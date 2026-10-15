/**
 * Shared column-type inference for DuckDB-backed file sources (Excel, CSV).
 *
 * Both Excel and CSV are loaded with `all_varchar=true` to dodge DuckDB's
 * type-inference errors on mixed-type columns. That leaves every column a
 * VARCHAR, so we re-type them in a single, ordered pass:
 *
 *   1. Excel serial dates  — numeric-looking date columns (e.g. 45726 → DATE)
 *   2. Text dates          — string date columns (e.g. '2026-02-01T18:30:00Z')
 *   3. Numbers             — plain / comma-formatted numbers (e.g. '3,424')
 *
 * Order matters: dates are claimed BEFORE the numeric pass, otherwise an Excel
 * serial date (just a number under the hood) gets cast to BIGINT/DOUBLE. Once a
 * column is re-typed it's no longer VARCHAR, so the later passes skip it.
 *
 * Each pass is tolerant of a small fraction of junk (sentinels, blanks) so one
 * stray value can't disqualify an entire column — the previous all-or-nothing
 * check turned date columns into doubles whenever a 9999-12-31 sentinel
 * (Excel serial 2958101) appeared.
 */

import { DuckDBConnection } from '@duckdb/node-api';

/** Column name tokens that hint a numeric column actually holds Excel serial dates. */
const SERIAL_DATE_NAME_HINTS = ['date', 'time', 'dt', 'dob', 'expir', 'due', 'asof'];

/**
 * "Modern" Excel serial-date band, used only as a CONFIDENCE signal: ~1954-10
 * (20000) to 2100 (73415). A real date column has most of its values here. The
 * high lower bound is what keeps day/hour/second *durations* in `*_time`-named
 * columns (typically small numbers) from being mistaken for dates.
 */
const SERIAL_MODERN_MIN = 20000;
const SERIAL_MODERN_MAX = 73415;

/**
 * Full range of valid Excel serial dates: 1 (1899-12-31) to 2958465
 * (9999-12-31). Used for the actual conversion so the common 9999-12-31 "open"
 * sentinel (serial 2958101) converts faithfully instead of disqualifying the
 * column. Values outside this range map to NULL.
 */
const SERIAL_VALID_MIN = 1;
const SERIAL_VALID_MAX = 2958465;

/**
 * Minimum fraction of values that must land in the modern band to accept a
 * (date-named, all-numeric) column as serial dates. Set low enough to tolerate
 * a heavy share of sentinels (e.g. many "open" rows carrying 9999-12-31) while
 * still rejecting small-integer duration/count columns.
 */
const SERIAL_THRESHOLD = 0.3;

/**
 * Name-independent trigger. A value shaped like `45769.690937` — a modern-band
 * integer part with a long fractional tail — is essentially a self-identifying
 * datetime serial; real numeric measures (quantities, IDs, prices, hour
 * estimates) almost never have that shape. When this fraction of a column's
 * values look like fractional-day serials, we accept it as dates even without a
 * date-ish column name. (Format metadata is NOT used — it's unreliable on
 * programmatic exports: observed tagging text name-columns as dates while
 * leaving a real date column "general".)
 */
const FRACTIONAL_SERIAL_THRESHOLD = 0.5;
/** A modern-band integer part with ≥3 fractional digits — a strong datetime tell. */
const FRACTIONAL_SERIAL_RE = '^[0-9]{4,5}\\.[0-9]{3,}$';

/**
 * strptime format list (tried in order) for text date columns that ISO
 * `TRY_CAST` can't parse. US month-first ordering is listed before
 * day-first to resolve the MM/DD vs DD/MM ambiguity deterministically.
 */
const TEXT_DATE_FORMATS = [
  '%m/%d/%Y %H:%M:%S', '%m/%d/%Y %H:%M', '%m/%d/%Y',
  '%d/%m/%Y %H:%M:%S', '%d/%m/%Y',
  '%m-%d-%Y', '%d-%m-%Y',
  '%Y/%m/%d',
  '%d-%b-%Y', '%d-%B-%Y', '%b %d, %Y', '%B %d, %Y',
];

interface Col { column_name: string; column_type: string }

async function describeVarcharCols(connection: DuckDBConnection, table: string): Promise<Col[]> {
  const desc = await connection.runAndReadAll(`DESCRIBE "${table}"`);
  const cols = desc.getRowObjects() as unknown as Col[];
  return cols.filter(c => c.column_type === 'VARCHAR');
}

/**
 * Rows sampled for cheap type *screening*. Each pass first probes only this many
 * rows; the full-column confirm runs solely for columns the sample doesn't rule
 * out. On a wide table this turns "3 full scans × every column" into "3 cheap
 * sampled scans × every column + 1 full scan × the few columns actually
 * converted" — far less transient memory/CPU — without weakening the
 * all-or-nothing guarantee (the lossy date casts still validate the whole
 * column before running).
 */
const SAMPLE_SIZE = 10000;

/**
 * Build an aggregate probe over a column's non-empty values. With `limit` set it
 * reads only the first N rows (cheap screen); without it, the whole column
 * (authoritative confirm). `cn` must already be `"`-escaped. The aggregate
 * expressions in `aggSelect` reference each value as `v`.
 */
function probeSql(table: string, cn: string, aggSelect: string, limit?: number): string {
  const inner =
    `SELECT "${cn}" AS v FROM "${table}" ` +
    `WHERE "${cn}" IS NOT NULL AND TRIM("${cn}") != ''` +
    (limit ? ` LIMIT ${limit}` : '');
  return `SELECT ${aggSelect} FROM (${inner})`;
}

/** Run a probe (sampled or full) and return the single stats row. */
async function runProbe(
  connection: DuckDBConnection,
  table: string,
  cn: string,
  aggSelect: string,
  limit?: number,
): Promise<any> {
  const res = await connection.runAndReadAll(probeSql(table, cn, aggSelect, limit));
  return res.getRowObjects()[0] as any;
}

/** SQL expression that converts an Excel serial (in `expr`) to a TIMESTAMP. */
function serialToTimestamp(expr: string): string {
  return `(TIMESTAMP '1899-12-30'
            + INTERVAL (CAST(FLOOR(${expr}) AS BIGINT)) DAY
            + INTERVAL (CAST(ROUND((${expr} - FLOOR(${expr})) * 86400) AS BIGINT)) SECOND)`;
}

/** SQL expression that converts an Excel serial (in `expr`) to a DATE. */
function serialToDate(expr: string): string {
  return `(DATE '1899-12-30' + INTERVAL (CAST(${expr} AS BIGINT)) DAY)`;
}

/**
 * Pass 1 — Excel serial dates.
 *
 * A numeric column is treated as dates when its name hints at date/time OR it
 * carries a strong fractional-day-serial signal (name-independent — catches
 * date columns whose header lacks a date/time token, e.g. `Posting`, `Effective`).
 * Either way it's then value-validated:
 *   - EVERY value must be numeric (so it's genuinely a number column),
 *   - EVERY value must be a valid Excel serial (1 .. 2958465 / 9999-12-31), and
 *   - a minimum fraction must land in the modern band (rejects small-integer
 *     durations like a `*_time` measure).
 * Conversion uses the full valid range, so the 9999-12-31 "open" sentinel
 * (serial 2958101) is preserved faithfully. Anything outside the valid range
 * maps to NULL.
 */
async function convertSerialDates(
  connection: DuckDBConnection,
  table: string,
  logPrefix: string,
): Promise<void> {
  const aggSelect = `
           COUNT(*) AS total,
           COUNT(*) FILTER (WHERE TRY_CAST(v AS DOUBLE) IS NOT NULL) AS numeric_cnt,
           COUNT(*) FILTER (WHERE TRY_CAST(v AS DOUBLE) BETWEEN ${SERIAL_VALID_MIN} AND ${SERIAL_VALID_MAX}) AS valid_serial,
           COUNT(*) FILTER (WHERE TRY_CAST(v AS DOUBLE) BETWEEN ${SERIAL_MODERN_MIN} AND ${SERIAL_MODERN_MAX}) AS modern,
           COUNT(*) FILTER (WHERE regexp_matches(v, '${FRACTIONAL_SERIAL_RE}')
                            AND TRY_CAST(v AS DOUBLE) BETWEEN ${SERIAL_MODERN_MIN} AND ${SERIAL_MODERN_MAX}) AS frac_serial,
           COUNT(*) FILTER (WHERE v LIKE '%.%') AS with_time`;

  for (const col of await describeVarcharCols(connection, table)) {
    const nameLower = col.column_name.toLowerCase();
    const nameHint = SERIAL_DATE_NAME_HINTS.some(h => nameLower.includes(h));

    const cn = col.column_name.replace(/"/g, '""');

    // All values numeric and within the valid Excel serial range, with enough
    // of them in the modern band to be confident it's dates and not a measure.
    // Without a date-ish name, require the strong fractional-serial signal —
    // otherwise an integer-only number in the band is indistinguishable from a
    // genuine measure and is left numeric.
    const qualifies = (r: any): boolean => {
      const total = Number(r.total);
      const numericCnt = Number(r.numeric_cnt);
      const validSerial = Number(r.valid_serial);
      const modern = Number(r.modern);
      const fracSerial = Number(r.frac_serial);
      if (total === 0 || numericCnt !== total || validSerial !== total) return false;
      if (modern / total < SERIAL_THRESHOLD) return false;
      const strongFractional = fracSerial / total >= FRACTIONAL_SERIAL_THRESHOLD;
      if (!nameHint && !strongFractional) return false;
      return true;
    };

    try {
      // Cheap screen on a sample, then confirm over the whole column before the
      // (lossy) conversion so a stray out-of-band value past the sample can't
      // silently NULL real data.
      if (!qualifies(await runProbe(connection, table, cn, aggSelect, SAMPLE_SIZE))) continue;
      const full = await runProbe(connection, table, cn, aggSelect);
      if (!qualifies(full)) continue;

      const hasTime = Number(full.with_time) > 0;
      const dbl = `TRY_CAST("${cn}" AS DOUBLE)`;
      const targetType = hasTime ? 'TIMESTAMP' : 'DATE';
      const convertExpr = hasTime ? serialToTimestamp(dbl) : serialToDate(dbl);

      await connection.run(
        `ALTER TABLE "${table}" ALTER COLUMN "${cn}" SET DATA TYPE ${targetType} USING
           CASE WHEN ${dbl} BETWEEN ${SERIAL_VALID_MIN} AND ${SERIAL_VALID_MAX} THEN ${convertExpr} ELSE NULL END`
      );
      const trigger = nameHint ? 'name' : 'fractional-serial';
      console.log(`${logPrefix} Converted Excel serial dates in "${col.column_name}" → ${targetType} (${trigger}) in "${table}"`);
    } catch (err) {
      console.warn(`${logPrefix} Skipped serial-date conversion for "${col.column_name}" in "${table}":`, err);
    }
  }
}

/**
 * Pass 2 — Text dates.
 *
 * Value-based (not name-gated): a VARCHAR column whose every non-empty value
 * parses as a date — via ISO `TRY_CAST` or one of the common `strptime`
 * formats — is re-typed to DATE/TIMESTAMP. Pure-number columns parse to NULL on
 * a date cast, so numeric/ID columns are naturally excluded; the serial pass
 * already claimed numeric date columns before this runs.
 */
async function convertTextDates(
  connection: DuckDBConnection,
  table: string,
  logPrefix: string,
): Promise<void> {
  const formatList = TEXT_DATE_FORMATS.map(f => `'${f}'`).join(', ');
  // parsed = ISO timestamp cast, falling back to a list of strptime formats.
  // References each value as `v` (the probe alias).
  const parsedV = `COALESCE(TRY_CAST(v AS TIMESTAMP), TRY_STRPTIME(v, [${formatList}]))`;
  const aggSelect = `
           COUNT(*) AS total,
           COUNT(*) FILTER (WHERE ${parsedV} IS NOT NULL) AS parsed_cnt,
           COUNT(*) FILTER (WHERE v LIKE '%:%' OR v LIKE '%T%') AS time_cnt`;

  // Every value must parse — a partial match means it's free text, not dates.
  const qualifies = (r: any): boolean => {
    const total = Number(r.total);
    return total > 0 && Number(r.parsed_cnt) === total;
  };

  for (const col of await describeVarcharCols(connection, table)) {
    const cn = col.column_name.replace(/"/g, '""');
    // parsed expression against the real column (for the ALTER USING clause).
    const parsed = `COALESCE(TRY_CAST("${cn}" AS TIMESTAMP), TRY_STRPTIME("${cn}", [${formatList}]))`;

    try {
      // Screen on a sample, then confirm over the whole column — a non-parsing
      // value past the sample would otherwise be silently cast to NULL.
      if (!qualifies(await runProbe(connection, table, cn, aggSelect, SAMPLE_SIZE))) continue;
      const full = await runProbe(connection, table, cn, aggSelect);
      if (!qualifies(full)) continue;

      const hasTime = Number(full.time_cnt) > 0;
      const targetType = hasTime ? 'TIMESTAMP' : 'DATE';
      const convertExpr = hasTime ? parsed : `CAST(${parsed} AS DATE)`;

      await connection.run(
        `ALTER TABLE "${table}" ALTER COLUMN "${cn}" SET DATA TYPE ${targetType} USING ${convertExpr}`
      );
      console.log(`${logPrefix} Converted text dates in "${col.column_name}" → ${targetType} in "${table}"`);
    } catch (err) {
      console.warn(`${logPrefix} Skipped text-date conversion for "${col.column_name}" in "${table}":`, err);
    }
  }
}

/**
 * Pass 3 — Numbers.
 *
 * A VARCHAR column whose every non-empty value is a plain or comma-formatted
 * number is re-typed to BIGINT (no decimals) or DOUBLE (decimals present).
 * Runs last so date columns claimed by passes 1–2 are no longer VARCHAR.
 */
async function convertNumeric(
  connection: DuckDBConnection,
  table: string,
  logPrefix: string,
): Promise<void> {
  const aggSelect = `
           COUNT(*) AS total,
           COUNT(*) FILTER (WHERE regexp_matches(v, '^-?[0-9]{1,3}(,?[0-9]{3})*(\\.([0-9]+))?$')) AS numeric_count,
           COUNT(*) FILTER (WHERE v LIKE '%.%') AS has_dec`;

  // Every value must be a plain/comma-formatted number.
  const qualifies = (r: any): boolean => {
    const total = Number(r.total);
    return total > 0 && Number(r.numeric_count) === total;
  };

  for (const col of await describeVarcharCols(connection, table)) {
    const cn = col.column_name.replace(/"/g, '""');
    try {
      // Screen on a sample, then confirm over the whole column. (The CAST below
      // would also abort on a non-numeric value, but the full confirm avoids
      // attempting a doomed rewrite of a huge column.)
      if (!qualifies(await runProbe(connection, table, cn, aggSelect, SAMPLE_SIZE))) continue;
      const full = await runProbe(connection, table, cn, aggSelect);
      if (!qualifies(full)) continue;

      const hasDecimals = Number(full.has_dec) > 0;
      const targetType = hasDecimals ? 'DOUBLE' : 'BIGINT';

      await connection.run(
        `ALTER TABLE "${table}" ALTER COLUMN "${cn}" SET DATA TYPE ${targetType} USING CAST(REPLACE("${cn}", ',', '') AS ${targetType})`
      );
      console.log(`${logPrefix} Converted "${col.column_name}" VARCHAR → ${targetType} in "${table}"`);
    } catch (err) {
      console.warn(`${logPrefix} Skipped numeric conversion for "${col.column_name}" in "${table}":`, err);
    }
  }
}

/**
 * Re-type the VARCHAR columns of a freshly-loaded DuckDB table: dates first
 * (serial, then text), then numbers. Safe to call on any table — columns that
 * don't match a pattern are left as VARCHAR.
 */
export async function inferColumnTypes(
  connection: DuckDBConnection,
  table: string,
  logPrefix = '[inferColumnTypes]',
): Promise<void> {
  await convertSerialDates(connection, table, logPrefix);
  await convertTextDates(connection, table, logPrefix);
  await convertNumeric(connection, table, logPrefix);
}

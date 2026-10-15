/**
 * Streaming Excel → CSV conversion for the DuckDB-backed Excel source.
 *
 * `read_xlsx` (DuckDB's excel extension) is NOT streaming — it parses the whole
 * worksheet XML into memory, so a 1 GB xlsx (≈5–10 GB uncompressed XML) blows
 * the process heap. exceljs's `WorkbookReader` streams the worksheet XML row by
 * row, so memory stays flat regardless of file size. We write one RFC-4180 CSV
 * per sheet to disk, then hand those to DuckDB's `read_csv`, which IS streaming
 * and memory-bounded — the same path 1 GB CSV uploads already use happily.
 *
 * Cell values are written as plain text (the all_varchar contract the loaders
 * rely on); DuckDB-side `inferColumnTypes()` re-types dates/numbers afterward.
 * Dates are the one typed exception: exceljs resolves Excel serials to JS Dates
 * (UTC instants), so we emit ISO text and let the text-date pass claim them.
 */

import * as fs from 'fs';
import * as path from 'path';
import { once } from 'events';
import ExcelJS from 'exceljs';
// unzipper (exceljs's own dependency) ships no bundled types; we only touch
// Open.file(...).files[].buffer(). Open.file SEEKS the zip central directory, so
// pulling one small entry does NOT load the whole (possibly 1 GB) xlsx into memory.
const unzipper = require('unzipper') as {
  Open: { file(p: string): Promise<{ files: Array<{ path: string; buffer(): Promise<Buffer> }> }> };
};
import {
  getSourceCsvDir,
  deleteSourceCsvDir,
  writeSourceCsvManifest,
  readSourceCsvManifest,
  fileFingerprint,
} from './file-storage';

export interface ConvertedSheet {
  /** Original sheet name from the workbook. */
  sheetName: string;
  /** Absolute path to the written CSV (one per non-empty sheet). */
  csvPath: string;
  /** Number of data rows written (excludes the header row). */
  rowCount: number;
}

export interface XlsxToCsvOptions {
  /** Restrict conversion to these sheet names (matches `read_xlsx` sheet filter). */
  sheets?: string[];
  /** Log prefix for diagnostics. */
  logPrefix?: string;
  /**
   * Optional progress callback for live status. Fired when a sheet starts, every
   * `progressRowInterval` rows while writing, and when a sheet finishes.
   */
  onProgress?: (info: { sheetName: string; sheetIndex: number; rows: number; done: boolean }) => void;
}

/** Emit a row-progress event roughly every this many rows during conversion. */
const PROGRESS_ROW_INTERVAL = 50_000;

/**
 * Serialize a single exceljs cell value to a CSV field string.
 *
 * exceljs cell values can be: null, number, string, boolean, Date, a formula
 * object `{ formula, result }`, rich text `{ richText: [...] }`, a hyperlink
 * `{ text, hyperlink }`, or an error `{ error }`. We flatten each to text.
 */
function cellToString(value: unknown): string {
  if (value === null || value === undefined) return '';

  if (value instanceof Date) return formatDate(value);

  if (typeof value === 'object') {
    const v = value as Record<string, unknown>;
    // Formula / shared-formula cell — use the computed result.
    if ('result' in v) return cellToString(v.result);
    // Rich text — concatenate the runs.
    if ('richText' in v && Array.isArray(v.richText)) {
      return (v.richText as Array<{ text?: string }>).map(r => r.text ?? '').join('');
    }
    // Hyperlink — keep the display text, drop the URL.
    if ('text' in v) return String(v.text ?? '');
    // Error cell (#N/A, #REF!, …) — treat as empty.
    if ('error' in v) return '';
    return '';
  }

  return String(value);
}

/**
 * Format a JS Date as ISO text. exceljs builds dates as UTC instants from the
 * Excel serial, so UTC getters give the correct calendar value with no
 * timezone drift. Pure dates emit `YYYY-MM-DD`; values carrying a time emit
 * `YYYY-MM-DD HH:MM:SS` — both parse cleanly via DuckDB's text-date pass.
 */
function formatDate(d: Date): string {
  const iso = d.toISOString(); // e.g. 2026-02-01T18:30:00.000Z
  if (iso.endsWith('T00:00:00.000Z')) return iso.slice(0, 10);
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}`;
}

/** Quote a CSV field per RFC 4180 when it contains a delimiter, quote, or newline. */
function csvField(s: string): string {
  if (s === '') return '';
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** Sanitize a sheet name into a safe CSV filename component. */
function safeFileName(sheetName: string): string {
  const cleaned = sheetName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100);
  return cleaned.length > 0 ? cleaned : 'sheet';
}

/**
 * Stream-convert every (selected) sheet of an xlsx file into a CSV in `outDir`.
 *
 * Returns one entry per sheet that produced at least a header row. Sheets with
 * no rows at all are skipped (no CSV written) since there's nothing to load.
 * Memory stays bounded: at most one worksheet row is materialized at a time and
 * writes apply backpressure via the stream `drain` event.
 */
function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&'); // must be last so "&amp;lt;" → "&lt;", not "<"
}

/**
 * Sheet names, keyed by WORKSHEET FILE NUMBER (the N in xl/worksheets/sheetN.xml):
 * workbook.xml gives name → r:id, workbook.xml.rels gives r:id → sheetN.xml.
 *
 * WHY BY FILE NUMBER, NOT POSITION: the streaming WorkbookReader emits worksheets
 * in ZIP ENTRY order, which matches neither the <sheets> display order nor numeric
 * file order. We therefore join via the rels mapping (name→rid→sheetN) to be
 * independent of storage order. `ordered` is kept only as a fallback.
 *
 * Best-effort: any failure returns empty and the caller falls back to exceljs's name.
 */
async function readSheetNameMaps(
  xlsxPath: string,
): Promise<{ byFileNum: Map<number, string>; ordered: string[] }> {
  const empty = { byFileNum: new Map<number, string>(), ordered: [] as string[] };
  try {
    const dir = await unzipper.Open.file(xlsxPath);
    const read = async (p: string) => {
      const f = dir.files.find((x) => x.path === p);
      return f ? (await f.buffer()).toString('utf8') : '';
    };
    const wbXml = await read('xl/workbook.xml');
    if (!wbXml) return empty;

    const ordered: string[] = [];
    const nameByRid = new Map<string, string>();
    let m: RegExpExecArray | null;
    const sheetRe = /<sheet\b[^>]*>/g;
    while ((m = sheetRe.exec(wbXml))) {
      const name = /\bname="([^"]*)"/.exec(m[0])?.[1];
      if (name === undefined) continue;
      const decoded = decodeXmlEntities(name);
      ordered.push(decoded);
      const rid = /\br:id="([^"]*)"/.exec(m[0])?.[1];
      if (rid) nameByRid.set(rid, decoded);
    }

    const byFileNum = new Map<number, string>();
    const relXml = await read('xl/_rels/workbook.xml.rels');
    const relRe = /<Relationship\b[^>]*>/g;
    while ((m = relRe.exec(relXml))) {
      const id = /\bId="([^"]*)"/.exec(m[0])?.[1];
      const target = /\bTarget="([^"]*)"/.exec(m[0])?.[1];
      const num = target ? /(?:^|\/)sheet(\d+)\.xml$/.exec(target)?.[1] : undefined;
      const nm = id ? nameByRid.get(id) : undefined;
      if (num && nm !== undefined) byFileNum.set(Number(num), nm);
    }
    return { byFileNum, ordered };
  } catch {
    return empty;
  }
}

export async function streamXlsxToCsvs(
  xlsxPath: string,
  outDir: string,
  options: XlsxToCsvOptions = {},
): Promise<ConvertedSheet[]> {
  const { sheets, logPrefix = '[xlsx-to-csv]', onProgress } = options;
  const wanted = sheets && sheets.length > 0 ? new Set(sheets) : null;

  fs.mkdirSync(outDir, { recursive: true });

  // True sheet names (exceljs streaming can't be trusted for these — see helper).
  // Matched to worksheets by file number below; display order is only a fallback.
  const { byFileNum, ordered: orderedNames } = await readSheetNameMaps(xlsxPath);

  const reader = new ExcelJS.stream.xlsx.WorkbookReader(xlsxPath, {
    // Keep the shared-strings table (worksheet cells reference it by index);
    // it's deduplicated, so far smaller than the full worksheet XML.
    sharedStrings: 'cache',
    // Cache styles so exceljs can recognize date-formatted cells and resolve
    // them to JS Dates (we emit ISO text). styles.xml is small and bounded —
    // it does NOT grow per row — so this costs negligible memory. Without it,
    // date cells arrive as bare Excel serials and we'd be at the mercy of the
    // serial-date heuristic, which can't claim integer dates in oddly-named
    // columns.
    styles: 'cache',
    // We don't need hyperlinks — skipping them keeps memory lower.
    hyperlinks: 'ignore',
    worksheets: 'emit',
    entries: 'emit',
  });

  const results: ConvertedSheet[] = [];
  const usedNames = new Set<string>();

  // exceljs resolves each emission's true name from workbook.xml.rels; trust it
  // when it is a known name. worksheet.id is the sheetId ATTRIBUTE, not the
  // sheetN.xml file number, so byFileNum keyed on it is only a fallback.
  const knownNames = new Set(orderedNames);
  let emitIndex = -1;
  for await (const worksheet of reader as any) {
    emitIndex++;
    const fileNum = Number(worksheet.id);
    const sheetName: string =
      (typeof worksheet.name === 'string' && knownNames.has(worksheet.name) ? worksheet.name : undefined) ??
      (Number.isFinite(fileNum) ? byFileNum.get(fileNum) : undefined) ??
      orderedNames[emitIndex] ?? worksheet.name ?? `Sheet${worksheet.id ?? emitIndex + 1}`;

    if (wanted && !wanted.has(sheetName)) {
      // Drain this worksheet's rows without writing so the parser advances.
      for await (const _ of worksheet) { /* skip */ }
      continue;
    }

    // Unique, filesystem-safe CSV path per sheet.
    let base = safeFileName(sheetName);
    let candidate = base;
    let n = 1;
    while (usedNames.has(candidate)) candidate = `${base}_${n++}`;
    usedNames.add(candidate);
    const csvPath = path.join(outDir, `${candidate}.csv`);

    const out = fs.createWriteStream(csvPath, { encoding: 'utf8' });
    let headerWidth = 0;
    let dataRows = 0;
    let wroteHeader = false;

    const sheetIndex = results.length + 1;
    onProgress?.({ sheetName, sheetIndex, rows: 0, done: false });

    const writeLine = async (line: string): Promise<void> => {
      if (!out.write(line)) await once(out, 'drain');
    };

    for await (const row of worksheet) {
      // exceljs `row.values` is 1-indexed (index 0 is always undefined).
      const raw = (row.values as unknown[]) ?? [];
      const cells = raw.slice(1);

      if (!wroteHeader) {
        // First row defines the columns (header=true, matching read_xlsx).
        headerWidth = cells.length;
        if (headerWidth === 0) continue; // skip leading blank rows before the header
        const header = cells.map(c => csvField(cellToString(c)));
        await writeLine(header.join(',') + '\n');
        wroteHeader = true;
        continue;
      }

      // Normalize each data row to the header width: pad short rows, drop
      // overflow cells (the header defines the column set, as read_xlsx does).
      const fields: string[] = new Array(headerWidth);
      for (let i = 0; i < headerWidth; i++) {
        fields[i] = csvField(cellToString(cells[i]));
      }
      await writeLine(fields.join(',') + '\n');
      dataRows++;
      if (dataRows % PROGRESS_ROW_INTERVAL === 0) {
        onProgress?.({ sheetName, sheetIndex, rows: dataRows, done: false });
      }
    }

    await new Promise<void>((resolve, reject) => {
      out.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });

    if (!wroteHeader) {
      // Completely empty sheet — nothing to load, discard the empty file.
      try { fs.unlinkSync(csvPath); } catch { /* ignore */ }
      console.log(`${logPrefix} Skipped empty sheet "${sheetName}"`);
      continue;
    }

    onProgress?.({ sheetName, sheetIndex, rows: dataRows, done: true });
    results.push({ sheetName, csvPath, rowCount: dataRows });
    console.log(`${logPrefix} Converted sheet "${sheetName}" → ${path.basename(csvPath)} (${dataRows} rows)`);
  }

  if (results.length === 0) {
    throw new Error('No sheets with data found in the Excel file');
  }

  return results;
}

// Marker file (in the source's CSV dir) holding the xlsx fingerprint the current
// converted CSVs were produced from. Lets a second caller reuse the conversion.
const CSV_FINGERPRINT_MARKER = '.xlsx-fingerprint';

/**
 * Ensure the per-sheet CSVs for an xlsx exist, REUSING a prior conversion when the
 * workbook is unchanged (matched by fingerprint). This lets the PII gate and the
 * build share a single conversion, so a large xlsx is read only once instead of
 * twice (sample, then build). On any change / missing artifact it re-converts.
 */
export async function ensureXlsxConverted(
  xlsxPath: string,
  projectId: string,
  sourceId: string,
  options: XlsxToCsvOptions = {},
  cacheKey?: string,
): Promise<ConvertedSheet[]> {
  const csvDir = getSourceCsvDir(projectId, sourceId);
  // Key reuse on a STABLE identity for the upload (the R2 object key) rather than
  // the file's mtime — the file is re-downloaded between the detect and confirm
  // calls, which changes an mtime-based fingerprint and would defeat reuse. Falls
  // back to the file fingerprint when no cacheKey is given (e.g. base64 uploads).
  const key = (cacheKey ?? fileFingerprint(xlsxPath) ?? '').trim();
  const markerPath = path.join(csvDir, CSV_FINGERPRINT_MARKER);
  const logPrefix = options.logPrefix ?? '[xlsx-to-csv]';

  // Reuse path — same upload already converted and all CSVs still present.
  if (key && fs.existsSync(markerPath)) {
    try {
      if (fs.readFileSync(markerPath, 'utf8').trim() === key) {
        const manifest = readSourceCsvManifest(projectId, sourceId);
        if (manifest && manifest.size > 0) {
          const sheets: ConvertedSheet[] = [];
          let allPresent = true;
          for (const [sheetName, file] of manifest) {
            const csvPath = path.join(csvDir, file);
            if (!fs.existsSync(csvPath)) { allPresent = false; break; }
            sheets.push({ sheetName, csvPath, rowCount: 0 });
          }
          if (allPresent) {
            console.log(`${logPrefix} Reused ${sheets.length} converted sheet CSV(s) for ${path.basename(xlsxPath)}`);
            return sheets;
          }
        }
      }
    } catch { /* fall through to a fresh conversion */ }
  }

  // Fresh conversion.
  deleteSourceCsvDir(projectId, sourceId);
  const converted = await streamXlsxToCsvs(xlsxPath, csvDir, options);
  writeSourceCsvManifest(
    projectId,
    sourceId,
    converted.map((c) => ({ sheet: c.sheetName, file: path.basename(c.csvPath) })),
  );
  if (key) {
    try { fs.writeFileSync(markerPath, key); } catch { /* best-effort marker */ }
  }
  return converted;
}

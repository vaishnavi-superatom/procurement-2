/**
 * PII column policy — CSV rewrite
 *
 * Applies the user's per-column PII decisions to a CSV before it's loaded into
 * DuckDB. Opt-in only: invoked from the load pipeline when the source config
 * carries redact/drop column lists (chosen in the PII review modal).
 *
 * Per the agreed design:
 *  - DROP columns are removed from the CSV entirely (so neither DuckDB nor the
 *    federation layer, which reads these CSVs, ever sees them).
 *  - REDACT columns are masked in full: EVERY non-empty cell in the column has its
 *    value replaced (every alphanumeric char → '*', see maskValue). The user
 *    explicitly chose these columns, so we redact them unconditionally rather than
 *    re-checking each cell for a PII pattern.
 *  - If a column is in both lists, DROP wins.
 *
 * Scope: local CSV (the CSV source's file, or the Excel source's converted
 * per-sheet CSVs). The original .xlsx is never touched.
 */

import * as fs from 'fs';
import { parseFile, writeToPath } from 'fast-csv';
import { maskValue } from './pii-detector';

/** Emit a redaction-progress event roughly every this many rows. */
const REDACT_PROGRESS_INTERVAL = 50_000;

export interface ProcessCsvOptions {
  /** Columns whose PII cells should be masked. */
  redactColumns?: string[];
  /** Columns to remove from the file entirely. */
  dropColumns?: string[];
  /** Column delimiter (defaults to ','). */
  delimiter?: string;
  /** Whether the first row is a header (defaults to true). Required for named columns. */
  hasHeader?: boolean;
  /** Write the result here instead of overwriting the input file. */
  outputPath?: string;
  /** Optional progress callback, fired every ~50k rows and once on completion. */
  onProgress?: (info: { rows: number; total: number; done: boolean }) => void;
}

export interface ProcessCsvResult {
  cellsRedacted: number;
  columnsDropped: number;
  rowsScanned: number;
}

/**
 * Read every row, drop the dropped columns, mask PII cells in the redact columns,
 * and write the file back. Reads fully into memory first, then writes — safe
 * because we only write after the read stream has ended.
 */
export async function processCsvFile(
  filePath: string,
  opts: ProcessCsvOptions,
): Promise<ProcessCsvResult> {
  const delimiter = opts.delimiter || ',';
  const hasHeader = opts.hasHeader !== false;
  const redactWanted = opts.redactColumns || [];
  const dropWanted = opts.dropColumns || [];

  if (!hasHeader) {
    console.warn('[PII-REDACTOR] Skipping: source has no header row, cannot match named columns');
    return { cellsRedacted: 0, columnsDropped: 0, rowsScanned: 0 };
  }
  if (!fs.existsSync(filePath)) {
    throw new Error(`processCsvFile: file not found: ${filePath}`);
  }
  if (redactWanted.length === 0 && dropWanted.length === 0) {
    return { cellsRedacted: 0, columnsDropped: 0, rowsScanned: 0 };
  }

  // 1) Read all rows as header-keyed objects.
  const rows: Record<string, string>[] = [];
  await new Promise<void>((resolve, reject) => {
    parseFile(filePath, { headers: true, delimiter })
      .on('error', reject)
      .on('data', (row: Record<string, string>) => rows.push(row))
      .on('end', () => resolve());
  });

  if (rows.length === 0) return { cellsRedacted: 0, columnsDropped: 0, rowsScanned: 0 };

  // 2) Resolve requested column names to actual header keys (case-insensitive).
  const headerKeys = Object.keys(rows[0]);
  const resolveKeys = (wanted: string[]): string[] => {
    const keys: string[] = [];
    for (const w of wanted) {
      const match = headerKeys.find((k) => k.toLowerCase() === String(w).toLowerCase());
      if (match) keys.push(match);
      else console.warn(`[PII-REDACTOR] Column "${w}" not found in CSV header — skipping`);
    }
    return keys;
  };
  const dropKeys = resolveKeys(dropWanted);
  // Drop wins over redact when a column appears in both.
  const redactKeys = resolveKeys(redactWanted).filter((k) => !dropKeys.includes(k));

  if (dropKeys.length === 0 && redactKeys.length === 0) {
    return { cellsRedacted: 0, columnsDropped: 0, rowsScanned: rows.length };
  }

  // 3) Drop columns + mask PII cells, per row. Deleting a key from every row
  //    removes it from the written header too (fast-csv derives headers from keys).
  let cellsRedacted = 0;
  let processed = 0;
  for (const row of rows) {
    for (const key of dropKeys) {
      delete row[key];
    }
    for (const key of redactKeys) {
      const original = row[key];
      if (original == null || original === '') continue;
      // The user explicitly chose this column — mask every cell unconditionally.
      row[key] = maskValue(String(original));
      cellsRedacted++;
    }
    processed++;
    if (processed % REDACT_PROGRESS_INTERVAL === 0) {
      opts.onProgress?.({ rows: processed, total: rows.length, done: false });
    }
  }

  // 4) Write back (same header order minus dropped columns, same delimiter).
  await new Promise<void>((resolve, reject) => {
    writeToPath(opts.outputPath || filePath, rows, { headers: true, delimiter })
      .on('error', reject)
      .on('finish', () => resolve());
  });

  // Signal completion only after the file is fully written — so "Redacted X"
  // never shows while the (slow) write is still in progress.
  opts.onProgress?.({ rows: rows.length, total: rows.length, done: true });

  return { cellsRedacted, columnsDropped: dropKeys.length, rowsScanned: rows.length };
}

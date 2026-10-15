/**
 * Shared table-naming for multi-file CSV sources — used by both CSVInstance
 * (actual DuckDB table names) and the PII gate (entity tags on findings), so
 * a PII redact/drop choice always lands on the table it was shown against.
 */

import * as path from 'path';

export function baseTableName(fileName: string): string {
  return path.basename(fileName, path.extname(fileName));
}

/** Dedupe a candidate name against ones already claimed in this pass. */
export function dedupeTableName(base: string, used: Set<string>): string {
  if (!used.has(base)) return base;
  let i = 2;
  let candidate = `${base}_${i}`;
  while (used.has(candidate)) {
    i++;
    candidate = `${base}_${i}`;
  }
  return candidate;
}

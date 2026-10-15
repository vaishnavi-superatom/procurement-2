/**
 * PII head-sampler
 *
 * Produces a lightweight SourceSchema (column names + a few sample values per
 * column) by reading only the HEAD of a CSV — no DuckDB build. This lets the PII
 * detection gate run BEFORE the expensive load.
 *
 * - CSV sources: sample the uploaded file directly (fast-csv `maxRows` truly stops
 *   early, so a large file isn't fully read).
 * - Excel sources: the gate first converts the workbook to per-sheet CSVs (a read
 *   that has to happen for the build anyway, and is reused), then samples those
 *   CSVs here. We never sample the .xlsx directly — exceljs is forward-only and
 *   can't be cheaply head-read.
 *
 * Output is shaped exactly like extractSchema's result, so detectPII() consumes it
 * unchanged. Detection is heuristic (it samples); the per-cell/whole-column
 * redaction later still processes every row.
 */

import * as path from 'path';
import { parseFile } from 'fast-csv';
import type { SourceSchema, SchemaField, SchemaEntity } from './types';

const MAX_SAMPLE_ROWS = 200;    // rows to read from the head
const MAX_VALUES_PER_COL = 15;  // distinct non-empty sample values kept per column

const emptySchema = (): SourceSchema => ({ entities: [], extractedAt: new Date().toISOString() });

/**
 * Sample a single CSV file's head into one schema entity (or null if empty / no
 * header). `entityName` is the table/sheet name the findings should carry.
 */
export async function sampleCsvEntity(
  filePath: string,
  entityName: string,
  delimiter = ',',
  hasHeader = true,
  maxRows = MAX_SAMPLE_ROWS,
): Promise<SchemaEntity | null> {
  if (!hasHeader) return null;

  const rows: Record<string, string>[] = [];
  await new Promise<void>((resolve, reject) => {
    parseFile(filePath, { headers: true, delimiter, maxRows })
      .on('error', reject)
      .on('data', (row: Record<string, string>) => rows.push(row))
      .on('end', () => resolve());
  });
  if (rows.length === 0) return null;

  const headerKeys = Object.keys(rows[0]);
  const fields: SchemaField[] = headerKeys.map((key) => ({
    name: key,
    type: 'TEXT',
    nativeType: 'VARCHAR',
    nullable: true,
    sampleValues: collectSamples(rows.map((r) => r[key])),
  }));

  return { name: entityName, fullName: entityName, fields, rowCount: rows.length };
}

/**
 * CSV source: sample the uploaded file's head into a one-entity schema.
 */
export async function sampleSchemaForPII(
  filePath: string,
  type: string,
  opts: { delimiter?: string; hasHeader?: boolean; maxRows?: number } = {},
): Promise<SourceSchema> {
  if (type !== 'csv') return emptySchema();
  const name = path.basename(filePath, path.extname(filePath));
  const entity = await sampleCsvEntity(
    filePath,
    name,
    opts.delimiter || ',',
    opts.hasHeader !== false,
    opts.maxRows ?? MAX_SAMPLE_ROWS,
  );
  return { entities: entity ? [entity] : [], extractedAt: new Date().toISOString() };
}

/**
 * Excel source: sample each already-converted per-sheet CSV (header=true,
 * comma-delimited) into one entity per sheet.
 */
export async function sampleConvertedCsvs(
  converted: Array<{ sheetName: string; csvPath: string }>,
  maxRows = MAX_SAMPLE_ROWS,
): Promise<SourceSchema> {
  const entities: SchemaEntity[] = [];
  for (const { sheetName, csvPath } of converted) {
    const entity = await sampleCsvEntity(csvPath, sheetName, ',', true, maxRows);
    if (entity) entities.push(entity);
  }
  return { entities, extractedAt: new Date().toISOString() };
}

/**
 * Multi-CSV source: sample each uploaded file into one entity, named with the
 * caller-supplied (already-deduped) table name.
 */
export async function sampleMultipleCsvs(
  files: Array<{ filePath: string; tableName: string }>,
  delimiter = ',',
  hasHeader = true,
  maxRows = MAX_SAMPLE_ROWS,
): Promise<SourceSchema> {
  const entities: SchemaEntity[] = [];
  for (const { filePath, tableName } of files) {
    const entity = await sampleCsvEntity(filePath, tableName, delimiter, hasHeader, maxRows);
    if (entity) entities.push(entity);
  }
  return { entities, extractedAt: new Date().toISOString() };
}

/** Up to MAX_VALUES_PER_COL distinct, non-empty values from a column's cells. */
function collectSamples(values: Array<string | undefined>): string[] {
  const out: string[] = [];
  for (const v of values) {
    if (v != null && v !== '' && !out.includes(v)) {
      out.push(v);
      if (out.length >= MAX_VALUES_PER_COL) break;
    }
  }
  return out;
}

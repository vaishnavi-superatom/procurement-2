/**
 * File Storage Helpers
 *
 * Handles saving uploaded files (base64) and downloading files from URLs
 * for Excel/CSV sources running on a remote server.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';

// Use process.cwd() so the path is stable whether running from source (tsx)
// or from compiled output (node dist/...) via pm2. pm2 should be started
// from the backend/ directory (cwd).
const UPLOADS_DIR = path.resolve(process.cwd(), 'uploads');
const DUCKDB_DIR = path.resolve(process.cwd(), 'duckdb');

/** Max file size: 100 MB */
const MAX_FILE_SIZE = 100 * 1024 * 1024;

function ensureUploadsDir(projectId: string): string {
  const dir = path.join(UPLOADS_DIR, projectId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Save a base64-encoded file to disk.
 * Returns the absolute path to the saved file.
 */
export function saveUploadedFile(
  base64Data: string,
  originalFileName: string,
  projectId: string,
  sourceId: string,
): string {
  const buffer = Buffer.from(base64Data, 'base64');

  if (buffer.length > MAX_FILE_SIZE) {
    throw new Error(`File too large (${(buffer.length / 1024 / 1024).toFixed(1)} MB). Maximum is 100 MB.`);
  }

  const dir = ensureUploadsDir(projectId);
  // Sanitise file name — keep only alphanumeric, dots, hyphens, underscores
  const safeName = originalFileName.replace(/[^a-zA-Z0-9._-]/g, '_');
  const filePath = path.join(dir, `${sourceId}_${safeName}`);

  fs.writeFileSync(filePath, buffer);
  console.log(`[file-storage] Saved upload: ${filePath} (${(buffer.length / 1024).toFixed(1)} KB)`);
  return filePath;
}

/**
 * Download a file from a URL and save it to disk.
 * Returns the absolute path to the saved file.
 */
export async function downloadFileFromURL(
  url: string,
  projectId: string,
  sourceId: string,
): Promise<string> {
  console.log(`[file-storage] Downloading: ${url}`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download file: HTTP ${response.status} ${response.statusText}`);
  }

  const contentLength = response.headers.get('content-length');
  if (contentLength && parseInt(contentLength) > MAX_FILE_SIZE) {
    throw new Error(`Remote file too large (${(parseInt(contentLength) / 1024 / 1024).toFixed(1)} MB). Maximum is 100 MB.`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_FILE_SIZE) {
    throw new Error(`Downloaded file too large (${(buffer.length / 1024 / 1024).toFixed(1)} MB). Maximum is 100 MB.`);
  }

  // Derive file name from URL
  const urlPath = new URL(url).pathname;
  const baseName = path.basename(urlPath) || 'downloaded_file';
  const safeName = baseName.replace(/[^a-zA-Z0-9._-]/g, '_');

  const dir = ensureUploadsDir(projectId);
  const filePath = path.join(dir, `${sourceId}_${safeName}`);

  fs.writeFileSync(filePath, buffer);
  console.log(`[file-storage] Downloaded: ${filePath} (${(buffer.length / 1024).toFixed(1)} KB)`);
  return filePath;
}

/**
 * Maximum size allowed for a file pulled from R2. Larger than MAX_FILE_SIZE
 * because R2-backed uploads bypass the WebSocket and target the larger-file
 * use case (Excel/CSV up to a few GB).
 */
const MAX_R2_FILE_SIZE = 5 * 1024 * 1024 * 1024; // 5 GB

/**
 * Download a file from R2 by object key.
 *
 * Talks to the worker (`/upload/source-file/signed-get`) to obtain a short-lived
 * presigned GET URL, then streams the body to local disk. Streaming (not
 * arrayBuffer) is important — a 1 GB file would otherwise sit in the Node heap.
 *
 * The worker URL and service token come from env:
 *   SA_API_URL                   - e.g. https://sa-api.superatom.ai
 *   SA_INTERNAL_SERVICE_TOKEN    - shared secret matching the worker's value
 */
export async function downloadFileFromR2(
  r2Key: string,
  projectId: string,
  sourceId: string,
  originalFileName?: string,
  /**
   * Disambiguates the local path for multi-file sources — without it, two
   * files sharing an original name would collide on disk. Omit for
   * single-file sources (path unchanged).
   */
  fileKey?: string,
): Promise<string> {
  // Deterministic local path for this source's upload, plus a sidecar marker that
  // records which R2 object the local file holds.
  const rawName = originalFileName || path.basename(r2Key);
  const safeName = rawName.replace(/[^a-zA-Z0-9._-]/g, '_');
  const baseName = fileKey !== undefined ? `${sourceId}_${fileKey}_${safeName}` : `${sourceId}_${safeName}`;
  const filePath = path.join(ensureUploadsDir(projectId), baseName);
  const markerPath = `${filePath}.r2key`;

  // Reuse a prior download of the SAME object instead of fetching it again. The
  // PII detect→confirm flow re-calls `create`, and a genuine re-upload (different
  // object) is blocked earlier by the duplicate-source check — so a matching marker
  // always means identical content. The marker is written only after a complete
  // download, so a partial/interrupted file never qualifies for reuse.
  if (fs.existsSync(filePath) && readTrimmed(markerPath) === r2Key) {
    console.log(`[file-storage] Reusing already-downloaded R2 object: ${filePath}`);
    return filePath;
  }

  const apiBase = process.env.SA_API_URL;
  const serviceToken = process.env.SA_INTERNAL_SERVICE_TOKEN;
  if (!apiBase) throw new Error('SA_API_URL is not set — required for R2-backed source files');
  if (!serviceToken) throw new Error('SA_INTERNAL_SERVICE_TOKEN is not set — required for R2-backed source files');

  // 1. Ask the worker for a presigned GET URL
  console.log(`[file-storage] Requesting signed GET URL for R2 key: ${r2Key}`);
  const signedResp = await fetch(`${apiBase.replace(/\/$/, '')}/upload/source-file/signed-get`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-SA-Service-Token': serviceToken,
    },
    body: JSON.stringify({ key: r2Key }),
  });

  if (!signedResp.ok) {
    const text = await signedResp.text().catch(() => '');
    throw new Error(`Failed to obtain signed URL for R2 key ${r2Key}: HTTP ${signedResp.status} ${text}`);
  }
  const { url: signedUrl } = await signedResp.json() as { url: string };

  // 2. Stream the file from R2 to local disk
  const response = await fetch(signedUrl);
  if (!response.ok) {
    throw new Error(`Failed to download from R2: HTTP ${response.status} ${response.statusText}`);
  }

  const contentLength = response.headers.get('content-length');
  if (contentLength && parseInt(contentLength) > MAX_R2_FILE_SIZE) {
    throw new Error(`R2 file too large (${(parseInt(contentLength) / 1024 / 1024).toFixed(1)} MB). Maximum is ${MAX_R2_FILE_SIZE / 1024 / 1024 / 1024} GB.`);
  }
  if (!response.body) throw new Error('R2 response body is empty');

  // Stream body → file. Readable.fromWeb adapts the Web ReadableStream to a Node Readable.
  await pipeline(Readable.fromWeb(response.body as any), fs.createWriteStream(filePath));

  // Record the object identity only after a complete download, so the next call
  // can safely reuse this file.
  try { fs.writeFileSync(markerPath, r2Key); } catch { /* best-effort marker */ }

  const stat = fs.statSync(filePath);
  console.log(`[file-storage] Downloaded from R2: ${filePath} (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
  return filePath;
}

/** Read a small text file, trimmed; null if it doesn't exist / can't be read. */
function readTrimmed(filePath: string): string | null {
  try { return fs.readFileSync(filePath, 'utf8').trim(); } catch { return null; }
}

/**
 * Delete a source file from R2 by object key.
 *
 * Talks to the worker (`/upload/source-file/delete`), which owns the R2
 * credentials — this backend has no direct R2 access (same reason
 * `downloadFileFromR2` proxies through the worker).
 *
 * Best-effort: logs and swallows all errors. A failed delete only leaves an
 * orphaned object in R2; it must never block deleting the source record or
 * replacing its file.
 *
 *   SA_API_URL                   - e.g. https://sa-api.superatom.ai
 *   SA_INTERNAL_SERVICE_TOKEN    - shared secret matching the worker's value
 */
export async function deleteFileFromR2(r2Key: string): Promise<void> {
  if (!r2Key) return;

  const apiBase = process.env.SA_API_URL;
  const serviceToken = process.env.SA_INTERNAL_SERVICE_TOKEN;

  if (!apiBase || !serviceToken) {
    console.warn(
      `[file-storage] Skipping R2 delete for ${r2Key}: SA_API_URL or SA_INTERNAL_SERVICE_TOKEN not set`,
    );
    return;
  }

  try {
    const resp = await fetch(`${apiBase.replace(/\/$/, '')}/upload/source-file/delete`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-SA-Service-Token': serviceToken,
      },
      body: JSON.stringify({ key: r2Key }),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      console.warn(`[file-storage] Failed to delete R2 object ${r2Key}: HTTP ${resp.status} ${text}`);
      return;
    }
    console.log(`[file-storage] Deleted R2 object: ${r2Key}`);
  } catch (err) {
    console.warn(`[file-storage] Error deleting R2 object ${r2Key}:`, err);
  }
}

/**
 * Delete an uploaded file. Silently ignores if file doesn't exist.
 */
export function deleteUploadedFile(filePath: string): void {
  if (!filePath || !filePath.startsWith(UPLOADS_DIR)) return;

  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log(`[file-storage] Deleted: ${filePath}`);
    }
  } catch (err) {
    console.warn(`[file-storage] Failed to delete ${filePath}:`, err);
  }
  // Best-effort: drop the R2-reuse marker sidecar if one exists.
  try { fs.unlinkSync(`${filePath}.r2key`); } catch { /* no marker — fine */ }
}

/**
 * Check if a string looks like a URL.
 */
export function isURL(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

/**
 * Check if a file path points to the uploads directory (i.e. was uploaded/downloaded).
 */
export function isUploadedFile(filePath: string): boolean {
  return filePath.startsWith(UPLOADS_DIR);
}

/**
 * Absolute path to a source's on-disk DuckDB database file.
 * Used by Excel/CSV instances to persist data outside the Node heap.
 */
export function getSourceDbPath(projectId: string, sourceId: string): string {
  return path.join(DUCKDB_DIR, projectId, `${sourceId}.duckdb`);
}

/**
 * Directory holding the per-sheet CSVs streamed out of an Excel source.
 * Lives under DUCKDB_DIR so it's cleaned up alongside the source's DB file.
 */
export function getSourceCsvDir(projectId: string, sourceId: string): string {
  return path.join(DUCKDB_DIR, projectId, `${sourceId}_csv`);
}

/**
 * Manifest mapping each Excel sheet name to its CSV file (basename) in the
 * source's CSV dir. Written during the build so consumers (the federation
 * layer) can locate a sheet's CSV without replicating the file-naming/dedup
 * logic — and survives restarts that reuse the cached build.
 */
function getSourceCsvManifestPath(projectId: string, sourceId: string): string {
  return path.join(getSourceCsvDir(projectId, sourceId), '_manifest.json');
}

export function writeSourceCsvManifest(
  projectId: string,
  sourceId: string,
  entries: Array<{ sheet: string; file: string }>,
): void {
  try {
    const p = getSourceCsvManifestPath(projectId, sourceId);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(entries));
  } catch (err) {
    console.warn(`[file-storage] Failed to write CSV manifest for ${sourceId}:`, err);
  }
}

/** Read the sheet→CSV-file manifest, or null if absent/unreadable. */
export function readSourceCsvManifest(projectId: string, sourceId: string): Map<string, string> | null {
  try {
    const raw = fs.readFileSync(getSourceCsvManifestPath(projectId, sourceId), 'utf8');
    const entries = JSON.parse(raw) as Array<{ sheet: string; file: string }>;
    if (!Array.isArray(entries)) return null;
    return new Map(entries.map(e => [e.sheet, e.file]));
  } catch {
    return null;
  }
}

/**
 * Delete a source's converted-CSV directory. Silently ignores a missing dir.
 * Confined to DUCKDB_DIR so an unexpected path can't escape and delete elsewhere.
 */
export function deleteSourceCsvDir(projectId: string, sourceId: string): void {
  const dir = getSourceCsvDir(projectId, sourceId);
  if (!dir.startsWith(DUCKDB_DIR)) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    console.warn(`[file-storage] Failed to delete CSV dir ${dir}:`, err);
  }
}

/**
 * Delete a source's on-disk DuckDB file. Silently ignores missing files.
 * Confined to DUCKDB_DIR so an unexpected path can't escape and delete elsewhere.
 */
export function deleteSourceDbFile(projectId: string, sourceId: string): void {
  const dbPath = getSourceDbPath(projectId, sourceId);
  if (!dbPath.startsWith(DUCKDB_DIR)) return;

  try {
    if (fs.existsSync(dbPath)) {
      fs.unlinkSync(dbPath);
      console.log(`[file-storage] Deleted DuckDB file: ${dbPath}`);
    }
  } catch (err) {
    console.warn(`[file-storage] Failed to delete DuckDB file ${dbPath}:`, err);
  }
  // The build-cache sidecar is meaningless without its DB — drop it too.
  deleteSourceMeta(projectId, sourceId);
}

// ============================================
// Build cache (skip rebuilding an unchanged file's DuckDB on restart)
// ============================================

/**
 * Metadata persisted alongside a source's `.duckdb`, recording the fingerprint
 * of the source file the DB was built from. On the next `connect()` we reuse the
 * existing `.duckdb` instead of rebuilding when the fingerprint still matches.
 */
export interface SourceBuildMeta {
  /** `size:mtimeMs` of the source file when the DuckDB was built. */
  fingerprint: string;
  /** ISO timestamp of the build, for diagnostics. */
  builtAt: string;
}

/** Sidecar path holding a source's build metadata. */
function getSourceMetaPath(projectId: string, sourceId: string): string {
  return path.join(DUCKDB_DIR, projectId, `${sourceId}.meta.json`);
}

/**
 * Cheap, stable fingerprint of a file: byte size + mtime. Any real content
 * change in this product's flows (new upload, R2/URL re-download, refresh)
 * rewrites the file and bumps mtime, so this reliably detects "the source
 * changed" without reading the whole (potentially multi-GB) file. Returns null
 * if the file can't be stat'd.
 */
export function fileFingerprint(filePath: string): string | null {
  try {
    const st = fs.statSync(filePath);
    return `${st.size}:${st.mtimeMs}`;
  } catch {
    return null;
  }
}

/** Read a source's build metadata, or null if absent/unreadable. */
export function readSourceMeta(projectId: string, sourceId: string): SourceBuildMeta | null {
  try {
    const raw = fs.readFileSync(getSourceMetaPath(projectId, sourceId), 'utf8');
    const meta = JSON.parse(raw);
    if (meta && typeof meta.fingerprint === 'string') return meta as SourceBuildMeta;
    return null;
  } catch {
    return null;
  }
}

/** Persist a source's build metadata next to its `.duckdb`. */
export function writeSourceMeta(projectId: string, sourceId: string, meta: SourceBuildMeta): void {
  try {
    const p = getSourceMetaPath(projectId, sourceId);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(meta));
  } catch (err) {
    console.warn(`[file-storage] Failed to write build meta for ${sourceId}:`, err);
  }
}

/** Delete a source's build metadata sidecar. Confined to DUCKDB_DIR. */
export function deleteSourceMeta(projectId: string, sourceId: string): void {
  const p = getSourceMetaPath(projectId, sourceId);
  if (!p.startsWith(DUCKDB_DIR)) return;
  try { fs.unlinkSync(p); } catch { /* ignore missing */ }
}

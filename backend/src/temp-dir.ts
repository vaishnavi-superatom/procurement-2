/**
 * Temp-directory bootstrap.
 *
 * Redirects the process temp directory off the OS default — which on many Linux
 * hosts is a small, RAM-backed tmpfs (`/tmp`, sized at ~50% of RAM) — onto the
 * working-directory disk, alongside `uploads/` and `duckdb/`.
 *
 * Why: ingesting a large Excel/CSV spools multi-GB scratch through
 * `os.tmpdir()` (the xlsx unzip/parse step). On a tmpfs that overflows RAM and
 * fails the write with EDQUOT ("Unknown system error -122"), so large uploads
 * die during "create data source" even when the real disk has plenty of room.
 *
 * This module is imported FIRST in app.ts so `process.env.TMPDIR` is set before
 * any library reads `os.tmpdir()`. It always overrides TMPDIR so the app
 * deterministically owns its temp location and can't silently fall back to a
 * tmpfs left over in the environment.
 */
import * as fs from 'fs';
import * as path from 'path';

const tmpDir = path.resolve(process.cwd(), 'tmp');
try {
  fs.mkdirSync(tmpDir, { recursive: true });
  process.env.TMPDIR = tmpDir;
  console.log(`[temp-dir] Temp files redirected to disk: ${tmpDir}`);
} catch (err) {
  console.warn(`[temp-dir] Could not create ${tmpDir}; falling back to OS default temp:`, err);
}

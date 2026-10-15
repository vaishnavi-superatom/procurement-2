/**
 * Worker pool for the SQL authorization rewriter.
 *
 * SQLGlot is Python; our data plane is Node. The rewriter therefore runs as a
 * small pool of long-lived Python processes, spoken to over line-delimited
 * JSON on stdin/stdout — one request per line, one response per line. The
 * sidecar exists only because the best parser for this job is in another
 * language; the security properties come from the AST, not from the process
 * boundary. See backend/docs/SQL-AUTHORIZATION-DESIGN.md.
 *
 * This file owns process lifecycle only: checkout, idle reaping, retry-once on
 * a dead worker, and killing children when the parent exits. Policy decisions
 * (what happens when the pool is unavailable) live in sql-rewrite.ts.
 */

import { ChildProcess, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';

export interface RewriteRequest {
  sql: string;
  read: string;
  write: string;
  policies?: unknown[];
  readableTables?: string[];
  maxRows?: number;
  allowWrites?: boolean;
}

export interface RewriteResponse {
  ok: boolean;
  sql?: string;
  cappedTo?: number | null;
  probeLimit?: number | null;
  applied?: string[];
  error?: string;
}

/**
 * Locate the Python side.
 *
 * `tsc` emits to `backend/dist/backend/src/...` and copies no .py files, so a
 * single `__dirname`-relative path works in dev (ts-node) and silently breaks
 * in a built deploy. Walk up instead, and let an env var override outright.
 */
function findRewriteRoot(): string {
  const override = process.env.SA_SQL_REWRITE_DIR;
  if (override) return path.resolve(override);

  const seen: string[] = [];
  for (const base of [__dirname, process.cwd()]) {
    let dir = base;
    for (let up = 0; up < 8; up++) {
      const candidate = path.join(dir, 'sqlrewrite', 'worker.py');
      seen.push(candidate);
      if (fs.existsSync(candidate)) return path.dirname(candidate);
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  // Nothing found: return the dev-layout path so the error names something real.
  return path.resolve(__dirname, '../../../sqlrewrite');
}

const ROOT = findRewriteRoot();
const WORKER = path.join(ROOT, 'worker.py');
const PYTHON = process.env.SA_SQL_REWRITE_PYTHON || 'python3';

const POOL_SIZE = Number(process.env.SA_SQL_REWRITE_POOL_SIZE || 2);
const IDLE_MS = Number(process.env.SA_SQL_REWRITE_IDLE_MS || 5 * 60_000);
const TIMEOUT_MS = Number(process.env.SA_SQL_REWRITE_TIMEOUT_MS || 5_000);

/** Raised when the rewriter could not be consulted at all (vs. rejecting a query). */
export class RewriterUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RewriterUnavailableError';
  }
}

interface Pending {
  resolve: (r: RewriteResponse) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

class Worker {
  private proc: ChildProcess | null = null;
  private buf = '';
  private nextId = 1;
  private pending = new Map<number, Pending>();
  busy = false;
  lastUsed = Date.now();

  get alive(): boolean {
    return this.proc !== null && !this.proc.killed && this.proc.exitCode === null;
  }

  start(): void {
    this.proc = spawn(PYTHON, [WORKER], {
      cwd: ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1' },
    });

    this.proc.stdout?.on('data', (chunk: Buffer) => this.onData(chunk));
    this.proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) console.warn(`[sqlrewrite] worker stderr: ${text.slice(0, 500)}`);
    });
    this.proc.on('exit', (code, signal) => this.onExit(code, signal));
    this.proc.on('error', (err) => this.failAll(new Error(`worker spawn failed: ${err.message}`)));
  }

  private onData(chunk: Buffer): void {
    this.buf += chunk.toString();
    let idx: number;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as RewriteResponse & { id?: number };
        const p = msg.id != null ? this.pending.get(msg.id) : undefined;
        if (!p) continue;
        this.pending.delete(msg.id!);
        clearTimeout(p.timer);
        p.resolve(msg);
      } catch {
        console.warn(`[sqlrewrite] unparseable worker output: ${line.slice(0, 200)}`);
      }
    }
  }

  private onExit(code: number | null, signal: string | null): void {
    this.proc = null;
    this.failAll(new RewriterUnavailableError(`worker exited (code=${code} signal=${signal})`));
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  send(payload: Record<string, unknown>): Promise<RewriteResponse> {
    if (!this.alive || !this.proc?.stdin?.writable) {
      return Promise.reject(new RewriterUnavailableError('worker is not running'));
    }
    const id = this.nextId++;
    return new Promise<RewriteResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // A worker that missed a deadline may still answer later and desync
        // the stream; retire it rather than trusting the next response.
        this.kill();
        reject(new RewriterUnavailableError(`rewrite timed out after ${TIMEOUT_MS}ms`));
      }, TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.proc!.stdin!.write(`${JSON.stringify({ ...payload, id })}\n`, (err) => {
        if (!err) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new RewriterUnavailableError(`write to worker failed: ${err.message}`));
      });
    });
  }

  kill(): void {
    this.failAll(new RewriterUnavailableError('worker retired'));
    try {
      this.proc?.kill('SIGKILL');
    } catch {
      /* already gone */
    }
    this.proc = null;
  }
}

class SqlglotPool {
  private workers: Worker[] = [];
  private reaper: NodeJS.Timeout | null = null;
  private exitHooked = false;

  available(): boolean {
    return fs.existsSync(WORKER);
  }

  private checkout(): Worker {
    let w = this.workers.find((x) => !x.busy && x.alive);
    if (!w) {
      w = this.workers.find((x) => !x.busy && !x.alive);
      if (w) w.start();
    }
    if (!w && this.workers.length < POOL_SIZE) {
      w = new Worker();
      w.start();
      this.workers.push(w);
    }
    if (!w) {
      // Pool saturated — reuse the least recently used busy worker's slot by
      // waiting is not worth the complexity here: the Python side is
      // single-request-per-line, so spawn a transient worker instead.
      w = new Worker();
      w.start();
      this.workers.push(w);
    }
    w.busy = true;
    w.lastUsed = Date.now();
    this.ensureReaper();
    this.ensureExitHook();
    return w;
  }

  private release(w: Worker): void {
    w.busy = false;
    w.lastUsed = Date.now();
  }

  private ensureReaper(): void {
    if (this.reaper) return;
    this.reaper = setInterval(() => {
      const now = Date.now();
      for (const w of this.workers) {
        if (!w.busy && w.alive && now - w.lastUsed > IDLE_MS) w.kill();
      }
      if (this.workers.every((w) => !w.alive) && this.reaper) {
        clearInterval(this.reaper);
        this.reaper = null;
      }
    }, Math.max(30_000, IDLE_MS / 2));
    this.reaper.unref?.();
  }

  private ensureExitHook(): void {
    if (this.exitHooked) return;
    this.exitHooked = true;
    const shutdown = () => this.shutdown();
    process.once('exit', shutdown);
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  }

  /** One retry on a dead worker, per the reference implementation. */
  async rewrite(req: RewriteRequest): Promise<RewriteResponse> {
    if (!this.available()) {
      throw new RewriterUnavailableError(`rewriter not installed at ${WORKER}`);
    }
    let lastErr: Error | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const w = this.checkout();
      try {
        return await w.send({ op: 'rewrite', ...req });
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        w.kill();
      } finally {
        this.release(w);
      }
    }
    throw lastErr ?? new RewriterUnavailableError('rewrite failed');
  }

  async ping(): Promise<RewriteResponse> {
    const w = this.checkout();
    try {
      return await w.send({ op: 'ping' });
    } finally {
      this.release(w);
    }
  }

  shutdown(): void {
    if (this.reaper) {
      clearInterval(this.reaper);
      this.reaper = null;
    }
    for (const w of this.workers) w.kill();
    this.workers = [];
  }
}

export const sqlglotPool = new SqlglotPool();

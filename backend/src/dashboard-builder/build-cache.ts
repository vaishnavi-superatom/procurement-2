/**
 * The compiled dashboard, kept on disk beside the program that produced it.
 *
 * A view is compiled by esbuild and checked by a TypeScript program, and the
 * second of those costs seconds on a cold call. The registry already avoids
 * repeating it *within* a process, which is enough for a page that loads six
 * panels at once and nothing else. It is not enough for the two cases that
 * actually hurt: the first reader after a restart, and every reader of every
 * dashboard after a deploy.
 *
 * So the build is written out and read back. Building becomes something that
 * happens when a dashboard is edited, and opening one becomes a file read.
 *
 * ### What a build is a function of
 *
 * Two things, and only one of them lives in the dashboard's folder:
 *
 *   the program's own sources — manifest, view, resolvers
 *   the contract the browser is running — the names a program may import
 *
 * Both are in the key. Leaving the second out is not a theoretical risk: it is
 * exactly the failure where a rebuilt frontend leaves every compiled view
 * describing a contract that no longer exists, and the dashboards go blank with
 * nothing on screen explaining why.
 *
 * ### Only successful builds are stored
 *
 * A failure is cheap to reproduce and expensive to be wrong about. Caching one
 * means a program that failed for a reason outside its own files — a contract
 * that had not arrived yet, a half-written edit — stays failed on disk until
 * something thinks to delete it. The in-memory registry cache already absorbs
 * the repeat cost of a failing program within a session.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { contractVersion } from './contract/registered';
import type { GuardViolation } from './contract/types';

/** Where a build lands. Never a program file, so publish neither copies nor deletes it. */
export const BUILD_DIR = '.build';

const CODE_FILE = 'view.js';
const META_FILE = 'build.json';

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

export interface CachedBuild {
	view: { code: string; version: string; bytes: number };
	violations: GuardViolation[];
}

interface BuildMeta {
	key: string;
	version: string;
	bytes: number;
	violations: GuardViolation[];
	builtAt: string;
}

/**
 * The sources a build is made from, hashed by content rather than by mtime.
 *
 * Content, because publishing copies files — which moves every mtime and would
 * invalidate a build that is byte-for-byte the one already on disk. The point
 * of this cache is that publishing an unchanged resolver does not cost a
 * rebuild of the view.
 */
function sourceHash(dir: string): string {
	const parts: string[] = [];
	const add = (rel: string) => {
		const full = path.join(dir, rel);
		if (fs.existsSync(full)) parts.push(rel, sha(fs.readFileSync(full, 'utf-8')));
	};

	/* Every source file, so an edit to a helper the view imports (`lib/`, `panels/`) rebuilds it. */
	const walk = (rel: string) => {
		for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
			const childRel = rel ? path.posix.join(rel, entry.name) : entry.name;
			if (entry.isDirectory()) walk(childRel);
			else if (/\.tsx?$/.test(entry.name)) add(childRel);
		}
	};
	if (fs.existsSync(dir)) walk('');

	return sha(parts.join('|'));
}

/**
 * The key this program's build must carry to be reusable.
 *
 * Empty when no contract has been registered — there is nothing to build
 * against yet, so there is nothing worth storing or trusting.
 */
export function buildKey(dir: string): string {
	const contract = contractVersion();
	if (contract === 'unregistered') return '';
	return sha(`${sourceHash(dir)}|${contract}`);
}

/** The stored build, when there is one and it was made from exactly this input. */
export function readBuild(dir: string, key: string): CachedBuild | null {
	if (!key) return null;
	try {
		const meta = JSON.parse(
			fs.readFileSync(path.join(dir, BUILD_DIR, META_FILE), 'utf-8'),
		) as BuildMeta;
		if (meta.key !== key) return null;

		const code = fs.readFileSync(path.join(dir, BUILD_DIR, CODE_FILE), 'utf-8');
		return {
			view: { code, version: meta.version, bytes: meta.bytes },
			violations: meta.violations ?? [],
		};
	} catch {
		/* Absent, unreadable, or written by an older shape. All three mean the
		 * same thing to a caller: build it. */
		return null;
	}
}

/**
 * Stores a build, or gives up quietly.
 *
 * A cache that cannot be written is a slow dashboard, not a broken one — a
 * read-only deployment or a race with another process must not turn into a
 * failed page load.
 */
export function writeBuild(
	dir: string,
	key: string,
	build: CachedBuild,
): void {
	if (!key) return;
	try {
		const out = path.join(dir, BUILD_DIR);
		fs.mkdirSync(out, { recursive: true });
		fs.writeFileSync(path.join(out, CODE_FILE), build.view.code, 'utf-8');

		const meta: BuildMeta = {
			key,
			version: build.view.version,
			bytes: build.view.bytes,
			violations: build.violations,
			builtAt: new Date().toISOString(),
		};
		fs.writeFileSync(path.join(out, META_FILE), JSON.stringify(meta, null, 2), 'utf-8');
	} catch {
		/* See above. */
	}
}

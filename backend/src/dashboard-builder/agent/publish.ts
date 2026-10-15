/**
 * The only way anything the agent wrote reaches a dashboard.
 *
 * This is where the two-agent design's safety property went. `apply()` used to
 * hold it: a task agent finished, and before its output became a dashboard the
 * platform re-validated the program, rewrote the manifest from the caller's
 * grants, and refused anything that would not compile. Nothing about that
 * reasoning depended on there being two agents, so it moves here intact.
 *
 * ### What it refuses, and why each one matters
 *
 * **A view that does not compile.** Publishing it would replace a working
 * dashboard with a broken one, which is the single outcome worse than not
 * building at all.
 *
 * **A resolver nobody ran.** *A dashboard is never the first place a query
 * runs.* A panel is only publishable once its resolver has been executed in this
 * session and returned real rows — which is knowledge the agent cannot fake,
 * because it comes from the run record rather than from anything it can write.
 *
 * **A widened blast radius.** The manifest is rewritten from the session's
 * grants every time. Not checked — rewritten. There is no version of this where
 * editing a file in the workspace grants a source.
 *
 * `layout.json` is never touched. It is the reader's file, it is not in the
 * workspace at all, and it survives every publish.
 */
import * as fs from 'fs';
import * as path from 'path';
import { validateProgramDir } from '../validate';
import { PUBLISH_BLOCKING_RULES } from '../typecheck';
import { dashboardDir, getDashboard, invalidate } from '../registry';
import { ensureLocations } from '../locations';
import { programFilesIn } from './workspace';
import {
	isVerified,
	resolverHash,
	VERIFIED_FILE,
	type WorkspaceRecord,
} from './workspaces';
import { writeManifest } from './manifest';
import { compileModule } from '../compile';
import type { ResolverMeta } from '../contract/types';

export interface PublishRequest {
	dashboardId: string;
	title: string;
	description?: string;
	grants: readonly string[];
	/** Direct-tool ids `ctx.run` may reach. Rewritten into the manifest, never checked. */
	toolGrants?: readonly string[];
	/** Absolute path to `dashboard-programs/<id>` inside the workspace. */
	programDir: string;
	/**
	 * The session's record of what has actually been run.
	 *
	 * The verification gate reads this and nothing else. Entries are written by
	 * `./run-resolver` as a side effect of executing one, so "I ran it" and "it
	 * ran" cannot come apart — and each carries the hash of the file that was run,
	 * so editing afterwards un-verifies it.
	 */
	record: WorkspaceRecord;
}

export interface PublishResult {
	published: boolean;
	summary: string;
	violations: { file: string; line: number; rule: string; detail: string; fix?: string }[];
	files: string[];
	/** Resolvers that exist in the program but were never run this session. */
	unverified: string[];
}

/** The view program, which must exist before anything can be published. */
const viewFile = (programDir: string) => path.join(programDir, 'view.tsx');

/**
 * The column names a resolver declares, or `null` if it declares none.
 *
 * Compiled rather than parsed — `meta` is TypeScript, and reading it any other
 * way means reimplementing enough of the language to eventually be wrong.
 * A resolver that declares nothing is not an error: inference covers it, less
 * well, which is a documented trade rather than a fault.
 */
async function declaredColumns(programDir: string, name: string): Promise<string[] | null> {
	try {
		const { module } = await compileModule<{ meta?: ResolverMeta }>(
			path.join(programDir, 'data', `${name}.ts`),
		);
		const columns = module?.meta?.output?.columns;
		return columns?.length ? columns.map((c) => c.name) : null;
	} catch {
		/* A resolver that will not compile is caught by validate, with a better
		 * message than anything this could add. */
		return null;
	}
}

/** Resolver names the program declares, from `data/<name>.ts`. */
function declaredResolvers(programDir: string): string[] {
	const dir = path.join(programDir, 'data');
	if (!fs.existsSync(dir)) return [];
	return fs
		.readdirSync(dir)
		.filter((f) => f.endsWith('.ts'))
		.map((f) => f.replace(/\.ts$/, ''))
		.sort();
}

export async function publish(req: PublishRequest): Promise<PublishResult> {
	const refuse = (summary: string, extra: Partial<PublishResult> = {}): PublishResult => ({
		published: false,
		summary,
		violations: [],
		files: [],
		unverified: [],
		...extra,
	});

	if (!fs.existsSync(viewFile(req.programDir))) {
		return refuse('There is no view.tsx to publish yet.');
	}

	const resolvers = declaredResolvers(req.programDir);
	if (!resolvers.length) {
		return refuse('There are no resolvers in data/ — nothing to publish.');
	}

	/**
	 * The verification gate.
	 *
	 * Checked before compiling, because "you never ran this" is a more useful
	 * thing to be told than a compile error in a panel that was never going to be
	 * publishable anyway.
	 */
	const unverified = resolvers.filter((name) => !isVerified(req.record, name));
	if (unverified.length) {
		/* Named separately because the two cases need different advice: one has
		 * never been run, the other was run and then edited. */
		const edited = unverified.filter((name) => req.record.verified.has(name));
		const never = unverified.filter((name) => !req.record.verified.has(name));

		return refuse(
			[
				`Refused: not everything here has been run.`,
				never.length ? `  never run: ${never.join(', ')}` : '',
				edited.length ? `  changed since it was run: ${edited.join(', ')}` : '',
				``,
				`Run each with ./run-resolver and look at the rows. A dashboard is never the`,
				`first place a query runs, and a resolver edited after running is one nobody`,
				`has run.`,
			]
				.filter(Boolean)
				.join('\n'),
			{ unverified },
		);
	}

	/**
	 * Does the resolver return what it says it returns?
	 *
	 * Two facts are already in hand and were never put next to each other: the
	 * columns the query **actually returned**, recorded by the server when the
	 * resolver ran, and the columns `meta.output.columns` **claims** it returns.
	 * Both are written by the agent, in the same file, and nothing compared them.
	 *
	 * That matters more than a mismatch usually would, because the declaration
	 * wins: `resolvers.ts` uses `meta.output.columns ?? inferColumns(rows)`, so
	 * the browser formats by what was declared, not by what arrived. Rename a
	 * column in the SQL and forget the declaration, and every panel reading it
	 * renders the null display forever — the query succeeds, the guard passes,
	 * publish accepts it, and the dashboard is quietly empty.
	 *
	 * Only *missing* columns are refused. A declaration may legitimately describe
	 * fewer columns than the query returns — a resolver that selects a key it does
	 * not intend to display is normal — so extra columns in the result are not an
	 * error.
	 */
	const undeclared: string[] = [];
	for (const name of resolvers) {
		const seen = req.record.verified.get(name);
		if (!seen) continue;

		const declared = await declaredColumns(req.programDir, name);
		if (!declared) continue;

		const actual = new Set(seen.columns);
		const missing = declared.filter((c) => !actual.has(c));
		if (missing.length) {
			undeclared.push(
				`${name}: declares ${missing.map((m) => `"${m}"`).join(', ')} but the query returned ` +
					`${seen.columns.map((c) => `"${c}"`).join(', ') || 'nothing'}`,
			);
		}
	}

	if (undeclared.length) {
		return refuse(
			[
				`Refused: a resolver declares columns its query does not return.`,
				...undeclared.map((u) => `  ${u}`),
				``,
				`The declaration is what the browser formats by, so a name that does not`,
				`arrive renders as "no data" on every panel that reads it — silently.`,
				`Fix the SQL or fix meta.output.columns so they agree.`,
			].join('\n'),
		);
	}

	/* Rewritten, not checked — see the header. The session already wrote one at
	 * open; this makes sure the published copy reflects the grants and title as
	 * they are now, not as they were when the conversation started. */
	writeManifest(req.programDir, {
		dashboardId: req.dashboardId,
		title: req.title,
		description: req.description,
		grants: req.grants,
		toolGrants: req.toolGrants,
	});

	const v = await validateProgramDir(req.programDir, {
		allowedSources: [...req.grants],
		allowedTools: [...(req.toolGrants ?? [])],
	});
	if (!v.valid) {
		const detail = v.violations.map((x) => `${x.file}:${x.line} ${x.detail}`).join('; ');
		return refuse(`Refused: the program does not compile. ${detail}`, {
			violations: v.violations,
		});
	}
	const blocking = v.violations.filter((x) => PUBLISH_BLOCKING_RULES.has(x.rule));
	if (blocking.length) {
		const detail = blocking.map((x) => `${x.file}:${x.line} ${x.detail} ${x.fix ?? ''}`.trim()).join('; ');
		return refuse(`Refused: ${detail}`, { violations: blocking });
	}

	/* ------------------------------- copy out -------------------------------- */

	await ensureLocations();
	const dest = dashboardDir(req.dashboardId);
	fs.mkdirSync(path.join(dest, 'data'), { recursive: true });

	/**
	 * Files the program no longer has are removed, so the published copy matches
	 * the workspace exactly.
	 *
	 * Only files this program owns, matched by the same filter that decides what
	 * gets copied — never `layout.json`, `.build/` or `.verified.json`. A resolver
	 * left behind keeps appearing in the catalogue and can still be called, which
	 * is how a deleted panel goes on answering questions.
	 */
	const keep = new Set(programFilesIn(req.programDir));
	for (const rel of programFilesIn(dest)) {
		if (!keep.has(rel)) fs.rmSync(path.join(dest, rel), { force: true });
	}

	const files: string[] = [];
	for (const rel of keep) {
		const to = path.join(dest, rel);
		fs.mkdirSync(path.dirname(to), { recursive: true });
		fs.copyFileSync(path.join(req.programDir, rel), to);
		files.push(rel);
	}

	/* What this publish proved, so a later conversation need not re-run an unchanged resolver. */
	writePublishedVerification(dest, req.record, resolvers);

	/* The registry caches compiled programs by content; a publish is exactly the
	 * moment that cache is wrong. */
	invalidate(req.dashboardId);

	return {
		published: true,
		summary: `Published ${req.dashboardId}: ${resolvers.length} resolver(s), ${files.length} file(s).`,
		violations: [],
		files,
		unverified: [],
	};
}

/** Records each published resolver's hash and returned columns beside the published program. */
function writePublishedVerification(dest: string, record: WorkspaceRecord, resolvers: readonly string[]): void {
	const proven: Record<string, { hash: string; columns: readonly string[] }> = {};
	for (const name of resolvers) {
		const seen = record.verified.get(name);
		if (seen) proven[name] = { hash: resolverHash(record.programDir, name), columns: seen.columns };
	}
	fs.writeFileSync(path.join(dest, VERIFIED_FILE), JSON.stringify(proven, null, 2) + '\n');
}

/**
 * Publishes a conversation's workspace, with the dashboard's own title and the session's grants.
 *
 * The one entry point for both the agent's `./publish` and the automatic publish at the end of a turn.
 */
export async function publishSession(record: WorkspaceRecord): Promise<PublishResult> {
	const state = await getDashboard(record.dashboardId, { skipTypecheck: true });
	return publish({
		dashboardId: record.dashboardId,
		title: state.title,
		description: state.description,
		grants: record.grants,
		toolGrants: record.toolGrants,
		programDir: record.programDir,
		record,
	});
}

/**
 * Whether the workspace holds program changes readers do not have yet.
 *
 * The view and resolvers only. `manifest.ts` is regenerated from the dashboard's row
 * on every open and every publish, so a difference there is not the agent's work.
 */
export async function hasUnpublishedChanges(record: WorkspaceRecord): Promise<boolean> {
	await ensureLocations();
	const dest = dashboardDir(record.dashboardId);
	const own = (dir: string) =>
		programFilesIn(dir).filter((rel) => rel !== 'manifest.ts');
	const working = own(record.programDir);
	const published = fs.existsSync(dest) ? own(dest) : [];
	if (working.length !== published.length) return true;
	return working.some((rel) => {
		const to = path.join(dest, rel);
		return !fs.existsSync(to) || !fs.readFileSync(to).equals(fs.readFileSync(path.join(record.programDir, rel)));
	});
}

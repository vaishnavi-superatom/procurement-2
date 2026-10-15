/**
 * `runResolver` — the verification primitive, and the runtime path.
 *
 * One function with three callers: the agent (proving its SQL before wiring a
 * panel to it), the browser (`usePanelData`), and the platform itself
 * (validation, preview, headless render). That it is *one* function is what
 * makes verification honest — what the agent saw when it tested is literally
 * what a viewer gets, rather than a parallel "test" path that can drift.
 *
 * The sequence, and every step earns its place:
 *
 *   compile        TypeScript → CJS, content-hashed          compile.ts
 *   read meta      what this resolver declares
 *   validate       params against that declaration            params.ts
 *   build ctx      the only capability it gets                query.ts
 *   execute        with a deadline
 *   shape          cap rows, derive columns, record timings
 */
import * as fs from 'fs';
import * as path from 'path';
import { compileModule, CompileError } from './compile';
import { validateParams, ParamError } from './params';
import { createContext, DEFAULT_STATEMENT_ROW_CAP, type QueryRecord } from './query';
import type {
	ColumnMeta,
	DataResult,
	ResolverModule,
	ResolverParams,
	ResolverSummary,
	Row,
	Rows,
} from './contract/types';

/**
 * The ceiling on what a resolver may hand a panel.
 *
 * Fixed by the platform. Nothing a dashboard writes can change it.
 */
export const DEFAULT_MAX_ROWS = 5_000;

/**
 * How long one resolver may take before it is cancelled.
 *
 * Was 30s, chosen when the only connected source was an Excel workbook read
 * through DuckDB, where anything slower meant a mistake. A real warehouse is a
 * different proposition: a SuiteQL join across `timebill`, `charge` and `job`
 * over a year of rows is legitimately slow the first time, and killing it at
 * thirty seconds turned "this is a heavy query" into "this query is broken",
 * which is a much harder thing for an agent to debug.
 *
 * Five minutes, and the cost of a long one is paid once — the result is cached
 * for an hour, so the next reader waits for nothing.
 *
 * A resolver may still set its own `timeoutMs`, and a dashboard may set one in
 * `manifest.defaults`. This is only the ceiling for anything that says nothing.
 */
export const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export class ResolverError extends Error {
	constructor(
		message: string,
		readonly code:
			| 'UNKNOWN_RESOLVER'
			| 'RESOLVER_BLOCKED'
			| 'BAD_PARAMS'
			| 'RESOLVER_FAILED'
			| 'FORBIDDEN_SOURCE'
			| 'TIMEOUT' = 'RESOLVER_FAILED',
	) {
		super(message);
	}
}

export interface RunOptions {
	dashboardId: string;
	/** The dashboard's folder. */
	dir: string;
	/** Resolver name — its filename without the extension. */
	name: string;
	params?: Record<string, unknown>;
	/** Source tool ids from the manifest. Nothing else is reachable. */
	grants: readonly string[];
	/** Direct-tool ids `ctx.run` may reach. Absent means none. */
	toolGrants?: readonly string[];
	timeoutMs?: number;
	/**
	 * Go to the source, ignoring what has been remembered about the statements
	 * this resolver issues.
	 *
	 * Set by a reader's refresh and by a background recompute — the two cases
	 * where the whole point is to find out whether the numbers have moved. A
	 * recompute that read its own SQL back out of the statement cache would
	 * write the same answer down again and call it fresh.
	 */
	fresh?: boolean;
	/** Cancels the run; a caller's Stop button ends up here. */
	signal?: AbortSignal;
	/** Receives `ctx.log` lines, for the agent's run output and the server log. */
	onLog?: (line: string) => void;
}

const resolverFile = (dir: string, name: string) => path.join(dir, 'data', `${name}.ts`);

/**
 * Runs one resolver and returns its rows.
 *
 * Throws a typed `ResolverError` rather than returning a failure shape: every
 * caller has to handle failure anyway, and a thrown error cannot be mistaken
 * for an empty result — which is the confusion worth designing out.
 */
export async function runResolver(opts: RunOptions): Promise<DataResult<Rows>> {
	const file = resolverFile(opts.dir, opts.name);
	if (!fs.existsSync(file)) {
		throw new ResolverError(
			`No resolver "${opts.name}" in this dashboard. Available: ${listResolverNames(opts.dir).join(', ') || 'none'}.`,
			'UNKNOWN_RESOLVER',
		);
	}

	/* 1. compile */
	let mod: ResolverModule;
	try {
		mod = (await compileModule<ResolverModule>(file)).module;
	} catch (err) {
		throw new ResolverError(
			err instanceof CompileError ? err.message : String(err),
			'RESOLVER_BLOCKED',
		);
	}

	/* 2. read what it declares */
	const meta = mod?.meta;
	const fn = mod?.default;
	if (!meta || typeof fn !== 'function') {
		throw new ResolverError(
			`"${opts.name}" must export \`meta\` and a default function. ` +
				`Found: ${Object.keys(mod ?? {}).join(', ') || 'nothing'}.`,
			'RESOLVER_BLOCKED',
		);
	}

	/* 3. validate the call against that declaration */
	let params: ResolverParams;
	try {
		params = validateParams(meta.params, opts.params ?? {});
	} catch (err) {
		throw new ResolverError(
			err instanceof ParamError ? err.message : String(err),
			'BAD_PARAMS',
		);
	}

	/* 4. the only capability it gets */
	const queries: QueryRecord[] = [];
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const controller = new AbortController();
	const onOuterAbort = () => controller.abort();
	opts.signal?.addEventListener('abort', onOuterAbort, { once: true });

	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);

	const ctx = createContext({
		grants: opts.grants,
		toolGrants: opts.toolGrants,
		signal: controller.signal,
		fresh: opts.fresh,
		queries,
		onLog: opts.onLog,
	});

	/* 5. execute, with a deadline */
	const started = Date.now();
	let raw: unknown;
	try {
		raw = await Promise.race([
			Promise.resolve(fn(ctx, params as never)),
			new Promise((_, reject) => {
				controller.signal.addEventListener(
					'abort',
					() =>
						reject(
							new ResolverError(
								timedOut
									? `"${opts.name}" exceeded its ${Math.round(timeoutMs / 1000)}s budget.`
									: `"${opts.name}" was cancelled.`,
								'TIMEOUT',
							),
						),
					{ once: true },
				);
			}),
		]);
	} catch (err: any) {
		if (err instanceof ResolverError) throw err;
		/* A grant refusal is the resolver's own fault and is worth naming as such. */
		const code = err?.code === 'FORBIDDEN_SOURCE' ? 'FORBIDDEN_SOURCE' : 'RESOLVER_FAILED';
		throw new ResolverError(err?.message ?? String(err), code as never);
	} finally {
		clearTimeout(timer);
		opts.signal?.removeEventListener('abort', onOuterAbort);
	}

	/* 6. shape the result */
	const all: Rows = Array.isArray(raw)
		? (raw as Rows)
		: raw && typeof raw === 'object'
			? [raw as Row]
			: [];

	const maxRows = DEFAULT_MAX_ROWS;
	const data = all.slice(0, maxRows);

	return {
		data,
		columns: meta.output?.columns ?? inferColumns(data),
		meta: {
			resolver: opts.name,
			elapsedMs: Date.now() - started,
			rowCount: data.length,
			/* Before the slice — this is what lets a panel report how many rows
			 * instead of "some rows are not shown". */
			totalRows: all.length,
			/* The platform cut, or a statement hit its ceiling. A full page of a paged
			 * read, or a LIMIT the author wrote, is not rows lost. */
			truncated: all.length > maxRows || queries.some((q) => q.truncated && q.rows >= DEFAULT_STATEMENT_ROW_CAP),
			cached: false,
			computedAt: new Date().toISOString(),
			/* Picked field by field rather than passed through: `truncated` and
			 * `tool` are this layer's bookkeeping and have already been folded into
			 * `meta.truncated` above, so forwarding them would put two answers to
			 * the same question on the wire. */
			queries: queries.map(({ source, elapsedMs, rows, sql }) => ({ source, elapsedMs, rows, sql })),
		},
	};
}

/**
 * Columns derived from the rows, when a resolver did not declare them.
 *
 * A fallback, not a feature. Inference cannot see a column that is null in
 * every returned row, and cannot know that an integer is a currency — which is
 * exactly why `meta.output.columns` exists and why the authoring guide asks for
 * it.
 */
function inferColumns(rows: Rows): ColumnMeta[] {
	const first = rows[0];
	if (!first) return [];
	return Object.keys(first).map((name) => {
		const sample = rows.find((r) => r[name] !== null && r[name] !== undefined)?.[name];
		const dataType =
			typeof sample === 'number'
				? Number.isInteger(sample)
					? ('integer' as const)
					: ('number' as const)
				: typeof sample === 'boolean'
					? ('boolean' as const)
					: ('string' as const);
		return { name, dataType };
	});
}

/* --------------------------------- listing --------------------------------- */

export function listResolverNames(dir: string): string[] {
	const dataDir = path.join(dir, 'data');
	if (!fs.existsSync(dataDir)) return [];
	return fs
		.readdirSync(dataDir)
		.filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'))
		.map((f) => f.replace(/\.ts$/, ''))
		.sort();
}

/**
 * Every resolver's declaration, without running any of them.
 *
 * What a catalogue shows, what the agent reads to know what already exists, and
 * what the view is type-checked against. A resolver that fails to compile
 * appears here with its error rather than vanishing — an absent resolver and a
 * broken one are different problems and must look different.
 */
export async function listResolvers(dir: string): Promise<ResolverSummary[]> {
	const out: ResolverSummary[] = [];

	for (const name of listResolverNames(dir)) {
		try {
			const { module: mod, version } = await compileModule<ResolverModule>(
				resolverFile(dir, name),
			);
			const meta = mod?.meta;
			if (!meta || typeof mod?.default !== 'function') {
				out.push({
					name,
					title: name,
					params: {},
					version,
					errors: ['Must export `meta` and a default function.'],
				});
				continue;
			}
			out.push({
				name,
				title: meta.title ?? name,
				description: meta.description,
				params: meta.params ?? {},
				output: meta.output,
				version,
				errors: [],
			});
		} catch (err: any) {
			out.push({
				name,
				title: name,
				params: {},
				version: '',
				errors: [err?.message ?? String(err)],
			});
		}
	}

	return out;
}

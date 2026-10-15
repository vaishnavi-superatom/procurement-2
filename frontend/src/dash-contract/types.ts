/**
 * The v1 contract — the shape both programs and the platform agree on.
 *
 * Trimmed hard from the full contract in `dash-builder/docs/contract/`: this is
 * only what Stage 0 needs to compile, load, render and query. Everything else
 * (interactions, drill, pages, themes, the component registry) is designed but
 * deliberately absent until something needs it.
 *
 * MIRROR — do not edit here first. The canonical copy is
 * `backend/src/dashboard-builder/contract/types.ts`; changes start there and are
 * copied across, the same way `sdk-web/src/types.ts` mirrors `sdk-nodejs`. The
 * two must stay identical below this header.
 *
 * The frontend is a separate package, so there is no shared module to hold this
 * without a publish cycle in the middle of every edit.
 */

/* --------------------------------- values --------------------------------- */

/**
 * The only leaf values a row may contain.
 *
 * `bigint` is absent deliberately. Warehouse ids routinely exceed
 * `Number.MAX_SAFE_INTEGER`, and a silently-rounded id surfaces weeks later as
 * "the drill-through opened the wrong record". Resolvers cast such columns to
 * string on the way out.
 */
export type ScalarValue = string | number | boolean | null;

export type Row = Record<string, ScalarValue>;
export type Rows = Row[];

export type DataType = 'string' | 'number' | 'integer' | 'boolean' | 'date' | 'datetime' | 'json';

/**
 * What a value *means*, as opposed to how it is stored.
 *
 * Small on purpose for v1 — only the types that change a rendering decision
 * today. The full registry is in the contract docs.
 */
export type SemanticType =
	| 'entity_key'
	| 'category'
	| 'quantity'
	| 'currency'
	| 'percentage'
	| 'creation_timestamp';

export interface ValueFormat {
	style?: 'number' | 'percent' | 'currency' | 'text' | 'date';
	decimals?: number;
	prefix?: string;
	suffix?: string;
	/** `1.2M` rather than `1,234,567`. */
	compact?: boolean;
	currency?: string;
	/**
	 * Multiplier applied before display — for a unit change, not for correcting
	 * bad data. Storing cents and showing dollars is the case this exists for.
	 */
	scale?: number;
	/** What to show for null. Defaults to an em dash — never `0`, which is a different claim. */
	nullDisplay?: string;
	align?: 'left' | 'center' | 'right';
}

export interface ColumnMeta {
	name: string;
	label?: string;
	dataType: DataType;
	semanticType?: SemanticType;
	format?: ValueFormat;
}

/* ------------------------------- data program ------------------------------ */

export type ResolverParamType = 'string' | 'number' | 'boolean' | 'date' | 'enum' | 'list';

/** A parameter's value: one scalar, or a list of them for a `list` parameter. */
export type ParamValue = ScalarValue | readonly ScalarValue[];

export interface ResolverParamSpec {
	type: ResolverParamType;
	optional?: boolean;
	default?: ParamValue;
	/** Required for `enum`; an allowlist for `string`, and for each item of a `list`. */
	values?: readonly (string | number)[];
	/** Item type of a `list`. Defaults to `string`. */
	items?: 'string' | 'number' | 'boolean' | 'date';
	description?: string;
}

export type ResolverParamSchema = Record<string, ResolverParamSpec>;

/** Parameter values after validation. Never objects, never functions. */
export type ResolverParams = Record<string, ParamValue>;

export interface ResolverMeta {
	/** One line on what this resolver answers. */
	title: string;
	description?: string;
	params?: ResolverParamSchema;
	/**
	 * Declared result columns.
	 *
	 * Not optional in spirit: declaring them lets a component's render contract
	 * be checked before a single row exists, and lets the view be written
	 * against something known. Skipping it pushes every such error to runtime.
	 */
	output?: { columns: ColumnMeta[] };
	/** Seconds a result stays fresh. Absent means do not cache. */
	cacheTtlSeconds?: number;
}

/* ------------------------------ semantic layer ----------------------------- */

export type SemanticFilterOp =
	| '='
	| '!='
	| '>'
	| '>='
	| '<'
	| '<='
	| 'in'
	| 'not in'
	| 'between'
	| 'like'
	| 'is null'
	| 'is not null';

/**
 * One condition, applied either before or after grouping.
 *
 * `field` names a dimension as `dataset.field` and becomes a `WHERE`. `metric`
 * names a metric and becomes a `HAVING`, so it filters the grouped rows rather
 * than the underlying ones — "projects whose soft total is above zero", not
 * "rows that happen to be non-zero". Exactly one of the two.
 */
export type SemanticFilter =
	| { field: string; metric?: never; op: SemanticFilterOp; value?: unknown }
	| { metric: string; field?: never; op: SemanticFilterOp; value?: unknown };

/**
 * A question asked of a governed model rather than of a table.
 *
 * The metric names, the dimension refs and the filterable fields all come from
 * one model's manifest. Nothing here is free text: a name the model does not
 * define is a rejected query, not an empty result.
 */
export interface SemanticQuery {
	model: string;
	metrics: string[];
	/** `dataset.field`. Pass `[]` for a single total. */
	dimensions?: string[];
	filters?: SemanticFilter[];
	orderBy?: { field?: string; metric?: string; dir?: 'asc' | 'desc' }[];
	limit?: number;
	/** Named values consumed by a model's programs and `{{...}}` expressions. */
	params?: Record<string, unknown>;
}

/**
 * The only capability a resolver is given.
 *
 * It imports types and its own siblings — not a driver, not `node:fs`, not
 * `fetch`, not `process`. A capability that was never imported cannot be
 * misused, which is a stronger guarantee than sandboxing one that was.
 */
export interface ResolverContext {
	/**
	 * One statement against a granted source.
	 *
	 * `source` is a **source tool id** — the same id `getSourceTools()` returns
	 * and the script bridge already speaks. Anything the manifest does not grant
	 * is refused here, not in the query.
	 *
	 * Parameters are **named**, written `$name` in the SQL and passed as an
	 * object. Positional `$1`/`$2` does not work: the platform's source layer
	 * takes a named map and each source resolves it its own way — postgres
	 * translates to positional bindings, DuckDB substitutes escaped literals and
	 * deliberately leaves `$1`-style placeholders untouched.
	 *
	 * A `list` parameter is written `col IN ($name)` and expands to one bound
	 * value per item. `$name_count` is bound beside it, so "nothing picked means
	 * no filter" is `($name_count = 0 OR col IN ($name))`.
	 *
	 * Never build SQL by concatenating a value. The declared parameter schema is
	 * what actually keeps a filter a value here: every argument has been coerced
	 * to its declared type before it reaches this call, so a string cannot
	 * arrive where a number was promised. `${}` inside a statement escapes that
	 * check entirely, which is why the guard rejects it.
	 */
	sql<T = Record<string, unknown>>(
		source: string,
		text: string,
		params?: Record<string, unknown>,
	): Promise<T[]>;

	/**
	 * One call to a granted **tool** — pre-built business logic, not raw SQL.
	 *
	 * Some logic does not live in a query. A concept with a `program` is verified,
	 * tested code the platform maintains, and rewriting it as SQL inside a
	 * resolver is how two versions of one rule start disagreeing. Without this
	 * there was no route to a program from a resolver at all: an agent could run
	 * one with `./run-tool`, see the right answer, and have nowhere legitimate to
	 * put it — which ends with the numbers pasted into the file as a constant,
	 * correct on the day and wrong from then on.
	 *
	 * `tool` is a direct-tool id, the same ids `./run-tool` accepts. Source query
	 * tools are deliberately not reachable here: reading data is `sql`'s job, and
	 * two routes to it would mean two places a grant has to be checked.
	 *
	 * `params` is whatever that tool declares — there is no fixed shape, and a
	 * field like `concept`'s `method` belongs to that tool rather than to this
	 * call. Each tool's own params are listed beside it in `./sources`.
	 *
	 * The result is unwrapped the way `sql` unwraps a source's: a tool reporting
	 * `{ error }` throws, so a failure cannot be mistaken for an empty result,
	 * and `{ data }` is handed back as the data.
	 */
	run<T = unknown>(tool: string, params?: Record<string, unknown>): Promise<T>;

	/**
	 * One question asked of a **semantic model** — a governed metric, not SQL.
	 *
	 * Reach for this before `sql` whenever a model already defines the number.
	 * A model holds the definition once: which table a fact comes from, how it
	 * joins, the filter that is always applied, how a rate is weighted. Writing
	 * that again in a resolver is how two dashboards start disagreeing about
	 * revenue, and the second author never sees the first author's `WHERE`.
	 *
	 * `source` is a granted source tool id, checked exactly as `sql` checks it.
	 * The compiled statement is recorded in `meta.queries` beside anything the
	 * resolver wrote by hand, so a panel can still show what produced it.
	 *
	 * Metric columns come back as numbers, dimension columns as they are stored.
	 * A metric or dimension the model does not define is an error, never an
	 * empty result — a typo and a genuinely empty month must not look alike.
	 *
	 * Run `./semantic models` and `./semantic manifest <model>` to see what a
	 * model offers before writing one of these.
	 */
	semantic(source: string, query: SemanticQuery): Promise<Rows>;

	/** Sources this dashboard is granted, for reference. */
	readonly sources: readonly string[];

	/** Tools this dashboard is granted, for reference. */
	readonly tools: readonly string[];

	/** Visible in the server log and in the agent's run-resolver output. */
	log(...args: unknown[]): void;

	/** Aborted when the resolver exceeds its time budget. */
	readonly signal: AbortSignal;
}

export type Resolver<P extends ResolverParams = ResolverParams, R = Rows> = (
	ctx: ResolverContext,
	params: P,
) => Promise<R> | R;

/** What every file in `data/` must export. */
export interface ResolverModule<P extends ResolverParams = ResolverParams, R = Rows> {
	meta: ResolverMeta;
	default: Resolver<P, R>;
}

/* --------------------------------- results --------------------------------- */

export interface ResultMeta {
	resolver: string;
	elapsedMs: number;
	rowCount: number;
	/**
	 * Rows the resolver produced **before** the cap. Equal to `rowCount` when
	 * nothing was cut.
	 *
	 * "Some rows are not shown" tells a reader they are missing something but not
	 * how much, which is the difference between a caveat and a number. With this
	 * a table can state how many rows of the total it is showing.
	 *
	 * A `LIMIT` written into the SQL is applied by the database, so what arrives
	 * here is already the capped set and this equals `rowCount`.
	 */
	totalRows: number;
	/**
	 * A row cap cut the result short. The view must surface this — a chart
	 * quietly drawn from the first 10,000 of 4,000,000 rows is the most
	 * expensive kind of wrong.
	 */
	truncated: boolean;
	cached: boolean;
	/**
	 * These rows came from the cache, and a recompute is running behind them.
	 *
	 * The panel's cue to ask once more with `awaitRefresh`, which waits for that
	 * run and returns what it found. Without the second ask the reader keeps an
	 * answer the server has already replaced.
	 */
	revalidating?: boolean;
	computedAt: string;
	/**
	 * Per-statement timings, and the statement itself.
	 *
	 * The agent's verification aid, and the reader's. `sql` is what `Provenance`
	 * renders: a panel that cannot be checked has to be taken on trust, and the
	 * three dashboards this contract is measured against all put the statements
	 * on screen.
	 *
	 * It reaches the browser, so it is table and column names in front of anyone
	 * who can open the dashboard. That is not a new exposure today — every
	 * connected source is granted to every reader, and there is no per-user
	 * source permission anywhere in the platform — but it is the line to revisit
	 * on the day there is one.
	 *
	 * Absent for a `ctx.run` call: a tool is not a statement, and `source` already
	 * names it.
	 */
	queries?: { source: string; elapsedMs: number; rows: number; sql?: string }[];
}

export interface DataResult<T = Rows> {
	data: T;
	columns?: ColumnMeta[];
	meta: ResultMeta;
}

/* -------------------------------- manifest --------------------------------- */

export interface DashboardManifest {
	/** Stable and opaque. Also the folder name. */
	id: string;
	title: string;
	description?: string;
	grants: {
		/** Source **tool ids** the resolvers may reach. The blast radius, not a convenience. */
		sources: string[];
		/**
		 * Direct-tool ids `ctx.run` may reach. Absent means none.
		 *
		 * Separate from `sources` because they are different kinds of reach: a
		 * source is data the dashboard may read, a tool is logic it may invoke —
		 * and a tool decides its own source at call time, so granting one is not
		 * the same as granting what it queries.
		 */
		tools?: string[];
	};
	defaults?: {
		timeoutMs?: number;
		cacheTtlSeconds?: number;
	};
}

/* --------------------------------- layout ---------------------------------- */

/**
 * Sizes and order. Never coordinates.
 *
 * Because no entry can name a position, two panels overlapping is not a state
 * this file is capable of describing — the invariant is unrepresentable rather
 * than validated, so there is no packing pass and no collision check.
 */
export interface PanelSize {
	/** Matches the `id` prop of a `<Panel>`. */
	i: string;
	/** Width in twelfths at the widest breakpoint. */
	span: number;
	/** Height in row units. Exact, not a floor. */
	h: number;
	/** Taken off the dashboard without touching its code, and reversible. */
	hidden?: boolean;
}

/**
 * The **reader's** arrangement, and only that.
 *
 * The agent never writes this file. It declares `minW`/`minH`/`defaultW`/
 * `defaultH` on each `<Panel>` in code; this holds what the reader changed.
 * `reconcile()` merges them at render time, which is why an agent can add a
 * panel without touching the layout at all.
 */
export interface DashboardLayout {
	version: 1;
	/** Reading order is this array's order. */
	panels: PanelSize[];
	updatedAt?: string;
}

/** What a `<Panel>` declares about itself. Never stored in the layout file. */
export interface PanelSpec {
	id: string;
	/**
	 * What the panel calls itself, for anything that has to name it to a person.
	 *
	 * The id is the key a saved arrangement stores against and reads like one;
	 * "rag-by-pillar" is the wrong thing to put in front of someone choosing a
	 * panel to talk about. Optional because a panel is allowed to have no title.
	 */
	title?: string;
	minW: number;
	minH: number;
	defaultW: number;
	defaultH: number;
}

/* --------------------------------- guard ----------------------------------- */

export interface GuardViolation {
	file: string;
	line: number;
	rule: string;
	detail: string;
	/** A concrete correction, when one exists. Fed back to the agent verbatim. */
	fix?: string;
}

/* -------------------------------- summary ---------------------------------- */

export interface ResolverSummary {
	name: string;
	title: string;
	description?: string;
	params: ResolverParamSchema;
	output?: { columns: ColumnMeta[] };
	/** Content hash of the file — also its cache-key component. */
	version: string;
	/** Populated when the file fails the guard or does not compile. */
	errors: string[];
}

export interface DashboardSummary {
	id: string;
	title: string;
	description?: string;
	grants: DashboardManifest['grants'];
	/** False when a guard rejected it. It will not be mounted. */
	valid: boolean;
	/**
	 * Registered, but nothing built yet — a row exists and the folder does not.
	 *
	 * Distinct from `valid: false`, which means something IS there and is broken.
	 * A reader needs to tell "ask for a panel" apart from "this is failing", and
	 * one boolean cannot say both.
	 */
	empty?: boolean;
	violations: GuardViolation[];
	/** Content hash of the view program. The module URL's cache key. */
	viewVersion: string;
	layoutVersion: string;
	resolvers: ResolverSummary[];
	/**
	 * From the dashboard's row, so they mean what a reader assumes.
	 *
	 * Both were `new Date()` at read time, which made every card say the
	 * dashboard had been updated seconds ago whether or not anything had
	 * happened to it. Absent when there is no row — a folder-only dashboard in a
	 * database-less dev setup has no dates to report, and reporting none is
	 * better than reporting now.
	 */
	createdAt?: string;
	updatedAt?: string;
}

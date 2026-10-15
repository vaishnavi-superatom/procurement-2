/**
 * What a contract export says about itself.
 *
 * Attached to the export, beside its code, as `Thing.Metadata = { … }` — the
 * same convention the platform's own components already use (see any component
 * in `src/components/`, and how `superatom.ts` collects them). Two reasons to
 * follow it rather than keep a list somewhere:
 *
 *  - **A description that lives elsewhere drifts.** Before this, the contract's
 *    surface was typed out in three places and `AreaChart` was missing from all
 *    of them while being fully implemented — working, styled, and reachable by
 *    nothing. Deleting a component now deletes its description; there is no
 *    second place to forget.
 *  - **It is already how this repository describes a component to an LLM.** A
 *    second mechanism for the same job is a thing to keep in sync.
 *
 * ### Deliberately a separate collection
 *
 * These are *not* added to `COMPONENTS` in `superatom.ts`. That map feeds the
 * main chat agent's component picker for the JSON DSL — a different audience
 * doing a different job. A dash contract export is an import inside a generated
 * React program, not a DSL node, and mixing the two lists would offer each
 * agent components it cannot use.
 *
 * ### Two fields, two audiences
 *
 * `purpose` is one line and goes into every prompt. Everything else is fetched
 * on demand by `./component <name>`. Four components fit in a prompt and forty
 * do not, so the index has to stay one line per entry however far the library
 * grows — BLUEPRINT §6, "inject an index, retrieve the detail".
 */

/** Groups the prompt index so it can be skimmed. */
export type ContractKind =
	| 'environment'
	| 'data'
	| 'structure'
	| 'status'
	| 'display'
	| 'filter'
	| 'format';

/**
 * What one prop is for.
 *
 * A plain string when a line will do — which is most of them, and which matches
 * the convention the platform's own `ComponentMetadata` already uses. Forcing an
 * object on all forty props would make this a chore to write, and metadata that
 * is a chore to write is metadata that stops getting written. That is how
 * `AreaChart` ended up implemented and undescribed.
 *
 * Note what is **not** here: a `type` field. TypeScript already has the type,
 * `./validate` already enforces it, and `./component` prints the real signature
 * from the compiler. A copy of the type in prose is one more thing that can
 * drift — the previous `props: 'BarChart({ data, x, … })'` string was exactly
 * that, and it was missing nine of the fifteen props by the time anyone looked.
 */
export type PropMeta =
	| string
	| {
			description: string;
			/**
			 * Defaults to `optional`.
			 *
			 * `recommended` is the one that earns its place: an agent cannot tell from
			 * a type that `columns` is technically optional but you are wrong not to
			 * pass it, or that an axis without a title makes the reader guess what
			 * they are looking at.
			 */
			importance?: 'required' | 'recommended' | 'optional';
			/** The real default, not prose describing one. */
			default?: string | number | boolean;
			/** What goes wrong when this is misused. The part a type cannot carry. */
			caution?: string;
			/** For components with enough props that a flat list is a wall. */
			group?: string;
	  };

export interface ContractMeta {
	kind: ContractKind;
	/** One line. Injected into every prompt — keep it skimmable at forty entries. */
	purpose: string;
	/**
	 * The props, by name. Fetched on demand, never injected.
	 *
	 * **Only what actually works.** A prop that is declared but unwired does not
	 * belong here: an agent told about it will use it, report the feature done,
	 * and be wrong. `onSelect` is typed on every chart and called by none of
	 * them, so it is absent until something calls it.
	 */
	props?: Record<string, PropMeta>;
	/** When to reach for this rather than its neighbours. */
	useWhen?: string;
	/** Anything that will otherwise be got wrong. */
	notes?: string;
}

/** An export that carries its own description. */
export type Described<T> = T & { Metadata: ContractMeta };

/**
 * Attaches metadata and hands the value back, so a description reads as part of
 * the declaration rather than as a statement that follows it.
 *
 * `export const Foo = describe(impl, { … })` keeps the two inseparable — you
 * cannot copy the component to a new file and leave its description behind.
 */
export function describe<T extends object>(value: T, meta: ContractMeta): Described<T> {
	(value as { Metadata?: ContractMeta }).Metadata = meta;
	return value as Described<T>;
}

/** One entry of the collected registry: the name, plus what it said about itself. */
export interface ContractEntry extends ContractMeta {
	name: string;
}

/**
 * Collects metadata off a map of exports — the same filter `superatom.ts` uses.
 *
 * Anything without `Metadata` is reported rather than skipped. A contract export
 * nobody described is one the agent will never be told about, which is the exact
 * failure this file exists to prevent, so it must not be possible to add one
 * quietly.
 */
export function collectRegistry(exports: Record<string, unknown>): {
	registry: ContractEntry[];
	undescribed: string[];
} {
	const registry: ContractEntry[] = [];
	const undescribed: string[] = [];

	for (const [name, value] of Object.entries(exports)) {
		const meta = (value as { Metadata?: ContractMeta } | null)?.Metadata;
		if (meta?.purpose) registry.push({ name, ...meta });
		else undescribed.push(name);
	}

	return { registry, undescribed };
}

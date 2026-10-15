/**
 * The host — parameters, data, layout.
 *
 * A generated view sees none of this directly. It calls `useParam` and
 * `usePanelData`, and this is what stands behind them.
 *
 * The important design point is that **the host owns parameter state**, not the
 * view. A `useState` inside a generated program has no name anything else can
 * see, so there is nowhere to put a URL, a chart click, a drill step or a saved
 * view. Declaring the parameter here is what makes all of those one mechanism
 * instead of four.
 */
import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	type ReactNode,
} from 'react';
import type {
	DashboardLayout,
	DataResult,
	PanelSize,
	PanelSpec,
	ParamValue,
	Rows,
	ScalarValue,
} from './types';
import type { ContractMeta } from './meta';
/* The one place the contract reaches into the shell: reconcile is the single
 * definition of "stored arrangement merged with what is on screen", and having
 * a second copy here is exactly how the two would drift. */
import { reconcile } from '../dash-shell/layout-engine';

/* --------------------------------- errors ---------------------------------- */

export type ContractErrorCode =
	| 'BAD_REQUEST'
	| 'FORBIDDEN_SOURCE'
	| 'UNKNOWN_DASHBOARD'
	| 'UNKNOWN_RESOLVER'
	| 'BAD_PARAMS'
	| 'RESOLVER_BLOCKED'
	| 'RESOLVER_FAILED'
	| 'TIMEOUT'
	| 'NOT_FOUND';

export class ContractError extends Error {
	/**
	 * Fields are assigned explicitly rather than declared as constructor
	 * parameter properties — the build runs with `erasableSyntaxOnly`, which
	 * forbids syntax that emits code rather than just erasing types.
	 */
	readonly code: ContractErrorCode;
	/** Present when the platform can suggest a correction. */
	readonly hint?: string;

	constructor(code: ContractErrorCode, message: string, hint?: string) {
		super(message);
		this.name = 'ContractError';
		this.code = code;
		this.hint = hint;
	}
}

/* -------------------------------- transport -------------------------------- */

/**
 * How the host reaches the server.
 *
 * An interface rather than a hard dependency on the SDK, so the contract
 * runtime can be exercised against a local function in a dev page and against
 * the websocket in the platform, with no change to anything a view can see.
 */
export interface DashboardTransport {
	runResolver(
		dashboardId: string,
		name: string,
		params: Record<string, ParamValue>,
		/**
		 * `fresh` skips the server's cache and replaces what it holds — a global
		 * recompute, not a bypass for one reader. It is what `refresh` sends.
		 */
		options?: {
			fresh?: boolean;
			/**
			 * Wait for the recompute a stale answer already started.
			 *
			 * Starts nothing of its own. Sent by a panel that was handed
			 * `meta.revalidating`, and answers when that run lands.
			 */
			awaitRefresh?: boolean;
		},
	): Promise<DataResult<Rows>>;

	/**
	 * Persists the reader's arrangement.
	 *
	 * Optional, and that is not laziness: a dashboard rendered somewhere with
	 * nowhere to write — a static export, a preview, a test harness — should
	 * still render and still let someone try an arrangement. It simply does not
	 * survive the page. The host treats an absent implementation as a no-op.
	 */
	saveLayout?(dashboardId: string, layout: DashboardLayout): Promise<DashboardLayout>;
}

/* ------------------------------- parameters -------------------------------- */

/** Reads any parameter value as a list. A URL carries a list as `a,b`. */
export function asList(v: ParamValue | undefined): readonly ScalarValue[] {
	if (Array.isArray(v)) return v;
	if (v === null || v === undefined || v === '') return [];
	return String(v).split(',');
}

/** Value equality for parameters. A list is a new array on every pick. */
export function sameValue(a: ParamValue | undefined, b: ParamValue | undefined): boolean {
	if (a === b) return true;
	if (!Array.isArray(a) || !Array.isArray(b)) return false;
	return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Two fields, because two fields are all `declare()` reads.
 *
 * It used to declare eight: `label`, `kind`, `operator`, `type`, `required`,
 * `persist` and `description` alongside these. Every one of them was stored in a
 * `Map` that nothing ever read, and `persist: 'url'` described itself as making
 * the view shareable and survive a reload. The only dashboard ever published
 * from this contract sets four of the dead ones — including `persist: 'url'` —
 * because the metadata said to, and reported a shareable dashboard that was not
 * one. Nothing failed at any step: it typechecked, compiled, published and
 * rendered.
 *
 * That is the whole argument for deleting rather than documenting. A prop the
 * code ignores cannot be described accurately, because the accurate description
 * is "this does nothing", and nobody writes that. Offering it is what makes the
 * lie possible; removing it is what makes the lie unrepresentable — the same
 * reason a panel declares a size and never a position.
 *
 * Any of these may come back. The condition is that something reads it first.
 */
export interface ParamSpec<T extends ParamValue = ParamValue> {
	id: string;
	/**
	 * The value before anyone touches it, and the only thing `T` is inferred from
	 * — which is why there is no `type` field. A declared type that nothing reads
	 * gives no safety; a default gives the compiler the real one.
	 */
	default?: T;
}

export interface Param<T extends ParamValue = ParamValue> {
	readonly id: string;
	readonly spec: ParamSpec<T>;
	readonly value: T;
	readonly isDefault: boolean;
	set(next: T): void;
	reset(): void;
}

/** True for anything `useParam` handed back — used to unwrap handles from a params object. */
const isParam = (v: unknown): v is Param =>
	typeof v === 'object' && v !== null && 'id' in v && 'spec' in v && 'set' in v;

/* --------------------------------- context --------------------------------- */

interface HostValue {
	dashboardId: string;
	transport: DashboardTransport;

	/**
	 * Content hash of each resolver, so a panel re-fetches when its query changes.
	 *
	 * Without this, editing a resolver was invisible: the view's own hash is
	 * unchanged — deliberately, since rewriting a query must not re-import the
	 * view — so the shell served the cached module and every panel kept the rows
	 * it already had. The agent republished, said so, and the screen did not move.
	 */
	resolverVersion(name: string): string | undefined;

	values: Record<string, ParamValue>;
	declare(spec: ParamSpec): void;
	setValue(id: string, value: ParamValue): void;

	/**
	 * Several parameters at once, as **one** change.
	 *
	 * A control that owns more than one parameter — a date range owns `from` and
	 * `to` — must write them together. Two `setValue` calls are two state
	 * changes, so every panel fetches twice for one click and renders a
	 * combination in between that nobody chose: the new start date against the
	 * old end date. On a source taking seconds per query that is visible, and the
	 * intermediate result is not merely slow, it is wrong.
	 */
	setParams(patch: Record<string, ParamValue>): void;

	/**
	 * Filter values as the **controls** show them, which is not always what the
	 * panels are running on.
	 *
	 * With `FilterBar apply`, changing a control stages a value here and leaves
	 * `values` alone until the reader presses Apply. Everything else reads
	 * `values`, so a panel never renders a half-chosen combination.
	 */
	draft: Record<string, ParamValue>;

	/** True once a `FilterBar apply` exists. Set by the bar, read by nothing else. */
	deferred: boolean;
	setDeferred(on: boolean): void;

	/**
	 * How many parameters the view has declared.
	 *
	 * `FilterBar` switches itself into apply mode at two or more, so that
	 * batching is what happens by default rather than what someone remembered to
	 * ask for. A date range counts as two: it writes `from` and `to` separately,
	 * so without batching one drag of a date is two rounds of queries.
	 */
	paramCount: number;

	/**
	 * Marks a parameter as machinery rather than a filter the reader applies.
	 *
	 * A search box's text is the clearest case. It exists so a resolver can do
	 * the matching in SQL, and it has to reach the server as the reader types —
	 * held back until Apply, the list never narrows, no spinner ever shows, and
	 * the control reads as broken. It is also not a filter anyone would think to
	 * apply: what they apply is the row they pick.
	 *
	 * So a parameter marked this way always commits, and does not count toward
	 * the threshold that turns batching on. Marked by the control that owns the
	 * mechanism, not declared in the view, so no generated dashboard has to know
	 * this rule exists.
	 */
	markLive(id: string): void;
	/** Whether `markLive` has claimed this parameter. */
	isLive(id: string): boolean;

	/**
	 * Says whether this parameter's control sits inside the `FilterBar`, and so
	 * whether Apply governs it. Called by the control, for the same reason
	 * `markLive` is: a generated view never has to know the rule exists.
	 */
	setBatched(id: string, batched: boolean): void;

	/** Staged values that differ from what the panels are showing. */
	pending: number;
	/** Promote the draft to the live values. One re-fetch, not one per control. */
	commit(): void;
	/** Throw the draft away and go back to what is on screen. */
	revert(): void;

	/** The reader's arrangement, already reconciled against the panels on screen. */
	layout: DashboardLayout | null;

	/**
	 * A panel declares its own size constraints during render.
	 *
	 * Reconciling needs `minW`/`minH`/`defaultW`/`defaultH`, and only the panel
	 * knows them — they live in the view program's code, never in `layout.json`.
	 * Without this the host cannot clamp a stored size to what the author
	 * actually permits, and a panel dragged below its minimum would stay there.
	 */
	registerPanel(spec: PanelSpec): void;

	/** Where this panel sits in reading order. Applied as CSS `order`. */
	orderOf(id: string): number;

	/** True while the reader is rearranging. Panels show their affordances. */
	editing: boolean;

	/**
	 * Attach a panel to whatever is having a conversation about this dashboard.
	 *
	 * Absent in a runtime app, and absent while arranging — a panel is either
	 * something you are moving or something you are discussing, never both. When
	 * it is present, `Panel` draws a small target in its header on hover.
	 *
	 * A target rather than a click on the panel itself, because clicking inside a
	 * panel is already how a reader uses its filters, sorts its table and clicks
	 * its chart. Selection cannot take a gesture that already means something.
	 */
	selectPanel?: (spec: PanelSpec) => void;

	/** The panel currently attached, if any. */
	selectedPanel?: string | null;

	/** Replaces the arrangement and persists it. Called by the canvas, not by a panel. */
	/** `persist: false` updates the screen only — see the implementation. */
	setPanels(next: PanelSize[], persist?: boolean): void;

	/** What each panel permits, for the canvas's resize arithmetic. */
	panelSpecs: Map<string, PanelSpec>;

	viewer: { locale: string; timeZone: string; theme: 'light' | 'dark'; isStaticRender: boolean };
}

const HostContext = createContext<HostValue | null>(null);

function useHost(): HostValue {
	const host = useContext(HostContext);
	if (!host) {
		throw new ContractError(
			'BAD_REQUEST',
			'A dashboard component was rendered outside <DashboardHost>.',
		);
	}
	return host;
}

/* ---------------------------------- host ----------------------------------- */

export interface DashboardHostProps {
	dashboardId: string;
	transport: DashboardTransport;
	layout?: DashboardLayout | null;
	/** Per-resolver content hashes, from `dashboard-builder.get`. */
	resolvers?: readonly { name: string; version: string }[];
	/** Initial parameter values, e.g. parsed from the URL. */
	initialParams?: Record<string, ParamValue>;
	/** Fires whenever a parameter changes, so a shell can write the URL. */
	onParamsChange?: (values: Record<string, ParamValue>) => void;
	/**
	 * Rearranging is on.
	 *
	 * Off by default: a dashboard is read far more often than it is arranged,
	 * and panels that can be dragged by accident are worse than panels that
	 * cannot be dragged at all. The shell owns the toggle.
	 */
	editing?: boolean;
	/** Supplied only when something is listening — see `selectPanel` on the value. */
	selectPanel?: (spec: PanelSpec) => void;
	selectedPanel?: string | null;
	theme?: 'light' | 'dark';
	children: ReactNode;
}

export function DashboardHost({
	dashboardId,
	transport,
	layout = null,
	resolvers,
	initialParams,
	onParamsChange,
	editing = false,
	selectPanel,
	selectedPanel = null,
	theme = 'light',
	children,
}: DashboardHostProps) {
	const [values, setValues] = useState<Record<string, ParamValue>>(initialParams ?? {});
	const specs = useRef(new Map<string, ParamSpec>());

	/**
	 * What the controls show, which in deferred mode runs ahead of `values`.
	 *
	 * Two maps rather than one because a dashboard with three filters has a
	 * meaningful in-between state: the reader has picked a new country and a new
	 * period and has not asked for either yet. One map cannot hold both "what
	 * they are choosing" and "what the panels are showing", and every attempt to
	 * make it do so ends up refetching on the first of the three.
	 */
	const [draft, setDraft] = useState<Record<string, ParamValue>>(initialParams ?? {});
	const [deferred, setDeferred] = useState(false);

	/**
	 * A parameter declares itself during render.
	 *
	 * Writing state from render is not allowed, so the default is seeded into a
	 * ref immediately (the value is needed *this* render, by the very hook that
	 * declared it) and reconciled into state in an effect.
	 */
	const seeded = useRef<Record<string, ParamValue>>({ ...(initialParams ?? {}) });

	/**
	 * Parameters declared with a list default. A URL carries them as `a,b`, so a
	 * string arriving for one of these is split back into a list.
	 */
	const listIds = useRef<Set<string>>(new Set());

	const [paramCount, setParamCount] = useState(0);

	/** Parameters that are machinery — see `markLive` on `HostValue`. */
	const liveIds = useRef<Set<string>>(new Set());
	const recount = useCallback(() => {
		let n = 0;
		for (const id of specs.current.keys()) if (!liveIds.current.has(id)) n += 1;
		setParamCount(n);
	}, []);

	const markLive = useCallback(
		(id: string) => {
			if (liveIds.current.has(id)) return;
			liveIds.current.add(id);
			/* Same reason as `declare` below: called from a control's effect, and
			 * the count is only read by another effect. */
			queueMicrotask(recount);
		},
		[recount],
	);
	const isLive = useCallback((id: string) => liveIds.current.has(id), []);

	/**
	 * Parameters whose control stands inside a `FilterBar` — the ones Apply governs.
	 *
	 * Deferring was applied to every parameter on the page, and Apply exists only
	 * inside the bar. A filter placed beside the table it filters therefore looked
	 * dead: the pick was staged, the table did not move, and the button that would
	 * have moved it was in another panel. So the hold follows the button.
	 *
	 * A parameter nothing registers — one a chart click or a drill step writes —
	 * is not batched either, which is the same rule read from the other side:
	 * whatever has no Apply beside it applies itself.
	 */
	const batchedIds = useRef<Set<string>>(new Set());
	const setBatched = useCallback((id: string, batched: boolean) => {
		if (batched) batchedIds.current.add(id);
		else batchedIds.current.delete(id);
	}, []);

	const declare = useCallback((spec: ParamSpec) => {
		const isNew = !specs.current.has(spec.id);
		specs.current.set(spec.id, spec);
		if (Array.isArray(spec.default)) listIds.current.add(spec.id);
		if (!(spec.id in seeded.current) && spec.default !== undefined) {
			seeded.current[spec.id] = spec.default;
		}
		/* After the render that declared it — writing state from render is not
		 * allowed, and the count is only read by an effect anyway. */
		if (isNew) queueMicrotask(recount);
	}, [recount]);

	/* Both maps, so a control shows the seeded default on first render rather
	 * than an empty box that fills in a tick later. */
	useEffect(() => {
		const merge = (prev: Record<string, ParamValue>) => {
			const next = { ...seeded.current, ...prev };
			for (const id of listIds.current) {
				if (id in next && !Array.isArray(next[id])) next[id] = asList(next[id]);
			}
			const changed = Object.keys(next).some((k) => !sameValue(next[k], prev[k]));
			return changed || Object.keys(next).length !== Object.keys(prev).length ? next : prev;
		};
		setValues(merge);
		setDraft(merge);
	});

	/**
	 * Reports only what the reader actually chose.
	 *
	 * It used to report every value, defaults included — and the shell writes
	 * what it is given into the URL, which is then read back as `initialParams`
	 * and seeded *in preference to* a parameter's own default. The result: once a
	 * dashboard had been opened, its defaults could never change again. Asked to
	 * default the period to 6–12 April, the agent edited the view correctly and
	 * the screen went on showing the previous range, because the URL still
	 * carried it and the URL wins.
	 *
	 * A URL is meant to record a decision, not a state. A value equal to its own
	 * default is not a decision — it is what the dashboard would have shown
	 * anyway — so it is dropped here, and a link stays shareable while a default
	 * stays changeable.
	 */
	/** Only what the reader chose — see the note above. */
	const report = useCallback(
		(next: Record<string, ParamValue>) => {
			const chosen: Record<string, ParamValue> = {};
			for (const [key, v] of Object.entries(next)) {
				const declared = specs.current.get(key)?.default;
				if (declared === undefined || !sameValue(v, declared)) chosen[key] = v;
			}
			onParamsChange?.(chosen);
		},
		[onParamsChange],
	);

	const setValue = useCallback(
		(id: string, value: ParamValue) => {
			setDraft((prev) => (sameValue(prev[id], value) ? prev : { ...prev, [id]: value }));

			/* In deferred mode a change made *in the bar* stops at the draft: the
			 * control updates, the panels do not move, and nothing reaches the URL
			 * until Apply. A control outside the bar has no Apply to wait for, and a
			 * live parameter is machinery — holding either back is what makes a
			 * filter look broken. */
			if (deferred && batchedIds.current.has(id) && !liveIds.current.has(id)) return;

			setValues((prev) => {
				if (sameValue(prev[id], value)) return prev;
				const next = { ...prev, [id]: value };
				report(next);
				return next;
			});
		},
		[deferred, report],
	);

	/** Several parameters, one change — see `setParams` on `HostValue`. */
	const setParams = useCallback(
		(patch: Record<string, ParamValue>) => {
			setDraft((prev) => ({ ...prev, ...patch }));
			/* One control, one decision: a date range in the bar waits for Apply, the
			 * same range outside it applies both halves at once. */
			const batched = Object.keys(patch).some((id) => batchedIds.current.has(id));
			if (deferred && batched) return;
			setValues((prev) => {
				const next = { ...prev, ...patch };
				report(next);
				return next;
			});
		},
		[deferred, report],
	);

	/**
	 * Apply. One state change, so one re-fetch per affected panel — which is the
	 * entire point: three filters changed immediately means three rounds of
	 * queries and two intermediate combinations nobody asked to see.
	 */
	const commit = useCallback(() => {
		setValues(() => {
			report(draft);
			return { ...draft };
		});
	}, [draft, report]);

	/** Back to what is on screen. The panels never moved, so nothing refetches. */
	const revert = useCallback(() => setDraft({ ...values }), [values]);

	/** How many staged values differ from what the panels are showing. */
	const pending = useMemo(() => {
		let n = 0;
		for (const id of new Set([...Object.keys(draft), ...Object.keys(values)])) {
			if (!sameValue(draft[id], values[id])) n++;
		}
		return n;
	}, [draft, values]);

	/* ------------------------------- layout -------------------------------- */

	/**
	 * Panels register during render, exactly as parameters do, and for the same
	 * reason: the size is needed *this* render by the panel that declared it, so
	 * a ref is written now and reconciled into state in an effect.
	 *
	 * Source order is captured here too — `panelOrder` is the order the view
	 * program rendered them in, which is what a dashboard with no stored layout
	 * falls back to.
	 */
	const panelSpecs = useRef(new Map<string, PanelSpec>());
	const panelOrder = useRef<string[]>([]);
	const [specsVersion, setSpecsVersion] = useState(0);

	/**
	 * The ids registered during this render of the host, in render order.
	 *
	 * `panelOrder` only ever appends, so a panel a republished view puts first
	 * would otherwise stay last for as long as the page is open. After each
	 * render the ids seen are written back into their slots in that order.
	 */
	const renderPass = useRef<string[]>([]);
	renderPass.current = [];

	useLayoutEffect(() => {
		const seen = [...new Set(renderPass.current)];
		if (seen.length < 2) return;
		const inPass = new Set(seen);
		let k = 0;
		const next = panelOrder.current.map((id) => (inPass.has(id) ? seen[k++]! : id));
		if (next.some((id, i) => id !== panelOrder.current[i])) {
			panelOrder.current = next;
			setSpecsVersion((v) => v + 1);
		}
	});

	const registerPanel = useCallback((spec: PanelSpec) => {
		renderPass.current.push(spec.id);
		const known = panelSpecs.current.get(spec.id);
		if (
			known &&
			known.minW === spec.minW &&
			known.minH === spec.minH &&
			known.defaultW === spec.defaultW &&
			known.defaultH === spec.defaultH
		) {
			return;
		}
		panelSpecs.current.set(spec.id, spec);
		if (!panelOrder.current.includes(spec.id)) panelOrder.current.push(spec.id);
		/* Nudges a re-reconcile once the render that declared it has finished. */
		queueMicrotask(() => setSpecsVersion((v) => v + 1));
	}, []);

	/** What the reader changed, if anything. Null until they do. */
	const [edited, setEdited] = useState<PanelSize[] | null>(null);
	const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	/** The arrangement waiting to be written, so unmount can flush it. */
	const pendingSave = useRef<PanelSize[] | null>(null);
	const saveRef = useRef<((panels: PanelSize[]) => void) | null>(null);

	/**
	 * Flush on unmount.
	 *
	 * Rearranging and immediately navigating away is a normal thing to do, and
	 * dropping the pending write would silently lose the change — the reader
	 * saw it happen, so as far as they are concerned it was saved.
	 */
	useEffect(
		() => () => {
			if (saveTimer.current) clearTimeout(saveTimer.current);
			if (pendingSave.current) saveRef.current?.(pendingSave.current);
		},
		[],
	);

	/**
	 * Stored arrangement merged with the panels actually on screen.
	 *
	 * Recomputed whenever either side moves — a rebuild can add or remove a
	 * panel while someone is looking at it, and `reconcile` is what stops that
	 * leaving a ghost entry or an unplaced panel.
	 */
	const reconciled = useMemo<DashboardLayout>(() => {
		const specs = panelOrder.current
			.map((id) => panelSpecs.current.get(id))
			.filter((s): s is PanelSpec => Boolean(s));
		return {
			version: 1,
			panels: reconcile(edited ?? layout?.panels, specs),
		};
		/* `specsVersion` is the dependency that matters — the refs it reads are
		 * mutable and would not trigger this on their own. */
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [edited, layout, specsVersion]);

	const orderOf = useCallback(
		(id: string) => {
			const at = reconciled.panels.findIndex((p) => p.i === id);
			return at === -1 ? 0 : at;
		},
		[reconciled],
	);

	/**
	 * Persist on change, and keep what the reader did even if the write fails.
	 *
	 * Optimistic because a rearrangement is a direct manipulation — panels that
	 * snap back while a request is in flight feel broken. A failed save leaves
	 * the arrangement on screen and the file unchanged, which is recoverable by
	 * moving anything again.
	 */
	const write = useCallback(
		(panels: PanelSize[]) => {
			pendingSave.current = null;
			void Promise.resolve(transport.saveLayout?.(dashboardId, { version: 1, panels })).catch(
				(err) => {
					/* Warned, not surfaced: the arrangement is already on screen and
					 * moving anything again retries. Throwing here would undo a direct
					 * manipulation, which is worse than not saving it. */
					console.warn('[dash] layout was not saved:', err);
				},
			);
		},
		[transport, dashboardId],
	);
	saveRef.current = write;

	/**
	 * `persist: false` renders an arrangement without writing it.
	 *
	 * The arrange session is an editor: it holds a working copy, offers undo and
	 * Discard, and commits once when the reader presses Save. Every intermediate
	 * arrangement still has to reach the screen — that is what makes dragging
	 * feel direct — but writing each one would turn an exploratory session into a
	 * stream of saves with no way back to where it started.
	 */
	const setPanels = useCallback(
		(next: PanelSize[], persist = true) => {
			setEdited(next);
			if (!persist || !transport.saveLayout) return;

			/**
			 * Debounced, because a single gesture produces many arrangements.
			 *
			 * Dragging across three columns commits three times and reordering past
			 * four panels commits four; saving each would be a round trip per step,
			 * and they would race — the last one to arrive wins, which is not
			 * necessarily the last one made. Screen updates immediately, disk
			 * catches up once the hand stops.
			 */
			pendingSave.current = next;
			if (saveTimer.current) clearTimeout(saveTimer.current);
			saveTimer.current = setTimeout(() => write(next), 400);
		},
		[transport, write],
	);

	const viewer = useMemo(
		() => ({
			locale: 'en-US',
			timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
			theme,
			isStaticRender: false,
		}),
		[theme],
	);

	/** Name → content hash, rebuilt only when the server sends a new set. */
	const resolverVersions = useMemo(() => {
		const map = new Map<string, string>();
		for (const r of resolvers ?? []) map.set(r.name, r.version);
		return map;
	}, [resolvers]);

	const resolverVersion = useCallback(
		(name: string) => resolverVersions.get(name),
		[resolverVersions],
	);

	const host = useMemo<HostValue>(
		() => ({
			dashboardId,
			transport,
			resolverVersion,
			values: { ...seeded.current, ...values },
			draft: { ...seeded.current, ...draft },
			deferred,
			setDeferred,
			paramCount,
			markLive,
			isLive,
			setBatched,
			pending,
			commit,
			revert,
			declare,
			setValue,
			setParams,
			layout: reconciled,
			registerPanel,
			orderOf,
			editing,
			/* Never both at once: while arranging, a panel is something you are
			 * moving. The header target would be a second meaning for the same
			 * hover, and the arrange cursor already owns it. */
			selectPanel: editing ? undefined : selectPanel,
			selectedPanel,
			setPanels,
			panelSpecs: panelSpecs.current,
			viewer,
		}),
		/**
		 * Every field the value object reads, or the context publishes a stale one.
		 *
		 * The staged-filter fields were added to the object and not to this list,
		 * so picking a date updated `draft` and nothing downstream ever saw it —
		 * the control kept rendering the previous date. It looked intermittent
		 * rather than broken, because any *other* dependency changing rebuilt the
		 * memo and swept the new draft along with it.
		 *
		 * A memo whose dependency list is shorter than what it closes over does not
		 * fail loudly; it fails occasionally, which is worse.
		 */
		[
			dashboardId,
			transport,
			resolverVersion,
			values,
			draft,
			deferred,
			paramCount,
			markLive,
			isLive,
			setBatched,
			pending,
			commit,
			revert,
			declare,
			setValue,
			setParams,
			reconciled,
			registerPanel,
			orderOf,
			editing,
			selectPanel,
			selectedPanel,
			setPanels,
			viewer,
		],
	);

	return <HostContext.Provider value={host}>{children}</HostContext.Provider>;
}

/* ---------------------------------- hooks ---------------------------------- */

/**
 * Declares a parameter and returns a handle on it.
 *
 * Looks like `useState`; differs in that the host owns the value. Pass the
 * *handle* into `usePanelData`, not `handle.value` — that is what registers the
 * binding, and it is how the host can later answer "which panels does this
 * filter affect?".
 */
export function useParam<T extends ParamValue = ParamValue>(spec: ParamSpec<T>): Param<T> {
	const host = useHost();
	host.declare(spec as ParamSpec);

	/**
	 * The **draft** value, because this is what a control renders.
	 *
	 * In immediate mode the draft and the live values are the same object's
	 * worth of data, so this changes nothing. Under `FilterBar apply` they
	 * diverge, and the control must show what the reader just picked rather than
	 * what the panels are still running on — otherwise pressing a date leaves
	 * the box showing the old date and the filter looks broken.
	 *
	 * `usePanelData` deliberately does *not* read this. It resolves handles
	 * against the committed values, so a panel never queries a half-chosen
	 * combination.
	 */
	const value = (host.draft[spec.id] ?? spec.default ?? null) as T;

	return useMemo(
		() => ({
			id: spec.id,
			spec,
			value,
			isDefault: sameValue(value, spec.default ?? null),
			set: (next: T) => host.setValue(spec.id, next),
			reset: () => host.setValue(spec.id, spec.default ?? null),
		}),
		[spec, value, host],
	);
}

/**
 * The staged-filter controls, for `FilterBar`.
 *
 * Deliberately not exported from the contract: a generated view has no reason
 * to reach these, and one that did could commit a filter change from anywhere,
 * which is a dashboard nobody can reason about. The bar owns the behaviour.
 */
/**
 * Writes several parameters as one change. For a control that owns more than
 * one — see `setParams` on `HostValue`.
 *
 * Not re-exported from the contract: a view has `useParam` handles and should
 * set them individually. This is for controls inside the contract that own a
 * parameter *pair*, where two writes would be two queries.
 */
export function useSetParams() {
	return useHost().setParams;
}

export function useFilterApply() {
	const host = useHost();
	return {
		deferred: host.deferred,
		setDeferred: host.setDeferred,
		paramCount: host.paramCount,
		pending: host.pending,
		commit: host.commit,
		revert: host.revert,
	};
}

/**
 * Puts a parameter under the bar's Apply, or takes it out again.
 *
 * Called by every filter control with whether it is rendered inside a
 * `FilterBar`. Undefined — a control with no parameter yet — registers nothing.
 */
export function useBatchedParam(id: string | undefined, batched: boolean) {
	const setBatched = useHost().setBatched;
	useEffect(() => {
		if (!id) return;
		setBatched(id, batched);
		/* Unmounting takes the hold off: a control that is gone governs nothing. */
		return () => setBatched(id, false);
	}, [id, batched, setBatched]);
}

/**
 * Declares that this parameter is machinery, not a filter the reader applies.
 *
 * For a control that drives a query itself — a search box whose text the
 * resolver matches on. See `markLive` on `HostValue` for why those must not be
 * held back by Apply. A no-op when the control is not using one.
 */
export function useLiveParam(id: string | undefined) {
	const markLive = useHost().markLive;
	useEffect(() => {
		if (id) markLive(id);
	}, [id, markLive]);
}

export interface AsyncState<T> {
	data: T | null;
	error: ContractError | null;
	loading: boolean;
	stale: boolean;
	columns: DataResult['columns'] | null;
	meta: DataResult['meta'] | null;
	refresh(): void;
}

/**
 * Runs a resolver.
 *
 * Pass `null` as the name to skip while a filter is unset, so a panel does not
 * fire a query it will immediately discard.
 */
export function usePanelData<T extends Rows = Rows>(
	resolver: string | null,
	params: Record<string, ParamValue | Param> = {},
): AsyncState<T> {
	return useResolver<T>(resolver, params, 'committed');
}

/**
 * A resolver that fills another control's options, rather than a panel.
 *
 * Same as `usePanelData` but reads its parameters as the reader has them **set
 * right now**, not as they were last applied. That is the difference between a
 * project list that narrows when you choose a pillar and one that narrows a
 * click later, after Apply — and the second is worse than it sounds, because in
 * between it offers projects the chosen pillar does not contain. Picking one
 * gives an empty dashboard on Apply, which reads as missing data rather than as
 * a filter that could never have matched.
 *
 * Apply is there so *panels* do not re-query on every change. A dropdown's
 * contents are not an answer anyone is reading, so nothing is protected by
 * making them wait.
 */
export function useFilterOptions<T extends Rows = Rows>(
	resolver: string | null,
	params: Record<string, ParamValue | Param> = {},
): AsyncState<T> {
	return useResolver<T>(resolver, params, 'draft');
}

const warnedLive = new Set<string>();

function useResolver<T extends Rows = Rows>(
	resolver: string | null,
	params: Record<string, ParamValue | Param>,
	reads: 'committed' | 'draft',
): AsyncState<T> {
	const host = useHost();
	const source = reads === 'draft' ? host.draft : host.values;

	/**
	 * Handles are unwrapped here, and against the **committed** values — never
	 * the handle's own `.value`, which is the draft a control is showing.
	 *
	 * That distinction is what makes `FilterBar apply` work. Read the draft here
	 * and every keystroke in a date box would fire a query; read the committed
	 * value and the panel moves once, when the reader asks it to.
	 *
	 * The resolved object is the effect's key, so this is also what decides when
	 * a panel re-fetches at all.
	 */
	const resolved = useMemo<Record<string, ParamValue>>(() => {
		const out: Record<string, ParamValue> = {};
		for (const [name, raw] of Object.entries(params)) {
			if (!isParam(raw)) {
				out[name] = raw as ParamValue;
				continue;
			}
			/**
			 * Presence, not `??`.
			 *
			 * This was `host.values[raw.id] ?? raw.value`, and `??` treats **null**
			 * as absent — so a filter whose committed value is legitimately null,
			 * which is every "All" and every parameter nobody has chosen yet, fell
			 * through to `raw.value`. That is the draft, so the panel moved on the
			 * pick rather than on Apply, and `FilterBar apply` did nothing for
			 * exactly the filters that start unset.
			 *
			 * The fallback is the declared default, never the handle's value — a
			 * parameter with no default is not seeded into `values`, and reading the
			 * draft there would reopen the same hole.
			 */
			/**
			 * A panel never reads a live parameter.
			 *
			 * Live parameters skip Apply, so a panel bound to a search box's text
			 * re-queried on every pause in typing. The panel gets the declared
			 * default instead and moves on the row the reader picks.
			 */
			if (reads === 'committed' && host.isLive(raw.id)) {
				if (!warnedLive.has(raw.id)) {
					warnedLive.add(raw.id);
					console.warn(
						`[dash-contract] "${raw.id}" is a search box's text; panels use its default. ` +
							`Pass it only to that filter's useFilterOptions.`,
					);
				}
				out[name] = raw.spec.default ?? null;
				continue;
			}
			const value = raw.id in source ? source[raw.id]! : (raw.spec.default ?? null);
			/* A list parameter sends a list, even for the render before a URL's `a,b` is split. */
			out[name] = Array.isArray(raw.spec.default) ? [...asList(value)] : value;
		}
		return out;
	}, [params, source, reads, host.isLive]);

	const key = JSON.stringify(resolved);
	const resolverVersion = resolver ? host.resolverVersion(resolver) : undefined;
	const [nonce, setNonce] = useState(0);
	const [state, setState] = useState<Omit<AsyncState<T>, 'refresh'>>({
		data: null,
		error: null,
		loading: resolver !== null,
		stale: false,
		columns: null,
		meta: null,
	});

	useEffect(() => {
		if (!resolver) {
			setState({ data: null, error: null, loading: false, stale: false, columns: null, meta: null });
			return;
		}

		let cancelled = false;
		setState((prev) => ({ ...prev, loading: true }));

		/**
		 * There is no cache on this side, deliberately.
		 *
		 * The server holds one, keyed on things the browser cannot see — the
		 * published manifest's grants and the platform row cap, both of which
		 * change the answer without moving any resolver's content hash. A second
		 * store here would be keyed on strictly less than that, so it could serve
		 * an answer the server would already have refused to.
		 *
		 * `fresh` is how the reader forces a real run: it makes the server skip
		 * its own lookup and replace the entry, which is a **global** recompute
		 * rather than a personal bypass. That is deliberate — the action someone
		 * takes when they suspect a stale number should fix it for everyone
		 * looking, not just for them.
		 */
		const show = (result: DataResult<Rows>) => {
			setState({
				data: result.data as T,
				error: null,
				loading: false,
				stale: Boolean(result.meta?.cached),
				columns: result.columns ?? null,
				meta: result.meta ?? null,
			});
		};

		host.transport
			.runResolver(host.dashboardId, resolver, JSON.parse(key) as Record<string, ParamValue>, {
				fresh: nonce > 0,
			})
			.then((result) => {
				if (cancelled) return;
				show(result);

				/**
				 * The second half of a stale read.
				 *
				 * The server answered from its cache and started a recompute behind
				 * it. There is no push on this transport, so the way those rows
				 * reach the panel is to ask once more — that request waits on the
				 * run rather than starting one, and answers when it lands.
				 *
				 * The reader is not blocked meanwhile: they already have the rows
				 * above, and a failure here leaves them in place rather than
				 * replacing a working panel with an error.
				 */
				if (!result.meta?.revalidating) return;
				host.transport
					.runResolver(host.dashboardId, resolver, JSON.parse(key) as Record<string, ParamValue>, {
						awaitRefresh: true,
					})
					.then((refreshed) => {
						if (!cancelled) show(refreshed);
					})
					.catch(() => {});
			})
			.catch((err: unknown) => {
				if (cancelled) return;
				setState({
					data: null,
					error:
						err instanceof ContractError
							? err
							: new ContractError('RESOLVER_FAILED', (err as Error)?.message ?? String(err)),
					loading: false,
					stale: false,
					columns: null,
					meta: null,
				});
			});

		return () => {
			cancelled = true;
		};
		/* `resolverVersion` in the deps is what makes a republished query show:
		 * the hash changes, the effect re-runs, the panel asks again. */
	}, [host.transport, host.dashboardId, resolver, key, nonce, resolverVersion]);

	/**
	 * Ask again, ignoring what the server remembers.
	 *
	 * The nonce is in the effect's deps, so bumping it re-runs the fetch — and
	 * because it is now above zero, that fetch carries `fresh`. Without the flag
	 * the server would answer instantly from its cache and the control would
	 * appear to do nothing, which is indistinguishable from data that genuinely
	 * has not changed.
	 */
	const refresh = useCallback(() => setNonce((n) => n + 1), []);

	return { ...state, refresh };
}

/** The reader's stored size for one panel, if there is one. */
export function usePanelSize(id: string): PanelSize | undefined {
	return useHost().layout?.panels.find((p) => p.i === id);
}

/**
 * What `<Panel>` needs from the host, and nothing more.
 *
 * Narrower than `useHost` on purpose: a panel has no business reaching the
 * transport or the parameter store, and a component that can only see three
 * fields cannot accidentally grow a dependency on the rest.
 */
export function usePanelHost(): Pick<
	HostValue,
	'registerPanel' | 'orderOf' | 'editing' | 'selectPanel' | 'selectedPanel'
> {
	const { registerPanel, orderOf, editing, selectPanel, selectedPanel } = useHost();
	return { registerPanel, orderOf, editing, selectPanel, selectedPanel };
}

/** The canvas's handle on the arrangement. Not part of the view program's surface. */
export function useLayoutEditing(): Pick<
	HostValue,
	'layout' | 'setPanels' | 'editing' | 'panelSpecs'
> {
	const { layout, setPanels, editing, panelSpecs } = useHost();
	return { layout, setPanels, editing, panelSpecs };
}

/* -------------------------------- metadata --------------------------------- */

/** See `meta.ts`. An assignment for a name that no longer exists fails to compile. */

usePanelData.Metadata = {
	kind: 'data',
	purpose: 'Run a resolver and get its rows, with loading, empty and error state.',
	useWhen: 'Every panel that shows data. This is the only way to reach the server.',
	props: {
		resolver: {
			description: 'The resolver to run — the filename in data/ without its extension.',
			importance: 'required',
			caution: 'The bare name. Not a path, not "dashboard/name", not the file.',
		},
		params: {
			description: 'Values the resolver declared, as { name: handle }.',
			importance: 'recommended',
			caution:
				'Pass the param *handle* from useParam, never `handle.value`. The handle is what ' +
				'registers the dependency; passing the value gives you a panel that never re-runs.',
		},
	},
	notes:
		'Returns { data, columns, error, loading, stale, meta, refresh }. Pass `columns` to whatever ' +
		'renders the rows so formats declared on the resolver are used, and `meta.truncated` so a ' +
		'capped result says so. `refresh` is what ErrorNote’s retry takes.',
} satisfies ContractMeta;

useFilterOptions.Metadata = {
	kind: 'data',
	purpose: "Run a resolver that fills another filter's list of options.",
	useWhen: 'A filter whose choices depend on another filter — projects within a pillar.',
	props: {
		resolver: {
			description: 'The resolver to run — the filename in data/ without its extension.',
			importance: 'required',
			caution: 'The bare name. Not a path, not "dashboard/name", not the file.',
		},
		params: {
			description: 'Values the resolver declared, as { name: handle }.',
			importance: 'recommended',
			caution: 'Pass the param *handle* from useParam, never `handle.value`.',
		},
	},
	notes:
		'Returns what usePanelData returns. Reads the filters as they are set rather than as last ' +
		'applied, so the list narrows on the pick and never offers a value the parent excludes. ' +
		'Pass the result to `optionsFrom`. ' +
		'IMPORTANT: one options resolver and one useFilterOptions call per filter. The resolver is a plain ' +
		'ctx.sql query over the dimension tables — ids and names, SELECT DISTINCT value and label, ordered by ' +
		'label, limited — never a metric model or a program dataset, which computes figures a list of names ' +
		'does not need. Pass it the other filters only, never the param this list sets. A list larger than the ' +
		'row cap uses FilterSearch with `query`, and its resolver always filters by that `query`.',
} satisfies ContractMeta;

useParam.Metadata = {
	kind: 'data',
	purpose: 'Declare a parameter and get a handle to read and set it.',
	useWhen:
		'Any value a reader can change: a filter, a drill step, the URL. They are the same ' +
		'mechanism, so a value set by any of them behaves identically.',
	props: {
		id: {
			description: 'The parameter’s name. Must match what the resolver declares.',
			importance: 'required',
			caution: 'A resolver refuses any parameter it did not declare, before its code runs.',
		},
		default: {
			description: 'The value before anyone touches it.',
			importance: 'recommended',
			caution: 'Without one the first render queries with nothing, which is rarely what a reader should see first.',
		},
	},
	/**
	 * Two props, and that is the whole surface — see `ParamSpec` for the six that
	 * were removed and why. The parameter's *type* lives on the resolver, which
	 * is the thing that enforces it.
	 */
	notes:
		'Returns a handle: { id, value, isDefault, set, reset }. Pass the handle to usePanelData and ' +
		'to a filter control — never the value. Declaring the parameter is what keeps a filter a ' +
		'value rather than text spliced into SQL.',
} satisfies ContractMeta;

/**
 * Transport — how the shell reaches the `dashboard-builder` collection.
 *
 * Rides the generic `DATA_REQ` path every other collection uses, rather than a
 * message family of its own. There is nothing dashboard-specific about "call an
 * operation with params and get a payload back", and a new message type would
 * be a second thing to keep in sync across two SDKs for no gain.
 *
 * A second implementation is provided for development, backed by a plain
 * function. That is what lets the contract runtime be exercised before the
 * websocket is wired, and it costs nothing to keep — the interface is four
 * methods wide.
 */
import type { DashboardTransport } from '../dash-contract';
import type { DashboardLayout, DataResult, ParamValue, Rows } from '../dash-contract';

type ResolverParams = Record<string, ParamValue>;

/** The catalogue entry the shell needs before it can render anything. */
export interface DashboardInfo {
	id: string;
	title: string;
	description?: string;
	valid: boolean;
	/**
	 * Registered but never built — no view, and so no violations either.
	 *
	 * `valid` alone cannot distinguish "nothing here yet" from "the generated
	 * program failed its guard", and the two need very different words in front
	 * of a reader. Without this the canvas reports a brand-new dashboard as a
	 * compile failure with nothing to show for it.
	 */
	empty?: boolean;
	violations: { file: string; line: number; rule: string; detail: string; fix?: string }[];
	viewVersion: string;
	layout: DashboardLayout | null;
	/**
	 * `version` is the resolver file's content hash — the unit of data
	 * invalidation.
	 *
	 * The server always sent it; this type simply did not declare it, so nothing
	 * in the browser could use it. That is what made a republished query
	 * invisible: the *view's* hash is unchanged when only a resolver changes — by
	 * design, since rewriting SQL must not re-import the view — so the panel kept
	 * the rows it already had and the screen did not move, however many times the
	 * agent said it had published.
	 */
	resolvers: { name: string; title: string; version: string; errors: string[] }[];
}

export interface ModuleResponse {
	id: string;
	valid: boolean;
	version?: string;
	code?: string | null;
	unchanged?: boolean;
	violations?: DashboardInfo['violations'];
}

export interface ShellTransport extends DashboardTransport {
	get(dashboardId: string): Promise<DashboardInfo>;
	module(dashboardId: string, knownVersion?: string): Promise<ModuleResponse>;
	saveLayout(dashboardId: string, layout: DashboardLayout): Promise<DashboardLayout>;
}

/** Minimal shape of the SDK web client, so this file need not import it. */
interface DataClient {
	requestData(options: {
		collection: string;
		operation: string;
		params?: Record<string, unknown>;
		timeout?: number;
	}): Promise<{ data?: unknown; error?: string }>;
}

/**
 * Talks to the backend over the websocket.
 *
 * Unwraps `{ data, error }` into a value or a throw. Every caller has to handle
 * failure anyway, and a thrown error cannot be mistaken for an empty result —
 * which is the confusion worth designing out, since "the query returned
 * nothing" and "the query did not run" look identical in a panel otherwise.
 */
/**
 * How long the browser waits for a resolver.
 *
 * **Longer than the server's own ceiling, deliberately.** The resolver runtime
 * cancels at five minutes and reports which resolver ran out of budget; if the
 * browser gives up first, the reader is told "Request timeout after 60000ms" —
 * a message about the transport, naming nothing, for a query that is still
 * running perfectly well on the server and will finish thirty seconds later.
 *
 * Whichever timer is shorter is the one that produces the error message, so the
 * shorter one should be the layer that knows what it is timing out.
 *
 * Thirty seconds of headroom over the server, to cover the round trip and the
 * serialisation of a large result.
 */
const RESOLVER_TIMEOUT_MS = 5.5 * 60 * 1000;

/** Everything else is metadata — small, fast, and a long wait means a real fault. */
const DEFAULT_TIMEOUT_MS = 60_000;

export function createSdkTransport(client: DataClient): ShellTransport {
	const call = async <T>(
		operation: string,
		params: Record<string, unknown>,
		timeout = DEFAULT_TIMEOUT_MS,
	): Promise<T> => {
		const res = await client.requestData({
			collection: 'dashboard-builder',
			operation,
			params,
			timeout,
		});
		if (res.error) throw new Error(res.error);
		return res.data as T;
	};

	return {
		get: (dashboardId) => call<DashboardInfo>('get', { id: dashboardId }),
		module: (dashboardId, knownVersion) =>
			call<ModuleResponse>('module', { id: dashboardId, version: knownVersion }),
		/* `fresh` is only sent when true — an absent field keeps the wire shape
		 * unchanged for every ordinary panel fetch. */
		runResolver: (dashboardId, name, params: ResolverParams, options) =>
			call<DataResult<Rows>>(
				'runResolver',
				{
					id: dashboardId,
					resolver: name,
					params,
					...(options?.fresh ? { fresh: true } : {}),
					...(options?.awaitRefresh ? { awaitRefresh: true } : {}),
				},
				RESOLVER_TIMEOUT_MS,
			),
		saveLayout: (dashboardId, layout) =>
			call<DashboardLayout>('saveLayout', { id: dashboardId, layout }),
	};
}

/**
 * A transport backed by plain functions.
 *
 * For the dev page, and for rendering a dashboard in a test without a server.
 */
export function createLocalTransport(impl: {
	get(id: string): Promise<DashboardInfo> | DashboardInfo;
	module(id: string, knownVersion?: string): Promise<ModuleResponse> | ModuleResponse;
	runResolver(id: string, name: string, params: ResolverParams): Promise<DataResult<Rows>> | DataResult<Rows>;
	saveLayout?(id: string, layout: DashboardLayout): Promise<DashboardLayout> | DashboardLayout;
}): ShellTransport {
	return {
		get: async (id) => impl.get(id),
		module: async (id, v) => impl.module(id, v),
		runResolver: async (id, name, params) => impl.runResolver(id, name, params),
		saveLayout: async (id, layout) => (impl.saveLayout ? impl.saveLayout(id, layout) : layout),
	};
}

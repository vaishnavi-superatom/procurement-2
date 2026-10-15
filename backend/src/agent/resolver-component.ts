/**
 * A component whose data comes from a dashboard panel's own resolver.
 *
 * A question asked from a dashboard is often answered by running one of its
 * panels at other filter values (`./run-resolver`). Those rows had no way to
 * reach a component: the only descriptors were SQL, a model query and a
 * concept's program, so an answer built on a panel run could only be markdown.
 *
 * Writing the rows in as literals would have been the other way out, and it is
 * the wrong one. The browser holds a queryId, not the rows; behind it the query
 * cache keeps this descriptor, so a table opened later, after a restart or with
 * a filter override re-runs the panel instead of showing a frozen copy. The
 * run is also the only thing the dashboard's grants are checked against - rows
 * written into a saved conversation are outside that check for good.
 *
 * `runResolverDescriptor` is what `/chat/run-resolver` calls too, so the shim
 * the agent uses and the component it writes run the same code.
 */
import { dashboardDir } from '../dashboard-builder/registry';
import { ensureLocations } from '../dashboard-builder/locations';
import { loadManifestFrom } from '../dashboard-builder/validate';
import { runResolver } from '../dashboard-builder/resolvers';
import type { DataResult, Rows } from '../dashboard-builder/contract/types';

export interface ResolverDescriptor {
	kind: 'resolver';
	/** Which dashboard's panel. Kept on the descriptor so a re-run works from anywhere, not only that page. */
	dashboardId: string;
	name: string;
	params?: Record<string, unknown>;
}

export function asResolverDescriptor(stored: unknown): ResolverDescriptor | null {
	const d = stored as ResolverDescriptor;
	return d &&
		typeof d === 'object' &&
		d.kind === 'resolver' &&
		typeof d.dashboardId === 'string' &&
		Boolean(d.dashboardId) &&
		typeof d.name === 'string' &&
		Boolean(d.name)
		? d
		: null;
}

/**
 * The `toolId` a panel-backed component carries.
 *
 * A sentinel, like `script_dataset`: a resolver is not a tool, and the descriptor
 * branch in `executeByQueryId` runs before any tool lookup. It only has to be a
 * stable label the browser can send back.
 */
export const RESOLVER_TOOL = 'dashboard_panel';

/** `data/<name>.ts` -> `<name>`: the agent names a panel by its file as often as by its name. */
export const resolverName = (name: string): string => String(name).replace(/^.*[\\/]/, '').replace(/\.ts$/, '');

/**
 * Runs one panel of one dashboard with the published manifest's grants, and
 * returns the resolver's own result - rows, columns and `meta`.
 *
 * Both callers go through here: `/chat/run-resolver`, which needs `meta` to
 * tell the agent a result was cut, and the component path below.
 */
export async function runDashboardResolver(
	dashboardId: string,
	name: string,
	params: Record<string, unknown>,
): Promise<DataResult<Rows>> {
	await ensureLocations().catch(() => null);
	const dir = dashboardDir(dashboardId);
	const manifest = await loadManifestFrom(dir);
	return runResolver({
		dashboardId,
		dir,
		name: resolverName(name),
		params,
		grants: [...(manifest.grants?.sources ?? [])],
		toolGrants: [...(manifest.grants?.tools ?? [])],
		fresh: false,
	});
}

/**
 * Runs the panel a descriptor names, for a component.
 *
 * `overrides` are the component's filter values, applied over the params the
 * descriptor was written with - the same precedence the semantic and concept
 * descriptors give them.
 */
export async function runResolverDescriptor(
	descriptor: ResolverDescriptor,
	overrides: Record<string, unknown>,
	limit: number,
): Promise<{ data: Record<string, unknown>[]; count: number }> {
	const result = await runDashboardResolver(descriptor.dashboardId, descriptor.name, {
		...(descriptor.params ?? {}),
		...overrides,
	});
	const rows: Record<string, unknown>[] = Array.isArray(result?.data) ? (result.data as Record<string, unknown>[]) : [];
	const data = rows.slice(0, limit);
	return { data, count: data.length };
}

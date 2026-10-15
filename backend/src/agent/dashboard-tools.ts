/**
 * What the answer agent's dashboard tools run: `tools/semantic` and
 * `tools/run-resolver` (served by services/agent-tools.ts).
 *
 * `semantic` uses the same verbs and handling as the dashboard builder's, through
 * `answerSemantic`; only the choice of source differs. An answering agent is not
 * scoped to one dashboard's grants, so it may use any connected source.
 */
import { answerSemantic } from '../dashboard-builder/bridge';
import { semanticSourceFor } from '../dashboard-builder/semantic';
import { connectedSourceIds } from '../dashboard-builder/query';
import { dashboardDir } from '../dashboard-builder/registry';
import { ensureLocations } from '../dashboard-builder/locations';
import { loadManifestFrom } from '../dashboard-builder/validate';
import { runDashboardResolver } from './resolver-component';

/** Rows `semantic run` returns — a model's whole result, before the tool's own cap. */
const SEMANTIC_ROWS = 250;

/** `semantic` for an answering agent: any connected source, not a dashboard's grants. */
export async function semanticForAgent(body: any): Promise<unknown> {
	const connected = connectedSourceIds();
	const asked = typeof body?.source === 'string' ? body.source : '';
	const model =
		typeof body?.model === 'string' ? body.model : typeof body?.query?.model === 'string' ? body.query.model : undefined;
	const source =
		asked ||
		(connected.length === 1
			? connected[0]
			: semanticSourceFor(connected, model) || (await dashboardSource(body?.dashboardId, connected)));

	if (asked && !connected.includes(asked)) {
		return { error: `"${asked}" is not a connected source. Connected: ${connected.join(', ') || 'none'}` };
	}
	if (!source) {
		return {
			error: connected.length
				? `Several sources are connected — add --source <id>. Connected: ${connected.join(', ')}`
				: 'No sources are connected.',
		};
	}

	return answerSemantic(source, body, { fresh: false, rows: SEMANTIC_ROWS });
}

/**
 * Runs one panel's resolver from the dashboard in view, with any filter values.
 *
 * The same call the panel makes, so a question the panel answers at other
 * filter values is one run rather than a rebuild of its logic. Reach comes from
 * the published manifest's grants.
 */
export async function runResolverForAgent(body: any): Promise<{ success: boolean; result?: any; code?: string; error?: string }> {
	const dashboardId = typeof body?.dashboardId === 'string' ? body.dashboardId : '';
	if (!dashboardId) return { success: false, error: 'No dashboard is in view.' };
	if (!body?.name) return { success: false, error: 'name is required' };

	const params = body.params;
	if (params !== undefined && params !== null && (typeof params !== 'object' || Array.isArray(params))) {
		return { success: false, code: 'BAD_PARAMS', error: `params must be a JSON object, got ${typeof params}.` };
	}

	try {
		const result = await runDashboardResolver(dashboardId, String(body.name), params ?? {});
		return { success: true, result };
	} catch (err: any) {
		return { success: false, code: err?.code, error: err?.message ?? String(err) };
	}
}

/** The dashboard in view's one granted source, when it has exactly one that is connected. */
async function dashboardSource(dashboardId: unknown, connected: string[]): Promise<string> {
	if (typeof dashboardId !== 'string' || !dashboardId) return '';
	try {
		await ensureLocations().catch(() => null);
		const manifest = await loadManifestFrom(dashboardDir(dashboardId));
		const granted = (manifest.grants?.sources ?? []).filter((s) => connected.includes(s));
		return granted.length === 1 ? granted[0] : '';
	} catch {
		return '';
	}
}

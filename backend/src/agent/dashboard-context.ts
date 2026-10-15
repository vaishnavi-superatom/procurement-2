/**
 * The dashboard a question was asked from, put in front of the chat agent.
 *
 * Two parts. The dashboard's program is copied into the thread's workspace under
 * `dashboard/`, so the agent can read exactly how each panel is built. And a note
 * goes ahead of the question: which dashboard, its panels, and the filter values
 * set on it right now.
 *
 * The full note is sent the first time a thread sees a dashboard; after that only
 * a line saying it is still in view, with the current filters. The pi session
 * remembers the rest.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { PromptContext } from '@superatomai/sdk-node';
import { dashboardDir } from '../dashboard-builder/registry';
import { ensureLocations, locationEntry } from '../dashboard-builder/locations';
import { loadManifestFrom } from '../dashboard-builder/validate';
import { listResolvers } from '../dashboard-builder/resolvers';
import { programFilesIn } from '../dashboard-builder/agent/workspace';
import type { ResolverSummary } from '../dashboard-builder/contract/types';

export const DASHBOARD_FOLDER = 'dashboard';

/**
 * The dashboard each thread was last given in full, by session key.
 *
 * In memory only: after a restart the next question sends the full note again,
 * which costs a few hundred tokens and loses nothing.
 */
const lastShown = new Map<string, string>();

function filterLine(filters: PromptContext['filters']): string {
	return filters && Object.keys(filters).length
		? `Filter values set on it right now: \`${JSON.stringify(filters)}\``
		: 'No filter values were sent with this question.';
}

/** Copies the published program into `dashboard/`, replacing a previous dashboard's copy. */
function copyProgram(cwd: string, dashboardId: string): { semanticPanels: Set<string>; hasSpec: boolean } {
	const source = dashboardDir(dashboardId);
	const target = path.join(cwd, DASHBOARD_FOLDER);
	fs.rmSync(target, { recursive: true, force: true });

	const semanticPanels = new Set<string>();
	for (const rel of programFilesIn(source)) {
		const from = path.join(source, rel);
		const to = path.join(target, rel);
		fs.mkdirSync(path.dirname(to), { recursive: true });
		fs.copyFileSync(from, to);

		const panel = rel.match(/^data\/([^/]+)\.ts$/)?.[1];
		if (panel && fs.readFileSync(from, 'utf-8').includes('ctx.semantic(')) semanticPanels.add(panel);
	}

	const spec = path.join(source, 'spec.json');
	const hasSpec = fs.existsSync(spec);
	if (hasSpec) fs.copyFileSync(spec, path.join(target, 'spec.json'));

	/* Read by `./run-resolver` and `./semantic`, so neither needs the id passed. */
	fs.mkdirSync(target, { recursive: true });
	fs.writeFileSync(path.join(target, 'dashboard.json'), JSON.stringify({ id: dashboardId }));

	return { semanticPanels, hasSpec };
}

function describePanel(resolver: ResolverSummary, usesSemantic: boolean): string {
	const params = Object.entries(resolver.params ?? {})
		.map(([name, spec]) => `${name} (${spec.type}${spec.optional ? ', optional' : ''})`)
		.join(', ');
	const columns = (resolver.output?.columns ?? []).map((c) => c.name).join(', ');

	const parts = [
		resolver.title,
		resolver.description,
		params && `Filters: ${params}`,
		columns && `Columns: ${columns}`,
		usesSemantic && 'Built on a semantic model',
	]
		.filter(Boolean)
		.map((part) => String(part).trim().replace(/\.+$/, ''));

	return `- \`${resolver.name}\` — ${parts.join('. ')}.`;
}

/**
 * The note to put ahead of the question, or null when it was not asked from a
 * dashboard. Never throws: a dashboard that cannot be read is described as such,
 * and the question is still answered.
 */
export async function dashboardNote(
	cwd: string,
	sessionKey: string,
	context: PromptContext | undefined,
): Promise<string | null> {
	const dashboardId = context?.dashboardId;
	if (!dashboardId) return null;

	/* Read from the files, not through `getDashboard`: that also compiles the view,
	 * which needs the component contract a browser registers, and fails until one
	 * has. The note needs the title and the panels, neither of which is compiled. */
	await ensureLocations().catch(() => null);
	const dir = dashboardDir(dashboardId);
	if (!fs.existsSync(path.join(dir, 'manifest.ts'))) {
		return `The person asked this while viewing a dashboard (\`${dashboardId}\`) that has no program yet.`;
	}

	const manifest = await loadManifestFrom(dir).catch(() => null);
	const row = locationEntry(dashboardId);
	const state = {
		title: row?.name || manifest?.title || dashboardId,
		description: row?.description ?? manifest?.description,
		resolvers: await listResolvers(dir).catch(() => [] as ResolverSummary[]),
	};

	let semanticPanels = new Set<string>();
	let hasSpec = false;
	try {
		({ semanticPanels, hasSpec } = copyProgram(cwd, dashboardId));
	} catch (err: any) {
		console.warn(`[chat-answer] could not copy dashboard ${dashboardId}: ${err?.message ?? err}`);
	}

	if (lastShown.get(sessionKey) === dashboardId) {
		return [
			`The person is still viewing the dashboard **${state.title}** (program in \`${DASHBOARD_FOLDER}/\`).`,
			filterLine(context?.filters),
		].join('\n');
	}
	lastShown.set(sessionKey, dashboardId);

	return [
		`The person asked this while viewing the dashboard **${state.title}**${state.description ? ` — ${state.description}` : ''}.`,
		'',
		`Its program is in \`${DASHBOARD_FOLDER}/\`: \`view.tsx\` lays out the panels and filters, and \`data/<name>.ts\` is`,
		`each panel's query.${hasSpec ? ' `spec.json` is what it was built to show.' : ''}`,
		'',
		'Panels:',
		...state.resolvers.map((r) => describePanel(r, semanticPanels.has(r.name))),
		'',
		filterLine(context?.filters),
	].join('\n');
}

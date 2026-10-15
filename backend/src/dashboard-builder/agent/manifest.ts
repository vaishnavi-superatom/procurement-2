/**
 * The manifest, written for the agent rather than by it.
 *
 * Regenerated on every publish from what the session was authorised for, so an
 * edit to `manifest.ts` in the workspace reaches nothing. A program that could
 * widen its own blast radius would not have one.
 *
 * Previously rendered from a `BuildSpec`. The spec is gone — there is one agent
 * and nothing to send it — so the inputs now come from where they were always
 * true: the dashboard's own row, and the grants the caller handed the session.
 */
import * as fs from 'fs';
import * as path from 'path';

export interface ManifestInput {
	dashboardId: string;
	title: string;
	description?: string;
	grants: readonly string[];
	/** Direct-tool ids `ctx.run` may reach. */
	toolGrants?: readonly string[];
}

const lit = (v: unknown) => JSON.stringify(v ?? null);

/**
 * Writes the manifest into a program directory.
 *
 * Called at session start as well as on publish, and that is the point. It used
 * to be written only by publish, so a dashboard nobody had published yet had no
 * `manifest.ts` — and `./validate` loads the manifest first, so it failed with
 * "No manifest.ts" on every new dashboard.
 *
 * The agent's own words for it, observed: *"Validation is blocked because this
 * empty dashboard has no generated manifest.ts yet… I'll use the publish step to
 * generate the manifest and run its checks."* It reasoned its way to publishing
 * in order to typecheck, which inverts the gate — validate exists so that
 * mistakes are found BEFORE anything reaches a reader. It then found a real prop
 * error that way, on the published dashboard.
 *
 * Writing it at session start costs nothing: the inputs are the dashboard's own
 * row and the grants the caller handed the session, both known before the agent
 * has done anything, and publish rewrites it regardless.
 */
export function writeManifest(programDir: string, input: ManifestInput): void {
	fs.mkdirSync(programDir, { recursive: true });
	fs.writeFileSync(path.join(programDir, 'manifest.ts'), renderManifest(input), 'utf-8');
}

export function renderManifest(input: ManifestInput): string {
	return `/**
 * ${input.title} — generated. Do not edit.
 *
 * Rewritten from the dashboard's registration every time it is published, so an
 * edit here is discarded. Grants in particular are the caller's decision.
 */
import type { DashboardManifest } from '../../src/dashboard-builder/contract/types';

export const manifest: DashboardManifest = {
	id: ${lit(input.dashboardId)},
	title: ${lit(input.title)},${input.description ? `\n\tdescription: ${lit(input.description)},` : ''}
	grants: {
		sources: [${input.grants.map((s) => `\n\t\t\t${lit(s)},`).join('')}
		],${
			input.toolGrants?.length
				? `\n\t\ttools: [${input.toolGrants.map((t) => `\n\t\t\t${lit(t)},`).join('')}\n\t\t],`
				: ''
		}
	},
};
`;
}

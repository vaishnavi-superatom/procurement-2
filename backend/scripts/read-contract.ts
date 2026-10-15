/**
 * Reads the dashboard contract straight from the frontend source.
 *
 * At runtime the backend gets this from the browser (`DASH_CONTRACT_RES`).
 * `dash-builder-smoke.ts` has no browser and still has to compile a view, so it
 * seeds the store with this instead.
 */
import * as path from 'path';
import * as esbuild from 'esbuild';
import type { DashboardComponent } from '../src/dashboard-builder/contract/registered';

export const CONTRACT_ENTRY = path.join(
	__dirname,
	'..',
	'..',
	'frontend',
	'src',
	'dash-contract',
	'index.ts',
);

export async function readContractFromSource(): Promise<DashboardComponent[]> {
	const out = await esbuild.build({
		entryPoints: [CONTRACT_ENTRY],
		bundle: true,
		write: false,
		format: 'cjs',
		platform: 'node',
		target: 'node20',
		jsx: 'automatic',
		logLevel: 'silent',
		absWorkingDir: path.dirname(CONTRACT_ENTRY),
	});

	const code = out.outputFiles?.[0]?.text ?? '';
	if (!code.trim()) throw new Error('The contract bundled to nothing.');

	const moduleObject: { exports: any } = { exports: {} };
	new Function('module', 'exports', 'require', code)(
		moduleObject,
		moduleObject.exports,
		require,
	);

	const registry = moduleObject.exports?.DASHBOARD_COMPONENT_REGISTRY;
	if (!registry?.registry?.length) {
		throw new Error('The contract exports no DASHBOARD_COMPONENT_REGISTRY.');
	}
	if (registry.undescribed?.length) {
		throw new Error(
			`These components have no Metadata: ${registry.undescribed.join(', ')}.`,
		);
	}

	return registry.registry as DashboardComponent[];
}

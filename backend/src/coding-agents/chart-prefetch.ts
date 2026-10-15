import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { readGraph, type GraphRenderer } from './answer-file';
import { renderGraph, type GraphSpec } from './ui-agent';

/**
 * Starts the UI agent on each chart as soon as its file is complete, while the
 * coding agent is still writing the answer, so the chart is ready (or nearly)
 * when answer.md is assembled. Keyed by the chart's content: a file rewritten
 * after it was picked up is rendered again, never served stale.
 */

const POLL_MS = 1000;

type Rendered = ReturnType<GraphRenderer>;

const keyOf = (spec: GraphSpec) => createHash('sha1').update(JSON.stringify(spec)).digest('hex');

export function startChartPrefetch(workspaceDir: string, catalog: any[] | undefined) {
	const started = new Map<string, { promise: Rendered; at: number }>();
	const seen = new Map<string, number>(); // file -> mtime last tried

	const start = (spec: GraphSpec, file: string, early: boolean) => {
		const key = keyOf(spec);
		if (started.has(key)) return started.get(key)!.promise;
		const at = Date.now();
		const promise = renderGraph(spec, catalog);
		// Settled either way, so an unused early start never becomes an unhandled rejection.
		promise.then(
			r => console.log(`[ui-agent] ${file} -> ${r.name} in ${((Date.now() - at) / 1000).toFixed(1)}s${early ? ' (started early)' : ''}`),
			e => console.warn(`[ui-agent] ${file} failed after ${((Date.now() - at) / 1000).toFixed(1)}s: ${e?.message ?? e}`),
		);
		started.set(key, { promise, at });
		return promise;
	};

	const scan = () => {
		let names: string[] = [];
		try { names = fs.readdirSync(path.join(workspaceDir, 'data')).filter(n => n.endsWith('.json')); } catch { return; }
		for (const name of names) {
			const rel = `data/${name}`;
			let mtime = 0;
			try { mtime = fs.statSync(path.join(workspaceDir, rel)).mtimeMs; } catch { continue; }
			if (seen.get(rel) === mtime) continue;
			seen.set(rel, mtime);
			// Table files and half-written charts do not read as a chart yet; a later write retries.
			let spec: GraphSpec;
			try { spec = readGraph(workspaceDir, rel); } catch { continue; }
			start(spec, rel, true);
		}
	};
	const timer = setInterval(scan, POLL_MS);

	return {
		stop: () => clearInterval(timer),
		/** For the assembler: the early result when the chart is unchanged, else a fresh render. */
		render: ((spec: GraphSpec, cat?: any[]) => start(spec, spec.name, false)) as GraphRenderer,
	};
}

/**
 * The view compiler — `view.tsx` into a module a browser can import.
 *
 * esbuild, bundled to ESM, with the two permitted imports rewritten to stubs
 * that read from the runtime the shell publishes on `globalThis`. React is not
 * bundled: the page already has one, and a second copy would give the dashboard
 * its own hook dispatcher, which breaks every hook it calls.
 *
 * The output is content-hashed. That hash is how a client decides whether to
 * re-import at all, and how a stale module is detected after a rebuild — it was
 * never really about HTTP caching, which is why moving delivery onto the
 * websocket changed nothing here.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as esbuild from 'esbuild';
import {
	contractExports,
	JSX_RUNTIME_EXPORTS,
	REACT_EXPORTS,
	RUNTIME_GLOBAL,
} from './contract/runtime';

export class ViewCompileError extends Error {
	readonly code = 'RESOLVER_BLOCKED';
	constructor(
		message: string,
		readonly diagnostics: { file: string; line: number; text: string }[] = [],
	) {
		super(message);
	}
}

export interface CompiledView {
	/** ESM. Imports nothing; reads React and `@contract` from the runtime global. */
	code: string;
	/** Content hash of the emitted bundle. */
	version: string;
	bytes: number;
	compiledMs: number;
}

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

/**
 * A stub module: named re-exports read off the runtime global.
 *
 * Generated rather than hand-written because the *list* is the contract. A name
 * absent from `CONTRACT_EXPORTS` simply is not exported here, so a view that
 * imports it fails at compile time with esbuild naming the symbol — which is a
 * far better error than `undefined is not a function` at render.
 */
function stubFor(specifier: string, contractNames: readonly string[]): string {
	const names =
		specifier === 'react'
			? REACT_EXPORTS
			: specifier === 'react/jsx-runtime'
				? JSX_RUNTIME_EXPORTS
				: contractNames;

	const slot =
		specifier === '@contract' ? 'contract' : specifier === 'react' ? 'react' : 'jsxRuntime';

	return [
		`const __rt = globalThis[${JSON.stringify(RUNTIME_GLOBAL)}];`,
		`if (!__rt) throw new Error(${JSON.stringify(
			`This dashboard was loaded before the contract runtime was published. ` +
				`The shell must set globalThis.${RUNTIME_GLOBAL} first.`,
		)});`,
		`const __m = __rt[${JSON.stringify(slot)}];`,
		...names.map((n) => `export const ${n} = __m[${JSON.stringify(n)}];`),
		/* `react` is imported as a default in some generated code; keep it working. */
		specifier === 'react' ? 'export default __m;' : '',
	]
		.filter(Boolean)
		.join('\n');
}

const RUNTIME_SPECIFIERS = /^(react|react\/jsx-runtime|@contract)$/;

/** Resolves the three runtime specifiers to generated stubs; everything else fails. */
const runtimeStubPlugin = (contractNames: readonly string[]): esbuild.Plugin => ({
	name: 'dash-runtime-stubs',
	setup(build) {
		build.onResolve({ filter: RUNTIME_SPECIFIERS }, (args) => ({
			path: args.path,
			namespace: 'dash-runtime',
		}));
		build.onLoad({ filter: /.*/, namespace: 'dash-runtime' }, (args) => ({
			contents: stubFor(args.path, contractNames),
			loader: 'js',
		}));
	},
});

/**
 * Compiles a dashboard's view program.
 *
 * `entry` defaults to `view.tsx`. Sibling files under `panels/` and `lib/` are
 * bundled in; anything reaching outside the folder fails to resolve, which is
 * the guard's rule enforced a second time by the bundler.
 */
export async function compileView(dir: string, entry = 'view.tsx'): Promise<CompiledView> {
	const file = path.join(dir, entry);
	if (!fs.existsSync(file)) {
		throw new ViewCompileError(`No ${entry} in this dashboard.`);
	}

	const started = Date.now();

	/* Throws when no browser has registered the contract — the stub would
	 * otherwise export nothing and every import in the view would fail. */
	const contractNames = contractExports();

	let result: esbuild.BuildResult;
	try {
		result = await esbuild.build({
			entryPoints: [file],
			bundle: true,
			write: false,
			format: 'esm',
			platform: 'browser',
			target: 'es2020',
			jsx: 'automatic',
			logLevel: 'silent',
			plugins: [runtimeStubPlugin(contractNames)],
			/* Keeps a stray type import from the backend contract out of the bundle. */
			external: ['*/contract/types'],
			minify: false,
			sourcemap: false,
			/* The dashboard folder is the resolution root; `../` escapes fail here. */
			absWorkingDir: path.resolve(dir),
		});
	} catch (err: any) {
		const diagnostics = (err?.errors ?? []).map((e: any) => ({
			file: e.location?.file ?? entry,
			line: e.location?.line ?? 0,
			text: e.text ?? String(e),
		}));
		throw new ViewCompileError(
			diagnostics.length
				? diagnostics.map((d) => `${d.file}:${d.line} ${d.text}`).join('\n')
				: (err?.message ?? String(err)),
			diagnostics,
		);
	}

	const code = result.outputFiles?.[0]?.text ?? '';
	if (!code.trim()) throw new ViewCompileError(`${entry} compiled to nothing.`);

	/**
	 * A default export is the whole module contract.
	 *
	 * Checked here rather than at mount because "this dashboard has no view"
	 * should be a build failure the author sees, not a blank card the reader
	 * does.
	 */
	if (!/export\s*\{[^}]*\bas default\b|export\s+default\b/.test(code)) {
		throw new ViewCompileError(
			`${entry} must default-export a component. ` +
				`Add \`export default function MyDashboard() { … }\`.`,
		);
	}

	return {
		code,
		version: sha(code),
		bytes: Buffer.byteLength(code, 'utf8'),
		compiledMs: Date.now() - started,
	};
}

/**
 * Splits a compiled module for delivery over the websocket.
 *
 * Mirrors `BUNDLE_REQ`/`BUNDLE_CHUNK`, which already ships the component bundle
 * this way — the client reassembles, wraps in a Blob and imports the object URL.
 */
export function chunkModule(code: string, chunkSize = 64 * 1024): string[] {
	const chunks: string[] = [];
	for (let i = 0; i < code.length; i += chunkSize) {
		chunks.push(code.slice(i, i + chunkSize));
	}
	return chunks.length ? chunks : [''];
}

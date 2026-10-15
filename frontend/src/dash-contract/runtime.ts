/**
 * The runtime surface — what a compiled view program may import, by name.
 *
 * A view is compiled on the server and loaded by a browser that **already has
 * React and the contract in memory**. The compiler therefore rewrites its two
 * permitted imports into stubs that read from a registry the shell publishes on
 * `globalThis`, rather than bundling a second copy of React into every
 * dashboard.
 *
 * A stub can only re-export names it knows, so both sides read this list. That
 * is the point: adding an export to `@contract` without adding it here fails
 * loudly at startup instead of silently as `undefined` inside somebody's
 * dashboard, three panels down, at render time.
 *
 * **This list is the contract's surface area.** Anything not on it does not
 * exist as far as a generated program is concerned, which makes the boundary
 * checkable by reading one file.
 *
 * MIRROR — do not edit here first. The canonical copy is
 * `backend/src/dashboard-builder/contract/runtime.ts`, and the compiler
 * generates its import stubs from that one. A name added only here produces a
 * stub that does not export it, so the view fails to compile with esbuild
 * naming the symbol — noisy, but in the wrong place. Changes start there.
 */

export const RUNTIME_GLOBAL = '__DASH_BUILDER_RUNTIME__';

/**
 * The names live in `index.ts` now, as the keys of `DASHBOARD_COMPONENTS`.
 *
 * They cannot live here: this module is imported *by* `index.ts`, and the list
 * is derived from the object that file builds. Putting the derivation here would
 * be a cycle — which is itself the useful signal that there is only one list
 * left, rather than a list and a copy of it.
 */

/**
 * React's value exports, for the compiler's stub.
 *
 * Only the hooks and helpers a view legitimately needs. `createElement` and the
 * jsx runtime entries are here because the automatic JSX transform emits calls
 * to them; everything else is what a panel component actually uses.
 */
export const REACT_EXPORTS = [
	'Fragment',
	'createElement',
	'cloneElement',
	'createContext',
	'forwardRef',
	'isValidElement',
	'memo',
	'useCallback',
	'useContext',
	'useDeferredValue',
	'useEffect',
	'useId',
	'useLayoutEffect',
	'useMemo',
	'useReducer',
	'useRef',
	'useState',
	'useSyncExternalStore',
	'useTransition',
] as const;

/** Named exports of `react/jsx-runtime`, used by the automatic JSX transform. */
export const JSX_RUNTIME_EXPORTS = ['jsx', 'jsxs', 'jsxDEV', 'Fragment'] as const;

/** What the shell publishes on `globalThis[RUNTIME_GLOBAL]`. */
export interface DashboardRuntime {
	react: Record<string, unknown>;
	jsxRuntime: Record<string, unknown>;
	contract: Record<string, unknown>;
	version: string;
}

/**
 * Checks the React half of a published runtime.
 *
 * It no longer checks the contract half: those names *are* the keys of the
 * object being published, so "listed but missing" stopped being a state anything
 * could reach. React is a different matter — the stub re-exports a fixed set of
 * names from someone else's package, and a version that drops one should fail at
 * boot rather than as a silent `undefined` inside a panel.
 */
export function missingReactExports(runtime: DashboardRuntime): string[] {
	return REACT_EXPORTS.filter((name) => runtime.react?.[name] === undefined).map(
		(name) => `react.${name}`,
	);
}

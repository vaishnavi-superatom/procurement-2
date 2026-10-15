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
 * Mirrored in `frontend/src/dash-contract/runtime.ts` — see the note in
 * `contract/types.ts` about why the copy exists.
 */

export const RUNTIME_GLOBAL = '__DASH_BUILDER_RUNTIME__';

/**
 * The names a generated program may import — from `registered.ts`, which the
 * browser fills in. A function rather than a const because it is not known
 * until a client has connected.
 */
export { contract, contractExports, isContractRegistered } from './registered';
export type { DashboardComponent, PropMeta } from './registered';

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

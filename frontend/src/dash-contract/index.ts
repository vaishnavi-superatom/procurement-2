/**
 * `@contract` — everything a compiled view program may import.
 *
 * A dashboard module never imports this file. The compiler rewrites its
 * `react`, `react/jsx-runtime` and `@contract` imports into stubs that read
 * from a registry on `globalThis`, and `publishRuntime()` is what puts the
 * registry there. Both sides read the same export list, so a name that exists
 * in one and not the other fails loudly at startup rather than silently as
 * `undefined` three panels into somebody's dashboard.
 *
 * Call `publishRuntime()` once, before loading any dashboard module.
 */
import * as React from 'react';
import * as JsxRuntime from 'react/jsx-runtime';

import {
	REACT_EXPORTS,
	RUNTIME_GLOBAL,
	missingReactExports,
	type DashboardRuntime,
} from './runtime';
import { collectRegistry } from './meta';

import {
	ContractError,
	DashboardHost,
	useParam,
	usePanelData,
	useFilterOptions,
	usePanelSize,
	useLayoutEditing,
	type AsyncState,
	type DashboardTransport,
	type Param,
	type ParamSpec,
} from './context';

import { Panel } from './components/layout/panel';
import { Card, Grid, Heading, Text } from './components/layout/primitives';
import { Stack, Row } from './components/layout/flow';
import { Loading, EmptyState, ErrorNote } from './components/status';
import { Metric } from './components/display/metric';

import {
	FilterBar,
	FilterGroup,
	FilterChoice,
	FilterSearch,
	FilterMultiChoice,
	FilterDate,
	FilterDateRange,
	FilterRange,
	FilterToggle,
} from './components/filters';

import { BarChart, LineChart } from './components/display/cartesian';
import { PieChart } from './components/display/pie';
import { DataTable } from './components/table';
import { MatrixTable } from './components/table/matrix';
import {
	CATEGORICAL,
	DIVERGING,
	SEQUENTIAL,
	SENTIMENT,
	GRID_COLUMNS,
	GRID_GAP,
	ROW_UNIT,
	themeVariables,
} from './theme';

import {
	formatValue,
	formatNumber,
	formatCurrency,
	formatPercent,
	formatCompact,
	formatDate,
} from './format';

/**
 * **The dashboard components — the one list.**
 *
 * What a generated dashboard program may use, by the name it imports. Keyed
 * rather than spread on purpose: a spread would make a typo invisible, and this
 * object is now the definition of the contract's surface rather than a copy of
 * it. `DASHBOARD_COMPONENT_NAMES` is its keys, and the registry the agent reads
 * is the `Metadata` hanging off its values.
 *
 * "Components" loosely — it also holds hooks and formatters, and each one says
 * which it is in its own `kind`. One list is simpler than three, and the agent
 * needs them together anyway.
 *
 * Adding something here and forgetting to describe it is caught at build time
 * by the generator, not discovered later by an agent that was never told.
 */
const DASHBOARD_COMPONENTS: Record<string, unknown> = {
	usePanelData,
	useFilterOptions,
	useParam,
	Panel,
	Stack,
	Row,
	Card,
	Grid,
	Heading,
	Text,
	Loading,
	EmptyState,
	ErrorNote,
	Metric,
	BarChart,
	LineChart,
	PieChart,
	DataTable,
	MatrixTable,
	FilterBar,
	FilterGroup,
	FilterChoice,
	FilterSearch,
	FilterMultiChoice,
	FilterDate,
	FilterDateRange,
	FilterRange,
	FilterToggle,
	formatValue,
	formatNumber,
	formatCurrency,
	formatPercent,
	formatCompact,
	formatDate,
};

/**
 * The same names again, as real module exports.
 *
 * At *runtime* these are never imported: the compiler rewrites a view's
 * `import { Panel } from '@contract'` into a read from the published global, so
 * `DASHBOARD_COMPONENTS` above is what actually satisfies it.
 *
 * They are exported anyway so that `@contract` is a module a **type checker**
 * can resolve. Without this, a generated view can be typechecked against
 * nothing — and a view nothing typechecks is a view that ships with `span={12}`
 * on a component whose props are `defaultW`/`minW`, renders every panel one
 * column wide, and passes the guard because esbuild strips types rather than
 * reading them. That happened, on the first real dashboard this agent built.
 *
 * The duplication is real and deliberate: TypeScript export lists cannot be
 * computed. Only the object above is registered with the backend, so a name
 * missing from this list fails the backend's typecheck of any view that imports
 * it — loudly, and naming the symbol.
 */
export {
	usePanelData,
	useFilterOptions,
	useParam,
	Panel,
	Stack,
	Row,
	Card,
	Grid,
	Heading,
	Text,
	Loading,
	EmptyState,
	ErrorNote,
	Metric,
	BarChart,
	LineChart,
	PieChart,
	DataTable,
	MatrixTable,
	FilterBar,
	FilterGroup,
	FilterChoice,
	FilterSearch,
	FilterMultiChoice,
	FilterDate,
	FilterDateRange,
	FilterRange,
	FilterToggle,
	formatValue,
	formatNumber,
	formatCurrency,
	formatPercent,
	formatCompact,
	formatDate,
};

/**
 * The names a dashboard program may import — the keys of the one list above.
 *
 * Derived, never typed out. This used to be a hand-written array here, another
 * in the backend guard, and a third as prose in the builder's prompt, and it had
 * already drifted: `AreaChart` was implemented, styled and working, and missing
 * from every one of them, so the guard rejected it and no agent knew it existed.
 */
export const DASHBOARD_COMPONENT_NAMES: readonly string[] = Object.keys(DASHBOARD_COMPONENTS);

/**
 * What each one says about itself, collected off the values.
 *
 * The same filter `superatom.ts` uses for the platform's own components — the
 * convention already in this repository, applied to a separate list because a
 * dash contract export is an import inside a generated program, not a DSL node.
 */
export const DASHBOARD_COMPONENT_REGISTRY = collectRegistry(DASHBOARD_COMPONENTS);

/** React, narrowed to what the stub re-exports. */
const REACT: Record<string, unknown> = Object.fromEntries(
	REACT_EXPORTS.map((name) => [name, (React as unknown as Record<string, unknown>)[name]]),
);

let published = false;

/**
 * Publishes the runtime a compiled dashboard reads.
 *
 * Idempotent, and it **throws on a gap** rather than warning. A missing export
 * is not a degraded dashboard, it is a dashboard that will crash somewhere
 * unpredictable — better to find out at boot, on the developer's machine, than
 * in a panel a reader is looking at.
 */
export function publishRuntime(): DashboardRuntime {
	const runtime: DashboardRuntime = {
		react: REACT,
		jsxRuntime: JsxRuntime as unknown as Record<string, unknown>,
		contract: DASHBOARD_COMPONENTS,
		version: '1',
	};

	/**
	 * The gap worth checking is no longer a missing *name*.
	 *
	 * Names are the keys of `DASHBOARD_COMPONENTS`, so "listed but not present"
	 * stopped being expressible. What can still go wrong is adding an export and
	 * not describing it — which fails silently in the worst way: the component
	 * works, the guard permits it, and no agent is ever told it exists. That is
	 * exactly how `AreaChart` sat unreachable, so it is checked at boot.
	 */
	const { undescribed } = DASHBOARD_COMPONENT_REGISTRY;
	if (undescribed.length) {
		throw new Error(
			`These dashboard components have no Metadata: ${undescribed.join(', ')}. ` +
				`Add it beside the component — an export nobody can describe is one no agent ` +
				`will be told about.`,
		);
	}

	const reactGaps = missingReactExports(runtime);
	if (reactGaps.length) {
		throw new Error(`The dashboard runtime is missing: ${reactGaps.join(', ')}.`);
	}

	(globalThis as Record<string, unknown>)[RUNTIME_GLOBAL] = runtime;
	published = true;
	return runtime;
}

export const isRuntimePublished = () => published;

/**
 * Loads a compiled dashboard module from source text.
 *
 * The code arrives over the websocket as chunks, is reassembled, wrapped in a
 * Blob and imported from an object URL — the same path the component bundle
 * already takes. `import()` needs a URL, but the URL is made here from bytes we
 * already hold; it never has to be a network URL.
 */
export async function loadDashboardModule(code: string): Promise<{ default: React.ComponentType }> {
	if (!published) {
		throw new Error('publishRuntime() must be called before a dashboard module is loaded.');
	}
	const blob = new Blob([code], { type: 'application/javascript' });
	const url = URL.createObjectURL(blob);
	try {
		return (await import(/* @vite-ignore */ url)) as { default: React.ComponentType };
	} finally {
		/* Revoked immediately: the module is resolved and holding the URL leaks. */
		URL.revokeObjectURL(url);
	}
}

export {
	DashboardHost,
	usePanelSize,
	/* Shell-only, and deliberately NOT in DASHBOARD_COMPONENTS: a view program has
	 * no business rearranging the reader's layout, and that object is what decides
	 * what a generated program can reach. */
	useLayoutEditing,
	RUNTIME_GLOBAL,
	GRID_COLUMNS,
	GRID_GAP,
	ROW_UNIT,
	themeVariables,
	CATEGORICAL,
	SEQUENTIAL,
	DIVERGING,
	SENTIMENT,
};

export type { AsyncState, DashboardTransport, Param, ParamSpec, DashboardRuntime };
export type * from './types';

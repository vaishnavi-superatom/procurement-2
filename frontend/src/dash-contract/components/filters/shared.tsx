/**
 * What every filter control is built from.
 *
 * Three things live here because all six filters need them and none of them
 * owns them: the pill shell, the two shapes an option list can arrive in, and
 * the rule for what happens to a selection a parent filter has invalidated.
 *
 * The pill is Metabase's, measured from `ParameterWidget.module.css`: a 32px
 * bordered control that changes border colour on hover and carries its own
 * label inside. Filters are chrome, and chrome does not look like a card.
 */
import { createContext, useContext, useEffect, useMemo, useRef } from 'react';
import type { ReactNode } from 'react';
import { useBatchedParam, type AsyncState, type Param } from '../../context';
import { T } from '../../theme';
import type { Rows, ScalarValue } from '../../types';

/** Whether a control is rendered inside a `FilterBar`. False everywhere else. */
export const InFilterBar = createContext(false);

/**
 * Puts this control's parameters under Apply when it stands in the bar.
 *
 * The bar batches so that six filters cost one round of queries rather than
 * six. That hold used to cover every parameter on the page, and Apply lives in
 * the bar — so a filter placed beside the table it filters looked dead: the
 * pick was staged, the table did not move, and the button that would have moved
 * it was in another panel. A control outside the bar now applies on the spot.
 */
export function useAppliesWithBar(...params: (Param | undefined)[]): void {
	const inBar = useContext(InFilterBar);
	/* Hook order stays fixed: a control's parameter count never changes. */
	for (const param of params) useBatchedParam(param?.id, inBar);
}

export const PILL_HEIGHT = 32;

export const pillStyle = (active: boolean): React.CSSProperties => ({
	display: 'inline-flex',
	alignItems: 'center',
	gap: 6,
	height: PILL_HEIGHT,
	padding: '0 10px',
	/* Squarer than a card. A filter is chrome sitting on the page, and at the
	 * card's own 10px radius a row of them reads as a row of small cards. */
	borderRadius: 4,
	border: `1px solid ${active ? T.accent : T.line}`,
	background: T.surface,
	color: T.fg,
	fontSize: 12,
	fontFamily: T.font,
	cursor: 'pointer',
	whiteSpace: 'nowrap',
	transition: 'border-color 140ms ease',
});

/** The filter's name, inside the control rather than above it — as Metabase does. */
export const PillLabel = ({ children }: { children: ReactNode }) => (
	<span style={{ color: T.muted, fontSize: 11.5 }}>{children}</span>
);

/** Longest option label a control will show before trimming. */
export const LABEL_MAX = 20;

/**
 * Trims an option label so one long name cannot set the width of a filter.
 *
 * Real names run to sixty characters — a customer, a project, a person with a
 * title — and a control sized to the longest one pushes every other filter off
 * the row. The full text stays available as the element's `title`.
 */
export const trimLabel = (text: string): string =>
	text.length > LABEL_MAX ? `${text.slice(0, LABEL_MAX - 1).trimEnd()}…` : text;

/**
 * A spinner, as inline SVG.
 *
 * SMIL rather than CSS because the contract carries no stylesheet — a compiled
 * dashboard never passes through the host's build, so there is nowhere to
 * declare keyframes. This animates on its own.
 */
export const Spinner = ({ size = 12 }: { size?: number }) => (
	<svg width={size} height={size} viewBox="0 0 16 16" aria-hidden style={{ flex: '0 0 auto' }}>
		<circle cx="8" cy="8" r="6" fill="none" stroke={T.line} strokeWidth="2" />
		<path d="M8 2 a6 6 0 0 1 6 6" fill="none" stroke={T.accent} strokeWidth="2" strokeLinecap="round">
			<animateTransform
				attributeName="transform"
				type="rotate"
				from="0 8 8"
				to="360 8 8"
				dur="0.7s"
				repeatCount="indefinite"
			/>
		</path>
	</svg>
);

/** A bare input, for the pills that hold one. */
export const bareInput: React.CSSProperties = {
	border: 'none',
	background: 'transparent',
	font: 'inherit',
	color: 'inherit',
	outline: 'none',
};

/* ------------------------------- option lists ------------------------------ */

export type Choice = { value: ScalarValue; label: string };

export interface ChoiceSource {
	/** A fixed list. Use this when the values are known at build time. */
	options?: readonly ScalarValue[] | readonly Choice[];
	/**
	 * A resolver's rows, for values that depend on another filter.
	 *
	 * This is the whole of dependent filtering: pass the parent's handle to the
	 * resolver that produces these rows, and the list narrows when the parent
	 * changes. No foreign keys, no metadata — the dependency is the parameter
	 * binding that already exists, so a chain of any depth works.
	 */
	optionsFrom?: AsyncState<Rows>;
	/** Which column holds the value. Defaults to the first column. */
	valueColumn?: string;
	/** Which column holds the display text. Defaults to `valueColumn`. */
	labelColumn?: string;
}

/** Normalises the two shapes an option list can arrive in. */
export function toChoices(source: ChoiceSource): { choices: Choice[]; loading: boolean } {
	const { options, optionsFrom, valueColumn, labelColumn } = source;

	const fixed = ((options ?? []) as unknown[]).map((o) =>
		typeof o === 'object' && o !== null && 'value' in o
			? (o as Choice)
			: { value: o as ScalarValue, label: String(o) },
	);

	if (optionsFrom) {
		const rows = optionsFrom.data ?? [];
		const key = valueColumn ?? optionsFrom.columns?.[0]?.name;
		if (!key) return { choices: fixed, loading: optionsFrom.loading };
		/**
		 * Fixed options come first, then whatever the resolver found.
		 *
		 * This is how a list gets an "All" — the one entry that cannot come from
		 * the data, because it means the absence of a filter. Making the resolver
		 * invent a row for it means a query that returns something no table
		 * contains, ordered ahead of real rows by a sort the source may not
		 * support. That is a lot of SQL to express "no filter", and it fails on
		 * the sources least able to fake a row.
		 */
		return {
			choices: [
				...fixed,
				...rows.map((row) => ({
					value: row[key] as ScalarValue,
					label: String(row[labelColumn ?? key] ?? row[key] ?? ''),
				})),
			],
			loading: optionsFrom.loading,
		};
	}

	return { choices: fixed, loading: false };
}

/**
 * Clears a selection the parent has invalidated.
 *
 * When Country changes from NZ to AU, a City of "Auckland" is no longer one of
 * the options. The research lists three possible answers — clear it, keep it and
 * mark it invalid, or auto-select the first valid value — and this takes the
 * first.
 *
 * Keeping an invalid value means every panel bound to it queries for something
 * that cannot match and renders empty, which reads as broken data rather than a
 * stale filter. Auto-selecting silently changes what the reader is looking at,
 * which is worse: a number moves and nothing says why. Clearing is the only one
 * of the three that is visibly a filter being reset.
 *
 * Nothing happens while the options are still loading — a child must not be
 * cleared because its list has not arrived yet.
 */
export function useValidSelection(param: Param, values: ScalarValue[], ready: boolean): void {
	const known = useRef(false);

	useEffect(() => {
		if (!ready || !values.length) return;
		/* The first resolved list is not a change — it is the initial state. */
		if (!known.current) {
			known.current = true;
			return;
		}
		const current = param.value;
		if (current === null || current === undefined) return;
		if (!values.some((v) => String(v) === String(current))) param.reset();
	}, [ready, values, param]);
}

/** The values of a choice list, stable for the effect above. */
export function useChoiceValues(choices: Choice[]): ScalarValue[] {
	return useMemo(() => choices.map((c) => c.value), [choices]);
}

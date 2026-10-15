/**
 * Find one value by typing.
 *
 * The case a dropdown cannot serve. Metabase switches to this above roughly a
 * hundred distinct values, and the reasoning holds: past that a reader is
 * scrolling a list they cannot scan.
 *
 * Matching is client-side over the options given by default, so the resolver
 * behind `optionsFrom` should already cap its rows.
 *
 * Pass `query` when the list is too large to bring back at all — a project
 * picker over a whole warehouse — and the search moves to the server: the typed
 * text is written to that parameter, the resolver behind `optionsFrom` takes it
 * and does the matching, and this control stops filtering locally. Debounced,
 * because a parameter drives a query and a keystroke should not.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ContractMeta } from '../../meta';
import { useLiveParam, type Param } from '../../context';
import { T } from '../../theme';
import type { ScalarValue } from '../../types';
import {
	PillLabel,
	Spinner,
	bareInput,
	pillStyle,
	toChoices,
	trimLabel,
	useAppliesWithBar,
	type Choice,
	type ChoiceSource,
} from './shared';

export interface FilterSearchProps extends ChoiceSource {
	param: Param;
	label?: string;
	placeholder?: string;
	/** How many matches to show at once. */
	limit?: number;
	/**
	 * A parameter carrying the typed text, for a search the SERVER runs.
	 *
	 * Declare it with `useParam`, pass it to the resolver behind `optionsFrom`,
	 * and pass it here. Matching then happens in SQL over everything, rather than
	 * in the browser over whatever the resolver happened to return — which is the
	 * difference between finding any project and finding one of the first two
	 * hundred.
	 */
	query?: Param;
	/** Text for the "no filter" entry. Omit to make a choice mandatory. */
	anyLabel?: string;
}

/**
 * How long a reader may keep typing before the server is asked.
 *
 * A constant, not a prop. It is a feel setting with one right answer — long
 * enough that a word costs one query, short enough that the list does not feel
 * stuck — and nothing about a particular dashboard changes it. A prop here
 * would be a knob every generated view has to decide about and none has a
 * reason to move.
 */
const QUERY_DEBOUNCE_MS = 250;

export function FilterSearch({
	param,
	label,
	placeholder,
	limit = 20,
	query: queryParam,
	anyLabel,
	...source
}: FilterSearchProps) {
	const { choices: found, loading } = toChoices(source);
	useAppliesWithBar(param);
	const [query, setQuery] = useState('');
	const [open, setOpen] = useState(false);

	/**
	 * The "no filter" entry, added here rather than by the resolver.
	 *
	 * It means the absence of a filter, so no table contains it. A server-side
	 * search replaces the whole list on every keystroke, and prepending it in the
	 * control is what keeps it there — and at the top, where a reset belongs.
	 */
	/* "All" is the parameter's own default — `0`, `''`, whatever the view declared. */
	const none = (param.spec.default ?? '') as ScalarValue;
	const choices = useMemo<Choice[]>(
		() => (anyLabel ? [{ value: none, label: anyLabel }, ...found] : found),
		[anyLabel, found, none],
	);

	/**
	 * The committed text, and a stable handle on the setter.
	 *
	 * Deliberately not `[queryParam]` as a dependency. `useParam` rebuilds its
	 * handle whenever the spec object changes identity, and the spec is written
	 * inline in the view, so the handle is a new object on every render — an
	 * effect depending on it would clear and restart the debounce timer forever
	 * and never fire. The value is a scalar and is safe to depend on.
	 */
	const committed = queryParam ? String(queryParam.value ?? '') : undefined;
	const setQueryParam = useRef(queryParam?.set);
	setQueryParam.current = queryParam?.set;

	/**
	 * The typed text reaches the server even when the bar batches.
	 *
	 * Two or more parameters turn Apply on, and a view with a server-side search
	 * has at least two — the chosen row and the text. Without this the text stops
	 * at the draft, the options resolver never re-runs, and the control shows no
	 * spinner and no new rows however much you type. What Apply governs is the
	 * row you pick, which is the filter; the typing is how the list is fetched.
	 */
	useLiveParam(queryParam?.id);

	useEffect(() => {
		if (committed === undefined) return;
		if (query === committed) return;
		const timer = window.setTimeout(() => setQueryParam.current?.(query), QUERY_DEBOUNCE_MS);
		return () => window.clearTimeout(timer);
	}, [query, committed]);

	const matches = useMemo(() => {
		/* The server already matched. Filtering again here would hide rows it
		 * deliberately returned — a fuzzy or aliased match the browser cannot see. */
		if (queryParam) return choices.slice(0, limit);
		const needle = query.trim().toLowerCase();
		if (!needle) return choices.slice(0, limit);
		return choices.filter((c) => c.label.toLowerCase().includes(needle)).slice(0, limit);
	}, [choices, query, limit, queryParam]);

	/**
	 * What the closed control shows: the chosen row's label, not its value.
	 *
	 * These lists are usually `{ value: id, label: name }`, so showing the raw
	 * value put a bare record id in front of the reader once they had picked
	 * something. It only ever read correctly when value and label were the same
	 * column.
	 */
	const selectedLabel = useMemo(() => {
		/* Nothing chosen. With an "any" entry that is a state with a name, so say
		 * it rather than showing the placeholder for a filter that is doing its
		 * job. */
		const empty = param.value === null || param.value === undefined || param.value === '';
		if (empty || (anyLabel && param.isDefault)) return anyLabel ? trimLabel(anyLabel) : '';
		const hit = choices.find((c) => String(c.value) === String(param.value));
		return trimLabel(hit ? hit.label : String(param.value));
	}, [choices, param.value, param.isDefault, anyLabel]);

	/**
	 * Where the list should sit, in viewport coordinates.
	 *
	 * The list is portalled to `<body>` rather than positioned inside this
	 * control, because a panel clips and an absolutely positioned list inside one
	 * is cut off at its edge — no z-index reaches past `overflow: hidden`. Same
	 * reason the chart tooltips are appended to the body.
	 *
	 * Re-measured on scroll and resize while open, since `position: fixed` does
	 * not follow the anchor on its own.
	 */
	const anchor = useRef<HTMLLabelElement>(null);
	const [box, setBox] = useState<DOMRect | null>(null);

	useEffect(() => {
		if (!open) return;
		const measure = () => setBox(anchor.current?.getBoundingClientRect() ?? null);
		measure();
		/* Capture phase: the scroll that matters is a panel's or the canvas's, not
		 * the window's. */
		window.addEventListener('scroll', measure, true);
		window.addEventListener('resize', measure);
		return () => {
			window.removeEventListener('scroll', measure, true);
			window.removeEventListener('resize', measure);
		};
	}, [open]);

	return (
		<div style={{ position: 'relative' }} role="listitem">
			<label ref={anchor} style={pillStyle(Boolean(param.value))}>
				{label && <PillLabel>{label}</PillLabel>}
				{/**
				 * The spinner sits *over* the input, not beside it.
				 *
				 * Beside it, appearing mid-search widened the pill by the icon and its
				 * gap, which re-wrapped the filter bar. A bar is a wrapping row inside a
				 * panel that clips, so the last control dropped below the fold and read
				 * as vanishing. The control's width may not depend on its state.
				 */}
				<span style={{ position: 'relative', display: 'inline-flex', width: 150 }}>
					<input
						value={open ? query : selectedLabel}
						placeholder={loading ? 'Loading…' : (placeholder ?? 'Search…')}
						onFocus={() => {
							setOpen(true);
							setQuery('');
						}}
						/* Closed on a timer rather than immediately: a click on a result is a
						 * blur first, and closing on blur would remove the row before the
						 * click landed on it. */
						onBlur={() => window.setTimeout(() => setOpen(false), 120)}
						onChange={(e) => setQuery(e.target.value)}
						style={{
							...bareInput,
							width: '100%',
							boxSizing: 'border-box',
							/* Room for the spinner, reserved whether or not it is showing. */
							paddingRight: 16,
						}}
					/>
					{/* A server-side search runs on a debounce, so without this the control
					    sits still for a moment after typing and reads as unresponsive. */}
					{loading && (
						<span
							style={{
								position: 'absolute',
								right: 0,
								top: '50%',
								transform: 'translateY(-50%)',
								display: 'inline-flex',
								pointerEvents: 'none',
							}}
						>
							<Spinner />
						</span>
					)}
				</span>
			</label>

			{open && matches.length > 0 && box && createPortal(
				<div
					style={{
						position: 'fixed',
						top: box.bottom + 4,
						left: box.left,
						zIndex: 999999,
						minWidth: Math.max(200, box.width),
						maxWidth: 360,
						maxHeight: 240,
						overflowY: 'auto',
						background: T.surface,
						border: `1px solid ${T.line}`,
						borderRadius: 8,
						boxShadow: '0 6px 20px rgba(0,0,0,0.10)',
						fontFamily: T.font,
					}}
				>
					{matches.map((c) => (
						<button
							key={String(c.value)}
							type="button"
							/* mouseDown, not click — the input's blur fires first and would
							 * unmount this row before a click could reach it. */
							onMouseDown={() => {
								param.set(c.value);
								setOpen(false);
							}}
							/* Full name here, not the trimmed one — the list is where you
							   read enough to choose. It is the control that must stay
							   narrow, not the menu. */
							title={c.label}
							style={{
								display: 'block',
								width: '100%',
								textAlign: 'left',
								padding: '7px 10px',
								border: 'none',
								background: 'transparent',
								font: 'inherit',
								fontSize: 12,
								color: T.fg,
								cursor: 'pointer',
								overflow: 'hidden',
								textOverflow: 'ellipsis',
								whiteSpace: 'nowrap',
							}}
						>
							{c.label}
						</button>
					))}
				</div>,
				document.body,
			)}
		</div>
	);
}

FilterSearch.Metadata = {
	kind: 'filter',
	purpose: 'Find one value by typing, for a list too long to scroll.',
	useWhen: 'Past about a hundred distinct values, where a dropdown stops being scannable.',
	props: {
		param: { description: 'The useParam handle this control writes to.', importance: 'required' },
		optionsFrom: {
			description: 'A resolver’s rows to search. The usual source for a list this long.',
			importance: 'recommended',
			caution:
				'Without `query`, matching is client-side over exactly what this returns, so cap it in ' +
				'the resolver. With `query`, the resolver does the matching and returns only hits. ' +
				'Rows from this filter’s own options resolver, one row per option.',
		},
		query: {
			description:
				'A second useParam handle carrying the typed text, for a search the SERVER runs. ' +
				'Declare it, pass it to the resolver behind optionsFrom, and pass it here.',
			caution:
				'Use it when the list is too large to bring back at all. Without it a reader can only ' +
				'find what the resolver already returned, which for a warehouse-sized list means the ' +
				'search silently covers the first few hundred rows and nothing else. With it, the ' +
				'resolver always filters by the typed text — this control no longer filters locally. ' +
				'IMPORTANT: pass this param only to this filter’s own useFilterOptions. Panels and other ' +
				'filters take `param`, the picked value.',
		},
		anyLabel: {
			description:
				'Text for the "no filter" entry, e.g. "All projects". It is added at the top of the ' +
				'list by the control, so a server-side search keeps it on every keystroke.',
			caution:
				'Choosing it resets the parameter to its useParam default, so that default is the "all" ' +
				'state. Never have the resolver return an "All" row of its own.',
		},
		options: {
			description: 'A fixed list, when the values are known at build time.',
			caution:
				'Never one option: a control the reader cannot change is decoration. And a list short ' +
				'enough to type by hand does not need a search box — reach for FilterChoice instead.',
		},
		valueColumn: { description: 'Which column holds the value. Defaults to the first column.' },
		labelColumn: {
			description: 'Which column holds the display text. Defaults to whatever valueColumn resolved to.',
		},
		label: { description: 'Shown inside the control.', importance: 'recommended' },
		placeholder: { description: 'Hint text when nothing is selected.', default: 'Search…' },
		limit: { description: 'How many matches to show at once.', default: 20 },
	},
} satisfies ContractMeta;

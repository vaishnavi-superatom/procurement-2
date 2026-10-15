/**
 * Pick one value from a set.
 *
 * Two displays, and the choice between them is about how many values there are
 * rather than taste: `segmented` shows every option at once, which stops being
 * readable past four or five; `dropdown` hides them behind a click, which is the
 * right trade the moment the list is longer than the eye can take in.
 */
import type { ContractMeta } from '../../meta';
import type { Param } from '../../context';
import { T } from '../../theme';
import { FilterSearch } from './search';
import {
	PILL_HEIGHT,
	PillLabel,
	bareInput,
	pillStyle,
	toChoices,
	trimLabel,
	useAppliesWithBar,
	useChoiceValues,
	useValidSelection,
	type ChoiceSource,
} from './shared';

/** Above this many choices a dropdown becomes a search box. */
const SEARCH_ABOVE = 10;

/** The `<option>` value for the "All" entry. Never a real value. */
const ANY = ' any';

export interface FilterChoiceProps extends ChoiceSource {
	param: Param;
	label?: string;
	display?: 'segmented' | 'dropdown';
	/** Text for the "no filter" entry. Omit to make the filter required. */
	anyLabel?: string;
	/**
	 * A parameter carrying the typed text, for a search the SERVER runs.
	 *
	 * Only used once the list is long enough to become a search. Pass it with
	 * `optionsFrom` when the full list is too large to bring back.
	 */
	query?: Param;
}

export function FilterChoice({
	param,
	label,
	display = 'dropdown',
	anyLabel,
	query,
	...source
}: FilterChoiceProps) {
	const { choices, loading } = toChoices(source);
	const values = useChoiceValues(choices);
	useValidSelection(param, values, !loading);
	useAppliesWithBar(param);

	const active = param.value !== null && param.value !== undefined && !param.isDefault;

	if (display === 'segmented') {
		/**
		 * One joined control, not a row of separate buttons.
		 *
		 * Separate pills read as several filters that happen to sit together; a
		 * single bordered group with hairlines between reads as one filter with
		 * several settings, which is what it is. The selected segment is filled in
		 * the foreground colour rather than the accent — the accent is already the
		 * caption above it and the first series colour in every chart, and a third
		 * job would stop it meaning anything.
		 */
		return (
			<div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }} role="listitem">
				{label && <PillLabel>{label}</PillLabel>}
				<div
					style={{
						display: 'inline-flex',
						height: PILL_HEIGHT,
						border: `1px solid ${T.line}`,
						borderRadius: 4,
						overflow: 'hidden',
					}}
				>
					{choices.map((c, i) => {
						const on = String(param.value) === String(c.value);
						return (
							<button
								key={String(c.value)}
								type="button"
								onClick={() => param.set(c.value)}
								style={{
									height: '100%',
									padding: '0 14px',
									border: 'none',
									borderLeft: i ? `1px solid ${T.line}` : 'none',
									background: on ? T.fg : T.surface,
									color: on ? '#fff' : T.fg,
									font: 'inherit',
									fontSize: 12,
									fontFamily: T.font,
									cursor: 'pointer',
									whiteSpace: 'nowrap',
								}}
								title={c.label}
							>
								{trimLabel(c.label)}
							</button>
						);
					})}
				</div>
			</div>
		);
	}

	/**
	 * Past ten values a dropdown stops being scannable, so it becomes a search.
	 *
	 * Decided from the choices actually loaded rather than from a prop: a list
	 * fed by `optionsFrom` does not know its own length until the resolver
	 * returns, so this is the only point at which the question can be answered.
	 *
	 * The whole source is handed over, not the rows it produced. Passing
	 * `options` alone froze a dependent list at whatever it held when it crossed
	 * ten entries, and dropped the server-side search with it.
	 */
	if (choices.length > SEARCH_ABOVE) {
		return <FilterSearch param={param} label={label} anyLabel={anyLabel} query={query} {...source} />;
	}

	return (
		<label style={pillStyle(active)} role="listitem">
			{label && <PillLabel>{label}</PillLabel>}
			<select
				/* With an "All" entry, the default is that entry, whatever value it has. */
				value={anyLabel && param.isDefault ? ANY : String(param.value ?? '')}
				disabled={loading}
				onChange={(e) => (e.target.value === ANY ? param.reset() : param.set(e.target.value))}
				style={{ ...bareInput, cursor: 'pointer', maxWidth: 180 }}
			>
				{anyLabel && <option value={ANY}>{anyLabel}</option>}
				{loading && <option>Loading…</option>}
				{choices.map((c) => (
					/* Trimmed: a native select sizes itself to its longest option, so one
					   long name widens the control even while closed. */
					<option key={String(c.value)} value={String(c.value)} title={c.label}>
						{trimLabel(c.label)}
					</option>
				))}
			</select>
		</label>
	);
}

FilterChoice.Metadata = {
	kind: 'filter',
	purpose: 'Pick one value from a set.',
	useWhen:
		'`segmented` for three or four values the reader should see at once; `dropdown` beyond that.',
	props: {
		param: {
			description: 'The useParam handle this control writes to.',
			importance: 'required',
			group: 'binding',
		},
		options: {
			description: 'A fixed list — plain values, or { value, label } pairs.',
			importance: 'recommended',
			group: 'values',
			caution:
				'Pass either this or optionsFrom, not both. Never one option: a control the reader ' +
				'cannot change is decoration, and it reads as a filter that is broken rather than ' +
				'one that has nothing to offer. If the distinct values came back as one, drop the ' +
				'control and say so in the panel title instead.',
		},
		optionsFrom: {
			description:
				'A resolver’s rows, when the values depend on another filter. Pass the parent handle ' +
				'to that resolver and this list narrows when the parent changes.',
			group: 'values',
			caution:
				'Rows from this filter’s own options resolver, one row per option. Every row becomes an option, ' +
				'so a resolver shared with other filters shows duplicates.',
		},
		valueColumn: {
			description: 'Which column of optionsFrom holds the value. Defaults to the first column.',
			group: 'values',
		},
		labelColumn: {
			description: 'Which column holds the display text. Defaults to whatever valueColumn resolved to.',
			group: 'values',
		},
		label: {
			description: 'Shown inside the control, before the value.',
			importance: 'recommended',
			group: 'display',
			caution: 'Without it a reader sees a value with nothing saying what it filters.',
		},
		display: {
			description: '"segmented" shows every option; "dropdown" hides them behind a click.',
			default: 'dropdown',
			group: 'display',
		},
		anyLabel: {
			description:
				'Text for the "no filter" entry, e.g. "All projects". Omit to make a choice mandatory.',
			group: 'display',
			caution: 'Choosing it resets the parameter to its useParam default, so that default is the "all" state.',
		},
		query: {
			description:
				'A second useParam handle carrying the typed text, for a search the SERVER runs. ' +
				'Used once the list is long enough to become a search.',
			group: 'values',
			caution:
				'Pass it with optionsFrom when the full list is too large to bring back. Without it a ' +
				'long list can only be searched over the rows the resolver already returned.',
		},
	},
	notes:
		'A selection the parent invalidates is cleared rather than left querying for something that ' +
		'cannot match.',
} satisfies ContractMeta;

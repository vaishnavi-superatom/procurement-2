/**
 * A numeric range — minimum and maximum.
 *
 * Two parameters for the same reason the date range takes two: a resolver wants
 * `BETWEEN $min AND $max`, and one packed value would have to be taken apart
 * inside the SQL.
 *
 * Committed on blur or Enter rather than per keystroke. Typing "1500" would
 * otherwise re-run every bound panel four times — once for "1", once for "15",
 * and so on — and three of those four queries are for a number nobody meant.
 */
import type { ContractMeta } from '../../meta';
import type { Param } from '../../context';
import { PillLabel, bareInput, pillStyle, useAppliesWithBar } from './shared';

export function FilterRange({
	min,
	max,
	label,
	step,
}: {
	min: Param;
	max: Param;
	label?: string;
	step?: number;
}) {
	useAppliesWithBar(min, max);

	const field = (param: Param) => (
		<input
			type="number"
			step={step}
			/* Uncontrolled on purpose: a controlled input committing on blur would
			 * fight the reader's own typing between keystroke and commit. */
			defaultValue={String(param.value ?? '')}
			placeholder="any"
			onBlur={(e) => param.set(e.target.value === '' ? '' : Number(e.target.value))}
			onKeyDown={(e) => {
				if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
			}}
			style={{ ...bareInput, width: 68 }}
		/>
	);

	return (
		<div style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }} role="listitem">
			{label && <PillLabel>{label}</PillLabel>}
			<label style={pillStyle(min.value !== null && min.value !== '')}>
				<PillLabel>Min</PillLabel>
				{field(min)}
			</label>
			<label style={pillStyle(max.value !== null && max.value !== '')}>
				<PillLabel>Max</PillLabel>
				{field(max)}
			</label>
		</div>
	);
}

FilterRange.Metadata = {
	kind: 'filter',
	purpose: 'A numeric range — minimum and maximum.',
	useWhen: 'Bounding a measure: orders over £1,000, margins below zero.',
	props: {
		min: {
			description: 'The parameter holding the lower bound.',
			importance: 'required',
			caution: 'An empty field means unbounded on that side — the resolver must allow null.',
		},
		max: { description: 'The parameter holding the upper bound.', importance: 'required' },
		label: { description: 'Shown before the controls.', importance: 'recommended' },
		step: { description: 'Increment for the number input.', default: 1 },
	},
	notes: 'Commits on blur or Enter, not on every keystroke.',
} satisfies ContractMeta;

/**
 * One on/off filter, one click.
 *
 * A two-option dropdown for a yes-or-no costs a click and a read to do what a
 * toggle does at a glance, which is why this exists as its own control rather
 * than as a `FilterChoice` with two values.
 */
import type { ContractMeta } from '../../meta';
import type { Param } from '../../context';
import { T } from '../../theme';
import { pillStyle, useAppliesWithBar } from './shared';

export function FilterToggle({
	param,
	label,
	onLabel,
}: {
	param: Param;
	label: string;
	onLabel?: string;
}) {
	useAppliesWithBar(param);

	/* Accepts the string too: a parameter restored from the URL arrives as text,
	 * and a filter that silently reads as off after a reload is worse than one
	 * that never persisted at all. */
	const on = param.value === true || param.value === 'true';

	return (
		<button
			type="button"
			role="listitem"
			aria-pressed={on}
			onClick={() => param.set(!on)}
			style={{
				...pillStyle(on),
				background: on ? T.accent : T.surface,
				color: on ? '#fff' : T.fg,
				borderColor: on ? T.accent : T.line,
			}}
		>
			<span
				style={{
					width: 8,
					height: 8,
					borderRadius: 999,
					background: on ? '#fff' : T.line,
					flex: '0 0 auto',
				}}
			/>
			{on ? (onLabel ?? label) : label}
		</button>
	);
}

FilterToggle.Metadata = {
	kind: 'filter',
	purpose: 'A single on/off filter.',
	useWhen:
		'A genuine yes or no — "exclude internal", "only active". A two-option dropdown is worse ' +
		'than a toggle for the same thing.',
	props: {
		param: {
			description: 'The useParam handle this control writes to.',
			importance: 'required',
			caution: 'Declare it as type "boolean" with a default, or the first click reads as a change from nothing.',
		},
		label: { description: 'What the filter does when off.', importance: 'required' },
		onLabel: {
			description: 'A different wording once it is on — "Including internal", say.',
			caution: 'Changing the wording is what tells a reader the state changed. Omit only when the label reads correctly both ways.',
		},
	},
} satisfies ContractMeta;

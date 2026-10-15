/**
 * A date range, as two parameters.
 *
 * Two rather than one, because a resolver's SQL wants `BETWEEN $from AND $to`
 * and a single packed value would have to be split somewhere — which means the
 * agent writing string surgery inside a query, exactly what the declared
 * parameter model exists to prevent.
 *
 * Quick ranges come first because they are what people pick. "Last 30 days" is a
 * far more common intent than a specific pair of dates, and a control that leads
 * with two empty date fields makes the common case the slow one.
 */
import type { ContractMeta } from '../../meta';
import { useSetParams, type Param } from '../../context';
import { T } from '../../theme';
import { PillLabel, bareInput, pillStyle, useAppliesWithBar } from './shared';

type Span = number | 'mtd' | 'qtd' | 'ytd';

const PRESETS: { id: string; label: string; span: Span }[] = [
	{ id: '7d', label: 'Last 7 days', span: 7 },
	{ id: '30d', label: 'Last 30 days', span: 30 },
	{ id: '90d', label: 'Last 90 days', span: 90 },
	{ id: 'mtd', label: 'Month to date', span: 'mtd' },
	{ id: 'qtd', label: 'Quarter to date', span: 'qtd' },
	{ id: 'ytd', label: 'Year to date', span: 'ytd' },
];

const iso = (d: Date) => d.toISOString().slice(0, 10);

function startOf(span: Span): string {
	const now = new Date();
	if (span === 'mtd') return iso(new Date(now.getFullYear(), now.getMonth(), 1));
	if (span === 'qtd') return iso(new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1));
	if (span === 'ytd') return iso(new Date(now.getFullYear(), 0, 1));
	const from = new Date(now);
	from.setDate(from.getDate() - span);
	return iso(from);
}

export function FilterDateRange({
	from,
	to,
	label,
}: {
	from: Param;
	to: Param;
	label?: string;
}) {
	const active = Boolean(from.value || to.value);
	const setParams = useSetParams();
	useAppliesWithBar(from, to);

	/**
	 * Which preset the current dates *are*, if any.
	 *
	 * The select used to be pinned to `value=""`, so choosing "Last 30 days"
	 * applied the range and then snapped straight back to "Quick range…" — the
	 * control asserting it had done nothing, immediately after doing something.
	 * It was written as an action menu when the presets are state.
	 *
	 * Derived rather than remembered: a preset is not a separate thing to store,
	 * it *is* a pair of dates. Keeping a chosen-preset value beside `from` and
	 * `to` would be a third piece of state that can disagree with them — edit a
	 * date by hand and the label would still claim "Last 30 days".
	 */
	const selected =
		PRESETS.find((p) => from.value === startOf(p.span) && to.value === iso(new Date()))?.id ?? '';

	return (
		<div style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }} role="listitem">
			{label && <PillLabel>{label}</PillLabel>}

			<label style={pillStyle(active)}>
				<select
					value={selected}
					onChange={(e) => {
						const preset = PRESETS.find((p) => p.id === e.target.value);
						if (!preset) return;
						/* Both dates in one change. Two `set` calls would be two state
						 * changes, so every panel would fetch twice for one click — and
						 * the first fetch would use the new start against the old end,
						 * a range the reader never chose. */
						setParams({ [from.id]: startOf(preset.span), [to.id]: iso(new Date()) });
					}}
					style={{ ...bareInput, color: T.muted, cursor: 'pointer' }}
				>
					{/* Only offered while the dates match no preset — once one is
					    chosen, re-picking "Quick range…" would mean nothing. */}
					{!selected && <option value="">Quick range…</option>}
					{PRESETS.map((p) => (
						<option key={p.id} value={p.id}>
							{p.label}
						</option>
					))}
				</select>
			</label>

			<label style={pillStyle(Boolean(from.value))}>
				<PillLabel>From</PillLabel>
				<input
					type="date"
					value={String(from.value ?? '')}
					onChange={(e) => from.set(e.target.value)}
					style={bareInput}
				/>
			</label>

			<label style={pillStyle(Boolean(to.value))}>
				<PillLabel>To</PillLabel>
				<input
					type="date"
					value={String(to.value ?? '')}
					onChange={(e) => to.set(e.target.value)}
					style={bareInput}
				/>
			</label>
		</div>
	);
}

FilterDateRange.Metadata = {
	kind: 'filter',
	purpose: 'A date range, with the usual quick ranges.',
	useWhen: 'Any time-bounded dashboard. Offer it before any other filter.',
	props: {
		from: {
			description: 'The useParam handle holding the start date.',
			importance: 'required',
			caution:
				'The resolver receives an ISO string (YYYY-MM-DD). Declare the resolver parameter as ' +
				'type "date" so it is validated as one.',
		},
		to: { description: 'The useParam handle holding the end date.', importance: 'required' },
		label: { description: 'Shown before the controls.', importance: 'recommended' },
	},
	notes:
		'Two parameters, not one, so a resolver can write BETWEEN $from AND $to — a single packed ' +
		'value would have to be split inside the SQL. Values are ISO dates (YYYY-MM-DD). A quick ' +
		'range sets both ends in one change, so a panel fetches once rather than twice, and the ' +
		'dropdown shows which range is in force rather than resetting to its placeholder.',
} satisfies ContractMeta;

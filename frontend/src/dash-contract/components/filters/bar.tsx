/**
 * The row filters live in, and an optional caption for grouping them.
 *
 * Metabase's `ParametersList` is a wrapping flex row —
 * `direction="row" align="end" wrap="wrap" gap="sm"` — sitting above the grid
 * rather than inside it. Wrapping rather than scrolling, so a dashboard with
 * eight filters degrades to two lines instead of a horizontal scrollbar.
 *
 * `alignItems: flex-end` so controls of different heights share a baseline: a
 * captioned select beside a bare toggle looks broken otherwise.
 */
import { useContext, useEffect, useLayoutEffect, type ReactNode } from 'react';
import type { ContractMeta } from '../../meta';
import { useFilterApply } from '../../context';
import { T } from '../../theme';
import { PanelFitContext } from '../layout/panel';
import { InFilterBar } from './shared';

export const FilterBar = ({ apply, children }: { apply?: boolean; children: ReactNode }) => {
	const { deferred, setDeferred, paramCount, pending, commit, revert } = useFilterApply();

	/* The panel holding the bar grows when the filters wrap, instead of clipping them. */
	const setFit = useContext(PanelFitContext);
	useLayoutEffect(() => {
		setFit?.(true);
		return () => setFit?.(false);
	}, [setFit]);

	/**
	 * **On by default at two or more parameters.**
	 *
	 * It was opt-in, and opting in is a thing to remember — so the dashboards that
	 * needed it most did not get it. A date range is the clearest case: it writes
	 * `from` and `to` as two separate changes, so one drag of a date fires two
	 * rounds of queries and renders a combination in between that nobody asked to
	 * see. Against a source taking seconds per query that is the difference
	 * between a filter and a wait.
	 *
	 * Counted from the parameters the view declared, not the controls rendered
	 * here: one `FilterDateRange` is two parameters, and it is parameters that
	 * cost queries.
	 *
	 * `apply` still wins when given, in either direction — `apply={false}` is how
	 * a dashboard says it genuinely wants every change applied immediately.
	 *
	 * Deferring is a property of the dashboard, not of one control: a reader who
	 * must press Apply for the period but not for the country is being asked to
	 * remember which is which.
	 */
	const batched = apply ?? paramCount >= 2;

	useEffect(() => {
		setDeferred(batched);
		return () => setDeferred(false);
	}, [batched, setDeferred]);

	/**
	 * Two columns: the filters wrap, the buttons hold the right corner.
	 *
	 * They used to share one wrapping row with `marginLeft: auto`, which put them
	 * at the end of whatever the last line happened to be — right where you want
	 * them at two filters, and adrift in the middle of the bar at six. Giving the
	 * buttons their own fixed column reserves that space, so the filters wrap
	 * within what is left and the buttons never move.
	 */
	return (
		<div
			style={{
				flex: '0 0 auto',
				display: 'flex',
				flexDirection: 'row',
				alignItems: 'flex-end',
				gap: 12,
				/**
				 * The bar rules itself off from the dashboard below it.
				 *
				 * Filters are chrome, not a result, and the rule is what says so — it
				 * reads as the edge of a toolbar rather than as one more card. Drawn
				 * here rather than by the panel so the treatment travels with the bar:
				 * in a bare panel this is the whole look, and in a card panel the same
				 * rule degrades to a sensible section divider.
				 */
				paddingBottom: 14,
				borderBottom: `2px solid ${T.accent}`,
			}}
		>
			<div
				role="list"
				style={{
					flex: '1 1 auto',
					minWidth: 0,
					display: 'flex',
					flexDirection: 'row',
					flexWrap: 'wrap',
					alignItems: 'flex-end',
					/* Wide enough that each filter reads as its own control rather than
					 * as one run-on row of boxes. */
					gap: 20,
				}}
			>
				{/* What Apply governs: these controls, and nothing outside this bar. */}
				<InFilterBar.Provider value={true}>{children}</InFilterBar.Provider>
			</div>

			{deferred && (
				<div
					style={{
						/**
						 * A reserved slot, not a column that grows with its contents.
						 *
						 * Reset only exists once something is staged and Apply gains a
						 * count, so an auto width changed the moment a filter was touched
						 * — which took width away from the filters beside it and re-wrapped
						 * the whole bar under the reader's cursor. The width is fixed so
						 * that nothing a button does can move a filter.
						 */
						flex: '0 0 160px',
						display: 'flex',
						alignItems: 'center',
						justifyContent: 'flex-end',
						gap: 6,
						whiteSpace: 'nowrap',
						/**
						 * Top-aligned, so wrapping filters cannot push it out of sight.
						 *
						 * The row is `align-items: flex-end`, which sits the buttons at the
						 * bottom of the filter block. That is fine at one row and wrong at
						 * three: the panel clips at a fixed height, so Apply ends up below
						 * the fold and reads as missing. Changing a filter's label was
						 * enough to re-wrap the row and make it vanish.
						 */
						alignSelf: 'flex-start',
					}}
				>
					{/* Reset reads as absent until something is staged — a control that is
					    always visible but usually does nothing stops being read. Hidden
					    rather than unmounted so it keeps its place in the slot, and out of
					    the tab order and the accessibility tree while it is hidden. */}
					<button
						onClick={revert}
						disabled={pending === 0}
						aria-hidden={pending === 0}
						tabIndex={pending === 0 ? -1 : 0}
						style={{
							fontSize: 12,
							padding: '5px 10px',
							borderRadius: 6,
							border: `1px solid ${T.line}`,
							background: 'transparent',
							color: T.muted,
							cursor: 'pointer',
							visibility: pending > 0 ? 'visible' : 'hidden',
						}}
					>
						Reset
					</button>
					<button
						onClick={commit}
						disabled={pending === 0}
						title={pending === 0 ? 'Nothing changed yet' : `Apply ${pending} change${pending === 1 ? '' : 's'}`}
						/**
						 * Visible when idle, not just when armed.
						 *
						 * It was transparent with faint grey text, so on a white card it
						 * read as absent — and Apply is the only thing telling a reader
						 * their filter changes are not live yet. Miss it and you change a
						 * filter, nothing moves, and the dashboard looks broken.
						 */
						style={{
							fontSize: 12,
							fontWeight: 500,
							padding: '5px 12px',
							borderRadius: 6,
							border: `1px solid ${pending ? T.accent : T.lineStrong}`,
							background: pending ? T.accent : T.surfaceSunken,
							color: pending ? '#fff' : T.muted,
							cursor: pending ? 'pointer' : 'default',
						}}
					>
						Apply{pending > 0 ? ` (${pending})` : ''}
					</button>
				</div>
			)}
		</div>
	);
};

FilterBar.Metadata = {
	kind: 'filter',
	purpose: 'The row that holds filter controls.',
	useWhen: 'Once, at the top of a dashboard. Filters scattered between panels cannot be scanned.',
	props: {
		children: { description: 'The filter controls.', importance: 'required' },
		apply: {
			description:
				'Overrides the automatic behaviour. Leave it out — the bar batches by itself as soon as ' +
				'the view declares two or more parameters.',
			caution:
				'Only pass `apply={false}`, and only when a dashboard genuinely wants every change ' +
				'applied on the spot. Passing `apply` is never needed to turn batching on.',
		},
	},
	notes:
		'Wraps rather than scrolls, so eight filters become two lines, and its panel grows to fit them. Apply and Reset hold a fixed ' +
		'slot in the right corner; their position and width are not configurable. Put it in a full-width panel ' +
		'with defaultH={2}. From two parameters upward it batches automatically: the controls show ' +
		'what has been picked while the panels keep showing what is applied, and an Apply button ' +
		'counts what is waiting. A date range is two parameters, so it batches.',
} satisfies ContractMeta;

export const FilterGroup = ({
	label,
	hint,
	children,
}: {
	label: string;
	hint?: string;
	children: ReactNode;
}) => (
	<div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
		{/**
		 * The caption carries the accent, and it is the only thing in the bar that
		 * does.
		 *
		 * It was 11px muted grey, the same weight as a hint, so a row of filters
		 * read as a row of boxes with nothing naming them until you looked inside
		 * each one. Naming them in the accent puts the labels first and the values
		 * second, which is the order they are actually read in.
		 */}
		<div style={{ fontSize: 12.5, color: T.accent, fontWeight: 600 }}>
			{label}
			{hint && <span style={{ color: T.faint, fontWeight: 400 }}> · {hint}</span>}
		</div>
		{children}
	</div>
);

FilterGroup.Metadata = {
	kind: 'filter',
	purpose: 'A labelled caption above one or more controls.',
	props: {
		label: { description: 'The caption.', importance: 'required' },
		hint: { description: 'A shorter qualifier shown after the label.' },
		children: { description: 'The controls this caption covers.', importance: 'required' },
	},
	notes:
		'Optional. Each filter already carries its own label inside the control, so reach for this ' +
		'only when several controls belong under one caption.',
} satisfies ContractMeta;

/**
 * Pie and donut — parts of one whole.
 *
 * The only chart here that is not cartesian, and the only one that makes a
 * claim beyond the values it draws: **that the slices are all of something.**
 * Every design decision below follows from that claim being easy to break.
 *
 * ### It refuses negative values
 *
 * A slice is sized by magnitude, so −32,000,000 draws as a *large* wedge and
 * every percentage in the chart is then wrong. There is no honest pie of
 * mixed-sign data — not a degraded one, an incorrect one — so this renders an
 * explanation instead and points at `BarChart`, which handles both signs
 * correctly.
 *
 * This is the same failure the capping rule exists for: `ORDER BY value DESC
 * LIMIT 12` once dropped five negative subsidiaries and the visible bars summed
 * to 9.3% more than the real total. A warning under a chart that is already
 * lying does not help; the chart has to not be there.
 *
 * ### It says so when the parts are not the whole
 *
 * Two ways that happens, and both are stated in the footnote rather than
 * implied:
 *
 *  - the result was capped (`truncated`), so slices are missing entirely and
 *    the percentages are computed over a subset
 *  - a tail was collapsed into "Other" by `maxCategories`
 *
 * ### Six categories, not twelve
 *
 * The cartesian charts cap at about twelve because past that a reader is
 * matching swatches to a legend. A pie stops working sooner: angle is much
 * harder to compare than length, and thin wedges become indistinguishable long
 * before the legend runs out. Six is the default, and past about eight the right
 * answer is usually a bar chart.
 */
import { useMemo, useState } from 'react';
import ReactECharts from 'echarts-for-react';
import type { ContractMeta } from '../../meta';
import { EmptyState } from '../status';
import { columnLabel, formatValue } from '../../format';
import { CHART, RESOLVED, T, seriesColor } from '../../theme';
import type { ColumnMeta, Rows, ScalarValue } from '../../types';
import { Frame, useChartResize } from './cartesian';

/* --------------------------------- helpers ---------------------------------
 *
 * Kept local rather than shared, so a pie can be read and changed without
 * reasoning about the bar and line charts. They are small, and each differs
 * slightly from its cartesian cousin — `toNumber` has no gap/zero choice
 * because a pie has no axis to leave a hole in.
 *
 * The one exception is `useChartResize`, imported from `cartesian.tsx`. It
 * encodes a discovery rather than a preference — `echarts-for-react` listens on
 * `window` and never hears a panel drag — and a second copy would be a second
 * place to have to find that out.
 */

const columnFor = (columns: ColumnMeta[] | undefined, name: string) =>
	columns?.find((c) => c.name === name);

/**
 * A value as a number, or zero.
 *
 * Unlike the cartesian charts there is no gap/zero choice here: a pie has no
 * axis to leave a hole in, so a null contributes nothing to the whole — which
 * is a zero-sized slice. The sign is preserved so the refusal below can see it.
 */
const toNumber = (v: ScalarValue): number => {
	if (v === null || v === undefined || v === '') return 0;
	const n = Number(v);
	return Number.isFinite(n) ? n : 0;
};

const chartStyle = { width: '100%', height: '100%' } as const;

const legendConfig = (legend: PieProps['legend'], show: boolean) => {
	if (legend === false || (!show && legend === undefined)) return { show: false };
	/* Top, matching the cartesian charts — a page where one chart's legend is
	 * above and another's below reads as two designs. */
	const position = legend === true || legend === undefined ? 'top' : legend;
	return {
		show: true,
		[position === 'right' ? 'right' : position]: position === 'right' ? 0 : 0,
		orient: position === 'right' ? ('vertical' as const) : ('horizontal' as const),
		icon: 'roundRect',
		itemWidth: 10,
		itemHeight: 10,
		textStyle: { color: RESOLVED.muted, fontSize: CHART.legend },
	};
};

/** Space between the legend and the pie, in px. */
const LEGEND_GAP = { sm: 8, md: 16, lg: 28 } as const;
/** Room the legend itself takes: one line when horizontal. */
const LEGEND_LINE = 22;

export interface PieProps {
	data: Rows;
	columns?: ColumnMeta[];
	/** Column holding the slice names. */
	category: string;
	/** Column holding the measure. One, not a series list — that is what a pie is. */
	value: string;
	donut?: boolean;
	maxCategories?: number;
	otherLabel?: string;
	showValues?: boolean;
	legend?: boolean | 'top' | 'right' | 'bottom';
	legendGap?: keyof typeof LEGEND_GAP;
	/** Fixed height in px. Without it the pie takes the room left in its panel. */
	height?: number;
	truncated?: boolean;
	empty?: React.ReactNode;
}

interface Slice {
	name: string;
	value: number;
}

/**
 * Largest first, with the tail collapsed.
 *
 * Sorted before bucketing, unlike the cartesian version, which buckets in the
 * order the resolver returned. A pie has no axis to carry an order, so "the
 * order the query happened to produce" is not information — and bucketing an
 * unsorted list would put arbitrary rows in "Other" rather than the small ones.
 */
function slices(
	rows: Rows,
	category: string,
	value: string,
	max: number,
	otherLabel: string,
): { slices: Slice[]; bucketed: number; negatives: number } {
	const all: Slice[] = [];
	let negatives = 0;

	for (const row of rows) {
		const n = toNumber(row[value]);
		if (n < 0) negatives++;
		all.push({ name: String(row[category] ?? '—'), value: n });
	}

	if (negatives) return { slices: [], bucketed: 0, negatives };

	all.sort((a, b) => b.value - a.value);
	if (all.length <= max) return { slices: all, bucketed: 0, negatives: 0 };

	const head = all.slice(0, max - 1);
	const tail = all.slice(max - 1);
	return {
		slices: [...head, { name: otherLabel, value: tail.reduce((sum, s) => sum + s.value, 0) }],
		bucketed: tail.length,
		negatives: 0,
	};
}

export const PieChart = ({
	data,
	columns,
	category,
	value,
	donut = false,
	maxCategories = 6,
	otherLabel = 'Other',
	showValues = false,
	legend,
	legendGap,
	height,
	truncated,
	empty,
}: PieProps) => {
	const measure = columnFor(columns, value);
	const dimension = columnFor(columns, category);

	const { slices: parts, bucketed, negatives } = useMemo(
		() => slices(data, category, value, maxCategories, otherLabel),
		[data, category, value, maxCategories, otherLabel],
	);

	const total = useMemo(() => parts.reduce((sum, s) => sum + s.value, 0), [parts]);

	const option = useMemo(() => {
		const format = measure?.format;

		/* With a legendGap the pie is laid out in the box the legend leaves, so the gap is exact. */
		const at = legend === false ? null : legend === true || legend === undefined ? 'top' : legend;
		const longest = Math.min(Math.max(...parts.map((s) => s.name.length), 1), 22);
		const gap = legendGap ? LEGEND_GAP[legendGap] : 0;
		const outer = showValues ? 65 : 88;
		const placement = !legendGap
			? { radius: donut ? ['52%', '76%'] : '74%', center: ['50%', '46%'] }
			: {
					...(at === 'top' ? { top: LEGEND_LINE + gap }
						: at === 'bottom' ? { bottom: LEGEND_LINE + gap }
						: at === 'right' ? { right: longest * 7 + 22 + gap }
						: {}),
					radius: donut ? [`${Math.round(outer * 0.66)}%`, `${outer}%`] : `${outer}%`,
					center: ['50%', '50%'],
				};

		return {
			animation: false,
			backgroundColor: 'transparent',
			legend: legendGap && at === 'right' ? { ...legendConfig(legend, true), top: 'middle' } : legendConfig(legend, true),
			tooltip: {
				trigger: 'item' as const,
				/**
				 * Rendered into <body>, not into the chart.
				 *
				 * A panel clips — deliberately, so a table cannot push its own box
				 * open — and a tooltip drawn inside the chart is clipped with
				 * everything else. On two panels side by side that means the tooltip
				 * is cut off at exactly the edge you are hovering near, which is
				 * where it is most needed.
				 *
				 * Appending to the body takes it out of the panel's stacking context
				 * and its overflow both, so no panel needs to stop clipping. The
				 * z-index then has to clear the whole dashboard; a tooltip only
				 * exists while the cursor is over a chart, so sitting above
				 * everything costs nothing.
				 */
				appendTo: 'body' as const,
				extraCssText: 'z-index: 999999; pointer-events: none;',
				backgroundColor: RESOLVED.surface,
				borderColor: RESOLVED.line,
				textStyle: { color: RESOLVED.fg, fontSize: CHART.label },
				formatter: (p: any) => {
					const share = total > 0 ? `${((p.value / total) * 100).toFixed(1)}%` : '—';
					const label = measure ? columnLabel(measure) : value;
					return `${p.name}<br/>${label}: <b>${formatValue(p.value, format)}</b><br/>${share} of shown`;
				},
			},
			series: [
				{
					type: 'pie' as const,
					/* A donut leaves the middle empty on purpose: nothing is written
					 * there. A centred total would be the sum of what is *shown*, which
					 * is the exact number that is wrong when a tail was dropped. */
					...placement,
					avoidLabelOverlap: true,
					/* Ordered largest-first already; ECharts must not re-sort. */
					sort: 'none' as const,
					itemStyle: {
						borderColor: RESOLVED.surface,
						borderWidth: 2,
					},
					label: showValues
						? {
								show: true,
								position: 'outside' as const,
								fontSize: CHART.label,
								color: RESOLVED.muted,
								formatter: (p: any) => `${p.name}  ${p.percent}%`,
							}
						: { show: false },
					labelLine: { show: showValues, length: 8, length2: 8 },
					emphasis: { scale: true, scaleSize: 4 },
					data: parts.map((s, i) => ({
						name: s.name,
						value: s.value,
						itemStyle: { color: seriesColor(i) },
					})),
				},
			],
		};
	}, [parts, total, donut, showValues, legend, legendGap, measure, value]);

	const [chart, setChart] = useState<{ resize: () => void } | null>(null);
	const resizeBox = useChartResize(chart);

	if (!data.length) return <>{empty ?? <EmptyState title="No data" />}</>;

	/**
	 * The refusal. See the file header.
	 *
	 * Named rather than generic: "3 of these values are negative" is what tells
	 * whoever sees it that the data is fine and the chart is wrong for it.
	 */
	if (negatives) {
		return (
			<EmptyState
				title="A pie cannot show negative values"
				hint={
					`${negatives} of these ${dimension ? columnLabel(dimension).toLowerCase() : category} ` +
					`values are negative. Slices are drawn by magnitude, so a negative would appear as a ` +
					`large wedge and every percentage would be wrong. Use BarChart, which shows both signs.`
				}
			/>
		);
	}

	if (total <= 0) {
		return (
			<EmptyState
				title="Nothing to divide"
				hint="Every value is zero, so there is no whole to show parts of."
			/>
		);
	}

	const notes = [
		bucketed > 0 ? `${bucketed} smaller categories grouped as "${otherLabel}"` : null,
		truncated
			? 'Result was capped — slices are missing and these percentages are of what is shown, not of the total'
			: null,
	].filter(Boolean);

	return (
		<Frame note={notes.length ? notes.join(' · ') : undefined} height={height}>
			<div ref={resizeBox} style={chartStyle}>
				<ReactECharts
					option={option}
					style={chartStyle}
					notMerge
					lazyUpdate
					opts={{ renderer: 'svg' }}
					onChartReady={setChart}
				/>
			</div>
		</Frame>
	);
};

PieChart.Metadata = {
	kind: 'display',
	purpose: 'Parts of one whole — share of a total across a few categories.',
	useWhen:
		'One measure split into at most a handful of positive parts that genuinely sum to something ' +
		'meaningful, and the share matters more than the amount. For comparing magnitudes, or for ' +
		'anything with more than about eight categories, use BarChart instead — angle is much harder ' +
		'to compare than length.',
	props: {
		data: { description: 'The resolver rows.', importance: 'required' },
		category: {
			description: 'Column holding the slice names.',
			importance: 'required',
		},
		value: {
			description: 'Column holding the measure. One column, not a series list.',
			importance: 'required',
			caution:
				'A pie shows ONE measure. There is no `series` prop here and no second axis — if you ' +
				'have two measures to compare, that is a BarChart.',
		},
		columns: {
			description: 'Pass state.columns so the tooltip formats by the column’s real type.',
			importance: 'recommended',
			caution: 'Without it a currency renders as a bare number in the tooltip.',
		},
		donut: {
			description: 'Draw it as a ring rather than a filled circle.',
			default: false,
			caution:
				'The middle stays empty on purpose. Nothing is written there — a centred total would ' +
				'be the sum of what is shown, which is the number that is wrong whenever a tail was ' +
				'dropped or the result was capped.',
		},
		maxCategories: {
			description: 'Slices beyond this collapse into one "Other". Ranked largest first.',
			default: 6,
			caution:
				'Lower than the bar charts’ cap for a reason: thin wedges stop being distinguishable ' +
				'well before a legend runs out. Past about eight categories, use BarChart.',
		},
		otherLabel: { description: 'Name for the collapsed tail.', default: 'Other' },
		showValues: {
			description: 'Label each slice with its name and percentage.',
			default: false,
			caution:
				'Outside labels need room. On a panel narrower than about six columns they overlap; ' +
				'leave this off and let the legend and the tooltip carry the names.',
		},
		legend: {
			description: 'false | true | "top" | "right" | "bottom".',
			default: 'top',
		},
		legendGap: {
			description: '"sm" | "md" | "lg" — space between the legend and the pie. Setting it also draws the pie larger.',
		},
		height: {
			description: 'Least chart height in px; it still grows with the panel.',
			caution: 'Omit it and the pie fills the room left in its panel. Set it to give the pie a floor.',
		},
		truncated: {
			description: 'Pass state.meta?.truncated.',
			importance: 'recommended',
			caution:
				'It matters more here than on any other chart. A pie asserts the slices are all of ' +
				'something; if rows were capped that assertion is false and every percentage is ' +
				'computed over a subset. Passing it is what puts that in writing under the chart.',
		},
		empty: { description: 'What to render when there are no rows.' },
	},
	notes:
		'IMPORTANT: this refuses to draw when any value is negative, and explains why instead. ' +
		'Slices are sized by magnitude, so a negative value would render as a large wedge and every ' +
		'percentage would be wrong. Eliminations, adjustments, credits, refunds and variances are ' +
		'routinely negative — check the sign of your measure before choosing a pie, and reach for ' +
		'BarChart when both signs are possible. Values are ranked largest first automatically; the ' +
		'order your query returns them in is not used.',
} satisfies ContractMeta;

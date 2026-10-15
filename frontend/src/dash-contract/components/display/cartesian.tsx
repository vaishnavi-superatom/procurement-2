/**
 * Charts and the table — ECharts for the drawing, our own tokens for the look.
 *
 * The capabilities here are the ones the catalogue marked P0/P1 and that a real
 * dashboard collapses without. Each is a prop rather than a variant component,
 * because a generated program should compose one chart with options, not pick
 * between fifteen near-identical exports.
 *
 * Three rules run through all of them:
 *
 *  - **Null is not zero.** A missing value is drawn as a gap and formatted as
 *    "—". Coercing it to 0 draws a line through a hole and asserts something
 *    nobody measured.
 *  - **Formatting comes from the column.** A currency is a currency on an axis
 *    tick, in a tooltip, in a label and in a table cell — otherwise the chart
 *    disagrees with the KPI beside it.
 *  - **Truncation is visible.** A chart drawn from the first N of many says so.
 *    Silence here is the most expensive kind of wrong.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ContractMeta } from '../../meta';
import ReactECharts from 'echarts-for-react';
import { EmptyState } from '../status';
import { alignFor, columnLabel, formatCompact, formatNumber, formatValue } from '../../format';
import { CATEGORICAL, CHART, RESOLVED, SENTIMENT, T, seriesColor } from '../../theme';
import type { ColumnMeta, Rows, ScalarValue, ValueFormat } from '../../types';
import { itemStyle } from '../layout/flow';

/* ---------------------------------- specs ---------------------------------- */

export interface SeriesSpec {
	/** Column holding the measure. */
	key: string;
	label?: string;
	color?: string;
	/** Overriding the mark per series is what makes a combo chart. */
	as?: 'bar' | 'line' | 'area';
	/** Second axis, for a measure on an incompatible scale. */
	axis?: 'left' | 'right';
	/**
	 * What a gap means. A semantic choice, not a cosmetic one:
	 * `zero` claims the value was zero, `gap` that it is unknown.
	 */
	missing?: 'gap' | 'zero';
	showValues?: boolean;
}

export interface AxisSpec {
	title?: string;
	min?: number;
	max?: number;
	/** Bar charts truncated above zero mislead; on by default for bars. */
	zeroBased?: boolean;
	format?: ValueFormat;
	labels?: boolean;
}

/** A line drawn across the plot for context. */
export interface ReferenceLine {
	kind: 'constant' | 'average' | 'median' | 'max' | 'min';
	value?: number;
	label?: string;
	color?: string;
}

export interface TooltipConfig {
	/** Columns to show beyond the dimension and the measures. */
	extraColumns?: string[];
	mode?: 'point' | 'unified';
}

export interface ChartProps {
	data: Rows;
	columns?: ColumnMeta[];
	x: string;
	series: SeriesSpec[];
	empty?: React.ReactNode;
	legend?: boolean | 'top' | 'right' | 'bottom';
	xAxis?: AxisSpec;
	yAxis?: AxisSpec;
	y2Axis?: AxisSpec;
	referenceLines?: ReferenceLine[];
	tooltip?: TooltipConfig;
	/**
	 * Categories beyond this collapse into one "Other" bar.
	 *
	 * Past ~12 a reader is matching swatches to a legend rather than reading a
	 * chart, and silently dropping the tail is worse than naming it.
	 */
	maxCategories?: number;
	otherLabel?: string;
	/** Set from `meta.truncated` so a capped result is visible, not implied. */
	truncated?: boolean;
	/**
	 * Rows before the cap, from `state.meta?.totalRows`.
	 *
	 * Turns "the result was capped" into a count of what was left out. Pass it
	 * beside `truncated` — one says a cap happened, the other says how big it was.
	 */
	totalRows?: number;
	/** Fixed height in px. Without it the chart takes the room left in its panel. */
	height?: number;
	onSelect?: (point: { category: ScalarValue; series: string; value: ScalarValue; row: Rows[number] }) => void;
}

/* --------------------------------- helpers --------------------------------- */

const columnFor = (columns: ColumnMeta[] | undefined, name: string) =>
	columns?.find((c) => c.name === name);

/** Preserves null rather than coercing it — see the file header. */
const numeric = (v: ScalarValue, missing: SeriesSpec['missing'] = 'gap'): number | null => {
	if (v === null || v === undefined || v === '') return missing === 'zero' ? 0 : null;
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
};

const chartStyle = { width: '100%', height: '100%' } as const;

const legendConfig = (legend: ChartProps['legend'], show: boolean) => {
	if (legend === false || (!show && legend === undefined)) return { show: false };
	/* Top by default: the bottom is where the category axis, its title and the
	 * zoom slider all compete, and a legend read after the chart is a legend
	 * read twice. */
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

function markLines(refs: ReferenceLine[] | undefined, values: number[]) {
	if (!refs?.length) return undefined;
	const clean = values.filter((v): v is number => v !== null && Number.isFinite(v));
	const stat = (kind: ReferenceLine['kind']): number | undefined => {
		if (!clean.length) return undefined;
		const sorted = [...clean].sort((a, b) => a - b);
		switch (kind) {
			case 'average':
				return clean.reduce((a, b) => a + b, 0) / clean.length;
			case 'median':
				return sorted[Math.floor(sorted.length / 2)];
			case 'max':
				return sorted[sorted.length - 1];
			case 'min':
				return sorted[0];
			default:
				return undefined;
		}
	};

	return {
		silent: true,
		symbol: 'none',
		label: { color: RESOLVED.muted, fontSize: CHART.label, position: 'insideEndTop' as const },
		lineStyle: { type: 'dashed' as const, width: 1 },
		data: refs
			.map((r) => {
				const value = r.kind === 'constant' ? r.value : stat(r.kind);
				if (value === undefined || value === null) return null;
				return {
					yAxis: value,
					label: { formatter: r.label ?? `${r.kind} ${formatCompact(value)}` },
					lineStyle: { color: r.color ?? RESOLVED.faint },
				};
			})
			.filter(Boolean),
	};
}

/** Collapses the tail into one "Other" row rather than dropping it. */
function bucketOther(
	rows: Rows,
	x: string,
	series: SeriesSpec[],
	max: number | undefined,
	label: string,
): { rows: Rows; bucketed: number } {
	if (!max || rows.length <= max) return { rows, bucketed: 0 };
	const head = rows.slice(0, max - 1);
	const tail = rows.slice(max - 1);
	const other: Record<string, ScalarValue> = { [x]: label };
	for (const s of series) {
		other[s.key] = tail.reduce((sum, r) => sum + (numeric(r[s.key], 'zero') ?? 0), 0);
	}
	return { rows: [...head, other], bucketed: tail.length };
}

/** A small note under a chart. Never a silent omission. */
const Note = ({ children }: { children: React.ReactNode }) => (
	<div style={{ fontSize: CHART.note, color: T.faint, marginTop: 6, flex: '0 0 auto' }}>{children}</div>
);

/** The least a chart shrinks to without a fixed `height`. */
const CHART_MIN_HEIGHT = 120;

export const Frame = ({ note, height, children }: { note?: React.ReactNode; height?: number; children: React.ReactNode }) => (
	<div
		style={{
			...itemStyle({ grow: true, height, minHeight: CHART_MIN_HEIGHT }),
			display: 'flex',
			flexDirection: 'column',
			overflow: 'hidden',
		}}
	>
		<div style={{ flex: '1 1 auto', minHeight: 0, minWidth: 0 }}>{children}</div>
		{note ? <Note>{note}</Note> : null}
	</div>
);

/**
 * Resizes the chart when its **panel** changes size, not when the window does.
 *
 * `echarts-for-react` listens on `window`, and dragging a panel's corner never
 * fires that. So the canvas kept the size it was first laid out at: shrink a
 * panel and a full-size chart sat inside a smaller box, which is where the
 * scrollbars came from — the panel had something too big in it and said so.
 * Growing a panel was the same fault the other way, with the chart marooned in
 * one corner.
 *
 * A `ResizeObserver` on the wrapper is the direct answer: it fires for a drag, a
 * split-pane move, a sidebar opening, and a window resize alike, because all of
 * them are the same event as far as this element is concerned.
 *
 * Exported because `pie.tsx` uses it too. It is the one thing the two charts
 * genuinely share: a second copy would be a second place to rediscover that
 * `echarts-for-react` never hears a panel drag.
 */
export function useChartResize(instance: { resize: () => void } | null) {
	const box = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const el = box.current;
		if (!el || !instance || typeof ResizeObserver === 'undefined') return;

		/* Coalesced to a frame: a drag emits a burst of entries, and resizing the
		 * chart on each one re-lays out the whole option for sizes nobody sees. */
		let queued = 0;
		const observer = new ResizeObserver(() => {
			cancelAnimationFrame(queued);
			queued = requestAnimationFrame(() => instance.resize());
		});
		observer.observe(el);
		return () => {
			cancelAnimationFrame(queued);
			observer.disconnect();
		};
	}, [instance]);

	return box;
}

/**
 * Axis chrome, including a **title that is actually placed**.
 *
 * `name` alone was not enough. ECharts defaults `nameLocation` to `'end'`, which
 * drops the title on top of the last tick label — so an axis title looked like a
 * rendering fault rather than a label. Centred with a gap that clears the ticks
 * is the only arrangement that reads, and the gap has to differ per axis because
 * a vertical title sits beside numbers and a horizontal one sits beneath
 * categories.
 */
const axisCommon = (spec: AxisSpec | undefined, vertical: boolean) => ({
	axisLabel: { color: RESOLVED.muted, fontSize: CHART.label, show: spec?.labels !== false },
	axisLine: { lineStyle: { color: RESOLVED.line } },
	axisTick: { show: false },
	name: spec?.title,
	nameLocation: 'middle' as const,
	/* Clears the tick labels: wider on the value axis, where the ticks are
	 * numbers that may be several characters long. */
	nameGap: spec?.title ? (vertical ? 52 : 34) : 0,
	nameTextStyle: {
		color: RESOLVED.muted,
		fontSize: CHART.axisTitle,
		fontWeight: 500 as const,
	},
});

/** Widest label, in characters, capped where the formatter truncates. */
/** Categories beyond this get a zoom slider rather than being squeezed. */
const ZOOM_FROM = 15;
const ZOOM_BAR = 14;

const LABEL_CAP = 22;
const CHAR_WIDTH = 7;

/**
 * Category tick labels that survive a narrow panel.
 *
 * Straight labels collide the moment there are more than a handful or any of
 * them is a real business name, and ECharts' default answer — dropping every
 * other one — is worse than tilting, because a chart silently missing half its
 * categories looks complete. So: tilt to 45° once they are crowded, truncate
 * past `LABEL_CAP` (the tooltip still carries the full value), and `interval: 0`
 * to insist that every category is drawn.
 *
 * The same arithmetic `DynamicBarChart` uses, for the same reason — these are
 * the two chart implementations in this repo and a reader should not be able to
 * tell which one drew a given panel.
 */
function categoryLabels(labels: string[], vertical: boolean) {
	const longest = Math.min(Math.max(...labels.map((l) => l.length), 1), LABEL_CAP);
	const tilt = vertical && (labels.length > 6 || (longest > 12 && labels.length > 3));
	return {
		tilt,
		/** How much room the tick labels need below the plot. */
		height: tilt ? Math.round(longest * CHAR_WIDTH * Math.SQRT1_2) : 16,
		/** How much room they need beside it, when the categories run down the side. */
		width: longest * CHAR_WIDTH,
		axisLabel: {
			color: RESOLVED.muted,
			fontSize: CHART.label,
			rotate: tilt ? 45 : 0,
			interval: 0 as const,
			hideOverlap: false,
			formatter: (v: string) =>
				String(v).length > LABEL_CAP ? `${String(v).slice(0, LABEL_CAP)}…` : String(v),
		},
	};
}

/**
 * A value axis, with its title rotated down the side and placed **outside** the
 * tick labels.
 *
 * `nameGap` is the whole difficulty. It is measured from the axis line, not from
 * the labels, so a fixed value puts the title on top of the numbers as soon as
 * the numbers get wider — "1.2M" and "1,284,556" need very different clearance,
 * and the same chart can go from one to the other just by changing a filter. So
 * the widest tick label is measured first and the gap is derived from it.
 *
 * `tickWidth` is that measurement, in pixels, from the formatted values.
 */
const valueAxis = (
	spec: AxisSpec | undefined,
	zeroDefault: boolean,
	vertical = true,
	tickWidth = 0,
) => ({
	type: 'value' as const,
	...axisCommon(spec, vertical),
	min: spec?.min ?? (spec?.zeroBased ?? zeroDefault ? 0 : undefined),
	max: spec?.max,
	...(vertical && spec?.title
		? {
				nameLocation: 'middle' as const,
				/* 90° reads bottom-to-top, the convention for a left-hand axis. */
				nameRotate: 90,
				nameGap: tickWidth + 16,
			}
		: null),
	axisLabel: {
		...axisCommon(spec, vertical).axisLabel,
		formatter: (v: number) => formatValue(v, { ...spec?.format, compact: true }),
	},
	/* Lighter than the panel border — see RESOLVED.gridLine. */
	splitLine: { lineStyle: { color: RESOLVED.gridLine } },
});

/* --------------------------------- cartesian -------------------------------- */

function CartesianChart({
	kind,
	data,
	columns,
	x,
	series,
	empty,
	legend,
	xAxis,
	yAxis,
	y2Axis,
	referenceLines,
	tooltip,
	maxCategories,
	otherLabel = 'Other',
	truncated,
	totalRows,
	height,
	onSelect,
	stacked,
	orientation = 'vertical',
}: ChartProps & {
	kind: 'bar' | 'line';
	stacked?: boolean | 'normalized';
	orientation?: 'vertical' | 'horizontal';
}) {
	const primary = columnFor(columns, series[0]?.key ?? '');
	const format = yAxis?.format ?? primary?.format;

	const { rows, bucketed } = useMemo(
		() => bucketOther(data, x, series, maxCategories, otherLabel),
		[data, x, series, maxCategories, otherLabel],
	);

	/**
	 * The rows in the order they are actually drawn.
	 *
	 * Horizontal bars read bottom-up in ECharts, so reversing puts the largest
	 * value at the top, where the eye starts.
	 *
	 * Lifted out of the option builder because a click gives back a `dataIndex`
	 * into *this* array, and mapping that index to a row against the unreversed
	 * list would select the wrong category on every horizontal chart — silently,
	 * and symmetrically enough that it looks right on the middle bar.
	 */
	const ordered = useMemo(
		() => (orientation === 'horizontal' ? [...rows].reverse() : rows),
		[rows, orientation],
	);

	const option = useMemo(() => {
		const categories = ordered.map((r) => String(r[x] ?? '—'));
		const hasRight = series.some((s) => s.axis === 'right');

		/* Which axis is which depends on orientation: with horizontal bars the
		 * categories run up the side and the measure runs along the bottom. The
		 * title gap has to follow that, not the prop name. */
		const categoryIsVertical = orientation === 'horizontal';

		const ticks = categoryLabels(categories, !categoryIsVertical);

		const category = {
			type: 'category' as const,
			data: categories,
			boundaryGap: kind === 'bar',
			...axisCommon(xAxis, categoryIsVertical),
			/* After the spread: the tilt and truncation replace the plain labels. */
			axisLabel: xAxis?.labels === false ? { show: false } : ticks.axisLabel,
			/* Clear the tilted labels, which are taller than a single line. */
			nameGap: xAxis?.title ? (categoryIsVertical ? ticks.width + 18 : ticks.height + 18) : 0,
		};

		const allValues = series.flatMap((s) =>
			ordered.map((r) => numeric(r[s.key], s.missing)).filter((v): v is number => v !== null),
		);

		/**
		 * How wide the value-axis tick labels will be, so a rotated axis title can
		 * be placed beyond them.
		 *
		 * Measured from the extremes of the real data, formatted exactly as the
		 * axis will format them — the same `formatValue(..., compact)` call the
		 * `axisLabel.formatter` makes. ECharts picks its own tick values, so this
		 * is an estimate, but it is an estimate of the right thing: the longest
		 * label is almost always at one end of the range.
		 */
		const tickWidth = (spec: AxisSpec | undefined) => {
			if (!spec?.title || !allValues.length) return 0;
			const ends = [Math.min(...allValues), Math.max(...allValues)];
			const longest = Math.max(
				...ends.map((v) => formatValue(v, { ...spec.format, compact: true }).length),
				1,
			);
			return longest * CHAR_WIDTH;
		};

		const left = valueAxis(yAxis, kind === 'bar', !categoryIsVertical, tickWidth(yAxis));
		const right = hasRight
			? valueAxis(y2Axis, false, !categoryIsVertical, tickWidth(y2Axis))
			: undefined;

		/**
		 * Past ~15 categories a chart is scrolled, not read at once.
		 *
		 * Capping is the wrong answer for a time axis — eighty months is not a tail
		 * to collapse into "Other", it is a range to move through. Same threshold
		 * and the same pair (drag-to-pan plus a slider) as `DynamicBarChart`.
		 */
		/* Where the legend ends up, or null when there is none — the grid has to
		 * reserve room at that end and nowhere else. Mirrors `legendConfig`. */
		const legendShown = legend !== false && (series.length > 1 || legend !== undefined);
		const legendAt = legendShown
			? legend === true || legend === undefined
				? 'top'
				: legend
			: null;

		const zoomed = categories.length > ZOOM_FROM;
		const zoomAxis = categoryIsVertical ? 'yAxisIndex' : 'xAxisIndex';
		/* Opens on the first 15, in the order the resolver returned them. */
		const zoomWindow = { start: 0, end: Math.min(100, (ZOOM_FROM / categories.length) * 100) };

		return {
			color: CATEGORICAL as unknown as string[],
			/* Both entries carry the same window. The `inside` one defaults to the
			 * full range if left without it, and two zooms on one axis leave the
			 * unbounded one in charge — which showed every bar. */
			dataZoom: zoomed
				? [
						{ type: 'inside' as const, [zoomAxis]: 0, ...zoomWindow },
						{
							type: 'slider' as const,
							[zoomAxis]: 0,
							...zoomWindow,
							...(categoryIsVertical
								? { width: ZOOM_BAR, right: 4 }
								: { height: ZOOM_BAR, bottom: 4 }),
							borderColor: 'transparent',
							/* Resolved hex, not a CSS var — ECharts computes the slider's
							 * own colours from these. */
							backgroundColor: '#f6f7f9',
							fillerColor: '#4A7FFF22',
							handleStyle: { color: RESOLVED.line },
							moveHandleStyle: { color: RESOLVED.line },
							textStyle: { color: RESOLVED.muted, fontSize: 10 },
							showDetail: false,
						},
					]
				: undefined,
			/**
			 * `containLabel` reserves room for tick labels but **not** for axis
			 * titles, so a chart with either one drew its title into the panel edge.
			 * The extra is added only when a title exists — padding a chart that has
			 * none would waste the space these panels are shortest of.
			 */
			grid: {
				/* Room for whichever axis title runs down the left side, rotated —
				 * the categories when the bars are horizontal, the values otherwise.
				 * `containLabel` covers the tick labels but never the title. */
				left: 8 + ((categoryIsVertical ? xAxis?.title : yAxis?.title) ? 24 : 0),
				/* The slider sits outside the plot, so the grid has to give it room —
				 * on the right for horizontal bars, along the bottom otherwise. */
				right: (hasRight ? 8 : 16) + (zoomed && categoryIsVertical ? ZOOM_BAR + 6 : 0),
				/* The legend takes its room from whichever end it sits at. */
				top: 16 + (legendAt === 'top' ? 20 : 0),
				bottom:
					8 +
					(legendAt === 'bottom' ? 16 : 0) +
					(categoryIsVertical ? (yAxis?.title ? 26 : 0) : xAxis?.title ? 26 : 0) +
					(zoomed && !categoryIsVertical ? ZOOM_BAR + 6 : 0),
				containLabel: true,
			},
			textStyle: { fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif' },
			tooltip: {
				trigger: 'axis' as const,
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
				axisPointer: { type: kind === 'bar' ? ('shadow' as const) : ('line' as const) },
				backgroundColor: RESOLVED.surface,
				borderColor: RESOLVED.line,
				textStyle: { color: RESOLVED.fg, fontSize: CHART.legend },
				formatter: (params: any[]) => {
					if (!Array.isArray(params) || !params.length) return '';
					const row = ordered[params[0].dataIndex];
					const head = `<div style="font-weight:600;margin-bottom:4px">${params[0].axisValueLabel}</div>`;
					const lines = params.map((p) => {
						const s = series.find((ser) => (ser.label ?? ser.key) === p.seriesName);
						const col = columnFor(columns, s?.key ?? '');
						return `<div>${p.marker} ${p.seriesName}: <b>${formatValue(p.value, col?.format ?? format)}</b></div>`;
					});
					const extras = (tooltip?.extraColumns ?? []).map((name) => {
						const col = columnFor(columns, name);
						return `<div style="color:${RESOLVED.muted}">${col ? columnLabel(col) : name}: ${formatValue(row?.[name], col)}</div>`;
					});
					return head + lines.join('') + extras.join('');
				},
			},
			legend: legendConfig(legend, series.length > 1),
			xAxis: orientation === 'horizontal' ? left : category,
			yAxis:
				orientation === 'horizontal'
					? category
					: right
						? [left, right]
						: left,
			series: series.map((s, i) => {
				const mark = s.as ?? kind;
				return {
					name: s.label ?? columnLabel(columnFor(columns, s.key) ?? { name: s.key, dataType: 'number' }),
					type: mark === 'area' ? ('line' as const) : (mark as 'bar' | 'line'),
					yAxisIndex: right && s.axis === 'right' ? 1 : 0,
					stack: stacked ? 'total' : undefined,
					...(stacked === 'normalized' ? { stackStrategy: 'all' as const } : {}),
					areaStyle: mark === 'area' ? { opacity: 0.12 } : undefined,
					smooth: false,
					symbol: 'circle',
					symbolSize: 5,
					showSymbol: ordered.length <= 40,
					barMaxWidth: 24,
					itemStyle: {
						color: seriesColor(i, s.color),
						/**
						 * Rounded at the growing end only.
						 *
						 * A single number rounds all four corners, which lifted every bar
						 * off its own baseline — the axis is a straight line and a bar
						 * that curves away from it reads as floating. The far end is
						 * where rounding belongs, and which end that is follows the
						 * orientation: the top for vertical bars, the right for
						 * horizontal ones.
						 *
						 * In a stack only the last series gets it. Rounding each segment
						 * would put a curve at every internal join, and a stack is meant
						 * to read as one bar divided, not as several bars touching.
						 */
						borderRadius:
							mark !== 'bar' || (stacked && i !== series.length - 1)
								? 0
								: orientation === 'horizontal'
									? [0, 3, 3, 0]
									: [3, 3, 0, 0],
					},
					lineStyle: { width: 2 },
					label: s.showValues
						? {
								show: true,
								position: orientation === 'horizontal' ? ('right' as const) : ('top' as const),
								fontSize: 10,
								color: RESOLVED.muted,
								formatter: (p: any) => formatValue(p.value, columnFor(columns, s.key)?.format ?? format),
							}
						: undefined,
					/** A gap in the data is drawn as a gap; joining invents a trend. */
					connectNulls: false,
					markLine: i === 0 ? markLines(referenceLines, allValues) : undefined,
					data: ordered.map((r) => numeric(r[s.key], s.missing)),
				};
			}),
		};
	}, [ordered, rows, columns, x, series, kind, orientation, stacked, legend, xAxis, yAxis, y2Axis, referenceLines, tooltip, format]);

	/**
	 * A click on a mark, as the row behind it.
	 *
	 * The whole point is that a chart and a filter are the same mechanism: the
	 * handler is handed the row, so a view sets a `useParam` from it and every
	 * panel bound to that parameter follows. Nothing here knows about filters.
	 *
	 * The "Other" bucket is deliberately inert. Its category is the label this
	 * component invented for the tail, not a value in anyone's data, so filtering
	 * on it would return no rows — an empty dashboard that looks like a real
	 * answer. A reader who wants the tail needs a bigger `maxCategories`, not a
	 * filter set to a word we made up.
	 */
	const onEvents = useMemo(() => {
		if (!onSelect) return undefined;
		return {
			click: (params: { dataIndex?: number; seriesIndex?: number }) => {
				const row = ordered[params.dataIndex ?? -1];
				if (!row) return;
				if (bucketed > 0 && String(row[x] ?? '') === otherLabel) return;
				const spec = series[params.seriesIndex ?? 0] ?? series[0];
				if (!spec) return;
				onSelect({
					category: row[x] ?? null,
					series: spec.key,
					value: row[spec.key] ?? null,
					row,
				});
			},
		};
	}, [onSelect, ordered, series, x, bucketed, otherLabel]);

	/* Held in state rather than a ref so the observer effect re-runs once the
	 * instance exists — a ref assignment would not wake it. */
	const [chart, setChart] = useState<{ resize: () => void } | null>(null);
	const resizeBox = useChartResize(chart);

	if (!series.length) return <EmptyState title="No series configured" />;
	if (!data.length) return <>{empty ?? <EmptyState title="No data" />}</>;

	const notes = [
		bucketed > 0 ? `${bucketed} smaller categories grouped as "${otherLabel}"` : null,
		/* A caveat with no magnitude is read as boilerplate — say how many, the way
		 * DataTable's footer already does. */
		truncated && totalRows && totalRows > rows.length
			? `Showing ${formatNumber(rows.length)} of ${formatNumber(totalRows)}`
			: truncated
				? 'Result was capped — some rows are not shown'
				: null,
	].filter(Boolean);

	return (
		<Frame note={notes.length ? notes.join(' · ') : undefined} height={height}>
			<div
				ref={resizeBox}
				/* The cursor is the only thing saying a chart is clickable, and it
				 * appears only when something is actually listening — a pointer over
				 * an inert chart promises an interaction that does not exist. */
				style={onSelect ? { ...chartStyle, cursor: 'pointer' } : chartStyle}
			>
				<ReactECharts
					option={option}
					style={chartStyle}
					notMerge
					lazyUpdate
					opts={{ renderer: 'svg' }}
					onChartReady={setChart}
					onEvents={onEvents}
				/>
			</div>
		</Frame>
	);
}

/**
 * Bars. Horizontal by default.
 *
 * Category labels are business names of unpredictable length; vertical bars
 * rotate them to 45° and stop being readable past about eight. Rows get the
 * width they need and read top to bottom like a list. Pass
 * `orientation="vertical"` when the axis is genuinely ordinal — a period, a
 * rating — rather than a set of names.
 */
export const BarChart = (
	props: ChartProps & { stacked?: boolean | 'normalized'; orientation?: 'vertical' | 'horizontal' },
) => <CartesianChart kind="bar" orientation={props.orientation ?? 'horizontal'} {...props} />;

/**
 * Everything on `ChartProps`, described once.
 *
 * The three charts are one engine with three entry points, so their props are
 * genuinely the same set — three copies would be three things to keep in step,
 * and the previous prose strings had already fallen out of step: `BarChart`
 * listed a prop that does nothing, and the other two listed six of fifteen.
 *
 * `onSelect` is described here now that the charts actually call it. It was
 * deliberately absent while it was typed and unwired — an agent told about it
 * would have built cross-filtering, watched it typecheck, and reported a
 * feature that did nothing. `PieChart` still does not take it.
 */
const CHART_PROPS = {
	data: { description: 'The resolver rows.', importance: 'required', group: 'data' },
	x: { description: 'Column for the category or time axis.', importance: 'required', group: 'data' },
	series: {
		description: 'Measures to plot. Each takes { key, label, color, as, axis, missing, showValues }.',
		importance: 'required',
		group: 'data',
	},
	columns: {
		description: 'Pass state.columns so values format by their real type.',
		importance: 'recommended',
		group: 'data',
		caution: 'Without it a currency renders as a bare number on the axis, in the tooltip and in the labels.',
	},

	xAxis: {
		description: 'Category axis: { title, labels }.',
		importance: 'recommended',
		group: 'axes',
		caution: 'An untitled axis makes the reader guess what they are looking at.',
	},
	yAxis: {
		description: 'Value axis: { title, min, max, zeroBased, format }.',
		importance: 'recommended',
		group: 'axes',
		caution:
			'zeroBased is on by default for bars because a bar chart cut above zero overstates ' +
			'differences. Do not turn it off to make a change look bigger.',
	},
	y2Axis: {
		description: 'A second value axis, for a measure on an incompatible scale.',
		group: 'axes',
		caution: 'Only read when a series sets axis: "right".',
	},

	stacked: {
		description: 'true to stack, "normalized" for 100%.',
		group: 'marks',
		caution: 'Stacking hides individual series trends — use it for composition, not comparison.',
	},
	referenceLines: {
		description: 'Context lines: { kind: "constant" | "average" | "median" | "max" | "min", value, label }.',
		group: 'marks',
	},

	legend: {
		description: 'true | "top" | "right" | "bottom" | false.',
		default: 'top',
		group: 'reading',
		caution: 'Turn it off for a single series — a legend naming one thing is noise.',
	},
	tooltip: { description: '{ extraColumns, mode: "point" | "unified" }.', group: 'reading' },
	totalRows: {
		description: 'Pass state.meta?.totalRows so the note can say how many are missing.',
		importance: 'recommended',
		group: 'reading',
		caution:
			'Without it the chart can only say "the result was capped", which reads as boilerplate. ' +
			'With it, "Showing 20 of 143" — a fact the reader can act on.',
	},
	truncated: {
		description: 'Pass state.meta?.truncated so a capped result says so.',
		importance: 'recommended',
		group: 'reading',
		caution: 'A chart drawn silently from the first N of many is the most expensive kind of wrong.',
	},
	onSelect: {
		description:
			'Called when the reader clicks a mark, with { category, series, value, row }. Set a ' +
			'useParam from it and every panel bound to that parameter follows — a chart click and a ' +
			'filter are the same mechanism.',
		group: 'reading',
		caution:
			'Clicks on the "Other" bucket do not fire: its category is a label this component ' +
			'invented, so filtering on it would return nothing and read as a real empty answer. ' +
			'PieChart does not take this prop.',
	},
	maxCategories: {
		description: 'Collapse the tail beyond this into one named bucket.',
		group: 'reading',
		caution:
			'Count the negatives first. Taking the top N by value drops the most negative rows — ' +
			'eliminations, credits, adjustments — and the remaining bars then sum to more than the ' +
			'real total.',
	},
	otherLabel: { description: 'Name for the collapsed tail.', default: 'Other', group: 'reading' },
	empty: { description: 'What to render when there are no rows.', group: 'reading' },
	height: {
		description: 'Least chart height in px; it still grows with the panel.',
		group: 'size',
		caution: 'Omit it and the chart fills the room left in its panel. Set it to give the chart a floor.',
	},
} as const;

BarChart.Metadata = {
	kind: 'display',
	purpose: 'Compare a measure across categories.',
	useWhen: 'Comparing magnitude across names. Horizontal by default so long labels stay readable.',
	props: {
		...CHART_PROPS,
		orientation: {
			description: '"horizontal" | "vertical".',
			default: 'horizontal',
			group: 'marks',
			caution:
				'Use "vertical" only when the axis is genuinely ordinal — a period, a rating. Business ' +
				'names are long, and vertical bars rotate their labels to 45° and stop being readable.',
		},
	},
	notes:
		'A series may set `as: "line"` to mix marks in one chart, and `axis: "right"` to put a ' +
		'measure on a second scale — that combination is how a combo chart is built.',
} satisfies ContractMeta;

export const LineChart = (props: ChartProps & { stacked?: boolean | 'normalized' }) => (
	<CartesianChart kind="line" {...props} />
);

LineChart.Metadata = {
	kind: 'display',
	purpose: 'A measure over an ordered axis, usually time.',
	useWhen: 'Trend and shape over an ordered sequence.',
	props: CHART_PROPS,
	notes:
		'Set each series’ `missing` deliberately: "gap" says the value is unknown, "zero" claims it ' +
		'was zero. Drawing a line straight through a hole asserts something nobody measured. ' +
		'The x column must be genuinely ordered — a line over unordered categories reads as a trend ' +
		'that is not there.',
} satisfies ContractMeta;

/* --------------------------------- table ----------------------------------- */

/** @see the conditional-formatting rule shape in the capability catalogue. */

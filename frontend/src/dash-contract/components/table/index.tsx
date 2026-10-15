/**
 * The table.
 *
 * The workhorse, and the component that carries the most capability — which is
 * why it was moved out of `charts.tsx` rather than left to grow inside it.
 *
 * Shaped against Metabase's table settings and Power BI's, from
 * `research/02-component-catalogue.md` §A4 and §B6. Their conditional-formatting
 * model is compact and complete enough to copy outright:
 *
 *  - a **single-colour** rule — columns, operator, value, colour, row highlight
 *  - a **colour-range** rule — a gradient across a numeric column's spread
 *  - an ordered list, **first match wins**
 *  - Power BI's addition: a rule may read one column and paint another
 *    ("colour by margin, show revenue")
 *
 * ### What was wrong before this
 *
 * The component's own metadata said *"Rows and columns, sortable"* and there was
 * no sorting — no state, no handler, nothing. An agent reading that would wire a
 * table expecting a reader could reorder it, and be wrong. Same class as
 * `AreaChart` being implemented and unreachable: the description and the code
 * disagreed, and only the description was ever read.
 */
import { useMemo, useState } from 'react';
import { EmptyState } from '../status';
import { alignFor, columnLabel, formatNumber, formatRaw, formatValue } from '../../format';
import { SENTIMENT, T } from '../../theme';
import type { ContractMeta } from '../../meta';
import type { ColumnMeta, Rows, ScalarValue, ValueFormat } from '../../types';
import { itemStyle, TABLE_MIN_HEIGHT } from '../layout/flow';

/* --------------------------------- rules ----------------------------------- */

export interface SingleColourRule {
	type?: 'single';
	/** Columns this rule paints. */
	columns: string[];
	/**
	 * Which column the rule *tests*, when that differs from the one it paints.
	 *
	 * Power BI's "colour by margin, show revenue". Without it a rule can only
	 * ever react to the number in front of it, which rules out most of the useful
	 * cases — flagging a row's revenue because its *margin* went negative, say.
	 */
	basedOn?: string;
	when: {
		op: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'isNull' | 'notNull';
		value?: ScalarValue;
	};
	color?: string;
	background?: string;
	/** Paints the whole row, so it can be spotted while scrolling. */
	wholeRow?: boolean;
}

export interface ColourRangeRule {
	type: 'range';
	columns: string[];
	basedOn?: string;
	/** Low to high. Two colours is a ramp; three is a diverging scale. */
	colors: string[];
	/** Defaults to the column's own minimum and maximum across the rows shown. */
	min?: number;
	max?: number;
}

export type FormatRule = SingleColourRule | ColourRangeRule;

const isRange = (r: FormatRule): r is ColourRangeRule => r.type === 'range';

/** The most rows a table shows, after sorting. The platform's number, not a prop; the footer names the rest. */
export const DISPLAY_ROWS = 10_000;

/**
 * Does one `when` clause hold for one value?
 *
 * Exported because `MatrixTable` colours cells with the same clause shape, and
 * two implementations of `gte` would eventually disagree about a null or a
 * numeric string. Not part of the agent-facing contract — it is not in
 * `DASHBOARD_COMPONENTS`, so a generated program cannot import it.
 */
export function matchesWhen(when: SingleColourRule['when'], value: ScalarValue): boolean {
	const { op, value: target } = when;
	if (op === 'isNull') return value === null || value === undefined;
	if (op === 'notNull') return value !== null && value !== undefined;
	if (value === null || value === undefined) return false;

	if (op === 'contains') return String(value).toLowerCase().includes(String(target).toLowerCase());
	if (op === 'eq') return value === target;
	if (op === 'ne') return value !== target;

	const a = Number(value);
	const b = Number(target);
	if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
	if (op === 'gt') return a > b;
	if (op === 'gte') return a >= b;
	if (op === 'lt') return a < b;
	return op === 'lte' ? a <= b : false;
}

/** Blends a value's position in a range across the given stops. */
function rampColour(value: number, min: number, max: number, colors: string[]): string | undefined {
	if (!colors.length || !Number.isFinite(value) || max === min) return colors[0];
	const t = Math.min(1, Math.max(0, (value - min) / (max - min)));
	const span = colors.length - 1;
	const i = Math.min(span - 1, Math.floor(t * span));
	const local = t * span - i;
	return mix(colors[i]!, colors[i + 1]!, local);
}

function mix(a: string, b: string, t: number): string {
	const parse = (hex: string) => {
		const h = hex.replace('#', '');
		const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
		return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
	};
	const [r1, g1, b1] = parse(a);
	const [r2, g2, b2] = parse(b);
	const to = (x: number) => Math.round(x).toString(16).padStart(2, '0');
	return `#${to(r1! + (r2! - r1!) * t)}${to(g1! + (g2! - g1!) * t)}${to(b1! + (b2! - b1!) * t)}`;
}

/* -------------------------------- columns ---------------------------------- */

export interface ColumnConfig {
	column: string;
	label?: string;
	hidden?: boolean;
	width?: number;
	format?: ValueFormat;
	/** A bar in the cell showing magnitude relative to the column's maximum. */
	miniBar?: boolean;
	/** Long text wraps instead of being clipped. Off by default — rows stay level. */
	wrap?: boolean;
	/** Renders the cell as a link. `{value}` in the pattern is replaced by the cell. */
	linkTemplate?: string;
	/**
	 * Columns to show when the reader hovers a cell in this column.
	 *
	 * The way a dense table stays explainable: the cell shows one figure, and
	 * what it was derived from is a hover away. The source columns are usually
	 * `hidden`, so they cost no width and still reach the reader.
	 *
	 * Named to match `ChartProps.tooltip.extraColumns`, which already means this.
	 */
	tooltip?: { extraColumns: string[] };
	/**
	 * A small superscript on cells matching a condition.
	 *
	 * For marking one KIND of value among another — a forecast among actuals, an
	 * estimate among measured figures. Colour says a value is good or bad; a
	 * marker says it is a different kind of thing, which colour cannot.
	 *
	 * Same `basedOn` and `when` as a format rule, so there is one vocabulary for
	 * "test a column" rather than two.
	 */
	marker?: {
		/** Column to test, when it is not the one being marked. */
		basedOn?: string;
		when: SingleColourRule['when'];
		/** One or two characters. It sits in superscript beside the value. */
		symbol: string;
		/** Hover text saying what the symbol means. */
		title?: string;
	};
}

/**
 * The fallback ceiling, when the caller gives no height and no container does.
 *
 * 480px is about fifteen rows plus the header and the footer — enough that the
 * table reads as a table rather than a preview, and short enough that whatever
 * the panel puts after it is still on screen. It only ever applies when the
 * table would otherwise have been taller: a table in a shorter container is
 * unaffected, because `height: 100%` already bounds it.
 */
const DEFAULT_MAX_HEIGHT = 480;

export interface DataTableProps {
	data: Rows;
	columns?: ColumnMeta[];
	columnConfig?: ColumnConfig[];
	/**
	 * A banded header row above the column names.
	 *
	 * Each band spans the columns it lists, in the order they already appear — a
	 * group whose columns are not adjacent is drawn as separate bands rather than
	 * reordering the table, because the column order is the caller's. Columns in
	 * no group get an empty band, so the two rows stay aligned.
	 */
	columnGroups?: { label: string; columns: string[] }[];
	/** Ordered; first match wins, as in every product that does this well. */
	formatRules?: FormatRule[];
	totals?: boolean | { columns: string[] };
	truncated?: boolean;
	/**
	 * Rows before the cap, from `state.meta?.totalRows`.
	 *
	 * Turns "the result was capped" into a count of what was left out. Pass it beside
	 * `truncated` — one says a cap happened, the other says how big it was.
	 */
	totalRows?: number;
	empty?: React.ReactNode;
	/** A 1-based row number in the first column. */
	rowIndex?: boolean;
	/** Rows per page. Omit for one scrolling list. */
	pageSize?: number;
	/** Column to sort by initially, and which way. */
	sortBy?: { column: string; direction?: 'asc' | 'desc' };
	/** Reader sorting, on by default — the whole reason the header is clickable. */
	sortable?: boolean;
	/**
	 * How tall this may grow when nothing above it says.
	 *
	 * The table fills a container that has a height and scrolls inside it. When
	 * the container has none — a plain `<div>` wrapping it, a column in a
	 * `Grid` — `height: 100%` resolves to `auto` and the table grows to every
	 * row it was given. A panel clips at its own edge, so the visible result is
	 * a table that runs off the bottom and takes the components after it with
	 * it: they are rendered and simply never on screen.
	 *
	 * Pass `'none'` for a table that should fill a tall panel exactly, or a
	 * different number of pixels to be precise.
	 */
	maxHeight?: number | string;
	/** Fixed height in px. Without it the table takes the room left in its panel. */
	height?: number;
	/** Row height and font size. */
	density?: Density;
}

export type Density = 'compact' | 'normal';

/** Cell padding, body and header font sizes, and the sticky header row height they produce. */
export const DENSITY: Record<Density, { pad: string; font: number; head: number; headerH: number }> = {
	compact: { pad: '4px 6px', font: 11.5, head: 11, headerH: 23 },
	normal: { pad: '7px 8px', font: 12, head: 11.5, headerH: 29 },
};

export function DataTable({
	data,
	columns,
	columnConfig,
	columnGroups,
	formatRules,
	totals,
	truncated,
	totalRows,
	empty,
	rowIndex,
	pageSize,
	sortBy,
	sortable = true,
	maxHeight = DEFAULT_MAX_HEIGHT,
	height,
	density = 'normal',
}: DataTableProps) {
	const dense = DENSITY[density];
	const [sort, setSort] = useState<{ column: string; direction: 'asc' | 'desc' } | null>(
		sortBy ? { column: sortBy.column, direction: sortBy.direction ?? 'asc' } : null,
	);
	const [page, setPage] = useState(0);

	const cols = useMemo(() => {
		const base: ColumnMeta[] =
			columns ??
			(data[0]
				? Object.keys(data[0]).map((name) => ({ name, dataType: 'string' as const }))
				: []);
		const byName = new Map((columnConfig ?? []).map((c) => [c.column, c]));
		return base
			.filter((c) => !byName.get(c.name)?.hidden)
			.map((c) => {
				const cfg = byName.get(c.name);
				return cfg ? { ...c, label: cfg.label ?? c.label, format: cfg.format ?? c.format } : c;
			});
	}, [columns, columnConfig, data]);

	const config = useMemo(
		() => new Map((columnConfig ?? []).map((c) => [c.column, c])),
		[columnConfig],
	);

	/**
	 * Every declared column by name, INCLUDING the hidden ones.
	 *
	 * `cols` drops hidden columns, and a tooltip's source columns are usually
	 * exactly those — hidden so they cost no width, reached on hover. Looking one
	 * up in `cols` would find nothing and print a bare name beside an
	 * unformatted value, which is the case this exists for.
	 */
	const declared = useMemo(() => {
		const base: ColumnMeta[] =
			columns ??
			(data[0]
				? Object.keys(data[0]).map((name) => ({ name, dataType: 'string' as const }))
				: []);
		const byConfig = new Map((columnConfig ?? []).map((c) => [c.column, c]));
		return new Map(
			base.map((c) => {
				const cfg = byConfig.get(c.name);
				const merged = cfg
					? { ...c, label: cfg.label ?? c.label, format: cfg.format ?? c.format }
					: c;
				return [c.name, merged] as const;
			}),
		);
	}, [columns, columnConfig, data]);

	/**
	 * The banded header, as runs over the columns in the order they already have.
	 *
	 * Runs rather than one cell per group: a group whose columns are not adjacent
	 * is drawn as two bands instead of silently reordering the table. The column
	 * order belongs to whoever wrote the resolver, and a header that rearranged
	 * it would put the label above the wrong figures.
	 *
	 * Columns in no group produce an unlabelled run, so both rows stay aligned.
	 */
	const groupRuns = useMemo(() => {
		if (!columnGroups?.length) return [];
		const labelOf = (name: string) =>
			columnGroups.find((g) => g.columns.includes(name))?.label;
		const runs: { label?: string; span: number }[] = [];
		for (const c of cols) {
			const label = labelOf(c.name);
			const last = runs[runs.length - 1];
			if (last && last.label === label) last.span += 1;
			else runs.push({ label, span: 1 });
		}
		return runs;
	}, [columnGroups, cols]);

	/**
	 * Sorted in place of the given order, never mutating the caller's rows.
	 *
	 * Nulls sink to the bottom in both directions. Sorting them to one end by
	 * value would put "no data" above real numbers on an ascending sort, which
	 * reads as a result rather than an absence.
	 */
	const ordered = useMemo(() => {
		if (!sort) return data;
		const dir = sort.direction === 'desc' ? -1 : 1;
		return [...data].sort((x, y) => {
			const a = x[sort.column];
			const b = y[sort.column];
			const aNull = a === null || a === undefined;
			const bNull = b === null || b === undefined;
			if (aNull && bNull) return 0;
			if (aNull) return 1;
			if (bNull) return -1;
			const na = Number(a);
			const nb = Number(b);
			if (Number.isFinite(na) && Number.isFinite(nb)) return (na - nb) * dir;
			return String(a).localeCompare(String(b)) * dir;
		});
	}, [data, sort]);

	/* The top rows after sorting, so a reader's sort decides which ones they are. */
	const shown = ordered.length > DISPLAY_ROWS ? ordered.slice(0, DISPLAY_ROWS) : ordered;
	/* Every row the query produced: what arrived, or the server's own count when it cut the result. */
	const total = truncated && totalRows ? Math.max(totalRows, ordered.length) : ordered.length;

	const pages = pageSize ? Math.ceil(shown.length / pageSize) : 1;
	const visible = pageSize ? shown.slice(page * pageSize, (page + 1) * pageSize) : shown;

	/** Mini-bar and gradient extents, from the whole result rather than the page. */
	const extents = useMemo(() => {
		const out: Record<string, { min: number; max: number; absMax: number }> = {};
		const track = (name: string) => {
			if (out[name]) return;
			const nums = data
				.map((r) => Number(r[name]))
				.filter((n) => Number.isFinite(n)) as number[];
			out[name] = {
				min: nums.length ? Math.min(...nums) : 0,
				max: nums.length ? Math.max(...nums) : 0,
				absMax: nums.length ? Math.max(...nums.map(Math.abs)) : 0,
			};
		};
		for (const cfg of columnConfig ?? []) if (cfg.miniBar) track(cfg.column);
		for (const rule of formatRules ?? []) {
			if (isRange(rule)) for (const c of rule.columns) track(rule.basedOn ?? c);
		}
		return out;
	}, [data, columnConfig, formatRules]);

	if (!data.length) return <>{empty ?? <EmptyState title="No rows" />}</>;

	/* A cut result cannot total what it never received. */
	const totalColumns = truncated
		? []
		: totals === true
			? cols.filter((c) => c.dataType === 'number' || c.dataType === 'integer').map((c) => c.name)
			: totals && typeof totals === 'object'
				? totals.columns
				: [];

	/** The first rule that claims this cell. Ordered, first match wins. */
	function paint(name: string, row: Rows[number]): { color?: string; background?: string } {
		for (const rule of formatRules ?? []) {
			if (!rule.columns.includes(name)) continue;
			const tested = row[rule.basedOn ?? name] ?? null;

			if (isRange(rule)) {
				const key = rule.basedOn ?? name;
				const span = extents[key];
				const n = Number(tested);
				if (!span || !Number.isFinite(n)) continue;
				const bg = rampColour(n, rule.min ?? span.min, rule.max ?? span.max, rule.colors);
				if (bg) return { background: bg };
				continue;
			}

			if (matchesWhen(rule.when, tested)) return { color: rule.color, background: rule.background };
		}
		return {};
	}

	const rowPaint = (row: Rows[number]) => {
		for (const rule of formatRules ?? []) {
			if (isRange(rule) || !rule.wholeRow) continue;
			if (rule.columns.some((c) => matchesWhen(rule.when, row[rule.basedOn ?? c] ?? null))) {
				return rule.background;
			}
		}
		return undefined;
	};

	/**
	 * The hover text for one cell: the extra columns, labelled and formatted.
	 *
	 * Formatted rather than raw, because the whole point is that a reader can
	 * read it — a tooltip printing 0.8342105 for a percentage has moved the
	 * problem rather than solved it.
	 */
	function tooltipFor(cfg: ColumnConfig | undefined, row: Rows[number]): string | undefined {
		const extra = cfg?.tooltip?.extraColumns;
		if (!extra?.length) return undefined;
		return extra
			.map((name) => {
				const meta = declared.get(name) ?? { name, dataType: 'string' as const };
				return `${columnLabel(meta)}: ${formatValue(row[name] ?? null, meta)}`;
			})
			.join('\n');
	}

	/** The marker for one cell, when its condition holds. Null otherwise. */
	function markerFor(cfg: ColumnConfig | undefined, name: string, row: Rows[number]) {
		const m = cfg?.marker;
		if (!m) return null;
		return matchesWhen(m.when, row[m.basedOn ?? name] ?? null) ? m : null;
	}

	const toggleSort = (name: string) => {
		if (!sortable) return;
		setPage(0);
		setSort((current) =>
			current?.column !== name
				? { column: name, direction: 'asc' }
				: current.direction === 'asc'
					? { column: name, direction: 'desc' }
					: null,
		);
	};

	/**
	 * How wide a cell may get before its text is clipped to an ellipsis.
	 *
	 * A column had no ceiling at all: `white-space: nowrap` with no `max-width`,
	 * so one long customer name set the width of that column for the whole table
	 * and pushed every other column off the panel. The reader lost eight columns
	 * to one value they could already read.
	 *
	 * Clipping is the better failure. The column keeps its share of the width,
	 * the long value says it is longer with an ellipsis, and the whole of it is
	 * one hover away. Override per column with `width`, or set `wrap` when the
	 * text genuinely needs more than one line.
	 */
	const CELL_MAX_WIDTH = 240;

	/**
	 * Above this many characters a cell offers its full text on hover.
	 *
	 * Roughly what fits in CELL_MAX_WIDTH at this font size, with room to spare —
	 * see the note at the call site for why this is a length test rather than a
	 * measurement.
	 */
	const TRUNCATE_HINT_CHARS = 24;

	/**
	 * The height of one sticky header row.
	 *
	 * A constant rather than a measurement: the padding and font size below are
	 * fixed, so the height is deterministic, and measuring would mean a layout
	 * read on every render to place a row that never moves. It travels with the
	 * two values it is derived from — change those and change this.
	 */
	const HEADER_ROW_H = dense.headerH;

	const th: React.CSSProperties = {
		padding: dense.pad,
		borderBottom: `1px solid ${T.line}`,
		color: T.muted,
		fontWeight: 500,
		fontSize: dense.head,
		position: 'sticky',
		/* Below the band row when there is one, so both stay visible while
		 * scrolling and neither covers the other. */
		top: groupRuns.length ? HEADER_ROW_H : 0,
		background: T.surface,
		whiteSpace: 'nowrap',
		zIndex: 1,
	};

	/** The band row: same chrome, one level up, and centred over its span. */
	const groupTh: React.CSSProperties = {
		...th,
		top: 0,
		textAlign: 'center',
		fontWeight: 600,
		zIndex: 2,
	};

	const indexCell: React.CSSProperties = {
		padding: dense.pad,
		borderBottom: `1px solid ${T.line}`,
		color: T.faint,
		textAlign: 'right',
		fontVariantNumeric: 'tabular-nums',
		width: 1,
	};

	return (
		<div
			style={{
				...itemStyle({ grow: true, height, minHeight: TABLE_MIN_HEIGHT }),
				display: 'flex',
				flexDirection: 'column',
				/* Bounded even when nothing above it is — except where the caller
				 * asked for a height, which is a floor the table grows from. */
				maxHeight: maxHeight === 'none' || height != null ? undefined : maxHeight,
			}}
		>
			<div style={{ flex: '1 1 auto', minHeight: 0, overflow: 'auto' }}>
				<table style={{ width: '100%', borderCollapse: 'collapse', fontSize: dense.font }}>
					<thead>
						{groupRuns.length > 0 && (
							<tr>
								{rowIndex && <th style={groupTh} />}
								{groupRuns.map((run, i) => (
									<th
										key={i}
										colSpan={run.span}
										style={{
											...groupTh,
											/* An unlabelled band is a spacer, not a heading. Ruling it
											 * would draw a line under nothing and read as an empty
											 * group rather than as columns that belong to none. */
											borderBottom: run.label ? `1px solid ${T.line}` : 'none',
										}}
									>
										{run.label ?? ''}
									</th>
								))}
							</tr>
						)}
						<tr>
							{rowIndex && <th style={{ ...th, textAlign: 'right' }}>#</th>}
							{cols.map((c) => {
								const active = sort?.column === c.name;
								return (
									<th
										key={c.name}
										onClick={() => toggleSort(c.name)}
										title={sortable ? 'Sort by this column' : undefined}
										style={{
											...th,
											textAlign: alignFor(c, null),
											width: config.get(c.name)?.width,
											cursor: sortable ? 'pointer' : 'default',
											color: active ? T.fg : T.muted,
											userSelect: 'none',
										}}
									>
										{columnLabel(c)}
										{/* An arrow only on the sorted column — a set of grey arrows on
										    every header is noise that says nothing. */}
										{active && (
											<span style={{ marginLeft: 4, fontSize: 9 }}>
												{sort.direction === 'asc' ? '▲' : '▼'}
											</span>
										)}
									</th>
								);
							})}
						</tr>
					</thead>

					<tbody>
						{visible.map((row, i) => {
							const highlight = rowPaint(row);
							return (
								<tr key={i} style={highlight ? { background: highlight } : undefined}>
									{rowIndex && (
										<td style={indexCell}>{(pageSize ? page * pageSize : 0) + i + 1}</td>
									)}
									{cols.map((c) => {
										const value = row[c.name] ?? null;
										const { color, background } = paint(c.name, row);
										const cfg = config.get(c.name);
										const span = cfg?.miniBar ? extents[c.name] : undefined;
										const rendered = formatValue(value, c);
										const link = cfg?.linkTemplate;
										const hover = tooltipFor(cfg, row);
										const mark = markerFor(cfg, c.name, row);

										/**
										 * The hover text, and why it is not on every cell.
										 *
										 * A `title` on all of them means a browser tooltip pops up
										 * wherever the cursor rests, including over a date and a
										 * three-digit count — noise that trains a reader to ignore
										 * the one place it carries something.
										 *
										 * Length is the heuristic because the real question — was
										 * this cell actually clipped — needs a measurement per cell
										 * per render, and a table is thousands of cells. Anything
										 * under the threshold fits comfortably in the default width
										 * at this font size, so the two answers agree in every case
										 * that matters. A column's own tooltip always wins.
										 */
										const full = String(rendered ?? '');
										const title = hover ?? formatRaw(value, c) ?? (full.length > TRUNCATE_HINT_CHARS ? full : undefined);

										return (
											<td
												key={c.name}
												title={title}
												style={{
													padding: dense.pad,
													borderBottom: `1px solid ${T.line}`,
													textAlign: alignFor(c, value),
													/* A null reads as absent, never as a value. */
													color: color ?? (value === null ? T.faint : T.fg),
													background,
													fontVariantNumeric: 'tabular-nums',
													whiteSpace: cfg?.wrap ? 'normal' : 'nowrap',
													maxWidth: cfg?.width ?? (cfg?.wrap ? 280 : CELL_MAX_WIDTH),
													/* Clip rather than stretch — see CELL_MAX_WIDTH. A
													 * wrapping column has somewhere for the text to go
													 * and must not be cut off instead. */
													overflow: cfg?.wrap ? undefined : 'hidden',
													textOverflow: cfg?.wrap ? undefined : 'ellipsis',
												}}
											>
												{span?.absMax ? (
													<div
														style={{
															display: 'flex',
															alignItems: 'center',
															gap: 6,
															justifyContent: 'flex-end',
														}}
													>
														<div
															style={{
																flex: '1 1 auto',
																height: 6,
																background: T.surfaceSunken,
																borderRadius: 3,
																minWidth: 24,
															}}
														>
															<div
																style={{
																	width: `${(Math.abs(Number(value) || 0) / span.absMax) * 100}%`,
																	height: '100%',
																	borderRadius: 3,
																	background:
																		(Number(value) || 0) < 0 ? SENTIMENT.negative : T.accent,
																}}
															/>
														</div>
														<span>{rendered}</span>
													</div>
												) : link && value !== null ? (
													<a
														href={link.replace('{value}', encodeURIComponent(String(value)))}
														target="_blank"
														rel="noreferrer noopener"
														style={{ color: T.accent, textDecoration: 'none' }}
													>
														{rendered}
													</a>
												) : (
													rendered
												)}
												{mark && (
													<sup
														title={mark.title}
														style={{
															fontSize: 8,
															marginLeft: 1,
															color: T.faint,
															cursor: mark.title ? 'help' : undefined,
														}}
													>
														{mark.symbol}
													</sup>
												)}
											</td>
										);
									})}
								</tr>
							);
						})}
					</tbody>

					{totalColumns.length > 0 && (
						<tfoot>
							<tr>
								{rowIndex && <td style={{ ...indexCell, borderTop: `2px solid ${T.lineStrong}` }} />}
								{cols.map((c, i) => (
									<td
										key={c.name}
										title={
											totalColumns.includes(c.name)
												? formatRaw(data.reduce((sum, r) => sum + (Number(r[c.name]) || 0), 0), c)
												: undefined
										}
										style={{
											padding: dense.pad,
											borderTop: `2px solid ${T.lineStrong}`,
											textAlign: alignFor(c, null),
											fontWeight: 600,
											fontVariantNumeric: 'tabular-nums',
											position: 'sticky',
											bottom: 0,
											background: T.surface,
										}}
									>
										{/* Totalled over every row, not the page — a total that changed
										    as you paged would be a different number each time. */}
										{i === 0 && !totalColumns.includes(c.name)
											? 'Total'
											: totalColumns.includes(c.name)
												? formatValue(
														data.reduce((sum, r) => sum + (Number(r[c.name]) || 0), 0),
														c,
													)
												: ''}
									</td>
								))}
							</tr>
						</tfoot>
					)}
				</table>
			</div>

			{/**
			 * The count is always shown.
			 *
			 * It used to appear only when the table paged or was capped, so a
			 * hundred-row table that had been cut down from a thousand rendered no
			 * footer at all and said nothing. A row count is not an exception
			 * worth surfacing — it is what a reader checks a table against.
			 */}
			<div
				style={{
					flex: '0 0 auto',
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'space-between',
					gap: 12,
					marginTop: 8,
					paddingTop: 8,
					/* A rule, so the footer belongs to the table rather than floating
					 * under it — and so the pager has an edge to sit against. */
					borderTop: `1px solid ${T.line}`,
					fontSize: 12,
					color: truncated || total > shown.length ? T.muted : T.faint,
				}}
			>
					{/**
					 * A count, not "some rows are not shown".
					 *
					 * The old wording told a reader they were missing something and
					 * not how much, which is the difference between a caveat and a
					 * number — and a caveat with no magnitude is read as boilerplate.
					 * `totalRows` is the count before the cap, so the sentence can be
					 * specific whenever the runtime did the capping.
					 */}
					<span style={total > shown.length || truncated ? { fontWeight: 500 } : undefined}>
						{total > shown.length
							? `Showing top ${formatNumber(shown.length)} of ${formatNumber(total)}`
							: truncated
								? `Showing ${formatNumber(shown.length)} — the result was capped`
								: `${formatNumber(shown.length)} row${shown.length === 1 ? '' : 's'}`}
					</span>

					{/**
					 * The pager, at a size someone can find.
					 *
					 * It was two 11px chevrons with no border and no hit area — small
					 * enough that a table looked like it simply ended at row twenty-five.
					 * A control nobody sees is a control that does not exist, so it now
					 * states the range it is showing, and the buttons are 28px targets
					 * with a visible edge.
					 */}
					{pages > 1 && (
						<span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
							<span style={{ color: T.muted, whiteSpace: 'nowrap' }}>
								{formatNumber(page * (pageSize ?? 0) + 1)}–
								{formatNumber(Math.min((page + 1) * (pageSize ?? 0), shown.length))}
							</span>
							<button
								type="button"
								disabled={page === 0}
								onClick={() => setPage(0)}
								style={pagerStyle(page === 0)}
								title="First page"
								aria-label="First page"
							>
								«
							</button>
							<button
								type="button"
								disabled={page === 0}
								onClick={() => setPage((p) => Math.max(0, p - 1))}
								style={pagerStyle(page === 0)}
								title="Previous page"
								aria-label="Previous page"
							>
								‹
							</button>
							<span style={{ color: T.fg, whiteSpace: 'nowrap', minWidth: 62, textAlign: 'center' }}>
								{formatNumber(page + 1)} / {formatNumber(pages)}
							</span>
							<button
								type="button"
								disabled={page >= pages - 1}
								onClick={() => setPage((p) => Math.min(pages - 1, p + 1))}
								style={pagerStyle(page >= pages - 1)}
								title="Next page"
								aria-label="Next page"
							>
								›
							</button>
							<button
								type="button"
								disabled={page >= pages - 1}
								onClick={() => setPage(pages - 1)}
								style={pagerStyle(page >= pages - 1)}
								title="Last page"
								aria-label="Last page"
							>
								»
							</button>
						</span>
					)}
			</div>
		</div>
	);
}

/** 28px, which is a target rather than a hint. Was 20px and went unnoticed. */
const pagerStyle = (disabled: boolean): React.CSSProperties => ({
	border: `1px solid ${disabled ? T.line : T.muted}`,
	background: T.surface,
	color: disabled ? T.faint : T.fg,
	borderRadius: 6,
	width: 28,
	height: 28,
	fontSize: 14,
	lineHeight: '26px',
	padding: 0,
	opacity: disabled ? 0.45 : 1,
	cursor: disabled ? 'default' : 'pointer',
});

DataTable.Metadata = {
	kind: 'display',
	purpose: 'Rows and columns — sortable, formattable, with totals and paging.',
	useWhen:
		'The reader needs the individual records, or there are too many dimensions to chart.',
	notes:
		'A resolver sends at most 10,000 rows. A cut result shows those, names the total in its footer and ' +
		'drops the totals row. Order the resolver so the rows that matter come first, and page anything ' +
		'longer than a screen.',
	props: {
		data: { description: 'The resolver rows.', importance: 'required', group: 'data' },
		columns: {
			description: 'Pass state.columns so each value formats by its real type.',
			importance: 'recommended',
			group: 'data',
			caution: 'Without it types are inferred from the first row, which cannot see a column that is null throughout.',
		},
		totalRows: {
			description: 'Pass state.meta?.totalRows so the footer states how many rows of the total are shown.',
			importance: 'recommended',
			group: 'data',
			caution:
				'A LIMIT written into the SQL is applied by the database, so this arrives equal to the row ' +
				'count and the footer cannot say how many rows were left out.',
		},
		truncated: {
			description: 'Pass state.meta?.truncated so a capped result says so.',
			importance: 'recommended',
			group: 'data',
		},
		empty: { description: 'What to render when there are no rows.', group: 'data' },

		columnConfig: {
			description:
				'Per column: { column, label, hidden, width, format, miniBar, wrap, linkTemplate, ' +
				'tooltip, marker }. `tooltip: { extraColumns: [...] }` shows those columns when the ' +
				'reader hovers a cell. `marker: { basedOn, when, symbol, title }` puts a superscript ' +
				'on cells that match, for flagging a different KIND of value — a forecast among ' +
				'actuals — which colour cannot say.',
			group: 'columns',
			caution:
				'Long values clip to an ellipsis and show in full on hover. Raise `width` for a column ' +
				'that needs more room, or set `wrap` when the text needs a second line.',
		},
		columnGroups: {
			description:
				'A banded header row above the column names: [{ label, columns: [...] }]. Columns in ' +
				'no group get an empty band.',
			group: 'columns',
			caution:
				'Bands follow the order the columns are already in — a group whose columns are not ' +
				'adjacent is drawn as two bands rather than reordering the table. Order the columns in ' +
				'the resolver if you want one band.',
		},
		totals: {
			description: 'true for every numeric column, or { columns: [...] } to choose.',
			group: 'columns',
			caution:
				'Totalled over the rows received, and dropped when the result was cut. Never total an ' +
				'average or a rate. Return a total that must always show from its own resolver.',
		},
		rowIndex: { description: 'A 1-based row number in the first column.', default: false, group: 'columns' },

		formatRules: {
			description:
				'Ordered, first match wins. A single rule takes { columns, when: { op, value }, color, ' +
				'background, wholeRow } with op in eq ne gt gte lt lte contains isNull notNull. A range ' +
				'rule takes { type: "range", columns, colors } and shades a gradient across the column. ' +
				'Either kind may set `basedOn` to test one column and paint another — colour by margin, ' +
				'show revenue.',
			group: 'formatting',
			caution:
				'Rules are tried in order and the first match wins, so put the specific case before the ' +
				'general one or it never fires.',
		},

		maxHeight: {
			description:
				'Pixel ceiling on the table when its container gives it no height.',
			default: 480,
			group: 'display',
			caution:
				'Only reach for this when a table sits in a container with a real height and should ' +
				'fill it exactly — pass "none" then. Raising it, or removing it, in a container with ' +
				'no height lets the table grow past the panel and take everything below it off screen.',
		},
		height: {
			description: 'Least table height in px; the body scrolls inside it and it still grows with the panel.',
			group: 'display',
			caution: 'Omit it and the table takes the room left in its panel. Set it for a table in a Grid cell or a Card.',
		},
		density: {
			description: '"compact" | "normal" — row height and font size.',
			default: 'normal',
			group: 'display',
		},
		sortable: {
			description: 'Reader can sort by clicking a header.',
			default: true,
			group: 'interaction',
			caution: 'Nulls sort to the bottom in both directions, so "no data" never outranks a real number.',
		},
		sortBy: {
			description: 'The column to sort by initially: { column, direction }.',
			importance: 'recommended',
			group: 'interaction',
			caution: 'An unsorted table of more than a few rows makes the reader do the ranking.',
		},
		pageSize: {
			description: 'Rows per page. Omit for one scrolling list.',
			group: 'interaction',
			caution:
				'Sorting and totals cover every row received, not the visible page.',
		},
	},
} satisfies ContractMeta;

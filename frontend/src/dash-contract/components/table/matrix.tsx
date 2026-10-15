/**
 * The matrix — one measure, a row hierarchy down the side, a dimension across
 * the top.
 *
 * `DataTable` renders the rows it is given. This renders a *crosstab*: it takes
 * long rows and pivots them, so the columns come from the data rather than from
 * the query's shape.
 *
 * ### Why the pivot happens here and not in SQL
 *
 * A resolver that returns weeks as columns has a column set that changes with
 * its own parameters — eight columns for one filter, three for another. That
 * cannot be declared: `meta.output.columns` is a fixed list, and `./publish`
 * refuses a resolver that declares a column its query did not return. So the
 * resolver would have to either lie or declare nothing and lose every format.
 *
 * Returning long rows removes the problem rather than working around it. The
 * resolver returns the same handful of columns whatever the filters do, declares
 * them honestly, and this component turns the distinct values of one of them
 * into columns at render time.
 *
 * ### The order of the columns is the data's
 *
 * Columns appear in the order they are first seen, so `ORDER BY` in the resolver
 * decides them. That is deliberate: sorting them here would mean sorting week
 * labels or period names as text, which is exactly the mistake the
 * "chronological sort order" rule exists to prevent — `W9` after `W10`, `April`
 * before `January`.
 */
import { useEffect, useMemo, useState } from 'react';
import { EmptyState } from '../status';
import { usePanelData, type AsyncState, type Param } from '../../context';
import { columnLabel, formatNumber, formatValue } from '../../format';
import { T } from '../../theme';
import type { ContractMeta } from '../../meta';
import type { ColumnMeta, ParamValue, Rows, ScalarValue } from '../../types';
import { DENSITY, matchesWhen, type Density, type SingleColourRule } from './index';
import { itemStyle, TABLE_MIN_HEIGHT } from '../layout/flow';

/* ---------------------------------- rules ---------------------------------- */

/**
 * One conditional-colour rule for a cell.
 *
 * The same `when` vocabulary as `DataTable`'s `formatRules`, minus `columns` —
 * a matrix has one measure, so there is nothing to choose between. `basedOn`
 * survives and is more useful here than there: every cell still has a whole
 * source row behind it, so a cell can be coloured by a column that is not on
 * screen at all.
 */
export interface MatrixCellRule {
	/** Column to test instead of the measure. */
	basedOn?: string;
	when: SingleColourRule['when'];
	color?: string;
	background?: string;
}

/* ---------------------------------- props ---------------------------------- */

export interface MatrixTableProps {
	data: Rows;
	columns?: ColumnMeta[];
	/**
	 * The row hierarchy, outermost first.
	 *
	 * One entry is a flat matrix. Two makes the first expandable into the second
	 * — pillars opening into their employees.
	 */
	groupBy: string[];
	/** The column whose distinct values become the columns. */
	across: string;
	/** Column holding the display text for `across`. Defaults to `across` itself. */
	acrossLabel?: string;
	/** The measure in every cell. */
	value: string;
	/**
	 * How a parent row fills its cells when the data has no row at its grain.
	 *
	 * `none` leaves them blank, and that is the default on purpose — see the
	 * caution in the metadata.
	 */
	aggregate?: 'none' | 'sum' | 'avg';
	/** A trailing total column, computed the same way as `aggregate`. */
	rowTotal?: boolean;
	/** A bottom total row, computed the same way as `aggregate`. */
	columnTotal?: boolean;
	/** Ordered, first match wins. */
	cellRules?: MatrixCellRule[];
	/** Whether the hierarchy starts open. */
	expanded?: 'none' | 'all';
	/** Columns to show when the reader hovers a cell. */
	tooltip?: { extraColumns: string[] };
	/** A superscript on cells matching a condition. */
	marker?: {
		basedOn?: string;
		when: SingleColourRule['when'];
		symbol: string;
		title?: string;
	};
	/**
	 * Loads a top-level row's children when it is opened, instead of carrying them
	 * in `data`. The resolver gets `params` plus `by` set to that row's value, and
	 * returns long rows at the child grain.
	 */
	childrenFrom?: {
		resolver: string;
		by: string;
		params?: Record<string, ParamValue | Param>;
		/** Top-level row values that do not open — a Total row. */
		except?: string[];
		/**
		 * The resolver returns one row per child, each cell's fields named
		 * `<field>__<across value>` — `variance__-4`. Keeps a large parent inside
		 * the row limit.
		 */
		wide?: boolean;
	};
	empty?: React.ReactNode;
	truncated?: boolean;
	totalRows?: number;
	/**
	 * How tall this may grow when nothing above it says.
	 *
	 * Same fallback as `DataTable`, and the same 480px: a crosstab in a
	 * container with no height grows to every row and takes the components after
	 * it off the bottom of the panel. Pass `'none'` to fill a tall panel
	 * exactly, or a different number of pixels.
	 */
	maxHeight?: number | string;
	/** Fixed height in px. Without it the matrix takes the room left in its panel. */
	height?: number;
	/** Row height and font size. */
	density?: Density;
}

/* ---------------------------------- model ---------------------------------- */

interface Cell {
	value: ScalarValue;
	/** The row this cell came from, for tooltips, markers and `basedOn`. */
	row: Rows[number];
}

interface Node {
	/** Full path, joined — unique, and the expansion key. */
	key: string;
	label: string;
	level: number;
	cells: Map<string, Cell>;
	children: Node[];
	/** A message row under a lazily loaded parent, not a data row. */
	status?: 'loading' | 'error' | 'note';
}

/**
 * Wide child rows back into long ones: `variance__-4` becomes `variance` on a
 * row whose `across` is -4. Only the across values the parent rows have become
 * cells, so a child cannot add a column.
 */
function unpack(rows: Rows, parents: Rows, across: string, acrossLabel: string): Rows {
	const keys = new Map<string, { value: ScalarValue; label: ScalarValue }>();
	for (const p of parents) {
		const v = p[across];
		if (v !== null && v !== undefined && !keys.has(String(v))) keys.set(String(v), { value: v, label: p[acrossLabel] ?? v });
	}
	const out: Rows = [];
	for (const row of rows) {
		const shared: Record<string, ScalarValue> = {};
		const cells = new Map<string, Record<string, ScalarValue>>();
		for (const [name, v] of Object.entries(row)) {
			const at = name.lastIndexOf('__');
			if (at <= 0) {
				shared[name] = v;
				continue;
			}
			const key = name.slice(at + 2);
			if (!keys.has(key)) continue;
			cells.set(key, { ...(cells.get(key) ?? {}), [name.slice(0, at)]: v });
		}
		for (const [key, { value, label }] of keys) {
			const cell = cells.get(key);
			if (cell) out.push({ ...shared, ...cell, [across]: value, [acrossLabel]: label });
		}
	}
	return out;
}

/** What a lazily loaded parent has received so far. */
type Loaded = Pick<AsyncState<Rows>, 'data' | 'loading' | 'error' | 'meta'>;

/** Fetches one parent's children and hands them up. Renders nothing. */
function ChildLoader({
	source,
	value,
	onState,
}: {
	source: NonNullable<MatrixTableProps['childrenFrom']>;
	value: string;
	onState: (value: string, state: Loaded) => void;
}) {
	const state = usePanelData(source.resolver, { ...(source.params ?? {}), [source.by]: value });
	useEffect(() => {
		onState(value, { data: state.data, loading: state.loading, error: state.error, meta: state.meta });
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [value, state.data, state.loading, state.error, state.meta]);
	return null;
}

const numeric = (v: ScalarValue): number | null => {
	if (v === null || v === undefined || v === '') return null;
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
};

/**
 * Rolls a list of numbers up, or returns null.
 *
 * Null rather than zero for an empty set, for the reason the whole contract
 * keeps repeating: an aggregate over nothing is not zero, and rendering it as
 * one states something false.
 */
function roll(values: (number | null)[], how: 'sum' | 'avg'): number | null {
	const present = values.filter((n): n is number => n !== null);
	if (!present.length) return null;
	const sum = present.reduce((a, b) => a + b, 0);
	return how === 'sum' ? sum : sum / present.length;
}

/** Every descendant leaf cell for one column key. */
function descendantValues(node: Node, columnKey: string): (number | null)[] {
	if (!node.children.length) return [numeric(node.cells.get(columnKey)?.value ?? null)];
	return node.children.flatMap((child) => descendantValues(child, columnKey));
}

/**
 * Long rows into a tree plus an ordered column list.
 *
 * A row lands on the node matching its group values *up to the first null*. So a
 * resolver that returns both grains — a pillar row with no employee, and the
 * employee rows under it — puts the pillar's own figures on the pillar node,
 * and those win over anything this component would compute. The resolver is
 * always allowed to be the authority on its own numbers.
 */
function build(
	data: Rows,
	groupBy: string[],
	across: string,
	acrossLabel: string,
	value: string,
): { columns: { key: string; label: string }[]; roots: Node[] } {
	const columns: { key: string; label: string }[] = [];
	const seen = new Set<string>();
	const roots: Node[] = [];
	const index = new Map<string, Node>();

	for (const row of data) {
		const rawColumn = row[across];
		if (rawColumn === null || rawColumn === undefined) continue;
		const columnKey = String(rawColumn);
		if (!seen.has(columnKey)) {
			seen.add(columnKey);
			columns.push({ key: columnKey, label: String(row[acrossLabel] ?? rawColumn) });
		}

		/* The path stops at the first absent level, which is what lets one result
		 * carry rows at more than one grain. */
		const path: string[] = [];
		for (const dimension of groupBy) {
			const v = row[dimension];
			if (v === null || v === undefined || v === '') break;
			path.push(String(v));
		}
		if (!path.length) continue;

		let siblings = roots;
		let key = '';
		let node: Node | undefined;
		for (let level = 0; level < path.length; level++) {
			key = key ? `${key} ${path[level]}` : path[level]!;
			node = index.get(key);
			if (!node) {
				node = { key, label: path[level]!, level, cells: new Map(), children: [] };
				index.set(key, node);
				siblings.push(node);
			}
			siblings = node.children;
		}
		node!.cells.set(columnKey, { value: row[value] ?? null, row });
	}

	return { columns, roots };
}

/* -------------------------------- component -------------------------------- */

export function MatrixTable({
	data,
	columns,
	groupBy,
	across,
	acrossLabel,
	value,
	aggregate = 'none',
	rowTotal,
	columnTotal,
	cellRules,
	expanded = 'none',
	tooltip,
	marker,
	childrenFrom,
	empty,
	truncated,
	totalRows,
	maxHeight = 480,
	height,
	density = 'normal',
}: MatrixTableProps) {
	/* Children already fetched, by parent value. Kept across collapse so reopening is instant. */
	const [loaded, setLoaded] = useState<Map<string, Loaded>>(new Map());
	/* New parent rows mean new filters: what was fetched belongs to the old ones. */
	useEffect(() => setLoaded((prev) => (prev.size ? new Map() : prev)), [data]);
	const onChildState = (parent: string, state: Loaded) =>
		setLoaded((prev) => new Map(prev).set(parent, state));

	const lazy = !!childrenFrom && groupBy.length > 1;
	const merged = useMemo(() => {
		if (!lazy) return data;
		const fetched = [...loaded.values()].flatMap((l) => l.data ?? []);
		const children = childrenFrom?.wide ? unpack(fetched, data, across, acrossLabel ?? across) : fetched;
		return children.length ? [...data, ...children] : data;
	}, [lazy, data, loaded, childrenFrom?.wide, across, acrossLabel]);

	const { columns: cols, roots } = useMemo(
		() => build(merged, groupBy, across, acrossLabel ?? across, value),
		[merged, groupBy, across, acrossLabel, value],
	);

	/** The measure's own declaration, so every cell formats the same way. */
	const measure = useMemo<ColumnMeta>(
		() => columns?.find((c) => c.name === value) ?? { name: value, dataType: 'number' },
		[columns, value],
	);

	const declared = useMemo(
		() => new Map((columns ?? []).map((c) => [c.name, c] as const)),
		[columns],
	);

	const [open, setOpen] = useState<Set<string>>(new Set());
	/**
	 * Whether a node is open.
	 *
	 * `expanded: 'all'` is the starting position rather than a permanent state,
	 * so a reader can still close a group — which is the difference between a
	 * default and a lock.
	 */
	const isOpen = (node: Node) => (expanded === 'all' ? !open.has(node.key) : open.has(node.key));
	const toggle = (node: Node) =>
		setOpen((prev) => {
			const next = new Set(prev);
			if (next.has(node.key)) next.delete(node.key);
			else next.add(node.key);
			return next;
		});

	/** Has children now, or will load them when opened. */
	const expandable = (node: Node) =>
		node.children.length > 0 ||
		(lazy && node.level === 0 && !childrenFrom?.except?.includes(node.label));

	const anyChildren = roots.some(expandable);
	const allOpen = roots.every((r) => !expandable(r) || isOpen(r));
	const setAll = (openThem: boolean) =>
		setOpen(
			expanded === 'all'
				? openThem
					? new Set()
					: new Set(roots.map((r) => r.key))
				: openThem
					? new Set(roots.map((r) => r.key))
					: new Set(),
		);

	/** Depth-first, honouring what is open. The render order. */
	const visible = useMemo(() => {
		const out: Node[] = [];
		const message = (parent: Node, status: Node['status'], label: string) =>
			out.push({ key: `${parent.key}::${status}`, label, level: parent.level + 1, cells: new Map(), children: [], status });
		const walk = (nodes: Node[]) => {
			for (const node of nodes) {
				out.push(node);
				if (!expandable(node) || !isOpen(node)) continue;
				walk(node.children);
				if (!lazy || node.level !== 0) continue;
				const got = loaded.get(node.label);
				if (!got || (got.loading && !got.data)) message(node, 'loading', 'Loading…');
				else if (got.error) message(node, 'error', `Could not load: ${(got.error as { message?: string }).message ?? String(got.error)}`);
				else if (!node.children.length) message(node, 'note', 'Nothing to show under this row');
				else if (got.meta?.truncated && got.meta.totalRows > got.meta.rowCount)
					message(node, 'note', `Showing ${formatNumber(got.meta.rowCount)} of ${formatNumber(got.meta.totalRows)} rows`);
			}
		};
		walk(roots);
		return out;
		/* `open` and `expanded` are what change the answer; `isOpen` closes over both. */
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [roots, open, expanded, lazy, loaded]);

	/* A loader for every open lazy parent that has nothing yet. */
	const loaders = lazy
		? roots.filter((r) => expandable(r) && isOpen(r) && !loaded.get(r.label)?.data).map((r) => r.label)
		: [];

	if (!data.length) return <>{empty ?? <EmptyState title="No rows" />}</>;

	/**
	 * One cell's number.
	 *
	 * The node's own value first — a resolver that returned a row at this grain
	 * has stated the figure and is not second-guessed. Only when it did not, and
	 * only when asked, is one computed from the children.
	 */
	function cellFor(node: Node, columnKey: string): { value: ScalarValue; row?: Rows[number] } {
		const own = node.cells.get(columnKey);
		if (own) return { value: own.value, row: own.row };
		if (aggregate === 'none' || !node.children.length) return { value: null };
		return { value: roll(descendantValues(node, columnKey), aggregate) };
	}

	/**
	 * Asking for a Total is asking for a sum.
	 *
	 * `aggregate` defaults to `none` so that a parent row does not quietly invent
	 * a roll-up nobody asked to see. A `rowTotal` or `columnTotal` is the
	 * opposite case: somebody asked for it by name. Reading `none` there produced
	 * a Total header with nothing underneath it, which is worse than either
	 * answer — the reader sees a column of dashes and cannot tell whether the
	 * data is missing or the table is broken.
	 */
	const totalHow = aggregate === 'none' ? 'sum' : aggregate;

	function totalFor(node: Node): ScalarValue {
		return roll(
			cols.map((c) => numeric(cellFor(node, c.key).value)),
			totalHow,
		);
	}

	function columnFooter(columnKey: string): ScalarValue {
		return roll(
			roots.flatMap((r) => descendantValues(r, columnKey)),
			totalHow,
		);
	}

	function paint(cellValue: ScalarValue, row?: Rows[number]) {
		for (const rule of cellRules ?? []) {
			const tested = rule.basedOn ? (row?.[rule.basedOn] ?? null) : cellValue;
			if (matchesWhen(rule.when, tested)) return { color: rule.color, background: rule.background };
		}
		return {};
	}

	function hoverFor(row: Rows[number] | undefined): string | undefined {
		const extra = tooltip?.extraColumns;
		if (!extra?.length || !row) return undefined;
		/* A column the row does not carry is left out, so parent and child rows can share one tooltip list. */
		return extra
			.filter((name) => row[name] !== null && row[name] !== undefined)
			.map((name) => {
				const meta = declared.get(name) ?? { name, dataType: 'string' as const };
				return `${columnLabel(meta)}: ${formatValue(row[name] ?? null, meta)}`;
			})
			.join('\n');
	}

	const markerFor = (row: Rows[number] | undefined, cellValue: ScalarValue) =>
		marker && row && matchesWhen(marker.when, marker.basedOn ? (row[marker.basedOn] ?? null) : cellValue)
			? marker
			: null;

	const dense = DENSITY[density];

	const th: React.CSSProperties = {
		padding: dense.pad,
		borderBottom: `1px solid ${T.line}`,
		color: T.muted,
		fontWeight: 500,
		fontSize: dense.head,
		position: 'sticky',
		top: 0,
		background: T.surface,
		whiteSpace: 'nowrap',
		zIndex: 1,
	};

	/**
	 * The label column stays put while the matrix scrolls sideways.
	 *
	 * A wide crosstab is read by scrolling right, and a row whose name has
	 * scrolled off is a row of numbers about nothing.
	 */
	const stickyLeft: React.CSSProperties = {
		position: 'sticky',
		left: 0,
		background: T.surface,
		zIndex: 1,
	};

	/** The Total row stays at the bottom while the rows scroll, as DataTable's does. */
	const stickyBottom: React.CSSProperties = {
		position: 'sticky',
		bottom: 0,
		background: T.surface,
		zIndex: 2,
	};

	const cellStyle: React.CSSProperties = {
		padding: density === 'compact' ? dense.pad : '6px 8px',
		borderBottom: `1px solid ${T.line}`,
		textAlign: 'center',
		fontVariantNumeric: 'tabular-nums',
		whiteSpace: 'nowrap',
	};

	return (
		<div
			style={{
				...itemStyle({ grow: true, height, minHeight: TABLE_MIN_HEIGHT }),
				display: 'flex',
				flexDirection: 'column',
				/* Bounded even when nothing above it is — see DataTable's maxHeight.
				 * A caller-given height is a floor, so it lifts the ceiling. */
				maxHeight: maxHeight === 'none' || height != null ? undefined : maxHeight,
			}}
		>
			<div style={{ flex: '1 1 auto', minHeight: 0, overflow: 'auto' }}>
				{childrenFrom &&
					loaders.map((parent) => (
						<ChildLoader key={parent} source={childrenFrom} value={parent} onState={onChildState} />
					))}
				<table style={{ width: '100%', borderCollapse: 'collapse', fontSize: dense.font }}>
					<thead>
						<tr>
							<th style={{ ...th, ...stickyLeft, textAlign: 'left', zIndex: 3 }}>
								{columnLabel(declared.get(groupBy[0] ?? '') ?? { name: groupBy[0] ?? '', dataType: 'string' })}
								{anyChildren && (
									<button
										type="button"
										onClick={() => setAll(!allOpen)}
										style={{
											marginLeft: 6,
											border: 'none',
											background: 'transparent',
											font: 'inherit',
											fontSize: 10,
											fontWeight: 400,
											color: T.faint,
											cursor: 'pointer',
											textDecoration: 'underline',
										}}
									>
										{allOpen ? 'collapse all' : 'expand all'}
									</button>
								)}
							</th>
							{cols.map((c) => (
								<th key={c.key} style={{ ...th, textAlign: 'center' }}>
									{c.label}
								</th>
							))}
							{rowTotal && <th style={{ ...th, textAlign: 'center' }}>Total</th>}
						</tr>
					</thead>

					<tbody>
						{visible.map((node) => {
							if (node.status) {
								return (
									<tr key={node.key}>
										<td
											colSpan={cols.length + 1 + (rowTotal ? 1 : 0)}
											style={{
												...cellStyle,
												textAlign: 'left',
												paddingLeft: 8 + node.level * 16 + 14,
												color: node.status === 'error' ? T.negative : T.faint,
												fontStyle: 'italic',
											}}
										>
											{node.label}
										</td>
									</tr>
								);
							}
							const parent = expandable(node);
							return (
								<tr key={node.key}>
									<td
										onClick={parent ? () => toggle(node) : undefined}
										style={{
											...cellStyle,
											...stickyLeft,
											textAlign: 'left',
											paddingLeft: 8 + node.level * 16,
											fontWeight: node.level === 0 ? 600 : 400,
											color: T.fg,
											cursor: parent ? 'pointer' : 'default',
											userSelect: 'none',
										}}
									>
										{parent && (
											<span style={{ display: 'inline-block', width: 14, color: T.faint }}>
												{isOpen(node) ? '⊟' : '⊞'}
											</span>
										)}
										{node.label}
									</td>

									{cols.map((c) => {
										const { value: v, row } = cellFor(node, c.key);
										const { color, background } = paint(v, row);
										const mark = markerFor(row, v);
										return (
											<td
												key={c.key}
												title={hoverFor(row)}
												style={{
													...cellStyle,
													color: color ?? (v === null ? T.faint : T.fg),
													background,
												}}
											>
												{formatValue(v, measure)}
												{mark && (
													<sup
														title={mark.title}
														style={{ fontSize: 8, marginLeft: 1, color: T.faint }}
													>
														{mark.symbol}
													</sup>
												)}
											</td>
										);
									})}

									{rowTotal && (
										<td style={{ ...cellStyle, fontWeight: 600 }}>
											{formatValue(totalFor(node), measure)}
										</td>
									)}
								</tr>
							);
						})}
					</tbody>

					{columnTotal && (
						<tfoot>
							<tr>
								<td
									style={{
										...cellStyle,
										...stickyLeft,
										...stickyBottom,
										textAlign: 'left',
										fontWeight: 600,
										borderTop: `2px solid ${T.lineStrong}`,
										zIndex: 3,
									}}
								>
									Total
								</td>
								{cols.map((c) => (
									<td
										key={c.key}
										style={{
											...cellStyle,
											...stickyBottom,
											fontWeight: 600,
											borderTop: `2px solid ${T.lineStrong}`,
										}}
									>
										{formatValue(columnFooter(c.key), measure)}
									</td>
								))}
								{rowTotal && (
									<td
										style={{
											...cellStyle,
											...stickyBottom,
											fontWeight: 600,
											borderTop: `2px solid ${T.lineStrong}`,
										}}
									/>
								)}
							</tr>
						</tfoot>
					)}
				</table>
			</div>

			<div
				style={{
					flex: '0 0 auto',
					marginTop: 8,
					paddingTop: 8,
					borderTop: `1px solid ${T.line}`,
					fontSize: 12,
					color: truncated ? T.muted : T.faint,
				}}
			>
				<span style={truncated ? { fontWeight: 500 } : undefined}>
					{truncated && totalRows && totalRows > data.length
						? `Showing ${formatNumber(data.length)} of ${formatNumber(totalRows)} rows`
						: truncated
							? `Showing ${formatNumber(data.length)} rows — the result was capped`
							: `${formatNumber(visible.length)} row${visible.length === 1 ? '' : 's'} · ${formatNumber(cols.length)} column${cols.length === 1 ? '' : 's'}`}
				</span>
			</div>
		</div>
	);
}

/* -------------------------------- metadata --------------------------------- */

/* Cells are centred rather than aligned per value the way DataTable does it: a
 * grid of one measure reads as a grid, and per-value alignment breaks the
 * columns into a ragged edge. */

MatrixTable.Metadata = {
	kind: 'display',
	purpose: 'A crosstab: one measure, a row hierarchy down the side, a dimension across the top.',
	useWhen:
		'A measure has to be read two ways at once — by team AND by week, by product AND by month. ' +
		'Use DataTable when the rows are records rather than a grid.',
	props: {
		maxHeight: {
			description:
				'Pixel ceiling on the crosstab when its container gives it no height.',
			default: 480,
			group: 'display',
			caution:
				'Only reach for this when a table sits in a container with a real height and should ' +
				'fill it exactly — pass "none" then. Raising it, or removing it, in a container with ' +
				'no height lets the table grow past the panel and take everything below it off screen.',
		},
		height: {
			description: 'Least height in px; the body scrolls inside it and it still grows with the panel.',
			group: 'display',
			caution: 'Omit it and the matrix takes the room left in its panel.',
		},
		density: {
			description: '"compact" | "normal" — row height and font size.',
			default: 'normal',
			group: 'display',
		},
		data: {
			description: 'The resolver rows, LONG — one row per cell, not one row per line of the grid.',
			importance: 'required',
			group: 'data',
			caution:
				'Do not pivot in SQL. A query that returns weeks as columns has a column set that ' +
				'changes with its own filters, which meta.output.columns cannot declare and ./publish ' +
				'refuses. Return the dimensions and the measure as ordinary columns and let this pivot.',
		},
		columns: {
			description: 'Pass state.columns so the measure formats by its declared type.',
			importance: 'recommended',
			group: 'data',
		},
		groupBy: {
			description: 'Row dimensions, outermost first. One is a flat grid; two makes it expandable.',
			importance: 'required',
			group: 'data',
		},
		across: {
			description: 'The column whose distinct values become the columns of the grid.',
			importance: 'required',
			group: 'data',
			caution:
				'Columns appear in the order the rows arrive, so ORDER BY in the resolver decides them. ' +
				'Sorting them here would sort labels as text and put W10 before W9.',
		},
		acrossLabel: {
			description: 'Column holding the display text for `across`. Defaults to `across` itself.',
			group: 'data',
			caution:
				'Use it when the value that orders correctly is not the value a reader should see — ' +
				'sort on 2026-W09, show W9.',
		},
		value: { description: 'The measure in every cell.', importance: 'required', group: 'data' },

		aggregate: {
			description: '"none" | "sum" | "avg" — how a parent row fills cells the data did not supply.',
			default: 'none',
			group: 'rollup',
			caution:
				'"none" by default, and think before changing it. An average of averages is not the ' +
				'average, and a sum over a grain that already contains subtotals double-counts. The ' +
				'safe alternative is to return the parent grain FROM THE RESOLVER — a row with the ' +
				'child dimension null lands on the parent and always wins over anything computed here.',
		},
		rowTotal: { description: 'A trailing Total column. Sums, unless `aggregate` says otherwise.', group: 'rollup' },
		columnTotal: {
			description:
				'A bottom Total row, pinned at the bottom of the table while the rows scroll. Sums, unless `aggregate` says otherwise.',
			group: 'rollup',
			caution: 'Use this for a total row; never add total rows in the resolver.',
		},

		cellRules: {
			description:
				'Ordered, first match wins: [{ when: { op, value }, color, background, basedOn }]. Same ' +
				'operators as DataTable formatRules.',
			group: 'formatting',
			caution:
				'There is no `columns` field — a matrix has one measure. `basedOn` tests another column ' +
				'of the source row instead, which is how a cell is coloured by something not on screen.',
		},
		tooltip: {
			description: 'Columns to show when the reader hovers a cell: { extraColumns: [...] }.',
			group: 'formatting',
			caution: 'Only on cells the data supplied. A cell this component computed has no source row behind it.',
		},
		marker: {
			description: 'A superscript on matching cells: { basedOn, when, symbol, title }.',
			group: 'formatting',
			caution:
				'For a different KIND of value, not a good or bad one — a forecast among actuals. ' +
				'Explain the symbol once beneath the panel; a mark nobody can decode is noise.',
		},
		childrenFrom: {
			description:
				'{ resolver, by, params, except, wide } — load a top-level row\'s children when it is opened. ' +
				'The resolver gets params plus `by` set to that row\'s groupBy[0] value, and returns rows ' +
				'carrying both groupBy columns. `except` lists rows that do not open. With `wide`, it returns ' +
				'one row per child with each cell\'s fields named `<field>__<across value>`. Fetched children ' +
				'are kept, so reopening is instant.',
			group: 'data',
			caution:
				'Use it when the child grain does not fit in one result — employees under every pillar. ' +
				'`data` then holds only the parent rows, and groupBy still names both levels. Use `wide` ' +
				'when children × columns can pass the resolver row cap.',
		},
		expanded: {
			description: '"none" | "all" — whether the hierarchy starts open.',
			default: 'none',
			group: 'reading',
		},
		truncated: {
			description: 'Pass state.meta?.truncated so a capped result says so.',
			importance: 'recommended',
			group: 'reading',
			caution:
				'A capped result is worse here than in a table: a missing row does not just hide itself, ' +
				'it silently changes every total and every parent average.',
		},
		totalRows: {
			description: 'Pass state.meta?.totalRows so the footer says how many rows of the total arrived.',
			importance: 'recommended',
			group: 'reading',
		},
		empty: { description: 'What to render when there are no rows.', group: 'reading' },
	},
	notes:
		'A resolver for this returns one row per cell: the group dimensions, the across dimension, the ' +
		'measure, and anything the tooltip or a rule needs. Rows at more than one grain may be mixed — ' +
		'a row whose child dimension is null becomes the parent row, and its figures beat anything ' +
		'`aggregate` would compute.',
} satisfies ContractMeta;

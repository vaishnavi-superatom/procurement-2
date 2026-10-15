/**
 * The layout engine — pure functions, no DOM.
 *
 * Ported from dashboard-pi's `frontend/src/shell/layout/engine.ts`, which had
 * already solved this and stated why. Kept as pure functions so the hard parts
 * — where a dragged panel lands, what a resize means at a narrow breakpoint —
 * are testable without a browser.
 *
 * **There are no coordinates here.** A panel never says *where* it is; it says
 * how wide it wants to be, how tall, and where it comes in the reading order.
 * Everything else is document flow: panels wrap into rows the way inline
 * content does.
 *
 * That is the whole safety property, and it is why gridstack was not used. With
 * x/y, an overlap is one bad number away and a hole is one bad drag away, and
 * both then need collision and compaction passes that fight the browser's own
 * layout. With an ordered list of sizes, **overlap is not representable** —
 * there is no pair of values you could put in `layout.json`, by hand or by
 * accident, that places two panels on top of each other. The browser packs.
 *
 * The rules:
 *  - width is a span out of 12 — always relative, never pixels;
 *  - at narrower breakpoints spans scale down and then clamp, so a panel can
 *    never demand more room than exists;
 *  - height is in row units and is **exact**;
 *  - order is the array's order. Rearranging is re-indexing a list.
 */
import { GRID_COLUMNS, GRID_GAP, ROW_UNIT } from '../dash-contract/theme';
import type { PanelSize, PanelSpec } from '../dash-contract/types';

export interface Breakpoint {
	name: 'lg' | 'md' | 'sm';
	/** Minimum canvas width, in px, at which this breakpoint applies. */
	minWidth: number;
	cols: number;
}

/** Widest first — `resolveBreakpoint` takes the first that fits. */
export const BREAKPOINTS: Breakpoint[] = [
	{ name: 'lg', minWidth: 1180, cols: 12 },
	{ name: 'md', minWidth: 760, cols: 8 },
	{ name: 'sm', minWidth: 0, cols: 4 },
];

/** Spans are always authored against this, then scaled to the breakpoint. */
export const BASE_COLS = GRID_COLUMNS;

export function resolveBreakpoint(width: number): Breakpoint {
	return BREAKPOINTS.find((bp) => width >= bp.minWidth) ?? BREAKPOINTS[BREAKPOINTS.length - 1]!;
}

/**
 * Scales an authored 12-column span to the breakpoint in play.
 *
 * `sm` is deliberately absolute: every panel takes the full width. It is the
 * floor that keeps any arrangement, however someone dragged it, readable on a
 * phone.
 */
export function spanFor(span: number, spec: PanelSpec | undefined, cols: number): number {
	if (cols <= 4) return cols;
	const scaled = Math.round((span / BASE_COLS) * cols) || 1;
	const min = Math.min(spec?.minW ?? 1, cols);
	return Math.max(min, Math.min(scaled, cols));
}

/**
 * A height in row units, in pixels.
 *
 * The panel's **exact** height, not a floor. Stretching panels to match the
 * tallest in their row looks tidier but makes height uneditable: put a short
 * chart beside a long table and the chart is sized by the table, so shrinking
 * the chart changes nothing on screen and the control appears broken. A panel
 * you can only ever make bigger is not a resizable panel.
 *
 * The cost is that rows can be ragged. That is the reader's call to make.
 */
export const heightPx = (h: number): number => h * ROW_UNIT + Math.max(0, h - 1) * GRID_GAP;

/** Converts a pixel height back into whole row units. */
export const heightUnits = (px: number): number =>
	Math.max(1, Math.round((px + GRID_GAP) / (ROW_UNIT + GRID_GAP)));

/**
 * Reconciles a stored arrangement with the panels the dashboard actually
 * rendered: unknown panels are dropped, and each new one is placed right after
 * the panel before it in source order (first, when nothing precedes it), at its
 * declared size.
 *
 * Placing is why an agent can add a panel without touching `layout.json`, and
 * dropping is why removing one does not leave a ghost entry behind.
 */
export function reconcile(stored: PanelSize[] | undefined, specs: PanelSpec[]): PanelSize[] {
	const byId = new Map(specs.map((spec) => [spec.id, spec]));
	const seen = new Set<string>();
	const result: PanelSize[] = [];

	for (const entry of stored ?? []) {
		const spec = byId.get(entry.i);
		if (!spec || seen.has(entry.i)) continue;
		seen.add(entry.i);
		result.push({
			i: entry.i,
			span: Math.max(spec.minW, Math.min(entry.span, BASE_COLS)),
			h: Math.max(spec.minH, entry.h),
			...(entry.hidden ? { hidden: true as const } : {}),
		});
	}

	specs.forEach((spec, index) => {
		if (seen.has(spec.id)) return;
		seen.add(spec.id);
		const before = index > 0 ? specs[index - 1]!.id : null;
		const at = before ? result.findIndex((entry) => entry.i === before) : -1;
		result.splice(at + 1, 0, {
			i: spec.id,
			span: Math.max(spec.minW, Math.min(spec.defaultW, BASE_COLS)),
			h: Math.max(spec.minH, spec.defaultH),
		});
	});

	return result;
}

/** Takes a panel out of view, or puts it back. */
export function setHidden(list: PanelSize[], id: string, hidden: boolean): PanelSize[] {
	return list.map((entry) => {
		if (entry.i !== id) return entry;
		const { hidden: _was, ...rest } = entry;
		return hidden ? { ...rest, hidden: true as const } : rest;
	});
}

/** Where a panel currently sits, or -1. */
export const indexOfPanel = (list: PanelSize[], id: string): number =>
	list.findIndex((entry) => entry.i === id);

/** Moves one panel to a new index. This is the entire "drag" operation. */
export function reorder(list: PanelSize[], id: string, toIndex: number): PanelSize[] {
	const from = list.findIndex((entry) => entry.i === id);
	if (from === -1) return list;
	const next = [...list];
	const [entry] = next.splice(from, 1);
	if (!entry) return list;
	next.splice(Math.max(0, Math.min(toIndex, next.length)), 0, entry);
	return next;
}

/**
 * Resizes one panel. `spanInCols` arrives in the breakpoint's columns and is
 * stored back in the canonical 12, so resizing on a laptop and on a wide
 * monitor mean the same thing.
 */
export function resize(
	list: PanelSize[],
	id: string,
	spanInCols: number,
	h: number,
	spec: PanelSpec | undefined,
	cols: number,
): PanelSize[] {
	const authored = cols === BASE_COLS ? spanInCols : Math.round((spanInCols / cols) * BASE_COLS);
	return list.map((entry) =>
		entry.i === id
			? {
					i: entry.i,
					span: Math.max(spec?.minW ?? 1, Math.min(authored || 1, BASE_COLS)),
					h: Math.max(spec?.minH ?? 1, h),
					...(entry.hidden ? { hidden: true as const } : {}),
				}
			: entry,
	);
}

/**
 * How far the dragged panel must cover a neighbour before taking its place, as
 * a fraction of that neighbour's width.
 *
 * Measured as **overlap**, not as one centre passing another. For two adjacent
 * panels of equal width, the moment their centres cross is the moment the
 * dragged panel covers its neighbour almost entirely — so a centre test reads
 * as "I have to drag the whole way across before anything happens". At 0.5 the
 * swap lands where the hand expects it: about when the cursor reaches the
 * neighbour's near edge.
 */
const SWAP_THRESHOLD = 0.5;

/**
 * How much horizontal overlap means one panel *contains* the other rather than
 * sitting beside it — the point at which left/right stops being a meaningful
 * comparison and only up/down can decide the order.
 */
const CONTAINMENT = 0.9;

/**
 * Where a dragged panel belongs, given where everything currently sits.
 *
 * The subtle part is which axis decides. Two panels are row-mates — compared
 * left to right — only when they sit *beside* each other. Once one horizontally
 * contains the other, left and right stop meaning anything and only up and down
 * can order them.
 *
 * Getting that wrong is what strands a full-width panel: comparing it
 * horizontally against a panel it completely spans always answers "after", no
 * matter how far up it is dragged, so it can never rise above the row — which
 * reads as needing an enormous drag that then does nothing.
 */
export function indexForRect(
	boxes: { id: string; rect: DOMRect }[],
	dragged: DOMRect,
	draggedId: string,
	/** Sign of horizontal travel: 1 moving right, -1 moving left, 0 at rest. */
	directionX = 0,
	/** Sign of vertical travel: 1 moving down, -1 moving up, 0 at rest. */
	directionY = 0,
): number {
	let index = 0;

	for (const entry of boxes) {
		if (entry.id === draggedId) continue;
		const { rect } = entry;

		const hOverlap = Math.min(dragged.right, rect.right) - Math.max(dragged.left, rect.left);
		const vOverlap = Math.min(dragged.bottom, rect.bottom) - Math.max(dragged.top, rect.top);

		const stacked = hOverlap > Math.min(dragged.width, rect.width) * CONTAINMENT;
		const sideBySide = !stacked && vOverlap > 0;

		const isBefore = sideBySide
			? directionX >= 0
				? dragged.right > rect.left + rect.width * SWAP_THRESHOLD
				: dragged.left > rect.right - rect.width * SWAP_THRESHOLD
			: directionY >= 0
				? dragged.bottom > rect.top + rect.height * SWAP_THRESHOLD
				: dragged.top > rect.bottom - rect.height * SWAP_THRESHOLD;

		if (isBefore) index += 1;
	}

	return index;
}

/**
 * Adjusts the heights of several panels by the same amount.
 *
 * Used when a row is resized together: applying a *delta* rather than a common
 * height keeps whatever differences the row already had, so a deliberately
 * shorter panel stays shorter instead of being flattened to match its
 * neighbours. Each panel is still clamped to its own declared minimum.
 */
export function nudgeHeights(
	list: PanelSize[],
	starts: { id: string; h: number }[],
	delta: number,
	specs: Map<string, PanelSpec>,
): PanelSize[] {
	const byId = new Map(starts.map((entry) => [entry.id, entry.h]));
	return list.map((entry) => {
		const from = byId.get(entry.i);
		if (from === undefined) return entry;
		return { ...entry, h: Math.max(specs.get(entry.i)?.minH ?? 1, from + delta) };
	});
}

/**
 * Adjusts the widths of several panels by the same number of columns.
 *
 * The counterpart to `nudgeHeights`, with one extra constraint: a row has only
 * twelve columns, so growth is capped at what is actually free. Without that
 * cap, widening a full row pushes its last panel onto a line of its own — the
 * opposite of what "make this row wider" is asking for. Shrinking needs no cap,
 * and each panel still stops at its own declared minimum.
 */
export function nudgeSpans(
	list: PanelSize[],
	starts: { id: string; span: number }[],
	delta: number,
	specs: Map<string, PanelSpec>,
): PanelSize[] {
	const byId = new Map(starts.map((entry) => [entry.id, entry.span]));
	const used = starts.reduce((sum, entry) => sum + entry.span, 0);
	const spare = Math.floor((BASE_COLS - used) / Math.max(1, starts.length));
	const applied = delta > 0 ? Math.min(delta, Math.max(0, spare)) : delta;

	return list.map((entry) => {
		const from = byId.get(entry.i);
		if (from === undefined) return entry;
		const min = Math.min(specs.get(entry.i)?.minW ?? 1, BASE_COLS);
		return { ...entry, span: Math.max(min, Math.min(from + applied, BASE_COLS)) };
	});
}

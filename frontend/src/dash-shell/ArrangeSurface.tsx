/**
 * The arrange surface — the layout editor.
 *
 * Ported from dashboard-pi's `frontend/src/shell/layout/DashboardCanvas.tsx`,
 * which had already settled this interaction. Kept deliberately close to it:
 * the behaviour below is the product of a lot of small corrections, and each
 * one is recorded where it was made rather than summarised here.
 *
 * Two properties come from the layout having no coordinates:
 *
 *  - **Panels cannot overlap.** They are laid out by CSS in reading order, each
 *    spanning a number of columns. No state could put two in one place, so
 *    there is no collision pass and nothing to repair.
 *  - **Dragging is reordering.** Moving a panel changes its index in a list;
 *    its neighbours reflow because that is what flow layout does.
 *
 * The interaction model:
 *
 *  1. **Select, then act.** Pressing a panel selects it and shows its handles
 *     and size; resize handles arm only on something already selected, so a
 *     stray drag near an edge cannot resize a panel you had not chosen.
 *  2. **The panel follows the pointer**, lifted, while a placeholder holds its
 *     landing slot — the layout never collapses behind the thing being dragged.
 *  3. **Sorting is decided by the dragged panel's own rectangle**, not the
 *     cursor, so a swap happens the moment it covers half its neighbour.
 *  4. **Everything else animates** to its new position, because the eye needs
 *     to see a card travel to believe it moved.
 *  5. **Escape cancels, Ctrl/⌘Z undoes, arrows nudge. Nothing reaches disk
 *     until Save.**
 *
 * Geometry for hit-testing comes from `offsetLeft`/`offsetTop`, which ignore
 * transforms. Measuring with `getBoundingClientRect` while panels are mid-
 * animation reads their *animating* positions and makes the drop target flicker
 * between two indices.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
	GRID_GAP,
	ROW_UNIT,
	themeVariables,
	useLayoutEditing,
	type PanelSize,
} from '../dash-contract';
import {
	BASE_COLS,
	heightUnits,
	indexForRect,
	nudgeHeights,
	nudgeSpans,
	reorder,
	resize,
	resolveBreakpoint,
	setHidden,
	spanFor,
} from './layout-engine';
import { ensureEditorStyles } from './editor-styles';
import { useHistory } from './useHistory';
import type { ShellTransport } from './transport';

/* The rules must be in place before the first paint of an arranging canvas; an
 * effect would let a panel render unstyled for a frame. */
ensureEditorStyles();

/* ---------------------------------- types ---------------------------------- */

/** Reach of the edge and corner resize zones, in px. */
const EDGE = 14;
/** Pointer travel before a press becomes a drag, so a click stays a click. */
const DRAG_THRESHOLD = 4;

type Zone = 'move' | 'right' | 'bottom' | 'corner';

interface DragState {
	zone: Zone;
	id: string;
	startX: number;
	startY: number;
	/** Where inside the panel it was grabbed, so it does not jump under the cursor. */
	grabX: number;
	grabY: number;
	startWidth: number;
	startHeight: number;
	/**
	 * The panels sharing a row with this one, and the size each started at.
	 * Holding shift while resizing grows or shrinks the whole row together.
	 */
	row: { id: string; h: number; span: number }[];
	/** The arrangement before this gesture, for Escape and for the undo stack. */
	snapshot: PanelSize[];
}

/** Layout geometry of one panel, immune to any transform applied to it. */
interface PanelBox {
	id: string;
	element: HTMLElement;
	left: number;
	top: number;
	width: number;
	height: number;
}

/** A rectangle in viewport coordinates, in the shape the hit-test expects. */
const viewportRect = (left: number, top: number, width: number, height: number): DOMRect =>
	({ left, top, width, height, right: left + width, bottom: top + height }) as DOMRect;

const zoneFor = (rect: DOMRect, x: number, y: number, resizable: boolean): Zone => {
	if (!resizable) return 'move';
	const nearRight = rect.right - x < EDGE;
	const nearBottom = rect.bottom - y < EDGE;
	if (nearRight && nearBottom) return 'corner';
	if (nearRight) return 'right';
	if (nearBottom) return 'bottom';
	return 'move';
};

const CURSORS: Record<Zone, string> = {
	move: 'grab',
	right: 'ew-resize',
	bottom: 'ns-resize',
	corner: 'nwse-resize',
};

/* -------------------------------- component -------------------------------- */

export function ArrangeSurface({
	style,
	editing,
	onToggleEditing,
	dashboardId,
	transport,
	arrange = true,
	onProgramChanged,
	children,
}: {
	style: React.CSSProperties;
	editing: boolean;
	onToggleEditing: () => void;
	dashboardId: string;
	transport: ShellTransport;
	/**
	 * Whether the reader may rearrange at all.
	 *
	 * Off in a runtime app, where a dashboard is something to read rather than
	 * something to lay out. Hides the bar entirely — a disabled control still
	 * says "you could do this here", which is not true there.
	 */
	arrange?: boolean;
	/**
	 * Called after a save that changed the program itself, not just its
	 * arrangement.
	 *
	 * Deleting a panel edits `view.tsx` on the server, and the browser is still
	 * running the module it imported when the page loaded — so without this the
	 * panel comes *back*: the old module re-registers it, the arrangement has no
	 * entry for it any more, and it is rebuilt at its default size. Re-fetching
	 * the program is what makes the screen agree with the file.
	 */
	onProgramChanged?: () => void;
	children: React.ReactNode;
}) {
	const { layout, setPanels, panelSpecs } = useLayoutEditing();

	const canvasRef = useRef<HTMLDivElement | null>(null);
	const outlineRef = useRef<HTMLDivElement | null>(null);
	const badgeRef = useRef<HTMLDivElement | null>(null);

	const [canvasWidth, setCanvasWidth] = useState(0);
	const [selected, setSelected] = useState<string | null>(null);
	const [drag, setDrag] = useState<DragState | null>(null);
	const [status, setStatus] = useState<string | null>(null);
	/** The arrangement as it was when Arrange was opened, for Discard. */
	const [baseline, setBaseline] = useState<PanelSize[] | null>(null);
	const [dirty, setDirty] = useState(false);
	/**
	 * Panels this session has already deleted from the program.
	 *
	 * They stay hidden on screen, but they are no longer *pending* — the file has
	 * been rewritten and nothing here can bring them back — so they drop out of
	 * the list that offers to keep them. Closing the editor is what re-fetches
	 * the program and makes the screen agree with the file.
	 */
	const [deleted, setDeleted] = useState<string[]>([]);

	const history = useHistory<PanelSize[]>();
	const historyRef = useRef(history);
	historyRef.current = history;

	const sizes = useMemo(() => layout?.panels ?? [], [layout]);

	/* -------------------------------- geometry -------------------------------- */

	useEffect(() => {
		const element = canvasRef.current;
		if (!element) return;
		const observer = new ResizeObserver(([entry]) => setCanvasWidth(entry?.contentRect.width ?? 0));
		observer.observe(element);
		setCanvasWidth(element.clientWidth);
		return () => observer.disconnect();
	}, []);

	const breakpoint = useMemo(() => resolveBreakpoint(canvasWidth || 1200), [canvasWidth]);
	/* The host already keys the specs by id, so this is that map, not a copy. */
	const specMap = panelSpecs;

	const measure = useCallback((): PanelBox[] => {
		const canvas = canvasRef.current;
		if (!canvas) return [];
		return Array.from(canvas.querySelectorAll<HTMLElement>('[data-panel-id]')).map((element) => ({
			id: element.dataset['panelId'] ?? '',
			element,
			left: element.offsetLeft,
			top: element.offsetTop,
			width: element.offsetWidth,
			height: element.offsetHeight,
		}));
	}, []);

	/**
	 * Renders an arrangement without writing it.
	 *
	 * Every intermediate state of a gesture reaches the screen — that is what
	 * makes dragging feel direct — but none of them reach disk. Save does that,
	 * once, which is what makes Discard and undo mean anything.
	 */
	const show = useCallback(
		(next: PanelSize[]) => {
			setPanels(next, false);
			setDirty(true);
		},
		[setPanels],
	);

	/* ------------------------------ FLIP animation ----------------------------- */

	const boxesRef = useRef<PanelBox[]>([]);
	const dragIdRef = useRef<string | null>(null);
	dragIdRef.current = drag?.id ?? null;

	/**
	 * After any reorder or resize, put each displaced panel back where it was
	 * with a transform, then release it — the browser animates the difference.
	 * Without this the reflow is instantaneous and reads as teleporting.
	 */
	useLayoutEffect(() => {
		const previous = new Map(boxesRef.current.map((box) => [box.id, box]));
		const current = measure();

		for (const box of current) {
			if (box.id === dragIdRef.current) continue;
			const before = previous.get(box.id);
			if (!before) continue;
			const dx = before.left - box.left;
			const dy = before.top - box.top;
			if (dx === 0 && dy === 0) continue;
			box.element.style.transition = 'none';
			box.element.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
		}

		const frame = requestAnimationFrame(() => {
			for (const box of current) {
				if (box.id === dragIdRef.current) continue;
				box.element.style.transition = '';
				box.element.style.transform = '';
			}
		});

		boxesRef.current = current;
		return () => cancelAnimationFrame(frame);
	}, [sizes, breakpoint.cols, measure]);

	/* ------------------------- selection & readout HUD ------------------------- */

	/**
	 * Draws the placeholder and the size readout over a panel's slot.
	 *
	 * Coordinates are canvas-local (`offsetLeft`/`offsetTop`) and the elements are
	 * absolutely positioned inside the canvas — so they travel with the page when
	 * it scrolls, with no scroll listener and no lag. Viewport-fixed positioning
	 * needs recomputing on every scroll event and always trails the content.
	 */
	const paintHud = useCallback(
		(id: string, list: PanelSize[]) => {
			const outline = outlineRef.current;
			const badge = badgeRef.current;
			const canvas = canvasRef.current;
			const node = canvas?.querySelector<HTMLElement>(`[data-panel-id="${CSS.escape(id)}"]`);
			const entry = list.find((item) => item.i === id);
			if (!node) {
				/* The panel is hidden or gone; the marker must go with it. */
				if (outline) outline.hidden = true;
				if (badge) badge.hidden = true;
				return;
			}

			const left = node.offsetLeft;
			const top = node.offsetTop;
			const width = node.offsetWidth;
			const height = node.offsetHeight;

			if (outline) {
				outline.hidden = false;
				outline.style.transform = `translate3d(${left}px, ${top}px, 0)`;
				outline.style.width = `${width}px`;
				outline.style.height = `${height}px`;
			}
			if (badge && entry) {
				badge.hidden = false;
				badge.style.transform = `translate3d(${left + width}px, ${top + height}px, 0)`;
				badge.textContent = `${spanFor(entry.span, specMap.get(id), breakpoint.cols)} of ${
					breakpoint.cols
				} cols · ${entry.h} rows`;
			}
		},
		[specMap, breakpoint.cols],
	);

	const hideHud = useCallback(() => {
		if (outlineRef.current) outlineRef.current.hidden = true;
		if (badgeRef.current) badgeRef.current.hidden = true;
	}, []);

	/**
	 * Keeps the selection marker on the selected panel, and takes it away when
	 * there is nothing selected.
	 *
	 * Erasing matters as much as drawing: hiding a panel clears the selection,
	 * and without this the outline would stay behind on a slot whose panel is no
	 * longer there. A drag paints its own marker, so leave it alone.
	 */
	useLayoutEffect(() => {
		if (drag) return;
		if (!editing || !selected) {
			hideHud();
			return;
		}
		paintHud(selected, sizes);
	}, [editing, selected, drag, sizes, paintHud, hideHud]);

	/* --------------------------- injected editing ----------------------------- */

	const live = useRef({ sizes, cols: breakpoint.cols, specMap, selected });
	live.current = { sizes, cols: breakpoint.cols, specMap, selected };

	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas || !editing) {
			hideHud();
			return;
		}

		const panels = () => Array.from(canvas.querySelectorAll<HTMLElement>('[data-panel-id]'));

		/* Granting the capability is a class; revoking it is removing the class.
		 * The panels themselves know nothing about any of it. */
		const mark = () => {
			for (const panel of panels()) {
				panel.classList.add('dash-editable');
				panel.classList.toggle('is-selected', panel.dataset['panelId'] === live.current.selected);
			}
		};
		mark();
		const observer = new MutationObserver(mark);
		observer.observe(canvas, { childList: true, subtree: true });

		/* Cursor tells you what a press will do before you commit to it. */
		const onHover = (event: PointerEvent) => {
			const target = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-panel-id]');
			if (!target) return;
			const id = target.dataset['panelId'];
			const zone = zoneFor(
				target.getBoundingClientRect(),
				event.clientX,
				event.clientY,
				id === live.current.selected,
			);
			target.style.cursor = CURSORS[zone];
		};

		const onPointerDown = (event: PointerEvent) => {
			if (event.button !== 0) return;
			const target = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-panel-id]');
			const id = target?.dataset['panelId'];

			if (!target || !id) {
				setSelected(null);
				return;
			}

			const rect = target.getBoundingClientRect();
			/* Resize arms only on an already-selected panel — the first press on a
			 * panel is always a selection, never an accidental resize. */
			const zone = zoneFor(rect, event.clientX, event.clientY, id === live.current.selected);

			event.preventDefault();
			setSelected(id);
			const boxes = measure();
			boxesRef.current = boxes;

			/* Row membership comes from the laid-out DOM rather than from the list:
			 * panels that share a row share a top edge, whatever their heights. */
			const top = boxes.find((box) => box.id === id)?.top ?? 0;
			const startSizes = new Map(live.current.sizes.map((entry) => [entry.i, entry]));
			const row = boxes
				.filter((box) => Math.abs(box.top - top) < 2)
				.map((box) => ({
					id: box.id,
					h: startSizes.get(box.id)?.h ?? 1,
					span: startSizes.get(box.id)?.span ?? 1,
				}));

			setDrag({
				zone,
				id,
				startX: event.clientX,
				startY: event.clientY,
				grabX: event.clientX - rect.left,
				grabY: event.clientY - rect.top,
				startWidth: rect.width,
				startHeight: rect.height,
				row,
				snapshot: live.current.sizes,
			});
		};

		canvas.addEventListener('pointermove', onHover);
		canvas.addEventListener('pointerdown', onPointerDown);

		return () => {
			observer.disconnect();
			canvas.removeEventListener('pointermove', onHover);
			canvas.removeEventListener('pointerdown', onPointerDown);
			for (const panel of panels()) {
				panel.classList.remove('dash-editable', 'is-selected', 'is-dragging');
				panel.style.transform = '';
				panel.style.transition = '';
				panel.style.cursor = '';
			}
			hideHud();
		};
	}, [editing, measure, hideHud]);

	/** Opening a session takes a baseline; closing one throws the stacks away. */
	useEffect(() => {
		if (editing) {
			setBaseline(live.current.sizes);
			setDirty(false);
			setStatus(null);
			return;
		}
		setSelected(null);
		setBaseline(null);
		setDirty(false);
		history.reset();
	}, [editing, history]);

	/* ------------------------------- the gesture ------------------------------- */

	/**
	 * Everything the pointer handlers need, in refs.
	 *
	 * The gesture effect below depends on `[drag]` and nothing else on purpose. An
	 * effect that also depends on values changing every render is torn down and
	 * re-created mid-gesture — which resets the lift, clears the transform and
	 * disarms the drag, several times a second. That reads as the panel
	 * vibrating, flickering and snapping back to where it started.
	 */
	const pointerRef = useRef({ x: 0, y: 0 });
	/** Sign of travel per axis, held through brief pauses so a stationary pointer
	 *  keeps the threshold it was last moving against. */
	const directionRef = useRef({ x: 0, y: 0 });
	/** Whether shift is down *right now*, so it can be pressed mid-gesture. */
	const shiftRef = useRef(false);
	const armedRef = useRef(false);
	const paintRef = useRef(paintHud);
	paintRef.current = paintHud;
	const measureRef = useRef(measure);
	measureRef.current = measure;
	const showRef = useRef(show);
	showRef.current = show;

	/** Positions the dragged panel under the pointer from its *current* slot. */
	const anchorDragged = useCallback((state: DragState) => {
		const canvas = canvasRef.current;
		const node = canvas?.querySelector<HTMLElement>(`[data-panel-id="${CSS.escape(state.id)}"]`);
		if (!canvas || !node) return;

		/* offsetLeft/offsetTop ignore transforms, so this is computed fresh each
		 * time rather than accumulated — no drift, and no dependence on the
		 * previous frame's value. */
		const canvasRect = canvas.getBoundingClientRect();
		const x = pointerRef.current.x - state.grabX - (canvasRect.left + node.offsetLeft);
		const y = pointerRef.current.y - state.grabY - (canvasRect.top + node.offsetTop);
		node.style.transform = `translate3d(${x}px, ${y}px, 0)`;
	}, []);

	/**
	 * Re-anchor and repaint after every change, before the browser paints.
	 *
	 * Two jobs, both of which have to happen *after* React has written the new
	 * layout to the DOM:
	 *
	 *  - A reorder moves the dragged panel's slot, so the transform keeping it
	 *    under the cursor is now measured from the wrong origin. Waiting for the
	 *    next pointer event leaves the panel visibly displaced — and if the
	 *    pointer has stopped, no event ever comes and it sits wrong until nudged.
	 *    Only a *move* is anchored: a resize must stay in its slot, and
	 *    translating it there instead drags it out from under its own outline.
	 *  - The placeholder is measured from the real element. Painting it in the
	 *    pointer handler reads the size the panel had *before* the commit, so the
	 *    outline trails the panel by one step for the whole gesture.
	 */
	useLayoutEffect(() => {
		if (!drag) return;
		if (drag.zone === 'move' && armedRef.current) anchorDragged(drag);
		paintRef.current(drag.id, sizes);
	}, [sizes, drag, anchorDragged]);

	useEffect(() => {
		if (!drag) return;
		const canvas = canvasRef.current;
		if (!canvas) return;

		const node = canvas.querySelector<HTMLElement>(`[data-panel-id="${CSS.escape(drag.id)}"]`);
		if (!node) return;

		armedRef.current = drag.zone !== 'move';
		directionRef.current = { x: 0, y: 0 };
		let changed = false;
		let cancelled = false;
		let frame = 0;

		if (armedRef.current) canvas.classList.add('is-resizing');

		const apply = () => {
			frame = 0;
			const { cols, specMap: specsNow, sizes: current } = live.current;
			const pointer = pointerRef.current;

			if (drag.zone !== 'move') {
				const cellWidth = (canvasRef.current!.clientWidth - GRID_GAP * (cols - 1)) / cols;
				const width =
					drag.zone === 'bottom' ? drag.startWidth : drag.startWidth + (pointer.x - drag.startX);
				const height =
					drag.zone === 'right' ? drag.startHeight : drag.startHeight + (pointer.y - drag.startY);
				const span = Math.max(
					1,
					Math.min(Math.round((width + GRID_GAP) / (cellWidth + GRID_GAP)), cols),
				);
				const targetH = heightUnits(height);

				let next = resize(current, drag.id, span, targetH, specsNow.get(drag.id), cols);

				/* Shift resizes the row together — the common case being a row of KPI
				 * cards or charts that should change as a set rather than one at a
				 * time. The delta is taken from what was *asked for*, not from the
				 * clamped result, so one panel sitting on its minimum does not freeze
				 * the rest of the row. */
				if (shiftRef.current && drag.row.length > 1) {
					const start = drag.row.find((entry) => entry.id === drag.id);
					if (drag.zone !== 'right') {
						next = nudgeHeights(next, drag.row, targetH - (start?.h ?? targetH), specsNow);
					}
					if (drag.zone !== 'bottom') {
						const authored = cols === BASE_COLS ? span : Math.round((span / cols) * BASE_COLS);
						next = nudgeSpans(next, drag.row, authored - (start?.span ?? authored), specsNow);
					}
				}

				if (next.some((entry, i) => entry.span !== current[i]?.span || entry.h !== current[i]?.h)) {
					changed = true;
					showRef.current(next);
				}
				return;
			}

			if (!armedRef.current) {
				if (Math.hypot(pointer.x - drag.startX, pointer.y - drag.startY) < DRAG_THRESHOLD) return;
				armedRef.current = true;
				node.classList.add('is-dragging');
				node.style.transition = 'none';
			}

			/* The placeholder holds the slot it will land in, so the layout never
			 * collapses behind the panel being moved; the layout effect above paints
			 * it from the committed DOM. */
			anchorDragged(drag);

			const canvasRect = canvas.getBoundingClientRect();
			const rects = boxesRef.current.map((box) => ({
				id: box.id,
				rect: viewportRect(
					canvasRect.left + box.left,
					canvasRect.top + box.top,
					box.width,
					box.height,
				),
			}));

			/* The panel's apparent rectangle. Its size is frozen at grab time: rows
			 * stretch to their tallest panel, so a live height would change as the
			 * panel enters a new row, moving its centre, changing the sort, changing
			 * the row again — a loop that oscillates instead of settling. */
			const projected = viewportRect(
				pointer.x - drag.grabX,
				pointer.y - drag.grabY,
				drag.startWidth,
				drag.startHeight,
			);

			const index = indexForRect(
				rects,
				projected,
				drag.id,
				directionRef.current.x,
				directionRef.current.y,
			);
			const next = reorder(current, drag.id, index);
			if (next.some((entry, position) => entry.i !== current[position]?.i)) {
				changed = true;
				showRef.current(next);
			}
		};

		/* One update per frame, however fast the pointer reports. */
		const onMove = (event: PointerEvent) => {
			shiftRef.current = event.shiftKey;
			const dx = event.clientX - pointerRef.current.x;
			const dy = event.clientY - pointerRef.current.y;
			/* A deadzone keeps hand tremor from flipping the swap threshold. */
			if (Math.abs(dx) > 1) directionRef.current.x = Math.sign(dx);
			if (Math.abs(dy) > 1) directionRef.current.y = Math.sign(dy);
			pointerRef.current = { x: event.clientX, y: event.clientY };
			if (!frame) frame = requestAnimationFrame(apply);
		};

		const onUp = () => setDrag(null);

		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== 'Escape') return;
			cancelled = true;
			showRef.current(drag.snapshot);
			setDrag(null);
		};

		window.addEventListener('pointermove', onMove);
		window.addEventListener('pointerup', onUp);
		window.addEventListener('pointercancel', onUp);
		window.addEventListener('keydown', onKeyDown);

		return () => {
			if (frame) cancelAnimationFrame(frame);
			window.removeEventListener('pointermove', onMove);
			window.removeEventListener('pointerup', onUp);
			window.removeEventListener('pointercancel', onUp);
			window.removeEventListener('keydown', onKeyDown);

			canvas.classList.remove('is-resizing');
			/* Settle: let the panel animate from wherever the cursor left it back
			 * into its slot, rather than blinking there. */
			armedRef.current = false;
			node.classList.remove('is-dragging');
			node.style.transition = '';
			node.style.transform = '';
			/* A panel grows to fit its content, so a height dragged below it snaps
			 * back to what is actually on screen. */
			if (changed && !cancelled && drag.zone !== 'move') {
				const fits = Math.ceil((node.offsetHeight + GRID_GAP) / (ROW_UNIT + GRID_GAP));
				const current = live.current.sizes;
				if (current.some((entry) => entry.i === drag.id && entry.h < fits)) {
					showRef.current(current.map((entry) => (entry.i === drag.id ? { ...entry, h: fits } : entry)));
				}
			}
			boxesRef.current = measureRef.current();
			if (changed && !cancelled) historyRef.current.commit(drag.snapshot);
		};
	}, [drag, anchorDragged]);

	/** Takes a panel out of the view, or puts it back, as one undoable step. */
	const toggleHidden = useCallback((id: string, hidden: boolean) => {
		const current = live.current.sizes;
		historyRef.current.commit(current);
		showRef.current(setHidden(current, id, hidden));
		if (hidden) setSelected(null);
	}, []);

	/* -------------------------------- keyboard -------------------------------- */

	useEffect(() => {
		if (!editing) return;

		const onKeyDown = (event: KeyboardEvent) => {
			const { sizes: current, cols, specMap: specsNow, selected: id } = live.current;

			/* A dashboard may render its own inputs; typing in one must not reorder
			 * or hide panels behind it. */
			const target = event.target as HTMLElement | null;
			if (target?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target?.tagName ?? '')) {
				return;
			}

			if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
				event.preventDefault();
				const value = event.shiftKey ? history.redo(current) : history.undo(current);
				if (value) show(value);
				return;
			}

			if (event.key === 'Escape') {
				setSelected(null);
				return;
			}

			if ((event.key === 'Delete' || event.key === 'Backspace') && id) {
				event.preventDefault();
				toggleHidden(id, true);
				return;
			}

			if (!id || !event.key.startsWith('Arrow')) return;
			const index = current.findIndex((entry) => entry.i === id);
			if (index === -1 || current[index]?.hidden) return;
			event.preventDefault();

			const entry = current[index]!;
			const spec = specsNow.get(id);

			if (event.shiftKey) {
				const dSpan = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
				const dH = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
				history.commit(current);
				show(resize(current, id, spanFor(entry.span, spec, cols) + dSpan, entry.h + dH, spec, cols));
				return;
			}

			const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1;
			history.commit(current);
			show(reorder(current, id, index + step));
		};

		window.addEventListener('keydown', onKeyDown);
		return () => window.removeEventListener('keydown', onKeyDown);
	}, [editing, history, toggleHidden, show]);

	/* --------------------------------- saving --------------------------------- */

	const save = async () => {
		setStatus('Saving…');
		try {
			const saved = await transport.saveLayout(dashboardId, { version: 1, panels: live.current.sizes });
			/**
			 * The server's arrangement, not the one we sent.
			 *
			 * Saving is what carries out a deletion, so what comes back has the
			 * removed panels gone rather than marked hidden. Adopting it is what
			 * empties the pending list and stops offering them back — they are no
			 * longer in the program to restore.
			 */
			setDirty(false);
			setBaseline(live.current.sizes);
			history.reset();

			/**
			 * Whether that save also rewrote the program.
			 *
			 * Read off the response rather than inferred from what we sent, because
			 * the server is the one that decides — an id staged for deletion that
			 * the view no longer contains is reported and changes nothing. Typed
			 * here rather than on `DashboardLayout`, which is mirrored into the
			 * backend contract and is the reader's file, not a result.
			 *
			 * The arrangement we keep on screen is the one we sent, *not* the one
			 * that came back. The reply no longer has an entry for a deleted panel,
			 * and adopting it would let the still-loaded module put the panel back
			 * at its default size. Ours still says hidden, so the screen stays put
			 * and the re-fetch waits for Done.
			 */
			const removed = (saved as { deleted?: { panels?: string[] } })?.deleted?.panels ?? [];
			if (removed.length) {
				setDeleted((prev) => [...prev, ...removed.filter((id) => !prev.includes(id))]);
				setStatus(`Deleted ${removed.join(', ')}`);
				return;
			}
			setStatus('Saved');
		} catch (error) {
			setStatus((error as Error).message);
		}
	};

	const discard = () => {
		if (baseline) setPanels(baseline, false);
		setDirty(false);
		history.reset();
		setStatus(null);
	};

	/* -------------------------------- rendering -------------------------------- */

	/* Staged, not already carried out — see `deleted`. */
	const hidden = useMemo(
		() => sizes.filter((entry) => entry.hidden && !deleted.includes(entry.i)),
		[sizes, deleted],
	);

	/**
	 * Leaving the editor is when a deletion reaches the screen.
	 *
	 * Re-fetching on save would tear the dashboard down mid-session, which is a
	 * jarring answer to a button called Save. Holding it until Done means the
	 * whole editing session is one uninterrupted thing and the reload lands where
	 * a reload is expected anyway.
	 */
	const leaveEditing = useCallback(() => {
		onToggleEditing();
		if (!editing || deleted.length === 0) return;
		setDeleted([]);
		onProgramChanged?.();
	}, [editing, deleted, onToggleEditing, onProgramChanged]);
	const arrangeable = arrange && panelSpecs.size > 0;
	const canEdit = arrangeable && breakpoint.name !== 'sm';

	return (
		<>
			<div
				className="dash-layout-bar"
				style={{
					...themeVariables,
					padding: `6px ${GRID_GAP}px`,
					marginBottom: 0,
					fontSize: 12,
					fontFamily: 'var(--dash-font, ui-sans-serif, system-ui, sans-serif)',
					color: 'var(--dash-muted)',
					background: 'var(--dash-surface-sunken)',
					display: arrangeable ? undefined : 'none',
				}}
			>
				<div className="dash-layout-meta">
					<span className="dash-tag">
						{breakpoint.name} · {breakpoint.cols} of {BASE_COLS} cols
					</span>
					<span>{panelSpecs.size} panels</span>
					{editing && (
						<span>
							drag to reorder · edges to resize · ⇧drag to size the whole row · arrows to nudge ·
							⇧arrows to size · del to remove · ⌘Z undo · esc cancel
						</span>
					)}
					{status && <span>{status}</span>}
					{/* Not "hidden" any more. Saving deletes these from the program along
					    with any query only they were using, so the list has to say what the
					    button is about to do while there is still a Discard to press. */}
					{editing && hidden.length > 0 && (
						<span className="dash-hidden-list">
							<span>deleted on save:</span>
							{hidden.map((entry) => (
								<button
									key={entry.i}
									type="button"
									className="dash-tag dash-tag-restore"
									title={`Keep "${entry.i}"`}
									onClick={() => toggleHidden(entry.i, false)}
								>
									{entry.i} <span aria-hidden="true">↩</span>
								</button>
							))}
						</span>
					)}
				</div>

				<div className="dash-layout-actions">
					{editing && dirty && (
						<>
							<button type="button" className="dash-button" onClick={discard}>
								Discard
							</button>
							<button type="button" className="dash-button is-primary" onClick={() => void save()}>
								Save layout
							</button>
						</>
					)}
					<button
						type="button"
						className={`dash-button ${editing ? 'is-active' : ''}`}
						disabled={!canEdit}
						title={canEdit ? undefined : 'Panels are full width at this size'}
						onClick={leaveEditing}
					>
						{editing ? 'Done' : 'Arrange'}
					</button>
				</div>
			</div>

			<div
				ref={canvasRef}
				className={`dash-canvas${editing ? ' is-editing' : ''}`}
				style={{ ...style, ['--dash-cols' as string]: breakpoint.cols }}
			>
				{children}

				{/* The placeholder and the size readout. Absolutely positioned inside
				    the canvas, so they take no grid column, cannot disturb what they
				    describe, and travel with the page as it scrolls. */}
				<div ref={outlineRef} className="dash-drop-outline" hidden aria-hidden="true" />
				<div ref={badgeRef} className="dash-size-badge" hidden aria-hidden="true" />
			</div>
		</>
	);
}

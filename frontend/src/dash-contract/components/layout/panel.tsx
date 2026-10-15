/**
 * `<Panel>` — the boundary a dashboard declares around one movable unit.
 *
 * It renders a card and nothing else. It has no idea the dashboard can be
 * rearranged: no drag handlers, no resize handle, no edit state. It says "this
 * is one unit, here is its id, and it needs at least this much room", and the
 * arrange surface injects everything interactive from outside.
 */
import { createContext, useState, type ReactNode } from 'react';
import type { ContractMeta } from '../../meta';
import { usePanelHost, usePanelSize } from '../../context';
import { GRID_COLUMNS, GRID_GAP, PANEL_PADDING, ROW_UNIT, T } from '../../theme';
import { SPACE, type Space } from './flow';

export { GRID_COLUMNS, GRID_GAP, ROW_UNIT };

const PADDING = { sm: 10, md: PANEL_PADDING } as const;

/**
 * Lets content inside a panel ask it to grow to fit. Every panel now grows to
 * fit its content, so this is kept only for callers such as `FilterBar`.
 */
export const PanelFitContext = createContext<((fit: boolean) => void) | null>(null);
const alwaysFits = () => {};

export interface PanelProps {
	id: string;
	title?: string;
	subtitle?: string;
	minW: number;
	minH: number;
	defaultW: number;
	defaultH: number;
	/** Space between the items inside. */
	gap?: Space;
	padding?: keyof typeof PADDING;
	children: ReactNode;
}

/**
 * The layout unit. Declares how much room it wants; never where it goes.
 *
 * Position comes from document flow in source order, so **two panels
 * overlapping is not a state this can express** — no packing pass, no collision
 * check, and a narrow breakpoint reflows for free.
 *
 * The reader's stored size wins where there is one, clamped to the minimums the
 * author declared; otherwise the declared default applies. That is the whole of
 * `reconcile`, done per panel, and it is why an agent can add a panel without
 * touching `layout.json`.
 */
export function Panel({ id, title, subtitle, minW, minH, defaultW, defaultH, gap = 'md', padding = 'md', children }: PanelProps) {
	/**
	 * Note what is *not* read here: whether the dashboard is being arranged.
	 *
	 * A panel declares a boundary and a minimum size and renders a card. It has
	 * no drag handlers, no resize handle, no edit flag. Everything interactive is
	 * granted from outside — the arrange surface adds a class to this element and
	 * takes it away again — so a dashboard cannot know it is being rearranged,
	 * and what you see with the editor closed is exactly the finished dashboard.
	 */
	const { registerPanel, orderOf, selectPanel, selectedPanel } = usePanelHost();

	/**
	 * Hover, tracked here rather than in CSS.
	 *
	 * A panel's styles are inline, so there is no `:hover` to hang this on, and
	 * the runtime deliberately ships no stylesheet. The listeners are attached
	 * only when a host is listening for a selection — with no `selectPanel` this
	 * component is exactly what it was, which is the property the note above is
	 * about.
	 */
	const [hovered, setHovered] = useState(false);

	/**
	 * Declared during render, exactly as a parameter is, and for the same
	 * reason: the sizes this panel permits are needed by the very reconcile that
	 * decides how big it ends up.
	 */
	registerPanel({ id, title, minW, minH, defaultW, defaultH });

	const stored = usePanelSize(id);
	if (stored?.hidden) return null;

	const span = Math.min(GRID_COLUMNS, Math.max(minW, stored?.span ?? defaultW));
	const rows = Math.max(minH, stored?.h ?? defaultH);
	const height = rows * ROW_UNIT + Math.max(0, rows - 1) * GRID_GAP;

	return (
		<section
			data-panel-id={id}
			onMouseEnter={selectPanel ? () => setHovered(true) : undefined}
			onMouseLeave={selectPanel ? () => setHovered(false) : undefined}
			style={{
				/**
				 * Reading order as CSS `order`.
				 *
				 * This is what lets a reader reorder panels without the shell
				 * reaching into the view program's JSX: the author's markup stays
				 * exactly as written, and the grid lays it out in the reader's order.
				 */
				order: orderOf(id),
				gridColumn: `span ${span} / span ${span}`,
				/* A minimum, not a fixed height: the panel grows to fit its content. */
				minHeight: height,
				position: 'relative',
				display: 'flex',
				flexDirection: 'column',
				background: T.surface,
				border: `1px solid ${T.line}`,
				borderRadius: T.radius,
				padding: PADDING[padding],
				overflow: 'hidden',
				fontFamily: T.font,
				color: T.fg,
				boxSizing: 'border-box',
				touchAction: 'none',
			}}
		>
			{/**
			 * The selection target.
			 *
			 * Top right rather than inside the header, because a panel is allowed
			 * to have no title and would then have no header to put it in. On hover
			 * only, so a finished dashboard reads as a dashboard; once selected it
			 * stays visible, because a control that vanishes when you move away
			 * gives you no way to tell what is attached.
			 */}
			{selectPanel && (hovered || selectedPanel === id) && (
				<button
					type="button"
					aria-label={selectedPanel === id ? `${title ?? id} is attached to the chat` : `Discuss ${title ?? id}`}
					title={selectedPanel === id ? 'Attached to the chat' : 'Discuss this panel'}
					onClick={(event) => {
						event.stopPropagation();
						selectPanel({ id, title, minW, minH, defaultW, defaultH });
					}}
					style={{
						position: 'absolute',
						top: 6,
						right: 6,
						zIndex: 2,
						display: 'inline-flex',
						alignItems: 'center',
						gap: 4,
						height: 22,
						padding: '0 8px',
						border: `1px solid ${selectedPanel === id ? T.accent : T.line}`,
						borderRadius: 999,
						background: selectedPanel === id ? T.accent : T.surface,
						color: selectedPanel === id ? '#fff' : T.muted,
						font: 'inherit',
						fontSize: 11,
						fontFamily: T.font,
						lineHeight: 1,
						cursor: 'pointer',
					}}
				>
					{selectedPanel === id ? 'Attached' : 'Discuss'}
				</button>
			)}

			{(title || subtitle) && (
				/**
				 * A panel title is a label, not a heading.
				 *
				 * It was 14px semibold at full contrast, which competes with the number
				 * or chart underneath it — on a page of twelve panels the titles read
				 * first and the data second. Smaller, medium weight and secondary
				 * colour puts it where it belongs.
				 */
				<header style={{ marginBottom: 14, flex: '0 0 auto' }}>
					{title && (
						<div style={{ fontSize: 12.5, fontWeight: 500, color: T.muted, letterSpacing: 0.1 }}>
							{title}
						</div>
					)}
					{subtitle && (
						<div style={{ fontSize: 11.5, color: T.faint, marginTop: 3 }}>{subtitle}</div>
					)}
				</header>
			)}
			{/**
			 * The panel clips. It does not scroll.
			 *
			 * This was `overflow: auto`, which meant every panel grew its own pair
			 * of scrollbars the moment its content did not fit — and while a reader
			 * drags a panel smaller, nothing fits for a frame or two. Dragging one
			 * corner produced scrollbars on every panel it touched, and a table,
			 * which scrolls internally, ended up inside a second scroller.
			 *
			 * A panel is a fixed window onto one thing. Content that genuinely has
			 * more to show owns that itself — DataTable scrolls its own body, and a
			 * chart resizes to whatever room it is given. `minHeight: 0` stays: it
			 * is what lets a flex child actually shrink rather than pushing the
			 * panel's own box open from the inside.
			 */}
			{/**
			 * A column with a gap, so a panel holding more than one thing spaces them
			 * itself.
			 *
			 * The container owns the spacing between its children — the same choice
			 * `Grid` already makes, at the same 12px. Without it a filter bar sat
			 * flush against the card below it and read as one welded block, and the
			 * alternative is every generated view hand-rolling a margin onto whatever
			 * happens to come first.
			 *
			 * `gap` applies only *between* children, so a panel with one chart or one
			 * table is spaced exactly as it was.
			 */}
			<div
				style={{
					flex: '1 1 auto',
					minHeight: 0,
					minWidth: 0,
					overflow: 'hidden',
					display: 'flex',
					flexDirection: 'column',
					gap: SPACE[gap],
				}}
			>
				<PanelFitContext.Provider value={alwaysFits}>{children}</PanelFitContext.Provider>
			</div>
		</section>
	);
}

/* ------------------------------- structure --------------------------------- */


Panel.Metadata = {
	kind: 'structure',
	purpose: 'One movable unit. Every top-level thing in a view must be wrapped in one.',
	useWhen: 'Always. A component outside a Panel cannot be sized, moved or hidden.',
	props: {
		id: {
			description: 'Stable identifier, unique within the dashboard.',
			importance: 'required',
			caution:
				'The key a saved arrangement stores against — treat it as a database id, not a label. ' +
				'Renaming it loses that panel’s placement.',
		},
		defaultW: {
			description: 'Starting width, in columns out of 12.',
			importance: 'required',
			group: 'size',
			caution: 'There is no `span` prop. That is a field name inside a stored layout.json entry, which a view never writes.',
		},
		defaultH: {
			description: 'Starting height, in row units.',
			importance: 'required',
			group: 'size',
			caution: 'There is no `h` prop, for the same reason as `span`.',
		},
		minW: {
			description: 'Smallest width a reader may drag it to. Roughly half the default.',
			importance: 'required',
			group: 'size',
		},
		minH: {
			description: 'Smallest height a reader may drag it to.',
			importance: 'required',
			group: 'size',
		},
		title: {
			description: 'Shown above the content.',
			importance: 'recommended',
			caution: 'A panel with no title makes the reader infer what they are looking at from the data alone.',
		},
		subtitle: { description: 'A qualifier under the title — the filter in force, say.' },
		gap: { description: '"none" | "sm" | "md" | "lg" — space between the items inside.', default: 'md' },
		padding: { description: '"sm" | "md" — space inside the border.', default: 'md' },
		children: { description: 'What the panel contains.', importance: 'required' },
	},
	notes:
		'Sizes that work: a filter bar defaultW={12} defaultH={2}, a single metric defaultW={3} ' +
		'defaultH={3}, a chart defaultW={6} defaultH={7}, a wide table defaultW={12} defaultH={8}. ' +
		'Panels declare size, never position — order on screen is source order. ' +
		'Items inside take their natural height; charts, tables and loading states take the room left, ' +
		'so changing defaultH resizes only those.',
} satisfies ContractMeta;

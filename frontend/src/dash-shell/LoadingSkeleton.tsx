/**
 * The dashboard, in outline, while it loads.
 *
 * Opening a dashboard is two requests: the metadata, which carries the reader's
 * saved arrangement, and then the compiled view, which is the slow one. The
 * arrangement lands in the first few hundred milliseconds and the view takes
 * seconds — so for nearly the whole wait the canvas already knows how many
 * panels there are, how wide each one is and how tall.
 *
 * That is what makes this worth building rather than showing a generic shimmer:
 * the boxes are the real panels at their real sizes, so the page settles into
 * the dashboard instead of being replaced by a different-shaped one.
 *
 * A dashboard nobody has ever rearranged has no saved arrangement — its sizes
 * are declared in the module still being fetched — so those get `FALLBACK`, a
 * shape common enough to be a reasonable guess and neutral enough not to look
 * like a promise.
 */
import { useMemo } from 'react';
import type { PanelSize } from '../dash-contract/types';
import { GRID_COLUMNS, GRID_GAP, PANEL_PADDING, ROW_UNIT, T } from '../dash-contract/theme';

const STYLE_ID = 'dash-skeleton-styles';

/**
 * Injected from a string, like the arrange editor's stylesheet and for the same
 * reason: the platform loads this project's JS bundle and nothing else, so a
 * `.css` file emitted beside it never arrives.
 *
 * A sweep needs keyframes, which inline styles cannot express. Everything else
 * here stays inline.
 */
const CSS = `
.dash-skeleton-block {
	position: relative;
	overflow: hidden;
	border-radius: 6px;
	background: var(--dash-surface-sunken, #f6f7f9);
}

.dash-skeleton-block::after {
	content: '';
	position: absolute;
	inset: 0;
	transform: translateX(-100%);
	background: linear-gradient(
		90deg,
		transparent 0%,
		var(--dash-line, #e3e6ea) 50%,
		transparent 100%
	);
	animation: dash-skeleton-sweep 1.5s ease-in-out infinite;
}

@keyframes dash-skeleton-sweep {
	to { transform: translateX(100%); }
}

/* A sweep crossing the screen every second and a half is exactly the kind of
   motion this setting exists to stop. The tint alone still reads as loading. */
@media (prefers-reduced-motion: reduce) {
	.dash-skeleton-block::after { animation: none; background: none; }
}
`;

function ensureSkeletonStyles(): void {
	if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
	const style = document.createElement('style');
	style.id = STYLE_ID;
	style.textContent = CSS;
	document.head.appendChild(style);
}

/** Four tiles over two wide panels — what a generated dashboard usually is. */
const FALLBACK: ReadonlyArray<{ span: number; h: number }> = [
	{ span: 3, h: 3 },
	{ span: 3, h: 3 },
	{ span: 3, h: 3 },
	{ span: 3, h: 3 },
	{ span: 6, h: 7 },
	{ span: 6, h: 7 },
];

/** The same arithmetic `Panel` does, so a box lands where its panel will. */
const heightOf = (rows: number): number => rows * ROW_UNIT + Math.max(0, rows - 1) * GRID_GAP;

export function DashboardSkeleton({
	style,
	panels,
}: {
	/** The canvas's own grid style, so the columns and gaps cannot drift. */
	style: React.CSSProperties;
	/** The saved arrangement, when the metadata has already arrived. */
	panels: PanelSize[] | null;
}) {
	ensureSkeletonStyles();

	const boxes = useMemo(() => {
		const stored = panels?.filter((panel) => !panel.hidden) ?? [];
		return stored.length
			? stored.map((panel) => ({
					key: panel.i,
					span: Math.min(GRID_COLUMNS, Math.max(1, panel.span)),
					h: Math.max(1, panel.h),
				}))
			: FALLBACK.map((panel, index) => ({ key: `fallback-${index}`, ...panel }));
	}, [panels]);

	return (
		<div
			style={style}
			/* One busy region with one label, rather than a dozen boxes each
			 * announcing themselves — a screen reader should hear "loading", not
			 * the shape of a dashboard that is not there yet. */
			role="status"
			aria-busy="true"
			aria-label="Loading dashboard"
		>
			{boxes.map((box) => (
				<div
					key={box.key}
					aria-hidden="true"
					style={{
						gridColumn: `span ${box.span} / span ${box.span}`,
						height: heightOf(box.h),
						display: 'flex',
						flexDirection: 'column',
						gap: 12,
						/* The real panel's own chrome, so only the contents are missing
						 * and the swap is a fill rather than a redraw. */
						background: T.surface,
						border: `1px solid ${T.line}`,
						borderRadius: T.radius,
						padding: PANEL_PADDING,
						boxSizing: 'border-box',
					}}
				>
					<div className="dash-skeleton-block" style={{ height: 11, width: '42%', flex: '0 0 auto' }} />
					<div className="dash-skeleton-block" style={{ flex: '1 1 auto', minHeight: 0 }} />
				</div>
			))}
		</div>
	);
}

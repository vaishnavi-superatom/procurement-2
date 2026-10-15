/**
 * The arrange-mode stylesheet, injected from JavaScript.
 *
 * Ported from dashboard-pi's `frontend/src/styles.css`, with two forced
 * changes:
 *
 *  - **It ships as a string, not a `.css` file.** The platform loads this
 *    project's JS bundle and nothing else (`Loading bundle from …/index-*.js`),
 *    so a stylesheet emitted beside it never arrives. Injecting it here means
 *    the editor cannot be half-present: the code that needs the rules carries
 *    them.
 *  - **It selects on `[data-panel-id]`, not on a panel class.** A `<Panel>` in
 *    this contract has no idea the dashboard can be rearranged — no drag
 *    handlers, no edit flag, no class of its own. Everything below is granted
 *    by the container adding a class to elements it did not write, and revoked
 *    by removing it. With the editor closed, not one of these rules matches.
 *
 * Colours come from the contract's `--dash-*` tokens so the editor inherits the
 * dashboard's theme rather than carrying a second palette that can drift.
 */

const STYLE_ID = 'dash-layout-editor-styles';

const CSS = `
/* -------------------------------- the canvas ------------------------------- */

.dash-canvas { position: relative; }

/* The column guides, shown only while arranging. */
.dash-canvas.is-editing {
	background-image: repeating-linear-gradient(
		to right, var(--dash-line) 0 1px, transparent 1px 100%);
	background-size: calc((100% + 16px) / var(--dash-cols, 12)) 100%;
	border-radius: 12px;
}

/* Brighter guides while a resize is in flight — the columns are what you are
   aiming at, so they come forward exactly when they matter. */
.dash-canvas.is-resizing {
	background-image: repeating-linear-gradient(
		to right,
		color-mix(in srgb, var(--dash-accent) 28%, transparent) 0 1px,
		transparent 1px 100%);
}

/* --------------------------------- panels ---------------------------------- */

/* Panels animate to their new slot. Without this the reflow is instantaneous
   and reads as teleporting — the eye needs to see a card travel to believe it
   moved. Transform only: it is compositor-only, so it keeps up with a drag. */
[data-panel-id] { transition: transform 260ms cubic-bezier(0.2, 0.9, 0.25, 1); }

[data-panel-id].dash-editable { user-select: none; }
[data-panel-id].dash-editable:hover {
	border-color: color-mix(in srgb, var(--dash-accent) 55%, var(--dash-line));
}

/**
 * Nothing inside a panel is interactive while arranging.
 *
 * A chart's tooltip, a table's scrollbar and a filter's dropdown all swallow
 * the pointer, and a drag that begins on one of them never reaches the canvas.
 * Killing pointer events on the *contents* leaves the panel itself as the event
 * target, which is precisely what the hit-test wants. Closing the editor
 * restores every one of them.
 */
.dash-canvas.is-editing [data-panel-id] * { pointer-events: none !important; }
.dash-canvas.is-editing [data-panel-id] { overflow: hidden; }

/* Selection: the panel you are acting on, with its handles. Only a selected
   panel arms its resize edges, so a stray drag cannot resize the wrong thing. */
[data-panel-id].is-selected {
	border-color: var(--dash-accent) !important;
	box-shadow: 0 0 0 1px var(--dash-accent);
}
[data-panel-id].is-selected::before,
[data-panel-id].is-selected::after {
	content: '';
	position: absolute;
	background: var(--dash-accent);
	border: 2px solid var(--dash-surface);
	border-radius: 3px;
	box-sizing: content-box;
	z-index: 3;
}
/* Right edge: width. */
[data-panel-id].is-selected::before {
	right: -5px; top: 50%; width: 4px; height: 18px; margin-top: -11px;
}
/* Bottom-right corner: both. */
[data-panel-id].is-selected::after {
	right: -5px; bottom: -5px; width: 8px; height: 8px;
}

/* Lifted and following the pointer. It leaves flow visually but keeps its slot,
   which is what the drop outline is drawn around. */
[data-panel-id].is-dragging {
	cursor: grabbing;
	z-index: 10;
	pointer-events: none;
	border-color: var(--dash-accent) !important;
	box-shadow: 0 18px 44px rgba(0, 0, 0, 0.28);
	opacity: 0.94;
}

/* ------------------------------ the HUD layer ------------------------------ */

/* Where it will land. Absolutely positioned inside the canvas, so it takes no
   grid column, cannot disturb what it describes, and travels with the page as
   it scrolls — no scroll listener, no lag. */
.dash-drop-outline {
	position: absolute;
	left: 0; top: 0;
	z-index: 4;
	pointer-events: none;
	border: 2px dashed var(--dash-accent);
	border-radius: 12px;
	background: color-mix(in srgb, var(--dash-accent) 8%, transparent);
	/* Animated on transform rather than left/top: a compositor-only property, so
	   the placeholder keeps up with a fast drag instead of trailing it. */
	transition: transform 180ms cubic-bezier(0.2, 0.9, 0.25, 1),
		width 180ms cubic-bezier(0.2, 0.9, 0.25, 1),
		height 180ms cubic-bezier(0.2, 0.9, 0.25, 1);
}

.dash-size-badge {
	position: absolute;
	left: 0; top: 0;
	z-index: 11;
	margin: 6px 0 0 -4px;
	pointer-events: none;
	transition: transform 180ms cubic-bezier(0.2, 0.9, 0.25, 1);
	padding: 3px 8px;
	border-radius: 6px;
	background: var(--dash-accent);
	color: #fff;
	font-size: 11px;
	font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
	white-space: nowrap;
}

/* ------------------------------- the tool bar ------------------------------ */

.dash-layout-bar {
	display: flex; align-items: center; justify-content: space-between;
	gap: 12px; flex-wrap: wrap; margin-bottom: 14px;
}
.dash-layout-meta { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.dash-layout-actions { display: flex; align-items: center; gap: 8px; }
.dash-hidden-list { display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; }

.dash-button {
	padding: 5px 12px;
	border: 1px solid var(--dash-line);
	border-radius: 8px;
	background: var(--dash-surface);
	color: var(--dash-fg);
	font: inherit; font-size: 12px; cursor: pointer;
}
.dash-button:hover:not(:disabled) { border-color: var(--dash-accent); }
.dash-button:disabled { opacity: 0.5; cursor: default; }
.dash-button.is-active { border-color: var(--dash-accent); color: var(--dash-accent); }
.dash-button.is-primary {
	background: var(--dash-accent); border-color: var(--dash-accent); color: #fff;
}

.dash-tag {
	padding: 3px 8px; border: 1px solid var(--dash-line); border-radius: 6px;
	font-size: 11px; color: var(--dash-muted);
}
.dash-tag-restore {
	cursor: pointer; font-family: ui-monospace, monospace;
	border-style: dashed; background: none;
}
.dash-tag-restore:hover { color: var(--dash-accent); border-color: var(--dash-accent); }
`;

/**
 * Injected once per document, at module scope rather than from an effect.
 *
 * The rules must be in place before the first paint of an arranging canvas; an
 * effect would let a panel render unstyled for a frame.
 */
export function ensureEditorStyles(): void {
	if (typeof document === 'undefined') return;
	if (document.getElementById(STYLE_ID)) return;
	const style = document.createElement('style');
	style.id = STYLE_ID;
	style.textContent = CSS;
	document.head.appendChild(style);
}

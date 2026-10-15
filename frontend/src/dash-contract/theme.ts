/**
 * Design tokens for the dashboard contract.
 *
 * Self-contained on purpose. A compiled dashboard module is loaded at runtime
 * and never passes through the host's CSS build, so these components cannot
 * rely on utility classes or on the surrounding app's tokens — they carry their
 * own and expose them as CSS custom properties, which is what makes a theme one
 * place rather than a hundred inline colours.
 *
 * Two forms of every token, and both are needed: `css` for anything rendered as
 * DOM (which follows a theme switch for free) and `resolved` for ECharts, which
 * paints to a canvas and cannot read a custom property.
 */

/* --------------------------------- palettes -------------------------------- */

/**
 * Categorical series colours.
 *
 * Taken from the platform's own `CHART_COLOR_PALETTE`
 * (`design-system/tokens.ts`), in its order, so a dashboard built here sits
 * beside the platform's other charts without looking like a different product.
 * Blue leads because the common case is a single series, and the first colour
 * is the only one most charts ever use.
 *
 * **Copied rather than imported.** The contract is self-contained by design: a
 * compiled dashboard module is loaded at runtime and never passes through the
 * host's build, so it carries its own tokens. Importing the host's design system
 * here would tie every generated dashboard to the app that happens to be
 * rendering it.
 *
 * The platform's list runs to thirty. Ten is the honest maximum: past that a
 * reader is matching swatches to a legend rather than reading a chart, which is
 * why the charts bucket the tail into a named "Other" instead of cycling. The
 * ten kept are the platform's first seven — which are genuinely distinct — plus
 * three from later that do not collide with them.
 */
export const CATEGORICAL = [
	'#4A7FFF', '#4ADE80', '#FB923C', '#C084FC', '#22D3EE',
	'#FF6B4A', '#FBBF24', '#EC4899', '#14B8A6', '#84CC16',
] as const;

/** Low → high, for a single measure. */
export const SEQUENTIAL = ['#eef3ff', '#cfdcff', '#a9c1ff', '#7fa2ff', '#4A7FFF', '#2d5bd1'] as const;

/**
 * For measures with a meaningful zero — margin, variance, growth.
 *
 * The midpoint has to be pinned to zero by the caller; a diverging scale
 * centred on the data's mean is a diverging scale that lies.
 */
export const DIVERGING = ['#b3261e', '#e08b7f', '#f2ded9', '#cfe3dd', '#6fb3a0', '#1c7c66'] as const;

export const SENTIMENT = {
	positive: '#1c7c66',
	negative: '#b3261e',
	warning: '#c07600',
	neutral: '#6b7280',
} as const;

/**
 * Soft card backgrounds — a tint, never a fill.
 *
 * A named set rather than a free colour, for the same reason `tone` is: twelve
 * KPIs with twelve invented hex codes stop reading as one page. These are the
 * palette's own hues at the lightness a background needs, so a tinted card sits
 * behind text that was designed against white and stays legible.
 */
export const SURFACE_TINT = {
	none: 'transparent',
	accent: '#eef3ff',
	positive: '#e9f5f1',
	negative: '#fdecea',
	warning: '#fdf4e6',
	muted: '#f4f6f8',
} as const;

export type SurfaceTint = keyof typeof SURFACE_TINT;

/* --------------------------------- tokens ---------------------------------- */

/** CSS custom-property references, for anything rendered as DOM. */
export const T = {
	fg: 'var(--dash-fg, #303d46)',
	muted: 'var(--dash-muted, #5f6672)',
	faint: 'var(--dash-faint, #9199a5)',
	line: 'var(--dash-line, #e3e6ea)',
	lineStrong: 'var(--dash-line-strong, #ccd1d8)',
	surface: 'var(--dash-surface, #ffffff)',
	surfaceSunken: 'var(--dash-surface-sunken, #f6f7f9)',
	accent: 'var(--dash-accent, #4A7FFF)',
	positive: `var(--dash-positive, ${SENTIMENT.positive})`,
	negative: `var(--dash-negative, ${SENTIMENT.negative})`,
	warning: `var(--dash-warning, ${SENTIMENT.warning})`,
	radius: 'var(--dash-radius, 10px)',
	font: 'var(--dash-font, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif)',
	mono: 'var(--dash-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
} as const;

/**
 * Literal values, for canvas.
 *
 * Kept beside the CSS forms rather than derived, because reading a computed
 * style per render to feed a chart is both slow and a source of flicker on the
 * first paint.
 */
export const RESOLVED = {
	/**
	 * Body text is a soft blue-grey, not near-black.
	 *
	 * It was `#16181d` — effectively black — which puts every label, number and
	 * title at maximum contrast at once and reads as harsh on a page of twelve
	 * panels. Measured against Metabase, whose primary text is `hsl(205 19% 23%)`
	 * ≈ `#303d46`: a desaturated blue at less than a quarter lightness.
	 *
	 * The whole ramp below is hue-shifted the same way (195–205°) rather than
	 * neutral grey, which is what keeps a page of them looking like one family
	 * instead of muddy.
	 */
	fg: '#303d46',
	muted: '#5f6672',
	faint: '#9199a5',
	line: '#e3e6ea',
	/**
	 * Grid lines inside a chart, deliberately lighter than the panel border.
	 *
	 * At the same value they were, the chart's interior carried the same visual
	 * weight as the frame around it, so twelve panels read as a grid of boxes
	 * rather than as twelve charts.
	 */
	gridLine: '#eef0f3',
	surface: '#ffffff',
} as const;

/**
 * Chart typography.
 *
 * `label` was 10px, which is below comfortable reading and the first thing that
 * makes a chart feel cramped. Metabase uses 13px for axis ticks, series labels
 * and goal-line labels alike; 12 is the same decision one step conservative,
 * since our panels are often narrower than a Metabase card.
 */
export const CHART = {
	label: 12,
	axisTitle: 12,
	legend: 12,
	note: 11,
} as const;

/** One row unit and the gap between panels. Heights are exact multiples. */
/** A panel's inner padding. Shared: `Metric`'s tint bleeds out by exactly this. */
export const PANEL_PADDING = 18;

export const ROW_UNIT = 44;
export const GRID_GAP = 16;
export const GRID_COLUMNS = 12;

/** Applied to the canvas container so every token above resolves. */
export const themeVariables: Record<string, string> = {
	'--dash-fg': RESOLVED.fg,
	'--dash-muted': RESOLVED.muted,
	'--dash-faint': RESOLVED.faint,
	'--dash-line': RESOLVED.line,
	'--dash-line-strong': '#ccd1d8',
	'--dash-surface': RESOLVED.surface,
	'--dash-surface-sunken': '#f6f7f9',
	'--dash-accent': '#4A7FFF',
	'--dash-positive': SENTIMENT.positive,
	'--dash-negative': SENTIMENT.negative,
	'--dash-warning': SENTIMENT.warning,
};

/** Colour for series `i`, honouring an explicit override. */
export const seriesColor = (i: number, override?: string): string =>
	override ?? CATEGORICAL[i % CATEGORICAL.length]!;

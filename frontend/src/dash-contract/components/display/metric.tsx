/**
 * One number, large, with a label.
 *
 * The value is raw and nullable on purpose: an aggregate over an empty set is
 * NULL, and `?? 0` turns "nothing here" into a figure that is simply false.
 * Only the formatter knows how to say "no data".
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ContractMeta } from '../../meta';
import { formatRaw, formatValue } from '../../format';
import { SENTIMENT, SURFACE_TINT, T, type SurfaceTint } from '../../theme';
import type { ScalarValue, ValueFormat } from '../../types';
import { itemStyle } from '../layout/flow';

export interface MetricProps {
	label: string;
	/**
	 * Raw, and **nullable on purpose**.
	 *
	 * An aggregate over an empty set returns NULL, and a caller who writes
	 * `?? 0` turns "no data" into a figure that is simply false. Only the
	 * formatter knows how to say "nothing here", so it gets the raw value.
	 */
	value: ScalarValue;
	format?: ValueFormat;
	sublabel?: string;
	tone?: 'neutral' | 'positive' | 'negative';
	/** A tinted card, from a named set rather than a free colour. */
	surface?: SurfaceTint;
	/** Draw the label at the same weight as the figure. */
	strongLabel?: boolean;
	/** The figure's size. "fill" scales it to the room it is given. */
	size?: MetricSize;
	labelSize?: 'sm' | 'md';
	/** "stacked": label above the figure. "inline": label and figure on one line. */
	layout?: 'stacked' | 'inline';
}

export type MetricSize = 'sm' | 'md' | 'lg' | 'xl' | 'fill';

const FIGURE: Record<Exclude<MetricSize, 'fill'>, number> = { sm: 16, md: 22, lg: 28, xl: 36 };
const LABEL = { sm: 11, md: 12 } as const;

export function Metric({
	label,
	value,
	format,
	sublabel,
	tone = 'neutral',
	surface = 'none',
	strongLabel = false,
	size,
	labelSize = 'md',
	layout = 'stacked',
}: MetricProps) {
	/**
	 * Without a size, a metric alone in its container fills it, and one beside
	 * other items is "md" — so a sibling appearing or going never resizes it.
	 */
	const root = useRef<HTMLDivElement>(null);
	const [sole, setSole] = useState(true);
	useLayoutEffect(() => {
		const next = (root.current?.parentElement?.childElementCount ?? 1) === 1;
		if (next !== sole) setSole(next);
	});
	const fill = size === 'fill' || (size === undefined && sole);
	const missing = value === null || value === undefined;
	const colour = missing
		? T.faint
		: tone === 'positive'
			? SENTIMENT.positive
			: tone === 'negative'
				? SENTIMENT.negative
				: T.fg;

	/**
	 * `format.align` positions the whole metric, not just the number.
	 *
	 * The property is declared on `ValueFormat` and was read only by `DataTable`,
	 * for column alignment. That made it a trap: asked to centre a KPI, an agent
	 * reasonably found `align` on the format it was already passing, set it, saw
	 * it typecheck and publish, and reported success — while nothing moved. A
	 * declared option that silently does nothing in the place someone would
	 * naturally reach for it is worse than one that does not exist.
	 *
	 * Label and value move together, because a centred number under a
	 * left-aligned label reads as a mistake rather than a choice.
	 */
	const align = format?.align ?? 'left';
	const items = align === 'center' ? 'center' : align === 'right' ? 'flex-end' : 'flex-start';

	/**
	 * The number scales to the room it is given.
	 *
	 * It was 30px whether the panel was three columns tall or ten, so a KPI given
	 * a big card looked lost in it — a headline figure should own its panel, and
	 * at a fixed size it never can. Measured rather than derived from the panel's
	 * declared height, because a panel can be resized by the reader after render
	 * and the declared height stops being true the moment they do.
	 *
	 * Bands rather than a continuous scale: a number that changes size smoothly
	 * while dragging is distracting, and four sizes cover every panel worth
	 * putting a metric in.
	 */
	const box = useRef<HTMLDivElement>(null);
	const [scaled, setScaled] = useState(30);

	useEffect(() => {
		const element = box.current;
		if (!fill || !element || typeof ResizeObserver === 'undefined') return;
		const observer = new ResizeObserver(([entry]) => {
			const h = entry?.contentRect.height ?? 0;
			setScaled(h < 84 ? 22 : h < 124 ? 30 : h < 190 ? 38 : 46);
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, [fill]);

	const figure = fill ? scaled : FIGURE[(size ?? 'md') as keyof typeof FIGURE];
	const inline = layout === 'inline';

	return (
		/**
		 * The tint is scoped to THIS metric, and the wrapper is what scopes it.
		 *
		 * It used to be an absolutely positioned div with no positioned parent of
		 * its own, so `inset: 0` resolved against the first ancestor that had a
		 * position — the panel's `<section>`. That was deliberate and correct while
		 * a tinted metric was always the only thing in its panel: the tint reached
		 * under the panel's padding and the panel clipped its corners.
		 *
		 * It is destructive the moment one shares a panel with anything else. An
		 * opaque `#eef3ff` sized to the whole panel paints over the filter bar and
		 * every sibling metric, leaving only this one visible because its own
		 * content div is relatively positioned and therefore above it. That shipped:
		 * a three-metric card rendered as one metric on a blue field.
		 *
		 * The cost of scoping it is that a lone KPI's tint now stops at its own box
		 * instead of bleeding to the panel edge. A tint that is 18px short is a
		 * cosmetic loss; one that hides its neighbours is a broken dashboard.
		 */
		<div ref={root} style={{ position: 'relative', ...itemStyle({ grow: fill }), ...(surface !== 'none' && !fill ? { padding: '8px 10px' } : null) }}>
			{surface !== 'none' && (
				<div
					aria-hidden
					style={{
						position: 'absolute',
						inset: 0,
						background: SURFACE_TINT[surface],
						borderRadius: 8,
					}}
				/>
			)}
		<div
			ref={box}
			style={{
				/* Above the tint, which is painted first. */
				position: 'relative',
				display: 'flex',
				flexDirection: inline ? 'row' : 'column',
				justifyContent: inline ? 'space-between' : 'center',
				alignItems: inline ? 'baseline' : items,
				gap: inline ? 8 : 0,
				textAlign: align,
				height: fill ? '100%' : undefined,
			}}
		>
			<div style={{ fontSize: LABEL[labelSize], fontWeight: strongLabel ? 600 : 400, color: strongLabel ? T.fg : T.muted }}>
				{label}
			</div>
			<div
				/* The exact figure on hover, when the display shortened it. */
				title={formatRaw(value, format)}
				style={{
					fontSize: missing ? Math.round(figure * 0.66) : figure,
					fontWeight: 600,
					color: colour,
					lineHeight: 1.15,
					marginTop: inline ? 0 : 4,
				}}
			>
				{formatValue(value, format)}
			</div>
			{sublabel && <div style={{ fontSize: 11, color: T.faint, marginTop: 4 }}>{sublabel}</div>}
		</div>
		</div>
	);
}

/* -------------------------------- metadata --------------------------------- */

/**
 * What each export tells the agent about itself.
 *
 * Grouped here rather than scattered through the file because these are sixteen
 * small components; the coupling still holds, because a `Metadata` assignment
 * for a component that no longer exists is a compile error rather than a stale
 * description nobody notices.
 */


Metric.Metadata = {
	kind: 'display',
	purpose: 'One number, large, with a label.',
	useWhen: 'A single headline figure — a total, a count, a rate.',
	props: {
		label: {
			description: 'What the number is.',
			importance: 'required',
			caution: 'Include the qualifier the figure actually carries — "Budget, 3 + 9" not "Budget".',
		},
		value: {
			description: 'The raw number, or null when there is none.',
			importance: 'required',
			caution:
				'Never write `?? 0`. An aggregate over an empty set returns NULL, and turning that into ' +
				'a zero states something false. Pass it raw and let the format say "no data".',
		},
		format: {
			description: 'Pass the resolver’s column format so the figure reads as money, a percentage or a count.',
			importance: 'recommended',
			caution: 'Without it a currency renders as a bare number and the reader supplies the wrong unit.',
		},
		sublabel: {
			description: 'A smaller line under the figure — the comparison, the period, the caveat.',
		},
		surface: {
			description:
				'"none" | "accent" | "positive" | "negative" | "warning" | "muted" — tints this metric’s ' +
				'own box.',
			default: 'none',
			caution:
				'A named set, not a colour. Use it to mark one or two figures out on a page — a page ' +
				'where every KPI is tinted has no emphasis left.',
		},
		strongLabel: {
			description: 'Draw the label at the same weight as the figure.',
			default: false,
			caution:
				'Off by default on purpose: the number is meant to win the panel, and a bold label ' +
				'competes with it. Turn it on when the label is the thing being scanned — a row of ' +
				'KPIs read as a list of names rather than a list of figures.',
		},
		tone: {
			description: '"neutral" | "positive" | "negative".',
			default: 'neutral',
			caution:
				'Tone is a judgement about whether the number is good, which depends on the measure. ' +
				'Costs rising is negative; revenue rising is not.',
		},
		size: {
			description: '"sm" | "md" | "lg" | "xl" | "fill" — the figure size. "fill" scales it to the room it is given.',
			group: 'size',
			caution: 'Unset: "fill" when the metric is alone in its container, "md" beside other items. Change this prop to resize a figure, not the panel height.',
		},
		labelSize: { description: '"sm" | "md".', default: 'md', group: 'size' },
		layout: {
			description: '"stacked" (label above the figure) | "inline" (label and figure on one line).',
			default: 'stacked',
			group: 'size',
		},
	},
	notes:
		'A metric is its natural height and never grows, so other items in the panel cannot change its size. ' +
		'`format.align` positions the whole metric, and `surface` tints the whole card.',
} satisfies ContractMeta;

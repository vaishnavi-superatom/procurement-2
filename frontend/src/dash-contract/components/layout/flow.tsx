/**
 * How things share the room inside a panel.
 *
 * A panel body is a column. Each item takes the height its content needs; only
 * an item that grows takes the room left over. Charts, tables and the status
 * states grow by default, text and metrics never do — so removing a line of
 * text or resizing a panel changes the chart, never the size of a number.
 */
import type { CSSProperties, ReactNode } from 'react';
import type { ContractMeta } from '../../meta';

export type Space = 'none' | 'sm' | 'md' | 'lg';

export const SPACE: Record<Space, number> = { none: 0, sm: 6, md: 12, lg: 20 };

/** The least a table shrinks to without a fixed `height`. It scrolls inside. */
export const TABLE_MIN_HEIGHT = 200;

/**
 * The flex style of one item in a panel, a Stack or a Row.
 *
 * `height` on an item that grows is a **floor**, not a cap: a chart told to be
 * 240px tall is at least that, and takes the extra when the reader drags the
 * panel taller. Otherwise `grow` takes the leftover room, never less than
 * `minHeight`, and an item that does not grow is its natural size and never
 * shrinks.
 */
export function itemStyle({
	grow,
	height,
	minHeight = 0,
}: {
	grow: boolean;
	height?: number;
	minHeight?: number;
}): CSSProperties {
	if (height != null) {
		return grow
			? { flex: '1 1 auto', minHeight: height, minWidth: 0 }
			: { flex: '0 0 auto', height, minHeight: 0, minWidth: 0 };
	}
	if (grow) return { flex: '1 1 0', height: '100%', minHeight, minWidth: 0 };
	return { flex: '0 0 auto', minWidth: 0 };
}

type Align = 'start' | 'center' | 'end' | 'stretch';
type Justify = 'start' | 'center' | 'end' | 'between';

const ALIGN: Record<Align, CSSProperties['alignItems']> = { start: 'flex-start', center: 'center', end: 'flex-end', stretch: 'stretch' };
const JUSTIFY: Record<Justify, CSSProperties['justifyContent']> = { start: 'flex-start', center: 'center', end: 'flex-end', between: 'space-between' };

interface FlowProps {
	children: ReactNode;
	gap?: Space;
	align?: Align;
	justify?: Justify;
	grow?: boolean;
}

export const Stack = ({ children, gap = 'md', align = 'stretch', justify = 'start', grow = false }: FlowProps) => (
	<div
		style={{
			...itemStyle({ grow }),
			display: 'flex',
			flexDirection: 'column',
			gap: SPACE[gap],
			alignItems: ALIGN[align],
			justifyContent: JUSTIFY[justify],
		}}
	>
		{children}
	</div>
);

export const Row = ({ children, gap = 'md', align = 'center', justify = 'start', grow = false, wrap = false }: FlowProps & { wrap?: boolean }) => (
	<div
		style={{
			...itemStyle({ grow }),
			display: 'flex',
			flexDirection: 'row',
			flexWrap: wrap ? 'wrap' : 'nowrap',
			gap: SPACE[gap],
			alignItems: ALIGN[align],
			justifyContent: JUSTIFY[justify],
		}}
	>
		{children}
	</div>
);

const FLOW_PROPS = {
	children: { description: 'What to lay out.', importance: 'required' },
	gap: { description: '"none" | "sm" | "md" | "lg" — space between items.', default: 'md' },
	justify: { description: '"start" | "center" | "end" | "between" — placement along the flow.', default: 'start' },
	grow: {
		description: 'Take the room left over in the parent.',
		default: false,
		caution: 'Set it when a chart or table inside has no `height` — without room of its own it draws nothing.',
	},
} as const;

Stack.Metadata = {
	kind: 'structure',
	purpose: 'Items one under another, each at its natural height.',
	useWhen: 'A group of items inside a panel that should stay together — a metric block, a label over a chart.',
	props: {
		...FLOW_PROPS,
		align: { description: '"start" | "center" | "end" | "stretch" — across the width.', default: 'stretch' },
	},
} satisfies ContractMeta;

Row.Metadata = {
	kind: 'structure',
	purpose: 'Items side by side on one line.',
	useWhen: 'Small figures or labels on one line — "Hard 120 h · Soft 40 h", a pair of metrics.',
	props: {
		...FLOW_PROPS,
		align: { description: '"start" | "center" | "end" | "stretch" — across the height.', default: 'center' },
		wrap: { description: 'Wrap onto more lines when the width runs out.', default: false },
	},
	notes: 'An item with `grow` takes an equal share of the width.',
} satisfies ContractMeta;

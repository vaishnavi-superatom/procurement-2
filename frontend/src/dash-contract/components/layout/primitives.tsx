/**
 * The small structural pieces — a heading, a box, a row of columns, a paragraph.
 *
 * Grouped in one file because each is a handful of lines and a folder of
 * six-line files is harder to read than one short file, not easier.
 */
import type { ReactNode } from 'react';
import type { ContractMeta } from '../../meta';
import { T } from '../../theme';
import { SPACE, type Space } from './flow';

const fixed = { flex: '0 0 auto', minWidth: 0 } as const;

export const Card = ({ children }: { children: ReactNode }) => (
	<div style={{ ...fixed, border: `1px solid ${T.line}`, borderRadius: 8, padding: 12 }}>{children}</div>
);

export const Grid = ({ columns = 2, gap = 'md', children }: { columns?: number; gap?: Space; children: ReactNode }) => (
	<div style={{ ...fixed, display: 'grid', gridTemplateColumns: `repeat(${columns}, 1fr)`, gap: SPACE[gap] }}>
		{children}
	</div>
);

export const Heading = ({ children, level = 2 }: { children: ReactNode; level?: 1 | 2 | 3 }) => (
	<div style={{ ...fixed, fontSize: level === 1 ? 20 : level === 2 ? 16 : 14, fontWeight: 600 }}>
		{children}
	</div>
);

const TEXT_SIZE = { xs: 11, sm: 12, md: 13, lg: 15 } as const;
const TEXT_TONE = { default: T.fg, muted: T.muted, positive: T.positive, negative: T.negative } as const;

export const Text = ({
	children,
	size = 'md',
	tone = 'default',
	weight = 'normal',
	align = 'left',
}: {
	children: ReactNode;
	size?: keyof typeof TEXT_SIZE;
	tone?: keyof typeof TEXT_TONE;
	weight?: 'normal' | 'bold';
	align?: 'left' | 'center' | 'right';
}) => (
	<div
		style={{
			...fixed,
			fontSize: TEXT_SIZE[size],
			color: TEXT_TONE[tone],
			fontWeight: weight === 'bold' ? 600 : 400,
			textAlign: align,
			lineHeight: 1.5,
		}}
	>
		{children}
	</div>
);


Card.Metadata = {
	kind: 'structure',
	purpose: 'A plain bordered surface for grouping content inside a panel.',
	props: {
		children: { description: 'What the card contains.', importance: 'required' },
	},
	notes:
		'A Panel already draws its own border, so a Card directly inside one is a box in a box. ' +
		'Reach for it when a panel holds several things that need separating.',
} satisfies ContractMeta;

Grid.Metadata = {
	kind: 'structure',
	purpose: 'Columns inside one panel.',
	props: {
		columns: { description: 'How many equal columns.', default: 2 },
		gap: { description: '"none" | "sm" | "md" | "lg" — space between cells.', default: 'md' },
		children: { description: 'What to lay out.', importance: 'required' },
	},
	notes:
		'Not the dashboard grid — that is Panel’s own width. This lays out within a single panel, ' +
		'for a row of small figures or a pair of lists. A chart or table in a cell needs a `height`.',

} satisfies ContractMeta;

Heading.Metadata = {
	kind: 'structure',
	purpose: 'A heading, levels 1 to 3.',
	props: {
		level: { description: '1, 2 or 3.', default: 2 },
		children: { description: 'The heading text.', importance: 'required' },
	},
	notes: 'A panel already has a `title` — reach for this only for a heading *inside* one.',
} satisfies ContractMeta;

Text.Metadata = {
	kind: 'structure',
	purpose: 'A line or paragraph of text.',
	props: {
		children: { description: 'The text.', importance: 'required' },
		size: { description: '"xs" | "sm" | "md" | "lg".', default: 'md' },
		tone: { description: '"default" | "muted" | "positive" | "negative".', default: 'default' },
		weight: { description: '"normal" | "bold".', default: 'normal' },
		align: { description: '"left" | "center" | "right".', default: 'left' },
	},
} satisfies ContractMeta;

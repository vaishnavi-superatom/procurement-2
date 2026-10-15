/**
 * The three states every data-bound panel must handle.
 *
 * A panel that renders nothing when a query returns nothing is indistinguishable
 * from a broken one, which is why these are part of the contract rather than
 * left to each generated program to invent.
 */
import type { CSSProperties, ReactNode } from 'react';
import type { ContractMeta } from '../../meta';
import { T } from '../../theme';
import { itemStyle } from '../layout/flow';

/* --------------------------------- states ---------------------------------- */

const centred: CSSProperties = {
	...itemStyle({ grow: true, minHeight: 80 }),
	display: 'flex',
	flexDirection: 'column',
	alignItems: 'center',
	justifyContent: 'center',
	textAlign: 'center',
	gap: 4,
};

export const Loading = ({ label }: { label?: string }) => (
	<div style={{ ...centred, color: T.faint, fontSize: 12 }}>{label ?? 'Loading…'}</div>
);

/**
 * Empty is a *state*, not an error, and must never be mistaken for zero.
 *
 * The hint matters more than it looks: "no rows" with no suggestion reads as a
 * broken panel, and the reader's next move is to report a bug.
 */
export const EmptyState = ({ title, hint }: { title: string; hint?: string }) => (
	<div style={{ ...centred, color: T.muted }}>
		<div style={{ fontSize: 13, fontWeight: 500 }}>{title}</div>
		{hint && <div style={{ fontSize: 12, color: T.faint }}>{hint}</div>}
	</div>
);

export const ErrorNote = ({ error, retry }: { error: unknown; retry?: () => void }) => {
	const err = error as { code?: string; message?: string; hint?: string } | null;
	return (
		<div style={{ ...centred, color: T.negative, gap: 6 }}>
			<div style={{ fontSize: 13, fontWeight: 500 }}>{err?.message ?? 'Something went wrong'}</div>
			{err?.hint && <div style={{ fontSize: 12, color: T.muted }}>{err.hint}</div>}
			{err?.code && <div style={{ fontSize: 11, color: T.faint }}>{err.code}</div>}
			{retry && (
				<button
					onClick={retry}
					style={{
						marginTop: 4,
						fontSize: 12,
						padding: '4px 10px',
						borderRadius: 6,
						border: `1px solid ${T.line}`,
						background: 'transparent',
						color: T.fg,
						cursor: 'pointer',
					}}
				>
					Try again
				</button>
			)}
		</div>
	);
};

/* --------------------------------- metric ---------------------------------- */


Loading.Metadata = {
	kind: 'status',
	purpose: 'A spinner with an optional label.',
	props: { label: { description: 'What is being waited for.', default: 'Loading…' } },
	useWhen: 'A short wait where the shape of the result is not yet known.',
} satisfies ContractMeta;

EmptyState.Metadata = {
	kind: 'status',
	purpose: 'A resolver succeeded and returned nothing.',
	props: {
		title: {
			description: 'What is absent, in the reader’s terms.',
			importance: 'required',
			caution: '"No rows" tells them nothing. "No budget for this country" tells them what to change.',
		},
		hint: {
			description: 'What to try next — a filter to widen, a version to switch.',
			importance: 'recommended',
			caution: 'Without a hint, an empty panel reads as broken rather than as a filter with no matches.',
		},
	},
	notes:
		'Empty is not an error and must not render as one. A filter combination with no rows is a ' +
		'normal answer, and saying "something went wrong" about it is a lie.',
} satisfies ContractMeta;

ErrorNote.Metadata = {
	kind: 'status',
	purpose: 'A resolver failed, with a retry.',
	props: {
		error: {
			description: 'The error from usePanelData — pass it whole.',
			importance: 'required',
			caution: 'Pass the error itself, not a message you wrote: it carries a code the reader’s support can act on.',
		},
		retry: {
			description: 'Pass state.refresh so the reader can try again.',
			importance: 'recommended',
			caution: 'The prop is `retry`, not `onRetry`. Without it the panel is a dead end.',
		},
	},
	notes: 'Every panel must handle loading, empty and error. All three, every time.',
} satisfies ContractMeta;

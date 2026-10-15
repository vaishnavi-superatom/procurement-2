/**
 * The canvas — loads a compiled dashboard and renders it.
 *
 * Its whole job is four things: publish the contract runtime, fetch the module,
 * import it, and put it inside a `DashboardHost` on a twelve-column grid. The
 * dashboard itself does the rest.
 *
 * The grid is CSS grid with `grid-auto-flow: row dense` left off deliberately:
 * panels declare a span and a height and are placed in source order, so the
 * browser does the packing and **overlap is not a state anything here can
 * produce**. No collision pass, no compaction, and a narrow viewport reflows on
 * its own.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import { Icon } from '@iconify/react';
import {
	DashboardHost,
	GRID_COLUMNS,
	GRID_GAP,
	loadDashboardModule,
	publishRuntime,
	isRuntimePublished,
	themeVariables,
	type DashboardLayout,
	type ParamValue,
} from '../dash-contract';
import type { DashboardInfo, ShellTransport } from './transport';
import { ArrangeSurface } from './ArrangeSurface';
import { DashboardSkeleton } from './LoadingSkeleton';
import { ViewErrorBoundary } from './ViewErrorBoundary';

/* --------------------------- runtime publication --------------------------- */

/**
 * Published once, before any module is imported.
 *
 * Module scope rather than an effect: a compiled dashboard reads the global at
 * import time, and an effect would let a `loadDashboardModule` call from
 * somewhere else win the race. `publishRuntime` throws on a missing export, so
 * a gap surfaces at boot rather than as `undefined` inside a panel.
 */
if (!isRuntimePublished()) publishRuntime();

/* ---------------------------------- state ---------------------------------- */

/**
 * There is no `invalid` phase, deliberately.
 *
 * There used to be one: a red card listing guard violations, on the theory that
 * whoever sees it is the person who can fix it. That was true when a broken
 * program could reach a reader — `./validate` only compiled, so a view with
 * wrong props passed the guard and published.
 *
 * It cannot now. `./validate` typechecks and `./publish` refuses anything that
 * fails, so a dashboard that reaches this canvas has already been proven to
 * compile and typecheck. A violation card would be diagnostics for a state the
 * publish gate no longer allows — shown to a reader who did not write it and
 * cannot act on it.
 *
 * Anything not yet built renders as empty. The place to find out why something
 * was refused is the conversation that was refused, where the agent is told
 * exactly what to change.
 */
type Phase =
	| { kind: 'loading' }
	| { kind: 'ready'; View: ComponentType; info: DashboardInfo }
	| { kind: 'empty'; info: DashboardInfo }
	| { kind: 'error'; message: string };

export interface DashboardCanvasProps {
	dashboardId: string;
	transport: ShellTransport;
	/** Initial parameter values, e.g. parsed from the URL. */
	initialParams?: Record<string, ParamValue>;
	onParamsChange?: (values: Record<string, ParamValue>) => void;
	/** Rendered above the grid — a title bar, an agent panel, whatever. */
	header?: React.ReactNode;
	/** Whether the reader may rearrange. Off in a runtime app — see ArrangeSurface. */
	arrange?: boolean;
	/**
	 * Called when a panel is attached to, or detached from, whatever is having a
	 * conversation about this dashboard. `null` means detached.
	 *
	 * Supplying it is what turns the feature on: with no listener, panels draw no
	 * selection target and a finished dashboard is unchanged.
	 */
	onPanelSelect?: (panel: { id: string; title?: string } | null) => void;
	/**
	 * The panel currently attached, as the caller understands it.
	 *
	 * The canvas keeps no copy of this. It used to, and the chat's own remove
	 * button then cleared the chip while the panel went on wearing its ring —
	 * one question with two answers. Only whoever renders the conversation knows
	 * when a turn has been sent and the attachment has therefore been spent, so
	 * that side owns the answer and this is how it tells the canvas.
	 */
	selectedPanelId?: string | null;
}

export function DashboardCanvas({
	dashboardId,
	transport,
	initialParams,
	onParamsChange,
	header,
	arrange = true,
	onPanelSelect,
	selectedPanelId = null,
}: DashboardCanvasProps) {
	const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
	/* Off by default — see ArrangeBar. */
	const [editing, setEditing] = useState(false);

	/**
	 * Clicking the target reports a toggle rather than recording one.
	 *
	 * Clicking the attached panel again detaches it, which is the gesture's own
	 * undo. What that does to the ring arrives back down as `selectedPanelId`,
	 * so the canvas cannot end up showing something the chat disagrees with.
	 */
	const attach = useCallback(
		(spec: { id: string; title?: string }) => {
			onPanelSelect?.(selectedPanelId === spec.id ? null : { id: spec.id, title: spec.title });
		},
		[selectedPanelId, onPanelSelect],
	);

	/* Arranging is a different question about the same panel, so attaching one
	 * and then opening the editor lets go of it rather than keeping a selection
	 * nothing is showing. */
	useEffect(() => {
		if (!editing || selectedPanelId == null) return;
		onPanelSelect?.(null);
	}, [editing, selectedPanelId, onPanelSelect]);

	/* Escape detaches, matching every other transient selection in the product. */
	useEffect(() => {
		if (selectedPanelId == null) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== 'Escape') return;
			onPanelSelect?.(null);
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, [selectedPanelId, onPanelSelect]);
	const [layout, setLayout] = useState<DashboardLayout | null>(null);

	/** Modules already imported this session, by content hash. */
	const modules = useRef(new Map<string, ComponentType>());

	const load = useCallback(async () => {
		setPhase({ kind: 'loading' });
		try {
			const info = await transport.get(dashboardId);

			/**
			 * A response that is not the agreed shape is its own failure, and a
			 * distinguishable one.
			 *
			 * Without this check a double-wrapped or renamed payload reads as
			 * `valid: undefined` and is reported as "the dashboard did not
			 * compile" — sending whoever sees it to debug a dashboard that is
			 * perfectly fine. Naming the real problem costs three lines.
			 */
			if (!info || typeof info.valid !== 'boolean') {
				setPhase({
					kind: 'error',
					message:
						`The server's response for "${dashboardId}" was not the expected shape ` +
						`(no boolean "valid"). Received: ${JSON.stringify(info)?.slice(0, 200) ?? 'nothing'}`,
				});
				return;
			}

			setLayout(info.layout ?? null);

			if (!info.valid) {
				setPhase({ kind: 'empty', info });
				return;
			}

			const cached = modules.current.get(info.viewVersion);
			if (cached) {
				setPhase({ kind: 'ready', View: cached, info });
				return;
			}

			const res = await transport.module(dashboardId, undefined);
			if (!res.valid || !res.code) {
				setPhase({ kind: 'empty', info });
				return;
			}

			const mod = await loadDashboardModule(res.code);
			const View = mod.default;
			if (typeof View !== 'function') {
				setPhase({ kind: 'error', message: 'The dashboard module has no default-exported component.' });
				return;
			}

			modules.current.set(res.version ?? info.viewVersion, View);
			setPhase({ kind: 'ready', View, info });
		} catch (err) {
			setPhase({ kind: 'error', message: (err as Error)?.message ?? String(err) });
		}
	}, [dashboardId, transport]);

	useEffect(() => {
		void load();
	}, [load]);

	const grid = useMemo<React.CSSProperties>(
		() => ({
			display: 'grid',
			gridTemplateColumns: `repeat(${GRID_COLUMNS}, minmax(0, 1fr))`,
			gap: GRID_GAP,
			alignItems: 'start',
			padding: GRID_GAP,
			...themeVariables,
			fontFamily: 'var(--dash-font, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif)',
			background: 'var(--dash-surface-sunken)',
			minHeight: '100%',
			boxSizing: 'border-box',
		}),
		[],
	);

	/* `layout` is set by the metadata request, which lands well before the module
	 * — so this is the real arrangement for most of the wait, and null only for
	 * the first moment or for a dashboard nobody has rearranged. */
	if (phase.kind === 'loading') return <DashboardSkeleton style={grid} panels={layout?.panels ?? null} />;

	if (phase.kind === 'error') {
		return <Centered tone="error">{phase.message}</Centered>;
	}

	if (phase.kind === 'empty') return <EmptyDashboard title={phase.info?.title} />;

	const { View, info } = phase;

	/** Resolvers that failed to compile fail their own panels, not the page. */
	const brokenResolvers = info.resolvers.filter((r) => r.errors.length);

	return (
		<div style={{ height: '100%', overflow: 'auto', ...themeVariables }}>
			{header}
			{brokenResolvers.length > 0 && (
				<div
					style={{
						margin: `${GRID_GAP}px ${GRID_GAP}px 0`,
						padding: '8px 12px',
						fontSize: 12,
						borderRadius: 8,
						border: '1px solid var(--dash-warning)',
						color: 'var(--dash-warning)',
						background: 'var(--dash-surface)',
					}}
				>
					{brokenResolvers.length} resolver{brokenResolvers.length > 1 ? 's are' : ' is'} blocked —
					panels using {brokenResolvers.length > 1 ? 'them' : 'it'} will show an error:{' '}
					{brokenResolvers.map((r) => r.name).join(', ')}
				</div>
			)}
			<ViewErrorBoundary
				resetKey={info.viewVersion}
				fallback={(error, retry) => (
					<Centered tone="error">
						<div>
							<div>This dashboard hit an error while rendering: {error.message}</div>
							<button type="button" onClick={retry} style={buttonStyle}>
								Try again
							</button>
						</div>
					</Centered>
				)}
			>
			<DashboardHost
				dashboardId={dashboardId}
				transport={transport}
				layout={layout}
				/* Carries each resolver's content hash, so a panel whose query was
				 * republished re-fetches. The view's own hash does not change when a
				 * resolver does — that is deliberate — so without this an edited
				 * query is invisible until a reload. */
				resolvers={info.resolvers}
				initialParams={initialParams}
				onParamsChange={onParamsChange}
				editing={editing}
				selectPanel={onPanelSelect ? attach : undefined}
				selectedPanel={selectedPanelId}
			>
				<ArrangeSurface
					style={grid}
					arrange={arrange}
					editing={editing}
					onToggleEditing={() => setEditing((value) => !value)}
					dashboardId={dashboardId}
					transport={transport}
					onProgramChanged={load}
				>
					<View />
				</ArrangeSurface>
			</DashboardHost>
			</ViewErrorBoundary>
		</div>
	);
}

/* --------------------------------- chrome ---------------------------------- */

const buttonStyle: React.CSSProperties = {
	marginTop: 8,
	fontSize: 12,
	padding: '5px 12px',
	borderRadius: 6,
	border: '1px solid var(--dash-line)',
	background: 'transparent',
	color: 'var(--dash-fg)',
	cursor: 'pointer',
};

const Centered = ({ children, tone }: { children: React.ReactNode; tone?: 'error' }) => (
	<div
		style={{
			...themeVariables,
			display: 'flex',
			alignItems: 'center',
			justifyContent: 'center',
			height: '100%',
			minHeight: 240,
			fontSize: 13,
			color: tone === 'error' ? 'var(--dash-negative)' : 'var(--dash-muted)',
			fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
			textAlign: 'center',
			padding: 24,
		}}
	>
		{children}
	</div>
);

/**
 * Nothing built here yet.
 *
 * It used to be a dashed box pinned to the top-left of the grid, which read as a
 * broken panel rather than as an invitation — the one state where the page has
 * nothing to show is the one where it should look deliberate. So: the full
 * container, centred, on a faint grid of the panels that are not there yet.
 *
 * The background is inline SVG rather than an asset. This component is compiled
 * into a bundle that the platform mounts by name, and a file reference would
 * have to resolve from wherever that bundle is served — a URL this side does not
 * know. It is also two shapes and a pattern; a request would cost more than the
 * markup.
 */
function EmptyDashboard({ title }: { title?: string }) {
	return (
		<div
			style={{
				...themeVariables,
				position: 'relative',
				display: 'flex',
				flexDirection: 'column',
				alignItems: 'center',
				justifyContent: 'center',
				height: '100%',
				minHeight: 320,
				overflow: 'hidden',
				textAlign: 'center',
				padding: 32,
				fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
			}}
		>
			<svg
				aria-hidden="true"
				style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
			>
				<defs>
					<pattern id="dash-empty-grid" width="32" height="32" patternUnits="userSpaceOnUse">
						<path d="M32 0H0V32" fill="none" stroke="var(--dash-line)" strokeWidth="1" opacity="0.5" />
					</pattern>
					{/* Fades the grid out at the edges so it reads as texture, not as a table. */}
					<radialGradient id="dash-empty-fade" cx="50%" cy="45%" r="60%">
						<stop offset="0%" stopColor="white" stopOpacity="1" />
						<stop offset="100%" stopColor="white" stopOpacity="0" />
					</radialGradient>
					<mask id="dash-empty-mask">
						<rect width="100%" height="100%" fill="url(#dash-empty-fade)" />
					</mask>
				</defs>
				<rect width="100%" height="100%" fill="url(#dash-empty-grid)" mask="url(#dash-empty-mask)" />
			</svg>

			{/**
			 * Three icons, in the accent, on a tinted disc each.
			 *
			 * Iconify, the same `@iconify/react` every other component in this
			 * bundle uses. Three rather than one because a single icon reads as a
			 * status glyph — a row of them reads as the kinds of thing that could
			 * go here, which is the actual message.
			 */}
			<div style={{ position: 'relative', display: 'flex', gap: 10, marginBottom: 20 }}>
				{[
					{ icon: 'lucide:bar-chart-3', opacity: 0.55 },
					{ icon: 'lucide:layout-dashboard', opacity: 1 },
					{ icon: 'lucide:table-2', opacity: 0.55 },
				].map(({ icon, opacity }) => (
					<div
						key={icon}
						style={{
							display: 'flex',
							alignItems: 'center',
							justifyContent: 'center',
							width: 46,
							height: 46,
							borderRadius: 12,
							border: '1px solid var(--dash-line)',
							background: 'var(--dash-surface)',
							color: 'var(--dash-accent, #4A7FFF)',
							opacity,
						}}
					>
						<Icon icon={icon} width={22} />
					</div>
				))}
			</div>

			<div style={{ position: 'relative', fontWeight: 600, fontSize: 16, color: 'var(--dash-fg)' }}>
				{title ? `${title} is empty` : 'Nothing here yet'}
			</div>
			<div
				style={{
					position: 'relative',
					marginTop: 6,
					maxWidth: 420,
					fontSize: 13,
					lineHeight: 1.5,
					color: 'var(--dash-muted)',
				}}
			>
				Start building your dashboard — describe what you want to see.
			</div>
		</div>
	);
}

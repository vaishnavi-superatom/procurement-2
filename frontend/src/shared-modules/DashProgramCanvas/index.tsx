/**
 * `DashProgramCanvas` — the program-dashboard flow, as a bundle component.
 *
 * This is the seam between the two repos. The platform UI renders it by name
 * through `BundleComponentWrapper`, which mounts it with **the bundle's own
 * `mount()`** so it runs inside the bundle's React instance.
 *
 * That isolation is why the whole dashboard runtime has to live on this side.
 * A compiled dashboard module reads React off the runtime global, and
 * `publishRuntime()` runs here — so the React a generated program gets is the
 * bundle's, the same one its components were built against. Publishing from the
 * platform UI instead would hand a dashboard a second React whose hook
 * dispatcher belongs to a different renderer, and every hook it calls would
 * fail in a way that is very hard to read.
 *
 * The transport comes from `window.SA_WEB_SDK_CLIENT`, which the platform sets
 * during connection — the same client every other collection call uses.
 */
import { useEffect, useMemo, useState } from 'react';
import type { ComponentMetadata } from '../../types';
import { DashboardCanvas } from '../../dash-shell/DashboardCanvas';
import { createSdkTransport, type ShellTransport } from '../../dash-shell/transport';
import type { ParamValue } from '../../dash-contract';

interface DashProgramCanvasProps {
	/** Folder name under the backend's `dashboard-programs/`. */
	dashboardId?: string;
	/** Seed values, e.g. from the page's URL. A list arrives as `a,b`. */
	initialParams?: Record<string, ParamValue>;
	onParamsChange?: (values: Record<string, ParamValue>) => void;
	/** Whether the reader may rearrange. Off in a runtime app. */
	arrange?: boolean;
	/**
	 * Called when a panel is attached to the conversation, or detached.
	 *
	 * The platform's builder page passes one so a person can point at a panel and
	 * then talk about it. Every other host leaves it out, and panels then draw no
	 * selection target at all.
	 */
	onPanelSelect?: (panel: { id: string; title?: string } | null) => void;
	/**
	 * The panel the host currently considers attached. Passed straight through.
	 *
	 * The host owns this because it is the side that knows when the attachment
	 * has been spent — sending the message is what ends it.
	 */
	selectedPanelId?: string | null;
}

export default function DashProgramCanvas({
	dashboardId = 'demo',
	arrange = true,
	initialParams,
	onParamsChange,
	onPanelSelect,
	selectedPanelId,
}: DashProgramCanvasProps) {
	/**
	 * The client is set during the platform's connection flow, which may not have
	 * finished when this first renders. Polling briefly beats failing outright:
	 * the alternative is an error card whose only cause is arriving early.
	 */
	const [client, setClient] = useState<unknown>(
		() => (window as unknown as { SA_WEB_SDK_CLIENT?: unknown }).SA_WEB_SDK_CLIENT ?? null,
	);

	useEffect(() => {
		if (client) return;
		const started = Date.now();
		const timer = setInterval(() => {
			const found = (window as unknown as { SA_WEB_SDK_CLIENT?: unknown }).SA_WEB_SDK_CLIENT;
			if (found || Date.now() - started > 30_000) {
				clearInterval(timer);
				if (found) setClient(found);
			}
		}, 250);
		return () => clearInterval(timer);
	}, [client]);

	const transport = useMemo<ShellTransport | null>(
		() =>
			client && typeof (client as { requestData?: unknown }).requestData === 'function'
				? createSdkTransport(client as never)
				: null,
		[client],
	);

	if (!transport) {
		return (
			<div
				style={{
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'center',
					height: '100%',
					minHeight: 200,
					fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
					fontSize: 13,
					color: '#5f6672',
				}}
			>
				Connecting…
			</div>
		);
	}

	return (
		<DashboardCanvas
			dashboardId={dashboardId}
			transport={transport}
			initialParams={initialParams}
			onParamsChange={onParamsChange}
			onPanelSelect={onPanelSelect}
			selectedPanelId={selectedPanelId}
			arrange={arrange}
		/>
	);
}

const METADATA: ComponentMetadata = {
	id: 'dash-program-canvas',
	name: 'DashProgramCanvas',
	displayName: 'Program-generated dashboard',
	isDisplayComp: false,
	type: 'DashProgramCanvas',
	description:
		'Renders a program-generated dashboard by id. The dashboard is a compiled React module served by the backend, not a DSL document — this component loads it, publishes the contract runtime, and arranges its panels.',
	category: '',
	keywords: ['dashboard', 'program', 'generated', 'panels', 'resolver'],
	/**
	 * No query props, deliberately.
	 *
	 * Every other bundle component takes SQL or a tool call, because the DSL
	 * flow binds data at the component. Here data belongs to the dashboard's own
	 * resolvers, which run on the server — this component only needs to know
	 * *which* dashboard to load. Handing it a query would be a second, unchecked
	 * way into the data, which is exactly what the resolver boundary exists to
	 * prevent.
	 */
	props: {
		dashboardId: {
			type: 'string',
			description:
				"Folder name under the backend's dashboard-programs/. Defaults to 'demo'.",
		},
	} as ComponentMetadata['props'],
};

(DashProgramCanvas as unknown as { Metadata: ComponentMetadata }).Metadata = METADATA;

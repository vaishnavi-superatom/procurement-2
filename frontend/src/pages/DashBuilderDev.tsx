/**
 * Development page for the program-generated dashboard flow.
 *
 * Deliberately separate from the platform's existing dashboard pages, which
 * drive the JSON-DSL flow — that path is untouched, and this one has to be able
 * to break without taking it down.
 *
 * The transport is the SDK client — the same websocket path production uses.
 * There is deliberately no HTTP fallback: the backend has no client-facing HTTP
 * server at all (only the agent's localhost script bridge), so a second
 * transport here would be a fiction that works nowhere else. A dev page that
 * proves a path production does not take proves very little.
 */
import { useMemo, useState } from 'react';
import { DashboardCanvas } from '../dash-shell/DashboardCanvas';
import { createSdkTransport, type ShellTransport } from '../dash-shell/transport';
import type { ParamValue } from '../dash-contract';

const DEFAULT_DASHBOARD = 'demo';

export default function DashBuilderDev() {
	const [dashboardId, setDashboardId] = useState(
		() => new URLSearchParams(location.search).get('id') ?? DEFAULT_DASHBOARD,
	);

	/** Parameter state lives in the URL, so a view is shareable and survives a reload. */
	const [params, setParams] = useState<Record<string, ParamValue>>(() => {
		const out: Record<string, ParamValue> = {};
		new URLSearchParams(location.search).forEach((value, key) => {
			if (key !== 'id') out[key] = value;
		});
		return out;
	});

	const onParamsChange = (values: Record<string, ParamValue>) => {
		setParams(values);
		const next = new URLSearchParams({ id: dashboardId });
		for (const [k, v] of Object.entries(values)) {
			if (v !== null && v !== undefined && v !== '') next.set(k, String(v));
		}
		history.replaceState(null, '', `${location.pathname}?${next}`);
	};

	const transport = useMemo<ShellTransport | null>(() => {
		const sdk = (window as unknown as { SA_WEB_SDK_CLIENT?: unknown }).SA_WEB_SDK_CLIENT;
		if (sdk && typeof (sdk as { requestData?: unknown }).requestData === 'function') {
			return createSdkTransport(sdk as never);
		}
		return null;
	}, []);

	/**
	 * Said plainly rather than rendered as a failed load.
	 *
	 * "No connection" and "the dashboard is broken" are different problems, and
	 * showing the second when it is the first sends whoever is looking at this
	 * to debug the wrong thing.
	 */
	if (!transport) {
		return (
			<div
				style={{
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'center',
					height: '100vh',
					fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
					fontSize: 13,
					color: '#5f6672',
					textAlign: 'center',
					padding: 24,
				}}
			>
				<div>
					<div style={{ fontWeight: 600, marginBottom: 6, color: '#16181d' }}>
						No SDK client on the page
					</div>
					<div>
						This page talks to the backend over the websocket, the same as production.
						<br />
						Load it inside the runtime that sets <code>window.SA_WEB_SDK_CLIENT</code>.
					</div>
				</div>
			</div>
		);
	}

	return (
		<div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
			<header
				style={{
					display: 'flex',
					alignItems: 'center',
					gap: 12,
					padding: '10px 16px',
					borderBottom: '1px solid #e3e6ea',
					fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
					fontSize: 13,
					background: '#fff',
				}}
			>
				<strong style={{ fontWeight: 600 }}>Dashboard builder</strong>
				<span style={{ color: '#9199a5' }}>program flow · development</span>
				<span style={{ flex: 1 }} />
				<label style={{ color: '#5f6672' }}>
					dashboard{' '}
					<input
						value={dashboardId}
						onChange={(e) => setDashboardId(e.target.value)}
						style={{
							fontSize: 12,
							padding: '4px 8px',
							borderRadius: 6,
							border: '1px solid #e3e6ea',
							width: 160,
						}}
					/>
				</label>
			</header>

			<div style={{ flex: 1, minHeight: 0 }}>
				<DashboardCanvas
					key={dashboardId}
					dashboardId={dashboardId}
					transport={transport}
					initialParams={params}
					onParamsChange={onParamsChange}
				/>
			</div>
		</div>
	);
}

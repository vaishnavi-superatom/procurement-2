import React from "react";

interface ComponentMetadata {
	id: string;
	name: string;
	isDisplayComp?: boolean;
	type: string;
	description: string;
	category?: string;
	keywords?: string[];
	props: {
		query?: string;
		title?: string;
		description?: string;
		config?: {
			[key: string]: any;
		};
	};
}

interface MultiComponentContainerProps {
	config?: {
		components: ComponentMetadata[];
		layout?: "vertical" | "grid" | "horizontal";
		spacing?: number;
		/** Compact report mode: fit content instead of reserving dashboard height. */
		compact?: boolean;
		title?: string;
		description?: string;
	};
	SA_RUNTIME?: any;
	messageId?: string; // Message ID for expand handler
}

const METADATA: ComponentMetadata = {
	id: "multi-component-container",
	name: "MultiComponentContainer",
	isDisplayComp: false,
	type: "DashboardLayout",
	description:
		"This is the default dashboard layout which can be used to display multiple components together",
	category: "layout",
	keywords: [
		"dashboard",
		"layout",
		"kpi",
		"chart",
		"table",
		"multi-component-container",
	],
	props: {
		config: {
			components:"Array of component configurations (will be auto-organized by type)",
			title: " title for the entire container",
			description: "description for the container",
		},
	},
};

interface MultiComponentContainerComponent
	extends React.FC<MultiComponentContainerProps> {
	Metadata: ComponentMetadata;
}

/**
 * MultiComponentContainer - A container component that renders multiple analytical components
 *
 * This component is designed to display multiple visualizations together based on user requests.
 * It supports various layout modes and automatically maps component types to their implementations.
 *
 * Props:
 * - config.components: Array of component metadata objects with type, props, etc.
 * - config.layout: Layout mode - 'vertical', 'grid', or 'horizontal' (default: 'grid')
 * - config.spacing: Gap between components in pixels (default: 24)
 * - config.title: Optional title for the entire container
 * - config.description: Optional description for the container
 */
const MultiComponentContainer: React.FC<MultiComponentContainerProps> = ({
	config = { components: [] },
	SA_RUNTIME = {},
}) => {
	const {
		components: rawComponents = [],
		layout = "grid",
		spacing = 24,
		compact = false,
		title,
		description,
	} = config;

	/**
	 * Enforce visual hierarchy: Filters (top-right) → KPICards → EMapChart → Charts/Graphs → DataTable
	 * This ensures components are always displayed in the correct order
	 */
	const { filterComponents, components } = React.useMemo(() => {
		// Separate filter components from other components
		const filters = rawComponents.filter((comp) => comp.type === "FilterDropdown");

		const kpiCards = rawComponents.filter((comp) => comp.type === "KPICard");
		const mapViews = rawComponents.filter((comp) => comp.type === "EMapChart");
		const markdownBlocks = rawComponents.filter((comp) => comp.type === "MarkdownBlock");
		const dataTables = rawComponents.filter(
			(comp) => comp.type === "DataTable"
		);
		// Everything that's not a KPICard, EMapChart, DataTable, MarkdownBlock, or Filter is a chart/graph
		const charts = rawComponents.filter(
			(comp) => comp.type !== "KPICard" && comp.type !== "EMapChart" && comp.type !== "DataTable" && comp.type !== "MarkdownBlock" && comp.type !== "FilterDropdown"
		);

		// Build the ordered array: KPICards → EMapCharts → Charts → MarkdownBlocks → DataTables (filters handled separately)
		return {
			filterComponents: filters,
			components: [...kpiCards, ...mapViews, ...charts, ...markdownBlocks, ...dataTables]
		};
	}, [rawComponents]);

	/**
	 * Component type mapper - Gets components from window.SUPERATOM.COMPONENTS
	 * This allows dynamic component loading without importing them here
	 */
	const getComponentByType = (type: string): React.ComponentType<any> | null => {
		// Get components from runtime (set by superatom.ts via setup())
		const COMPONENTS = (window as any).SUPERATOM?.COMPONENTS || {};

		// Normalize the incoming type for comparison
		const normalizedType = type?.toLowerCase().replace(/[^a-z0-9]/g, "");

		// Find component by matching metadata.type
		for (const [key, Component] of Object.entries(COMPONENTS)) {
			if (typeof Component !== 'function') continue;

			const metadata = (Component as any).Metadata;
			if (metadata && metadata.type) {
				const metadataType = metadata.type?.toLowerCase().replace(/[^a-z0-9]/g, "");
				if (metadataType === normalizedType) {
					return Component as React.ComponentType<any>;
				}
			}
		}

		// Fallback: Special cases where type name differs from component
		if (normalizedType === 'donutchart' || normalizedType === 'donut') {
			return COMPONENTS.DynamicPieChart || null;
		}

		return null;
	};

	/**
	 * Get Tailwind classes based on component type and position
	 */
	// Check if this is a vertical/report layout - render components in original order
	const isVerticalLayout = layout === "vertical";

	const getComponentClasses = (componentType: string): string => {
		const isDataTable = componentType === "DataTable";
		const isKPI = componentType === "KPICard";
		const isFilter = componentType === "FilterDropdown";
		const isEMapChart = componentType === "EMapChart" || componentType === "MapView";
		const isMarkdownBlock = componentType === "MarkdownBlock";
		const isTimePeriod = componentType === "TimePeriod";

		if (isFilter) {
			return ""; // Filters have their own inline styling
		} else if (isTimePeriod) {
			// Keep the compact time-period chip close to the surrounding report text
			// without changing spacing for tables, markdown, or other components.
			return "w-full -my-2";
		} else if (isDataTable || isEMapChart || isMarkdownBlock) {
			return "w-full"; // Full width for tables, maps, and markdown blocks
		} else if (isKPI) {
			return "flex-1 min-w-[280px]";
		} else {
			// All other components are charts/graphs - use responsive CSS class
			return "chart-component-wrapper";
		}
	};

	/**
	 * Render filter component
	 */
	const renderFilterComponent = (componentData: ComponentMetadata, index: number) => {
		const ComponentToRender = getComponentByType(componentData.type);

		if (!ComponentToRender) {
			return null;
		}

		// Pass SA_RUNTIME normally - filters need to dispatch events
		const componentProps = {
			...componentData.props,
			SA_RUNTIME: SA_RUNTIME,
		};

		return (
			<div key={componentData.id || `filter-${index}`}>
				<ComponentToRender {...componentProps} />
			</div>
		);
	};

	/**
	 * Render individual component based on metadata
	 */
	const renderComponent = (componentData: ComponentMetadata, index: number) => {
		const ComponentToRender = getComponentByType(componentData.type);

		if (!ComponentToRender) {
			return (
				<div
					key={componentData.id || index}
					className="alert alert-warning"
				>
					<div>
						<strong>Unknown Component Type:</strong> {componentData.type}
						<br />
						<small>Component name: {componentData.name}</small>
					</div>
				</div>
			);
		}

    
		// Special handling for DonutChart - add donut config to PieChart
		const componentProps =
			componentData.type === "DonutChart"
				? {
					...componentData.props,
					config: {
						...componentData.props.config,
						donut: true,
					},
					SA_RUNTIME,
				}
				: {
					...componentData.props,
					SA_RUNTIME,
				};

		const wrapperClasses = getComponentClasses(componentData.type);

		return (
			<div
				key={componentData.id || index}
				className={wrapperClasses}
			>
				<ComponentToRender {...componentProps} />
			</div>
		);
	};

	// Handle empty components array
	if (!components || components.length === 0) {
		return (
			<div className="bg-base-100 rounded-lg p-10 shadow-sm text-center text-base-content/40">
				<div className="text-base mb-2">No components to display</div>
				<div className="text-sm">
					Please provide component metadata in the config
				</div>
			</div>
		);
	}

	// Separate components by type for structured layout
	const kpiComponents = components.filter((comp) => comp.type === "KPICard");
	const mapComponents = components.filter((comp) => comp.type === "EMapChart" || comp.type === "MapView");
	const markdownComponents = components.filter((comp) => comp.type === "MarkdownBlock");
	const tableComponents = components.filter(
		(comp) => comp.type === "DataTable"
	);
	// Everything that's not a KPICard, EMapChart, MapView, DataTable, or MarkdownBlock is a chart/graph
	const chartComponents = components.filter(
		(comp) => comp.type !== "KPICard" && comp.type !== "EMapChart" && comp.type !== "MapView" && comp.type !== "DataTable" && comp.type !== "MarkdownBlock"
	);

	const spacingClass =
		spacing === 24 ? "gap-6" : spacing === 16 ? "gap-4" : `gap-[${spacing}px]`;

	// Single-component layouts (e.g. a lone chart) center themselves via the
	// single-component-container class.
	const isSingleComponent = components.length === 1;

	return (
		<div style={{
			position: "relative",
			width: "100%",
			height: "100%"
		}}>
			<style>{`
				.single-component-container {
					display: flex;
					flex-direction: column;
					align-items: center;
					gap: 2rem;
				}
				@media (min-width: 1024px) {
					.single-component-container {
						flex-direction: row;
						justify-content: center;
					}
				}
				.table-component-wrapper {
					width: 100%;
				}
				.table-button-wrapper {
					width: 100%;
					display: flex;
					align-items: center;
					justify-content: center;
				}
				@media (min-width: 1024px) {
					.table-component-wrapper {
						width: 80%;
					}
					.table-button-wrapper {
						width: 20%;
					}
				}
				.chart-component-wrapper {
					width: 100%;
					height: 480px;
				}
			`}</style>

			<div className={`w-full overflow-y-auto flex flex-col p-5 ${spacingClass} rounded-xl bg-base-100 ${compact ? 'h-auto min-h-0' : 'h-full min-h-(--container-height)'} ${isSingleComponent ? 'justify-center' : 'justify-start'}`}>

			{/* Header Row: Title/Description on left, Filters on right */}
			{(title || description || filterComponents.length > 0) && (
				<div className="w-full mb-2 flex items-start justify-between gap-4">
					{/* Left side: Title & Description */}
					<div className="flex-1">
						{title && <h2 className="text-2xl font-bold text-base-content">{title}</h2>}
						{description && (
							<p className="text-base-content/70 mt-2 text-sm">{description}</p>
						)}
					</div>

					{/* Right side: Filter Components */}
					{filterComponents.length > 0 && (
						<div className="flex items-center gap-3 flex-shrink-0">
							{filterComponents.map((filter, index) =>
								renderFilterComponent(filter, index)
							)}
						</div>
					)}
				</div>
			)}

			{/* Markdown Summary Section - Full width, right below header (grid layout only) */}
			{!isVerticalLayout && markdownComponents.length > 0 && (
				<div className={`flex flex-col ${spacingClass} w-full`}>
					{markdownComponents.map((component, index) =>
						renderComponent(component, index)
					)}
				</div>
			)}

			{/* Vertical/Report Layout - render components in original order (not grouped by type) */}
			{isVerticalLayout ? (
				<>
					{/* Group consecutive KPIs into rows, everything else full-width (markdown stays in order for reports) */}
					{(() => {
						// Use rawComponents (excluding filters) to preserve original order including markdown
						const orderedComponents = rawComponents.filter((comp) => comp.type !== "FilterDropdown");
						const groups: { type: 'kpi-row' | 'component'; items: ComponentMetadata[] }[] = [];

						orderedComponents.forEach((comp) => {
							if (comp.type === 'KPICard') {
								// Add to existing KPI group or create new one
								const lastGroup = groups[groups.length - 1];
								if (lastGroup && lastGroup.type === 'kpi-row') {
									lastGroup.items.push(comp);
								} else {
									groups.push({ type: 'kpi-row', items: [comp] });
								}
							} else {
								groups.push({ type: 'component', items: [comp] });
							}
						});

						return groups.map((group, groupIdx) => {
							if (group.type === 'kpi-row') {
								return (
									<div key={`kpi-row-${groupIdx}`} className={`flex flex-wrap ${spacingClass} w-full`}>
										{group.items.map((comp, idx) => renderComponent(comp, idx))}
									</div>
								);
							}
							const comp = group.items[0];
							return (
								<div key={comp.id || `comp-${groupIdx}`} className="w-full">
									{renderComponent(comp, groupIdx)}
								</div>
							);
						});
					})()}
				</>
			) : (
				<>
			{/* KPI Cards Section - Display in a row */}
			{kpiComponents.length > 0 && (
				<div className={`flex flex-wrap ${spacingClass} w-full ${isSingleComponent ? 'single-component-container min-h-[300px]' : ''}`}>
					{kpiComponents.map((component, index) =>
						renderComponent(component, index)
					)}
				</div>
			)}

			{/* EMapChart Section - Full width, one per row (after KPIs, before charts) */}
			{mapComponents.length > 0 && (
				<div className={`flex flex-col ${spacingClass} w-full ${isSingleComponent ? 'justify-center items-center min-h-[400px] gap-8' : ''}`}>
					{mapComponents.map((component, index) =>
						renderComponent(component, index)
					)}
				</div>
			)}

			{/* Charts Section - Display in flex wrap */}
			{chartComponents.length > 0 && (
				<div className={`flex flex-wrap ${spacingClass} w-full ${isSingleComponent ? 'single-component-container min-h-[400px]' : ''}`}>
					{chartComponents.map((component, index) =>
						renderComponent(component, index)
					)}
				</div>
			)}

			{/* Table Section - Full width at bottom */}
			{tableComponents.length > 0 && (
				<div className="w-full flex flex-col gap-6 overflow-hidden">
					{tableComponents.map((component, index) =>
						renderComponent(component, index)
					)}
				</div>
			)}
				</>
			)}

			</div>
		</div>
	);
};

// Attach metadata to component
(MultiComponentContainer as MultiComponentContainerComponent).Metadata =
	METADATA;

export default MultiComponentContainer;

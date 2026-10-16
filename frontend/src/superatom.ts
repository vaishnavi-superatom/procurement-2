import { createRoot } from 'react-dom/client'
import { createElement, type ComponentType } from 'react';
import { setup } from '@superatomai/sdk-web';

// Import all components
import DynamicBarChart from './shared-modules/DynamicBarChart';
import DynamicDataTable from './shared-modules/DynamicDataTable';
import DynamicKPICard from './shared-modules/DynamicKPICard';
import DynamicLeafletMapView from './shared-modules/DynamicLeafletMapView'
import DynamicLineChart from './shared-modules/DynamicLineChart';
import DynamicPieChart from './shared-modules/DynamicPieChart';
import DatabaseOverview from './modules/DatabaseOverview';
import Home from './modules/home';
import PurchaseRequests from './modules/PurchaseRequests';
import RfqReceived from './modules/RfqReceived';
import ActiveNegotiations from './modules/ActiveNegotiations';
import ApprovedRfqsHome from './modules/ApprovedRfqsHome';
import RfqApprovalHome from './modules/RfqApprovalHome';
import AwardDetails from './modules/AwardDetails';
// import CatalogClassification from './modules/CatalogClassification'; // removed from sidebar for now
import InventoryCapital from './modules/InventoryCapital';
import Negotiations from './modules/Negotiations';
import VendorsOnboarded from './modules/VendorsOnboarded';
import VendorsOnboardedHome from './modules/VendorsOnboardedHome';
import SpendCategory from './modules/SpendCategory';
import CommodityMarket from './modules/CommodityMarket';
import MultiComponentContainer from './shared-modules/MultiComponentContainer';
import DynamicScatterChart from './shared-modules/DynamicScatterChart';
// import DynamicGaugeChart from './shared-modules/DynamicGaugeChart';
import DynamicRadarChart from './shared-modules/DynamicRadarChart';
import DynamicTreemapChart from './shared-modules/DynamicTreemapChart';
import DynamicHeatmapChart from './shared-modules/DynamicHeatmapChart';
import DynamicWaterfallChart from './shared-modules/DynamicWaterfallChart';
import DynamicCandleStickChart from './shared-modules/DynamicCandleStickChart';
import DynamicForm from './shared-modules/DynamicForm';
import DynamicFilterDropdown from './shared-modules/DynamicFilterDropdown';
import DynamicFilterTree from './shared-modules/DynamicFilterTree';
import DynamicApplyFiltersButton from './shared-modules/DynamicApplyFiltersButton';
import DynamicMarkdownBlock from './shared-modules/DynamicMarkdownBlock';
// import DynamicEMapChart from './shared-modules/DynamicEMapChart';
// import DynamicLocationFlowChart from './shared-modules/DynamicLocationFlowChart';
import DebugPropsModal from './shared-modules/DebugPropsModal';
// Program-generated dashboards. Its runtime must be published from inside this
// bundle — a compiled dashboard reads React off the runtime global, and that has
// to be the bundle's React, not the host page's.
import DashProgramCanvas from './shared-modules/DashProgramCanvas';
import { publishRuntime, DASHBOARD_COMPONENT_REGISTRY } from './dash-contract';


// Shelf Life Monitoring Workflow
import ShelfLifeMonitoring from './workflows/shelf-life-monitoring';
import Card from './components/Card';
import Carousel from './components/Carousel';
import Tabs from './components/Tabs';
import Checkbox from './components/Checkbox';
import FileUpload from './components/FileUpload';
import Gallery from './components/Gallery';
import Input from './components/Input';
import List from './components/List';
import MarkdownPreview from './components/MarkdownPreview';
import RichTextEditor from './components/RichTextEditor';
import TimePeriod from './components/TimePeriod';

// Track each isolated React root by its container element so the runtime's
// BundleComponentWrapper can re-render a mounted bundle component with NEW props
// (e.g. when the full dashboard arrives) instead of freezing it at mount-time props.
const __bundleRoots = new WeakMap<HTMLElement, { root: ReturnType<typeof createRoot>; Component: ComponentType<any> }>();

// Components registry - add new components here (single source of truth)
const COMPONENTS = {
    DashProgramCanvas,
    DynamicBarChart,
    DynamicDataTable,
    DynamicKPICard,
    DynamicLeafletMapView,
    DynamicLineChart,
    DynamicPieChart,
    DatabaseOverview,
    Home,              // → Home button (/home)
    PurchaseRequests,  // → /dash/PurchaseRequests
    RfqReceived,       // embedded in Home via the "RFQs received" card — no dashboard route
    ActiveNegotiations, // opened from an RFQ's "Start Negotiation" button — no dashboard route
    ApprovedRfqsHome,  // embedded in Home via the "Approved RFQs" card — no dashboard route
    RfqApprovalHome,   // opened from a negotiation's "Proceed to Approval" button — no dashboard route
    AwardDetails,      // opened from a row in the Approved RFQs list — read-only, no dashboard route
    VendorsOnboardedHome, // embedded in Home via the "Vendors Onboarded" card — no dashboard route
    // CatalogClassification, // → /dash/CatalogClassification — removed from sidebar for now
    InventoryCapital,  // → /dash/InventoryCapital
    Negotiations,      // → /dash/Negotiations
    VendorsOnboarded,  // → /dash/VendorsOnboarded
    SpendCategory,     // → /dash/SpendCategory
    CommodityMarket,   // → /dash/CommodityMarket
    DynamicScatterChart,
    // DynamicGaugeChart,
    DynamicRadarChart,
    // DynamicTreemapChart,
    // DynamicHeatmapChart,
    DynamicWaterfallChart,
    // DynamicCandleStickChart,
    DynamicForm,
    DynamicFilterDropdown,
    DynamicFilterTree,
    DynamicApplyFiltersButton,
    DynamicMarkdownBlock,
    // DynamicEMapChart,
    // DynamicLocationFlowChart,
    MultiComponentContainer,
    ShelfLifeMonitoring,
    Card,
    Carousel,
    Tabs,
    Checkbox,
    FileUpload,
    Gallery,
    Input,
    List,
    MarkdownPreview,
    RichTextEditor,
    TimePeriod,
    DebugPropsModal,

    mount: (Component: ComponentType<any>, container: HTMLElement, props?: Record<string, any>) => {
        // Bundle's internal React
        const root = createRoot(container);
        __bundleRoots.set(container, { root, Component });
        root.render(createElement(Component, props));
        return {
            unmount: () => {
                root.unmount();
                __bundleRoots.delete(container);
            },
        };
    },
    // Re-render an already-mounted bundle component with NEW props, in its own
    // isolated React instance. The runtime's BundleComponentWrapper calls this when
    // the wrapper's props change (e.g. the full dashboard becomes available). Without
    // it, prop updates never cross into the bundle's React tree and the component
    // stays stuck on its initial props — which is why the "View more" button never
    // appeared (fullDashboardComponent was always seen as undefined after mount).
    update: (container: HTMLElement, props?: Record<string, any>) => {
        const entry = __bundleRoots.get(container);
        if (!entry) return;
        entry.root.render(createElement(entry.Component, props));
    },
}

// Extract metadata from COMPONENTS - each component should have a static .Metadata property
const componentsMetadata = Object.values(COMPONENTS)
    .filter(component => typeof component === 'function' && 'Metadata' in component)
    .map(component => (component as any).Metadata);

const SUPERATOM = {
    init : async () => {
        // Publish the dashboard contract runtime before anything can import a
        // compiled dashboard module. A generated dashboard reads React off this
        // global, and it must be THIS bundle's React — the host page has its own
        // instance, and hooks dispatched into the wrong renderer fail in ways
        // that are very hard to read. publishRuntime() throws on a missing
        // export, so a gap in the contract surfaces here rather than as
        // `undefined` inside somebody's panel.
        publishRuntime();

        // Setup SDK components first (this may overwrite window.SA)
        setup(COMPONENTS);

        (window as any).runtime?.componentsLoaded()

        // // Re-initialize QueryExecutor and ActionsRequestExecutor after setup
        // // Import and initialize them here to ensure they're set after setup()
        // const QueryExecutor = (await import('./data/query')).default;
        // const ActionsRequestExecutor = (await import('./data/actions')).default;

        // (window as any).SA = (window as any).SA || {};
        // (window as any).SA.QueryExecutor = new QueryExecutor();
        // (window as any).SA.ActionsRequestExecutor = new ActionsRequestExecutor();

        // Check if SDK client is already set by runtime
        let sdkClient = (window as any).SA_WEB_SDK_CLIENT;

        if(sdkClient) {
            const llm_components = componentsMetadata.filter(c => !c.type.startsWith('Workflow_') && c.type !== 'DashboardLayout');
            console.log('SDK client found, sending component metadata:', llm_components);
            sdkClient.sendComponents(llm_components);

            /**
             * Register the dashboard contract — the names a generated dashboard
             * may import, with the metadata the agent reads.
             *
             * This bundle is where those components are defined, so this bundle
             * is what says what they are. Sent again on every reconnect, not only
             * here: a backend restart leaves this tab talking to a process that
             * has forgotten the contract, and the agent would then be told it has
             * no components at all.
             */
            const dashContract = DASHBOARD_COMPONENT_REGISTRY.registry;
            const sendContract = () => {
                console.log(`Sending dashboard contract (${dashContract.length})`);
                sdkClient.sendDashContract(dashContract);
            };
            sendContract();
            sdkClient.onConnected?.(sendContract);
        } else {
            // // If not found, initialize our own SDK client
            // console.log('SDK client not found, initializing...');
            // await sdk.connect();
            // (window as any).SA_WEB_SDK_CLIENT = sdk;

            // console.log('sending component metadata:', componentsMetadata);
            // sdk.sendComponents(componentsMetadata);
        }
    },
    destroy: () => {
        // sdk.disconnect();
    }
}


export default SUPERATOM;



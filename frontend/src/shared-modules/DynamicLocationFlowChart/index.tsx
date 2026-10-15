import React, { useEffect, useState, useRef } from 'react';
import { Icon } from '@iconify/react';
import ReactECharts, { type EChartsOption } from 'echarts-for-react';
import * as echarts from 'echarts';
import type { ComponentMetadata } from '../../types';
import { COLORS, SHADOWS, BORDER_RADIUS, TYPOGRAPHY, SPACING } from '../../design-system/tokens';
import usaGeoJson from '../DynamicEMapChart/usa.json';
import { useDebugClick } from '../useDebugClick';
import DebugPropsModal from '../DebugPropsModal';

interface ExternalTool {
  toolId: string;
  toolName: string;
  parameters: Record<string, any>;
}

interface QueryConfig {
  sql: string;
  params?: Record<string, any>;
}

interface DynamicLocationFlowChartProps {
  query?: string | QueryConfig | null;
  title?: string;
  description?: string;
  externalTool?: ExternalTool | null;
  config?: {
    // Field mappings
    sourceField?: string;          // Column name for source location
    targetField?: string;          // Column name for target location
    valueField?: string;           // Column name for flow value (count, amount, etc.)
    sourceLatField?: string;       // Column name for source latitude
    sourceLonField?: string;       // Column name for source longitude
    targetLatField?: string;       // Column name for target latitude
    targetLonField?: string;       // Column name for target longitude
    // Display options
    height?: number;
    showValue?: boolean;           // Show values on flow lines
    roam?: boolean;                // Allow zoom and pan
    // Data (for direct data passing)
    data?: any[];
  };
  SA_RUNTIME?: any;
}

// Helper function to get case-insensitive key from object
const getCaseInsensitiveValue = (obj: any, key: string): any => {
  if (!obj || !key) return undefined;
  const actualKey = Object.keys(obj).find(k => k?.toLowerCase() === key?.toLowerCase());
  return actualKey ? obj[actualKey] : undefined;
};

// Format number for display
const formatNumber = (value: any): string => {
  if (value === null || value === undefined) return 'N/A';
  const numVal = typeof value === 'number' ? value : parseFloat(value);
  if (isNaN(numVal)) return String(value);
  if (numVal >= 1000000) {
    return (numVal / 1000000).toFixed(1) + 'M';
  } else if (numVal >= 1000) {
    return (numVal / 1000).toFixed(1) + 'k';
  }
  return numVal.toLocaleString(undefined, { maximumFractionDigits: 0 });
};

// ============================================
// METADATA
// ============================================

const METADATA: ComponentMetadata = {
  id: 'dynamic-location-flow-chart',
  name: 'DynamicLocationFlowChart',
  displayName: 'Show flow between locations',
  isDisplayComp: false,
  type: 'LocationFlowChart',
  description: 'Visualizes flows/transfers between locations as a network diagram with nodes and arrows. Perfect for showing order flows, inventory transfers, or any directional movement between locations. Shows 3-4 key locations with weighted arrows indicating flow volume. IMPORTANT: Use EITHER query OR externalTool as data source, NEVER BOTH.',
  category: 'Flow',
  keywords: ['flow', 'transfer', 'network', 'locations', 'movement', 'graph', 'nodes', 'edges', 'arrows', 'sankey'],
  props: {
    query: {
      sql: 'SQL query returning: source location, target location, and flow value. Example: SELECT source_store, target_store, COUNT(*) as flow_count FROM transfers GROUP BY source_store, target_store',
      params: 'Default parameter values object. Keys must match $paramName placeholders. FilterDropdown params override these.'
    },
    externalTool: 'Set to null if using query. Otherwise provide: { toolId: "registered-tool-id", toolName: "Display Name", parameters: { param1: value1 } }',
    title: 'Title for the flow chart, e.g., "Order Flows Between Stores"',
    description: 'Brief description',
    config: {
      sourceField: 'Column name for source location (default: "source")',
      targetField: 'Column name for target location (default: "target")',
      valueField: 'Column name for flow value/weight (default: "value")',
      sourceLatField: 'Column name for source latitude (default: "source_lat")',
      sourceLonField: 'Column name for source longitude (default: "source_lon")',
      targetLatField: 'Column name for target latitude (default: "target_lat")',
      targetLonField: 'Column name for target longitude (default: "target_lon")',
      height: 'Chart height in pixels (default: 420)',
      showValue: 'Show values on flow arrows (default: true)',
      roam: 'Allow zoom and pan on map (default: true)',
    }
  }
};

// Default query - shows hardcoded sample flows between stores with coordinates
const DEFAULT_QUERY = `WITH stores AS (
  SELECT
    location_name,
    geocodedgpslat as lat,
    geocodedgpslon as lon,
    ROW_NUMBER() OVER (ORDER BY location_name) as rn
  FROM locations
  WHERE geocodedgpslat IS NOT NULL AND geocodedgpslon IS NOT NULL
  LIMIT 4
)
SELECT
  s1.location_name as source,
  s1.lat as source_lat,
  s1.lon as source_lon,
  s2.location_name as target,
  s2.lat as target_lat,
  s2.lon as target_lon,
  CASE
    WHEN s1.rn = 1 AND s2.rn = 3 THEN 150
    WHEN s1.rn = 1 AND s2.rn = 4 THEN 85
    WHEN s1.rn = 2 AND s2.rn = 3 THEN 120
    WHEN s1.rn = 2 AND s2.rn = 4 THEN 95
    ELSE 0
  END as value
FROM stores s1
CROSS JOIN stores s2
WHERE s1.rn < s2.rn
  AND ((s1.rn = 1 AND s2.rn IN (3, 4)) OR (s1.rn = 2 AND s2.rn IN (3, 4)))`;

const DEFAULT_CONFIG = {
  sourceField: 'source',
  targetField: 'target',
  valueField: 'value',
  sourceLatField: 'source_lat',
  sourceLonField: 'source_lon',
  targetLatField: 'target_lat',
  targetLonField: 'target_lon',
  height: 420,
  showValue: true,
  roam: true
};


// ============================================
// COMPONENT
// ============================================

interface DynamicLocationFlowChartComponent extends React.FC<DynamicLocationFlowChartProps> {
  Metadata: ComponentMetadata;
}

const DynamicLocationFlowChart: React.FC<DynamicLocationFlowChartProps> = ({
  query = DEFAULT_QUERY,
  title = 'Location Flow Analysis',
  description = 'Visualizing transfers and flows between locations',
  externalTool = null,
  config = {},
  SA_RUNTIME = {}
}) => {
  const { isDebugModalOpen, handleDebugClick, closeDebugModal } = useDebugClick();
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };

  const hasExternalTool = externalTool && externalTool.toolId;
  const hasConfigData = !!config.data;

  const [data, setData] = useState<any[]>(config.data || []);
  const [loading, setLoading] = useState<boolean>(!hasConfigData);
  const [error, setError] = useState<string | null>(null);
  const [mapRegistered, setMapRegistered] = useState(false);

  // Filter params state
  const [filterParams, setFilterParams] = useState<Record<string, any>>({});
  // Monotonic request counter — see fetchData for why every fetch function checks it
  const fetchIdRef = useRef(0);

  // For the debug modal only: `externalTool` as received in props is the
  // DSL's static baked-in defaults (e.g. params all null) — it never reflects
  // filter selections, since those are merged in separately at fetch time
  // (see fetchExternalToolDataWithParams). Recompute the same merge here so
  // Alt+Click inspection shows what's actually being queried right now.
  const liveExternalTool = hasExternalTool && externalTool
    ? {
        ...externalTool,
        parameters: externalTool.parameters?.params
          ? { ...externalTool.parameters, params: { ...externalTool.parameters.params, ...filterParams } }
          : { ...externalTool.parameters, ...filterParams },
      }
    : externalTool;

  // Fullscreen state
  const [isHovered, setIsHovered] = useState<boolean>(false);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const chartContainerRef = React.useRef<HTMLDivElement>(null);

  const toolId = externalTool?.toolId;
  const toolParamsStr = externalTool?.parameters ? JSON.stringify(externalTool.parameters) : '';
  const queryStr = typeof query === 'string' ? query : JSON.stringify(query);
  const uiBlockId = SA_RUNTIME?.uiBlockId;

  // ============================================
  // REGISTER USA MAP
  // ============================================

  useEffect(() => {
    try {
      if ((echarts as any).getMap && (echarts as any).getMap('USA')) {
        setMapRegistered(true);
        return;
      }

      echarts.registerMap('USA', usaGeoJson as any, {
        Alaska: { left: -131, top: 25, width: 15 },
        Hawaii: { left: -110, top: 28, width: 5 },
        'Puerto Rico': { left: -76, top: 26, width: 2 }
      });

      setMapRegistered(true);
    } catch (err) {
      console.error('[DynamicLocationFlowChart] Error registering map:', err);
      setError('Failed to register map');
    }
  }, []);

  // ============================================
  // DATA FETCHING
  // ============================================

  useEffect(() => {
    // If filters have already settled before this component mounted, the
    // filter-listener effect below will fetch with the complete, current
    // params via its catch-up branch — skip this default-params fetch to
    // avoid firing two concurrent requests for the same data.
    const eventName = uiBlockId ? `${uiBlockId}_FILTER` : 'GLOBAL_FILTER';
    const alreadySettled = (window as any).__FILTER_STATE__?.[eventName]?.params;
    if (alreadySettled && Object.keys(alreadySettled).length > 0) return;
    if (hasExternalTool) {
      fetchExternalToolData();
    } else if (!hasConfigData) {
      fetchData();
    }
  }, [queryStr, toolId, toolParamsStr, hasConfigData]);

  // Listen for filter events
  // Debounces the actual fetch: a cascading filter (listenTo another filter)
  // re-fetches its own options and re-dispatches once resolved, so a single
  // upstream change can fire 2+ events in quick succession here. Fetching on
  // each one individually causes a visible flash of stale-combo data before
  // the final, correct combo lands. Coalescing into one fetch after the burst
  // settles fixes that without needing to know the filter dependency graph.
  const filterDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const eventName = uiBlockId ? `${uiBlockId}_FILTER` : 'GLOBAL_FILTER';

    const handleFilterChange = (event: CustomEvent) => {
      const { params, isInitial, filterKey: sourceFilterKey } = event.detail || {};

      if (params && typeof params === 'object') {
        setFilterParams(prev => {
          const mergedParams = { ...prev };

          // If this filter dispatches empty params (e.g., "All" selected),
          // remove any keys that were previously set by this same filterKey
          if (Object.keys(params).length === 0 && sourceFilterKey) {
            const filterKeyMap = (window as any).__FILTER_KEY_MAP__ || {};
            const prevKeys = filterKeyMap[sourceFilterKey] || [];
            for (const key of prevKeys) {
              delete mergedParams[key];
            }
          } else if (sourceFilterKey) {
            if (!(window as any).__FILTER_KEY_MAP__) (window as any).__FILTER_KEY_MAP__ = {};
            (window as any).__FILTER_KEY_MAP__[sourceFilterKey] = Object.keys(params);
          }

          // Merge new params
          Object.assign(mergedParams, params);

          // If a DynamicApplyFiltersButton is present on this page, it sets this
          // flag on mount — data widgets hold off fetching on individual filter
          // events entirely and wait for the button's explicit _FILTER_APPLY
          // event instead (see the second listener below). Labels above still
          // update live so titles/descriptions reflect the in-progress selection.
          const requiresApply = (window as any).__FILTER_STATE__?.[eventName]?.requiresApply;
          if (!requiresApply && (!isInitial || data.length === 0)) {
            if (filterDebounceRef.current) clearTimeout(filterDebounceRef.current);
            filterDebounceRef.current = setTimeout(() => {
              if (hasExternalTool) {
                fetchExternalToolDataWithParams(mergedParams);
              } else if (!hasConfigData) {
                fetchDataWithParams(mergedParams);
              }
            }, 250);
          }
          return mergedParams;
        });
      }
    };

    window.addEventListener(eventName, handleFilterChange as EventListener);

    return () => {
      window.removeEventListener(eventName, handleFilterChange as EventListener);
      if (filterDebounceRef.current) clearTimeout(filterDebounceRef.current);
    };
  }, [uiBlockId, hasExternalTool, hasConfigData]);

  // Listen for the explicit "Apply Filters" trigger (see DynamicApplyFiltersButton).
  // Fires unconditionally, with no debounce — this is the ONLY fetch trigger
  // once a page has an Apply button (the listener above then only updates
  // labels/local param state, per the requiresApply gate).
  useEffect(() => {
    const applyEventName = uiBlockId ? `${uiBlockId}_FILTER_APPLY` : 'GLOBAL_FILTER_APPLY';

    const handleApply = (event: CustomEvent) => {
      const { params } = event.detail || {};
      if (!params || typeof params !== 'object') return;

      setFilterParams(prev => {
        const mergedParams = { ...prev, ...params };
        if (hasExternalTool) {
          fetchExternalToolDataWithParams(mergedParams);
        } else if (!hasConfigData) {
          fetchDataWithParams(mergedParams);
        }
        return mergedParams;
      });
    };

    window.addEventListener(applyEventName, handleApply as EventListener);
    return () => window.removeEventListener(applyEventName, handleApply as EventListener);
  }, [uiBlockId, hasExternalTool, hasConfigData]);

  // Track fullscreen state changes
  useEffect(() => {
    const handleFullscreenChange = () => {
      const isCurrentlyFullscreen = !!(
        document.fullscreenElement ||
        (document as any).webkitFullscreenElement ||
        (document as any).mozFullScreenElement ||
        (document as any).msFullscreenElement
      );
      setIsFullscreen(isCurrentlyFullscreen);
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
    document.addEventListener('mozfullscreenchange', handleFullscreenChange);
    document.addEventListener('MSFullscreenChange', handleFullscreenChange);

    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', handleFullscreenChange);
      document.removeEventListener('mozfullscreenchange', handleFullscreenChange);
      document.removeEventListener('MSFullscreenChange', handleFullscreenChange);
    };
  }, []);

  // Enter fullscreen using browser API
  const enterFullscreen = async () => {
    if (!chartContainerRef.current) return;

    try {
      if (chartContainerRef.current.requestFullscreen) {
        await chartContainerRef.current.requestFullscreen();
      } else if ((chartContainerRef.current as any).webkitRequestFullscreen) {
        await (chartContainerRef.current as any).webkitRequestFullscreen();
      } else if ((chartContainerRef.current as any).mozRequestFullScreen) {
        await (chartContainerRef.current as any).mozRequestFullScreen();
      } else if ((chartContainerRef.current as any).msRequestFullscreen) {
        await (chartContainerRef.current as any).msRequestFullscreen();
      }
    } catch (err) {
      console.error('Error entering fullscreen:', err);
    }
  };

  const fetchData = async () => {
    // Stale-response guard: if a newer fetch (default, filter-triggered, or
    // external-tool) starts before this one resolves, this request's result
    // must be discarded on arrival — otherwise a slow response for OLD filter
    // params can resolve after a faster NEW request and silently overwrite
    // the correct display with stale data (the exact bug seen in production:
    // FY changed 3x in quick succession, each hitting a slow ~5s MSSQL query;
    // a later, faster query finished first showing correct data, then an
    // earlier, slower query finished seconds later and clobbered it).
    const requestId = ++fetchIdRef.current;
    setLoading(true);
    setError(null);

    try {
      const queryExecutor = (window as any).SA?.QueryExecutor;

      if (!queryExecutor) {
        throw new Error('QueryExecutor not available');
      }

      let finalQuery: string;
      if (typeof query === 'object' && query !== null && 'sql' in query) {
        finalQuery = JSON.stringify({ sql: query.sql, values: query.params || {} });
      } else {
        finalQuery = query as string;
      }

      const result = await queryExecutor.executeQuery({ query: finalQuery, SA_RUNTIME });
      if (requestId !== fetchIdRef.current) return; // superseded by a newer fetch — discard

      if (result && result.length > 0) {
        setData(result);
      } else {
        setData([]);
      }
    } catch (err) {
      if (requestId !== fetchIdRef.current) return;
      console.error('Error fetching data:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch data');
    } finally {
      if (requestId === fetchIdRef.current) setLoading(false);
    }
  };

  const fetchDataWithParams = async (filterParams: Record<string, any>) => {
    const requestId = ++fetchIdRef.current; // see fetchData for why this guard exists
    setLoading(true);
    setError(null);

    try {
      const queryExecutor = (window as any).SA?.QueryExecutor;

      if (!queryExecutor) {
        throw new Error('QueryExecutor not available');
      }

      let sqlString: string;
      let existingParams: Record<string, any> = {};

      if (typeof query === 'object' && query !== null && 'sql' in query) {
        sqlString = query.sql;
        existingParams = query.params || {};
      } else if (typeof query === 'string') {
        try {
          const parsed = JSON.parse(query);
          if (parsed && typeof parsed === 'object' && parsed.sql) {
            sqlString = parsed.sql;
            existingParams = parsed.values || {};
          } else {
            sqlString = query;
          }
        } catch {
          sqlString = query;
        }
      } else {
        sqlString = '';
      }

      const mergedParams = { ...existingParams, ...filterParams };
      const finalQuery = JSON.stringify({ sql: sqlString, values: mergedParams });

      const result = await queryExecutor.executeQuery({ query: finalQuery, SA_RUNTIME });
      if (requestId !== fetchIdRef.current) return; // superseded by a newer fetch — discard

      if (result && result.length > 0) {
        setData(result);
      } else {
        setData([]);
      }
    } catch (err) {
      if (requestId !== fetchIdRef.current) return;
      console.error('Error fetching data with params:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch data');
    } finally {
      if (requestId === fetchIdRef.current) setLoading(false);
    }
  };

  const fetchExternalToolData = async () => {
    if (!externalTool) return;

    const requestId = ++fetchIdRef.current; // see fetchData for why this guard exists
    setLoading(true);
    setError(null);

    try {
      const toolExecutor = (window as any).SA?.ToolExecutor;

      if (!toolExecutor) {
        throw new Error('ToolExecutor not available');
      }

      let result;
      if (externalTool.parameters?.queryId) {
        result = await toolExecutor.executeByQueryId({
          toolId: externalTool.toolId,
          queryId: externalTool.parameters.queryId,
          params: externalTool.parameters.params,
          SA_RUNTIME
        });
      } else {
        result = await toolExecutor.executeTool({
          externalTool: externalTool,
          formData: {},
          SA_RUNTIME
        });
      }

      let chartData: any[] = [];

      if (result?.data) {
        if (Array.isArray(result.data)) {
          chartData = result.data;
        } else if (result.data.data && Array.isArray(result.data.data)) {
          chartData = result.data.data;
        } else if (result.data.records && Array.isArray(result.data.records)) {
          chartData = result.data.records;
        } else if (result.data.items && Array.isArray(result.data.items)) {
          chartData = result.data.items;
        } else if (result.data.results && Array.isArray(result.data.results)) {
          chartData = result.data.results;
        }
      } else if (Array.isArray(result)) {
        chartData = result;
      }

      if (requestId !== fetchIdRef.current) return; // superseded by a newer fetch — discard
      if (chartData.length > 0) {
        setData(chartData);
      } else {
        setData([]);
      }
    } catch (err) {
      if (requestId !== fetchIdRef.current) return;
      console.error('Error fetching external tool data:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch data from external tool');
    } finally {
      if (requestId === fetchIdRef.current) setLoading(false);
    }
  };

  const fetchExternalToolDataWithParams = async (params: Record<string, any>) => {
    if (!externalTool) return;

    const requestId = ++fetchIdRef.current; // see fetchData for why this guard exists
    setLoading(true);
    setError(null);

    try {
      const toolExecutor = (window as any).SA?.ToolExecutor;

      if (!toolExecutor) {
        throw new Error('ToolExecutor not available');
      }

      // Merge filter params: into parameters.params if it exists (SQL named params), otherwise top-level
      const mergedParameters = externalTool.parameters?.params
        ? { ...externalTool.parameters, params: { ...externalTool.parameters.params, ...params } }
        : { ...externalTool.parameters, ...params };

      let result;
      if (externalTool.parameters?.queryId) {
        result = await toolExecutor.executeByQueryId({
          toolId: externalTool.toolId,
          queryId: externalTool.parameters.queryId,
          params: externalTool.parameters.params,
          filterParams: params,
          SA_RUNTIME
        });
      } else {
        result = await toolExecutor.executeTool({
          externalTool: {
            ...externalTool,
            parameters: mergedParameters
          },
          formData: {},
          SA_RUNTIME
        });
      }

      let chartData: any[] = [];

      if (result?.data) {
        if (Array.isArray(result.data)) {
          chartData = result.data;
        } else if (result.data.data && Array.isArray(result.data.data)) {
          chartData = result.data.data;
        } else if (result.data.records && Array.isArray(result.data.records)) {
          chartData = result.data.records;
        } else if (result.data.items && Array.isArray(result.data.items)) {
          chartData = result.data.items;
        } else if (result.data.results && Array.isArray(result.data.results)) {
          chartData = result.data.results;
        }
      } else if (Array.isArray(result)) {
        chartData = result;
      }

      if (requestId !== fetchIdRef.current) return; // superseded by a newer fetch — discard
      if (chartData.length > 0) {
        setData(chartData);
      } else {
        setData([]);
      }
    } catch (err) {
      if (requestId !== fetchIdRef.current) return;
      console.error('Error fetching external tool data with params:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch data from external tool');
    } finally {
      if (requestId === fetchIdRef.current) setLoading(false);
    }
  };

  // ============================================
  // BUILD CHART DATA
  // ============================================

  const buildChartData = () => {
    if (data.length === 0) return { locations: [], flows: [] };

    // Extract unique locations with coordinates
    const locationMap = new Map<string, { name: string; lat: number; lon: number }>();
    const flows: any[] = [];

    data.forEach(item => {
      const sourceName = String(getCaseInsensitiveValue(item, mergedConfig.sourceField) || '');
      const targetName = String(getCaseInsensitiveValue(item, mergedConfig.targetField) || '');
      const value = parseFloat(getCaseInsensitiveValue(item, mergedConfig.valueField) || 0);

      const sourceLat = parseFloat(getCaseInsensitiveValue(item, mergedConfig.sourceLatField) || 0);
      const sourceLon = parseFloat(getCaseInsensitiveValue(item, mergedConfig.sourceLonField) || 0);
      const targetLat = parseFloat(getCaseInsensitiveValue(item, mergedConfig.targetLatField) || 0);
      const targetLon = parseFloat(getCaseInsensitiveValue(item, mergedConfig.targetLonField) || 0);

      if (sourceName && targetName && value > 0 && sourceLat && sourceLon && targetLat && targetLon) {
        // Add locations to map if not already added
        if (!locationMap.has(sourceName)) {
          locationMap.set(sourceName, { name: sourceName, lat: sourceLat, lon: sourceLon });
        }
        if (!locationMap.has(targetName)) {
          locationMap.set(targetName, { name: targetName, lat: targetLat, lon: targetLon });
        }

        // Add flow
        flows.push({
          fromName: sourceName,
          toName: targetName,
          coords: [
            [sourceLon, sourceLat],
            [targetLon, targetLat]
          ],
          value,
          originalData: item
        });
      }
    });

    const locations = Array.from(locationMap.values());

    return { locations, flows };
  };

  // ============================================
  // BUILD CHART OPTION
  // ============================================

  const buildChartOption = (): EChartsOption => {
    const { locations, flows } = buildChartData();

    if (locations.length === 0) {
      return {};
    }

    // Calculate line widths based on flow values
    const values = flows.map(f => f.value);
    const minValue = Math.min(...values);
    const maxValue = Math.max(...values);
    const valueRange = maxValue - minValue || 1;

    // Build a map of incoming flows for each destination
    const incomingFlowsMap = new Map<string, { from: string; value: number }[]>();
    flows.forEach(flow => {
      const existing = incomingFlowsMap.get(flow.toName) || [];
      existing.push({ from: flow.fromName, value: flow.value });
      incomingFlowsMap.set(flow.toName, existing);
    });

    // Build scatter data for locations with incoming flow info
    const scatterData = locations.map(loc => {
      const incomingFlows = incomingFlowsMap.get(loc.name) || [];
      const flowInfo = incomingFlows.length > 0
        ? incomingFlows.map(f => `${f.from}: ${formatNumber(f.value)}`).join('\n')
        : '';

      return {
        name: loc.name,
        value: [loc.lon, loc.lat, 1],
        incomingFlows,
        flowInfo
      };
    });

    // Build lines data for flows
    const linesData = flows.map(flow => ({
      name: `${flow.fromName} → ${flow.toName}`,
      fromName: flow.fromName,
      toName: flow.toName,
      coords: flow.coords,
      value: flow.value,
      lineStyle: {
        width: 2 + ((flow.value - minValue) / valueRange) * 4, // Width 2-6 based on value
        color: COLORS.primary,
        opacity: 0.6
      },
      label: { show: false }
    }));

    return {
      tooltip: {
        show: true,
        trigger: 'item',
        backgroundColor: COLORS.darkNavy,
        borderColor: COLORS.darkNavy,
        textStyle: {
          color: COLORS.white,
          fontSize: parseInt(TYPOGRAPHY.fontSize.small)
        },
        padding: 12,
        borderRadius: parseInt(BORDER_RADIUS.medium),
        formatter: (params: any) => {
          if (params.componentSubType === 'lines') {
            const data = params.data;
            return `<div style="font-weight: 600; margin-bottom: 4px;">${data.fromName} → ${data.toName}</div>
                    <div style="font-size: 18px; font-weight: 700; color: ${COLORS.primary};">${formatNumber(data.value)}</div>`;
          } else if (params.componentSubType === 'scatter') {
            return `<div style="font-weight: 600;">${params.name}</div>`;
          }
          return '';
        }
      },
      geo: {
        map: 'USA',
        roam: mergedConfig.roam,
        itemStyle: {
          areaColor: '#e2e8f0',
          borderColor: '#94a3b8',
          borderWidth: 1,
        },
        emphasis: {
          itemStyle: {
            areaColor: '#cbd5e1',
          },
          label: { show: false }
        },
        label: { show: false },
      },
      series: [
        // Flow lines
        {
          type: 'lines',
          coordinateSystem: 'geo',
          data: linesData,
          effect: {
            show: true,
            period: 4,
            trailLength: 0.1,
            symbol: 'arrow',
            symbolSize: 8,
            color: COLORS.primary
          },
          lineStyle: {
            color: COLORS.primary,
            width: 2,
            opacity: 0.6,
            curveness: 0.2
          },
          emphasis: {
            lineStyle: {
              width: 4,
              opacity: 0.8
            }
          }
        },
        // Location markers
        {
          type: 'scatter',
          coordinateSystem: 'geo',
          data: scatterData,
          symbolSize: 20,
          itemStyle: {
            color: COLORS.primary,
            borderColor: COLORS.white,
            borderWidth: 2,
            shadowBlur: 8,
            shadowColor: 'rgba(0, 0, 0, 0.3)'
          },
          label: {
            show: true,
            formatter: (params: any) => {
              const data = params.data;
              if (data.flowInfo) {
                return `{title|${data.name}}\n{info|${data.flowInfo}}`;
              }
              return `{title|${data.name}}`;
            },
            position: 'bottom',
            distance: 8,
            backgroundColor: 'rgba(255, 255, 255, 0.9)',
            padding: [6, 10],
            borderRadius: 4,
            rich: {
              title: {
                fontSize: parseInt(TYPOGRAPHY.fontSize.small),
                fontWeight: TYPOGRAPHY.fontWeight.semibold,
                color: COLORS.text.primary,
                lineHeight: 18
              },
              info: {
                fontSize: 10,
                color: COLORS.text.secondary,
                lineHeight: 14
              }
            }
          },
          emphasis: {
            scale: 1.3,
            itemStyle: {
              shadowBlur: 12,
              shadowColor: 'rgba(0, 0, 0, 0.5)'
            }
          }
        }
      ]
    };
  };

  // ============================================
  // RENDER
  // ============================================

  if (loading || !mapRegistered) {
    return (
      <div
        ref={chartContainerRef}
        className="card bg-base-100 shadow-sm border border-base-300 p-6 relative"
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        <div
          className="absolute top-0 left-0 right-0 h-1"
          style={{ background: `linear-gradient(90deg, ${COLORS.primary}, ${COLORS.primary}80)` }}
        ></div>

        {/* Fullscreen icon - shows on hover when not in fullscreen */}
        {isHovered && !isFullscreen && (
          <button
            onClick={enterFullscreen}
            className="absolute top-2 right-1 z-10"
            title="Enter fullscreen (ESC to exit)"
          >
            <Icon icon="mdi:fullscreen" className="w-5 h-5" />
          </button>
        )}
        <div className="skeleton h-6 w-48 mb-2"></div>
        <div className="skeleton h-4 w-64 mb-4"></div>
        <div className="skeleton w-full flex-1 min-h-0"></div>
      </div>
    );
  }

  if (error) {
    return (
      <div
        className="card bg-base-100 shadow-sm hover:shadow-md transition-all duration-300 border border-error overflow-hidden"
        onClick={handleDebugClick}
      >
        {isDebugModalOpen && (
          <DebugPropsModal
            componentName="DynamicLocationFlowChart"
            componentId={SA_RUNTIME?.componentId || 'unknown'}
            props={{ title, description, externalTool: liveExternalTool, config, filterParams, error }}
            isOpen={isDebugModalOpen}
            onClose={closeDebugModal}
          />
        )}
        <div className="absolute top-0 left-0 right-0 h-1 bg-error"></div>
        <div className="card-body p-5">
          <div className="alert alert-error">
            <Icon icon="mdi:alert-circle" className="w-5 h-5 flex-shrink-0" />
            <div>
              <p className="font-medium">Error loading chart</p>
              <p className="text-sm opacity-80">{error}</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div
        className="card bg-base-100 shadow-sm border border-base-300 overflow-hidden"
      >
        <div
          className="absolute top-0 left-0 right-0 h-1"
          style={{ background: `linear-gradient(90deg, ${COLORS.primary}, ${COLORS.primary}80)` }}
        ></div>
        <div className="p-6">
          <div className="flex items-center gap-2 mb-4">
            <Icon icon="mdi:map-marker-path" className="w-6 h-6" style={{ color: COLORS.primary }} />
            <h3 className="text-lg font-bold">{title}</h3>
          </div>
          <div className="text-center py-12">
            <Icon icon="mdi:map-marker-off" className="w-12 h-12 opacity-40 mx-auto mb-3" />
            <p className="text-sm opacity-60">No flow data available</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="card bg-base-100 shadow-sm hover:shadow-md transition-all duration-300 border border-base-300 overflow-hidden"
      onClick={handleDebugClick}
    >
      {isDebugModalOpen && (
        <DebugPropsModal
          componentName="DynamicLocationFlowChart"
          componentId={SA_RUNTIME?.componentId || 'unknown'}
          props={{ title, description, externalTool: liveExternalTool, config, filterParams }}
          isOpen={isDebugModalOpen}
          onClose={closeDebugModal}
        />
      )}
      {/* Gradient accent bar at top */}
      <div
        className="absolute top-0 left-0 right-0 h-1"
        style={{
          background: `linear-gradient(90deg, ${COLORS.primary}, ${COLORS.primary}80)`
        }}
      ></div>

      <div className="card-body p-5">
        {/* Header */}
        <div className="mb-4">
          <div className="flex items-center gap-2 mb-1">
            <Icon icon="mdi:map-marker-path" className="w-6 h-6" style={{ color: COLORS.primary }} />
            <h3                                                                                      className="card-title text-lg font-bold text-base-content whitespace-nowrap overflow-x-auto  [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"                                              
               title={title}                                                                                                    
           >
              {title}
            </h3>
          </div>
          {description && (
            <p className="text-sm opacity-60 mt-1 line-clamp-2" title={description}>{description}</p>
          )}
        </div>

        {/* Chart */}
        <div style={{ height: `${mergedConfig.height}px` }}>
          <ReactECharts
            option={buildChartOption()}
            style={{ height: '100%', width: '100%' }}
            opts={{ renderer: 'svg' }}
          />
        </div>
      </div>

    </div>
  );
};

// Attach metadata to component
(DynamicLocationFlowChart as DynamicLocationFlowChartComponent).Metadata = METADATA;

export default DynamicLocationFlowChart;

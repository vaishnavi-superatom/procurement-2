import React, { useEffect, useState, useRef } from 'react';
import { Icon } from '@iconify/react';
import ReactECharts, { type EChartsOption } from 'echarts-for-react';
import LoadingState from '../../components/LoadingState';
import type { ComponentMetadata } from '../../types';
import { COLORS, SHADOWS, BORDER_RADIUS, TYPOGRAPHY, SPACING, CHART_COLOR_PALETTE } from '../../design-system/tokens';
import { useDebugClick } from '../useDebugClick';
import DebugPropsModal from '../DebugPropsModal';
import TruncationNote from '../../components/TruncationNote';

interface ExternalTool {
  toolId: string;
  toolName: string;
  parameters: Record<string, any>;
}

interface QueryConfig {
  sql: string;
  params?: Record<string, any>;
}

interface DynamicScatterChartProps {
  /** Stamped by the SDK when the payload is render-capped (§2.7). */
  _rowsRendered?: number;
  _rowsTotal?: number;
  query?: string | QueryConfig;
  title?: string;
  description?: string;
  timeFrame?: string;
  externalTool?: ExternalTool | null;
  config?: {
    xAxisKey?: string;
    yAxisKey?: string;
    xAxisLabel?: string; // Label/title for x-axis
    yAxisLabel?: string; // Label/title for y-axis
    seriesKey?: string;
    sizeKey?: string;
    height?: number;
    showDataLabels?: boolean;
    colorPalette?: string[];
    data?: any[];
  };
  SA_RUNTIME?: any;
}

/**
* ============================================
* DESIGN SYSTEM THEME - Using design-system/tokens.ts
* ============================================
*/
const THEME = {
  card: {
    background: COLORS.white,
    borderRadius: BORDER_RADIUS.large,
    padding: SPACING.xl,
    boxShadow: SHADOWS.card,
  },
  title: {
    fontSize: parseInt(TYPOGRAPHY.fontSize.subsection),
    fontWeight: TYPOGRAPHY.fontWeight.semibold,
    color: COLORS.text.primary,
  },
  subtitle: {
    fontSize: parseInt(TYPOGRAPHY.fontSize.body),
    color: COLORS.text.secondary,
  },
  colors: CHART_COLOR_PALETTE,
  loadingColor: COLORS.primary,
  errorColor: COLORS.error,
};


// Helper function to get case-insensitive key from object
const getCaseInsensitiveValue = (obj: any, key: string): any => {
  if (!obj || !key) return undefined;
  const actualKey = Object.keys(obj).find(k => k?.toLowerCase() === key?.toLowerCase());
  return actualKey ? obj[actualKey] : undefined;
};

// Helper function to format numbers for chart display
// >= 1000 with decimals: round to 0 decimal places
// < 1000 with decimals: round to 2 decimal places
const formatChartNumber = (value: number): string => {
  if (value === null || value === undefined || isNaN(value)) return 'N/A';

  const hasDecimals = value % 1 !== 0;

  if (!hasDecimals) {
    return value.toLocaleString('en-US', {
      minimumFractionDigits: 0,
      maximumFractionDigits: 0
    });
  } else if (Math.abs(value) >= 1000) {
    return value.toLocaleString('en-US', {
      minimumFractionDigits: 0,
      maximumFractionDigits: 0
    });
  } else {
    return value.toLocaleString('en-US', {
      minimumFractionDigits: 0,
      maximumFractionDigits: 2
    });
  }
};

const METADATA: ComponentMetadata = {
  id: 'dynamic-scatter-chart',
  name: 'DynamicScatterChart',
  displayName: 'Display correlation between two variables',
  isDisplayComp: false,
  type: 'ScatterChart',
  description: 'Displays correlation between two variables as scatter plot. Always use externalTool with SQL for data points in parameters.sql.',
  category: 'Scatter Chart',
  keywords: ['scatter', 'chart', 'dynamic', 'correlation', 'analytics', 'bubble'],
  props: {
    query: null,
    externalTool: '(object) REQUIRED. Object with toolId, toolName, parameters. Put SQL for data points in parameters.sql.',
    title: 'Chart title',
    description: 'Chart description',
    timeFrame: 'Time period for the data',
    config: {
      xAxisKey: 'REQUIRED. MUST exactly match a column name returned by the SQL query. Field name for x-axis numeric values.',
      yAxisKey: 'REQUIRED. MUST exactly match a column name returned by the SQL query. Field name for y-axis numeric values.',
      xAxisLabel: '(optional) Display label for x-axis',
      yAxisLabel: '(optional) Display label for y-axis',
      seriesKey: 'RECOMMENDED. Column name from query SELECT to identify each point or group. Each unique value gets its own color + legend entry. Without this, all points are the same color with no legend. Always set this when points need to be distinguishable.',
      sizeKey: '(optional) Column name from query SELECT for bubble size — larger values = bigger bubbles',
      height: 400,
      showDataLabels: false,
      colorPalette: CHART_COLOR_PALETTE,
    }
  }
}

interface DynamicScatterChartComponent extends React.FC<DynamicScatterChartProps> {
  Metadata: ComponentMetadata;
}

const DEFAULT_PROPS = {
  query: `SELECT
  pv.price as product_price,
  AVG(r.rating) as avg_rating,
  p.name as product_name,
  COUNT(r.review_id) as review_count
FROM product_variants pv
JOIN products p ON pv.product_id = p.product_id
LEFT JOIN reviews r ON p.product_id = r.product_id
WHERE pv.price > 0
  AND r.rating IS NOT NULL
GROUP BY pv.variant_id, pv.price, p.name
HAVING COUNT(r.review_id) >= 3
ORDER BY pv.price ASC
LIMIT 100`,
  title: 'Product Price vs. Average Rating',
  description: 'Relationship between product price and customer ratings',
  config: {
    xAxisKey: 'product_price',
    yAxisKey: 'avg_rating',
    sizeKey: 'review_count',
    height: 400,
    showDataLabels: false,
    colorPalette: CHART_COLOR_PALETTE,
  }
}

const DynamicScatterChart: React.FC<DynamicScatterChartProps> = ({
  query = DEFAULT_PROPS.query as string,
  title = DEFAULT_PROPS.title as string,
  description = DEFAULT_PROPS.description as string,
  timeFrame,
  externalTool = null,
  config = DEFAULT_PROPS.config as any,
  _rowsRendered,
  _rowsTotal,
  SA_RUNTIME = {}
}) => {
  const { isDebugModalOpen, handleDebugClick, closeDebugModal } = useDebugClick();

  // Determine data source: externalTool takes priority over query
  const hasExternalTool = externalTool && externalTool.toolId;
  const [data, setData] = useState<any[]>(config.data || []);
  const [loading, setLoading] = useState<boolean>(!(config.data && config.data.length > 0) && (hasExternalTool ? true : !config.data));
  const [error, setError] = useState<string | null>(null);

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
  const [isDescriptionExpanded, setIsDescriptionExpanded] = useState<boolean>(false);
  const [isTitleExpanded, setIsTitleExpanded] = useState<boolean>(false);

  const [filterLabels, setFilterLabels] = useState<Record<string, string>>(() => {
    const eventName = SA_RUNTIME?.uiBlockId ? `${SA_RUNTIME.uiBlockId}_FILTER` : 'GLOBAL_FILTER';
    return (window as any).__FILTER_STATE__?.[eventName]?.labels || {};
  });

  const interpolate = (template: string, labels: Record<string, string>): string => {
    if (Object.keys(labels).length === 0) {
      return template.replace(/\{%(\w+)%\}\s*[-–—]\s*/g, '').replace(/\{%(\w+)%\}/g, '').trim();
    }
    return template.replace(/\{%(\w+)%\}/g, (_, key) =>
      labels[key] !== undefined && labels[key] !== '' ? labels[key] : ''
    );
  };
  const displayTitle = interpolate(title, filterLabels);
  const displayDescription = interpolate(description, filterLabels);
  const displayTimeFrame = timeFrame ? interpolate(timeFrame, filterLabels) : '';

  const chartContainerRef = useRef<HTMLDivElement>(null);

  const defaultConfig = DEFAULT_PROPS.config as any;
  const xAxisKey = config.xAxisKey || 'x';
  const yAxisKey = config.yAxisKey || 'y';
  const xAxisLabel = config.xAxisLabel;
  const yAxisLabel = config.yAxisLabel;
  const seriesKey = config.seriesKey || null;
  const sizeKey = config.sizeKey || null;
  const height = config.height || defaultConfig.height || 400;
  const showDataLabels = config.showDataLabels !== undefined ? config.showDataLabels : (defaultConfig.showDataLabels !== undefined ? defaultConfig.showDataLabels : false);
  const colorPalette = config.colorPalette || defaultConfig.colorPalette || THEME.colors;

  
  // Extract primitive values for stable useEffect dependencies
  // This prevents re-fetching when parent re-renders with same data but new object references
  const toolId = externalTool?.toolId;
  const toolParamsStr = externalTool?.parameters ? JSON.stringify(externalTool.parameters) : '';
  const queryStr = typeof query === 'string' ? query : JSON.stringify(query);
  const hasConfigData = !!config.data;
  const uiBlockId = SA_RUNTIME?.uiBlockId;

  useEffect(() => {
    // Priority: config.data (prefetched) > externalTool > query
    if (config.data && config.data.length > 0) return;
    // If filters have already settled before this component mounted, the
    // filter-listener effect below will fetch with the complete, current
    // params via its catch-up branch — skip this default-params fetch to
    // avoid firing two concurrent requests for the same data.
    const eventName = uiBlockId ? `${uiBlockId}_FILTER` : 'GLOBAL_FILTER';
    const alreadySettled = (window as any).__FILTER_STATE__?.[eventName]?.params;
    if (alreadySettled && Object.keys(alreadySettled).length > 0) return;
    if (hasExternalTool) {
      fetchExternalToolData();
    } else {
      fetchData();
    }
  // Use primitive dependencies instead of objects to prevent unnecessary re-fetches
  }, [queryStr, toolId, toolParamsStr, hasConfigData]);

  // Listen for filter events scoped to this uiBlockId
  // Debounces the actual fetch: a cascading filter (listenTo another filter)
  // re-fetches its own options and re-dispatches once resolved, so a single
  // upstream change can fire 2+ events in quick succession here. Fetching on
  // each one individually causes a visible flash of stale-combo data before
  // the final, correct combo lands. Coalescing into one fetch after the burst
  // settles fixes that without needing to know the filter dependency graph.
  const filterDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const eventName = uiBlockId
      ? `${uiBlockId}_FILTER`
      : 'GLOBAL_FILTER';

    const handleFilterChange = (event: CustomEvent) => {
      const { params, isInitial, filterKey: sourceFilterKey, filterLabel } = event.detail || {};

      if (sourceFilterKey && filterLabel !== undefined) {
        setFilterLabels(prev => ({ ...prev, [`${sourceFilterKey}Label`]: filterLabel }));
      }

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

    // Catch up on filter state broadcast before this listener existed. When
    // every widget on a dashboard mounts simultaneously for the first time
    // (e.g. a freshly-generated dashboard, not one built incrementally
    // widget-by-widget), the filter's own mount-time dispatch can run and
    // finish before this component's effect even attaches its listener —
    // the one-shot event is missed entirely and never replayed.
    // window.__FILTER_STATE__ persists the last dispatch regardless, so
    // re-reading it here is immune to that mount-order race.
    const currentFilterState = (window as any).__FILTER_STATE__?.[eventName];
    if (currentFilterState?.labels && Object.keys(currentFilterState.labels).length > 0) {
      setFilterLabels(prev => ({ ...prev, ...currentFilterState.labels }));
    }
    if (currentFilterState?.params && Object.keys(currentFilterState.params).length > 0) {
      setFilterParams(prev => {
        const mergedParams = { ...prev, ...currentFilterState.params };
        if (hasExternalTool) {
          fetchExternalToolDataWithParams(mergedParams);
        } else if (!hasConfigData) {
          fetchDataWithParams(mergedParams);
        }
        return mergedParams;
      });
    }

    return () => {
      window.removeEventListener(eventName, handleFilterChange as EventListener);
      if (filterDebounceRef.current) clearTimeout(filterDebounceRef.current);
    };
  // Use primitive dependencies
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
    const d = document as any;
    const handleFullscreenChange = () => {
      setIsFullscreen(
        Boolean(d.fullscreenElement || d.webkitFullscreenElement || d.msFullscreenElement)
      );
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
    document.addEventListener('MSFullscreenChange', handleFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', handleFullscreenChange);
      document.removeEventListener('MSFullscreenChange', handleFullscreenChange);
    };
  }, []);

  const enterFullscreen = () => {
    const elem = chartContainerRef.current as any;
    if (!elem) return;
    const request =
      elem.requestFullscreen || elem.webkitRequestFullscreen || elem.msRequestFullscreen;
    /* Rejects when the browser does not trust the gesture, or in an iframe
       without `allowfullscreen`. Nothing to do but stay as we are — the chart
       is still on screen and still readable. */
    if (request) Promise.resolve(request.call(elem)).catch(() => {});
  };

  const exitFullscreen = () => {
    const d = document as any;
    if (!(d.fullscreenElement || d.webkitFullscreenElement || d.msFullscreenElement)) return;
    const exit = d.exitFullscreen || d.webkitExitFullscreen || d.msExitFullscreen;
    if (exit) Promise.resolve(exit.call(d)).catch(() => {});
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

      // Handle query as string or object { sql, params }
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

  const fetchDataWithParams = async (params: Record<string, any>) => {
    const requestId = ++fetchIdRef.current; // see fetchData for why this guard exists
    setLoading(true);
    setError(null);

    try {
      const queryExecutor = (window as any).SA?.QueryExecutor;

      if (!queryExecutor) {
        throw new Error('QueryExecutor not available');
      }

      let sqlString: string;
      let baseParams: Record<string, any> = {};

      if (typeof query === 'object' && query !== null && 'sql' in query) {
        sqlString = query.sql;
        baseParams = query.params || {};
      } else {
        sqlString = query as string;
      }

      const mergedParams = { ...baseParams, ...params };
      const finalQuery = JSON.stringify({ sql: sqlString, values: mergedParams });

      console.log(`[DynamicScatterChart] Fetching with params:`, mergedParams);

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

      // Extract data from result - handle various response formats
      let chartData: any[] = [];

      if (result?.data) {
        if (Array.isArray(result.data)) {
          chartData = result.data;
        } else if (result.data.data && Array.isArray(result.data.data)) {
          chartData = result.data.data;
        } else if (result.data.rows && Array.isArray(result.data.rows)) {
          chartData = result.data.rows;
        } else if (typeof result.data === 'object') {
          chartData = [result.data];
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
      console.error('Error fetching data from external tool:', err);
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

      console.log(`[DynamicScatterChart] Fetching external tool with params:`, mergedParameters);

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
          externalTool: { ...externalTool, parameters: mergedParameters },
          formData: params,
          SA_RUNTIME
        });
      }

      let chartData: any[] = [];

      if (result?.data) {
        if (Array.isArray(result.data)) {
          chartData = result.data;
        } else if (result.data.data && Array.isArray(result.data.data)) {
          chartData = result.data.data;
        } else if (result.data.rows && Array.isArray(result.data.rows)) {
          chartData = result.data.rows;
        } else if (typeof result.data === 'object') {
          chartData = [result.data];
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
      console.error('Error fetching data from external tool with params:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch data from external tool');
    } finally {
      if (requestId === fetchIdRef.current) setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="card bg-base-100 shadow-sm border border-base-300 p-6 h-full flex flex-col">
        <div className="skeleton h-6 w-48 mb-2"></div>
        <div className="skeleton h-4 w-64 mb-4"></div>
        <div className="skeleton w-full flex-1 min-h-0"></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="card bg-base-100 shadow-sm border border-base-300 p-6" style={{ height: '100%' }} onClick={handleDebugClick}>
        {isDebugModalOpen && (
          <DebugPropsModal
            componentName="DynamicScatterChart"
            componentId={SA_RUNTIME?.componentId || 'unknown'}
            props={{ title, description, timeFrame, externalTool: liveExternalTool, config, filterParams, error }}
            isOpen={isDebugModalOpen}
            onClose={closeDebugModal}
          />
        )}
        <div className="alert alert-error">
          <Icon icon="mdi:alert-circle" className="w-5 h-5 flex-shrink-0" />
          <div>
            <p className="text-sm font-medium">Error loading chart</p>
            <p className="text-xs opacity-80 mt-1">{error}</p>
          </div>
        </div>
      </div>
    );
  }

  // Validate config keys against actual data columns — ignore keys that don't exist in the data
  const sampleRow = data.length > 0 ? data[0] : null;
  const keyExistsInData = (key: string | null): boolean => {
    if (!key || !sampleRow) return false;
    return getCaseInsensitiveValue(sampleRow, key) !== undefined;
  };
  const autoSeriesKey = !seriesKey && sampleRow
    ? Object.keys(sampleRow).find(k => {
        const v = sampleRow[k];
        return typeof v === 'string' && k !== xAxisKey && k !== yAxisKey && k !== sizeKey;
      }) ?? null
    : null;
  const validSeriesKey = keyExistsInData(seriesKey) ? seriesKey : (autoSeriesKey && keyExistsInData(autoSeriesKey) ? autoSeriesKey : null);
  const validSizeKey = keyExistsInData(sizeKey) ? sizeKey : null;

  // Prepare chart data
  let series: any[] = [];

  // Pre-compute min/max for sizeKey to normalize bubble sizes to 5–50px
  let sizeMin = Infinity;
  let sizeMax = -Infinity;
  if (validSizeKey) {
    data.forEach(item => {
      const v = parseFloat(getCaseInsensitiveValue(item, validSizeKey) || 0);
      if (v < sizeMin) sizeMin = v;
      if (v > sizeMax) sizeMax = v;
    });
    if (!isFinite(sizeMin)) sizeMin = 0;
    if (!isFinite(sizeMax)) sizeMax = 0;
  }
  const normalizeBubbleSize = (value: number): number => {
    if (sizeMax === sizeMin) return 27; // midpoint when all values are equal
    const ratio = (value - sizeMin) / (sizeMax - sizeMin);
    return 5 + ratio * 45; // 5–50px range
  };

  if (validSeriesKey) {
    // Multi-series scatter chart (grouped by seriesKey)
    // Each unique seriesKey value gets its own color + legend entry
    const seriesMap = new Map<string, any[]>();

    data.forEach(item => {
      const seriesName = String(getCaseInsensitiveValue(item, validSeriesKey) ?? '');
      const xValue = parseFloat(getCaseInsensitiveValue(item, xAxisKey) || 0);
      const yValue = parseFloat(getCaseInsensitiveValue(item, yAxisKey) || 0);
      const sizeValue = validSizeKey ? parseFloat(getCaseInsensitiveValue(item, validSizeKey) || 10) : 10;

      if (!seriesMap.has(seriesName)) {
        seriesMap.set(seriesName, []);
      }

      seriesMap.get(seriesName)!.push(
        validSizeKey ? [xValue, yValue, sizeValue] : [xValue, yValue]
      );
    });

    let colorIdx = 0;
    seriesMap.forEach((seriesData, seriesName) => {
      series.push({
        name: seriesName,
        type: 'scatter',
        data: seriesData,
        symbolSize: validSizeKey
          ? (dataItem: any) => normalizeBubbleSize(dataItem[2])
          : 18,
        itemStyle: {
          color: colorPalette[colorIdx % colorPalette.length],
          opacity: 0.7
        },
        emphasis: {
          itemStyle: {
            opacity: 1,
            borderColor: COLORS.white,
            borderWidth: 2
          }
        },
        label: showDataLabels ? {
          show: true,
          position: 'top',
          fontSize: parseInt(TYPOGRAPHY.fontSize.tiny),
          color: COLORS.text.secondary,
          formatter: (params: any) => {
            const d = params.data || params.value;
            const yVal = Array.isArray(d) ? d[1] : d;
            return typeof yVal === 'number' ? formatChartNumber(yVal) : yVal;
          }
        } : undefined
      });
      colorIdx++;
    });
  } else {
    // Single series scatter chart — all points same color, no legend
    const scatterData = data.map(item => {
      const xValue = parseFloat(getCaseInsensitiveValue(item, xAxisKey) || 0);
      const yValue = parseFloat(getCaseInsensitiveValue(item, yAxisKey) || 0);
      const sizeValue = validSizeKey ? parseFloat(getCaseInsensitiveValue(item, validSizeKey) || 10) : 10;

      return validSizeKey ? [xValue, yValue, sizeValue] : [xValue, yValue];
    });

    series = [{
      type: 'scatter',
      data: scatterData,
      symbolSize: validSizeKey
        ? (dataItem: any) => normalizeBubbleSize(dataItem[2])
        : 12,
      itemStyle: {
        color: colorPalette[0],
        opacity: 0.7
      },
      emphasis: {
        itemStyle: {
          opacity: 1,
          borderColor: COLORS.white,
          borderWidth: 2
        }
      },
      label: showDataLabels ? {
        show: true,
        position: 'top',
        fontSize: parseInt(TYPOGRAPHY.fontSize.tiny),
        color: COLORS.text.secondary
      } : undefined
    }];
  }

  const option: EChartsOption = {
    tooltip: {
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
        const d = params.data || params.value;
        const xVal = Array.isArray(d) ? d[0] : d;
        const yVal = Array.isArray(d) ? d[1] : d;
        const xFormatted = typeof xVal === 'number' ? formatChartNumber(xVal) : xVal;
        const yFormatted = typeof yVal === 'number' ? formatChartNumber(yVal) : yVal;
        const header = validSeriesKey && params.seriesName ? `<div style="font-weight: bold; margin-bottom: 4px;">${params.seriesName}</div>` : '';
        const xLabel = xAxisLabel || xAxisKey;
        const yLabel = yAxisLabel || yAxisKey;
        const sizeVal = validSizeKey && Array.isArray(d) ? d[2] : null;
        const sizeLine = sizeVal != null ? `<div>${params.marker} ${validSizeKey}: ${typeof sizeVal === 'number' ? formatChartNumber(sizeVal) : sizeVal}</div>` : '';
        return `${header}<div>${params.marker} ${xLabel}: ${xFormatted}</div><div>${params.marker} ${yLabel}: ${yFormatted}</div>${sizeLine}`;
      }
    },
    legend: validSeriesKey ? {
      type: 'scroll', // Enable scrolling for many items
      orient: 'horizontal',
      top: 10,
      left: 'center',
      padding: [5, 5, 5, 5],
      pageButtonItemGap: 5,
      pageButtonPosition: 'end',
      pageIconSize: 12,
      pageTextStyle: {
        color: COLORS.text.secondary,
        fontSize: parseInt(TYPOGRAPHY.fontSize.tiny)
      },
      textStyle: {
        color: COLORS.text.secondary,
        fontSize: parseInt(TYPOGRAPHY.fontSize.small)
      },
      // Show max 2 rows, then paginate
      height: 50
    } : undefined,
    grid: {
      left: '3%',
      right: '4%',
      bottom: xAxisLabel ? '10%' : '3%',
      top: validSeriesKey ? (yAxisLabel ? '90px' : '80px') : (yAxisLabel ? '12%' : '10%'),
      containLabel: true
    },
    xAxis: {
      type: 'value',
      name: xAxisLabel,
      nameLocation: 'middle',
      nameGap: 30,
      nameTextStyle: {
        color: COLORS.text.primary,
        fontSize: parseInt(TYPOGRAPHY.fontSize.small),
        fontWeight: 'bold'
      },
      axisLabel: {
        color: COLORS.text.secondary,
        fontSize: parseInt(TYPOGRAPHY.fontSize.small)
      },
      splitLine: {
        lineStyle: {
          color: COLORS.borderGray,
          type: 'dashed'
        }
      },
      axisLine: {
        lineStyle: {
          color: COLORS.borderGray
        }
      }
    },
    yAxis: {
      type: 'value',
      name: yAxisLabel,
      nameLocation: 'end',
      nameTextStyle: {
        color: COLORS.text.primary,
        fontSize: parseInt(TYPOGRAPHY.fontSize.small),
        fontWeight: 'bold',
        align: 'left',
        padding: [0, 0, 5, 0]
      },
      axisLabel: {
        color: COLORS.text.secondary,
        fontSize: parseInt(TYPOGRAPHY.fontSize.small),
        formatter: (value: number) => formatChartNumber(value)
      },
      splitLine: {
        lineStyle: {
          color: COLORS.borderGray,
          type: 'dashed'
        }
      },
      axisLine: {
        lineStyle: {
          color: COLORS.borderGray
        }
      }
    },
    series: series
  };

  // Chart content component - renders the actual chart UI
  /* The chart. One of them — this is the element that goes fullscreen, rather
     than a copy of it being rendered somewhere else to be fullscreened. */
  const renderChartContent = () => (
    <div
      ref={chartContainerRef}
      className="card bg-base-100 shadow-sm border border-base-300 hover:shadow-md transition-shadow duration-200 overflow-hidden [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden relative"
      /* `height: 100%` covers both cases. In place it fills whatever panel the
         dashboard gave it; fullscreen, the browser's own `:fullscreen` rule
         makes this element the size of the screen, so 100% is the screen. */
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
      }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onClick={handleDebugClick}
    >
      {isDebugModalOpen && (
        <DebugPropsModal
          componentName="DynamicScatterChart"
          componentId={SA_RUNTIME?.componentId || 'unknown'}
          props={{ title, description, timeFrame, externalTool: liveExternalTool, config, filterParams }}
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

      {/* Fullscreen button - shows on hover (enter) or when in fullscreen (exit) */}
      {(isHovered || isFullscreen) && (
        <button
          onClick={isFullscreen ? exitFullscreen : enterFullscreen}
          className="absolute top-2 right-1 z-10"
          title={isFullscreen ? "Exit fullscreen" : "Enter fullscreen (ESC to exit)"}
        >
          <Icon icon={isFullscreen ? "mdi:fullscreen-exit" : "mdi:fullscreen"} className="w-5 h-5" />
        </button>
      )}

      <div className="card-body p-5 flex-1 flex flex-col" style={{ minHeight: 0 }}>
        {/* Header */}
        <div className="mb-4">
            <h3
              className={`text-lg font-bold text-base-content ${isTitleExpanded ? '' : 'overflow-hidden whitespace-nowrap text-ellipsis'}`}
              title={displayTitle}
              onClick={() => setIsTitleExpanded(prev => !prev)}
            >
              {displayTitle}
            </h3>
          {displayDescription && (
            <p
              className={`text-sm opacity-60 mt-1 min-h-[2.5em] ${isDescriptionExpanded ? '' : 'line-clamp-2'}`}
              onClick={() => setIsDescriptionExpanded(prev => !prev)}
            >
              {displayDescription}
            </p>
          )}
          <TruncationNote rendered={_rowsRendered} total={_rowsTotal} />
          {displayTimeFrame && (
            <div className="flex items-center gap-1.5 mt-2">
              <Icon icon="mdi:calendar-range" className="w-3.5 h-3.5 opacity-50" />
              <span className="text-xs opacity-50 font-medium">{displayTimeFrame}</span>
            </div>
          )}
        </div>

        {/* Chart */}
        {/* Fills what the card has left, in place and fullscreen alike — the
            card is the fullscreen element now, so there is one case. */}
        <div style={{ width: '100%', flex: '1 1 0', minHeight: 0 }}>
          <ReactECharts
            option={option}
            style={{ height: '100%', width: '100%' }}
            opts={{ renderer: 'svg' }}
          />
        </div>

      </div>
    </div>
  );

  /* One chart, rendered where it belongs. Fullscreen is the browser taking
     this element to the screen — not a second copy of it somewhere else. */
  return renderChartContent();
};

// Attach metadata to component
(DynamicScatterChart as DynamicScatterChartComponent).Metadata = METADATA;

export default DynamicScatterChart;

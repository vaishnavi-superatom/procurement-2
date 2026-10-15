import React, { useEffect, useState, useRef } from 'react';
import { Icon } from '@iconify/react';
import ReactECharts, { type EChartsOption } from 'echarts-for-react';
import LoadingState from '../../components/LoadingState';
import type { ComponentMetadata } from '../../types';
import { COLORS, SHADOWS, BORDER_RADIUS, TYPOGRAPHY, SPACING } from '../../design-system/tokens';
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

interface DynamicHeatmapChartProps {
  query?: string | QueryConfig | null;
  title?: string;
  description?: string;
  timeFrame?: string;
  externalTool?: ExternalTool | null;
  config?: {
    xAxisKey?: string;
    yAxisKey?: string;
    valueKey?: string;
    height?: number;
    showValues?: boolean;
    colorRange?: string[];
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
  colorRange: ['#E8F4FD', '#A8D5F2', '#5AAEE3', '#2E86D4', '#1E5FA0'],
  loadingColor: COLORS.primary,
  errorColor: COLORS.error,
};


// Helper function to get case-insensitive key from object
const getCaseInsensitiveValue = (obj: any, key: string): any => {
  if (!obj) return undefined;
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
  id: 'dynamic-heatmap-chart',
  name: 'DynamicHeatmapChart',
  displayName: 'Display data intensity as heatmap',
  isDisplayComp: false,
  type: 'HeatmapChart',
  description: 'Displays data intensity across two categorical dimensions using color gradients. Always use externalTool with SQL GROUP BY for intensity aggregations in parameters.sql.',
  category: 'Heatmap Chart',
  keywords: ['heatmap', 'chart', 'dynamic', 'correlation', 'matrix', 'analytics', 'intensity'],
  props: {
    query: null,
    externalTool: '(object) REQUIRED. Object with toolId, toolName, parameters. Put SQL with GROUP BY in parameters.sql.',
    title: 'Chart title',
    description: 'Chart description',
    timeFrame: 'Time period for the data',
    config: {
      xAxisKey: 'MUST exactly match a column name returned by the SQL query. Field name for horizontal dimension.',
      yAxisKey: 'MUST exactly match a column name returned by the SQL query. Field name for vertical dimension.',
      valueKey: 'MUST exactly match a column name returned by the SQL query. Field name for intensity/numeric value.',
      height: 400,
      showValues: true,
      colorRange: ['#E8F4FD', '#A8D5F2', '#5AAEE3', '#2E86D4', '#1E5FA0'],
    }
  }
}


interface DynamicHeatmapChartComponent extends React.FC<DynamicHeatmapChartProps> {
  Metadata: ComponentMetadata;
}

const DEFAULT_PROPS = {
  query: `WITH order_data AS (
  SELECT
    o.order_id,
    EXTRACT(DOW FROM o.order_date) as day_of_week,
    EXTRACT(HOUR FROM o.order_date) as hour_of_day
  FROM orders o
  WHERE o.status NOT IN ('Cancelled', 'Failed')
    AND o.order_date >= CURRENT_DATE - INTERVAL '90 days'
)
SELECT
  CASE day_of_week
    WHEN 0 THEN 'Sunday'
    WHEN 1 THEN 'Monday'
    WHEN 2 THEN 'Tuesday'
    WHEN 3 THEN 'Wednesday'
    WHEN 4 THEN 'Thursday'
    WHEN 5 THEN 'Friday'
    WHEN 6 THEN 'Saturday'
  END as day_name,
  hour_of_day::TEXT as hour,
  COUNT(*) as order_count
FROM order_data
GROUP BY day_of_week, day_name, hour_of_day
ORDER BY day_of_week, hour_of_day`,
  title: 'Orders Heatmap by Day and Hour',
  description: 'Order volume patterns across days of week and hours of day',
  config: {
    xAxisKey: 'hour',
    yAxisKey: 'day_name',
    valueKey: 'order_count',
    height: 400,
    showValues: false,
    colorRange: ['#E8F4FD', '#A8D5F2', '#5AAEE3', '#2E86D4', '#1E5FA0'],
  }
}

const DynamicHeatmapChart: React.FC<DynamicHeatmapChartProps> = ({
  query = DEFAULT_PROPS.query as string,
  title = DEFAULT_PROPS.title as string,
  description = DEFAULT_PROPS.description as string,
  timeFrame,
  externalTool = null,
  config = DEFAULT_PROPS.config as any,
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
  const xAxisKey = config.xAxisKey || defaultConfig.xAxisKey || 'x';
  const yAxisKey = config.yAxisKey || defaultConfig.yAxisKey || 'y';
  const valueKey = config.valueKey || defaultConfig.valueKey || 'value';
  const height = config.height || defaultConfig.height || 400;
  const showValues = config.showValues !== undefined ? config.showValues : (defaultConfig.showValues !== undefined ? defaultConfig.showValues : true);
  const colorRange = config.colorRange || defaultConfig.colorRange || THEME.colorRange;

   // Extract primitive values for stable useEffect dependencies
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

  // Fetch data with filter params - merges with query params
  const fetchDataWithParams = async (filterParams: Record<string, any>) => {
    const requestId = ++fetchIdRef.current; // see fetchData for why this guard exists
    setLoading(true);
    setError(null);

    try {
      const queryExecutor = (window as any).SA?.QueryExecutor;

      if (!queryExecutor) {
        throw new Error('QueryExecutor not available');
      }

      // Extract SQL and existing params from query (handles both string and object formats)
      let sqlString: string;
      let existingParams: Record<string, any> = {};

      if (typeof query === 'object' && query !== null && 'sql' in query) {
        // New format: { sql, params }
        sqlString = query.sql;
        existingParams = query.params || {};
      } else if (typeof query === 'string') {
        // Legacy: try to parse as JSON, otherwise use as plain SQL
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

      // Merge existing params with filter params (filter params take precedence)
      const mergedParams = { ...existingParams, ...filterParams };
      const finalQuery = JSON.stringify({ sql: sqlString, values: mergedParams });

      console.log('[DynamicHeatmapChart] Executing parameterized query:', finalQuery);

      const result = await queryExecutor.executeQuery({ query: finalQuery, SA_RUNTIME });
      if (requestId !== fetchIdRef.current) return; // superseded by a newer fetch — discard

      if (result && result.length > 0) {
        setData(result);
      } else {
        setData([]);
      }
    } catch (err) {
      if (requestId !== fetchIdRef.current) return;
      console.error('[DynamicHeatmapChart] Error fetching data with params:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch data');
    } finally {
      if (requestId === fetchIdRef.current) setLoading(false);
    }
  };

  // Fetch external tool data with filter params
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

      console.log(`[DynamicHeatmapChart] Fetching external tool with filter params:`, mergedParameters);

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

      // Extract data from the result (same logic as fetchExternalToolData)
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
      console.error('[DynamicHeatmapChart] Error fetching external tool data with params:', err);
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
            componentName="DynamicHeatmapChart"
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

  // Extract unique X and Y axis values
  const xAxisData = Array.from(new Set(data.map(item => getCaseInsensitiveValue(item, xAxisKey)))).sort();
  const yAxisData = Array.from(new Set(data.map(item => getCaseInsensitiveValue(item, yAxisKey)))).sort();

  // Create a map for quick lookup
  const dataMap = new Map<string, number>();
  data.forEach(item => {
    const xValue = getCaseInsensitiveValue(item, xAxisKey);
    const yValue = getCaseInsensitiveValue(item, yAxisKey);
    const value = parseFloat(getCaseInsensitiveValue(item, valueKey) || 0);
    dataMap.set(`${xValue}||${yValue}`, value);
  });

  // Prepare heatmap data in format: [xIndex, yIndex, value]
  const heatmapData: any[] = [];
  const values: number[] = [];

  yAxisData.forEach((yValue, yIdx) => {
    xAxisData.forEach((xValue, xIdx) => {
      const value = dataMap.get(`${xValue}||${yValue}`) || 0;
      heatmapData.push([xIdx, yIdx, value]);
      values.push(value);
    });
  });

  // Calculate min and max for visualization
  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);

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
        const data = params.data || params.value;
        const val = Array.isArray(data) ? data[2] : data;
        const formatted = typeof val === 'number' ? formatChartNumber(val) : val;
        return `<div>${params.marker} ${formatted}</div>`;
      }
    },
    grid: {
      left: '3%',
      right: '10%',
      bottom: '3%',
      top: '3%',
      containLabel: true
    },
    xAxis: {
      type: 'category',
      data: xAxisData,
      splitArea: {
        show: true,
        areaStyle: {
          color: ['rgba(250, 250, 250, 0.3)', 'rgba(200, 200, 200, 0.1)']
        }
      },
      axisLabel: {
        color: COLORS.text.secondary,
        fontSize: parseInt(TYPOGRAPHY.fontSize.small),
        rotate: xAxisData.length > 12 ? 45 : 0
      },
      axisLine: {
        lineStyle: {
          color: COLORS.borderGray
        }
      }
    },
    yAxis: {
      type: 'category',
      data: yAxisData,
      splitArea: {
        show: true,
        areaStyle: {
          color: ['rgba(250, 250, 250, 0.3)', 'rgba(200, 200, 200, 0.1)']
        }
      },
      axisLabel: {
        color: COLORS.text.secondary,
        fontSize: parseInt(TYPOGRAPHY.fontSize.small)
      },
      axisLine: {
        lineStyle: {
          color: COLORS.borderGray
        }
      }
    },
    visualMap: {
      min: minValue,
      max: maxValue,
      calculable: true,
      orient: 'vertical',
      right: '2%',
      top: 'center',
      inRange: {
        color: colorRange
      },
      textStyle: {
        color: COLORS.text.secondary,
        fontSize: parseInt(TYPOGRAPHY.fontSize.small)
      }
    },
    series: [
      {
        type: 'heatmap',
        data: heatmapData,
        label: {
          show: showValues,
          color: COLORS.text.primary,
          fontSize: parseInt(TYPOGRAPHY.fontSize.tiny),
          fontWeight: TYPOGRAPHY.fontWeight.medium
        },
        emphasis: {
          itemStyle: {
            shadowBlur: 10,
            shadowColor: 'rgba(0, 0, 0, 0.5)',
            borderColor: COLORS.primary,
            borderWidth: 2
          }
        }
      }
    ]
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
          componentName="DynamicHeatmapChart"
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
(DynamicHeatmapChart as DynamicHeatmapChartComponent).Metadata = METADATA;

export default DynamicHeatmapChart;

import React, { useEffect, useState, useRef } from 'react';
import { createPortal } from 'react-dom';
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

interface DynamicWaterfallChartProps {
  query?: string | QueryConfig | null;
  title?: string;
  description?: string;
  timeFrame?: string;
  externalTool?: ExternalTool | null;
  config?: {
    categoryKey?: string;
    valueKey?: string;
    height?: number;
    showConnectors?: boolean;
    showDataLabels?: boolean;
    colors?: {
      increase?: string;
      decrease?: string;
      total?: string;
    };
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
  colors: {
    increase: COLORS.success,
    decrease: COLORS.error,
    total: COLORS.primary,
  },
  loadingColor: COLORS.primary,
  errorColor: COLORS.error,
};

// Helper function to get case-insensitive key from object
const getCaseInsensitiveValue = (obj: any, key: string): any => {
  if (!obj) return undefined;
  const actualKey = Object.keys(obj).find(k => k?.toLowerCase() === key?.toLowerCase());
  return actualKey ? obj[actualKey] : undefined;
};

const METADATA: ComponentMetadata = {
  id: 'dynamic-waterfall-chart',
  name: 'DynamicWaterfallChart',
  displayName: 'Show monthly revenue waterfall as chart',
  isDisplayComp: false,
  type: 'WaterfallChart',
  description: 'Displays cumulative effect of sequential positive and negative values. Always use externalTool with SQL in parameters.sql.',
  category: 'Waterfall Chart',
  keywords: ['waterfall', 'chart', 'dynamic', 'cumulative', 'sequential', 'margin', 'bridge', 'external', 'tool'],
  props: {
    query: null,
    externalTool: '(object) REQUIRED. Object with toolId, toolName, parameters. Put SQL query in parameters.sql.',
    title: 'title for waterfall chart',
    description: 'description for waterfall chart',
    config: {
      categoryKey: 'MUST exactly match a column name returned by the SQL query. Field name for the step/category labels.',
      valueKey: 'MUST exactly match a column name returned by the SQL query. Field name for the numeric changes.',
      height: 400,
      showConnectors: true,
      showDataLabels: true,
      colors: {
        increase: COLORS.success,
        decrease: COLORS.error,
        total: COLORS.primary,
      }
    }
  }
}

interface DynamicWaterfallChartComponent extends React.FC<DynamicWaterfallChartProps> {
  Metadata: ComponentMetadata;
}

const DEFAULT_PROPS = {
  query: `WITH monthly_revenue AS (
  SELECT
    TO_CHAR(order_date, 'Mon YYYY') as month,
    DATE_TRUNC('month', order_date) as month_date,
    SUM(total_amount) as revenue
  FROM orders
  WHERE status NOT IN ('Cancelled', 'Failed')
    AND order_date >= CURRENT_DATE - INTERVAL '6 months'
  GROUP BY DATE_TRUNC('month', order_date), TO_CHAR(order_date, 'Mon YYYY')
  ORDER BY month_date
)
SELECT
  month as category,
  revenue as value
FROM monthly_revenue
LIMIT 6`,
  title: 'Monthly Revenue Waterfall',
  description: 'Cumulative revenue changes over the last 6 months',
  config: {
    categoryKey: 'category',
    valueKey: 'value',
    height: 400,
    showConnectors: true,
    showDataLabels: true,
    colors: {
      increase: COLORS.success,
      decrease: COLORS.error,
      total: COLORS.primary,
    }
  }
}

const DynamicWaterfallChart: React.FC<DynamicWaterfallChartProps> = ({
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
  const [showPortal, setShowPortal] = useState<boolean>(false);
  const [isDescriptionExpanded, setIsDescriptionExpanded] = useState<boolean>(false);
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const portalContainerRef = useRef<HTMLDivElement>(null);

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

  const defaultConfig = DEFAULT_PROPS.config as any;
  const categoryKey = config.categoryKey || defaultConfig.categoryKey || 'category';
  const valueKey = config.valueKey || defaultConfig.valueKey || 'value';
  const height = config.height || defaultConfig.height || 400;
  // Note: showConnectors is available in config but not yet implemented in the chart
  // const showConnectors = config.showConnectors !== undefined ? config.showConnectors : (defaultConfig.showConnectors !== undefined ? defaultConfig.showConnectors : true);
  const showDataLabels = config.showDataLabels !== undefined ? config.showDataLabels : (defaultConfig.showDataLabels !== undefined ? defaultConfig.showDataLabels : true);

  const colors = {
    increase: config.colors?.increase || defaultConfig.colors?.increase || THEME.colors.increase,
    decrease: config.colors?.decrease || defaultConfig.colors?.decrease || THEME.colors.decrease,
    total: config.colors?.total || defaultConfig.colors?.total || THEME.colors.total,
  };

  
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
    const handleFullscreenChange = () => {
      const isCurrentlyFullscreen = Boolean(document.fullscreenElement);
      setIsFullscreen(isCurrentlyFullscreen);
      if (!isCurrentlyFullscreen && showPortal) {
        setShowPortal(false);
      }
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, [showPortal]);

  // Enter fullscreen via portal
  const enterFullscreen = () => {
    setShowPortal(true);
  };

  // Request fullscreen on portal after it renders
  useEffect(() => {
    if (showPortal && portalContainerRef.current && !isFullscreen) {
      const timer = setTimeout(() => {
        portalContainerRef.current?.requestFullscreen().catch((err) => {
          console.error('Failed to enter fullscreen:', err);
          setShowPortal(false);
        });
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [showPortal, isFullscreen]);

  // Exit fullscreen
  const exitFullscreen = () => {
    if (document.fullscreenElement) {
      document.exitFullscreen();
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

      console.log('[DynamicWaterfallChart] Executing parameterized query:', finalQuery);

      const result = await queryExecutor.executeQuery({ query: finalQuery, SA_RUNTIME });
      if (requestId !== fetchIdRef.current) return; // superseded by a newer fetch — discard

      if (result && result.length > 0) {
        setData(result);
      } else {
        setData([]);
      }
    } catch (err) {
      if (requestId !== fetchIdRef.current) return;
      console.error('[DynamicWaterfallChart] Error fetching data with params:', err);
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

      console.log(`[DynamicWaterfallChart] Fetching external tool with filter params:`, mergedParameters);

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
      console.error('[DynamicWaterfallChart] Error fetching external tool data with params:', err);
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
            componentName="DynamicWaterfallChart"
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

  // Prepare waterfall chart data
  const categories: string[] = [];
  const values: number[] = [];
  let cumulative = 0;

  data.forEach(item => {
    const category = getCaseInsensitiveValue(item, categoryKey);
    const value = parseFloat(getCaseInsensitiveValue(item, valueKey) || 0);

    categories.push(category);
    values.push(value);
  });

  // Calculate waterfall data
  // Each bar needs: [start, end] where start is the cumulative before this value
  const waterfallData: any[] = [];
  const assistData: any[] = []; // Helper series for floating bars

  cumulative = 0;
  values.forEach((value, idx) => {
    const isLast = idx === values.length - 1;

    if (idx === 0) {
      // First bar starts from 0
      waterfallData.push({
        value: value,
        itemStyle: {
          color: value >= 0 ? colors.increase : colors.decrease
        }
      });
      assistData.push(0);
      cumulative = value;
    } else if (isLast) {
      // Last bar shows total
      waterfallData.push({
        value: cumulative,
        itemStyle: {
          color: colors.total
        }
      });
      assistData.push(0);
    } else {
      // Middle bars show the change
      waterfallData.push({
        value: value,
        itemStyle: {
          color: value >= 0 ? colors.increase : colors.decrease
        }
      });
      assistData.push(cumulative);
      cumulative += value;
    }
  });

  const option: EChartsOption = {
    tooltip: {
      trigger: 'axis',
      axisPointer: {
        type: 'shadow'
      },
      backgroundColor: COLORS.darkNavy,
      borderColor: COLORS.darkNavy,
      textStyle: {
        color: COLORS.white,
        fontSize: parseInt(TYPOGRAPHY.fontSize.small)
      },
      padding: 12,
      borderRadius: parseInt(BORDER_RADIUS.medium),
      formatter: (params: any) => {
        const dataIndex = params[0].dataIndex;
        const category = categories[dataIndex];
        const value = values[dataIndex];
        const isFirst = dataIndex === 0;
        const isLast = dataIndex === categories.length - 1;

        if (isLast) {
          return `${category}<br/>Total: ${cumulative.toLocaleString()}`;
        } else if (isFirst) {
          return `${category}<br/>Starting: ${value.toLocaleString()}`;
        } else {
          return `${category}<br/>Change: ${value >= 0 ? '+' : ''}${value.toLocaleString()}`;
        }
      }
    },
    grid: {
      left: '3%',
      right: '4%',
      bottom: '3%',
      top: '10%',
      containLabel: true
    },
    xAxis: {
      type: 'category',
      data: categories,
      axisLabel: {
        color: COLORS.text.secondary,
        fontSize: parseInt(TYPOGRAPHY.fontSize.small),
        rotate: categories.length > 8 ? 45 : 0
      },
      axisLine: {
        lineStyle: {
          color: COLORS.borderGray
        }
      },
      splitLine: {
        show: false
      }
    },
    yAxis: {
      type: 'value',
      axisLabel: {
        color: COLORS.text.secondary,
        fontSize: parseInt(TYPOGRAPHY.fontSize.small),
        formatter: (value: number) => value.toLocaleString()
      },
      splitLine: {
        lineStyle: {
          color: COLORS.borderGray,
          type: 'dashed'
        }
      }
    },
    series: [
      {
        name: 'Assist',
        type: 'bar',
        stack: 'total',
        itemStyle: {
          borderColor: 'transparent',
          color: 'transparent'
        },
        emphasis: {
          itemStyle: {
            borderColor: 'transparent',
            color: 'transparent'
          }
        },
        data: assistData
      },
      {
        name: 'Value',
        type: 'bar',
        stack: 'total',
        label: showDataLabels ? {
          show: true,
          position: 'top',
          formatter: (params: any) => {
            const idx = params.dataIndex;
            const value = values[idx];
            const isLast = idx === categories.length - 1;

            if (isLast) {
              return cumulative.toLocaleString();
            }
            return value >= 0 ? `+${value.toLocaleString()}` : value.toLocaleString();
          },
          color: COLORS.text.primary,
          fontSize: parseInt(TYPOGRAPHY.fontSize.small),
          fontWeight: TYPOGRAPHY.fontWeight.medium
        } : undefined,
        data: waterfallData,
        barMaxWidth: 60
      }
    ]
  };

  // Chart content component - renders the actual chart UI
  const renderChartContent = (inPortal: boolean = false) => (
    <div
      ref={inPortal ? portalContainerRef : chartContainerRef}
      className={`card bg-base-100 shadow-sm border border-base-300 hover:shadow-md transition-shadow duration-200 overflow-hidden [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden relative ${
        inPortal ? 'w-full h-full' : ''
      }`}
      style={inPortal ? {
        display: 'flex',
        flexDirection: 'column',
        maxWidth: '100vw',
        maxHeight: '100vh'
      } : {
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
          componentName="DynamicWaterfallChart"
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
      {(isHovered || isFullscreen || inPortal) && (
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
          <h3                                                                                      className="card-title text-lg font-bold text-base-content whitespace-nowrap overflow-x-auto  [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
               title={displayTitle}
           >
            {displayTitle}
          </h3>
          {displayDescription && (
            <p className="text-sm opacity-60 mt-1 min-h-12">
              {displayDescription.length > 100 ? (
                <>
                  {isDescriptionExpanded ? (
                    <>
                      {displayDescription}{' '}
                      <span
                        onClick={() => setIsDescriptionExpanded(false)}
                        className="text-xs text-primary hover:underline cursor-pointer"
                      >
                        Show less
                      </span>
                    </>
                  ) : (
                    <>
                      {displayDescription.slice(0, 100)}
                      <span
                        onClick={() => setIsDescriptionExpanded(true)}
                        className="text-primary hover:underline cursor-pointer"
                      >
                        ...
                      </span>
                    </>
                  )}
                </>
              ) : (
                displayDescription
              )}
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
        <div style={{ height: inPortal ? 'calc(100vh - 250px)' : undefined, width: '100%', flex: inPortal ? undefined : '1 1 0', minHeight: 0 }}>
          <ReactECharts
            option={option}
            style={{ height: '100%', width: '100%' }}
            opts={{ renderer: 'svg' }}
          />
        </div>

        {/* Legend */}
        <div className="mt-4 flex items-center justify-center gap-6">
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded" style={{ backgroundColor: colors.increase }}></div>
            <span className="text-xs text-base-content/60">Increase</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded" style={{ backgroundColor: colors.decrease }}></div>
            <span className="text-xs text-base-content/60">Decrease</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded" style={{ backgroundColor: colors.total }}></div>
            <span className="text-xs text-base-content/60">Total</span>
          </div>
        </div>

      </div>
    </div>
  );

  return (
    <>
      {/* Normal rendering in place */}
      {renderChartContent(false)}

      {/* Portal rendering for fullscreen - renders at document.body level */}
      {showPortal && createPortal(
        <div
          className="fixed inset-0 bg-base-100 z-[9999]"
          style={{ isolation: 'isolate' }}
        >
          {renderChartContent(true)}
        </div>,
        document.body
      )}
    </>
  );
};

// Attach metadata to component
(DynamicWaterfallChart as DynamicWaterfallChartComponent).Metadata = METADATA;

export default DynamicWaterfallChart;

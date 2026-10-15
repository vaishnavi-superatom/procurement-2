import React, { useEffect, useState, useRef } from 'react';
import { createPortal } from 'react-dom';
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

interface DynamicBarChartProps {
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
    metricKeys?: string[]; // Multiple numeric columns — creates one grouped bar series per key
    metricLabels?: string[]; // Display labels parallel to metricKeys
    xAxisLabel?: string; // Label/title for x-axis
    yAxisLabel?: string; // Label/title for y-axis
    seriesKey?: string; // Categorical column to group bars by (like LineChart)
    height?: number;
    orientation?: 'vertical' | 'horizontal';
    // Opt-in: abbreviate the numeric axis's tick labels (10K, 68.7M, 1B) instead
    // of full comma-separated numbers. Off by default so existing charts are
    // unaffected — set explicitly per chart where large numbers benefit from it.
    compactAxisLabels?: boolean;
    colorPalette?: string[];
    data?: any[];
    // Aggregation config for external tool data
    groupBy?: string; // Field to group by (defaults to xAxisKey if not set)
    aggregation?: 'count' | 'sum' | 'avg'; // How to aggregate (default: count)
    aggregationField?: string; // Field to aggregate (required for sum/avg)
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

// Helper function to safely format value for display (handles nested objects)
const formatDisplayValue = (value: any): string => {
  if (value === null || value === undefined) return 'N/A';
  if (typeof value === 'object' && !Array.isArray(value)) {
    // Extract display value from nested objects (e.g., Owner: {name, id, email})
    if (value.name) return String(value.name);
    if (value.title) return String(value.title);
    if (value.label) return String(value.label);
    if (value.value) return String(value.value);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return value.map(v => formatDisplayValue(v)).join(', ');
  }
  return String(value);
};

// Helper function to format numbers for chart display
// >= 1000 with decimals: round to 0 decimal places
// < 1000 with decimals: round to 2 decimal places
const formatChartNumber = (value: number): string => {
  if (value === null || value === undefined || isNaN(value)) return 'N/A';

  const hasDecimals = value % 1 !== 0;

  if (!hasDecimals) {
    // No decimals - show as integer with thousand separators
    return value.toLocaleString('en-US', {
      minimumFractionDigits: 0,
      maximumFractionDigits: 0
    });
  } else if (Math.abs(value) >= 1000) {
    // >= 1000 with decimals - round to 0 decimal places
    return value.toLocaleString('en-US', {
      minimumFractionDigits: 0,
      maximumFractionDigits: 0
    });
  } else {
    // < 1000 with decimals - round to 2 decimal places
    return value.toLocaleString('en-US', {
      minimumFractionDigits: 0,
      maximumFractionDigits: 2
    });
  }
};

// Compact Indian number format for axis labels: 1Cr, 50L, 10K
const formatAxisNumber = (value: number): string => {
  if (value === null || value === undefined || isNaN(value)) return 'N/A';
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 1_00_00_000) return sign + (abs / 1_00_00_000).toFixed(abs % 1_00_00_000 === 0 ? 0 : 1).replace(/\.0$/, '') + ' Cr';
  if (abs >= 1_00_000) return sign + (abs / 1_00_000).toFixed(abs % 1_00_000 === 0 ? 0 : 1).replace(/\.0$/, '') + ' L';
  if (abs >= 1_000) return sign + (abs / 1_000).toFixed(abs % 1_000 === 0 ? 0 : 1).replace(/\.0$/, '') + ' K';
  return formatChartNumber(value);
};

// Compact Western number format for numeric axis tick labels: 10K, 100K, 68.7M, 1B.
// Only used for axis ticks — tooltips and data labels keep full precision via
// formatChartNumber, so no actual data/values are affected, just how the axis reads.
const formatCompactAxisNumber = (value: number): string => {
  if (value === null || value === undefined || isNaN(value)) return 'N/A';
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 1_000_000_000) return sign + (abs / 1_000_000_000).toFixed(abs % 1_000_000_000 === 0 ? 0 : 1).replace(/\.0$/, '') + 'B';
  if (abs >= 1_000_000) return sign + (abs / 1_000_000).toFixed(abs % 1_000_000 === 0 ? 0 : 1).replace(/\.0$/, '') + 'M';
  if (abs >= 1_000) return sign + (abs / 1_000).toFixed(abs % 1_000 === 0 ? 0 : 1).replace(/\.0$/, '') + 'K';
  return formatChartNumber(value);
};

const METADATA: ComponentMetadata = {
  id: 'dynamic-bar-chart',
  name: 'DynamicBarChart',
  displayName: 'Display data distribution as bar chart',
  isDisplayComp: false,
  type: 'BarChart',
  description: 'Displays data as vertical or horizontal bar chart. Always use externalTool with SQL GROUP BY for distributions/aggregations in parameters.sql.',
  category: '',
  keywords: ['bar', 'chart', 'dynamic', 'analytics', 'comparison', 'distribution'],
  props: {
    query: null,
    externalTool: '(object) REQUIRED. Object with toolId, toolName, parameters. Put SQL with GROUP BY in parameters.sql.',
    title: 'Chart title',
    description: 'Chart description',
    timeFrame: 'Time period for the data',
    config: {
      xAxisKey: 'MUST exactly match a column name returned by the SQL query. Field name for x-axis category.',
      yAxisKey: 'MUST exactly match a column name returned by the SQL query. Field name for y-axis numeric values. Use this for single-metric charts.',
      metricKeys: '(optional) Array of column names for multiple numeric metrics — creates one grouped bar series per key. Use instead of yAxisKey when comparing multiple metrics (e.g. ["Revenue", "HireCosts"]). SQL can stay in wide format with one row per category.',
      metricLabels: '(optional) Display labels for each entry in metricKeys (parallel array). e.g. ["Total Revenue", "Hire Costs"]',
      xAxisLabel: 'Display label for x-axis',
      yAxisLabel: 'Display label for y-axis',
      seriesKey: '(optional) Categorical/string column name to group bars by. Creates one bar series per unique value. e.g. seriesKey:"BranchName" with xAxisKey:"ItemCode" and yAxisKey:"Revenue" shows Revenue bars grouped by Branch for each Item. NEVER use seriesKey for paired/from-to data (e.g. origin-destination, from-to cities) — instead CONCAT them into a single label in SQL (e.g. FromCity + " - " + ToCity AS Lane) and use as xAxisKey with no seriesKey. Only use seriesKey for independent categorical groupings like time periods, vehicle types, or status.',
      height: 400,
      orientation: 'vertical or horizontal',
      colorPalette: CHART_COLOR_PALETTE,
    }
  }
}

interface DynamicBarChartComponent extends React.FC<DynamicBarChartProps> {
  Metadata: ComponentMetadata;
}


const DEFAULT_PROPS = {
  query: `SELECT
  c.name as category,
  COUNT(DISTINCT o.order_id) as total_orders
FROM orders o
JOIN order_items oi ON o.order_id = oi.order_id
JOIN product_variants pv ON oi.variant_id = pv.variant_id
JOIN products p ON pv.product_id = p.product_id
JOIN categories c ON p.category_id = c.category_id
WHERE o.status NOT IN ('Cancelled', 'Failed')
GROUP BY c.category_id, c.name
ORDER BY total_orders DESC
LIMIT 10`,
  title: 'Orders by Category',
  description: 'Top 10 product categories by order count',
  config: {
    xAxisKey: 'category',
    yAxisKey: 'total_orders',
    height: 400,
    orientation: 'vertical',
    colorPalette: CHART_COLOR_PALETTE,
  }
}

const DynamicBarChart: React.FC<DynamicBarChartProps> = ({
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

  // Filter params state - stores params from filter events
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
  const [isMobile, setIsMobile] = useState<boolean>(false);
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
  const portalContainerRef = useRef<HTMLDivElement>(null);
  const chartAreaRef = useRef<HTMLDivElement>(null);
  const echartsRef = useRef<any>(null);
  const initialEndRef = useRef<number>(100);
  const [chartDims, setChartDims] = useState<{ w: number; h: number } | null>(null);

  // ResizeObserver to get exact pixel dimensions for ECharts
  // Depends on loading/error so it re-runs when the chart area div appears in DOM
  useEffect(() => {
    const el = chartAreaRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const { width, height: h } = entries[0]?.contentRect ?? { width: 0, height: 0 };
      if (width > 0 && h > 0) {
        setChartDims((prev) => {
          const w = Math.round(width);
          const hh = Math.round(h);
          if (prev && prev.w === w && prev.h === hh) return prev;
          return { w, h: hh };
        });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [loading, error]);

  // Detect mobile screen
  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth < 768);
    };
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  const defaultConfig = DEFAULT_PROPS.config as any;
  const rawXAxisKey = config.xAxisKey || 'x';
  const rawYAxisKey = config.yAxisKey || 'y';

  // Auto-detect swapped keys: if yAxisKey resolves to a non-numeric value
  // and xAxisKey resolves to a numeric value, the LLM likely swapped them
  // (common for horizontal charts where visually categories are on Y-axis)
  const shouldSwapKeys = (() => {
    if (!data || data.length === 0) return false;
    if (config.metricKeys && config.metricKeys.length > 0) return false;
    const firstRow = data[0];
    const xVal = getCaseInsensitiveValue(firstRow, rawXAxisKey);
    const yVal = getCaseInsensitiveValue(firstRow, rawYAxisKey);
    const xIsNumeric = xVal != null && !isNaN(Number(xVal));
    const yIsNumeric = yVal != null && !isNaN(Number(yVal));
    return xIsNumeric && !yIsNumeric;
  })();

  const xAxisKey = shouldSwapKeys ? rawYAxisKey : rawXAxisKey;
  const yAxisKey = shouldSwapKeys ? rawXAxisKey : rawYAxisKey;
  const xAxisLabel = shouldSwapKeys ? config.yAxisLabel : config.xAxisLabel;
  const yAxisLabel = shouldSwapKeys ? config.xAxisLabel : config.yAxisLabel;
  const seriesKey = config.seriesKey || null; // Categorical column to group by
  const metricKeys = config.metricKeys && config.metricKeys.length > 0 ? config.metricKeys : null;
  const isMultiMetric = !seriesKey && !!metricKeys; // Wide-format: multiple numeric columns as separate series
  const height = config.height || defaultConfig.height || 400;
  const orientation = config.orientation || defaultConfig.orientation || 'vertical';
  const compactAxisLabels = config.compactAxisLabels ?? defaultConfig.compactAxisLabels ?? false;
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

  // Dispatch initial zoom when data changes (reset to 15-point default)
  useEffect(() => {
    if (echartsRef.current) {
      echartsRef.current.dispatchAction({
        type: 'dataZoom',
        start: 0,
        end: initialEndRef.current,
      });
    }
  }, [data]);

  // Track fullscreen state changes
  useEffect(() => {
    const onFullscreenChange = () => {
      const isCurrentlyFullscreen = Boolean(document.fullscreenElement);
      setIsFullscreen(isCurrentlyFullscreen);

      // When exiting fullscreen, close the portal
      if (!isCurrentlyFullscreen && showPortal) {
        setShowPortal(false);
      }
    };

    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
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
        // New format: { sql, params }
        finalQuery = JSON.stringify({ sql: query.sql, values: query.params || {} });
      } else {
        // Legacy string format
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

      console.log('[DynamicBarChart] Executing parameterized query:', finalQuery);

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

      console.log(`[DynamicBarChart] Fetching data from external tool: ${externalTool.toolName} (${externalTool.toolId})`);

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

      console.log('[DynamicBarChart] External tool data fetched successfully', result);

      // Extract data from the result
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

      console.log('[DynamicBarChart] External tool result:', chartData.length);

      if (requestId !== fetchIdRef.current) return; // superseded by a newer fetch — discard
      if (chartData.length > 0) {
        setData(chartData);
      } else {
        setData([]);
      }
    } catch (err) {
      if (requestId !== fetchIdRef.current) return;
      console.error('[DynamicBarChart] Error fetching external tool data:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch data from external tool');
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

      console.log(`[DynamicBarChart] Fetching external tool with filter params:`, mergedParameters);

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
      console.error('[DynamicBarChart] Error fetching external tool data with params:', err);
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
      <div className="card bg-base-100 shadow-sm hover:shadow-md transition-all duration-300 border border-error overflow-hidden"
        onClick={handleDebugClick}
      >
        {isDebugModalOpen && (
          <DebugPropsModal
            componentName="DynamicBarChart"
            componentId={SA_RUNTIME?.componentId || 'unknown'}
            props={{ title, description, timeFrame, externalTool: liveExternalTool, config, filterParams, error }}
            SA_RUNTIME={SA_RUNTIME}
            isOpen={isDebugModalOpen}
            onClose={closeDebugModal}
          />
        )}
        {/* Error accent bar at top */}
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

  // Prepare chart data and series
  const isMultiSeries = !!seriesKey; // Categorical grouping (like LineChart)
  const showLegend = isMultiSeries || isMultiMetric;

  // Aggregation config
  const groupByField = config.groupBy || xAxisKey;
  const aggregationType = config.aggregation || 'count';
  // Without an explicit aggregationField, sum/avg used to fall through to a row
  // COUNT — a chart of identical bars that reads as real data. Use yAxisKey.
  const aggregationField = config.aggregationField
    || (aggregationType !== 'count' ? yAxisKey : undefined);

  // Only aggregate when the config asks for it. A yAxisKey missing from the data
  // is a broken config, not a request to count rows — surface it below instead
  // of silently rendering counts.
  const hasExplicitAggregation = config.groupBy || config.aggregation;
  const needsAggregation = data.length > 0 && !isMultiSeries && !isMultiMetric && !!hasExplicitAggregation;
  const missingYAxis = data.length > 0 && !isMultiSeries && !isMultiMetric
    && !hasExplicitAggregation
    && getCaseInsensitiveValue(data[0], yAxisKey) === undefined;

  if (missingYAxis) {
    return (
      <div className="card bg-base-100 shadow-sm border border-error overflow-hidden">
        <div className="absolute top-0 left-0 right-0 h-1 bg-error"></div>
        <div className="card-body p-5">
          <div className="alert alert-error">
            <Icon icon="mdi:alert-circle" className="w-5 h-5 flex-shrink-0" />
            <div>
              <p className="font-medium">Chart configuration error</p>
              <p className="text-sm opacity-80">
                yAxisKey "{String(yAxisKey)}" is not a field in the returned data.
                Available: {Object.keys(data[0] || {}).join(', ') || '(none)'}
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Aggregate data if needed
  let processedData = data;
  if (needsAggregation) {
    console.log(`[DynamicBarChart] Aggregating data - groupBy: ${groupByField}, aggregation: ${aggregationType}`);

    // Group data by the groupBy field
    const aggregationMap = new Map<string, { count: number; sum: number; values: number[] }>();

    data.forEach(item => {
      const key = formatDisplayValue(getCaseInsensitiveValue(item, groupByField));
      const existing = aggregationMap.get(key) || { count: 0, sum: 0, values: [] };

      existing.count += 1;

      if (aggregationField) {
        const val = getCaseInsensitiveValue(item, aggregationField);
        const numVal = typeof val === 'number' ? val : parseFloat(val) || 0;
        existing.sum += numVal;
        existing.values.push(numVal);
      }

      aggregationMap.set(key, existing);
    });

    // Convert map to array of objects based on aggregation type
    processedData = Array.from(aggregationMap.entries()).map(([key, agg]) => {
      let value: number;

      // No silent count fallback: aggregationField now defaults to yAxisKey, so
      // a sum/avg that finds no numeric values is 0 — not a row count wearing
      // the label of a measure.
      switch (aggregationType) {
        case 'sum':
          value = agg.sum;
          break;
        case 'avg':
          value = agg.values.length > 0 ? agg.sum / agg.values.length : 0;
          break;
        case 'count':
        default:
          value = agg.count;
      }

      return {
        [xAxisKey]: key,
        [yAxisKey]: value,
        _aggregated: true
      };
    });

    // Sort by value descending for better visualization
    processedData.sort((a, b) => (b[yAxisKey] as number) - (a[yAxisKey] as number));

    console.log('[DynamicBarChart] Aggregated data:', processedData.length, 'groups');
  }

  // Helper function to get border radius based on value and orientation
  const getBorderRadius = (value: number) => {
    if (orientation === 'vertical') {
      return value >= 0 ? [4, 4, 0, 0] : [0, 0, 4, 4];
    } else {
      return value >= 0 ? [0, 4, 4, 0] : [4, 0, 0, 4];
    }
  };

  // Build categories and series based on mode
  let categories: string[];
  let seriesArray: any[];
  let seriesKeyNames: string[] = []; // For legend when using seriesKey

  if (isMultiSeries) {
    // seriesKey mode: group data by a categorical column (like LineChart/ScatterChart)
    // Data shape: [{ItemCode, BranchName, Revenue}, ...] -> one bar series per unique BranchName
    const seriesMap = new Map<string, Map<string, number>>();
    const categorySet = new Set<string>();

    data.forEach(item => {
      const seriesName = formatDisplayValue(getCaseInsensitiveValue(item, seriesKey!));
      const category = formatDisplayValue(getCaseInsensitiveValue(item, xAxisKey));
      const value = parseFloat(getCaseInsensitiveValue(item, yAxisKey) || 0);

      categorySet.add(category);

      if (!seriesMap.has(seriesName)) {
        seriesMap.set(seriesName, new Map());
      }
      seriesMap.get(seriesName)!.set(category, value);
    });

    categories = Array.from(categorySet);
    seriesKeyNames = Array.from(seriesMap.keys());

    let colorIdx = 0;
    seriesArray = [];
    seriesMap.forEach((dataMap, seriesName) => {
      const seriesColor = colorPalette[colorIdx % colorPalette.length];
      seriesArray.push({
        name: seriesName,
        type: 'bar' as const,
        color: seriesColor,
        data: categories.map(cat => {
          const value = dataMap.get(cat) || 0;
          return {
            value: value,
            formattedValue: formatChartNumber(value),
            itemStyle: {
              color: seriesColor,
              borderRadius: getBorderRadius(value)
            }
          };
        }),
        barMaxWidth: 60,
        label: { show: false }
      });
      colorIdx++;
    });
  } else if (isMultiMetric) {
    // Multi-metric mode: one bar series per metricKeys entry (wide-format data)
    categories = processedData.map(item => formatDisplayValue(getCaseInsensitiveValue(item, xAxisKey)));
    seriesKeyNames = metricKeys!.map((key: string, idx: number) => config.metricLabels?.[idx] || key);

    seriesArray = metricKeys!.map((key: string, idx: number) => {
      const seriesColor = colorPalette[idx % colorPalette.length];
      const seriesName = config.metricLabels?.[idx] || key;
      return {
        name: seriesName,
        type: 'bar' as const,
        color: seriesColor,
        data: processedData.map(item => {
          const value = parseFloat(getCaseInsensitiveValue(item, key) || 0);
          return {
            value,
            formattedValue: formatChartNumber(value),
            itemStyle: { color: seriesColor, borderRadius: getBorderRadius(value) }
          };
        }),
        barMaxWidth: 60,
        label: { show: false }
      };
    });
  } else {
    // Single series mode
    categories = processedData.map(item => formatDisplayValue(getCaseInsensitiveValue(item, xAxisKey)));

    seriesArray = [
      {
        type: 'bar' as const,
        data: processedData.map(item => {
          const value = parseFloat(getCaseInsensitiveValue(item, yAxisKey) || 0);
          return {
            value: value,
            formattedValue: formatChartNumber(value),
            itemStyle: {
              color: colorPalette[0],
              borderRadius: getBorderRadius(value)
            }
          };
        }),
        barMaxWidth: 60,
        label: { show: false }
      }
    ];
  }

  // Pre-compute xAxis label dimensions for grid bottom and nameGap
  const _hasLongLabels = orientation === 'vertical' ? categories.some((label: string) => label.length > 25) : false;
  const _shouldTiltLabels = orientation === 'vertical' && (isMobile || categories.length > 6 || (_hasLongLabels && categories.length > 3 && categories.length < 7));
  const _maxDisplayLen = orientation === 'vertical' ? Math.min(Math.max(...categories.map((l: string) => l.length), 1), 25) : 1;
  const _charWidth = 7;
  const _rotateRad = (45 * Math.PI) / 180;
  const _labelHeight = _shouldTiltLabels ? Math.round(_maxDisplayLen * _charWidth * Math.sin(_rotateRad)) : 16;
  const _needsScroll = categories.length > 15;
  const _scrollBarSize = 18;
  const _scrollExtra = _needsScroll && orientation === 'vertical' ? 10 : 0;
  const _gridBottom = orientation === 'vertical'
    ? (xAxisLabel
      ? _labelHeight + 40 + _scrollExtra
      : _labelHeight + 15 + _scrollExtra)
    : (xAxisLabel ? _labelHeight + 40 : _labelHeight + 15);
  const _nameGap = _labelHeight + 15;
  const _gridRight = orientation === 'horizontal' && _needsScroll ? _scrollBarSize + 15 : undefined;

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
        if (!Array.isArray(params)) params = [params];
        const categoryName = params[0]?.name || '';
        let result = `<div style="font-weight: bold; margin-bottom: 4px;">${categoryName}</div>`;
        params.forEach((item: any) => {
          // Use pre-formatted value from data, fallback to raw value
          const displayValue = item.data?.formattedValue ?? item.value;
          const sName = showLegend && item.seriesName ? `${item.seriesName}: ` : '';
          result += `<div>${item.marker} ${sName}${displayValue}</div>`;
        });
        return result;
      }
    },
    legend: showLegend ? {
      type: 'scroll',
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
        color: COLORS.text.primary,
        fontSize: parseInt(TYPOGRAPHY.fontSize.small)
      },
      data: seriesKeyNames,
      height: 50
    } : undefined,
    grid: {
      left: '8%',
      right: _gridRight ?? '4%',
      bottom: _gridBottom,
      top: showLegend ? (yAxisLabel ? '90px' : '80px') : (yAxisLabel ? '12%' : '8%'),
      containLabel: false
    },
    xAxis: orientation === 'vertical' ? (() => {
      const hasLongLabels = _hasLongLabels;
      const shouldTiltLabels = _shouldTiltLabels;

      return {
        type: 'category',
        data: categories,
        name: xAxisLabel,
        nameLocation: 'middle',
        nameGap: _nameGap,
        nameTextStyle: {
          color: COLORS.text.primary,
          fontSize: parseInt(TYPOGRAPHY.fontSize.small),
          fontWeight: 'bold'
        },
        axisLabel: {
          color: COLORS.text.secondary,
          fontSize: parseInt(TYPOGRAPHY.fontSize.small),
          rotate: shouldTiltLabels ? 45 : 0,
          interval: 0,
          formatter: (value: string) => value.length > 25 ? value.substring(0, 25) + '...' : value
        },
        axisLine: {
          lineStyle: {
            color: COLORS.borderGray
          }
        }
      };
    })() : {
      type: 'value',
      axisLabel: {
        color: COLORS.text.secondary,
        fontSize: parseInt(TYPOGRAPHY.fontSize.small),
        formatter: (value: number) => compactAxisLabels ? formatCompactAxisNumber(value) : formatChartNumber(value)
      },
      splitLine: {
        lineStyle: {
          color: COLORS.borderGray,
          type: 'dashed'
        }
      }
    },
    yAxis: orientation === 'vertical' ? {
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
        formatter: (value: number) => compactAxisLabels ? formatCompactAxisNumber(value) : formatChartNumber(value)
      },
      splitLine: {
        lineStyle: {
          color: COLORS.borderGray,
          type: 'dashed'
        }
      }
    } : {
      type: 'category',
      data: categories,
      axisLabel: {
        color: COLORS.text.secondary,
        fontSize: parseInt(TYPOGRAPHY.fontSize.small),
        interval: 0,
        formatter: (value: string) => value.length > 25 ? value.substring(0, 25) + '...' : value
      },
      axisLine: {
        lineStyle: {
          color: COLORS.borderGray
        }
      }
    },
    series: seriesArray,
    dataZoom: _needsScroll ? (() => {
      // Store initial end for dispatchAction — do NOT put start/end in the option.
      // ECharts preserves zoom as internal state across setOption calls (merge mode).
      // Putting start/end here would reset zoom on every re-render (e.g. hover).
      initialEndRef.current = Math.round((15 / categories.length) * 100);
      return [
        {
          type: 'inside',
          [orientation === 'vertical' ? 'xAxisIndex' : 'yAxisIndex']: 0,
        },
        orientation === 'vertical' ? {
          type: 'slider',
          xAxisIndex: 0,
          height: _scrollBarSize,
          bottom: 5,
          borderColor: COLORS.borderGray,
          fillerColor: `${COLORS.primary}30`,
          handleStyle: { color: COLORS.primary },
          textStyle: { color: COLORS.text.secondary, fontSize: 10 },
          showDetail: false,
        } : {
          type: 'slider',
          yAxisIndex: 0,
          width: _scrollBarSize,
          right: 5,
          borderColor: COLORS.borderGray,
          fillerColor: `${COLORS.primary}30`,
          handleStyle: { color: COLORS.primary },
          textStyle: { color: COLORS.text.secondary, fontSize: 10 },
          showDetail: false,
        }
      ];
    })() : undefined,
  };

  const onChartReady = (instance: any) => {
    echartsRef.current = instance;
    if (_needsScroll) {
      instance.dispatchAction({ type: 'dataZoom', start: 0, end: initialEndRef.current });
    }
  };

  // Chart content component - renders the actual chart UI
  const renderChartContent = (inPortal: boolean = false) => (
    <div
      ref={(el) => {
        if (inPortal) {
          (portalContainerRef as any).current = el;
        } else {
          (chartContainerRef as any).current = el;
        }
      }}
      className={`card bg-base-100 shadow-sm hover:shadow-md transition-all duration-300 border border-base-300 relative overflow-hidden ${inPortal ? 'w-full h-full' : ''
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
      {/* Gradient accent bar at top */}
      <div
        className="absolute top-0 left-0 right-0 h-1"
        style={{
          background: 'linear-gradient(90deg, #1E9CD8, #1E9CD880)'
        }}
      ></div>
      {isDebugModalOpen && (
        <DebugPropsModal
          componentName="DynamicBarChart"
          componentId={SA_RUNTIME?.componentId || 'unknown'}
          props={{ title, description, timeFrame, externalTool: liveExternalTool, config, filterParams }}
          SA_RUNTIME={SA_RUNTIME}
          isOpen={isDebugModalOpen}
          onClose={closeDebugModal}
        />
      )}

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
        <div ref={inPortal ? undefined : chartAreaRef} style={{ height: inPortal ? 'calc(100vh - 200px)' : undefined, width: '100%', flex: inPortal ? undefined : '1 1 0', minHeight: 0 }}>
          {inPortal ? (
            <ReactECharts
              option={option}
              style={{ height: '100%', width: '100%' }}
              opts={{ renderer: 'svg' }}
              onChartReady={onChartReady}
            />
          ) : chartDims && (
            <ReactECharts
              option={option}
              style={{ width: chartDims.w, height: chartDims.h }}
              opts={{ renderer: 'svg' }}
              onChartReady={onChartReady}
            />
          )}
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
          className={`fixed inset-0 bg-base-100 z-[9999] ${isFullscreen ? 'opacity-100' : 'opacity-0'}`}
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
(DynamicBarChart as DynamicBarChartComponent).Metadata = METADATA;

export default DynamicBarChart;

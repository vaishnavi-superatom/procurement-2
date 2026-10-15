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

interface DynamicLineChartProps {
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
    metricKeys?: string[]; // Multiple numeric columns — creates one line series per key
    metricLabels?: string[]; // Display labels parallel to metricKeys
    xAxisLabel?: string; // Label/title for x-axis
    yAxisLabel?: string; // Label/title for y-axis
    seriesKey?: string;
    height?: number;
    smooth?: boolean;
    showArea?: boolean;
    showDataPoints?: boolean;
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

const parseDate = (value: any): Date | null => {
  if (value === null || value === undefined) return null;

  if (value instanceof Date) {
    return isNaN(value.getTime()) ? null : value;
  }

  const str = String(value).trim();
  if (!str) return null;

  // Check if it is a pure integer (Unix timestamp in seconds or milliseconds)
  if (/^\d+$/.test(str)) {
    const num = Number(str);
    // Is it in seconds? (Year 2000 to Year 2100 range: 946684800 to 4102444800)
    if (num >= 946684800 && num <= 4102444800) {
      return new Date(num * 1000);
    }
    // Is it in milliseconds? (Year 2000 to Year 2100 range: 946684800000 to 4102444800000)
    if (num >= 946684800000 && num <= 4102444800000) {
      return new Date(num);
    }
    // Is it in microseconds or nanoseconds?
    if (num >= 946684800000000 && num <= 4102444800000000) {
      return new Date(Math.floor(num / 1000));
    }
  }

  // Fallback to standard Date parsing
  const normalized = str.replace(/\//g, '-');
  const d = new Date(normalized);
  return !isNaN(d.getTime()) ? d : null;
};

const isDateLike = (value: any): boolean => {
  return parseDate(value) !== null;
};

// A date-like axis whose every point falls on the 1st of its month (e.g. a
// "yyyy-MM"/"April 2023" monthly aggregate, however it happened to be
// formatted upstream) has no real day-level precision — formatting it with
// a day component ("01 Apr 23") fabricates precision the data doesn't have
// and reads as a parsing artifact. Detect that case from the data itself so
// month-bucketed series always render as just the month, no per-widget flag
// required.
const isMonthGranularity = (xData: any[]): boolean => {
  const points = xData.filter((v) => v != null);
  if (points.length === 0) return false;
  return points.every((v) => {
    const d = parseDate(v);
    return d !== null && d.getDate() === 1;
  });
};

const formatFullDateTime = (value: any, monthOnly: boolean = false): string => {
  const d = parseDate(value);
  if (!d) return String(value);
  if (monthOnly) {
    return d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  }
  const datePart = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  const timePart = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return `${datePart} ${timePart}`;
};

const formatDateValue = (value: any, spanDays: number = Infinity, monthOnly: boolean = false): string => {
  const d = parseDate(value);
  if (!d) return String(value);
  if (monthOnly) {
    return d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
  }
  // Defensive floor — a span is a magnitude and must never be negative here.
  // Without this, a negative spanDays (e.g. from an upstream miscalculation)
  // would satisfy every "< N" check below and always hit the sub-hour,
  // time-only branch, printing 00:00:00 for a plain calendar date.
  const absSpanDays = Math.max(0, spanDays);
  if (absSpanDays < 0.04) { // less than ~1 hour, include seconds
    return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }
  if (absSpanDays < 2) {
    return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  }
  if (absSpanDays < 7) {
    return `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
  }
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' });
};

const getSmartInterval = (xData: any[]): number => {
  const n = xData.length;
  if (n <= 1) return 0;
  if (n <= 12) return 0; // few enough to show all
  const first = parseDate(xData[0]);
  const last = parseDate(xData[n - 1]);
  if (!first || !last) return Math.max(0, Math.round(n / 8) - 1);
  const spanDays = (last.getTime() - first.getTime()) / (1000 * 60 * 60 * 24);
  if (spanDays === 0) return Math.max(0, Math.round(n / 8) - 1);
  const avgDaysPerPoint = spanDays / (n - 1);
  let targetGapDays: number;
  if (spanDays <= 60) targetGapDays = 7;
  else if (spanDays <= 365) targetGapDays = 30;
  else if (spanDays <= 730) targetGapDays = 90;
  else targetGapDays = 365;
  const rawInterval = Math.round(targetGapDays / avgDaysPerPoint) - 1;
  const maxInterval = Math.floor(n / 5); // always show at least 5 labels
  return Math.max(0, Math.min(rawInterval, maxInterval));
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
  id: 'dynamic-line-chart',
  name: 'DynamicLineChart',
  displayName: 'Display data trends as line chart',
  isDisplayComp: false,
  type: 'LineChart',
  description: 'Displays data trends over time as line chart. Always use externalTool with SQL GROUP BY for time-series aggregations in parameters.sql.',
  category: 'Line Chart',
  keywords: ['line', 'chart', 'dynamic', 'trend', 'time-series', 'analytics'],
  props: {
    query: null,
    externalTool: '(object) REQUIRED. Object with toolId, toolName, parameters. Put SQL with GROUP BY for time-series in parameters.sql.',
    title: 'Chart title',
    description: 'Chart description',
    timeFrame: 'Time period for the data',
    config: {
      xAxisKey: 'MUST exactly match a column name returned by the SQL query. Field name for date/time x-axis.',
      yAxisKey: 'MUST exactly match a column name returned by the SQL query. Field name for y-axis numeric values. Use this for single-metric charts.',
      metricKeys: '(optional) Array of column names for multiple numeric metrics — creates one line series per key. Use instead of yAxisKey when comparing multiple metrics over time (e.g. ["Revenue", "HireCosts"]). SQL can stay in wide format with one row per x-axis point.',
      metricLabels: '(optional) Display labels for each entry in metricKeys (parallel array). e.g. ["Total Revenue", "Hire Costs"]',
      xAxisLabel: '(optional) Display label for x-axis',
      yAxisLabel: '(optional) Display label for y-axis',
      seriesKey: '(optional) MUST exactly match a column name returned by the SQL query. Field name to create multiple line series.',
      height: 400,
      smooth: 'boolean - smooth line curves (default false: straight lines between points)',
      showArea: 'boolean - fill area under line (default: only when there is a single line)',
      showDataPoints: 'boolean - show data point markers',
      colorPalette: CHART_COLOR_PALETTE,
    }
  }
}

const DEFAULT_PROPS ={
    query: `SELECT
  DATE_TRUNC('day', order_date) as order_day,
  SUM(total_amount) as daily_revenue
FROM orders
WHERE order_date >= CURRENT_DATE - INTERVAL '30 days'
  AND status NOT IN ('Cancelled', 'Failed')
GROUP BY DATE_TRUNC('day', order_date)
ORDER BY order_day ASC`,
    title: 'Daily Revenue Trend',
    description: 'Revenue trend over the last 30 days',
    config: {
      xAxisKey: 'order_day',
      yAxisKey: 'daily_revenue',
      height: 400,
      smooth: false,
      showArea: true,
      showDataPoints: true,
      colorPalette: CHART_COLOR_PALETTE,
    }
  }

interface DynamicLineChartComponent extends React.FC<DynamicLineChartProps> {
  Metadata: ComponentMetadata;
}

const DynamicLineChart: React.FC<DynamicLineChartProps> = ({
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

  const [filterParams, setFilterParams] = useState<Record<string, any>>(() => {
    const eventName = SA_RUNTIME?.uiBlockId ? `${SA_RUNTIME.uiBlockId}_FILTER` : 'GLOBAL_FILTER';
    return (window as any).__FILTER_STATE__?.[eventName]?.params || {};
  });

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

  const [zoomRange, setZoomRange] = useState<{ start: number; end: number } | null>(null);
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
  const [chartDims, setChartDims] = useState<{ w: number; h: number } | null>(null);
  // ResizeObserver to get exact pixel dimensions for ECharts
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
  const xAxisKey = config.xAxisKey || 'x';
  const yAxisKey = config.yAxisKey || 'y';
  const xAxisLabel = config.xAxisLabel || defaultConfig.xAxisLabel;
  const yAxisLabel = config.yAxisLabel || defaultConfig.yAxisLabel;
  const seriesKey = config.seriesKey || null;
  const metricKeys = config.metricKeys && config.metricKeys.length > 0 ? config.metricKeys : null;
  const isMultiMetric = !seriesKey && !!metricKeys;
  const showLegend = !!seriesKey || isMultiMetric;
  const height = config.height || defaultConfig.height || 400; // Fallback height, container height takes priority
  // Straight by default: a smoothed curve between monthly points draws values that never existed.
  const smooth = config.smooth !== undefined ? config.smooth : (defaultConfig.smooth !== undefined ? defaultConfig.smooth : false);
  // Filled only for a single line by default: stacked fills under several lines hide each other.
  const showArea = config.showArea !== undefined ? config.showArea
    : showLegend ? false : (defaultConfig.showArea !== undefined ? defaultConfig.showArea : true);
  const showDataPoints = config.showDataPoints !== undefined ? config.showDataPoints : (defaultConfig.showDataPoints !== undefined ? defaultConfig.showDataPoints : true);
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

      if (result?.rows && Array.isArray(result.rows)) {
        chartData = result.rows;
      } else if (result?.records && Array.isArray(result.records)) {
        chartData = result.records;
      } else if (result?.data) {
        if (Array.isArray(result.data)) {
          chartData = result.data;
        } else if (result.data.data && Array.isArray(result.data.data)) {
          chartData = result.data.data;
        } else if (result.data.rows && Array.isArray(result.data.rows)) {
          chartData = result.data.rows;
        } else if (result.data.records && Array.isArray(result.data.records)) {
          chartData = result.data.records;
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

      console.log('[DynamicLineChart] Executing parameterized query:', finalQuery);

      const result = await queryExecutor.executeQuery({ query: finalQuery, SA_RUNTIME });
      if (requestId !== fetchIdRef.current) return; // superseded by a newer fetch — discard

      if (result && result.length > 0) {
        setData(result);
      } else {
        setData([]);
      }
    } catch (err) {
      if (requestId !== fetchIdRef.current) return;
      console.error('[DynamicLineChart] Error fetching data with params:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch data');
    } finally {
      if (requestId === fetchIdRef.current) setLoading(false);
    }
  };

  // Fetch external tool data with filter parameters
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
      const mergedTool = {
        ...externalTool,
        parameters: externalTool.parameters?.params
          ? { ...externalTool.parameters, params: { ...externalTool.parameters.params, ...params } }
          : { ...externalTool.parameters, ...params }
      };

      console.log(`[DynamicLineChart] Fetching external tool data with params:`, mergedTool);

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
          externalTool: mergedTool,
          formData: {},
          SA_RUNTIME
        });
      }

      let chartData: any[] = [];
      if (result?.rows && Array.isArray(result.rows)) {
        chartData = result.rows;
      } else if (result?.records && Array.isArray(result.records)) {
        chartData = result.records;
      } else if (result?.data) {
        if (Array.isArray(result.data)) {
          chartData = result.data;
        } else if (result.data.data && Array.isArray(result.data.data)) {
          chartData = result.data.data;
        } else if (result.data.rows && Array.isArray(result.data.rows)) {
          chartData = result.data.rows;
        } else if (result.data.records && Array.isArray(result.data.records)) {
          chartData = result.data.records;
        }
      } else if (Array.isArray(result)) {
        chartData = result;
      }

      if (requestId !== fetchIdRef.current) return; // superseded by a newer fetch — discard
      setData(chartData);
    } catch (err) {
      if (requestId !== fetchIdRef.current) return;
      console.error('[DynamicLineChart] Error fetching external tool data with params:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch data');
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
            componentName="DynamicLineChart"
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

  if (!loading && !error && data.length === 0) {
    return (
      <div className="card bg-base-100 shadow-sm border border-base-300 p-6 h-full flex flex-col items-center justify-center gap-2">
        <Icon icon="mdi:chart-line" className="w-10 h-10 opacity-20" />
        <p className="text-sm opacity-40 font-medium">{title || 'No data available'}</p>
      </div>
    );
  }

  // Prepare chart data
  let series: any[] = [];
  let xAxisData: any[] = [];

  if (seriesKey) {
    // Multi-line chart (grouped by seriesKey)
    const seriesMap = new Map<string, any[]>();
    const xAxisSet = new Set<string>();

    data.forEach(item => {
      const seriesName = getCaseInsensitiveValue(item, seriesKey);
      const xValue = getCaseInsensitiveValue(item, xAxisKey);
      const raw = getCaseInsensitiveValue(item, yAxisKey);
      const yValue = raw === null || raw === undefined || raw === '' ? null : parseFloat(raw);

      xAxisSet.add(xValue);

      if (!seriesMap.has(seriesName)) {
        seriesMap.set(seriesName, []);
      }
      seriesMap.get(seriesName)!.push({ x: xValue, y: yValue });
    });

    xAxisData = Array.from(xAxisSet);

    let colorIdx = 0;
    seriesMap.forEach((seriesData, seriesName) => {
      const dataMap = new Map(seriesData.map(d => [d.x, d.y]));
      const values = xAxisData.map(x => dataMap.get(x) || null);

      series.push({
        name: seriesName,
        type: 'line',
        data: values,
        smooth: smooth,
        showSymbol: showDataPoints,
        symbol: 'circle',
        symbolSize: 6,
        lineStyle: {
          width: 2,
          color: colorPalette[colorIdx % colorPalette.length]
        },
        itemStyle: {
          color: colorPalette[colorIdx % colorPalette.length]
        },
        areaStyle: showArea ? {
          color: {
            type: 'linear',
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [{
              offset: 0,
              color: `${colorPalette[colorIdx % colorPalette.length]}40`
            }, {
              offset: 1,
              color: `${colorPalette[colorIdx % colorPalette.length]}10`
            }]
          }
        } : undefined
      });
      colorIdx++;
    });
  } else if (isMultiMetric) {
    // Multi-metric mode: one line series per metricKeys entry (wide-format data)
    xAxisData = data.map(item => getCaseInsensitiveValue(item, xAxisKey));

    series = metricKeys!.map((key: string, idx: number) => {
      const seriesColor = colorPalette[idx % colorPalette.length];
      const seriesName = config.metricLabels?.[idx] || key;
      const yValues = data.map(item => {
        const raw = getCaseInsensitiveValue(item, key);
        return raw === null || raw === undefined || raw === '' ? null : parseFloat(raw);
      });

      return {
        name: seriesName,
        type: 'line',
        data: yValues,
        smooth: smooth,
        showSymbol: showDataPoints,
        symbol: 'circle',
        symbolSize: 6,
        lineStyle: { width: 2, color: seriesColor },
        itemStyle: { color: seriesColor },
        areaStyle: showArea ? {
          color: {
            type: 'linear',
            x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [
              { offset: 0, color: `${seriesColor}40` },
              { offset: 1, color: `${seriesColor}10` }
            ]
          }
        } : undefined
      };
    });
  } else {
    // Single line chart
    xAxisData = data.map(item => getCaseInsensitiveValue(item, xAxisKey));
    const yAxisData = data.map(item => {
      const raw = getCaseInsensitiveValue(item, yAxisKey);
      return raw === null || raw === undefined || raw === '' ? null : parseFloat(raw);
    });

    series = [{
      type: 'line',
      data: yAxisData,
      smooth: smooth,
      showSymbol: showDataPoints,
      symbol: 'circle',
      symbolSize: 6,
      lineStyle: {
        width: 2,
        color: colorPalette[0]
      },
      itemStyle: {
        color: colorPalette[0]
      },
      areaStyle: showArea ? {
        color: {
          type: 'linear',
          x: 0,
          y: 0,
          x2: 0,
          y2: 1,
          colorStops: [{
            offset: 0,
            color: `${colorPalette[0]}40`
          }, {
            offset: 1,
            color: `${colorPalette[0]}10`
          }]
        }
      } : undefined
    }];
  }

  const isDateAxis = xAxisData.length > 0 && isDateLike(xAxisData.find((v: any) => v != null));
  const monthOnly = isDateAxis && isMonthGranularity(xAxisData);
  const dateSpanDays = (() => {
    if (!isDateAxis || xAxisData.length < 2) return Infinity;
    // True min/max over every parsed point, not the positionally first/last
    // element — the SQL isn't guaranteed to return rows in date order, and a
    // first/last read on out-of-order data can compute a NEGATIVE span
    // (e.g. "10/4" arriving before "9/4"). formatDateValue's < 0.04 branch
    // has no lower bound, so a negative span was falling into the sub-hour
    // "time only" formatter and printing 00:00:00 for every plain-date label.
    const times = xAxisData
      .map((v: any) => parseDate(v))
      .filter((d): d is Date => d !== null)
      .map((d) => d.getTime());
    if (times.length < 2) return Infinity;
    return (Math.max(...times) - Math.min(...times)) / (1000 * 60 * 60 * 24);
  })();
  const formattedXAxisData = isDateAxis
    ? xAxisData.map((v: any) => (v != null ? formatDateValue(v, dateSpanDays, monthOnly) : v))
    : xAxisData;
  const smartInterval = isDateAxis ? getSmartInterval(xAxisData) : 'auto';

  // Pre-compute label dimensions for grid bottom and nameGap (same approach as DynamicBarChart)
  const _visibleLabelCount = typeof smartInterval === 'number' && smartInterval > 0
    ? Math.ceil(xAxisData.length / (smartInterval + 1))
    : xAxisData.length;
  const _rotate = _visibleLabelCount > 5 ? (isDateAxis ? 30 : 45) : 0;
  const _shouldTilt = _rotate > 0;
  const _maxDisplayLen = _shouldTilt
    ? Math.min(Math.max(...formattedXAxisData.map((v: any) => String(v ?? '').length), 1), 25)
    : 0;
  const _charWidth = 7;
  const _rotateRad = (_rotate * Math.PI) / 180;
  const _labelHeight = _shouldTilt ? Math.round(_maxDisplayLen * _charWidth * Math.sin(_rotateRad)) : 16;
  const _needsScroll = xAxisData.length > 50;
  const _scrollBarSize = 18;
  const _scrollExtra = _needsScroll ? 10 : 0;
  const _gridBottom = xAxisLabel ? _labelHeight + 40 + _scrollExtra : _labelHeight + 15 + _scrollExtra;
  const _nameGap = _labelHeight + 15;

  const option: EChartsOption = {
    tooltip: {
      trigger: 'axis',
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
        const dataIndex = params[0]?.dataIndex;
        const rawValue = isDateAxis && dataIndex != null ? xAxisData[dataIndex] : null;
        const categoryName = rawValue ? formatFullDateTime(rawValue, monthOnly) : (params[0]?.name || '');
        let result = `<div style="font-weight: bold; margin-bottom: 4px;">${categoryName}</div>`;
        params.forEach((item: any) => {
          const value = item.value === null || item.value === undefined ? 'N/A' : typeof item.value === 'number' ? formatChartNumber(item.value) : item.value;
          const sName = showLegend && item.seriesName ? `${item.seriesName}: ` : '';
          const unit = !showLegend && yAxisLabel ? ` ${yAxisLabel}` : '';
          result += `<div>${item.marker} ${sName}${value}${unit}</div>`;
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
        color: COLORS.text.secondary,
        fontSize: parseInt(TYPOGRAPHY.fontSize.small)
      },
      height: 50
    } : undefined,
    grid: {
      left: '8%',
      right: '4%',
      bottom: _gridBottom,
      top: showLegend ? (yAxisLabel ? '90px' : '80px') : (yAxisLabel ? '12%' : '10%'),
      containLabel: false
    },
    xAxis: {
      type: 'category',
      data: formattedXAxisData,
      boundaryGap: false,
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
        rotate: _rotate,
        interval: 'auto',
        hideOverlap: true,
        formatter: isDateAxis
          ? (value: string) => value
          : (value: string) => value.length > 12 ? value.substring(0, 12) + '...' : value
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
      }
    },
    series: series,
    dataZoom: _needsScroll ? [
      {
        type: 'inside',
        xAxisIndex: 0,
        start: zoomRange ? zoomRange.start : 0,
        end: zoomRange ? zoomRange.end : Math.max(5, Math.min(100, Math.round((50 / xAxisData.length) * 100))),
      },
      {
        type: 'slider',
        xAxisIndex: 0,
        start: zoomRange ? zoomRange.start : 0,
        end: zoomRange ? zoomRange.end : Math.max(5, Math.min(100, Math.round((50 / xAxisData.length) * 100))),
        height: _scrollBarSize,
        bottom: 5,
        borderColor: COLORS.borderGray,
        fillerColor: `${COLORS.primary}30`,
        handleStyle: { color: COLORS.primary },
        textStyle: { color: COLORS.text.secondary, fontSize: 10 },
        showDetail: false,
      }
    ] : undefined,
  };

  const onEvents = {
    'datazoom': (params: any) => {
      // Capture zoom/scroll state to prevent reset on re-render
      if (params.batch && params.batch[0]) {
        setZoomRange({ start: params.batch[0].start, end: params.batch[0].end });
      } else if (params.start !== undefined && params.end !== undefined) {
        setZoomRange({ start: params.start, end: params.end });
      }
    }
  };

  // Chart content component - renders the actual chart UI
  const renderChartContent = (inPortal: boolean = false) => (
    <div
      ref={inPortal ? portalContainerRef : chartContainerRef}
      className={`card bg-base-100 shadow-sm border border-base-300 hover:shadow-md transition-shadow duration-200 relative overflow-hidden ${
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
      {/* Gradient accent bar at top */}
      <div
        className="absolute top-0 left-0 right-0 h-1"
        style={{
          background: `linear-gradient(90deg, ${COLORS.primary}, ${COLORS.primary}80)`
        }}
      ></div>
      {isDebugModalOpen && (
        <DebugPropsModal
          componentName="DynamicLineChart"
          componentId={SA_RUNTIME?.componentId || 'unknown'}
          props={{ title, description, timeFrame, externalTool: liveExternalTool, config, filterParams }}
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
              onEvents={onEvents}
              style={{ height: '100%', width: '100%' }}
              opts={{ renderer: 'svg' }}
              notMerge={true}
            />
          ) : chartDims && (
            <ReactECharts
              option={option}
              onEvents={onEvents}
              style={{ width: chartDims.w, height: chartDims.h }}
              opts={{ renderer: 'svg' }}
              notMerge={true}
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
(DynamicLineChart as DynamicLineChartComponent).Metadata = METADATA;

export default DynamicLineChart;

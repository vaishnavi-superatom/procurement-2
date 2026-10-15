import React, { useEffect, useState, useRef } from 'react';
import { Icon } from '@iconify/react';
import type { ComponentMetadata } from '../../types';
import { COLORS, SHADOWS, BORDER_RADIUS, TYPOGRAPHY, SPACING } from '../../design-system/tokens';
import QueryExecutor from '../../data/query';
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

interface DynamicKPICardProps {
  /** Stamped by the SDK when the payload is render-capped (§2.7). */
  _rowsRendered?: number;
  _rowsTotal?: number;
  query?: string | QueryConfig | null;
  title?: string;
  description?: string;
  timeFrame?: string;
  externalTool?: ExternalTool | null;
  config?: {
    valueKey?: string;
    prefix?: string;
    suffix?: string;
    formatNumber?: boolean;
    icon?: string;
    iconColor?: string;
    trend?: number; // Percentage change (e.g., 12.5 for +12.5%)
    trendLabel?: string; // Label for trend (e.g., "vs last month")
    height?: number;
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
  // Card styling
  card: {
    background: COLORS.white,
    borderRadius: BORDER_RADIUS.large,
    padding: SPACING.xl,
    boxShadow: SHADOWS.card,
  },
  // Chart title styling
  title: {
    fontSize: parseInt(TYPOGRAPHY.fontSize.subsection),  // Subsection size (20px)
    fontWeight: TYPOGRAPHY.fontWeight.semibold,
    color: COLORS.text.primary,
  },
  // Chart subtitle styling
  subtitle: {
    fontSize: parseInt(TYPOGRAPHY.fontSize.body),
    color: COLORS.text.secondary,
  },
  // Tooltip styling
  tooltip: {
    backgroundColor: COLORS.darkNavy,
    borderColor: COLORS.darkNavy,
    borderWidth: 0,
    textColor: COLORS.white,
    padding: 12,
    borderRadius: parseInt(BORDER_RADIUS.medium),
  },
  // KPI colors - from design system
  colors: [
    COLORS.primary,
    COLORS.success,
    COLORS.warning,
    COLORS.chart.secondary,
    COLORS.chart.tertiary,
    COLORS.error,
    COLORS.info
  ],
  // Loading state color
  loadingColor: COLORS.primary,
  // Error state color
  errorColor: COLORS.error,
};
/**
* ============================================
* END DESIGN SYSTEM THEME
* ============================================
*/

// Helper function to get case-insensitive key from object
const getCaseInsensitiveValue = (obj: any, key: string): any => {
  if (!obj) return undefined;
  const actualKey = Object.keys(obj).find(k => k?.toLowerCase() === key?.toLowerCase());
  return actualKey ? obj[actualKey] : undefined;
};

// Numeric values only — nulls/blanks are EXCLUDED rather than coerced to 0, so
// they can't silently pad a sum or drag an average's denominator.
const numericValues = (rows: any[], field: string): number[] => {
  const out: number[] = [];
  for (const r of rows) {
    const v = getCaseInsensitiveValue(r, field);
    if (v === null || v === undefined || v === '') continue;
    const n = typeof v === 'number' ? v : parseFloat(v);
    if (!isNaN(n)) out.push(n);
  }
  return out;
};

// Helper function to safely extract value from nested objects
const extractValue = (val: any): any => {
  if (val === null || val === undefined) return null;
  if (typeof val === 'object' && !Array.isArray(val)) {
    // Extract value from nested objects (e.g., Owner: {name, id, email})
    if (val.value !== undefined) return val.value;
    if (val.count !== undefined) return val.count;
    if (val.total !== undefined) return val.total;
    if (val.name) return val.name;
    // If it's an object without known value keys, return length if array-like
    return Object.keys(val).length;
  }
  if (Array.isArray(val)) return val.length;
  return val;
};

// Helper function to format numbers with smart decimal handling
const formatNumberValue = (val: any, shouldFormat: boolean): string => {
  // First extract value from nested objects
  const extractedVal = extractValue(val);

  if (extractedVal === null || extractedVal === undefined) return 'N/A';

  const isNumeric = typeof extractedVal === 'number' ||
    (typeof extractedVal === 'string' && extractedVal.trim() !== '' && !isNaN(Number(extractedVal)));

  if (!isNumeric) return String(extractedVal);

  const numVal = typeof extractedVal === 'number' ? extractedVal : Number(extractedVal);

  if (!shouldFormat) return numVal.toString();

  // Smart formatting logic:
  // 1. No decimal points → show as is (e.g., 100 → "100", 5000 → "5,000")
  // 2. >= 1000 with decimals → round to 0 decimals (e.g., 1234.56 → "1,235")
  // 3. < 1000 with decimals → round to max 2 decimals (e.g., 4.6 → "4.6", 4.567 → "4.57")

  const hasDecimals = numVal % 1 !== 0;

  if (!hasDecimals) {
    // No decimal points: show as integer with thousand separators
    return numVal.toLocaleString('en-US', {
      minimumFractionDigits: 0,
      maximumFractionDigits: 0
    });
  } else if (Math.abs(numVal) >= 1000) {
    // Large numbers with decimals: round to 0 decimals
    return numVal.toLocaleString('en-US', {
      minimumFractionDigits: 0,
      maximumFractionDigits: 0
    });
  } else {
    // Small numbers with decimals: round to max 2 decimals (no trailing zeros)
    return numVal.toLocaleString('en-US', {
      minimumFractionDigits: 0,
      maximumFractionDigits: 2
    });
  }
};


const METADATA: ComponentMetadata = {
  id: 'dynamic-kpi-card',
  name: 'DynamicKPICard',
  displayName: 'Display a single metric value',
  isDisplayComp: false,
  type: 'KPICard',
  description: 'KPI card showing a single aggregated value. Always use externalTool with SQL aggregation (COUNT/SUM/AVG) in parameters.sql for metrics over all data.',
  category: '',
  keywords: ['kpi', 'dynamic', 'metrics', 'analytics', 'total', 'count'],
  props: {
    query: null,
    externalTool: '(object) REQUIRED. Object with toolId, toolName, parameters. Put SQL with COUNT/SUM/AVG in parameters.sql.',
    title: 'Card title',
    description: 'Card description',
    timeFrame: 'Time period for the data',
    config: {
      valueKey: 'Field name for the value from query result or tool outputSchema',
      prefix: '(optional) Prefix for the value',
      suffix: '(optional) Suffix/unit for the value',
      formatNumber: 'boolean',
      icon: 'Iconify icon name',
      iconColor: COLORS.primary,
    }
  }
}


interface DynamicKPICardComponent extends React.FC<DynamicKPICardProps> {
  Metadata: ComponentMetadata;
}

const DEFAULT_PROPS = {
  query: `SELECT
  COUNT(DISTINCT order_id) as value
FROM orders
WHERE status NOT IN ('Cancelled', 'Failed')`,
  title: 'Total Orders',
  description: 'Total number of successful orders',
  config: {
    valueKey: 'value',
    prefix: '',
    suffix: '',
    formatNumber: true,
    icon: 'mdi:cart-outline',
    iconColor: COLORS.primary,
    height: 130,
  }
}

const DynamicKPICard: React.FC<DynamicKPICardProps> = ({
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

  // Determine data source: prefetched config.data > externalTool > query
  const hasExternalTool = externalTool && externalTool.toolId;
  const hasConfigData = !!config.data && config.data.length > 0;
  const [data, setData] = useState<any[]>(config.data || []);
  const [loading, setLoading] = useState<boolean>(!hasConfigData && (!!hasExternalTool || !config.data));
  const [error, setError] = useState<string | null>(null);
  const [filterParams, setFilterParams] = useState<Record<string, any>>({});
  // Monotonic request counter — see fetchData for why every fetch function checks it
  const fetchIdRef = useRef(0);

  // Read initial filter labels from global state (set by FilterDropdown on mount)
  const getInitialFilterLabels = (): Record<string, string> => {
    const eventName = SA_RUNTIME?.uiBlockId
      ? `${SA_RUNTIME.uiBlockId}_FILTER`
      : 'GLOBAL_FILTER';
    return (window as any).__FILTER_STATE__?.[eventName]?.labels || {};
  };

  const [filterLabels, setFilterLabels] = useState<Record<string, string>>(getInitialFilterLabels);
  const [isDescriptionExpanded, setIsDescriptionExpanded] = useState<boolean>(false);
  const [isTitleExpanded, setIsTitleExpanded] = useState<boolean>(false);

  const defaultConfig = DEFAULT_PROPS.config as any


  const valueKey = config.valueKey || 'value';
  const prefix = config.prefix != null ? config.prefix : (defaultConfig.prefix || '');
  const suffix = config.suffix != null ? config.suffix : (defaultConfig.suffix || '');
  const formatNumber = config.formatNumber !== undefined ? config.formatNumber : (defaultConfig.formatNumber !== undefined ? defaultConfig.formatNumber : true);
  const icon = config.icon || 'mdi:chart-line';
  const iconColor = config.iconColor || defaultConfig.iconColor || THEME.colors[0];
  const trend = config.trend;
  const trendLabel = config.trendLabel || 'vs previous period';
  const height = config.height || defaultConfig.height || 140;

  // Interpolate {%key%} placeholders with filter labels
  // e.g. "{%statusLabel%} — Order Count" → "Delivered — Order Count"
  // If no labels set yet, strip placeholders cleanly rather than showing raw {%key%}
  const interpolate = (template: string, labels: Record<string, string>): string => {
    if (Object.keys(labels).length === 0) {
      return template.replace(/\{%(\w+)%\}\s*[-–]\s*/g, '').replace(/\{%(\w+)%\}/g, '').trim();
    }
    return template.replace(/\{%(\w+)%\}/g, (_, key) =>
      labels[key] !== undefined && labels[key] !== '' ? labels[key] : ''
    );
  };

  const displayTitle = interpolate(title, filterLabels);
  const displayDescription = interpolate(description, filterLabels);
  const displayTimeFrame = timeFrame ? interpolate(timeFrame, filterLabels) : '';

  // Extract primitive values for stable useEffect dependencies
  // This prevents re-fetching when parent re-renders with same data but new object references
  const toolId = externalTool?.toolId;
  const toolParamsStr = externalTool?.parameters ? JSON.stringify(externalTool.parameters) : '';
  const queryStr = typeof query === 'string' ? query : JSON.stringify(query);
  const uiBlockId = SA_RUNTIME?.uiBlockId;

  useEffect(() => {
    // Priority: config.data (prefetched) > externalTool > query
    if (hasConfigData) return;
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
      const { filterKey: sourceFilterKey, filterLabel, params, isInitial } = event.detail || {};

      // Accumulate labels for title/description interpolation
      if (sourceFilterKey && filterLabel) {
        setFilterLabels(prev => ({
          ...prev,
          [`${sourceFilterKey}Label`]: filterLabel
        }));
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
      // Use imported QueryExecutor, but also set it on window for compatibility
      const queryExecutor = new QueryExecutor();

      // Make it available on window for other components
      (window as any).SA = (window as any).SA || {};
      (window as any).SA.QueryExecutor = queryExecutor;

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
      const queryExecutor = new QueryExecutor();
      (window as any).SA = (window as any).SA || {};
      (window as any).SA.QueryExecutor = queryExecutor;

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

      console.log('[DynamicKPICard] Executing parameterized query:', finalQuery);

      const result = await queryExecutor.executeQuery({ query: finalQuery, SA_RUNTIME });
      if (requestId !== fetchIdRef.current) return; // superseded by a newer fetch — discard

      if (result && result.length > 0) {
        setData(result);
      } else {
        setData([]);
      }
    } catch (err) {
      if (requestId !== fetchIdRef.current) return;
      console.error('[DynamicKPICard] Error fetching data with params:', err);
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

      console.log(`[DynamicKPICard] Fetching external tool data with params:`, mergedTool);

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

      // Process result same as fetchExternalToolData
      let kpiData: any[] = [];
      // Prioritize result.data.data[0][valueKey] — the actual query row value.
      // result.data.count is row-count metadata (always 1 for single-row KPI queries), not the KPI value.
      const rootValue = result?.data?.data?.[0]?.[valueKey]
        ?? result?.data?.data?.[0]?.value
        ?? result?.[valueKey]
        ?? result?.total
        ?? result?.value
        ?? result?.data?.[valueKey]
        ?? result?.data?.value;

      if (rootValue !== undefined && rootValue !== null) {
        kpiData = [{ value: rootValue, [valueKey]: rootValue }];
      } else if (result?.data) {
        let dataArray: any[] = [];
        if (Array.isArray(result.data)) {
          dataArray = result.data;
        } else if (result.data.data && Array.isArray(result.data.data)) {
          dataArray = result.data.data;
        } else if (typeof result.data === 'object') {
          dataArray = [result.data];
        }

        if (dataArray.length > 0) {
          const firstItem = dataArray[0];
          const hasValueField = firstItem && (
            firstItem[valueKey] !== undefined ||
            firstItem.value !== undefined
          );
          kpiData = hasValueField ? dataArray : [{ value: dataArray.length, [valueKey]: dataArray.length }];
        }
      } else if (Array.isArray(result)) {
        kpiData = [{ value: result.length, [valueKey]: result.length }];
      }

      if (requestId !== fetchIdRef.current) return; // superseded by a newer fetch — discard
      setData(kpiData);
    } catch (err) {
      if (requestId !== fetchIdRef.current) return;
      console.error('[DynamicKPICard] Error fetching external tool data with params:', err);
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

      console.log(`[DynamicKPICard] Fetching data from external tool: ${externalTool.toolName} (${externalTool.toolId})`);

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

      console.log('[DynamicKPICard] External tool data fetched successfully', result);

      // For KPI cards, we need to extract a single value (count/total)
      // External tool responses often have structure: { total: 5, data: [...] }
      // We should prioritize root-level count/total fields over array data
      let kpiData: any[] = [];

      // Prioritize result.data.data[0][valueKey] — the actual query row value.
      // result.data.count is row-count metadata (always 1 for single-row KPI queries), not the KPI value.
      const rootValue = result?.data?.data?.[0]?.[valueKey]
        ?? result?.data?.data?.[0]?.value
        ?? result?.[valueKey]
        ?? result?.total
        ?? result?.value
        ?? result?.data?.[valueKey]
        ?? result?.data?.value;

      if (rootValue !== undefined && rootValue !== null && !config.aggregation) {
        // Create a synthetic data object with the value for the KPI card
        console.log('[DynamicKPICard] Found root-level value:', rootValue);
        kpiData = [{ value: rootValue, [valueKey]: rootValue }];
      } else {
        // Extract data array for aggregation or fallback
        let dataArray: any[] = [];

        if (result?.data) {
          if (Array.isArray(result.data)) {
            dataArray = result.data;
          } else if (result.data.data && Array.isArray(result.data.data)) {
            dataArray = result.data.data;
          } else if (result.data.records && Array.isArray(result.data.records)) {
            dataArray = result.data.records;
          } else if (result.data.items && Array.isArray(result.data.items)) {
            dataArray = result.data.items;
          } else if (result.data.results && Array.isArray(result.data.results)) {
            dataArray = result.data.results;
          } else if (typeof result.data === 'object') {
            dataArray = [result.data];
          }
        } else if (Array.isArray(result)) {
          dataArray = result;
        }

        // Check if aggregation is configured
        const aggregationType = config.aggregation;
        const aggregationField = config.aggregationField;

        if (aggregationType && dataArray.length > 0) {
          console.log(`[DynamicKPICard] Performing ${aggregationType} aggregation on ${dataArray.length} rows`);

          let aggregatedValue: number;

          switch (aggregationType) {
            case 'count':
              aggregatedValue = dataArray.length;
              console.log(`[DynamicKPICard] COUNT: ${aggregatedValue}`);
              break;

            case 'sum':
              if (!aggregationField) {
                console.warn('[DynamicKPICard] aggregationField required for sum aggregation');
                aggregatedValue = dataArray.length;
              } else {
                aggregatedValue = numericValues(dataArray, aggregationField)
                  .reduce((sum, n) => sum + n, 0);
                console.log(`[DynamicKPICard] SUM(${aggregationField}): ${aggregatedValue}`);
              }
              break;

            case 'avg':
              if (!aggregationField) {
                console.warn('[DynamicKPICard] aggregationField required for avg aggregation');
                aggregatedValue = dataArray.length;
              } else {
                // Divide by the count of NUMERIC values, not row count. Nulls were
                // coerced to 0 and still counted, dragging every average down.
                const nums = numericValues(dataArray, aggregationField);
                aggregatedValue = nums.length > 0 ? nums.reduce((s, n) => s + n, 0) / nums.length : 0;
                if (nums.length !== dataArray.length) {
                  console.warn(`[DynamicKPICard] AVG(${aggregationField}): ${dataArray.length - nums.length} of ${dataArray.length} rows non-numeric, excluded`);
                }
                console.log(`[DynamicKPICard] AVG(${aggregationField}): ${aggregatedValue}`);
              }
              break;

            case 'min':
              if (!aggregationField) {
                console.warn('[DynamicKPICard] aggregationField required for min aggregation');
                aggregatedValue = dataArray.length;
              } else {
                aggregatedValue = Math.min(...dataArray.map(item => {
                  const val = getCaseInsensitiveValue(item, aggregationField);
                  return typeof val === 'number' ? val : parseFloat(val) || Infinity;
                }));
                console.log(`[DynamicKPICard] MIN(${aggregationField}): ${aggregatedValue}`);
              }
              break;

            case 'max':
              if (!aggregationField) {
                console.warn('[DynamicKPICard] aggregationField required for max aggregation');
                aggregatedValue = dataArray.length;
              } else {
                aggregatedValue = Math.max(...dataArray.map(item => {
                  const val = getCaseInsensitiveValue(item, aggregationField);
                  return typeof val === 'number' ? val : parseFloat(val) || -Infinity;
                }));
                console.log(`[DynamicKPICard] MAX(${aggregationField}): ${aggregatedValue}`);
              }
              break;

            default:
              aggregatedValue = dataArray.length;
          }

          kpiData = [{ value: aggregatedValue, [valueKey]: aggregatedValue }];
        } else if (dataArray.length > 0) {
          // No aggregation configured - use existing logic
          const firstItem = dataArray[0];
          const hasValueField = firstItem && (
            firstItem[valueKey] !== undefined ||
            firstItem.value !== undefined ||
            firstItem.count !== undefined ||
            firstItem.total !== undefined
          );

          if (hasValueField) {
            kpiData = dataArray;
          } else {
            // No value field found - this is likely a list of records
            // Use the array length as the count
            console.log('[DynamicKPICard] No value field in data, using array length:', dataArray.length);
            kpiData = [{ value: dataArray.length, [valueKey]: dataArray.length }];
          }
        }
      }

      console.log('[DynamicKPICard] Processed KPI data:', kpiData);

      if (requestId !== fetchIdRef.current) return; // superseded by a newer fetch — discard
      if (kpiData.length > 0) {
        setData(kpiData);
      } else {
        setData([]);
      }
    } catch (err) {
      if (requestId !== fetchIdRef.current) return;
      console.error('[DynamicKPICard] Error fetching external tool data:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch data from external tool');
    } finally {
      if (requestId === fetchIdRef.current) setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="card bg-base-100 shadow-lg hover:shadow-xl transition-all duration-300 border border-base-300 group/kpicard overflow-hidden min-h-[175px]" style={{ height: 'fit-content' }}
      >
        {/* Gradient accent bar at top */}
        <div
          className="absolute top-0 left-0 right-0 h-1 bg-base-200"
        ></div>

        <div className="card-body p-5 pb-6">
          <div className="flex items-start justify-between mb-3">
            <div className="flex-1 pr-3">
              {/* Skeleton for title */}
              <div className="skeleton h-3 w-24 mb-2"></div>
              {/* Skeleton for description */}
              <div className="skeleton h-2 w-32 mt-1"></div>
            </div>

            {/* Skeleton for icon badge */}
            <div className="skeleton w-14 h-14 rounded-xl flex-shrink-0"></div>
          </div>

          {/* Skeleton for main value */}
          <div>
            <div className="skeleton h-10 w-32"></div>
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="card bg-base-100 shadow-lg hover:shadow-xl transition-all duration-300 border border-error group/kpicard overflow-hidden"
        onClick={handleDebugClick}
      >
        {isDebugModalOpen && (
          <DebugPropsModal
            componentName="DynamicKPICard"
            componentId={SA_RUNTIME?.componentId || 'unknown'}
            props={{ title, description, timeFrame, externalTool, config, filterParams, error }}
            SA_RUNTIME={SA_RUNTIME}
            isOpen={isDebugModalOpen}
            onClose={closeDebugModal}
          />
        )}
        {/* Error accent bar at top */}
        <div className="absolute top-0 left-0 right-0 h-1 bg-error"></div>

        <div className="card-body p-5" style={{ minHeight: `${height}px` }}>
          <div className="flex items-start gap-3">
            <div className="avatar placeholder">
              <div className="w-14 h-14 rounded-xl bg-error/10 border-2 border-error/20 flex items-center justify-center">
                <Icon icon="mdi:alert-circle" className="w-7 h-7 text-error" />
              </div>
            </div>
            <div className="flex-1">
              <h3 className="card-title text-sm font-semibold text-error mb-1">Error loading KPI</h3>
              <p className="text-xs opacity-60">{error}</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Get the main KPI value from the first row
  const value = data.length > 0 ? getCaseInsensitiveValue(data[0], valueKey) : null;
  const formattedValue = formatNumberValue(value, formatNumber);

  // Drop scale suffixes (K, M, B) if the raw value is already >= 1000
  // This prevents display like "$ 509,212,727 M" when the number isn't abbreviated
  const scaleUnits = ['k', 'm', 'b', 'cr', 'crore', 'l', 'lakh', 'million', 'billion'];
  const isNumericValue = typeof value === 'number' ||
    (typeof value === 'string' && value.trim() !== '' && !isNaN(Number(value)));
  const rawNum = isNumericValue ? (typeof value === 'number' ? value : Number(value)) : NaN;
  const displaySuffix = (!isNaN(rawNum) && Math.abs(rawNum) >= 1000 && scaleUnits.includes(suffix.trim().toLowerCase()))
    ? ''
    : suffix;

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

  return (
    <div className="card bg-base-100 shadow-sm hover:shadow-md transition-all duration-300 border border-base-300 group/kpicard overflow-hidden min-h-[175px]"
      onClick={handleDebugClick}
    >
      {/* Gradient accent bar at top */}
      <div
        className="absolute top-0 left-0 right-0 h-1"
        style={{
          background: `linear-gradient(90deg, ${iconColor}, ${iconColor}80)`
        }}
      ></div>
      {isDebugModalOpen && (
        <DebugPropsModal
          componentName="DynamicKPICard"
          componentId={SA_RUNTIME?.componentId || 'unknown'}
          props={{ title, description, timeFrame, externalTool: liveExternalTool, config, filterParams }}
          SA_RUNTIME={SA_RUNTIME}
          isOpen={isDebugModalOpen}
          onClose={closeDebugModal}
        />
      )}

      <div className="card-body p-5" style={{ minHeight: `${height}px`, paddingBottom: '1.5rem' }}>
        <div className="flex items-start justify-between mb-3">
          <div className="flex-1 min-w-0 pr-3">
            <h3
              className={`text-xs uppercase tracking-wider mb-1 opacity-60 font-semibold ${isTitleExpanded ? '' : 'overflow-hidden whitespace-nowrap text-ellipsis'}`}
              title={displayTitle}
              onClick={() => setIsTitleExpanded(prev => !prev)}
            >
              {displayTitle}
            </h3>
            {displayDescription && (
              <p
                className={`text-xs opacity-50 mt-1 min-h-[2.5em] ${isDescriptionExpanded ? '' : 'line-clamp-2'}`}
                onClick={() => setIsDescriptionExpanded(prev => !prev)}
              >
                {displayDescription}
              </p>
            )}
          <TruncationNote rendered={_rowsRendered} total={_rowsTotal} />
            {displayTimeFrame && (
              <div className="flex items-center gap-1 mt-1">
                <Icon icon="mdi:calendar-range" className="w-3 h-3 opacity-50" />
                <span className="text-[10px] opacity-50 font-medium">{displayTimeFrame}</span>
              </div>
            )}
          </div>

          {/* Icon badge with avatar */}
          <div className="avatar placeholder flex-shrink-0">
            <div
              className="w-14 h-14 rounded-xl transition-transform duration-300 group-hover/kpicard:scale-110 group-hover/kpicard:rotate-3 flex items-center justify-center"
              style={{
                backgroundColor: `${iconColor}15`,
                border: `2px solid ${iconColor}40`
              }}
            >
              <Icon icon={icon} className="w-7 h-7" style={{ color: iconColor }} />
            </div>
          </div>
        </div>

        {/* Main value using stat */}
        <div className="stat p-0 overflow-auto max-h-24">
          <div className="stat-value text-2xl font-bold text-base-content wrap-break-words overflow-x-auto overflow-y-hidden  [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {prefix}&nbsp;{formattedValue}&nbsp;{displaySuffix}
          </div>
        </div>

        {/* Trend indicator */}
        {trend !== undefined && trend !== null && (
          <div className="flex items-center gap-2 flex-wrap mt-2">
            <div
              className={`badge gap-1 font-semibold ${trend >= 0
                  ? 'badge-success'
                  : 'badge-error'
                }`}
            >
              <Icon
                icon={trend >= 0 ? 'mdi:trending-up' : 'mdi:trending-down'}
                className="w-4 h-4"
              />
              <span>{Math.abs(trend).toFixed(1)}%</span>
            </div>
            <span className="text-xs opacity-50">{trendLabel}</span>
          </div>
        )}
      </div>

    </div>
  );
};

// Attach metadata to component
(DynamicKPICard as DynamicKPICardComponent).Metadata = METADATA;

export default DynamicKPICard;

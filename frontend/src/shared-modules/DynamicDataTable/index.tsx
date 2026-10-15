import React, { useEffect, useLayoutEffect, useState, useRef } from 'react';
import { Icon } from '@iconify/react';
import LoadingState from '../../components/LoadingState';
import type { ComponentMetadata } from '../../types';
import { COLORS, SHADOWS, BORDER_RADIUS, TYPOGRAPHY, SPACING } from '../../design-system/tokens';
import { useDebugClick } from '../useDebugClick';
import DebugPropsModal from '../DebugPropsModal';
import TruncationNote from '../../components/TruncationNote';

interface ColumnConfig {
  key: string;
  label: string;
  width?: string;
  align?: 'left' | 'center' | 'right';
  format?: (value: any) => string;
}

interface ExternalTool {
  toolId: string;
  toolName: string;
  parameters: Record<string, any>;
}

interface QueryConfig {
  sql: string;
  params?: Record<string, any>;
}

interface DynamicDataTableProps {
  /** Stamped by the SDK when the payload is render-capped (§2.7). */
  _rowsRendered?: number;
  _rowsTotal?: number;
  query?: string | QueryConfig | null;
  title?: string;
  description?: string;
  timeFrame?: string;
  externalTool?: ExternalTool | null;
  config?: {
    pageSize?: number;
    showPagination?: boolean;
    sortable?: boolean;
    striped?: boolean;
    hoverable?: boolean;
    compact?: boolean;
    showExpandButton?: boolean;
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
  table: {
    headerBg: COLORS.lightBackground,
    borderColor: COLORS.borderGray,
    hoverBg: 'rgba(74, 127, 255, 0.05)',
    stripedBg: '#F8FAFC',
  },
  colors: [
    COLORS.primary,
    COLORS.success,
    COLORS.warning,
    COLORS.chart.secondary,
    COLORS.chart.tertiary,
    COLORS.error,
    COLORS.info
  ],
  loadingColor: COLORS.primary,
  errorColor: COLORS.error,
};

// Helper function to get case-insensitive key from object
const getCaseInsensitiveValue = (obj: any, key: string): any => {
  if (!obj || !key) return undefined;
  const actualKey = Object.keys(obj).find(k => k?.toLowerCase() === key?.toLowerCase());
  return actualKey ? obj[actualKey] : undefined;
};

// Helper function to format currency
const formatCurrency = (value: any): string => {
  if (value === null || value === undefined) return 'N/A';
  const numVal = typeof value === 'number' ? value : parseFloat(value);
  if (isNaN(numVal)) return value.toString();
  return `$${numVal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

const isTimestampColumn = (columnKey?: string): boolean => {
  if (!columnKey) return false;
  const key = columnKey.toLowerCase();
  return (
    key === 'timestamp' ||
    key.endsWith('_timestamp') ||
    key.includes('timestamp') ||
    key === 'starttime' ||
    key === 'endtime' ||
    key.endsWith('_time') ||
    key.endsWith('_at') ||
    key.endsWith('_date') ||
    key.includes('datetime')
  );
};

const formatDateTime = (value: any): string | null => {
  if (value === null || value === undefined || value === '') return 'N/A';

  let date: Date | null = null;

  if (value instanceof Date) {
    date = value;
  } else if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    date = new Date(value > 1e11 ? value : value * 1000);
  } else if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return 'N/A';

    if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
      const numericValue = Number(trimmed);
      if (!Number.isFinite(numericValue)) return null;
      date = new Date(numericValue > 1e11 ? numericValue : numericValue * 1000);
    } else {
      date = new Date(trimmed);
    }
  }

  if (!date || Number.isNaN(date.getTime())) return null;

  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
};

// Helper function to safely format cell value for display
// Handles nested objects, smart number formatting, and date formatting
const formatCellValue = (
  value: any,
  columnKey?: string,
  columnFormattingMap?: Record<string, any>,
  showRawMap?: Record<string, boolean>
): string => {
  if (value === null || value === undefined) return 'N/A';

  if (isTimestampColumn(columnKey)) {
    const formattedDateTime = formatDateTime(value);
    if (formattedDateTime !== null) return formattedDateTime;
  }

  // If it's an object (not an array), try to extract a display value
  if (typeof value === 'object' && !Array.isArray(value)) {
    // Common patterns for nested objects - try name, title, label, value, email first
    if (value.name) return String(value.name);
    if (value.title) return String(value.title);
    if (value.label) return String(value.label);
    if (value.value) return String(value.value);
    if (value.email) return String(value.email);
    if (value.id) return String(value.id);
    // Fallback: stringify the object
    return JSON.stringify(value);
  }

  // If it's an array, join the values
  if (Array.isArray(value)) {
    return value.map(v => formatCellValue(v)).join(', ');
  }

  // Try to parse value as number (handles both number types and numeric strings)
  let numValue: number | null = null;
  if (typeof value === 'number') {
    numValue = value;
  } else if (typeof value === 'string') {
    // Only parse strings that look like numbers (not dates or other formats)
    // Regex matches: optional sign, digits, optional decimal point and more digits
    const numericStringRegex = /^-?\d+\.?\d*(?:[eE][+-]?\d+)?$/;
    if (numericStringRegex.test(value.trim())) {
      const parsed = parseFloat(value);
      if (!isNaN(parsed)) {
        numValue = parsed;
      }
    }
  }

  // If it's a number (or numeric string), format it appropriately with smart formatting
  if (numValue !== null) {
    // If we have column formatting info, use smart formatting
    if (columnKey && columnFormattingMap) {
      const formatting = columnFormattingMap[columnKey];

      // If toggle is on for this column, show raw data
      if (showRawMap && showRawMap[columnKey]) {
        return String(numValue);
      }

      // Apply smart formatting based on column analysis
      if (formatting?.shouldFormat) {
        // Smart formatting: round to specified decimal places
        const roundedValue = parseFloat(numValue.toFixed(formatting.decimalPlaces));
        // Use toLocaleString for numbers >= 1000
        if (Math.abs(roundedValue) >= 1000) {
          return roundedValue.toLocaleString('en-US', {
            minimumFractionDigits: 0,
            maximumFractionDigits: formatting.decimalPlaces
          });
        }
        return roundedValue.toString();
      }

      // No formatting needed (all integers) - return as-is without commas
      if (formatting?.isNumericColumn && !formatting?.hasDecimals) {
        return String(numValue);
      }
    }

    // Fallback for numbers without formatting info (backward compatibility)
    // Smart formatting logic:
    // 1. No decimal points → show as integer without commas
    // 2. >= 1000 with decimals → round to 0 decimals (with commas)
    // 3. < 1000 with decimals → round to max 2 decimals (no trailing zeros)

    const hasDecimals = numValue % 1 !== 0;

    if (!hasDecimals) {
      // No decimal points: show as integer without commas
      return String(numValue);
    } else if (Math.abs(numValue) >= 1000) {
      // Large numbers with decimals: round to 0 decimals with commas
      return Math.round(numValue).toLocaleString('en-US');
    } else {
      // Small numbers with decimals: round to max 2 decimals (no trailing zeros)
      return parseFloat(numValue.toFixed(2)).toString();
    }
  }

  return String(value);
};

// Helper function to check if a column is relational (contains ID reference)
const isRelationalColumn = (columnKey: string): boolean => {
  const key = columnKey.toLowerCase();
  // Check for common ID patterns: ends with _id, named id, or contains _id_
  return key === 'id' ||
         key.endsWith('_id') ||
         key.endsWith('id') ||
         key.includes('_id_') ||
         key.startsWith('id_');
};

const METADATA: ComponentMetadata = {
  id: 'dynamic-data-table',
  name: 'DynamicDataTable',
  displayName: 'Display data rows in a table',
  isDisplayComp: false,
  type: 'DataTable',
  description: 'Displays data rows in a paginated table with sorting. Always use externalTool with SQL in parameters.sql to fetch rows.',
  category: 'Table',
  keywords: ['table', 'data', 'pagination', 'dynamic', 'list', 'rows'],
  props: {
    query: null,
    externalTool: '(object) REQUIRED. Object with toolId, toolName, parameters. Put SQL query in parameters.sql.',
    title: 'Table title',
    description: 'Table description',
    timeFrame: 'Time period for the data',
    config: {
      columns: '(optional) Array of { key, label } objects choosing which columns to show, in order. `key` MUST exactly match a column name in the data. Omit to show every column.',
      pageSize: 'number of rows per page',
      showPagination: 'boolean',
      height: 400,
      sortable: 'boolean',
      striped: 'boolean',
      hoverable: 'boolean',
      compact: 'boolean',
      showExpandButton: 'boolean (default true). Set false to hide the "Show all" button that expands the table beyond its initial row count.'
    }
  }
}

const DEFAULT_PROPS =  {
    query: `SELECT
  o.order_id,
  o.order_date,
  c.first_name || ' ' || c.last_name as customer_name,
  c.email,
  o.status,
  o.total_amount,
  o.payment_method
FROM orders o
JOIN customers c ON o.customer_id = c.customer_id
ORDER BY o.order_date DESC
LIMIT 100`,
    title: 'Recent Orders',
    description: '',
    config: {
      pageSize: 10,
      showPagination: true,
      sortable: true,
      striped: true,
      hoverable: true,
      compact: false,
    }
  }

interface DynamicDataTableComponent extends React.FC<DynamicDataTableProps> {
  Metadata: ComponentMetadata;
}

const DynamicDataTable: React.FC<DynamicDataTableProps> = ({
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
  // If externalTool is provided, we always fetch fresh data (no config.data caching)
  const hasExternalTool = externalTool && externalTool.toolId;
  const [data, setData] = useState<any[]>(config.data || []);
  const [loading, setLoading] = useState<boolean>(!(config.data && config.data.length > 0) && (hasExternalTool ? true : !config.data));
  const [error, setError] = useState<string | null>(null);

  const [filterParams, setFilterParams] = useState<Record<string, any>>({});
  const [aggregates, setAggregates] = useState<Record<string, any>>({});
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

  // Pagination state
  const [currentPage, setCurrentPage] = useState<number>(1);

  // Sorting state
  const [sortColumn, setSortColumn] = useState<string | null>(null);
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');

  // Show all rows state
  const [showAllRows, setShowAllRows] = useState<boolean>(false);

  // Column formatting analysis state
  const [columnFormatting, setColumnFormatting] = useState<Record<string, {
    hasDecimals: boolean;
    maxValue: number;
    shouldFormat: boolean;
    decimalPlaces: number;
    isNumericColumn: boolean;
  }>>({});

  // Column-specific raw data toggle state
  const [showRawData, setShowRawData] = useState<Record<string, boolean>>({});

  // Column header hover state (for format toggle button)
  const [hoveredColumn, setHoveredColumn] = useState<string | null>(null);

  // Fullscreen state
  const [isHovered, setIsHovered] = useState<boolean>(false);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const [isDescriptionExpanded, setIsDescriptionExpanded] = useState<boolean>(false);
  const [isTitleExpanded, setIsTitleExpanded] = useState<boolean>(false);
  const chartContainerRef = useRef<HTMLDivElement>(null);
  // Inside a chat answer the table drops its own card frame and keeps its controls compact.
  const [inChat, setInChat] = useState(false);
  useLayoutEffect(() => { setInChat(!!chartContainerRef.current?.closest('.chat-answer')); }, []);

  const defaultConfig = DEFAULT_PROPS.config as any;
  // const columns = config.columns || defaultConfig.columns || [];
  const pageSize = config.pageSize || defaultConfig.pageSize || 10;
  const showPagination = config.showPagination !== undefined ? config.showPagination : (defaultConfig.showPagination !== undefined ? defaultConfig.showPagination : true);
  const sortable = config.sortable !== undefined ? config.sortable : (defaultConfig.sortable !== undefined ? defaultConfig.sortable : true);
  const striped = config.striped !== undefined ? config.striped : (defaultConfig.striped !== undefined ? defaultConfig.striped : true);
  const hoverable = config.hoverable !== undefined ? config.hoverable : (defaultConfig.hoverable !== undefined ? defaultConfig.hoverable : true);
  const compact = config.compact !== undefined ? config.compact : (defaultConfig.compact !== undefined ? defaultConfig.compact : false);
  const showExpandButton = config.showExpandButton !== undefined ? config.showExpandButton : true;

  // Grid-line color for table borders.
  const GRID_BORDER = COLORS.borderGray;

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
    const eventName = uiBlockId ? `${uiBlockId}_FILTER` : 'GLOBAL_FILTER';

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
            // Track which keys each filter owns
            const filterKeyMap = (window as any).__FILTER_KEY_MAP__ || {};
            const prevKeys = filterKeyMap[sourceFilterKey] || [];
            for (const key of prevKeys) {
              delete mergedParams[key];
            }
          } else if (sourceFilterKey) {
            // Store which keys this filter sets, so we can clear them later
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
       without `allowfullscreen`. Nothing to do but stay as we are — the table
       is still on screen and still readable. */
    if (request) Promise.resolve(request.call(elem)).catch(() => {});
  };

  const exitFullscreen = () => {
    const d = document as any;
    if (!(d.fullscreenElement || d.webkitFullscreenElement || d.msFullscreenElement)) return;
    const exit = d.exitFullscreen || d.webkitExitFullscreen || d.msExitFullscreen;
    if (exit) Promise.resolve(exit.call(d)).catch(() => {});
  };

  // Handle Ctrl+Click on table cells for relational columns
  const handleCellCtrlClick = (
    event: React.MouseEvent<HTMLTableCellElement>,
    columnKey: string,
    value: any
  ) => {
    // Only proceed if Ctrl key is pressed and column is relational
    if (!event.ctrlKey || !isRelationalColumn(columnKey)) {
      return;
    }

    // Prevent default behavior and text selection
    event.preventDefault();
    event.stopPropagation();

    // Skip if value is null/undefined/empty
    if (value === null || value === undefined || value === '') {
      console.log('Skipping Ctrl+Click: empty value');
      return;
    }

    // Format column name for display (replace underscores, title case)
    const formattedColumn = columnKey
      .replace(/_id$/i, '') // Remove _id suffix
      .replace(/_/g, ' ')   // Replace underscores with spaces
      .replace(/\b\w/g, l => l.toUpperCase()); // Title case

    // Construct the question
    const question = `show me info about ${formattedColumn} ${value}`;

    console.log(`🔍 Ctrl+Click on relational column: ${columnKey} = ${value}`);
    console.log(`📝 Generated question: ${question}`);

    // Trigger the action handler with the generated question
    try {
      const actionHandler = (window as any).SA?.onActionClick;

      if (typeof actionHandler === 'function') {
        actionHandler({
          question: question,
          actionId: `drill-down-${columnKey}-${value}`,
          actionName: `Drill down: ${formattedColumn}`,
          threadId: SA_RUNTIME?.threadId,
          uiBlockId: SA_RUNTIME?.uiBlockId,
          componentId: SA_RUNTIME?.componentId,
        });
      } else {
        console.warn('No action handler registered in runtime for Ctrl+Click drill-down');
      }
    } catch (err) {
      console.error('Error handling Ctrl+Click drill-down:', err);
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

      console.log(`[DynamicDataTable] Fetching data from external tool: ${externalTool.toolName} (${externalTool.toolId})`);

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
          formData: {}, // No form data needed for read operations
          SA_RUNTIME
        });
      }

      console.log('[DynamicDataTable] External tool data fetched successfully', result);
      // Extract data from the result
      // The result structure may vary based on the tool, so we handle common patterns
      let tableData: any[] = [];

      if (result?.data) {
        // If result.data is an array, use it directly
        if (Array.isArray(result.data)) {
          tableData = result.data;
        }
        // If result.data has a nested data array (common pattern)
        else if (result.data.data && Array.isArray(result.data.data)) {
          tableData = result.data.data;
        }
        // If result.data is an object with records/items/results
        else if (result.data.records && Array.isArray(result.data.records)) {
          tableData = result.data.records;
        }
        else if (result.data.items && Array.isArray(result.data.items)) {
          tableData = result.data.items;
        }
        else if (result.data.results && Array.isArray(result.data.results)) {
          tableData = result.data.results;
        }
      }
      // If result itself is an array
      else if (Array.isArray(result)) {
        tableData = result;
      }
      console.log('[DynamicDataTable] External tool result:', tableData.length);

      // Extract top-level aggregate fields (e.g. totalItems, totalDeadstockValue)
      if (result?.data && !Array.isArray(result.data) && typeof result.data === 'object') {
        const agg: Record<string, any> = {};
        for (const [key, val] of Object.entries(result.data)) {
          if (key !== 'data' && key !== 'records' && key !== 'items' && key !== 'results'
              && (typeof val === 'number' || typeof val === 'string')) {
            agg[key] = val;
          }
        }
        if (Object.keys(agg).length > 0) setAggregates(agg);
      }

      if (requestId !== fetchIdRef.current) return; // superseded by a newer fetch — discard
      if (tableData.length > 0) {
        setData(tableData);
      } else {
        setData([]);
      }
    } catch (err) {
      if (requestId !== fetchIdRef.current) return;
      console.error('[DynamicDataTable] Error fetching external tool data:', err);
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

      console.log('[DynamicDataTable] Executing parameterized query:', finalQuery);

      const result = await queryExecutor.executeQuery({ query: finalQuery, SA_RUNTIME });
      if (requestId !== fetchIdRef.current) return; // superseded by a newer fetch — discard

      if (result && result.length > 0) {
        setData(result);
      } else {
        setData([]);
      }
    } catch (err) {
      if (requestId !== fetchIdRef.current) return;
      console.error('[DynamicDataTable] Error fetching data with params:', err);
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

      console.log(`[DynamicDataTable] Fetching external tool data with params:`, mergedTool);

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

      let tableData: any[] = [];
      if (result?.data) {
        if (Array.isArray(result.data)) {
          tableData = result.data;
        } else if (result.data.data && Array.isArray(result.data.data)) {
          tableData = result.data.data;
        } else if (result.data.records && Array.isArray(result.data.records)) {
          tableData = result.data.records;
        }
      } else if (Array.isArray(result)) {
        tableData = result;
      }

      // Extract top-level aggregate fields
      if (result?.data && !Array.isArray(result.data) && typeof result.data === 'object') {
        const agg: Record<string, any> = {};
        for (const [key, val] of Object.entries(result.data)) {
          if (key !== 'data' && key !== 'records' && key !== 'items' && key !== 'results'
              && (typeof val === 'number' || typeof val === 'string')) {
            agg[key] = val;
          }
        }
        if (Object.keys(agg).length > 0) setAggregates(agg);
      }

      if (requestId !== fetchIdRef.current) return; // superseded by a newer fetch — discard
      setData(tableData);
    } catch (err) {
      if (requestId !== fetchIdRef.current) return;
      console.error('[DynamicDataTable] Error fetching external tool data with params:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch data');
    } finally {
      if (requestId === fetchIdRef.current) setLoading(false);
    }
  };

  // Analyze columns for smart number formatting
  useEffect(() => {
    if (data.length === 0) {
      setColumnFormatting({});
      return;
    }

    // Get column keys from first row
    const columnKeys = Object.keys(data[0]);
    const analysis: Record<string, any> = {};

    columnKeys.forEach(colKey => {
      let maxVal = 0;
      let hasDecimals = false;
      let isNumericColumn = false;

      // Analyze all values in this column
      data.forEach(row => {
        const rawValue = getCaseInsensitiveValue(row, colKey);

        // Try to parse as number (handles both number types and numeric strings)
        let numValue: number | null = null;

        if (typeof rawValue === 'number') {
          numValue = rawValue;
          isNumericColumn = true;
        } else if (typeof rawValue === 'string') {
          // Only parse strings that look like numbers (not dates or other formats)
          const numericStringRegex = /^-?\d+\.?\d*(?:[eE][+-]?\d+)?$/;
          if (numericStringRegex.test(rawValue.trim())) {
            const parsed = parseFloat(rawValue);
            if (!isNaN(parsed)) {
              numValue = parsed;
              isNumericColumn = true;
            }
          }
        }

        // If we successfully got a number, analyze it
        if (numValue !== null) {
          maxVal = Math.max(maxVal, Math.abs(numValue));
          // Check if it has decimals
          if (numValue % 1 !== 0) {
            hasDecimals = true;
          }
        }
      });

      // Determine if this column should be formatted
      // Only format numeric columns that have decimal values
      let shouldFormat = false;
      let decimalPlaces = 0;

      if (isNumericColumn && hasDecimals) {
        if (maxVal >= 1000) {
          // High values with decimals: round to 0 decimals
          shouldFormat = true;
          decimalPlaces = 0;
        } else {
          // Low values with decimals: round to 2 decimals
          shouldFormat = true;
          decimalPlaces = 2;
        }
      }

      analysis[colKey] = {
        hasDecimals,
        maxValue: maxVal,
        shouldFormat,
        decimalPlaces,
        isNumericColumn
      };
    });

    console.log('[DynamicDataTable] Column formatting analysis:', analysis);
    setColumnFormatting(analysis);
  }, [data]);

  // Auto-detect columns if not provided
  const detectedColumns: ColumnConfig[] =
    data.length > 0 ? Object.keys(data[0]).map(key => ({
      key,
      label: key.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
      align: 'left' as const
    })) : [];

  // Sorting logic
  const handleSort = (columnKey: string) => {
    if (!sortable) return;

    if (sortColumn === columnKey) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortColumn(columnKey);
      setSortDirection('asc');
    }
    setCurrentPage(1); // Reset to first page on sort
  };

  // Sort data
  const sortedData = sortColumn ? [...data].sort((a, b) => {
    const aVal = getCaseInsensitiveValue(a, sortColumn);
    const bVal = getCaseInsensitiveValue(b, sortColumn);

    if (aVal === null || aVal === undefined) return 1;
    if (bVal === null || bVal === undefined) return -1;

    if (typeof aVal === 'number' && typeof bVal === 'number') {
      return sortDirection === 'asc' ? aVal - bVal : bVal - aVal;
    }

    const aStr = String(aVal).toLowerCase();
    const bStr = String(bVal).toLowerCase();

    if (sortDirection === 'asc') {
      return aStr.localeCompare(bStr);
    } else {
      return bStr.localeCompare(aStr);
    }
  }) : data;

  // Pagination logic
  const INITIAL_ROW_COUNT = 3;

  // Amounts and measures align right so digits line up; ids and codes (plain numbers) stay left.
  // Pre-formatted amounts ("₹25,000", "12.5%") count too; a bare digit string is an id.
  const AMOUNT_TEXT = /^[-+]?\s?[₹$€£]?\s?\d[\d,]*(\.\d+)?\s?(%|K|L|Cr|M|B)?$/i;
  const alignOf = (column: ColumnConfig) => {
    if (column.align) return column.align;
    const f = columnFormatting[column.key];
    if (f?.isNumericColumn && f.hasDecimals) return 'right';
    const sample = sortedData.slice(0, 50).map(r => getCaseInsensitiveValue(r, column.key))
      .filter(v => v !== null && v !== undefined && v !== '' && v !== 'N/A').map(String);
    return sample.length && sample.every(v => AMOUNT_TEXT.test(v.trim())) && sample.some(v => /[₹$€£%,.]|\d\s?(K|L|Cr|M|B)$/i.test(v)) ? 'right' : 'left';
  };
  /** Short header labels stay on one line. */
  const SINGLE_LINE_HEADER = 24;
  const totalPages = Math.ceil(sortedData.length / pageSize);
  const startIndex = (currentPage - 1) * pageSize;
  const endIndex = startIndex + pageSize;

  // In portal/fullscreen mode, always show all rows (with pagination if enabled).
  // In normal mode, respect the showAllRows toggle — unless the expand button
  // is hidden entirely, in which case there's no way to reach showAllRows, so
  // default to showing everything instead of permanently capping at 3 rows.
  const getDisplayedData = () => {
    if (isFullscreen || showAllRows || !showExpandButton) {
      return showPagination ? sortedData.slice(startIndex, endIndex) : sortedData;
    }
    return sortedData.slice(0, INITIAL_ROW_COUNT);
  };

  const goToPage = (page: number) => {
    setCurrentPage(Math.max(1, Math.min(page, totalPages)));
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
      <div className="card bg-base-100 shadow-sm border border-error p-6"
        onClick={handleDebugClick}
      >
        {isDebugModalOpen && (
          <DebugPropsModal
            componentName="DynamicDataTable"
            componentId={SA_RUNTIME?.componentId || 'unknown'}
            props={{ title, description, timeFrame, externalTool, config, filterParams, error }}
            isOpen={isDebugModalOpen}
            onClose={closeDebugModal}
          />
        )}
        <div className="alert alert-error">
          <Icon icon="mdi:alert-circle" className="w-5 h-5 flex-shrink-0" />
          <div>
            <p className="text-sm font-medium">Error loading data</p>
            <p className="text-xs opacity-80 mt-1">{error}</p>
          </div>
        </div>
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div className="card bg-base-100 shadow-sm border border-base-300 p-6">
        <div className="text-center py-8">
          <Icon icon="mdi:table-off" className="w-12 h-12 opacity-40 mx-auto mb-3" />
          <p className="text-sm opacity-60">No data available</p>
        </div>
      </div>
    );
  }

  // Table content component - renders the actual table UI
  /* The table. One of them — this is the element that goes fullscreen, rather
     than a copy of it being rendered somewhere else to be fullscreened.

     `inPortal` became `isFullscreen` rather than disappearing: here it never
     only meant "this is the copy", it meant "this is the big view" — all rows
     rather than three, a card frame even inside a chat answer, a scrolling
     body. Those are still wanted, and are now asked of the thing that actually
     knows. */
  const renderTableContent = () => (
    <div
      ref={chartContainerRef}
      className={`card bg-base-100 overflow-hidden relative ${inChat && !isFullscreen ? 'rounded-none' : 'shadow-sm border border-base-300 hover:shadow-md transition-shadow duration-200'}`}
      /* Only fullscreen needs a column: in place the card is as tall as its
         content, and the browser's `:fullscreen` rule gives it the screen. */
      style={isFullscreen ? {
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
      } : undefined}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onClick={handleDebugClick}
    >
      {isDebugModalOpen && (
        <DebugPropsModal
          componentName="DynamicDataTable"
          componentId={SA_RUNTIME?.componentId || 'unknown'}
          props={{ title, description, timeFrame, externalTool: liveExternalTool, config, filterParams }}
          isOpen={isDebugModalOpen}
          onClose={closeDebugModal}
        />
      )}
      {/* Gradient accent bar at top; a chat answer has no card frame for it to cap */}
      {!(inChat && !isFullscreen) && <div
        className="absolute top-0 left-0 right-0 h-1"
        style={{
          background: `linear-gradient(90deg, ${COLORS.primary}, ${COLORS.primary}80)`
        }}
      ></div>}

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

      {/* Header */}
      <div className={inChat && !isFullscreen ? 'px-4 md:px-5 pt-1 pb-3' : 'p-6 pb-4'}>
        <div className="flex items-start justify-between">
          <div className="flex-1 min-w-0 pr-3">
            <h3
              className={`${inChat && !isFullscreen ? 'text-[15px]' : 'text-lg'} font-semibold text-base-content ${isTitleExpanded ? '' : 'overflow-hidden whitespace-nowrap text-ellipsis'}`}
              title={displayTitle}
              onClick={() => setIsTitleExpanded(prev => !prev)}
            >
              {displayTitle}
            </h3>
            {displayDescription && (
              <p
                className={`${inChat && !isFullscreen ? 'text-[13px] mt-0.5' : 'text-sm mt-1 min-h-[2.5em]'} opacity-60 ${isDescriptionExpanded ? '' : 'line-clamp-2'}`}
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
          <div className="flex items-center gap-2 flex-shrink-0">
            {inChat && !isFullscreen ? (<>
              <span className="text-xs text-base-content/50 tabular-nums mr-1">
                {showExpandButton && !showAllRows && sortedData.length > INITIAL_ROW_COUNT
                  ? `Showing ${INITIAL_ROW_COUNT} of ${sortedData.length}`
                  : `${sortedData.length} ${sortedData.length === 1 ? 'row' : 'rows'}`}
              </span>
              {showExpandButton && sortedData.length > INITIAL_ROW_COUNT && (
                <button
                  onClick={() => { setShowAllRows(!showAllRows); if (showAllRows) setCurrentPage(1); }}
                  className="btn btn-ghost btn-xs gap-1 text-base-content/60 hover:text-base-content"
                >
                  {showAllRows ? 'Show fewer' : 'Show all'}
                  <Icon icon={showAllRows ? 'mdi:chevron-up' : 'mdi:chevron-down'} className="w-4 h-4" />
                </button>
              )}
            </>) : (
            <span
              className="inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-full"
              style={{ background: COLORS.lightBackground, color: COLORS.text.secondary, border: `1px solid ${COLORS.borderGray}` }}
            >
              <Icon icon="mdi:table-row" className="w-3.5 h-3.5" style={{ opacity: 0.6 }} />
              {sortedData.length} {sortedData.length === 1 ? 'row' : 'rows'}
            </span>
            )}
          </div>
        </div>
      </div>

      {/* Aggregate Summary Bar */}
      {Object.keys(aggregates).length > 0 && (
        <div className="flex flex-wrap gap-4 px-5 py-2" style={{ borderBottom: `1px solid ${COLORS.borderGray}` }}>
          {Object.entries(aggregates).map(([key, val]) => {
            // Format the key: camelCase → Title Case (e.g. totalItems → Total Items)
            const label = key.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase()).trim();
            // Format value: numbers get locale formatting, currency-like values get $
            const isMoneyField = /value|cost|revenue|price/i.test(key);
            const formatted = typeof val === 'number'
              ? (isMoneyField ? `$${val.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}` : val.toLocaleString())
              : String(val);
            return (
              <div key={key} className="flex items-center gap-1.5">
                <span style={{ fontSize: TYPOGRAPHY.fontSize.small, color: COLORS.text.secondary }}>{label}:</span>
                <span style={{ fontSize: TYPOGRAPHY.fontSize.body, fontWeight: TYPOGRAPHY.fontWeight.semibold, color: COLORS.text.primary }}>{formatted}</span>
              </div>
            );
          })}
        </div>
      )}

      {/* Table */}
      {/* In a chat answer the rows share the text's side margins, so every part starts on one line. */}
      <div className={`overflow-x-auto ${inChat && !isFullscreen ? 'px-4 md:px-5' : 'px-5'} ${isFullscreen ? 'flex-1 overflow-y-auto' : ''}`}>
        <table
          className={`table w-full ${striped ? 'table-zebra' : ''} ${compact ? 'table-sm' : ''} ${inChat && !isFullscreen ? 'text-sm [&_td]:py-2.5 [&_th]:py-2.5' : ''}`}
          style={{ borderCollapse: 'collapse' }}
        >
          <thead>
            <tr className="bg-base-200">
              {detectedColumns.map((column: ColumnConfig, idx: number) => {
                const hasFormatting = columnFormatting[column.key]?.shouldFormat;
                const isColumnHovered = hoveredColumn === column.key;
                return (
                  <th
                    key={idx}
                    style={{
                      width: column.width,
                      whiteSpace: String(column.label ?? '').length <= SINGLE_LINE_HEADER ? 'nowrap' : 'normal',
                      position: 'sticky',
                      top: 0,
                      zIndex: 1,
                      background: COLORS.lightBackground,
                      borderTop: `1px solid ${GRID_BORDER}`,
                      borderBottom: `1px solid ${GRID_BORDER}`,
                      color: COLORS.text.secondary,
                    }}
                    className={`text-xs font-medium normal-case ${alignOf(column) === 'right' ? 'text-right' : alignOf(column) === 'center' ? 'text-center' : 'text-left'}`}
                    onMouseEnter={() => setHoveredColumn(column.key)}
                    onMouseLeave={() => setHoveredColumn(null)}
                  >
                    <div className={`flex items-center gap-1 ${alignOf(column) === 'right' ? 'justify-end' : alignOf(column) === 'center' ? 'justify-center' : 'justify-start'}`}>
                      <span
                        className={`relative ${sortable ? 'cursor-pointer select-none' : ''}`}
                        onClick={() => handleSort(column.key)}
                      >
                        {column.label}
                        {hasFormatting && (
                          <button
                            className={`absolute left-full top-1/2 -translate-y-1/2 ml-1 btn btn-ghost btn-xs p-0 min-h-0 h-auto transition-opacity duration-150 ${isColumnHovered ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              setShowRawData(prev => ({
                                ...prev,
                                [column.key]: !prev[column.key]
                              }));
                            }}
                            title={showRawData[column.key] ? "Show formatted values" : "Show raw data"}
                          >
                            <Icon
                              icon="material-symbols-light:format-paragraph-rounded"
                              className="w-4 h-4"
                            />
                          </button>
                        )}
                      </span>
                      {sortable && sortColumn === column.key && (
                        <Icon
                          icon={sortDirection === 'asc' ? 'mdi:arrow-up' : 'mdi:arrow-down'}
                          className="w-4 h-4 text-primary"
                        />
                      )}
                    </div>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {getDisplayedData().map((row, rowIdx) => (
              <tr
                key={rowIdx}
                className={hoverable ? 'hover' : ''}
              >
                {detectedColumns.map((column: ColumnConfig, colIdx: number) => {
                  const value = getCaseInsensitiveValue(row, column.key);
                  // Apply formatCellValue to handle nested objects (e.g., Owner: {name, id, email})
                  // Pass columnKey and formatting maps for smart number formatting
                  const formattedValue = column.format
                    ? column.format(value)
                    : formatCellValue(value, column.key, columnFormatting, showRawData);
                  const isRelational = isRelationalColumn(column.key);

                  return (
                    <td
                      key={colIdx}
                      onClick={(e) => handleCellCtrlClick(e, column.key, value)}
                      style={{ borderBottom: `1px solid ${GRID_BORDER}` }}
                      className={`tabular-nums ${alignOf(column) === 'right' ? 'text-right' : alignOf(column) === 'center' ? 'text-center' : 'text-left'} ${isRelational ? 'cursor-pointer' : ''}`}
                      title={isRelational ? 'Ctrl+Click to drill down' : undefined}
                    >
                      {isRelational ? (
                        <span className="hover:underline transition-colors cursor-pointer" style={inChat ? undefined : { color: COLORS.primary }}>
                          {formattedValue}
                        </span>
                      ) : (
                        <span>{formattedValue}</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Show/Hide All Rows Button - only in normal mode, not in fullscreen */}
      {!isFullscreen && !inChat && showExpandButton && sortedData.length > INITIAL_ROW_COUNT && (
        <div className="flex items-center justify-end px-6 py-4 border-t border-base-300">
          <button
            onClick={() => {
              setShowAllRows(!showAllRows);
              if (showAllRows) {
                setCurrentPage(1); // Reset to first page when hiding
              }
            }}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold text-white cursor-pointer transition-all duration-200 hover:shadow-md hover:brightness-105"
            style={{ background: '#0d9488' /* teal-600 */ }}
          >
            <span>{showAllRows ? 'Hide rows' : 'Show all'}</span>
            <Icon icon={showAllRows ? 'mdi:chevron-up' : 'mdi:chevron-down'} className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Pagination - show in fullscreen (always), when showAllRows is true, or when the
          expand button is hidden entirely (no other way to reach paginated rows then) */}
      {(isFullscreen || showAllRows || !showExpandButton) && showPagination && totalPages > 1 && (
        <div className="flex items-center justify-between px-6 py-4 border-t border-base-300">
          <div className="text-sm opacity-60">
            Showing {startIndex + 1} to {Math.min(endIndex, sortedData.length)} of {sortedData.length} rows
          </div>
          <div className="join">
            <button
              onClick={() => goToPage(currentPage - 1)}
              disabled={currentPage === 1}
              className="join-item btn btn-sm"
            >
              <Icon icon="mdi:chevron-left" className="w-4 h-4" />
            </button>

            {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
              let pageNum;
              if (totalPages <= 5) {
                pageNum = i + 1;
              } else if (currentPage <= 3) {
                pageNum = i + 1;
              } else if (currentPage >= totalPages - 2) {
                pageNum = totalPages - 4 + i;
              } else {
                pageNum = currentPage - 2 + i;
              }

              return (
                <button
                  key={i}
                  onClick={() => goToPage(pageNum)}
                  className={`join-item btn btn-sm ${currentPage === pageNum ? 'btn-primary' : ''}`}
                >
                  {pageNum}
                </button>
              );
            })}

            <button
              onClick={() => goToPage(currentPage + 1)}
              disabled={currentPage === totalPages}
              className="join-item btn btn-sm"
            >
              <Icon icon="mdi:chevron-right" className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

    </div>
  );

  /* One table, rendered where it belongs. Fullscreen is the browser taking
     this element to the screen — not a second copy of it somewhere else. */
  return renderTableContent();
};

// Attach metadata to component
(DynamicDataTable as DynamicDataTableComponent).Metadata = METADATA;

export default DynamicDataTable;

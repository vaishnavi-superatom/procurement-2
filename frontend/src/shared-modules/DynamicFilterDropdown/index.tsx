import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '@iconify/react';
import type { ComponentMetadata } from '../../types';
import { COLORS, SHADOWS, BORDER_RADIUS, TYPOGRAPHY, SPACING } from '../../design-system/tokens';

interface FilterOption {
  label: string;
  value: string;
  params: Record<string, any>;
  isDefault?: boolean;
}

interface ExternalToolConfig {
  toolId: string;
  toolName: string;
  parameters: Record<string, any>;
}

interface OptionMapping {
  label: string;
  value: string;
  params?: Record<string, string>;
}

interface DynamicFilterDropdownProps {
  title?: string;
  filterKey?: string;
  filters?: FilterOption[];
  defaultValue?: string;
  externalTool?: ExternalToolConfig;
  optionMapping?: OptionMapping;
  listenTo?: string[];
  includeAllOption?: boolean;
  SA_RUNTIME?: {
    uiBlockId?: string;
    threadId?: string;
    componentId?: string;
    [key: string]: any;
  };
}

const METADATA: ComponentMetadata = {
  id: 'dynamic-filter-dropdown',
  name: 'DynamicFilterDropdown',
  displayName: 'Filter dropdown for dashboards',
  isDisplayComp: false,
  type: 'FilterDropdown',
  description: 'Dropdown filter that broadcasts filter changes to other components. Supports static options via filters prop OR dynamic options fetched from an externalTool. For cascading filters, use listenTo to re-fetch options when upstream filters change. Use when user asks about specific time periods, categories, or any filterable dimension.',
  category: 'Filter',
  keywords: ['filter', 'dropdown', 'select', 'dashboard', 'control', 'interactive', 'cascading', 'dynamic', 'dependent', 'time period', 'date range', 'category filter'],
  props: {
    title: 'Label for the filter dropdown, eg. Time Period, Category, Status, Branch',
    defaultValue: 'Value of the initially selected filter option',
    filters: [
      {
        label: 'Display text shown in dropdown (static mode)',
        value: 'Unique identifier for this option',
        params: { paramKey: 'Value that replaces $paramKey placeholder in other component queries' },
        isDefault: 'Boolean - set true for the default selected option (optional)'
      }
    ],
    externalTool: {
      toolId: 'Tool ID to fetch options from (e.g. get-branches, source_uuid_query)',
      toolName: 'Tool display name',
      parameters: 'For raw-SQL tools: { sql: "...WHERE region = $region", params: { region: "any-default" } } — params values are just defaults; on listenTo re-fetch, upstream filter values are merged into params by key automatically, not via $-substitution. For named tools with no sql field: { region: "$region" } — here $paramName IS substituted from upstream filter values.'
    },
    optionMapping: {
      label: 'Field name from tool response for display text, e.g. "BranchName"',
      value: 'Field name from tool response for option value, e.g. "BranchId"',
      params: 'Object mapping param keys to field names, e.g. { "branch": "BranchId" }'
    },
    listenTo: 'Array of upstream filterKey names. When these change, re-fetch options. e.g. ["region"]',
    includeAllOption: 'Boolean (default true). Prepends an "All" option. In dynamic mode (externalTool + optionMapping) "All" carries every optionMapping.params key set to NULL — NOT a string "All". In static mode it carries whatever params you put on that option.',
    _queryFormat: 'IMPORTANT: Other components using this filter MUST use query object format: { sql: "SELECT * FROM table WHERE date >= $startDate", params: { startDate: "default-value" } }. The $paramKey placeholders must match the params keys in filters array. UNFILTERED IS NULL, NOT A SENTINEL: when "All" is selected this filter sends the param as null, so every dependent widget must be null-tolerant — write ($region IS NULL OR region = $region) and default it to null in params. Never ($region = \'All\' OR region = $region): SQL evaluates NULL = \'All\' to NULL, not TRUE, so the widget silently returns ZERO rows instead of everything.'
  }
};

interface DynamicFilterDropdownComponent extends React.FC<DynamicFilterDropdownProps> {
  Metadata: ComponentMetadata;
}

const DEFAULT_FILTERS: FilterOption[] = [
  { label: 'All Time', value: 'all', params: {}, isDefault: true }
];

/** Resolve $paramName placeholders in tool parameters using current filter state */
function resolveParameters(
  toolParams: Record<string, any>,
  filterState: Record<string, any>
): { resolved: Record<string, any>; allResolved: boolean } {
  const resolved: Record<string, any> = {};
  let allResolved = true;
  for (const [key, value] of Object.entries(toolParams)) {
    if (typeof value === 'string' && value.startsWith('$')) {
      const paramKey = value.slice(1);
      if (paramKey in filterState && filterState[paramKey] != null) {
        resolved[key] = filterState[paramKey];
      } else {
        allResolved = false;
      }
    } else {
      resolved[key] = value;
    }
  }
  return { resolved, allResolved };
}

/**
 * Resolve externalTool.parameters for a fetch, given the current upstream
 * filter state. Two shapes, handled differently:
 * - Nested SQL-style (`{ sql, params }`): `params` gets the upstream
 *   filter's own values merged in directly BY KEY — the same mechanism
 *   every data-carrying component (chart/table/KPI) already uses to
 *   receive filter values, since real SQL parameter binding happens
 *   server-side. A raw SQL string can't be rewritten by `$` substitution
 *   safely, so this shape never goes through resolveParameters.
 * - Flat, named-tool style (`{ region: "$region" }`, no `sql` field): the
 *   original `$paramName` placeholder substitution still applies.
 */
function resolveToolParameters(
  toolParams: Record<string, any>,
  filterState: Record<string, any>
): Record<string, any> {
  if (toolParams && typeof toolParams.sql === 'string' && toolParams.params && typeof toolParams.params === 'object') {
    return { ...toolParams, params: { ...toolParams.params, ...filterState } };
  }
  return resolveParameters(toolParams, filterState).resolved;
}

/** Map tool response rows to FilterOption[] using optionMapping */
function mapResponseToOptions(
  rows: any[],
  mapping: OptionMapping
): FilterOption[] {
  const seen = new Set<string>();
  return rows
    .filter(row => row[mapping.value] != null)
    .map(row => ({
      label: String(row[mapping.label] || row[mapping.value]),
      value: String(row[mapping.value]),
      params: mapping.params
        ? Object.fromEntries(
            Object.entries(mapping.params).map(([paramKey, fieldName]) => [paramKey, row[fieldName]])
          )
        : { [mapping.value]: row[mapping.value] },
    }))
    // Collapse repeated values — a single-select dropdown must not list the same
    // value twice (e.g. mapping value:"Region" over per-branch rows from get-branches).
    .filter(opt => {
      if (seen.has(opt.value)) return false;
      seen.add(opt.value);
      return true;
    });
}

const DynamicFilterDropdown: React.FC<DynamicFilterDropdownProps> = ({
  title = 'Filter',
  filterKey,
  filters = DEFAULT_FILTERS,
  defaultValue,
  externalTool,
  optionMapping,
  listenTo,
  includeAllOption = true,
  SA_RUNTIME = {}
}) => {
  const isDynamic = !!(externalTool && optionMapping);
  const staticFilters = Array.isArray(filters) && filters.length > 0 ? filters : DEFAULT_FILTERS;

  const [dynamicFilters, setDynamicFilters] = useState<FilterOption[]>([]);
  const [isLoading, setIsLoading] = useState(isDynamic);
  const [upstreamParams, setUpstreamParams] = useState<Record<string, any>>({});
  const fetchIdRef = useRef(0); // to discard stale fetches

  const effectiveFilters = isDynamic && dynamicFilters.length > 0 ? dynamicFilters : staticFilters;

  const getDefaultFilter = useCallback((opts: FilterOption[]): FilterOption => {
    if (defaultValue) {
      const found = opts.find(f => f?.value === defaultValue);
      if (found) return found;
    }
    const def = opts.find(f => f?.isDefault);
    if (def) return def;
    return opts[0] || DEFAULT_FILTERS[0];
  }, [defaultValue]);

  const [selectedFilter, setSelectedFilter] = useState<FilterOption>(getDefaultFilter(effectiveFilters));
  const [isOpen, setIsOpen] = useState(false);
  const [searchText, setSearchText] = useState('');
  const buttonRef = useRef<HTMLButtonElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  // The open panel is portaled to document.body (see render below) so it
  // can't get trapped behind a sibling GridStack widget's own stacking
  // context — a z-index inside one grid item never wins against another
  // grid item's content, no matter how high, because the comparison never
  // escapes the item's local stacking context. Portaling means we can no
  // longer rely on CSS `position: absolute` relative to the button, so its
  // screen position is tracked explicitly and kept in sync while open.
  const [dropdownPos, setDropdownPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const mountedRef = useRef(true);
  const initialDispatchDone = useRef(false);

  const uiBlockId = SA_RUNTIME?.uiBlockId;
  const eventName = uiBlockId ? `${uiBlockId}_FILTER` : 'GLOBAL_FILTER';

  const showSearch = effectiveFilters.length > 5;
  const searchedOptions = showSearch && searchText
    ? effectiveFilters.filter(f => f?.label?.toLowerCase().includes(searchText.toLowerCase()))
    : effectiveFilters;
  // Surface the current selection at the top of the list — with long option
  // lists (20+ items) it's otherwise buried wherever it happened to sort,
  // making it hard to spot on reopen.
  const selectedIndex = selectedFilter
    ? searchedOptions.findIndex(f => f?.value === selectedFilter.value)
    : -1;
  const filteredOptions = selectedIndex > 0
    ? [searchedOptions[selectedIndex], ...searchedOptions.slice(0, selectedIndex), ...searchedOptions.slice(selectedIndex + 1)]
    : searchedOptions;

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const updateDropdownPos = useCallback(() => {
    if (!buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    setDropdownPos({ top: rect.bottom + 4, left: rect.left, width: rect.width });
  }, []);

  useEffect(() => {
    if (isOpen && showSearch) {
      setTimeout(() => searchInputRef.current?.focus(), 0);
    }
  }, [selectedFilter, isOpen, effectiveFilters.length]);

  // Keep the portaled panel glued to the button while open — scrolling the
  // dashboard grid (or the window) or resizing must move/close the gap it'd
  // otherwise leave, since the panel is no longer a CSS-positioned child of
  // the button. `true` (capture) on the scroll listener so it also catches
  // scroll events on the grid's own inner scroll container, not just window.
  useEffect(() => {
    if (!isOpen) return;
    updateDropdownPos();
    window.addEventListener('scroll', updateDropdownPos, true);
    window.addEventListener('resize', updateDropdownPos);
    return () => {
      window.removeEventListener('scroll', updateDropdownPos, true);
      window.removeEventListener('resize', updateDropdownPos);
    };
  }, [isOpen, updateDropdownPos]);

  // Store filter state globally
  const storeFilterStateGlobally = useCallback((filter: FilterOption) => {
    if (!filterKey) return;
    if (!(window as any).__FILTER_STATE__) (window as any).__FILTER_STATE__ = {};
    if (!(window as any).__FILTER_STATE__[eventName]) (window as any).__FILTER_STATE__[eventName] = { labels: {}, params: {} };
    (window as any).__FILTER_STATE__[eventName].labels[`${filterKey}Label`] = filter?.label || '';
    const mergedParams = {
      ...(window as any).__FILTER_STATE__[eventName].params,
      ...(filter?.params || {})
    };
    // "All" carries empty params; clear this filter's own dimension so it doesn't
    // linger stale for downstream/cascading filters that read it on mount.
    // Must be null, not '' — SQL sentinel checks are `$param IS NULL OR ...`,
    // and an empty string satisfies neither that nor any real value comparison,
    // silently filtering out every row whenever this filterKey collides with
    // the actual bound param name (e.g. a "quarter" filter bound to $quarter).
    if (filter?.value === 'all') mergedParams[filterKey] = null;
    (window as any).__FILTER_STATE__[eventName].params = mergedParams;
  }, [filterKey, eventName]);

  // Dispatch filter event
  const dispatchFilter = useCallback((filter: FilterOption, isInitial = false) => {
    if (!filter) return;
    console.log(`[FilterDropdown] Dispatching ${eventName}:`, filter?.params);
    storeFilterStateGlobally(filter);
    window.dispatchEvent(new CustomEvent(eventName, {
      detail: {
        filterKey,
        filterValue: filter?.value || '',
        filterLabel: filter?.label || '',
        params: filter?.params || {},
        uiBlockId,
        timestamp: Date.now(),
        isInitial
      }
    }));
  }, [filterKey, eventName, uiBlockId, storeFilterStateGlobally]);

  // Handle user selection
  const handleFilterChange = (filter: FilterOption) => {
    if (!filter) return;
    setSelectedFilter(filter);
    setIsOpen(false);
    setSearchText('');
    dispatchFilter(filter);
  };

  // Dynamic fetch
  const fetchOptions = useCallback(async (params: Record<string, any>) => {
    console.log(`[FilterDropdown:${filterKey}] fetchOptions called, isDynamic:`, isDynamic, 'externalTool:', !!externalTool, 'optionMapping:', !!optionMapping);
    if (!externalTool || !optionMapping) return;

    const toolExecutor = (window as any).SA?.ToolExecutor;
    console.log(`[FilterDropdown:${filterKey}] ToolExecutor available:`, !!toolExecutor);
    if (!toolExecutor) return;

    const fetchId = ++fetchIdRef.current;
    setIsLoading(true);

    try {
      let result;
      if (externalTool.parameters?.queryId) {
        // Cached server-side (create-filter.ts wraps a filter's own SQL in a
        // queryId, same as every data-carrying component) — no raw sql to
        // resolve placeholders in here, just resolve the cached query by id.
        result = await toolExecutor.executeByQueryId({
          toolId: externalTool.toolId,
          queryId: externalTool.parameters.queryId,
          params: externalTool.parameters.params,
          filterParams: params,
          SA_RUNTIME
        });
      } else {
        const resolved = resolveToolParameters(externalTool.parameters, params);
        console.log(`[FilterDropdown:${filterKey}] Resolved params:`, resolved);
        result = await toolExecutor.executeTool({
          externalTool: { ...externalTool, parameters: resolved },
          formData: {},
          SA_RUNTIME
        });
      }

      console.log(`[FilterDropdown:${filterKey}] Tool result:`, result?.data ? `${Array.isArray(result.data) ? result.data.length : 'object'} items` : 'no data');

      if (!mountedRef.current || fetchId !== fetchIdRef.current) return;

      let rows: any[] = [];
      if (result?.data) {
        if (Array.isArray(result.data)) rows = result.data;
        else if (result.data.data && Array.isArray(result.data.data)) rows = result.data.data;
        else if (result.data.records && Array.isArray(result.data.records)) rows = result.data.records;
      }
      console.log(`[FilterDropdown:${filterKey}] Mapped ${rows.length} rows`);

      let options = mapResponseToOptions(rows, optionMapping);
      if (includeAllOption) {
        // Explicitly null out every param key this filter's own optionMapping
        // produces (not just its filterKey) — a downstream listener's merge
        // (`{...prev, ...params}`) only clears what's actually present in the
        // dispatched params. An empty {} here means a downstream widget's own
        // param (e.g. locationId, produced by optionMapping.params) never gets
        // cleared and stays stuck at whatever value was last selected.
        const allParams = Object.fromEntries(
          Object.keys(optionMapping?.params || {}).map((key) => [key, null])
        );
        options = [{ label: 'All', value: 'all', params: allParams, isDefault: !defaultValue }, ...options];
      }

      setDynamicFilters(options);

      // Reset selection: keep current if still valid, otherwise default
      const currentStillValid = options.some(o => o.value === selectedFilter?.value);
      const newDefault = getDefaultFilter(options);
      if (!currentStillValid && newDefault) {
        setSelectedFilter(newDefault);
        dispatchFilter(newDefault);
      } else if (options.length > 0 && !initialDispatchDone.current) {
        // Initial load — dispatch the default
        const def = getDefaultFilter(options);
        setSelectedFilter(def);
        dispatchFilter(def, true);
        initialDispatchDone.current = true;
      }
    } catch (err) {
      console.error('[FilterDropdown] Failed to fetch options:', err);
    } finally {
      if (mountedRef.current && fetchId === fetchIdRef.current) setIsLoading(false);
    }
  }, [externalTool, optionMapping, includeAllOption, defaultValue, SA_RUNTIME, selectedFilter, getDefaultFilter, dispatchFilter]);

  // Initial fetch for dynamic mode
  useEffect(() => {
    console.log(`[FilterDropdown:${filterKey}] Mount, isDynamic:`, isDynamic, 'externalTool:', !!externalTool, 'optionMapping:', !!optionMapping);
    if (isDynamic) {
      const currentState = (window as any).__FILTER_STATE__?.[eventName]?.params || {};
      console.log(`[FilterDropdown:${filterKey}] Initial fetch with state:`, currentState);
      setUpstreamParams(currentState);
      fetchOptions(currentState);
    }
  }, [isDynamic]);

  // Listen for upstream filter changes
  useEffect(() => {
    if (!listenTo || listenTo.length === 0) return;

    const handler = (event: CustomEvent) => {
      const { filterKey: sourceKey, filterValue, params } = event.detail || {};
      // Ignore own events
      if (sourceKey === filterKey) return;
      // Only react to filters we're listening to
      if (!listenTo.includes(sourceKey)) return;

      setUpstreamParams(prev => {
        const next = { ...prev, ...params };
        // The "All" option carries empty params ({}), so the merge above leaves
        // the previous selection stale in `next`. Explicitly clear the upstream
        // dimension so this filter re-fetches the unfiltered set
        // (e.g. region=All → all branches, not just the last region's).
        // Must be null, not '' — SQL sentinel checks are `$param IS NULL OR ...`,
        // and an empty string satisfies neither that nor any real value comparison.
        if (filterValue === 'all') next[sourceKey] = null;
        fetchOptions(next);
        return next;
      });
    };

    window.addEventListener(eventName, handler as EventListener);
    return () => window.removeEventListener(eventName, handler as EventListener);
  }, [listenTo, filterKey, eventName, fetchOptions]);

  // Static mode: dispatch initial filter on mount
  useEffect(() => {
    if (isDynamic) return; // Dynamic mode handles its own initial dispatch
    const initialFilter = getDefaultFilter(staticFilters);
    if (initialFilter?.params && Object.keys(initialFilter.params).length > 0) {
      dispatchFilter(initialFilter, true);
    }
  }, []);

  // Close dropdown on outside click
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      // The panel itself is portaled to document.body (see render below), so
      // it's no longer a DOM descendant of .filter-dropdown-container — it
      // needs its own exemption or every click inside it (search box, an
      // option) would register as "outside" and close it immediately.
      if (!target.closest('.filter-dropdown-container') && !target.closest('.filter-dropdown-portal')) {
        setIsOpen(false);
        setSearchText('');
      }
    };
    if (isOpen) document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, [isOpen]);

  if (!isDynamic && (!staticFilters || staticFilters.length === 0)) return null;

  return (
    <div className="filter-dropdown-container relative w-full">
      <button
        ref={buttonRef}
        onClick={() => setIsOpen(!isOpen)}
        className="btn btn-sm btn-outline gap-2 w-full justify-between"
        disabled={isLoading}
        style={{
          borderColor: COLORS.borderGray,
          color: COLORS.text.primary,
          fontWeight: TYPOGRAPHY.fontWeight.medium,
          fontSize: TYPOGRAPHY.fontSize.body,
        }}
      >
        <span className="flex items-center gap-2 min-w-0 flex-1">
          {title && (
            <span className="flex-shrink-0" style={{ color: COLORS.text.secondary, fontSize: TYPOGRAPHY.fontSize.small }}>
              {title}:
            </span>
          )}
          <span className="truncate max-w-[120px]">
            {isLoading ? 'Loading...' : (selectedFilter?.label || 'Select')}
          </span>
        </span>
        {isLoading ? (
          <Icon icon="mdi:loading" className="w-4 h-4 flex-shrink-0 animate-spin" style={{ color: COLORS.text.secondary }} />
        ) : (
          <Icon icon={isOpen ? 'mdi:chevron-up' : 'mdi:chevron-down'} className="w-4 h-4 flex-shrink-0" style={{ color: COLORS.text.secondary }} />
        )}
      </button>

      {isOpen && dropdownPos && createPortal(
        <div
          className="filter-dropdown-portal bg-base-100 rounded-lg border border-base-300 overflow-hidden"
          style={{
            position: 'fixed',
            top: dropdownPos.top,
            left: dropdownPos.left,
            boxShadow: SHADOWS.dropdown,
            borderRadius: BORDER_RADIUS.medium,
            width: dropdownPos.width > 0 ? `${dropdownPos.width}px` : undefined,
            zIndex: 9999,
            maxHeight: 280,
            display: 'flex',
            flexDirection: 'column' as const,
          }}
        >
          {showSearch && (
            <div style={{ padding: '6px 6px 2px' }}>
              <input
                ref={searchInputRef}
                type="text"
                placeholder="Search..."
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                className="input input-sm input-bordered w-full"
                style={{ fontSize: TYPOGRAPHY.fontSize.small }}
              />
            </div>
          )}
          <ul className="menu menu-sm p-1 w-full" style={{ overflowY: 'auto', flex: 1, display: 'flex', flexDirection: 'column', flexWrap: 'nowrap' }}>
            {filteredOptions.length === 0 && (
              <li className="w-full">
                <span style={{ fontSize: TYPOGRAPHY.fontSize.small, color: COLORS.text.secondary, padding: `${SPACING.sm} ${SPACING.md}` }}>
                  {isDynamic ? 'No options available' : 'No results found'}
                </span>
              </li>
            )}
            {filteredOptions.map((filter, index) => (
              <li key={filter?.value || index} className="w-full">
                <button
                  onClick={() => handleFilterChange(filter)}
                  className={`flex items-center justify-between w-full ${selectedFilter?.value === filter?.value ? 'active' : ''}`}
                  style={{ fontSize: TYPOGRAPHY.fontSize.body, padding: `${SPACING.sm} ${SPACING.md}` }}
                >
                  <span className="truncate flex-1 text-left">{filter?.label || 'Unknown'}</span>
                  {selectedFilter?.value === filter?.value && (
                    <Icon icon="mdi:check" className="w-4 h-4 flex-shrink-0 ml-2" style={{ color: COLORS.primary }} />
                  )}
                </button>
              </li>
            ))}
          </ul>
        </div>,
        document.body
      )}
    </div>
  );
};

(DynamicFilterDropdown as DynamicFilterDropdownComponent).Metadata = METADATA;

export default DynamicFilterDropdown;

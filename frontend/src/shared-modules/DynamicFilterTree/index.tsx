import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '@iconify/react';
import type { ComponentMetadata } from '../../types';
import { COLORS, SHADOWS, BORDER_RADIUS, TYPOGRAPHY, SPACING } from '../../design-system/tokens';

interface TreeFilterOption {
  label: string;
  value: string;
  params: Record<string, any>;
}

interface TreeFilterGroup {
  label: string;
  value: string;
  children: TreeFilterOption[];
}

interface ExternalToolConfig {
  toolId: string;
  toolName: string;
  parameters: Record<string, any>;
}

interface TreeOptionMapping {
  label: string;
  value: string;
  groupBy: string;
  groupLabel?: string;
  params?: Record<string, string>;
}

interface DynamicFilterTreeProps {
  title?: string;
  filterKey?: string;
  groups?: TreeFilterGroup[];
  defaultValues?: string[];
  paramKey?: string;
  externalTool?: ExternalToolConfig;
  optionMapping?: TreeOptionMapping;
  listenTo?: string[];
  SA_RUNTIME?: {
    uiBlockId?: string;
    [key: string]: any;
  };
}

const METADATA: ComponentMetadata = {
  id: 'dynamic-filter-tree',
  name: 'DynamicFilterTree',
  displayName: 'Hierarchical tree filter for dashboards',
  isDisplayComp: false,
  type: 'FilterTree',
  description: 'Tree filter with parent-child grouping and multi-select checkboxes that broadcasts filter changes. Supports static groups OR dynamic groups fetched from an externalTool. For cascading filters, use listenTo to re-fetch options when upstream filters change. Use for hierarchical dimensions like ProductType to MajorCode.',
  category: 'Filter',
  keywords: ['filter', 'tree', 'hierarchy', 'multi-select', 'checkbox', 'group', 'parent-child', 'dashboard', 'control', 'category', 'cascading', 'dynamic'],
  props: {
    title: 'Label for the filter tree, e.g. Product Category, Hierarchy to Minor Code',
    paramKey: 'Key name for the filter param array, e.g. "majorCodes" produces { majorCodes: ["01","02"] }',
    defaultValues: 'Array of initially selected leaf values. Empty or omitted means All.',
    groups: [
      {
        label: 'Display name for the parent group (static mode)',
        value: 'Unique identifier for the group',
        children: [
          {
            label: 'Display name for the child option',
            value: 'Unique identifier sent in filter params',
            params: { paramKey: 'Value for this option' }
          }
        ]
      }
    ],
    externalTool: {
      toolId: 'Tool ID to fetch options from',
      toolName: 'Tool display name',
      parameters: 'For raw-SQL tools: { sql: "...WHERE region = $region", params: { region: "any-default" } } — params values are just defaults; on listenTo re-fetch, upstream filter values are merged into params by key automatically, not via $-substitution. For named tools with no sql field: { region: "$region" } — here $paramName IS substituted from upstream filter values.'
    },
    optionMapping: {
      label: 'Field name for child display text, e.g. "MajorCodeDescription"',
      value: 'Field name for child value, e.g. "MajorCodeDisplay"',
      groupBy: 'Field name to group rows by, e.g. "ProductType"',
      groupLabel: 'Field name for group display label (defaults to groupBy value)',
      params: 'Object mapping param keys to field names'
    },
    listenTo: 'Array of upstream filterKey names. When these change, re-fetch options. e.g. ["branch"]'
  }
};

interface DynamicFilterTreeComponent extends React.FC<DynamicFilterTreeProps> {
  Metadata: ComponentMetadata;
}

const DEFAULT_GROUPS: TreeFilterGroup[] = [];

/** Resolve $paramName placeholders */
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

/** Map flat tool response rows to grouped TreeFilterGroup[] */
function mapResponseToGroups(rows: any[], mapping: TreeOptionMapping): TreeFilterGroup[] {
  const groupMap = new Map<string, TreeFilterGroup>();
  for (const row of rows) {
    const groupKey = String(row[mapping.groupBy] || 'Other');
    const groupLabel = mapping.groupLabel ? String(row[mapping.groupLabel] || groupKey) : groupKey;
    if (!groupMap.has(groupKey)) {
      groupMap.set(groupKey, { label: groupLabel, value: groupKey, children: [] });
    }
    const childValue = String(row[mapping.value]);
    // Avoid duplicates within a group
    if (!groupMap.get(groupKey)!.children.some(c => c.value === childValue)) {
      groupMap.get(groupKey)!.children.push({
        label: String(row[mapping.label] || childValue),
        value: childValue,
        params: mapping.params
          ? Object.fromEntries(Object.entries(mapping.params).map(([pk, fn]) => [pk, row[fn]]))
          : {},
      });
    }
  }
  return Array.from(groupMap.values());
}

const DynamicFilterTree: React.FC<DynamicFilterTreeProps> = ({
  title = 'Filter',
  filterKey,
  groups = DEFAULT_GROUPS,
  defaultValues,
  paramKey = 'values',
  externalTool,
  optionMapping,
  listenTo,
  SA_RUNTIME = {}
}) => {
  const isDynamic = !!(externalTool && optionMapping);
  const staticGroups = Array.isArray(groups) && groups.length > 0 ? groups : DEFAULT_GROUPS;

  const [dynamicGroups, setDynamicGroups] = useState<TreeFilterGroup[]>([]);
  const [isLoading, setIsLoading] = useState(isDynamic);
  const [upstreamParams, setUpstreamParams] = useState<Record<string, any>>({});
  const fetchIdRef = useRef(0);
  const mountedRef = useRef(true);
  const initialDispatchDone = useRef(false);

  const effectiveGroups = isDynamic && dynamicGroups.length > 0 ? dynamicGroups : staticGroups;
  const allLeafValues = effectiveGroups.flatMap(g => (g.children || []).map(c => c.value));
  const totalLeafCount = allLeafValues.length;

  const [selectedValues, setSelectedValues] = useState<Set<string>>(() => {
    if (defaultValues && defaultValues.length > 0) {
      return new Set(defaultValues.filter(v => allLeafValues.includes(v)));
    }
    return new Set(allLeafValues);
  });

  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(
    new Set(effectiveGroups.map(g => g.value))
  );
  const [isOpen, setIsOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [dropdownPos, setDropdownPos] = useState<{ top: number; left: number; width: number } | null>(null);

  const uiBlockId = SA_RUNTIME?.uiBlockId;
  const eventName = uiBlockId ? `${uiBlockId}_FILTER` : 'GLOBAL_FILTER';

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
    if (!isOpen) return;
    updateDropdownPos();
    window.addEventListener('scroll', updateDropdownPos, true);
    window.addEventListener('resize', updateDropdownPos);
    return () => {
      window.removeEventListener('scroll', updateDropdownPos, true);
      window.removeEventListener('resize', updateDropdownPos);
    };
  }, [isOpen, updateDropdownPos, selectedValues, effectiveGroups.length]);

  // Update expanded groups and selection when groups change
  useEffect(() => {
    setExpandedGroups(new Set(effectiveGroups.map(g => g.value)));
    const newLeaves = effectiveGroups.flatMap(g => (g.children || []).map(c => c.value));
    setSelectedValues(new Set(newLeaves)); // Select all on refresh
  }, [dynamicGroups]);

  const isAllSelected = selectedValues.size === totalLeafCount || selectedValues.size === 0;
  const isGroupSelected = (group: TreeFilterGroup) => group.children.every(c => selectedValues.has(c.value));
  const isGroupIndeterminate = (group: TreeFilterGroup) =>
    group.children.some(c => selectedValues.has(c.value)) && !isGroupSelected(group);

  const storeFilterStateGlobally = useCallback((label: string, params: Record<string, any>) => {
    if (!filterKey) return;
    if (!(window as any).__FILTER_STATE__) (window as any).__FILTER_STATE__ = {};
    if (!(window as any).__FILTER_STATE__[eventName]) (window as any).__FILTER_STATE__[eventName] = { labels: {}, params: {} };
    (window as any).__FILTER_STATE__[eventName].labels[`${filterKey}Label`] = label;
    const mergedParams = {
      ...(window as any).__FILTER_STATE__[eventName].params,
      ...params
    };
    // Empty params means "All" (all/none selected); clear this tree's own
    // dimension so it doesn't linger stale for downstream filters that read it on mount.
    // Must be null, not '' — SQL sentinel checks are `$param IS NULL OR ...`,
    // and an empty string satisfies neither that nor any real value comparison.
    if (Object.keys(params).length === 0) mergedParams[paramKey] = null;
    (window as any).__FILTER_STATE__[eventName].params = mergedParams;
  }, [filterKey, eventName, paramKey]);

  const dispatchFilterEvent = useCallback((newSelected: Set<string>, isInitial = false) => {
    const leafs = effectiveGroups.flatMap(g => (g.children || []).map(c => c.value));
    const isAll = newSelected.size === leafs.length || newSelected.size === 0;
    const params = isAll ? {} : { [paramKey]: Array.from(newSelected) };
    const label = isAll ? 'All' : `${newSelected.size} of ${leafs.length} selected`;

    console.log(`[FilterTree] Dispatching ${eventName}:`, params);
    storeFilterStateGlobally(label, params);

    window.dispatchEvent(new CustomEvent(eventName, {
      detail: {
        filterKey,
        filterValue: isAll ? 'all' : Array.from(newSelected).join(','),
        filterLabel: label,
        params,
        uiBlockId,
        timestamp: Date.now(),
        isInitial
      }
    }));
  }, [filterKey, eventName, uiBlockId, paramKey, effectiveGroups, storeFilterStateGlobally]);

  const toggleLeaf = (value: string) => {
    setSelectedValues(prev => {
      const next = new Set(prev);
      next.has(value) ? next.delete(value) : next.add(value);
      dispatchFilterEvent(next);
      return next;
    });
  };

  const toggleGroup = (group: TreeFilterGroup) => {
    setSelectedValues(prev => {
      const next = new Set(prev);
      const allSelected = group.children.every(c => next.has(c.value));
      group.children.forEach(c => allSelected ? next.delete(c.value) : next.add(c.value));
      dispatchFilterEvent(next);
      return next;
    });
  };

  const toggleAll = () => {
    setSelectedValues(prev => {
      const next = prev.size === totalLeafCount ? new Set<string>() : new Set(allLeafValues);
      dispatchFilterEvent(next);
      return next;
    });
  };

  const toggleExpanded = (groupValue: string) => {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      next.has(groupValue) ? next.delete(groupValue) : next.add(groupValue);
      return next;
    });
  };

  // Dynamic fetch
  const fetchOptions = useCallback(async (params: Record<string, any>) => {
    if (!externalTool || !optionMapping) return;
    const toolExecutor = (window as any).SA?.ToolExecutor;
    if (!toolExecutor) return;

    const resolved = resolveToolParameters(externalTool.parameters, params);

    const fetchId = ++fetchIdRef.current;
    setIsLoading(true);

    try {
      const result = await toolExecutor.executeTool({
        externalTool: { ...externalTool, parameters: resolved },
        formData: {},
        SA_RUNTIME
      });

      if (!mountedRef.current || fetchId !== fetchIdRef.current) return;

      let rows: any[] = [];
      if (result?.data) {
        if (Array.isArray(result.data)) rows = result.data;
        else if (result.data.data && Array.isArray(result.data.data)) rows = result.data.data;
        else if (result.data.records && Array.isArray(result.data.records)) rows = result.data.records;
      }

      const newGroups = mapResponseToGroups(rows, optionMapping);
      setDynamicGroups(newGroups);

      // Select all and dispatch
      const newLeaves = newGroups.flatMap(g => g.children.map(c => c.value));
      const newSelected = new Set(newLeaves);
      setSelectedValues(newSelected);
      dispatchFilterEvent(newSelected, !initialDispatchDone.current);
      initialDispatchDone.current = true;
    } catch (err) {
      console.error('[FilterTree] Failed to fetch options:', err);
    } finally {
      if (mountedRef.current && fetchId === fetchIdRef.current) setIsLoading(false);
    }
  }, [externalTool, optionMapping, SA_RUNTIME, dispatchFilterEvent]);

  // Initial fetch
  useEffect(() => {
    if (isDynamic) {
      const currentState = (window as any).__FILTER_STATE__?.[eventName]?.params || {};
      setUpstreamParams(currentState);
      fetchOptions(currentState);
    }
  }, [isDynamic]);

  // Listen for upstream filter changes
  useEffect(() => {
    if (!listenTo || listenTo.length === 0) return;

    const handler = (event: CustomEvent) => {
      const { filterKey: sourceKey, filterValue, params } = event.detail || {};
      if (sourceKey === filterKey) return;
      if (!listenTo.includes(sourceKey)) return;

      setUpstreamParams(prev => {
        const next = { ...prev, ...params };
        // Upstream "All" sends empty params, so the merge leaves the previous
        // selection stale in `next`. Clear the upstream dimension so we re-fetch
        // the unfiltered option set instead of retaining the prior value.
        // Must be null, not '' — downstream SQL sentinel checks are
        // `$param IS NULL OR ...`, and an empty string satisfies neither that
        // nor any real value comparison.
        if (filterValue === 'all') next[sourceKey] = null;
        fetchOptions(next);
        return next;
      });
    };

    window.addEventListener(eventName, handler as EventListener);
    return () => window.removeEventListener(eventName, handler as EventListener);
  }, [listenTo, filterKey, eventName, fetchOptions]);

  // Static mode: dispatch initial on mount
  useEffect(() => {
    if (isDynamic) return;
    if (totalLeafCount > 0) dispatchFilterEvent(selectedValues, true);
  }, []);

  // Close on outside click
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (!target.closest('.filter-tree-container') && !target.closest('.filter-tree-portal')) setIsOpen(false);
    };
    if (isOpen) document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, [isOpen]);

  const getButtonLabel = () => {
    if (isLoading) return 'Loading...';
    if (isAllSelected) return 'All';
    if (selectedValues.size === 0) return 'All';
    return `${selectedValues.size} of ${totalLeafCount} selected`;
  };

  const CheckboxIcon: React.FC<{ checked: boolean; indeterminate?: boolean }> = ({ checked, indeterminate }) => {
    if (indeterminate) return <Icon icon="mdi:minus-box" className="w-4 h-4 flex-shrink-0" style={{ color: COLORS.primary }} />;
    if (checked) return <Icon icon="mdi:checkbox-marked" className="w-4 h-4 flex-shrink-0" style={{ color: COLORS.primary }} />;
    return <Icon icon="mdi:checkbox-blank-outline" className="w-4 h-4 flex-shrink-0" style={{ color: COLORS.text.tertiary }} />;
  };

  if (!isDynamic && effectiveGroups.length === 0) return null;

  return (
    <div className="filter-tree-container relative w-full">
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
          <span className="truncate">{getButtonLabel()}</span>
        </span>
        {isLoading ? (
          <Icon icon="mdi:loading" className="w-4 h-4 flex-shrink-0 animate-spin" style={{ color: COLORS.text.secondary }} />
        ) : (
          <Icon icon={isOpen ? 'mdi:chevron-up' : 'mdi:chevron-down'} className="w-4 h-4 flex-shrink-0" style={{ color: COLORS.text.secondary }} />
        )}
      </button>

      {isOpen && dropdownPos && createPortal(
        <div
          className="filter-tree-portal bg-base-100 rounded-lg border border-base-300 overflow-hidden"
          style={{
            position: 'fixed',
            top: dropdownPos.top,
            left: dropdownPos.left,
            boxShadow: SHADOWS.dropdown,
            borderRadius: BORDER_RADIUS.medium,
            width: dropdownPos.width > 0 ? `${dropdownPos.width}px` : '100%',
            minWidth: '200px',
            zIndex: 9999,
          }}
        >
          <div style={{ maxHeight: '300px', overflowY: 'auto' }}>
            {effectiveGroups.length === 0 ? (
              <div style={{ padding: `${SPACING.sm} ${SPACING.md}`, fontSize: TYPOGRAPHY.fontSize.small, color: COLORS.text.secondary }}>
                No options available
              </div>
            ) : (
              <>
                {/* Select All */}
                <button
                  onClick={toggleAll}
                  className="flex items-center gap-2 w-full text-left hover:bg-base-200"
                  style={{ padding: `${SPACING.sm} ${SPACING.md}`, fontSize: TYPOGRAPHY.fontSize.body }}
                >
                  <CheckboxIcon checked={isAllSelected} indeterminate={!isAllSelected && selectedValues.size > 0} />
                  <span style={{ fontWeight: TYPOGRAPHY.fontWeight.medium }}>Select all</span>
                </button>

                <hr style={{ borderColor: COLORS.borderGray, margin: 0 }} />

                {effectiveGroups.map(group => (
                  <div key={group.value}>
                    <div className="flex items-center gap-1 hover:bg-base-200" style={{ padding: `${SPACING.xs} ${SPACING.md}` }}>
                      <button
                        onClick={() => toggleExpanded(group.value)}
                        className="flex items-center p-0 bg-transparent border-none cursor-pointer"
                        style={{ color: COLORS.text.secondary }}
                      >
                        <Icon icon={expandedGroups.has(group.value) ? 'mdi:chevron-down' : 'mdi:chevron-right'} className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => toggleGroup(group)}
                        className="flex items-center gap-2 flex-1 bg-transparent border-none cursor-pointer text-left p-0"
                      >
                        <CheckboxIcon checked={isGroupSelected(group)} indeterminate={isGroupIndeterminate(group)} />
                        <span style={{ fontWeight: TYPOGRAPHY.fontWeight.medium, fontSize: TYPOGRAPHY.fontSize.body, color: COLORS.text.primary }}>
                          {group.label}
                        </span>
                      </button>
                    </div>

                    {expandedGroups.has(group.value) && group.children.map(child => (
                      <button
                        key={child.value}
                        onClick={() => toggleLeaf(child.value)}
                        className="flex items-center gap-2 w-full text-left hover:bg-base-200"
                        style={{
                          padding: `${SPACING.xs} ${SPACING.md}`,
                          paddingLeft: SPACING.xl,
                          fontSize: TYPOGRAPHY.fontSize.body,
                          color: COLORS.text.primary,
                          background: 'transparent',
                          border: 'none',
                          cursor: 'pointer',
                        }}
                      >
                        <CheckboxIcon checked={selectedValues.has(child.value)} />
                        <span className="truncate">{child.label}</span>
                      </button>
                    ))}
                  </div>
                ))}
              </>
            )}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
};

(DynamicFilterTree as DynamicFilterTreeComponent).Metadata = METADATA;

export default DynamicFilterTree;

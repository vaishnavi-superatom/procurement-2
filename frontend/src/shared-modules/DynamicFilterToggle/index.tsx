import React, { useState, useCallback, useEffect } from 'react';
import type { ComponentMetadata } from '../../types';
import { COLORS, BORDER_RADIUS, TYPOGRAPHY, SPACING } from '../../design-system/tokens';

interface ToggleOption {
  label: string;
  value: string;
  params: Record<string, any>;
}

interface DynamicFilterToggleProps {
  title?: string;
  filterKey?: string;
  // Exactly two states to switch between — e.g. Above 5% / Below 5%. No "All"
  // state: one of the two is always active, so unlike DynamicFilterDropdown
  // there's no null-clearing convention here on its own — see __FILTER_KEY_MAP__
  // handling below for why switching still needs to clear the OTHER option's keys.
  options: [ToggleOption, ToggleOption];
  defaultValue?: string; // value of the initially active option; defaults to options[0]
  SA_RUNTIME?: {
    uiBlockId?: string;
    [key: string]: any;
  };
}

const METADATA: ComponentMetadata = {
  id: 'dynamic-filter-toggle',
  name: 'DynamicFilterToggle',
  displayName: 'Two-state toggle filter for dashboards',
  isDisplayComp: false,
  type: 'FilterToggle',
  description: 'Two-option segmented toggle that broadcasts filter changes, same as DynamicFilterDropdown but for exactly 2 states instead of a dropdown list — e.g. "Above 5%" vs "Below 5%". Use when a dimension is naturally binary, not a list of options. For threshold-style splits, prefer broadcasting min/max params (e.g. {minProfit: 5, maxProfit: null} for "above" and {minProfit: null, maxProfit: 5} for "below") so the SQL stays a single null-tolerant WHERE clause: ($minProfit IS NULL OR x > $minProfit) AND ($maxProfit IS NULL OR x <= $maxProfit).',
  category: 'Filter',
  keywords: ['filter', 'toggle', 'switch', 'binary', 'two-state', 'dashboard', 'control', 'threshold'],
  props: {
    title: 'Label for the toggle, e.g. "Profit Margin"',
    filterKey: 'Key name for this filter, used for stale-param cleanup when switching (e.g. "profitFilter")',
    options: [
      {
        label: 'Display text for this state, e.g. "Above 5%"',
        value: 'Unique identifier for this state, e.g. "above"',
        params: { paramKey: 'Value(s) that replace $paramKey placeholders in other component queries for this state' },
      },
    ],
    defaultValue: '(optional) value of the initially active option — defaults to the first entry in options',
  },
};

interface DynamicFilterToggleComponent extends React.FC<DynamicFilterToggleProps> {
  Metadata: ComponentMetadata;
}

const DynamicFilterToggle: React.FC<DynamicFilterToggleProps> = ({
  title,
  filterKey,
  options,
  defaultValue,
  SA_RUNTIME = {},
}) => {
  const uiBlockId = SA_RUNTIME?.uiBlockId;
  const eventName = uiBlockId ? `${uiBlockId}_FILTER` : 'GLOBAL_FILTER';

  const getInitialOption = useCallback((): ToggleOption => {
    if (defaultValue) {
      const found = options.find((o) => o?.value === defaultValue);
      if (found) return found;
    }
    return options[0];
  }, [options, defaultValue]);

  const [activeOption, setActiveOption] = useState<ToggleOption>(getInitialOption);
  const initialDispatchDone = React.useRef(false);

  // Options can carry their own "xLabel" params (e.g. profitMarginLabel:
  // "Profit"/"Loss") for widgets that want wording other than the toggle's
  // own button text ("All"/"Below 5%") interpolated into their title/description.
  const getCustomLabels = (params?: Record<string, any>): Record<string, string> => {
    const result: Record<string, string> = {};
    if (!params) return result;
    for (const [key, value] of Object.entries(params)) {
      if (key.endsWith('Label') && typeof value === 'string') result[key] = value;
    }
    return result;
  };

  const storeFilterStateGlobally = useCallback((option: ToggleOption) => {
    if (!filterKey) return;
    if (!(window as any).__FILTER_STATE__) (window as any).__FILTER_STATE__ = {};
    if (!(window as any).__FILTER_STATE__[eventName]) {
      (window as any).__FILTER_STATE__[eventName] = { labels: {}, params: {} };
    }
    (window as any).__FILTER_STATE__[eventName].labels[`${filterKey}Label`] = option?.label || '';
    // Custom "xLabel" params override the default above when the key matches
    // (e.g. a param literally named "profitMarginLabel" for filterKey "profitMargin").
    Object.assign((window as any).__FILTER_STATE__[eventName].labels, getCustomLabels(option?.params));

    const mergedParams = {
      ...(window as any).__FILTER_STATE__[eventName].params,
    };

    // The two options can use entirely different param keys (e.g. minProfit vs
    // maxProfit) — switching must clear whichever keys the PREVIOUSLY active
    // option set that the new one doesn't also set, or a downstream widget's
    // param from the old state lingers stale. Same __FILTER_KEY_MAP__ pattern
    // DynamicFilterDropdown/DynamicFilterTree already use.
    if (!(window as any).__FILTER_KEY_MAP__) (window as any).__FILTER_KEY_MAP__ = {};
    const prevKeys: string[] = (window as any).__FILTER_KEY_MAP__[filterKey] || [];
    const nextKeys = Object.keys(option?.params || {});
    for (const key of prevKeys) {
      if (!nextKeys.includes(key)) delete mergedParams[key];
    }
    (window as any).__FILTER_KEY_MAP__[filterKey] = nextKeys;

    Object.assign(mergedParams, option?.params || {});
    (window as any).__FILTER_STATE__[eventName].params = mergedParams;
  }, [filterKey, eventName]);

  const dispatchOption = useCallback((option: ToggleOption, isInitial = false) => {
    if (!option) return;
    storeFilterStateGlobally(option);
    console.log(`[FilterToggle] Dispatching ${eventName}:`, option?.params);
    window.dispatchEvent(new CustomEvent(eventName, {
      detail: {
        filterKey,
        filterValue: option?.value || '',
        filterLabel: option?.label || '',
        labels: {
          [`${filterKey}Label`]: option?.label || '',
          ...getCustomLabels(option?.params),
        },
        params: option?.params || {},
        uiBlockId,
        timestamp: Date.now(),
        isInitial,
      },
    }));
  }, [filterKey, eventName, uiBlockId, storeFilterStateGlobally]);

  // Dispatch initial state on mount, same as DynamicFilterDropdown's static mode.
  useEffect(() => {
    if (initialDispatchDone.current) return;
    initialDispatchDone.current = true;
    dispatchOption(activeOption, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!options || options.length !== 2) return null;
  const [left, right] = options;
  const ACCENT = '#009193';
  const isRight = activeOption.value === right.value;

  const handleToggle = () => {
    const next = isRight ? left : right;
    setActiveOption(next);
    dispatchOption(next);
  };

  return (
    <div
      className="flex items-center w-full h-full"
      style={{
        border: `1px solid ${COLORS.borderGray}`,
        borderRadius: BORDER_RADIUS.medium,
        fontSize: TYPOGRAPHY.fontSize.small,
        padding: `0 ${SPACING.md}`,
      }}
    >
      {/* Section 1: title */}
      {title && (
        <span
          className="flex-shrink-0"
          style={{ color: COLORS.text.secondary, fontSize: TYPOGRAPHY.fontSize.small, fontWeight: TYPOGRAPHY.fontWeight.medium }}
        >
          {title}
        </span>
      )}

      {/* Vertical divider between the title and the toggle control */}
      {title && (
        <div
          className="flex-shrink-0"
          style={{ width: 1, alignSelf: 'stretch', backgroundColor: COLORS.borderGray, margin: `0 ${SPACING.md}` }}
        />
      )}

      {/* Section 2: the toggle itself */}
      <div className="flex items-center gap-1.5 flex-1 justify-center">
        <span
          onClick={() => isRight && handleToggle()}
          style={{
            cursor: isRight ? 'pointer' : 'default',
            color: isRight ? COLORS.text.tertiary : ACCENT,
            fontWeight: isRight ? TYPOGRAPHY.fontWeight.medium : TYPOGRAPHY.fontWeight.semibold,
            fontSize: TYPOGRAPHY.fontSize.small,
          }}
        >
          {left.label}
        </span>
        {/* The actual switch: a pill track with a knob that slides between the
            two sides. One click target (the whole track), not two separate
            buttons — that's what makes it read as a toggle, not a segmented
            picker. */}
        <button
          type="button"
          role="switch"
          aria-checked={isRight}
          aria-label={title || 'Toggle'}
          onClick={handleToggle}
          style={{
            position: 'relative',
            display: 'inline-block',
            width: 28,
            height: 16,
            borderRadius: 999,
            border: 'none',
            cursor: 'pointer',
            backgroundColor: isRight ? ACCENT : COLORS.borderGray,
            padding: 0,
            margin: 0,
            lineHeight: 0,
            verticalAlign: 'middle',
            flexShrink: 0,
            transition: 'background-color 0.2s ease',
          }}
        >
          <span
            style={{
              position: 'absolute',
              top: 2,
              left: isRight ? 14 : 2,
              width: 12,
              height: 12,
              borderRadius: '50%',
              backgroundColor: isRight ? COLORS.white : ACCENT,
              boxShadow: '0 1px 2px rgba(0,0,0,0.35)',
              transition: 'left 0.2s ease, background-color 0.2s ease',
            }}
          />
        </button>
        <span
          onClick={() => !isRight && handleToggle()}
          style={{
            cursor: !isRight ? 'pointer' : 'default',
            color: isRight ? ACCENT : COLORS.text.tertiary,
            fontWeight: isRight ? TYPOGRAPHY.fontWeight.semibold : TYPOGRAPHY.fontWeight.medium,
            fontSize: TYPOGRAPHY.fontSize.small,
          }}
        >
          {right.label}
        </span>
      </div>
    </div>
  );
};

(DynamicFilterToggle as DynamicFilterToggleComponent).Metadata = METADATA;

export default DynamicFilterToggle;

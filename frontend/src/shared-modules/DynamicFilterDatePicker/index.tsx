import React, { useState, useCallback, useEffect, useRef } from 'react';
import type { ComponentMetadata } from '../../types';
import { COLORS, BORDER_RADIUS, TYPOGRAPHY, SPACING } from '../../design-system/tokens';

interface DynamicFilterDatePickerProps {
  title?: string;
  filterKey?: string;
  mode?: 'single' | 'range';
  // single mode
  paramKey?: string;
  defaultValue?: string;
  // range mode
  startParam?: string;
  endParam?: string;
  defaultStart?: string;
  defaultEnd?: string;
  // shared
  min?: string;
  max?: string;
  SA_RUNTIME?: {
    uiBlockId?: string;
    [key: string]: any;
  };
}

const METADATA: ComponentMetadata = {
  id: 'dynamic-filter-date-picker',
  name: 'DynamicFilterDatePicker',
  displayName: 'Date/date-range filter for dashboards',
  isDisplayComp: false,
  type: 'FilterDatePicker',
  description: 'Date/date-range filter with the native date input shown inline next to the title (click it to get the browser\'s native date picker) — same broadcast conventions as the other Dynamic* filters. Two modes: "single" broadcasts one date param, "range" broadcasts a from/to pair. Use for exact-date or custom-range filtering (e.g. "as of date", "from X to Y") — for preset periods like "Last 30 days" prefer DynamicFilterDropdown with static options instead. Unset dates dispatch null (not empty string), so dependent widget SQL must be null-tolerant: ($startDate IS NULL OR date >= $startDate) AND ($endDate IS NULL OR date <= $endDate).',
  category: 'Filter',
  keywords: ['filter', 'date', 'daterange', 'calendar', 'picker', 'range', 'dashboard', 'control', 'period', 'from', 'to'],
  props: {
    title: 'Label for the filter, e.g. "Start Date"',
    filterKey: 'Key name for this filter, used for the stored label (e.g. "orderDate")',
    mode: '"single" for one date param, "range" for a from/to pair. Defaults to "range".',
    paramKey: '(single mode) Param key that replaces $paramKey placeholders in other component queries. Defaults to filterKey or "date".',
    defaultValue: '(single mode, optional) Initially selected date, ISO format "YYYY-MM-DD". Leave unset to start with no date selected (null).',
    startParam: '(range mode) Param key for the from-date. Defaults to "startDate".',
    endParam: '(range mode) Param key for the to-date. Defaults to "endDate".',
    defaultStart: '(range mode, optional) Initially selected from-date, ISO format "YYYY-MM-DD".',
    defaultEnd: '(range mode, optional) Initially selected to-date, ISO format "YYYY-MM-DD".',
    min: '(optional) Earliest selectable date, ISO format "YYYY-MM-DD".',
    max: '(optional) Latest selectable date, ISO format "YYYY-MM-DD".',
  },
};

interface DynamicFilterDatePickerComponent extends React.FC<DynamicFilterDatePickerProps> {
  Metadata: ComponentMetadata;
}

const inputStyle: React.CSSProperties = {
  border: `1px solid ${COLORS.borderGray}`,
  borderRadius: BORDER_RADIUS.small,
  fontSize: TYPOGRAPHY.fontSize.small,
  color: COLORS.text.primary,
  padding: `2px ${SPACING.xs}`,
  height: 26,
  minWidth: 0,
  flex: 1,
};

const DynamicFilterDatePicker: React.FC<DynamicFilterDatePickerProps> = ({
  title,
  filterKey,
  mode = 'range',
  paramKey,
  defaultValue,
  startParam = 'startDate',
  endParam = 'endDate',
  defaultStart,
  defaultEnd,
  min,
  max,
  SA_RUNTIME = {},
}) => {
  const uiBlockId = SA_RUNTIME?.uiBlockId;
  const eventName = uiBlockId ? `${uiBlockId}_FILTER` : 'GLOBAL_FILTER';
  const effectiveParamKey = paramKey || filterKey || 'date';

  const [singleDate, setSingleDate] = useState(defaultValue || '');
  const [startDate, setStartDate] = useState(defaultStart || '');
  const [endDate, setEndDate] = useState(defaultEnd || '');
  const initialDispatchDone = useRef(false);

  // Dispatch takes the about-to-be-committed value(s) directly rather than
  // reading from state — setState hasn't flushed yet when a change handler
  // calls this synchronously, so reading state here would dispatch the
  // PREVIOUS value one pick behind.
  const dispatchDates = useCallback((values: { single?: string; start?: string; end?: string }, isInitial = false) => {
    const params = mode === 'single'
      ? { [effectiveParamKey]: values.single || null }
      : { [startParam]: values.start || null, [endParam]: values.end || null };
    const label = mode === 'single'
      ? (values.single || 'Any date')
      : (!values.start && !values.end ? 'Any date' : `${values.start || '…'} to ${values.end || '…'}`);

    if (!(window as any).__FILTER_STATE__) (window as any).__FILTER_STATE__ = {};
    if (!(window as any).__FILTER_STATE__[eventName]) {
      (window as any).__FILTER_STATE__[eventName] = { labels: {}, params: {} };
    }
    if (filterKey) {
      (window as any).__FILTER_STATE__[eventName].labels[`${filterKey}Label`] = label;
    }
    (window as any).__FILTER_STATE__[eventName].params = {
      ...(window as any).__FILTER_STATE__[eventName].params,
      ...params,
    };

    console.log(`[FilterDatePicker] Dispatching ${eventName}:`, params);
    window.dispatchEvent(new CustomEvent(eventName, {
      detail: {
        filterKey,
        filterValue: label,
        filterLabel: label,
        params,
        uiBlockId,
        timestamp: Date.now(),
        isInitial,
      },
    }));
  }, [mode, effectiveParamKey, startParam, endParam, eventName, filterKey, uiBlockId]);

  // Dispatch initial state on mount, same as the other filter widgets.
  useEffect(() => {
    if (initialDispatchDone.current) return;
    initialDispatchDone.current = true;
    dispatchDates({ single: singleDate, start: startDate, end: endDate }, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSingleChange = (value: string) => {
    setSingleDate(value);
    dispatchDates({ single: value });
  };

  const handleStartChange = (value: string) => {
    setStartDate(value);
    dispatchDates({ start: value, end: endDate });
  };

  const handleEndChange = (value: string) => {
    setEndDate(value);
    dispatchDates({ start: startDate, end: value });
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
      {title && (
        <span
          className="shrink-0"
          style={{ color: COLORS.text.secondary, fontSize: TYPOGRAPHY.fontSize.small, fontWeight: TYPOGRAPHY.fontWeight.medium }}
        >
          {title}
        </span>
      )}

      {title && (
        <div
          className="shrink-0"
          style={{ width: 1, alignSelf: 'stretch', backgroundColor: COLORS.borderGray, margin: `0 ${SPACING.md}` }}
        />
      )}

      {mode === 'single' ? (
        <input
          type="date"
          value={singleDate}
          min={min}
          max={max}
          onChange={(e) => handleSingleChange(e.target.value)}
          style={inputStyle}
        />
      ) : (
        <div className="flex items-center gap-1.5 flex-1 min-w-0">
          <input
            type="date"
            value={startDate}
            min={min}
            max={max}
            onChange={(e) => handleStartChange(e.target.value)}
            style={inputStyle}
          />
          <span style={{ color: COLORS.text.tertiary, flexShrink: 0 }}>&ndash;</span>
          <input
            type="date"
            value={endDate}
            min={min}
            max={max}
            onChange={(e) => handleEndChange(e.target.value)}
            style={inputStyle}
          />
        </div>
      )}
    </div>
  );
};

(DynamicFilterDatePicker as DynamicFilterDatePickerComponent).Metadata = METADATA;

export default DynamicFilterDatePicker;

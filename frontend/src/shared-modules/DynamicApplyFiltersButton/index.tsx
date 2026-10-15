import React, { useEffect, useState, useCallback } from 'react';
import { Icon } from '@iconify/react';
import type { ComponentMetadata } from '../../types';
import { COLORS, BORDER_RADIUS, TYPOGRAPHY } from '../../design-system/tokens';

interface DynamicApplyFiltersButtonProps {
  title?: string;
  SA_RUNTIME?: {
    uiBlockId?: string;
    [key: string]: any;
  };
}

const METADATA: ComponentMetadata = {
  id: 'dynamic-apply-filters-button',
  name: 'DynamicApplyFiltersButton',
  displayName: 'Apply filters button for dashboards',
  isDisplayComp: false,
  type: 'ApplyFiltersButton',
  description: 'Button placed next to filter widgets. While this widget is present on a dashboard page, filter changes only update filter dropdowns and title/description labels — data-carrying widgets (charts, tables, KPI cards) do NOT re-fetch until this button is clicked. Has two states: shows "Apply Filters" (highlighted) once any filter has changed since the last click, and reverts to "Refresh" (neutral) once clicked, since the displayed data now matches the selected filters again. Use on dashboards with 2+ cascading (listenTo) filters so widgets never flash through intermediate, still-resolving filter combinations. Place directly next to the filter widgets.',
  category: 'Filter',
  keywords: ['filter', 'apply', 'refresh', 'button', 'cascading', 'dashboard', 'control'],
  props: {
    title: '(optional) Override for the button label. Leave unset to get the automatic "Apply Filters" / "Refresh" dual-state label.',
  },
};

interface DynamicApplyFiltersButtonComponent extends React.FC<DynamicApplyFiltersButtonProps> {
  Metadata: ComponentMetadata;
}

const DynamicApplyFiltersButton: React.FC<DynamicApplyFiltersButtonProps> = ({
  title,
  SA_RUNTIME = {},
}) => {
  const uiBlockId = SA_RUNTIME?.uiBlockId;
  const eventName = uiBlockId ? `${uiBlockId}_FILTER` : 'GLOBAL_FILTER';
  const applyEventName = uiBlockId ? `${uiBlockId}_FILTER_APPLY` : 'GLOBAL_FILTER_APPLY';

  // Dirty = a filter has changed since the last Apply click, so the data
  // currently on screen no longer necessarily matches the selected filters.
  // Starts false: this widget is intentionally NOT in isFilterWidget() (see
  // useDashboardFilterGate.ts), so it only ever mounts once filtersReady has
  // gone true — i.e. once the real dependency-tracking gate has confirmed
  // the ENTIRE initial filter cascade has genuinely settled, not a guess.
  // That's why the display is already correct for the current selection the
  // moment this mounts.
  const [isDirty, setIsDirty] = useState(false);

  // While mounted, tell every data widget on this channel to hold off fetching
  // on individual filter events and wait for an explicit Apply click instead —
  // otherwise a cascading filter chain still fires one fetch per settling level
  // (each one visible on screen before the next, correct one lands).
  useEffect(() => {
    if (!(window as any).__FILTER_STATE__) (window as any).__FILTER_STATE__ = {};
    if (!(window as any).__FILTER_STATE__[eventName]) {
      (window as any).__FILTER_STATE__[eventName] = { labels: {}, params: {} };
    }
    (window as any).__FILTER_STATE__[eventName].requiresApply = true;
    console.log(`[ApplyFiltersButton] Mounted (post-filtersReady). eventName="${eventName}" applyEventName="${applyEventName}" — requiresApply set true`);

    return () => {
      console.log(`[ApplyFiltersButton] Unmounting eventName="${eventName}" — clearing requiresApply`);
      // Leaving this page/dashboard — don't leave data widgets permanently
      // waiting for an Apply click that will never come.
      if ((window as any).__FILTER_STATE__?.[eventName]) {
        (window as any).__FILTER_STATE__[eventName].requiresApply = false;
      }
    };
  }, [eventName]);

  // Watch for real filter changes to flip into the "Apply Filters" state.
  //
  // Because this widget only mounts after filtersReady (see the comment on
  // isDirty above), any _FILTER event received from here on is, by
  // construction, a genuine post-load change — not part of the initial
  // settle — so no quiet-window/timer guess is needed at all. (A previous
  // version tried to detect "settled" with a fixed quiet timer while mounted
  // immediately alongside the filters; that raced against slow cascading
  // queries and intermittently misfired on load. Gating on filtersReady
  // instead removes the race entirely.)
  //
  // isInitial is still checked, defensively, in case a filter widget ever
  // re-mounts and redispatches its own first-ever event after this point —
  // that should never happen in the current architecture, but costs nothing
  // to guard against.
  useEffect(() => {
    const handleFilterChange = (event: CustomEvent) => {
      const { params, filterKey, isInitial } = event.detail || {};
      console.log(`[ApplyFiltersButton] Received "${eventName}" event — filterKey=${filterKey} isInitial=${isInitial} params=`, params);

      if (isInitial) return;
      if (!params || typeof params !== 'object') return;

      console.log(`[ApplyFiltersButton] Real post-load change — marking dirty (isDirty=true)`);
      setIsDirty(true);
    };

    window.addEventListener(eventName, handleFilterChange as EventListener);
    return () => window.removeEventListener(eventName, handleFilterChange as EventListener);
  }, [eventName]);

  useEffect(() => {
    console.log(`[ApplyFiltersButton] isDirty changed → ${isDirty} (label will show "${isDirty ? 'Apply Filters' : 'Refresh'}")`);
  }, [isDirty]);

  const handleApply = useCallback(() => {
    console.log(`[ApplyFiltersButton] Click — isDirty was ${isDirty}`);
    const currentParams = (window as any).__FILTER_STATE__?.[eventName]?.params || {};
    console.log(`[ApplyFiltersButton] Dispatching ${applyEventName}:`, currentParams);

    // Snapshot what's being applied — lets a widget that mounts later (e.g.
    // added mid-session) catch up to the last APPLIED state instead of any
    // live-but-unapplied filter change, if it's wired to read this.
    if ((window as any).__FILTER_STATE__?.[eventName]) {
      (window as any).__FILTER_STATE__[eventName].appliedParams = currentParams;
    }

    window.dispatchEvent(
      new CustomEvent(applyEventName, {
        detail: {
          params: currentParams,
          isInitial: false,
        },
      })
    );
    setIsDirty(false);
  }, [eventName, applyEventName, isDirty]);

  const label = title ?? (isDirty ? 'Apply Filters' : 'Refresh');
  const ACCENT = '#009193';

  return (
    <button
      onClick={handleApply}
      className="btn btn-sm gap-2"
      style={{
        borderRadius: BORDER_RADIUS.medium,
        fontWeight: TYPOGRAPHY.fontWeight.medium,
        fontSize: TYPOGRAPHY.fontSize.body,
        backgroundColor: isDirty ? ACCENT : 'transparent',
        color: isDirty ? COLORS.white : ACCENT,
        border: `1px solid ${ACCENT}`,
      }}
    >
      <Icon icon={isDirty ? 'mdi:filter-check-outline' : 'tabler:refresh'} className="w-4 h-4" />
      {label}
    </button>
  );
};

(DynamicApplyFiltersButton as DynamicApplyFiltersButtonComponent).Metadata = METADATA;

export default DynamicApplyFiltersButton;

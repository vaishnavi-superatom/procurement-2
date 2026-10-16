import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@iconify/react';
import type { ComponentMetadata } from '../../types';
import { COLORS, TYPOGRAPHY, SPACING, SHADOWS } from '../../design-system/tokens';
import LoadingState from '../../components/LoadingState';
import PRComments from './PRComments';

interface PurchaseRequestsProps {
  SA_RUNTIME?: any;
  /** Swaps the list toolbar's Filter-by-Time + Group-by controls for a single
   * All PRs / RFQ's Received / RFQ's Not Received filter, alongside search.
   * Defaults to on (both the standalone Purchase Requisitions page and the
   * Home "Total PRs Raised" instance use this toolbar); pass `false` to get
   * the original Filter-by-Time + Group-by toolbar instead. */
  simplifiedToolbar?: boolean;
  /** Shows the RFQ status badge as its own table column. Off by default (the
   * standalone Purchase Requisitions page relies on the RFQ filter instead,
   * per its own column spec) — only the Home "Total PRs Raised" instance
   * turns this on, to keep that view exactly as it already is. */
  showRfqColumn?: boolean;
  /** Fired when "Evaluate RFQ" / "Evaluate RFQ's" is clicked in a PR's detail
   * view, with the linked RFQ id when there's exactly one. Left undefined on
   * the standalone Purchase Requests page, where the button stays a no-op
   * (there's no RFQ experience alongside it to hand off to) — only Home wires
   * this up to open RfqReceived focused on the PR's RFQ(s). */
  onEvaluateRfq?: (args: { prId: string; rfqId?: string }) => void;
  /** Applied invisibly (no extra toolbar control) whenever `simplifiedToolbar`
   * is on, so the Home "Total PRs Raised" card's embedded table always shows
   * exactly the rows counted for that card's selected period. Ignored when
   * `simplifiedToolbar` is off, where the visible Filter-by-Time control owns
   * this instead. */
  activePeriod?: 'Today' | 'This Week' | 'This Month' | 'This Year';
}

// Teal accent shared with the Home dashboard, so this screen reads as part of the
// same product rather than a one-off.
const TEAL = {
  base: '#0F6B64',
  dark: '#0B4F4A',
  tint: '#E6F5F3',
  border: '#D7E8E6',
};

// ============================================================
// Real data shapes (public.purchase_requisitions / material_master /
// inventory / rfq_events / purchase_orders / vendor_master — the live
// "PostgreSQL Connection" source registered for this project).
// ============================================================

interface PRListRow {
  pr_id: string;
  pr_date: string;
  required_date: string;
  requester_dept: string;
  plant_code: string;
  urgency: 'High' | 'Normal';
  source_type: 'Contract' | 'RFQ' | 'Repeat';
  line_count: number;
  material_count: number;
  total_value: number;
  material_group: string | null;
  first_material_id: string;
  first_material_desc: string | null;
  has_rfq: boolean;
}

interface PRLine {
  pr_id: string;
  pr_line_item: number;
  material_id: string;
  requested_qty: number;
  unit_of_measure: string;
  estimated_price: number;
  total_value: number;
  pr_date: string;
  required_date: string;
  requester_id: string;
  requester_dept: string;
  plant_code: string;
  pr_status: string;
  urgency: 'High' | 'Normal';
  source_type: 'Contract' | 'RFQ' | 'Repeat';
  material_desc: string | null;
  material_group: string | null;
  unspsc_title: string | null;
  standard_price: number | null;
  lead_time_days: number | null;
  safety_stock: number | null;
}

interface InventoryRow {
  material_id: string;
  plant_code: string;
  current_stock: number;
  reserved_stock: number;
  last_receipt_date: string | null;
  last_issue_date: string | null;
  reorder_point: number;
}

interface RfqRow {
  rfq_id: string;
  pr_id: string;
  material_id: string;
  rfq_date: string;
  response_deadline: string;
  vendors_invited: number;
  quotes_received: number;
  awarded_vendor_id: string | null;
  awarded_price: number | null;
  rfq_status: 'RFQ Received' | 'In Negotiation' | 'Awarded';
  negotiation_rounds: number;
}

// A vendor we've bought this material (or a similar one) from before —
// "past selections", per the sourcing review.
interface CandidateVendor {
  vendor_id: string;
  vendor_name: string;
  vendor_type: string;
  city: string;
  state: string;
  payment_terms: string;
  orders: number;
  last_order_date: string;
  last_price: number | null;
  basis: 'material' | 'similar';
}

type TimeFilter = 'All Time' | 'Today' | 'This Week' | 'This Month' | 'This Year';
const TIME_FILTER_OPTIONS: TimeFilter[] = ['All Time', 'Today', 'This Week', 'This Month', 'This Year'];

type GroupBy = 'None' | 'Department' | 'Material' | 'Urgency';
const GROUP_BY_OPTIONS: GroupBy[] = ['None', 'Department', 'Material', 'Urgency'];

// Whether a PR has a linked rfq_events row — real relationship, not inferred
// from source_type or any other field. See has_rfq in PR_LIST_QUERY.
type RfqFilter = 'All PRs' | "RFQ's Received" | "RFQ's Not Received";
const RFQ_FILTER_OPTIONS: RfqFilter[] = ['All PRs', "RFQ's Received", "RFQ's Not Received"];
const RFQ_FILTER_DESCRIPTIONS: Record<RfqFilter, string> = {
  'All PRs': 'Every purchase request.',
  "RFQ's Received": 'PRs linked to an RFQ.',
  "RFQ's Not Received": 'PRs without an RFQ yet.',
};

// ============================================================
// Query helpers
//
// This project's live business data (purchase_requisitions, inventory,
// rfq_events, purchase_orders, vendor_master, ...) is registered as a per-project source,
// not a static DATABASE_URL — so it's queried through window.SA.ToolExecutor
// against that source's generated "<sourceId>_query" tool (see
// backend/src/sources/core/base-source.ts getToolId/getToolName), the same
// mechanism workflows/shelf-life-monitoring uses, rather than
// window.SA.QueryExecutor (which only works when DATABASE_URL/MSSQL_* env
// vars are set — they aren't for this project).
// ============================================================

const TOOL_ID = 'postgres-0fc80d2496ff_query';
const TOOL_NAME = 'Query PostgreSQL Connection';

const PR_LIST_QUERY = `
WITH rfq_prs AS (
  SELECT DISTINCT pr_id FROM rfq_events
)
SELECT
  pr.pr_id,
  MIN(pr.pr_date) AS pr_date,
  MIN(pr.required_date) AS required_date,
  MAX(pr.requester_dept) AS requester_dept,
  MAX(pr.plant_code) AS plant_code,
  MAX(pr.urgency) AS urgency,
  MAX(pr.source_type) AS source_type,
  COUNT(*) AS line_count,
  COUNT(DISTINCT pr.material_id) AS material_count,
  SUM(pr.total_value) AS total_value,
  MIN(m.material_group) AS material_group,
  MIN(pr.material_id) AS first_material_id,
  MIN(m.material_desc) AS first_material_desc,
  BOOL_OR(rp.pr_id IS NOT NULL) AS has_rfq
FROM purchase_requisitions pr
LEFT JOIN material_master m ON m.material_id = pr.material_id
LEFT JOIN rfq_prs rp ON rp.pr_id = pr.pr_id
GROUP BY pr.pr_id
ORDER BY MIN(pr.pr_date) DESC
LIMIT 5000;
`;

// Basic well-formedness check before opening a detail view — not a SQL-safety
// measure (queries below use real bound parameters), just a friendly guard
// against an unexpected id shape.
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

// The source's query tool caps results at 500 rows unless the caller passes
// an explicit limit (see getTool().fn in base-source.ts) — pass one whenever
// a query can plausibly return more than that.
async function runTool<T = any>(
  sql: string,
  params: Record<string, any> | undefined,
  SA_RUNTIME: any,
  limit?: number
): Promise<T[]> {
  const toolExecutor = (window as any).SA?.ToolExecutor;
  if (!toolExecutor) {
    throw new Error('ToolExecutor not available');
  }
  const res = await toolExecutor.executeTool({
    externalTool: {
      toolId: TOOL_ID,
      toolName: TOOL_NAME,
      parameters: {
        sql,
        ...(params ? { params } : {}),
        ...(limit ? { limit } : {}),
      },
    },
    formData: {},
    SA_RUNTIME,
  });
  const payload = res?.data ?? res;
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.records)
        ? payload.records
        : [];
  return rows as T[];
}

// ============================================================
// Formatting helpers
// ============================================================

const formatINR = (n: number | null | undefined): string => {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return '₹' + Math.round(n).toLocaleString('en-IN');
};

const formatDate = (d: string | null | undefined): string => {
  if (!d) return '—';
  const date = new Date(d);
  if (isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
};

const inTimeFilter = (dateStr: string, filter: TimeFilter): boolean => {
  if (filter === 'All Time') return true;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return false;
  const now = new Date();
  if (filter === 'Today') return d.toDateString() === now.toDateString();
  if (filter === 'This Week') {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    start.setDate(now.getDate() - now.getDay());
    const end = new Date(start);
    end.setDate(start.getDate() + 7);
    return d >= start && d < end;
  }
  if (filter === 'This Month') return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
  if (filter === 'This Year') return d.getFullYear() === now.getFullYear();
  return true;
};

const groupKeyFor = (row: PRListRow, groupBy: GroupBy): string => {
  if (groupBy === 'Department') return row.requester_dept || 'Unassigned';
  if (groupBy === 'Material') return row.material_group || 'Unclassified';
  if (groupBy === 'Urgency') return row.urgency || 'Normal';
  return 'All Purchase Requests';
};

// ============================================================
// Small shared bits
// ============================================================

// An RFQ stays "RFQ Received" until the buyer starts negotiating.
const RFQ_STATUS_STYLE: Record<string, { bg: string; fg: string }> = {
  'RFQ Received': { bg: '#E0F2FE', fg: '#0284C7' },
  'In Negotiation': { bg: '#FFEDD5', fg: '#EA580C' },
  Awarded: { bg: '#DCFCE7', fg: '#16A34A' },
};

const UrgencyBadge: React.FC<{ urgency: string }> = ({ urgency }) => {
  const high = urgency === 'High';
  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold"
      style={{
        backgroundColor: high ? '#F1F5F9' : COLORS.lightGray,
        color: high ? '#475569' : COLORS.text.secondary,
      }}
    >
      {high && <Icon icon="mdi:alert-circle" className="w-3 h-3" />}
      {urgency}
    </span>
  );
};

const RfqBadge: React.FC<{ hasRfq: boolean }> = ({ hasRfq }) => (
  <span
    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold"
    style={{
      backgroundColor: hasRfq ? TEAL.tint : COLORS.lightGray,
      color: hasRfq ? TEAL.base : COLORS.text.secondary,
    }}
  >
    <Icon icon={hasRfq ? 'mdi:check-circle' : 'mdi:minus-circle-outline'} className="w-3 h-3" />
    {hasRfq ? 'Received' : 'Not Received'}
  </span>
);

interface DropdownProps {
  label: string;
  icon: string;
  value: string;
  options: string[];
  onChange: (v: string) => void;
}

const ToolbarDropdown: React.FC<DropdownProps> = ({ label, icon, value, options, onChange }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium"
        style={{ border: `1px solid ${COLORS.borderGray}`, color: COLORS.text.primary, backgroundColor: COLORS.white }}
      >
        <Icon icon={icon} className="w-4 h-4" style={{ color: COLORS.text.secondary }} />
        <span style={{ color: COLORS.text.secondary }}>{label}:</span>
        <span className="font-semibold">{value}</span>
        <Icon icon="mdi:chevron-down" className="w-3.5 h-3.5" style={{ color: COLORS.text.secondary }} />
      </button>
      {open && (
        <div
          className="absolute left-0 mt-1 w-44 rounded-lg overflow-hidden z-20"
          style={{ backgroundColor: COLORS.white, boxShadow: SHADOWS.dropdown, border: `1px solid ${COLORS.borderGray}` }}
        >
          {options.map((opt) => (
            <button
              key={opt}
              onClick={() => {
                onChange(opt);
                setOpen(false);
              }}
              className="w-full text-left px-3 py-2 text-xs"
              style={{
                color: opt === value ? TEAL.base : COLORS.text.primary,
                fontWeight: opt === value ? TYPOGRAPHY.fontWeight.semibold : TYPOGRAPHY.fontWeight.regular,
                backgroundColor: opt === value ? TEAL.tint : 'transparent',
              }}
            >
              {opt}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

// RFQ filter dropdown — each option shows a one-line description (what the
// pasted-content spec for this control asked for), so it gets its own
// richer menu rather than overloading the generic ToolbarDropdown above.
const RfqFilterDropdown: React.FC<{ value: RfqFilter; onChange: (v: RfqFilter) => void }> = ({ value, onChange }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium"
        style={{ border: `1px solid ${COLORS.borderGray}`, color: COLORS.text.primary, backgroundColor: COLORS.white }}
      >
        <Icon icon="mdi:file-send-outline" className="w-4 h-4" style={{ color: COLORS.text.secondary }} />
        <span style={{ color: COLORS.text.secondary }}>Filter:</span>
        <span className="font-semibold">{value}</span>
        <Icon icon="mdi:chevron-down" className="w-3.5 h-3.5" style={{ color: COLORS.text.secondary }} />
      </button>
      {open && (
        <div
          className="absolute left-0 mt-1 w-64 rounded-lg overflow-hidden z-20"
          style={{ backgroundColor: COLORS.white, boxShadow: SHADOWS.dropdown, border: `1px solid ${COLORS.borderGray}` }}
        >
          {RFQ_FILTER_OPTIONS.map((opt) => (
            <button
              key={opt}
              onClick={() => {
                onChange(opt);
                setOpen(false);
              }}
              className="w-full text-left px-3 py-2"
              style={{ backgroundColor: opt === value ? TEAL.tint : 'transparent' }}
            >
              <p
                className="text-xs"
                style={{
                  color: opt === value ? TEAL.base : COLORS.text.primary,
                  fontWeight: opt === value ? TYPOGRAPHY.fontWeight.semibold : TYPOGRAPHY.fontWeight.regular,
                }}
              >
                {opt}
              </p>
              <p className="text-[11px] mt-0.5" style={{ color: COLORS.text.secondary }}>
                {RFQ_FILTER_DESCRIPTIONS[opt]}
              </p>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

// ============================================================
// METADATA
// ============================================================

const METADATA: ComponentMetadata = {
  id: 'purchase-requests-dashboard',
  name: 'PurchaseRequests',
  displayName: 'Show purchase requests dashboard',
  isDisplayComp: true,
  type: 'PurchaseRequests',
  description: 'Purchase requisitions list and detail view, sourced from the live purchase_requisitions/inventory/rfq_events/purchase_orders data',
  category: 'Dashboard',
  keywords: ['purchase', 'requests', 'pr', 'requisition', 'rfq', 'procurement'],
  dashboard: { label: 'Purchase Requisitions', icon: 'mdi:cart-outline', order: 1 },
  props: {},
};

interface PurchaseRequestsComponent extends React.FC<PurchaseRequestsProps> {
  Metadata: ComponentMetadata;
}

// ============================================================
// List screen
// ============================================================

const PRListScreen: React.FC<{
  rows: PRListRow[];
  loading: boolean;
  error: string | null;
  onOpen: (prId: string) => void;
  simplifiedToolbar?: boolean;
  showRfqColumn?: boolean;
  activePeriod?: 'Today' | 'This Week' | 'This Month' | 'This Year';
}> = ({ rows, loading, error, onOpen, simplifiedToolbar = true, showRfqColumn = false, activePeriod }) => {
  const [search, setSearch] = useState('');
  const [timeFilter, setTimeFilter] = useState<TimeFilter>('All Time');
  const [groupBy, setGroupBy] = useState<GroupBy>('None');
  const [rfqFilter, setRfqFilter] = useState<RfqFilter>('All PRs');
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  // Rendering every matching row at once (there can be thousands) is what made
  // the table feel slow — only mount a page's worth of rows and grow it with
  // "Load more" instead.
  const PAGE_SIZE = 100;
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  // In simplified-toolbar mode there's no visible Filter-by-Time control —
  // the period comes from Home's own selector instead, applied here with the
  // exact same inTimeFilter the KPI card's own count query matches.
  const effectiveTimeFilter: TimeFilter = simplifiedToolbar ? (activePeriod || 'All Time') : timeFilter;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (!inTimeFilter(r.pr_date, effectiveTimeFilter)) return false;
      if (simplifiedToolbar) {
        const hasRfq = Boolean(r.has_rfq);
        if (rfqFilter === "RFQ's Received" && !hasRfq) return false;
        if (rfqFilter === "RFQ's Not Received" && hasRfq) return false;
      }
      if (!q) return true;
      return (
        r.pr_id.toLowerCase().includes(q) ||
        (r.requester_dept || '').toLowerCase().includes(q) ||
        (r.first_material_desc || '').toLowerCase().includes(q) ||
        (r.material_group || '').toLowerCase().includes(q) ||
        (r.plant_code || '').toLowerCase().includes(q)
      );
    });
  }, [rows, search, effectiveTimeFilter, rfqFilter, simplifiedToolbar]);

  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [search, effectiveTimeFilter, groupBy, rfqFilter]);

  const groups = useMemo(() => {
    const map = new Map<string, PRListRow[]>();
    for (const row of filtered) {
      const key = groupKeyFor(row, groupBy);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(row);
    }
    const urgencyOrder: Record<string, number> = { High: 0, Normal: 1 };
    return Array.from(map.entries()).sort(([a], [b]) => {
      if (groupBy === 'Urgency') return (urgencyOrder[a] ?? 2) - (urgencyOrder[b] ?? 2);
      return a.localeCompare(b);
    });
  }, [filtered, groupBy]);

  // Only materialize rows up to visibleCount, cutting groups short as needed —
  // "Load more" just raises visibleCount and picks up where it left off.
  const { renderedGroups, hasMore } = useMemo(() => {
    let remaining = visibleCount;
    const result: [string, PRListRow[]][] = [];
    for (const [groupName, groupRows] of groups) {
      if (remaining <= 0) break;
      const slice = groupRows.slice(0, remaining);
      if (slice.length > 0) result.push([groupName, slice]);
      remaining -= slice.length;
    }
    return { renderedGroups: result, hasMore: visibleCount < filtered.length };
  }, [groups, visibleCount, filtered.length]);

  // Group headers show the group's true total, not just how many of its rows
  // are currently materialized by "Load more".
  const groupTotals = useMemo(() => new Map(groups.map(([name, groupRows]) => [name, groupRows.length])), [groups]);

  const columnCount = showRfqColumn ? 8 : 7;
  // Compact padding/row-height for the standalone page only — the Home
  // "Total PRs Raised" table (showRfqColumn=true) keeps its original sizing.
  const cellPad = showRfqColumn ? 'px-4 py-3' : 'px-3 py-1.5';
  const pageTitle = showRfqColumn ? 'Purchase Requests' : 'Purchase Requisitions';

  if (loading) {
    return <LoadingState height={520} message="Loading purchase requests…" variant="skeleton" size="lg" />;
  }

  if (error) {
    return (
      <div className="bg-white rounded-xl shadow-sm border border-[#F1F5F9] p-6">
        <div className="flex items-center gap-3">
          <Icon icon="mdi:alert-circle" className="w-5 h-5 text-[#475569] flex-shrink-0" />
          <div>
            <p className="text-sm font-medium text-[#475569]">Couldn't load purchase requests</p>
            <p className="text-xs mt-1" style={{ color: COLORS.text.secondary }}>{error}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={showRfqColumn ? 'w-full flex flex-col' : 'flex flex-col mx-auto'}
      style={{
        height: 'calc(100vh - 160px)',
        minHeight: 480,
        ...(showRfqColumn ? {} : { width: '82%', minWidth: 760 }),
      }}
    >
      {/* Toolbar — fixed, never scrolls */}
      <div className="flex items-center justify-between flex-wrap gap-3 mb-4 flex-shrink-0">
        <div>
          <h1 className="text-xl font-bold" style={{ color: COLORS.text.primary }}>
            {pageTitle}
          </h1>
          <p className="text-xs mt-0.5" style={{ color: COLORS.text.secondary }}>
            {filtered.length.toLocaleString('en-IN')} of {rows.length.toLocaleString('en-IN')} requests
          </p>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <div
            className="flex items-center gap-2 px-3 py-2 rounded-lg"
            style={{ border: `1px solid ${COLORS.borderGray}`, backgroundColor: COLORS.white }}
          >
            <Icon icon="mdi:magnify" className="w-4 h-4" style={{ color: COLORS.text.tertiary }} />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search PR ID, department, material…"
              className="text-xs w-56"
              style={{ color: COLORS.text.primary, border: 'none', outline: 'none', boxShadow: 'none', background: 'transparent' }}
            />
          </div>
          {simplifiedToolbar ? (
            <RfqFilterDropdown value={rfqFilter} onChange={setRfqFilter} />
          ) : (
            <>
              <ToolbarDropdown
                label="Filter by Time"
                icon="mdi:calendar-range-outline"
                value={timeFilter}
                options={TIME_FILTER_OPTIONS}
                onChange={(v) => setTimeFilter(v as TimeFilter)}
              />
              <ToolbarDropdown
                label="Group by"
                icon="mdi:format-list-group"
                value={groupBy}
                options={GROUP_BY_OPTIONS}
                onChange={(v) => setGroupBy(v as GroupBy)}
              />
            </>
          )}
        </div>
      </div>

      {/* Table — the only internally-scrolling region */}
      <div
        className="flex-1 min-h-0 rounded-xl overflow-auto"
        style={{ border: `1px solid ${TEAL.border}`, backgroundColor: COLORS.white, boxShadow: SHADOWS.card }}
      >
        <table className="w-full text-sm border-collapse" style={{ tableLayout: 'fixed' }}>
          {/* Fixed column widths so content never triggers a table-wide
              column-width recalculation (e.g. on row hover). */}
          <colgroup>
            <col style={{ width: showRfqColumn ? '110px' : '112px' }} />
            <col />
            <col style={{ width: showRfqColumn ? '130px' : '108px' }} />
            <col style={{ width: showRfqColumn ? '80px' : '64px' }} />
            <col style={{ width: showRfqColumn ? '90px' : '76px' }} />
            {showRfqColumn && <col style={{ width: '110px' }} />}
            <col style={{ width: showRfqColumn ? '100px' : '136px' }} />
            <col style={{ width: showRfqColumn ? '120px' : '105px' }} />
          </colgroup>
          <thead className="sticky top-0 z-10" style={{ backgroundColor: COLORS.lightBackground }}>
            <tr>
              {(showRfqColumn
                ? ['PR ID', 'Material', 'Department', 'Plant', 'Urgency', 'RFQ', 'Required By', 'Value']
                : ['PR ID', 'Material', 'Department', 'Plant', 'Urgency', 'RFQ Required By', 'Value']
              ).map((h) => (
                <th
                  key={h}
                  className={`text-left ${cellPad} text-[11px] font-semibold uppercase tracking-wide truncate`}
                  style={{ color: COLORS.text.secondary, borderBottom: `1px solid ${TEAL.border}` }}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {renderedGroups.map(([groupName, groupRows]) => (
              <React.Fragment key={groupName}>
                {groupBy !== 'None' && (
                  <tr>
                    <td
                      colSpan={columnCount}
                      className={`${cellPad} text-xs font-semibold`}
                      style={{ backgroundColor: TEAL.tint, color: TEAL.base }}
                    >
                      {groupName} <span style={{ color: COLORS.text.secondary, fontWeight: 400 }}>({groupTotals.get(groupName) ?? groupRows.length})</span>
                    </td>
                  </tr>
                )}
                {groupRows.map((row) => (
                  <tr
                    key={row.pr_id}
                    onMouseEnter={() => setHoveredId(row.pr_id)}
                    onMouseLeave={() => setHoveredId((id) => (id === row.pr_id ? null : id))}
                    onClick={() => onOpen(row.pr_id)}
                    className="cursor-pointer transition-colors duration-150"
                    style={{
                      borderBottom: `1px solid ${COLORS.lightGray}`,
                      backgroundColor: hoveredId === row.pr_id ? TEAL.tint : 'transparent',
                    }}
                  >
                    <td className={`${cellPad} font-semibold truncate`} style={{ color: COLORS.text.primary }}>
                      {row.pr_id}
                    </td>
                    <td className={`${cellPad} truncate`} style={{ color: COLORS.text.primary }}>
                      {row.first_material_desc || row.first_material_id}
                      {row.material_count > 1 && (
                        <span className="ml-1.5 text-[11px]" style={{ color: COLORS.text.tertiary }}>
                          +{row.material_count - 1} more
                        </span>
                      )}
                    </td>
                    <td className={`${cellPad} truncate`} style={{ color: COLORS.text.secondary }}>{row.requester_dept}</td>
                    <td className={`${cellPad} truncate`} style={{ color: COLORS.text.secondary }}>{row.plant_code}</td>
                    <td className={cellPad}><UrgencyBadge urgency={row.urgency} /></td>
                    {showRfqColumn && (
                      <td className={cellPad}><RfqBadge hasRfq={Boolean(row.has_rfq)} /></td>
                    )}
                    <td className={`${cellPad} truncate`} style={{ color: COLORS.text.secondary }}>{formatDate(row.required_date)}</td>
                    <td className={`${cellPad} font-medium truncate`} style={{ color: COLORS.text.primary }}>{formatINR(row.total_value)}</td>
                  </tr>
                ))}
              </React.Fragment>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={columnCount} className={`px-4 ${showRfqColumn ? 'py-12' : 'py-8'} text-center text-sm`} style={{ color: COLORS.text.tertiary }}>
                  {simplifiedToolbar && effectiveTimeFilter !== 'All Time' && rows.length > 0
                    ? `No purchase requests raised in ${effectiveTimeFilter.toLowerCase()}. Try a different period from the banner above.`
                    : 'No purchase requests match these filters.'}
                </td>
              </tr>
            )}
            {hasMore && (
              <tr>
                <td colSpan={columnCount} className={`${cellPad} text-center`}>
                  <button
                    onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
                    className="px-4 py-1.5 rounded-lg text-xs font-semibold transition-colors duration-150"
                    style={{ backgroundColor: TEAL.tint, color: TEAL.base }}
                  >
                    Load more ({(filtered.length - visibleCount).toLocaleString('en-IN')} remaining)
                  </button>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

// ============================================================
// Detail screen
// ============================================================

const PRDetailScreen: React.FC<{
  prId: string;
  onBack: () => void;
  SA_RUNTIME: any;
  onEvaluateRfq?: (args: { prId: string; rfqId?: string }) => void;
}> = ({ prId, onBack, SA_RUNTIME, onEvaluateRfq }) => {
  const [lines, setLines] = useState<PRLine[] | null>(null);
  const [inventory, setInventory] = useState<InventoryRow[]>([]);
  const [rfqs, setRfqs] = useState<RfqRow[]>([]);
  const [candidateVendors, setCandidateVendors] = useState<CandidateVendor[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        if (!SAFE_ID.test(prId)) throw new Error('Invalid PR id');

        const lineRows = await runTool<PRLine>(
          `
          SELECT pr.*, m.material_desc, m.material_group, m.unspsc_title, m.standard_price, m.lead_time_days, m.safety_stock
          FROM purchase_requisitions pr
          LEFT JOIN material_master m ON m.material_id = pr.material_id
          WHERE pr.pr_id = @prId
          ORDER BY pr.pr_line_item;
          `,
          { prId },
          SA_RUNTIME
        );
        if (cancelled) return;
        if (lineRows.length === 0) throw new Error(`No purchase requisition found for ${prId}`);
        setLines(lineRows);

        const materialIds = Array.from(new Set(lineRows.map((l) => l.material_id)));
        const plantCodes = Array.from(new Set(lineRows.map((l) => l.plant_code)));

        const [invRows, rfqRows] = await Promise.all([
          materialIds.length
            ? runTool<InventoryRow>(
                `SELECT * FROM inventory WHERE material_id = ANY(@materialIds) AND plant_code = ANY(@plantCodes);`,
                { materialIds, plantCodes },
                SA_RUNTIME
              )
            : Promise.resolve([]),
          runTool<RfqRow>(
            `
            SELECT rfq.*
            FROM rfq_events rfq
            WHERE rfq.pr_id = @prId
            ORDER BY rfq.rfq_date DESC;
            `,
            { prId },
            SA_RUNTIME
          ),
        ]);
        if (cancelled) return;
        setInventory(invRows);
        setRfqs(rfqRows);

        // No RFQ yet: suggest vendors from past purchase orders for these
        // materials, then for similar ones (same subgroup) so a rarely-bought
        // material still gets candidates. Last price only for the exact material.
        if (rfqRows.length === 0) {
          const vendors = await runTool<CandidateVendor>(
            `
            WITH line AS (
              SELECT material_id, material_subgroup FROM material_master WHERE material_id = ANY(@materialIds)
            ),
            past AS (
              SELECT po.vendor_id, po.po_id, po.po_date,
                     CASE WHEN po.material_id IN (SELECT material_id FROM line) THEN 'material' ELSE 'similar' END AS basis
              FROM purchase_orders po
              JOIN material_master m ON m.material_id = po.material_id
              WHERE m.material_subgroup IN (SELECT material_subgroup FROM line)
            )
            SELECT v.vendor_id, v.vendor_name, v.vendor_type, v.city, v.state, v.payment_terms,
                   COUNT(DISTINCT p.po_id) AS orders, MAX(p.po_date) AS last_order_date, MIN(p.basis) AS basis,
                   (SELECT po2.unit_price FROM purchase_orders po2
                     WHERE po2.vendor_id = v.vendor_id AND po2.material_id = ANY(@materialIds)
                     ORDER BY po2.po_date DESC LIMIT 1) AS last_price
            FROM past p
            JOIN vendor_master v ON v.vendor_id = p.vendor_id
            WHERE v.is_active = true
            GROUP BY v.vendor_id, v.vendor_name, v.vendor_type, v.city, v.state, v.payment_terms
            ORDER BY MIN(p.basis), COUNT(DISTINCT p.po_id) DESC, MAX(p.po_date) DESC
            LIMIT 6;
            `,
            { materialIds },
            SA_RUNTIME
          );
          if (!cancelled) setCandidateVendors(vendors);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load this purchase request');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();
    return () => {
      cancelled = true;
    };
  }, [prId, SA_RUNTIME]);

  if (loading) {
    return <LoadingState height={520} message="Loading purchase request…" variant="skeleton" size="lg" />;
  }

  if (error || !lines) {
    return (
      <div className="w-full">
        <button onClick={onBack} className="flex items-center gap-1.5 text-xs font-medium mb-4" style={{ color: TEAL.base }}>
          <Icon icon="mdi:arrow-left" className="w-4 h-4" /> Back to Purchase Requests
        </button>
        <div className="bg-white rounded-xl shadow-sm border border-[#F1F5F9] p-6">
          <div className="flex items-center gap-3">
            <Icon icon="mdi:alert-circle" className="w-5 h-5 text-[#475569] flex-shrink-0" />
            <p className="text-sm" style={{ color: '#475569' }}>{error}</p>
          </div>
        </div>
      </div>
    );
  }

  const header = lines[0];
  const totalValue = lines.reduce((sum, l) => sum + Number(l.total_value || 0), 0);

  return (
    <div className="w-full flex flex-col" style={{ height: 'calc(100vh - 120px)', minHeight: 480 }}>
      {/* Fixed header */}
      <div className="flex-shrink-0">
        <button onClick={onBack} className="flex items-center gap-1.5 text-xs font-medium mb-3" style={{ color: TEAL.base }}>
          <Icon icon="mdi:arrow-left" className="w-4 h-4" /> Back to Purchase Requests
        </button>
        <div className="flex items-center gap-3 mb-4">
          <h1 className="text-xl font-bold" style={{ color: COLORS.text.primary }}>
            Purchase Request {header.pr_id}
          </h1>
          <UrgencyBadge urgency={header.urgency} />
        </div>

        {/* Key info — one small box, not six */}
        <div
          className="rounded-lg px-4 py-2.5 mb-4 flex flex-wrap items-center gap-x-5 gap-y-1.5"
          style={{ backgroundColor: '#F0FDF4', border: '1px solid #BBF7D0' }}
        >
          {[
            ['Department', header.requester_dept],
            ['Plant', header.plant_code],
            ['Raised', formatDate(header.pr_date)],
            ['Required By', formatDate(header.required_date)],
            ['Line Items', String(lines.length)],
            ['Total Value', formatINR(totalValue)],
          ].map(([label, value]) => (
            <div key={label} className="flex items-baseline gap-1.5">
              <span className="text-[10px] uppercase tracking-wide" style={{ color: '#15803D' }}>{label}</span>
              <span className="text-xs font-semibold" style={{ color: '#14532D' }}>{value}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Scrollable body — line items, RFQ status or sourcing, stock */}
      <div className="flex-1 min-h-0 overflow-auto space-y-4 pr-1">
        <div className="rounded-xl overflow-hidden" style={{ border: `1px solid ${TEAL.border}`, backgroundColor: COLORS.white, boxShadow: SHADOWS.card }}>
          <div className="px-4 py-3" style={{ borderBottom: `1px solid ${TEAL.border}` }}>
            <h2 className="text-sm font-semibold" style={{ color: COLORS.text.primary }}>Line Items</h2>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr style={{ backgroundColor: COLORS.lightBackground }}>
                {['Material', 'Qty', 'Est. Price', 'Line Value'].map((h) => (
                  <th key={h} className="text-left px-4 py-2 text-[11px] font-semibold uppercase tracking-wide" style={{ color: COLORS.text.secondary }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={`${l.pr_id}-${l.pr_line_item}`} style={{ borderTop: `1px solid ${COLORS.lightGray}` }}>
                  <td className="px-4 py-2" style={{ color: COLORS.text.primary }}>
                    {l.material_desc || l.material_id}
                    <span className="ml-1.5 text-[11px]" style={{ color: COLORS.text.tertiary }}>{l.material_id}</span>
                  </td>
                  <td className="px-4 py-2" style={{ color: COLORS.text.secondary }}>{l.requested_qty} {l.unit_of_measure}</td>
                  <td className="px-4 py-2" style={{ color: COLORS.text.secondary }}>{formatINR(l.estimated_price)}</td>
                  <td className="px-4 py-2 font-medium" style={{ color: COLORS.text.primary }}>{formatINR(l.total_value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* RFQ status comes right after line items, when one has been received for this PR */}
        {rfqs.length > 0 && (
          <div className="rounded-xl overflow-hidden" style={{ border: `1px solid ${TEAL.border}`, backgroundColor: COLORS.white, boxShadow: SHADOWS.card }}>
            <div className="px-4 py-3" style={{ borderBottom: `1px solid ${TEAL.border}` }}>
              <h2 className="text-sm font-semibold" style={{ color: COLORS.text.primary }}>RFQ Status</h2>
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr style={{ backgroundColor: COLORS.lightBackground }}>
                  {['ID', 'Status', 'Vendors Invited', 'Quotes Received'].map((h) => (
                    <th key={h} className="text-left px-4 py-2 text-[11px] font-semibold uppercase tracking-wide" style={{ color: COLORS.text.secondary }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rfqs.map((r) => (
                  <tr key={r.rfq_id} style={{ borderTop: `1px solid ${COLORS.lightGray}` }}>
                    <td className="px-4 py-2 font-medium" style={{ color: COLORS.text.primary }}>{r.rfq_id}</td>
                    <td className="px-4 py-2">
                      <span
                        className="px-2 py-0.5 rounded-full text-[11px] font-semibold"
                        style={{
                          backgroundColor: (RFQ_STATUS_STYLE[r.rfq_status] ?? RFQ_STATUS_STYLE['In Negotiation']).bg,
                          color: (RFQ_STATUS_STYLE[r.rfq_status] ?? RFQ_STATUS_STYLE['In Negotiation']).fg,
                        }}
                      >
                        {r.rfq_status}
                      </span>
                    </td>
                    <td className="px-4 py-2" style={{ color: COLORS.text.secondary }}>{r.vendors_invited}</td>
                    <td className="px-4 py-2" style={{ color: COLORS.text.secondary }}>{r.quotes_received}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {/* Only where the RFQ experience is wired up (not on the standalone
                Purchase Requests page, which has nothing to open). */}
            {onEvaluateRfq && (
              <div className="px-4 py-3 flex justify-end" style={{ borderTop: `1px solid ${COLORS.lightGray}` }}>
                <button
                  onClick={() => onEvaluateRfq({ prId: header.pr_id, rfqId: rfqs.length === 1 ? rfqs[0].rfq_id : undefined })}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold"
                  style={{ backgroundColor: TEAL.base, color: COLORS.white }}
                >
                  <Icon icon="mdi:clipboard-check-outline" className="w-4 h-4" />
                  {rfqs.length === 1 ? 'Evaluate RFQ' : "Evaluate RFQ's"}
                </button>
              </div>
            )}
          </div>
        )}

        {/* For a PR with no RFQ yet, sourcing is the next action — shown right
            after the line items. Once an RFQ exists this is skipped; the RFQ
            Status section above covers it, and no RFQ data shows here. */}
        {rfqs.length === 0 && (
          <div className="rounded-xl overflow-hidden" style={{ border: `1px solid ${TEAL.border}`, backgroundColor: COLORS.white, boxShadow: SHADOWS.card }}>
            <div className="px-4 py-3" style={{ borderBottom: `1px solid ${TEAL.border}` }}>
              <h2 className="text-sm font-semibold" style={{ color: COLORS.text.primary }}>Sourcing</h2>
            </div>
            {candidateVendors.length > 0 ? (
              <div className="px-4 py-3">
                <p className="text-xs mb-3" style={{ color: COLORS.text.secondary }}>
                  No RFQ exists yet. Vendors we've bought this material, or similar items, from before:
                </p>
                <table className="w-full text-sm">
                  <thead>
                    <tr style={{ backgroundColor: COLORS.lightBackground }}>
                      {['Vendor', 'Location', 'Payment Terms', 'Past Orders', 'Last Ordered', 'Last Price'].map((h) => (
                        <th key={h} className="text-left px-4 py-2 text-[11px] font-semibold uppercase tracking-wide" style={{ color: COLORS.text.secondary }}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {candidateVendors.map((v) => (
                      <tr key={v.vendor_id} style={{ borderTop: `1px solid ${COLORS.lightGray}` }}>
                        <td className="px-4 py-2" style={{ color: COLORS.text.primary }}>
                          <span className="font-medium">{v.vendor_name}</span>
                          <div className="text-[11px]" style={{ color: COLORS.text.tertiary }}>
                            {v.vendor_type} · {v.basis === 'material' ? 'bought this material' : 'bought similar items'}
                          </div>
                        </td>
                        <td className="px-4 py-2" style={{ color: COLORS.text.secondary }}>{v.city}, {v.state}</td>
                        <td className="px-4 py-2" style={{ color: COLORS.text.secondary }}>{v.payment_terms}</td>
                        <td className="px-4 py-2" style={{ color: COLORS.text.secondary }}>{v.orders}</td>
                        <td className="px-4 py-2" style={{ color: COLORS.text.secondary }}>{formatDate(v.last_order_date)}</td>
                        <td className="px-4 py-2" style={{ color: COLORS.text.secondary }}>{formatINR(v.last_price)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="px-4 py-4 text-xs" style={{ color: COLORS.text.tertiary }}>
                No RFQ yet, and we haven't bought this material or similar items before.
              </p>
            )}
          </div>
        )}

        {/* Kept for now: removing stock from this screen was discussed (it gets
            its own area of the product) but isn't decided — see TODO.md §1. */}
        <div className="rounded-xl overflow-hidden" style={{ border: `1px solid ${TEAL.border}`, backgroundColor: COLORS.white, boxShadow: SHADOWS.card }}>
          <div className="px-4 py-3" style={{ borderBottom: `1px solid ${TEAL.border}` }}>
            <h2 className="text-sm font-semibold" style={{ color: COLORS.text.primary }}>Available Stock</h2>
          </div>
          {inventory.length === 0 ? (
            <p className="px-4 py-4 text-xs" style={{ color: COLORS.text.tertiary }}>No inventory record for these materials at {header.plant_code}.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr style={{ backgroundColor: COLORS.lightBackground }}>
                  {['Material', 'Plant', 'On Hand', 'Reserved', 'Available', 'Reorder Point'].map((h) => (
                    <th key={h} className="text-left px-4 py-2 text-[11px] font-semibold uppercase tracking-wide" style={{ color: COLORS.text.secondary }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {inventory.map((inv) => {
                  const available = inv.current_stock - inv.reserved_stock;
                  const line = lines.find((l) => l.material_id === inv.material_id);
                  return (
                    <tr key={`${inv.material_id}-${inv.plant_code}`} style={{ borderTop: `1px solid ${COLORS.lightGray}` }}>
                      <td className="px-4 py-2" style={{ color: COLORS.text.primary }}>{line?.material_desc || inv.material_id}</td>
                      <td className="px-4 py-2" style={{ color: COLORS.text.secondary }}>{inv.plant_code}</td>
                      <td className="px-4 py-2" style={{ color: COLORS.text.secondary }}>{inv.current_stock}</td>
                      <td className="px-4 py-2" style={{ color: COLORS.text.secondary }}>{inv.reserved_stock}</td>
                      <td className="px-4 py-2 font-medium" style={{ color: available >= (line?.requested_qty || 0) ? '#16A34A' : '#475569' }}>
                        {available}
                      </td>
                      <td className="px-4 py-2" style={{ color: COLORS.text.secondary }}>{inv.reorder_point}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

      </div>

      {/* Comments are docked at the bottom, outside the scroll, so they stay
          reachable from anywhere in the PR; the panel opens upward. */}
      <div className="flex-shrink-0 pt-3">
        <PRComments prId={header.pr_id} />
      </div>
    </div>
  );
};

// ============================================================
// Root component
// ============================================================

const PurchaseRequests: React.FC<PurchaseRequestsProps> = ({ SA_RUNTIME, simplifiedToolbar, showRfqColumn, onEvaluateRfq, activePeriod }) => {
  const [rows, setRows] = useState<PRListRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedPrId, setSelectedPrId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await runTool<PRListRow>(PR_LIST_QUERY, undefined, SA_RUNTIME, 5000);
        if (!cancelled) setRows(data);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load purchase requests');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [SA_RUNTIME]);

  return (
    <div style={{ fontFamily: TYPOGRAPHY.fontFamily.primary, paddingTop: SPACING.xl }}>
      {selectedPrId ? (
        <PRDetailScreen prId={selectedPrId} onBack={() => setSelectedPrId(null)} SA_RUNTIME={SA_RUNTIME} onEvaluateRfq={onEvaluateRfq} />
      ) : (
        <PRListScreen
          rows={rows}
          loading={loading}
          error={error}
          onOpen={setSelectedPrId}
          simplifiedToolbar={simplifiedToolbar}
          showRfqColumn={showRfqColumn}
          activePeriod={activePeriod}
        />
      )}
    </div>
  );
};

(PurchaseRequests as PurchaseRequestsComponent).Metadata = METADATA;

export default PurchaseRequests;

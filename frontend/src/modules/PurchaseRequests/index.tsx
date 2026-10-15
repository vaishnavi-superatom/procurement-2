import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@iconify/react';
import type { ComponentMetadata } from '../../types';
import { COLORS, TYPOGRAPHY, SPACING, SHADOWS } from '../../design-system/tokens';
import LoadingState from '../../components/LoadingState';

interface PurchaseRequestsProps {
  SA_RUNTIME?: any;
  /** Shows the All PRs / RFQ / Non-RFQ filter in the list toolbar. Off by
   * default — only the Home "Total PRs Raised" instance turns this on, so
   * the standalone Purchase Requests page is unaffected. */
  rfqFilterEnabled?: boolean;
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
// inventory / rfq_events / quotations / vendor_master — the live
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
  rfq_status: 'Awarded' | 'In Negotiation';
  negotiation_rounds: number;
  vendor_name: string | null;
}

interface CandidateVendor {
  vendor_id: string;
  vendor_name: string;
  vendor_type: string;
  category_specialization: string;
  city: string;
  state: string;
  payment_terms: string;
}

type TimeFilter = 'All Time' | 'Today' | 'This Week' | 'This Month' | 'This Year';
const TIME_FILTER_OPTIONS: TimeFilter[] = ['All Time', 'Today', 'This Week', 'This Month', 'This Year'];

type GroupBy = 'None' | 'Department' | 'Material' | 'Urgency';
const GROUP_BY_OPTIONS: GroupBy[] = ['None', 'Department', 'Material', 'Urgency'];

// Whether a PR has a linked rfq_events row — real relationship, not inferred
// from source_type or any other field. See has_rfq in PR_LIST_QUERY.
type RfqFilter = 'All PRs' | 'RFQ' | 'Non-RFQ';
const RFQ_FILTER_OPTIONS: RfqFilter[] = ['All PRs', 'RFQ', 'Non-RFQ'];

// ============================================================
// Query helpers
//
// This project's live business data (purchase_requisitions, inventory,
// rfq_events, vendor_master, ...) is registered as a per-project source,
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
  BOOL_OR(EXISTS (SELECT 1 FROM rfq_events r WHERE r.pr_id = pr.pr_id)) AS has_rfq
FROM purchase_requisitions pr
LEFT JOIN material_master m ON m.material_id = pr.material_id
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

const UrgencyBadge: React.FC<{ urgency: string }> = ({ urgency }) => {
  const high = urgency === 'High';
  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold"
      style={{
        backgroundColor: high ? '#FEE2E2' : COLORS.lightGray,
        color: high ? '#DC2626' : COLORS.text.secondary,
      }}
    >
      {high && <Icon icon="mdi:alert-circle" className="w-3 h-3" />}
      {urgency}
    </span>
  );
};

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

// ============================================================
// METADATA
// ============================================================

const METADATA: ComponentMetadata = {
  id: 'purchase-requests-dashboard',
  name: 'PurchaseRequests',
  displayName: 'Show purchase requests dashboard',
  isDisplayComp: true,
  type: 'PurchaseRequests',
  description: 'Purchase requisitions list and detail view, sourced from the live purchase_requisitions/inventory/rfq_events data',
  category: 'Dashboard',
  keywords: ['purchase', 'requests', 'pr', 'requisition', 'rfq', 'procurement'],
  dashboard: { label: 'Purchase Requests', icon: 'mdi:cart-outline', order: 1 },
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
  rfqFilterEnabled?: boolean;
}> = ({ rows, loading, error, onOpen, rfqFilterEnabled }) => {
  const [search, setSearch] = useState('');
  const [timeFilter, setTimeFilter] = useState<TimeFilter>('All Time');
  const [groupBy, setGroupBy] = useState<GroupBy>('None');
  const [rfqFilter, setRfqFilter] = useState<RfqFilter>('All PRs');
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (!inTimeFilter(r.pr_date, timeFilter)) return false;
      if (rfqFilterEnabled) {
        if (rfqFilter === 'RFQ' && !r.has_rfq) return false;
        if (rfqFilter === 'Non-RFQ' && r.has_rfq) return false;
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
  }, [rows, search, timeFilter, rfqFilter, rfqFilterEnabled]);

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

  if (loading) {
    return <LoadingState height={520} message="Loading purchase requests…" variant="skeleton" size="lg" />;
  }

  if (error) {
    return (
      <div className="bg-white rounded-xl shadow-sm border border-[#FEE2E2] p-6">
        <div className="flex items-center gap-3">
          <Icon icon="mdi:alert-circle" className="w-5 h-5 text-[#DC2626] flex-shrink-0" />
          <div>
            <p className="text-sm font-medium text-[#DC2626]">Couldn't load purchase requests</p>
            <p className="text-xs mt-1" style={{ color: COLORS.text.secondary }}>{error}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full flex flex-col" style={{ height: 'calc(100vh - 160px)', minHeight: 480 }}>
      {/* Toolbar — fixed, never scrolls */}
      <div className="flex items-center justify-between flex-wrap gap-3 mb-4 flex-shrink-0">
        <div>
          <h1 className="text-xl font-bold" style={{ color: COLORS.text.primary }}>
            Purchase Requests
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
              className="text-xs outline-none w-56"
              style={{ color: COLORS.text.primary }}
            />
          </div>
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
          {rfqFilterEnabled && (
            <ToolbarDropdown
              label="RFQ"
              icon="mdi:file-send-outline"
              value={rfqFilter}
              options={RFQ_FILTER_OPTIONS}
              onChange={(v) => setRfqFilter(v as RfqFilter)}
            />
          )}
        </div>
      </div>

      {/* Table — the only internally-scrolling region */}
      <div
        className="flex-1 min-h-0 rounded-xl overflow-auto"
        style={{ border: `1px solid ${TEAL.border}`, backgroundColor: COLORS.white, boxShadow: SHADOWS.card }}
      >
        <table className="w-full text-sm border-collapse">
          <thead className="sticky top-0 z-10" style={{ backgroundColor: COLORS.lightBackground }}>
            <tr>
              {['PR ID', 'Material', 'Department', 'Plant', 'Urgency', 'Required By', 'Value', ''].map((h) => (
                <th
                  key={h}
                  className="text-left px-4 py-3 text-[11px] font-semibold uppercase tracking-wide"
                  style={{ color: COLORS.text.secondary, borderBottom: `1px solid ${TEAL.border}` }}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {groups.map(([groupName, groupRows]) => (
              <React.Fragment key={groupName}>
                {groupBy !== 'None' && (
                  <tr>
                    <td
                      colSpan={8}
                      className="px-4 py-2 text-xs font-semibold"
                      style={{ backgroundColor: TEAL.tint, color: TEAL.base }}
                    >
                      {groupName} <span style={{ color: COLORS.text.secondary, fontWeight: 400 }}>({groupRows.length})</span>
                    </td>
                  </tr>
                )}
                {groupRows.map((row) => (
                  <tr
                    key={row.pr_id}
                    onMouseEnter={() => setHoveredId(row.pr_id)}
                    onMouseLeave={() => setHoveredId((id) => (id === row.pr_id ? null : id))}
                    onClick={() => onOpen(row.pr_id)}
                    className="cursor-pointer"
                    style={{
                      borderBottom: `1px solid ${COLORS.lightGray}`,
                      backgroundColor: hoveredId === row.pr_id ? TEAL.tint : 'transparent',
                    }}
                  >
                    <td className="px-4 py-3 font-semibold" style={{ color: COLORS.text.primary }}>
                      {row.pr_id}
                    </td>
                    <td className="px-4 py-3" style={{ color: COLORS.text.primary }}>
                      {row.first_material_desc || row.first_material_id}
                      {row.material_count > 1 && (
                        <span className="ml-1.5 text-[11px]" style={{ color: COLORS.text.tertiary }}>
                          +{row.material_count - 1} more
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3" style={{ color: COLORS.text.secondary }}>{row.requester_dept}</td>
                    <td className="px-4 py-3" style={{ color: COLORS.text.secondary }}>{row.plant_code}</td>
                    <td className="px-4 py-3"><UrgencyBadge urgency={row.urgency} /></td>
                    <td className="px-4 py-3" style={{ color: COLORS.text.secondary }}>{formatDate(row.required_date)}</td>
                    <td className="px-4 py-3 font-medium" style={{ color: COLORS.text.primary }}>{formatINR(row.total_value)}</td>
                    <td className="px-4 py-3 text-right">
                      {hoveredId === row.pr_id && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onOpen(row.pr_id);
                          }}
                          className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-semibold"
                          style={{ backgroundColor: TEAL.base, color: COLORS.white }}
                        >
                          Open PR
                          <Icon icon="mdi:arrow-right" className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </React.Fragment>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-12 text-center text-sm" style={{ color: COLORS.text.tertiary }}>
                  No purchase requests match these filters.
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

type Recommendation = 'stock' | 'rfq' | 'create';

const PRDetailScreen: React.FC<{ prId: string; onBack: () => void; SA_RUNTIME: any }> = ({ prId, onBack, SA_RUNTIME }) => {
  const [lines, setLines] = useState<PRLine[] | null>(null);
  const [inventory, setInventory] = useState<InventoryRow[]>([]);
  const [rfqs, setRfqs] = useState<RfqRow[]>([]);
  const [candidateVendors, setCandidateVendors] = useState<CandidateVendor[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const inventoryRef = useRef<HTMLDivElement>(null);
  const sourcingRef = useRef<HTMLDivElement>(null);

  const scrollTo = useCallback((ref: React.RefObject<HTMLDivElement | null>) => {
    ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

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
            SELECT rfq.*, v.vendor_name
            FROM rfq_events rfq
            LEFT JOIN vendor_master v ON v.vendor_id = rfq.awarded_vendor_id
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

        if (rfqRows.length === 0) {
          const materialGroup = lineRows[0]?.material_group;
          if (materialGroup) {
            const vendors = await runTool<CandidateVendor>(
              `
              SELECT vendor_id, vendor_name, vendor_type, category_specialization, city, state, payment_terms
              FROM vendor_master
              WHERE is_active = true AND category_specialization ILIKE @materialGroupPattern
              ORDER BY CASE vendor_type WHEN 'Strategic' THEN 0 WHEN 'Preferred' THEN 1 WHEN 'Approved' THEN 2 ELSE 3 END, vendor_name
              LIMIT 6;
              `,
              { materialGroupPattern: `%${materialGroup}%` },
              SA_RUNTIME
            );
            if (!cancelled) setCandidateVendors(vendors);
          }
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

  const { recommendation, coveredCount } = useMemo(() => {
    if (!lines) return { recommendation: 'create' as Recommendation, coveredCount: 0 };
    let covered = 0;
    for (const line of lines) {
      const inv = inventory.find((i) => i.material_id === line.material_id && i.plant_code === line.plant_code);
      const available = inv ? inv.current_stock - inv.reserved_stock : 0;
      if (available >= line.requested_qty) covered += 1;
    }
    const all = lines.length > 0 && covered === lines.length;
    let rec: Recommendation = 'create';
    if (all) rec = 'stock';
    else if (rfqs.length > 0) rec = 'rfq';
    return { recommendation: rec, coveredCount: covered };
  }, [lines, inventory, rfqs]);

  if (loading) {
    return <LoadingState height={520} message="Loading purchase request…" variant="skeleton" size="lg" />;
  }

  if (error || !lines) {
    return (
      <div className="w-full">
        <button onClick={onBack} className="flex items-center gap-1.5 text-xs font-medium mb-4" style={{ color: TEAL.base }}>
          <Icon icon="mdi:arrow-left" className="w-4 h-4" /> Back to Purchase Requests
        </button>
        <div className="bg-white rounded-xl shadow-sm border border-[#FEE2E2] p-6">
          <div className="flex items-center gap-3">
            <Icon icon="mdi:alert-circle" className="w-5 h-5 text-[#DC2626] flex-shrink-0" />
            <p className="text-sm" style={{ color: '#DC2626' }}>{error}</p>
          </div>
        </div>
      </div>
    );
  }

  const header = lines[0];
  const totalValue = lines.reduce((sum, l) => sum + Number(l.total_value || 0), 0);
  const awardedRfq = rfqs.find((r) => r.rfq_status === 'Awarded');
  const openRfq = rfqs[0];

  const recCopy: Record<Recommendation, { icon: string; title: string; body: string; ctaLabel: string; action: () => void }> = {
    stock: {
      icon: 'mdi:warehouse',
      title: 'Existing inventory can cover this request',
      body: `${coveredCount} of ${lines.length} line item${lines.length > 1 ? 's are' : ' is'} fully stocked at ${header.plant_code}. No new sourcing is needed.`,
      ctaLabel: 'Review Available Stock',
      action: () => scrollTo(inventoryRef),
    },
    rfq: {
      icon: 'mdi:file-send-outline',
      title: 'An RFQ already exists for this request',
      body: openRfq
        ? `${openRfq.rfq_id} is ${openRfq.rfq_status.toLowerCase()} — ${openRfq.quotes_received} of ${openRfq.vendors_invited} invited vendors have quoted${
            awardedRfq?.vendor_name ? `, awarded to ${awardedRfq.vendor_name}` : ''
          }.`
        : 'A related RFQ is already in progress for this material.',
      ctaLabel: 'Go to Existing RFQ',
      action: () => scrollTo(sourcingRef),
    },
    create: {
      icon: 'mdi:plus-circle-outline',
      title: 'New sourcing is required',
      body: 'No existing stock covers this request and there is no active RFQ for it yet.',
      ctaLabel: 'Create RFQ',
      action: () => scrollTo(sourcingRef),
    },
  };
  const rec = recCopy[recommendation];

  return (
    <div className="w-full flex flex-col" style={{ height: 'calc(100vh - 120px)', minHeight: 480 }}>
      {/* Fixed header */}
      <div className="flex-shrink-0">
        <button onClick={onBack} className="flex items-center gap-1.5 text-xs font-medium mb-3" style={{ color: TEAL.base }}>
          <Icon icon="mdi:arrow-left" className="w-4 h-4" /> Back to Purchase Requests
        </button>
        <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-bold" style={{ color: COLORS.text.primary }}>
              Purchase Request {header.pr_id}
            </h1>
            <UrgencyBadge urgency={header.urgency} />
          </div>
          <button
            onClick={rec.action}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold"
            style={{ backgroundColor: TEAL.base, color: COLORS.white }}
          >
            <Icon icon={rec.icon} className="w-4 h-4" />
            {rec.ctaLabel}
          </button>
        </div>

        {/* Recommendation — visible immediately, not gated behind a click */}
        <div
          className="flex items-start gap-3 p-4 rounded-xl mb-4"
          style={{ backgroundColor: TEAL.tint, border: `1px solid ${TEAL.border}` }}
        >
          <Icon icon={rec.icon} className="w-5 h-5 flex-shrink-0 mt-0.5" style={{ color: TEAL.base }} />
          <div>
            <p className="text-sm font-semibold" style={{ color: TEAL.base }}>{rec.title}</p>
            <p className="text-xs mt-0.5" style={{ color: COLORS.text.secondary }}>{rec.body}</p>
          </div>
        </div>

        {/* Key info */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-4">
          {[
            ['Department', header.requester_dept],
            ['Plant', header.plant_code],
            ['Raised', formatDate(header.pr_date)],
            ['Required By', formatDate(header.required_date)],
            ['Line Items', String(lines.length)],
            ['Total Value', formatINR(totalValue)],
          ].map(([label, value]) => (
            <div key={label} className="rounded-lg p-3" style={{ border: `1px solid ${TEAL.border}`, backgroundColor: COLORS.white }}>
              <p className="text-[10px] uppercase tracking-wide mb-0.5" style={{ color: COLORS.text.tertiary }}>{label}</p>
              <p className="text-sm font-semibold truncate" style={{ color: COLORS.text.primary }}>{value}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Scrollable body — line items, inventory, sourcing */}
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

        <div ref={inventoryRef} className="rounded-xl overflow-hidden" style={{ border: `1px solid ${TEAL.border}`, backgroundColor: COLORS.white, boxShadow: SHADOWS.card }}>
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
                      <td className="px-4 py-2 font-medium" style={{ color: available >= (line?.requested_qty || 0) ? '#16A34A' : '#DC2626' }}>
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

        <div ref={sourcingRef} className="rounded-xl overflow-hidden" style={{ border: `1px solid ${TEAL.border}`, backgroundColor: COLORS.white, boxShadow: SHADOWS.card }}>
          <div className="px-4 py-3" style={{ borderBottom: `1px solid ${TEAL.border}` }}>
            <h2 className="text-sm font-semibold" style={{ color: COLORS.text.primary }}>Sourcing</h2>
          </div>
          {rfqs.length > 0 ? (
            <table className="w-full text-sm">
              <thead>
                <tr style={{ backgroundColor: COLORS.lightBackground }}>
                  {['RFQ ID', 'Status', 'Vendors Invited', 'Quotes Received', 'Awarded Vendor', 'Awarded Price'].map((h) => (
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
                          backgroundColor: r.rfq_status === 'Awarded' ? '#DCFCE7' : '#FFEDD5',
                          color: r.rfq_status === 'Awarded' ? '#16A34A' : '#EA580C',
                        }}
                      >
                        {r.rfq_status}
                      </span>
                    </td>
                    <td className="px-4 py-2" style={{ color: COLORS.text.secondary }}>{r.vendors_invited}</td>
                    <td className="px-4 py-2" style={{ color: COLORS.text.secondary }}>{r.quotes_received}</td>
                    <td className="px-4 py-2" style={{ color: COLORS.text.secondary }}>{r.vendor_name || '—'}</td>
                    <td className="px-4 py-2 font-medium" style={{ color: COLORS.text.primary }}>{formatINR(r.awarded_price)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : candidateVendors.length > 0 ? (
            <div className="px-4 py-3">
              <p className="text-xs mb-3" style={{ color: COLORS.text.secondary }}>
                No RFQ exists yet. Candidate vendors for {header.material_group || 'this material group'}:
              </p>
              <table className="w-full text-sm">
                <thead>
                  <tr style={{ backgroundColor: COLORS.lightBackground }}>
                    {['Vendor', 'Type', 'Specialization', 'Location', 'Payment Terms'].map((h) => (
                      <th key={h} className="text-left px-4 py-2 text-[11px] font-semibold uppercase tracking-wide" style={{ color: COLORS.text.secondary }}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {candidateVendors.map((v) => (
                    <tr key={v.vendor_id} style={{ borderTop: `1px solid ${COLORS.lightGray}` }}>
                      <td className="px-4 py-2 font-medium" style={{ color: COLORS.text.primary }}>{v.vendor_name}</td>
                      <td className="px-4 py-2" style={{ color: COLORS.text.secondary }}>{v.vendor_type}</td>
                      <td className="px-4 py-2" style={{ color: COLORS.text.secondary }}>{v.category_specialization}</td>
                      <td className="px-4 py-2" style={{ color: COLORS.text.secondary }}>{v.city}, {v.state}</td>
                      <td className="px-4 py-2" style={{ color: COLORS.text.secondary }}>{v.payment_terms}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="px-4 py-4 text-xs" style={{ color: COLORS.text.tertiary }}>
              No existing RFQ and no active vendors found for this material group.
            </p>
          )}
        </div>
      </div>
    </div>
  );
};

// ============================================================
// Root component
// ============================================================

const PurchaseRequests: React.FC<PurchaseRequestsProps> = ({ SA_RUNTIME, rfqFilterEnabled }) => {
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
        <PRDetailScreen prId={selectedPrId} onBack={() => setSelectedPrId(null)} SA_RUNTIME={SA_RUNTIME} />
      ) : (
        <PRListScreen rows={rows} loading={loading} error={error} onOpen={setSelectedPrId} rfqFilterEnabled={rfqFilterEnabled} />
      )}
    </div>
  );
};

(PurchaseRequests as PurchaseRequestsComponent).Metadata = METADATA;

export default PurchaseRequests;

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@iconify/react';
import type { ComponentMetadata } from '../../types';
import { COLORS, TYPOGRAPHY, SPACING, SHADOWS } from '../../design-system/tokens';
import LoadingState from '../../components/LoadingState';
import { setTRank, startNegotiation } from '../../data/rfq-workflow';
import {
  TechnicalEvaluation,
  TRankBadge,
  type TechBid,
  type TechEvaluation,
  type TechRequirement,
  type TRankDefinition,
} from './TechnicalEvaluation';

interface RfqReceivedProps {
  SA_RUNTIME?: any;
  /** Deep-links into a specific RFQ's detail on (re-)mount/change — used by the
   * Purchase Request detail view's "Evaluate RFQ" button when the PR has
   * exactly one linked RFQ. Bump `focusToken` to re-trigger for the same id
   * (e.g. evaluating the same PR again after navigating back). */
  focusRfqId?: string | null;
  /** Pre-fills and applies the list's search box — used alongside focusRfqId
   * (so "Back" returns to a list already narrowed to that PR) and alone when
   * a PR has more than one linked RFQ (focus the list instead of one record). */
  focusSearch?: string;
  focusToken?: number;
  /** Fired by "Start Negotiation" in an RFQ's detail view, with the linked PR,
   * this RFQ, and the leading supplier (the awarded vendor if the RFQ has
   * one, otherwise the lowest quote) preserved. There's no Active
   * Negotiations experience built yet, so this is left undefined everywhere
   * today — the button renders disabled until a real destination exists to
   * hand off to, rather than linking to a dead/fake page. */
  onStartNegotiation?: (args: { prId: string; rfqId: string; materialId: string; vendorId: string; vendorName?: string | null }) => void;
  /** Default for the list's own Filter-by-Time control — set from Home's
   * "Procurement at a Glance" period so the embedded table opens showing the
   * exact rows the "RFQs received" card counted. Still a normal, buyer-
   * changeable control after that; this only sets where it starts. */
  initialPeriod?: 'Today' | 'This Week' | 'This Month' | 'This Year';
}

// Same palette as the Home dashboard / Purchase Requests screen, so this
// reads as part of the same product rather than a one-off.
const TEAL = {
  base: '#3A59CD',
  dark: '#2E47A4',
  tint: '#EBEEFA',
  border: '#D8DEF5',
};

// ============================================================
// Real data shapes (public.rfq_events / purchase_requisitions /
// material_master / quotations / vendor_master — the live
// "PostgreSQL Connection" source registered for this project).
// ============================================================

interface RfqListRow {
  rfq_id: string;
  pr_id: string;
  material_id: string;
  material_desc: string | null;
  rfq_date: string;
  response_deadline: string;
  vendors_invited: number;
  quotes_received: number;
  rfq_status: 'RFQ Received' | 'In Negotiation' | 'Awarded';
  awarded_vendor_id: string | null;
  awarded_vendor_name: string | null;
  awarded_price: number | null;
}

interface RfqHeader {
  rfq_id: string;
  pr_id: string;
  material_id: string;
  material_desc: string | null;
  material_group: string | null;
  rfq_date: string;
  response_deadline: string;
  vendors_invited: number;
  quotes_received: number;
  rfq_status: 'RFQ Received' | 'In Negotiation' | 'Awarded';
  negotiation_rounds: number;
  awarded_vendor_id: string | null;
  awarded_price: number | null;
  requester_dept: string | null;
  plant_code: string | null;
  urgency: string | null;
}

interface QuotationRow {
  quote_id: string;
  rfq_id: string;
  vendor_id: string;
  vendor_name: string | null;
  vendor_type: string | null;
  city: string | null;
  state: string | null;
  material_id: string;
  quoted_price: number;
  quoted_qty: number;
  quote_date: string;
  delivery_days: number;
  payment_terms: string;
  warranty_months: number;
  is_technically_compliant: boolean;
  technical_score: number | null;
  is_awarded: boolean;
}

type TimeFilter = 'All Time' | 'Today' | 'This Week' | 'This Month' | 'This Year';
const TIME_FILTER_OPTIONS: TimeFilter[] = ['All Time', 'Today', 'This Week', 'This Month', 'This Year'];

// ============================================================
// Query helpers — same ToolExecutor path as modules/PurchaseRequests
// (this project's business data is a per-project source, not a static
// DATABASE_URL, so it's reached through the generated "<sourceId>_query"
// tool rather than window.SA.QueryExecutor).
// ============================================================

//local-tool id
const TOOL_ID = 'postgres-6a0f22831b3f_query';
//prod-tool id
//const TOOL_ID = 'postgres-0fc80d2496ff_query';
const TOOL_NAME = 'Query PostgreSQL Connection';

const RFQ_LIST_QUERY = `
SELECT
  rfq.rfq_id,
  rfq.pr_id,
  rfq.material_id,
  m.material_desc,
  rfq.rfq_date,
  rfq.response_deadline,
  rfq.vendors_invited,
  rfq.quotes_received,
  rfq.rfq_status,
  rfq.awarded_vendor_id,
  v.vendor_name AS awarded_vendor_name,
  rfq.awarded_price
FROM rfq_events rfq
LEFT JOIN material_master m ON m.material_id = rfq.material_id
LEFT JOIN vendor_master v ON v.vendor_id = rfq.awarded_vendor_id
ORDER BY rfq.rfq_date DESC
LIMIT 5000;
`;

const SAFE_ID = /^[A-Za-z0-9_-]+$/;

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

// ============================================================
// Small shared bits
// ============================================================

// An RFQ stays "RFQ Received" until the buyer starts negotiating
// (same colours as the PR detail's RFQ Status table).
const RFQ_STATUS_STYLE: Record<string, { bg: string; fg: string }> = {
  'RFQ Received': { bg: '#E0F2FE', fg: '#0284C7' },
  'In Negotiation': { bg: '#FFEDD5', fg: '#EA580C' },
  Awarded: { bg: '#DCFCE7', fg: '#16A34A' },
};

const RfqStatusBadge: React.FC<{ status: string }> = ({ status }) => {
  const style = RFQ_STATUS_STYLE[status] ?? RFQ_STATUS_STYLE['In Negotiation'];
  return (
    <span
      className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold"
      style={{ backgroundColor: style.bg, color: style.fg }}
    >
      {status}
    </span>
  );
};

// Same badge as the PR detail header.
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

const ToolbarDropdown: React.FC<{
  label: string;
  icon: string;
  value: string;
  options: string[];
  onChange: (v: string) => void;
}> = ({ label, icon, value, options, onChange }) => {
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
  id: 'rfq-received-list',
  name: 'RfqReceived',
  displayName: 'Show RFQs received',
  isDisplayComp: true,
  type: 'RfqReceived',
  description: 'RFQs received list and detail view (supplier quotations, commercial terms), sourced from the live rfq_events/quotations data',
  category: 'Dashboard',
  keywords: ['rfq', 'quotation', 'supplier', 'vendor', 'procurement'],
  props: {},
};

interface RfqReceivedComponent extends React.FC<RfqReceivedProps> {
  Metadata: ComponentMetadata;
}

// ============================================================
// List screen
// ============================================================

const RfqListScreen: React.FC<{
  rows: RfqListRow[];
  loading: boolean;
  error: string | null;
  onOpen: (rfqId: string) => void;
  focusSearch?: string;
  focusToken?: number;
  initialPeriod?: 'Today' | 'This Week' | 'This Month' | 'This Year';
}> = ({ rows, loading, error, onOpen, focusSearch, focusToken, initialPeriod }) => {
  const [search, setSearch] = useState('');
  const [timeFilter, setTimeFilter] = useState<TimeFilter>(initialPeriod || 'This Month');
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const PAGE_SIZE = 100;
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  // Set only while the list is showing one PR's RFQ(s) via "Evaluate RFQ's" —
  // an exact pr_id match, not the fuzzy multi-field search below, so no
  // unrelated RFQ (matched by material/vendor text) can slip in. Cleared the
  // moment the buyer edits the search box themselves.
  const [exactPrFilter, setExactPrFilter] = useState<string | null>(null);

  // Focused from a PR's "Evaluate RFQ's" — search that PR and widen the time
  // filter so its RFQ(s) show regardless of when they were raised.
  useEffect(() => {
    if (!focusToken) return;
    setSearch(focusSearch || '');
    setExactPrFilter(focusSearch || null);
    setTimeFilter('All Time');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusToken]);

  // Keeps this list's own Filter-by-Time control in sync with Home's
  // "Procurement at a Glance" period whenever it changes, so the card and
  // this table never disagree — the buyer can still change it afterward.
  useEffect(() => {
    if (initialPeriod) setTimeFilter(initialPeriod);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPeriod]);

  const filtered = useMemo(() => {
    if (exactPrFilter) {
      return rows.filter((r) => r.pr_id === exactPrFilter && inTimeFilter(r.rfq_date, timeFilter));
    }
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (!inTimeFilter(r.rfq_date, timeFilter)) return false;
      if (!q) return true;
      return (
        r.rfq_id.toLowerCase().includes(q) ||
        r.pr_id.toLowerCase().includes(q) ||
        (r.material_desc || '').toLowerCase().includes(q) ||
        (r.awarded_vendor_name || '').toLowerCase().includes(q)
      );
    });
  }, [rows, search, timeFilter, exactPrFilter]);

  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [search, timeFilter]);

  const visibleRows = filtered.slice(0, visibleCount);
  const hasMore = visibleCount < filtered.length;

  // When a time filter empties the list, say why rather than just "no
  // matches" — this dataset's RFQs don't necessarily reach into the current
  // calendar period, and that's a real data boundary, not a filter bug.
  const latestRfqDate = useMemo(() => {
    if (rows.length === 0) return null;
    return rows.reduce((max, r) => (r.rfq_date > max ? r.rfq_date : max), rows[0].rfq_date);
  }, [rows]);

  if (loading) {
    return <LoadingState height={520} message="Loading RFQs…" variant="skeleton" size="lg" />;
  }

  if (error) {
    return (
      <div className="bg-white rounded-xl shadow-sm border border-[#F1F5F9] p-6">
        <div className="flex items-center gap-3">
          <Icon icon="mdi:alert-circle" className="w-5 h-5 text-[#475569] flex-shrink-0" />
          <div>
            <p className="text-sm font-medium text-[#475569]">Couldn't load RFQs</p>
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
            RFQs Received
          </h1>
          <p className="text-xs mt-0.5" style={{ color: COLORS.text.secondary }}>
            {filtered.length.toLocaleString('en-IN')} of {rows.length.toLocaleString('en-IN')} RFQs
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
              onChange={(e) => {
                setSearch(e.target.value);
                setExactPrFilter(null);
              }}
              placeholder="Search RFQ ID, PR, material…"
              className="text-xs w-56"
              style={{ color: COLORS.text.primary, border: 'none', outline: 'none', boxShadow: 'none', background: 'transparent' }}
            />
          </div>
          <ToolbarDropdown
            label="Filter by Time"
            icon="mdi:calendar-range-outline"
            value={timeFilter}
            options={TIME_FILTER_OPTIONS}
            onChange={(v) => setTimeFilter(v as TimeFilter)}
          />
        </div>
      </div>

      {/* Table — the only internally-scrolling region */}
      <div
        className="flex-1 min-h-0 rounded-xl overflow-auto"
        style={{ border: `1px solid ${TEAL.border}`, backgroundColor: COLORS.white, boxShadow: SHADOWS.card }}
      >
        {/* minWidth: in a narrow container the table scrolls sideways instead of
            squeezing columns until the IDs are clipped. */}
        <table className="w-full text-sm border-collapse" style={{ tableLayout: 'fixed', minWidth: 880 }}>
          <colgroup>
            <col style={{ width: '140px' }} />
            <col />
            <col style={{ width: '120px' }} />
            <col style={{ width: '96px' }} />
            <col style={{ width: '120px' }} />
            <col style={{ width: '140px' }} />
          </colgroup>
          <thead className="sticky top-0 z-10" style={{ backgroundColor: COLORS.lightBackground }}>
            <tr>
              {[
                { label: 'RFQ ID', align: 'text-left' },
                { label: 'Material', align: 'text-left' },
                { label: 'Linked PR', align: 'text-left' },
                { label: 'Quotes', align: 'text-right' },
                { label: 'Deadline', align: 'text-left' },
                { label: 'Status', align: 'text-left' },
              ].map((h) => (
                <th
                  key={h.label}
                  className={`${h.align} px-4 py-3 text-[11px] font-semibold uppercase tracking-wide whitespace-nowrap`}
                  style={{ color: COLORS.text.secondary, borderBottom: `1px solid ${TEAL.border}` }}
                >
                  {h.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((row) => (
              <tr
                key={row.rfq_id}
                onMouseEnter={() => setHoveredId(row.rfq_id)}
                onMouseLeave={() => setHoveredId((id) => (id === row.rfq_id ? null : id))}
                onClick={() => onOpen(row.rfq_id)}
                className="cursor-pointer transition-colors duration-150"
                style={{
                  borderBottom: `1px solid ${COLORS.lightGray}`,
                  backgroundColor: hoveredId === row.rfq_id ? TEAL.tint : 'transparent',
                }}
              >
                <td className="px-4 py-3 align-top">
                  <div className="font-semibold whitespace-nowrap tabular-nums" style={{ color: TEAL.base }} title={row.rfq_id}>
                    {row.rfq_id}
                  </div>
                  <div className="text-[11px] mt-0.5 whitespace-nowrap" style={{ color: COLORS.text.tertiary }}>
                    {formatDate(row.rfq_date)}
                  </div>
                </td>
                <td className="px-4 py-3 align-top" title={row.material_desc || row.material_id}>
                  <div className="font-medium truncate" style={{ color: COLORS.text.primary }}>
                    {row.material_desc || row.material_id}
                  </div>
                  {row.material_desc && (
                    <div className="text-[11px] mt-0.5 truncate tabular-nums" style={{ color: COLORS.text.tertiary }}>
                      {row.material_id}
                    </div>
                  )}
                </td>
                <td className="px-4 py-3 align-top whitespace-nowrap tabular-nums" style={{ color: COLORS.text.primary }}>
                  {row.pr_id}
                </td>
                <td className="px-4 py-3 align-top text-right whitespace-nowrap tabular-nums" title="Quotes received / vendors invited">
                  <span className="font-semibold" style={{ color: COLORS.text.primary }}>{row.quotes_received}</span>
                  <span style={{ color: COLORS.text.tertiary }}> / {row.vendors_invited}</span>
                </td>
                <td className="px-4 py-3 align-top whitespace-nowrap" style={{ color: COLORS.text.secondary }}>
                  {formatDate(row.response_deadline)}
                </td>
                <td className="px-4 py-3 align-top whitespace-nowrap"><RfqStatusBadge status={row.rfq_status} /></td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-12 text-center text-sm" style={{ color: COLORS.text.tertiary }}>
                  {rows.length > 0 && timeFilter !== 'All Time' && !search ? (
                    <div className="flex flex-col items-center gap-2">
                      <p>
                        No RFQs were raised in <span className="font-medium">{timeFilter}</span>.
                        {latestRfqDate && <> The most recent RFQ in this data is from {formatDate(latestRfqDate)}.</>}
                      </p>
                      <button
                        onClick={() => setTimeFilter('All Time')}
                        className="px-3 py-1.5 rounded-lg text-xs font-semibold"
                        style={{ backgroundColor: TEAL.tint, color: TEAL.base }}
                      >
                        View All Time
                      </button>
                    </div>
                  ) : (
                    'No RFQs match these filters.'
                  )}
                </td>
              </tr>
            )}
            {hasMore && (
              <tr>
                <td colSpan={6} className="px-4 py-3 text-center">
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

const RfqDetailScreen: React.FC<{
  rfqId: string;
  onBack: () => void;
  SA_RUNTIME: any;
  onStartNegotiation?: (args: { prId: string; rfqId: string; materialId: string; vendorId: string; vendorName?: string | null }) => void;
}> = ({ rfqId, onBack, SA_RUNTIME, onStartNegotiation }) => {
  const [header, setHeader] = useState<RfqHeader | null>(null);
  const [quotations, setQuotations] = useState<QuotationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  // Technical evaluation (T-ranking): one expanded vendor at a time
  const [requirements, setRequirements] = useState<TechRequirement[]>([]);
  const [bids, setBids] = useState<TechBid[]>([]);
  const [evaluations, setEvaluations] = useState<Record<string, TechEvaluation>>({});
  const [definitions, setDefinitions] = useState<TRankDefinition[]>([]);
  const [expandedQuoteId, setExpandedQuoteId] = useState<string | null>(null);
  const [showLegend, setShowLegend] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        if (!SAFE_ID.test(rfqId)) throw new Error('Invalid RFQ id');

        const [headerRows, quoteRows, reqRows, bidRows, evalRows, defRows] = await Promise.all([
          runTool<RfqHeader>(
            `
            SELECT
              rfq.rfq_id, rfq.pr_id, rfq.material_id, m.material_desc, m.material_group,
              rfq.rfq_date, rfq.response_deadline, rfq.vendors_invited, rfq.quotes_received,
              rfq.rfq_status, rfq.negotiation_rounds, rfq.awarded_vendor_id, rfq.awarded_price,
              pr.requester_dept, pr.plant_code, pr.urgency
            FROM rfq_events rfq
            LEFT JOIN material_master m ON m.material_id = rfq.material_id
            LEFT JOIN purchase_requisitions pr ON pr.pr_id = rfq.pr_id AND pr.material_id = rfq.material_id
            WHERE rfq.rfq_id = @rfqId
            LIMIT 1;
            `,
            { rfqId },
            SA_RUNTIME
          ),
          runTool<QuotationRow>(
            `
            SELECT q.*, v.vendor_name, v.vendor_type, v.city, v.state
            FROM quotations q
            LEFT JOIN vendor_master v ON v.vendor_id = q.vendor_id
            WHERE q.rfq_id = @rfqId
            ORDER BY q.quoted_price ASC;
            `,
            { rfqId },
            SA_RUNTIME
          ),
          // Technical evaluation: what the PR line asked for, each vendor's
          // offer against it, the (pre-filled) T-ranks, and what they mean.
          runTool<TechRequirement>(
            `
            SELECT t.sort_order, t.parameter, t.required_value, t.comparison, t.is_mandatory
            FROM pr_technical_requirements t
            JOIN rfq_events rfq ON rfq.pr_id = t.pr_id AND rfq.material_id = t.material_id
            WHERE rfq.rfq_id = @rfqId
            ORDER BY t.sort_order;
            `,
            { rfqId },
            SA_RUNTIME
          ),
          runTool<TechBid>(
            `SELECT quote_id, sort_order, parameter, offered_value, status FROM quotation_technical_bids WHERE rfq_id = @rfqId ORDER BY quote_id, sort_order;`,
            { rfqId },
            SA_RUNTIME
          ),
          runTool<TechEvaluation & { rfq_id: string }>(
            `SELECT quote_id, rfq_id, suggested_t_rank, suggestion_reason, t_rank, ranked_by, ranked_at FROM rfq_technical_evaluations WHERE rfq_id = @rfqId;`,
            { rfqId },
            SA_RUNTIME
          ),
          runTool<TRankDefinition>(
            `SELECT t_rank, label, description, eligible_for_negotiation FROM t_rank_definitions ORDER BY sort_order;`,
            undefined,
            SA_RUNTIME
          ),
        ]);
        if (cancelled) return;
        // Defensive scoping on top of the WHERE clause — never show a quote or
        // header row for a different rfq_id than the one being evaluated.
        const ownHeaderRows = headerRows.filter((h) => h.rfq_id === rfqId);
        const ownQuoteRows = quoteRows.filter((q) => q.rfq_id === rfqId);
        if (ownHeaderRows.length === 0) throw new Error(`No RFQ found for ${rfqId}`);
        setHeader(ownHeaderRows[0]);
        setQuotations(ownQuoteRows);
        setRequirements(reqRows);
        setBids(bidRows);
        setEvaluations(Object.fromEntries(evalRows.filter((e) => e.rfq_id === rfqId).map((e) => [e.quote_id, e])));
        setDefinitions(defRows);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load this RFQ');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();
    return () => {
      cancelled = true;
    };
  }, [rfqId, SA_RUNTIME]);

  // Once loaded, the whole RFQ sits in the middle of the screen, Start Negotiation included
  // (review, 19 Oct: "reduce the height, show it in the center"); it's never taller than the screen.
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!loading) rootRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [loading]);

  if (loading) {
    return <LoadingState height={520} message="Loading RFQ…" variant="skeleton" size="lg" />;
  }

  if (error || !header) {
    return (
      <div className="w-full">
        <button onClick={onBack} className="flex items-center gap-1.5 text-xs font-medium mb-4" style={{ color: TEAL.base }}>
          <Icon icon="mdi:arrow-left" className="w-4 h-4" /> Back to RFQs Received
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

  // Real, derived from the two counts the source data actually has — there's
  // no per-vendor "invited but silent" record, so we can't name who's pending.
  const pendingCount = Math.max(0, header.vendors_invited - header.quotes_received);

  // The buyer's T-rank once set, otherwise the pre-filled suggestion.
  const tRankOf = (quoteId: string) => evaluations[quoteId]?.t_rank ?? evaluations[quoteId]?.suggested_t_rank ?? null;

  // The supplier a negotiation would start with: the awarded quote if one
  // exists, otherwise the lowest-priced quote still technically accepted
  // (quotations is already sorted ASC by quoted_price) — never invented, just
  // the leading real record.
  const leadingQuote = quotations.find((q) => q.is_awarded) || quotations.find((q) => tRankOf(q.quote_id) !== 'NOT_ACCEPTED') || null;
  const negotiationSupported = Boolean(onStartNegotiation) && Boolean(leadingQuote);

  return (
    // As tall as its content, up to the screen.
    <div ref={rootRef} className="w-full flex flex-col" style={{ maxHeight: 'calc(100vh - 120px)' }}>
      {/* Fixed header */}
      <div className="flex-shrink-0">
        <button onClick={onBack} className="flex items-center gap-1.5 text-xs font-medium mb-3" style={{ color: TEAL.base }}>
          <Icon icon="mdi:arrow-left" className="w-4 h-4" /> Back to RFQs Received
        </button>
        <div className="flex items-center gap-3 mb-4">
          <h1 className="text-xl font-bold" style={{ color: COLORS.text.primary }}>
            {/^rfq/i.test(header.rfq_id) ? header.rfq_id : `RFQ ${header.rfq_id}`}
          </h1>
          <RfqStatusBadge status={header.rfq_status} />
          {header.urgency && <UrgencyBadge urgency={header.urgency} />}
        </div>

        {/* Key info — one small box */}
        <div
          className="rounded-lg px-4 py-2.5 mb-4 flex flex-wrap items-center gap-x-5 gap-y-1.5"
          style={{ backgroundColor: '#F0FDF4', border: '1px solid #BBF7D0' }}
        >
          {[
            ['Linked PR', header.pr_id],
            ['Material', header.material_desc || header.material_id],
            ['Department', header.requester_dept || '—'],
            ['Plant', header.plant_code || '—'],
            ['RFQ Date', formatDate(header.rfq_date)],
            ['Deadline', formatDate(header.response_deadline)],
            ['Vendors Invited', String(header.vendors_invited)],
            ['Quotes Received', String(header.quotes_received)],
            ['Negotiation Rounds', String(header.negotiation_rounds)],
          ].map(([label, value]) => (
            <div key={label} className="flex items-baseline gap-1.5">
              <span className="text-[10px] uppercase tracking-wide" style={{ color: '#15803D' }}>{label}</span>
              <span className="text-xs font-semibold" style={{ color: '#14532D' }}>{value}</span>
            </div>
          ))}
          {pendingCount > 0 && (
            <div className="flex items-baseline gap-1.5">
              <span className="text-[10px] uppercase tracking-wide" style={{ color: '#C2410C' }}>Pending Responses</span>
              <span className="text-xs font-semibold" style={{ color: '#C2410C' }}>{pendingCount}</span>
            </div>
          )}
        </div>
      </div>

      {/* Scrollable body — supplier quotations & commercial terms */}
      <div className="flex-1 min-h-0 overflow-auto space-y-4 pr-1">
        <div className="rounded-xl overflow-hidden" style={{ border: `1px solid ${TEAL.border}`, backgroundColor: COLORS.white, boxShadow: SHADOWS.card }}>
          <div className="px-4 py-3" style={{ borderBottom: `1px solid ${TEAL.border}` }}>
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold" style={{ color: COLORS.text.primary }}>Supplier Quotations</h2>
              {definitions.length > 0 && (
                <button
                  onClick={() => setShowLegend((s) => !s)}
                  className="inline-flex items-center gap-1 text-[11px] font-medium flex-shrink-0"
                  style={{ color: TEAL.base }}
                >
                  <Icon icon="mdi:information-outline" className="w-3.5 h-3.5" />
                  What do T-ranks mean?
                </button>
              )}
            </div>
            {showLegend && (
              <div className="mt-2 grid gap-1.5" style={{ gridTemplateColumns: 'auto 1fr' }}>
                {definitions.map((d) => (
                  <React.Fragment key={d.t_rank}>
                    <TRankBadge rank={d.t_rank} />
                    <span className="text-[11px] self-center" style={{ color: COLORS.text.secondary }}>
                      {d.description}{!d.eligible_for_negotiation && ' (does not go to negotiation)'}
                    </span>
                  </React.Fragment>
                ))}
              </div>
            )}
          </div>
          {pendingCount > 0 && (
            <div className="flex items-center gap-2 px-4 py-2" style={{ backgroundColor: '#FFF7ED', borderBottom: `1px solid ${TEAL.border}` }}>
              <Icon icon="mdi:clock-alert-outline" className="w-4 h-4 flex-shrink-0" style={{ color: '#C2410C' }} />
              <p className="text-xs" style={{ color: '#9A3412' }}>
                {pendingCount} of {header.vendors_invited} invited supplier{header.vendors_invited === 1 ? '' : 's'} {pendingCount === 1 ? 'has' : 'have'} not responded yet.
              </p>
            </div>
          )}
          {quotations.length === 0 ? (
            <p className="px-4 py-4 text-xs" style={{ color: COLORS.text.tertiary }}>No quotations received yet for this RFQ.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr style={{ backgroundColor: COLORS.lightBackground }}>
                  {['Vendor', 'Quoted Price', 'Qty', 'Delivery', 'Payment Terms', 'Warranty', 'T-Rank'].map((h) => (
                    <th key={h} className="text-left px-4 py-2 text-[11px] font-semibold uppercase tracking-wide" style={{ color: COLORS.text.secondary }}>
                      {h}
                    </th>
                  ))}
                  <th className="w-12" />
                </tr>
              </thead>
              <tbody>
                {quotations.map((q) => {
                  const expanded = expandedQuoteId === q.quote_id;
                  return (
                  <React.Fragment key={q.quote_id}>
                  <tr
                    onClick={() => setExpandedQuoteId(expanded ? null : q.quote_id)}
                    aria-expanded={expanded}
                    title={expanded ? 'Click to collapse' : 'Click to see the technical evaluation'}
                    className="cursor-pointer"
                    style={{
                      borderTop: `1px solid ${COLORS.lightGray}`,
                      backgroundColor: q.is_awarded ? TEAL.tint : expanded ? COLORS.lightBackground : 'transparent',
                    }}
                  >
                    <td className="px-4 py-2" style={{ color: COLORS.text.primary }}>
                      {/* One line per vendor; its type and city on hover, to keep the page short. */}
                      <span className="font-medium" title={[q.vendor_type, [q.city, q.state].filter(Boolean).join(', ')].filter(Boolean).join(' · ')}>
                        {q.vendor_name || q.vendor_id}
                      </span>
                      {q.is_awarded && (
                        <span
                          className="ml-2 px-1.5 py-0.5 rounded-full text-[10px] font-semibold"
                          style={{ backgroundColor: TEAL.base, color: COLORS.white }}
                        >
                          Awarded
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2 font-medium" style={{ color: COLORS.text.primary }}>{formatINR(q.quoted_price)}</td>
                    <td className="px-4 py-2" style={{ color: COLORS.text.secondary }}>{q.quoted_qty}</td>
                    <td className="px-4 py-2" style={{ color: COLORS.text.secondary }}>{q.delivery_days} days</td>
                    <td className="px-4 py-2" style={{ color: COLORS.text.secondary }}>{q.payment_terms}</td>
                    <td className="px-4 py-2" style={{ color: COLORS.text.secondary }}>{q.warranty_months} mo</td>
                    <td className="px-4 py-2">
                      <TRankBadge rank={tRankOf(q.quote_id)} />
                    </td>
                    {/* Arrow at the row's right end, so the row reads as one that opens (review, 18 Oct: "nothing is saying that you can" open it). */}
                    <td className="px-4 py-2 text-right">
                      <span
                        aria-hidden
                        className="inline-flex items-center justify-center w-5 h-5 rounded-full"
                        style={{ backgroundColor: TEAL.tint, color: TEAL.base }}
                      >
                        <Icon icon={expanded ? 'mdi:chevron-up' : 'mdi:chevron-down'} className="w-4 h-4" />
                      </span>
                    </td>
                  </tr>
                  {expanded && (
                    <tr>
                      <td colSpan={8} className="p-0" style={{ borderTop: `1px solid ${COLORS.lightGray}` }}>
                        <TechnicalEvaluation
                          rfqId={header.rfq_id}
                          vendorId={q.vendor_id}
                          vendorName={q.vendor_name || q.vendor_id}
                          requirements={requirements}
                          bids={bids.filter((b) => b.quote_id === q.quote_id)}
                          evaluation={evaluations[q.quote_id]}
                          definitions={definitions}
                          locked={header.rfq_status === 'Awarded'}
                          onRankChange={async (tRank) => {
                            const saved = await setTRank(header.rfq_id, q.quote_id, tRank);
                            setEvaluations((prev) => ({
                              ...prev,
                              [q.quote_id]: { ...prev[q.quote_id], t_rank: saved.tRank, ranked_by: saved.rankedBy, ranked_at: saved.rankedAt },
                            }));
                          }}
                        />
                        {/* An obvious way to close the panel (walkthrough, 16 Oct: "is there a way to collapse it?"). */}
                        <div className="flex justify-center pb-3" style={{ backgroundColor: COLORS.lightBackground }}>
                          <button
                            type="button"
                            onClick={() => setExpandedQuoteId(null)}
                            className="inline-flex items-center gap-1 px-3 py-1 rounded-full text-[11px] font-medium"
                            style={{ color: TEAL.base, border: `1px solid ${TEAL.border}`, backgroundColor: COLORS.white }}
                          >
                            <Icon icon="mdi:chevron-up" className="w-3.5 h-3.5" />
                            Collapse {q.vendor_name || q.vendor_id}
                          </button>
                        </div>
                      </td>
                    </tr>
                  )}
                  </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Hands off the linked PR, this RFQ, and the leading supplier to
            Active Negotiations. Disabled when there's no quotation to
            negotiate from (see onStartNegotiation / negotiationSupported above).
            This is the buyer actively entering negotiation, so an RFQ still
            "RFQ Received" moves to "In Negotiation" first. */}
        <div className="flex items-center justify-end gap-3">
          {startError && (
            <span className="text-xs mr-auto" style={{ color: '#475569' }}>
              Couldn't start the negotiation: {startError}
            </span>
          )}
          <button
            disabled={!negotiationSupported || starting}
            onClick={async () => {
              if (!negotiationSupported || !leadingQuote || starting) return;
              setStartError(null);
              if (header.rfq_status === 'RFQ Received') {
                setStarting(true);
                try {
                  const change = await startNegotiation(header.rfq_id);
                  setHeader({ ...header, rfq_status: change.status as RfqHeader['rfq_status'] });
                } catch (err) {
                  setStartError(err instanceof Error ? err.message : 'please try again');
                  return;
                } finally {
                  setStarting(false);
                }
              }
              onStartNegotiation?.({
                prId: header.pr_id,
                rfqId: header.rfq_id,
                materialId: header.material_id,
                vendorId: leadingQuote.vendor_id,
                vendorName: leadingQuote.vendor_name,
              });
            }}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold flex-shrink-0"
            style={{
              backgroundColor: negotiationSupported ? TEAL.base : COLORS.lightGray,
              color: negotiationSupported ? COLORS.white : COLORS.text.tertiary,
              cursor: negotiationSupported && !starting ? 'pointer' : 'not-allowed',
            }}
          >
            <Icon icon={starting ? 'mdi:loading' : 'mdi:handshake-outline'} className={`w-4 h-4 ${starting ? 'animate-spin' : ''}`} />
            {starting ? 'Starting…' : 'Start Negotiation'}
          </button>
        </div>
      </div>
    </div>
  );
};

// ============================================================
// Root component
// ============================================================

const RfqReceived: React.FC<RfqReceivedProps> = ({ SA_RUNTIME, focusRfqId, focusSearch, focusToken, onStartNegotiation, initialPeriod }) => {
  const [rows, setRows] = useState<RfqListRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedRfqId, setSelectedRfqId] = useState<string | null>(null);

  // Focused from a PR's "Evaluate RFQ" — jump straight to its one linked RFQ.
  // With more than one (focusRfqId undefined), fall through to the list,
  // which RfqListScreen below narrows via focusSearch instead.
  useEffect(() => {
    if (!focusToken) return;
    setSelectedRfqId(focusRfqId || null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusToken]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await runTool<RfqListRow>(RFQ_LIST_QUERY, undefined, SA_RUNTIME, 5000);
        if (!cancelled) setRows(data);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load RFQs');
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
      {selectedRfqId ? (
        <RfqDetailScreen
          rfqId={selectedRfqId}
          onBack={() => setSelectedRfqId(null)}
          SA_RUNTIME={SA_RUNTIME}
          onStartNegotiation={onStartNegotiation}
        />
      ) : (
        <RfqListScreen
          rows={rows}
          loading={loading}
          error={error}
          onOpen={setSelectedRfqId}
          focusSearch={focusSearch}
          focusToken={focusToken}
          initialPeriod={initialPeriod}
        />
      )}
    </div>
  );
};

(RfqReceived as RfqReceivedComponent).Metadata = METADATA;

export default RfqReceived;

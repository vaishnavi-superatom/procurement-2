import React, { useEffect, useMemo, useState } from 'react';
import { Icon } from '@iconify/react';
import type { ComponentMetadata } from '../../types';
import { COLORS, TYPOGRAPHY, SPACING, SHADOWS } from '../../design-system/tokens';
import LoadingState from '../../components/LoadingState';
import ActiveNegotiations from '../ActiveNegotiations';

interface NegotiationsProps {
  SA_RUNTIME?: any;
  /** Width/row-height treatment. Defaults to the compact, width-constrained
   * layout (for the sidebar route, which receives no extra props). Home's
   * "Active Negotiations" card passes `compact={false}` so its embedded
   * table matches the full-width look of the RFQs/PRs tables next to it. */
  compact?: boolean;
  /** Applied invisibly (no extra toolbar control here) when set — used by
   * Home's "Active Negotiations" card so this embedded table always shows
   * exactly the rows that card's own count query matched for the selected
   * period. Left unset for the sidebar route, which shows every negotiation. */
  activePeriod?: 'Today' | 'This Week' | 'This Month' | 'This Year';
}

// Same palette as the rest of this product's procurement screens.
const TEAL = {
  base: '#3A59CD',
  dark: '#2E47A4',
  tint: '#EBEEFA',
  border: '#D8DEF5',
};

// ============================================================
// Real data shape — one row per RFQ currently "In Negotiation" (rfq_events),
// with its bid count and leading supplier computed from the actual
// quotations recorded against it (see NEGOTIATIONS_QUERY).
// ============================================================

interface NegotiationRow {
  rfq_id: string;
  pr_id: string;
  material_id: string;
  material_desc: string | null;
  rfq_date: string;
  bid_count: number;
  leading_vendor_id: string | null;
  leading_vendor_name: string | null;
}

type TimeFilter = 'All Time' | 'Today' | 'This Week' | 'This Month' | 'This Year';

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
// Query helpers — same ToolExecutor path as the other procurement modules.
// ============================================================

//local-tool id
//const TOOL_ID = 'postgres-6a0f22831b3f_query';
//prod-tool id
const TOOL_ID = 'postgres-0fc80d2496ff_query';
const TOOL_NAME = 'Query PostgreSQL Connection';

async function runTool<T = any>(sql: string, SA_RUNTIME: any, limit?: number): Promise<T[]> {
  const toolExecutor = (window as any).SA?.ToolExecutor;
  if (!toolExecutor) throw new Error('ToolExecutor not available');
  const res = await toolExecutor.executeTool({
    externalTool: { toolId: TOOL_ID, toolName: TOOL_NAME, parameters: { sql, ...(limit ? { limit } : {}) } },
    formData: {},
    SA_RUNTIME,
  });
  const payload = res?.data ?? res;
  const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.records) ? payload.records : [];
  return rows as T[];
}

// Bid count = COUNT of actual quotations rows for the RFQ (not the cached
// quotes_received counter on rfq_events) — the literal recorded bids.
// Leading supplier uses the exact same ranking as the negotiation detail
// view's recommendation (technically compliant, then not high-risk/not
// sanctioned, then lowest price), so the supplier named here is always the
// one the detail view opens to.
const NEGOTIATIONS_QUERY = `
WITH ranked_quotes AS (
  SELECT
    q.rfq_id, q.vendor_id, v.vendor_name,
    ROW_NUMBER() OVER (
      PARTITION BY q.rfq_id
      ORDER BY
        CASE WHEN q.is_technically_compliant THEN 0 ELSE 1 END,
        CASE WHEN sc.financial_risk_tier = 'High' OR sc.sanctions_flag THEN 1 ELSE 0 END,
        q.quoted_price ASC
    ) AS rn
  FROM quotations q
  LEFT JOIN vendor_master v ON v.vendor_id = q.vendor_id
  LEFT JOIN supplier_scorecard sc ON sc.vendor_id = q.vendor_id
),
bid_counts AS (
  SELECT rfq_id, COUNT(*) AS bid_count FROM quotations GROUP BY rfq_id
)
SELECT
  rfq.rfq_id,
  rfq.pr_id,
  rfq.material_id,
  m.material_desc,
  rfq.rfq_date,
  COALESCE(bc.bid_count, 0) AS bid_count,
  lead.vendor_id AS leading_vendor_id,
  lead.vendor_name AS leading_vendor_name
FROM rfq_events rfq
LEFT JOIN material_master m ON m.material_id = rfq.material_id
LEFT JOIN bid_counts bc ON bc.rfq_id = rfq.rfq_id
LEFT JOIN ranked_quotes lead ON lead.rfq_id = rfq.rfq_id AND lead.rn = 1
WHERE rfq.rfq_status = 'In Negotiation'
ORDER BY rfq.rfq_date DESC
LIMIT 5000;
`;

const METADATA: ComponentMetadata = {
  id: 'negotiations-dashboard',
  name: 'Negotiations',
  displayName: 'Show negotiations dashboard',
  isDisplayComp: true,
  type: 'Negotiations',
  description: 'Active negotiations list (PR, material, leading supplier, actual bid count), opening the existing negotiation detail view',
  category: 'Dashboard',
  keywords: ['negotiations', 'rfq', 'vendor', 'procurement', 'bids'],
  dashboard: { label: 'Negotiations', icon: 'mdi:bullhorn-outline', order: 4 },
  props: {},
};

interface NegotiationsComponent extends React.FC<NegotiationsProps> {
  Metadata: ComponentMetadata;
}

const Negotiations: React.FC<NegotiationsProps> = ({ SA_RUNTIME, compact = true, activePeriod }) => {
  const cellPad = compact ? 'px-3 py-1.5' : 'px-4 py-3';
  const headPad = compact ? 'px-3 py-2' : 'px-4 py-3';
  const [rows, setRows] = useState<NegotiationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [selected, setSelected] = useState<{ prId: string; rfqId: string; materialId: string; vendorId: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await runTool<NegotiationRow>(NEGOTIATIONS_QUERY, SA_RUNTIME, 5000);
        if (!cancelled) setRows(data);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load negotiations');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [SA_RUNTIME]);

  // No visible time-filter control here — activePeriod is only ever set by
  // Home's "Active Negotiations" card, applied invisibly so this table's row
  // count always matches that card's own count query. The sidebar route gets
  // no activePeriod and shows every open negotiation, as before.
  const effectivePeriod: TimeFilter = activePeriod || 'All Time';

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (!inTimeFilter(r.rfq_date, effectivePeriod)) return false;
      if (!q) return true;
      return (
        r.pr_id.toLowerCase().includes(q) ||
        (r.material_desc || r.material_id).toLowerCase().includes(q) ||
        (r.leading_vendor_name || r.leading_vendor_id || '').toLowerCase().includes(q)
      );
    });
  }, [rows, search, effectivePeriod]);

  if (selected) {
    return (
      <div style={{ fontFamily: TYPOGRAPHY.fontFamily.primary, paddingTop: SPACING.xl }}>
        <ActiveNegotiations
          SA_RUNTIME={SA_RUNTIME}
          prId={selected.prId}
          rfqId={selected.rfqId}
          materialId={selected.materialId}
          vendorId={selected.vendorId}
          onBack={() => setSelected(null)}
        />
      </div>
    );
  }

  if (loading) {
    return <LoadingState height={520} message="Loading negotiations…" variant="skeleton" size="lg" />;
  }

  if (error) {
    return (
      <div className="bg-white rounded-xl shadow-sm border border-[#F1F5F9] p-6">
        <div className="flex items-center gap-3">
          <Icon icon="mdi:alert-circle" className="w-5 h-5 text-[#475569] flex-shrink-0" />
          <div>
            <p className="text-sm font-medium text-[#475569]">Couldn't load negotiations</p>
            <p className="text-xs mt-1" style={{ color: COLORS.text.secondary }}>{error}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={compact ? 'flex flex-col mx-auto' : 'w-full flex flex-col'}
      style={{
        fontFamily: TYPOGRAPHY.fontFamily.primary,
        paddingTop: SPACING.xl,
        height: 'calc(100vh - 160px)',
        minHeight: 480,
        ...(compact ? { width: '82%', minWidth: 640 } : {}),
      }}
    >
      {/* Toolbar — fixed, never scrolls */}
      <div className="flex items-center justify-between flex-wrap gap-3 mb-4 flex-shrink-0">
        <div>
          <h1 className="text-xl font-bold" style={{ color: COLORS.text.primary }}>
            Active Negotiations
          </h1>
          <p className="text-xs mt-0.5" style={{ color: COLORS.text.secondary }}>
            {filtered.length.toLocaleString('en-IN')} of {rows.length.toLocaleString('en-IN')} negotiations
          </p>
        </div>

        <div
          className="flex items-center gap-2 px-3 py-2 rounded-lg"
          style={{ border: `1px solid ${COLORS.borderGray}`, backgroundColor: COLORS.white }}
        >
          <Icon icon="mdi:magnify" className="w-4 h-4" style={{ color: COLORS.text.tertiary }} />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search PR ID, material, supplier…"
            className="text-xs w-56"
            style={{ color: COLORS.text.primary, border: 'none', outline: 'none', boxShadow: 'none', background: 'transparent' }}
          />
        </div>
      </div>

      {/* Table — the only internally-scrolling region */}
      <div
        className="flex-1 min-h-0 rounded-xl overflow-auto"
        style={{ border: `1px solid ${TEAL.border}`, backgroundColor: COLORS.white, boxShadow: SHADOWS.card }}
      >
        <table className="w-full text-sm border-collapse" style={{ tableLayout: 'fixed' }}>
          <colgroup>
            <col style={{ width: compact ? '110px' : '130px' }} />
            <col />
            <col style={{ width: compact ? '120px' : '150px' }} />
          </colgroup>
          <thead className="sticky top-0 z-10" style={{ backgroundColor: COLORS.lightBackground }}>
            <tr>
              {['PR ID', 'Material', 'Number of Bids'].map((h) => (
                <th
                  key={h}
                  className={`text-left ${headPad} text-[11px] font-semibold uppercase tracking-wide leading-tight`}
                  style={{ color: COLORS.text.secondary, borderBottom: `1px solid ${TEAL.border}` }}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((row) => {
              const openable = Boolean(row.leading_vendor_id);
              return (
                <tr
                  key={row.rfq_id}
                  onMouseEnter={() => setHoveredId(row.rfq_id)}
                  onMouseLeave={() => setHoveredId((id) => (id === row.rfq_id ? null : id))}
                  onClick={() =>
                    openable &&
                    setSelected({ prId: row.pr_id, rfqId: row.rfq_id, materialId: row.material_id, vendorId: row.leading_vendor_id as string })
                  }
                  className="transition-colors duration-150"
                  style={{
                    borderBottom: `1px solid ${COLORS.lightGray}`,
                    backgroundColor: hoveredId === row.rfq_id ? TEAL.tint : 'transparent',
                    cursor: openable ? 'pointer' : 'default',
                  }}
                >
                  <td className={`${cellPad} font-semibold truncate`} style={{ color: COLORS.text.primary }}>
                    {row.pr_id}
                  </td>
                  <td className={`${cellPad} truncate`} style={{ color: COLORS.text.primary }}>
                    {row.material_desc || row.material_id}
                  </td>
                  <td className={cellPad} style={{ color: COLORS.text.secondary }}>{row.bid_count}</td>
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={3} className="px-3 py-12 text-center text-sm" style={{ color: COLORS.text.tertiary }}>
                  {activePeriod && rows.length > 0 && !search
                    ? `No negotiations opened in ${activePeriod.toLowerCase()}. Try a different period from the banner above.`
                    : 'No active negotiations match this search.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

(Negotiations as NegotiationsComponent).Metadata = METADATA;

export default Negotiations;

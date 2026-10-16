import React, { useEffect, useMemo, useState } from 'react';
import { Icon } from '@iconify/react';
import type { ComponentMetadata } from '../../types';
import { COLORS, TYPOGRAPHY, SPACING, SHADOWS } from '../../design-system/tokens';
import LoadingState from '../../components/LoadingState';

interface ApprovedRfqsHomeProps {
  SA_RUNTIME?: any;
  /** Opens the clicked RFQ in the existing RFQs Received detail view (the
   * same hand-off PR detail's "Evaluate RFQ" uses) — reused as-is, nothing
   * new built for "RFQ/award details". */
  onOpenRfq: (args: { prId: string; rfqId: string }) => void;
  /** Applied invisibly (no extra toolbar control here) when set — used by
   * Home's "Approved RFQs" card so this embedded table always shows exactly
   * the rows that card's own count query matched for the selected period. */
  activePeriod?: 'Today' | 'This Week' | 'This Month' | 'This Year';
}

type TimeFilter = 'All Time' | 'Today' | 'This Week' | 'This Month' | 'This Year';

const inTimeFilter = (dateStr: string | null, filter: TimeFilter): boolean => {
  if (filter === 'All Time') return true;
  if (!dateStr) return false;
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

// Same palette as the rest of this product's procurement screens.
const TEAL = {
  base: '#3A59CD',
  dark: '#2E47A4',
  tint: '#EBEEFA',
  border: '#D8DEF5',
};

// ============================================================
// Real data shape — one row per RFQ genuinely awarded (rfq_events.rfq_status
// = 'Awarded' is the only real "approved" status this schema has; there is
// no separate approval workflow/status field). "Approval Date" uses the
// awarded quotation's quote_date — rfq_events has no awarded/approval date
// column of its own, so this is the closest real, recorded date for when
// the winning offer was approved, not an invented field.
// ============================================================

interface ApprovedRfqRow {
  rfq_id: string;
  pr_id: string;
  material_id: string;
  material_desc: string | null;
  awarded_vendor_id: string | null;
  awarded_vendor_name: string | null;
  awarded_price: number | null;
  rfq_status: 'RFQ Received' | 'In Negotiation' | 'Awarded';
  rfq_date: string;
  awarded_quote_date: string | null;
}

//local-tool id
const TOOL_ID = 'postgres-6a0f22831b3f_query';
//prod-tool id
//const TOOL_ID = 'postgres-0fc80d2496ff_query';
const TOOL_NAME = 'Query PostgreSQL Connection';

async function runTool<T = any>(sql: string, SA_RUNTIME: any): Promise<T[]> {
  const toolExecutor = (window as any).SA?.ToolExecutor;
  if (!toolExecutor) throw new Error('ToolExecutor not available');
  const res = await toolExecutor.executeTool({
    externalTool: { toolId: TOOL_ID, toolName: TOOL_NAME, parameters: { sql } },
    formData: {},
    SA_RUNTIME,
  });
  const payload = res?.data ?? res;
  const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.records) ? payload.records : [];
  return rows as T[];
}

const APPROVED_RFQS_QUERY = `
SELECT
  rfq.rfq_id,
  rfq.pr_id,
  rfq.material_id,
  MIN(m.material_desc) AS material_desc,
  rfq.awarded_vendor_id,
  MIN(v.vendor_name) AS awarded_vendor_name,
  rfq.awarded_price,
  rfq.rfq_status,
  MIN(rfq.rfq_date) AS rfq_date,
  MIN(aq.quote_date) AS awarded_quote_date
FROM rfq_events rfq
LEFT JOIN material_master m ON m.material_id = rfq.material_id
LEFT JOIN vendor_master v ON v.vendor_id = rfq.awarded_vendor_id
LEFT JOIN quotations aq ON aq.rfq_id = rfq.rfq_id AND aq.is_awarded = true
WHERE rfq.rfq_status = 'Awarded'
GROUP BY rfq.rfq_id, rfq.pr_id, rfq.material_id, rfq.awarded_vendor_id, rfq.awarded_price, rfq.rfq_status
ORDER BY MIN(rfq.rfq_date) DESC
LIMIT 5000;
`;

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

const METADATA: ComponentMetadata = {
  id: 'approved-rfqs-home',
  name: 'ApprovedRfqsHome',
  displayName: 'Approved RFQs (Home tab)',
  isDisplayComp: true,
  type: 'ApprovedRfqsHome',
  description: 'Genuinely awarded RFQs (rfq_status = Awarded), embedded on the Home "Approved RFQs" card',
  category: 'Dashboard',
  keywords: ['rfq', 'approved', 'awarded', 'procurement'],
  props: {},
};

interface ApprovedRfqsHomeComponent extends React.FC<ApprovedRfqsHomeProps> {
  Metadata: ComponentMetadata;
}

const ApprovedRfqsHome: React.FC<ApprovedRfqsHomeProps> = ({ SA_RUNTIME, onOpenRfq, activePeriod }) => {
  const [rows, setRows] = useState<ApprovedRfqRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const effectivePeriod: TimeFilter = activePeriod || 'All Time';

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await runTool<ApprovedRfqRow>(APPROVED_RFQS_QUERY, SA_RUNTIME);
        if (!cancelled) setRows(data);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load approved RFQs');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [SA_RUNTIME]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (!inTimeFilter(r.awarded_quote_date, effectivePeriod)) return false;
      if (!q) return true;
      return (
        r.rfq_id.toLowerCase().includes(q) ||
        r.pr_id.toLowerCase().includes(q) ||
        (r.material_desc || r.material_id).toLowerCase().includes(q) ||
        (r.awarded_vendor_name || r.awarded_vendor_id || '').toLowerCase().includes(q)
      );
    });
  }, [rows, search, effectivePeriod]);

  if (loading) {
    return <LoadingState height={520} message="Loading approved RFQs…" variant="skeleton" size="lg" />;
  }

  if (error) {
    return (
      <div className="bg-white rounded-xl shadow-sm border border-[#F1F5F9] p-6">
        <div className="flex items-center gap-3">
          <Icon icon="mdi:alert-circle" className="w-5 h-5 text-[#475569] flex-shrink-0" />
          <div>
            <p className="text-sm font-medium text-[#475569]">Couldn't load approved RFQs</p>
            <p className="text-xs mt-1" style={{ color: COLORS.text.secondary }}>{error}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="flex flex-col mx-auto"
      style={{ fontFamily: TYPOGRAPHY.fontFamily.primary, paddingTop: SPACING.xl, height: 'calc(100vh - 160px)', minHeight: 480, width: '82%', minWidth: 760 }}
    >
      {/* Toolbar — fixed, never scrolls */}
      <div className="flex items-center justify-between flex-wrap gap-3 mb-4 flex-shrink-0">
        <div>
          <h1 className="text-xl font-bold" style={{ color: COLORS.text.primary }}>
            Approved RFQs
          </h1>
          <p className="text-xs mt-0.5" style={{ color: COLORS.text.secondary }}>
            {filtered.length.toLocaleString('en-IN')} of {rows.length.toLocaleString('en-IN')} approved RFQs
          </p>
        </div>

        <div className="flex items-center gap-2 px-3 py-2 rounded-lg" style={{ border: `1px solid ${COLORS.borderGray}`, backgroundColor: COLORS.white }}>
          <Icon icon="mdi:magnify" className="w-4 h-4" style={{ color: COLORS.text.tertiary }} />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search RFQ ID, PR, material, supplier…"
            className="text-xs w-56"
            style={{ color: COLORS.text.primary, border: 'none', outline: 'none', boxShadow: 'none', background: 'transparent' }}
          />
        </div>
      </div>

      {/* Table — the only internally-scrolling region */}
      <div className="flex-1 min-h-0 rounded-xl overflow-auto" style={{ border: `1px solid ${TEAL.border}`, backgroundColor: COLORS.white, boxShadow: SHADOWS.card }}>
        <table className="w-full text-sm border-collapse" style={{ tableLayout: 'fixed' }}>
          <colgroup>
            <col style={{ width: '100px' }} />
            <col style={{ width: '100px' }} />
            <col />
            <col style={{ width: '160px' }} />
            <col style={{ width: '110px' }} />
            <col style={{ width: '110px' }} />
            <col style={{ width: '90px' }} />
          </colgroup>
          <thead className="sticky top-0 z-10" style={{ backgroundColor: COLORS.lightBackground }}>
            <tr>
              {['RFQ ID', 'PR ID', 'Material', 'Awarded Supplier', 'Approved Value', 'Approval Date', 'Status'].map((h) => (
                <th
                  key={h}
                  className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-wide leading-tight"
                  style={{ color: COLORS.text.secondary, borderBottom: `1px solid ${TEAL.border}` }}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((row) => (
              <tr
                key={row.rfq_id}
                onMouseEnter={() => setHoveredId(row.rfq_id)}
                onMouseLeave={() => setHoveredId((id) => (id === row.rfq_id ? null : id))}
                onClick={() => onOpenRfq({ prId: row.pr_id, rfqId: row.rfq_id })}
                className="cursor-pointer transition-colors duration-150"
                style={{ borderBottom: `1px solid ${COLORS.lightGray}`, backgroundColor: hoveredId === row.rfq_id ? TEAL.tint : 'transparent' }}
              >
                <td className="px-3 py-1.5 font-semibold truncate" style={{ color: COLORS.text.primary }}>{row.rfq_id}</td>
                <td className="px-3 py-1.5 truncate" style={{ color: COLORS.text.secondary }}>{row.pr_id}</td>
                <td className="px-3 py-1.5 truncate" style={{ color: COLORS.text.primary }}>{row.material_desc || row.material_id}</td>
                <td className="px-3 py-1.5 truncate" style={{ color: COLORS.text.secondary }}>{row.awarded_vendor_name || row.awarded_vendor_id || '—'}</td>
                <td className="px-3 py-1.5 font-medium truncate" style={{ color: COLORS.text.primary }}>{formatINR(row.awarded_price)}</td>
                <td className="px-3 py-1.5 truncate" style={{ color: COLORS.text.secondary }}>{formatDate(row.awarded_quote_date)}</td>
                <td className="px-3 py-1.5">
                  <span
                    className="px-2 py-0.5 rounded-full text-[11px] font-semibold"
                    style={{ backgroundColor: '#DCFCE7', color: '#16A34A' }}
                  >
                    {row.rfq_status}
                  </span>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-12 text-center text-sm" style={{ color: COLORS.text.tertiary }}>
                  {activePeriod && rows.length > 0 && !search
                    ? `No RFQs were approved in ${activePeriod.toLowerCase()}. Try a different period from the banner above.`
                    : 'No approved RFQs match this search.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

(ApprovedRfqsHome as ApprovedRfqsHomeComponent).Metadata = METADATA;

export default ApprovedRfqsHome;

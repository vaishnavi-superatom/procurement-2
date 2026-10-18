import React, { useEffect, useMemo, useState } from 'react';
import { Icon } from '@iconify/react';
import type { ComponentMetadata } from '../../types';
import { COLORS, TYPOGRAPHY, SPACING, SHADOWS } from '../../design-system/tokens';
import LoadingState from '../../components/LoadingState';

interface AwardDetailsProps {
  SA_RUNTIME?: any;
  /** The PR and RFQ this award belongs to — handed off from the Approved
   * RFQs list. This is a read-only view of an award that already exists;
   * it never restarts evaluation or negotiation, and never writes anything. */
  prId?: string | null;
  rfqId?: string | null;
  onBack?: () => void;
}

// Same palette as the rest of this product's procurement screens.
const TEAL = {
  base: '#0F6B64',
  dark: '#0B4F4A',
  tint: '#E6F5F3',
  border: '#D7E8E6',
};

// ============================================================
// Real data shapes. The award itself comes from purchase_orders rows linked
// to this RFQ (purchase_orders.rfq_id) — the actual recorded purchase(s),
// not a recommendation. More than one distinct vendor across those POs is a
// genuine recorded split award, read directly off real rows, never invented.
// ============================================================

interface RfqHeader {
  rfq_id: string;
  pr_id: string;
  material_id: string;
  rfq_date: string;
  response_deadline: string;
  vendors_invited: number;
  quotes_received: number;
  rfq_status: 'Awarded' | 'In Negotiation';
  negotiation_rounds: number;
}

interface PRLine {
  pr_id: string;
  material_id: string;
  requested_qty: number;
  unit_of_measure: string;
  estimated_price: number;
  required_date: string;
  requester_dept: string;
  plant_code: string;
  urgency: 'High' | 'Normal';
  material_desc: string | null;
  material_group: string | null;
}

interface AwardedPO {
  po_id: string;
  po_line_item: number;
  vendor_id: string;
  vendor_name: string | null;
  vendor_type: string | null;
  city: string | null;
  state: string | null;
  ordered_qty: number;
  unit_price: number;
  total_value: number;
  po_date: string;
  delivery_date: string | null;
  actual_delivery_date: string | null;
  po_status: 'Delivered' | 'Open';
  payment_status: 'Paid' | 'Pending';
  contract_id: string | null;
}

interface QuoteEvidence {
  vendor_id: string;
  quoted_price: number;
  delivery_days: number;
  payment_terms: string;
  warranty_months: number;
  is_technically_compliant: boolean;
  otd_pct: number | null;
  otd_trend: string | null;
  quality_acceptance_pct: number | null;
  financial_risk_tier: string | null;
  overall_risk: string | null;
  sanctions_flag: boolean | null;
  ecovadis_score: number | null;
}

const TOOL_ID = 'postgres-0fc80d2496ff_query';
const TOOL_NAME = 'Query PostgreSQL Connection';
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

async function runTool<T = any>(sql: string, params: Record<string, any> | undefined, SA_RUNTIME: any): Promise<T[]> {
  const toolExecutor = (window as any).SA?.ToolExecutor;
  if (!toolExecutor) throw new Error('ToolExecutor not available');
  const res = await toolExecutor.executeTool({
    externalTool: { toolId: TOOL_ID, toolName: TOOL_NAME, parameters: { sql, ...(params ? { params } : {}) } },
    formData: {},
    SA_RUNTIME,
  });
  const payload = res?.data ?? res;
  const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.records) ? payload.records : [];
  return rows as T[];
}

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

const RiskBadge: React.FC<{ tier: string | null }> = ({ tier }) => {
  if (!tier) return <span style={{ color: COLORS.text.tertiary }}>—</span>;
  const high = tier === 'High';
  const med = tier === 'Medium';
  return (
    <span
      className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold"
      style={{ backgroundColor: high ? '#F1F5F9' : med ? '#FFEDD5' : '#DCFCE7', color: high ? '#475569' : med ? '#EA580C' : '#16A34A' }}
    >
      {tier}
    </span>
  );
};

const METADATA: ComponentMetadata = {
  id: 'award-details',
  name: 'AwardDetails',
  displayName: 'Award details (Home tab)',
  isDisplayComp: true,
  type: 'AwardDetails',
  description: 'Read-only award details for an already-approved RFQ — awarded supplier(s), split-award breakdown, quantities, prices, and total award value, sourced from the real purchase_orders records',
  category: 'Dashboard',
  keywords: ['rfq', 'award', 'approved', 'purchase order', 'procurement'],
  props: {},
};

interface AwardDetailsComponent extends React.FC<AwardDetailsProps> {
  Metadata: ComponentMetadata;
}

const AwardDetails: React.FC<AwardDetailsProps> = ({ SA_RUNTIME, prId, rfqId, onBack }) => {
  const [header, setHeader] = useState<RfqHeader | null>(null);
  const [prLine, setPrLine] = useState<PRLine | null>(null);
  const [pos, setPos] = useState<AwardedPO[]>([]);
  const [evidence, setEvidence] = useState<QuoteEvidence[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!prId || !rfqId) return;
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        if (!SAFE_ID.test(prId) || !SAFE_ID.test(rfqId)) throw new Error('Invalid PR or RFQ id');

        const headerRows = await runTool<RfqHeader>(
          `
          SELECT rfq_id, pr_id, material_id, rfq_date, response_deadline, vendors_invited, quotes_received,
                 rfq_status, negotiation_rounds
          FROM rfq_events WHERE rfq_id = @rfqId LIMIT 1;
          `,
          { rfqId },
          SA_RUNTIME
        );
        if (cancelled) return;
        if (headerRows.length === 0) throw new Error(`No RFQ found for ${rfqId}`);
        const h = headerRows[0];
        setHeader(h);

        const [prRows, poRows, quoteRows] = await Promise.all([
          runTool<PRLine>(
            `
            SELECT pr.pr_id, pr.material_id, pr.requested_qty, pr.unit_of_measure, pr.estimated_price,
                   pr.required_date, pr.requester_dept, pr.plant_code, pr.urgency,
                   m.material_desc, m.material_group
            FROM purchase_requisitions pr
            LEFT JOIN material_master m ON m.material_id = pr.material_id
            WHERE pr.pr_id = @prId AND pr.material_id = @materialId
            LIMIT 1;
            `,
            { prId, materialId: h.material_id },
            SA_RUNTIME
          ),
          runTool<AwardedPO>(
            `
            SELECT po.po_id, po.po_line_item, po.vendor_id, v.vendor_name, v.vendor_type, v.city, v.state,
                   po.ordered_qty, po.unit_price, po.total_value, po.po_date, po.delivery_date,
                   po.actual_delivery_date, po.po_status, po.payment_status, po.contract_id
            FROM purchase_orders po
            LEFT JOIN vendor_master v ON v.vendor_id = po.vendor_id
            WHERE po.rfq_id = @rfqId
            ORDER BY po.total_value DESC;
            `,
            { rfqId },
            SA_RUNTIME
          ),
          runTool<QuoteEvidence>(
            `
            SELECT q.vendor_id, q.quoted_price, q.delivery_days, q.payment_terms, q.warranty_months,
                   q.is_technically_compliant,
                   sc.otd_pct, sc.otd_trend, sc.quality_acceptance_pct, sc.financial_risk_tier, sc.overall_risk,
                   sc.sanctions_flag, sc.ecovadis_score
            FROM quotations q
            LEFT JOIN supplier_scorecard sc ON sc.vendor_id = q.vendor_id
            WHERE q.rfq_id = @rfqId;
            `,
            { rfqId },
            SA_RUNTIME
          ),
        ]);
        if (cancelled) return;
        if (prRows.length === 0) throw new Error(`No purchase requisition line found for ${prId} / ${h.material_id}`);
        setPrLine(prRows[0]);
        setPos(poRows.filter((po) => po.po_id)); // defensive: drop any malformed row
        setEvidence(quoteRows);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load this award');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();
    return () => {
      cancelled = true;
    };
  }, [prId, rfqId, SA_RUNTIME]);

  // One line per distinct vendor actually awarded a purchase order on this
  // RFQ — more than one is a real, recorded split award (not a hypothetical
  // one), read directly off purchase_orders rather than computed/guessed.
  const awardLines = useMemo(() => {
    const map = new Map<
      string,
      { vendor_id: string; vendor_name: string | null; vendor_type: string | null; city: string | null; state: string | null; qty: number; value: number; poIds: string[]; statuses: Set<string>; paymentStatuses: Set<string>; latestPoDate: string }
    >();
    for (const po of pos) {
      if (!map.has(po.vendor_id)) {
        map.set(po.vendor_id, {
          vendor_id: po.vendor_id,
          vendor_name: po.vendor_name,
          vendor_type: po.vendor_type,
          city: po.city,
          state: po.state,
          qty: 0,
          value: 0,
          poIds: [],
          statuses: new Set(),
          paymentStatuses: new Set(),
          latestPoDate: po.po_date,
        });
      }
      const e = map.get(po.vendor_id)!;
      e.qty += Number(po.ordered_qty || 0);
      e.value += Number(po.total_value || 0);
      e.poIds.push(po.po_id);
      e.statuses.add(po.po_status);
      e.paymentStatuses.add(po.payment_status);
      if (po.po_date > e.latestPoDate) e.latestPoDate = po.po_date;
    }
    return Array.from(map.values()).sort((a, b) => b.value - a.value);
  }, [pos]);

  const totalAwardValue = useMemo(() => awardLines.reduce((s, l) => s + l.value, 0), [awardLines]);
  const isSplitAward = awardLines.length > 1;

  const evidenceByVendor = useMemo(() => new Map(evidence.map((e) => [e.vendor_id, e])), [evidence]);

  if (!prId || !rfqId) {
    return (
      <div className="bg-white rounded-xl shadow-sm border border-[#F1F5F9] p-6">
        <div className="flex items-center gap-3">
          <Icon icon="mdi:alert-circle" className="w-5 h-5 text-[#475569] flex-shrink-0" />
          <p className="text-sm" style={{ color: '#475569' }}>This award needs a PR and RFQ to open — select one from the Approved RFQs list.</p>
        </div>
      </div>
    );
  }

  if (loading) {
    return <LoadingState height={480} message="Loading award details…" variant="skeleton" size="lg" />;
  }

  if (error || !prLine || !header) {
    return (
      <div className="w-full">
        {onBack && (
          <button onClick={onBack} className="flex items-center gap-1.5 text-xs font-medium mb-4" style={{ color: TEAL.base }}>
            <Icon icon="mdi:arrow-left" className="w-4 h-4" /> Back to Approved RFQs
          </button>
        )}
        <div className="bg-white rounded-xl shadow-sm border border-[#F1F5F9] p-6">
          <div className="flex items-center gap-3">
            <Icon icon="mdi:alert-circle" className="w-5 h-5 text-[#475569] flex-shrink-0" />
            <p className="text-sm" style={{ color: '#475569' }}>{error || 'This RFQ has no recorded purchase order yet.'}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full" style={{ fontFamily: TYPOGRAPHY.fontFamily.primary, paddingTop: SPACING.xl }}>
      {onBack && (
        <button onClick={onBack} className="flex items-center gap-1.5 text-xs font-medium mb-3" style={{ color: TEAL.base }}>
          <Icon icon="mdi:arrow-left" className="w-4 h-4" /> Back to Approved RFQs
        </button>
      )}
      <div className="flex items-center gap-3 mb-3">
        <h1 className="text-xl font-bold" style={{ color: COLORS.text.primary }}>
          Award Details — {prLine.pr_id} / {header.rfq_id}
        </h1>
        <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold" style={{ backgroundColor: '#DCFCE7', color: '#16A34A' }}>
          Approved
        </span>
      </div>

      {/* PR + RFQ context — same box as the rest of this product's procurement screens */}
      <div
        className="rounded-lg px-4 py-2.5 mb-4 flex flex-wrap items-center gap-x-5 gap-y-1.5"
        style={{ backgroundColor: '#F0FDF4', border: '1px solid #BBF7D0' }}
      >
        {[
          ['PR ID', prLine.pr_id],
          ['Material', prLine.material_desc || prLine.material_id],
          ['Requested Qty', `${prLine.requested_qty} ${prLine.unit_of_measure}`],
          ['Plant', prLine.plant_code],
          ['Department', prLine.requester_dept],
          ['RFQ Date', formatDate(header.rfq_date)],
        ].map(([label, value]) => (
          <div key={label} className="flex items-baseline gap-1.5">
            <span className="text-[10px] uppercase tracking-wide" style={{ color: '#15803D' }}>{label}</span>
            <span className="text-xs font-semibold" style={{ color: '#14532D' }}>{value}</span>
          </div>
        ))}
      </div>

      {/* Award — one row per vendor actually awarded a purchase order */}
      <div className="rounded-xl overflow-hidden mb-4" style={{ border: `1px solid ${TEAL.border}`, backgroundColor: COLORS.white, boxShadow: SHADOWS.card }}>
        <div className="px-4 py-3" style={{ borderBottom: `1px solid ${TEAL.border}` }}>
          <h2 className="text-sm font-semibold" style={{ color: COLORS.text.primary }}>
            {isSplitAward ? `Split Award — ${awardLines.length} Suppliers` : 'Awarded Supplier'}
          </h2>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr style={{ backgroundColor: COLORS.lightBackground }}>
              {['Supplier', 'Awarded Qty', 'Unit Price', 'Award Value', 'Purchase Orders', 'Status'].map((h) => (
                <th key={h} className="text-left px-4 py-2 text-[11px] font-semibold uppercase tracking-wide" style={{ color: COLORS.text.secondary }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {awardLines.map((l) => (
              <tr key={l.vendor_id} style={{ borderTop: `1px solid ${COLORS.lightGray}` }}>
                <td className="px-4 py-2" style={{ color: COLORS.text.primary }}>
                  <span className="font-medium">{l.vendor_name || l.vendor_id}</span>
                  <div className="text-[11px]" style={{ color: COLORS.text.tertiary }}>
                    {[l.vendor_type, [l.city, l.state].filter(Boolean).join(', ')].filter(Boolean).join(' · ')}
                  </div>
                </td>
                <td className="px-4 py-2" style={{ color: COLORS.text.secondary }}>{l.qty}</td>
                <td className="px-4 py-2" style={{ color: COLORS.text.secondary }}>{formatINR(l.qty ? l.value / l.qty : 0)}</td>
                <td className="px-4 py-2 font-semibold" style={{ color: COLORS.text.primary }}>{formatINR(l.value)}</td>
                <td className="px-4 py-2" style={{ color: COLORS.text.secondary }}>
                  {l.poIds.join(', ')}
                  <div className="text-[11px]" style={{ color: COLORS.text.tertiary }}>{formatDate(l.latestPoDate)}</div>
                </td>
                <td className="px-4 py-2">
                  <div className="flex flex-wrap gap-1">
                    {Array.from(l.statuses).map((s) => (
                      <span key={s} className="px-1.5 py-0.5 rounded-full text-[10px] font-semibold" style={{ backgroundColor: s === 'Delivered' ? '#DCFCE7' : '#FFEDD5', color: s === 'Delivered' ? '#16A34A' : '#EA580C' }}>
                        {s}
                      </span>
                    ))}
                    {Array.from(l.paymentStatuses).map((s) => (
                      <span key={s} className="px-1.5 py-0.5 rounded-full text-[10px] font-semibold" style={{ backgroundColor: s === 'Paid' ? TEAL.tint : COLORS.lightGray, color: s === 'Paid' ? TEAL.base : COLORS.text.secondary }}>
                        {s}
                      </span>
                    ))}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="px-4 py-3 flex items-center justify-between" style={{ backgroundColor: COLORS.lightBackground }}>
          <span className="text-xs font-semibold uppercase tracking-wide" style={{ color: COLORS.text.secondary }}>Total Award Value</span>
          <p className="text-lg font-bold" style={{ color: TEAL.base }}>{formatINR(totalAwardValue)}</p>
        </div>
      </div>

      {/* Supporting evidence for the awarded supplier(s), from the real quotations on this RFQ */}
      {awardLines.some((l) => evidenceByVendor.has(l.vendor_id)) && (
        <div className="rounded-xl overflow-hidden" style={{ border: `1px solid ${TEAL.border}`, backgroundColor: COLORS.white, boxShadow: SHADOWS.card }}>
          <div className="px-4 py-3" style={{ borderBottom: `1px solid ${TEAL.border}` }}>
            <h2 className="text-sm font-semibold" style={{ color: COLORS.text.primary }}>Supporting Evidence</h2>
          </div>
          <div className="px-4 py-3 space-y-3">
            {awardLines.map((l) => {
              const q = evidenceByVendor.get(l.vendor_id);
              if (!q) return null;
              return (
                <div key={l.vendor_id}>
                  <p className="text-xs font-semibold mb-1" style={{ color: COLORS.text.primary }}>{l.vendor_name || l.vendor_id}</p>
                  <ul className="text-xs space-y-0.5 list-disc pl-4" style={{ color: COLORS.text.secondary }}>
                    <li>Quoted price: {formatINR(q.quoted_price)} · {q.is_technically_compliant ? 'Technically compliant' : 'Not marked technically compliant'}.</li>
                    <li>Delivery in {q.delivery_days} days, payment terms {q.payment_terms}, warranty {q.warranty_months} months.</li>
                    {q.otd_pct != null && <li>On-time delivery track record: {q.otd_pct}%{q.otd_trend ? ` (${q.otd_trend.toLowerCase()})` : ''}.</li>}
                    {q.financial_risk_tier && <li>Financial risk tier: {q.financial_risk_tier}.</li>}
                    {q.sanctions_flag && <li>⚠ Sanctions flag present on this vendor.</li>}
                    {q.ecovadis_score != null && <li>ESG: EcoVadis {q.ecovadis_score}.</li>}
                  </ul>
                  <div className="flex items-center gap-2 mt-1">
                    <Icon icon="mdi:chart-donut" className="w-3.5 h-3.5" style={{ color: COLORS.text.tertiary }} />
                    <span className="text-[11px]" style={{ color: COLORS.text.tertiary }}>Overall risk:</span>
                    <RiskBadge tier={q.overall_risk} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};

(AwardDetails as AwardDetailsComponent).Metadata = METADATA;

export default AwardDetails;

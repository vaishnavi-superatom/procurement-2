import React, { useEffect, useMemo, useState } from 'react';
import { Icon } from '@iconify/react';
import type { ComponentMetadata } from '../../types';
import { COLORS, TYPOGRAPHY, SPACING, SHADOWS } from '../../design-system/tokens';
import LoadingState from '../../components/LoadingState';

interface RfqApprovalHomeProps {
  SA_RUNTIME?: any;
  prId?: string | null;
  rfqId?: string | null;
  materialId?: string | null;
  vendorId?: string | null;
  onBack?: () => void;
  /** Opens the RFQ in the existing RFQs Received detail view — used by the
   * "View in Approved RFQs" link when this RFQ is already awarded. */
  onViewRfq?: (args: { prId: string; rfqId: string }) => void;
}

// Same palette as the rest of this product's procurement screens.
const TEAL = {
  base: '#3A59CD',
  dark: '#2E47A4',
  tint: '#EBEEFA',
  border: '#D8DEF5',
};

// ============================================================
// Real data shapes — same tables as ActiveNegotiations, scoped to one
// specific negotiated quote (rfq_id + vendor_id).
// ============================================================

interface PRLine {
  pr_id: string;
  material_id: string;
  requested_qty: number;
  unit_of_measure: string;
  estimated_price: number;
  plant_code: string;
  requester_dept: string;
  urgency: 'High' | 'Normal';
  material_desc: string | null;
  material_group: string | null;
  standard_price: number | null;
  primary_commodity: string | null;
}

interface RfqHeader {
  rfq_id: string;
  pr_id: string;
  material_id: string;
  rfq_date: string;
  response_deadline: string;
  rfq_status: 'RFQ Received' | 'In Negotiation' | 'Awarded';
  negotiation_rounds: number;
  awarded_vendor_id: string | null;
  awarded_price: number | null;
}

interface NegotiatedQuote {
  quote_id: string;
  rfq_id: string;
  vendor_id: string;
  vendor_name: string | null;
  vendor_type: string | null;
  city: string | null;
  state: string | null;
  quoted_price: number;
  quoted_qty: number;
  delivery_days: number;
  payment_terms: string;
  warranty_months: number;
  is_technically_compliant: boolean;
  is_awarded: boolean;
  quote_date: string;
  otd_pct: number | null;
  otd_trend: string | null;
  quality_acceptance_pct: number | null;
  financial_risk_tier: string | null;
  overall_risk: string | null;
  sanctions_flag: boolean | null;
  ecovadis_score: number | null;
  sustainability_tier: string | null;
  /** From technical evaluation (rfq_vendor_ranking). */
  t_rank: string | null;
  l_rank: string | null;
}

/** The buyer's saved pick for this vendor (rfq_supplier_selections), with the
 * recommendation it was made against. */
interface SupplierSelectionRow {
  is_deviation: boolean;
  deviation_comment: string | null;
  selected_by: string | null;
  created_at: string;
  recommended_vendor_name: string | null;
  combined_rank: string | null;
  rationale: string | null;
}

interface CommodityPriceRow {
  commodity_code: string;
  price_date: string;
  price_inr_per_unit: number;
}

//local-tool id
//const TOOL_ID = 'postgres-6a0f22831b3f_query';
//prod-tool id
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

const METADATA: ComponentMetadata = {
  id: 'rfq-approval-home',
  name: 'RfqApprovalHome',
  displayName: 'RFQ Approval (Home tab)',
  isDisplayComp: true,
  type: 'RfqApprovalHome',
  description: 'Approval view for a negotiated RFQ offer — negotiated terms, evidence, and approve/reject gated by real workflow support',
  category: 'Dashboard',
  keywords: ['rfq', 'approval', 'negotiation', 'award', 'procurement'],
  props: {},
};

interface RfqApprovalHomeComponent extends React.FC<RfqApprovalHomeProps> {
  Metadata: ComponentMetadata;
}

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

const RfqApprovalHome: React.FC<RfqApprovalHomeProps> = ({ SA_RUNTIME, prId, rfqId, materialId, vendorId, onBack, onViewRfq }) => {
  const [prLine, setPrLine] = useState<PRLine | null>(null);
  const [header, setHeader] = useState<RfqHeader | null>(null);
  const [quote, setQuote] = useState<NegotiatedQuote | null>(null);
  const [commodityPrices, setCommodityPrices] = useState<CommodityPriceRow[]>([]);
  const [selection, setSelection] = useState<SupplierSelectionRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!prId || !rfqId || !materialId || !vendorId) return;
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        if (![prId, rfqId, materialId, vendorId].every((id) => SAFE_ID.test(id))) {
          throw new Error('Invalid PR, RFQ, material, or vendor id');
        }

        const [prRows, headerRows, quoteRows, selectionRows] = await Promise.all([
          runTool<PRLine>(
            `
            SELECT pr.pr_id, pr.material_id, pr.requested_qty, pr.unit_of_measure, pr.estimated_price,
                   pr.plant_code, pr.requester_dept, pr.urgency,
                   m.material_desc, m.material_group, m.standard_price, m.primary_commodity
            FROM purchase_requisitions pr
            LEFT JOIN material_master m ON m.material_id = pr.material_id
            WHERE pr.pr_id = @prId AND pr.material_id = @materialId
            LIMIT 1;
            `,
            { prId, materialId },
            SA_RUNTIME
          ),
          runTool<RfqHeader>(
            `
            SELECT rfq_id, pr_id, material_id, rfq_date, response_deadline, rfq_status, negotiation_rounds, awarded_vendor_id, awarded_price
            FROM rfq_events WHERE rfq_id = @rfqId LIMIT 1;
            `,
            { rfqId },
            SA_RUNTIME
          ),
          runTool<NegotiatedQuote>(
            `
            SELECT q.quote_id, q.rfq_id, q.vendor_id, v.vendor_name, v.vendor_type, v.city, v.state,
                   q.quoted_price, q.quoted_qty, q.delivery_days, q.payment_terms, q.warranty_months,
                   q.is_technically_compliant, q.is_awarded, q.quote_date,
                   sc.otd_pct, sc.otd_trend, sc.quality_acceptance_pct, sc.financial_risk_tier, sc.overall_risk,
                   sc.sanctions_flag, sc.ecovadis_score, sc.sustainability_tier, rk.t_rank, rk.l_rank
            FROM quotations q
            LEFT JOIN vendor_master v ON v.vendor_id = q.vendor_id
            LEFT JOIN supplier_scorecard sc ON sc.vendor_id = q.vendor_id
            LEFT JOIN rfq_vendor_ranking rk ON rk.quote_id = q.quote_id
            WHERE q.rfq_id = @rfqId AND q.vendor_id = @vendorId
            LIMIT 1;
            `,
            { rfqId, vendorId },
            SA_RUNTIME
          ),
          // Optional context: an RFQ awarded before Select Supplier existed has none.
          runTool<SupplierSelectionRow>(
            `
            SELECT s.is_deviation, s.deviation_comment, s.selected_by, s.created_at,
                   rv.vendor_name AS recommended_vendor_name, rr.combined_rank, rr.rationale
            FROM rfq_supplier_selections s
            LEFT JOIN vendor_master rv ON rv.vendor_id = s.recommended_vendor_id
            LEFT JOIN rfq_recommendations rr ON rr.id = s.recommendation_id
            WHERE s.rfq_id = @rfqId AND s.vendor_id = @vendorId
            ORDER BY s.created_at DESC
            LIMIT 1;
            `,
            { rfqId, vendorId },
            SA_RUNTIME
          ).catch(() => [] as SupplierSelectionRow[]),
        ]);
        if (cancelled) return;
        if (prRows.length === 0) throw new Error(`No purchase requisition line found for ${prId} / ${materialId}`);
        if (quoteRows.length === 0) throw new Error(`No quotation found for vendor ${vendorId} on ${rfqId}`);
        setPrLine(prRows[0]);
        setHeader(headerRows[0] ?? null);
        setQuote(quoteRows[0]);
        setSelection(selectionRows[0] ?? null);

        const commodityCode = prRows[0].primary_commodity;
        if (commodityCode && SAFE_ID.test(commodityCode)) {
          const priceRows = await runTool<CommodityPriceRow>(
            `SELECT commodity_code, price_date, price_inr_per_unit FROM commodity_prices WHERE commodity_code = @commodityCode ORDER BY price_date DESC LIMIT 90;`,
            { commodityCode },
            SA_RUNTIME
          );
          if (!cancelled) setCommodityPrices(priceRows);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load this approval');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();
    return () => {
      cancelled = true;
    };
  }, [prId, rfqId, materialId, vendorId, SA_RUNTIME]);

  const commodityTrend = useMemo(() => {
    if (commodityPrices.length < 2) return null;
    const latest = commodityPrices[0];
    const earliest = commodityPrices[commodityPrices.length - 1];
    if (!earliest.price_inr_per_unit) return null;
    const pctChange = ((latest.price_inr_per_unit - earliest.price_inr_per_unit) / earliest.price_inr_per_unit) * 100;
    return { latest, earliest, pctChange };
  }, [commodityPrices]);

  if (!prId || !rfqId || !materialId || !vendorId) {
    return (
      <div className="bg-white rounded-xl shadow-sm border border-[#F1F5F9] p-6">
        <div className="flex items-center gap-3">
          <Icon icon="mdi:alert-circle" className="w-5 h-5 text-[#475569] flex-shrink-0" />
          <p className="text-sm" style={{ color: '#475569' }}>
            This approval needs a PR, RFQ, material, and negotiated supplier to open — proceed from an active negotiation first.
          </p>
        </div>
      </div>
    );
  }

  if (loading) {
    return <LoadingState height={480} message="Loading approval…" variant="skeleton" size="lg" />;
  }

  if (error || !prLine || !quote) {
    return (
      <div className="w-full">
        {onBack && (
          <button onClick={onBack} className="flex items-center gap-1.5 text-xs font-medium mb-4" style={{ color: TEAL.base }}>
            <Icon icon="mdi:arrow-left" className="w-4 h-4" /> Back
          </button>
        )}
        <div className="bg-white rounded-xl shadow-sm border border-[#F1F5F9] p-6">
          <div className="flex items-center gap-3">
            <Icon icon="mdi:alert-circle" className="w-5 h-5 text-[#475569] flex-shrink-0" />
            <p className="text-sm" style={{ color: '#475569' }}>{error}</p>
          </div>
        </div>
      </div>
    );
  }

  const approvedValue = prLine.requested_qty * quote.quoted_price;
  const alreadyAwarded = header?.rfq_status === 'Awarded';
  const awardedToThisVendor = alreadyAwarded && header?.awarded_vendor_id === vendorId;

  const evidence: string[] = [
    quote.t_rank
      ? `Technical bid rank ${quote.t_rank}${quote.l_rank ? `, commercial bid rank ${quote.l_rank}` : ''} (T and L are ranked independently).`
      : quote.is_technically_compliant ? 'Technically compliant with the RFQ requirements.' : 'Not marked technically compliant.',
    `Delivery in ${quote.delivery_days} days, payment terms ${quote.payment_terms}, warranty ${quote.warranty_months} months.`,
  ];
  if (quote.otd_pct != null) evidence.push(`On-time delivery track record: ${quote.otd_pct}%${quote.otd_trend ? ` (${quote.otd_trend.toLowerCase()})` : ''}.`);
  if (quote.financial_risk_tier) evidence.push(`Financial risk tier: ${quote.financial_risk_tier}.`);
  if (quote.sanctions_flag) evidence.push('⚠ Sanctions flag present on this vendor.');
  if (quote.ecovadis_score != null) evidence.push(`ESG: EcoVadis ${quote.ecovadis_score}${quote.sustainability_tier ? `, ${quote.sustainability_tier}` : ''}.`);
  if (commodityTrend) {
    const dir = commodityTrend.pctChange >= 0 ? 'up' : 'down';
    evidence.push(
      `Market reference: ${prLine.primary_commodity} price is ${dir} ${Math.abs(commodityTrend.pctChange).toFixed(1)}% over the last ${commodityPrices.length} recorded data points (${formatDate(commodityTrend.earliest.price_date)} → ${formatDate(commodityTrend.latest.price_date)}).`
    );
  }

  return (
    <div className="w-full" style={{ fontFamily: TYPOGRAPHY.fontFamily.primary, paddingTop: SPACING.xl }}>
      {onBack && (
        <button onClick={onBack} className="flex items-center gap-1.5 text-xs font-medium mb-3" style={{ color: TEAL.base }}>
          <Icon icon="mdi:arrow-left" className="w-4 h-4" /> Back
        </button>
      )}
      <h1 className="text-xl font-bold mb-3" style={{ color: COLORS.text.primary }}>
        Approval — {prLine.pr_id} / {rfqId}
      </h1>

      {/* PR + RFQ context */}
      <div
        className="rounded-lg px-4 py-2.5 mb-4 flex flex-wrap items-center gap-x-5 gap-y-1.5"
        style={{ backgroundColor: '#F0FDF4', border: '1px solid #BBF7D0' }}
      >
        {[
          ['PR ID', prLine.pr_id],
          ['Material', prLine.material_desc || prLine.material_id],
          ['Quantity', `${prLine.requested_qty} ${prLine.unit_of_measure}`],
          ['Plant', prLine.plant_code],
          ['Department', prLine.requester_dept],
          ['RFQ Status', header?.rfq_status || '—'],
        ].map(([label, value]) => (
          <div key={label} className="flex items-baseline gap-1.5">
            <span className="text-[10px] uppercase tracking-wide" style={{ color: '#15803D' }}>{label}</span>
            <span className="text-xs font-semibold" style={{ color: '#14532D' }}>{value}</span>
          </div>
        ))}
      </div>

      {alreadyAwarded && (
        <div className="rounded-lg px-4 py-3 mb-4 flex items-start justify-between gap-3" style={{ backgroundColor: TEAL.tint, border: `1px solid ${TEAL.border}` }}>
          <div className="flex items-start gap-2">
            <Icon icon="mdi:check-decagram" className="w-4 h-4 flex-shrink-0 mt-0.5" style={{ color: TEAL.base }} />
            <p className="text-xs" style={{ color: TEAL.dark }}>
              {awardedToThisVendor
                ? `This RFQ is already awarded to ${quote.vendor_name || vendorId} at ${formatINR(header?.awarded_price)}. It's already in the Approved RFQs list — nothing more to do here.`
                : `This RFQ is already awarded, to a different vendor than the one being reviewed here.`}
            </p>
          </div>
          {onViewRfq && (
            <button
              onClick={() => onViewRfq({ prId: prLine.pr_id, rfqId })}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold flex-shrink-0"
              style={{ backgroundColor: TEAL.base, color: COLORS.white }}
            >
              View in Approved RFQs
              <Icon icon="mdi:arrow-right" className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      )}

      {/* Negotiated offer */}
      <div className="rounded-xl overflow-hidden mb-4" style={{ border: `1px solid ${TEAL.border}`, backgroundColor: COLORS.white, boxShadow: SHADOWS.card }}>
        <div className="px-4 py-3" style={{ borderBottom: `1px solid ${TEAL.border}` }}>
          <h2 className="text-sm font-semibold" style={{ color: COLORS.text.primary }}>Negotiated Offer</h2>
        </div>
        <div className="px-4 py-3 flex flex-wrap items-center gap-x-6 gap-y-2">
          <div>
            <p className="text-[10px] uppercase tracking-wide" style={{ color: COLORS.text.tertiary }}>Supplier</p>
            <p className="text-sm font-semibold" style={{ color: COLORS.text.primary }}>{quote.vendor_name || quote.vendor_id}</p>
            <p className="text-[11px]" style={{ color: COLORS.text.tertiary }}>
              {[quote.vendor_type, [quote.city, quote.state].filter(Boolean).join(', ')].filter(Boolean).join(' · ')}
            </p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wide" style={{ color: COLORS.text.tertiary }}>Quoted Price</p>
            <p className="text-sm font-semibold" style={{ color: COLORS.text.primary }}>{formatINR(quote.quoted_price)}</p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wide" style={{ color: COLORS.text.tertiary }}>Quote Date</p>
            <p className="text-sm font-semibold" style={{ color: COLORS.text.primary }}>{formatDate(quote.quote_date)}</p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wide" style={{ color: COLORS.text.tertiary }}>Delivery / Payment / Warranty</p>
            <p className="text-sm font-semibold" style={{ color: COLORS.text.primary }}>
              {quote.delivery_days}d · {quote.payment_terms} · {quote.warranty_months}mo
            </p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wide" style={{ color: COLORS.text.tertiary }}>Recommended Approval Value</p>
            <p className="text-base font-bold" style={{ color: TEAL.base }}>{formatINR(approvedValue)}</p>
            <p className="text-[11px]" style={{ color: COLORS.text.tertiary }}>
              {prLine.requested_qty} {prLine.unit_of_measure} × {formatINR(quote.quoted_price)}
            </p>
          </div>
        </div>
      </div>

      {/* Why the buyer chose this supplier — the approver's main question */}
      {selection && (
        <div className="rounded-xl overflow-hidden mb-4" style={{ border: `1px solid ${TEAL.border}`, backgroundColor: COLORS.white, boxShadow: SHADOWS.card }}>
          <div className="px-4 py-3 flex items-center justify-between gap-3" style={{ borderBottom: `1px solid ${TEAL.border}` }}>
            <h2 className="text-sm font-semibold" style={{ color: COLORS.text.primary }}>Supplier Selection</h2>
            <span
              className="px-2 py-0.5 rounded-full text-[11px] font-semibold"
              style={selection.is_deviation ? { backgroundColor: '#FFEDD5', color: '#EA580C' } : { backgroundColor: TEAL.tint, color: TEAL.dark }}
            >
              {selection.is_deviation ? 'Differs from recommendation' : 'Recommended supplier'}
            </span>
          </div>
          <div className="px-4 py-3 space-y-1.5 text-xs" style={{ color: COLORS.text.secondary }}>
            {selection.is_deviation ? (
              <>
                <p>
                  Recommended:{' '}
                  <span className="font-medium" style={{ color: COLORS.text.primary }}>{selection.recommended_vendor_name || '—'}</span>
                  {selection.combined_rank && ` (${selection.combined_rank})`}
                </p>
                <p>
                  Buyer's reason: <span style={{ color: COLORS.text.primary }}>"{selection.deviation_comment}"</span>
                </p>
              </>
            ) : (
              selection.rationale && <p style={{ color: COLORS.text.primary }}>{selection.rationale}</p>
            )}
            <p className="text-[11px]" style={{ color: COLORS.text.tertiary }}>
              Selected{selection.selected_by ? ` by ${selection.selected_by}` : ''} on {formatDate(selection.created_at)}
            </p>
          </div>
        </div>
      )}

      {/* Supporting evidence */}
      <div className="rounded-xl overflow-hidden mb-4" style={{ border: `1px solid ${TEAL.border}`, backgroundColor: COLORS.white, boxShadow: SHADOWS.card }}>
        <div className="px-4 py-3" style={{ borderBottom: `1px solid ${TEAL.border}` }}>
          <h2 className="text-sm font-semibold" style={{ color: COLORS.text.primary }}>Supporting Evidence</h2>
        </div>
        <div className="px-4 py-3">
          <ul className="text-xs space-y-1 list-disc pl-4" style={{ color: COLORS.text.secondary }}>
            {evidence.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
          <div className="flex items-center gap-2 mt-2">
            <Icon icon="mdi:chart-donut" className="w-3.5 h-3.5" style={{ color: COLORS.text.tertiary }} />
            <span className="text-[11px]" style={{ color: COLORS.text.tertiary }}>Overall risk:</span>
            <RiskBadge tier={quote.overall_risk} />
          </div>
        </div>
      </div>

      {/* Approve / Reject — only enabled when the workflow actually supports writing a decision back */}
      {!alreadyAwarded && (
        <div className="rounded-xl flex items-center justify-between gap-3 px-4 py-3" style={{ border: `1px solid ${TEAL.border}`, backgroundColor: COLORS.white, boxShadow: SHADOWS.card }}>
          <p className="text-xs" style={{ color: COLORS.text.secondary }}>
            Approval isn't wired to a write-back workflow yet — there's no way to change this RFQ's status in the database from here,
            so these actions are disabled rather than faked.
          </p>
          <div className="flex items-center gap-2 flex-shrink-0">
            <button
              disabled
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold"
              style={{ backgroundColor: COLORS.lightGray, color: COLORS.text.tertiary, cursor: 'not-allowed' }}
            >
              <Icon icon="mdi:close" className="w-4 h-4" /> Reject
            </button>
            <button
              disabled
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold"
              style={{ backgroundColor: COLORS.lightGray, color: COLORS.text.tertiary, cursor: 'not-allowed' }}
            >
              <Icon icon="mdi:check" className="w-4 h-4" /> Approve
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

(RfqApprovalHome as RfqApprovalHomeComponent).Metadata = METADATA;

export default RfqApprovalHome;

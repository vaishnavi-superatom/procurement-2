import React, { useEffect, useMemo, useState } from 'react';
import { Icon } from '@iconify/react';
import type { ComponentMetadata } from '../../types';
import { COLORS, TYPOGRAPHY, SPACING, SHADOWS } from '../../design-system/tokens';
import LoadingState from '../../components/LoadingState';

interface ActiveNegotiationsProps {
  SA_RUNTIME?: any;
  /** The PR, RFQ, material and leading vendor this negotiation is for —
   * handed off from an RFQ's "Start Negotiation" button. This module has no
   * list of its own yet; it only renders once all four are known. */
  prId?: string | null;
  rfqId?: string | null;
  materialId?: string | null;
  vendorId?: string | null;
  onBack?: () => void;
  /** Fired by "Proceed to Approval", with the recommended supplier's id
   * preserved — opens the approval view for this exact PR/RFQ/supplier. */
  onProceedToApproval?: (args: { prId: string; rfqId: string; materialId: string; vendorId: string }) => void;
}

// Same palette as the rest of this product's procurement screens.
const TEAL = {
  base: '#0F6B64',
  dark: '#0B4F4A',
  tint: '#E6F5F3',
  border: '#D7E8E6',
};

// ============================================================
// Real data shapes (purchase_requisitions / material_master / rfq_events /
// quotations / vendor_master / supplier_scorecard / commodity_prices).
// ============================================================

interface PRLine {
  pr_id: string;
  material_id: string;
  requested_qty: number;
  unit_of_measure: string;
  estimated_price: number;
  total_value: number;
  required_date: string;
  requester_dept: string;
  plant_code: string;
  urgency: 'High' | 'Normal';
  material_desc: string | null;
  material_group: string | null;
  standard_price: number | null;
  primary_commodity: string | null;
  commodity_pct: number | null;
}

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
  awarded_vendor_id: string | null;
  awarded_price: number | null;
}

interface QuoteRow {
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
  otd_pct: number | null;
  otd_trend: string | null;
  quality_acceptance_pct: number | null;
  financial_risk_tier: string | null;
  overall_risk: string | null;
  sanctions_flag: boolean | null;
  ecovadis_score: number | null;
}

interface CommodityPriceRow {
  commodity_code: string;
  price_date: string;
  price_inr_per_unit: number;
  unit: string;
}

// ============================================================
// Query helpers — same ToolExecutor path as PurchaseRequests/RfqReceived.
// ============================================================

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
  id: 'active-negotiations-detail',
  name: 'ActiveNegotiations',
  displayName: 'Show negotiation detail for a PR/RFQ',
  isDisplayComp: true,
  type: 'ActiveNegotiations',
  description: 'Negotiation workspace for a specific PR/RFQ: supplier comparison, evidence-based recommendation, and pricing reference points',
  category: 'Dashboard',
  keywords: ['negotiation', 'rfq', 'supplier', 'recommendation', 'pricing', 'procurement'],
  props: {},
};

interface ActiveNegotiationsComponent extends React.FC<ActiveNegotiationsProps> {
  Metadata: ComponentMetadata;
}

const RiskBadge: React.FC<{ tier: string | null }> = ({ tier }) => {
  if (!tier) return <span style={{ color: COLORS.text.tertiary }}>—</span>;
  const high = tier === 'High';
  const med = tier === 'Medium';
  return (
    <span
      className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold"
      style={{
        backgroundColor: high ? '#F1F5F9' : med ? '#FFEDD5' : '#DCFCE7',
        color: high ? '#475569' : med ? '#EA580C' : '#16A34A',
      }}
    >
      {tier}
    </span>
  );
};

const ActiveNegotiations: React.FC<ActiveNegotiationsProps> = ({ SA_RUNTIME, prId, rfqId, materialId, vendorId, onBack, onProceedToApproval }) => {
  const [prLine, setPrLine] = useState<PRLine | null>(null);
  const [header, setHeader] = useState<RfqHeader | null>(null);
  const [quotes, setQuotes] = useState<QuoteRow[]>([]);
  const [commodityPrices, setCommodityPrices] = useState<CommodityPriceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedVendorId, setExpandedVendorId] = useState<string | null>(vendorId ?? null);
  const [openFormula, setOpenFormula] = useState<'target' | 'walkaway' | 'deal' | null>(null);

  useEffect(() => {
    setExpandedVendorId(vendorId ?? null);
  }, [vendorId, rfqId]);

  useEffect(() => {
    if (!prId || !rfqId || !materialId) return;
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        if (!SAFE_ID.test(prId) || !SAFE_ID.test(rfqId) || !SAFE_ID.test(materialId)) {
          throw new Error('Invalid PR, RFQ, or material id');
        }

        const [prRows, headerRows, quoteRows] = await Promise.all([
          runTool<PRLine>(
            `
            SELECT pr.pr_id, pr.material_id, pr.requested_qty, pr.unit_of_measure, pr.estimated_price, pr.total_value,
                   pr.required_date, pr.requester_dept, pr.plant_code, pr.urgency,
                   m.material_desc, m.material_group, m.standard_price, m.primary_commodity, m.commodity_pct
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
            SELECT rfq_id, pr_id, material_id, rfq_date, response_deadline, vendors_invited, quotes_received,
                   rfq_status, negotiation_rounds, awarded_vendor_id, awarded_price
            FROM rfq_events
            WHERE rfq_id = @rfqId
            LIMIT 1;
            `,
            { rfqId },
            SA_RUNTIME
          ),
          runTool<QuoteRow>(
            `
            SELECT q.quote_id, q.rfq_id, q.vendor_id, v.vendor_name, v.vendor_type, v.city, v.state,
                   q.quoted_price, q.quoted_qty, q.delivery_days, q.payment_terms, q.warranty_months,
                   q.is_technically_compliant, q.is_awarded,
                   sc.otd_pct, sc.otd_trend, sc.quality_acceptance_pct, sc.financial_risk_tier, sc.overall_risk, sc.sanctions_flag, sc.ecovadis_score
            FROM quotations q
            LEFT JOIN vendor_master v ON v.vendor_id = q.vendor_id
            LEFT JOIN supplier_scorecard sc ON sc.vendor_id = q.vendor_id
            WHERE q.rfq_id = @rfqId
            ORDER BY q.quoted_price ASC;
            `,
            { rfqId },
            SA_RUNTIME
          ),
        ]);
        if (cancelled) return;
        if (prRows.length === 0) throw new Error(`No purchase requisition line found for ${prId} / ${materialId}`);
        setPrLine(prRows[0]);
        setHeader(headerRows[0] ?? null);
        setQuotes(quoteRows.filter((q) => q.rfq_id === rfqId));

        const commodityCode = prRows[0].primary_commodity;
        if (commodityCode && SAFE_ID.test(commodityCode)) {
          const priceRows = await runTool<CommodityPriceRow>(
            `
            SELECT commodity_code, price_date, price_inr_per_unit, unit
            FROM commodity_prices
            WHERE commodity_code = @commodityCode
            ORDER BY price_date DESC
            LIMIT 90;
            `,
            { commodityCode },
            SA_RUNTIME
          );
          if (!cancelled) setCommodityPrices(priceRows);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load this negotiation');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();
    return () => {
      cancelled = true;
    };
  }, [prId, rfqId, materialId, SA_RUNTIME]);

  // Recommendation: ground truth if the RFQ already has an awarded quote;
  // otherwise computed from real evidence — technically compliant, then not
  // high financial risk / not sanctioned, then lowest price. A second (or
  // third) quote within 5% of the best compliant price is treated as a
  // split-award candidate rather than invented into a specific allocation.
  const { recommendedIds, basis, rankedPool } = useMemo(() => {
    const compliant = quotes.filter((q) => q.is_technically_compliant);
    const safe = compliant.filter((q) => q.financial_risk_tier !== 'High' && !q.sanctions_flag);
    const pool = safe.length > 0 ? safe : compliant.length > 0 ? compliant : quotes;
    const ranked = [...pool].sort((a, b) => a.quoted_price - b.quoted_price);

    const awarded = quotes.filter((q) => q.is_awarded);
    if (awarded.length > 0) {
      return { recommendedIds: new Set(awarded.map((q) => q.quote_id)), basis: 'awarded' as const, rankedPool: ranked };
    }
    if (ranked.length === 0) {
      return { recommendedIds: new Set<string>(), basis: 'none' as const, rankedPool: ranked };
    }
    const best = ranked[0];
    const splitCandidates = ranked.filter((q) => q.quoted_price <= best.quoted_price * 1.05);
    const chosen = splitCandidates.length > 1 ? splitCandidates : [best];
    return { recommendedIds: new Set(chosen.map((q) => q.quote_id)), basis: 'computed' as const, rankedPool: ranked };
  }, [quotes]);

  const isSplitAward = basis === 'computed' && recommendedIds.size > 1;
  const recommendedQuotes = quotes.filter((q) => recommendedIds.has(q.quote_id));
  const leadQuote = recommendedQuotes[0] || rankedPool[0] || null;

  const commodityTrend = useMemo(() => {
    if (commodityPrices.length < 2) return null;
    const latest = commodityPrices[0];
    const earliest = commodityPrices[commodityPrices.length - 1];
    if (!earliest.price_inr_per_unit) return null;
    const pctChange = ((latest.price_inr_per_unit - earliest.price_inr_per_unit) / earliest.price_inr_per_unit) * 100;
    return { latest, earliest, pctChange };
  }, [commodityPrices]);

  const reasonsFor = (q: QuoteRow): string[] => {
    const reasons: string[] = [];
    const rank = rankedPool.findIndex((r) => r.quote_id === q.quote_id);
    reasons.push(
      rank === 0
        ? `Lowest price among compliant, acceptable-risk quotes (${formatINR(q.quoted_price)}).`
        : `Within 5% of the lowest compliant quote (${formatINR(q.quoted_price)}) — considered for a split award.`
    );
    reasons.push(q.is_technically_compliant ? 'Technically compliant with the RFQ requirements.' : 'Not marked technically compliant.');
    reasons.push(`Delivery in ${q.delivery_days} days, payment terms ${q.payment_terms}, warranty ${q.warranty_months} months.`);
    if (q.otd_pct != null) reasons.push(`On-time delivery track record: ${q.otd_pct}%${q.otd_trend ? ` (${q.otd_trend.toLowerCase()})` : ''}.`);
    if (q.financial_risk_tier) reasons.push(`Financial risk tier: ${q.financial_risk_tier}.`);
    if (q.sanctions_flag) reasons.push('⚠ Sanctions flag present on this vendor.');
    if (commodityTrend) {
      const dir = commodityTrend.pctChange >= 0 ? 'up' : 'down';
      reasons.push(
        `Market reference: ${prLine?.primary_commodity} price is ${dir} ${Math.abs(commodityTrend.pctChange).toFixed(1)}% over the last ${commodityPrices.length} recorded data points (${formatDate(commodityTrend.earliest.price_date)} → ${formatDate(commodityTrend.latest.price_date)}).`
      );
    }
    return reasons;
  };

  // Pricing reference points — standard procurement negotiation methodology
  // applied to this RFQ's real data (no pre-existing formula was found
  // anywhere in this codebase to reuse instead; see each panel for the exact
  // inputs used).
  const targetPrice = prLine?.standard_price ?? null;
  const walkawayPrice = prLine?.estimated_price ?? null;
  const dealQty = prLine?.requested_qty ?? null;
  const dealUnitPrice = leadQuote?.quoted_price ?? null;
  const estimatedDealValue = dealQty != null && dealUnitPrice != null ? dealQty * dealUnitPrice : null;

  if (!prId || !rfqId || !materialId || !vendorId) {
    return (
      <div className="bg-white rounded-xl shadow-sm border border-[#F1F5F9] p-6">
        <div className="flex items-center gap-3">
          <Icon icon="mdi:alert-circle" className="w-5 h-5 text-[#475569] flex-shrink-0" />
          <p className="text-sm" style={{ color: '#475569' }}>
            This negotiation needs a PR, RFQ, material, and supplier to open — start it from "Start Negotiation" on an evaluated RFQ.
          </p>
        </div>
      </div>
    );
  }

  if (loading) {
    return <LoadingState height={520} message="Loading negotiation…" variant="skeleton" size="lg" />;
  }

  if (error || !prLine) {
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

  return (
    <div className="w-full" style={{ fontFamily: TYPOGRAPHY.fontFamily.primary, paddingTop: SPACING.xl }}>
      {onBack && (
        <button onClick={onBack} className="flex items-center gap-1.5 text-xs font-medium mb-3" style={{ color: TEAL.base }}>
          <Icon icon="mdi:arrow-left" className="w-4 h-4" /> Back
        </button>
      )}
      <h1 className="text-xl font-bold mb-3" style={{ color: COLORS.text.primary }}>
        Negotiation — {prLine.pr_id} / {header?.rfq_id || rfqId}
      </h1>

      {/* 1. PR context — compact box, same convention as PR/RFQ detail screens */}
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
          ['Urgency', prLine.urgency],
          ['Required By', formatDate(prLine.required_date)],
          ['RFQ Status', header?.rfq_status || '—'],
        ].map(([label, value]) => (
          <div key={label} className="flex items-baseline gap-1.5">
            <span className="text-[10px] uppercase tracking-wide" style={{ color: '#15803D' }}>{label}</span>
            <span className="text-xs font-semibold" style={{ color: '#14532D' }}>{value}</span>
          </div>
        ))}
      </div>

      {/* 2 & 3. Supplier comparison + recommendation */}
      <div className="rounded-xl overflow-hidden mb-4" style={{ border: `1px solid ${TEAL.border}`, backgroundColor: COLORS.white, boxShadow: SHADOWS.card }}>
        <div className="px-4 py-3" style={{ borderBottom: `1px solid ${TEAL.border}` }}>
          <h2 className="text-sm font-semibold" style={{ color: COLORS.text.primary }}>Supplier Comparison</h2>
          {basis === 'awarded' && (
            <p className="text-[11px] mt-0.5" style={{ color: COLORS.text.secondary }}>Recommendation reflects this RFQ's actual award.</p>
          )}
        </div>
        {quotes.length === 0 ? (
          <p className="px-4 py-4 text-xs" style={{ color: COLORS.text.tertiary }}>No quotations received yet for this RFQ.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr style={{ backgroundColor: COLORS.lightBackground }}>
                {['Vendor', 'Quoted Price', 'Qty', 'Delivery', 'Payment Terms', 'Warranty', 'Compliant'].map((h) => (
                  <th key={h} className="text-left px-4 py-2 text-[11px] font-semibold uppercase tracking-wide" style={{ color: COLORS.text.secondary }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {quotes.map((q) => {
                const recommended = recommendedIds.has(q.quote_id);
                const expanded = expandedVendorId === q.vendor_id;
                return (
                  <React.Fragment key={q.quote_id}>
                    <tr
                      onClick={() => recommended && setExpandedVendorId(expanded ? null : q.vendor_id)}
                      style={{
                        borderTop: `1px solid ${COLORS.lightGray}`,
                        backgroundColor: recommended ? TEAL.tint : 'transparent',
                        cursor: recommended ? 'pointer' : 'default',
                      }}
                    >
                      <td className="px-4 py-2" style={{ color: COLORS.text.primary }}>
                        <span className="font-medium">{q.vendor_name || q.vendor_id}</span>
                        {recommended && (
                          <span
                            className="ml-2 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-semibold"
                            style={{ backgroundColor: TEAL.base, color: COLORS.white }}
                          >
                            <Icon icon="mdi:star" className="w-2.5 h-2.5" /> Recommended
                            <Icon icon={expanded ? 'mdi:chevron-up' : 'mdi:chevron-down'} className="w-2.5 h-2.5" />
                          </span>
                        )}
                        <div className="text-[11px]" style={{ color: COLORS.text.tertiary }}>
                          {[q.vendor_type, [q.city, q.state].filter(Boolean).join(', ')].filter(Boolean).join(' · ')}
                        </div>
                      </td>
                      <td className="px-4 py-2 font-medium" style={{ color: COLORS.text.primary }}>{formatINR(q.quoted_price)}</td>
                      <td className="px-4 py-2" style={{ color: COLORS.text.secondary }}>{q.quoted_qty}</td>
                      <td className="px-4 py-2" style={{ color: COLORS.text.secondary }}>{q.delivery_days} days</td>
                      <td className="px-4 py-2" style={{ color: COLORS.text.secondary }}>{q.payment_terms}</td>
                      <td className="px-4 py-2" style={{ color: COLORS.text.secondary }}>{q.warranty_months} mo</td>
                      <td className="px-4 py-2">
                        <span
                          className="px-2 py-0.5 rounded-full text-[11px] font-semibold"
                          style={{
                            backgroundColor: q.is_technically_compliant ? '#DCFCE7' : '#F1F5F9',
                            color: q.is_technically_compliant ? '#16A34A' : '#475569',
                          }}
                        >
                          {q.is_technically_compliant ? 'Yes' : 'No'}
                        </span>
                      </td>
                    </tr>
                    {recommended && expanded && (
                      <tr style={{ backgroundColor: TEAL.tint }}>
                        <td colSpan={7} className="px-4 py-3">
                          <div className="flex items-start gap-2">
                            <Icon icon="mdi:lightbulb-on-outline" className="w-4 h-4 flex-shrink-0 mt-0.5" style={{ color: TEAL.base }} />
                            <div>
                              <p className="text-xs font-semibold mb-1" style={{ color: TEAL.base }}>
                                Why {q.vendor_name || q.vendor_id} is recommended
                              </p>
                              <ul className="text-xs space-y-0.5 list-disc pl-4" style={{ color: COLORS.text.secondary }}>
                                {reasonsFor(q).map((r, i) => (
                                  <li key={i}>{r}</li>
                                ))}
                              </ul>
                              <div className="flex items-center gap-2 mt-1.5">
                                <Icon icon="mdi:chart-donut" className="w-3.5 h-3.5" style={{ color: COLORS.text.tertiary }} />
                                <span className="text-[11px]" style={{ color: COLORS.text.tertiary }}>Overall risk:</span>
                                <RiskBadge tier={q.overall_risk} />
                              </div>
                            </div>
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

      {/* 4. Split award note */}
      {isSplitAward && (
        <div
          className="rounded-lg px-4 py-3 mb-4 flex items-start gap-2"
          style={{ backgroundColor: '#FFF7ED', border: '1px solid #FED7AA' }}
        >
          <Icon icon="mdi:call-split" className="w-4 h-4 flex-shrink-0 mt-0.5" style={{ color: '#C2410C' }} />
          <p className="text-xs" style={{ color: '#9A3412' }}>
            {recommendedQuotes.length} suppliers are within 5% of each other on price and both compliant with acceptable risk —{' '}
            {recommendedQuotes.map((q) => q.vendor_name || q.vendor_id).join(' and ')} could be considered for a split award to
            diversify supply risk. This data doesn't support a specific quantity split, so none is proposed — that allocation would
            need a buyer decision.
          </p>
        </div>
      )}
      {basis === 'none' && (
        <div className="rounded-lg px-4 py-3 mb-4" style={{ backgroundColor: COLORS.lightGray }}>
          <p className="text-xs" style={{ color: COLORS.text.secondary }}>
            No technically compliant quotation is available yet, so no supplier can be recommended from the current data.
          </p>
        </div>
      )}

      {/* 5 & 6. Pricing reference points */}
      <div className="rounded-xl overflow-hidden" style={{ border: `1px solid ${TEAL.border}`, backgroundColor: COLORS.white, boxShadow: SHADOWS.card }}>
        <div className="px-4 py-3" style={{ borderBottom: `1px solid ${TEAL.border}` }}>
          <h2 className="text-sm font-semibold" style={{ color: COLORS.text.primary }}>Pricing Reference Points</h2>
        </div>
        <div className="flex flex-wrap items-stretch gap-4 px-4 py-3">
          {[
            {
              key: 'target' as const,
              label: 'Target Price',
              value: targetPrice,
              formula: "Target Price = Material Standard Price — the company's own established reference (\"should-cost\") price for this material, independent of any vendor's quote.",
              input: `material_master.standard_price = ${formatINR(targetPrice)}`,
              unavailable: 'No standard price is recorded for this material.',
            },
            {
              key: 'walkaway' as const,
              label: 'Walkaway Price',
              value: walkawayPrice,
              formula: "Walkaway Price = the Purchase Requisition's Estimated Price — the per-unit price originally budgeted and approved when this requisition was raised; the ceiling before requiring re-approval.",
              input: `purchase_requisitions.estimated_price = ${formatINR(walkawayPrice)}`,
              unavailable: 'No estimated price is recorded on this requisition.',
            },
            {
              key: 'deal' as const,
              label: 'Estimated Deal Value',
              value: estimatedDealValue,
              formula: "Estimated Deal Value = Requested Quantity × the recommended supplier's Quoted Price.",
              input:
                dealQty != null && dealUnitPrice != null
                  ? `requested_qty = ${dealQty} ${prLine.unit_of_measure}  ×  quoted_price (${leadQuote?.vendor_name || leadQuote?.vendor_id || '—'}) = ${formatINR(dealUnitPrice)}`
                  : '',
              unavailable: 'No quotation is available yet to value this deal.',
            },
          ].map((m) => (
            <div key={m.key} className="min-w-[180px]">
              <div className="flex items-center gap-1.5">
                <span className="text-[11px] uppercase tracking-wide" style={{ color: COLORS.text.tertiary }}>{m.label}</span>
                <button onClick={() => setOpenFormula(openFormula === m.key ? null : m.key)} aria-label={`How ${m.label} is calculated`}>
                  <Icon icon="mdi:information-outline" className="w-3.5 h-3.5" style={{ color: TEAL.base }} />
                </button>
              </div>
              <p className="text-xl font-bold" style={{ color: m.value != null ? COLORS.text.primary : COLORS.text.tertiary }}>
                {m.value != null ? formatINR(m.value) : '—'}
              </p>
              {openFormula === m.key && (
                <div className="mt-2 p-2.5 rounded-lg text-[11px] leading-relaxed" style={{ backgroundColor: TEAL.tint, color: TEAL.dark, maxWidth: 280 }}>
                  {m.value != null ? (
                    <>
                      <p className="font-semibold mb-1">Formula</p>
                      <p className="mb-1.5">{m.formula}</p>
                      <p className="font-semibold mb-1">Inputs</p>
                      <p className="mb-1.5">{m.input}</p>
                      <p className="font-semibold mb-1">Result</p>
                      <p>{formatINR(m.value)}</p>
                    </>
                  ) : (
                    <p>{m.unavailable} Showing the limitation instead of guessing a value.</p>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Hands off the PR, RFQ, and recommended supplier to the approval view.
          Disabled when there's no recommended supplier to approve. */}
      <div
        className="rounded-xl flex items-center justify-end gap-3 px-4 py-3 mt-4"
        style={{ border: `1px solid ${TEAL.border}`, backgroundColor: COLORS.white, boxShadow: SHADOWS.card }}
      >
        <button
          disabled={!leadQuote}
          onClick={() => {
            if (!leadQuote) return;
            onProceedToApproval?.({ prId: prLine.pr_id, rfqId: rfqId!, materialId: prLine.material_id, vendorId: leadQuote.vendor_id });
          }}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold"
          style={{
            backgroundColor: leadQuote ? TEAL.base : COLORS.lightGray,
            color: leadQuote ? COLORS.white : COLORS.text.tertiary,
            cursor: leadQuote ? 'pointer' : 'not-allowed',
          }}
        >
          <Icon icon="mdi:clipboard-check-outline" className="w-4 h-4" />
          Proceed to Approval
        </button>
      </div>
    </div>
  );
};

(ActiveNegotiations as ActiveNegotiationsComponent).Metadata = METADATA;

export default ActiveNegotiations;

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@iconify/react';
import type { ComponentMetadata } from '../../types';
import { COLORS, TYPOGRAPHY, SPACING, SHADOWS } from '../../design-system/tokens';
import LoadingState from '../../components/LoadingState';
import { TRankBadge } from '../RfqReceived/TechnicalEvaluation';
import { MarketStudyPanel } from './MarketStudy';
import { RecommendationCard, SelectSupplierList } from './SupplierSelection';
import {
  getMarketStudy,
  getOnlinePrice,
  recommendSupplier,
  type MarketInputs,
  type OnlinePrice,
  type SupplierRecommendation,
} from '../../data/rfq-recommendation';
import type { SupplierSelection } from '../../data/rfq-workflow';

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
  /** Fired by "Send for Approval" with the supplier the buyer selected (and
   * saved via Select Supplier) — opens the approval view for this exact
   * PR/RFQ/supplier. */
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
  rfq_status: 'RFQ Received' | 'In Negotiation' | 'Awarded';
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
  /** From technical evaluation (rfq_vendor_ranking): T1–T4 or NOT_ACCEPTED,
   * and the price rank among the technically accepted vendors. */
  t_rank: string | null;
  l_rank: string | null;
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
  description: 'Negotiation workspace for a specific PR/RFQ: supplier comparison by technical (T) and price (L) rank, single-supplier award, and pricing reference points',
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
  // Vendors ranked "Not accepted" in technical evaluation don't negotiate.
  const [notAcceptedCount, setNotAcceptedCount] = useState(0);
  const [commodityPrices, setCommodityPrices] = useState<CommodityPriceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openFormula, setOpenFormula] = useState<'target' | 'walkaway' | 'deal' | null>(null);
  // "Proceed to Approval" opens this review in place (same loaded data, no
  // re-fetch) instead of jumping straight to the approval screen — lets the
  // buyer see the award before anything is sent forward.
  const [showAwardReview, setShowAwardReview] = useState(false);
  // The one supplier the buyer picks to award to (product review, Oct 16:
  // "ask them to pick one"). Nothing is pre-selected — there's no
  // recommendation until the buyer asks for the AI Recommendation.
  const [selectedVendorId, setSelectedVendorId] = useState<string | null>(null);
  // The pick once confirmed and saved (rfq_supplier_selections); only a saved
  // pick can go to approval.
  const [selection, setSelection] = useState<SupplierSelection | null>(null);

  // AI Recommendation: market study, online price, then the pick.
  const [studyOpen, setStudyOpen] = useState(false);
  const [market, setMarket] = useState<MarketInputs | null>(null);
  const [marketError, setMarketError] = useState<string | null>(null);
  const [online, setOnline] = useState<OnlinePrice | null>(null);
  const [onlineLoading, setOnlineLoading] = useState(false);
  const [rec, setRec] = useState<SupplierRecommendation | null>(null);
  const [recLoading, setRecLoading] = useState(false);
  const [recError, setRecError] = useState<string | null>(null);
  // Bumped per run (and per RFQ) so a slow answer from an earlier run is ignored.
  const runIdRef = useRef(0);

  useEffect(() => {
    runIdRef.current += 1;
    setShowAwardReview(false);
    setSelectedVendorId(null);
    setSelection(null);
    setStudyOpen(false);
    setMarket(null);
    setMarketError(null);
    setOnline(null);
    setOnlineLoading(false);
    setRec(null);
    setRecLoading(false);
    setRecError(null);
  }, [vendorId, rfqId]);

  /**
   * The market study (fast) and the web price search (~15–30 s) run side by
   * side; the recommendation follows once the online price is in, so it
   * reuses that cached price. `refresh` re-runs everything from scratch.
   */
  const runRecommendation = async (refresh = false) => {
    if (!rfqId) return;
    const runId = ++runIdRef.current;
    const current = () => runId === runIdRef.current;
    setStudyOpen(true);
    setRec(null);
    setRecError(null);
    setRecLoading(true);
    setOnlineLoading(true);

    if (refresh) {
      setMarket(null);
      setOnline(null);
      try {
        const result = await recommendSupplier(rfqId, SA_RUNTIME, true);
        if (!current()) return;
        setRec(result);
        setMarket(result.market);
        setOnline(result.market?.online ?? null);
        setMarketError(null);
      } catch (err) {
        if (current()) setRecError(err instanceof Error ? err.message : 'Recommendation failed');
      } finally {
        if (current()) {
          setRecLoading(false);
          setOnlineLoading(false);
        }
      }
      return;
    }

    setMarketError(null);
    getMarketStudy(rfqId, SA_RUNTIME)
      .then((study) => current() && setMarket(study.market))
      .catch((err) => current() && setMarketError(err instanceof Error ? err.message : 'Market study failed'));

    try {
      const price = await getOnlinePrice(rfqId, SA_RUNTIME);
      if (current()) setOnline(price);
    } catch (err) {
      if (current()) setOnline({ available: false, summary: `Online price search failed${err instanceof Error ? `: ${err.message}` : ''}.` });
    } finally {
      if (current()) setOnlineLoading(false);
    }
    if (!current()) return;

    try {
      const result = await recommendSupplier(rfqId, SA_RUNTIME);
      if (current()) setRec(result);
    } catch (err) {
      if (current()) setRecError(err instanceof Error ? err.message : 'Recommendation failed');
    } finally {
      if (current()) setRecLoading(false);
    }
  };

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
                   q.is_technically_compliant, q.is_awarded, rk.t_rank, rk.l_rank,
                   sc.otd_pct, sc.otd_trend, sc.quality_acceptance_pct, sc.financial_risk_tier, sc.overall_risk, sc.sanctions_flag, sc.ecovadis_score
            FROM quotations q
            LEFT JOIN vendor_master v ON v.vendor_id = q.vendor_id
            LEFT JOIN supplier_scorecard sc ON sc.vendor_id = q.vendor_id
            LEFT JOIN rfq_vendor_ranking rk ON rk.quote_id = q.quote_id
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
        const ownQuotes = quoteRows.filter((q) => q.rfq_id === rfqId);
        setQuotes(ownQuotes.filter((q) => q.t_rank !== 'NOT_ACCEPTED'));
        setNotAcceptedCount(ownQuotes.filter((q) => q.t_rank === 'NOT_ACCEPTED').length);

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

  // No built-in recommendation here: the product review (Oct 16) rejected
  // comparing on lowest price / compliance / delivery and wants nothing
  // recommended until the buyer asks for the AI Recommendation.
  const selectedQuote = quotes.find((q) => q.vendor_id === selectedVendorId) ?? null;
  const readyForApproval = !!selectedQuote && selection?.vendorId === selectedQuote.vendor_id && header?.rfq_status !== 'Awarded';

  const commodityTrend = useMemo(() => {
    if (commodityPrices.length < 2) return null;
    const latest = commodityPrices[0];
    const earliest = commodityPrices[commodityPrices.length - 1];
    if (!earliest.price_inr_per_unit) return null;
    const pctChange = ((latest.price_inr_per_unit - earliest.price_inr_per_unit) / earliest.price_inr_per_unit) * 100;
    return { latest, earliest, pctChange };
  }, [commodityPrices]);

  // Facts about the chosen supplier, shown with the award — plain record, no
  // recommendation logic.
  const factsFor = (q: QuoteRow): string[] => {
    const reasons: string[] = [];
    reasons.push(`Quoted ${formatINR(q.quoted_price)} per ${prLine?.unit_of_measure ?? 'unit'}.`);
    reasons.push(`Technical rank ${q.t_rank ?? 'not set'}${q.l_rank ? `, price rank ${q.l_rank}` : ''} (T and L are ranked independently).`);
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
  const dealUnitPrice = selectedQuote?.quoted_price ?? null;
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

  if (showAwardReview && selectedQuote && readyForApproval) {
    const awardQty = prLine.requested_qty;
    const awardValue = awardQty * selectedQuote.quoted_price;

    return (
      <div className="w-full" style={{ fontFamily: TYPOGRAPHY.fontFamily.primary, paddingTop: SPACING.xl }}>
        <button
          onClick={() => setShowAwardReview(false)}
          className="flex items-center gap-1.5 text-xs font-medium mb-3"
          style={{ color: TEAL.base }}
        >
          <Icon icon="mdi:arrow-left" className="w-4 h-4" /> Back to Negotiation
        </button>
        <h1 className="text-xl font-bold mb-3" style={{ color: COLORS.text.primary }}>
          Award Details — {prLine.pr_id} / {header?.rfq_id || rfqId}
        </h1>

        {/* PR + RFQ context — same box as the negotiation and approval screens */}
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

        {/* Award summary — the one supplier the buyer picked, for the full
            requested quantity. */}
        <div className="rounded-xl overflow-hidden mb-4" style={{ border: `1px solid ${TEAL.border}`, backgroundColor: COLORS.white, boxShadow: SHADOWS.card }}>
          <div className="px-4 py-3" style={{ borderBottom: `1px solid ${TEAL.border}` }}>
            <h2 className="text-sm font-semibold" style={{ color: COLORS.text.primary }}>Award Summary</h2>
          </div>

          <table className="w-full text-sm">
            <thead>
              <tr style={{ backgroundColor: COLORS.lightBackground }}>
                {['Vendor', 'T · L', 'Risk', 'Quoted Price', 'Award Qty', 'Award Value', ''].map((h) => (
                  <th key={h} className="text-left px-4 py-2 text-[11px] font-semibold uppercase tracking-wide" style={{ color: COLORS.text.secondary }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr style={{ borderTop: `1px solid ${COLORS.lightGray}` }}>
                <td className="px-4 py-2" style={{ color: COLORS.text.primary }}>
                  <span className="font-medium">{selectedQuote.vendor_name || selectedQuote.vendor_id}</span>
                  <div className="text-[11px]" style={{ color: COLORS.text.tertiary }}>
                    {[selectedQuote.vendor_type, [selectedQuote.city, selectedQuote.state].filter(Boolean).join(', ')].filter(Boolean).join(' · ')}
                  </div>
                </td>
                <td className="px-4 py-2 whitespace-nowrap">
                  <TRankBadge rank={selectedQuote.t_rank} />
                  {selectedQuote.l_rank && <span className="ml-1.5 text-[11px] font-semibold" style={{ color: COLORS.text.secondary }}>{selectedQuote.l_rank}</span>}
                </td>
                <td className="px-4 py-2"><RiskBadge tier={selectedQuote.overall_risk} /></td>
                <td className="px-4 py-2 font-medium" style={{ color: COLORS.text.primary }}>{formatINR(selectedQuote.quoted_price)}</td>
                <td className="px-4 py-2" style={{ color: COLORS.text.secondary }}>{awardQty} {prLine.unit_of_measure}</td>
                <td className="px-4 py-2 font-semibold" style={{ color: COLORS.text.primary }}>{formatINR(awardValue)}</td>
                <td className="px-4 py-2 text-right">
                  <button
                    disabled={awardQty <= 0}
                    onClick={() => onProceedToApproval?.({ prId: prLine.pr_id, rfqId: rfqId!, materialId: prLine.material_id, vendorId: selectedQuote.vendor_id })}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-semibold whitespace-nowrap"
                    style={{
                      backgroundColor: awardQty > 0 ? TEAL.base : COLORS.lightGray,
                      color: awardQty > 0 ? COLORS.white : COLORS.text.tertiary,
                      cursor: awardQty > 0 ? 'pointer' : 'not-allowed',
                    }}
                  >
                    <Icon icon="mdi:send-outline" className="w-3.5 h-3.5" />
                    Send for Approval
                  </button>
                </td>
              </tr>
            </tbody>
          </table>

          <div className="px-4 py-3 flex items-center justify-between" style={{ backgroundColor: COLORS.lightBackground }}>
            <span className="text-xs font-semibold uppercase tracking-wide" style={{ color: COLORS.text.secondary }}>Total Award Value</span>
            <p className="text-lg font-bold" style={{ color: TEAL.base }}>{formatINR(awardValue)}</p>
          </div>
        </div>

        {/* Why this supplier: the recommendation's reason, or the buyer's
            reason for choosing someone else (saved with the selection). */}
        {selection && selection.vendorId === selectedQuote.vendor_id && (
          <div className="rounded-xl overflow-hidden mb-4" style={{ border: `1px solid ${TEAL.border}`, backgroundColor: COLORS.white, boxShadow: SHADOWS.card }}>
            <div className="px-4 py-3 flex items-center justify-between gap-3" style={{ borderBottom: `1px solid ${TEAL.border}` }}>
              <h2 className="text-sm font-semibold" style={{ color: COLORS.text.primary }}>Supplier Selection</h2>
              <span
                className="px-2 py-0.5 rounded-full text-[11px] font-semibold"
                style={selection.isDeviation ? { backgroundColor: '#FFEDD5', color: '#EA580C' } : { backgroundColor: TEAL.tint, color: TEAL.dark }}
              >
                {selection.isDeviation ? 'Differs from recommendation' : 'Recommended supplier'}
              </span>
            </div>
            <div className="px-4 py-3 space-y-1.5 text-xs" style={{ color: COLORS.text.secondary }}>
              {selection.isDeviation ? (
                <>
                  <p>
                    Recommended:{' '}
                    <span className="font-medium" style={{ color: COLORS.text.primary }}>
                      {rec?.recommendedVendor || selection.recommendedVendorId}
                    </span>
                    {rec?.combinedRank && ` (${rec.combinedRank})`}
                  </p>
                  <p>
                    Buyer's reason: <span style={{ color: COLORS.text.primary }}>"{selection.comment}"</span>
                  </p>
                </>
              ) : (
                rec?.rationale && <p style={{ color: COLORS.text.primary }}>{rec.rationale}</p>
              )}
              <p className="text-[11px]" style={{ color: COLORS.text.tertiary }}>
                Selected{selection.selectedBy ? ` by ${selection.selectedBy}` : ''} on {formatDate(selection.createdAt)}
              </p>
            </div>
          </div>
        )}

        {/* Supporting evidence — the chosen supplier's own record */}
        <div className="rounded-xl overflow-hidden mb-4" style={{ border: `1px solid ${TEAL.border}`, backgroundColor: COLORS.white, boxShadow: SHADOWS.card }}>
          <div className="px-4 py-3" style={{ borderBottom: `1px solid ${TEAL.border}` }}>
            <h2 className="text-sm font-semibold" style={{ color: COLORS.text.primary }}>Supporting Evidence</h2>
          </div>
          <div className="px-4 py-3">
            <ul className="text-xs space-y-1 list-disc pl-4" style={{ color: COLORS.text.secondary }}>
              {factsFor(selectedQuote).map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
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

      {/* 2. Supplier comparison — T · L ranks in price order, for reading only;
          the pick happens in Select Supplier, after the recommendation. */}
      <div className="rounded-xl overflow-hidden mb-4" style={{ border: `1px solid ${TEAL.border}`, backgroundColor: COLORS.white, boxShadow: SHADOWS.card }}>
        <div className="px-4 py-3" style={{ borderBottom: `1px solid ${TEAL.border}` }}>
          <h2 className="text-sm font-semibold" style={{ color: COLORS.text.primary }}>Supplier Comparison</h2>
          <p className="text-[11px] mt-0.5" style={{ color: COLORS.text.secondary }}>
            Technically accepted vendors by quoted price (L-rank). T and L are ranked independently.
          </p>
          {notAcceptedCount > 0 && (
            <p className="text-[11px] mt-0.5" style={{ color: COLORS.text.tertiary }}>
              {notAcceptedCount} vendor{notAcceptedCount === 1 ? '' : 's'} ranked Not accepted in technical evaluation {notAcceptedCount === 1 ? 'is' : 'are'} left out.
            </p>
          )}
        </div>
        {quotes.length === 0 ? (
          <p className="px-4 py-4 text-xs" style={{ color: COLORS.text.tertiary }}>No quotations received yet for this RFQ.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr style={{ backgroundColor: COLORS.lightBackground }}>
                {['Vendor', 'Quoted Price', 'Qty', 'Delivery', 'Payment Terms', 'Warranty', 'T · L'].map((h) => (
                  <th key={h} className="text-left px-4 py-2 text-[11px] font-semibold uppercase tracking-wide" style={{ color: COLORS.text.secondary }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {quotes.map((q) => {
                const picked = selection?.vendorId === q.vendor_id;
                return (
                  <tr
                    key={q.quote_id}
                    style={{
                      borderTop: `1px solid ${COLORS.lightGray}`,
                      backgroundColor: picked ? TEAL.tint : 'transparent',
                    }}
                  >
                    <td className="px-4 py-2" style={{ color: COLORS.text.primary }}>
                      <span className="font-medium">{q.vendor_name || q.vendor_id}</span>
                      {q.is_awarded && (
                        <span
                          className="ml-2 px-1.5 py-0.5 rounded-full text-[10px] font-semibold"
                          style={{ backgroundColor: TEAL.base, color: COLORS.white }}
                        >
                          Awarded
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
                    <td className="px-4 py-2 whitespace-nowrap">
                      <TRankBadge rank={q.t_rank} />
                      {q.l_rank && <span className="ml-1.5 text-[11px] font-semibold" style={{ color: COLORS.text.secondary }}>{q.l_rank}</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {/* No recommendation until the buyer asks for one (product review, Oct 16). */}
        {quotes.length > 0 && (
          <div className="px-4 py-3 flex items-center justify-between gap-3" style={{ borderTop: `1px solid ${TEAL.border}`, backgroundColor: COLORS.lightBackground }}>
            <p className="text-[11px]" style={{ color: COLORS.text.secondary }}>
              {studyOpen
                ? 'Market study and recommendation below.'
                : 'Runs a market study (our past prices, commodity trend, online price) and recommends one supplier.'}
            </p>
            {!studyOpen && (
              <button
                onClick={() => runRecommendation()}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold flex-shrink-0"
                style={{ backgroundColor: TEAL.base, color: COLORS.white }}
              >
                <Icon icon="mdi:creation-outline" className="w-4 h-4" />
                AI Recommendation
              </button>
            )}
          </div>
        )}
      </div>

      {studyOpen && (
        <>
          <MarketStudyPanel
            market={market}
            online={online}
            onlineLoading={onlineLoading}
            error={marketError}
            vendorIds={quotes.map((q) => q.vendor_id)}
            lowestQuote={quotes[0]?.quoted_price ?? null}
          />
          <RecommendationCard rec={rec} loading={recLoading} error={recError} onRerun={() => runRecommendation(true)} />
          {rec && rec.data.length > 0 && (
            header?.rfq_status === 'Awarded' ? (
              <div className="rounded-lg px-4 py-3 mb-4 flex items-center gap-2" style={{ backgroundColor: TEAL.tint, border: `1px solid ${TEAL.border}` }}>
                <Icon icon="mdi:check-decagram" className="w-4 h-4 flex-shrink-0" style={{ color: TEAL.base }} />
                <p className="text-xs" style={{ color: TEAL.dark }}>
                  This RFQ is already awarded
                  {header.awarded_vendor_id ? ` to ${quotes.find((q) => q.vendor_id === header.awarded_vendor_id)?.vendor_name || header.awarded_vendor_id}` : ''}, so
                  there's no supplier to select.
                </p>
              </div>
            ) : (
              <SelectSupplierList
                rfqId={rfqId}
                rec={rec}
                pickedVendorId={selectedVendorId}
                onPick={setSelectedVendorId}
                selection={selection}
                onSaved={(s) => {
                  setSelection(s);
                  setSelectedVendorId(s.vendorId);
                }}
              />
            )
          )}
        </>
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
              formula: "Estimated Deal Value = Requested Quantity × the selected supplier's Quoted Price.",
              input:
                dealQty != null && dealUnitPrice != null
                  ? `requested_qty = ${dealQty} ${prLine.unit_of_measure}  ×  quoted_price (${selectedQuote?.vendor_name || selectedQuote?.vendor_id || '—'}) = ${formatINR(dealUnitPrice)}`
                  : '',
              unavailable: 'Pick a supplier in Select Supplier to value this deal.',
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

      {/* Hands off the PR, RFQ, and the selected supplier to the award review
          above. Disabled until a selection is confirmed and saved. */}
      <div
        className="rounded-xl flex items-center justify-end gap-3 px-4 py-3 mt-4"
        style={{ border: `1px solid ${TEAL.border}`, backgroundColor: COLORS.white, boxShadow: SHADOWS.card }}
      >
        {!readyForApproval && (
          <p className="text-[11px] mr-auto" style={{ color: COLORS.text.tertiary }}>
            {header?.rfq_status === 'Awarded'
              ? 'This RFQ is already awarded.'
              : 'Run the AI Recommendation, then select and confirm one supplier.'}
          </p>
        )}
        <button
          disabled={!readyForApproval}
          onClick={() => {
            if (!readyForApproval) return;
            setShowAwardReview(true);
          }}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold"
          style={{
            backgroundColor: readyForApproval ? TEAL.base : COLORS.lightGray,
            color: readyForApproval ? COLORS.white : COLORS.text.tertiary,
            cursor: readyForApproval ? 'pointer' : 'not-allowed',
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

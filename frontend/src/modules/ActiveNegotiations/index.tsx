import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@iconify/react';
import type { ComponentMetadata } from '../../types';
import { COLORS, TYPOGRAPHY, SPACING, SHADOWS } from '../../design-system/tokens';
import LoadingState from '../../components/LoadingState';
import { TRankBadge } from '../RfqReceived/TechnicalEvaluation';
import { MarketStudyPanel } from './MarketStudy';
import { AiRankBadge, LRankBadge, SelectSupplierList } from './SupplierSelection';
import { SupplierPerformance } from './SupplierPerformance';
import {
  aiRankByVendor,
  getMarketSearch,
  getMarketStudy,
  refreshMarketBenchmarks,
  getNegotiationStrategy,
  getOnlinePrice,
  RANK_HELP,
  RANK_SUBLABEL,
  recommendSupplier,
  type MarketInputs,
  type MarketSearch,
  type NegotiationStrategy,
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
  base: '#3A59CD',
  dark: '#2E47A4',
  tint: '#EBEEFA',
  border: '#D8DEF5',
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
  total_value: number;
  required_date: string;
  requester_dept: string;
  plant_code: string;
  urgency: 'High' | 'Normal';
  material_desc: string | null;
  material_group: string | null;
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
  id: 'active-negotiations-detail',
  name: 'ActiveNegotiations',
  displayName: 'Show negotiation detail for a PR/RFQ',
  isDisplayComp: true,
  type: 'ActiveNegotiations',
  description: 'Negotiation workspace for a specific PR/RFQ: supplier comparison by technical (T) and price (L) rank, system recommendation, and single-supplier award',
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

// Each step is its own box on the page, like the RFQ's (review, 19 Oct: the market study is "a new card,
// not in the old card"): the negotiation box, then the market study, then the strategy table.
const BOX_STYLE = { backgroundColor: COLORS.white, border: `1px solid ${TEAL.border}`, boxShadow: SHADOWS.card };

/** A new step below the last: a divider, then its box (the market study panel or the strategy table is the box). */
const NewStep: React.FC<{ stepRef?: React.Ref<HTMLDivElement>; children: React.ReactNode }> = ({ stepRef, children }) => (
  <div ref={stepRef} className="mt-8" style={{ scrollMarginTop: 16 }}>
    <div style={{ borderTop: `1px solid ${TEAL.border}` }} />
    <div className="mt-6">{children}</div>
  </div>
);

const ActiveNegotiations: React.FC<ActiveNegotiationsProps> = ({ SA_RUNTIME, prId, rfqId, materialId, vendorId, onBack, onProceedToApproval }) => {
  const [prLine, setPrLine] = useState<PRLine | null>(null);
  const [header, setHeader] = useState<RfqHeader | null>(null);
  const [quotes, setQuotes] = useState<QuoteRow[]>([]);
  // Vendors ranked "Not accepted" in technical evaluation don't negotiate.
  const [notAcceptedCount, setNotAcceptedCount] = useState(0);
  const [commodityPrices, setCommodityPrices] = useState<CommodityPriceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // "Proceed to Approval" opens this review in place (same loaded data, no
  // re-fetch) instead of jumping straight to the approval screen — lets the
  // buyer see the award before anything is sent forward.
  const [showAwardReview, setShowAwardReview] = useState(false);
  // The one supplier the buyer picks to award to (product review, Oct 16:
  // "ask them to pick one"). Nobody is picked when the Negotiation Strategy
  // opens; picking one shows its pointers (review, Oct 19).
  const [selectedVendorId, setSelectedVendorId] = useState<string | null>(null);
  // The pick once confirmed and saved (rfq_supplier_selections); only a saved
  // pick can go to approval.
  const [selection, setSelection] = useState<SupplierSelection | null>(null);

  // System Recommendation: market study, online price, then the pick.
  const [studyOpen, setStudyOpen] = useState(false);
  const [market, setMarket] = useState<MarketInputs | null>(null);
  const [marketError, setMarketError] = useState<string | null>(null);
  const [online, setOnline] = useState<OnlinePrice | null>(null);
  const [onlineLoading, setOnlineLoading] = useState(false);
  // Prices and suppliers per market (card ③); runs alongside, the recommendation doesn't wait for it.
  const [marketSearch, setMarketSearch] = useState<MarketSearch | null>(null);
  const [marketSearchLoading, setMarketSearchLoading] = useState(false);
  // Verified commodity benchmarks being fetched (World Bank, etc.); the study re-reads them when done.
  const [benchmarkLoading, setBenchmarkLoading] = useState(false);
  const [rec, setRec] = useState<SupplierRecommendation | null>(null);
  const [recLoading, setRecLoading] = useState(false);
  const [recError, setRecError] = useState<string | null>(null);
  // Bumped per run (and per RFQ) so a slow answer from an earlier run is ignored.
  const runIdRef = useRef(0);
  // Whether the market search is still running: a strategy built meanwhile gets its pointers again once it's in.
  const marketSearchPendingRef = useRef(false);
  const refreshPointersRef = useRef(false);
  // Negotiation Strategy (meetings, 18 Oct): five pointers per supplier, the last one the discount to ask for.
  const [strategyOpen, setStrategyOpen] = useState(false);
  const [strategy, setStrategy] = useState<NegotiationStrategy | null>(null);
  const [strategyLoading, setStrategyLoading] = useState(false);
  const [strategyError, setStrategyError] = useState<string | null>(null);
  const strategyRunRef = useRef(0);

  useEffect(() => {
    runIdRef.current += 1;
    marketSearchPendingRef.current = false;
    refreshPointersRef.current = false;
    strategyRunRef.current += 1;
    setStrategyOpen(false);
    setStrategy(null);
    setStrategyLoading(false);
    setStrategyError(null);
    setShowAwardReview(false);
    setSelectedVendorId(null);
    setSelection(null);
    setStudyOpen(false);
    setMarket(null);
    setMarketError(null);
    setOnline(null);
    setOnlineLoading(false);
    setMarketSearch(null);
    setMarketSearchLoading(false);
    setBenchmarkLoading(false);
    setRec(null);
    setRecLoading(false);
    setRecError(null);
  }, [vendorId, rfqId]);

  /**
   * The market study (fast) and the web price search (~15–30 s) run side by
   * side; the recommendation follows once the online price is in, so it
   * reuses that cached price. `refresh` re-runs everything from scratch.
   */
  const runRecommendation = async (refresh = false): Promise<SupplierRecommendation | null> => {
    if (!rfqId) return null;
    const runId = ++runIdRef.current;
    const current = () => runId === runIdRef.current;
    setStudyOpen(true);
    setRec(null);
    setRecError(null);
    setRecLoading(true);
    setOnlineLoading(true);

    // Prices and suppliers in each market: slower (about a minute), fills card ③ when done.
    setMarketSearch(null);
    setMarketSearchLoading(true);
    marketSearchPendingRef.current = true;
    getMarketSearch(rfqId, SA_RUNTIME, refresh)
      .then((found) => current() && setMarketSearch(found))
      .catch(() => current() && setMarketSearch({ available: false, profile: null, regions: [], summary: "Couldn't search the markets just now." }))
      .finally(() => {
        if (!current()) return;
        marketSearchPendingRef.current = false;
        setMarketSearchLoading(false);
      });

    // Verified commodity benchmarks: fetched only when a provider has newer data, then read into the study.
    setBenchmarkLoading(true);
    refreshMarketBenchmarks(SA_RUNTIME)
      .catch(() => null)
      .then(() => getMarketStudy(rfqId, SA_RUNTIME))
      .then((study) => {
        if (!current() || !study?.market) return;
        setMarket((prev) => (prev ? { ...prev, benchmark: study.market.benchmark, index: study.market.index } : study.market));
      })
      .catch(() => null)
      .finally(() => current() && setBenchmarkLoading(false));

    if (refresh) {
      setMarket(null);
      setOnline(null);
      try {
        const result = await recommendSupplier(rfqId, SA_RUNTIME, true);
        if (!current()) return null;
        setRec(result);
        setMarket(result.market);
        setOnline(result.market?.online ?? null);
        setMarketError(null);
        return result;
      } catch (err) {
        if (current()) setRecError(err instanceof Error ? err.message : 'Recommendation failed');
      } finally {
        if (current()) {
          setRecLoading(false);
          setOnlineLoading(false);
        }
      }
      return null;
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
    if (!current()) return null;

    try {
      const result = await recommendSupplier(rfqId, SA_RUNTIME);
      if (!current()) return null;
      setRec(result);
      return result;
    } catch (err) {
      if (current()) setRecError(err instanceof Error ? err.message : 'Recommendation failed');
    } finally {
      if (current()) setRecLoading(false);
    }
    return null;
  };

  /**
   * Five pointers for every supplier (a second or two). The table opens with nobody picked:
   * pointers show once the buyer picks a supplier (review, 19 Oct).
   */
  const runStrategy = async () => {
    if (!rfqId) return;
    const runId = ++strategyRunRef.current;
    const current = () => runId === strategyRunRef.current;
    setStrategyOpen(true);
    setStrategy(null);
    setStrategyError(null);
    setStrategyLoading(true);
    const searchPending = marketSearchPendingRef.current;
    try {
      let result = await getNegotiationStrategy(rfqId, SA_RUNTIME);
      // The market search finished meanwhile: once more, so the market price pointer can use its listings.
      if (searchPending && !marketSearchPendingRef.current) result = await getNegotiationStrategy(rfqId, SA_RUNTIME);
      if (!current()) return;
      setStrategy(result);
      // Still searching: the effect below asks again once it's in.
      refreshPointersRef.current = marketSearchPendingRef.current;
    } catch (err) {
      if (current()) setStrategyError(err instanceof Error ? err.message : 'Negotiation strategy failed');
    } finally {
      if (current()) setStrategyLoading(false);
    }
  };

  /** "Run again": a fresh market study and recommendation, then the strategy from them. */
  const rerunAll = async () => {
    const before = runIdRef.current;
    await runRecommendation(true);
    // Skipped when another run, or another RFQ, started meanwhile.
    if (runIdRef.current === before + 1) runStrategy();
  };

  // A strategy built while the market search was still running: its pointers again once the search is in,
  // so the market price pointer can use the listings. Quietly; the table stays as it is meanwhile.
  useEffect(() => {
    if (marketSearchLoading || !rfqId || !refreshPointersRef.current) return;
    refreshPointersRef.current = false;
    const runId = strategyRunRef.current;
    getNegotiationStrategy(rfqId, SA_RUNTIME)
      .then((result) => {
        if (runId !== strategyRunRef.current) return;
        setStrategy(result);
      })
      .catch(() => {
        // Keep the pointers already on screen.
      });
  }, [marketSearchLoading, rfqId, SA_RUNTIME]);

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
            SELECT pr.pr_id, pr.material_id, pr.requested_qty, pr.unit_of_measure, pr.total_value,
                   pr.required_date, pr.requester_dept, pr.plant_code, pr.urgency,
                   m.material_desc, m.material_group, m.primary_commodity, m.commodity_pct
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

  // Each step opens in view, at the top of the screen (review, 18 Oct: "if the box is half aligned, it
  // creates confusion"): this page once loaded (the home screen scrolls to it while it still loads, and the
  // RFQ above can shift it), then the market study and the strategy table as they open.
  const pageRef = useRef<HTMLDivElement>(null);
  const studyRef = useRef<HTMLDivElement>(null);
  const strategyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!loading) pageRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [loading]);
  useEffect(() => {
    if (studyOpen) studyRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [studyOpen]);
  useEffect(() => {
    if (strategyOpen) strategyRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [strategyOpen]);

  // No built-in recommendation here: the product review (Oct 16) rejected
  // comparing on lowest price / compliance / delivery and wants nothing
  // recommended until the buyer asks for the System Recommendation.
  const selectedQuote = quotes.find((q) => q.vendor_id === selectedVendorId) ?? null;
  const readyForApproval = !!selectedQuote && selection?.vendorId === selectedQuote.vendor_id && header?.rfq_status !== 'Awarded';
  // Proceed to Approval comes with the supplier table (after Run Negotiation Strategy), not before.
  const supplierTableShown = strategyOpen && header?.rfq_status !== 'Awarded' && !!rec && rec.data.length > 0;
  // Filled once the System Recommendation has run; same order as Select Supplier.
  const aiRanks = aiRankByVendor(rec);

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
    reasons.push(`Technical bid rank ${q.t_rank ?? 'not set'}${q.l_rank ? `, commercial bid rank ${q.l_rank}` : ''} (T and L are ranked independently).`);
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

          <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ backgroundColor: COLORS.lightBackground }}>
                {['Vendor', 'T-Rank', 'L-Rank', 'System Rank', 'Risk', 'Quoted Price', 'Award Qty', 'Award Value'].map((h) => (
                  <th
                    key={h}
                    title={RANK_HELP[h]}
                    className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-wide align-bottom"
                    style={{ color: COLORS.text.secondary }}
                  >
                    {h}
                    {RANK_SUBLABEL[h] && (
                      <span className="block text-[10px] font-medium normal-case tracking-normal" style={{ color: COLORS.text.tertiary }}>
                        {RANK_SUBLABEL[h]}
                      </span>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr style={{ borderTop: `1px solid ${COLORS.lightGray}` }}>
                <td className="px-3 py-2" style={{ color: COLORS.text.primary }}>
                  <span className="font-medium">{selectedQuote.vendor_name || selectedQuote.vendor_id}</span>
                  <div className="text-[11px]" style={{ color: COLORS.text.tertiary }}>
                    {[selectedQuote.vendor_type, [selectedQuote.city, selectedQuote.state].filter(Boolean).join(', ')].filter(Boolean).join(' · ')}
                  </div>
                </td>
                <td className="px-3 py-2"><TRankBadge rank={selectedQuote.t_rank} /></td>
                <td className="px-3 py-2"><LRankBadge rank={selectedQuote.l_rank} /></td>
                <td className="px-3 py-2"><AiRankBadge rank={aiRanks.get(selectedQuote.vendor_id)} /></td>
                <td className="px-3 py-2"><RiskBadge tier={selectedQuote.overall_risk} /></td>
                <td className="px-3 py-2 font-medium whitespace-nowrap tabular-nums" style={{ color: COLORS.text.primary }}>{formatINR(selectedQuote.quoted_price)}</td>
                <td className="px-3 py-2 whitespace-nowrap tabular-nums" style={{ color: COLORS.text.secondary }}>{awardQty} {prLine.unit_of_measure}</td>
                <td className="px-3 py-2 font-semibold whitespace-nowrap tabular-nums" style={{ color: COLORS.text.primary }}>{formatINR(awardValue)}</td>
              </tr>
            </tbody>
          </table>
          </div>

          <div className="px-4 py-3 flex items-center justify-between" style={{ backgroundColor: COLORS.lightBackground }}>
            <span className="text-xs font-semibold uppercase tracking-wide" style={{ color: COLORS.text.secondary }}>Total Award Value</span>
            {/* The next step sits with the total, so the table above stays narrow enough not to scroll sideways. */}
            <div className="flex items-center gap-3">
              <p className="text-lg font-bold" style={{ color: TEAL.base }}>{formatINR(awardValue)}</p>
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
            </div>
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
    <div ref={pageRef} className="w-full" style={{ fontFamily: TYPOGRAPHY.fontFamily.primary, scrollMarginTop: 24 }}>
      <div className="rounded-lg p-4" style={BOX_STYLE}>
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

      {/* 2. Supplier comparison — T-rank, L-rank and system rank as separate columns,
          in price order, for reading only; the pick happens in Select Supplier,
          after the recommendation. */}
      <div className="rounded-xl overflow-hidden mb-4" style={{ border: `1px solid ${TEAL.border}`, backgroundColor: COLORS.white, boxShadow: SHADOWS.card }}>
        <div className="px-4 py-3" style={{ borderBottom: `1px solid ${TEAL.border}` }}>
          <h2 className="text-sm font-semibold" style={{ color: COLORS.text.primary }}>Supplier Comparison</h2>
          <p className="text-[11px] mt-0.5" style={{ color: COLORS.text.secondary }}>
            Technically accepted vendors by quoted price. T-Rank (technical bid ranking) and L-Rank (commercial / price bid ranking) are ranked separately.
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
          <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ backgroundColor: COLORS.lightBackground }}>
                {['Vendor', 'Quoted Price', 'Qty', 'Delivery', 'Payment Terms', 'Warranty', 'T-Rank', 'L-Rank'].map((h) => (
                  <th
                    key={h}
                    title={RANK_HELP[h]}
                    className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-wide align-bottom"
                    style={{ color: COLORS.text.secondary }}
                  >
                    {h}
                    {RANK_SUBLABEL[h] && (
                      <span className="block text-[10px] font-medium normal-case tracking-normal" style={{ color: COLORS.text.tertiary }}>
                        {RANK_SUBLABEL[h]}
                      </span>
                    )}
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
                    <td className="px-3 py-2" style={{ color: COLORS.text.primary }}>
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
                    <td className="px-3 py-2 font-medium whitespace-nowrap tabular-nums" style={{ color: COLORS.text.primary }}>{formatINR(q.quoted_price)}</td>
                    <td className="px-3 py-2" style={{ color: COLORS.text.secondary }}>{q.quoted_qty}</td>
                    <td className="px-3 py-2 whitespace-nowrap" style={{ color: COLORS.text.secondary }}>{q.delivery_days} days</td>
                    <td className="px-3 py-2" style={{ color: COLORS.text.secondary }}>{q.payment_terms}</td>
                    <td className="px-3 py-2" style={{ color: COLORS.text.secondary }}>{q.warranty_months} mo</td>
                    <td className="px-3 py-2"><TRankBadge rank={q.t_rank} /></td>
                    <td className="px-3 py-2"><LRankBadge rank={q.l_rank} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        )}
      </div>


        {/* "Market Analysis" (review, 18 Oct), a plain button with no box or text (review, 19 Oct): it runs
            the market study, which opens as a new box below; the recommendation runs in the background. */}
        {quotes.length > 0 && !studyOpen && (
          <div className="flex justify-end">
            <button
              onClick={() => runRecommendation()}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold flex-shrink-0"
              style={{ backgroundColor: TEAL.base, color: COLORS.white }}
            >
              <Icon icon="mdi:chart-box-outline" className="w-4 h-4" />
              Market Analysis
            </button>
          </div>
        )}
      </div>

      {studyOpen && (
        <NewStep stepRef={studyRef}>
          <MarketStudyPanel
            market={market}
            online={online}
            onlineLoading={onlineLoading}
            marketSearch={marketSearch}
            marketSearchLoading={marketSearchLoading}
            benchmarkLoading={benchmarkLoading}
            error={marketError}
            quotes={quotes.map((q) => ({ vendorId: q.vendor_id, vendorName: q.vendor_name || q.vendor_id, tRank: q.t_rank, price: Number(q.quoted_price) }))}
            productName={prLine.material_desc || prLine.material_id}
          >
            {/* Delivery discipline and sustainability, at the bottom of the study; reading only, ranks untouched. */}
            {quotes.length > 0 && (
              <SupplierPerformance
                embedded
                suppliers={quotes.map((q) => ({ vendorId: q.vendor_id, vendorName: q.vendor_name || q.vendor_id, tRank: q.t_rank }))}
                runQuery={(sql, params) => runTool(sql, params, SA_RUNTIME)}
              />
            )}
          </MarketStudyPanel>
        </NewStep>
      )}

      {/* Run Negotiation Strategy: a plain button too; while the recommendation (which orders the table)
          is still running in the background it waits, and an error says so beside it. */}
      {studyOpen && !strategyOpen && (
        <div className="flex items-center justify-end gap-3">
          {recError && <span className="text-xs" style={{ color: '#475569' }}>Couldn't weigh the quotes: {recError}</span>}
          <button
            onClick={() => (recError ? runRecommendation() : runStrategy())}
            disabled={recLoading}
            title={recLoading ? 'Weighing the quotes, ranks and market study…' : undefined}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold flex-shrink-0"
            style={{
              backgroundColor: recLoading ? COLORS.lightGray : TEAL.base,
              color: recLoading ? COLORS.text.tertiary : COLORS.white,
              cursor: recLoading ? 'not-allowed' : 'pointer',
            }}
          >
            <Icon
              icon={recError ? 'mdi:refresh' : recLoading ? 'mdi:loading' : 'mdi:handshake-outline'}
              className={`w-4 h-4 ${recLoading ? 'animate-spin' : ''}`}
            />
            {recError ? 'Try again' : 'Run Negotiation Strategy'}
          </button>
        </div>
      )}

      {studyOpen && strategyOpen && (
        <NewStep stepRef={strategyRef}>
          {header?.rfq_status === 'Awarded' ? (
            <div className="rounded-lg px-4 py-3 mb-4 flex items-center gap-2" style={{ backgroundColor: TEAL.tint, border: `1px solid ${TEAL.border}` }}>
              <Icon icon="mdi:check-decagram" className="w-4 h-4 flex-shrink-0" style={{ color: TEAL.base }} />
              <p className="text-xs" style={{ color: TEAL.dark }}>
                This RFQ is already awarded
                {header.awarded_vendor_id ? ` to ${quotes.find((q) => q.vendor_id === header.awarded_vendor_id)?.vendor_name || header.awarded_vendor_id}` : ''}, so
                there's no supplier to select.
              </p>
            </div>
          ) : rec && rec.data.length > 0 ? (
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
              strategy={strategy}
              strategyLoading={strategyLoading}
              strategyError={strategyError}
              onRetryStrategy={() => runStrategy()}
            />
          ) : (
            <div
              className="rounded-xl px-4 py-3 mb-4 flex items-center justify-between gap-3"
              style={{ border: `1px solid ${TEAL.border}`, backgroundColor: COLORS.white, boxShadow: SHADOWS.card }}
            >
              <p className="text-xs" style={{ color: recError ? '#475569' : COLORS.text.secondary }}>
                {recLoading
                  ? 'Weighing the quotes, ranks and market study…'
                  : recError
                    ? `Couldn't weigh the quotes: ${recError}`
                    : rec?.rationale || 'No supplier can be recommended for this RFQ.'}
              </p>
              {recError && !recLoading && (
                <button onClick={rerunAll} className="inline-flex items-center gap-1 text-[11px] font-medium flex-shrink-0" style={{ color: TEAL.base }}>
                  <Icon icon="mdi:refresh" className="w-3.5 h-3.5" /> Try again
                </button>
              )}
            </div>
          )}
        </NewStep>
      )}

      {/* Hands off the PR, RFQ, and the selected supplier to the award review
          above. Disabled until a selection is confirmed and saved. */}
      {supplierTableShown && (
      <div
        className="rounded-xl flex items-center justify-end gap-3 px-4 py-3 mt-4"
        style={{ border: `1px solid ${TEAL.border}`, backgroundColor: COLORS.white, boxShadow: SHADOWS.card }}
      >
        {!readyForApproval && (
          <p className="text-[11px] mr-auto" style={{ color: COLORS.text.tertiary }}>
            Select and confirm one supplier to send it for approval.
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
      )}
    </div>
  );
};

(ActiveNegotiations as ActiveNegotiationsComponent).Metadata = METADATA;

export default ActiveNegotiations;

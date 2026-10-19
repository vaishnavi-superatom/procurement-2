// The backend's RFQ recommendation pipeline (direct tools in
// backend/src/tools/direct/procurement), called through the tool executor
// like any other tool.

export interface RankedVendor {
  position: number;
  vendorId: string;
  vendorName: string;
  tRank: string;
  lRank: string;
  /** 0–1: 60% price rank (L) + 40% technical rank (T). */
  score: number;
  quotedPrice: number;
  deliveryDays: number;
  paymentTerms: string;
  warrantyMonths: number;
  overallRisk: string | null;
  otdPct: number | null;
  qualityPct: number | null;
  ecovadisScore: number | null;
  vsHistoricalAvgPct: number | null;
  vsContractPct: number | null;
  vsOnlinePct: number | null;
  flags: string;
  technicalNote: string | null;
}

export interface PastSupplier {
  vendorId: string;
  vendorName: string;
  orders: number;
  lastPrice: number;
  lastDate: string;
  minPrice: number;
  maxPrice: number;
}

export interface HistoricalPrice {
  available: boolean;
  unit: string;
  lastPrice: number | null;
  lastDate: string | null;
  avg12m: number | null;
  min12m?: number | null;
  max12m?: number | null;
  /** The whole history, for materials with no order in the last 12 months. */
  minAll?: number | null;
  maxAll?: number | null;
  avgAll?: number | null;
  firstDate?: string | null;
  /** Who we bought it from, latest first. */
  pastSuppliers?: PastSupplier[];
  orders12m: number;
  totalOrders?: number;
  trend3mPct: number | null;
  series?: { month: string; avgPrice: number; orders: number }[];
  /** Every order, oldest first (latest 240), for the chart. */
  orders?: { date: string; price: number; vendorName: string }[];
  /** The RFQ's date: where its quotes sit on the chart. */
  rfqDate?: string;
  summary: string;
}

/** What the item should cost to make, per material (entered from Ashish's figures). */
export interface ShouldCost {
  available: boolean;
  shouldCost?: number;
  unit?: string;
  /** e.g. bill of materials, manpower, IP. */
  breakdown?: { label: string; amount: number }[];
  basis?: string | null;
  source?: string | null;
  updatedAt?: string | null;
  summary: string;
}

/** One priced listing found in a market, exactly as listed (own currency, before freight and duty). */
export interface MarketListing {
  source: string;
  title: string;
  price: number;
  currency: string;
  unit: string;
  meetsSpecs: 'yes' | 'nearly' | 'no' | 'unknown';
  url: string;
  /** INR listings only: far away from the quotes, so probably another spec or basis. */
  outOfRange?: boolean;
  /** The price in rupees (at the day's ECB rate for foreign listings). */
  priceInr?: number;
}

/** The listing used as the market price when India's reference search finds none: meets the specs, India first. */
export interface BestListing {
  region: string;
  source: string;
  title: string;
  url: string;
  unit: string;
  /** As listed, in its own currency. */
  price: number;
  currency: string;
  priceInr: number;
  /** Rupees per unit of the listing's currency, and the rate's date; null for INR. */
  rate: number | null;
  rateDate: string | null;
}

export interface MarketRegionResult {
  region: string;
  sites: string[];
  listings: MarketListing[];
  suppliers: { name: string; country: string; website: string | null }[];
  note: string | null;
  failed?: boolean;
}

/** Prices and suppliers per market (engineering: India, China, Europe, US; raw materials: India, Indonesia, Australia, South Africa). */
export interface MarketSearch {
  available: boolean;
  pending?: boolean;
  profile: string | null;
  regions: MarketRegionResult[];
  summary: string;
  cached?: boolean;
  bestListing?: BestListing | null;
}

export interface CommodityFeed {
  available: boolean;
  commodity?: string;
  unit?: string;
  latestPrice?: number;
  latestDate?: string;
  change90dPct?: number | null;
  exposurePct?: number | null;
  costImpact90dPct?: number | null;
  series?: { date: string; price: number }[];
  summary: string;
}

export interface OnlinePrice {
  available: boolean;
  /** Market study only: today's price hasn't been searched for yet. */
  pending?: boolean;
  priceInr?: number | null;
  unit?: string;
  range?: string | null;
  asOf?: string | null;
  /** The specific product the price is for, e.g. "Atlas Copco GA90". */
  matchedModel?: string | null;
  basis?: string;
  notes?: string | null;
  comparable?: boolean;
  outOfRange?: boolean;
  note?: string;
  /** When no price: the system's short reason for the buyer (e.g. that size is sold on quotation only). */
  noPriceReason?: string | null;
  sources?: { title: string; url: string }[];
  cached?: boolean;
  /** Set when India's reference search found no price and a market listing stands in. */
  fromListing?: BestListing;
  /** With `fromListing`: why India's reference search found no price. */
  referenceReason?: string | null;
  summary: string;
}

/** ④ EcoVadis per quoting vendor (Not accepted vendors included; filter by the ranking). */
export interface Sustainability {
  available: boolean;
  vendors: { vendorId: string; vendorName: string; ecovadisScore: number | string | null; sustainabilityTier: string | null }[];
  summary: string;
}

/** ⑤ Our rate contracts for the material. */
export interface ContractBenchmark {
  available: boolean;
  activeContracts?: { contractId: string; vendorId: string; vendorName: string; price: number; endDate: string }[];
  expiredContracts?: number;
  bestActivePrice?: number | null;
  quotingVendorsWithContract?: { vendorId: string; vendorName: string; price: number }[];
  summary: string;
}

export interface MarketInputs {
  /** Missing in recommendations saved before 18 Oct. */
  shouldCost?: ShouldCost;
  historical: HistoricalPrice;
  commodity: CommodityFeed;
  online: OnlinePrice;
  sustainability: Sustainability;
  contract: ContractBenchmark;
}

export interface MarketStudy {
  data: RankedVendor[];
  unit: string;
  market: MarketInputs;
}

/** One headed point of the reason: Pricing, Technical, Delivery or Risk. */
export interface RecommendationPoint {
  heading: string;
  text: string;
}

export interface SupplierRecommendation {
  data: RankedVendor[];
  unit: string;
  recommendedVendorId: string | null;
  recommendedVendor: string | null;
  /** e.g. "L1, T2" */
  combinedRank: string | null;
  /** One sentence on why (the award review and approval pages show it). */
  rationale: string | null;
  /** The reason as four headed points, shown on the card; empty when no supplier can be recommended. */
  points?: RecommendationPoint[];
  considerations: string[];
  /** 'ai', or the plain score when the model was unavailable. */
  recommendationSource: string;
  model: string | null;
  agreesWithScore: boolean;
  /** 0.6 / 0.4 */
  weights: { price: number; technical: number };
  market: MarketInputs;
  recommendationId: number;
  createdAt: string;
  reused: boolean;
}

/** One supplier's negotiation strategy: five pointers from our data, the last one the discount to ask for. */
export interface VendorStrategy {
  vendorId: string;
  vendorName: string;
  quotedPrice: number;
  tRank: string | null;
  lRank: string | null;
  /** Side heading + text, e.g. "Market price", "Market trend", "Delivery record", "Ask". */
  pointers: RecommendationPoint[];
  ask: { pct: number; targetPrice: number; saving: number | null; basis: string };
}

export interface NegotiationStrategy {
  rfqId: string;
  unit: string;
  quantity: number | null;
  vendors: VendorStrategy[];
  createdAt: string;
}

/**
 * The system's order, used by Select Supplier and the System Rank column: the
 * recommended vendor first, then the rest by combined score.
 */
export function aiRanking(rec: SupplierRecommendation): RankedVendor[] {
  const first = rec.data.filter((v) => v.vendorId === rec.recommendedVendorId);
  const rest = rec.data.filter((v) => v.vendorId !== rec.recommendedVendorId).sort((a, b) => b.score - a.score || a.position - b.position);
  return [...first, ...rest];
}

/** vendorId → system rank (1 = recommended); empty until the System Recommendation has run. */
export const aiRankByVendor = (rec: SupplierRecommendation | null): Map<string, number> =>
  new Map((rec ? aiRanking(rec) : []).map((v, i) => [v.vendorId, i + 1]));

/** Header tooltips for the rank columns: T and L are separate ranks, not one combined value. */
export const RANK_HELP: Record<string, string> = {
  'T-Rank': 'Technical rank from evaluation: T1 meets every requirement comfortably, T4 has a small deviation',
  'L-Rank': 'Price rank among technically accepted vendors: L1 is the lowest price',
  'System Rank': 'Order from the System Recommendation: 1 is the recommended vendor, the rest follow by combined score (60% price, 40% technical)',
};

// The slice of the global tool executor (data/tool-executor.ts) this file uses.
interface ToolExecutorLike {
  executeTool(args: {
    externalTool: { toolId: string; toolName: string; parameters: Record<string, unknown> };
    formData: Record<string, unknown>;
    SA_RUNTIME?: unknown;
  }): Promise<{ data?: unknown } | undefined>;
}

async function runDirectTool<T>(toolId: string, toolName: string, parameters: Record<string, unknown>, SA_RUNTIME: unknown): Promise<T> {
  const toolExecutor = (window as unknown as { SA?: { ToolExecutor?: ToolExecutorLike } }).SA?.ToolExecutor;
  if (!toolExecutor) throw new Error('ToolExecutor not available');
  const res = await toolExecutor.executeTool({ externalTool: { toolId, toolName, parameters }, formData: {}, SA_RUNTIME });
  return (res?.data ?? res) as T;
}

/** Our past prices, the commodity trend and today's online price if already found. Fast. */
export const getMarketStudy = (rfqId: string, SA_RUNTIME: unknown): Promise<MarketStudy> =>
  runDirectTool('get-rfq-market-study', 'Get RFQ Market Study', { rfqId, includeSeries: true }, SA_RUNTIME);

/** Searches the web for the material's current price (~15–30 s; cached for the day). */
export const getOnlinePrice = (rfqId: string, SA_RUNTIME: unknown): Promise<OnlinePrice> =>
  runDirectTool('get-rfq-online-price', 'Get RFQ Online Market Price', { rfqId }, SA_RUNTIME);

/** Prices and suppliers in several markets (~30–90 s; cached for the day). */
export const getMarketSearch = (rfqId: string, SA_RUNTIME: unknown, refresh = false): Promise<MarketSearch> =>
  runDirectTool('get-rfq-market-search', 'Get RFQ Market Prices by Region', { rfqId, ...(refresh ? { refresh: true } : {}) }, SA_RUNTIME);

async function strategyTool(parameters: Record<string, unknown>, SA_RUNTIME: unknown): Promise<NegotiationStrategy> {
  const res = await runDirectTool<NegotiationStrategy & { error?: string }>('get-rfq-negotiation-strategy', 'Get RFQ Negotiation Strategy', parameters, SA_RUNTIME);
  if (res?.error || !Array.isArray(res?.vendors)) throw new Error(res?.error || 'no negotiation strategy came back');
  return res;
}

/** Five pointers for every supplier, the last one the discount to ask for: our data only, a second or two. */
export const getNegotiationStrategy = (rfqId: string, SA_RUNTIME: unknown): Promise<NegotiationStrategy> => strategyTool({ rfqId }, SA_RUNTIME);

/** Picks one supplier with the reason. `refresh` runs a fresh study, web search included. */
export const recommendSupplier = (rfqId: string, SA_RUNTIME: unknown, refresh = false): Promise<SupplierRecommendation> =>
  runDirectTool('recommend-rfq-supplier', 'Recommend RFQ Supplier', { rfqId, includeSeries: true, ...(refresh ? { refresh: true } : {}) }, SA_RUNTIME);

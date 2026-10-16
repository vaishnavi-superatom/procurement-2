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

export interface HistoricalPrice {
  available: boolean;
  unit: string;
  lastPrice: number | null;
  lastDate: string | null;
  avg12m: number | null;
  orders12m: number;
  trend3mPct: number | null;
  series?: { month: string; avgPrice: number; orders: number }[];
  summary: string;
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
  /** When no price: the AI's short reason for the buyer (e.g. that size is sold on quotation only). */
  noPriceReason?: string | null;
  sources?: { title: string; url: string }[];
  cached?: boolean;
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

export interface SupplierRecommendation {
  data: RankedVendor[];
  unit: string;
  recommendedVendorId: string | null;
  recommendedVendor: string | null;
  /** e.g. "L1, T2" */
  combinedRank: string | null;
  rationale: string | null;
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

/** Picks one supplier with the reason. `refresh` runs a fresh study, web search included. */
export const recommendSupplier = (rfqId: string, SA_RUNTIME: unknown, refresh = false): Promise<SupplierRecommendation> =>
  runDirectTool('recommend-rfq-supplier', 'Recommend RFQ Supplier', { rfqId, includeSeries: true, ...(refresh ? { refresh: true } : {}) }, SA_RUNTIME);

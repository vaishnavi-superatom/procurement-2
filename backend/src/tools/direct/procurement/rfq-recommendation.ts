/**
 * System Recommendation for an RFQ in negotiation (TODO.md §3), as direct
 * tools. The MainAgent can call them from chat, and the screens call them
 * through the tool executor like any other tool.
 *
 *   1. RFQ facts       eligible vendors with T/L ranks, quote terms, scorecard
 *   2. Market study    should cost (once entered), historical price, commodity feed,
 *                      online reference price (OpenRouter web search), sustainability
 *                      (EcoVadis) and our rate-contract benchmark
 *   3. Score           60% L-rank / 40% T-rank; price vs benchmarks is shown, not weighted
 *   4. Recommendation  the model picks one eligible vendor and explains why; falls
 *                      back to the step-3 top pick when it fails or misbehaves
 *   5. Save            snapshot to rfq_recommendations
 *
 * Also the negotiation strategy (meeting, 18 Oct): per supplier, five pointers from
 * the same data, the last one the discount to ask for.
 *
 * Tables it writes (source writeMode must be at least 'dml'), created once in
 * the procurement DB:
 *
 *   CREATE TABLE public.rfq_recommendations (
 *     id serial PRIMARY KEY, rfq_id text NOT NULL,
 *     recommended_vendor_id text, recommended_quote_id text, combined_rank text, rationale text,
 *     considerations jsonb NOT NULL DEFAULT '[]', source text NOT NULL, model text,
 *     points jsonb NOT NULL DEFAULT '[]',  -- added 16 Oct: the four headed points shown on screen
 *     ranking jsonb NOT NULL, market jsonb NOT NULL, created_by text,
 *     created_at timestamptz NOT NULL DEFAULT now()
 *   );
 *   CREATE INDEX idx_rfq_recommendations_rfq ON public.rfq_recommendations (rfq_id, created_at);
 *
 *   CREATE TABLE public.market_reference_prices (
 *     id serial PRIMARY KEY, material_id text NOT NULL, query text NOT NULL, result jsonb NOT NULL,
 *     model text, fetched_on date NOT NULL DEFAULT CURRENT_DATE, created_at timestamptz NOT NULL DEFAULT now()
 *   );
 *   CREATE INDEX idx_market_reference_prices_material ON public.market_reference_prices (material_id, fetched_on);
 *
 * Read only, and not created yet: the should cost per material, which Ashish
 * provides (meeting, 18 Oct). Until the table exists the study reports
 * "no should cost entered".
 *
 *   CREATE TABLE public.material_should_costs (
 *     id serial PRIMARY KEY, material_id text NOT NULL,
 *     should_cost numeric NOT NULL,           -- per unit, INR
 *     unit text,                              -- the material's unit when empty
 *     breakdown jsonb NOT NULL DEFAULT '[]',  -- [{"label": "Bill of materials", "amount": 812000}, ...]
 *     basis text, source text,                -- e.g. "ex-works"; who gave the figure, and when
 *     updated_by text, updated_at timestamptz NOT NULL DEFAULT now()
 *   );
 *   CREATE INDEX idx_material_should_costs_material ON public.material_should_costs (material_id, updated_at);
 */

import { LLM, getRequestContext } from '@superatomai/sdk-node';
import type { SourceTool } from '../../../sources/core/types';
import type { ExecuteFn } from '../index';

const RECOMMENDATION_MODEL = process.env.SA_RECOMMENDATION_MODEL || 'openrouter/typesafe/jev-router';
// ':online' turns on OpenRouter's web search for the request.
const MARKET_SEARCH_MODEL = process.env.SA_MARKET_SEARCH_MODEL || 'openrouter/typesafe/jev-router:online';
const FALLBACK_MODEL = process.env.SA_RECOMMENDATION_FALLBACK_MODEL || 'openrouter/anthropic/claude-haiku-4.5';

// Proposed in the product discussion (price 60 / technical 40); pending sign-off.
const PRICE_WEIGHT = 0.6;
const TECH_WEIGHT = 0.4;
const T_SCORE: Record<string, number> = { T1: 1, T2: 0.75, T3: 0.5, T4: 0.25 };

const SEARCH_TIMEOUT_MS = 90_000;
// Per model attempt in the market search, so a market with one fallback stays near 90 s.
const MARKET_SEARCH_TIMEOUT_MS = 45_000;
const RECOMMEND_TIMEOUT_MS = 45_000;

const RFQ_ID = /^[A-Za-z0-9_-]{1,50}$/;

// ============================================================
// Shapes
// ============================================================

interface RfqFacts {
	rfqId: string;
	prId: string;
	rfqDate: string;
	rfqStatus: string;
	materialId: string;
	materialDesc: string;
	materialGroup: string;
	materialSubgroup: string;
	unit: string;
	standardPrice: number | null;
	primaryCommodity: string | null;
	commodityPct: number | null;
	requestedQty: number | null;
	plantCode: string | null;
	urgency: string | null;
}

interface VendorQuote {
	quoteId: string;
	vendorId: string;
	vendorName: string;
	quotedPrice: number;
	quotedQty: number;
	deliveryDays: number | null;
	paymentTerms: string | null;
	warrantyMonths: number | null;
	tRank: string | null;
	lRank: string | null;
	eligible: boolean;
	technicalNote: string | null;
	otdPct: number | null;
	qualityPct: number | null;
	overallRisk: string | null;
	financialRiskTier: string | null;
	sanctionsFlag: boolean;
	ecovadisScore: number | null;
	sustainabilityTier: string | null;
}

interface RankedVendor extends VendorQuote {
	position: number;
	score: number;
	priceScore: number;
	techScore: number;
	vsHistoricalAvgPct: number | null;
	vsContractPct: number | null;
	vsOnlinePct: number | null;
	flags: string[];
}

/** Runs SQL on the bound source and returns plain rows. */
type Run = (sql: string, params?: Record<string, unknown>) => Promise<any[]>;

const runner = (execute: ExecuteFn): Run => async (sql, params) => {
	const result = await execute({ sql, params: params as Record<string, any> | undefined });
	return Array.isArray(result) ? result : (result?.data ?? result?.rows ?? []);
};

// ============================================================
// Helpers
// ============================================================

const num = (v: unknown): number | null => (v === null || v === undefined || v === '' || isNaN(Number(v)) ? null : Number(v));
const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;
const pct = (a: number, b: number | null | undefined) => (b ? round((a / b - 1) * 100, 1) : null);
const inr = (v: number) => '₹' + Math.round(v).toLocaleString('en-IN');
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Shortens model text at a sentence end rather than mid-word ("7.5 bar" and "e.g." are not sentence ends). */
function clipToSentence(text: string, max: number): string {
	if (text.length <= max) return text;
	const cut = text.slice(0, max);
	let end = -1;
	for (const m of cut.matchAll(/[.!?](?=\s)/g)) {
		if (!/(?:e\.g|i\.e)\.$/i.test(cut.slice(Math.max(0, m.index! - 3), m.index! + 1))) end = m.index!;
	}
	return end > max / 3 ? cut.slice(0, end + 1) : cut.replace(/\s+\S*$/, '') + '…';
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s`)), ms);
	});
	return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/** JSON from the first model that answers; tries each in order. */
async function askJson(label: string, messages: { sys: string; user: string }, models: string[], maxTokens: number, timeoutMs: number): Promise<{ data: any; model: string }> {
	let lastError: unknown = new Error('no model tried');
	for (const model of models) {
		try {
			const data = await withTimeout(LLM.stream(messages, { model, maxTokens, temperature: 0 }, true), timeoutMs, `${label} (${model})`);
			if (data && typeof data === 'object') return { data, model };
			lastError = new Error(`${model} returned no JSON`);
		} catch (e) {
			lastError = e;
			console.warn(`[RFQ-RECOMMENDATION] ${label} failed on ${model}: ${errMsg(e)}`);
		}
	}
	throw lastError;
}

// ============================================================
// Step 1 — RFQ facts
// ============================================================

async function loadRfqFacts(run: Run, rfqId: string): Promise<{ rfq: RfqFacts; vendors: VendorQuote[]; requirements: any[] }> {
	const [r] = await run(`
		SELECT r.rfq_id, r.pr_id, r.rfq_date::text AS rfq_date, r.rfq_status, r.material_id,
		       m.material_desc, m.material_group, m.material_subgroup, m.unit_of_measure, m.standard_price,
		       m.primary_commodity, m.commodity_pct, pr.requested_qty, pr.plant_code, pr.urgency
		FROM rfq_events r
		JOIN material_master m ON m.material_id = r.material_id
		LEFT JOIN purchase_requisitions pr ON pr.pr_id = r.pr_id AND pr.material_id = r.material_id
		WHERE r.rfq_id = @rfqId
		LIMIT 1`, { rfqId });
	if (!r) throw new Error(`RFQ ${rfqId} not found`);

	const rfq: RfqFacts = {
		rfqId: r.rfq_id, prId: r.pr_id, rfqDate: r.rfq_date, rfqStatus: r.rfq_status, materialId: r.material_id,
		materialDesc: r.material_desc, materialGroup: r.material_group, materialSubgroup: r.material_subgroup,
		unit: r.unit_of_measure, standardPrice: num(r.standard_price), primaryCommodity: r.primary_commodity || null,
		commodityPct: num(r.commodity_pct), requestedQty: num(r.requested_qty), plantCode: r.plant_code, urgency: r.urgency,
	};

	const rows = await run(`
		SELECT v.quote_id, v.vendor_id, vm.vendor_name, v.quoted_price, q.quoted_qty, q.delivery_days, q.payment_terms,
		       q.warranty_months, v.t_rank, v.l_rank, v.eligible_for_negotiation, e.suggestion_reason,
		       sc.otd_pct, sc.quality_acceptance_pct, sc.overall_risk, sc.financial_risk_tier, sc.sanctions_flag,
		       sc.ecovadis_score, sc.sustainability_tier
		FROM rfq_vendor_ranking v
		JOIN quotations q ON q.quote_id = v.quote_id
		JOIN vendor_master vm ON vm.vendor_id = v.vendor_id
		LEFT JOIN rfq_technical_evaluations e ON e.quote_id = v.quote_id
		LEFT JOIN supplier_scorecard sc ON sc.vendor_id = v.vendor_id
		WHERE v.rfq_id = @rfqId
		ORDER BY v.quoted_price`, { rfqId });

	const vendors: VendorQuote[] = rows.map((v: any) => ({
		quoteId: v.quote_id, vendorId: v.vendor_id, vendorName: v.vendor_name, quotedPrice: Number(v.quoted_price),
		quotedQty: Number(v.quoted_qty), deliveryDays: num(v.delivery_days), paymentTerms: v.payment_terms,
		warrantyMonths: num(v.warranty_months), tRank: v.t_rank, lRank: v.l_rank, eligible: v.eligible_for_negotiation === true,
		technicalNote: v.suggestion_reason, otdPct: num(v.otd_pct), qualityPct: num(v.quality_acceptance_pct),
		overallRisk: v.overall_risk, financialRiskTier: v.financial_risk_tier, sanctionsFlag: v.sanctions_flag === true,
		ecovadisScore: num(v.ecovadis_score), sustainabilityTier: v.sustainability_tier,
	}));

	const requirements = await run(`
		SELECT parameter, required_value, comparison, is_mandatory
		FROM pr_technical_requirements
		WHERE pr_id = @prId AND material_id = @materialId
		ORDER BY sort_order`, { prId: rfq.prId, materialId: rfq.materialId });

	return { rfq, vendors, requirements };
}

// ============================================================
// Step 2 — market inputs
// ============================================================

/**
 * What the item should cost to make (bill of materials, manpower, IP and the
 * rest), per material; Ashish provides the figures (meeting, 18 Oct). See the
 * material_should_costs table above.
 */
async function shouldCost(run: Run, rfq: RfqFacts) {
	const none = { available: false, summary: 'No should cost entered for this material yet.' };
	try {
		const [table] = await run(`SELECT to_regclass('public.material_should_costs') IS NOT NULL AS ready`);
		if (table?.ready !== true) return none;
		const [r] = await run(`
			SELECT should_cost, unit, breakdown, basis, source, updated_at::text AS updated_at
			FROM material_should_costs
			WHERE material_id = @materialId
			ORDER BY updated_at DESC
			LIMIT 1`, { materialId: rfq.materialId });
		const value = num(r?.should_cost);
		if (value === null) return none;
		const unit = r.unit || rfq.unit;
		const breakdown = (Array.isArray(r.breakdown) ? r.breakdown : [])
			.filter((b: any) => typeof b?.label === 'string' && num(b?.amount) !== null)
			.map((b: any) => ({ label: b.label as string, amount: round(Number(b.amount)) }));
		return {
			available: true,
			shouldCost: round(value),
			unit,
			breakdown,
			basis: r.basis ?? null,
			source: r.source ?? null,
			updatedAt: r.updated_at ?? null,
			summary: `Should cost ${inr(value)}/${unit}${r.source ? ` (${r.source})` : ''}.`,
		};
	} catch (e) {
		// The rest of the study still stands without it.
		console.warn(`[RFQ-RECOMMENDATION] should cost for ${rfq.materialId} unavailable: ${errMsg(e)}`);
		return none;
	}
}

/** ① What we have paid for this material before the RFQ. */
async function historicalPrice(run: Run, rfq: RfqFacts) {
	const rows = await run(`
		SELECT po.po_date::text AS po_date, po.unit_price, po.vendor_id, v.vendor_name
		FROM purchase_orders po
		LEFT JOIN vendor_master v ON v.vendor_id = po.vendor_id
		WHERE po.material_id = @materialId AND po.po_date < CAST(@rfqDate AS date)
		ORDER BY po.po_date`, { materialId: rfq.materialId, rfqDate: rfq.rfqDate });
	const orders = rows.map((r: any) => ({
		date: r.po_date as string,
		price: Number(r.unit_price),
		vendorId: r.vendor_id as string,
		vendorName: (r.vendor_name as string | null) ?? r.vendor_id,
	}));
	const rfqTime = Date.parse(rfq.rfqDate);
	const daysBefore = (d: string) => (rfqTime - Date.parse(d)) / 86_400_000;
	const last12 = orders.filter(o => daysBefore(o.date) <= 365);
	const avg = (xs: { price: number }[]) => (xs.length ? xs.reduce((s, x) => s + x.price, 0) / xs.length : null);
	const recent = avg(last12.filter(o => daysBefore(o.date) <= 90));
	const prior = avg(last12.filter(o => daysBefore(o.date) > 90 && daysBefore(o.date) <= 180));

	const byMonth = new Map<string, number[]>();
	for (const o of orders.filter(o => daysBefore(o.date) <= 730)) {
		const k = o.date.slice(0, 7);
		byMonth.set(k, [...(byMonth.get(k) ?? []), o.price]);
	}
	// Who we bought it from (meeting, 16 Oct: "who are the suppliers in past?"): latest supplier first.
	const bySupplier = new Map<string, { vendorId: string; vendorName: string; orders: number; lastPrice: number; lastDate: string; minPrice: number; maxPrice: number }>();
	for (const o of orders) { // oldest first, so the last write per supplier is its latest order
		const s = bySupplier.get(o.vendorId);
		bySupplier.set(o.vendorId, {
			vendorId: o.vendorId,
			vendorName: o.vendorName,
			orders: (s?.orders ?? 0) + 1,
			lastPrice: round(o.price),
			lastDate: o.date,
			minPrice: round(Math.min(s?.minPrice ?? o.price, o.price)),
			maxPrice: round(Math.max(s?.maxPrice ?? o.price, o.price)),
		});
	}
	const pastSuppliers = [...bySupplier.values()].sort((a, b) => b.lastDate.localeCompare(a.lastDate)).slice(0, 8);

	const last = orders[orders.length - 1];
	const avg12m = avg(last12);
	return {
		available: orders.length > 0,
		unit: rfq.unit,
		lastPrice: last ? round(last.price) : null,
		lastDate: last?.date ?? null,
		avg12m: avg12m !== null ? round(avg12m) : null,
		min12m: last12.length ? round(Math.min(...last12.map(o => o.price))) : null,
		max12m: last12.length ? round(Math.max(...last12.map(o => o.price))) : null,
		// The whole history, for materials with no order in the last 12 months.
		minAll: orders.length ? round(Math.min(...orders.map(o => o.price))) : null,
		maxAll: orders.length ? round(Math.max(...orders.map(o => o.price))) : null,
		avgAll: orders.length ? round(avg(orders)!) : null,
		firstDate: orders[0]?.date ?? null,
		pastSuppliers,
		orders12m: last12.length,
		totalOrders: orders.length,
		trend3mPct: recent !== null && prior !== null ? pct(recent, prior) : null,
		standardPrice: rfq.standardPrice,
		series: [...byMonth.entries()].map(([month, ps]) => ({ month, avgPrice: round(ps.reduce((s, p) => s + p, 0) / ps.length), orders: ps.length })),
		// Every order for the chart, not monthly averages (meeting, 18 Oct: "increase the number of data points"); latest 240.
		orders: orders.slice(-240).map(o => ({ date: o.date, price: round(o.price), vendorName: o.vendorName })),
		rfqDate: rfq.rfqDate,
		summary: orders.length === 0
			? `No previous purchase orders for this material; standard price is ${rfq.standardPrice ? inr(rfq.standardPrice) : 'not set'}.`
			: avg12m !== null
				? `12-month average ${inr(avg12m)}/${rfq.unit} across ${last12.length} order(s); last paid ${inr(last.price)} on ${last.date}.`
				: `Last paid ${inr(last.price)}/${rfq.unit} on ${last.date} (no orders in the 12 months before this RFQ).`,
	};
}

/** ② The material's main commodity, from the market feed. */
async function commodityFeed(run: Run, rfq: RfqFacts) {
	if (!rfq.primaryCommodity) return { available: false, summary: 'No commodity linked to this material.' };
	const rows = await run(`
		SELECT price_date::text AS price_date, price_inr_per_unit, unit, source
		FROM commodity_prices
		WHERE commodity_code = @code AND price_date <= CURRENT_DATE AND price_date > CURRENT_DATE - 365
		ORDER BY price_date`, { code: rfq.primaryCommodity });
	if (!rows.length) return { available: false, commodity: rfq.primaryCommodity, summary: `No recent ${rfq.primaryCommodity} prices.` };

	const series = rows.map((r: any) => ({ date: r.price_date as string, price: Number(r.price_inr_per_unit) }));
	const latest = series[series.length - 1];
	const back = (days: number) => {
		const cutoff = Date.parse(latest.date) - days * 86_400_000;
		return [...series].reverse().find(p => Date.parse(p.date) <= cutoff) ?? series[0];
	};
	const change30dPct = pct(latest.price, back(30).price);
	const change90dPct = pct(latest.price, back(90).price);
	const change365dPct = pct(latest.price, series[0].price);
	const exposure = rfq.commodityPct;
	const impactPct = change90dPct !== null && exposure !== null ? round(change90dPct * exposure, 1) : null;
	const unit = rows[0].unit;
	return {
		available: true,
		commodity: rfq.primaryCommodity,
		unit,
		source: rows[0].source,
		latestPrice: round(latest.price),
		latestDate: latest.date,
		change30dPct,
		change90dPct,
		change365dPct,
		exposurePct: exposure !== null ? round(exposure * 100, 0) : null,
		costImpact90dPct: impactPct,
		series,
		summary: `${rfq.primaryCommodity} at ${inr(latest.price)} ${unit} (${latest.date}), ${change90dPct! >= 0 ? '+' : ''}${change90dPct}% over 90 days`
			+ (impactPct !== null && exposure
				? `; with ${round(exposure * 100, 0)}% exposure that is about ${impactPct >= 0 ? '+' : ''}${impactPct}% on this material's cost.`
				: '.'),
	};
}

const PRICE_SEARCH_PROMPT =
	'You find current market reference prices for industrial procurement in India, using the web search results provided. '
	+ 'Respond with JSON only: {"price_inr": number or null, "unit": string, "range": string or null, "as_of": string or null, '
	+ '"matched_model": string or null, "basis": string, "notes": string or null, "comparable_to_delivered_quotes": boolean, '
	+ '"no_price_reason": string or null, "sources": [{"title": string, "url": string}]}. '
	+ 'Marketplace listings (IndiaMART, Aajjo, TradeIndia, Moglix) and manufacturer or dealer pages count, but only when the listing itself '
	+ 'states specs that meet, or nearly meet, every one of the buyer\'s required specs: name it in "matched_model" (brand and model) and say in '
	+ '"notes" how close it is. Do NOT use a price for a product series or range ("starting from", "flow up to 500 m³/h"), a listing that does '
	+ 'not state the key specs, or a different size or grade; mention such listings in "notes" and return price_inr null. A wrong price is worse than none. '
	+ '"unit" is just the unit, e.g. "MT" or "EA". '
	+ '"basis" is a short phrase of at most 12 words saying what the price is (e.g. "marketplace listing, delivery included" or '
	+ '"mine-head notified price, excludes freight and taxes"); put any detail in "notes" (at most 2 sentences). '
	+ '"comparable_to_delivered_quotes" is true only if the price is on a delivered or landed basis like a supplier quote. '
	+ 'Use null when the results do not give a reliable price for this material and grade. Never invent numbers or URLs. '
	+ '"no_price_reason": when price_inr is null, at most 2 short plain sentences (under 45 words) saying what the search found and what it did not, '
	+ 'naming the requirement that made the difference, e.g. "The search found listings only for smaller units (up to about 4 m³/min); none meets '
	+ 'the 20 m³/min your PR asks for." Report only what these results show; never claim a price does not exist anywhere. null when a price is given.';

/**
 * One web search for a price (OpenRouter web search via the ':online' model).
 * The search runs on the user message, so it stays a plain query; `specs` go
 * to the instructions for judging whether a listing matches.
 */
const searchPrice = (query: string, specs?: string) =>
	// Generous token budget: the router may pick a reasoning model, which
	// spends part of it thinking and otherwise cuts the JSON short.
	askJson('online price', {
		sys: PRICE_SEARCH_PROMPT + (specs ? ` The buyer's required specs: ${specs}.` : ''),
		user: query,
	}, [MARKET_SEARCH_MODEL, FALLBACK_MODEL + ':online'], 2000, SEARCH_TIMEOUT_MS);

/**
 * Specific products that meet the PR's specs, as a short search query for their
 * listed prices. Null for commodities and generic materials (no model names).
 */
async function candidateModels(rfq: RfqFacts, specs: string): Promise<{ models: string[]; query: string } | null> {
	try {
		const { data } = await askJson('candidate models', {
			sys: 'Name up to 3 specific products sold in India (brand and model) that meet the given specifications, for a price search. '
				+ 'Respond with JSON only: {"models": [string], "search_query": string or null}. "search_query" is a short web search '
				+ '(under 15 words) for their listed prices in INR in India, e.g. "Atlas Copco GA90 air compressor price India". '
				+ 'For commodities or generic materials with no model names, return {"models": [], "search_query": null}.',
			user: `${rfq.materialSubgroup}; specs: ${specs}`,
		}, [RECOMMENDATION_MODEL, FALLBACK_MODEL], 600, 30_000);
		const models = (Array.isArray(data.models) ? data.models : []).filter((m: unknown) => typeof m === 'string' && m.trim()).slice(0, 3);
		const search = typeof data.search_query === 'string' ? data.search_query.trim().slice(0, 150) : '';
		if (!models.length || !search) return null;
		return { models, query: search };
	} catch (e) {
		console.warn(`[RFQ-RECOMMENDATION] candidate models failed: ${errMsg(e)}`);
		return null;
	}
}

/** The PR specs that decide the grade (mandatory or exact-match), for search queries and spec checks. */
function keySpecs(requirements: any[]): string {
	return requirements
		.filter((r: any) => r.is_mandatory || r.comparison === 'exact')
		.slice(0, 4)
		.map((r: any) => `${r.parameter} ${r.required_value}`)
		.join('; ');
}

/** ③ Current market price found on the web, cached per material per day. */
async function onlineReferencePrice(run: Run, rfq: RfqFacts, requirements: any[], opts: { refresh?: boolean; cachedOnly?: boolean } = {}) {
	if (rfq.materialGroup === 'Services') {
		return { available: false, summary: 'No public market price for services.' };
	}
	if (!opts.refresh) {
		// The market search's daily row shares this table; skip it.
		const [hit] = await run(`
			SELECT result, model, created_at FROM market_reference_prices
			WHERE material_id = @materialId AND fetched_on = CURRENT_DATE AND query <> @marketKey
			ORDER BY created_at DESC LIMIT 1`, { materialId: rfq.materialId, marketKey: MARKET_SEARCH_KEY });
		if (hit) return { ...hit.result, model: hit.model, fetchedAt: hit.created_at, cached: true };
	}
	if (opts.cachedOnly) return { available: false, pending: true, summary: 'Not fetched yet today.' };

	// Search for the right grade: the key specs from the PR go into the query.
	const specs = keySpecs(requirements);
	let query = `${rfq.materialSubgroup} (${rfq.materialDesc})${specs ? `, specs: ${specs}` : ''}. Price per ${rfq.unit} in INR, India.`;

	try {
		let { data, model } = await searchPrice(query, specs);
		// A generic query can miss listings that exist under a model name (e.g. an
		// "Atlas Copco GA90" on a marketplace), so when it finds nothing, ask for
		// specific models that meet the specs and search for those.
		if (!(num(data.price_inr)! > 0) && specs) {
			const candidates = await candidateModels(rfq, specs);
			if (candidates) {
				const second = await searchPrice(candidates.query, specs);
				const secondFound = num(second.data.price_inr)! > 0;
				console.log(`[RFQ-RECOMMENDATION] ${rfq.materialId}: no price for the material query; searched "${candidates.query}" `
					+ `(${candidates.models.join(', ')}): ${secondFound ? `found ₹${second.data.price_inr}` : 'nothing'}`);
				if (secondFound || !data.no_price_reason) {
					({ data, model } = second);
					query = candidates.query;
				}
			}
		}

		const price = num(data.price_inr);
		const sources = (Array.isArray(data.sources) ? data.sources : [])
			.filter((s: any) => typeof s?.url === 'string' && /^https?:\/\//.test(s.url))
			.slice(0, 5)
			.map((s: any) => ({ title: String(s.title ?? s.url).slice(0, 200), url: s.url }));
		// Models sometimes answer "INR per metric tonne" for the unit; keep just the unit.
		const unit = typeof data.unit === 'string' && data.unit.trim()
			? data.unit.replace(/^\s*(INR|₹|Rs\.?)?\s*(per|\/)\s*/i, '').trim() || rfq.unit
			: rfq.unit;
		const basis = typeof data.basis === 'string' && data.basis.trim() ? data.basis.trim().slice(0, 160) : 'basis not stated';
		const found = price !== null && price > 0;
		// The buyer-facing reason when there's no price: what the search found instead.
		const noPriceReason = !found && typeof data.no_price_reason === 'string' && data.no_price_reason.trim()
			? clipToSentence(data.no_price_reason.trim(), 400)
			: null;
		const result = {
			available: found,
			priceInr: price !== null && price > 0 ? round(price) : null,
			unit,
			range: typeof data.range === 'string' ? data.range : null,
			asOf: typeof data.as_of === 'string' ? data.as_of : null,
			matchedModel: found && typeof data.matched_model === 'string' && data.matched_model.trim() ? data.matched_model.trim().slice(0, 120) : null,
			basis,
			notes: typeof data.notes === 'string' ? data.notes.slice(0, 400) : null,
			comparable: data.comparable_to_delivered_quotes === true,
			noPriceReason,
			sources,
			query,
			summary: found
				? `${inr(price!)} per ${unit} (${basis}).`
				: noPriceReason ?? 'No reliable online price found for this material and grade.',
		};
		await run(`
			INSERT INTO market_reference_prices (material_id, query, result, model)
			VALUES (@materialId, @query, CAST(@result AS jsonb), @model)`,
			{ materialId: rfq.materialId, query, result: JSON.stringify(result), model });
		return { ...result, model, fetchedAt: new Date().toISOString(), cached: false };
	} catch (e) {
		return { available: false, error: errMsg(e), query, summary: 'Online price search failed.' };
	}
}

/**
 * A web price far outside the quoted range means either a different
 * specification or basis (e.g. a small drive vs an HD drive) or quotes that
 * need a second look, so it is kept for context but never compared against them.
 */
function checkOnlineAgainstQuotes(online: any, vendors: VendorQuote[]) {
	if (!online?.available || !online.priceInr) return online;
	const prices = vendors.filter(v => v.eligible).map(v => v.quotedPrice).sort((a, b) => a - b);
	if (!prices.length) return online;
	const ratio = online.priceInr / prices[Math.floor(prices.length / 2)];
	if (ratio >= 1 / 3 && ratio <= 3) return { ...online, outOfRange: false };
	return {
		...online,
		comparable: false,
		outOfRange: true,
		note: `About ${ratio < 1 ? round(1 / ratio, 1) + '× below' : round(ratio, 1) + '× above'} the quoted prices: either a different specification or basis, `
			+ 'or the quotes need checking. Shown for context, not compared.',
	};
}

// ============================================================
// Market search by region (meeting, 16 Oct): prices from several sources and,
// where no price is published, the suppliers in each market. Same web search
// as the online price; a search API restricted to these sites can replace
// `searchRegion` later without changing the rest.
// ============================================================

/** Key of the market search's daily row in market_reference_prices (online price rows hold their search text). */
const MARKET_SEARCH_KEY = 'market-search';

interface MarketRegion {
	region: string;
	sites: string[];
}

// Different products need different sources (meeting: "for engineering products
// one thing; coal and all you want different thing altogether").
const MARKET_PROFILES: Record<'engineering' | 'rawMaterials' | 'packaging', MarketRegion[]> = {
	engineering: [
		{ region: 'India', sites: ['indiamart.com', 'tradeindia.com', 'moglix.com', 'industrybuying.com', 'amazon.in'] },
		{ region: 'China', sites: ['alibaba.com', 'globalsources.com', 'made-in-china.com'] },
		{ region: 'Europe', sites: ['directindustry.com', 'europages.com'] },
		{ region: 'United States', sites: ['globalspec.com', 'thomasnet.com', 'grainger.com'] },
	],
	rawMaterials: [
		{ region: 'India', sites: ['indiamart.com', 'tradeindia.com', 'coalindia.in'] },
		{ region: 'Indonesia', sites: ['alibaba.com', 'tradewheel.com'] },
		{ region: 'Australia', sites: ['tradingeconomics.com', 'alibaba.com'] },
		{ region: 'South Africa', sites: ['tradingeconomics.com', 'alibaba.com'] },
	],
	packaging: [
		{ region: 'India', sites: ['indiamart.com', 'tradeindia.com'] },
		{ region: 'China', sites: ['alibaba.com', 'made-in-china.com'] },
		{ region: 'Europe', sites: ['europages.com'] },
	],
};

function marketProfileOf(rfq: RfqFacts): { name: string; regions: MarketRegion[] } | null {
	if (rfq.materialGroup === 'Services') return null;
	if (rfq.materialGroup === 'Raw Materials') return { name: 'raw materials', regions: MARKET_PROFILES.rawMaterials };
	if (rfq.materialGroup === 'Packaging') return { name: 'packaging', regions: MARKET_PROFILES.packaging };
	return { name: 'engineering', regions: MARKET_PROFILES.engineering };
}

const marketSearchPrompt = (region: string, sites: string[], specs: string) =>
	`You research one product's market in ${region} for an industrial buyer in India, using the web search results provided. `
	+ 'Respond with JSON only: {"listings": [{"source": string, "title": string, "price": number or null, "currency": string, "unit": string, '
	+ '"meets_specs": "yes" | "nearly" | "no" | "unknown", "url": string}], "suppliers": [{"name": string, "country": string, "website": string or null}], '
	+ '"note": string or null}. '
	+ `"listings": up to 5 offers from ${region} that state a price; copy the price and currency exactly as listed (do not convert); `
	+ '"source" is the site name, "unit" just the unit (e.g. "piece", "MT"), and "meets_specs" compares the listing\'s stated specs with the buyer\'s. '
	+ `"suppliers": up to 6 manufacturers or distributors that sell this product in ${region}, whether or not they show a price. `
	+ `Prefer these sites: ${sites.join(', ')}. `
	+ (specs ? `The buyer's required specs: ${specs}. ` : '')
	+ 'Never invent prices, names or URLs; use empty lists when the results show none. "note": one short plain sentence on what the results show, or null.';

const CURRENCY_ALIASES: Record<string, string> = {
	'₹': 'INR', RS: 'INR', 'RS.': 'INR', INR: 'INR',
	'$': 'USD', 'US$': 'USD', USD: 'USD',
	'€': 'EUR', EUR: 'EUR',
	'¥': 'CNY', RMB: 'CNY', CNY: 'CNY',
	'£': 'GBP', GBP: 'GBP',
	'A$': 'AUD', AUD: 'AUD',
	ZAR: 'ZAR', IDR: 'IDR',
};
const currencyOf = (raw: unknown): string => {
	const c = String(raw ?? '').trim().toUpperCase();
	return CURRENCY_ALIASES[c] ?? (/^[A-Z]{3}$/.test(c) ? c : c || 'unknown');
};
const isUrl = (u: unknown): u is string => typeof u === 'string' && /^https?:\/\/\S+$/.test(u);

/** One market: priced listings (as listed, in their own currency) and suppliers. */
async function searchRegion(rfq: RfqFacts, specs: string, region: MarketRegion, medianQuote: number | null) {
	const query = `${rfq.materialDesc} (${rfq.materialSubgroup}) price and suppliers in ${region.region}`;
	try {
		const { data } = await askJson(
			`market search ${region.region}`,
			{ sys: marketSearchPrompt(region.region, region.sites, specs), user: query },
			[MARKET_SEARCH_MODEL, FALLBACK_MODEL + ':online'],
			2500,
			MARKET_SEARCH_TIMEOUT_MS,
		);
		const listings = (Array.isArray(data.listings) ? data.listings : [])
			.map((l: any) => ({
				source: String(l?.source ?? '').slice(0, 80),
				title: String(l?.title ?? '').slice(0, 200),
				price: num(l?.price),
				currency: currencyOf(l?.currency),
				unit: typeof l?.unit === 'string' && l.unit.trim() ? l.unit.trim().slice(0, 30) : rfq.unit,
				meetsSpecs: ['yes', 'nearly', 'no', 'unknown'].includes(l?.meets_specs) ? l.meets_specs : 'unknown',
				url: l?.url,
			}))
			.filter((l: any) => l.price !== null && l.price > 0 && isUrl(l.url))
			.slice(0, 5)
			.map((l: any) => {
				// Only INR listings can be set against the quotes; far away usually means another spec or basis.
				const ratio = l.currency === 'INR' && medianQuote ? l.price / medianQuote : null;
				return { ...l, price: round(l.price), outOfRange: ratio !== null && (ratio < 1 / 3 || ratio > 3) };
			});
		const suppliers = (Array.isArray(data.suppliers) ? data.suppliers : [])
			.filter((s: any) => typeof s?.name === 'string' && s.name.trim())
			.slice(0, 6)
			.map((s: any) => ({
				name: s.name.trim().slice(0, 120),
				country: typeof s.country === 'string' && s.country.trim() ? s.country.trim().slice(0, 60) : region.region,
				website: isUrl(s.website) ? s.website : null,
			}));
		const note = typeof data.note === 'string' && data.note.trim() ? clipToSentence(data.note.trim(), 240) : null;
		return { region: region.region, sites: region.sites, listings, suppliers, note };
	} catch (e) {
		console.warn(`[RFQ-RECOMMENDATION] market search ${region.region} failed for ${rfq.materialId}: ${errMsg(e)}`);
		return { region: region.region, sites: region.sites, listings: [], suppliers: [], note: null, failed: true };
	}
}

const medianQuoteOf = (vendors: VendorQuote[]): number | null => {
	const prices = vendors.filter(v => v.eligible).map(v => v.quotedPrice).sort((a, b) => a - b);
	return prices.length ? prices[Math.floor(prices.length / 2)] : null;
};

// ECB reference rates from Frankfurter (free, no key), once a day, to put
// foreign listings in rupees.
const FX_URL = 'https://api.frankfurter.dev/v1/latest?base=INR';
let fxCache: { day: string; date: string; inrPer: Record<string, number> } | null = null;

/** Rupees per unit of each currency (INR = 1); null when the rates can't be fetched. */
async function inrRates(): Promise<{ date: string; inrPer: Record<string, number> } | null> {
	const day = new Date().toISOString().slice(0, 10);
	if (fxCache?.day === day) return fxCache;
	try {
		const res = await withTimeout(fetch(FX_URL), 8_000, 'exchange rates');
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const body: any = await res.json();
		const inrPer: Record<string, number> = { INR: 1 };
		for (const [currency, perInr] of Object.entries(body?.rates ?? {})) {
			if (typeof perInr === 'number' && perInr > 0) inrPer[currency] = 1 / perInr;
		}
		fxCache = { day, date: String(body?.date ?? day), inrPer };
		return fxCache;
	} catch (e) {
		console.warn(`[RFQ-RECOMMENDATION] exchange rates unavailable: ${errMsg(e)}`);
		return null;
	}
}

// Listings name the same unit in many ways (review, 19 Oct: "per unit or per piece, need to be consistent"):
// one item becomes the material's own unit when that is EA, and a tonne becomes MT when that is MT.
const ONE_ITEM = /^(?:units?|pieces?|pcs?|nos?|numbers?|each|ea|items?)$/i;
const ONE_TONNE = /^(?:t|tons?|tonnes?|mts?|metric ?tonn?e?s?)$/i;
function sameUnitName(raw: unknown, materialUnit: string): string {
	const unit = String(raw ?? '').trim().replace(/^per\s+/i, '').replace(/\.$/, '');
	if (!unit) return materialUnit;
	if (materialUnit === 'EA' && ONE_ITEM.test(unit)) return 'EA';
	if (materialUnit === 'MT' && ONE_TONNE.test(unit)) return 'MT';
	return unit;
}

/**
 * Each listing in rupees and with its unit named like the material's, and the
 * one to use as the market price when India's reference search finds none
 * (meeting, 18 Oct: "one price meets the spec, why didn't we consider that?"):
 * listings that meet the specs, India first, else any market; the middle one
 * when several do. Ones far from the quotes are left out, as they are for the
 * reference price.
 */
async function withBestListing(result: any, vendors: VendorQuote[], materialUnit: string) {
	const fx = await inrRates();
	const medianQuote = medianQuoteOf(vendors);
	const regions = (result.regions ?? []).map((r: any) => ({
		...r,
		listings: (r.listings ?? []).map((l: any) => {
			const rate = l.currency === 'INR' ? 1 : fx?.inrPer[l.currency];
			const named = { ...l, unit: sameUnitName(l.unit, materialUnit) };
			return rate ? { ...named, priceInr: round(l.price * rate) } : named;
		}),
	}));
	const candidates = regions
		.flatMap((r: any) => r.listings.map((l: any) => ({ ...l, region: r.region })))
		.filter((l: any) => l.meetsSpecs === 'yes' && l.priceInr > 0)
		.filter((l: any) => !medianQuote || (l.priceInr / medianQuote >= 1 / 3 && l.priceInr / medianQuote <= 3));
	const india = candidates.filter((l: any) => l.currency === 'INR');
	const pool = (india.length ? india : candidates).sort((a: any, b: any) => a.priceInr - b.priceInr);
	const pick = pool[Math.floor((pool.length - 1) / 2)];
	const foreign = pick && pick.currency !== 'INR';
	return {
		...result,
		regions,
		fxDate: fx?.date ?? null,
		bestListing: pick
			? {
				region: pick.region, source: pick.source, title: pick.title, url: pick.url, unit: pick.unit,
				price: pick.price, currency: pick.currency, priceInr: pick.priceInr,
				rate: foreign ? round(fx!.inrPer[pick.currency], 4) : null, rateDate: foreign ? fx!.date : null,
			}
			: null,
	};
}

/** Listings and suppliers per market for the RFQ's material, cached per material per day. */
async function marketSearch(run: Run, rfq: RfqFacts, vendors: VendorQuote[], requirements: any[], opts: { refresh?: boolean; cachedOnly?: boolean } = {}) {
	const profile = marketProfileOf(rfq);
	if (!profile) return { available: false, profile: null, regions: [], summary: 'No market listings for services.' };
	if (!opts.refresh) {
		const [hit] = await run(`
			SELECT result, created_at FROM market_reference_prices
			WHERE material_id = @materialId AND fetched_on = CURRENT_DATE AND query = @key
			ORDER BY created_at DESC LIMIT 1`, { materialId: rfq.materialId, key: MARKET_SEARCH_KEY });
		if (hit) return withBestListing({ ...hit.result, fetchedAt: hit.created_at, cached: true }, vendors, rfq.unit);
	}
	if (opts.cachedOnly) return { available: false, pending: true, profile: profile.name, regions: [], summary: 'Not searched yet today.' };

	const medianQuote = medianQuoteOf(vendors);
	const started = Date.now();
	const regions = await Promise.all(profile.regions.map(r => searchRegion(rfq, keySpecs(requirements), r, medianQuote)));
	const priced = regions.filter(r => r.listings.length).length;
	const result = {
		available: regions.some(r => r.listings.length || r.suppliers.length),
		profile: profile.name,
		regions,
		summary: `Prices found in ${priced} of ${regions.length} markets; suppliers listed for ${regions.filter(r => r.suppliers.length).length}.`,
	};
	const failed = regions.filter(r => 'failed' in r).length;
	console.log(`[RFQ-RECOMMENDATION] ${rfq.materialId}: market search (${profile.name}) ${result.summary}${failed ? ` ${failed} failed.` : ''} ${Date.now() - started} ms`);
	if (failed < regions.length) { // a total failure isn't cached, so the next call tries again
		await run(`
			INSERT INTO market_reference_prices (material_id, query, result, model)
			VALUES (@materialId, @key, CAST(@result AS jsonb), @model)`,
			{ materialId: rfq.materialId, key: MARKET_SEARCH_KEY, result: JSON.stringify(result), model: MARKET_SEARCH_MODEL });
	}
	return withBestListing({ ...result, fetchedAt: new Date().toISOString(), cached: false }, vendors, rfq.unit);
}

/** A market listing standing in for the India reference price, and saying so. */
function listingAsMarketPrice(reference: any, l: any, unit: string) {
	const foreign = l.currency !== 'INR';
	const asListed = `${l.currency} ${Number(l.price).toLocaleString('en-US')}`;
	return {
		available: true,
		priceInr: l.priceInr,
		unit: l.unit || unit,
		matchedModel: l.title,
		basis: foreign ? `${l.region} listing, before freight and import duty` : `${l.region} marketplace listing`,
		notes: `No India reference price met the specs, so this is a listing that does, on ${l.source}`
			+ (foreign ? `: ${asListed} at ₹${l.rate} per ${l.currency} (${l.rateDate}).` : '.'),
		// A foreign price before freight and duty isn't on a delivered basis like the quotes.
		comparable: !foreign,
		fromListing: l,
		referenceReason: reference?.noPriceReason ?? null,
		sources: [{ title: l.title, url: l.url }],
		summary: `Market price from a ${l.region} listing that meets the specs: ${inr(l.priceInr)}/${l.unit || unit}`
			+ (foreign ? ` (${asListed}, before freight and import duty).` : '.'),
	};
}

/** ④ Sustainability of the vendors that quoted. */
function sustainability(vendors: VendorQuote[]) {
	const rated = vendors.filter(v => v.eligible && v.ecovadisScore !== null);
	const best = [...rated].sort((a, b) => (b.ecovadisScore ?? 0) - (a.ecovadisScore ?? 0))[0];
	const avg = rated.length ? Math.round(rated.reduce((s, v) => s + (v.ecovadisScore ?? 0), 0) / rated.length) : null;
	return {
		available: rated.length > 0,
		vendors: vendors.map(v => ({ vendorId: v.vendorId, vendorName: v.vendorName, ecovadisScore: v.ecovadisScore, sustainabilityTier: v.sustainabilityTier })),
		best: best ? { vendorId: best.vendorId, vendorName: best.vendorName, ecovadisScore: best.ecovadisScore, sustainabilityTier: best.sustainabilityTier } : null,
		averageEcovadis: avg,
		summary: best ? `Best: ${best.vendorName} (EcoVadis ${best.ecovadisScore}, ${best.sustainabilityTier}); average ${avg} across eligible vendors.` : 'No sustainability ratings for these vendors.',
	};
}

/** ⑤ Our existing rate-contract prices for this material. */
async function contractBenchmark(run: Run, rfq: RfqFacts, vendors: VendorQuote[]) {
	const rows = await run(`
		SELECT ci.contract_unit_price, c.contract_id, c.vendor_id, vm.vendor_name, c.contract_type,
		       c.start_date::text AS start_date, c.end_date::text AS end_date,
		       (c.start_date <= CURRENT_DATE AND c.end_date >= CURRENT_DATE) AS active
		FROM contract_items ci
		JOIN contracts c ON c.contract_id = ci.contract_id
		JOIN vendor_master vm ON vm.vendor_id = c.vendor_id
		WHERE ci.material_id = @materialId
		ORDER BY ci.contract_unit_price`, { materialId: rfq.materialId });
	const contracts = rows.map((c: any) => ({
		contractId: c.contract_id, vendorId: c.vendor_id, vendorName: c.vendor_name, contractType: c.contract_type,
		price: round(Number(c.contract_unit_price)), startDate: c.start_date, endDate: c.end_date, active: c.active === true,
	}));
	const active = contracts.filter(c => c.active);
	const best = active[0] ?? null;
	const quoting = new Set(vendors.map(v => v.vendorId));
	return {
		available: active.length > 0,
		activeContracts: active,
		expiredContracts: contracts.filter(c => !c.active).length,
		bestActivePrice: best?.price ?? null,
		quotingVendorsWithContract: active.filter(c => quoting.has(c.vendorId)).map(c => ({ vendorId: c.vendorId, vendorName: c.vendorName, price: c.price })),
		summary: best
			? `Active rate contract at ${inr(best.price)}/${rfq.unit} with ${best.vendorName} (${best.contractId}, until ${best.endDate}).`
			: contracts.length ? 'Only expired contracts cover this material.' : 'No rate contract covers this material.',
	};
}

/** Steps 1–2 together: the facts plus all five market inputs. */
async function marketStudy(run: Run, rfqId: string, online: { refresh?: boolean; cachedOnly?: boolean }) {
	const { rfq, vendors, requirements } = await loadRfqFacts(run, rfqId);
	const [should, historical, commodity, contract, onlinePrice] = await Promise.all([
		shouldCost(run, rfq),
		historicalPrice(run, rfq),
		commodityFeed(run, rfq),
		contractBenchmark(run, rfq, vendors),
		onlineReferencePrice(run, rfq, requirements, online),
	]);
	let marketPrice = checkOnlineAgainstQuotes(onlinePrice, vendors);
	if (marketPrice && !marketPrice.pending && !(marketPrice.available && marketPrice.priceInr)) {
		// No India reference price: a listing that meets the specs from today's market search, once it's in.
		const search: any = await marketSearch(run, rfq, vendors, requirements, { cachedOnly: true });
		if (search.bestListing) marketPrice = checkOnlineAgainstQuotes(listingAsMarketPrice(onlinePrice, search.bestListing, rfq.unit), vendors);
	}
	const market = {
		shouldCost: should, historical, commodity, online: marketPrice,
		sustainability: sustainability(vendors), contract,
	};
	return { rfq, vendors, requirements, market };
}

// ============================================================
// Step 3 — score
// ============================================================

function rankVendors(vendors: VendorQuote[], market: any): RankedVendor[] {
	const eligible = vendors.filter(v => v.eligible && v.tRank && v.lRank);
	const n = eligible.length;
	const onlineComparable = market.online?.available && market.online?.comparable ? market.online.priceInr : null;
	return eligible
		.map(v => {
			const l = parseInt(v.lRank!.slice(1), 10);
			const priceScore = n > 1 ? 1 - (l - 1) / (n - 1) : 1;
			const techScore = T_SCORE[v.tRank!] ?? 0;
			const flags: string[] = [];
			if (v.sanctionsFlag) flags.push('Sanctions flag');
			if (v.overallRisk === 'High' || v.financialRiskTier === 'High') flags.push('High risk');
			return {
				...v,
				position: 0,
				priceScore: round(priceScore, 3),
				techScore,
				score: round(PRICE_WEIGHT * priceScore + TECH_WEIGHT * techScore, 3),
				vsHistoricalAvgPct: pct(v.quotedPrice, market.historical?.avg12m),
				vsContractPct: pct(v.quotedPrice, market.contract?.bestActivePrice),
				vsOnlinePct: pct(v.quotedPrice, onlineComparable),
				flags,
			};
		})
		.sort((a, b) => b.score - a.score || a.quotedPrice - b.quotedPrice)
		.map((v, i) => ({ ...v, position: i + 1 }));
}

// ============================================================
// Step 4 — recommendation
// ============================================================

// Shown as four short points with side headings (meeting, 16 Oct: "4 to 5
// bullet points… side headings, like pricing… risk"; "clean point, direct speech").
interface Point {
	heading: string;
	text: string;
}
const POINT_HEADINGS = ['Pricing', 'Technical', 'Delivery', 'Risk'] as const;

/**
 * The four points from our data alone: used when the model's points are
 * missing or unusable, and for recommendations saved before points existed.
 */
function factPoints(pick: RankedVendor, ranking: RankedVendor[], unit: string): Point[] {
	const n = ranking.length;
	const vs = (p: number | null | undefined, what: string) => (p === null || p === undefined ? null : `${Math.abs(p)}% ${p <= 0 ? 'below' : 'above'} ${what}`);
	const pricing = [
		`${inr(pick.quotedPrice)} per ${unit}, ${pick.lRank} of ${n} quote${n === 1 ? '' : 's'}`,
		vs(pick.vsHistoricalAvgPct, 'our 12-month average'),
		vs(pick.vsContractPct, 'our rate contract'),
	].filter(Boolean).join('; ');
	const fastest = ranking.filter(v => v.deliveryDays != null).sort((a, b) => a.deliveryDays! - b.deliveryDays!)[0];
	const delivery = pick.deliveryDays == null
		? 'Delivery time not stated'
		: fastest && fastest.vendorId !== pick.vendorId && fastest.deliveryDays! < pick.deliveryDays
			? `${pick.deliveryDays} days; the fastest quote is ${fastest.deliveryDays} days (${fastest.vendorName})`
			: `${pick.deliveryDays} days, the fastest quote`;
	const risk = [
		pick.overallRisk ? `${pick.overallRisk} risk` : 'Risk not rated',
		pick.otdPct != null ? `${Math.round(pick.otdPct)}% on-time delivery` : null,
		pick.ecovadisScore != null ? `EcoVadis ${pick.ecovadisScore}` : null,
	].filter(Boolean).join(', ');
	const technical = `${pick.tRank}${pick.technicalNote ? `: ${clipToSentence(pick.technicalNote, 140)}` : ''}`;
	const end = (s: string) => (/[.!?]$/.test(s) ? s : `${s}.`);
	return [
		{ heading: 'Pricing', text: end(pricing) },
		{ heading: 'Technical', text: end(technical) },
		{ heading: 'Delivery', text: end(delivery) },
		{ heading: 'Risk', text: end(risk) },
	];
}

/** The model's points, if it gave exactly one per heading; otherwise null. */
function cleanPoints(raw: unknown): Point[] | null {
	if (!Array.isArray(raw)) return null;
	const byHeading = new Map<string, string>();
	for (const p of raw) {
		const heading = typeof p?.heading === 'string' ? p.heading.trim().toLowerCase() : '';
		const text = typeof p?.text === 'string' ? p.text.trim() : '';
		const h = POINT_HEADINGS.find(x => x.toLowerCase() === heading);
		if (h && text && !byHeading.has(h)) byHeading.set(h, clipToSentence(text, 220));
	}
	return byHeading.size === POINT_HEADINGS.length ? POINT_HEADINGS.map(h => ({ heading: h, text: byHeading.get(h)! })) : null;
}

async function recommend(rfq: RfqFacts, ranking: RankedVendor[], market: any) {
	const candidates = ranking.filter(v => !v.sanctionsFlag);
	if (!candidates.length) {
		return { vendorId: null, vendorName: null, quoteId: null, combinedRank: null, rationale: 'No technically acceptable vendor without a sanctions flag.', considerations: [] as string[], points: [] as Point[], source: 'none', model: null as string | null, agreesWithScore: null as boolean | null };
	}
	const top = candidates[0];
	const fallback = (why: string) => ({
		vendorId: top.vendorId, vendorName: top.vendorName, quoteId: top.quoteId, combinedRank: `${top.lRank}, ${top.tRank}`,
		rationale: `${top.vendorName} has the best combined score (${top.lRank}, ${top.tRank}) under the ${PRICE_WEIGHT * 100}/${TECH_WEIGHT * 100} price/technical weighting`
			+ (top.vsHistoricalAvgPct !== null ? `, and its price is ${Math.abs(top.vsHistoricalAvgPct)}% ${top.vsHistoricalAvgPct <= 0 ? 'below' : 'above'} our 12-month average.` : '.'),
		considerations: [] as string[], points: factPoints(top, ranking, rfq.unit), source: 'fallback', model: null as string | null, agreesWithScore: true as boolean | null, fallbackReason: why,
	});

	const facts = {
		material: `${rfq.materialDesc} (${rfq.materialSubgroup})`,
		quantity: `${rfq.requestedQty ?? '?'} ${rfq.unit}`,
		plant: rfq.plantCode,
		urgency: rfq.urgency,
		weighting: `score = ${PRICE_WEIGHT} × price rank + ${TECH_WEIGHT} × technical rank`,
		vendors: candidates.map(v => ({
			vendor_id: v.vendorId, name: v.vendorName, score: v.score, l_rank: v.lRank, t_rank: v.tRank,
			unit_price: v.quotedPrice, delivery_days: v.deliveryDays, payment_terms: v.paymentTerms, warranty_months: v.warrantyMonths,
			technical_note: v.technicalNote, on_time_delivery_pct: v.otdPct, quality_pct: v.qualityPct, risk: v.overallRisk,
			ecovadis_score: v.ecovadisScore, sustainability_tier: v.sustainabilityTier,
			vs_12m_avg_pct: v.vsHistoricalAvgPct, vs_contract_pct: v.vsContractPct, flags: v.flags,
		})),
		// All five market-study inputs (inputs 4 and 5 chosen Oct 16: sustainability and contract benchmark).
		market: {
			historical: market.historical?.summary,
			commodity: market.commodity?.summary,
			online_reference: market.online?.available
				? {
					price_inr: market.online.priceInr, unit: market.online.unit, model: market.online.matchedModel ?? undefined,
					basis: market.online.basis, comparable_to_quotes: market.online.comparable, note: market.online.note ?? undefined,
				}
				: [market.online?.summary ?? 'not available', market.online?.notes].filter(Boolean).join(' '),
			sustainability: market.sustainability?.summary,
			contract: market.contract?.summary,
		},
	};

	try {
		const { data, model } = await askJson('recommendation', {
			sys: 'You recommend one supplier for a procurement RFQ. The buyer decides; your recommendation is advisory. '
				+ 'Pick exactly one vendor_id from the given vendors. Start from the given score (0 to 1, higher is better; it already combines '
				+ 'price rank L and technical rank T with the stated weighting), then weigh delivery time, payment terms, risk, quality, '
				+ 'the market benchmarks (our past prices, the commodity trend, the online price, our rate-contract price) and sustainability (EcoVadis). '
				+ 'Do not compute your own score; quote the given one. Round prices to whole rupees. '
				+ 'The online reference price may be on a different basis (e.g. mine-head, excluding freight and taxes); compare quotes to it only when comparable_to_quotes is true. '
				+ 'Respond with JSON only: {"vendor_id": string, "summary": string, "points": [{"heading": "Pricing", "text": string}, '
				+ '{"heading": "Technical", "text": string}, {"heading": "Delivery", "text": string}, {"heading": "Risk", "text": string}]}. '
				+ '"points": exactly these four headings in this order; each text is one short plain sentence (at most 20 words) about the '
				+ 'recommended vendor with the key numbers; mention another vendor only when it explains the choice (e.g. a faster or cheaper one). '
				+ 'Pricing covers the price against the other quotes, our past prices and the rate contract; Technical covers the T-rank and specs; '
				+ 'Delivery covers delivery time against the urgency; Risk covers risk rating, on-time delivery and sustainability. '
				+ '"summary": one sentence (at most 25 words) on why this supplier. '
				+ 'Write in plain, direct business language: no filler, no hedging, no first person, no words like "superior" or "significant".',
			user: JSON.stringify(facts),
		}, [RECOMMENDATION_MODEL, FALLBACK_MODEL], 1500, RECOMMEND_TIMEOUT_MS);

		const pickVendor = candidates.find(v => v.vendorId === data.vendor_id);
		if (!pickVendor) return fallback(`model picked an ineligible vendor (${data.vendor_id})`);
		// Points the model didn't get right are built from our data instead, so the screen always has four.
		const points = cleanPoints(data.points) ?? factPoints(pickVendor, ranking, rfq.unit);
		const summary = typeof data.summary === 'string' && data.summary.trim()
			? data.summary.trim()
			: typeof data.rationale === 'string' && data.rationale.trim() ? data.rationale.trim() : '';
		return {
			vendorId: pickVendor.vendorId, vendorName: pickVendor.vendorName, quoteId: pickVendor.quoteId,
			// Ranks come from our data, never from the model's text.
			combinedRank: `${pickVendor.lRank}, ${pickVendor.tRank}`,
			rationale: clipToSentence(summary || points.map(p => p.text).join(' '), 400),
			considerations: [] as string[],
			points,
			source: 'ai', model: model as string | null, agreesWithScore: (pickVendor.vendorId === top.vendorId) as boolean | null,
		};
	} catch (e) {
		return fallback(errMsg(e));
	}
}

// ============================================================
// Full pipeline (steps 1–5)
// ============================================================

/**
 * Reuses today's saved recommendation unless a T-rank on this RFQ changed
 * since, or `refresh` is set.
 */
async function runRecommendation(run: Run, rfqId: string, opts: { refresh?: boolean; userId?: string } = {}) {
	if (!opts.refresh) {
		const [saved] = await run(`
			SELECT rr.id, rr.recommended_vendor_id, rr.recommended_quote_id, rr.combined_rank, rr.rationale, rr.considerations,
			       rr.points, rr.source, rr.model, rr.ranking, rr.market, rr.created_at
			FROM rfq_recommendations rr
			WHERE rr.rfq_id = @rfqId AND rr.created_at::date = CURRENT_DATE
			  AND rr.created_at > COALESCE((SELECT max(ranked_at) FROM rfq_technical_evaluations WHERE rfq_id = @rfqId), '-infinity')
			ORDER BY rr.created_at DESC LIMIT 1`, { rfqId });
		if (saved) {
			const ranking: RankedVendor[] = saved.ranking ?? [];
			const { rfq } = await loadRfqFacts(run, rfqId);
			const pick = ranking.find(v => v.vendorId === saved.recommended_vendor_id);
			// Saved before points existed: build them from the saved ranking.
			const points: Point[] = Array.isArray(saved.points) && saved.points.length === POINT_HEADINGS.length
				? saved.points
				: pick ? factPoints(pick, ranking, rfq.unit) : [];
			return {
				id: saved.id, createdAt: saved.created_at, rfq, market: saved.market, ranking, reused: true,
				recommendation: {
					vendorId: saved.recommended_vendor_id,
					vendorName: pick?.vendorName ?? null,
					quoteId: saved.recommended_quote_id,
					combinedRank: saved.combined_rank,
					rationale: saved.rationale,
					considerations: saved.considerations ?? [],
					points,
					source: saved.source,
					model: saved.model,
					agreesWithScore: ranking.find(v => !v.sanctionsFlag)?.vendorId === saved.recommended_vendor_id,
				},
			};
		}
	}

	const started = Date.now();
	const { rfq, vendors, market } = await marketStudy(run, rfqId, { refresh: opts.refresh });
	const ranking = rankVendors(vendors, market);
	const recommendation = await recommend(rfq, ranking, market);

	const [saved] = await run(`
		INSERT INTO rfq_recommendations (rfq_id, recommended_vendor_id, recommended_quote_id, combined_rank, rationale,
		                                 considerations, points, source, model, ranking, market, created_by)
		VALUES (@rfqId, @vendorId, @quoteId, @combinedRank, @rationale, CAST(@considerations AS jsonb), CAST(@points AS jsonb), @source, @model,
		        CAST(@ranking AS jsonb), CAST(@market AS jsonb), @createdBy)
		RETURNING id, created_at`, {
		rfqId, vendorId: recommendation.vendorId, quoteId: recommendation.quoteId, combinedRank: recommendation.combinedRank,
		rationale: recommendation.rationale, considerations: JSON.stringify(recommendation.considerations), points: JSON.stringify(recommendation.points),
		source: recommendation.source,
		model: recommendation.model, ranking: JSON.stringify(ranking), market: JSON.stringify(market), createdBy: opts.userId ?? null,
	});
	console.log(`[RFQ-RECOMMENDATION] ${rfqId}: ${recommendation.vendorName ?? 'none'} (${recommendation.combinedRank ?? '-'}) via ${recommendation.source} in ${Date.now() - started} ms`);
	return { id: saved?.id, createdAt: saved?.created_at, rfq, market, ranking, recommendation, reused: false };
}

// ============================================================
// Negotiation strategy (meetings, 18 Oct): for every supplier, five short
// pointers from our data, the last one the discount to ask for. No script
// ("get rid of that script"), so no model call.
// ============================================================

interface DeliveryRecord {
	delivered: number;
	late: number;
	avgDaysLate: number | null;
	worstDaysLate: number | null;
}

/** Each vendor's deliveries to us, any material: how many came late, and by how much. */
async function deliveryRecords(run: Run, vendorIds: string[]): Promise<Map<string, DeliveryRecord>> {
	const records = new Map<string, DeliveryRecord>();
	if (!vendorIds.length) return records;
	const rows = await run(`
		SELECT vendor_id,
		       count(*) AS delivered,
		       sum(CASE WHEN actual_delivery_date > delivery_date THEN 1 ELSE 0 END) AS late,
		       avg(CASE WHEN actual_delivery_date > delivery_date THEN actual_delivery_date - delivery_date END) AS avg_days_late,
		       max(actual_delivery_date - delivery_date) AS worst_days_late
		FROM purchase_orders
		WHERE actual_delivery_date IS NOT NULL AND delivery_date IS NOT NULL
		  AND vendor_id IN (${vendorIds.map((_, i) => `@v${i}`).join(', ')})
		GROUP BY vendor_id`, Object.fromEntries(vendorIds.map((id, i) => [`v${i}`, id])));
	for (const r of rows) {
		const avgLate = num(r.avg_days_late);
		records.set(r.vendor_id, {
			delivered: Number(r.delivered),
			late: Number(r.late),
			avgDaysLate: avgLate !== null ? round(avgLate, 1) : null,
			worstDaysLate: num(r.worst_days_late),
		});
	}
	return records;
}

interface NegotiationAsk {
	/** % off the quote. */
	pct: number;
	targetPrice: number;
	/** On the requested quantity; null when it isn't known. */
	saving: number | null;
	basis: string;
}

/** "12.4% above it" / "the same as it". */
const rel = (p: number, what: string) => (p === 0 ? `the same as ${what}` : `${Math.abs(p)}% ${p > 0 ? 'above' : 'below'} ${what}`);
const leadingNumber = (s: string | null) => Number(/(\d+)/.exec(s ?? '')?.[1] ?? 0);

// Five pointers per supplier: four facts and the ask (review, 18 Oct: "1, 2, 3, 4, 5 pointers", no script).
const FACT_POINTERS = 4;

/**
 * One supplier's five pointers, one short line each: the first four facts that
 * apply, in the meeting's order (should cost, market price, market trend, delivery
 * record, the other quotes; then what we last paid, their last price to us,
 * delivery time, terms and risk), and the discount to ask for: down to the
 * nearest benchmark under the quote, 1–10% ("even 1% reduction").
 */
function strategyFor(v: RankedVendor, ranking: RankedVendor[], market: any, delivery: Map<string, DeliveryRecord>, qty: number | null) {
	const facts: Point[] = [];
	const add = (heading: string, text: string) => facts.push({ heading, text });
	const benchmarks: { label: string; price: number }[] = [];

	// Should cost ("should price is way lesser than quoted price").
	const shouldCost = market.shouldCost?.available ? num(market.shouldCost.shouldCost) : null;
	if (shouldCost) {
		const p = pct(v.quotedPrice, shouldCost)!;
		add('Should cost', p > 0
			? `Quote is ${p}% above the should cost (${inr(shouldCost)}).`
			: `Quote is ${rel(p, 'the should cost')} (${inr(shouldCost)}): press on terms, not price.`);
		benchmarks.push({ label: 'the should cost', price: shouldCost });
	}

	// Market price ("current quoted price is this much, but the market price is this much"):
	// India's reference price, else a listing that meets the specs from any market.
	const online = market.online;
	const listing = online?.fromListing;
	if (online?.available && online.priceInr && !online.outOfRange && (online.comparable !== false || listing)) {
		const vs = rel(pct(v.quotedPrice, online.priceInr)!, 'it');
		add('Market price', !listing
			? `${inr(online.priceInr)} in the market today; quote is ${vs}.`
			: listing.currency === 'INR'
				? `${inr(listing.priceInr)} on ${listing.source} (${listing.region}); quote is ${vs}.`
				: `${listing.currency} ${Number(listing.price).toLocaleString('en-US')} on ${listing.source} (${listing.region}), about ${inr(listing.priceInr)} before freight and duty; quote is ${vs}.`);
		// Only a price on a delivered basis like the quotes sets the ask.
		if (online.comparable !== false) benchmarks.push({ label: 'the market price', price: Number(online.priceInr) });
	}

	// Market trend ("the expectation is that this cost is going down").
	const c = market.commodity;
	if (c?.available && c.change90dPct != null && Math.abs(c.change90dPct) >= 1) {
		const share = c.exposurePct ? ` (about ${c.exposurePct}% of this item's cost)` : '';
		add('Market trend', c.change90dPct < 0
			? `${c.commodity} down ${Math.abs(c.change90dPct)}% in 90 days${share}: the price should come down.`
			: `${c.commodity} up ${c.change90dPct}% in 90 days${share}: expect them to cite it.`);
	}

	// Delivery record ("previously your delivery timelines are bad"): a lever only when they were late.
	const d = delivery.get(v.vendorId);
	if (d && d.late > 0) {
		add('Delivery record', `${d.late} of ${d.delivered} deliveries to us were late${d.avgDaysLate ? `, ${d.avgDaysLate} days on average` : ''}: ask for a penalty clause.`);
	} else if (!d && v.otdPct != null && v.otdPct < 90) {
		add('Delivery record', `${Math.round(v.otdPct)}% on-time delivery: ask for a penalty clause.`);
	}

	// Other quotes.
	const others = ranking.filter(o => o.vendorId !== v.vendorId);
	const lowest = [...others].sort((a, b) => a.quotedPrice - b.quotedPrice)[0];
	if (lowest) {
		add('Other quotes', lowest.quotedPrice < v.quotedPrice
			? `${lowest.vendorName} (${lowest.tRank}) quoted ${inr(lowest.quotedPrice)}, ${round((1 - lowest.quotedPrice / v.quotedPrice) * 100, 1)}% less.`
			: `Lowest quote; next is ${lowest.vendorName} at ${inr(lowest.quotedPrice)}.`);
		benchmarks.push({ label: 'the lowest other quote', price: lowest.quotedPrice });
	}

	// What we last paid (no averages: review, 18 Oct), and their last price to us for this item.
	const h = market.historical;
	if (h?.lastPrice) {
		add('Our last price', `We last paid ${inr(h.lastPrice)} (${h.lastDate}); quote is ${rel(pct(v.quotedPrice, h.lastPrice)!, 'that')}.`);
		benchmarks.push({ label: 'what we last paid', price: Number(h.lastPrice) });
	}
	const own = (h?.pastSuppliers ?? []).find((s: any) => s.vendorId === v.vendorId);
	if (own) {
		add('Their last price', `They charged us ${inr(own.lastPrice)} on ${own.lastDate}; quote is ${rel(pct(v.quotedPrice, own.lastPrice)!, 'that')}.`);
		benchmarks.push({ label: 'their last price to us', price: Number(own.lastPrice) });
	}

	// Delivery time, terms and risk.
	const fastest = others.filter(o => o.deliveryDays != null).sort((a, b) => a.deliveryDays! - b.deliveryDays!)[0];
	if (v.deliveryDays != null && fastest && fastest.deliveryDays! < v.deliveryDays) {
		add('Delivery time', `${v.deliveryDays} days vs ${fastest.deliveryDays} from ${fastest.vendorName}: ask them to match.`);
	}
	const betterPay = others.filter(o => leadingNumber(o.paymentTerms) > leadingNumber(v.paymentTerms))
		.sort((a, b) => leadingNumber(b.paymentTerms) - leadingNumber(a.paymentTerms))[0];
	const longerWarranty = others.filter(o => (o.warrantyMonths ?? 0) > (v.warrantyMonths ?? 0))
		.sort((a, b) => (b.warrantyMonths ?? 0) - (a.warrantyMonths ?? 0))[0];
	const terms = [
		betterPay && `${betterPay.vendorName} offers ${betterPay.paymentTerms}`,
		longerWarranty && `${longerWarranty.vendorName} gives ${longerWarranty.warrantyMonths} months' warranty`,
	].filter(Boolean);
	if (terms.length) add('Terms', `${terms.join('; ')}: ask them to match.`);
	const risks = [
		v.qualityPct != null && v.qualityPct < 95 ? `${Math.round(v.qualityPct)}% quality acceptance` : null,
		v.overallRisk === 'High' || v.financialRiskTier === 'High' ? 'high risk rating' : null,
		v.sanctionsFlag ? 'sanctions flag' : null,
	].filter(Boolean);
	if (risks.length) add('Risk', `${risks.join(' and ')}: ask for guarantees.`);

	const nearest = benchmarks
		.filter(b => b.price > 0 && b.price < v.quotedPrice)
		.map(b => ({ ...b, gap: (1 - b.price / v.quotedPrice) * 100 }))
		.sort((a, b) => a.gap - b.gap)[0];
	const askPct = Math.min(10, Math.max(1, Math.round((nearest?.gap ?? 1) * 2) / 2));
	const targetPrice = round(v.quotedPrice * (1 - askPct / 100));
	const saving = qty ? round((v.quotedPrice - targetPrice) * qty) : null;
	const ask: NegotiationAsk = {
		pct: askPct,
		targetPrice,
		saving,
		basis: !nearest
			? 'even 1% is worth asking for'
			: nearest.gap > 10 ? `${nearest.label} is ${round(nearest.gap, 1)}% lower` : `in line with ${nearest.label}`,
	};
	return {
		pointers: [
			...facts.slice(0, FACT_POINTERS),
			{ heading: 'Ask', text: `${askPct}% off, to ${inr(targetPrice)}${saving ? ` (saves ${inr(saving)})` : ''}: ${ask.basis}.` },
		],
		ask,
	};
}

/**
 * Pointers and the ask for every supplier, from our data only: a second or
 * two, no model call. Uses today's web price and market search as far as
 * they're in; the screen asks again once the market search finishes.
 */
async function negotiationPointers(run: Run, rfqId: string) {
	const { rfq, vendors, market } = await marketStudy(run, rfqId, { cachedOnly: true });
	const ranking = rankVendors(vendors, market);
	const delivery = await deliveryRecords(run, ranking.map(v => v.vendorId));
	return { rfq, items: ranking.map(v => ({ v, ...strategyFor(v, ranking, market, delivery, rfq.requestedQty) })) };
}

// ============================================================
// Tool output shaping
// ============================================================

/** Chart series are for screens; the chat agent doesn't need 365 points. */
function withoutSeries(market: any) {
	const { series: _historicalSeries, orders: _historicalOrders, ...historical } = market.historical ?? {};
	const { series: _commoditySeries, ...commodity } = market.commodity ?? {};
	return { ...market, historical, commodity };
}

const marketSummary = (market: any) => ({
	shouldCost: market.shouldCost?.summary,
	historical: market.historical?.summary,
	commodity: market.commodity?.summary,
	onlinePrice: market.online?.note ? `${market.online.summary} ${market.online.note}` : market.online?.summary,
	sustainability: market.sustainability?.summary,
	contract: market.contract?.summary,
});

/** One flat row per eligible vendor, best combined score first. */
const rankingRows = (ranking: RankedVendor[]) => ranking.map(v => ({
	position: v.position,
	vendorId: v.vendorId,
	vendorName: v.vendorName,
	tRank: v.tRank,
	lRank: v.lRank,
	score: v.score,
	quotedPrice: v.quotedPrice,
	deliveryDays: v.deliveryDays,
	paymentTerms: v.paymentTerms,
	warrantyMonths: v.warrantyMonths,
	overallRisk: v.overallRisk,
	otdPct: v.otdPct,
	qualityPct: v.qualityPct,
	ecovadisScore: v.ecovadisScore,
	vsHistoricalAvgPct: v.vsHistoricalAvgPct,
	vsContractPct: v.vsContractPct,
	vsOnlinePct: v.vsOnlinePct,
	flags: v.flags.join(', '),
	technicalNote: v.technicalNote,
}));

const RANKING_FIELDS = [
	{ name: 'position', type: 'number', description: 'Order by combined score (1 = best)' },
	{ name: 'vendorName', type: 'string', description: 'Vendor' },
	{ name: 'tRank', type: 'string', description: 'Technical rank T1 (best) to T4' },
	{ name: 'lRank', type: 'string', description: 'Price rank among technically accepted vendors (L1 = cheapest)' },
	{ name: 'score', type: 'number', description: `Combined score 0–1: ${PRICE_WEIGHT} × price rank + ${TECH_WEIGHT} × technical rank` },
	{ name: 'quotedPrice', type: 'number', description: 'Quoted unit price (INR)' },
	{ name: 'deliveryDays', type: 'number', description: 'Quoted delivery time in days' },
	{ name: 'vsHistoricalAvgPct', type: 'number', description: '% above (+) or below (−) our 12-month average price' },
	{ name: 'vsContractPct', type: 'number', description: '% vs our best active rate-contract price for the material' },
	{ name: 'overallRisk', type: 'string', description: 'Supplier risk' },
	{ name: 'flags', type: 'string', description: 'Sanctions / high-risk flags' },
];

function requireRfqId(input: any): string | null {
	return typeof input?.rfqId === 'string' && RFQ_ID.test(input.rfqId.trim()) ? input.rfqId.trim() : null;
}

// ============================================================
// Tools
// ============================================================

export function createRfqRecommendationTools(execute: ExecuteFn): SourceTool[] {
	const run = runner(execute);

	return [
		{
			id: 'recommend-rfq-supplier',
			name: 'Recommend RFQ Supplier',
			toolType: 'direct',
			// Writes a recommendation snapshot and depends on T-ranks the buyer can change.
			cache: false,
			description:
				'Recommend one supplier for an RFQ, with the reason, after a market study (our past prices, commodity trend, ' +
				'online market price, sustainability, rate-contract price). Ranks technically accepted vendors (T1–T4) by ' +
				`${PRICE_WEIGHT * 100}% price rank (L) / ${TECH_WEIGHT * 100}% technical rank (T); the recommendation is advisory. ` +
				'USE FOR: "which vendor should we choose for RFQ-…", supplier recommendation with rationale, comparing an RFQ\'s ' +
				'vendors on T-rank, L-rank and market benchmarks. ' +
				'DO NOT USE FOR: listing or counting RFQs, quotes or vendors in general — use a SQL source query for those.',
			params: {
				rfqId: 'string - the RFQ id, e.g. "RFQ-00015"',
				refresh: 'boolean (optional) - true to run a fresh study instead of reusing today\'s saved recommendation',
				includeSeries: 'boolean (optional) - true to include chart series (for screens); leave out in chat',
			},
			fn: async (input: { rfqId?: string; refresh?: boolean; includeSeries?: boolean }) => {
				const rfqId = requireRfqId(input);
				if (!rfqId) return { error: 'A valid rfqId is required, e.g. "RFQ-00015".' };
				try {
					const principal = getRequestContext()?.principal;
					const result = await runRecommendation(run, rfqId, {
						refresh: input.refresh === true,
						userId: principal?.kind === 'user' ? principal.userId : undefined,
					});
					const rec = result.recommendation;
					return {
						data: rankingRows(result.ranking),
						count: result.ranking.length,
						rfqId,
						material: result.rfq.materialDesc,
						unit: result.rfq.unit,
						recommendedVendorId: rec.vendorId,
						recommendedVendor: rec.vendorName,
						combinedRank: rec.combinedRank,
						rationale: rec.rationale,
						considerations: rec.considerations,
						// The reason as four headed points: Pricing, Technical, Delivery, Risk.
						points: rec.points,
						recommendationSource: rec.source,
						model: rec.model,
						agreesWithScore: rec.agreesWithScore,
						weights: { price: PRICE_WEIGHT, technical: TECH_WEIGHT },
						marketSummary: marketSummary(result.market),
						market: input.includeSeries ? result.market : withoutSeries(result.market),
						recommendationId: result.id,
						createdAt: result.createdAt,
						reused: result.reused,
					};
				} catch (e) {
					return { error: errMsg(e) };
				}
			},
			outputSchema: {
				description: 'Eligible vendors ranked by combined score, plus the recommended vendor, its combined rank and the rationale.',
				fields: [
					{ name: 'recommendedVendor', type: 'string', description: 'Recommended supplier (KPI)' },
					{ name: 'combinedRank', type: 'string', description: 'Recommended supplier\'s ranks, e.g. "L1, T2" (KPI)' },
					{ name: 'rationale', type: 'string', description: 'Why this supplier, in two sentences' },
					...RANKING_FIELDS,
				],
			},
		},
		{
			id: 'get-rfq-market-study',
			name: 'Get RFQ Market Study',
			toolType: 'direct',
			cache: false,
			description:
				'Market study for an RFQ without an AI recommendation: the should cost (once entered), our historical purchase price for the material, its ' +
				'commodity price trend, our rate-contract price, vendor sustainability, today\'s online price if already ' +
				'fetched, and the technically accepted vendors ranked by T-rank and L-rank. Fast; makes no AI or web calls. ' +
				'USE FOR: price benchmarks for an RFQ\'s material, "is this quote above what we usually pay", T/L ranking of ' +
				'an RFQ\'s vendors. DO NOT USE FOR: choosing a supplier (use recommend-rfq-supplier) or market-wide analysis.',
			params: {
				rfqId: 'string - the RFQ id, e.g. "RFQ-00015"',
				includeSeries: 'boolean (optional) - true to include chart series (for screens); leave out in chat',
			},
			fn: async (input: { rfqId?: string; includeSeries?: boolean }) => {
				const rfqId = requireRfqId(input);
				if (!rfqId) return { error: 'A valid rfqId is required, e.g. "RFQ-00015".' };
				try {
					const { rfq, vendors, requirements, market } = await marketStudy(run, rfqId, { cachedOnly: true });
					const ranking = rankVendors(vendors, market);
					return {
						data: rankingRows(ranking),
						count: ranking.length,
						rfqId,
						material: rfq.materialDesc,
						unit: rfq.unit,
						rfqStatus: rfq.rfqStatus,
						notAcceptedCount: vendors.filter(v => !v.eligible).length,
						weights: { price: PRICE_WEIGHT, technical: TECH_WEIGHT },
						marketSummary: marketSummary(market),
						market: input.includeSeries ? market : withoutSeries(market),
						requirements,
					};
				} catch (e) {
					return { error: errMsg(e) };
				}
			},
			outputSchema: {
				description: 'Technically accepted vendors ranked by combined score, with market benchmarks for the RFQ\'s material.',
				fields: RANKING_FIELDS,
			},
		},
		{
			id: 'get-rfq-online-price',
			name: 'Get RFQ Online Market Price',
			toolType: 'direct',
			// Writes the daily cache row; a forced refresh must really search again.
			cache: false,
			description:
				'Current market price on the web for the material of an RFQ (grade and specs from the PR), with its basis ' +
				'(e.g. mine-head vs delivered), range and source links. Searches the web, so it can take ~30 seconds; the ' +
				'result is cached per material for the day. ' +
				'USE FOR: "what is the market price of this RFQ\'s material right now". ' +
				'DO NOT USE FOR: our own past prices (use get-rfq-market-study) or materials not tied to an RFQ.',
			params: {
				rfqId: 'string - the RFQ id, e.g. "RFQ-00015"',
				refresh: 'boolean (optional) - true to search again even if today\'s price is cached',
			},
			fn: async (input: { rfqId?: string; refresh?: boolean }) => {
				const rfqId = requireRfqId(input);
				if (!rfqId) return { error: 'A valid rfqId is required, e.g. "RFQ-00015".' };
				try {
					const { rfq, vendors, requirements } = await loadRfqFacts(run, rfqId);
					const online = checkOnlineAgainstQuotes(await onlineReferencePrice(run, rfq, requirements, { refresh: input.refresh === true }), vendors);
					const row = online.available
						? [{ priceInr: online.priceInr, unit: online.unit, range: online.range, basis: online.basis, comparable: online.comparable, outOfRange: online.outOfRange ?? false }]
						: [];
					return { ...online, data: row, count: row.length, rfqId, material: rfq.materialDesc };
				} catch (e) {
					return { error: errMsg(e) };
				}
			},
			outputSchema: {
				description: 'Online market reference price for the RFQ\'s material.',
				fields: [
					{ name: 'priceInr', type: 'number', description: 'Reference price in INR (KPI)' },
					{ name: 'unit', type: 'string', description: 'Price unit, e.g. MT' },
					{ name: 'basis', type: 'string', description: 'What the price is, e.g. mine-head, ex-works, delivered' },
					{ name: 'comparable', type: 'boolean', description: 'Whether it can be compared with delivered supplier quotes' },
				],
			},
		},
		{
			id: 'get-rfq-market-search',
			name: 'Get RFQ Market Prices by Region',
			toolType: 'direct',
			// Writes the daily cache row; a forced refresh must really search again.
			cache: false,
			description:
				'Prices and suppliers for an RFQ\'s material in several markets, from web listings: engineering items in India, China, ' +
				'Europe and the United States; raw materials in India, Indonesia, Australia and South Africa. Each listing has its source, ' +
				'price as listed (in its own currency), unit and link; each market also lists suppliers. Searches the web (about 30–60 ' +
				'seconds); cached per material for the day. ' +
				'USE FOR: "who else sells this", "what does this cost in China / Europe / the US", international price comparison for an RFQ. ' +
				'DO NOT USE FOR: our own past prices (use get-rfq-market-study) or the single India reference price (use get-rfq-online-price).',
			params: {
				rfqId: 'string - the RFQ id, e.g. "RFQ-00015"',
				refresh: 'boolean (optional) - true to search again even if today\'s results are cached',
			},
			fn: async (input: { rfqId?: string; refresh?: boolean }) => {
				const rfqId = requireRfqId(input);
				if (!rfqId) return { error: 'A valid rfqId is required, e.g. "RFQ-00015".' };
				try {
					const { rfq, vendors, requirements } = await loadRfqFacts(run, rfqId);
					const market: any = await marketSearch(run, rfq, vendors, requirements, { refresh: input.refresh === true });
					const rows = (market.regions ?? []).flatMap((r: any) => r.listings.map((l: any) => ({
						region: r.region, source: l.source, title: l.title, price: l.price, currency: l.currency, unit: l.unit, meetsSpecs: l.meetsSpecs, url: l.url,
					})));
					return { ...market, data: rows, count: rows.length, rfqId, material: rfq.materialDesc, unit: rfq.unit };
				} catch (e) {
					return { error: errMsg(e) };
				}
			},
			outputSchema: {
				description: 'Priced listings per market for the RFQ\'s material (own currency, before freight and duty), plus suppliers per market.',
				fields: [
					{ name: 'region', type: 'string', description: 'Market, e.g. India, China, Europe' },
					{ name: 'source', type: 'string', description: 'Site the listing is on' },
					{ name: 'title', type: 'string', description: 'Listing title' },
					{ name: 'price', type: 'number', description: 'Price as listed (KPI)' },
					{ name: 'currency', type: 'string', description: 'Currency of the price, e.g. INR, USD, EUR' },
					{ name: 'unit', type: 'string', description: 'Price unit' },
					{ name: 'meetsSpecs', type: 'string', description: 'Whether the listing\'s stated specs meet the PR: yes / nearly / no / unknown' },
				],
			},
		},
		{
			id: 'get-rfq-negotiation-strategy',
			name: 'Get RFQ Negotiation Strategy',
			toolType: 'direct',
			// The pointers follow today's market study as it fills in.
			cache: false,
			description:
				'Negotiation pointers for the technically accepted suppliers on an RFQ: five per supplier, from our data (should cost, ' +
				'today\'s market price, the commodity trend, the supplier\'s late deliveries to us, the other quotes, what we last paid, ' +
				'delivery time, terms and risk), the last one the discount to ask for. Fast; makes no AI call. ' +
				'USE FOR: "how should we negotiate with <supplier> on RFQ-…", negotiation points, the discount to ask for. ' +
				'DO NOT USE FOR: choosing a supplier (use recommend-rfq-supplier).',
			params: {
				rfqId: 'string - the RFQ id, e.g. "RFQ-00015"',
			},
			fn: async (input: { rfqId?: string }) => {
				const rfqId = requireRfqId(input);
				if (!rfqId) return { error: 'A valid rfqId is required, e.g. "RFQ-00015".' };
				try {
					const started = Date.now();
					const { rfq, items } = await negotiationPointers(run, rfqId);
					const vendors = items.map(({ v, pointers, ask }) => ({
						vendorId: v.vendorId, vendorName: v.vendorName, quotedPrice: v.quotedPrice, tRank: v.tRank, lRank: v.lRank, pointers, ask,
					}));
					console.log(`[RFQ-RECOMMENDATION] ${rfqId}: negotiation pointers for ${items.length} supplier(s) in ${Date.now() - started} ms`);
					const rows = vendors.map((v: any) => ({
						vendorName: v.vendorName, tRank: v.tRank, lRank: v.lRank, quotedPrice: v.quotedPrice,
						askPct: v.ask.pct, targetPrice: v.ask.targetPrice, pointers: v.pointers.map((p: Point) => `${p.heading}: ${p.text}`).join(' '),
					}));
					return {
						rfqId, material: rfq.materialDesc, unit: rfq.unit, quantity: rfq.requestedQty,
						createdAt: new Date().toISOString(), vendors, data: rows, count: rows.length,
					};
				} catch (e) {
					return { error: errMsg(e) };
				}
			},
			outputSchema: {
				description: 'Per technically accepted supplier: the discount to ask for, the target price and the negotiation pointers.',
				fields: [
					{ name: 'vendorName', type: 'string', description: 'Supplier' },
					{ name: 'tRank', type: 'string', description: 'Technical rank T1 (best) to T4' },
					{ name: 'lRank', type: 'string', description: 'Price rank among technically accepted vendors (L1 = cheapest)' },
					{ name: 'quotedPrice', type: 'number', description: 'Quoted unit price (INR)' },
					{ name: 'askPct', type: 'number', description: 'Discount to ask for, % off the quote (KPI)' },
					{ name: 'targetPrice', type: 'number', description: 'Unit price after that discount (INR)' },
					{ name: 'pointers', type: 'string', description: 'Negotiation pointers from our data' },
				],
			},
		},
	];
}

/**
 * Commodity market benchmarks: genuine, traceable external prices for coal and coke,
 * kept apart from the synthetic `commodity_prices` series the demo data generator wrote.
 *
 *   providers (World Bank, Trading Economics, authorized imports)
 *     → validation + normalisation (dated USD→INR from the ECB, metric tonnes)
 *     → market_benchmark_observations (one row per provider × benchmark × observation date)
 *     → per-RFQ commodity intelligence (reference price, history, supplier comparison, insights)
 *     → Market Analysis, the index comparison, the should cost and the negotiation points
 *
 * What each provider gives, as checked on 19 Oct 2026:
 *   - World Bank Pink Sheet (free, official): monthly thermal coal, Australia (f.o.b. Newcastle) and
 *     South Africa (f.o.b. Richards Bay), USD per metric tonne. No coking coal, coke or anthracite.
 *   - Trading Economics: documented REST API (`/markets/commodities`, `/markets/historical/{symbol}`),
 *     key required (HTTP 401 without one). The coking coal symbol is looked up by name from the
 *     commodities listing at run time, never assumed. Off until TRADING_ECONOMICS_API_KEY is set.
 *   - BigMint: subscription product, no public API; the site refuses automated requests. Only
 *     authorized exports are taken in, through `import-market-benchmarks` (CSV).
 *
 * Tables (procurement source; created by `refresh-market-benchmarks` with CREATE TABLE IF NOT EXISTS,
 * or by hand from database/procurement-source/001_market_benchmarks.sql):
 *
 *   market_benchmark_observations — see BENCHMARK_DDL below
 *   market_benchmark_refreshes    — one row per refresh attempt (the cache and the audit trail)
 *
 * Nothing here reads or writes commodity_prices.
 */

import ExcelJS from 'exceljs';

/** Runs SQL on the procurement source and returns plain rows. */
export type Run = (sql: string, params?: Record<string, unknown>) => Promise<any[]>;

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;
const pctChange = (now: number, before: number | null | undefined) => (before ? round((now / before - 1) * 100, 1) : null);
const LOG = '[MARKET-BENCHMARKS]';

async function fetchWithTimeout(url: string, ms: number, init?: RequestInit): Promise<Response> {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), ms);
	try {
		return await fetch(url, { ...init, signal: ctrl.signal });
	} finally {
		clearTimeout(timer);
	}
}

// ============================================================
// 1. Catalogue: the benchmarks we know, with their published definitions
// ============================================================

export type CommodityCategory = 'steam_coal' | 'coking_coal' | 'met_coke' | 'anthracite';
export type Provider = 'world_bank' | 'trading_economics' | 'bigmint_import';
export type DataStatus = 'verified_external' | 'authorized_import';

export interface BenchmarkDef {
	id: string;
	provider: Provider;
	commodity: CommodityCategory;
	name: string;
	/** As the provider publishes it. */
	specification: string;
	location: string;
	deliveryBasis: string;
	currency: string;
	unit: string;
	frequency: 'monthly' | 'daily';
	sourceUrl: string;
	/** Published specs, for the comparability check. */
	spec: { energyKcalKg?: number; energyBasis?: 'NAR' | 'GAR'; maxSulphurPct?: number; origin?: string; seaborne: boolean };
}

const WB_PAGE = 'https://www.worldbank.org/en/research/commodity-markets';

export const BENCHMARKS: BenchmarkDef[] = [
	{
		id: 'wb_coal_south_africa',
		provider: 'world_bank',
		commodity: 'steam_coal',
		name: 'Coal, South African (World Bank Pink Sheet)',
		specification: 'f.o.b. Richards Bay, NAR 6,000 kcal/kg, sulfur less than 1%, forward month 1 (from January 2015)',
		location: 'Richards Bay, South Africa',
		deliveryBasis: 'FOB (export, before freight, insurance and import duty)',
		currency: 'USD',
		unit: 'MT',
		frequency: 'monthly',
		sourceUrl: WB_PAGE,
		spec: { energyKcalKg: 6000, energyBasis: 'NAR', maxSulphurPct: 1, origin: 'South Africa', seaborne: true },
	},
	{
		id: 'wb_coal_australia',
		provider: 'world_bank',
		commodity: 'steam_coal',
		name: 'Coal, Australian (World Bank Pink Sheet)',
		specification: 'port thermal, f.o.b. Newcastle, 6,000 kcal/kg futures price (from February 2022)',
		location: 'Newcastle, Australia',
		deliveryBasis: 'FOB (export, before freight, insurance and import duty)',
		currency: 'USD',
		unit: 'MT',
		frequency: 'monthly',
		sourceUrl: WB_PAGE,
		spec: { energyKcalKg: 6000, origin: 'Australia', seaborne: true },
	},
	{
		id: 'te_coking_coal',
		provider: 'trading_economics',
		commodity: 'coking_coal',
		name: 'Coking Coal (Trading Economics)',
		specification: 'As published by Trading Economics for its "Coking Coal" commodity series; grade and terms per the provider',
		location: 'Per provider',
		deliveryBasis: 'Per provider (seaborne benchmark)',
		currency: 'USD',
		unit: 'MT',
		frequency: 'daily',
		sourceUrl: 'https://tradingeconomics.com/commodity/coking-coal',
		spec: { seaborne: true },
	},
];

/**
 * Material → benchmark mapping. By subgroup, with per-material overrides. `benchmarks` is in order of
 * preference; imported (BigMint) benchmarks for the same commodity are added after them. Comparability
 * is never assumed: it's worked out against the PR's own specs, and only an explicit `allowDirect`
 * after review can make a benchmark a like-for-like comparison.
 */
export const MATERIAL_BENCHMARK_MAP: {
	bySubgroup: Record<string, { commodity: CommodityCategory; benchmarks: string[] }>;
	byMaterial: Record<string, { benchmarks?: string[]; allowDirect?: string[]; note?: string }>;
} = {
	bySubgroup: {
		// Richards Bay first: a configured default, as a seaborne reference for imported thermal coal.
		'Steam Coal': { commodity: 'steam_coal', benchmarks: ['wb_coal_south_africa', 'wb_coal_australia'] },
		'Coking Coal': { commodity: 'coking_coal', benchmarks: ['te_coking_coal'] },
		'Metallurgical Coke': { commodity: 'met_coke', benchmarks: [] },
		Anthracite: { commodity: 'anthracite', benchmarks: [] },
	},
	byMaterial: {
		// Priority demo materials: same defaults as their subgroup, listed so they can be tuned one by one.
		'MAT-001952': { note: 'Steam Coal Grade A (RFQ-00015, RFQ-01267)' },
		'MAT-000995': { note: 'Met Coke Grade B (RFQ-01405)' },
		'MAT-000603': { note: 'Coking Coal Low-Ash' },
		'MAT-000131': { note: 'Anthracite Lump' },
	},
};

export const COMMODITY_LABEL: Record<CommodityCategory, string> = {
	steam_coal: 'Steam Coal',
	coking_coal: 'Coking Coal',
	met_coke: 'Metallurgical Coke',
	anthracite: 'Anthracite',
};

// ============================================================
// 2. Storage
// ============================================================

export const BENCHMARK_DDL = [
	`CREATE TABLE IF NOT EXISTS public.market_benchmark_observations (
		id bigserial PRIMARY KEY,
		provider text NOT NULL,
		benchmark_id text NOT NULL,
		commodity text NOT NULL,
		benchmark_name text NOT NULL,
		specification text,
		source_url text NOT NULL,
		dataset_version text,
		observation_date date NOT NULL,
		frequency text NOT NULL,
		period_label text,
		price numeric NOT NULL,
		currency text NOT NULL,
		unit text NOT NULL,
		location text,
		delivery_basis text,
		data_status text NOT NULL,
		fx_inr_per_unit numeric,
		fx_basis text,
		price_inr_per_mt numeric,
		retrieved_at timestamptz NOT NULL DEFAULT now(),
		CONSTRAINT uq_market_benchmark_observation UNIQUE (provider, benchmark_id, observation_date)
	)`,
	`CREATE INDEX IF NOT EXISTS idx_market_benchmark_obs_bench ON public.market_benchmark_observations (benchmark_id, observation_date)`,
	`CREATE TABLE IF NOT EXISTS public.market_benchmark_refreshes (
		id bigserial PRIMARY KEY,
		provider text NOT NULL,
		status text NOT NULL,
		message text,
		dataset_url text,
		dataset_version text,
		rows_upserted integer,
		started_at timestamptz NOT NULL DEFAULT now(),
		finished_at timestamptz
	)`,
	`CREATE INDEX IF NOT EXISTS idx_market_benchmark_refreshes_provider ON public.market_benchmark_refreshes (provider, started_at)`,
];

async function tablesReady(run: Run): Promise<boolean> {
	const [r] = await run(`SELECT to_regclass('public.market_benchmark_observations') IS NOT NULL AS ready`);
	return r?.ready === true;
}

async function ensureTables(run: Run): Promise<{ ok: boolean; message?: string }> {
	try {
		for (const sql of BENCHMARK_DDL) await run(sql);
		return { ok: true };
	} catch (e) {
		return { ok: false, message: `Couldn't create the benchmark tables (${errMsg(e)}). Run database/procurement-source/001_market_benchmarks.sql on the procurement database, or allow DDL on this source.` };
	}
}

export interface Observation {
	benchmarkId: string;
	provider: Provider;
	commodity: CommodityCategory;
	benchmarkName: string;
	specification: string;
	sourceUrl: string;
	datasetVersion: string | null;
	/** First day of the period for monthly data; the trading day for daily data. */
	observationDate: string;
	frequency: 'monthly' | 'daily' | 'weekly';
	periodLabel: string;
	price: number;
	currency: string;
	unit: string;
	location: string | null;
	deliveryBasis: string | null;
	dataStatus: DataStatus;
}

/** Inserts new observations; a revised value for the same date replaces the old one and is re-stamped. */
async function upsert(run: Run, obs: (Observation & { fx: FxPoint | null; priceInrPerMt: number | null })[]): Promise<number> {
	let n = 0;
	for (const o of obs) {
		const rows = await run(`
			INSERT INTO market_benchmark_observations
				(provider, benchmark_id, commodity, benchmark_name, specification, source_url, dataset_version,
				 observation_date, frequency, period_label, price, currency, unit, location, delivery_basis, data_status,
				 fx_inr_per_unit, fx_basis, price_inr_per_mt)
			VALUES (@provider, @benchmarkId, @commodity, @benchmarkName, @specification, @sourceUrl, @datasetVersion,
				 CAST(@observationDate AS date), @frequency, @periodLabel, @price, @currency, @unit, @location, @deliveryBasis, @dataStatus,
				 @fxRate, @fxBasis, @priceInr)
			ON CONFLICT (provider, benchmark_id, observation_date) DO UPDATE SET
				price = EXCLUDED.price, currency = EXCLUDED.currency, unit = EXCLUDED.unit,
				dataset_version = EXCLUDED.dataset_version, source_url = EXCLUDED.source_url,
				specification = EXCLUDED.specification, fx_inr_per_unit = EXCLUDED.fx_inr_per_unit,
				fx_basis = EXCLUDED.fx_basis, price_inr_per_mt = EXCLUDED.price_inr_per_mt, retrieved_at = now()
			WHERE (market_benchmark_observations.price, market_benchmark_observations.dataset_version, market_benchmark_observations.fx_inr_per_unit)
				IS DISTINCT FROM (EXCLUDED.price, EXCLUDED.dataset_version, EXCLUDED.fx_inr_per_unit)
			RETURNING id`, {
			provider: o.provider, benchmarkId: o.benchmarkId, commodity: o.commodity, benchmarkName: o.benchmarkName,
			specification: o.specification, sourceUrl: o.sourceUrl, datasetVersion: o.datasetVersion,
			observationDate: o.observationDate, frequency: o.frequency, periodLabel: o.periodLabel, price: o.price,
			currency: o.currency, unit: o.unit, location: o.location, deliveryBasis: o.deliveryBasis, dataStatus: o.dataStatus,
			fxRate: o.fx?.inrPerUnit ?? null, fxBasis: o.fx?.basis ?? null, priceInr: o.priceInrPerMt,
		});
		n += rows.length;
	}
	return n;
}

async function logRefresh(run: Run, r: { provider: Provider; status: string; message?: string; datasetUrl?: string | null; datasetVersion?: string | null; rows?: number }) {
	try {
		await run(`
			INSERT INTO market_benchmark_refreshes (provider, status, message, dataset_url, dataset_version, rows_upserted, finished_at)
			VALUES (@provider, @status, @message, @datasetUrl, @datasetVersion, @rows, now())`,
			{ provider: r.provider, status: r.status, message: r.message ?? null, datasetUrl: r.datasetUrl ?? null, datasetVersion: r.datasetVersion ?? null, rows: r.rows ?? null });
	} catch (e) {
		console.warn(`${LOG} couldn't log the ${r.provider} refresh: ${errMsg(e)}`);
	}
}

// ============================================================
// 3. Normalisation: units and dated FX
// ============================================================

const TONNE = /^(?:\$\/mt|usd\/mt|usd\/t|mt|t|tonnes?|metric ?tonn?e?s?|tons?)$/i;
/** 'MT' for a metric tonne however it's written, else null (not converted). */
export function normaliseUnit(raw: string): 'MT' | null {
	const u = raw.trim().replace(/^per\s+/i, '').replace(/[()]/g, '');
	return TONNE.test(u) ? 'MT' : null;
}

export interface FxPoint {
	/** Rupees per one unit of the source currency. */
	inrPerUnit: number;
	/** e.g. "ECB reference rate, average of 21 days in 2026-09 (Frankfurter)" */
	basis: string;
}

/**
 * USD→INR from ECB reference rates (Frankfurter, free, no key): the average of the month for monthly
 * observations, the rate on (or just before) the day for daily ones. One request for the whole range.
 */
export async function fxSeries(currency: string, from: string, to: string): Promise<Map<string, FxPoint> | null> {
	if (currency === 'INR') return new Map();
	const url = `https://api.frankfurter.dev/v1/${from}..${to}?base=${encodeURIComponent(currency)}&symbols=INR`;
	try {
		const res = await fetchWithTimeout(url, 15_000);
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const body: any = await res.json();
		const daily = new Map<string, number>();
		for (const [day, rates] of Object.entries(body?.rates ?? {})) {
			const inr = Number((rates as any)?.INR);
			if (inr > 0) daily.set(day, inr);
		}
		const out = new Map<string, FxPoint>();
		for (const [day, inr] of daily) out.set(day, { inrPerUnit: inr, basis: `ECB reference rate on ${day} (Frankfurter)` });
		// Monthly averages under the key YYYY-MM.
		const byMonth = new Map<string, number[]>();
		for (const [day, inr] of daily) byMonth.set(day.slice(0, 7), [...(byMonth.get(day.slice(0, 7)) ?? []), inr]);
		for (const [month, xs] of byMonth) {
			out.set(month, { inrPerUnit: round(xs.reduce((s, x) => s + x, 0) / xs.length, 4), basis: `ECB reference rate, average of ${xs.length} days in ${month} (Frankfurter)` });
		}
		return out;
	} catch (e) {
		console.warn(`${LOG} FX ${currency}→INR ${from}..${to} unavailable: ${errMsg(e)}`);
		return null;
	}
}

/** The rate for an observation: its month's average, or the closest earlier day within 7 days. */
export function fxFor(series: Map<string, FxPoint> | null, o: Pick<Observation, 'frequency' | 'observationDate' | 'currency'>): FxPoint | null {
	if (o.currency === 'INR') return { inrPerUnit: 1, basis: 'Already in INR' };
	if (!series) return null;
	if (o.frequency === 'monthly') return series.get(o.observationDate.slice(0, 7)) ?? null;
	const d = new Date(o.observationDate + 'T00:00:00Z');
	for (let i = 0; i <= 7; i++) {
		const key = new Date(d.getTime() - i * 86_400_000).toISOString().slice(0, 10);
		const hit = series.get(key);
		if (hit) return hit;
	}
	return null;
}

/** Original price → INR per metric tonne, or null when the unit or the rate is missing (never guessed). */
export function toInrPerMt(price: number, unit: string, fx: FxPoint | null): number | null {
	if (normaliseUnit(unit) !== 'MT' || !fx) return null;
	return round(price * fx.inrPerUnit, 2);
}

// ============================================================
// 4. Providers
// ============================================================

interface ProviderResult {
	provider: Provider;
	status: 'ok' | 'not_modified' | 'access_required' | 'unavailable' | 'error';
	message: string;
	datasetUrl?: string | null;
	datasetVersion?: string | null;
	observations: Observation[];
}

/** How many months of monthly history to keep from the World Bank file. */
const WB_MONTHS = 60;
const WB_SERIES: Record<string, string> = { 'Coal, Australian': 'wb_coal_australia', 'Coal, South African': 'wb_coal_south_africa' };

const cellText = (v: unknown): string => {
	if (v === null || v === undefined) return '';
	if (typeof v === 'object') {
		const o = v as any;
		if (Array.isArray(o.richText)) return o.richText.map((r: any) => r.text).join('');
		if (o.result !== undefined) return String(o.result);
		if (o.text !== undefined) return String(o.text);
	}
	return String(v);
};

/** The current monthly dataset's URL, read from the World Bank page (it changes with every release). */
async function worldBankDatasetUrl(): Promise<string> {
	const res = await fetchWithTimeout(WB_PAGE, 20_000, { headers: { 'User-Agent': 'procurement-market-benchmarks/1.0' } });
	if (!res.ok) throw new Error(`World Bank page HTTP ${res.status}`);
	const html = await res.text();
	const m = /href="(https:\/\/thedocs\.worldbank\.org\/[^"]*CMO-Historical-Data-Monthly\.xlsx)"/i.exec(html);
	if (!m) throw new Error('No CMO-Historical-Data-Monthly.xlsx link on the World Bank commodity markets page');
	return m[1];
}

/** Parses the Pink Sheet's "Monthly Prices" sheet into observations for the coal series we map. */
export async function parseWorldBankMonthly(buffer: ArrayBuffer | Buffer, datasetUrl: string): Promise<{ version: string | null; observations: Observation[] }> {
	const wb = new ExcelJS.Workbook();
	await wb.xlsx.load(buffer as any);
	const ws = wb.getWorksheet('Monthly Prices');
	if (!ws) throw new Error('Sheet "Monthly Prices" not found in the World Bank file');
	let version: string | null = null;
	let headerRow = 0;
	const cols: { col: number; benchmarkId: string; unit: string }[] = [];
	for (let r = 1; r <= 12 && !cols.length; r++) {
		const row = ws.getRow(r);
		const first = cellText(row.getCell(1).value);
		if (/^Updated on/i.test(first)) version = `World Bank Pink Sheet, ${first}`;
		row.eachCell((c, i) => {
			const label = cellText(c.value).replace(/\*+/g, '').trim();
			const id = WB_SERIES[label];
			if (id) {
				headerRow = r;
				cols.push({ col: i, benchmarkId: id, unit: cellText(ws.getRow(r + 1).getCell(i).value).trim() });
			}
		});
	}
	if (!cols.length) throw new Error('Coal columns not found in "Monthly Prices"');
	const observations: Observation[] = [];
	const months: { label: string; row: number }[] = [];
	for (let r = headerRow + 2; r <= ws.rowCount; r++) {
		const label = cellText(ws.getRow(r).getCell(1).value).trim();
		if (/^\d{4}M\d{2}$/.test(label)) months.push({ label, row: r });
	}
	for (const { label, row } of months.slice(-WB_MONTHS)) {
		const [y, m] = label.split('M');
		for (const c of cols) {
			const price = Number(cellText(ws.getRow(row).getCell(c.col).value));
			if (!Number.isFinite(price) || price <= 0) continue; // "…" = no observation
			const def = BENCHMARKS.find(b => b.id === c.benchmarkId)!;
			// The header says "($/mt)": US dollars per metric tonne.
			if (!/\$\/mt/i.test(c.unit)) throw new Error(`Unexpected unit "${c.unit}" for ${def.name}`);
			observations.push({
				benchmarkId: def.id, provider: 'world_bank', commodity: def.commodity, benchmarkName: def.name,
				specification: def.specification, sourceUrl: datasetUrl, datasetVersion: version,
				observationDate: `${y}-${m}-01`, frequency: 'monthly', periodLabel: `${y}-${m} (monthly average)`,
				price, currency: 'USD', unit: 'MT', location: def.location, deliveryBasis: def.deliveryBasis, dataStatus: 'verified_external',
			});
		}
	}
	return { version, observations };
}

/** World Bank monthly coal. Skips the download when the same file was imported in the last 7 days. */
async function worldBank(run: Run, force: boolean): Promise<ProviderResult> {
	const provider: Provider = 'world_bank';
	let url: string;
	try {
		url = await worldBankDatasetUrl();
	} catch (e) {
		return { provider, status: 'unavailable', message: `World Bank unreachable: ${errMsg(e)}`, observations: [] };
	}
	if (!force) {
		const [last] = await run(`
			SELECT dataset_url, finished_at FROM market_benchmark_refreshes
			WHERE provider = 'world_bank' AND status = 'ok' ORDER BY finished_at DESC LIMIT 1`);
		const fresh = last && last.dataset_url === url && Date.now() - new Date(last.finished_at).getTime() < 7 * 86_400_000;
		if (fresh) return { provider, status: 'not_modified', message: 'Same World Bank release already imported this week.', datasetUrl: url, observations: [] };
	}
	try {
		const res = await fetchWithTimeout(url, 60_000);
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const { version, observations } = await parseWorldBankMonthly(await res.arrayBuffer(), url);
		return { provider, status: 'ok', message: `${observations.length} monthly coal observations (${version ?? 'version not stated'}).`, datasetUrl: url, datasetVersion: version, observations };
	} catch (e) {
		return { provider, status: 'error', message: `World Bank dataset couldn't be read: ${errMsg(e)}`, datasetUrl: url, observations: [] };
	}
}

const TE_API = 'https://api.tradingeconomics.com';

/** Trading Economics coking coal: needs TRADING_ECONOMICS_API_KEY (server side only). Daily refresh. */
async function tradingEconomics(run: Run, force: boolean): Promise<ProviderResult> {
	const provider: Provider = 'trading_economics';
	const key = process.env.TRADING_ECONOMICS_API_KEY;
	if (!key) return { provider, status: 'access_required', message: 'Market benchmark unavailable — provider access required (set TRADING_ECONOMICS_API_KEY on the server).', observations: [] };
	if (!force) {
		const [last] = await run(`
			SELECT finished_at FROM market_benchmark_refreshes
			WHERE provider = 'trading_economics' AND status = 'ok' ORDER BY finished_at DESC LIMIT 1`);
		if (last && Date.now() - new Date(last.finished_at).getTime() < 86_400_000) {
			return { provider, status: 'not_modified', message: 'Refreshed in the last 24 hours.', observations: [] };
		}
	}
	const get = async (path: string): Promise<any> => {
		const res = await fetchWithTimeout(`${TE_API}${path}${path.includes('?') ? '&' : '?'}f=json`, 20_000, { headers: { Authorization: key } });
		if (res.status === 401 || res.status === 403) throw Object.assign(new Error(`HTTP ${res.status}: the key has no access to this data`), { access: true });
		if (res.status === 429) throw new Error('rate limit reached (HTTP 429); try again later');
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		return res.json();
	};
	try {
		// The symbol comes from the provider's own listing, matched by name; an override is allowed.
		let symbol = process.env.TRADING_ECONOMICS_COKING_COAL_SYMBOL || '';
		let unit = '';
		let listedName = '';
		if (!symbol) {
			const list: any[] = await get('/markets/commodities');
			const hit = (Array.isArray(list) ? list : []).find(x => /coking\s*coal/i.test(String(x?.Name ?? '')));
			if (!hit?.Symbol) return { provider, status: 'unavailable', message: 'No "Coking Coal" series in the Trading Economics commodities listing for this key.', observations: [] };
			symbol = String(hit.Symbol);
			unit = String(hit.unit ?? hit.Unit ?? '');
			listedName = String(hit.Name);
		}
		const d1 = new Date(Date.now() - 2 * 365 * 86_400_000).toISOString().slice(0, 10);
		const rows: any[] = await get(`/markets/historical/${encodeURIComponent(symbol)}?d1=${d1}`);
		const def = BENCHMARKS.find(b => b.id === 'te_coking_coal')!;
		// Documented as "USD/T"-style units; anything that isn't per tonne isn't stored as a tonne price.
		const unitOk = !unit || /\/\s*t\b|tonne|\/mt/i.test(unit);
		if (!unitOk) return { provider, status: 'error', message: `Trading Economics lists ${listedName || symbol} in "${unit}", not per tonne; not stored.`, observations: [] };
		const observations: Observation[] = [];
		for (const r of Array.isArray(rows) ? rows : []) {
			const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(r?.Date ?? '')); // documented as dd/mm/yyyy
			const close = Number(r?.Close);
			if (!m || !Number.isFinite(close) || close <= 0) continue;
			const day = `${m[3]}-${m[2]}-${m[1]}`;
			observations.push({
				benchmarkId: def.id, provider, commodity: def.commodity, benchmarkName: listedName ? `${listedName} (Trading Economics)` : def.name,
				specification: def.specification, sourceUrl: `${def.sourceUrl} (API symbol ${symbol})`, datasetVersion: null,
				observationDate: day, frequency: 'daily', periodLabel: `${day} (close)`, price: close, currency: 'USD', unit: 'MT',
				location: def.location, deliveryBasis: def.deliveryBasis, dataStatus: 'verified_external',
			});
		}
		return { provider, status: 'ok', message: `${observations.length} daily observations for ${symbol}.`, observations };
	} catch (e: any) {
		return { provider, status: e?.access ? 'access_required' : 'error', message: e?.access ? `Market benchmark unavailable — provider access required (${errMsg(e)}).` : `Trading Economics: ${errMsg(e)}`, observations: [] };
	}
}

/** Normalises and stores one provider's observations; logs the attempt either way. */
async function ingest(run: Run, result: ProviderResult): Promise<ProviderResult & { rows: number }> {
	let rows = 0;
	if (result.status === 'ok' && result.observations.length) {
		const byCurrency = new Map<string, Observation[]>();
		for (const o of result.observations) byCurrency.set(o.currency, [...(byCurrency.get(o.currency) ?? []), o]);
		const enriched: (Observation & { fx: FxPoint | null; priceInrPerMt: number | null })[] = [];
		for (const [currency, list] of byCurrency) {
			const dates = list.map(o => o.observationDate).sort();
			const end = list.some(o => o.frequency === 'monthly') ? monthEnd(dates[dates.length - 1]) : dates[dates.length - 1];
			const fx = await fxSeries(currency, dates[0], end);
			for (const o of list) {
				const point = fxFor(fx, o);
				enriched.push({ ...o, fx: point, priceInrPerMt: toInrPerMt(o.price, o.unit, point) });
			}
		}
		rows = await upsert(run, enriched);
		const noFx = enriched.filter(o => o.priceInrPerMt === null).length;
		if (noFx) result = { ...result, message: `${result.message} ${noFx} kept in their own currency only (no dated FX rate).` };
	}
	await logRefresh(run, { provider: result.provider, status: result.status, message: result.message, datasetUrl: result.datasetUrl, datasetVersion: result.datasetVersion, rows });
	return { ...result, rows };
}

const monthEnd = (day: string) => {
	const d = new Date(day + 'T00:00:00Z');
	return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
};

/** Refreshes every provider that can be reached; providers fail independently. */
export async function refreshBenchmarks(run: Run, opts: { force?: boolean } = {}) {
	if (!(await tablesReady(run))) {
		const made = await ensureTables(run);
		if (!made.ok) return { ok: false, message: made.message, providers: [] as any[] };
	}
	const results = [];
	for (const fn of [worldBank, tradingEconomics]) {
		let r: ProviderResult;
		try {
			r = await fn(run, !!opts.force);
		} catch (e) {
			r = { provider: fn === worldBank ? 'world_bank' : 'trading_economics', status: 'error', message: errMsg(e), observations: [] };
		}
		const done = r.status === 'not_modified' ? r : await ingest(run, r);
		results.push({ provider: done.provider, status: done.status, message: done.message, rows: (done as any).rows ?? 0, datasetVersion: done.datasetVersion ?? null });
	}
	results.push({
		provider: 'bigmint_import', status: 'access_required', rows: 0, datasetVersion: null,
		message: 'Market benchmark unavailable — provider access required. BigMint has no public API; load authorized exports with import-market-benchmarks.',
	});
	return { ok: true, message: 'Refreshed.', providers: results };
}

// ============================================================
// 5. Authorized imports (BigMint exports, or any licensed assessment)
// ============================================================

const IMPORT_COLUMNS = ['commodity', 'benchmark_name', 'specification', 'location', 'delivery_basis', 'observation_date', 'frequency', 'price', 'currency', 'unit', 'source_url'] as const;

function parseCsv(text: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [], cell = '', quoted = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (quoted) {
			if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch;
		} else if (ch === '"') quoted = true;
		else if (ch === ',') { row.push(cell); cell = ''; }
		else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
		else cell += ch;
	}
	if (cell || row.length) { row.push(cell); rows.push(row); }
	return rows.filter(r => r.some(c => c.trim()));
}

/**
 * Takes in an authorized export (e.g. from a BigMint subscription) as CSV with the columns in
 * IMPORT_COLUMNS. Every row is checked; nothing is stored unless every row is valid.
 */
export async function importBenchmarks(run: Run, csv: string, importedBy: string | null) {
	const rows = parseCsv(csv);
	if (rows.length < 2) return { ok: false, message: 'The CSV needs a header row and at least one observation.', rows: 0 };
	const header = rows[0].map(h => h.trim().toLowerCase());
	const missing = IMPORT_COLUMNS.filter(c => !header.includes(c));
	if (missing.length) return { ok: false, message: `Missing columns: ${missing.join(', ')}.`, rows: 0 };
	const at = (r: string[], c: string) => (r[header.indexOf(c)] ?? '').trim();
	const errors: string[] = [];
	const observations: Observation[] = [];
	rows.slice(1).forEach((r, i) => {
		const line = i + 2;
		const commodity = at(r, 'commodity') as CommodityCategory;
		const day = at(r, 'observation_date');
		const price = Number(at(r, 'price'));
		const frequency = at(r, 'frequency') as Observation['frequency'];
		const url = at(r, 'source_url');
		if (!(commodity in COMMODITY_LABEL)) errors.push(`line ${line}: commodity must be one of ${Object.keys(COMMODITY_LABEL).join(', ')}`);
		if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) errors.push(`line ${line}: observation_date must be YYYY-MM-DD`);
		if (!Number.isFinite(price) || price <= 0) errors.push(`line ${line}: price must be a positive number`);
		if (!['monthly', 'weekly', 'daily'].includes(frequency)) errors.push(`line ${line}: frequency must be daily, weekly or monthly`);
		if (!/^https?:\/\//.test(url)) errors.push(`line ${line}: source_url must be the assessment's URL`);
		if (!at(r, 'benchmark_name') || !at(r, 'currency') || !at(r, 'unit')) errors.push(`line ${line}: benchmark_name, currency and unit are required`);
		const name = at(r, 'benchmark_name');
		observations.push({
			benchmarkId: `import:${name.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 60)}`,
			provider: 'bigmint_import', commodity, benchmarkName: name, specification: at(r, 'specification'),
			sourceUrl: url, datasetVersion: importedBy ? `Authorized import by ${importedBy}` : 'Authorized import',
			observationDate: day, frequency, periodLabel: `${day} (${frequency})`, price, currency: at(r, 'currency').toUpperCase(),
			unit: at(r, 'unit'), location: at(r, 'location') || null, deliveryBasis: at(r, 'delivery_basis') || null, dataStatus: 'authorized_import',
		});
	});
	if (errors.length) return { ok: false, message: `Nothing imported. ${errors.slice(0, 8).join('; ')}${errors.length > 8 ? '; …' : ''}`, rows: 0 };
	if (!(await tablesReady(run))) {
		const made = await ensureTables(run);
		if (!made.ok) return { ok: false, message: made.message, rows: 0 };
	}
	const done = await ingest(run, { provider: 'bigmint_import', status: 'ok', message: `${observations.length} imported observations.`, observations });
	return { ok: true, message: done.message, rows: done.rows };
}

// ============================================================
// 6. Per-RFQ commodity intelligence (reads stored observations only; no network)
// ============================================================

export interface StoredObservation {
	benchmark_id: string;
	provider: Provider;
	benchmark_name: string;
	specification: string | null;
	source_url: string;
	dataset_version: string | null;
	observation_date: string;
	frequency: string;
	period_label: string | null;
	price: number;
	currency: string;
	unit: string;
	location: string | null;
	delivery_basis: string | null;
	data_status: DataStatus;
	fx_inr_per_unit: number | null;
	fx_basis: string | null;
	price_inr_per_mt: number | null;
	retrieved_at: string;
}

export interface RequirementRow { parameter: string; required_value: string; required_num: number | null; comparison: string; unit: string | null }

/** Spec-by-spec differences between what the PR asks for and what the benchmark is. */
export function comparability(def: Pick<BenchmarkDef, 'spec' | 'deliveryBasis' | 'location'> | null, reqs: RequirementRow[], allowDirect: boolean) {
	const notes: string[] = [];
	const find = (re: RegExp) => reqs.find(r => re.test(r.parameter));
	const energy = find(/calorific|gcv|ncv|energy|kcal/i);
	const origin = find(/origin|source country/i);
	const ash = find(/\bash\b/i);
	const sulphur = find(/sulph|sulfur/i);
	if (def?.spec.seaborne) notes.push(`Benchmark is a seaborne export price (${def.deliveryBasis}); our quotes are delivered to the plant.`);
	if (energy && def?.spec.energyKcalKg) {
		const req = energy.required_num;
		notes.push(`Energy: PR asks ${energy.required_value}; benchmark is ${def.spec.energyKcalKg.toLocaleString('en-IN')} kcal/kg${def.spec.energyBasis ? ` ${def.spec.energyBasis}` : ''}${req && Math.abs(req - def.spec.energyKcalKg) / def.spec.energyKcalKg > 0.05 ? ' (more than 5% apart)' : ''}.`);
	}
	if (origin && def?.spec.origin && !new RegExp(def.spec.origin, 'i').test(origin.required_value)) {
		notes.push(`Origin: PR asks ${origin.required_value}; benchmark is ${def.spec.origin}.`);
	}
	if (ash) notes.push(`Ash: PR asks ${ash.required_value}; the benchmark doesn't publish an ash limit.`);
	if (sulphur && def?.spec.maxSulphurPct != null) notes.push(`Sulphur: PR asks ${sulphur.required_value}; benchmark is below ${def.spec.maxSulphurPct}%.`);
	if (!reqs.length) notes.push('No technical requirements recorded for this PR line to compare with.');
	// Like-for-like only after review (allowDirect) and with nothing above standing in the way.
	const direct = allowDirect && !def?.spec.seaborne && notes.length === 0;
	return { status: direct ? 'direct' as const : 'reference' as const, label: direct ? 'Directly comparable' : 'Reference benchmark — not directly comparable.', notes };
}

/** Freshness of the latest observation, judged by its frequency. */
export function freshness(latest: Pick<StoredObservation, 'observation_date' | 'frequency'>, today = new Date()) {
	const start = new Date(latest.observation_date + 'T00:00:00Z');
	const end = latest.frequency === 'monthly' ? new Date(monthEnd(latest.observation_date) + 'T00:00:00Z') : start;
	const days = Math.floor((today.getTime() - end.getTime()) / 86_400_000);
	const [fresh, aging] = latest.frequency === 'monthly' ? [45, 75] : latest.frequency === 'weekly' ? [10, 21] : [3, 10];
	return { daysOld: days, status: days <= fresh ? 'current' as const : days <= aging ? 'aging' as const : 'stale' as const };
}

/** Movement over N observations back, named by frequency (monthly: "3-month", never "90-day"). */
function movements(series: StoredObservation[]) {
	const last = series[series.length - 1];
	const value = (o: StoredObservation) => Number(o.price);
	const back = (n: number) => series[series.length - 1 - n];
	const monthly = last.frequency === 'monthly';
	const spans = monthly ? [[1, '1-month'], [3, '3-month'], [12, '12-month']] as const : [[30, '30-day'], [90, '90-day']] as const;
	return spans.map(([n, label]) => {
		let base: StoredObservation | undefined;
		if (monthly) base = back(n);
		else {
			const cutoff = new Date(last.observation_date).getTime() - n * 86_400_000;
			base = [...series].reverse().find(o => new Date(o.observation_date).getTime() <= cutoff);
		}
		return base ? { label, from: base.observation_date, to: last.observation_date, changePct: pctChange(value(last), value(base)) } : { label, from: null, to: last.observation_date, changePct: null };
	});
}

/** The observation for a date: same month for monthly series, else the latest on or before it. */
export function observationFor(series: StoredObservation[], day: string): StoredObservation | null {
	if (!series.length) return null;
	if (series[0].frequency === 'monthly') return series.find(o => o.observation_date.slice(0, 7) === day.slice(0, 7)) ?? null;
	const hit = [...series].reverse().find(o => o.observation_date <= day);
	return hit && (new Date(day).getTime() - new Date(hit.observation_date).getTime()) / 86_400_000 <= 7 ? hit : null;
}

export interface IntelligenceInput {
	materialId: string;
	materialSubgroup: string;
	unit: string;
	rfqDate: string;
	prId: string;
	commodityPct: number | null;
	vendors: { vendorId: string; vendorName: string; quotedPrice: number; tRank: string | null }[];
	/** Each supplier's last price to us for this material. */
	pastSuppliers: { vendorId: string; vendorName: string; lastPrice: number; lastDate: string }[];
	lastPurchase: { price: number; date: string } | null;
}

/** Everything the Commodity Market Intelligence card, the index comparison, the should cost and the negotiation points need. */
export async function commodityIntelligence(run: Run, input: IntelligenceInput) {
	const mapping = MATERIAL_BENCHMARK_MAP.bySubgroup[input.materialSubgroup];
	if (!mapping) return { mapped: false as const, summary: 'No commodity benchmark is mapped to this material subgroup.' };
	const override = MATERIAL_BENCHMARK_MAP.byMaterial[input.materialId] ?? {};
	const base = {
		mapped: true as const,
		commodity: mapping.commodity,
		commodityLabel: COMMODITY_LABEL[mapping.commodity],
		materialNote: override.note ?? null,
	};
	if (!(await tablesReady(run))) {
		return { ...base, available: false, status: 'not_loaded', summary: 'Market benchmarks have not been loaded yet. Run Market Analysis (or refresh-market-benchmarks) to fetch them.', providers: await providerStatus(run, mapping.commodity) };
	}
	const preferred = override.benchmarks ?? mapping.benchmarks;
	const rows: StoredObservation[] = await run(`
		SELECT benchmark_id, provider, benchmark_name, specification, source_url, dataset_version,
		       observation_date::text AS observation_date, frequency, period_label, price::float8 AS price, currency, unit,
		       location, delivery_basis, data_status, fx_inr_per_unit::float8 AS fx_inr_per_unit, fx_basis,
		       price_inr_per_mt::float8 AS price_inr_per_mt, retrieved_at::text AS retrieved_at
		FROM market_benchmark_observations
		WHERE commodity = @commodity
		ORDER BY benchmark_id, observation_date`, { commodity: mapping.commodity });
	const byBenchmark = new Map<string, StoredObservation[]>();
	for (const r of rows) byBenchmark.set(r.benchmark_id, [...(byBenchmark.get(r.benchmark_id) ?? []), r]);
	// Preferred catalogue benchmarks first, then any authorized import for the same commodity.
	const order = [...preferred, ...[...byBenchmark.keys()].filter(id => !preferred.includes(id))];
	const chosenId = order.find(id => (byBenchmark.get(id) ?? []).length > 0);
	const providers = await providerStatus(run, mapping.commodity);
	if (!chosenId) {
		return { ...base, available: false, status: 'unavailable', summary: 'Market benchmark unavailable — provider access required.', providers };
	}
	const series = byBenchmark.get(chosenId)!;
	const latest = series[series.length - 1];
	const def = BENCHMARKS.find(b => b.id === chosenId) ?? null;
	const reqs: RequirementRow[] = await run(`
		SELECT parameter, required_value, required_num::float8 AS required_num, comparison, unit
		FROM pr_technical_requirements WHERE pr_id = @prId AND material_id = @materialId ORDER BY sort_order`,
		{ prId: input.prId, materialId: input.materialId }).catch(() => []);
	const comp = comparability(def ?? { spec: { seaborne: false }, deliveryBasis: latest.delivery_basis ?? 'not stated', location: latest.location ?? '' },
		reqs, (override.allowDirect ?? []).includes(chosenId));
	if (!def && !latest.delivery_basis) comp.notes.push('The imported assessment states no delivery basis.');
	const unitMatches = normaliseUnit(input.unit) === 'MT';
	const atRfq = observationFor(series, input.rfqDate);
	const refForQuotes = atRfq ?? latest;
	const refInr = unitMatches ? refForQuotes.price_inr_per_mt : null;
	const moves = movements(series);
	const share = input.commodityPct !== null ? round(input.commodityPct * 100, 1) : null;

	// C. Each quote against the benchmark (reference unless comparable).
	const suppliers = input.vendors.map(v => ({
		vendorId: v.vendorId,
		vendorName: v.vendorName,
		tRank: v.tRank,
		quotedPrice: v.quotedPrice,
		benchmarkInr: refInr,
		differenceInr: refInr !== null ? round(v.quotedPrice - refInr, 0) : null,
		differencePct: refInr !== null ? pctChange(v.quotedPrice, refInr) : null,
		comparability: comp.status,
	}));

	// Index comparison: benchmark move between a past price and this RFQ, weighted by the commodity share.
	const window = (fromDate: string) => {
		const from = observationFor(series, fromDate);
		const to = atRfq;
		if (!from || !to) return { measurable: false as const, reason: `No ${latest.frequency} observation for ${!from ? fromDate.slice(0, 7) : input.rfqDate.slice(0, 7)}.` };
		if (from.observation_date === to.observation_date) return { measurable: false as const, reason: `Both dates fall in the same ${latest.frequency === 'monthly' ? 'monthly observation' : 'observation'} (${to.period_label ?? to.observation_date}), so no benchmark movement can be measured.` };
		const change = pctChange(Number(to.price), Number(from.price))!;
		return {
			measurable: true as const,
			fromObservation: from.period_label ?? from.observation_date,
			toObservation: to.period_label ?? to.observation_date,
			fromPrice: Number(from.price),
			toPrice: Number(to.price),
			benchmarkChangePct: change,
			commodityImpactPct: share !== null ? round((change * share) / 100, 1) : null,
		};
	};
	const overall = input.lastPurchase ? { ...window(input.lastPurchase.date), baselineDate: input.lastPurchase.date, baselinePrice: input.lastPurchase.price } : null;
	const perSupplier = input.vendors.map(v => {
		const own = input.pastSuppliers.find(p => p.vendorId === v.vendorId);
		if (!own) return { vendorId: v.vendorId, vendorName: v.vendorName, tRank: v.tRank, quotedPrice: v.quotedPrice, measurable: false as const, reason: 'No earlier order of this material from this supplier.' };
		const w = window(own.lastDate);
		const quoteChange = pctChange(v.quotedPrice, own.lastPrice)!;
		return {
			vendorId: v.vendorId, vendorName: v.vendorName, tRank: v.tRank, quotedPrice: v.quotedPrice,
			lastPrice: own.lastPrice, lastDate: own.lastDate, quoteChangePct: quoteChange, ...w,
			unexplainedPts: w.measurable && w.commodityImpactPct !== null ? round(quoteChange - w.commodityImpactPct, 1) : null,
		};
	});

	// D. Insights from the data only.
	const three = moves.find(m => m.label === '3-month' || m.label === '90-day');
	const direction = three?.changePct == null ? null : three.changePct > 3 ? 'rising' : three.changePct < -3 ? 'falling' : 'stable';
	const fresh = freshness(latest);
	const insights: string[] = [];
	if (direction && three) insights.push(`${def?.name ?? latest.benchmark_name} is ${direction}: ${three.changePct! >= 0 ? '+' : ''}${three.changePct}% over ${three.label} (${three.from} to ${three.to}).`);
	const aboveIndex = perSupplier.filter(s => 'unexplainedPts' in s && s.unexplainedPts !== null && s.unexplainedPts > 1);
	for (const s of aboveIndex.slice(0, 2)) {
		insights.push(`${s.vendorName}'s quote moved ${(s as any).quoteChangePct >= 0 ? '+' : ''}${(s as any).quoteChangePct}% on their last price while the benchmark's commodity-driven impact was ${(s as any).commodityImpactPct >= 0 ? '+' : ''}${(s as any).commodityImpactPct}%: ask them to explain the other ${(s as any).unexplainedPts} points.`);
	}
	const limitations = [
		...comp.notes,
		`Observations are ${latest.frequency}${latest.frequency === 'monthly' ? ' averages, not daily prices' : ''}.`,
		fresh.status !== 'current' ? `Latest observation is ${fresh.daysOld} days past its period (${fresh.status}).` : null,
		!unitMatches ? `The material is bought per ${input.unit}, not per metric tonne, so prices aren't converted.` : null,
		refInr === null && unitMatches ? 'No dated exchange rate for this observation, so it stays in its own currency.' : null,
		'Freight, insurance, import duty and port handling are not in the benchmark and no verified figures for them are on record.',
		share !== null ? `Commodity share of the material's cost (${share}%) is from the material master.` : 'No commodity share recorded for this material.',
	].filter((x): x is string => !!x);

	return {
		...base,
		available: true,
		status: 'ok',
		benchmark: {
			id: chosenId,
			name: def?.name ?? latest.benchmark_name,
			provider: latest.provider,
			specification: latest.specification,
			location: latest.location,
			deliveryBasis: latest.delivery_basis,
			sourceUrl: latest.source_url,
			datasetVersion: latest.dataset_version,
			dataStatus: latest.data_status,
			frequency: latest.frequency,
		},
		latest: {
			observationDate: latest.observation_date,
			periodLabel: latest.period_label,
			price: Number(latest.price),
			currency: latest.currency,
			unit: latest.unit,
			priceInrPerMt: latest.price_inr_per_mt,
			fxInrPerUnit: latest.fx_inr_per_unit,
			fxBasis: latest.fx_basis,
			retrievedAt: latest.retrieved_at,
			freshness: fresh,
		},
		atRfq: atRfq ? { observationDate: atRfq.observation_date, periodLabel: atRfq.period_label, price: Number(atRfq.price), priceInrPerMt: atRfq.price_inr_per_mt, fxBasis: atRfq.fx_basis } : null,
		history: series.slice(-60).map(o => ({ date: o.observation_date, price: Number(o.price), priceInrPerMt: o.price_inr_per_mt })),
		movements: moves,
		direction,
		comparability: comp,
		commoditySharePct: share,
		suppliers,
		index: { overall, perSupplier },
		insights,
		limitations,
		alternatives: order.filter(id => id !== chosenId && (byBenchmark.get(id) ?? []).length).map(id => byBenchmark.get(id)![0].benchmark_name),
		providers,
		summary: `${def?.name ?? latest.benchmark_name}: ${latest.currency} ${latest.price}/${latest.unit} for ${latest.period_label ?? latest.observation_date}`
			+ (latest.price_inr_per_mt ? ` (≈ ₹${Math.round(latest.price_inr_per_mt).toLocaleString('en-IN')}/MT at ${latest.fx_basis})` : '')
			+ `; ${comp.label}`,
	};
}

/** Last refresh outcome per provider relevant to a commodity, for the card's "data sources" line. */
async function providerStatus(run: Run, commodity: CommodityCategory) {
	const providers = [...new Set(BENCHMARKS.filter(b => b.commodity === commodity).map(b => b.provider))];
	if (commodity !== 'steam_coal') providers.push('bigmint_import');
	const out: { provider: Provider; status: string; message: string | null; at: string | null }[] = [];
	for (const p of [...new Set(providers)]) {
		if (p === 'trading_economics' && !process.env.TRADING_ECONOMICS_API_KEY) {
			out.push({ provider: p, status: 'access_required', message: 'Market benchmark unavailable — provider access required (Trading Economics API key not configured).', at: null });
			continue;
		}
		if (p === 'bigmint_import') {
			const [imp] = await run(`SELECT count(*)::int AS n FROM market_benchmark_observations WHERE provider = 'bigmint_import' AND commodity = @commodity`, { commodity }).catch(() => [{ n: 0 }]);
			out.push({ provider: p, status: imp?.n ? 'ok' : 'access_required', message: imp?.n ? `${imp.n} authorized imported observations.` : 'Market benchmark unavailable — provider access required (BigMint subscription; authorized CSV import supported).', at: null });
			continue;
		}
		const [last] = await run(`
			SELECT status, message, finished_at::text AS at FROM market_benchmark_refreshes
			WHERE provider = @p ORDER BY started_at DESC LIMIT 1`, { p }).catch(() => []);
		out.push({ provider: p, status: last?.status ?? 'never_refreshed', message: last?.message ?? null, at: last?.at ?? null });
	}
	return out;
}

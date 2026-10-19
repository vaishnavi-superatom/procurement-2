import React, { useState } from 'react';
import { Icon } from '@iconify/react';
import ReactECharts from 'echarts-for-react';
import { COLORS, SHADOWS } from '../../design-system/tokens';
import { TRankBadge } from '../RfqReceived/TechnicalEvaluation';
import type {
  CostSplit,
  HistoricalPrice,
  IndexComparison,
  MarketInputs,
  MarketListing,
  MarketSearch,
  OnlinePrice,
  ShouldCost,
  Sustainability,
} from '../../data/rfq-recommendation';

const TEAL = {
  base: '#3A59CD',
  dark: '#2E47A4',
  tint: '#EBEEFA',
  border: '#D8DEF5',
};
// Chart line: a brighter step of the brand teal (passes the chroma and
// contrast checks the brand colour itself fails as a data colour).
const SERIES = '#0D9488';
// What we paid, in neutral grey, so the quotes in their T-rank colours stand out.
const HISTORY = COLORS.text.secondary;
// At any place, only 2 of anything (review, 18 Oct).
const SHOWN = 2;
// Recessive chart chrome: hairline grid and axis, muted labels.
const GRID = COLORS.lightGray;
const AXIS = COLORS.borderGray;
const MUTED = COLORS.text.tertiary;

const formatINR = (n: number | null | undefined): string => {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return '₹' + Math.round(n).toLocaleString('en-IN');
};

const formatDay = (d: string | null | undefined): string => {
  if (!d) return '—';
  const date = new Date(d);
  if (isNaN(date.getTime())) return d;
  return date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
};

/** Axis ticks and bar labels: ₹45K, ₹16.1 L, ₹2.45 Cr. */
const compactINR = (n: number): string => {
  const a = Math.abs(n);
  if (a >= 1e7) return `₹${+(n / 1e7).toFixed(2)} Cr`;
  if (a >= 1e5) return `₹${+(n / 1e5).toFixed(1)} L`;
  if (a >= 1e3) return `₹${+(n / 1e3).toFixed(a >= 1e4 ? 0 : 1)}K`;
  return `₹${Math.round(n)}`;
};

/** Vendor names from the database go into tooltip HTML. */
const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
};

const TOOLTIP = {
  confine: true,
  backgroundColor: COLORS.white,
  borderColor: COLORS.borderGray,
  padding: [4, 8],
  textStyle: { color: COLORS.text.primary, fontSize: 11 },
};

const T_ORDER: Record<string, number> = { T1: 1, T2: 2, T3: 3, T4: 4 };
/** Best T-rank first, then cheapest: "all our sellers rank-wise" (meeting, 18 Oct). */
const byTRank = (a: QuoteRef, b: QuoteRef) => (T_ORDER[a.tRank ?? ''] ?? 9) - (T_ORDER[b.tRank ?? ''] ?? 9) || a.price - b.price;

/** A round axis end at or above `n`, so a should cost above every quote stays on the chart. */
const niceCeil = (n: number): number => {
  const step = 10 ** Math.floor(Math.log10(n)) / 2;
  return Math.ceil(n / step) * step;
};

/** ① Every quote as a bar, in the order given, against the should cost line. */
const QuotesVsShouldCost: React.FC<{ quotes: QuoteRef[]; shouldCost: number | null }> = ({ quotes, shouldCost }) => {
  if (quotes.length === 0) return null;
  const top = Math.max(...quotes.map((q) => q.price));
  const option = {
    animation: false,
    grid: { left: 4, right: 56, top: 4, bottom: 0, containLabel: true },
    xAxis: {
      type: 'value',
      min: 0,
      max: shouldCost != null && shouldCost > top ? niceCeil(shouldCost) : undefined,
      axisLabel: { color: MUTED, fontSize: 10, formatter: compactINR },
      splitLine: { lineStyle: { color: GRID } },
    },
    yAxis: {
      type: 'category',
      inverse: true,
      data: quotes.map((q) => `${q.vendorName} · ${q.tRank ?? '—'}`),
      axisLabel: { color: COLORS.text.primary, fontSize: 11 },
      axisLine: { lineStyle: { color: AXIS } },
      axisTick: { show: false },
    },
    tooltip: {
      ...TOOLTIP,
      trigger: 'item',
      formatter: (p: { dataIndex: number }) => {
        const q = quotes[p.dataIndex];
        const vs = shouldCost != null ? `<br/><span style="color:${COLORS.text.secondary}">${vsText(q.price, shouldCost)} the should cost</span>` : '';
        return `<b>${formatINR(q.price)}</b><br/><span style="color:${COLORS.text.secondary}">${esc(q.vendorName)} · ${esc(q.tRank ?? '—')}</span>${vs}`;
      },
    },
    series: [
      {
        type: 'bar',
        data: quotes.map((q) => q.price),
        barMaxWidth: 16,
        itemStyle: { color: SERIES, borderRadius: [0, 4, 4, 0] },
        emphasis: { itemStyle: { opacity: 0.85 } },
        label: { show: true, position: 'right', color: COLORS.text.secondary, fontSize: 10, formatter: (p: { value: number }) => compactINR(p.value) },
        // Keyed above the chart rather than labelled here, so the label can't land on the bars.
        markLine:
          shouldCost != null
            ? { silent: true, symbol: 'none', label: { show: false }, lineStyle: { color: COLORS.text.primary, width: 2, type: 'solid' }, data: [{ xAxis: shouldCost }] }
            : undefined,
      },
    ],
  };
  return (
    <div role="img" aria-label={`Quoted price of each vendor, best T-rank first${shouldCost != null ? ', against the should cost' : ''}`}>
      <ReactECharts option={option} notMerge opts={{ renderer: 'svg' }} style={{ height: quotes.length * 30 + 26, width: '100%' }} />
    </div>
  );
};

/** ② What we paid, order by order, with this RFQ's quotes at its date. */
/**
 * What we paid, order by order: one line, so no legend (the card title names it). The current
 * quotes sit in the boxes above it, not on the chart (review, 19 Oct: "remove these dots").
 */
const PriceHistoryChart: React.FC<{ orders: NonNullable<HistoricalPrice['orders']> }> = ({ orders }) => {
  // One supplier's orders of this material (the picker above chooses whose).
  const points = orders.map((o) => ({ t: Date.parse(o.date), price: o.price, who: o.vendorName }));
  if (points.length === 0) return null;
  const dates = points.map((p) => p.t);
  const option = {
    animation: false,
    grid: { left: 4, right: 12, top: 8, bottom: 0, containLabel: true },
    xAxis: {
      type: 'time',
      boundaryGap: ['2%', '4%'],
      axisLabel: { color: MUTED, fontSize: 10, hideOverlap: true, formatter: '{MMM} {yy}' },
      axisLine: { lineStyle: { color: AXIS } },
      axisTick: { show: false },
      splitLine: { show: false },
    },
    yAxis: {
      type: 'value',
      scale: true,
      // Unit price per order (purchase_orders.unit_price), never the order's total value.
      name: 'Unit price',
      nameTextStyle: { color: MUTED, fontSize: 10, align: 'left' },
      axisLabel: { color: MUTED, fontSize: 10, formatter: compactINR },
      splitLine: { lineStyle: { color: GRID } },
    },
    tooltip: {
      ...TOOLTIP,
      trigger: 'axis',
      axisPointer: { type: 'line', snap: true, lineStyle: { color: MUTED, width: 1 } },
      // That day's orders, at the nearest date.
      formatter: (params: { axisValue?: number } | { axisValue?: number }[]) => {
        const x = Number((Array.isArray(params) ? params[0] : params)?.axisValue);
        const at = dates.reduce((best, t) => (Math.abs(t - x) < Math.abs(best - x) ? t : best), dates[0]);
        const muted = (text: string) => `<span style="color:${COLORS.text.secondary}">${text}</span>`;
        return [
          muted(formatDay(new Date(at).toISOString())),
          ...points.filter((p) => p.t === at).map((p) => `<b>${formatINR(p.price)}</b> ${muted(`paid to ${esc(p.who)}`)}`),
        ].join('<br/>');
      },
    },
    series: [
      {
        name: 'What we paid',
        type: 'line',
        data: points.map((p) => [p.t, p.price]),
        // A lone order still shows as a dot.
        showSymbol: points.length <= 60,
        symbol: 'circle',
        symbolSize: 8,
        lineStyle: { width: 2, color: HISTORY, cap: 'round', join: 'round' },
        itemStyle: { color: HISTORY, borderColor: COLORS.white, borderWidth: 2 },
      },
    ],
  };
  return (
    <div role="img" aria-label={`What we paid ${points[0].who} for this item, order by order`}>
      <ReactECharts option={option} notMerge opts={{ renderer: 'svg' }} style={{ height: 180, width: '100%' }} />
    </div>
  );
};

/** A supplier in the Price History picker: anyone quoting now, then anyone we've bought this material from. */
interface HistorySupplier {
  vendorId: string;
  vendorName: string;
  tRank: string | null;
  quoting: boolean;
}

/**
 * A supplier's min / max / average for this material. From the backend's figures over all its orders
 * when present; a study saved before 19 Oct only has the latest 240 orders (and maybe no vendor ids), so
 * the figures come from those, matched by id or else by name, and say so.
 */
function statsFor(data: HistoricalPrice, s: HistorySupplier) {
  const all = data.orders ?? [];
  const mine = all.filter((o) => (o.vendorId ? o.vendorId === s.vendorId : o.vendorName === s.vendorName));
  const full = data.supplierStats?.find((x) => x.vendorId === s.vendorId);
  if (full) return { orders: mine, min: full.minPrice, max: full.maxPrice, avg: full.avgPrice, count: full.orders, fromChartOnly: false };
  if (mine.length === 0) return { orders: mine, min: null, max: null, avg: null, count: 0, fromChartOnly: false };
  const prices = mine.map((o) => o.price);
  return {
    orders: mine,
    min: Math.min(...prices),
    max: Math.max(...prices),
    avg: prices.reduce((sum, p) => sum + p, 0) / prices.length,
    count: mine.length,
    fromChartOnly: true,
  };
}

/** A labelled figure; several sit on one line to compare at a glance. */
const Figure: React.FC<{ label: React.ReactNode; value: string; unit?: string; sub?: string; strong?: boolean }> = ({ label, value, unit, sub, strong }) => (
  <div
    className="rounded-md px-2.5 py-1.5 min-w-0"
    style={{ backgroundColor: strong ? TEAL.tint : COLORS.lightBackground, border: `1px solid ${strong ? TEAL.border : COLORS.lightGray}` }}
  >
    <div className="flex items-center gap-1 text-[11px] whitespace-nowrap" style={{ color: COLORS.text.secondary }}>{label}</div>
    <p className="text-sm font-bold leading-tight whitespace-nowrap" style={{ color: COLORS.text.primary }}>
      {value}
      {unit && <span className="text-[10px] font-normal" style={{ color: COLORS.text.tertiary }}> / {unit}</span>}
    </p>
    {sub && <p className="text-[10px] whitespace-nowrap" style={{ color: COLORS.text.tertiary }}>{sub}</p>}
  </div>
);

/** `hint`: one line saying what the card is, for inputs that aren't self-explanatory. */
// No 1–5 numbers on the cards (review, 18 Oct).
const Card: React.FC<{ title: string; hint?: string; className?: string; children: React.ReactNode }> = ({ title, hint, className = '', children }) => (
  <div className={`rounded-lg p-3 flex flex-col gap-1.5 min-w-0 ${className}`} style={{ border: `1px solid ${TEAL.border}`, backgroundColor: COLORS.white }}>
    <span className="text-[11px] font-semibold uppercase tracking-wide truncate" style={{ color: COLORS.text.secondary }}>{title}</span>
    {hint && <p className="text-[11px] leading-snug" style={{ color: COLORS.text.tertiary }}>{hint}</p>}
    {children}
  </div>
);

const Skeleton: React.FC<{ lines?: number }> = ({ lines = 3 }) => (
  <div className="space-y-2 pt-1 animate-pulse">
    <div className="h-6 w-24 rounded" style={{ backgroundColor: '#E2E8F0' }} />
    {Array.from({ length: lines }).map((_, i) => (
      <div key={i} className="h-3 rounded" style={{ backgroundColor: COLORS.lightGray, width: `${90 - i * 15}%` }} />
    ))}
  </div>
);

const Unavailable: React.FC<{ text: string }> = ({ text }) => (
  <p className="text-xs" style={{ color: COLORS.text.tertiary }}>{text}</p>
);

// ============================================================
// Should cost: one per product, the same for every supplier.
//   Should cost = Raw Material/BOM + Machining/Conversion + IP/Licensing + Overhead
//                 + Logistics + Packaging + Supplier margin
// Where the figures come from, in order:
//   1. Entered figures (material_should_costs), when the team has entered them: real amounts.
//   2. Otherwise the market price the recommendation uses, split by this material's commodity
//      shares from material_master (the only product-level split in our data). Those amounts are
//      estimates (a share of the market price), and any component without a share is Unavailable,
//      never guessed.
// ============================================================

const UNAVAILABLE = 'Unavailable';

/** The seven components, and the labels that match them in entered material_should_costs lines. */
const SHOULD_COST_COMPONENTS: { key: string; label: string; match: RegExp; what: string }[] = [
  { key: 'bom', label: 'Raw Material / BOM', match: /bill|bom|raw|material/i, what: 'Materials and bought-out parts' },
  { key: 'conversion', label: 'Machining / Conversion', match: /machin|conversion|process|labou?r|manpower/i, what: 'Turning the materials into the product' },
  { key: 'ip', label: 'IP / Licensing', match: /\bip\b|licen|royalt|patent/i, what: 'Design rights and licences' },
  { key: 'overhead', label: 'Overhead', match: /overhead|admin/i, what: "Plant and administrative costs" },
  { key: 'logistics', label: 'Logistics', match: /freight|logistic|transport|handling|shipping/i, what: 'Freight and handling to our plant' },
  { key: 'packaging', label: 'Packaging', match: /packag|packing/i, what: 'Packing for transport and storage' },
  { key: 'margin', label: 'Supplier margin', match: /margin|profit/i, what: "The supplier's profit" },
];

/** In material_master, LABOR is the conversion share; every other commodity is a raw material. */
const LABOUR_COMMODITY = 'LABOR';

interface ShouldCostRow {
  key: string;
  label: string;
  what: string;
  /** Share of the should cost, %. */
  pct: number | null;
  amount: number | null;
  basis: string;
  /** An amount apportioned from a share, not an entered cost. */
  estimate: boolean;
}

const sameUnit = (a?: string | null, b?: string | null) => !a || !b || a.trim().toLowerCase() === b.trim().toLowerCase();

/** The benchmark: the market price already used for the recommendation, else today's best listing. */
function benchmarkOf(online: OnlinePrice | null, search: MarketSearch | null): { amount: number; unit: string | null; source: string } | null {
  if (online?.available && online.priceInr != null) {
    const what = online.matchedModel ? `${online.matchedModel}${online.basis ? `, ${online.basis}` : ''}` : online.basis || 'Online market price';
    return { amount: online.priceInr, unit: online.unit ?? null, source: what };
  }
  const l = search?.bestListing;
  if (l && l.priceInr != null) {
    return { amount: l.priceInr, unit: l.unit || null, source: `${l.region} listing on ${l.source}${l.currency !== 'INR' ? ', before freight and import duty' : ''}` };
  }
  return null;
}

/** The product's should cost, component by component, from the best data we have (see above). */
function shouldCostModel(entered: ShouldCost | null, split: CostSplit | null | undefined, benchmark: ReturnType<typeof benchmarkOf>) {
  // 1. Entered figures.
  if (entered?.available && entered.shouldCost != null && entered.breakdown?.length) {
    const total = entered.shouldCost;
    const rows: ShouldCostRow[] = SHOULD_COST_COMPONENTS.map((c) => {
      const line = entered.breakdown!.find((b) => c.match.test(b.label));
      return {
        key: c.key,
        label: c.label,
        what: c.what,
        amount: line ? line.amount : null,
        pct: line && total ? (line.amount / total) * 100 : null,
        basis: line ? `Entered: ${line.label}` : 'Not entered for this material',
        estimate: false,
      };
    });
    return { total, unit: entered.unit ?? null, totalBasis: `Entered should cost${entered.source ? ` (${entered.source})` : ''}`, rows, estimated: false };
  }

  // 2. The market price, split by this material's commodity shares.
  const total = benchmark?.amount ?? null;
  const shares = split?.available ? split.commodities ?? [] : [];
  const raw = shares.filter((c) => c.commodity !== LABOUR_COMMODITY);
  const labour = shares.filter((c) => c.commodity === LABOUR_COMMODITY);
  const fromShares = (list: { commodity: string; sharePct: number }[]) => {
    if (list.length === 0) return null;
    const pct = list.reduce((s, c) => s + c.sharePct, 0);
    return { pct, basis: `${list.map((c) => `${c.commodity} ${c.sharePct}%`).join(' + ')} of cost (material master)` };
  };
  const known: Record<string, ReturnType<typeof fromShares>> = { bom: fromShares(raw), conversion: fromShares(labour) };
  const rows: ShouldCostRow[] = SHOULD_COST_COMPONENTS.map((c) => {
    const share = known[c.key];
    return {
      key: c.key,
      label: c.label,
      what: c.what,
      pct: share?.pct ?? null,
      amount: share && total != null ? (total * share.pct) / 100 : null,
      basis: share?.basis ?? 'Not recorded for this material',
      estimate: !!share,
    };
  });
  return { total, unit: benchmark?.unit ?? null, totalBasis: benchmark ? `Market price: ${benchmark.source}` : null, rows, estimated: true };
}

const signedPct = (v: number | null | undefined, digits = 1) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(digits)}%`);

/**
 * What the product should cost delivered to us, part by part, once for all suppliers, so the buyer
 * can hold every quote against it. Sits at the bottom of the study, full width.
 */
const ShouldCostCard: React.FC<{
  entered: ShouldCost | null;
  split: CostSplit | null | undefined;
  online: OnlinePrice | null;
  marketSearch: MarketSearch | null;
  loading: boolean;
  quotes: QuoteRef[];
  unit?: string;
  productName?: string;
}> = ({ entered, split, online, marketSearch, loading, quotes, unit, productName }) => {
  const benchmark = benchmarkOf(online, marketSearch);
  const model = shouldCostModel(entered, split, benchmark);
  const { total, rows } = model;
  const knownPct = rows.reduce((s, r) => s + (r.pct ?? 0), 0);
  // The part of the cost our data doesn't split into components.
  const restPct = total != null && model.estimated ? Math.max(0, 100 - knownPct) : 0;
  const restAmount = total != null ? (total * restPct) / 100 : null;
  const shownUnit = model.unit || unit;
  const unitMismatch = total != null && !sameUnit(model.unit, unit);
  const ranked = [...quotes].sort(byTRank);
  const lowest = ranked.length ? Math.min(...ranked.map((q) => q.price)) : null;
  const anyEstimate = rows.some((r) => r.estimate);

  const formulaNumbers = [
    ...rows.map((r) => (r.amount != null ? `${formatINR(r.amount)}${r.estimate ? '*' : ''}` : UNAVAILABLE)),
    ...(restPct > 0.05 && restAmount != null ? [`${formatINR(restAmount)}* not broken down`] : []),
  ].join(' + ');

  return (
    <Card title={productName ? `Should cost · ${productName}` : 'Should cost'} className="lg:col-span-2">
      {loading && total == null ? (
        <>
          <Skeleton lines={2} />
          <p className="text-[11px] flex items-center gap-1" style={{ color: COLORS.text.tertiary }}>
            <Icon icon="mdi:earth" className="w-3.5 h-3.5" /> Waiting for the market price to build the should cost…
          </p>
        </>
      ) : (
        <>
          {/* The final value, up front: one for the product, not one per supplier */}
          <div className="flex flex-wrap items-end gap-x-3 gap-y-1">
            <div className="rounded-md px-3 py-2" style={{ backgroundColor: TEAL.tint, border: `1px solid ${TEAL.border}` }}>
              <div className="text-[11px]" style={{ color: COLORS.text.secondary }}>Should cost, every supplier</div>
              <p className="text-xl font-bold leading-tight whitespace-nowrap" style={{ color: total != null ? COLORS.text.primary : COLORS.text.tertiary }}>
                {total != null ? formatINR(total) : UNAVAILABLE}
                {total != null && shownUnit && <span className="text-xs font-normal" style={{ color: COLORS.text.tertiary }}> / {shownUnit}</span>}
              </p>
            </div>
            {anyEstimate && (
              <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold mb-1" style={{ backgroundColor: '#FEF3C7', color: '#B45309' }}>
                * Estimate: split by this material's commodity shares
              </span>
            )}
            {total != null && lowest != null && !unitMismatch && (
              <span className="text-[11px] mb-1.5" style={{ color: COLORS.text.secondary }}>
                Lowest quote {formatINR(lowest)} is {vsText(lowest, total)} the should cost
              </span>
            )}
          </div>
          {model.totalBasis && (
            <p className="text-[11px]" style={{ color: COLORS.text.tertiary }}>Total from: {model.totalBasis}</p>
          )}
          {total == null && (
            <p className="text-[11px]" style={{ color: COLORS.text.tertiary }}>
              No should cost has been entered for this material and no market price has been found yet, so there's no total to split.
            </p>
          )}
          {unitMismatch && (
            <p className="text-[11px]" style={{ color: '#B45309' }}>
              The should cost is priced per {model.unit} and the quotes per {unit}, so they aren't compared here.
            </p>
          )}

          {/* Formula and the numbers that go into it */}
          <div className="rounded-md px-3 py-2 mt-1 text-[11px] space-y-0.5" style={{ backgroundColor: COLORS.lightBackground, border: `1px solid ${COLORS.lightGray}` }}>
            <p style={{ color: COLORS.text.secondary }}>
              <span className="font-semibold" style={{ color: COLORS.text.primary }}>Formula: </span>
              Should cost = Raw Material/BOM + Machining/Conversion + IP/Licensing + Overhead + Logistics + Packaging + Supplier margin
            </p>
            <p className="tabular-nums" style={{ color: COLORS.text.secondary }}>
              = {formulaNumbers} = <b style={{ color: COLORS.text.primary }}>{total != null ? formatINR(total) : UNAVAILABLE}</b>
            </p>
            {model.estimated && (
              <p style={{ color: COLORS.text.tertiary }}>
                The split is this material's, so it's the same for every supplier. Components with no recorded share are Unavailable;
                their combined share is shown as "not broken down".
              </p>
            )}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead>
                <tr style={{ color: COLORS.text.tertiary }}>
                  {['Component', 'Basis', 'Share', 'Amount'].map((h) => (
                    <th key={h} className={`${h === 'Share' || h === 'Amount' ? 'text-right' : 'text-left'} font-medium py-1 pr-3 whitespace-nowrap`}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key} style={{ borderTop: `1px solid ${COLORS.lightGray}` }}>
                    <td className="py-1.5 pr-3 align-top">
                      <div className="font-medium whitespace-nowrap" style={{ color: COLORS.text.primary }}>{r.label}</div>
                      <div style={{ color: COLORS.text.tertiary }}>{r.what}</div>
                    </td>
                    <td className="py-1.5 pr-3 align-top" style={{ color: COLORS.text.secondary }}>{r.basis}</td>
                    <td className="py-1.5 pr-3 align-top text-right whitespace-nowrap tabular-nums" style={{ color: r.pct != null ? COLORS.text.primary : COLORS.text.tertiary }}>
                      {r.pct != null ? `${r.pct.toFixed(1)}%` : UNAVAILABLE}
                    </td>
                    <td className="py-1.5 pr-3 align-top text-right whitespace-nowrap tabular-nums" style={{ color: r.amount != null ? COLORS.text.primary : COLORS.text.tertiary }}>
                      {r.amount != null ? `${formatINR(r.amount)}${r.estimate ? '*' : ''}` : UNAVAILABLE}
                    </td>
                  </tr>
                ))}
                {restPct > 0.05 && (
                  <tr style={{ borderTop: `1px solid ${COLORS.lightGray}` }}>
                    <td className="py-1.5 pr-3 align-top">
                      <div className="font-medium whitespace-nowrap" style={{ color: COLORS.text.secondary }}>Not broken down</div>
                      <div style={{ color: COLORS.text.tertiary }}>The unavailable components above, together</div>
                    </td>
                    <td className="py-1.5 pr-3 align-top" style={{ color: COLORS.text.secondary }}>Rest of the total</td>
                    <td className="py-1.5 pr-3 align-top text-right whitespace-nowrap tabular-nums" style={{ color: COLORS.text.secondary }}>{restPct.toFixed(1)}%</td>
                    <td className="py-1.5 pr-3 align-top text-right whitespace-nowrap tabular-nums" style={{ color: COLORS.text.secondary }}>
                      {restAmount != null ? `${formatINR(restAmount)}*` : UNAVAILABLE}
                    </td>
                  </tr>
                )}
                <tr style={{ borderTop: `1px solid ${TEAL.border}` }}>
                  <td className="py-1.5 pr-3 font-semibold" style={{ color: COLORS.text.primary }} colSpan={2}>Should cost</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums" style={{ color: COLORS.text.secondary }}>{total != null ? '100%' : '—'}</td>
                  <td className="py-1.5 pr-3 text-right font-bold whitespace-nowrap tabular-nums" style={{ color: COLORS.text.primary }}>
                    {total != null ? formatINR(total) : UNAVAILABLE}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          {total != null && !unitMismatch && ranked.length > 0 && (
            <>
              <p className="flex items-center gap-1.5 text-[11px] mt-1" style={{ color: COLORS.text.secondary }}>
                <span aria-hidden className="inline-block flex-none" style={{ width: 2, height: 12, backgroundColor: COLORS.text.primary }} />
                Should cost line
              </p>
              <QuotesVsShouldCost quotes={ranked} shouldCost={total} />
            </>
          )}

          <p className="text-[11px] leading-snug mt-1" style={{ color: COLORS.text.tertiary }}>
            <span className="font-semibold" style={{ color: COLORS.text.secondary }}>Why it matters: </span>
            Should cost is a fair, independent estimate of what this product ought to cost delivered to us. Holding each quotation against it
            shows which suppliers are priced above a reasonable cost, and by how much, so the buyer knows where there is room to negotiate.
          </p>
        </>
      )}
    </Card>
  );
};

/**
 * Index-based price comparison: how the material's commodity indices moved between our last purchase
 * and this RFQ, the part of the product's cost that move explains, and each quote against it.
 */
const IndexComparisonCard: React.FC<{ data: IndexComparison | null | undefined; loading: boolean; quotes: QuoteRef[]; unit?: string }> = ({
  data,
  loading,
  quotes,
  unit,
}) => {
  const ranked = [...quotes].sort(byTRank);
  return (
    <Card
      title="Index-based price comparison"
      hint="Only the commodity's share of the product's cost moves with its index: an 8% rise in a commodity that is 60% of the cost explains about 4.8%, not 8%."
    >
      {loading ? (
        <Skeleton />
      ) : !data ? (
        <Unavailable text="Not in this saved analysis. Re-run the Market Analysis to see it." />
      ) : !data.available || !data.baseline ? (
        <Unavailable text={data.summary} />
      ) : (
        <>
          <p className="text-[11px]" style={{ color: COLORS.text.secondary }}>
            From our last purchase, <b style={{ color: COLORS.text.primary }}>{formatINR(data.baseline.price)}</b>
            {unit && ` / ${unit}`} on {formatDay(data.baseline.date)}, to this RFQ on {formatDay(data.rfqDate)}.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead>
                <tr style={{ color: COLORS.text.tertiary }}>
                  {['Index', 'Share of cost', 'Index change', 'Effect on cost'].map((h) => (
                    <th key={h} className={`${h === 'Index' ? 'text-left' : 'text-right'} font-medium py-1 pr-3 whitespace-nowrap`}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(data.indices ?? []).map((i) => (
                  <tr key={i.commodity} style={{ borderTop: `1px solid ${COLORS.lightGray}` }}>
                    <td
                      className="py-1 pr-3 font-medium"
                      style={{ color: COLORS.text.primary }}
                      title={
                        i.fromPrice != null && i.toPrice != null
                          ? `${formatINR(i.fromPrice)} (${formatDay(i.fromDate)}) → ${formatINR(i.toPrice)} (${formatDay(i.toDate)})${i.unit ? ` ${i.unit}` : ''}`
                          : 'No index price for part of the period'
                      }
                    >
                      {i.commodity}
                    </td>
                    <td className="py-1 pr-3 text-right tabular-nums" style={{ color: COLORS.text.secondary }}>{i.sharePct}%</td>
                    <td className="py-1 pr-3 text-right tabular-nums" style={{ color: COLORS.text.secondary }}>{signedPct(i.changePct)}</td>
                    <td className="py-1 pr-3 text-right tabular-nums font-semibold" style={{ color: COLORS.text.primary }}>{signedPct(i.effectPct)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.expectedEffectPct != null && (
            <div className="flex flex-wrap gap-2">
              <Figure strong label="Indices explain" value={signedPct(data.expectedEffectPct)} />
              {data.indexExplainedPrice != null && <Figure label="Index-explained price" value={formatINR(data.indexExplainedPrice)} unit={unit} />}
            </div>
          )}
          {ranked.length > 0 && data.expectedEffectPct != null && (
            <div className="overflow-x-auto">
              <table className="w-full text-[11px]">
                <thead>
                  <tr style={{ color: COLORS.text.tertiary }}>
                    {['Supplier', 'Quote', 'vs last purchase', 'Beyond the index'].map((h) => (
                      <th key={h} className={`${h === 'Supplier' ? 'text-left' : 'text-right'} font-medium py-1 pr-3 whitespace-nowrap`}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {ranked.map((q) => {
                    const change = ((q.price - data.baseline!.price) / data.baseline!.price) * 100;
                    const gap = change - (data.expectedEffectPct as number);
                    return (
                      <tr key={q.vendorId} style={{ borderTop: `1px solid ${COLORS.lightGray}` }}>
                        <td className="py-1 pr-3" style={{ color: COLORS.text.primary }}>
                          <span className="inline-flex items-center gap-1">
                            <span className="truncate">{q.vendorName}</span>
                            <TRankBadge rank={q.tRank} />
                          </span>
                        </td>
                        <td className="py-1 pr-3 text-right tabular-nums whitespace-nowrap" style={{ color: COLORS.text.primary }}>{formatINR(q.price)}</td>
                        <td className="py-1 pr-3 text-right tabular-nums" style={{ color: COLORS.text.secondary }}>{signedPct(change)}</td>
                        <td
                          className="py-1 pr-3 text-right tabular-nums font-semibold whitespace-nowrap"
                          style={{ color: gap > 0 ? '#B45309' : '#16A34A' }}
                          title="Quote change minus the change the indices explain, in percentage points"
                        >
                          {gap > 0 ? '+' : ''}{gap.toFixed(1)} pts
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="text-[10px] leading-snug" style={{ color: COLORS.text.tertiary }}>
            Positive "beyond the index" means the quote rose more than the commodity indices explain. The rest of the cost (conversion,
            overhead, logistics, margin) isn't indexed in our data, so part of a gap may come from there.
          </p>
        </>
      )}
    </Card>
  );
};

/**
 * The current quotes in small boxes, then what we paid before (review, 18 Oct: no averages, no text
 * under the chart; 19 Oct: the boxes back on top, the dots off the chart).
 */
const PriceHistoryCard: React.FC<{ data: HistoricalPrice | null; quotes: QuoteRef[] }> = ({ data, quotes }) => {
  const ranked = [...quotes].sort(byTRank);
  // Quoting suppliers first (best T-rank first), then past suppliers of this material who aren't quoting.
  const quotingIds = new Set(ranked.map((q) => q.vendorId));
  const suppliers: HistorySupplier[] = [
    ...ranked.map((q) => ({ vendorId: q.vendorId, vendorName: q.vendorName, tRank: q.tRank, quoting: true })),
    ...(data?.supplierStats ?? data?.pastSuppliers ?? [])
      .filter((s) => !quotingIds.has(s.vendorId))
      .map((s) => ({ vendorId: s.vendorId, vendorName: s.vendorName, tRank: null, quoting: false })),
  ];
  const [picked, setPicked] = useState<string | null>(null);
  // One supplier at a time; by default the best-ranked quoting supplier we've bought this material from.
  const fallback = data
    ? suppliers.find((s) => s.quoting && statsFor(data, s).count > 0) ?? suppliers.find((s) => statsFor(data, s).count > 0) ?? suppliers[0]
    : suppliers[0];
  const selected = suppliers.find((s) => s.vendorId === picked) ?? fallback;
  const stats = data && selected ? statsFor(data, selected) : null;
  return (
    <Card title="Cost History">
      {ranked.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {ranked.map((q) => (
            <Figure
              key={q.vendorId}
              label={
                <>
                  <span className="truncate">{q.vendorName}</span>
                  <TRankBadge rank={q.tRank} />
                </>
              }
              value={formatINR(q.price)}
            />
          ))}
        </div>
      )}
      {!data ? (
        <Skeleton />
      ) : !data.available ? (
        <Unavailable text={data.summary} />
      ) : (
        <>
          {/* Suppliers: pick one to see only its prices (one at a time keeps the chart readable). */}
          {suppliers.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label="Supplier">
              <span className="text-[11px] font-semibold mr-0.5" style={{ color: COLORS.text.secondary }}>Suppliers:</span>
              {suppliers.map((s) => {
                const on = s.vendorId === selected?.vendorId;
                return (
                  <button
                    key={s.vendorId}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => setPicked(s.vendorId)}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium transition-colors duration-150"
                    style={{
                      backgroundColor: on ? TEAL.base : COLORS.white,
                      color: on ? COLORS.white : COLORS.text.primary,
                      border: `1px solid ${on ? TEAL.base : TEAL.border}`,
                    }}
                    title={s.quoting ? 'Quoting on this RFQ' : 'Past supplier of this material'}
                  >
                    {s.vendorName}
                    {s.tRank && <span style={{ opacity: on ? 0.85 : 0.6 }}>· {s.tRank}</span>}
                  </button>
                );
              })}
            </div>
          )}
          {selected && stats && stats.count > 0 ? (
            <>
              <PriceHistoryChart orders={stats.orders} />
              <div className="flex flex-wrap gap-2">
                <Figure label="Minimum" value={formatINR(stats.min)} unit={data.unit} />
                <Figure label="Maximum" value={formatINR(stats.max)} unit={data.unit} />
                <Figure strong label="Average" value={formatINR(stats.avg)} unit={data.unit} />
              </div>
              {/* What the figures are, so they're read on the same basis as the quotes. */}
              <p className="text-[10px] leading-snug" style={{ color: COLORS.text.tertiary }}>
                {selected.vendorName}: {stats.count} purchase order{stats.count === 1 ? '' : 's'} of this material before this RFQ, unit prices in ₹ per {data.unit}.
                {stats.fromChartOnly
                  ? ' This saved study only carries the latest orders, so the figures cover those; re-run the Market Analysis for the full history.'
                  : stats.orders.length < stats.count
                    ? ` The chart shows the latest ${stats.orders.length}; the figures cover all ${stats.count}.`
                    : ''}
              </p>
            </>
          ) : (
            selected && <Unavailable text="No historical pricing data available." />
          )}
          <PastSuppliers data={data} />
        </>
      )}
    </Card>
  );
};

/** Who we bought it from before ("who are the suppliers in past?"), latest first; two, the rest on request. */
const PastSuppliers: React.FC<{ data: HistoricalPrice }> = ({ data }) => {
  const [showAll, setShowAll] = useState(false);
  const all = data.pastSuppliers ?? [];
  if (all.length === 0) return null;
  const rows = showAll ? all : all.slice(0, SHOWN);
  return (
    <div className="mt-1">
      <p className="text-[11px] font-semibold" style={{ color: COLORS.text.secondary }}>Past suppliers</p>
      <div className="overflow-x-auto">
        <table className="w-full text-[11px] mt-0.5">
          <thead>
            <tr style={{ color: COLORS.text.tertiary }}>
              {['Supplier', 'Orders', 'Last price', 'Last ordered'].map((h) => (
                <th key={h} className="text-left font-medium py-1 pr-3 whitespace-nowrap">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.vendorId} style={{ borderTop: `1px solid ${COLORS.lightGray}` }}>
                <td className="py-1 pr-3" style={{ color: COLORS.text.primary }}>{s.vendorName}</td>
                <td className="py-1 pr-3" style={{ color: COLORS.text.secondary }}>{s.orders}</td>
                <td className="py-1 pr-3 whitespace-nowrap" style={{ color: COLORS.text.primary }}>{formatINR(s.lastPrice)}</td>
                <td className="py-1 pr-3 whitespace-nowrap" style={{ color: COLORS.text.secondary }}>{formatDay(s.lastDate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {all.length > SHOWN && (
        <button type="button" onClick={() => setShowAll((v) => !v)} className="text-[11px] font-medium mt-0.5" style={{ color: TEAL.base }}>
          {showAll ? 'Show fewer' : `Show all ${all.length}`}
        </button>
      )}
    </div>
  );
};

// ============================================================
// Market price: two listings, the one that meets the specs and one from India
// (review, 19 Oct: "only 2 prices, not all: one whose specs are met, one India").
// ============================================================

const CURRENCY_SYMBOL: Record<string, string> = { INR: '₹', USD: 'US$', EUR: '€', GBP: '£', CNY: 'CN¥', AUD: 'A$', ZAR: 'R ', IDR: 'Rp ' };

/** A price as listed, in its own currency. */
const formatMoney = (amount: number, currency: string): string => {
  const n = amount.toLocaleString(currency === 'INR' ? 'en-IN' : 'en-US', { maximumFractionDigits: amount < 100 ? 2 : 0 });
  const symbol = CURRENCY_SYMBOL[currency];
  return symbol ? `${symbol}${n}` : `${currency} ${n}`;
};

const SPEC_BADGE: Record<MarketListing['meetsSpecs'], { label: string; bg: string; fg: string }> = {
  yes: { label: 'Meets specs', bg: '#DCFCE7', fg: '#16A34A' },
  nearly: { label: 'Nearly meets specs', bg: '#FEF3C7', fg: '#B45309' },
  unknown: { label: 'Specs not stated', bg: COLORS.lightGray, fg: COLORS.text.secondary },
  no: { label: "Doesn't meet specs", bg: COLORS.lightGray, fg: COLORS.text.tertiary },
};
const SPEC_ORDER: Record<MarketListing['meetsSpecs'], number> = { yes: 0, nearly: 1, unknown: 2, no: 3 };
const FAVOURED_BADGE = { label: 'Most favoured', bg: '#DCFCE7', fg: '#16A34A' };

/** A listing on screen, with its market. */
type ShownListing = Omit<MarketListing, 'priceInr'> & { region: string; priceInr?: number | null };

/**
 * Two prices: the most favoured listing (meets the specs, from any market; the
 * same one the pointers use), then the best one from India. If none meets the
 * specs, the closest instead.
 */
const MarketPriceCard: React.FC<{ market: MarketSearch | null; loading: boolean }> = ({ market, loading }) => {
  const all: ShownListing[] = (market?.regions ?? []).flatMap((r) => r.listings.map((l) => ({ ...l, region: r.region })));
  const bySpec = (a: ShownListing, b: ShownListing) => SPEC_ORDER[a.meetsSpecs] - SPEC_ORDER[b.meetsSpecs];
  const best = market?.bestListing;
  const favoured: ShownListing | undefined = best
    ? { ...best, meetsSpecs: 'yes' }
    : [...all].sort(bySpec).find((l) => l.meetsSpecs !== 'no' && !l.outOfRange);
  const india = all.filter((l) => l.region === 'India' && l.url !== favoured?.url).sort(bySpec)[0];
  const shown = [favoured, india].filter((l): l is ShownListing => !!l);
  return (
    <Card title="Market price">
      {loading || !market || market.pending ? (
        <>
          <Skeleton lines={2} />
          <p className="text-[11px] flex items-center gap-1" style={{ color: COLORS.text.tertiary }}>
            <Icon icon="mdi:earth" className="w-3.5 h-3.5" /> Searching each market for prices, about a minute…
          </p>
        </>
      ) : shown.length > 0 ? (
        <ul className="space-y-2.5">
          {shown.map((l) => {
            const badge = l === favoured && l.meetsSpecs === 'yes' ? FAVOURED_BADGE : SPEC_BADGE[l.meetsSpecs];
            return (
              <li key={l.url}>
                {/* The country and the price stand out (review, 19 Oct: "these need to be highlighted"). */}
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="px-2 py-0.5 rounded-md text-xs font-semibold whitespace-nowrap" style={{ backgroundColor: TEAL.tint, color: TEAL.dark }}>
                    {l.region}
                  </span>
                  <span className="text-base font-bold whitespace-nowrap" style={{ color: COLORS.text.primary }}>
                    {formatMoney(l.price, l.currency)}
                    <span className="text-[11px] font-normal" style={{ color: COLORS.text.tertiary }}> / {l.unit}</span>
                  </span>
                  {l.currency !== 'INR' && l.priceInr != null && (
                    <span className="text-sm font-semibold whitespace-nowrap" style={{ color: COLORS.text.secondary }}>≈ {formatINR(l.priceInr)}</span>
                  )}
                  <span className="px-1.5 rounded-full text-[10px] font-semibold whitespace-nowrap" style={{ backgroundColor: badge.bg, color: badge.fg }}>
                    {badge.label}
                  </span>
                  {l.outOfRange && <span className="text-[10px]" style={{ color: COLORS.text.tertiary }}>far from the quotes</span>}
                </div>
                <div className="flex flex-wrap items-baseline gap-x-2 text-[11px] mt-0.5">
                  <a
                    href={l.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline truncate"
                    style={{ color: TEAL.base, maxWidth: '28rem' }}
                    title={l.title}
                  >
                    {l.title || hostOf(l.url)}
                  </a>
                  <span style={{ color: COLORS.text.tertiary }}>{l.source || hostOf(l.url)}</span>
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <Unavailable text={market.summary} />
      )}
    </Card>
  );
};


/** ④ EcoVadis score (0–100) of each vendor still in the running, best first. */
const SustainabilityCard: React.FC<{ data: Sustainability | null; vendorIds: string[] }> = ({ data, vendorIds }) => {
  const rows = (data?.vendors ?? [])
    .filter((v) => vendorIds.includes(v.vendorId) && v.ecovadisScore != null)
    .map((v) => ({ ...v, score: Number(v.ecovadisScore) }))
    .sort((a, b) => b.score - a.score);
  return (
    <Card
      title="Sustainability · EcoVadis"
      hint="EcoVadis rates a supplier's environment, labour, ethics and sourcing practices from 0 to 100; higher is better."
    >
      {!data ? (
        <Skeleton />
      ) : rows.length === 0 ? (
        <Unavailable text="No sustainability ratings for these vendors." />
      ) : (
        <ul className="space-y-1.5 pt-0.5">
          {rows.map((v) => (
            <li key={v.vendorId} title={`${v.vendorName}: EcoVadis ${v.score}${v.sustainabilityTier ? `, ${v.sustainabilityTier}` : ''}`}>
              <div className="flex items-baseline justify-between gap-2 text-[11px]">
                <span className="truncate" style={{ color: COLORS.text.primary }}>{v.vendorName}</span>
                <span className="whitespace-nowrap" style={{ color: COLORS.text.secondary }}>
                  <b style={{ color: COLORS.text.primary }}>{v.score}</b>
                  {v.sustainabilityTier && ` · ${v.sustainabilityTier}`}
                </span>
              </div>
              <div className="h-1 rounded-full mt-0.5" style={{ backgroundColor: COLORS.lightGray }}>
                <div className="h-1 rounded-full" style={{ width: `${Math.max(0, Math.min(100, v.score))}%`, backgroundColor: SERIES }} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
};

/** A quote still in the running: who, its T-rank, and its unit price. */
interface QuoteRef {
  vendorId: string;
  vendorName: string;
  tRank: string | null;
  price: number;
}

/** "8.4% below" / "3.1% above": how far `value` sits from `base`. */
const vsText = (value: number, base: number): string => {
  const p = ((value - base) / base) * 100;
  return `${Math.abs(p).toFixed(1)}% ${p <= 0 ? 'below' : 'above'}`;
};

/**
 * Market Study and Insights: cost history, the market price, sustainability,
 * the index-based comparison and the should cost
 * and sustainability, in small boxes, two cards to a row (review, 18 Oct: less
 * text, narrower; the rate contract card went, "it doesn't make any sense").
 */
export const MarketStudyPanel: React.FC<{
  market: MarketInputs | null;
  /** India's reference price: feeds the recommendation and pointers, not shown here. */
  online: OnlinePrice | null;
  onlineLoading: boolean;
  /** Prices and suppliers per market (the Market price card). */
  marketSearch: MarketSearch | null;
  marketSearchLoading: boolean;
  error: string | null;
  /** Quotes still in the running (Not accepted left out). */
  quotes: QuoteRef[];
  /** The product the should cost is for (one per product, not per supplier). */
  productName?: string;
}> = ({ market, online, onlineLoading, marketSearch, marketSearchLoading, error, quotes, productName }) => {
  // Open once shown: the cards are what the buyer reads (meeting, 18 Oct).
  const [expanded, setExpanded] = useState(true);
  const vendorIds = quotes.map((q) => q.vendorId);
  return (
    <div className="rounded-xl overflow-hidden mb-4" style={{ border: `1px solid ${TEAL.border}`, backgroundColor: COLORS.white, boxShadow: SHADOWS.card }}>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="w-full px-4 py-3 flex items-center justify-between gap-3 text-left"
        style={expanded ? { borderBottom: `1px solid ${TEAL.border}` } : undefined}
      >
        <div>
          <h2 className="text-sm font-semibold" style={{ color: COLORS.text.primary }}>Market Study and Insights</h2>
          <p className="text-[11px] mt-0.5" style={{ color: COLORS.text.secondary }}>
            {expanded
              ? 'Hover a chart for values.'
              : `Cost history, market prices, sustainability, index comparison and should cost.${onlineLoading || marketSearchLoading ? ' Searching the web for prices…' : ''}`}
          </p>
        </div>
        <span className="inline-flex items-center gap-1 text-[11px] font-medium flex-shrink-0" style={{ color: TEAL.base }}>
          {expanded ? 'Hide' : 'Show'}
          <Icon icon={expanded ? 'mdi:chevron-up' : 'mdi:chevron-down'} className="w-4 h-4" />
        </span>
      </button>
      {expanded &&
        (error ? (
          <p className="px-4 py-3 text-xs" style={{ color: '#475569' }}>Couldn't load the market study: {error}</p>
        ) : (
          // Two cards to a row on wide screens, so the study fits in less scrolling.
          <div className="grid gap-3 p-4 grid-cols-1 lg:grid-cols-2">
            <PriceHistoryCard data={market?.historical ?? null} quotes={quotes} />
            <MarketPriceCard market={marketSearch} loading={marketSearchLoading} />
            <SustainabilityCard data={market?.sustainability ?? null} vendorIds={vendorIds} />
            <IndexComparisonCard data={market?.index} loading={!market} quotes={quotes} unit={market?.historical?.unit} />
            {/* Last, full width: it draws on the market price above. */}
            <ShouldCostCard
              entered={market?.shouldCost ?? null}
              split={market?.costSplit}
              productName={productName}
              online={online ?? market?.online ?? null}
              marketSearch={marketSearch}
              loading={!market || onlineLoading || marketSearchLoading}
              quotes={quotes}
              unit={market?.historical?.unit}
            />

          </div>
        ))}
    </div>
  );
};

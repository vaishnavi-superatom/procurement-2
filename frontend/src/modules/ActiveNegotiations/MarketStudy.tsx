import React, { useState } from 'react';
import { Icon } from '@iconify/react';
import ReactECharts from 'echarts-for-react';
import { COLORS, SHADOWS } from '../../design-system/tokens';
import { TRankBadge } from '../RfqReceived/TechnicalEvaluation';
import type {
  HistoricalPrice,
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
const PriceHistoryChart: React.FC<{ data: HistoricalPrice }> = ({ data }) => {
  // Every order; a study saved before the per-order list falls back to monthly averages.
  const points = data.orders?.length
    ? data.orders.map((o) => ({ t: Date.parse(o.date), price: o.price, who: o.vendorName }))
    : (data.series ?? []).map((s) => ({ t: Date.parse(`${s.month}-15`), price: s.avgPrice, who: `Average of ${s.orders} order${s.orders === 1 ? '' : 's'}` }));
  if (points.length < 2) return null;
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
        showSymbol: points.length <= 60,
        symbol: 'circle',
        symbolSize: 8,
        lineStyle: { width: 2, color: HISTORY, cap: 'round', join: 'round' },
        itemStyle: { color: HISTORY, borderColor: COLORS.white, borderWidth: 2 },
      },
    ],
  };
  return (
    <div role="img" aria-label="What we paid for this item, order by order">
      <ReactECharts option={option} notMerge opts={{ renderer: 'svg' }} style={{ height: 180, width: '100%' }} />
    </div>
  );
};

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
const Card: React.FC<{ title: string; hint?: string; children: React.ReactNode }> = ({ title, hint, children }) => (
  <div className="rounded-lg p-3 flex flex-col gap-1.5 min-w-0" style={{ border: `1px solid ${TEAL.border}`, backgroundColor: COLORS.white }}>
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

// The should cost's parts, from Ashish's breakdown (review, 18 Oct: "bill of material cost, service cost, margin").
const SHOULD_COST_PARTS: { label: string; match: RegExp }[] = [
  { label: 'Bill of material cost', match: /bill|bom|material/i },
  { label: 'Service cost', match: /service|manpower|labou?r/i },
  { label: 'Margin', match: /margin|profit/i },
];

/** What the item should cost us, in its parts, against every quote (Ashish provides the figures). */
const ShouldCostCard: React.FC<{ data: ShouldCost | null; loading: boolean; quotes: QuoteRef[]; unit?: string }> = ({ data, loading, quotes, unit }) => {
  const value = data?.available && data.shouldCost != null ? data.shouldCost : null;
  const part = (match: RegExp) => data?.breakdown?.find((b) => match.test(b.label))?.amount ?? null;
  const ranked = [...quotes].sort(byTRank);
  return (
    <Card title="Should cost">
      {/* The placeholder alone while loading, then the chart: not both at once (review, 19 Oct). */}
      {loading ? (
        <Skeleton lines={2} />
      ) : (
        <>
          {/* The figures only once Ashish's are in: no empty boxes until then (review, 19 Oct). */}
          {value != null && (
            <div className="flex flex-wrap gap-2">
              {SHOULD_COST_PARTS.map((p) => {
                const amount = part(p.match);
                return amount != null ? <Figure key={p.label} label={p.label} value={formatINR(amount)} /> : null;
              })}
              <Figure strong label="Should cost" value={formatINR(value)} unit={data?.unit ?? unit} />
            </div>
          )}
          {value != null && ranked.length > 0 && (
            <p className="flex items-center gap-1.5 text-[11px]" style={{ color: COLORS.text.secondary }}>
              <span aria-hidden className="inline-block flex-none" style={{ width: 2, height: 12, backgroundColor: COLORS.text.primary }} />
              Should cost line
            </p>
          )}
          <QuotesVsShouldCost quotes={ranked} shouldCost={value} />
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
  return (
    <Card title="Our price history">
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
          <PriceHistoryChart data={data} />
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
 * Market Study and Insights: should cost, our price history, the market price
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
}> = ({ market, onlineLoading, marketSearch, marketSearchLoading, error, quotes }) => {
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
              : `Should cost, our price history, market prices and sustainability.${onlineLoading || marketSearchLoading ? ' Searching the web for prices…' : ''}`}
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
            <ShouldCostCard data={market?.shouldCost ?? null} loading={!market} quotes={quotes} unit={market?.historical?.unit} />
            <PriceHistoryCard data={market?.historical ?? null} quotes={quotes} />
            <MarketPriceCard market={marketSearch} loading={marketSearchLoading} />
            <SustainabilityCard data={market?.sustainability ?? null} vendorIds={vendorIds} />
          </div>
        ))}
    </div>
  );
};

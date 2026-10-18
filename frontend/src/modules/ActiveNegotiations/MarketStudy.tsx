import React, { useState } from 'react';
import { Icon } from '@iconify/react';
import ReactECharts from 'echarts-for-react';
import { COLORS, SHADOWS } from '../../design-system/tokens';
import type {
  CommodityFeed,
  ContractBenchmark,
  HistoricalPrice,
  MarketInputs,
  MarketListing,
  MarketRegionResult,
  MarketSearch,
  OnlinePrice,
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

const formatINR = (n: number | null | undefined): string => {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return '₹' + Math.round(n).toLocaleString('en-IN');
};

const formatPct = (p: number | null | undefined): string => {
  if (p === null || p === undefined || isNaN(p)) return '—';
  return `${p >= 0 ? '+' : '−'}${Math.abs(p).toFixed(1)}%`;
};

const formatDay = (d: string | null | undefined): string => {
  if (!d) return '—';
  const date = new Date(d);
  if (isNaN(date.getTime())) return d;
  return date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
};

const formatMonth = (m: string): string => {
  const date = new Date(`${m}-01T00:00:00`);
  return isNaN(date.getTime()) ? m : date.toLocaleDateString('en-IN', { month: 'short', year: 'numeric' });
};

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
};

/** Single-series trend line: no axes or legend (the card names it), hover for values. */
const Sparkline: React.FC<{ labels: string[]; values: number[]; ariaLabel: string }> = ({ labels, values, ariaLabel }) => {
  if (values.length < 2) return null;
  const option = {
    animation: false,
    grid: { left: 4, right: 4, top: 6, bottom: 4 },
    xAxis: { type: 'category', data: labels, show: false, boundaryGap: false },
    yAxis: { type: 'value', show: false, scale: true },
    tooltip: {
      trigger: 'axis',
      confine: true,
      backgroundColor: COLORS.white,
      borderColor: '#E2E8F0',
      padding: [4, 8],
      textStyle: { color: COLORS.text.primary, fontSize: 11 },
      axisPointer: { type: 'line', lineStyle: { color: COLORS.text.tertiary, width: 1 } },
      formatter: (params: { name: string; value: number } | { name: string; value: number }[]) => {
        const p = Array.isArray(params) ? params[0] : params;
        return `<span style="color:${COLORS.text.secondary}">${p.name}</span><br/><b>${formatINR(p.value)}</b>`;
      },
    },
    series: [
      {
        type: 'line',
        data: values,
        showSymbol: false,
        symbolSize: 8,
        lineStyle: { width: 2, color: SERIES },
        itemStyle: { color: SERIES },
        areaStyle: { color: SERIES, opacity: 0.1 },
      },
    ],
  };
  return (
    <div role="img" aria-label={ariaLabel}>
      <ReactECharts option={option} notMerge opts={{ renderer: 'svg' }} style={{ height: 56, width: '100%' }} />
    </div>
  );
};

/** `hint`: one line saying what the card is, for inputs that aren't self-explanatory. */
const Card: React.FC<{ n: number; title: string; hint?: string; children: React.ReactNode }> = ({ n, title, hint, children }) => (
  <div className="rounded-lg p-3 flex flex-col gap-1.5 min-w-0" style={{ border: `1px solid ${TEAL.border}`, backgroundColor: COLORS.white }}>
    <div className="flex items-center gap-1.5">
      <span
        className="inline-flex items-center justify-center rounded-full text-[10px] font-semibold flex-shrink-0"
        style={{ width: 16, height: 16, backgroundColor: TEAL.tint, color: TEAL.dark }}
      >
        {n}
      </span>
      <span className="text-[11px] font-semibold uppercase tracking-wide truncate" style={{ color: COLORS.text.secondary }}>{title}</span>
    </div>
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

const HistoricalCard: React.FC<{ data: HistoricalPrice | null }> = ({ data }) => (
  <Card n={1} title="Our past prices">
    {!data ? (
      <Skeleton />
    ) : !data.available ? (
      <Unavailable text={data.summary} />
    ) : (
      <>
        <div>
          <p className="text-lg font-bold leading-tight" style={{ color: COLORS.text.primary }}>
            {formatINR(data.avg12m ?? data.lastPrice)}
            <span className="text-[11px] font-normal" style={{ color: COLORS.text.tertiary }}> / {data.unit}</span>
          </p>
          <p className="text-[11px]" style={{ color: COLORS.text.secondary }}>
            {data.avg12m != null ? `12-month average, ${data.orders12m} order${data.orders12m === 1 ? '' : 's'}` : 'Last price paid (none in the past 12 months)'}
          </p>
        </div>
        <Sparkline
          labels={(data.series ?? []).map((s) => formatMonth(s.month))}
          values={(data.series ?? []).map((s) => s.avgPrice)}
          ariaLabel="Our average purchase price by month"
        />
        <p className="text-[11px]" style={{ color: COLORS.text.secondary }}>
          Last paid {formatINR(data.lastPrice)} on {formatDay(data.lastDate)}
          {data.trend3mPct != null && <> · 3-month trend {formatPct(data.trend3mPct)}</>}
        </p>
        <PriceRange data={data} />
        <PastSuppliers data={data} />
      </>
    )}
  </Card>
);

/** Low, average and high (meeting, 16 Oct: "what is the maximum, minimum"): 12 months, else the whole history. */
const PriceRange: React.FC<{ data: HistoricalPrice }> = ({ data }) => {
  const recent = data.min12m != null && data.max12m != null;
  const low = recent ? data.min12m : data.minAll;
  const high = recent ? data.max12m : data.maxAll;
  const avg = recent ? data.avg12m : data.avgAll;
  if (low == null || high == null) return null;
  return (
    <p className="text-[11px]" style={{ color: COLORS.text.secondary }}>
      Low <b style={{ color: COLORS.text.primary }}>{formatINR(low)}</b> · Average <b style={{ color: COLORS.text.primary }}>{formatINR(avg)}</b> · High{' '}
      <b style={{ color: COLORS.text.primary }}>{formatINR(high)}</b>
      <span style={{ color: COLORS.text.tertiary }}> ({recent ? 'last 12 months' : `all orders since ${formatDay(data.firstDate)}`})</span>
    </p>
  );
};

/** Who we bought it from before ("who are the suppliers in past?"), latest first. */
const PastSuppliers: React.FC<{ data: HistoricalPrice }> = ({ data }) => {
  const rows = (data.pastSuppliers ?? []).slice(0, 6);
  if (rows.length === 0) return null;
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
    </div>
  );
};

const CommodityCard: React.FC<{ data: CommodityFeed | null }> = ({ data }) => (
  <Card n={2} title={data?.commodity ? `Commodity · ${data.commodity}` : 'Commodity market'}>
    {!data ? (
      <Skeleton />
    ) : !data.available ? (
      <Unavailable text={data.summary} />
    ) : (
      <>
        <div>
          <p className="text-lg font-bold leading-tight" style={{ color: COLORS.text.primary }}>
            {formatINR(data.latestPrice)}
            {data.unit && <span className="text-[11px] font-normal" style={{ color: COLORS.text.tertiary }}> {data.unit}</span>}
          </p>
          <p className="text-[11px]" style={{ color: COLORS.text.secondary }}>
            {formatPct(data.change90dPct)} over 90 days · as of {formatDay(data.latestDate)}
          </p>
        </div>
        <Sparkline
          labels={(data.series ?? []).map((s) => formatDay(s.date))}
          values={(data.series ?? []).map((s) => s.price)}
          ariaLabel={`${data.commodity} price over the past 12 months`}
        />
        <p className="text-[11px]" style={{ color: COLORS.text.secondary }}>
          {data.costImpact90dPct != null && data.exposurePct
            ? `About ${formatPct(data.costImpact90dPct)} on this material's cost (${data.exposurePct}% exposure)`
            : 'Exposure of this material to the commodity is not recorded'}
        </p>
      </>
    )}
  </Card>
);

const SourceLinks: React.FC<{ sources?: { title: string; url: string }[]; label?: string }> = ({ sources, label }) =>
  sources && sources.length > 0 ? (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
      {label && <span className="text-[11px]" style={{ color: COLORS.text.tertiary }}>{label}</span>}
      {sources.slice(0, 3).map((s) => (
        <a
          key={s.url}
          href={s.url}
          target="_blank"
          rel="noopener noreferrer"
          title={s.title}
          className="text-[11px] underline truncate max-w-full"
          style={{ color: TEAL.base }}
        >
          {hostOf(s.url)}
        </a>
      ))}
    </div>
  ) : null;

// ============================================================
// ③ Online market prices: the India reference price, then each market's
// listings and suppliers (meeting, 16 Oct: "market price from various sources";
// "if you are not getting price, at least show… other suppliers")
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
const LISTINGS_SHOWN = 3;

const MarketRegionBlock: React.FC<{ result: MarketRegionResult }> = ({ result }) => {
  const [showAll, setShowAll] = useState(false);
  const listings = [...result.listings].sort((a, b) => SPEC_ORDER[a.meetsSpecs] - SPEC_ORDER[b.meetsSpecs]);
  const visible = showAll ? listings : listings.slice(0, LISTINGS_SHOWN);
  return (
    <div className="pt-2" style={{ borderTop: `1px solid ${COLORS.lightGray}` }}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-semibold" style={{ color: COLORS.text.primary }}>{result.region}</span>
        <span className="text-[10px] whitespace-nowrap" style={{ color: COLORS.text.tertiary }}>
          {result.failed
            ? "Couldn't search this market"
            : `${listings.length} price${listings.length === 1 ? '' : 's'} · ${result.suppliers.length} supplier${result.suppliers.length === 1 ? '' : 's'}`}
        </span>
      </div>
      {visible.length > 0 && (
        <ul className="mt-1 space-y-1">
          {visible.map((l, i) => {
            const badge = SPEC_BADGE[l.meetsSpecs];
            return (
              <li key={`${l.url}-${i}`} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[11px]">
                <span className="font-semibold whitespace-nowrap" style={{ color: COLORS.text.primary }}>
                  {formatMoney(l.price, l.currency)}
                  <span className="font-normal" style={{ color: COLORS.text.tertiary }}> / {l.unit}</span>
                </span>
                <a
                  href={l.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline truncate"
                  style={{ color: TEAL.base, maxWidth: '24rem' }}
                  title={l.title}
                >
                  {l.title || hostOf(l.url)}
                </a>
                <span style={{ color: COLORS.text.tertiary }}>{l.source || hostOf(l.url)}</span>
                <span className="px-1.5 rounded-full text-[10px] font-semibold whitespace-nowrap" style={{ backgroundColor: badge.bg, color: badge.fg }}>
                  {badge.label}
                </span>
                {l.outOfRange && <span className="text-[10px]" style={{ color: COLORS.text.tertiary }}>far from the quotes</span>}
              </li>
            );
          })}
        </ul>
      )}
      {listings.length > LISTINGS_SHOWN && (
        <button type="button" onClick={() => setShowAll((v) => !v)} className="text-[11px] font-medium mt-0.5" style={{ color: TEAL.base }}>
          {showAll ? 'Show fewer' : `Show ${listings.length - LISTINGS_SHOWN} more`}
        </button>
      )}
      {listings.length === 0 && result.note && (
        <p className="text-[11px] mt-0.5" style={{ color: COLORS.text.secondary }}>{result.note}</p>
      )}
      {result.suppliers.length > 0 && (
        <p className="text-[11px] mt-1" style={{ color: COLORS.text.secondary }}>
          <span style={{ color: COLORS.text.tertiary }}>{listings.length ? 'Suppliers: ' : 'No published price. Suppliers you can contact: '}</span>
          {result.suppliers.map((s, i) => (
            <React.Fragment key={`${s.name}-${i}`}>
              {i > 0 && ', '}
              {s.website ? (
                <a href={s.website} target="_blank" rel="noopener noreferrer" className="underline" style={{ color: TEAL.base }}>
                  {s.name}
                </a>
              ) : (
                s.name
              )}
            </React.Fragment>
          ))}
        </p>
      )}
    </div>
  );
};

/** Each market's listings and suppliers, below the India reference price. */
const MarketsSection: React.FC<{ market: MarketSearch | null; loading: boolean }> = ({ market, loading }) => {
  if (!loading && (!market || market.pending)) return null;
  const international = market?.regions.some((r) => r.listings.some((l) => l.currency !== 'INR')) ?? false;
  return (
    <div className="mt-2 pt-2 space-y-2" style={{ borderTop: `1px solid ${TEAL.border}` }}>
      <p className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: COLORS.text.secondary }}>By market</p>
      {loading ? (
        <>
          <Skeleton lines={3} />
          <p className="text-[11px] flex items-center gap-1" style={{ color: COLORS.text.tertiary }}>
            <Icon icon="mdi:earth" className="w-3.5 h-3.5" /> Searching each market for prices and suppliers, about a minute…
          </p>
        </>
      ) : market && market.regions.length > 0 ? (
        <>
          {market.regions.map((r) => (
            <MarketRegionBlock key={r.region} result={r} />
          ))}
          {international && (
            <p className="text-[10px]" style={{ color: COLORS.text.tertiary }}>
              International prices are shown as listed, in their own currency, before freight and import duty.
            </p>
          )}
        </>
      ) : (
        <Unavailable text={market?.summary ?? 'No market listings found.'} />
      )}
    </div>
  );
};

const OnlineCard: React.FC<{ data: OnlinePrice | null; loading: boolean; market: MarketSearch | null; marketLoading: boolean }> = ({
  data,
  loading,
  market,
  marketLoading,
}) => (
  <Card n={3} title="Online market prices" hint="Prices found online for this item today, and who sells it in each market.">
    {data && !loading && !data.pending && (
      <p className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: COLORS.text.tertiary }}>Reference price · India</p>
    )}
    {loading || !data || data.pending ? (
      <>
        <Skeleton lines={2} />
        <p className="text-[11px] flex items-center gap-1" style={{ color: COLORS.text.tertiary }}>
          <Icon icon="mdi:web" className="w-3.5 h-3.5" /> Searching the web, usually 15–30 s…
        </p>
      </>
    ) : !data.available ? (
      // Say why, in the system's words: e.g. that size is sold on quotation only.
      <>
        {data.noPriceReason ? (
          <>
            <p className="text-xs font-semibold" style={{ color: COLORS.text.secondary }}>No public price</p>
            <p className="text-[11px] leading-relaxed" style={{ color: COLORS.text.primary }}>{data.noPriceReason}</p>
          </>
        ) : (
          // Searches saved before the reason existed: the summary plus the search's notes.
          <>
            <Unavailable text={data.summary} />
            {data.notes && <p className="text-[11px] leading-relaxed" style={{ color: COLORS.text.secondary }}>{data.notes}</p>}
          </>
        )}
        <SourceLinks sources={data.sources} label="Searched:" />
      </>
    ) : (
      <>
        <div>
          <p className="text-lg font-bold leading-tight" style={{ color: COLORS.text.primary }}>
            {formatINR(data.priceInr)}
            {data.unit && <span className="text-[11px] font-normal" style={{ color: COLORS.text.tertiary }}> / {data.unit}</span>}
          </p>
          {data.matchedModel && (
            <p className="text-[11px] font-medium" style={{ color: COLORS.text.primary }}>{data.matchedModel}</p>
          )}
          <p className="text-[11px]" style={{ color: COLORS.text.secondary }}>
            {data.basis}
            {data.range && <> · range {data.range}</>}
          </p>
        </div>
        {data.notes && <p className="text-[11px] leading-relaxed" style={{ color: COLORS.text.secondary }}>{data.notes}</p>}
        {(data.outOfRange || data.comparable === false) && (
          <p className="text-[11px] rounded px-2 py-1" style={{ backgroundColor: COLORS.lightGray, color: COLORS.text.secondary }}>
            {data.outOfRange ? data.note : 'Not on a delivered basis, so not directly comparable with the quotes.'}
          </p>
        )}
        <SourceLinks sources={data.sources} />
        <p className="text-[10px]" style={{ color: COLORS.text.tertiary }}>
          {data.cached ? 'Found earlier today' : 'Just found'}{data.asOf ? ` · source dated ${data.asOf}` : ''}
        </p>
      </>
    )}
    <MarketsSection market={market} loading={marketLoading} />
  </Card>
);

/** ④ EcoVadis score (0–100) of each vendor still in the running, best first. */
const SustainabilityCard: React.FC<{ data: Sustainability | null; vendorIds: string[] }> = ({ data, vendorIds }) => {
  const rows = (data?.vendors ?? [])
    .filter((v) => vendorIds.includes(v.vendorId) && v.ecovadisScore != null)
    .map((v) => ({ ...v, score: Number(v.ecovadisScore) }))
    .sort((a, b) => b.score - a.score);
  return (
    <Card
      n={4}
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

/** A quote still in the running: who, and at what unit price. */
interface QuoteRef {
  vendorId: string;
  price: number;
}

/** "8.4% below" / "3.1% above": how far `value` sits from `base`. */
const vsText = (value: number, base: number): string => {
  const p = ((value - base) / base) * 100;
  return `${Math.abs(p).toFixed(1)}% ${p <= 0 ? 'below' : 'above'}`;
};

/**
 * ⑤ Prices we already agreed with suppliers for this item: whose each
 * contract is, and whether that supplier quoted on this RFQ (walkthrough,
 * 16 Oct: "rate contract of who?").
 */
const ContractCard: React.FC<{ data: ContractBenchmark | null; quotes: QuoteRef[]; unit?: string }> = ({ data, quotes, unit }) => {
  const active = data?.activeContracts ?? []; // cheapest first
  const best = active[0] ?? null;
  const lowest = quotes.length ? Math.min(...quotes.map((q) => q.price)) : null;
  // Every quoting vendor that holds an active contract, Not accepted ones included.
  const quotedIds = new Set((data?.quotingVendorsWithContract ?? []).map((v) => v.vendorId));
  const statusOf = (vendorId: string, contractPrice: number): string => {
    const q = quotes.find((x) => x.vendorId === vendorId);
    if (q) return `also quoted ${formatINR(q.price)} on this RFQ, ${vsText(q.price, contractPrice)} this contract`;
    if (quotedIds.has(vendorId)) return 'quoted on this RFQ, but was ranked Not accepted';
    return "didn't quote on this RFQ";
  };
  return (
    <Card
      n={5}
      title="Rate contract"
      hint="A price we've already agreed with a supplier for this item, valid until an end date. If the quotes are higher, buying on the contract may be cheaper."
    >
      {!data ? (
        <Skeleton />
      ) : !data.available || !best ? (
        <Unavailable text={data.summary} />
      ) : (
        <>
          <ul className="space-y-2 pt-0.5">
            {active.map((c) => (
              <li key={c.contractId}>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-xs truncate" style={{ color: COLORS.text.primary }}>
                    Our contract with <b>{c.vendorName}</b>
                  </span>
                  <span className="text-sm font-bold whitespace-nowrap" style={{ color: COLORS.text.primary }}>
                    {formatINR(c.price)}
                    {unit && <span className="text-[11px] font-normal" style={{ color: COLORS.text.tertiary }}> / {unit}</span>}
                  </span>
                </div>
                <p className="text-[11px]" style={{ color: COLORS.text.secondary }}>
                  {c.contractId}, valid until {formatDay(c.endDate)} · {statusOf(c.vendorId, c.price)}
                </p>
              </li>
            ))}
          </ul>
          {lowest != null && (
            <p className="text-[11px]" style={{ color: COLORS.text.secondary }}>
              Lowest quote ({formatINR(lowest)}) is {vsText(lowest, best.price)} the {active.length > 1 ? 'best ' : ''}contract price.
            </p>
          )}
          {(data.expiredContracts ?? 0) > 0 && (
            <p className="text-[10px]" style={{ color: COLORS.text.tertiary }}>
              {data.expiredContracts} expired contract{data.expiredContracts === 1 ? '' : 's'} for this item not shown.
            </p>
          )}
        </>
      )}
    </Card>
  );
};

/** The five market-study inputs behind the recommendation. */
export const MarketStudyPanel: React.FC<{
  market: MarketInputs | null;
  online: OnlinePrice | null;
  onlineLoading: boolean;
  /** Prices and suppliers per market (shown in card ③). */
  marketSearch: MarketSearch | null;
  marketSearchLoading: boolean;
  error: string | null;
  /** Quotes still in the running (Not accepted left out). */
  quotes: QuoteRef[];
}> = ({ market, online, onlineLoading, marketSearch, marketSearchLoading, error, quotes }) => {
  // Collapsed at first: the recommendation below is what the buyer reads first.
  const [expanded, setExpanded] = useState(false);
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
          <h2 className="text-sm font-semibold" style={{ color: COLORS.text.primary }}>Market Study</h2>
          <p className="text-[11px] mt-0.5" style={{ color: COLORS.text.secondary }}>
            {expanded
              ? 'The five inputs the recommendation weighs besides the quotes. Hover a chart for values.'
              : `Our past prices, commodity trend, online market prices, sustainability and rate contract.${onlineLoading || marketSearchLoading ? ' Searching the web for prices…' : ''}`}
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
          // One card per row, full width.
          <div className="flex flex-col gap-3 p-4">
            <HistoricalCard data={market?.historical ?? null} />
            <CommodityCard data={market?.commodity ?? null} />
            <OnlineCard data={online ?? market?.online ?? null} loading={onlineLoading} market={marketSearch} marketLoading={marketSearchLoading} />
            <SustainabilityCard data={market?.sustainability ?? null} vendorIds={vendorIds} />
            <ContractCard data={market?.contract ?? null} quotes={quotes} unit={market?.historical?.unit} />
          </div>
        ))}
    </div>
  );
};

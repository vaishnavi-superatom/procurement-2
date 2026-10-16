import React, { useState } from 'react';
import { Icon } from '@iconify/react';
import ReactECharts from 'echarts-for-react';
import { COLORS, SHADOWS } from '../../design-system/tokens';
import type { CommodityFeed, ContractBenchmark, HistoricalPrice, MarketInputs, OnlinePrice, Sustainability } from '../../data/rfq-recommendation';

const TEAL = {
  base: '#0F6B64',
  dark: '#0B4F4A',
  tint: '#E6F5F3',
  border: '#D7E8E6',
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

const Card: React.FC<{ n: number; title: string; children: React.ReactNode }> = ({ n, title, children }) => (
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
      </>
    )}
  </Card>
);

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

const OnlineCard: React.FC<{ data: OnlinePrice | null; loading: boolean }> = ({ data, loading }) => (
  <Card n={3} title="Online market price">
    {loading || !data || data.pending ? (
      <>
        <Skeleton lines={2} />
        <p className="text-[11px] flex items-center gap-1" style={{ color: COLORS.text.tertiary }}>
          <Icon icon="mdi:web" className="w-3.5 h-3.5" /> Searching the web, usually 15–30 s…
        </p>
      </>
    ) : !data.available ? (
      // Say why, in the AI's words: e.g. that size is sold on quotation only.
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
  </Card>
);

/** ④ EcoVadis score (0–100) of each vendor still in the running, best first. */
const SustainabilityCard: React.FC<{ data: Sustainability | null; vendorIds: string[] }> = ({ data, vendorIds }) => {
  const rows = (data?.vendors ?? [])
    .filter((v) => vendorIds.includes(v.vendorId) && v.ecovadisScore != null)
    .map((v) => ({ ...v, score: Number(v.ecovadisScore) }))
    .sort((a, b) => b.score - a.score);
  return (
    <Card n={4} title="Sustainability · EcoVadis">
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

/** ⑤ Our best active rate-contract price for this material, against the lowest quote. */
const ContractCard: React.FC<{ data: ContractBenchmark | null; lowestQuote: number | null; unit?: string }> = ({ data, lowestQuote, unit }) => {
  const best = data?.activeContracts?.[0] ?? null;
  const vsLowest = best && lowestQuote ? ((lowestQuote - best.price) / best.price) * 100 : null;
  return (
    <Card n={5} title="Rate contract">
      {!data ? (
        <Skeleton />
      ) : !data.available || !best ? (
        <Unavailable text={data.summary} />
      ) : (
        <>
          <div>
            <p className="text-lg font-bold leading-tight" style={{ color: COLORS.text.primary }}>
              {formatINR(best.price)}
              {unit && <span className="text-[11px] font-normal" style={{ color: COLORS.text.tertiary }}> / {unit}</span>}
            </p>
            <p className="text-[11px]" style={{ color: COLORS.text.secondary }}>
              {best.vendorName} · {best.contractId}, until {formatDay(best.endDate)}
            </p>
          </div>
          {vsLowest != null && (
            <p className="text-[11px]" style={{ color: COLORS.text.secondary }}>
              Lowest quote is {formatPct(vsLowest)} {vsLowest <= 0 ? '(below the contract)' : '(above the contract)'}
            </p>
          )}
          <p className="text-[11px]" style={{ color: COLORS.text.secondary }}>
            {data.quotingVendorsWithContract && data.quotingVendorsWithContract.length > 0
              ? `Holds a contract and quoted: ${data.quotingVendorsWithContract.map((v) => v.vendorName).join(', ')}`
              : 'None of the quoting vendors holds a contract for it'}
          </p>
          {(data.activeContracts!.length > 1 || (data.expiredContracts ?? 0) > 0) && (
            <p className="text-[10px]" style={{ color: COLORS.text.tertiary }}>
              {data.activeContracts!.length} active
              {(data.expiredContracts ?? 0) > 0 && `, ${data.expiredContracts} expired`} contract{data.activeContracts!.length + (data.expiredContracts ?? 0) === 1 ? '' : 's'}
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
  error: string | null;
  /** Vendors still in the running (Not accepted left out). */
  vendorIds: string[];
  lowestQuote: number | null;
}> = ({ market, online, onlineLoading, error, vendorIds, lowestQuote }) => {
  // Collapsed at first: the recommendation below is what the buyer reads first.
  const [expanded, setExpanded] = useState(false);
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
              : `Our past prices, commodity trend, online price, sustainability and rate contract.${onlineLoading ? ' Searching the web for a price…' : ''}`}
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
            <OnlineCard data={online ?? market?.online ?? null} loading={onlineLoading} />
            <SustainabilityCard data={market?.sustainability ?? null} vendorIds={vendorIds} />
            <ContractCard data={market?.contract ?? null} lowestQuote={lowestQuote} unit={market?.historical?.unit} />
          </div>
        ))}
    </div>
  );
};

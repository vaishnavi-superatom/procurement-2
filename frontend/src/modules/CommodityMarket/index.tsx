import React, { useEffect, useMemo, useState } from 'react';
import { Icon } from '@iconify/react';
import type { ComponentMetadata } from '../../types';
import { COLORS, TYPOGRAPHY, SPACING, SHADOWS, CHART_COLOR_PALETTE } from '../../design-system/tokens';
import LoadingState from '../../components/LoadingState';
import DynamicPieChart from '../../shared-modules/DynamicPieChart';

interface CommodityMarketProps {
  SA_RUNTIME?: any;
}

// Same palette as the rest of this product's procurement screens.
const TEAL = {
  base: '#0F6B64',
  dark: '#0B4F4A',
  tint: '#E6F5F3',
  border: '#D7E8E6',
};

// ============================================================
// Real data shapes — purchase_orders / material_master / commodity_prices,
// the live "PostgreSQL Connection" source registered for this project. Spend
// exposure and market pricing are computed from two separate queries and
// never mixed into one number: exposure is this project's own spend,
// pricing is an external market reference index.
// ============================================================

interface PORow {
  material_id: string;
  total_value: number;
}

interface MaterialRow {
  material_id: string;
  primary_commodity: string | null;
  commodity_pct: number | null;
  secondary_commodity: string | null;
  secondary_commodity_pct: number | null;
}

interface CommodityPriceRow {
  commodity_code: string;
  price_date: string;
  price_inr_per_unit: number;
  unit: string;
}

const TOOL_ID = 'postgres-0fc80d2496ff_query';
const TOOL_NAME = 'Query PostgreSQL Connection';

async function runTool<T = any>(sql: string, SA_RUNTIME: any, limit?: number): Promise<T[]> {
  const toolExecutor = (window as any).SA?.ToolExecutor;
  if (!toolExecutor) throw new Error('ToolExecutor not available');
  const res = await toolExecutor.executeTool({
    externalTool: { toolId: TOOL_ID, toolName: TOOL_NAME, parameters: { sql, ...(limit ? { limit } : {}) } },
    formData: {},
    SA_RUNTIME,
  });
  const payload = res?.data ?? res;
  const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.records) ? payload.records : [];
  return rows as T[];
}

const PO_QUERY = `SELECT material_id, total_value FROM purchase_orders LIMIT 5000;`;

const MATERIAL_QUERY = `
SELECT material_id, primary_commodity, commodity_pct, secondary_commodity, secondary_commodity_pct
FROM material_master
LIMIT 2500;
`;

// Last 90 recorded prices per commodity, in one query via a window function
// instead of one round trip per commodity — same window convention already
// used elsewhere in this app (ActiveNegotiations' commodity trend).
const COMMODITY_TREND_QUERY = `
SELECT commodity_code, price_date, price_inr_per_unit, unit
FROM (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY commodity_code ORDER BY price_date DESC) AS rn
  FROM commodity_prices
) ranked
WHERE rn <= 90
ORDER BY commodity_code, price_date DESC;
`;

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

const SectionCard: React.FC<{ title: string; subtitle?: string; children: React.ReactNode }> = ({ title, subtitle, children }) => (
  <div className="rounded-xl overflow-hidden" style={{ border: `1px solid ${TEAL.border}`, backgroundColor: COLORS.white, boxShadow: SHADOWS.card }}>
    <div className="px-4 py-3" style={{ borderBottom: `1px solid ${TEAL.border}` }}>
      <h2 className="text-sm font-semibold" style={{ color: COLORS.text.primary }}>{title}</h2>
      {subtitle && <p className="text-[11px] mt-0.5" style={{ color: COLORS.text.secondary }}>{subtitle}</p>}
    </div>
    <div className="px-4 py-3">{children}</div>
  </div>
);

const METADATA: ComponentMetadata = {
  id: 'commodity-market-dashboard',
  name: 'CommodityMarket',
  displayName: 'Show commodity & market dashboard',
  isDisplayComp: true,
  type: 'CommodityMarket',
  description: 'Commodity exposure and live market pricing — spend distribution by underlying commodity kept separate from the market price reference, sourced from the live purchase_orders/material_master/commodity_prices data',
  category: 'Dashboard',
  keywords: ['commodity', 'market', 'trends', 'exposure', 'pricing', 'procurement'],
  dashboard: { label: 'Commodity & Market', icon: 'mdi:trending-up', order: 7 },
  props: {},
};

interface CommodityMarketComponent extends React.FC<CommodityMarketProps> {
  Metadata: ComponentMetadata;
}

const CommodityMarket: React.FC<CommodityMarketProps> = ({ SA_RUNTIME }) => {
  const [pos, setPos] = useState<PORow[]>([]);
  const [materials, setMaterials] = useState<MaterialRow[]>([]);
  const [commodityPrices, setCommodityPrices] = useState<CommodityPriceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const [poRows, materialRows, commodityRows] = await Promise.all([
          runTool<PORow>(PO_QUERY, SA_RUNTIME, 5000),
          runTool<MaterialRow>(MATERIAL_QUERY, SA_RUNTIME, 2500),
          runTool<CommodityPriceRow>(COMMODITY_TREND_QUERY, SA_RUNTIME, 2000),
        ]);
        if (cancelled) return;
        setPos(poRows);
        setMaterials(materialRows);
        setCommodityPrices(commodityRows);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load commodity data');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [SA_RUNTIME]);

  const materialById = useMemo(() => new Map(materials.map((m) => [m.material_id, m])), [materials]);

  // Procurement exposure — this project's own spend, weighted by each
  // material's real commodity_pct / secondary_commodity_pct. Never mixed
  // with the market price reference below.
  const commodityExposure = useMemo(() => {
    const map = new Map<string, number>();
    let unmapped = 0;
    for (const po of pos) {
      const m = materialById.get(po.material_id);
      const val = Number(po.total_value || 0);
      if (!m || !m.primary_commodity) {
        unmapped += val;
        continue;
      }
      const pPct = m.commodity_pct != null ? Number(m.commodity_pct) : 100;
      const sPct = m.secondary_commodity && m.secondary_commodity_pct != null ? Number(m.secondary_commodity_pct) : 0;
      map.set(m.primary_commodity, (map.get(m.primary_commodity) || 0) + val * (pPct / 100));
      if (m.secondary_commodity) map.set(m.secondary_commodity, (map.get(m.secondary_commodity) || 0) + val * (sPct / 100));
      const mappedPct = pPct + sPct;
      if (mappedPct < 100) unmapped += val * ((100 - mappedPct) / 100);
    }
    const rows = Array.from(map.entries())
      .map(([commodity, spend]) => ({ commodity, spend }))
      .sort((a, b) => b.spend - a.spend);
    if (unmapped > 0.5) rows.push({ commodity: 'Unmapped / Other', spend: unmapped });
    return rows;
  }, [pos, materialById]);

  const commodityChartData = useMemo(() => commodityExposure.map((r) => ({ commodity: r.commodity, spend: Math.round(r.spend) })), [commodityExposure]);

  // Live market reference — an external price index, kept strictly separate
  // from the spend-exposure figures above: this is a price, not a dollar
  // amount this project spent. Change is computed from the actual recorded
  // prices in the fetched window, never invented.
  const commodityMarketRef = useMemo(() => {
    const byCommodity = new Map<string, CommodityPriceRow[]>();
    for (const r of commodityPrices) {
      if (!byCommodity.has(r.commodity_code)) byCommodity.set(r.commodity_code, []);
      byCommodity.get(r.commodity_code)!.push(r);
    }
    const result = new Map<string, { latest: number; latestDate: string; earliestDate: string; pctChange: number | null; unit: string; pointCount: number }>();
    byCommodity.forEach((rows, code) => {
      const sorted = [...rows].sort((a, b) => b.price_date.localeCompare(a.price_date));
      const latest = sorted[0];
      const earliest = sorted[sorted.length - 1];
      const pctChange = earliest && earliest.price_inr_per_unit ? ((latest.price_inr_per_unit - earliest.price_inr_per_unit) / earliest.price_inr_per_unit) * 100 : null;
      if (latest) result.set(code, { latest: latest.price_inr_per_unit, latestDate: latest.price_date, earliestDate: earliest.price_date, pctChange, unit: latest.unit, pointCount: sorted.length });
    });
    return result;
  }, [commodityPrices]);

  // Every commodity with a market price record, not only ones with mapped
  // spend — this table is about market pricing, not procurement exposure.
  const marketRows = useMemo(
    () => Array.from(commodityMarketRef.entries()).map(([commodity, ref]) => ({ commodity, ...ref })).sort((a, b) => a.commodity.localeCompare(b.commodity)),
    [commodityMarketRef]
  );

  if (loading) {
    return <LoadingState height={520} message="Loading commodity data…" variant="skeleton" size="lg" />;
  }

  if (error) {
    return (
      <div className="bg-white rounded-xl shadow-sm border border-[#F1F5F9] p-6">
        <div className="flex items-center gap-3">
          <Icon icon="mdi:alert-circle" className="w-5 h-5 text-[#475569] flex-shrink-0" />
          <div>
            <p className="text-sm font-medium text-[#475569]">Couldn't load commodity data</p>
            <p className="text-xs mt-1" style={{ color: COLORS.text.secondary }}>{error}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full max-w-[1200px] mx-auto space-y-6" style={{ fontFamily: TYPOGRAPHY.fontFamily.primary, paddingTop: SPACING.xl, paddingBottom: SPACING.xl }}>
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0" style={{ backgroundColor: TEAL.tint }}>
          <Icon icon="mdi:trending-up" className="w-5 h-5" style={{ color: TEAL.base }} />
        </div>
        <div>
          <h1 className="text-xl font-bold" style={{ color: COLORS.text.primary }}>Commodity & Market</h1>
          <p className="text-xs mt-0.5" style={{ color: COLORS.text.secondary }}>
            Spend distribution by underlying commodity, kept separate from the live market price reference.
          </p>
        </div>
      </div>

      <SectionCard title="Commodity Exposure" subtitle="Spend distribution by underlying commodity — not the same as live market pricing.">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide mb-1" style={{ color: TEAL.base }}>Procurement Exposure (this project's spend)</p>
            {commodityChartData.length > 0 ? (
              <DynamicPieChart
                config={{ data: commodityChartData, nameKey: 'commodity', valueKey: 'spend', height: 280, showPercentage: true, donut: true, colorPalette: CHART_COLOR_PALETTE }}
                title="Spend by Commodity"
                description=""
              />
            ) : (
              <p className="text-xs py-3" style={{ color: COLORS.text.tertiary }}>No commodity mapping available on these materials.</p>
            )}
          </div>
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide mb-1" style={{ color: COLORS.text.tertiary }}>Live Market Reference (commodity_prices, last 90 records)</p>
            <div className="rounded-lg overflow-auto" style={{ border: `1px solid ${COLORS.borderGray}`, maxHeight: 280 }}>
              <table className="w-full text-sm border-collapse">
                <thead className="sticky top-0" style={{ backgroundColor: COLORS.lightBackground }}>
                  <tr>
                    {['Commodity', 'Latest Price', 'Change'].map((h) => (
                      <th key={h} className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-wide" style={{ color: COLORS.text.secondary }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {marketRows.map((ref) => {
                    const up = (ref.pctChange ?? 0) >= 0;
                    return (
                      <tr key={ref.commodity} style={{ borderTop: `1px solid ${COLORS.lightGray}` }}>
                        <td className="px-3 py-1.5 font-medium truncate" style={{ color: COLORS.text.primary }}>{ref.commodity}</td>
                        <td className="px-3 py-1.5" style={{ color: COLORS.text.secondary }}>{formatINR(ref.latest)} {ref.unit}</td>
                        <td className="px-3 py-1.5 font-medium" style={{ color: ref.pctChange == null ? COLORS.text.tertiary : up ? '#EA580C' : '#16A34A' }}>
                          {ref.pctChange == null ? '—' : `${up ? '+' : ''}${ref.pctChange.toFixed(1)}%`}
                        </td>
                      </tr>
                    );
                  })}
                  {marketRows.length === 0 && (
                    <tr>
                      <td colSpan={3} className="px-3 py-8 text-center text-xs" style={{ color: COLORS.text.tertiary }}>No market price records found.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            {marketRows.length > 0 && (
              <p className="text-[11px] mt-1.5" style={{ color: COLORS.text.tertiary }}>
                Change is calculated over the last {Math.max(...marketRows.map((r) => r.pointCount))} recorded prices per commodity
                ({formatDate(marketRows[0]?.earliestDate)} → {formatDate(marketRows[0]?.latestDate)}).
              </p>
            )}
          </div>
        </div>
      </SectionCard>
    </div>
  );
};

(CommodityMarket as CommodityMarketComponent).Metadata = METADATA;

export default CommodityMarket;

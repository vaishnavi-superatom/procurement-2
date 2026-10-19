import React, { useEffect, useState } from 'react';
import { COLORS, SHADOWS } from '../../design-system/tokens';
import { TRankBadge } from '../RfqReceived/TechnicalEvaluation';

// Supplier performance for the quoting suppliers: delivery discipline from our purchase orders,
// and a sustainability score from the inputs the database actually holds. Shown for reading only;
// the T-rank, L-rank and recommendation order are untouched.

const TEAL = {
  base: '#3A59CD',
  dark: '#2E47A4',
  tint: '#EBEEFA',
  border: '#D8DEF5',
};
const INSUFFICIENT = 'Insufficient Data';
const SAFE_ID = /^[A-Za-z0-9_-]+$/;
/** Fewer completed deliveries than this and the rate is flagged as a small sample. */
const SMALL_SAMPLE = 5;

/**
 * Sustainability framework: every component a sustainability score should weigh, and whether our
 * database records it. Weights go only to recorded components; the rest show as not recorded and
 * carry no weight, rather than being filled in from unrelated supplier data.
 */
const SUSTAINABILITY_COMPONENTS: { key: string; label: string; recorded: boolean; source: string; weight: number | null }[] = [
  {
    key: 'ecovadis',
    label: 'EcoVadis rating (environment, labour & human rights, ethics, sustainable procurement)',
    recorded: true,
    source: 'supplier_scorecard.ecovadis_score, 0–100',
    weight: 100,
  },
  { key: 'compliance', label: 'Environmental compliance', recorded: false, source: 'Not recorded in our database', weight: null },
  { key: 'certifications', label: 'Certifications (e.g. ISO 14001)', recorded: false, source: 'Not recorded in our database', weight: null },
  { key: 'emissions', label: 'Emissions', recorded: false, source: 'Not recorded in our database', weight: null },
  { key: 'waste', label: 'Waste management', recorded: false, source: 'Not recorded in our database', weight: null },
];

export interface PerformanceSupplier {
  vendorId: string;
  vendorName: string;
  tRank: string | null;
}

interface DeliveryRow {
  vendor_id: string;
  completed: number;
  on_time: number;
  avg_days_late: number | null;
}

interface ScorecardRow {
  vendor_id: string;
  ecovadis_score: number | null;
  sustainability_tier: string | null;
}

type RunQuery = <T>(sql: string, params?: Record<string, unknown>) => Promise<T[]>;

const TIER_STYLE: Record<string, { bg: string; fg: string }> = {
  Advanced: { bg: '#DCFCE7', fg: '#16A34A' },
  Good: { bg: '#E0F2FE', fg: '#0284C7' },
  Basic: { bg: '#FEF3C7', fg: '#B45309' },
  Insufficient: { bg: COLORS.lightGray, fg: COLORS.text.secondary },
};

const Muted: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span style={{ color: COLORS.text.tertiary }}>{children}</span>
);

export const SupplierPerformance: React.FC<{ suppliers: PerformanceSupplier[]; runQuery: RunQuery; embedded?: boolean }> = ({ suppliers, runQuery, embedded = false }) => {
  const [delivery, setDelivery] = useState<Record<string, DeliveryRow>>({});
  const [scorecard, setScorecard] = useState<Record<string, ScorecardRow>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showMethod, setShowMethod] = useState(false);

  // Ids are checked against SAFE_ID before they go into the IN list.
  const ids = suppliers.map((s) => s.vendorId).filter((id) => SAFE_ID.test(id));
  const idKey = ids.join(',');

  useEffect(() => {
    if (ids.length === 0) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    const inList = ids.map((id) => `'${id}'`).join(', ');
    // A delivery counts once it has happened: an actual delivery date on or before today.
    const completed = 'actual_delivery_date IS NOT NULL AND actual_delivery_date <= CURRENT_DATE AND delivery_date IS NOT NULL';
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const [deliveryRows, scoreRows] = await Promise.all([
          runQuery<DeliveryRow>(`
            SELECT vendor_id,
                   COUNT(*) FILTER (WHERE ${completed}) AS completed,
                   COUNT(*) FILTER (WHERE ${completed} AND actual_delivery_date <= delivery_date) AS on_time,
                   ROUND(AVG(actual_delivery_date - delivery_date) FILTER (WHERE ${completed} AND actual_delivery_date > delivery_date)::numeric, 1) AS avg_days_late
            FROM purchase_orders
            WHERE vendor_id IN (${inList})
            GROUP BY vendor_id;`),
          runQuery<ScorecardRow>(`
            SELECT vendor_id, ecovadis_score, sustainability_tier
            FROM supplier_scorecard
            WHERE vendor_id IN (${inList});`),
        ]);
        if (cancelled) return;
        setDelivery(Object.fromEntries(deliveryRows.map((r) => [r.vendor_id, r])));
        setScorecard(Object.fromEntries(scoreRows.map((r) => [r.vendor_id, r])));
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Couldn't load supplier performance");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idKey]);

  return (
    <div
      className={embedded ? 'rounded-lg overflow-hidden' : 'rounded-xl overflow-hidden mb-4'}
      style={{ border: `1px solid ${TEAL.border}`, backgroundColor: COLORS.white, ...(embedded ? {} : { boxShadow: SHADOWS.card }) }}
    >
      <div className="px-4 py-3 flex items-start justify-between gap-3" style={{ borderBottom: `1px solid ${TEAL.border}` }}>
        <div>
          <h2 className="text-sm font-semibold" style={{ color: COLORS.text.primary }}>Supplier Performance</h2>
          <p className="text-[11px] mt-0.5" style={{ color: COLORS.text.secondary }}>
            Delivery discipline from our purchase orders, and sustainability from the ratings on record. For reading only: rankings are unchanged.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowMethod((v) => !v)}
          aria-expanded={showMethod}
          className="text-[11px] font-medium whitespace-nowrap flex-shrink-0"
          style={{ color: TEAL.base }}
        >
          {showMethod ? 'Hide method' : 'How these are calculated'}
        </button>
      </div>

      {showMethod && (
        <div className="px-4 py-3 space-y-3 text-[11px]" style={{ backgroundColor: COLORS.lightBackground, borderBottom: `1px solid ${TEAL.border}` }}>
          <div>
            <p className="font-semibold" style={{ color: COLORS.text.primary }}>Delivery Discipline</p>
            <p style={{ color: COLORS.text.secondary }}>
              On-Time Delivery % = (On-Time Deliveries ÷ Total Completed Deliveries) × 100. A delivery is completed once its actual delivery date is on
              or before today, and on time when that date is on or before the promised delivery date. All of the supplier's purchase orders count, every
              material. With no completed delivery, it shows {INSUFFICIENT}.
            </p>
          </div>
          <div>
            <p className="font-semibold" style={{ color: COLORS.text.primary }}>Sustainability Score</p>
            <p style={{ color: COLORS.text.secondary }}>
              Score = Σ (component score × weight), over the components our database records. Only the EcoVadis rating is recorded, so it carries the full
              weight; the others aren't recorded and carry none. Delivery, quality, risk and spend are not sustainability inputs and aren't used.
            </p>
            <table className="w-full mt-1.5">
              <thead>
                <tr style={{ color: COLORS.text.tertiary }}>
                  {['Component', 'In our data', 'Weight'].map((h) => (
                    <th key={h} className={`${h === 'Weight' ? 'text-right' : 'text-left'} font-medium py-1 pr-3`}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {SUSTAINABILITY_COMPONENTS.map((c) => (
                  <tr key={c.key} style={{ borderTop: `1px solid ${COLORS.lightGray}` }}>
                    <td className="py-1 pr-3" style={{ color: COLORS.text.primary }}>{c.label}</td>
                    <td className="py-1 pr-3" style={{ color: c.recorded ? COLORS.text.secondary : COLORS.text.tertiary }}>{c.source}</td>
                    <td className="py-1 pr-3 text-right tabular-nums font-semibold" style={{ color: c.weight != null ? COLORS.text.primary : COLORS.text.tertiary }}>
                      {c.weight != null ? `${c.weight}%` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {error ? (
        <p className="px-4 py-3 text-xs" style={{ color: '#475569' }}>Couldn't load supplier performance: {error}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ backgroundColor: COLORS.lightBackground }}>
                {['Vendor', 'Delivery Discipline', 'Sustainability Score'].map((h) => (
                  <th key={h} className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-wide" style={{ color: COLORS.text.secondary }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {suppliers.map((s) => {
                const d = delivery[s.vendorId];
                const completed = Number(d?.completed ?? 0);
                const onTime = Number(d?.on_time ?? 0);
                const otd = completed > 0 ? (onTime / completed) * 100 : null;
                const sc = scorecard[s.vendorId];
                const eco = sc?.ecovadis_score != null ? Number(sc.ecovadis_score) : null;
                const tier = sc?.sustainability_tier ? TIER_STYLE[sc.sustainability_tier] : undefined;
                return (
                  <tr key={s.vendorId} style={{ borderTop: `1px solid ${COLORS.lightGray}` }}>
                    <td className="px-3 py-2 align-top" style={{ color: COLORS.text.primary }}>
                      <span className="inline-flex items-center gap-1.5">
                        <span className="font-medium">{s.vendorName}</span>
                        <TRankBadge rank={s.tRank} />
                      </span>
                    </td>
                    <td className="px-3 py-2 align-top">
                      {loading ? (
                        <Muted>Loading…</Muted>
                      ) : otd == null ? (
                        <Muted>{INSUFFICIENT}</Muted>
                      ) : (
                        <>
                          <span className="font-bold tabular-nums" style={{ color: COLORS.text.primary }}>{otd.toFixed(1)}%</span>{' '}
                          <span className="text-[11px]" style={{ color: COLORS.text.secondary }}>
                            on time ({onTime} of {completed} completed deliveries)
                          </span>
                          {d?.avg_days_late != null && (
                            <div className="text-[11px]" style={{ color: COLORS.text.tertiary }}>Late deliveries average {Number(d.avg_days_late)} days late</div>
                          )}
                          {completed < SMALL_SAMPLE && (
                            <div className="text-[11px]" style={{ color: '#B45309' }}>Small sample: read with care</div>
                          )}
                        </>
                      )}
                    </td>
                    <td className="px-3 py-2 align-top">
                      {loading ? (
                        <Muted>Loading…</Muted>
                      ) : eco == null ? (
                        <Muted>{INSUFFICIENT}</Muted>
                      ) : (
                        <>
                          <span className="inline-flex items-center gap-1.5">
                            <span className="font-bold tabular-nums" style={{ color: COLORS.text.primary }}>{eco}</span>
                            <span className="text-[11px]" style={{ color: COLORS.text.tertiary }}>/ 100</span>
                            {tier && sc?.sustainability_tier && (
                              <span className="px-1.5 py-0.5 rounded-full text-[10px] font-semibold" style={{ backgroundColor: tier.bg, color: tier.fg }}>
                                {sc.sustainability_tier}
                              </span>
                            )}
                          </span>
                          <div className="text-[11px] tabular-nums" style={{ color: COLORS.text.tertiary }}>
                            EcoVadis {eco} × 100% = {eco}; other components not recorded
                          </div>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

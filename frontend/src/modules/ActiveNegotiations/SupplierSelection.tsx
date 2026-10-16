import React, { useEffect, useRef, useState } from 'react';
import { Icon } from '@iconify/react';
import { COLORS, SHADOWS } from '../../design-system/tokens';
import { TRankBadge } from '../RfqReceived/TechnicalEvaluation';
import { aiRanking, RANK_HELP, type RankedVendor, type SupplierRecommendation } from '../../data/rfq-recommendation';
import { selectSupplier, type SupplierSelection } from '../../data/rfq-workflow';

const TEAL = {
  base: '#3A59CD',
  dark: '#2E47A4',
  tint: '#EBEEFA',
  border: '#D8DEF5',
};

const formatINR = (n: number | null | undefined): string => {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return '₹' + Math.round(n).toLocaleString('en-IN');
};

const formatTime = (iso: string | null | undefined): string => {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '' : d.toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
};

const fmtPctAbs = (p: number): string => `${Math.abs(p).toFixed(1)}%`;

/** "Net 45" → 45; unparseable terms fall back to 0 so a comparison never crashes or fabricates a number. */
const paymentDays = (terms: string): number => Number(/\d+/.exec(terms)?.[0] ?? '0');

/**
 * 3–4 concise, actionable talking points for negotiating with this specific
 * vendor — built only from this RFQ's own quotes (rows) and this vendor's own
 * recommendation fields (quoted price, commercial terms, delivery, the
 * recommendation's own vs-contract/vs-historical/vs-online benchmarks, risk,
 * OTD/quality, flags, technical note). Nothing here is invented: each point
 * either states a real field directly or compares two real fields already
 * present on the data. Recomputed fresh on every call, so it always reflects
 * whichever vendor is currently picked.
 */
function buildNegotiationPointers(vendor: RankedVendor, rows: RankedVendor[]): string[] {
  const points: string[] = [];
  const others = rows.filter((r) => r.vendorId !== vendor.vendorId);

  // 1. Price vs the cheapest real quote in this RFQ (only meaningful with 2+ bids).
  if (others.length > 0) {
    const cheapest = rows.reduce((min, r) => (r.quotedPrice < min.quotedPrice ? r : min), rows[0]);
    if (cheapest.vendorId === vendor.vendorId) {
      points.push(`Lowest quote received for this RFQ (${formatINR(vendor.quotedPrice)}) — a strong anchor; avoid conceding further without a clear trade-off.`);
    } else {
      const gapPct = ((vendor.quotedPrice - cheapest.quotedPrice) / cheapest.quotedPrice) * 100;
      points.push(
        `Quoted ${formatINR(vendor.quotedPrice)}, ${fmtPctAbs(gapPct)} higher than the lowest bid in this RFQ (${formatINR(cheapest.quotedPrice)} from ${cheapest.vendorName}) — use this gap to push for a lower price.`
      );
    }
  }

  // 2. Price vs our own contract rate, else our 12-month average, else the live market price —
  // whichever real benchmark the recommendation actually computed, in that priority order.
  const benchmark =
    vendor.vsContractPct != null
      ? { label: 'our current contract price', pct: vendor.vsContractPct }
      : vendor.vsHistoricalAvgPct != null
        ? { label: 'our 12-month average price', pct: vendor.vsHistoricalAvgPct }
        : vendor.vsOnlinePct != null
          ? { label: 'the live market price', pct: vendor.vsOnlinePct }
          : null;
  if (benchmark && Math.abs(benchmark.pct) >= 1) {
    points.push(
      benchmark.pct > 0
        ? `${fmtPctAbs(benchmark.pct)} above ${benchmark.label} — ask them to explain the premium or move closer to it.`
        : `Already ${fmtPctAbs(benchmark.pct)} below ${benchmark.label} — a favorable rate worth locking in before further rounds.`
    );
  }

  // 3. Delivery vs the fastest bid in this RFQ.
  if (others.length > 0) {
    const fastest = rows.reduce((min, r) => (r.deliveryDays < min.deliveryDays ? r : min), rows[0]);
    if (fastest.vendorId === vendor.vendorId) {
      points.push(`Fastest delivery in this RFQ at ${vendor.deliveryDays} days — a point in their favor if price concessions are limited.`);
    } else if (fastest.deliveryDays < vendor.deliveryDays) {
      points.push(`Delivery is ${vendor.deliveryDays} days vs ${fastest.deliveryDays} days from ${fastest.vendorName} — ask whether they can match it.`);
    }
  }

  // 4. Whichever real commercial-terms or risk signal stands out most, in priority order.
  const longerWarranty = others.find((r) => r.warrantyMonths > vendor.warrantyMonths);
  const longerPayment = others.find((r) => paymentDays(r.paymentTerms) > paymentDays(vendor.paymentTerms));
  if (vendor.flags) {
    points.push(`Flagged: ${vendor.flags} — raise this directly and confirm how they plan to address it.`);
  } else if (vendor.overallRisk === 'High') {
    points.push('Overall risk tier is High — consider requiring mitigations or additional guarantees before awarding.');
  } else if (longerWarranty) {
    points.push(`Warranty is ${vendor.warrantyMonths} months vs ${longerWarranty.warrantyMonths} months from ${longerWarranty.vendorName} — ask if they can match it.`);
  } else if (longerPayment) {
    points.push(`Payment terms are ${vendor.paymentTerms} vs ${longerPayment.paymentTerms} from ${longerPayment.vendorName} — negotiate for longer terms.`);
  } else if (vendor.otdPct != null && vendor.otdPct < 90) {
    points.push(`On-time delivery track record is ${vendor.otdPct}% — below a strong benchmark; consider a delivery-performance clause.`);
  } else if (vendor.qualityPct != null && vendor.qualityPct < 95) {
    points.push(`Quality acceptance rate is ${vendor.qualityPct}% — worth confirming inspection and rejection terms.`);
  } else if (vendor.technicalNote) {
    points.push(vendor.technicalNote);
  }

  return points.slice(0, 4);
}

// T, L and system ranks are separate columns (walkthrough, 16 Oct: "they are
// individual columns, not combined T1 L1").

/** Price rank among technically accepted vendors (L1 = lowest price). */
export const LRankBadge: React.FC<{ rank: string | null | undefined }> = ({ rank }) =>
  rank ? (
    <span
      className="inline-flex px-2 py-0.5 rounded-full text-[11px] font-semibold whitespace-nowrap"
      style={{ backgroundColor: COLORS.lightGray, color: COLORS.text.primary }}
    >
      {rank}
    </span>
  ) : (
    <span className="text-[11px]" style={{ color: COLORS.text.tertiary }}>—</span>
  );

/** Place in the System Recommendation's order: 1 = recommended, then by combined score. */
export const AiRankBadge: React.FC<{ rank: number | null | undefined }> = ({ rank }) =>
  rank ? (
    <span
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold whitespace-nowrap"
      style={rank === 1 ? { backgroundColor: TEAL.base, color: COLORS.white } : { backgroundColor: COLORS.lightGray, color: COLORS.text.secondary }}
      title={rank === 1 ? 'Recommended by the system' : undefined}
    >
      {rank === 1 && <Icon icon="mdi:creation" className="w-3 h-3" />}
      {rank}
    </span>
  ) : (
    <span className="text-[11px]" style={{ color: COLORS.text.tertiary }} title="Run the System Recommendation to rank">
      —
    </span>
  );

const weightsText = (rec: SupplierRecommendation): string =>
  `${Math.round((rec.weights?.price ?? 0.6) * 100)}% price rank (L), ${Math.round((rec.weights?.technical ?? 0.4) * 100)}% technical rank (T)`;

const cardStyle = { border: `1px solid ${TEAL.border}`, backgroundColor: COLORS.white, boxShadow: SHADOWS.card };

/** The recommended supplier and why. Advisory: the buyer still chooses. */
export const RecommendationCard: React.FC<{
  rec: SupplierRecommendation | null;
  loading: boolean;
  error: string | null;
  onRerun: () => void;
}> = ({ rec, loading, error, onRerun }) => {
  const pick = rec?.data.find((v) => v.vendorId === rec.recommendedVendorId) ?? null;
  return (
    <div className="rounded-xl overflow-hidden mb-4" style={cardStyle}>
      <div className="px-4 py-3 flex items-start justify-between gap-3" style={{ borderBottom: `1px solid ${TEAL.border}` }}>
        <div>
          <h2 className="text-sm font-semibold flex items-center gap-1.5" style={{ color: COLORS.text.primary }}>
            <Icon icon="mdi:creation-outline" className="w-4 h-4" style={{ color: TEAL.base }} />
            System Recommendation
          </h2>
          <p className="text-[11px] mt-0.5" style={{ color: COLORS.text.secondary }}>
            Advisory. You choose the supplier below; choosing a different one needs a short reason.
          </p>
        </div>
        {rec && !loading && (
          <button
            onClick={onRerun}
            className="inline-flex items-center gap-1 text-[11px] font-medium flex-shrink-0"
            style={{ color: TEAL.base }}
            title="Run a fresh market study and recommendation"
          >
            <Icon icon="mdi:refresh" className="w-3.5 h-3.5" /> Run again
          </button>
        )}
      </div>
      <div className="px-4 py-3">
        {loading ? (
          <div className="space-y-2 animate-pulse">
            <div className="h-5 w-48 rounded" style={{ backgroundColor: '#E2E8F0' }} />
            <div className="h-3 w-full rounded" style={{ backgroundColor: COLORS.lightGray }} />
            <div className="h-3 w-4/5 rounded" style={{ backgroundColor: COLORS.lightGray }} />
            <p className="text-[11px] pt-1" style={{ color: COLORS.text.tertiary }}>Weighing the quotes, ranks and market study…</p>
          </div>
        ) : error ? (
          <p className="text-xs" style={{ color: '#475569' }}>Couldn't get a recommendation: {error}</p>
        ) : !rec ? null : !rec.recommendedVendorId ? (
          <p className="text-xs" style={{ color: COLORS.text.secondary }}>{rec.rationale || 'No supplier can be recommended for this RFQ.'}</p>
        ) : (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-base font-bold" style={{ color: COLORS.text.primary }}>{rec.recommendedVendor || rec.recommendedVendorId}</span>
              {pick && (
                <span className="inline-flex items-center gap-1.5">
                  <TRankBadge rank={pick.tRank} />
                  <LRankBadge rank={pick.lRank} />
                </span>
              )}
              {pick && (
                <span className="text-[11px]" style={{ color: COLORS.text.secondary }}>
                  {formatINR(pick.quotedPrice)} / {rec.unit} · {pick.deliveryDays} days
                </span>
              )}
            </div>
            {/* Exactly up to 4 concise points, built only from rec's own real
                fields — the rationale, then its (already-capped-at-3) real
                considerations, then the real scoring-agreement fact as filler
                only when there's a gap. Never invented, never padded beyond
                what the recommendation actually returned. */}
            {(() => {
              const points: string[] = [];
              if (rec.rationale) points.push(rec.rationale);
              for (const c of rec.considerations) points.push(c);
              if (points.length < 4) {
                points.push(
                  rec.agreesWithScore
                    ? `Matches the top combined score under the ${weightsText(rec)} weighting.`
                    : `Differs from the top combined score under the ${weightsText(rec)} weighting — see the reason above.`
                );
              }
              return points.length > 0 ? (
                <ul className="text-xs space-y-1 list-disc pl-4" style={{ color: COLORS.text.primary }}>
                  {points.slice(0, 4).map((p, i) => (
                    <li key={i}>{p}</li>
                  ))}
                </ul>
              ) : null;
            })()}
            <p className="text-[10px]" style={{ color: COLORS.text.tertiary }}>
              {rec.recommendationSource === 'ai' ? 'system recommendation' : 'Top combined score (system unavailable)'}
              {rec.createdAt ? ` · ${rec.reused ? 'saved' : 'made'} ${formatTime(rec.createdAt)}` : ''}
            </p>
          </div>
        )}
      </div>
    </div>
  );
};

/** Pick one supplier; the pop-up confirms it (or asks why, for a deviation) and saves it. */
export const SelectSupplierList: React.FC<{
  rfqId: string;
  rec: SupplierRecommendation;
  pickedVendorId: string | null;
  onPick: (vendorId: string) => void;
  selection: SupplierSelection | null;
  onSaved: (selection: SupplierSelection) => void;
}> = ({ rfqId, rec, pickedVendorId, onPick, selection, onSaved }) => {
  const [confirming, setConfirming] = useState(false);
  const rows = aiRanking(rec);
  const picked = rows.find((v) => v.vendorId === pickedVendorId) ?? null;
  const savedForPick = selection && selection.vendorId === pickedVendorId;
  // Recomputed on every render, so it always reflects whichever vendor is
  // currently picked — no separate effect/state needed to "update on change".
  const pointers = picked ? buildNegotiationPointers(picked, rows) : [];

  return (
    <>
    <div className="rounded-xl overflow-hidden mb-4" style={cardStyle}>
      <div className="px-4 py-3" style={{ borderBottom: `1px solid ${TEAL.border}` }}>
        <h2 className="text-sm font-semibold" style={{ color: COLORS.text.primary }}>Select Supplier</h2>
        <p className="text-[11px] mt-0.5" style={{ color: COLORS.text.secondary }}>
          Recommended supplier first, then by combined score: {weightsText(rec)}.
        </p>
      </div>
      <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr style={{ backgroundColor: COLORS.lightBackground }}>
            {['', 'System Rank', 'Vendor', 'T-Rank', 'L-Rank', 'Quoted Price', 'Delivery', 'EcoVadis'].map((h, i) => (
              <th
                key={i}
                title={RANK_HELP[h]}
                className="text-left px-4 py-2 text-[11px] font-semibold uppercase tracking-wide whitespace-nowrap"
                style={{ color: COLORS.text.secondary }}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((v, i) => {
            const checked = pickedVendorId === v.vendorId;
            const recommended = v.vendorId === rec.recommendedVendorId;
            return (
              <tr
                key={v.vendorId}
                onClick={() => onPick(v.vendorId)}
                className="cursor-pointer"
                style={{ borderTop: `1px solid ${COLORS.lightGray}`, backgroundColor: checked ? TEAL.tint : 'transparent' }}
              >
                <td className="px-4 py-2">
                  <input
                    type="radio"
                    name={`select-supplier-${rfqId}`}
                    checked={checked}
                    onChange={() => onPick(v.vendorId)}
                    className="w-4 h-4 cursor-pointer"
                    style={{ accentColor: TEAL.base }}
                    aria-label={`Select ${v.vendorName}`}
                  />
                </td>
                <td className="px-4 py-2"><AiRankBadge rank={i + 1} /></td>
                <td className="px-4 py-2" style={{ color: COLORS.text.primary }}>
                  <span className="font-medium">{v.vendorName}</span>
                  {recommended && (
                    <span className="ml-2 px-1.5 py-0.5 rounded-full text-[10px] font-semibold" style={{ backgroundColor: TEAL.base, color: COLORS.white }}>
                      Recommended
                    </span>
                  )}
                </td>
                <td className="px-4 py-2"><TRankBadge rank={v.tRank} /></td>
                <td className="px-4 py-2"><LRankBadge rank={v.lRank} /></td>
                <td className="px-4 py-2" style={{ color: COLORS.text.primary }}>{formatINR(v.quotedPrice)}</td>
                <td className="px-4 py-2 whitespace-nowrap" style={{ color: COLORS.text.secondary }}>{v.deliveryDays} days</td>
                <td className="px-4 py-2" style={{ color: COLORS.text.secondary }}>{v.ecovadisScore ?? '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>
      <div className="px-4 py-3 flex items-center justify-between gap-3" style={{ backgroundColor: COLORS.lightBackground }}>
        <p className="text-[11px]" style={{ color: COLORS.text.secondary }}>
          {savedForPick
            ? `${picked?.vendorName} selected${selection!.selectedBy ? ` by ${selection!.selectedBy}` : ''} · ${formatTime(selection!.createdAt)}${selection!.isDeviation ? ' · differs from the recommendation' : ''}`
            : picked
              ? `${picked.vendorName} picked, not saved yet.`
              : 'Pick one supplier.'}
        </p>
        <button
          disabled={!picked || !!savedForPick}
          onClick={() => setConfirming(true)}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold flex-shrink-0"
          style={{
            backgroundColor: picked && !savedForPick ? TEAL.base : COLORS.lightGray,
            color: picked && !savedForPick ? COLORS.white : COLORS.text.tertiary,
            cursor: picked && !savedForPick ? 'pointer' : 'not-allowed',
          }}
        >
          <Icon icon={savedForPick ? 'mdi:check' : 'mdi:account-check-outline'} className="w-4 h-4" />
          {savedForPick ? 'Selected' : 'Select Supplier'}
        </button>
      </div>
      {confirming && picked && (
        <SelectionModal
          rfqId={rfqId}
          rec={rec}
          vendor={picked}
          onCancel={() => setConfirming(false)}
          onSaved={(s) => {
            setConfirming(false);
            onSaved(s);
          }}
        />
      )}
    </div>

    {picked && pointers.length > 0 && (
      <div className="rounded-xl overflow-hidden mb-4" style={cardStyle}>
        <div className="px-4 py-3" style={{ borderBottom: `1px solid ${TEAL.border}` }}>
          <h2 className="text-sm font-semibold flex items-center gap-1.5" style={{ color: COLORS.text.primary }}>
            <Icon icon="mdi:comment-quote-outline" className="w-4 h-4" style={{ color: TEAL.base }} />
            Negotiation Pointers — {picked.vendorName}
          </h2>
          <p className="text-[11px] mt-0.5" style={{ color: COLORS.text.secondary }}>
            Talking points from this RFQ's own quotes and benchmarks — updates as the picked supplier changes.
          </p>
        </div>
        <ul className="px-4 py-3 text-xs space-y-1.5 list-disc pl-8" style={{ color: COLORS.text.primary }}>
          {pointers.map((p, i) => (
            <li key={i}>{p}</li>
          ))}
        </ul>
      </div>
    )}
    </>
  );
};

/** Confirms the recommended vendor with its reason, or asks why for any other vendor. */
const SelectionModal: React.FC<{
  rfqId: string;
  rec: SupplierRecommendation;
  vendor: RankedVendor;
  onCancel: () => void;
  onSaved: (selection: SupplierSelection) => void;
}> = ({ rfqId, rec, vendor, onCancel, onSaved }) => {
  const deviation = vendor.vendorId !== rec.recommendedVendorId;
  const [comment, setComment] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const recommended = rec.data.find((v) => v.vendorId === rec.recommendedVendorId) ?? null;
  const canSave = !saving && (!deviation || comment.trim().length > 0);

  useEffect(() => {
    if (deviation) textRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !saving) onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [deviation, saving, onCancel]);

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      onSaved(await selectSupplier(rfqId, vendor.vendorId, deviation ? comment.trim() : undefined));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save the selection");
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ backgroundColor: 'rgba(15, 23, 42, 0.4)' }}
      onClick={() => !saving && onCancel()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="select-supplier-title"
        className="w-full max-w-md rounded-xl overflow-hidden"
        style={{ backgroundColor: COLORS.white, boxShadow: '0 10px 30px rgba(15, 23, 42, 0.2)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4" style={{ borderBottom: `1px solid ${TEAL.border}` }}>
          <h3 id="select-supplier-title" className="text-sm font-semibold" style={{ color: COLORS.text.primary }}>
            {deviation ? 'Choose a different supplier?' : 'Confirm supplier'}
          </h3>
        </div>
        <div className="px-5 py-4 space-y-3">
          {deviation ? (
            <>
              <p className="text-xs leading-relaxed" style={{ color: COLORS.text.primary }}>
                The recommended supplier is <b>{rec.recommendedVendor || rec.recommendedVendorId}</b>
                {recommended && ` (${recommended.lRank}, ${recommended.tRank})`}. You're selecting <b>{vendor.vendorName}</b> ({vendor.lRank},{' '}
                {vendor.tRank}) instead.
              </p>
              <label className="block">
                <span className="text-[11px] font-semibold" style={{ color: COLORS.text.secondary }}>
                  Why {vendor.vendorName}? (required, saved with the selection)
                </span>
                <textarea
                  ref={textRef}
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  maxLength={2000}
                  rows={3}
                  placeholder="e.g. The shutdown needs delivery within 10 days"
                  className="mt-1 w-full rounded-lg px-2.5 py-2 text-xs focus:outline-none"
                  style={{ border: `1px solid ${TEAL.border}`, color: COLORS.text.primary }}
                />
              </label>
            </>
          ) : (
            <>
              <p className="text-xs leading-relaxed" style={{ color: COLORS.text.primary }}>
                You're selecting <b>{vendor.vendorName}</b> ({vendor.lRank}, {vendor.tRank}), the recommended supplier, at{' '}
                {formatINR(vendor.quotedPrice)} / {rec.unit} with delivery in {vendor.deliveryDays} days.
              </p>
              {rec.rationale && (
                <div className="rounded-lg px-3 py-2" style={{ backgroundColor: TEAL.tint }}>
                  <p className="text-[11px] font-semibold" style={{ color: TEAL.dark }}>Why</p>
                  <p className="text-[11px] mt-0.5 leading-relaxed" style={{ color: TEAL.dark }}>{rec.rationale}</p>
                </div>
              )}
            </>
          )}
          {error && <p className="text-[11px]" style={{ color: '#475569' }}>{error}</p>}
        </div>
        <div className="px-5 py-3 flex items-center justify-end gap-2" style={{ backgroundColor: COLORS.lightBackground }}>
          <button
            onClick={onCancel}
            disabled={saving}
            className="px-3 py-1.5 rounded-lg text-xs font-medium"
            style={{ color: COLORS.text.secondary, border: `1px solid ${COLORS.lightGray}`, backgroundColor: COLORS.white }}
          >
            Cancel
          </button>
          <button
            onClick={save}
            disabled={!canSave}
            className="px-3 py-1.5 rounded-lg text-xs font-semibold"
            style={{
              backgroundColor: canSave ? TEAL.base : COLORS.lightGray,
              color: canSave ? COLORS.white : COLORS.text.tertiary,
              cursor: canSave ? 'pointer' : 'not-allowed',
            }}
          >
            {saving ? 'Saving…' : 'Confirm selection'}
          </button>
        </div>
      </div>
    </div>
  );
};

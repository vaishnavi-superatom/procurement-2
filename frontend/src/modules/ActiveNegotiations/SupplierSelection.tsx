import React, { useEffect, useRef, useState } from 'react';
import { Icon } from '@iconify/react';
import { COLORS, SHADOWS } from '../../design-system/tokens';
import { TRankBadge } from '../RfqReceived/TechnicalEvaluation';
import {
  aiRanking,
  RANK_HELP,
  RANK_SUBLABEL,
  type NegotiationStrategy,
  type RankedVendor,
  type RecommendationPoint,
  type SupplierRecommendation,
  type VendorStrategy,
} from '../../data/rfq-recommendation';
import { selectSupplier, type SupplierSelection } from '../../data/rfq-workflow';

const TEAL = {
  base: '#0F6B64',
  dark: '#0B4F4A',
  tint: '#E6F5F3',
  border: '#D7E8E6',
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

// T, L and AI ranks are separate columns (walkthrough, 16 Oct: "they are
// individual columns, not combined T1 L1").

/** Commercial / price bid rank among technically accepted vendors (L1 = lowest price). */
export const LRankBadge: React.FC<{ rank: string | null | undefined }> = ({ rank }) =>
  rank ? (
    <span
      className="inline-flex px-2 py-0.5 rounded-full text-[11px] font-semibold whitespace-nowrap"
      style={{ backgroundColor: COLORS.lightGray, color: COLORS.text.primary }}
      title={`Commercial / Price Bid Ranking: ${rank}`}
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
    <span className="text-[11px]" style={{ color: COLORS.text.tertiary }} title="Run the Market Analysis to rank">
      —
    </span>
  );

const weightsText = (rec: SupplierRecommendation): string =>
  `${Math.round((rec.weights?.price ?? 0.6) * 100)}% price rank (L), ${Math.round((rec.weights?.technical ?? 0.4) * 100)}% technical rank (T)`;

const cardStyle = { border: `1px solid ${TEAL.border}`, backgroundColor: COLORS.white, boxShadow: SHADOWS.card };

// The reason as short points with side headings (meeting, 16 Oct: "4 to 5
// bullet points… side headings, like pricing… risk").
const PointList: React.FC<{ points: RecommendationPoint[]; className: string; headingColor: string; textColor: string }> = ({
  points,
  className,
  headingColor,
  textColor,
}) => (
  <ul className={className}>
    {points.map((p) => (
      <li key={p.heading} className="flex gap-3 leading-relaxed">
        <span className="w-18 flex-shrink-0 font-semibold" style={{ color: headingColor }}>
          {p.heading}
        </span>
        <span style={{ color: textColor }}>{p.text}</span>
      </li>
    ))}
  </ul>
);

/**
 * The picked supplier's five pointers, the last one the discount to ask for
 * (review, 18 Oct: no script, "1, 2, 3, 4, 5 pointers", one table with no box
 * inside a box): plain lines under its row, in the row's own tint.
 */
const StrategyPointers: React.FC<{ strategy: VendorStrategy | null; loading: boolean; error: string | null; onRetry: () => void }> = ({
  strategy,
  loading,
  error,
  onRetry,
}) =>
  loading ? (
    <p className="text-[11px] animate-pulse" style={{ color: COLORS.text.tertiary }}>Getting the pointers…</p>
  ) : error ? (
    <p className="text-xs" style={{ color: '#475569' }}>
      Couldn't get the pointers: {error}
      <button type="button" onClick={onRetry} className="ml-2 inline-flex items-center gap-1 text-[11px] font-medium" style={{ color: TEAL.base }}>
        <Icon icon="mdi:refresh" className="w-3.5 h-3.5" /> Try again
      </button>
    </p>
  ) : !strategy ? (
    <p className="text-xs" style={{ color: COLORS.text.secondary }}>No pointers for this supplier.</p>
  ) : (
    <div className="space-y-2">
      <p className="text-xs font-semibold" style={{ color: COLORS.text.primary }}>{strategy.vendorName} — Negotiation Recommendations</p>
      {strategy.pointers.length === 0 ? (
        <p className="text-xs" style={{ color: COLORS.text.secondary }}>Our data gives no negotiation lever with this supplier.</p>
      ) : (
        <ol className="text-xs space-y-1.5">
          {strategy.pointers.map((p, i) => (
            <li key={p.heading} className="flex gap-3 leading-relaxed">
              <span className="w-32 flex-none font-semibold" style={{ color: COLORS.text.secondary }}>
                {i + 1}. {p.heading}
              </span>
              {/* Each point: the reason, then what to do, then the data it rests on. Older saved points have only text. */}
              {p.reason ? (
                <span className="min-w-0">
                  <span style={{ color: COLORS.text.primary }}>{p.reason}</span>{' '}
                  <span className="font-semibold" style={{ color: TEAL.dark }}>{p.action}</span>
                  {p.data && (
                    <span className="block text-[11px]" style={{ color: COLORS.text.tertiary }}>Data: {p.data}</span>
                  )}
                </span>
              ) : (
                <span style={{ color: COLORS.text.primary }}>{p.text}</span>
              )}
            </li>
          ))}
        </ol>
      )}
      {strategy.missing && strategy.missing.length > 0 && (
        <p className="text-[11px] flex items-start gap-1" style={{ color: '#B45309' }}>
          <Icon icon="mdi:information-outline" className="w-3.5 h-3.5 flex-none mt-px" />
          <span>Not enough data for more points. Missing: {strategy.missing.join('; ')}.</span>
        </p>
      )}
    </div>
  );

// Narrow enough not to scroll sideways (review, 18 Oct): the averages, rate contract,
// EcoVadis and flags columns went, and the score too (19 Oct); the AI rank shows the order.
const COLUMNS = ['', 'AI Rank', 'Vendor', 'T-Rank', 'L-Rank', 'Quoted Price', 'Delivery'];

/**
 * The negotiation strategy as one table (review, 18 Oct): a row per supplier,
 * the picked one open with its pointers; the pop-up confirms the pick (or asks
 * why, for a deviation) and saves it.
 */
export const SelectSupplierList: React.FC<{
  rfqId: string;
  rec: SupplierRecommendation;
  pickedVendorId: string | null;
  onPick: (vendorId: string) => void;
  selection: SupplierSelection | null;
  onSaved: (selection: SupplierSelection) => void;
  /** Shown under the picked supplier (meeting, 18 Oct: "when we select a supplier, under that… strategy points"). */
  strategy: NegotiationStrategy | null;
  strategyLoading: boolean;
  strategyError: string | null;
  onRetryStrategy: () => void;
}> = ({ rfqId, rec, pickedVendorId, onPick, selection, onSaved, strategy, strategyLoading, strategyError, onRetryStrategy }) => {
  const [confirming, setConfirming] = useState(false);
  const rows = aiRanking(rec);
  const picked = rows.find((v) => v.vendorId === pickedVendorId) ?? null;
  const savedForPick = selection && selection.vendorId === pickedVendorId;

  return (
    <div className="rounded-xl overflow-hidden mb-4" style={cardStyle}>
      <div className="px-4 py-3 flex items-start justify-between gap-3" style={{ borderBottom: `1px solid ${TEAL.border}` }}>
        <div>
          <h2 className="text-sm font-semibold" style={{ color: COLORS.text.primary }}>Negotiation Strategy</h2>
          <p className="text-[11px] mt-0.5" style={{ color: COLORS.text.secondary }}>
            Recommended first, then by combined score: {weightsText(rec)}. Pick a supplier to see its pointers.
          </p>
        </div>
      </div>
      <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr style={{ backgroundColor: COLORS.lightBackground }}>
            {COLUMNS.map((h, i) => (
              <th
                key={i}
                title={RANK_HELP[h]}
                className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-wide align-bottom"
                style={{ color: COLORS.text.secondary }}
              >
                {h}
                {RANK_SUBLABEL[h] && (
                  <span className="block text-[10px] font-medium normal-case tracking-normal" style={{ color: COLORS.text.tertiary }}>
                    {RANK_SUBLABEL[h]}
                  </span>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((v, i) => {
            const checked = pickedVendorId === v.vendorId;
            const recommended = v.vendorId === rec.recommendedVendorId;
            return (
              <React.Fragment key={v.vendorId}>
              <tr
                onClick={() => onPick(v.vendorId)}
                className="cursor-pointer"
                style={{ borderTop: `1px solid ${COLORS.lightGray}`, backgroundColor: checked ? TEAL.tint : 'transparent' }}
              >
                <td className="px-3 py-2">
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
                <td className="px-3 py-2"><AiRankBadge rank={i + 1} /></td>
                <td className="px-3 py-2" style={{ color: COLORS.text.primary }}>
                  <span className="font-medium">{v.vendorName}</span>
                  {recommended && (
                    <span className="ml-2 px-1.5 py-0.5 rounded-full text-[10px] font-semibold" style={{ backgroundColor: TEAL.base, color: COLORS.white }}>
                      Recommended
                    </span>
                  )}
                </td>
                <td className="px-3 py-2"><TRankBadge rank={v.tRank} /></td>
                <td className="px-3 py-2"><LRankBadge rank={v.lRank} /></td>
                <td className="px-3 py-2" style={{ color: COLORS.text.primary }}>{formatINR(v.quotedPrice)}</td>
                <td className="px-3 py-2 whitespace-nowrap" style={{ color: COLORS.text.secondary }}>{v.deliveryDays} days</td>
              </tr>
              {checked && (
                <tr style={{ backgroundColor: TEAL.tint }}>
                  <td colSpan={COLUMNS.length} className="px-4 pb-3 pt-1">
                    <StrategyPointers
                      strategy={strategy?.vendors.find((s) => s.vendorId === v.vendorId) ?? null}
                      loading={strategyLoading}
                      error={strategyError}
                      onRetry={onRetryStrategy}
                    />
                  </td>
                </tr>
              )}
              </React.Fragment>
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
              ? `${picked.vendorName} picked; confirm it with Select Supplier.`
              : 'Pick a supplier to see its pointers.'}
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
              {(rec.points?.length || rec.rationale) && (
                <div className="rounded-lg px-3 py-2" style={{ backgroundColor: TEAL.tint }}>
                  <p className="text-[11px] font-semibold" style={{ color: TEAL.dark }}>Why</p>
                  {rec.points?.length ? (
                    <PointList points={rec.points} className="text-[11px] space-y-1 mt-1" headingColor={TEAL.dark} textColor={TEAL.dark} />
                  ) : (
                    <p className="text-[11px] mt-0.5 leading-relaxed" style={{ color: TEAL.dark }}>{rec.rationale}</p>
                  )}
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

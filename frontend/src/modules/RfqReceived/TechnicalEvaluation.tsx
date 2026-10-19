import React, { useEffect, useRef, useState } from 'react';
import { Icon } from '@iconify/react';
import { COLORS } from '../../design-system/tokens';
import { createVendorComment, listVendorComments, type VendorComment } from '../../data/rfq-vendor-comments';
import { getSignedInUser } from '../../data/signed-in-user';
import { capitalizeName, formatWhen, initials } from '../../utils/comment-format';
import { T_RANK_STYLE } from '../../utils/t-rank-style';

// Same teal accent as the rest of the RFQ screen (see index.tsx).
const TEAL = {
  base: '#3A59CD',
  dark: '#2E47A4',
  tint: '#EBEEFA',
  border: '#D8DEF5',
};

const MAX_COMMENT_LENGTH = 2000;

// ============================================================
// Real data shapes (public.pr_technical_requirements /
// quotation_technical_bids / rfq_technical_evaluations / t_rank_definitions)
// ============================================================

export interface TechRequirement {
  sort_order: number;
  parameter: string;
  required_value: string;
  comparison: string;
  is_mandatory: boolean;
}

export interface TechBid {
  quote_id: string;
  sort_order: number;
  parameter: string;
  offered_value: string;
  status: string;
}

export interface TechEvaluation {
  quote_id: string;
  suggested_t_rank: string;
  suggestion_reason: string;
  t_rank: string | null;
  ranked_by: string | null;
  ranked_at: string | null;
}

export interface TRankDefinition {
  t_rank: string;
  label: string;
  description: string;
  eligible_for_negotiation: boolean;
}

// ============================================================
// T-rank badge — same colours wherever a T-rank shows
// ============================================================


export const TRankBadge: React.FC<{ rank: string | null | undefined }> = ({ rank }) => {
  if (!rank) return <span className="text-[11px]" style={{ color: COLORS.text.tertiary }}>—</span>;
  const style = T_RANK_STYLE[rank] ?? T_RANK_STYLE.T4;
  return (
    <span
      className="inline-flex px-2 py-0.5 rounded-full text-[11px] font-semibold whitespace-nowrap"
      style={{ backgroundColor: style.bg, color: style.fg }}
      title={`Technical Bid Ranking: ${style.label}`}
    >
      {style.label}
    </span>
  );
};

// How each offered value compares with the PR requirement.
const SPEC_STATUS: Record<string, { icon: string; color: string; label: string }> = {
  met: { icon: 'mdi:check-circle', color: '#16A34A', label: 'Met' },
  close_to_limit: { icon: 'mdi:alert-circle-outline', color: '#B45309', label: 'Close to limit' },
  minor_deviation: { icon: 'mdi:alert', color: '#EA580C', label: 'Minor deviation' },
  not_met: { icon: 'mdi:close-circle', color: '#475569', label: 'Not met' },
  preference_missed: { icon: 'mdi:minus-circle-outline', color: '#94A3B8', label: 'Preference missed' },
};

// ============================================================
// Technical comments on this vendor's bid for this RFQ
// ============================================================

const VendorTechComments: React.FC<{ rfqId: string; vendorId: string; vendorName: string }> = ({ rfqId, vendorId, vendorName }) => {
  const [comments, setComments] = useState<VendorComment[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const signedInAs = capitalizeName(getSignedInUser().userName);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const rows = await listVendorComments(rfqId, vendorId);
        if (!cancelled) setComments(rows);
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : "Couldn't load comments");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rfqId, vendorId]);

  // Newest at the bottom, next to the box you type in.
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [comments.length]);

  const post = async () => {
    const body = draft.trim();
    if (!body || posting) return;
    setPosting(true);
    setPostError(null);
    try {
      const created = await createVendorComment(rfqId, vendorId, body);
      if (created) setComments((prev) => [...prev, created]);
      setDraft('');
    } catch (err) {
      setPostError(err instanceof Error ? err.message : "Couldn't post your comment");
    } finally {
      setPosting(false);
    }
  };

  return (
    <div className="rounded-lg overflow-hidden" style={{ border: `1px solid ${TEAL.border}`, backgroundColor: COLORS.white }}>
      <div className="px-3 py-2 flex items-center justify-between" style={{ borderBottom: `1px solid ${TEAL.border}` }}>
        <h3 className="text-xs font-semibold" style={{ color: COLORS.text.primary }}>Technical comments on {vendorName} for {rfqId}</h3>
        {!loading && !loadError && (
          <span className="text-[11px]" style={{ color: COLORS.text.tertiary }}>
            {comments.length === 0 ? 'None yet' : `${comments.length} comment${comments.length === 1 ? '' : 's'}`}
          </span>
        )}
      </div>

      <div ref={listRef} className="px-3 py-2 space-y-3 overflow-auto" style={{ maxHeight: 220 }}>
        {loadError ? (
          <p className="text-xs" style={{ color: '#475569' }}>{loadError}</p>
        ) : loading ? (
          <p className="text-xs" style={{ color: COLORS.text.tertiary }}>Loading comments…</p>
        ) : comments.length === 0 ? (
          <p className="text-xs" style={{ color: COLORS.text.tertiary }}>No technical comments on this vendor's bid yet.</p>
        ) : (
          comments.map((c) => {
            const author = capitalizeName(c.userName || c.userId || 'Anonymous');
            return (
              <div key={c.id} className="flex gap-2.5">
                <div
                  className="w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-semibold flex-shrink-0"
                  style={{ backgroundColor: TEAL.tint, color: TEAL.base }}
                >
                  {initials(author)}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <span className="text-xs font-semibold" style={{ color: COLORS.text.primary }}>{author}</span>
                    <span className="text-[11px]" style={{ color: COLORS.text.tertiary }}>{formatWhen(c.createdAt)}</span>
                  </div>
                  <p className="text-xs mt-0.5 whitespace-pre-wrap break-words" style={{ color: COLORS.text.secondary }}>{c.body}</p>
                </div>
              </div>
            );
          })
        )}
      </div>

      <div className="px-3 py-2" style={{ borderTop: `1px solid ${COLORS.lightGray}` }}>
        <div className="flex gap-2 items-end">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                post();
              }
            }}
            placeholder="Add a technical comment…"
            rows={2}
            maxLength={MAX_COMMENT_LENGTH}
            disabled={posting}
            className="flex-1 rounded-lg px-3 py-2 text-xs resize-y focus:outline-none"
            style={{ border: `1px solid ${TEAL.border}`, color: COLORS.text.primary }}
          />
          <button
            onClick={post}
            disabled={!draft.trim() || posting}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold disabled:opacity-50"
            style={{ backgroundColor: TEAL.base, color: COLORS.white }}
          >
            <Icon icon={posting ? 'mdi:loading' : 'mdi:send'} className={`w-3.5 h-3.5 ${posting ? 'animate-spin' : ''}`} />
            Post
          </button>
        </div>
        <p className="text-[11px] mt-1" style={{ color: postError ? '#475569' : COLORS.text.tertiary }}>
          {postError || `Commenting as ${signedInAs} · Ctrl+Enter to post`}
        </p>
      </div>
    </div>
  );
};

// ============================================================
// Expanded vendor row: requirements | technical bid | T-rank
// ============================================================

export const TechnicalEvaluation: React.FC<{
  rfqId: string;
  vendorId: string;
  vendorName: string;
  requirements: TechRequirement[];
  bids: TechBid[];
  evaluation: TechEvaluation | undefined;
  definitions: TRankDefinition[];
  /** Awarded RFQs keep their T-ranks as a record; no more changes. */
  locked: boolean;
  onRankChange: (tRank: string) => Promise<void>;
}> = ({ rfqId, vendorId, vendorName, requirements, bids, evaluation, definitions, locked, onRankChange }) => {
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const current = evaluation?.t_rank ?? evaluation?.suggested_t_rank ?? null;
  const currentDef = definitions.find((d) => d.t_rank === current);
  const bidFor = (r: TechRequirement) => bids.find((b) => b.sort_order === r.sort_order) ?? bids.find((b) => b.parameter === r.parameter);

  const change = async (tRank: string) => {
    if (tRank === current || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      await onRankChange(tRank);
    } catch (err) {
      // The dropdown falls back to the saved rank, so say so.
      const label = (rank: string | null) => (rank ? (T_RANK_STYLE[rank] ?? { label: rank }).label : 'unranked');
      const reason = err instanceof Error && err.message ? ` (${err.message})` : '';
      setSaveError(`Couldn't save ${label(tRank)}, so it stays ${label(current)}${reason}.`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="px-4 py-4 space-y-4" style={{ backgroundColor: COLORS.lightBackground }}>
      {/* T-rank on the far left, then the PR requirement next to the vendor's bid (product review, Oct 16) */}
      <div className="grid gap-4" style={{ gridTemplateColumns: 'minmax(240px, 1fr) minmax(0, 2fr)' }}>
        {/* The buyer's call, pre-filled with the suggestion */}
        <div className="rounded-lg p-3 space-y-3" style={{ border: `1px solid ${TEAL.border}`, backgroundColor: COLORS.white }}>
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold" style={{ color: COLORS.text.primary }} title="Technical Bid Ranking (T1, T2, T3…)">
              T-Rank <span className="font-normal" style={{ color: COLORS.text.tertiary }}>· Technical bid ranking</span>
            </span>
            <TRankBadge rank={current} />
          </div>
          <select
            value={current ?? ''}
            onChange={(e) => change(e.target.value)}
            disabled={locked || saving || definitions.length === 0}
            className="w-full rounded-lg px-2.5 py-2 text-xs focus:outline-none disabled:opacity-60"
            style={{ border: `1px solid ${TEAL.border}`, color: COLORS.text.primary, backgroundColor: COLORS.white }}
          >
            {definitions.map((d) => (
              <option key={d.t_rank} value={d.t_rank}>
                {d.label} — {d.description}
              </option>
            ))}
          </select>
          {currentDef && (
            <p className="text-[11px]" style={{ color: COLORS.text.secondary }}>
              {currentDef.description}.{!currentDef.eligible_for_negotiation && ' This vendor will not go to negotiation.'}
            </p>
          )}
          {(saving || saveError || locked) && (
            <p className="text-[11px]" style={{ color: saveError ? '#475569' : COLORS.text.tertiary }}>
              {saving ? 'Saving…' : saveError ? saveError : 'This RFQ is awarded, so T-ranks are locked.'}
            </p>
          )}
          {evaluation && (
            <div className="rounded-md px-2.5 py-2" style={{ backgroundColor: TEAL.tint }}>
              <p className="text-[11px] font-semibold" style={{ color: TEAL.dark }}>
                Suggested: {(T_RANK_STYLE[evaluation.suggested_t_rank] ?? { label: evaluation.suggested_t_rank }).label}
              </p>
              <p className="text-[11px] mt-0.5" style={{ color: TEAL.dark }}>{evaluation.suggestion_reason}</p>
            </div>
          )}
          {evaluation && (
            <p className="text-[11px]" style={{ color: COLORS.text.tertiary }}>
              {!evaluation.ranked_by || evaluation.ranked_by === 'system'
                ? 'Pre-filled from the suggestion.'
                : `Set by ${capitalizeName(evaluation.ranked_by)}${evaluation.ranked_at ? ` · ${formatWhen(evaluation.ranked_at)}` : ''}`}
            </p>
          )}
        </div>

        {/* What the PR asked for, next to what this vendor offered, spec by spec */}
        <div className="rounded-lg overflow-hidden" style={{ border: `1px solid ${TEAL.border}`, backgroundColor: COLORS.white }}>
          {requirements.length === 0 ? (
            <p className="px-3 py-3 text-xs" style={{ color: COLORS.text.tertiary }}>No technical requirements recorded for this PR line.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr style={{ backgroundColor: COLORS.lightBackground }}>
                  {['Parameter', 'PR requirement', "Vendor's technical bid"].map((h) => (
                    <th key={h} className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-wide" style={{ color: COLORS.text.secondary }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {requirements.map((r) => {
                  const bid = bidFor(r);
                  const mark = SPEC_STATUS[bid?.status ?? ''];
                  const preference = r.comparison.startsWith('pref');
                  return (
                    <tr key={r.sort_order} style={{ borderTop: `1px solid ${COLORS.lightGray}` }}>
                      <td className="px-3 py-1.5 text-xs" style={{ color: COLORS.text.primary }}>
                        {r.parameter}
                        {r.is_mandatory && <span style={{ color: '#475569' }}> *</span>}
                        {preference && <span className="ml-1 text-[10px]" style={{ color: COLORS.text.tertiary }}>(preferred)</span>}
                      </td>
                      <td className="px-3 py-1.5 text-xs" style={{ color: COLORS.text.secondary }}>{r.required_value}</td>
                      <td className="px-3 py-1.5 text-xs" style={{ color: COLORS.text.primary }}>
                        {bid ? (
                          <span className="inline-flex items-center gap-1.5" title={mark?.label}>
                            {mark && <Icon icon={mark.icon} className="w-3.5 h-3.5 flex-shrink-0" style={{ color: mark.color }} />}
                            <span className={bid.status === 'not_met' ? 'font-semibold' : ''}>{bid.offered_value}</span>
                            {mark && bid.status !== 'met' && (
                              <span className="text-[10px]" style={{ color: mark.color }}>{mark.label}</span>
                            )}
                          </span>
                        ) : (
                          <span style={{ color: COLORS.text.tertiary }}>Not stated</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          <p className="px-3 py-1.5 text-[10px]" style={{ color: COLORS.text.tertiary, borderTop: `1px solid ${COLORS.lightGray}` }}>
            * Mandatory spec: not meeting it means Not accepted.
          </p>
        </div>
      </div>

      <VendorTechComments rfqId={rfqId} vendorId={vendorId} vendorName={vendorName} />
    </div>
  );
};

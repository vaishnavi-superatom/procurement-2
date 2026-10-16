import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '@iconify/react';
import { COLORS, SHADOWS } from '../../design-system/tokens';
import { createPrComment, listPrComments, type PRComment } from '../../data/pr-comments';
import { getSignedInUser } from '../../data/signed-in-user';
import { capitalizeName, formatWhen, initials } from '../../utils/comment-format';

// Same teal accent as the rest of the PR screen (see index.tsx).
const TEAL = {
  base: '#3A59CD',
  dark: '#2E47A4',
  tint: '#EBEEFA',
  border: '#D8DEF5',
};

const MAX_LENGTH = 2000;

const PRComments: React.FC<{ prId: string }> = ({ prId }) => {
  const [open, setOpen] = useState(false);
  const [comments, setComments] = useState<PRComment[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const signedInAs = capitalizeName(getSignedInUser().userName);

  const load = useCallback(async (isCancelled: () => boolean = () => false) => {
    setLoading(true);
    setLoadError(null);
    try {
      const rows = await listPrComments(prId);
      if (!isCancelled()) setComments(rows);
    } catch (err) {
      if (!isCancelled()) setLoadError(err instanceof Error ? err.message : "Couldn't load comments");
    } finally {
      if (!isCancelled()) setLoading(false);
    }
  }, [prId]);

  // Loaded with the PR (not on first open) so the button can show the count.
  useEffect(() => {
    let cancelled = false;
    load(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [load]);

  // The panel opens upward from the button; keep the newest comment in view,
  // right above the box you type in.
  useEffect(() => {
    if (open && listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [open, comments.length]);

  const post = async () => {
    const body = draft.trim();
    if (!body || posting) return;
    setPosting(true);
    setPostError(null);
    try {
      const created = await createPrComment(prId, body);
      if (created) setComments((prev) => [...prev, created]);
      setDraft('');
    } catch (err) {
      setPostError(err instanceof Error ? err.message : "Couldn't post your comment");
    } finally {
      setPosting(false);
    }
  };

  return (
    <div className="flex flex-col items-end gap-3">
      {open && (
        <div
          className="w-full rounded-xl overflow-hidden flex flex-col"
          style={{ border: `1px solid ${TEAL.border}`, backgroundColor: COLORS.white, boxShadow: SHADOWS.card, maxHeight: '55vh' }}
        >
          <div className="flex-shrink-0 px-4 py-3 flex items-center justify-between" style={{ borderBottom: `1px solid ${TEAL.border}` }}>
            <h2 className="text-sm font-semibold" style={{ color: COLORS.text.primary }}>Comments</h2>
            <button
              onClick={() => load()}
              disabled={loading}
              title="Refresh comments"
              className="p-1 rounded-md disabled:opacity-50"
              style={{ color: COLORS.text.secondary }}
            >
              <Icon icon="mdi:refresh" className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>

          <div ref={listRef} className="flex-1 min-h-0 overflow-auto px-4 py-3 space-y-4">
            {loadError ? (
              <div className="flex items-center gap-2 text-xs" style={{ color: '#475569' }}>
                <Icon icon="mdi:alert-circle" className="w-4 h-4 flex-shrink-0" />
                <span>{loadError}</span>
                <button onClick={() => load()} className="font-semibold underline" style={{ color: TEAL.base }}>
                  Try again
                </button>
              </div>
            ) : loading && comments.length === 0 ? (
              <p className="text-xs" style={{ color: COLORS.text.tertiary }}>Loading comments…</p>
            ) : comments.length === 0 ? (
              <p className="text-xs" style={{ color: COLORS.text.tertiary }}>No comments yet. Start the discussion below.</p>
            ) : (
              comments.map((c) => {
                const author = capitalizeName(c.userName || c.userId || 'Anonymous');
                return (
                  <div key={c.id} className="flex gap-3">
                    <div
                      className="w-8 h-8 rounded-full flex items-center justify-center text-[11px] font-semibold flex-shrink-0"
                      style={{ backgroundColor: TEAL.tint, color: TEAL.base }}
                    >
                      {initials(author)}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <span className="text-xs font-semibold" style={{ color: COLORS.text.primary }}>{author}</span>
                        <span className="text-[11px]" style={{ color: COLORS.text.tertiary }}>{formatWhen(c.createdAt)}</span>
                      </div>
                      <p className="text-sm mt-0.5 whitespace-pre-wrap break-words" style={{ color: COLORS.text.secondary }}>
                        {c.body}
                      </p>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          <div className="flex-shrink-0 px-4 py-3" style={{ borderTop: `1px solid ${COLORS.lightGray}` }}>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  post();
                }
              }}
              placeholder="Write a comment…"
              rows={2}
              maxLength={MAX_LENGTH}
              disabled={posting}
              className="w-full rounded-lg px-3 py-2 text-sm resize-y focus:outline-none"
              style={{ border: `1px solid ${TEAL.border}`, color: COLORS.text.primary }}
            />
            <div className="flex items-center justify-between gap-3 mt-2">
              <span className="text-[11px]" style={{ color: postError ? '#475569' : COLORS.text.tertiary }}>
                {postError || `Commenting as ${signedInAs} · Ctrl+Enter to post`}
              </span>
              <button
                onClick={post}
                disabled={!draft.trim() || posting}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold disabled:opacity-50"
                style={{ backgroundColor: TEAL.base, color: COLORS.white }}
              >
                <Icon icon={posting ? 'mdi:loading' : 'mdi:send'} className={`w-4 h-4 ${posting ? 'animate-spin' : ''}`} />
                {posting ? 'Posting…' : 'Post'}
              </button>
            </div>
          </div>
        </div>
      )}

      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold"
        style={{ border: `1px solid ${TEAL.border}`, backgroundColor: open ? TEAL.tint : COLORS.white, color: TEAL.base, boxShadow: SHADOWS.card }}
      >
        <Icon icon="mdi:comment-text-outline" className="w-4 h-4" />
        Comments{!loading && !loadError ? ` (${comments.length})` : ''}
        <Icon icon={open ? 'mdi:chevron-down' : 'mdi:chevron-up'} className="w-4 h-4" />
      </button>
    </div>
  );
};

export default PRComments;

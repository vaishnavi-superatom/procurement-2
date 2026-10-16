// Display helpers shared by the comment threads (PR comments, vendor
// technical comments).

// Postgres sends "2026-10-15 17:30:12.345678+00" — normalise it to ISO so
// every browser parses it, not just the lenient ones.
export const parseTimestamp = (value: string): Date =>
  new Date(value.replace(' ', 'T').replace(/(\.\d{3})\d+/, '$1').replace(/([+-]\d{2})$/, '$1:00'));

export const formatWhen = (value: string): string => {
  const date = parseTimestamp(value);
  if (isNaN(date.getTime())) return '';
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 7 * 86400) return `${Math.floor(seconds / 86400)}d ago`;
  return date.toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
};

// Names arrive as typed at sign-in ("yash") — always show them capitalised.
export const capitalizeName = (name: string): string =>
  name.replace(/(^|\s)(\S)/g, (_match, space: string, first: string) => space + first.toUpperCase());

export const initials = (name: string): string =>
  name
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join('') || '?';

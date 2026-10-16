// The signed-in user, as the browser knows them — sent along with comments and
// T-rank changes. The backend still prefers the relay-verified login for the id.

// The platform login (not this repo) puts the signed-in user's name in
// sessionStorage. Set this to that exact key once it's confirmed; until then
// the likely keys are searched below.
const SESSION_USER_NAME_KEY: string | null = null;

const nameFromValue = (raw: string, key: string): string | null => {
  try {
    const value = JSON.parse(raw);
    if (typeof value === 'string') return /name/i.test(key) && value.trim() ? value.trim() : null;
    const user = value?.user ?? value;
    const name = user?.fullname ?? user?.fullName ?? user?.name ?? user?.displayName ?? user?.username ?? user?.email;
    return typeof name === 'string' && name.trim() ? name.trim() : null;
  } catch {
    // Not JSON — a plain string only counts when the key says it's a name.
    const text = raw.trim();
    return /name/i.test(key) && text && text.length <= 100 ? text : null;
  }
};

const readSessionUserName = (): string | null => {
  try {
    if (SESSION_USER_NAME_KEY) {
      const raw = sessionStorage.getItem(SESSION_USER_NAME_KEY);
      return raw ? nameFromValue(raw, SESSION_USER_NAME_KEY) ?? raw.trim() : null;
    }
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      if (!key || !/user|name|auth/i.test(key)) continue;
      const raw = sessionStorage.getItem(key);
      const name = raw ? nameFromValue(raw, key) : null;
      if (name) return name;
    }
  } catch {
    // Storage can be blocked (privacy mode, sandboxed frame) — fall through.
  }
  return null;
};

export const getSignedInUser = (): { userId: string | null; userName: string } => {
  let userId: string | null = null;
  try {
    userId = localStorage.getItem('sa_logged_in_user_id');
  } catch {
    // Storage blocked — the backend still uses the verified login when present.
  }
  return { userId, userName: readSessionUserName() || userId || 'Anonymous' };
};

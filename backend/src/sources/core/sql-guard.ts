/**
 * Read-only SQL guard.
 *
 * Source agents generate SQL with an LLM and we execute it directly against
 * customer databases. This guard is the last, un-bypassable line of defense:
 * it rejects anything that is not a single read-only statement BEFORE it
 * reaches the driver. It is intentionally strict — the agent flow only ever
 * needs to read.
 *
 * Enforcement is two-fold:
 *   1. The statement must START with a read-only keyword (SELECT / WITH / … ).
 *   2. No data- or schema-mutating keyword may appear anywhere (catches
 *      writable CTEs like `WITH x AS (DELETE … RETURNING …)` and `SELECT … INTO`).
 *   3. Only a single statement is allowed (blocks `SELECT 1; DROP TABLE …`).
 *
 * String literals, quoted identifiers, and comments are stripped before the
 * checks so that a `;` or a keyword hiding inside a string/comment cannot fool
 * (or trip) the guard.
 */

export class ReadOnlySqlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReadOnlySqlError';
  }
}

/**
 * How much a source is permitted to mutate. Sourced ONLY from trusted
 * server-side source config (never from the request/LLM payload).
 *   - 'read' : SELECT/WITH only. Default; what the LLM agent flow uses.
 *   - 'dml'  : + INSERT/UPDATE/DELETE/MERGE (row-level CRUD). Still blocks DDL
 *              (DROP/ALTER/TRUNCATE/CREATE), GRANT/REVOKE, CALL/EXEC, COPY,
 *              transaction control, and multiple statements.
 *   - 'full' : anything, including DDL and multiple statements. Reserved for
 *              trusted migration/admin flows only.
 */
export type WriteMode = 'read' | 'dml' | 'full';

// Statements allowed to appear as the FIRST token, per mode.
const READ_LEADING = /^(SELECT|WITH|EXPLAIN|SHOW|DESCRIBE|DESC|PRAGMA|VALUES|TABLE)\b/i;
const DML_LEADING = /^(SELECT|WITH|EXPLAIN|SHOW|DESCRIBE|DESC|PRAGMA|VALUES|TABLE|INSERT|UPDATE|DELETE|MERGE|REPLACE|UPSERT)\b/i;

// Row-level data-mutating keywords (allowed under 'dml' and 'full').
const DML_KEYWORDS = ['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'UPSERT', 'REPLACE'];

// Schema-mutating / privileged / control keywords. Blocked under 'read' and
// 'dml'; only 'full' permits them. `INTO` is handled separately: it is legal in
// `INSERT INTO` (DML) but marks table-creation in `SELECT … INTO`.
const DDL_KEYWORDS = [
  'DROP', 'CREATE', 'ALTER', 'TRUNCATE', 'RENAME',
  'GRANT', 'REVOKE',
  'CALL', 'EXEC', 'EXECUTE',
  'COPY',
  'ATTACH', 'DETACH',
  'COMMIT', 'ROLLBACK', 'SAVEPOINT',
];

// 'read' forbids every mutating keyword (incl. any INTO — read statements never
// legitimately use it). 'dml' forbids only the DDL set; a `SELECT … INTO`
// table-creation is caught separately in assertSqlAllowed.
// REPLACE is excluded from the blanket list and matched separately with a
// negative lookahead so that the REPLACE(str, from, to) string function is
// permitted while REPLACE INTO (DML) is still blocked.
const READ_DML_NO_REPLACE = DML_KEYWORDS.filter(k => k !== 'REPLACE');
const READ_FORBIDDEN_RE = new RegExp(
  `\\b(${[...READ_DML_NO_REPLACE, ...DDL_KEYWORDS, 'INTO'].join('|')})\\b|\\bREPLACE\\b(?!\\s*\\()`,
  'i'
);
const DML_FORBIDDEN_RE = new RegExp(`\\b(${DDL_KEYWORDS.join('|')})\\b`, 'i');

/**
 * Remove comments, string literals and quoted identifiers so the structural
 * checks operate on SQL keywords/structure only. Removed spans are replaced
 * with a single space to preserve token boundaries.
 */
function stripLiteralsAndComments(sql: string): string {
  let out = '';
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const ch = sql[i];
    const next = sql[i + 1];

    // Line comment: -- … end-of-line
    if (ch === '-' && next === '-') {
      i += 2;
      while (i < n && sql[i] !== '\n') i++;
      out += ' ';
      continue;
    }

    // Block comment: /* … */
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i += 2;
      out += ' ';
      continue;
    }

    // Single-quoted string literal ('' escapes a quote)
    if (ch === "'") {
      i++;
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") { i += 2; continue; }
        if (sql[i] === "'") { i++; break; }
        i++;
      }
      out += ' ';
      continue;
    }

    // Double-quoted identifier ("" escapes a quote)
    if (ch === '"') {
      i++;
      while (i < n) {
        if (sql[i] === '"' && sql[i + 1] === '"') { i += 2; continue; }
        if (sql[i] === '"') { i++; break; }
        i++;
      }
      out += ' ';
      continue;
    }

    // Backtick-quoted identifier (MySQL)
    if (ch === '`') {
      i++;
      while (i < n && sql[i] !== '`') i++;
      i++;
      out += ' ';
      continue;
    }

    out += ch;
    i++;
  }

  return out;
}

/**
 * Returns true if `sql` is a single read-only statement.
 */
export function isReadOnlySql(sql: string): boolean {
  try {
    assertReadOnlySql(sql);
    return true;
  } catch {
    return false;
  }
}

/**
 * Throws {@link ReadOnlySqlError} if `sql` is not a single read-only statement.
 * Thin wrapper over {@link assertSqlAllowed} in 'read' mode — kept for callers
 * that are always read-only regardless of source policy (file/federation).
 * @param sql        The SQL text about to be executed.
 * @param sourceName Optional source label, included in the error message.
 */
export function assertReadOnlySql(sql: string, sourceName?: string): void {
  assertSqlAllowed(sql, 'read', sourceName);
}

/**
 * Throws {@link ReadOnlySqlError} if `sql` exceeds what `mode` permits.
 *
 * The regex/keyword checks are a defense-in-depth backstop against
 * LLM-generated SQL — they are NOT a substitute for scoping the connecting DB
 * role's grants. A write-enabled source should still connect with a role that
 * can only touch what you intend.
 *
 * @param sql        The SQL text about to be executed.
 * @param mode       Source write policy (default 'read').
 * @param sourceName Optional source label, included in the error message.
 */
export function assertSqlAllowed(sql: string, mode: WriteMode = 'read', sourceName?: string): void {
  const label = sourceName ? ` on "${sourceName}"` : '';

  if (typeof sql !== 'string' || sql.trim().length === 0) {
    throw new ReadOnlySqlError(`Empty or invalid SQL${label}.`);
  }

  const stripped = stripLiteralsAndComments(sql).trim();

  if (stripped.length === 0) {
    throw new ReadOnlySqlError(`SQL${label} contains no executable statement.`);
  }

  // 'full' is the trusted-migration escape hatch: allow DDL and multi-statement
  // scripts. Everything else stays single-statement + keyword-gated below.
  if (mode === 'full') {
    return;
  }

  // Single-statement check: after removing a single optional trailing
  // semicolon, no statement separator may remain.
  const withoutTrailing = stripped.replace(/;\s*$/, '');
  if (withoutTrailing.includes(';')) {
    throw new ReadOnlySqlError(
      `Only a single statement is allowed${label}; multiple statements were detected.`
    );
  }

  const leadingRe = mode === 'dml' ? DML_LEADING : READ_LEADING;
  if (!leadingRe.test(withoutTrailing)) {
    const firstWord = withoutTrailing.split(/\s+/)[0] || '(none)';
    const expected = mode === 'dml' ? 'SELECT/WITH/INSERT/UPDATE/DELETE' : 'SELECT/WITH';
    throw new ReadOnlySqlError(
      `Statement not permitted${label}. Starts with "${firstWord}"; expected ${expected}.`
    );
  }

  const forbiddenRe = mode === 'dml' ? DML_FORBIDDEN_RE : READ_FORBIDDEN_RE;
  const forbidden = withoutTrailing.match(forbiddenRe);
  if (forbidden) {
    const kind = mode === 'dml' ? 'DDL/schema' : 'Write/DDL';
    throw new ReadOnlySqlError(
      `${kind} operations are not permitted${label}. Disallowed keyword: "${(forbidden[1] ?? forbidden[0]).toUpperCase()}".`
    );
  }

  // 'dml': a read-leading statement (SELECT/WITH/…) carrying INTO is a
  // table-creating `SELECT … INTO` — block it. `INSERT INTO` leads with INSERT
  // and never matches READ_LEADING, so it is unaffected.
  if (mode === 'dml' && READ_LEADING.test(withoutTrailing) && /\bINTO\b/i.test(withoutTrailing)) {
    throw new ReadOnlySqlError(
      `DDL/schema operations are not permitted${label}. Disallowed keyword: "INTO".`
    );
  }
}

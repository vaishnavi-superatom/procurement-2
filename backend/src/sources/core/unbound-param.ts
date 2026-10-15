/**
 * Detect an unbound script parameter that reached the SQL as text.
 *
 * Generated scripts interpolate params into a SQL string. When a param is
 * missing or badly formatted, what lands in the query is the JS rendering of
 * the value — and the database then reports a problem it does NOT have:
 *
 *   WHERE b.BillingPartyId = undefined        → "Invalid column name 'undefined'"
 *   WHERE ds.DocumentDate >= 'Thu Jan 01'     → "Conversion failed ... from character string"
 *
 * Both messages point at the schema. The fault is the caller's params, so a
 * schema-shaped hint sends the model looking in the wrong place — confirmed
 * twice, with every retry regenerating byte-identical SQL.
 */

/** JS `Date` rendered by toString()/toDateString() instead of toISOString(). */
const JS_DATE_TEXT = /'(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+[A-Z][a-z]{2}\s+\d{1,2}[^']*'/;

/** The WHOLE quoted value is the missing marker — not a word inside real text. */
const QUOTED_MISSING = /'(?:undefined|NaN)'/i;
/** Bare `undefined`/`NaN` as a complete token. `undefined_flag` is a real column. */
const BARE_MISSING = /\b(?:undefined|NaN)\b/;

export function detectUnboundParam(sql: string): string | null {
	if (!sql) return null;

	// Blank string literals before hunting bare tokens, so legitimate prose
	// ("status undefined here") can't be read as a missing parameter.
	const outsideLiterals = sql.replace(/'(?:[^']|'')*'/g, "''");

	if (QUOTED_MISSING.test(sql) || BARE_MISSING.test(outsideLiterals)) {
		return '\n\nFIX: A SCRIPT PARAMETER WAS NOT SUPPLIED — the query contains the literal text "undefined"/"NaN" where a value should be. This is NOT a schema problem: do not look up column names. Either pass every declared parameter when calling execute_script, or give the parameter a default in the script body (e.g. `const limit = params.limit ?? 5`). Check that each name you read from `params` matches a name you declared.';
	}

	if (JS_DATE_TEXT.test(sql)) {
		return '\n\nFIX: A DATE PARAMETER WAS FORMATTED THE WRONG WAY — the query contains a JS Date rendered as text (e.g. \'Thu Jan 01\'), not a SQL date. This is NOT an invalid calendar date and NOT a schema problem. Use `d.toISOString().slice(0, 10)` to get \'YYYY-MM-DD\'; `toDateString()` and `toString()` produce day-name text that MSSQL cannot parse.';
	}

	return null;
}

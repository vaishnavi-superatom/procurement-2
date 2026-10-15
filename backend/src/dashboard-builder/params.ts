/**
 * Parameter validation — where a filter stays a value.
 *
 * The browser names a resolver and passes parameter *values*. This validates
 * them against the resolver's own declared schema **before the resolver runs**,
 * which is the whole reason a filter can never become a fragment of a query,
 * whatever the generated SQL happens to look like.
 *
 * Anything not declared is refused rather than passed through. That is
 * deliberate: a resolver that silently accepts an undeclared parameter is one
 * where the caller and the author disagree about the contract, and the caller
 * always loses that argument at runtime.
 */
import type {
	ParamValue,
	ResolverParams,
	ResolverParamSchema,
	ResolverParamSpec,
	ScalarValue,
} from './contract/types';

export class ParamError extends Error {
	readonly code = 'BAD_PARAMS';
	constructor(
		message: string,
		/** Which parameter, so a caller can point at the right control. */
		readonly param?: string,
	) {
		super(message);
	}
}

/**
 * Coerces one value to its declared type.
 *
 * Coercion is narrow on purpose. A URL and a form both deliver everything as a
 * string, so `'42'` must become `42` — but `'banana'` must not become `NaN`,
 * and `''` must not become `0`. Every conversion here either succeeds exactly
 * or throws.
 */
function coerce(name: string, spec: ResolverParamSpec, raw: unknown): ScalarValue {
	if (raw === null || raw === undefined || raw === '') {
		if (spec.default !== undefined) return spec.default as ScalarValue;
		if (spec.optional) return null;
		throw new ParamError(`"${name}" is required and was not supplied.`, name);
	}

	if (Array.isArray(raw)) {
		throw new ParamError(`"${name}" takes one value, not a list. Declare it as type "list".`, name);
	}

	switch (spec.type) {
		case 'string':
		case 'enum': {
			const v = String(raw);
			if (spec.values && !spec.values.map(String).includes(v)) {
				throw new ParamError(
					`"${name}" must be one of: ${spec.values.join(', ')}. Got "${v}".`,
					name,
				);
			}
			return v;
		}

		case 'number': {
			const v = typeof raw === 'number' ? raw : Number(String(raw).trim());
			if (!Number.isFinite(v)) {
				throw new ParamError(`"${name}" must be a number. Got "${String(raw)}".`, name);
			}
			return v;
		}

		case 'boolean': {
			if (typeof raw === 'boolean') return raw;
			const v = String(raw).toLowerCase();
			if (v === 'true' || v === '1') return true;
			if (v === 'false' || v === '0') return false;
			throw new ParamError(`"${name}" must be true or false. Got "${String(raw)}".`, name);
		}

		case 'date': {
			/**
			 * `YYYY-MM-DD` only, and checked rather than trusted.
			 *
			 * `new Date('2026-02-31')` silently rolls into March, so a shape test
			 * alone is not enough — the round-trip is what catches it.
			 */
			const v = String(raw).trim();
			if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) {
				throw new ParamError(`"${name}" must be a date as YYYY-MM-DD. Got "${v}".`, name);
			}
			const parsed = new Date(`${v}T00:00:00Z`);
			if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== v) {
				throw new ParamError(`"${name}" is not a real date: "${v}".`, name);
			}
			return v;
		}

		default:
			throw new ParamError(`"${name}" has an unknown declared type.`, name);
	}
}

/**
 * Coerces a `list` parameter, item by item.
 *
 * Absent or empty is the empty list — nothing picked, which is a valid filter
 * state rather than a missing value. A string is split on commas, because that
 * is how a list travels in a URL.
 */
function coerceList(name: string, spec: ResolverParamSpec, raw: unknown): readonly ScalarValue[] {
	if (raw === null || raw === undefined || raw === '') {
		return Array.isArray(spec.default) ? spec.default : [];
	}
	const items = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : [raw];
	const item: ResolverParamSpec = { type: spec.items ?? 'string', values: spec.values, optional: true };
	return items
		.filter((v) => v !== null && v !== undefined && String(v).trim() !== '')
		.map((v) => coerce(name, item, typeof v === 'string' ? v.trim() : v));
}

/**
 * Validates a whole call.
 *
 * Returns a fresh object containing exactly the declared parameters — never the
 * caller's object, so nothing undeclared can ride along into the resolver.
 */
export function validateParams(
	schema: ResolverParamSchema | undefined,
	input: Record<string, unknown> = {},
): ResolverParams {
	const declared = schema ?? {};

	const unknown = Object.keys(input).filter((k) => !(k in declared));
	if (unknown.length) {
		const known = Object.keys(declared);
		throw new ParamError(
			`Unknown parameter${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}. ` +
				`This resolver declares: ${known.join(', ') || 'none'}.`,
		);
	}

	const out: ResolverParams = {};
	for (const [name, spec] of Object.entries(declared)) {
		out[name] = spec.type === 'list' ? coerceList(name, spec, input[name]) : coerce(name, spec, input[name]);
	}
	return out;
}

/**
 * Every combination worth testing before wiring a resolver to a panel.
 *
 * The rule the authoring guide states — run it with its defaults *and with each
 * filter value* — only works if something enumerates those values. A filter
 * returning identical numbers for every value is not wired up, however good the
 * SQL looks, and this is what makes that checkable rather than aspirational.
 *
 * Enumerable parameters are the ones with a declared value list. Free-text and
 * numeric parameters fall back to their default, since there is no finite set
 * to walk.
 */
export function enumerateTestCases(
	schema: ResolverParamSchema | undefined,
	limit = 12,
): ResolverParams[] {
	const declared = schema ?? {};
	const entries = Object.entries(declared);
	if (!entries.length) return [{}];

	const axes = entries.map(([name, spec]) => {
		/* A list is tested empty and with each allowed value on its own. */
		const values: ParamValue[] =
			spec.type === 'list'
				? [[], ...(spec.values ?? []).map((v) => [v])]
				: spec.values?.length
					? spec.values.slice()
					: [(spec.default ?? (spec.optional ? null : '')) as ParamValue];
		return { name, values };
	});

	let cases: ResolverParams[] = [{}];
	for (const axis of axes) {
		const next: ResolverParams[] = [];
		for (const base of cases) {
			for (const value of axis.values) {
				next.push({ ...base, [axis.name]: value });
				if (next.length >= limit) break;
			}
			if (next.length >= limit) break;
		}
		cases = next;
	}
	return cases.slice(0, limit);
}

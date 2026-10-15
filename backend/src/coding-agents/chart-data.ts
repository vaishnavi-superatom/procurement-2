/**
 * A chart's rows, described and reshaped in code. The UI agent decides from the
 * profile (facts about ALL rows, not a sample) and may ask for a sort or a top N;
 * code applies those over every row, so no number passes through a model.
 */

export type ColType = 'number' | 'date' | 'text';
export interface Column { key: string; label: string; unit?: string }
type Row = Record<string, unknown>;

const NUMERIC = /^-?\d+(\.\d+)?$/;
// ISO dates and months (2025-04, 2025-04-01, 2025-04-01T00:00:00Z): they also sort as text.
const DATE = /^\d{4}-\d{2}(-\d{2})?([T ][\d:.]+Z?)?$/;

/** Each column's type, and the rows with numeric text turned into numbers. */
export function typed(columns: Column[], rows: Row[]): { types: Record<string, ColType>; rows: Row[] } {
	const types: Record<string, ColType> = {};
	for (const c of columns) {
		const vals = rows.map(r => r[c.key]).filter(v => v !== null && v !== undefined && v !== '');
		types[c.key] = vals.length && vals.every(v => typeof v === 'number' || (typeof v === 'string' && NUMERIC.test(v.trim()))) ? 'number'
			: vals.length && vals.every(v => typeof v === 'string' && DATE.test(v.trim())) ? 'date'
			: 'text';
	}
	const out = rows.map(r => {
		const copy: Row = { ...r };
		for (const c of columns) if (types[c.key] === 'number' && typeof copy[c.key] === 'string') copy[c.key] = Number(copy[c.key]);
		return copy;
	});
	return { types, rows: out };
}

const round = (n: number) => Math.round(n * 100) / 100;

/** Facts about every row, per column: what a chart decision needs, without the rows themselves. */
export function profile(columns: Column[], rows: Row[], types: Record<string, ColType>) {
	return columns.map(c => {
		const vals = rows.map(r => r[c.key]);
		const present = vals.filter(v => v !== null && v !== undefined && v !== '');
		const base = { key: c.key, label: c.label, ...(c.unit ? { unit: c.unit } : {}), type: types[c.key], nulls: vals.length - present.length };
		if (types[c.key] === 'number') {
			const nums = present.map(Number);
			return { ...base, min: round(Math.min(...nums)), max: round(Math.max(...nums)), sum: round(nums.reduce((a, b) => a + b, 0)), negatives: nums.filter(n => n < 0).length };
		}
		const counts = new Map<string, number>();
		for (const v of present) counts.set(String(v), (counts.get(String(v)) ?? 0) + 1);
		if (types[c.key] === 'date') {
			const sorted = [...counts.keys()].sort();
			return { ...base, distinct: counts.size, first: sorted[0], last: sorted[sorted.length - 1] };
		}
		const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([value, n]) => ({ value, rows: n }));
		return { ...base, distinct: counts.size, top };
	});
}

/** What the UI agent may ask code to do to the rows. */
export interface DataOps {
	sort?: { key: string; order?: 'asc' | 'desc' };
	/** Keep the n groups of `group` with the largest total `by`; the rest become one "Others" group, or are dropped. */
	top?: { group: string; by: string; n: number; others?: boolean };
}

export function checkOps(ops: DataOps | undefined, types: Record<string, ColType>): string | null {
	if (!ops) return null;
	if (ops.sort && !(ops.sort.key in types)) return `data.sort.key "${ops.sort.key}" is not a column`;
	if (ops.top) {
		const { group, by, n } = ops.top;
		if (!(group in types)) return `data.top.group "${group}" is not a column`;
		if (types[by] !== 'number') return `data.top.by "${by}" is not a numeric column`;
		if (!Number.isInteger(n) || n < 1 || n > 50) return `data.top.n must be a whole number from 1 to 50`;
	}
	return null;
}

/** The rows the chart draws: top N (with Others) and order applied; a date x-axis runs oldest first. */
export function applyOps(rows: Row[], types: Record<string, ColType>, ops: DataOps | undefined, xKey?: string): Row[] {
	let out = rows;
	if (ops?.top) {
		const { group, by, n, others = true } = ops.top;
		const totals = new Map<string, number>();
		for (const r of out) totals.set(String(r[group]), (totals.get(String(r[group])) ?? 0) + Number(r[by] ?? 0));
		const keep = new Set([...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([g]) => g));
		const kept = out.filter(r => keep.has(String(r[group])));
		const rest = out.filter(r => !keep.has(String(r[group])));
		if (others && rest.length) {
			// The rest summed per remaining dimension, so "Others" lines up with the kept groups.
			const dims = Object.keys(types).filter(k => k !== group && types[k] !== 'number');
			const measures = Object.keys(types).filter(k => types[k] === 'number');
			const merged = new Map<string, Row>();
			for (const r of rest) {
				const id = dims.map(d => String(r[d])).join('\u0000');
				const m = merged.get(id) ?? { ...Object.fromEntries(dims.map(d => [d, r[d]])), [group]: 'Others', ...Object.fromEntries(measures.map(k => [k, 0])) };
				for (const k of measures) m[k] = Number(m[k]) + Number(r[k] ?? 0);
				merged.set(id, m);
			}
			out = [...kept, ...merged.values()];
		} else {
			out = kept;
		}
	}
	const sort = ops?.sort ?? (xKey && types[xKey] === 'date' ? { key: xKey, order: 'asc' as const } : undefined);
	if (sort) {
		const dir = sort.order === 'desc' ? -1 : 1;
		const num = types[sort.key] === 'number';
		out = [...out].sort((a, b) => {
			const x = a[sort.key], y = b[sort.key];
			return dir * (num ? Number(x) - Number(y) : String(x).localeCompare(String(y)));
		});
	}
	return out;
}

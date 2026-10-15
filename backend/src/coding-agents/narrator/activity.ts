import type { AgentEvent } from '@superatomai/sdk-node';
import { getQueryRef } from '../../services/script-bridge';

/**
 * What the narrator is shown: the coding agent's events, turned into activity
 * items, and those items as prompt text.
 *
 * **It sees what the agent sees.** Every command with its real output, every
 * query with its SQL and the rows that came back, the agent's notes, reasoning
 * and plan. It is TOLD not to repeat SQL or identifiers to the person — seeing
 * them is what lets it say accurately what is happening. The only thing applied
 * on the way in is a size cap, so one call stays cheap.
 *
 * Pure functions, apart from the bridge lookup that pairs a query with its SQL.
 */

// Size caps — the same order as the chat transcript's (answer-provider.ts), so
// the narrator reads roughly what the person could have read there.
const TEXT_CAP = 2000;
export const CMD_CAP = 2000;
const OUTPUT_CAP = 6000;
const SQL_CAP = 3000;
/** Rows per query result handed over; the agent itself sees up to 200. */
const ROW_CAP = 20;
const CELL_CAP = 200;
/** One call's whole activity, rendered. Oldest items are dropped past this. */
const BATCH_CAP = 20_000;

/** One query the agent ran, paired with its own result. */
export interface QueryActivity {
	/** The bridge's handle (q1, q2…) — what pairs this SQL with this result. */
	ref?: string;
	sql: string;
	failed?: boolean;
	/** The real total, not the number handed over. */
	count?: number;
	returned?: number;
	truncated?: boolean;
	columns?: string[];
	rows?: Record<string, unknown>[];
	/** Why it failed, when it did. */
	error?: string;
}

/** One thing the agent did or said, as the narrator was given it. */
export type ActivityItem =
	| { kind: 'note'; text: string }
	| { kind: 'thinking'; text: string }
	| { kind: 'plan'; text: string }
	| { kind: 'command'; command: string; status: 'completed' | 'failed'; output?: string; queries?: QueryActivity[] }
	| { kind: 'tool'; name: string; args?: unknown; status?: string }
	| { kind: 'error'; text: string }
	/** Nothing new: what is still running and for how long — a command, or (none) the agent thinking. */
	| { kind: 'waiting'; command?: string; forSeconds: number };

export function clip(text: string, max: number): string {
	const t = String(text ?? '').trim();
	return t.length > max ? `${t.slice(0, max)}\n… ${(t.length - max).toLocaleString('en-IN')} more characters` : t;
}

const QUERY_CALL_RE = /(?:\.\/|tools\/)query\s+/;

/** Does this command run a data query? */
export function isQueryCommand(cmd: string): boolean {
	return QUERY_CALL_RE.test(cmd);
}

/** Every SQL in a command, in order — the agent chains `query … && query …`. */
function sqlsFromCommand(cmd: string): string[] {
	const unescaped = cmd.replace(/\\"/g, '"');
	const out: string[] = [];
	for (const part of unescaped.split(/(?:\.\/|tools\/)query\s+/).slice(1)) {
		// "<source>" "<sql>" — the SQL is single-quoted inside, so the next bare
		// double quote closes the argument.
		const sql = part.match(/^"[^"]+"\s+"([^"]*)"/)?.[1]?.trim();
		if (sql) out.push(sql);
	}
	return out;
}

/** The JSON objects a command printed, back to back, string-aware. */
function jsonObjects(text: string): Array<{ at: number; value: any }> {
	const out: Array<{ at: number; value: any }> = [];
	let depth = 0, start = -1, inString = false, escaped = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === '\\') escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') { inString = true; continue; }
		if (ch === '{') { if (depth === 0) start = i; depth++; }
		else if (ch === '}' && depth > 0) {
			depth--;
			if (depth === 0 && start !== -1) {
				try { out.push({ at: start, value: JSON.parse(text.slice(start, i + 1)) }); } catch { /* not JSON */ }
				start = -1;
			}
		}
	}
	return out;
}

function sampleRows(rows: unknown[]): Record<string, unknown>[] {
	return rows.slice(0, ROW_CAP).map((row) => {
		if (!row || typeof row !== 'object') return { value: row };
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(row)) {
			out[k] = typeof v === 'string' && v.length > CELL_CAP ? `${v.slice(0, CELL_CAP)}…` : v;
		}
		return out;
	});
}

/**
 * Pair each query in a command with its own result.
 *
 * A result that carries a `ref` is exact: the bridge recorded the SQL it ran
 * under that ref, so the SQL is looked up rather than inferred. Only a result
 * with no ref — a query refused before it ran — falls back to its position in
 * the command, which is the order bash ran them in.
 */
function pairQueries(cmd: string, output: string, contextToken: string | undefined): QueryActivity[] {
	const sqls = sqlsFromCommand(cmd);
	const results = jsonObjects(output).filter((o) => o.value && Array.isArray(o.value.rows));
	const paired: QueryActivity[] = [];

	results.forEach((r, i) => {
		const v = r.value;
		const recorded = v.ref ? getQueryRef(contextToken, v.ref) : undefined;
		const rows: unknown[] = v.rows;
		paired.push({
			...(v.ref ? { ref: v.ref } : {}),
			sql: clip(recorded?.sql ?? sqls[i] ?? '(not recovered)', SQL_CAP),
			count: typeof v.count === 'number' ? v.count : rows.length,
			returned: typeof v.returned === 'number' ? v.returned : rows.length,
			truncated: !!v.truncated,
			columns: rows.length && rows[0] && typeof rows[0] === 'object' ? Object.keys(rows[0] as object) : [],
			rows: sampleRows(rows),
		});
	});

	// Queries that printed no result: refused or failed before running. Their
	// SQL is known from the command; the output says why.
	for (let i = results.length; i < sqls.length; i++) {
		paired.push({ sql: clip(sqls[i], SQL_CAP), failed: true, error: clip(output, 1000) || 'no result printed' });
	}
	return paired;
}

/**
 * One FINISHED agent event as an activity item, or null when it carries nothing
 * to narrate. A command's start is not handled here: the caller only remembers
 * it, so a long query can be waited on.
 */
export function toActivity(ev: AgentEvent, contextToken: string | undefined): ActivityItem | null {
	const text = String(ev.text ?? '').trim();
	switch (ev.kind) {
		case 'command': {
			const cmd = String(ev.command ?? '');
			const output = String(ev.output ?? '');
			const status = ev.status === 'failed' ? 'failed' : 'completed';
			return isQueryCommand(cmd)
				? { kind: 'command', command: clip(cmd, CMD_CAP), status, queries: pairQueries(cmd, output, contextToken) }
				: { kind: 'command', command: clip(cmd, CMD_CAP), status, ...(output.trim() ? { output: clip(output, OUTPUT_CAP) } : {}) };
		}
		case 'message':
			return text ? { kind: 'note', text: clip(text, TEXT_CAP) } : null;
		case 'reasoning':
			return text ? { kind: 'thinking', text: clip(text, TEXT_CAP) } : null;
		case 'todo':
			return text ? { kind: 'plan', text: clip(text, TEXT_CAP) } : null;
		case 'tool':
			return { kind: 'tool', name: ev.tool?.name ?? 'tool', ...(ev.tool?.args !== undefined ? { args: ev.tool.args } : {}), ...(ev.status ? { status: ev.status } : {}) };
		case 'error':
			return text ? { kind: 'error', text: clip(text, TEXT_CAP) } : null;
		// File writes are internal implementation details. They may be
		// intermediate work rather than the final answer, so do not narrate them
		// or imply that the answer is ready.
		case 'file':
		default:
			return null;
	}
}

/** One activity item, as the narrator reads it. */
export function render(item: ActivityItem): string {
	switch (item.kind) {
		case 'note': return `Note:\n${item.text}`;
		case 'thinking': return `Reasoning:\n${item.text}`;
		case 'plan': return `Plan:\n${item.text}`;
		case 'error': return `Error:\n${item.text}`;
		case 'tool': return `Called ${item.name}${item.args ? ` with ${clip(JSON.stringify(item.args), CMD_CAP)}` : ''}`;
		case 'waiting': return item.command
			? `Still running after ${item.forSeconds}s:\n$ ${item.command}`
			: `No command running; the agent has been thinking for ${item.forSeconds}s since its last step.`;
		case 'command': {
			if (item.queries?.length) {
				return item.queries.map((q) => {
					const head = `Query${q.ref ? ` ${q.ref}` : ''}${q.failed ? ' (FAILED)' : ''}:\n${q.sql}`;
					if (q.failed) return `${head}\nError: ${q.error}`;
					const of = q.truncated ? ` (first ${q.returned} returned)` : '';
					return `${head}\nResult: ${q.count} row(s)${of}; columns: ${(q.columns ?? []).join(', ') || '(none)'}\n` +
						`Rows: ${JSON.stringify(q.rows ?? [])}`;
				}).join('\n\n');
			}
			return `Ran a command (${item.status}):\n$ ${item.command}\n` +
				(item.output ? `Output:\n${item.output}` : 'Output: (none)');
		}
	}
}

/** Newest first until the cap, then back in order — a call favours what just happened. */
export function withinCap(items: ActivityItem[]): { kept: ActivityItem[]; omitted: number } {
	const kept: ActivityItem[] = [];
	let size = 0;
	for (let i = items.length - 1; i >= 0; i--) {
		const n = render(items[i]).length;
		if (kept.length && size + n > BATCH_CAP) return { kept: kept.reverse(), omitted: i + 1 };
		kept.push(items[i]);
		size += n;
	}
	return { kept: kept.reverse(), omitted: 0 };
}

/**
 * What one run looked up through the agent tools, keyed by its context token.
 * Recorded where the request arrives, so it holds the exact names on any OS or
 * harness; the answer provider reads it once the run ends to report what the
 * routed domain lacked.
 */
export interface RunUsage {
	/** Concepts whose bodies were fetched (canonical names). */
	concepts: string[];
	/** Concept searches and names that matched nothing. */
	conceptMisses: string[];
	/** Tables looked up through the schema tools. */
	tables: string[];
	/** Every query as the database received it, with its error when it failed. */
	queries: Array<{ sql: string; error?: string }>;
}

const TTL_MS = 30 * 60 * 1000; // outlives the longest run; a sweep, not a contract
const runs = new Map<string, RunUsage & { at: number }>();

function runFor(token: string): RunUsage & { at: number } {
	const now = Date.now();
	for (const [k, v] of runs) if (now - v.at > TTL_MS) runs.delete(k);
	let run = runs.get(token);
	if (!run) { run = { concepts: [], conceptMisses: [], tables: [], queries: [], at: now }; runs.set(token, run); }
	return run;
}

export function noteUsage(token: string | undefined, kind: 'concepts' | 'conceptMisses' | 'tables', values: string[]): void {
	if (!token || !values.length) return;
	const run = runFor(token);
	for (const v of values) if (v && !run[kind].includes(v)) run[kind].push(v);
}

export function noteQuery(token: string | undefined, sql: string, error?: string): void {
	if (!token || !sql.trim()) return;
	runFor(token).queries.push({ sql, ...(error ? { error } : {}) });
}

/** The run's usage, removed once read. */
export function takeUsage(token: string | undefined): RunUsage {
	const run = token ? runs.get(token) : undefined;
	if (token) runs.delete(token);
	return { concepts: run?.concepts ?? [], conceptMisses: run?.conceptMisses ?? [], tables: run?.tables ?? [], queries: run?.queries ?? [] };
}

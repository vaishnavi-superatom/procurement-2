/**
 * What an embedded pi agent did during one turn, kept for the debug trace.
 *
 * Every tool call with what it returned, grouped by the tool that made it:
 * `concept-catalog`, `query`, `run-resolver`, `files` for pi's own read/write/
 * edit. The result is the text the model was handed, so the trace answers the
 * question a trace exists for — what did the agent actually see.
 *
 * Capped at both ends. A turn that loops on a failing command would otherwise
 * write thousands of near-identical entries, and one query's rows would make a
 * single entry larger than the rest of the trace together.
 */
const MAX_CALLS_PER_TOOL = 50;
const MAX_ARG_CHARS = 2000;
const MAX_RESULT_CHARS = 20_000;

export interface TraceCall {
	at: string;
	call: string;
	/** What the tool returned, as the model received it. */
	result?: string;
	failed?: true;
}

export interface ToolTrace {
	/** Tool name → the calls it received, in order. */
	[tool: string]: TraceCall[];
}

interface Run {
	trace: ToolTrace;
	/** Open calls by pi's call id, so a result lands on the call that made it. */
	pending: Map<string, TraceCall>;
}

const runs = new Map<string, Run>();

/** The tool a call belongs to: a shim's own name, or what pi calls its file tools. */
function toolOf(toolName: string, args: unknown): { tool: string; call: string } {
	const input = (args ?? {}) as { command?: unknown; path?: unknown };

	if (toolName !== 'bash') {
		const path = typeof input.path === 'string' ? input.path : '';
		return {
			tool: toolName === 'read' || toolName === 'write' || toolName === 'edit' ? 'files' : toolName,
			call: path || toolName,
		};
	}

	const command = String(input.command ?? '').replace(/\s+/g, ' ').trim();
	const shim = command.match(/^\.\/([\w-]+)/);
	return { tool: shim ? shim[1]! : 'bash', call: command };
}

/** A tool result as text, however pi wrapped it. */
function resultText(result: unknown): string {
	if (result == null) return '';
	if (typeof result === 'string') return result;
	const shaped = result as { output?: unknown; content?: unknown; text?: unknown };
	for (const value of [shaped.output, shaped.content, shaped.text]) {
		if (typeof value === 'string') return value;
	}
	try {
		return JSON.stringify(result);
	} catch {
		return String(result);
	}
}

const cap = (text: string, limit: number): string =>
	text.length > limit ? `${text.slice(0, limit)}\n… cut, ${text.length - limit} more characters` : text;

/** Starts a fresh trace for one turn, dropping whatever the previous one left. */
export function startTrace(key: string): void {
	runs.set(key, { trace: {}, pending: new Map() });
}

/** Records one tool call, if a turn is being traced. */
export function recordToolCall(key: string, callId: string, toolName: string, args: unknown): void {
	const run = runs.get(key);
	if (!run) return;
	const { tool, call } = toolOf(toolName, args);
	const calls = (run.trace[tool] ??= []);
	if (calls.length >= MAX_CALLS_PER_TOOL) return;
	const entry: TraceCall = { at: new Date().toISOString(), call: cap(call, MAX_ARG_CHARS) };
	calls.push(entry);
	if (callId) run.pending.set(callId, entry);
}

/** Attaches what a call returned to the call itself. */
export function recordToolResult(key: string, callId: string, result: unknown, failed: boolean): void {
	const run = runs.get(key);
	const entry = run?.pending.get(callId);
	if (!run || !entry) return;
	run.pending.delete(callId);
	const text = resultText(result);
	if (text) entry.result = cap(text, MAX_RESULT_CHARS);
	if (failed) entry.failed = true;
}

/**
 * Our trace in the shape the SDK's conversation saver reads.
 *
 * That saver calls `hasTraceContent(trace)`, which walks `trace.kbNodes.global`,
 * `trace.schemaNodes.*` and `trace.entityResolution.*` with no optional chaining
 * — it is written for the built-in flow's `RunTrace`. Handing it a bare
 * `ToolTrace` throws inside the save, and because that throw is caught above the
 * row that was already written, the turn silently loses its trace, its
 * embedding, and the conversation id its analytics event needed.
 *
 * So the calls travel as `directTools.calls`, which is what they are, and every
 * section that check dereferences is present and empty.
 */
export function asRunTrace(trace: ToolTrace | undefined): Record<string, unknown> | undefined {
	if (!trace || !Object.keys(trace).length) return undefined;

	const calls = Object.entries(trace).flatMap(([tool, entries]) =>
		entries.map((entry) => ({
			toolId: tool,
			input: { call: entry.call, at: entry.at },
			...(entry.result === undefined ? {} : { output: entry.result }),
			...(entry.failed ? { error: 'the call failed' } : {}),
		})),
	);
	if (!calls.length) return undefined;

	return {
		version: 1,
		kbNodes: { global: [], query: [] },
		schemaNodes: { routing: [], preResolve: [], sourceAgentSchemas: [] },
		entityResolution: { calls: [] },
		directTools: { calls },
	};
}

/**
 * Both halves of a turn as one trace.
 *
 * A component the agent has to fix is a second prompt inside the same turn, and
 * the calls it makes belong to the same conversation row. Kept in order, the
 * repair's calls after the first attempt's.
 */
export function mergeTraces(...traces: (ToolTrace | undefined)[]): ToolTrace | undefined {
	const merged: ToolTrace = {};
	for (const trace of traces) {
		for (const [tool, calls] of Object.entries(trace ?? {})) {
			(merged[tool] ??= []).push(...calls);
		}
	}
	return Object.keys(merged).length ? merged : undefined;
}

/** The trace for a finished turn, or undefined when nothing was recorded. */
export function takeTrace(key: string): ToolTrace | undefined {
	const run = runs.get(key);
	runs.delete(key);
	return run && Object.keys(run.trace).length ? run.trace : undefined;
}

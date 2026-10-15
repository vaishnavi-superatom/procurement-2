import {
	runCodingAgent, mintContextToken, revokeContextToken,
	type AnswerProvider, type AnswerProviderContext, type T_RESPONSE,
} from '@superatomai/sdk-node';
import * as fs from 'fs';
import * as path from 'path';
import { releaseQueryRefs } from '../services/script-bridge';
import { formatSql } from './format-sql';
import { startNarrator, type NarrationUpdate } from './narrator';
import { assembleAnswerFile } from './answer-file';
import type { RouteInfo } from './answer-agent';
import { domainStep, findGaps, gapsStep } from './route-report';
import { startChartPrefetch } from './chart-prefetch';
import { setThreadConfig, getThreadAttachments } from '../../../database/postgres/src/project-data-db/user-conversations';
import { ATTACHMENT_LOAD_ERROR, MAX_THREAD_ATTACHMENTS } from './attachments';
import { takeUsage } from '../services/run-usage';
import { saveRouteGaps } from '../../../database/postgres/src/project-data-db/graph';

/** Deployment's number locale, for the row counts printed in the transcript. */
const LOCALE = process.env.SA_LOCALE || undefined;

/**
 * Answer a user question with the `answer-agent` coding agent instead of
 * MainAgent + SourceAgent. Registered as the SDK's answerProvider; see
 * SA_ANSWER_FLOW in sa.ts for the switch.
 *
 * Why a provider rather than an edit inside the SDK: the agent, its prompt and
 * the assembly are all deployment-specific, while the transport is not. The SDK
 * only needs to know that something else answers.
 */
/**
 * Recover the SQL from a `tools/query "<source>" "<sql>"` invocation.
 *
 * Returns EVERY query in the command, because the agent chains them; a single
 * greedy match swallowed the operator and both statements. A fragment that does
 * not parse as a statement is DROPPED rather than guessed.
 */
export function sqlsFromCommand(cmd: string): string[] {
	const unescaped = cmd.replace(/\\"/g, '"');
	// The invocation, not a mention of it: an `rg` pattern containing the text
	// "tools/query" was labelled as a query and its grep pattern printed as SQL.
	const out: string[] = [];
	// Windows: the SQL is a PowerShell here-string piped INTO the tool, so it
	// comes before the call: @' <newline> SQL <newline> '@ | tools/query "<source>" -
	for (const m of unescaped.matchAll(/@'\r?\n([\s\S]*?)\r?\n'@\s*\|\s*(?:\.[\/\\])?tools[\/\\]query\b/g)) {
		const sql = m[1].trim();
		if (/^\s*(select|with)\b/i.test(sql)) out.push(sql);
	}
	if (!/(?:\.\/|tools\/)query\s+"/.test(unescaped)) return out;
	// Split on the invocations themselves, so each fragment holds exactly one
	// call's arguments and nothing from the next.
	// Both spellings: the shared tool is tools/query, and ./query is the older
	// per-workspace shim that some live threads may still be calling.
	for (const part of unescaped.split(/(?:\.\/|tools\/)query\s+/).slice(1)) {
		// Either the SQL argument, or `- <<'TAG'` with the SQL on stdin up to TAG.
		const heredoc = part.match(/^"[^"]+"\s+-[^\n]*?<<-?\s*'?(\w+)'?[^\n]*\n([\s\S]*?)\n\s*\1\b/);
		const sql = (part.match(/^"[^"]+"\s+"([^"]*)"/)?.[1] ?? heredoc?.[2])?.trim();
		if (sql && /^\s*(select|with)\b/i.test(sql)) out.push(sql);
	}
	return out;
}

/**
 * Agent events → one `<Step>` per event, rendered by the chat as a collapsed row.
 *
 * NOTHING IS DROPPED. This stream is how someone answers "what did the agent
 * actually do, and how did it reach that number", so every event the harness
 * reports appears: its messages, its reasoning, every command with its full
 * output, tool calls, file writes, todos, errors. The UI collapses them; we do
 * not summarise them. The earlier version printed only the first eight lines of
 * each output and skipped messages entirely, which made the trail unauditable.
 *
 * A step carries a headline (icon, label, a badge saying how it came out) so the
 * timeline reads at a glance, and the evidence sits inside, one click away.
 *
 * Printed on `done` only: the driver re-emits a GROWING `text` for a streaming
 * item, so printing every event would repeat each line once per delta. The one
 * exception is a query command, which opens the live timer pill when it starts.
 */
const FENCE = '```';
/** Generous, and only to keep one runaway output from bloating the saved row. */
const BODY_CAP = 40_000;

function fence(body: string, lang = ''): string {
	// A fence inside the body would close ours early and spill the rest as prose.
	return `${FENCE}${lang}\n${body.split(FENCE).join("'''")}\n${FENCE}\n\n`;
}

function cap(text: string): string {
	return text.length <= BODY_CAP
		? text
		: `${text.slice(0, BODY_CAP)}\n… +${(text.length - BODY_CAP).toLocaleString(LOCALE)} characters not shown`;
}

/** Attribute-safe: the label and badge sit in a quoted HTML attribute. */
function attr(v: string): string {
	return v.replace(/[<>"&\n]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
}

/** Seconds with one decimal, as the step attributes carry them. */
const secs = (ms: number) => (Math.max(0, ms) / 1000).toFixed(1);

/**
 * `model` = the model's time before this step (reading the last result, deciding
 * and writing this one); `run` = the step's own execution; `at` = when it ended,
 * from the start of the question. The model's share is most of every answer and
 * was invisible: the trail summed only execution, a few seconds out of a minute.
 */
interface StepTiming { model?: number; run?: number; at?: number }

function step(o: { icon: string; label: string; badge?: string; status?: string; body?: string } & StepTiming): string {
	const open = `<Step icon="${attr(o.icon)}" label="${attr(o.label)}"` +
		(o.badge ? ` badge="${attr(o.badge)}"` : '') +
		(o.status ? ` status="${attr(o.status)}"` : '') +
		(o.model !== undefined ? ` model="${secs(o.model)}"` : '') +
		(o.run !== undefined ? ` run="${secs(o.run)}"` : '') +
		(o.at !== undefined ? ` at="${secs(o.at)}"` : '') + '>';
	return `${open}\n\n${o.body ?? ''}\n\n</Step>\n\n`;
}

/**
 * What the agent ran, as the tools rather than the shell around them. Codex
 * wraps everything in `/bin/bash -lc '…'` and chains several tools per command,
 * so the headline is the list of invocations.
 */
function commandLabel(cmd: string): { label: string; icon: string; inner: string } {
	// Linux wraps commands in `/bin/bash -lc '…'`, Windows in `"…powershell.exe" -Command "…"`.
	const inner = cmd.replace(/^\/bin\/bash\s+-lc\s+/, '').replace(/^"?[^"\s]*powershell(?:\.exe)?"?\s+-Command\s+/i, '')
		.replace(/^['"]|['"]$/g, '');
	const tools = [...new Set([...inner.matchAll(/(?:^|[\s&|;(])(?:(?:\.[\/\\])?tools[\/\\]|\.\/)([a-z-]+)/g)].map(m => m[1]))];
	if (tools.length) {
		const icon = tools.includes('query') ? 'query'
			: tools.some(t => t.endsWith('concept')) ? 'concept'
			: tools.some(t => t.endsWith('entity')) ? 'entity'
			: tools.some(t => t.endsWith('schema')) ? 'schema' : 'tool';
		// The ARGUMENTS are what make a row readable: "find-concept" says nothing,
		// "find-concept booking, freight revenue" says what was looked up. Quoted
		// arguments only — flags and SQL would swamp the line.
		const args = [...new Set([...inner.matchAll(/"([^"]{2,60})"/g)].map(m => m[1].replace(/\\/g, '').trim())
			// A shell or grep fragment is not an argument worth naming.
			.filter(a => a && !/^\s*(select|with)\b/i.test(a) && !a.includes('_query')
				&& !/[|*!$]/.test(a) && !a.startsWith('-')))];
		const shown = args.slice(0, 4).join(', ');
		return { label: shown ? `${tools.join(' · ')} — ${shown}${args.length > 4 ? ` +${args.length - 4}` : ''}` : tools.join(' · '), icon, inner };
	}
	const progs = [...new Set(inner.split(/&&|\|\||;|\|/).map(s => s.trim().split(/\s+/)[0]).filter(Boolean))];
	return { label: progs.slice(0, 3).join(' · ') || 'command', icon: 'shell', inner };
}

/** First words of a block of prose — enough to recognise the step by. */
function gist(text: string, max = 90): string {
	const one = text.replace(/\s+/g, ' ').trim();
	return one.length > max ? `${one.slice(0, max)}…` : one;
}

/** Full detail that repeats what a step already shows structurally. */
function collapsed(summary: string, body: string): string {
	return `<details>\n<summary>${summary}</summary>\n\n${body}\n</details>\n\n`;
}

/** The `{ ref, count, returned, rows }` objects the query tool prints, in order. */
function queryResults(output: string): Array<{ ref?: string; count?: number; returned?: number; rows?: any[]; warning?: string }> {
	const out: any[] = [];
	let depth = 0, start = -1, inString = false, escaped = false;
	for (let i = 0; i < output.length; i++) {
		const ch = output[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === '\\') escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') { inString = true; continue; }
		if (ch === '{') { if (depth === 0) start = i; depth++; }
		else if (ch === '}' && depth > 0 && --depth === 0 && start !== -1) {
			try {
				const v = JSON.parse(output.slice(start, i + 1));
				if (v && Array.isArray(v.rows)) out.push(v);
			} catch { /* not a result object */ }
			start = -1;
		}
	}
	return out;
}

export function makeTranscript(onStream: (chunk: string) => void) {
	const printed = new Set<string>();
	const running = new Map<string, number>();
	// The first step's model time therefore includes routing and agent start-up.
	const startedAt = Date.now();
	let lastDone = startedAt;
	/** Model time since the previous step ended, then this step's end becomes the mark. */
	const timing = (runStart?: number): StepTiming => {
		const now = Date.now();
		// Parallel commands start before the previous one ends: no model time between them.
		const t: StepTiming = runStart === undefined
			? { model: now - lastDone, at: now - startedAt }
			: { model: Math.max(0, runStart - lastDone), run: now - runStart, at: now - startedAt };
		lastDone = Math.max(lastDone, now);
		return t;
	};
	return (event: any) => {
		if (!event) return;
		const cmd = String(event.command ?? '').trim();

		// Every command is timed, but nothing is emitted yet: a separate timer pill
		// per query piled up detached from the step it belonged to, and one whose
		// DONE marker never arrived ticked on forever (seen live at 450s). The
		// duration belongs on the step's own row.
		if (event.kind === 'command' && event.status === 'in_progress') {
			if (!running.has(event.id)) running.set(event.id, Date.now());
			return;
		}
		if (event.done !== true) return;
		const key = `${event.kind}:${event.id ?? ''}`;
		if (printed.has(key)) return;
		printed.add(key);

		const text = String(event.text ?? '').trim();
		switch (event.kind) {
			// Kept, unlike before: the closing message IS the answer and is also
			// rendered as the answer component, but dropping it here left a hole in
			// the record of what the agent said and when.
			case 'message':
				onStream(step({ icon: 'message', label: gist(text), badge: `${text.length.toLocaleString(LOCALE)} chars`, body: cap(text), ...timing() }));
				return;
			case 'reasoning':
				onStream(step({ icon: 'thinking', label: gist(text), body: cap(text), ...timing() }));
				return;
			case 'command': {
				const out = String(event.output ?? '').trim();
				const { label: rawLabel, icon, inner } = commandLabel(cmd);
				const t0 = running.get(event.id);
				running.delete(event.id);
				// No in_progress seen: the command's whole span counts as its run.
				const time = timing(t0 ?? lastDone);
				const sqls = sqlsFromCommand(cmd);
				const results = queryResults(out);
				// A query's own label comes from the SQL: which tables it read. Its
				// quoted arguments are the source id and the statement itself, neither
				// of which fits on a row.
				const tables = [...new Set(sqls.flatMap(q => [...q.matchAll(/\b(?:from|join)\s+(?:dbo\.)?([a-z_][\w.]*)/gi)].map(m => m[1])))];
				const label = sqls.length
					? `query — ${tables.slice(0, 3).join(', ')}${tables.length > 3 ? ` +${tables.length - 3}` : ''}`
					: rawLabel;
				// SQL replaces the shell line it was quoted inside — the escaped
				// one-liner is unreadable and says nothing the formatted SQL doesn't.
				const body = [
					sqls.length ? '' : fence(inner, 'bash'),
					...sqls.map(sql => fence(formatSql(sql), 'sql')),
					...results.map(r => {
						const n = r.returned ?? r.rows?.length ?? 0;
						const of = typeof r.count === 'number' && r.count > n ? ` of ${r.count.toLocaleString(LOCALE)}` : '';
						return `**${n.toLocaleString(LOCALE)}${of} row${n === 1 ? '' : 's'}${r.ref ? ` · \`${r.ref}\`` : ''}**\n\n` +
							(r.rows?.length ? `<DataTable>${JSON.stringify(r.rows)}</DataTable>\n\n` : '') +
							(r.warning ? `⚠️ ${r.warning}\n\n` : '');
					}),
					// Nothing is lost: the raw output is kept verbatim, one level deeper,
					// because printing it beside a table of the same rows was the single
					// biggest source of noise in this view.
					!out ? ''
						: results.length ? collapsed('raw output', fence(cap(out)))
						: fence(cap(out)),
				].join('');
				const badge = (results.length
					? results.map(r => `${(r.returned ?? r.rows?.length ?? 0).toLocaleString(LOCALE)} rows`).join(' · ')
					: `${out ? out.split('\n').length.toLocaleString(LOCALE) : 0} lines`);
				onStream(step({ icon, label, badge, status: event.status === 'failed' ? 'failed' : 'ok', body, ...time }));
				return;
			}
			case 'tool':
				onStream(step({ icon: 'tool', label: event.tool?.name ?? 'tool', status: event.status === 'failed' ? 'failed' : 'ok',
					body: fence(JSON.stringify(event.tool?.args ?? {}, null, 2), 'json'), ...timing() }));
				return;
			case 'file':
				onStream(step({ icon: 'file', label: 'Wrote files', body: cap(text), ...timing() }));
				return;
			case 'todo':
				onStream(step({ icon: 'todo', label: 'Plan', body: cap(text), ...timing() }));
				return;
			case 'error':
				onStream(step({ icon: 'error', label: 'Error', status: 'failed', body: cap(text), ...timing() }));
				return;
			default:
				// An event kind we do not know about is still shown — losing it would
				// make the trail lie by omission.
				onStream(step({ icon: 'tool', label: String(event.kind ?? 'event'), body: cap(text || JSON.stringify(event)), ...timing() }));
		}
	};
}

/**
 * The answer, as the one component this flow renders.
 *
 * `DynamicMarkdownBlock` takes a markdown string and nothing else — no dataset,
 * no config, no column names — so there is nothing for the agent to get wrong
 * and no catalog in its workspace. WE build it from its closing message.
 *
 * Built from the live catalog entry when the frontend has pushed one, so the
 * displayName/type/description match what that client registered; the literal
 * fallback keeps the answer rendering on a client that has not registered it and
 * in headless runs, where no catalog arrives at all.
 */
const ANSWER_COMPONENT = 'DynamicMarkdownBlock';

function answerComponent(text: string, catalog: any[] | undefined): any {
	const template = (catalog ?? []).find((c) => c?.name === ANSWER_COMPONENT);
	return {
		id: `answer_${Date.now()}`,
		name: ANSWER_COMPONENT,
		type: template?.type ?? 'MarkdownBlock',
		displayName: template?.displayName,
		description: template?.description ?? 'Answer',
		category: template?.category,
		keywords: template?.keywords,
		props: { content: text },
	};
}

/**
 * Why a run produced nothing, in words the person who asked can act on.
 *
 * Everything used to come back as "please try again, and rephrase if it
 * recurs", which blames the question. The most likely cause in production is
 * not the question at all: this deployment authenticates codex with ONE
 * account, so when its usage limit is reached every user hits it at once, and
 * rephrasing cannot help. Naming the cause is also what tells whoever is on
 * call whether to look at the quota, the credentials or the data.
 */
export function explainFailure(error: string | undefined): string {
	// An attached file that could not be loaded already names the file and why.
	const loadError = error?.indexOf(ATTACHMENT_LOAD_ERROR) ?? -1;
	if (loadError >= 0) return error!.slice(loadError);

	const e = (error ?? '').toLowerCase();
	const asked = 'Your question was not answered.';

	if (/usage limit|rate limit|quota|too many requests|\b429\b/.test(e)) {
		// codex prints the reset as "try again at 1:00 PM" / "try again in 12 minutes".
		const when = (error ?? '').match(/try again (?:at|in|after) ([^.\n"]{1,40})/i)?.[1]?.trim();
		return `The AI service limit for this workspace has been reached${when ? `, and resets ${/^\d/.test(when) ? 'at ' : ''}${when}` : ''}. ` +
			`${asked} This is a shared limit, so rephrasing will not help — please try again later.`;
	}
	if (/unauthorized|401|403|not authenticated|login|credential|api key/.test(e)) {
		return `The AI service rejected this deployment's credentials, so ${asked.toLowerCase()} ` +
			`This needs an administrator — it is not something rephrasing will fix.`;
	}
	if (/timed out|timeout|etimedout/.test(e)) {
		return `This question took longer than the time allowed and was stopped. ${asked} ` +
			`A narrower question — a shorter period, one branch, fewer things at once — usually completes.`;
	}
	if (/aborted/.test(e)) return `This question was stopped before it finished.`;

	return `I could not complete that answer. Nothing was returned, so there is no partial ` +
		`result to show — please try again, and rephrase if it recurs.`;
}

export const codingAgentAnswerProvider: AnswerProvider = async (
	ctx: AnswerProviderContext,
): Promise<T_RESPONSE> => {
	const started = Date.now();

	// Minted from the caller's own context, which handleUserPromptRequest has
	// already established. The agent queries from a separate OS process, so this
	// token is the ONLY way its SQL is policed as that user — without it the data
	// seam sees an anonymous query and refuses under SA_SQL_REWRITE_MODE=enforce.
	const contextToken = mintContextToken();
	if (!contextToken) {
		console.warn('[answer-provider] No request context — the agent would be refused at the data seam.');
	}

	/* A thread started on a dashboard records it, so the UI reopens the thread on
	   that dashboard. Done before the answer is saved: setThreadConfig only
	   writes to a thread that has no messages yet. */
	if (ctx.context?.dashboardId && ctx.userId && ctx.threadId) {
		await setThreadConfig({
			userId: ctx.userId,
			threadId: ctx.threadId,
			title: ctx.prompt,
			config: { dashboardId: ctx.context.dashboardId },
		}).catch((err: any) =>
			console.warn(
				`[answer-provider] could not record the dashboard on ${ctx.threadId}: ${err?.message ?? err}`,
			),
		);
	}

	/* Files attached to the question: within the thread's limit, or refused before
	   anything runs. The agent's prepare() loads them and records them on the thread. */
	if (ctx.attachments?.length && ctx.userId && ctx.threadId) {
		const existing = await getThreadAttachments({ userId: ctx.userId, threadId: ctx.threadId });
		if (existing.length + ctx.attachments.length > MAX_THREAD_ATTACHMENTS) {
			const left = Math.max(0, MAX_THREAD_ATTACHMENTS - existing.length);
			const tooMany = `A chat can have at most ${MAX_THREAD_ATTACHMENTS} files. This one has ${existing.length}, so ` +
				`${left === 0 ? 'no more can be added' : `only ${left} more can be added`}.`;
			return { success: false, data: { text: tooMany, component: null }, errors: [tooMany] } as T_RESPONSE;
		}
	}

	// A fresh narrator per question. Its updates go to the client on their own
	// channel (ctx.onNarration) — never into ctx.onStream.
	const narrator = startNarrator({ question: ctx.prompt, threadId: ctx.threadId, contextToken, onUpdate: ctx.onNarration });
	const transcript = ctx.onStream ? makeTranscript(ctx.onStream) : undefined;
	// Returned with the answer as data.narration on EVERY outcome — the SDK saves
	// it on the answer's own row (response.narration), aborted and failed included.
	let narration: NarrationUpdate[] = [];
	const withNarration = <T extends object>(data: T): T & { narration?: NarrationUpdate[] } =>
		narration.length ? { ...data, narration } : data;

	let stopCharts = () => {};
	try {
		// Routing decides inside the agent's prepare(); its result opens the trail as the Domain step.
		let routeInfo: RouteInfo | undefined;
		const onRoute = (info: RouteInfo) => {
			routeInfo = info;
			const t = domainStep(info);
			ctx.onStream?.(step({ icon: 'concept', label: t.label, badge: t.badge, body: t.body }));
		};
		// Charts start rendering as soon as their files are complete, while the agent still works.
		let charts: ReturnType<typeof startChartPrefetch> | undefined;
		stopCharts = () => charts?.stop();
		const onWorkspace = (dir: string) => { charts ??= startChartPrefetch(dir, ctx.components); };
		const input = { question: ctx.prompt, contextToken, threadId: ctx.threadId, userId: ctx.userId, context: ctx.context, attachments: ctx.attachments, onRoute, onWorkspace };
		const runOptions = {
			userId: ctx.userId,
			threadId: ctx.threadId,
			signal: ctx.signal,
			// No onNarration: the agent's prose is already in the event stream as
			// `message` items, so streaming it separately printed it twice.
			// Every event goes to the chat transcript AND to the narrator.
			onEvent: (event: any) => {
				transcript?.(event);
				narrator.feed(event);
			},
		};
		let run = await runCodingAgent('answer-agent', { input, ...runOptions });

		// A turn can end one step short of answer.md (measured: an empty final message
		// right after the table file). Same session, so it already holds every result:
		// one short turn asking only for the file, never more than once.
		const hasAnswer = () => { try { return fs.readFileSync(path.join(run.workspaceDir, 'answer.md'), 'utf-8').trim().length > 0; } catch { return false; } };
		// One recovery turn per question, whichever is wrong: no answer.md, or one the assembler rejects.
		let recovered = false;
		const recover = async (reason?: string) => {
			recovered = true;
			const first = run;
			run = await runCodingAgent('answer-agent', { input: { ...input, recovery: true, recoveryReason: reason, onRoute: undefined }, ...runOptions });
			run = { ...run, usage: {
				...run.usage,
				inputTokens: first.usage.inputTokens + run.usage.inputTokens,
				outputTokens: first.usage.outputTokens + run.usage.outputTokens,
				toolCalls: first.usage.toolCalls + run.usage.toolCalls,
				...(first.usage.costUSD !== undefined || run.usage.costUSD !== undefined
					? { costUSD: (first.usage.costUSD ?? 0) + (run.usage.costUSD ?? 0) } : {}),
			} };
			return first;
		};
		if (run.status === 'completed' && !hasAnswer() && !ctx.signal?.aborted) {
			console.warn(`[answer-provider] run=${run.runId} ended without answer.md — asking for it once in the same session`);
			const first = await recover();
			console.log(`[answer-provider] run=${first.runId} recovery ${hasAnswer() ? 'wrote answer.md' : 'still wrote no answer.md'} (${run.status})`);
		}

		// What the answer needed that its domain lacked: shown after the agent's steps,
		// stored on the route for the gap report. Never allowed to cost the answer.
		const usage = takeUsage(contextToken);
		if (routeInfo) {
			try {
				const gaps = await findGaps(routeInfo, usage);
				if (gaps) {
					const g = gapsStep(routeInfo, gaps);
					ctx.onStream?.(step({ icon: 'error', label: g.label, badge: g.badge, body: g.body }));
				}
				const routeId = routeInfo.decision.routeId;
				if (routeId) saveRouteGaps(routeId, gaps ?? {}).catch(err => console.warn(`[answer-provider] gaps not saved: ${err?.message ?? err}`));
			} catch (err: any) { console.warn(`[answer-provider] gap check failed: ${err?.message ?? err}`); }
		}
		// The run is over, so the answer exists: nothing may be narrated after it.
		narration = narrator.stop();

		// Another question in this same thread still holds the lock (scope: 'thread').
		// Returning the empty answer would read as a silent failure.
		if (run.status === 'skipped') {
			const busy = 'Still working on your previous question. Please try again in a moment.';
			return {
				success: false,
				data: withNarration({ text: busy, component: null }),
				errors: [busy],
			} as T_RESPONSE;
		}

		// The final chat message is only a completion signal. The renderer-ready
		// answer comes from the known workspace artifact, never an agent-supplied path.
		let text = '';
		try {
			text = fs.readFileSync(path.join(run.workspaceDir, 'answer.md'), 'utf-8').trim();
		} catch { /* handled by the existing empty-answer response below */ }
		if (!text) {
			console.error(`[answer-provider] run=${run.runId} status=${run.status} wrote no answer.md: ${run.error ?? 'unknown'}`);
			// `errors` is shown to the person as-is, so it carries the same readable
			// text; the internal reason is in the log line above.
			// explainFailure, not a generic line: the likeliest reason a run wrote
			// nothing is a shared usage limit, which rephrasing cannot fix.
			const failure = explainFailure(run.error);
			return {
				success: false,
				data: withNarration({ text: failure, component: null }),
				errors: [failure],
			} as T_RESPONSE;
		}

		let assembled;
		try {
			charts?.stop();
			try {
				assembled = await assembleAnswerFile(run.workspaceDir, text, ctx.components, charts?.render);
			} catch (err: any) {
				// A rejected answer.md gets the same one recovery turn, told exactly what is wrong.
				const reason = err?.message ?? String(err);
				if (!recovered && run.status === 'completed' && !ctx.signal?.aborted) {
					console.warn(`[answer-provider] run=${run.runId} answer.md rejected (${reason}) — asking for a fix once in the same session`);
					const first = await recover(reason);
					let fixed = '';
					try { fixed = fs.readFileSync(path.join(run.workspaceDir, 'answer.md'), 'utf-8').trim(); } catch { /* none */ }
					if (fixed) text = fixed;
					try {
						assembled = await assembleAnswerFile(run.workspaceDir, text, ctx.components, charts?.render);
						console.log(`[answer-provider] run=${first.runId} recovery fixed answer.md (${run.status})`);
					} catch (again: any) {
						console.warn(`[answer-provider] run=${first.runId} still rejected after recovery: ${again?.message ?? again}`);
					}
				}
				// Last resort: what can be read is shown; an unreadable block becomes a note, not a lost answer.
				if (!assembled) {
					assembled = await assembleAnswerFile(run.workspaceDir, text, ctx.components, charts?.render, { lenient: true });
					console.warn(`[answer-provider] run=${run.runId} answer.md assembled leniently after: ${reason}`);
				}
			}
		} catch (err: any) {
			const message = err?.message ?? String(err);
			console.error(`[answer-provider] run=${run.runId} invalid answer.md: ${message}`);
			// The cause is in the log line above; the person gets words.
			const incomplete = 'I could not put that answer together. Please try again.';
			return {
				success: false,
				data: withNarration({ text: incomplete, component: null }),
				errors: [incomplete],
			} as T_RESPONSE;
		}

		// The answer is NOT streamed again. Every message the agent wrote is already
		// in the transcript the chat received, and the answer is rendered from the
		// component below. Nor is __TEXT_COMPLETE__ emitted: the UI discards that
		// marker and everything after it, which would cut the transcript short.
		console.log(
			`[answer-provider] run=${run.runId} ${run.status} ${Math.round((Date.now() - started) / 1000)}s ` +
			`tokens=${run.usage.inputTokens}/${run.usage.outputTokens} tools=${run.usage.toolCalls} ` +
			`answer=${assembled.text.length}c`
		);

		// `text` is for a caller that did not stream; the component is what the
		// chat renders, in the panel where a dashboard used to go.
		return {
			success: true,
			data: withNarration({ text: assembled.text, component: assembled.component, method: 'coding-agent' }),
			errors: [],
		} as T_RESPONSE;
	} finally {
		// Idempotent; covers a run that threw before the stop above.
		narrator.stop();
		stopCharts();
		// Never outlive the run it was granted for.
		revokeContextToken(contextToken);
		releaseQueryRefs(contextToken);
	}
};

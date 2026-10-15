import { INSTRUCTIONS_FILE, type CodingAgentDefinition, type PromptAttachment, type PromptContext, type Workspace } from '@superatomai/sdk-node';
import * as fs from 'fs';
import * as path from 'path';
import { bridgeAccess, type BridgeAccess } from './data-tools';
import { linkToolFolders } from './tool-folders';
import { dashboardNote } from '../agent/dashboard-context';
import { attachmentsNote, downloadAttachments } from './attachments';
import { addThreadAttachments } from '../../../database/postgres/src/project-data-db/user-conversations';
import { IS_WINDOWS, basePrompt, fillInstructions } from './answer-prompt';
export { basePrompt, fillInstructions } from './answer-prompt';
import { GENERIC_DOMAIN, route, type RouteDecision } from '../graph/router';
import { llmTieBreak } from '../graph/tie-break';
import { compose, place } from '../graph/compose';
import { getInvariants } from '../../../database/postgres/src/project-data-db/concepts';
import { getPublishedDomain } from '../../../database/postgres/src/project-data-db/graph';

/**
 * Answer Agent — answers ONE user question, in prose.
 *
 * The alternative to MainAgent + SourceAgent. Where that pair solves a context
 * limit by summarising each source and delegating in prose, this solves it by
 * putting the material behind tools and letting the agent fetch only what it
 * needs. No summary, so no lossy handoff.
 *
 * The agent writes its rendered-answer source to answer.md and any tabular data
 * it references to data/*.json. The provider reads answer.md after the run;
 * the closing message is merely a completion signal.
 */

export interface AnswerAgentInput {
	question: string;
	/** For the route audit row: which conversation and which person asked. */
	threadId?: string;
	userId?: string;
	/**
	 * Identity for this run's queries, from mintContextToken(). Minted and
	 * revoked by the CALLER: prepare() has no teardown hook, and the caller is
	 * the only place that knows whose question this is.
	 *
	 * Live path: mint from the user's own request context, so row-level policies
	 * apply exactly as they do on the MainAgent path. Without it the bridge sees
	 * an anonymous query and refuses under SA_SQL_REWRITE_MODE=enforce.
	 */
	contextToken?: string;
	/**
	 * Where the question was asked from. With a dashboard in it, the dashboard's
	 * program is copied into the workspace and described ahead of the question,
	 * so a follow-up can run its panels (tools/run-resolver) and read its logic.
	 */
	context?: PromptContext;
	/** Files attached to this question (R2 references): downloaded into attachments/ by prepare(). */
	attachments?: PromptAttachment[];
	/** A second turn in the same session after one ended without answer.md: keep its files, ask only for the file. */
	recovery?: boolean;
	/** Why the recovery turn runs: the assembler's error when answer.md was written but rejected. */
	recoveryReason?: string;
	/** Called once the workspace is ready for this question, before the agent starts. */
	onWorkspace?: (dir: string) => void;
	/** Called once routing has decided, before the agent starts: the answer's Domain step and gap check. */
	onRoute?: (info: RouteInfo) => void;
}

/** Which domain a question was answered from, why, and what that domain holds. */
export interface RouteInfo {
	question: string;
	decision: RouteDecision;
	title: string;
	/** Names and aliases of the domain's concepts and the invariants, lowercased. */
	conceptKeys: string[];
	conceptNames: string[];
	/** Concept names the domain lists that the store does not have. */
	missing: string[];
	/** The composed instructions, lowercased: a table named nowhere in them is one the domain does not describe. */
	text: string;
}

/**
 * The agent's tools: the shared lookups in `agent-tools/common`, linked into the
 * workspace as `tools/` — see tool-folders.ts for why a link and not a copy.
 * Windows gets the PowerShell-native versions, `common-win` (see answer-prompt.ts).
 */
const TOOL_LINKS = { tools: IS_WINDOWS ? 'common-win' : 'common' };

/**
 * The codex model that answers unless SA_ANSWER_AGENT_MODEL/CODEX_AGENT_MODEL
 * override it. Needs codex >= 0.156 (0.149 has no metadata for it and the API
 * then refuses it) — see CODEX_VERSION in the Dockerfile.
 */
const DEFAULT_MODEL = 'gpt-6-luna';

/** The dashboard note for this turn, written by prepare() and read by buildPrompt. */
const DASHBOARD_NOTE = '.dashboard-note';

/** The attached-files note for this turn, written by prepare() and read by buildPrompt. */
const ATTACHMENTS_NOTE = '.attachments-note';

/**
 * Set when this turn's composition replaced a previous one, and read by
 * buildPrompt.
 *
 * The SDK decides `resumeId` from `_state.json` BEFORE prepare() runs, so
 * deleting that file here cannot restart the session for this turn — only the
 * next one. This turn therefore runs in a session whose context still holds the
 * PREVIOUS domain's instructions while the new one is already on disk, so the turn
 * prompt has to say "re-read it".
 */
const SWITCH_MARKER = '.graph-switched';

/** The domain holding the parts every other domain gets. */
const SHARED_DOMAIN = 'shared';
/** Domains that already contain the shared parts, so they are not appended twice. */
const SHARED_DOMAINS = new Set([SHARED_DOMAIN, GENERIC_DOMAIN]);

/** Which domain this workspace is composed from, read back by buildPrompt. */
const DOMAIN_STAMP = '.graph-domain';

export interface AnswerDataset {
	id: string;
	toolId: string;
	sql: string;
	rows: any[];
	count?: number;
}

export interface AnswerComponentSpec {
	componentType: string;
	/** The `ref` ./query printed. Rows come from the bridge, never from the agent. */
	query?: string;
	/** Legacy: names a `datasets[].id`. Kept so an older deliverable still renders. */
	sourceRef?: string;
	title?: string;
	description?: string;
	config?: Record<string, any>;
}

/** Numbers behind the coverage line. Shares are derived, never supplied. */
export interface CoverageStats {
	/** 'amount' renders as money in the deployment's locale/currency; 'count' as a plain grouped number. */
	measure: 'amount' | 'count';
	/** What is being measured, for the sentence: "booking amount", "bookings". */
	measureLabel: string;
	/** The ungrouped total over the SAME filters. */
	total: number;
	/** What the returned rows account for. */
	shown: number;
	/** The unattributable group — null/zero/unmatched key. */
	excluded?: number;
	excludedRows?: number;
	/** Why they could not be attributed, in a few words. */
	excludedReason?: string;
}

export interface AnswerOutput {
	answer: string;
	/** Legacy: rows typed by the agent. Superseded by components[].query. */
	datasets?: AnswerDataset[];
	components: AnswerComponentSpec[];
	method?: string;
	verification?: string;
	/** Dashboard heading. Mirrors write_components' required `layoutTitle`. */
	layoutTitle?: string;
	/** One-line subtitle under it. Mirrors `layoutDescription`. */
	layoutDescription?: string;
	/**
	 * What the answer leaves out, as NUMBERS.
	 *
	 * Structured rather than prose because completeness cannot be instructed: the
	 * same sentence was revised three times and still shipped an answer stating
	 * "483 bookings excluded" without the ₹2.58 Cr those represented — half the
	 * month. Take the figures, compute the shares in code, and the omission
	 * becomes impossible rather than discouraged.
	 *
	 * A plain string is still accepted: only a SUBSET answer owes coverage at
	 * all, and a live session holds earlier prose turns in its context.
	 */
	coverage?: string | CoverageStats;
	/**
	 * Files written under outputs/ that the person should be able to download.
	 * Never bound to a query — kept separate from `components`, whose
	 * `query` must always name a real result. Optional and additive: the
	 * permissive output.schema.parse() below passes it through untouched, so
	 * an older or unaware agent run simply omits it.
	 */
	attachments?: AnswerAttachment[];
}

export interface AnswerAttachment {
	/** Workspace-relative, must resolve under outputs/ — see resolveOutputFile in answer-assembly.ts. */
	path: string;
	/** Shown as the link label; falls back to the file's own name. */
	title?: string;
}

/** The body of system.md's "## Write answer.md" section, up to the next `## ` heading. */
export function answerLayout(instructions: string): string {
	const m = /^##[ \t]+Write\b[^\n]*answer\.md[^\n]*\n([\s\S]*?)(?=^##[ \t]|(?![\s\S]))/m.exec(instructions);
	return m ? m[1].trim() : '';
}

/**
 * Route the question to a domain and lay its knowledge into the workspace.
 *
 * Runs in prepare() because the runner writes the instructions FIRST and calls
 * prepare() after, so this is the one place that can replace the instructions
 * for this question. The composed prompt is base.md plus the domain's parts in
 * order; its files land under domain/.
 *
 * On unless SA_GRAPH_ROUTING=off. An empty graph composes nothing and any
 * failure falls back to the on-disk prompt, so this costs a new client nothing.
 */
async function composeDomain(ws: Workspace, question: string, access: BridgeAccess | null, threadId?: string, userId?: string,
	opts: { recovery?: boolean; onRoute?: (info: RouteInfo) => void } = {}): Promise<string> {
	if (process.env.SA_GRAPH_ROUTING === 'off' || !question.trim()) return '';
	try {
		// The thread's current domain, so an elliptical follow-up stays in it.
		let currentDomain: string | null = null;
		try { currentDomain = fs.readFileSync(ws.pathTo(DOMAIN_STAMP), 'utf-8').trim() || null; } catch { /* first turn */ }
		const hadDomain = Boolean(currentDomain);

		// A recovery turn keeps the domain its first turn ran in: routing again could pick
		// another, which would restart the session that holds the results.
		const { decision, composed } = opts.recovery && currentDomain
			? { decision: { domainName: currentDomain, domainId: null, score: 0, matched: [], decidedBy: 'sticky' } as RouteDecision,
				composed: await getPublishedDomain(currentDomain) }
			: await route(question, { threadId, userId, currentDomain, tieBreak: llmTieBreak });
		if (!composed) return ', no domain (graph empty)';

		// Invariants apply to every question, so they are composed in rather than
		// left to a tool call the agent has to remember to make. The `shared`
		// domain holds the answer contract and the rules: an authored domain lists
		// only its own knowledge and would otherwise have no answer format.
		const invariants = (await getInvariants()).data as any[];
		const shared = SHARED_DOMAINS.has(decision.domainName)
			? [] : (await getPublishedDomain(SHARED_DOMAIN))?.members ?? [];
		const comp = compose(composed, { invariants, shared });
		const replaced = place(ws.pathTo('.'), comp);

		if (opts.onRoute) {
			const concepts = [...composed.members.map(m => m.concept).filter(Boolean), ...invariants] as any[];
			try {
				opts.onRoute({
					question,
					decision,
					title: composed.domain.title || decision.domainName.replace(/_/g, ' '),
					conceptKeys: concepts.flatMap(c => [c.name, ...(c.aliases ?? [])]).filter(Boolean).map((k: string) => k.toLowerCase()),
					conceptNames: composed.members.map(m => m.concept?.name).filter(Boolean) as string[],
					missing: composed.missing,
					text: comp.prompt.toLowerCase(),
				});
			} catch (err: any) { console.warn(`[answer-agent] onRoute failed: ${err?.message ?? err}`); }
		}

		await ws.write(INSTRUCTIONS_FILE, `${basePrompt(access)}\n\n${comp.prompt}\n`);

		// A live codex session was given the OLD instructions and cannot be told
		// they changed, so a different composition has to start a new session.
		// Deleting the state makes the NEXT turn start clean; the marker makes THIS
		// turn re-read the file it was not given. A first turn has no stale session
		// to correct, so it gets neither.
		if (replaced) {
			if (hadDomain) fs.writeFileSync(ws.pathTo(SWITCH_MARKER), decision.domainName);
			fs.rmSync(ws.pathTo('_state.json'), { force: true });
		}

		// buildPrompt runs per turn and has no access to the route, so the decision
		// is left on disk. Written even when the composition was unchanged.
		fs.writeFileSync(ws.pathTo(DOMAIN_STAMP), decision.domainName);

		const conceptCount = composed.members.filter(m => m.role === 'concept' && m.concept).length;
		const terms = decision.matched.map(m => m.term).slice(0, 4).join(', ');
		return `, domain ${decision.domainName} (${decision.decidedBy}, score ${decision.score}${terms ? `, on ${terms}` : ''}`
			+ `, ${conceptCount} concepts + ${invariants.length} invariants${composed.missing.length ? `, MISSING ${composed.missing.join('/')}` : ''})`
			+ `${replaced ? ', re-placed' : ''}`;
	} catch (err: any) {
		// The graph failing must never cost an answer: without a composition the
		// agent falls back to the prompt already on disk.
		console.warn(`[answer-agent] graph routing skipped: ${err?.message ?? err}`);
		return ', domain routing failed';
	}
}

// ── Definition ──────────────────────────────────────────────────────────────

export const answerAgent: CodingAgentDefinition<AnswerAgentInput> = {
	id: 'answer-agent',
	title: 'Answer Agent',
	description: 'Answers a user question from the project data, in prose.',

	// A person is waiting and it streams. Also what gates chat-transport reach.
	mode: 'chat',

	// Switchable without a code change, most specific first:
	//   SA_ANSWER_AGENT_MODEL  this agent only
	//   CODEX_AGENT_MODEL      every coding agent
	//   neither                DEFAULT_MODEL
	model: process.env.SA_ANSWER_AGENT_MODEL || process.env.CODEX_AGENT_MODEL || DEFAULT_MODEL,

	// One session and workspace per UI THREAD, matching what the user sees as a
	// conversation: follow-ups in a thread carry their own history, a new thread
	// starts clean, and a user's threads can run in parallel. Per-user scope made
	// every thread share one ever-growing session, so unrelated threads bled into
	// each other and input tokens climbed with the user's whole history.
	// Two questions in the SAME thread still serialise (status 'skipped').
	scope: 'thread',
	session: { scope: 'persistent', workspace: 'persistent' },

	// ./query reaches the bridge over loopback HTTP; without this the sandbox
	// blocks it. Filesystem stays confined to the workspace (workspace-write).
	networkAccessEnabled: true,

	  sandboxMode: (['read-only', 'workspace-write', 'danger-full-access'] as const)
              .find(m => m === process.env.ANSWER_AGENT_SANDBOX_MODE) ?? 'workspace-write',
	// Under the frontend's 20-minute socket timeout, so a stuck run fails here
	// with a usable error instead of dying as a socket timeout with no trace.
	timeoutMs: 10 * 60 * 1000,

	/**
	 * What the shared tools in `agent-tools/` need to know about THIS run. They
	 * are one file on disk serving every thread, so anything run-specific has to
	 * arrive at runtime; baking it in is what we are moving away from.
	 */
	env(input) {
		return {
			// The tools run their Node parts on the backend's own Node, not whatever PATH finds.
			SA_NODE: process.execPath,
			...(process.env.SCRIPT_BRIDGE_URL ? { SA_BRIDGE_URL: process.env.SCRIPT_BRIDGE_URL } : {}),
			...(input.contextToken ? { SA_CONTEXT_TOKEN: input.contextToken } : {}),
			// The dashboard this question was asked from: tools/run-resolver and
			// tools/semantic act on it. Absent, they fall back to dashboard/dashboard.json.
			...(input.context?.dashboardId ? { SA_DASHBOARD_ID: input.context.dashboardId } : {}),
		};
	},

	async prepare(ws, input) {
		linkToolFolders(ws.dir, TOOL_LINKS);

		// Asked from a dashboard: its program goes into dashboard/ and a note about
		// it goes ahead of the question (buildPrompt). Never fails the run — a
		// dashboard that cannot be read is described as such.
		const note = await dashboardNote(ws.dir, `answer-agent/${input.threadId ?? ''}`, input.context).catch((err) => {
			console.warn(`[answer-agent] dashboard context unavailable: ${err?.message ?? err}`);
			return null;
		});
		if (note) await ws.write(DASHBOARD_NOTE, note);
		else fs.rmSync(ws.pathTo(DASHBOARD_NOTE), { force: true });

		// Files attached to the question: loaded into attachments/, then recorded on
		// the thread — in that order, so a file that could not be loaded is never
		// counted against the thread's limit (checked by the provider). A failed
		// download fails the run with the file's name; the provider shows that as is.
		// A recovery turn keeps the note it already had.
		if (!input.recovery) {
			fs.rmSync(ws.pathTo(ATTACHMENTS_NOTE), { force: true });
			if (input.attachments?.length) {
				const files = await downloadAttachments(ws.dir, input.attachments);
				if (input.userId && input.threadId) {
					await addThreadAttachments({ userId: input.userId, threadId: input.threadId, title: input.question, attachments: input.attachments });
				}
				await ws.write(ATTACHMENTS_NOTE, attachmentsNote(files));
			}
		}

		// Workspaces are persistent per thread, so a thread that ran under the old
		// deliverable contract still holds its files. Left alone, the agent reads a
		// component catalogue it can no longer return and an answer.json nobody
		// reads.
		// AGENTS.md is in the list because codex prefers that name over the
		// system.md fallback: a thread created before the rename would otherwise
		// keep reading the instructions it was composed with weeks ago.
		// A recovery turn keeps them: its answer is built from the files this question already wrote.
		if (!input.recovery) for (const stale of ['input', 'AGENTS.md', 'out/answer.json', 'answer.md', 'data', '.query-results', 'sql']) {
			fs.rmSync(ws.pathTo(stale), { force: true, recursive: ['data', 'input', '.query-results', 'sql'].includes(stale) });
		}
		input.onWorkspace?.(ws.dir);

		// Data access is entirely through shared tools now; nothing about the
		// bridge is written into the workspace. The tools tell the agent when it is
		// down; this only flags it in the log.
		const access = await bridgeAccess();

		// Concepts arrive through tools/find-concept and tools/get-concept now — one
		// shared copy for every thread. Writing the whole set per run put ~19k tokens
		// in every workspace and made an edit reach only later workspaces.

		// NOTHING is written to input/ any more. Measured: reading those files cost
		// 1-5 calls and 20-44s per turn for 0.2-0.6s of execution, and whatever was
		// read then rode along in the context of every later call. What they held is
		// better served elsewhere — the domain's concepts name the tables and joins,
		// get-schema reports columns and types on demand, and the dialect rules were
		// written for a weaker generation of models. The four that are NOT about SQL
		// but about this harness (one statement, SELECT/WITH only, no DECLARE, no
		// leading semicolon) moved into base.md beside the query tool.
		const domain = await composeDomain(ws, input.question ?? '', access, input.threadId, input.userId,
			{ recovery: input.recovery, onRoute: input.onRoute });
		// Whatever wrote the instructions — a composed domain or the runner's plain
		// system.md — its placeholders are filled here, for this OS.
		const instructions = await ws.read(INSTRUCTIONS_FILE);
		if (instructions && instructions.includes('{{')) await ws.write(INSTRUCTIONS_FILE, fillInstructions(instructions, access));

		// The model is printed because it is env-switchable: a run that answers
		// differently after a restart should say which model did it.
		const model = process.env.SA_ANSWER_AGENT_MODEL || process.env.CODEX_AGENT_MODEL || DEFAULT_MODEL;
		console.log(`[answer-agent] workspace ready: model ${model}${access ? '' : ', NO data access'}${domain}`);
	},

	/**
	 * The turn's prompt IS the user's question, nothing else — the same thing a
	 * person types into a coding agent.
	 *
	 * Everything that used to be wrapped around it (input/ is refreshed) is
	 * standing fact, so it belongs in system.md, which the agent reads once per
	 * session instead of re-reading every turn.
	 */
	buildPrompt(ws, input) {
		if (input.recovery) {
			const what = input.recoveryReason
				? `Your ${ws.pathTo('answer.md')} was rejected: ${input.recoveryReason}. Fix answer.md and the files it cites`
				: `You ended your turn without writing ${ws.pathTo('answer.md')}. Write it now`;
			return `${what}, in the format given earlier, from the results and data/ files you already have. `
				+ 'Run no new queries unless a figure the answer needs is missing.';
		}
		// A follow-up re-plans from its own recent reasoning, and system.md is far
		// back in context by then: measured, turn 2 re-ran the schema lookups its
		// domain had retired and substituted its own key for the domain's. The
		// reminder sits in the turn prompt because that is the most recent thing
		// the model reads. `generic` is excluded — it has nothing to assert.
		let domain = '';
		try {
			const name = fs.readFileSync(ws.pathTo(DOMAIN_STAMP), 'utf-8').trim();
			if (name && name !== GENERIC_DOMAIN) {
				domain = `Active domain: ${name}. The keys, joins and decisions stated in your `
					+ 'instructions are authoritative and already verified — apply them as written; '
					+ 'do not re-derive, re-confirm or substitute your own.\n\n';
			}
		} catch { /* no routing: nothing to assert */ }

		// Only when the composition actually changed under a live session: a normal
		// follow-up already has the right instructions and must not be sent reading.
		let handover = '';
		try {
			const marker = ws.pathTo(SWITCH_MARKER);
			if (fs.existsSync(marker)) {
				const to = fs.readFileSync(marker, 'utf-8').trim();
				fs.rmSync(marker, { force: true });
				handover = `This question is about a different area, so your instructions were replaced: `
					+ `run \`cat system.md\` and work from that${to ? ` (domain: ${to})` : ''}. `
					+ 'Anything you remember from earlier in this conversation about which tables, keys or '
					+ 'definitions to use no longer applies.\n\n';
			}
		} catch { /* no marker: ordinary turn */ }

		// The dashboard the question was asked from, ahead of the question itself.
		let dashboard = '';
		try {
			const note = fs.readFileSync(ws.pathTo(DASHBOARD_NOTE), 'utf-8').trim();
			if (note) dashboard = `${note}\n\n---\n\n`;
		} catch { /* not asked from a dashboard */ }

		// The files attached to the question, ahead of it too.
		let files = '';
		try {
			const note = fs.readFileSync(ws.pathTo(ATTACHMENTS_NOTE), 'utf-8').trim();
			if (note) files = `${note}\n\n---\n\n`;
		} catch { /* no files with this question */ }

		// The layout goes last on every question: read once at the top of a long session it was
		// dropped, most often on follow-ups. Read from system.md, so the admin's latest edit applies.
		let layout = '';
		try { layout = answerLayout(fs.readFileSync(ws.pathTo(INSTRUCTIONS_FILE), 'utf-8')); } catch { /* none */ }
		const answerMd = ws.pathTo('answer.md');
		const prompt = `${domain}${handover}${dashboard}${files}${input.question ?? ''}\n\n`
			+ (layout
				? `---\n\nBefore finishing, write ${answerMd}. When your answer shows figures, use this layout:\n\n${layout}\n\n`
					+ 'Otherwise (a clarifying question, or the details of one record), answer as the question needs.'
				: `Before finishing, write ${answerMd} as your instructions (system.md) describe.`);
		console.log(`[answer-agent] prompt for ${input.threadId ?? '-'}:\n${prompt}\n[answer-agent] end of prompt`);
		return prompt;
	},

	// No SDK output contract: it currently validates JSON deliverables only.
	// answer-provider reads this Markdown artifact and no apply() is needed.
};

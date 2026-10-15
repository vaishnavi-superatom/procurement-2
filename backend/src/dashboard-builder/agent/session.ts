/**
 * The dashboard builder — a long-lived conversation, one per dashboard.
 *
 * **There is one agent.** It grounds a request against the real data, writes
 * both programs, runs what it wrote, and publishes. An earlier design split that
 * across a read-only analyst and an ephemeral builder joined by a `BuildSpec`;
 * the boundary was real, and it failed at the seam — a spec naming a dashboard
 * its sender had no business choosing, grounding established twice because prose
 * could not carry it, and two prompts that grew two different habits about which
 * catalogue to trust. IMPLEMENTED.md, "Why the split came apart".
 *
 * Modelled on dashboard-pi's session shape, which is proven.
 *
 * **Keyed by dashboardId, not by thread.** The conversation about a dashboard is
 * the dashboard's, not a particular person's or tab's — reopening it later
 * should resume where it left off rather than start again with an agent that has
 * forgotten what was already decided. `cwd` is deterministic for the same
 * reason, so `SessionManager.continueRecent` finds the real session file and a
 * backend restart costs the in-memory transcript but not the conversation.
 *
 * **The dashboard exists before the conversation does.** The platform registers
 * an empty dashboard, and only then is a session opened on it. So there is no id
 * for the agent to invent and none to get wrong — the same treatment grants get,
 * applied one level up. There is no `_new`.
 *
 * **It can write, and that is the trade.** pi's read, write and edit tools are
 * on beside the shims. Restricting to bash confined nothing — bash has no
 * sandbox here — and cost a silent failure mode: a shell replace that matches
 * nothing reports success, where `edit` raises. What stands between any of it
 * and a reader is `./publish`, which refuses anything unverified,
 * uncompilable, or reaching past its grants — see `publish.ts`.
 */
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { sourceTypeOf } from '../../sources/source-type';
import { mintContextToken, revokeContextToken } from '@superatomai/sdk-node';
import { bridgeAccess } from '../../coding-agents/data-tools';
import { linkToolFolders, describeTools, type ToolSummary } from '../../coding-agents/tool-folders';
import { ensureWorkspace, programFilesIn, WORKSPACE_ROOT } from './workspace';
import { registerWorkspace, closeWorkspace, findSessionFor } from './workspaces';
import { writeManifest } from './manifest';
import { hasUnpublishedChanges, publishSession } from './publish';
import { locationEntry, resolveDir } from '../locations';
import { directToolIds } from '../query';
import { listSemanticModels } from '../semantic';
import { componentIndex } from '../component-catalog';
import { resetProposedThisTurn } from '../bridge';
import { getConcept, getConceptCatalog } from '../../../../database/postgres/src/project-data-db/concepts';
import { promptLoader } from '@superatomai/sdk-node';
import {
	createUpdateBus,
	narrate,
	personsWords,
	textOf,
	type AgentUpdate,
	type LiveSession,
} from '../../pi/narration';
import { startTrace, recordToolCall, recordToolResult, takeTrace, type ToolTrace } from '../../pi/trace';
import { readStats as readSessionStats, spent, usageLine } from '../../pi/usage';
import { describe } from './narrate';

/* pi is ESM-only and this project compiles to CommonJS — same dynamic-import
 * trick the chat agent and dashboardAgent use, for the same reason. */
type PiModule = typeof import('@earendil-works/pi-coding-agent');
let piModulePromise: Promise<PiModule> | null = null;
function pi(): Promise<PiModule> {
	piModulePromise ??= new Function('m', 'return import(m)')(
		'@earendil-works/pi-coding-agent',
	) as Promise<PiModule>;
	return piModulePromise;
}

export const RUNTIME_DIR = WORKSPACE_ROOT;
const AGENTS_MD_SOURCE = path.join(process.cwd(), '.prompts', 'dashboard-builder', 'AGENTS.md');

const WANTED_PROVIDER = process.env['PI_PROVIDER'] ?? 'openai-codex';
const WANTED_MODEL = process.env['PI_MODEL'] ?? 'gpt-5.6-luna';
const IDLE_TIMEOUT_MS = Number(process.env['DASH_BUILDER_IDLE_MS'] ?? 30 * 60 * 1000);

type AgentSession = Awaited<ReturnType<PiModule['createAgentSession']>>['session'];

/** The parts of pi's session store this module reads. Structural, not imported,
 *  because pi's types are ESM and this file compiles to CommonJS. */
interface SessionEntryLike {
	type?: string;
	message?: unknown;
}
interface SessionManagerLike {
	getEntries?(): SessionEntryLike[];
	buildSessionContext?(): { messages?: unknown[] };
}

/**
 * What a caller watching this conversation is told.
 *
 * The shared vocabulary, not a private one. This union used to be declared here
 * and again, spelled slightly differently, in the chat agent — same variants,
 * same delta arithmetic, same everything except that one called a tool call
 * `tool` and the other called it `activity`. The name stays as an alias because
 * "builder update" is what the collection and the SDK call it.
 */
export type BuilderUpdate = AgentUpdate;

interface Live extends LiveSession {
	/** `provider/modelId`, for the analytics event. */
	model: string;
	/**
	 * What the agent's tools are told about this session — bridge address,
	 * dashboard, program directory, and during a turn whose identity it runs as.
	 * Read by the shell on every command, so the per-turn token lands without
	 * rebuilding the session.
	 */
	env: Record<string, string>;
}

/**
 * The shared tools, linked into every builder workspace: the common lookups as
 * `tools/`, the builder's own as `dash/`. See coding-agents/tool-folders.ts.
 */
const TOOL_LINKS = { tools: 'common', dash: 'dashboard-builder' };

/**
 * What the agent's shell inherits from the backend: enough to run commands, and
 * none of the backend's own secrets — database credentials and API keys stay
 * out of reach of an agent that can type `env`. The codex driver scrubs the same
 * way; the run-specific values are added on top.
 */
const SHELL_ENV_ALLOWLIST = [
	'PATH', 'Path', 'HOME', 'USER', 'USERNAME', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TERM',
	'TMPDIR', 'TEMP', 'TMP', 'NODE_EXTRA_CA_CERTS',
	// Windows: without these a shell cannot start programs.
	'SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'COMSPEC', 'PATHEXT', 'USERPROFILE',
	'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH', 'ProgramFiles', 'ProgramData', 'MSYSTEM',
];

function shellEnv(run: Record<string, string>): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const key of SHELL_ENV_ALLOWLIST) {
		if (process.env[key] !== undefined) env[key] = process.env[key];
	}
	return { ...env, ...run };
}

const sessions = new Map<string, Live>();

/**
 * This agent's own channel.
 *
 * One bus per agent rather than one for the process: a builder listener has no
 * business being woken by a chat turn, and a shared bus keyed by id would leave
 * every listener filtering for its own conversation.
 */
const bus = createUpdateBus();

export function onBuilderUpdate(fn: (id: string, u: BuilderUpdate) => void): () => void {
	return bus.listen(fn);
}

function emit(id: string, live: Live | undefined, update: BuilderUpdate): void {
	bus.publish(id, live, update);
}

/**
 * Put an update on a conversation's stream from outside this module.
 *
 * For things the agent causes through a tool rather than through pi — a concept
 * proposal is the first. The bridge handles the call and knows the outcome; this
 * module owns the stream and the transcript, and the alternative was a second
 * channel to the same pane.
 *
 * Recorded against the live conversation when there is one, so a reload replays
 * it. A call for a dashboard with no session still reaches listeners; it simply
 * is not kept, which is the same rule every other update follows.
 */
export function publishBuilderUpdate(dashboardId: string, update: BuilderUpdate): void {
	bus.publish(dashboardId, sessions.get(dashboardId), update);
}

/**
 * Rebuilds a transcript from a resumed conversation.
 *
 * User and assistant text only. pi's session file does not keep the tool trail
 * in a form worth re-parsing, so reopening a conversation shows what was said
 * rather than what was run — which is the part worth reading back anyway.
 *
 * ### Not `session.messages`
 *
 * That getter returns `agent.state.messages`, which is only assigned by
 * `compact()`, `_runAutoCompaction()` and `navigateTree()` — never at
 * construction. On a freshly resumed session it is **empty until a turn runs**,
 * so seeding from it produced no transcript at all: thirty messages intact on
 * disk and invisible in the pane, which looks lost and is not.
 *
 * Capped, because a long conversation is not worth sending in full to redraw a
 * pane; the recent end is what someone is coming back to.
 */
function seedTranscript(session: AgentSession, dashboardId: string): BuilderUpdate[] {
	const manager = (session as unknown as { sessionManager?: SessionManagerLike }).sessionManager;
	if (!manager) {
		console.warn(`[dashboard-builder] ${dashboardId}: no sessionManager — transcript starts empty`);
		return [];
	}

	/**
	 * `getEntries()` rather than `buildSessionContext()`.
	 *
	 * They answer different questions. `buildSessionContext()` is *the LLM's
	 * view*: it follows the branch to the current leaf and resolves compaction,
	 * so a long conversation legitimately collapses to a summary plus the recent
	 * tail. Reading a transcript from it shows whatever the model would be sent,
	 * which is not what was said.
	 *
	 * `getEntries()` is the append-only log — everything, in order, never
	 * rewritten. That is what a person scrolling back is looking for.
	 *
	 * Entries are wrappers (`{ type: 'message', message: { role, content } }`),
	 * so the inner message is what `textOf` reads.
	 */
	let entries: SessionEntryLike[] = [];
	try {
		entries = manager.getEntries?.() ?? [];
	} catch (err: any) {
		console.warn(`[dashboard-builder] ${dashboardId}: could not read session entries: ${err?.message ?? err}`);
		return [];
	}

	const transcript: BuilderUpdate[] = [];
	for (const entry of entries) {
		if (entry?.type !== 'message') continue;
		const message = entry.message;

		const user = textOf(message, 'user');
		if (user) {
			/* The backend's own publish follow-ups are not the person's words. */
			if (!user.startsWith(PUBLISH_CHECK)) {
				transcript.push({ type: 'user', text: personsWords(user), at: Date.now() });
			}
			continue;
		}
		const assistant = textOf(message, 'assistant');
		if (assistant) transcript.push({ type: 'assistant', text: assistant, at: Date.now() });
	}

	/**
	 * One line per resumed conversation, and it has earned its place.
	 *
	 * Two wrong diagnoses were made about this exact code — a shape problem that
	 * was not one, and then a source that returns the compacted view — because
	 * nothing said what was actually being read. The counts distinguish every
	 * failure this has had: no entries at all, entries that carry no text, or a
	 * source quietly returning fewer than the file holds.
	 */
	let contextCount = -1;
	try {
		contextCount = manager.buildSessionContext?.()?.messages?.length ?? -1;
	} catch {
		/* Only for the log line. */
	}
	console.log(
		`[dashboard-builder] ${dashboardId}: resumed — ${entries.length} entries, ` +
			`${transcript.length} shown (LLM context would be ${contextCount})`,
	);

	return transcript.slice(-200);
}


/**
 * Subscribes to one session's raw pi events and republishes the parts worth
 * showing.
 *
 * What reaches a reader is deliberately not the raw stream. A coding agent's
 * transcript is mostly mechanics, and nobody working out what a dashboard
 * should contain wants to read it — so assistant prose is kept, a tool call
 * becomes one short line, and tool **output never leaves the server**. Same
 * choice dashboard-pi made, for the same reason.
 */
function attach(id: string, live: Live): void {
	/**
	 * `describe` is what stays local.
	 *
	 * The event handling is the same for any embedded pi agent and lives in
	 * `src/pi/narration`. Phrasing a tool call is not: this agent's tools are its
	 * own shims, and `./run-resolver revenue` reading as "Running revenue against
	 * the data" depends on knowing them.
	 *
	 * No `pairToolCalls`: this transcript is a list of what was done, not a
	 * checklist ticking itself off, so a finished call needs no second update.
	 */
	/* `ownsRunningState`: a turn can run the model more than once — see the publish loop in `ask`. */
	narrate(id, live, bus, {
		describe,
		ownsRunningState: true,
		onToolCall: (callId, toolName, args) => recordToolCall(id, callId, toolName, args),
		onToolResult: (callId, result, failed) => recordToolResult(id, callId, result, failed),
	});
}

/**
 * pi's bash tool with the timeout taken away from the model.
 *
 * Its schema no longer offers `timeout`, and any value still sent is dropped
 * before the command runs. How long a query may take is decided by the source
 * instance, not by the agent.
 */
function bashWithoutTimeout(
	cwd: string,
	createBashToolDefinition: PiModule['createBashToolDefinition'],
	createLocalBashOperations: PiModule['createLocalBashOperations'],
	/** This session's tool environment, read fresh on every command. */
	runEnv: Record<string, string>,
) {
	const local = createLocalBashOperations();
	const definition = createBashToolDefinition(cwd, {
		operations: {
			exec: (command, dir, options) =>
				local.exec(command, dir, { ...options, timeout: undefined, env: shellEnv(runEnv) }),
		},
	});
	const parameters = definition.parameters as unknown as { properties: Record<string, unknown>; required?: string[] };
	return {
		...definition,
		description: definition.description.replace(/\s*Optionally provide a timeout in seconds\./, ''),
		parameters: { ...parameters, properties: { command: parameters.properties.command }, required: ['command'] },
	} as unknown as typeof definition;
}

let runtimePromise: ReturnType<PiModule['ModelRuntime']['create']> | null = null;
let announced = false;

async function modelRuntime() {
	const { ModelRuntime, getAgentDir } = await pi();
	const agentDir = getAgentDir();
	runtimePromise ??= ModelRuntime.create({
		authPath: `${agentDir}/auth.json`,
		modelsStorePath: `${agentDir}/models-store.json`,
		allowModelNetwork: true,
	});
	return runtimePromise;
}

async function create(dashboardId: string, grants: readonly string[]): Promise<Live> {
	const { createAgentSession, getAgentDir, SessionManager, createBashToolDefinition, createLocalBashOperations } = await pi();
	const agentDir = getAgentDir();
	const runtime = await modelRuntime();

	/**
	 * The workspace, and the published program synced into it.
	 *
	 * Every time a session opens, not only when one is created: a backend restart
	 * rebuilds the session from disk, and someone may have deleted or republished
	 * the dashboard in between. Syncing on open is what stops the agent editing a
	 * copy of something that no longer exists.
	 */
	const ws = await ensureWorkspace(dashboardId);
	const cwd = ws.root;

	const available = await runtime.getAvailable(WANTED_PROVIDER);
	const model =
		available.find((m) => (m as { id?: string }).id === WANTED_MODEL) ?? available[0];
	if (!model) {
		throw new Error(
			`No model available from "${WANTED_PROVIDER}". Authorise it in a terminal: run \`pi\`, then \`/login\`.`,
		);
	}
	if (!announced) {
		announced = true;
		const chosen = model as { id?: string };
		console.log(
			`  dashboard builder model: ${WANTED_PROVIDER}/${chosen.id}` +
				(chosen.id === WANTED_MODEL ? '' : ` (${WANTED_MODEL} unavailable; fell back)`),
		);
	}

	/**
	 * Everything the one agent needs, in one place.
	 *
	 * `includeDirectTools` was off, on the reasoning that this agent reads data
	 * to work out what is possible and does not invoke business logic. That
	 * reasoning was wrong about what a concept is. `./concept-catalog` lists
	 * every concept and what it is for, and without `./run-tool` there is no way
	 * to read what any of them *says* — so the agent saw `ref-data null
	 * sentinel` in a list, could not find out that it means `'-'` is null here,
	 * and fell through to the knowledge base because that was the only endpoint
	 * returning content. A rule it cannot read is a rule it cannot apply.
	 *
	 * `concept` is also the one direct tool registered today, so this offers
	 * exactly that. If a second project folder is ever added to PROJECT_CONFIGS,
	 * revisit whether this agent should see it.
	 */
	const access = await bridgeAccess({
		includeDirectTools: true,
		includeEntityResolution: true,
		includeConceptCatalog: true,
		includeKnowledgeBase: true,
	});
	/**
	 * What the agent's tools are told about this session. Nothing run-specific is
	 * written into the workspace: the tools are shared, linked in below, and read
	 * these on every command. SA_CONTEXT_TOKEN is added per turn, in ask().
	 */
	const runEnv: Record<string, string> = {
		SA_DASHBOARD_ID: dashboardId,
		SA_PROGRAM_DIR: ws.programDir,
		...(process.env.SCRIPT_BRIDGE_URL ? { SA_BRIDGE_URL: process.env.SCRIPT_BRIDGE_URL } : {}),
	};

	if (access) {
		linkToolFolders(cwd, TOOL_LINKS);

		/**
		 * The session's grants and its program directory, registered on the server.
		 *
		 * This is what `dash/run-resolver`, `dash/validate` and `dash/publish` are
		 * checked against. The agent's tools send only the directory from their
		 * environment, and everything that decides its reach is looked up here — so
		 * there is no argument it can change to widen anything.
		 */
		/* Tool grants come from the same registry `./run-tool` uses, so a tool the
		 * agent can test with is one the resolver it writes can actually call. */
		const toolGrants = directToolIds();
		registerWorkspace({ dashboardId, programDir: ws.programDir, grants, toolGrants }, resolveDir(dashboardId));

		/**
		 * So `./validate` works before anything has been published.
		 *
		 * It loads `manifest.ts` first, and only publish used to write one — so on
		 * a new dashboard every validate failed with "No manifest.ts" and the agent
		 * reasoned, correctly from what it could see, that publishing was the way
		 * to typecheck. That inverts the gate: validate is what catches a bad prop
		 * before a reader sees it.
		 *
		 * Rewritten on every open, not only on create, for the same reason the
		 * workspace is re-synced above: the title or the grants may have changed
		 * since the conversation started.
		 */
		const row = locationEntry(dashboardId);
		writeManifest(ws.programDir, {
			dashboardId,
			title: row?.name || dashboardId,
			description: row?.description,
			grants,
			toolGrants,
		});

		await writeInstructions(cwd, ws.programRelPath, grants, access.entityTypes ?? [], describeTools(TOOL_LINKS));
	} else {
		await writeInstructions(cwd, ws.programRelPath, [], []);
		fs.writeFileSync(
			path.join(cwd, 'NO-DATA-ACCESS.txt'),
			'The data bridge is unavailable. You cannot check whether anything is possible, ' +
				'so do not build a dashboard — say the data is unreachable.',
			'utf-8',
		);
	}

	const { session } = await createAgentSession({
		cwd,
		agentDir,
		modelRuntime: runtime,
		model: model as never,
		/* No `tools` list: pi's defaults are read, bash, edit and write, and this
		 * agent needs all four. Bash is replaced by one without a timeout. */
		customTools: [bashWithoutTimeout(cwd, createBashToolDefinition, createLocalBashOperations, runEnv)],
		/* Deterministic cwd + continueRecent is what makes a conversation survive
		 * a backend restart, rather than only the process. */
		sessionManager: SessionManager.continueRecent(cwd),
	});

	/**
	 * Rebuild the transcript, so reopening a dashboard after a restart shows the
	 * conversation rather than an empty pane.
	 *
	 * Unconditional now. This was guarded by `session.messages.length > 0` —
	 * which is exactly the array that is empty on a resumed session, so the guard
	 * skipped the rebuild in precisely the case it existed for. See
	 * `seedTranscript` for what replaced it.
	 */
	const transcript = seedTranscript(session, dashboardId);

	const live: Live = {
		session,
		running: false,
		transcript,
		buffer: '',
		lastActive: Date.now(),
		model: `${WANTED_PROVIDER}/${(model as { id?: string }).id ?? WANTED_MODEL}`,
		env: runEnv,
	};
	/* Subscribe once, at creation — pi publishes through the session's own event
	 * stream, not through an option on prompt(). */
	attach(dashboardId, live);
	return live;
}

/**
 * The standing instructions, with everything situational filled in.
 *
 * The prompt on disk is a template. What varies between one project and the
 * next — which tools exist, which components the contract permits, which SQL
 * the connected sources actually speak — arrives as a placeholder, resolved
 * here, from the thing itself.
 *
 * ### Why this replaced three files in the workspace
 *
 * An earlier version wrote `TOOLS.txt`, `COMPONENTS.txt` and
 * `WHERE-THINGS-ARE.txt` beside the agent and told it to read them. That is a
 * turn spent fetching what could have been given, and worse, a turn the agent
 * may simply not spend — the same affordance problem that had half the old
 * system never opening the concept catalogue. Instructions the agent must go
 * and get are instructions it might not have.
 *
 * ### Why the SQL rules come from the SDK
 *
 * `promptLoader.loadDatabaseRulesForType` already owns the map from a source
 * type to its engine, including that an Excel or CSV source is queried through
 * DuckDB rather than the deployment's own database. Writing a second copy of
 * that map would be a second thing to get wrong, and getting it wrong means
 * handing the agent authoritative-sounding syntax for the wrong dialect.
 */
/**
 * Every semantic model the granted sources define, as prompt text.
 *
 * Name and description only. What a model's metrics and dimensions are is what
 * `./semantic manifest` is for, and pasting all of it here would be most of a
 * context window spent on models the question does not touch.
 */
async function describeSemanticModels(grants: readonly string[]): Promise<string> {
	const lines: string[] = [];

	for (const source of grants) {
		try {
			const listed = (await listSemanticModels(source)) as unknown;
			const models = Array.isArray(listed) ? listed : (listed as { models?: unknown[] })?.models;
			if (!Array.isArray(models)) continue;

			for (const entry of models) {
				const model = entry as { name?: unknown; description?: unknown };
				const name = typeof model?.name === 'string' ? model.name : null;
				if (!name) continue;
				const description = typeof model?.description === 'string' ? model.description.trim() : '';
				lines.push(description ? `  ${name} — ${description}` : `  ${name}`);
			}
		} catch {
			/* A source with no semantic layer is the normal case, not a failure. */
		}
	}

	return lines.length
		? [...new Set(lines)].join('\n')
		: '  (none found when this conversation opened — run `./semantic models` to check)';
}

async function writeInstructions(
	cwd: string,
	programRelPath: string,
	grants: readonly string[],
	entityTypes: readonly string[] = [],
	shims: readonly ToolSummary[] = [],
): Promise<void> {
	let template: string;
	try {
		template = fs.readFileSync(AGENTS_MD_SOURCE, 'utf-8');
	} catch (err: any) {
		console.warn(
			`[dashboard-builder] no AGENTS.md at ${AGENTS_MD_SOURCE} — running without standing instructions: ${err?.message ?? err}`,
		);
		return;
	}

	/* The tools, as describeTools() read them from the linked folders — each
	 * with the one line from its own header, so a tool cannot change out from
	 * under its description, and a tool that is not there is not listed.
	 *
	 * Grouped by the phase of work, and ordered within it: the order the tools
	 * are needed, not the order they sit on disk. The grouping is by NAME,
	 * deliberately: a phase is this agent's idea of its own work, not a property
	 * of the tool — the common tools serve other agents, and none of them should
	 * teach this one how to sequence itself.
	 *
	 * Nothing is dropped. A tool no phase claims falls into the last group rather
	 * than disappearing — silently omitting a tool is how one goes unused. */
	const PHASES: { title: string; order: string[] }[] = [
		{
			title: 'Ground it — everything here comes before you write a line of SQL',
			order: [
				'dash/inventory',
				'tools/sources',
				'tools/find-concept',
				'tools/get-concept',
				'tools/find-kb',
				'tools/get-kb',
				'tools/run-tool',
				'tools/find-entity',
				'tools/get-entity',
				'tools/find-schema',
				'tools/get-schema',
				'tools/query',
			],
		},
		{ title: 'Build it', order: ['dash/component', 'dash/run-resolver'] },
		{ title: 'Ship it', order: ['dash/validate', 'dash/publish'] },
	];

	const width = Math.max(...shims.map((s) => s.name.length));
	const line = (s: ToolSummary) => `  ${s.name.padEnd(width)}  ${s.summary}`;

	const claimed = new Set<string>();
	const groups: string[] = [];
	for (const phase of PHASES) {
		const present = phase.order
			.map((name) => shims.find((s) => s.name === name))
			.filter((s): s is ToolSummary => Boolean(s));
		if (!present.length) continue;
		present.forEach((s) => claimed.add(s.name));
		groups.push(`${phase.title}\n${present.map(line).join('\n')}`);
	}

	const rest = shims.filter((s) => !claimed.has(s.name));
	if (rest.length) groups.push(`Also available\n${rest.map(line).join('\n')}`);

	const tools = groups;

	const where = [
		`program directory   ${programRelPath}/`,
		`  manifest.ts       written for you — do not edit, it is regenerated on publish`,
		`  data/<key>.ts     one resolver per panel`,
		`  view.tsx          the single view program`,
		`contract types      src/dashboard-builder/contract/types.ts  (read it; do not edit it)`,
		``,
		`This directory is yours and it persists. What you wrote last time is still here,`,
		`and what is published has been copied in — so a small change is a small edit,`,
		`not a rebuild.`,
		``,
		`layout.json is deliberately absent. It belongs to whoever arranged the dashboard,`,
		`and publishing never touches it.`,
	].join('\n');

	const rules = grants.length
		? (
				await Promise.all(
					Array.from(new Set(grants.map(sourceTypeOf).filter(Boolean))).map((type) =>
						promptLoader.loadDatabaseRulesForType(type),
					),
				)
			).join('\n\n---\n\n')
		: 'No sources are connected, so there is nothing to query.';

	/**
	 * The concept catalogue is deliberately NOT injected here.
	 *
	 * The components index is, and the reasoning differs: components are fixed,
	 * and the agent needs them to write any view at all. Concepts change as the
	 * project's rules are written, and a list baked into the instructions at
	 * session start goes stale mid-conversation while `./concept-catalog` does
	 * not. The agent runs it — see AGENTS.md, "The order of work", step 2.
	 */
	/**
	 * Step 2 of "The order of work" names `./resolve-entities` two steps before
	 * `./sources` — the one place the resolvable entity types were listed. So the
	 * agent was told to resolve a name before it was told what is resolvable, and
	 * a question about a vendor on a project with no vendor catalogue cost a turn
	 * to find that out.
	 *
	 * Both branches end in an instruction, never in "this step does not apply":
	 * no catalogue does not make the name-matching problem go away, it removes
	 * the shortcut — the fallback (read the column's distinct values) is the
	 * same one step 4 already teaches.
	 *
	 * Inherits the staleness of every other `bridgeAccess` field: a source
	 * connected mid-conversation does not reach the conversation that is already
	 * open. No worse than `./sources`, which is a baked string literal, and both
	 * are fixed by the same re-sync.
	 */
	const entityResolution = entityTypes.length
		? [
				'```',
				`tools/find-entity "<the name, as the question spells it>"`,
				'```',
				'',
				'The kinds of name this project has indexed:',
				'',
				...entityTypes.map((t) => `  ${t}`),
				'',
				'Pass the mention on its own — the search covers all of those. `--type` is only a hint, so a',
				'type you guess wrong costs nothing; read the [type] on each hit before using its id, then',
				'`tools/get-entity --type "<type>" <id>` for the column to filter on. A name that is not one',
				'of these kinds has no catalogue entry: read the distinct values of the column you will',
				'filter on and match there instead.',
			].join('\n')
		: [
				'This project has no entity catalogue, so there is nothing to resolve a name against. Read',
				'the distinct values of the column you will filter on and match there instead.',
			].join('\n');

	/**
	 * The semantic models, read when the conversation opens.
	 *
	 * They used to be named in the prompt by hand, which put one project's models
	 * — four of the eight it actually had — in the file every project loads.
	 *
	 * Best effort, and the fallback is an instruction rather than an apology: a
	 * layer that will not load is a reason to ask the tool, not a reason to have
	 * no models. Inherits the same staleness as the entity types above, for the
	 * same reason: a model added mid-conversation does not reach a conversation
	 * already open, and the prompt says so.
	 */
	const models = await describeSemanticModels(grants);

	const filled = template
		.replace('{{WHERE_THINGS_ARE}}', where)
		.replace('{{ENTITY_RESOLUTION}}', entityResolution)
		.replace('{{SEMANTIC_MODELS}}', models)
		.replace('{{TOOLS}}', tools.length ? tools.join('\n\n') : '  (none — the data bridge is unavailable)')
		.replace('{{DASHBOARD_COMPONENTS}}', componentIndex())
		.replace('{{DATABASE_RULES}}', rules);

	fs.writeFileSync(path.join(cwd, 'AGENTS.md'), filled, 'utf-8');
}

async function ensure(dashboardId: string, grants: readonly string[]): Promise<Live> {
	const existing = sessions.get(dashboardId);
	if (existing) return existing;
	const live = await create(dashboardId, grants);
	sessions.set(dashboardId, live);
	startSweeper();
	return live;
}

/**
 * Releases conversations nobody is using.
 *
 * A session holds a model connection and the whole conversation, so one per
 * dashboard alive forever is a slow leak on a server hosting many. Eviction is
 * on idleness rather than on a caller disconnecting — a closed tab is not the
 * same as finished work — and a running turn is never interrupted.
 *
 * Losing a session costs the in-memory transcript, not the conversation: pi
 * keeps its own session file under the deterministic cwd.
 */
let sweeper: NodeJS.Timeout | null = null;

function startSweeper(): void {
	if (sweeper) return;
	sweeper = setInterval(() => {
		const cutoff = Date.now() - IDLE_TIMEOUT_MS;
		for (const [id, live] of sessions) {
			if (live.running || live.lastActive > cutoff) continue;
			live.session.dispose?.();
			sessions.delete(id);
			console.log(`  dashboard builder session released after inactivity: ${id}`);
		}
		if (sessions.size === 0 && sweeper) {
			clearInterval(sweeper);
			sweeper = null;
		}
	}, 60_000);
	sweeper.unref?.();
}

/**
 * Ends a conversation because its dashboard is gone.
 *
 * Distinct from the sweeper, which releases an *idle* session expecting it to be
 * resumed from disk later. This one is final: the files are about to be removed,
 * so the workspace record goes with it — otherwise the bridge would go on
 * treating that directory as a live session and grant a resolver run against a
 * program that no longer exists.
 *
 * A turn in flight is not waited for. It is already writing into a directory
 * that is being deleted, and letting it finish would only produce a longer,
 * more confusing failure.
 */
export function releaseSession(dashboardId: string): boolean {
	const live = sessions.get(dashboardId);
	if (live) {
		live.session.dispose?.();
		sessions.delete(dashboardId);
	}

	/* Keyed by directory, so it has to be rebuilt from the id — the same path
	 * `ensureWorkspace` produces. */
	closeWorkspace(path.join(RUNTIME_DIR, dashboardId, 'dashboard-programs', dashboardId));

	return Boolean(live);
}

/* ---------------------------------- api ----------------------------------- */

export interface BuilderState {
	dashboardId: string;
	running: boolean;
	transcript: BuilderUpdate[];
}

/**
 * The conversation so far.
 *
 * Resumes the session when one exists on disk but is not live — after a backend
 * restart, or once the idle sweeper has released it. Without that, reopening a
 * dashboard shows an empty pane while the conversation sits intact in pi's
 * session file: the worst of both, since it looks lost and is not.
 *
 * The directory check is what keeps this cheap. A dashboard nobody has talked
 * to has no directory, so opening it does not create a session or a model
 * connection just to answer "nothing yet".
 */
export async function getState(dashboardId: string, grants: readonly string[] = []): Promise<BuilderState> {
	const live = sessions.get(dashboardId);
	if (live) {
		return { dashboardId, running: live.running, transcript: live.transcript };
	}

	if (!fs.existsSync(path.join(RUNTIME_DIR, dashboardId))) {
		return { dashboardId, running: false, transcript: [] };
	}

	try {
		const resumed = await ensure(dashboardId, grants);
		return { dashboardId, running: resumed.running, transcript: resumed.transcript };
	} catch (err: any) {
		/* A conversation we cannot reopen is not a reason to fail the page — the
		 * dashboard itself renders fine without it. */
		console.warn(`[dashboard-builder] could not resume "${dashboardId}": ${err?.message ?? err}`);
		return { dashboardId, running: false, transcript: [] };
	}
}

export interface AskOptions {
	/** Sources a build from this conversation may be granted. The caller's decision. */
	grants: readonly string[];
	onUpdate?: (update: BuilderUpdate) => void;
	/**
	 * A panel the person pointed at before typing. Its `Panel` id.
	 *
	 * Turned into one line ahead of their message rather than mixed into it, so
	 * the transcript keeps what they actually wrote and a reload does not show
	 * them words they never said.
	 */
	panelId?: string;
}

/**
 * One turn.
 *
 * Awaited rather than fire-and-forget. `onUpdate` is how a caller watches a turn
 * that takes minutes: this agent grounds, writes, runs and publishes inside one
 * turn, so there is a lot to watch and a long time to wait for it.
 */
/** What a finished turn cost, and how it ended. Recorded by the caller. */
export interface TurnOutcome {
	answer: string;
	error?: string;
	status: 'success' | 'error' | 'aborted';
	latencyMs: number;
	model: string;
	usage?: { inputTokens: number; outputTokens: number; costUSD: number };
	/** Every tool call this turn made, grouped by tool. Saved as the turn's debug trace. */
	trace?: ToolTrace;
}

/**
 * What the catalogue looked like when this conversation last read it.
 *
 * The system prompt is built once, when the session opens, and pi keeps it for
 * the life of the conversation — so the instructions cannot carry this. What
 * can go stale instead is the agent's own memory: it ran `./concept-catalog` on
 * its first turn, got an answer, and has no reason to ask again. A reviewer
 * approving a rule two messages later does not change what is in its context.
 *
 * Names and ids, because both matter to a caller: an id addresses a rule and a
 * name is checked against it.
 */
const catalogueSeen = new Map<string, string>();

/**
 * Has the catalogue moved since this conversation last looked?
 *
 * False on the first turn whatever the answer — there is no stale reading to
 * correct yet, and the instructions already say to read it. False on failure
 * too: this decides whether to add a sentence, and nothing about it is worth
 * failing a turn for.
 */
/**
 * Proposals this conversation made that nobody has decided on yet.
 *
 * Neither decision reliably moves the catalogue: a rejection leaves it as it
 * was, and an approved change keeps its id and name. In memory: the backend runs
 * continuously.
 */
interface TrackedProposal {
	name: string;
	/** The approved concept a revision would change. */
	replaces?: number;
}
const pendingProposals = new Map<string, Map<number, TrackedProposal>>();

export function trackProposal(dashboardId: string, id: number, name: string, replaces?: number): void {
	let tracked = pendingProposals.get(dashboardId);
	if (!tracked) pendingProposals.set(dashboardId, (tracked = new Map()));
	const known = tracked.get(id);
	tracked.set(id, { name, replaces: replaces ?? known?.replaces });
}

type Decided = { id: number; name: string };

/**
 * Proposals approved or rejected since the last turn, each reported once.
 *
 * An accepted revision's row is deleted, so a missing revision was approved and
 * is reported under the concept it changed. A missing new proposal was deleted
 * by hand and is dropped.
 */
async function decidedProposals(dashboardId: string): Promise<{ approved: Decided[]; rejected: Decided[] }> {
	const approved: Decided[] = [];
	const rejected: Decided[] = [];
	const tracked = pendingProposals.get(dashboardId);
	if (!tracked?.size) return { approved, rejected };

	for (const [id, proposal] of [...tracked]) {
		try {
			const row = (await getConcept(id)).data as { name: string; status?: string; supersedes?: number | null };
			if (row.status === 'draft' || row.status === 'proposed') continue;
			if (row.status === 'approved') approved.push({ id, name: row.name });
			/* An accepted change is kept as `superseded`; report it under the concept it changed. */
			if (row.status === 'superseded' && (row.supersedes ?? proposal.replaces) != null) {
				approved.push({ id: (row.supersedes ?? proposal.replaces)!, name: row.name });
			}
			if (row.status === 'rejected') rejected.push({ id, name: row.name });
			tracked.delete(id);
		} catch (err) {
			if (!(err instanceof Error && /not found/.test(err.message))) continue;
			if (proposal.replaces != null) approved.push({ id: proposal.replaces, name: proposal.name });
			tracked.delete(id);
		}
	}
	return { approved, rejected };
}

/** One paragraph per outcome, so `personsWords` can strip each off a reloaded transcript. */
function decisionNote(decided: Decided[], outcome: 'approved' | 'rejected'): string {
	if (!decided.length) return '';
	const names = decided.map((d) => `"${d.name}" (id ${d.id})`).join(', ');
	const one = decided.length === 1;
	const tail =
		outcome === 'approved' ? (one ? 'was approved and is now in force' : 'were approved and are now in force') : one ? 'was rejected' : 'were rejected';
	return `The concept${one ? '' : 's'} you proposed, ${names}, ${tail}.\n\n`;
}

async function catalogueMoved(dashboardId: string): Promise<boolean> {
	try {
		const rows = (await getConceptCatalog()).data as Array<{ id?: number; name?: string }>;
		const now = rows
			.map((c) => `${c.id}:${c.name}`)
			.sort()
			.join('|');
		const before = catalogueSeen.get(dashboardId);
		catalogueSeen.set(dashboardId, now);
		return before !== undefined && before !== now;
	} catch {
		return false;
	}
}

export async function ask(
	dashboardId: string,
	text: string,
	opts: AskOptions,
): Promise<TurnOutcome> {
	const started = Date.now();
	const live = await ensure(dashboardId, opts.grants);
	if (live.running) {
		return {
			answer: '',
			error: 'This conversation is already working on something.',
			status: 'error',
			latencyMs: Date.now() - started,
			model: live.model,
		};
	}

	/**
	 * Cost is cumulative, so a turn's cost is the difference.
	 *
	 * `getSessionStats()` walks the whole entry log and totals it, which is the
	 * right number for "what has this conversation cost" and the wrong one for
	 * "what did this turn cost". Taking a reading either side and subtracting is
	 * the only way to get the second, and the second is what a per-turn record
	 * means.
	 */
	const before = readStats(live);

	const off = opts.onUpdate
		? onBuilderUpdate((id, u) => {
				if (id === dashboardId) opts.onUpdate!(u);
			})
		: null;
	/* Set here as well as on `agent_start`: the guard above reads it, and two
	 * calls arriving before the first event would both get through. */
	live.running = true;
	live.lastActive = Date.now();
	emit(dashboardId, live, { type: 'user', text, at: Date.now() });
	emit(dashboardId, live, { type: 'state', running: true });

	/* A new turn can carry a new rule, so `./publish` asks again. */
	resetProposedThisTurn(dashboardId);
	/* The debug trace covers this turn only. */
	startTrace(dashboardId);

	/**
	 * The selected panel, stated once, above the message.
	 *
	 * A person who clicked a panel and typed "make this a bar chart" has said
	 * everything they mean; the word "this" only resolves if the agent is told
	 * what was pointed at. Prefixed rather than appended so it is read as context
	 * before the instruction, and kept out of the transcript above so the pane
	 * shows their words rather than ours.
	 *
	 * Deliberately says *unless they say otherwise*: someone can attach a panel
	 * and then ask a question about the whole dashboard, and the sentence they
	 * wrote outranks the panel they clicked.
	 */
	const scoped = opts.panelId
		? `The person has selected the panel \`${opts.panelId}\` on screen. Their message is about ` +
			`that panel unless they say otherwise. It may be a question or an edit — read what they ` +
			`wrote and decide. Answer a question without touching a file. For an edit, change that ` +
			`panel's block in the view and the resolvers it uses, and leave every other panel alone.

${text}`
		: text;

	/**
	 * Said only when it actually moved.
	 *
	 * A line that appears every turn is one the agent learns to skip, and it
	 * would cost a sentence on messages where nothing changed. This one is a
	 * fact: something was approved, rejected or written since it last looked.
	 */
	const moved = (await catalogueMoved(dashboardId))
		? `The rule catalogue has changed since your last turn — something was approved or ` +
			`written. Whatever you remember reading from it is out of date; run tools/find-concept ` +
			`again before you rely on it.\n\n${scoped}`
		: scoped;

	/* No body: `personsWords` strips these paragraphs off a reloaded transcript. */
	const { approved, rejected } = await decidedProposals(dashboardId);
	const prompt = decisionNote(approved, 'approved') + decisionNote(rejected, 'rejected') + moved;

	/**
	 * The prompt, as the agent receives it.
	 *
	 * A scoped turn reads differently from the message in the pane, and the only
	 * other way to tell which one went out is to infer it from what the agent
	 * did. Printed whole rather than summarised — it is a handful of lines and
	 * the point is to see the exact words.
	 */
	console.log(
		`[dashboard-builder] ${dashboardId}: prompt to agent` +
			`${opts.panelId ? ` (panel ${opts.panelId})` : ''} —\n${prompt}`,
	);

	/**
	 * Whose data this turn may read.
	 *
	 * The agent's tools run in their own processes and call the bridge over HTTP,
	 * so the request's identity does not travel with them on its own. A token
	 * minted from this turn's context — the SDK runs DASH_BUILDER_REQ as the
	 * sender — goes into the tools' environment and is revoked when the turn
	 * ends, so each query is policed as the person who asked, and a token never
	 * outlives the turn it was granted for.
	 */
	const contextToken = mintContextToken();
	if (contextToken) {
		live.env.SA_CONTEXT_TOKEN = contextToken;
	} else {
		delete live.env.SA_CONTEXT_TOKEN;
		console.warn(`[dashboard-builder] ${dashboardId}: no request identity — the agent's queries will run anonymous.`);
	}

	try {
		/* No options: pi's prompt() takes the text alone, and everything worth
		 * watching arrives through the subscription set up in attach(). */
		await live.session.prompt(prompt);
		await publishUnpublishedWork(dashboardId, live);
		return {
			answer: live.session.getLastAssistantText()?.trim() ?? '',
			status: 'success',
			latencyMs: Date.now() - started,
			model: live.model,
			usage: spent(before, readStats(live)),
			trace: takeTrace(dashboardId),
		};
	} catch (err: any) {
		const message = err?.message ?? String(err);
		emit(dashboardId, live, { type: 'error', text: message, at: Date.now() });
		return {
			answer: '',
			error: message,
			/* An abort is not a fault, and the two are worth telling apart in
			 * analytics — a page of aborts means people changing their minds, a
			 * page of errors means something is broken. */
			status: /abort/i.test(message) ? 'aborted' : 'error',
			latencyMs: Date.now() - started,
			model: live.model,
			usage: spent(before, readStats(live)),
			trace: takeTrace(dashboardId),
		};
	} finally {
		revokeContextToken(contextToken);
		delete live.env.SA_CONTEXT_TOKEN;
		const used = spent(before, readStats(live));
		console.log(`[dashboard-builder] ${dashboardId}: ${usageLine(used, Date.now() - started)}`);
		live.running = false;
		live.lastActive = Date.now();
		emit(dashboardId, live, { type: 'state', running: false });
		off?.();
	}
}

/** Opens every follow-up the backend sends, so a resumed transcript can leave them out. */
const PUBLISH_CHECK = 'Automatic publish check:';

/** Follow-ups after a refused publish before the turn stops and shows why. */
const PUBLISH_FOLLOW_UPS = 2;

/** Content hash of the program files, to tell whether a follow-up changed anything. */
function programPrint(programDir: string): string {
	const hash = createHash('sha1');
	for (const rel of programFilesIn(programDir)) hash.update(rel).update(fs.readFileSync(path.join(programDir, rel)));
	return hash.digest('hex');
}

/**
 * Publishes what the turn left unpublished, and keeps the agent working when publish refuses.
 *
 * The refusal goes back to the agent as a follow-up in the same turn, never shown as the
 * person's message. A refusal repeated with nothing changed means the agent chose to stop,
 * and the turn ends with the reason on screen.
 */
async function publishUnpublishedWork(dashboardId: string, live: Live): Promise<void> {
	const record = findSessionFor(dashboardId);
	if (!record) return;

	let previous: { reason: string; print: string } | null = null;
	for (let followUps = 0; ; followUps++) {
		if (!(await hasUnpublishedChanges(record))) return;

		emit(dashboardId, live, { type: 'tool', text: 'Publishing the dashboard', at: Date.now() });
		const result = await publishSession(record);
		if (result.published) {
			console.log(`[dashboard-builder] ${dashboardId}: published at end of turn`);
			return;
		}

		const reason = result.summary;
		const print = programPrint(record.programDir);
		const stuck = previous && previous.reason === reason && previous.print === print;
		if (stuck || followUps >= PUBLISH_FOLLOW_UPS) {
			emit(dashboardId, live, { type: 'tool', text: `Not published: ${reason.split('\n')[0]}`, at: Date.now() });
			return;
		}
		previous = { reason, print };

		await live.session.prompt(
			`${PUBLISH_CHECK} your changes are not published. ./publish refused:\n\n${reason}\n\n` +
				`Fix what it names, then run ./publish. If you are deliberately leaving the dashboard ` +
				`unpublished — waiting on the person, or the numbers are not right — say so in one sentence and stop.`,
		);
	}
}

/** Cumulative tokens and cost, or zeroes when pi cannot report them. */
const readStats = (live: Live) => readSessionStats(live.session);

export function abort(dashboardId: string): boolean {
	const live = sessions.get(dashboardId);
	if (!live?.running) return false;
	live.session.abort?.();
	return true;
}

/** For diagnostics and the idle sweeper's own tests. */
export function liveConversations(): string[] {
	return [...sessions.keys()];
}

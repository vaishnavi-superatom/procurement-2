import * as fs from 'fs';
import * as path from 'path';

/**
 * The narrator's model session — loading pi, the model connection, and one
 * in-memory session per question.
 *
 * Set up the way dash-builder-sa's dashboard builder does it.
 */

// Pi is pure ESM and this backend compiles to CommonJS; `new Function` keeps
// TypeScript from downlevelling the import into a require() that cannot load it.
type PiModule = typeof import('@earendil-works/pi-coding-agent');
let piModulePromise: Promise<PiModule> | null = null;
function pi(): Promise<PiModule> {
	piModulePromise ??= new Function('m', 'return import(m)')('@earendil-works/pi-coding-agent') as Promise<PiModule>;
	return piModulePromise;
}

/**
 * OpenRouter by default, on the deployment's OPENROUTER_API_KEY — a proxy key
 * is routed through SUPERATOM_LLM_PROXY_URL below. Any pi provider works:
 * `openai-codex` (e.g. gpt-5.6-luna) runs on a ChatGPT login made once with the
 * pi CLI (`pi`, then `/login`). allowModelNetwork lets pi discover models newer
 * than its bundled catalog.
 */
const WANTED_PROVIDER = process.env.NARRATOR_PROVIDER || 'openrouter';
const WANTED_MODEL = process.env.NARRATOR_MODEL || 'deepseek/deepseek-v4.1-flash';

const PROMPT_FILE = path.join(process.cwd(), '.prompts', 'narrator', 'system.md');

/**
 * How to write money and large numbers, from the deployment's SA_LOCALE and
 * SA_CURRENCY — the same settings the rest of the backend formats by (sa.ts).
 * Without it the narrator saw raw figures and wrote "₹235 million" on an
 * Indian deployment.
 */
function numberRule(): string {
	const locale = process.env.SA_LOCALE || 'en-IN';
	const currency = process.env.SA_CURRENCY || 'INR';
	if (locale === 'en-IN' || currency === 'INR') {
		return `Write amounts in ${currency} using Indian units — lakh and crore (e.g. ₹2.35 Cr, ₹45.6 L) — never million or billion.`;
	}
	return `Write amounts the way ${locale} writes them, in ${currency} (e.g. 235M, 2.35B with the ${currency} symbol).`;
}

/** Created once per process and reused: it holds the credentials and the model list. */
let runtimePromise: ReturnType<PiModule['ModelRuntime']['create']> | null = null;
async function modelRuntime() {
	const { ModelRuntime, getAgentDir } = await pi();
	const agentDir = getAgentDir();
	runtimePromise ??= ModelRuntime.create({
		authPath: `${agentDir}/auth.json`,
		modelsStorePath: `${agentDir}/models-store.json`,
		allowModelNetwork: true,
	}).then((runtime) => {
		// A per-client `sk-prox-…` OpenRouter key is only valid at our proxy, so
		// route OpenRouter through it — the same override the SDK's dashboard
		// agent and llm.ts apply. Unset (a real key), requests go to OpenRouter.
		const proxy = process.env.SUPERATOM_LLM_PROXY_URL;
		if (proxy) {
			runtime.registerProvider('openrouter', {
				baseUrl: `${proxy.replace(/\/+$/, '')}/openrouter`,
				apiKey: process.env.OPENROUTER_API_KEY,
			});
		}
		return runtime;
	});
	runtimePromise.catch(() => { runtimePromise = null; });
	return runtimePromise;
}

/**
 * Loads pi and the model connection ahead of the first question.
 *
 * Measured: on a cold process the first session took 9.6 s to set up (loading
 * pi, the model runtime and its model list) before the opening line could even
 * be asked for; every later one took 16 ms. Paid at startup, the first question
 * is as quick as the rest. Never throws: a narrator that cannot start says so
 * when a question arrives.
 */
export async function warmNarratorSession(): Promise<void> {
	try {
		const t = Date.now();
		const runtime = await modelRuntime();
		await runtime.getAvailable(WANTED_PROVIDER);
		console.log(`[narrator] warmed up in ${((Date.now() - t) / 1000).toFixed(1)}s`);
	} catch (err: any) {
		console.warn(`[narrator] warm-up failed: ${err?.message ?? err}`);
	}
}

/** A fresh session for one question: the narrator prompt, no tools, nothing on disk. */
export async function createNarratorSession(): Promise<{ session: any; model: string }> {
	const piMod = await pi();
	const runtime = await modelRuntime();
	const available = await runtime.getAvailable(WANTED_PROVIDER);
	// Unlike the dashboard builder, no fallback to another model: a narrator
	// quietly running on something else is harder to judge than one that says
	// it could not start.
	const model = available.find((m) => m.id === WANTED_MODEL);
	if (!model) {
		throw new Error(
			`${WANTED_PROVIDER}/${WANTED_MODEL} is not available` +
			(available.length ? ` (have: ${available.map((m) => m.id).join(', ')})` : ' — authorise it in a terminal: run `pi`, then `/login`'),
		);
	}

	// Instructions are read per session so an edit applies to the next question
	// without a restart. No context files, skills or extensions: the narrator must
	// not pick up the repo's AGENTS.md and start behaving like a coding agent.
	const cwd = process.cwd();
	const agentDir = piMod.getAgentDir();
	const resourceLoader = new piMod.DefaultResourceLoader({
		cwd,
		agentDir,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPrompt: `${fs.readFileSync(PROMPT_FILE, 'utf-8').trimEnd()}\n\n## Numbers\n\n- ${numberRule()}\n`,
	});
	await resourceLoader.reload();

	const { session } = await piMod.createAgentSession({
		cwd,
		agentDir,
		modelRuntime: runtime,
		// In memory: a narration session lives exactly as long as one question.
		sessionManager: piMod.SessionManager.inMemory(cwd),
		model,
		// Off, not 'minimal': measured, 'minimal' still let DeepSeek think for
		// 100-300 tokens before a one-line update (2.5-4 s); off writes ~10 (~1.4 s).
		thinkingLevel: 'off',
		// It talks, it does not act. No shell, no file access.
		noTools: 'all',
		resourceLoader,
	});
	return { session, model: `${WANTED_PROVIDER}/${model.id}` };
}

/**
 * What a session has used so far: tokens and pi's list-price cost. One session
 * per question, so at stop this IS the question's narration cost.
 */
export function costLine(session: any): string {
	try {
		const s = session?.getSessionStats?.();
		return `${s?.tokens?.input ?? 0} in / ${s?.tokens?.output ?? 0} out, $${(s?.cost ?? 0).toFixed(4)}`;
	} catch {
		return 'unavailable';
	}
}

import * as fs from 'fs';
import * as path from 'path';
import type { BridgeAccess } from './data-tools';

/**
 * The answer agent's instructions, filled for this run and this OS. Kept free
 * of backend imports so it can be checked on its own, for either platform.
 */

// Windows gets PowerShell-native tools and syntax: codex runs every command
// there in PowerShell, which cannot run the bash tools Linux uses.
export const IS_WINDOWS = process.platform === 'win32';

const PROMPT_DIR = path.join(process.cwd(), '.prompts', 'coding-agents', 'answer-agent');
const BASE_PROMPT = path.join(PROMPT_DIR, 'base.md');

/**
 * The Python a Windows agent should call, found on PATH. The Microsoft Store
 * stubs under WindowsApps answer `python` by opening the Store, so they are skipped.
 */
let pythonExe: string | null | undefined;
function windowsPython(): string | null {
	if (pythonExe !== undefined) return pythonExe;
	const dirs = (process.env.Path ?? process.env.PATH ?? '').split(';').filter(d => d && !/WindowsApps/i.test(d));
	pythonExe = ['python3', 'python', 'py'].find(n => dirs.some(d => fs.existsSync(path.join(d, `${n}.exe`)))) ?? null;
	return pythonExe;
}

/** The tool list in this OS's shell syntax: `core` for base.md, `all` for the full list. */
function osTools(kind: 'core' | 'all'): string {
	const file = path.join(PROMPT_DIR, 'os', IS_WINDOWS ? 'windows' : 'linux', `${kind}.md`);
	const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8').trimEnd() : '';
	if (!IS_WINDOWS) return text;
	const py = windowsPython();
	return text.replace('{{PYTHON}}', py
		? `For any computation, write it to a \`.py\` file and run \`${py} <file>.py\`; never \`${py} -c\`.`
		: 'There is no Python here: compute in SQL.');
}

/**
 * Fill every placeholder the instructions can carry. Run over the final file,
 * so the text is right whether it came from a composed domain or the plain
 * system.md, and whatever the shared parts in the graph hold.
 */
export function fillInstructions(text: string, access: BridgeAccess | null): string {
	const sources = access?.sources.length
		? `Sources (pass the id to tools/query): ${access.sources.map(s => `${s.id}${s.type ? ` (${s.type})` : ''}`).join(', ')}`
		: 'Sources: none connected. Say you cannot query the data.';
	return text
		.replace('{{SOURCES}}', sources)
		.replace('{{TOOLS}}', () => osTools('core'))
		.replace('{{TOOLS_ALL}}', () => osTools('all'));
}

/**
 * base.md with its `{{SOURCES}}` line filled from the live source list. Named
 * up front because, unnamed, the agent spent three calls finding the source id.
 */
export function basePrompt(access: BridgeAccess | null): string {
	const base = fs.existsSync(BASE_PROMPT) ? fs.readFileSync(BASE_PROMPT, 'utf-8').trim() : '';
	return fillInstructions(base, access);
}

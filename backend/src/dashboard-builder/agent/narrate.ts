/**
 * What a command is doing, said the way a person would say it.
 *
 * The agent is asked to narrate its own work, and when it does, this is the
 * quieter second line under what it said. But an instruction is not a guarantee:
 * a turn where the model forgets to narrate would otherwise be three silent
 * minutes, or worse, a wall of shell in front of someone who wanted a dashboard.
 * So the floor is set here, on the server, where it does not depend on the model
 * remembering anything.
 *
 * **Only the shims are translated.** Anything else is shown as it was typed.
 * Inventing a friendly phrase for an arbitrary command would mean guessing at
 * intent, and a confidently wrong description is worse than a literal one.
 *
 * Kept in its own module rather than in `session.ts` because it is pure string
 * handling with no dependencies — which is what makes it testable without
 * loading pi, the SDK and a websocket.
 */
import * as path from 'path';

const trim = (s: string | undefined) => (s ?? '').replace(/^['"]|['"]$/g, '').trim();

/**
 * The shape of a query, not the query.
 *
 * A page of SQL is not a progress note. What someone watching wants to know is
 * which table is being read and roughly what for.
 */
function summariseSql(raw: string): string {
	const sql = trim(raw).replace(/\s+/g, ' ');
	const from = sql.match(/\bFROM\s+"?([A-Za-z0-9_]+)"?/i);
	const grouped = /\bGROUP\s+BY\b/i.test(sql);
	if (!from) return sql.slice(0, 60);
	return grouped ? `grouping ${from[1]}` : `reading ${from[1]}`;
}

/** What a program file is called, in the words the bash patterns below use. */
function fileNoun(raw: unknown): string {
	if (typeof raw !== 'string' || !raw) return 'a file';
	const file = raw.replace(/\\/g, '/');
	if (/(^|\/)view\.tsx$/.test(file)) return 'the dashboard layout';
	const resolver = file.match(/(?:^|\/)data\/([^/]+)\.ts$/);
	return resolver ? `the ${resolver[1]} query` : path.basename(file);
}

/** First match wins, so the more specific patterns come first. */
const NARRATION: { match: RegExp; say: (m: RegExpMatchArray) => string }[] = [
	{ match: /^\.\/inventory\b/, say: () => 'Looking at what this dashboard already has' },
	{ match: /^\.\/sources\b/, say: () => 'Checking which data sources are available' },
	{ match: /^\.\/schema-search\s+(.+)$/, say: (m) => `Searching the schema for ${trim(m[1])}` },
	{ match: /^\.\/concept-catalog\b/, say: () => 'Reading the verified business rules' },
	{ match: /^\.\/knowledge-base\b.*"query"\s*:\s*"([^"]+)"/, say: (m) => `Looking up "${m[1]}"` },
	{ match: /^\.\/knowledge-base\b/, say: () => 'Reading the knowledge base' },
	{ match: /^\.\/resolve-entities\s+(.+)$/, say: (m) => `Resolving ${trim(m[1])}` },
	{ match: /^\.\/component\s+(\S+)/, say: (m) => `Checking how to use ${trim(m[1])}` },
	{ match: /^\.\/query\s+\S+\s+(.+)$/, say: (m) => `Querying the data — ${summariseSql(m[1] ?? '')}` },
	{ match: /^\.\/run-resolver\s+(\S+)/, say: (m) => `Running ${trim(m[1])} against the data` },
	{ match: /^\.\/validate\b/, say: () => 'Checking the dashboard compiles' },
	{ match: /^\.\/publish\b/, say: () => 'Publishing the dashboard' },
	{ match: /^cat\s+>\s*\S*data\/(\S+?)\.ts/, say: (m) => `Writing the ${trim(m[1])} query` },
	{ match: /^cat\s+>\s*\S*view\.tsx/, say: () => 'Writing the dashboard layout' },
	{ match: /^cat\s+(\S+)/, say: (m) => `Reading ${path.basename(trim(m[1]))}` },
];

export function describe(toolName: string, args: unknown): string {
	/* pi's file tools. The path only — a write carries the whole file in its
	 * arguments, and none of that belongs in a chat pane. */
	const input = (args ?? {}) as { path?: unknown; command?: string };
	if (toolName === 'read') return `Reading ${fileNoun(input.path)}`;
	if (toolName === 'write') return `Writing ${fileNoun(input.path)}`;
	if (toolName === 'edit') return `Editing ${fileNoun(input.path)}`;

	if (toolName !== 'bash') return toolName.replace(/_/g, ' ');
	const command = input.command ?? '';
	const flat = command.replace(/\s+/g, ' ').trim();

	for (const rule of NARRATION) {
		const m = flat.match(rule.match);
		if (m) return rule.say(m);
	}
	return flat.slice(0, 120);
}

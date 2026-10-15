/**
 * The last line of defence on what the narrator says.
 *
 * The prompt already forbids SQL, identifiers and paths; this drops an update
 * that has them anyway, rather than show a person a table name.
 */

const UNSAFE: Array<[RegExp, string]> = [
	[/\bselect\b[\s\S]*\bfrom\b/i, 'sql'],
	[/\b(?:group|order)\s+by\b|\b(?:inner|left|right|outer)\s+join\b/i, 'sql'],
	[/\bwhere\s+\w+\s*(?:=|<|>|like\b|in\b)/i, 'sql'],
	[/`/, 'code'],
	[/\b\w+_\w+\b/, 'identifier'],
	// ./x, /x, C:\x, or a/b/c — but not "and/or".
	[/(?:^|\s)(?:\.{1,2}\/|\/\w|[A-Za-z]:\\)|\w+\/\w+\/\w+/, 'path'],
	[/\.(?:json|jsonl|md|sql|ts|js|csv|txt)\b/i, 'file name'],
	[/\b(?:find|get)-(?:concept|entity|schema)\b|\btools?\b/i, 'tool name'],
];

/** Why an update must not be shown, or null when it is fine. */
export function unsafeReason(text: string): string | null {
	for (const [re, why] of UNSAFE) if (re.test(text)) return why;
	return null;
}

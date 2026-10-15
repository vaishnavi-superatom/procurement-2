/**
 * The dashboard components, shaped for an agent to read.
 *
 * Two views of one list (`contract/registered.ts`, pushed by the browser):
 *
 *  - `componentIndex()` — one line each, grouped. This goes in the prompt.
 *  - `componentDetail()` — everything about one, by name, when it is wanted.
 *
 * ### Why the prompt gets the index and not the props
 *
 * The full list is small enough to carry, and carrying it is what makes this
 * simple: the agent already knows every component that exists and can only ask
 * for one that does. Props, caveats and usage would triple the length for detail
 * that only matters after a choice is made, so those are fetched by name.
 *
 * ### There is deliberately no search
 *
 * An earlier version had one, reasoning from `./concept-catalog` — which takes
 * no arguments, could not be pointed at a question, and was quietly abandoned by
 * half the system as a result. That rule is real but it does not apply here:
 * concepts are *not* in the prompt and may number in the hundreds, so they have
 * to be aimed at. Components are all in the prompt. An agent holding the whole
 * list has nothing to search and cannot ask for a name that is not on it.
 */
import { contract, type PropMeta } from './contract/registered';

/** The order kinds appear in the prompt: what a panel is made of, roughly in order. */
const KIND_ORDER = [
	'data',
	'structure',
	'display',
	'filter',
	'status',
	'format',
	'environment',
] as const;

const KIND_TITLE: Record<string, string> = {
	data: 'Data and parameters',
	structure: 'Structure',
	display: 'Showing data',
	filter: 'Filters',
	status: 'States every panel must handle',
	format: 'Formatting',
	environment: 'Environment',
};

/**
 * One line per component, grouped by kind. Injected into the prompt.
 *
 * Deliberately not the props: a signature per entry would triple the length for
 * information that is only needed once a choice is made, and the choice is made
 * from the purpose.
 */
export function componentIndex(): string {
	const components = contract();
	const seen = new Set<string>();
	const sections: string[] = [];

	for (const kind of KIND_ORDER) {
		const rows = components.filter((entry) => entry.kind === kind);
		if (!rows.length) continue;
		rows.forEach((row) => seen.add(row.name));
		sections.push(
			`${KIND_TITLE[kind] ?? kind}\n` +
				rows.map((row) => `  ${row.name} — ${row.purpose}`).join('\n'),
		);
	}

	/* A kind nobody listed above still has to appear. Silently dropping a
	 * component here would recreate exactly the problem the registry solved. */
	const rest = components.filter((entry) => !seen.has(entry.name));
	if (rest.length) {
		sections.push(`Other\n` + rest.map((row) => `  ${row.name} — ${row.purpose}`).join('\n'));
	}

	return sections.join('\n\n');
}

/**
 * One component, by name, ready to print. `undefined` if there is no such name.
 *
 * Case-insensitive because that is the only mismatch worth tolerating — the
 * agent is reading the name off a list it was given, so anything beyond a
 * capitalisation slip means it has invented something, and inventing is better
 * answered with "no such component" than with a guess.
 */
export function componentDetail(name: string): string | undefined {
	const needle = name.trim().toLowerCase();
	const entry = contract().find((c) => c.name.toLowerCase() === needle);
	if (!entry) return undefined;

	const lines = [`${entry.name}  (${entry.kind})`, ``, entry.purpose];
	if (entry.useWhen) lines.push(``, `When to use`, `  ${entry.useWhen}`);
	if (entry.props) lines.push(``, ...renderProps(entry.props));
	if (entry.notes) lines.push(``, `Notes`, `  ${entry.notes}`);
	return lines.join('\n');
}

/* --------------------------------- props ----------------------------------- */

const IMPORTANCE_RANK: Record<string, number> = { required: 0, recommended: 1, optional: 2 };

/**
 * The props, in the order they should be read rather than the order they were
 * written.
 *
 * Two orderings, because a flat alphabetical list is what the old single-string
 * `props` effectively was and it hid the thing that matters: `BarChart` has
 * fifteen props, three of which the chart cannot render without. Required first,
 * then the ones an agent cannot tell are important from the type — a `yAxis` is
 * optional to the compiler and not optional to a reader trying to work out what
 * they are looking at.
 *
 * Groups win over importance when a component declares them, because at fifteen
 * props "which of these are about the axes" is the question being asked; within
 * a group importance still orders. Importance stays visible either way, as a tag
 * on the line.
 */
function renderProps(props: Record<string, PropMeta>): string[] {
	const entries = Object.entries(props);
	const grouped = entries.some(([, meta]) => typeof meta === 'object' && meta.group);

	/* `.map(propLine)` would pass the array index as the indent. */
	if (!grouped) return ['Props', ...sortProps(entries).map((item) => propLine(item))];

	/* First-appearance order: the author's grouping is deliberate, and sorting it
	 * alphabetically would put "axes" before "data" on every chart. */
	const order: string[] = [];
	const byGroup = new Map<string, [string, PropMeta][]>();
	const loose: [string, PropMeta][] = [];

	for (const item of entries) {
		const meta = item[1];
		const group = typeof meta === 'object' ? meta.group : undefined;
		if (!group) {
			loose.push(item);
			continue;
		}
		if (!byGroup.has(group)) {
			byGroup.set(group, []);
			order.push(group);
		}
		byGroup.get(group)!.push(item);
	}

	/* Ungrouped first and unheaded, rather than swept into a group called "other".
	 * On `Panel` the ungrouped four are `id`, `children`, `title` and `subtitle` —
	 * the ones you cannot skip — and filing them under "other" would both bury
	 * them below the sizing props and imply they are the leftovers. */
	const lines = ['Props', ...sortProps(loose).map((item) => propLine(item))];
	for (const group of order) {
		/* Bracketed so a heading cannot be read as a prop. It was printed as a bare
		 * indented word, and an agent took `axes` — a group holding xAxis/yAxis —
		 * for a prop called `axes`, wrote it, and lost a validate round trip to it. */
		lines.push(`  [${group}]`);
		lines.push(...sortProps(byGroup.get(group)!).map((item) => propLine(item, '    ')));
	}
	return lines;
}

const sortProps = (entries: [string, PropMeta][]): [string, PropMeta][] =>
	[...entries].sort(([, a], [, b]) => rank(a) - rank(b));

const rank = (meta: PropMeta): number =>
	typeof meta === 'string' ? IMPORTANCE_RANK.optional : (IMPORTANCE_RANK[meta.importance ?? 'optional'] ?? 2);

/**
 * One prop, and its caution on a line of its own.
 *
 * The caution is separated rather than run into the description because it is a
 * different kind of claim — the description says what the prop does, the caution
 * says what happens when it is used wrongly — and because a paragraph that mixes
 * the two gets skimmed as one.
 */
function propLine([name, meta]: [string, PropMeta], indent = '  '): string {
	if (typeof meta === 'string') return `${indent}${name} — ${meta}`;

	const tag = meta.importance && meta.importance !== 'optional' ? ` (${meta.importance})` : '';
	const fallback = meta.default !== undefined ? `  [default: ${JSON.stringify(meta.default)}]` : '';
	const head = `${indent}${name}${tag} — ${meta.description}${fallback}`;
	return meta.caution ? `${head}\n${indent}    ${meta.caution}` : head;
}

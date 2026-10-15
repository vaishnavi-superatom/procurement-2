/**
 * Taking a panel out of a program for good.
 *
 * Hiding a panel is the reader's own business and lives in `layout.json`, which
 * is why the delete key can be undone and why it costs nothing. This is the
 * other half of that gesture: when the arrangement is saved, whatever is still
 * hidden stops being part of the program at all.
 *
 * ### Why this is a parse and not a regex
 *
 * A panel is a top-level `<Panel>` element in `view.tsx`, and its rows come from
 * a `usePanelData` binding declared above the return. Both have to go, and the
 * second one conditionally: **resolvers are shared**. One `summary` commonly
 * feeds three metric panels, and deleting its file because one of the three went
 * away would break the other two. So the binding is removed only once nothing
 * left in the file reads it, and the resolver file follows the binding.
 *
 * TypeScript's parser gives the exact source range of every node, so the file is
 * spliced rather than reprinted. Reprinting would reformat generated code the
 * agent reads again on its next turn, and turn a one-panel deletion into a
 * whole-file diff.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { dashboardDir } from './registry';
import { WORKSPACE_ROOT } from './agent/workspace';

export interface PanelDeletion {
	/** Panels whose element was found and removed. */
	panels: string[];
	/** Resolvers deleted with them, because nothing reads them any more. */
	resolvers: string[];
	/** Ids asked for that the view does not contain. Not an error — see below. */
	missing: string[];
}

const NOTHING: PanelDeletion = { panels: [], resolvers: [], missing: [] };

const parse = (source: string): ts.SourceFile =>
	ts.createSourceFile('view.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
	visit(node);
	node.forEachChild((child) => walk(child, visit));
}

type JsxNode = ts.JsxElement | ts.JsxSelfClosingElement;

const isJsx = (node: ts.Node): node is JsxNode =>
	ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node);

const tagOf = (node: JsxNode): string =>
	ts.isJsxElement(node) ? node.openingElement.tagName.getText() : node.tagName.getText();

/** A string-valued JSX attribute, written either bare or inside braces. */
function attr(node: JsxNode, name: string): string | null {
	const attributes = ts.isJsxElement(node) ? node.openingElement.attributes : node.attributes;
	for (const property of attributes.properties) {
		if (!ts.isJsxAttribute(property) || property.name.getText() !== name) continue;
		const value = property.initializer;
		if (value && ts.isStringLiteralLike(value)) return value.text;
		if (value && ts.isJsxExpression(value) && value.expression && ts.isStringLiteralLike(value.expression)) {
			return value.expression.text;
		}
	}
	return null;
}

/** Splices ranges out back-to-front, so earlier offsets stay valid. */
function cut(source: string, ranges: ReadonlyArray<readonly [number, number]>): string {
	let out = source;
	for (const [start, end] of [...ranges].sort((a, b) => b[0] - a[0])) {
		out = out.slice(0, start) + out.slice(end);
	}
	return out;
}

const countPanels = (source: string): number => {
	let n = 0;
	walk(parse(source), (node) => {
		if (isJsx(node) && tagOf(node) === 'Panel') n += 1;
	});
	return n;
};

/**
 * Where an element's line really begins.
 *
 * Whitespace between JSX children is a `JsxText` node rather than trivia, so an
 * element's own start is the `<` and nothing else. Cutting from there leaves the
 * newline and indent that used to sit in front of it, which shows up as a line
 * of spaces where the panel used to be. Swallowing that sibling is what keeps
 * the generated file looking generated.
 */
function indentStart(node: JsxNode): number {
	const parent = node.parent;
	if (!parent || (!ts.isJsxElement(parent) && !ts.isJsxFragment(parent))) return node.getStart();
	const index = parent.children.indexOf(node as ts.JsxChild);
	const previous = index > 0 ? parent.children[index - 1] : undefined;
	/* `getFullStart`, not `getStart`: the latter skips trivia, and for a node whose
	 * entire content is whitespace that means it reports its own end. */
	if (previous && ts.isJsxText(previous) && previous.getText().trim() === '') return previous.getFullStart();
	return node.getStart();
}

function removePanels(source: string, ids: ReadonlySet<string>): { source: string; removed: string[] } {
	const ranges: Array<[number, number]> = [];
	const removed: string[] = [];

	walk(parse(source), (node) => {
		if (!isJsx(node) || tagOf(node) !== 'Panel') return;
		const id = attr(node, 'id');
		if (!id || !ids.has(id)) return;
		removed.push(id);
		ranges.push([indentStart(node), node.getEnd()]);
	});

	return { source: cut(source, ranges), removed };
}

interface Declared {
	name: string;
	/** Set when the statement is a `usePanelData` binding, so a file can go too. */
	resolver?: string;
	start: number;
	end: number;
}

/* Both hooks bind a resolver to a name. `useFilterOptions` is the same binding
 * against the reader's unapplied values, and a filter panel that goes takes its
 * options query with it exactly as a chart panel takes its own. */
const RESOLVER_HOOKS = new Set(['usePanelData', 'useFilterOptions']);

const panelDataResolver = (init: ts.Expression): string | undefined => {
	if (!ts.isCallExpression(init) || !RESOLVER_HOOKS.has(init.expression.getText())) return undefined;
	const first = init.arguments[0];
	return first && ts.isStringLiteralLike(first) ? first.text : undefined;
};

const callsAnything = (node: ts.Node): boolean => {
	let found = false;
	walk(node, (child) => {
		if (ts.isCallExpression(child)) found = true;
	});
	return found;
};

/**
 * Statements that may be removed once nothing reads them.
 *
 * Two kinds, and the second is the one this was missing. A `usePanelData`
 * binding is obvious. The other is a plain derivation from one — the generator
 * writes `const s = summary.data?.[0]` and every panel then reads `s` rather
 * than `summary`. Delete those panels and `s` is dead, but `summary` still
 * *looks* read because `s` mentions it, so the binding and its resolver survive
 * as a query nothing displays.
 *
 * "Calls nothing" is what keeps this safe. `useParam` declares a filter to the
 * host as a side effect of being called, so an unread parameter is still doing
 * something and must stay.
 */
function removable(file: ts.SourceFile): Declared[] {
	const found: Declared[] = [];
	walk(file, (node) => {
		if (!ts.isVariableStatement(node)) return;
		const declarations = node.declarationList.declarations;
		/* A single declarator per statement is what the generator writes. Anything
		 * else is hand-edited, and removing half of it is worse than leaving it. */
		if (declarations.length !== 1) return;
		const declaration = declarations[0]!;
		if (!ts.isIdentifier(declaration.name) || !declaration.initializer) return;

		const resolver = panelDataResolver(declaration.initializer);
		if (!resolver && callsAnything(declaration.initializer)) return;

		found.push({
			name: declaration.name.text,
			resolver,
			start: node.getFullStart(),
			end: node.getEnd(),
		});
	});
	return found;
}

/** Mentions of `name` anywhere outside its own declaration. */
function stillRead(file: ts.SourceFile, declared: Declared): boolean {
	let used = false;
	walk(file, (node) => {
		if (used || !ts.isIdentifier(node) || node.text !== declared.name) return;
		if (node.getStart() >= declared.start && node.getEnd() <= declared.end) return;
		used = true;
	});
	return used;
}

function pruneDead(source: string): { source: string; resolvers: string[] } {
	let current = source;
	const resolvers: string[] = [];

	/**
	 * Repeated, because removing one statement orphans the next.
	 *
	 * `s` only becomes dead once the panels reading it are gone, and `summary`
	 * only becomes dead once `s` is. One pass would stop after `s` and leave the
	 * query behind. The bound is a stop, not a budget: each pass removes at least
	 * one statement, and a generated view has nothing like ten links in a chain.
	 */
	for (let pass = 0; pass < 10; pass += 1) {
		const file = parse(current);
		const dead = removable(file).filter((declared) => !stillRead(file, declared));
		if (!dead.length) break;
		for (const declared of dead) if (declared.resolver) resolvers.push(declared.resolver);
		current = cut(
			current,
			dead.map((declared) => [declared.start, declared.end] as const),
		);
	}

	return { source: current, resolvers };
}

/** A resolver name is a file name, so it may not climb out of `data/`. */
const safeName = (name: string): boolean =>
	Boolean(name) && !name.includes('..') && !path.isAbsolute(name) && !/[\\/]/.test(name);

function removeResolver(programDir: string, name: string): void {
	if (!safeName(name)) return;
	for (const extension of ['.ts', '.tsx']) {
		const file = path.join(programDir, 'data', `${name}${extension}`);
		if (fs.existsSync(file)) fs.rmSync(file);
	}
}

/**
 * The agent's working copy, brought level by hand.
 *
 * `ensureWorkspace` refreshes that copy from what is published every time a
 * conversation opens, but it copies and overwrites — it never removes. Without
 * this the deleted resolver would sit in the workspace as an orphan for the
 * agent to find and wonder about.
 */
function mirrorIntoWorkspace(dashboardId: string, view: string, resolvers: readonly string[]): void {
	const programDir = path.join(WORKSPACE_ROOT, dashboardId, 'dashboard-programs', dashboardId);
	if (!fs.existsSync(programDir)) return;
	const viewPath = path.join(programDir, 'view.tsx');
	if (fs.existsSync(viewPath)) fs.writeFileSync(viewPath, view);
	for (const name of resolvers) removeResolver(programDir, name);
}

/**
 * Removes panels from a dashboard's program, and any resolver left unread.
 *
 * An id the view does not contain is reported in `missing` rather than thrown:
 * the arrangement can name a panel the program no longer has — the agent may
 * have removed it in a conversation since — and refusing to save the whole
 * arrangement over one stale entry helps nobody.
 */
export function deletePanels(dashboardId: string, ids: readonly string[]): PanelDeletion {
	if (!ids.length) return NOTHING;

	const programDir = dashboardDir(dashboardId);
	const viewPath = path.join(programDir, 'view.tsx');
	if (!fs.existsSync(viewPath)) return { ...NOTHING, missing: [...ids] };

	const original = fs.readFileSync(viewPath, 'utf8');
	const before = countPanels(original);
	const removed = removePanels(original, new Set(ids));
	if (!removed.removed.length) return { ...NOTHING, missing: [...ids] };

	const pruned = pruneDead(removed.source);

	/**
	 * The result has to parse back to exactly the panels we meant to leave.
	 *
	 * Splicing by source range is only as good as the ranges, and the failure
	 * mode of getting one wrong is a view that no longer compiles — which,
	 * written to disk, is a working dashboard replaced by a broken one. Cheaper
	 * to count than to recover from.
	 */
	const after = countPanels(pruned.source);
	if (after !== before - removed.removed.length) {
		throw new Error(
			`Deleting ${removed.removed.join(', ')} would have left the view with ${after} panels ` +
				`instead of ${before - removed.removed.length}. Nothing was changed.`,
		);
	}

	fs.writeFileSync(viewPath, pruned.source);
	for (const name of pruned.resolvers) removeResolver(programDir, name);
	mirrorIntoWorkspace(dashboardId, pruned.source, pruned.resolvers);

	return {
		panels: removed.removed,
		resolvers: pruned.resolvers,
		missing: ids.filter((id) => !removed.removed.includes(id)),
	};
}

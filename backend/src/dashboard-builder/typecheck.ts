/**
 * Typechecks a generated program against the real contract.
 *
 * ### Why this exists
 *
 * The guard used to prove two things about a view: that it imports only
 * permitted names, and that it compiles. Both were checked with **esbuild**,
 * which strips types without reading them — so a view could name every import
 * legally, parse perfectly, and still be wrong about what those imports take.
 *
 * That is not hypothetical. The first dashboard this agent built shipped three
 * prop errors through a passing guard:
 *
 *  - `<Panel span={12} h={1}>` — the props are `defaultW`/`minW`, so every panel
 *    got `undefined` for its size, computed `NaN` columns, and rendered as a
 *    sliver. That is what the reader saw.
 *  - `<ErrorNote onRetry={…}>` — the prop is `retry`, so all four error branches
 *    had a dead button nobody would notice until a resolver failed.
 *  - `useParam({ type: 'enum' })` — not a parameter type.
 *
 * Every one is a compile error the moment anything actually reads the types.
 *
 * ### The same argument as the publish gate
 *
 * The prompt already said which props each component takes, and the agent could
 * have run `./component Panel` to be sure. It did neither, correctly-ish: it had
 * seen `span` and `h` in a stored layout and generalised. Instructions are hopes.
 * *A dashboard is never the first place a query runs* is enforced by refusing to
 * publish an unrun resolver; this is the same rule for the view.
 *
 * ### How the contract is resolved
 *
 * `@contract` is mapped straight at the frontend source, so the types checked
 * against are the real components rather than a description of them that could
 * drift. That is also why `index.ts` exports every contract name — at runtime
 * they are read off a published global and the exports are never used, but a
 * type checker needs a module it can resolve.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import type { GuardViolation } from './contract/types';

const FRONTEND = path.join(process.cwd(), '..', 'frontend');
const CONTRACT_ENTRY = path.join(FRONTEND, 'src', 'dash-contract', 'index.ts');

/**
 * The previous program, kept so the next one can reuse it.
 *
 * Creating a program means parsing React's declarations and the whole contract —
 * a second or more, every time. Handing the old program back as `oldProgram`
 * lets TypeScript keep every source file whose contents have not changed, which
 * for a validate between two agent turns is all of them but one or two.
 *
 * Validate runs on nearly every turn, and the difference between a check that
 * costs 100ms and one that costs two seconds is whether it stays a check or
 * becomes something to route around.
 */
let previous: ts.Program | undefined;

const OPTIONS: ts.CompilerOptions = {
	jsx: ts.JsxEmit.ReactJSX,
	target: ts.ScriptTarget.ES2020,
	module: ts.ModuleKind.ESNext,
	moduleResolution: ts.ModuleResolutionKind.Bundler,
	strict: true,
	noEmit: true,
	/* The contract's own dependencies — React, ECharts — are not what is being
	 * checked here, and reading every one of their declarations would triple the
	 * cost to re-prove something their own builds already prove. */
	skipLibCheck: true,
	baseUrl: FRONTEND,
	paths: { '@contract': [CONTRACT_ENTRY] },
	typeRoots: [path.join(FRONTEND, 'node_modules', '@types')],
};

/** The program's own files — resolvers and the view. Nothing else is reported. */
function programFiles(dir: string): string[] {
	const files: string[] = [];
	const view = path.join(dir, 'view.tsx');
	if (fs.existsSync(view)) files.push(view);

	const data = path.join(dir, 'data');
	if (fs.existsSync(data)) {
		for (const f of fs.readdirSync(data)) {
			if (f.endsWith('.ts')) files.push(path.join(data, f));
		}
	}
	return files;
}

/**
 * A TypeScript diagnostic, said the way the agent needs to hear it.
 *
 * The default flattening produces one long line with the specific mismatch
 * buried at the end — "Type '{ children: Element; id: string; span: number; }'
 * is not assignable to type 'IntrinsicAttributes & PanelProps'. Property 'span'
 * does not exist…". The last clause is the actionable part, so it is pulled to
 * the front and the structural preamble kept as context.
 */
function explain(diagnostic: ts.Diagnostic): { detail: string; fix?: string } {
	const chain = diagnostic.messageText;
	if (typeof chain === 'string') return { detail: chain };

	/* Walk to the innermost message — TypeScript nests general → specific. */
	const messages: string[] = [];
	let node: ts.DiagnosticMessageChain | undefined = chain;
	while (node) {
		messages.push(node.messageText);
		node = node.next?.[0];
	}

	const specific = messages[messages.length - 1]!;
	const general = messages[0]!;

	return {
		detail: specific,
		fix: messages.length > 1 ? general : undefined,
	};
}

/**
 * Typechecks the program in `dir`. An empty result means it is sound.
 *
 * Errors only. TypeScript's suggestions and warnings are advice about style,
 * and a guard that refuses a dashboard over advice is a guard people route
 * around.
 */
export function typecheckProgram(dir: string): GuardViolation[] {
	const files = programFiles(dir);
	if (!files.length) return [];

	/* Without the frontend beside us there is nothing to check against. Silence
	 * is right here rather than a violation: this is a deployment shape we do
	 * not support, not a fault in the program being checked. */
	if (!fs.existsSync(CONTRACT_ENTRY)) return [];

	const program = ts.createProgram({
		rootNames: files,
		options: OPTIONS,
		host: ts.createCompilerHost(OPTIONS, true),
		oldProgram: previous,
	});
	previous = program;

	const own = new Set(files.map((f) => path.resolve(f).toLowerCase()));

	return ts
		.getPreEmitDiagnostics(program)
		.filter((d) => d.category === ts.DiagnosticCategory.Error)
		.filter((d) => d.file && own.has(path.resolve(d.file.fileName).toLowerCase()))
		.map((d): GuardViolation => {
			const { line } = d.file!.getLineAndCharacterOfPosition(d.start ?? 0);
			const { detail, fix } = explain(d);
			return {
				file: path.relative(dir, d.file!.fileName).replace(/\\/g, '/'),
				line: line + 1,
				rule: 'type-error',
				detail,
				fix,
			};
		});
}

/**
 * A filter control offering one choice.
 *
 * `<FilterChoice options={['NZD']} />` renders a dropdown the reader can open,
 * look at, and change nothing with. It reads as a filter that is broken rather
 * than as one with nothing to offer — the same misreading `ErrorNote` exists to
 * prevent for an empty result, arrived at from the other direction.
 *
 * It is the shape a correct process still produces: step 5 of the order of work
 * counts the distinct values of a dimension, and when the answer is one the
 * agent has already written the control before it finds out. So this is not a
 * carelessness check, and the prompt saying "never one option" would not catch
 * it — by the time the count comes back the JSX is on disk.
 *
 * **Syntax only, and deliberately.** A literal `options={[…]}` is the case
 * worth catching and the only one knowable without running anything;
 * `optionsFrom` is a resolver whose row count is not a static fact. That is the
 * boundary between this and `./run-resolver`, which is where a one-row option
 * list actually shows itself.
 *
 * Reported, not fatal. A dashboard with a redundant dropdown is worse than it
 * should be and still correct — refusing to publish it would be a guard that
 * blocks a working page over a cosmetic fault, which is how guards get routed
 * around. `valid` turns on type errors, which are the ones that render wrongly.
 */
export function checkFilterOptions(dir: string): GuardViolation[] {
	const violations: GuardViolation[] = [];

	for (const file of programFiles(dir)) {
		if (!file.endsWith('.tsx')) continue;
		const source = ts.createSourceFile(
			file,
			fs.readFileSync(file, 'utf-8'),
			ts.ScriptTarget.Latest,
			true,
			ts.ScriptKind.TSX,
		);

		const visit = (node: ts.Node): void => {
			if (ts.isJsxAttribute(node) && node.name.getText(source) === 'options') {
				const tag = jsxTagOf(node);
				const initialiser = node.initializer;
				if (
					tag?.startsWith('Filter') &&
					initialiser &&
					ts.isJsxExpression(initialiser) &&
					initialiser.expression &&
					ts.isArrayLiteralExpression(initialiser.expression) &&
					initialiser.expression.elements.length === 1
				) {
					const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
					violations.push({
						file: path.relative(dir, file).replace(/\\/g, '/'),
						line: line + 1,
						rule: 'filter-one-option',
						detail: `<${tag}> offers one option, so the reader cannot change it.`,
						fix:
							'Drop the control and say what it was fixed to in the panel title. If the list ' +
							'is meant to grow, load it with optionsFrom from a resolver instead.',
					});
				}
			}
			ts.forEachChild(node, visit);
		};
		visit(source);
	}

	return violations;
}

/** Controls that write one value, and the one that writes a list. */
const SINGLE_VALUE_FILTERS = new Set(['FilterChoice', 'FilterSearch', 'FilterToggle', 'FilterDate']);
const LIST_VALUE_FILTERS = new Set(['FilterMultiChoice']);

/**
 * Rules that stop a publish, beyond `valid`.
 *
 * Not part of `valid`: that also decides whether a published dashboard renders,
 * and one already live with this fault should keep rendering.
 */
export const PUBLISH_BLOCKING_RULES = new Set(['filter-param-shape']);

/**
 * A param's default must have the shape its control writes.
 *
 * The default decides the param's type, so `useParam({ default: [2] })` on a
 * `FilterChoice` types as a list and holds one value once someone picks. Code
 * reading `.value` as a list then throws in the browser, past a green typecheck.
 *
 * Syntax only: a default that is not a literal is skipped.
 */
export function checkFilterParamShapes(dir: string): GuardViolation[] {
	const violations: GuardViolation[] = [];

	for (const file of programFiles(dir)) {
		if (!file.endsWith('.tsx')) continue;
		const source = ts.createSourceFile(
			file,
			fs.readFileSync(file, 'utf-8'),
			ts.ScriptTarget.Latest,
			true,
			ts.ScriptKind.TSX,
		);

		const shapes = new Map<string, { list: boolean; id: string; text: string }>();
		const collect = (node: ts.Node): void => {
			if (
				ts.isVariableDeclaration(node) &&
				ts.isIdentifier(node.name) &&
				node.initializer &&
				ts.isCallExpression(node.initializer) &&
				node.initializer.expression.getText(source) === 'useParam'
			) {
				const spec = node.initializer.arguments[0];
				if (spec && ts.isObjectLiteralExpression(spec)) {
					const prop = (name: string) =>
						spec.properties.find(
							(p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText(source) === name,
						)?.initializer;
					const def = prop('default');
					const idNode = prop('id');
					const id = idNode && ts.isStringLiteralLike(idNode) ? idNode.text : node.name.text;
					const shape = def ? literalShape(def) : undefined;
					if (shape) shapes.set(node.name.text, { list: shape === 'list', id, text: def!.getText(source) });
				}
			}
			ts.forEachChild(node, collect);
		};
		collect(source);

		const visit = (node: ts.Node): void => {
			if (ts.isJsxAttribute(node) && node.name.getText(source) === 'param') {
				const tag = jsxTagOf(node);
				const value = node.initializer;
				const name =
					value && ts.isJsxExpression(value) && value.expression && ts.isIdentifier(value.expression)
						? value.expression.text
						: undefined;
				const shape = name ? shapes.get(name) : undefined;
				const wantsList = tag && LIST_VALUE_FILTERS.has(tag);
				const wantsSingle = tag && SINGLE_VALUE_FILTERS.has(tag);
				if (shape && ((wantsSingle && shape.list) || (wantsList && !shape.list))) {
					const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
					violations.push({
						file: path.relative(dir, file).replace(/\\/g, '/'),
						line: line + 1,
						rule: 'filter-param-shape',
						detail: wantsSingle
							? `<${tag}> writes one value, but param "${shape.id}" has the list default ${shape.text}.`
							: `<${tag}> writes a list, but param "${shape.id}" has the single default ${shape.text}.`,
						fix: wantsSingle
							? `Give "${shape.id}" a single default (e.g. default: ${singleFrom(shape.text)}), or use FilterMultiChoice.`
							: `Give "${shape.id}" a list default (e.g. default: []), or use a single-value control.`,
					});
				}
			}
			ts.forEachChild(node, visit);
		};
		visit(source);
	}

	return violations;
}

/** 'list' for an array literal, 'single' for a scalar literal, undefined otherwise. */
function literalShape(node: ts.Expression): 'list' | 'single' | undefined {
	if (ts.isArrayLiteralExpression(node)) return 'list';
	if (
		ts.isStringLiteralLike(node) ||
		ts.isNumericLiteral(node) ||
		node.kind === ts.SyntaxKind.NullKeyword ||
		node.kind === ts.SyntaxKind.TrueKeyword ||
		node.kind === ts.SyntaxKind.FalseKeyword ||
		(ts.isPrefixUnaryExpression(node) && ts.isNumericLiteral(node.operand))
	) {
		return 'single';
	}
	return undefined;
}

/** `[2]` → `2`, `[]` → `null`. */
function singleFrom(listText: string): string {
	const inner = listText.trim().replace(/^\[|\]$/g, '').split(',')[0]?.trim();
	return inner ? inner : 'null';
}

/** The component name an attribute belongs to, or undefined outside an element. */
function jsxTagOf(attribute: ts.Node): string | undefined {
	const attributes = attribute.parent;
	if (!attributes || !ts.isJsxAttributes(attributes)) return undefined;
	const element = attributes.parent;
	if (ts.isJsxOpeningElement(element) || ts.isJsxSelfClosingElement(element)) {
		return element.tagName.getText();
	}
	return undefined;
}

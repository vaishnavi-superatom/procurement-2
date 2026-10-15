/**
 * "Is this program fit to mount?" — asked of a **directory**, not a dashboard id.
 *
 * The registry asks it of `dashboard-programs/<id>/`; the builder agent asks it
 * of its own workspace, before anything has been copied anywhere. Same function
 * both times, and that is the point: if the agent's check and the registry's
 * check were two implementations, the interesting failure would be the one where
 * they disagree — the agent reports success and the dashboard is broken.
 *
 * Nothing here runs a query. Compiling proves the programs are well-formed;
 * only `runResolver` proves they are *right*, which is why the builder's loop
 * requires running every resolver and not merely validating.
 */
import * as fs from 'fs';
import * as path from 'path';
import { compileModule } from './compile';
import { compileView, ViewCompileError } from './compile-view';
import { listResolvers } from './resolvers';
import { connectedSourceIds } from './query';
import { typecheckProgram, checkFilterOptions, checkFilterParamShapes } from './typecheck';
import { buildKey, readBuild, writeBuild } from './build-cache';
import { ContractNotRegisteredError } from './contract/registered';
import type {
	DashboardManifest,
	GuardViolation,
	ResolverSummary,
} from './contract/types';

export interface ProgramValidation {
	manifest: DashboardManifest;
	/** True when the **view** compiles — see the note in `validateProgramDir`. */
	valid: boolean;
	violations: GuardViolation[];
	view?: { code: string; version: string; bytes: number };
	resolvers: ResolverSummary[];
}

/**
 * Loads `manifest.ts` from a directory.
 *
 * Exported because the agent's workspace has a manifest too, and it is loaded
 * the same way — compiled and read, not JSON.parsed. A manifest is a `.ts` file
 * so it can be type-checked against the contract like everything else.
 */
export async function loadManifestFrom(dir: string): Promise<DashboardManifest> {
	const file = path.join(dir, 'manifest.ts');
	if (!fs.existsSync(file)) throw new Error(`No manifest.ts in ${dir}`);

	const { module } = await compileModule<{
		manifest?: DashboardManifest;
		default?: DashboardManifest;
	}>(file);
	const manifest = module.manifest ?? module.default;
	if (!manifest?.id) {
		throw new Error('manifest.ts must export `manifest` with an `id`.');
	}
	return manifest;
}

/**
 * A grant naming a source that is not connected.
 *
 * Not fatal, deliberately: the source may be connected later, and refusing to
 * mount would hide every working panel on the dashboard for a reason that has
 * nothing to do with them. It is a violation the catalogue shows, so the cause
 * is visible before a panel fails with it.
 *
 * Silent when nothing at all is connected — that is a backend still starting
 * up, not a bad manifest, and flagging every dashboard during boot trains
 * people to ignore the field.
 */
function checkGrants(manifest: DashboardManifest): GuardViolation[] {
	const connected = connectedSourceIds();
	if (!connected.length) return [];
	return manifest.grants.sources
		.filter((s) => !connected.includes(s))
		.map((s) => ({
			file: 'manifest.ts',
			line: 0,
			rule: 'unknown-source',
			detail: `Granted source "${s}" is not connected in this environment.`,
			fix: `Connected sources: ${connected.join(', ') || 'none'}.`,
		}));
}

export interface ValidateOptions {
	/**
	 * The grants the **caller** authorised, when there is one.
	 *
	 * A manifest listing a source outside this set is a violation rather than a
	 * wider grant. The builder agent writes into its own workspace and could
	 * otherwise hand itself any source by editing one line — this is what makes
	 * `manifest.grants` a statement of what was permitted rather than of what the
	 * program would like.
	 */
	allowedSources?: readonly string[];
	/** Direct-tool ids the caller authorised. Same rule as `allowedSources`. */
	allowedTools?: readonly string[];
	/** Skip compiling the view. For a check that only cares about resolvers. */
	skipView?: boolean;
	/**
	 * Skip the TypeScript pass. **Only for listing.**
	 *
	 * `typecheckProgram` builds a TS program over the contract and React's
	 * declarations — around a second per dashboard, and the dominant cost of
	 * `listDashboards`, which runs it once per dashboard on a page that renders
	 * a name, a description and two dates. Twelve seconds to draw a list of two.
	 *
	 * It is right to keep it everywhere a program is about to be *served* or
	 * published: that is what catches a prop error before a reader sees a page of
	 * broken panels. It is wrong on a path that only needs titles.
	 *
	 * The cost of skipping it here is that `valid` reflects "compiles" and not
	 * "typechecks" for a listed dashboard. The list no longer renders that
	 * distinction — the status chip came off the cards — and anything that acts
	 * on `valid` (serving the module, publishing) goes through the full path.
	 */
	skipTypecheck?: boolean;
}

export async function validateProgramDir(
	dir: string,
	opts: ValidateOptions = {},
): Promise<ProgramValidation> {
	const manifest = await loadManifestFrom(dir);
	const violations = checkGrants(manifest);

	if (opts.allowedSources) {
		const allowed = new Set(opts.allowedSources);
		for (const s of manifest.grants.sources) {
			if (!allowed.has(s)) {
				violations.push({
					file: 'manifest.ts',
					line: 0,
					rule: 'grant-not-authorised',
					detail: `This run was not authorised to grant "${s}".`,
					fix: `Authorised sources: ${[...allowed].join(', ') || 'none'}. Remove the rest — a grant is given to the build, not chosen by it.`,
				});
			}
		}
	}

	/* Tools get the same treatment, for the same reason: a manifest is a statement
	 * of what was permitted, not a request for what would be convenient. */
	if (opts.allowedTools) {
		const allowed = new Set(opts.allowedTools);
		for (const t of manifest.grants.tools ?? []) {
			if (!allowed.has(t)) {
				violations.push({
					file: 'manifest.ts',
					line: 0,
					rule: 'grant-not-authorised',
					detail: `This run was not authorised to grant the tool "${t}".`,
					fix: `Authorised tools: ${[...allowed].join(', ') || 'none'}.`,
				});
			}
		}
	}

	let view: ProgramValidation['view'];
	if (!opts.skipView) {
		/**
		 * The build this program already has, when it is a build of this program.
		 *
		 * Keyed on the sources and the contract together, so the only way to get a
		 * hit is for nothing that affects the output to have moved. Editing a
		 * dashboard rebuilds it; opening one does not.
		 */
		const key = buildKey(dir);
		const cached = readBuild(dir, key);

		/**
		 * Everything this build decided about the program itself.
		 *
		 * Kept apart from `violations`, which also carries the grant checks above.
		 * Those are a property of the *call* — who authorised it — and storing
		 * them would mean serving one caller's permissions to the next.
		 */
		const built: GuardViolation[] = [];

		if (cached) {
			view = cached.view;
			built.push(...cached.violations);
		} else {
			try {
				const compiled = await compileView(dir);
				view = { code: compiled.code, version: compiled.version, bytes: compiled.bytes };
			} catch (err) {
				/**
				 * A missing contract is not a fault in this program.
				 *
				 * `compileView` throws when no browser has registered the components
				 * yet. Recording that as a `view-compile` violation would make the
				 * dashboard `valid: false`, and the registry would cache that against
				 * the current file fingerprint — which never changes, because the
				 * files did not. The dashboard would then stay broken after the
				 * contract arrived.
				 */
				if (err instanceof ContractNotRegisteredError) throw err;

				built.push({
					file: 'view.tsx',
					line: err instanceof ViewCompileError ? (err.diagnostics[0]?.line ?? 0) : 0,
					rule: 'view-compile',
					detail: err instanceof Error ? err.message : String(err),
				});
			}

			/**
			 * Compiling is not checking.
			 *
			 * `compileView` runs esbuild, which strips types rather than reading
			 * them, so a program can pass everything above while being wrong about
			 * what its own components take. The first dashboard built this way
			 * shipped three prop errors through a green guard — one of which gave
			 * every panel an undefined width and rendered the whole page as slivers.
			 * See `typecheck.ts`.
			 *
			 * Run even when the compile failed: a syntax error and a type error are
			 * often the same edit, and reporting only the first costs a round trip.
			 */
			if (!opts.skipTypecheck) built.push(...typecheckProgram(dir));

			/* Outside the `skipTypecheck` guard: this parses one file and resolves
			 * no types, so it does not carry the cost that exemption exists for. */
			built.push(...checkFilterOptions(dir));
			built.push(...checkFilterParamShapes(dir));

			/**
			 * Stored only when it is the whole verdict.
			 *
			 * A run that skipped the typecheck did not decide whether this program
			 * is valid, and writing that out would let a cheap metadata call leave
			 * behind a build that a later reader trusts as checked.
			 */
			if (view && !opts.skipTypecheck) writeBuild(dir, key, { view, violations: built });
		}

		violations.push(...built);
	}

	const resolvers = await listResolvers(dir);

	/**
	 * Valid means the **view** compiles *and* typechecks — not that every
	 * resolver does.
	 *
	 * A broken resolver fails its own panel and nothing else, so it must not stop
	 * the rest of the dashboard mounting. That is per-panel error isolation, and
	 * collapsing the whole page for one bad query is the exact behaviour it
	 * exists to prevent. A blocked resolver is still reported, in
	 * `resolvers[].errors`.
	 *
	 * A **type error is different** and does stop it. It is not confined to one
	 * panel: a component given the wrong props renders wrongly wherever it
	 * appears, and there is no error boundary for "this looks fine and is not".
	 * A type error that only warned would be a violation nobody acts on, which
	 * is how the first dashboard shipped a page of one-column panels.
	 */
	const typeErrors = violations.some((v) => v.rule === 'type-error');

	return {
		manifest,
		valid: opts.skipView ? true : Boolean(view) && !typeErrors,
		violations,
		view,
		resolvers,
	};
}

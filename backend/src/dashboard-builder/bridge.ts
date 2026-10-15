/**
 * The dashboard builder's own bridge endpoints.
 *
 * These are what the agent's shims call: it reads a dashboard with
 * `./inventory`, checks its work with `./run-resolver` and `./validate`, looks
 * up what it may import with `./component`, and ships with `./publish`.
 *
 * They live here rather than in `services/script-bridge.ts` because they only
 * mean anything beside `registry.ts` and `agent/` — the modules in this folder.
 * The bridge is a transport; it should not have to know what a resolver is. It
 * exposes `registerBridgeRoute`, and each feature owns its endpoints the same
 * way collections and coding agents already own theirs.
 *
 * **Three of these compile or execute code from a directory**, which is not
 * something to leave open. Each refuses any directory without an open session
 * registered in `agent/workspaces.ts`, so their reach is exactly the set of live
 * conversations and nothing else on the filesystem.
 */
import { registerBridgeRoute } from '../services/script-bridge';
import { getWorkspace, findSessionFor, recordVerified } from './agent/workspaces';
import { publishSession } from './agent/publish';
import { AGENT_ROWS } from './agent/shims';
import { validateProgramDir } from './validate';
import { runResolver, ResolverError } from './resolvers';
import { getDashboard, dashboardDir } from './registry';
import { publishBuilderUpdate, trackProposal } from './agent/session';
import { componentDetail } from './component-catalog';
import {
	createConcept as createStoredConcept,
	updateConcept as updateStoredConcept,
	getAllConcepts as listAllConcepts,
	listConceptProposals,
	type ConceptRecord as StoredConcept,
} from '../../../database/postgres/src/project-data-db/concepts';
import { createContext, type QueryRecord } from './query';
import {
	describeSemantic,
	explainSemanticQuery,
	listSemanticModels,
	semanticManifest,
	suggestSemantic,
	validateSemanticQuery,
} from './semantic';
import * as fs from 'fs';
import * as path from 'path';

/** The dashboard's own record of what it was asked to be, or null. */
function readStoredSpec(dashboardId: string): unknown {
	try {
		return JSON.parse(fs.readFileSync(path.join(dashboardDir(dashboardId), 'spec.json'), 'utf-8'));
	} catch {
		return null;
	}
}

/**
 * Idempotent, because there is more than one legitimate entry point.
 *
 * The app registers these alongside the collections; a test that starts the
 * bridge on its own must register them too, or every shim call 404s. Making a
 * second call harmless means neither caller has to know about the other.
 */
let registered = false;

/**
 * Dashboards that have written a rule down **during the current turn**.
 *
 * Only so `./publish` knows whether to remind the agent, and per turn rather
 * than per conversation on purpose. A conversation corrects a number, a rule is
 * recorded, and then three messages later a second rule arrives — with a
 * conversation-wide flag the first proposal would silence the reminder for
 * every rule after it, which is the case the reminder exists for.
 *
 * Cleared by `ask()` as each turn opens. In memory and per process: it is a
 * nudge, and the worst a lost entry does is repeat one, where the duplicate-name
 * and one-open-revision refusals take over.
 */
const proposedThisTurn = new Set<string>();

/** Called as a turn begins — see `proposedThisTurn`. */
export function resetProposedThisTurn(dashboardId: string): void {
	proposedThisTurn.delete(dashboardId);
}

/**
 * One `./semantic` call against a source the caller has already settled on.
 *
 * Shared by the dashboard builder's route, which picks the source from the
 * dashboard's grants, and the chat agent's, which picks it from what is
 * connected. Everything after that choice is the same.
 *
 * `fresh` sends `run`'s statements to the source instead of the query cache.
 * `rows` is how many of `run`'s rows are printed; the builder's default is `AGENT_ROWS`.
 */
export async function answerSemantic(
	source: string,
	body: any,
	opts: { fresh: boolean; rows?: number },
): Promise<unknown> {
	const shownRows = opts.rows ?? AGENT_ROWS;
	const verb = typeof body?.verb === 'string' ? body.verb : '';
	const model = typeof body?.model === 'string' ? body.model : '';
	const query = body?.query && typeof body.query === 'object' ? (body.query as any) : null;

	try {
		switch (verb) {
			case 'models':
				return { success: true, result: await listSemanticModels(source) };

			case 'manifest':
				if (!model) return { error: 'usage: ./semantic manifest <model>' };
				return { success: true, result: { text: await semanticManifest(source, model) } };

			case 'search':
				return {
					success: true,
					result: await suggestSemantic(source, String(body?.text ?? '')),
				};

			case 'describe':
				if (!model || !body?.name) return { error: 'usage: ./semantic describe <model> <name>' };
				return { success: true, result: await describeSemantic(source, model, String(body.name)) };

			case 'validate':
				if (!query) return { error: 'usage: ./semantic validate \'<query json>\'' };
				return { success: true, result: await validateSemanticQuery(source, query) };

			case 'explain':
				if (!query) return { error: 'usage: ./semantic explain \'<query json>\'' };
				return { success: true, result: await explainSemanticQuery(source, query) };

			case 'run': {
				if (!query) return { error: 'usage: ./semantic run \'<query json>\'' };
				const controller = new AbortController();
				const queries: QueryRecord[] = [];
				const ctx = createContext({
					grants: [source],
					signal: controller.signal,
					queries,
					fresh: opts.fresh,
				});
				const rows = await ctx.semantic(source, query);
				return {
					success: true,
					result: {
						rowCount: rows.length,
						shown: Math.min(rows.length, shownRows),
						rows: rows.slice(0, shownRows),
						sql: queries.map((q) => q.sql).filter(Boolean),
					},
				};
			}

			default:
				return {
					error:
						'usage: ./semantic models | manifest <model> | search <text> | ' +
						'describe <model> <name> | validate <json> | explain <json> | run <json>',
				};
		}
	} catch (err: any) {
		return { error: err?.message ?? String(err) };
	}
}

export function registerDashBridgeRoutes(): void {
	if (registered) return;
	registered = true;

	/* ------------------------------ the builder ------------------------------ */

	/** Does the program in this workspace compile? */
	registerBridgeRoute('/dash/validate', {
		summarize: (b) => `programDir=${b?.programDir}`,
		async handle(body) {
			const run = getWorkspace(body?.programDir);
			if (!run) return { error: 'No open session for that directory.' };

			try {
				/* allowedSources, so a manifest widened inside the workspace is
				 * reported here rather than discovered at apply time. */
				const v = await validateProgramDir(run.programDir, {
					allowedSources: run.grants,
					allowedTools: run.toolGrants,
				});
				return {
					success: true,
					result: {
						valid: v.valid,
						violations: v.violations,
						/* The compiled code is never returned — it is large, and nothing
						 * the agent does with it beats reading its own source. */
						viewBytes: v.view?.bytes ?? 0,
						resolvers: v.resolvers.map((r) => ({
							name: r.name,
							title: r.title,
							params: r.params,
							output: r.output,
							errors: r.errors,
						})),
					},
				};
			} catch (err: any) {
				return { success: false, error: err?.message ?? String(err) };
			}
		},
	});

	/** The verification primitive, against real data. */
	registerBridgeRoute('/dash/run-resolver', {
		summarize: (b) =>
			`programDir=${b?.programDir}, resolver=${b?.name}, params=${JSON.stringify(b?.params ?? {})}`,
		async handle(body) {
			const run = getWorkspace(body?.programDir);
			if (!run) return { error: 'No open session for that directory.' };
			if (!body?.name) return { error: 'name is required' };

			const params = body.params;
			/**
			 * Anything but a plain object is refused here, loudly.
			 *
			 * `Object.keys()` on a string returns character indices, so a mangled
			 * argument would otherwise surface as "Unknown parameters: 0, 1, 2, ..."
			 * — an error describing a symptom and hiding its cause. Observed:
			 * PowerShell re-quotes a JSON argument, so it arrives double-encoded and
			 * parses to a string.
			 */
			if (
				params !== undefined &&
				params !== null &&
				(typeof params !== 'object' || Array.isArray(params))
			) {
				return {
					success: false,
					code: 'BAD_PARAMS',
					error:
						`params must be a JSON object, got ${typeof params}: ${JSON.stringify(params)}. ` +
						`On PowerShell, single-quote the whole argument.`,
				};
			}

			/* The resolver's own name, not a path. The agent works in a directory
			 * named after the dashboard, so "budget-by-period/totals" is an easy and
			 * actually-observed mistake — three wasted calls before it self-corrected. */
			const bare = String(body.name).replace(/^.*[\\/]/, '').replace(/\.ts$/, '');

			try {
				const result = await runResolver({
					dashboardId: run.dashboardId,
					dir: run.programDir,
					name: bare,
					params: params ?? {},
					/* From the session record, NOT the workspace manifest — a file the
					 * agent can edit must never be the authority on its own reach. */
					grants: [...run.grants],
					toolGrants: [...(run.toolGrants ?? [])],
					/**
					 * The resolver's code always runs; its statements read the query
					 * cache. Those rows came from a real run of the same SQL, and an
					 * edited statement is a new key that goes to the source.
					 */
					fresh: false,
				});

				/**
				 * The run is the verification.
				 *
				 * Recorded here, on the server, from a call that actually executed —
				 * so a panel becomes publishable by being proven rather than by being
				 * claimed. The columns come back from the real result set, and the
				 * hash is taken from the file that produced them.
				 */
				recordVerified(run.programDir, bare, (result.columns ?? []).map((c: any) => c.name));

				return { success: true, result };
			} catch (err: any) {
				/* A refusal is an ANSWER, not a server fault: the agent is meant to
				 * read it, fix its resolver and try again. */
				return {
					success: false,
					code: err instanceof ResolverError ? err.code : 'ERROR',
					error: err?.message ?? String(err),
				};
			}
		},
	});

	/**
	 * The one endpoint that changes what a reader sees.
	 *
	 * It takes no arguments beyond the directory. Not a convenience — the
	 * dashboard, the title and the grants all come from the session record, so
	 * there is no field for the agent to fill in wrongly. That is the same
	 * treatment grants already had, applied to everything else the caller decided:
	 * a conversation attached to a dashboard publishes *that* dashboard.
	 */
	registerBridgeRoute('/dash/publish', {
		summarize: (b) => `programDir=${b?.programDir}`,
		async handle(body) {
			const run = getWorkspace(body?.programDir);
			if (!run) return { error: 'No open session for that directory.' };

			try {
				/* Only the title and description are read from here — `publish` runs
				 * its own full validate against the workspace, which is the one that
				 * decides. */
				/* The same function the automatic end-of-turn publish calls. */
				const result = await publishSession(run);

				/* A reminder to propose any rule the dashboard encodes (via a propose-concept
				 * tool) belongs here once concept approvals exist. Until then the agent has
				 * no way to act on it, so none is sent. */
				return { success: true, result };
			} catch (err: any) {
				return { success: false, error: err?.message ?? String(err) };
			}
		},
	});

	/* --------------------------- reading the system --------------------------- */

	/**
	 * The props and caveats of one component, by name.
	 *
	 * No search: the whole list is already in the agent's instructions, one line
	 * each, so there is nothing to look for and no way to name something that is
	 * not there. This just answers "how do I use this one".
	 */
	registerBridgeRoute('/dash/component', {
		summarize: (b) => `name=${b?.name}`,
		async handle(body) {
			const name = typeof body?.name === 'string' ? body.name : '';
			if (!name) return { error: 'name is required' };

			const text = componentDetail(name);
			if (!text) return { error: `No dashboard component named "${name}".` };

			return { success: true, result: { text } };
		},
	});

	/**
	 * The semantic models — what they define, and what one query would run.
	 *
	 * Read-only, and every verb here is except `run`. That one goes through the
	 * same path a resolver's `ctx.semantic` takes, for the reason `./run-tool`
	 * exists: an agent that can see the number a model gives will write a
	 * resolver against the model, and one that cannot will re-derive it in SQL.
	 */
	registerBridgeRoute('/dash/semantic', {
		summarize: (b) => `verb=${b?.verb} model=${b?.model ?? '-'}`,
		async handle(body) {
			/**
			 * The source comes from the session, not from the agent.
			 *
			 * Same rule as everywhere else here: the shim knows a dashboard id and
			 * nothing about grants, so there is no argument through which a wider
			 * reach could be asked for. `--source` only picks among what the
			 * session already holds, and is only needed when it holds several.
			 */
			const dashboardId = String(body?.dashboardId ?? '');
			/* The session's grants while a conversation is open, the published
			 * manifest's otherwise — the same list `ctx.semantic` is checked
			 * against when a reader opens the dashboard. */
			const granted =
				findSessionFor(dashboardId)?.grants ??
				(await getDashboard(dashboardId, { skipTypecheck: true }).catch(() => null))?.manifest
					?.grants?.sources ??
				[];
			const asked = typeof body?.source === 'string' ? body.source : '';
			const source = asked || (granted.length === 1 ? granted[0] : '');

			if (asked && !granted.includes(asked)) {
				return { error: `Not granted "${asked}". Granted: ${granted.join(', ') || 'none'}` };
			}
			if (!source) {
				return {
					error: granted.length
						? `Several sources are granted — add --source <id>. Granted: ${granted.join(', ')}`
						: 'This dashboard has no granted sources.',
				};
			}

			return answerSemantic(source, body, { fresh: false });
		},
	});

	/** What a dashboard currently contains. */
	registerBridgeRoute('/dash/inventory', {
		summarize: (b) => `dashboardId=${b?.dashboardId}`,
		async handle(body) {
			const dashboardId = body?.dashboardId;
			if (!dashboardId) return { error: 'dashboardId is required' };

			try {
				/* An inventory, not a verdict — the agent runs `./validate` for that,
				 * and it is the one place the answer has to be current. */
				const state = await getDashboard(dashboardId, { skipTypecheck: true });

				/**
				 * Two different lists, and reporting only one of them misled the very
				 * first conversation this agent had.
				 *
				 * `state.grants` is what the dashboard's *published manifest* grants —
				 * empty for a dashboard nobody has built yet, and correctly so. That
				 * was returned as plain `grants`, and the agent read it as "I have no
				 * data access" and told the person their project had no sources. It had
				 * an Excel source connected the whole time.
				 *
				 * What the agent needs is what it can reach *now* — the session's
				 * grants. Both are reported, each named for what it actually is.
				 */
				const session = findSessionFor(dashboardId);

				return {
					success: true,
					result: {
						exists: true,
						id: state.id,
						title: state.title,
						description: state.description,
						valid: state.valid,
						empty: state.empty ?? false,
						violations: state.violations,
						/** What you may query in this conversation. `./sources` has the detail. */
						availableSources: session?.grants ?? [],
						/** What the published manifest declares — empty until the first publish. */
						declaredGrants: state.grants,
						resolvers: state.resolvers.map((r) => ({
							name: r.name,
							title: r.title,
							description: r.description,
							params: r.params,
							output: r.output,
							errors: r.errors,
						})),
						/**
						 * What this dashboard was asked to be, if the agent recorded it.
						 *
						 * `spec.json` is no longer a message between two agents — there is
						 * one — but it is still worth keeping as the dashboard's own note
						 * of what was wanted and what was established about the data. It is
						 * the first thing a later edit should read.
						 */
						spec: readStoredSpec(dashboardId),
					},
				};
			} catch {
				/* Absent is an answer, not a failure: "there is no dashboard yet" is
				 * exactly what the agent needs before proposing to create one. */
				return {
					success: true,
					result: { exists: false, id: dashboardId, note: `No dashboard "${dashboardId}" yet.` },
				};
			}
		},
	});

	/**
	 * A concept the conversation produced, offered for review.
	 *
	 * **Nothing here takes effect.** Every row this writes is unapproved, and the
	 * runtime reads approved concepts only — so the worst outcome of a bad call
	 * is a line in somebody's review queue, never a rule that starts governing
	 * numbers. That is the property that makes it safe to give an agent at all: a
	 * concept body overrides the schema, the knowledge base and the model's own
	 * reasoning, so writing one directly is not the agent's to do.
	 *
	 * ### The agent states its intent, and the server checks it
	 *
	 * `create` or `update`, as a word, rather than inferred from whether an id
	 * happens to be present. An operation that changes a rule somebody approved
	 * should not be reachable by accident, and every other tool here takes a verb
	 * first, so this is also the shape the agent already knows.
	 *
	 * Stating it does not make it true, so each claim is verified:
	 *
	 *   create   refused if that name exists, or is an alias of something.
	 *            The reply carries the id, so the retry is mechanical.
	 *   update   needs the id AND the matching name. An id alone is
	 *            unverifiable — stale or mistyped, it rewrites a different rule
	 *            and nothing in the reply looks wrong. A name alone is ambiguous.
	 *            Two independent facts about one row is what makes a wrong id a
	 *            refusal instead of damage.
	 *
	 * What `update` then does depends on the target, and follows the
	 * concept-builder's rule rather than a second one invented here:
	 *
	 *   approved target  → a revision: a new row pointing at it, left for review
	 *   pending target   → refine that proposal in place, rather than stacking
	 *
	 * And the guard that matters most: one open revision per concept. A
	 * conversation where someone disputes the same number three times should
	 * leave one correction to review, not three.
	 */
	registerBridgeRoute('/dash/concept', {
		summarize: (b) => `name=${b?.name}`,
		async handle(body) {
			/**
			 * Announced on the conversation's stream as well as returned.
			 *
			 * The agent gets a sentence to repeat; the person gets a card with the
			 * rule in it and two decisions to make, and a sentence cannot carry a
			 * body to show or an id to act on. Best effort — a pane nobody is
			 * watching must not fail the write.
			 */
			const announce = (update: Parameters<typeof publishBuilderUpdate>[1]) => {
				const dashboardId = typeof body?.dashboardId === 'string' ? body.dashboardId : '';
				if (!dashboardId) return;
				/* Every path that reaches here has written a row, which is what
				 * `./publish` wants to know — see `proposedThisTurn`. */
				proposedThisTurn.add(dashboardId);
				if (update.type === 'concept') trackProposal(dashboardId, update.id, update.name, update.replaces);
				try {
					publishBuilderUpdate(dashboardId, update);
				} catch {
					/* Nobody listening, or a listener threw. Neither is this call's problem. */
				}
			};

			/* Which dashboard proposed it, kept on the row in `origin_ref`. */
			const proposedBy =
				typeof body?.dashboardId === 'string' && body.dashboardId ? `dashboard:${body.dashboardId}` : undefined;

			const name = typeof body?.name === 'string' ? body.name.trim() : '';
			const conceptBody = typeof body?.body === 'string' ? body.body.trim() : '';
			if (!name) return { error: 'name is required' };
			if (!conceptBody) return { error: 'body is required — the rule itself, written out' };
			if (name.length > 64) return { error: `name exceeds 64 characters: "${name}"` };

			const optionalArray = (value: unknown): string[] | undefined =>
				Array.isArray(value) ? value.map((v) => String(v)).filter(Boolean) : undefined;

			/**
			 * The id of the concept being changed. Required by `update`, refused by
			 * `create`, which has nothing to point at.
			 *
			 * A value that is present but not a positive whole number is refused
			 * rather than coerced: `Number("42x")` is NaN, but `Number("42 ")` is 42,
			 * and silently addressing a row from a sloppy argument is the class of
			 * thing this whole design is avoiding.
			 */
			const updates = body?.updates == null ? null : Number(body.updates);
			if (updates != null && (!Number.isInteger(updates) || updates <= 0)) {
				return { error: `"updates" must be a concept id — got ${JSON.stringify(body?.updates)}` };
			}

			/**
			 * What the agent says it is doing. Checked against the evidence below.
			 *
			 * No default. A missing verb is a call whose intent nobody stated, and
			 * guessing from the arguments is exactly the inference this replaced.
			 */
			const verb = typeof body?.verb === 'string' ? body.verb.trim().toLowerCase() : '';
			if (verb !== 'create' && verb !== 'update') {
				return { error: `First argument must be "create" or "update" — got ${JSON.stringify(body?.verb ?? '')}` };
			}
			if (verb === 'create' && updates != null) {
				return {
					error:
						`"create" writes a new concept and takes no id. To change concept ${updates}, ` +
						`call update instead.`,
				};
			}
			if (verb === 'update' && updates == null) {
				return {
					error:
						`"update" needs the id of the concept to change: {"updates":<id>}. ` +
						`Run ./concept-catalog for the ids. To write a new rule, call create.`,
				};
			}

			/**
			 * `invariant` is not the agent's to hand out.
			 *
			 * An invariant concept is injected into *every* question, whether or not
			 * it is relevant — that is the tier for things like how dates are encoded.
			 * It is the strongest effect a concept can have, and a reviewer reading a
			 * plausible body can easily approve one without noticing the kind. So the
			 * agent proposes it as an ordinary concept and says it should be an
			 * invariant, and a person promotes it.
			 */
			const KINDS = ['formula', 'definition', 'filter', 'lookup', 'join'] as const;
			const kind = typeof body?.kind === 'string' ? body.kind.trim().toLowerCase() : '';
			if (kind && !KINDS.includes(kind as (typeof KINDS)[number])) {
				return {
					error:
						kind === 'invariant'
							? `"invariant" concepts are injected into every question, so they are promoted by a ` +
								`reviewer rather than proposed. Use one of: ${KINDS.join(', ')}, and say in your ` +
								`answer that it should be an invariant.`
							: `Unknown kind "${kind}". Use one of: ${KINDS.join(', ')}.`,
				};
			}

			/**
			 * A rule, not a transcript.
			 *
			 * Generous, because a real concept body carries a formula, a filter and a
			 * join path. The cap exists for the failure where an agent pastes the
			 * conversation, or a query's output, into the field.
			 */
			if (conceptBody.length > 4000) {
				return {
					error:
						`That body is ${conceptBody.length} characters. Write the rule, not the conversation ` +
						`that produced it — under 4000.`,
				};
			}

			const shared = {
				body: conceptBody,
				kind: typeof body?.kind === 'string' ? (body.kind as any) : undefined,
				requires: optionalArray(body?.requires),
				aliases: optionalArray(body?.aliases),
				description: typeof body?.description === 'string' ? body.description : undefined,
				returns: body?.returns && typeof body.returns === 'object' ? (body.returns as any) : undefined,
			};

			/**
			 * The names one rule cites inside another, which is how the vocabulary
			 * holds together.
			 *
			 * A body says `per 'transaction joins'` and that phrase is a real
			 * concept, resolved and injected alongside this one. A correction that
			 * rewrites the rule from memory drops those phrases without meaning to,
			 * and the dependency goes with them. Reported in the reply so the agent
			 * has to look at what it just dropped; the reviewer sees it too, in the
			 * old body shown above the new one.
			 */
			const citations = (text: string) =>
				new Set((text.match(/'[^']{3,80}'/g) ?? []).map((s) => s.slice(1, -1).trim().toLowerCase()));

			/**
			 * What the review card shows beside the body, taken from the stored row
			 * rather than the request: an update inherits the fields it left out, and
			 * the reviewer decides on the concept as it now stands.
			 */
			const asProposed = (row: any) => ({
				kind: row.kind ?? undefined,
				requires: row.requires?.length ? row.requires : undefined,
				aliases: row.aliases?.length ? row.aliases : undefined,
				description: row.description ?? undefined,
				returns: row.returns && Object.keys(row.returns).length ? row.returns : undefined,
			});

			try {
				const all = (await listAllConcepts()).data;
				const key = (value: string) => value.trim().replace(/\s+/g, ' ').toLowerCase();
				const byName = all.find((c) => c.supersedes == null && key(c.name) === key(name));

				/* The id and the name must agree — see the note on the route. The id
				 * comes from `./concept-catalog`, which is where the agent read the
				 * name too, so the two cannot come from different places. */
				if (verb === 'update' && updates != null) {
					const target = all.find((c) => c.id === updates);
					if (!target) {
						return {
							error:
								`No concept with id ${updates}. Run ./concept-catalog and use an id from it, ` +
								`or omit the id to propose a new concept.`,
						};
					}
					if (key(target.name) !== key(name)) {
						return {
							error:
								`Id ${updates} is "${target.name}", not "${name}". Either use the name that id ` +
								`actually has, or use that concept's own id. Renaming a concept is not something ` +
								`to do as part of changing it.`,
						};
					}
					/* Falls through to the same two branches a name match takes, now
					 * against a row the agent named twice over. */
					return await applyTo(target);
				}

				/**
				 * `create` says this is new, so an existing name is a contradiction.
				 *
				 * Refused rather than quietly turned into a correction. The agent
				 * either did not read the catalogue or believes this is a different
				 * idea, and both are worth one turn to settle. The reply carries the
				 * id, so the retry is mechanical.
				 */
				if (byName) {
					return {
						error:
							`"${byName.name}" already exists (id ${byName.id}). If you mean to change it: ` +
							`./propose-concept update "${byName.name}" "<the rule>" '{"updates":${byName.id}}'. ` +
							`If you mean a different idea, give it a name that says how it differs.`,
					};
				}

				/**
				 * And the near miss: the name is free but it is an alias of something.
				 *
				 * This is the duplicate an id cannot prevent — "Billable time" against
				 * a "Billable Hours" that lists it as an alias. Two approved concepts
				 * meaning one thing is worse than none, because both get used and an
				 * answer cannot say which it came from.
				 */
				const byAlias = all.find(
					(c) => c.supersedes == null && (c.aliases ?? []).some((a) => key(a) === key(name)),
				);
				if (byAlias) {
					return {
						error:
							`"${name}" is already an alias of "${byAlias.name}" (id ${byAlias.id}). Change that one ` +
							`with update, or pick a name that is not one of its aliases.`,
					};
				}

				const created = await createStoredConcept({
					name,
					...shared,
					origin: 'user_question',
					originRef: proposedBy,
				} as any);

				announce({
					type: 'concept',
					action: 'created',
					id: created.data.id,
					name: created.data.name,
					body: conceptBody,
					...asProposed(created.data),
					at: Date.now(),
				});

				/**
				 * A dependency on a concept that does not exist.
				 *
				 * Reported, not refused. Writing two concepts that need each other
				 * means one of them is written first, so refusing would make a
				 * legitimate pair impossible. But `requires` is resolved transitively
				 * when a concept is injected, and a name that resolves to nothing is a
				 * precondition silently dropped — so it must not pass in silence
				 * either.
				 */
				const known = new Set(all.map((c) => key(c.name)));
				const dangling = (shared.requires ?? []).filter((r) => !known.has(key(r)));

				return {
					success: true,
					result: {
						action: 'created',
						id: created.data.id,
						name: created.data.name,
						text:
							`Recorded "${created.data.name}" as a new rule, waiting on approval. Tell the person ` +
							`it is written down and needs their approval — not that it is a "concept".` +
							(dangling.length
								? ` Note: it requires ${dangling.map((d) => `"${d}"`).join(', ')}, which ` +
									`${dangling.length === 1 ? 'does' : 'do'} not exist yet — propose ` +
									`${dangling.length === 1 ? 'it' : 'them'} too, or drop the dependency.`
								: ''),
					},
				};
			} catch (err: any) {
				return { error: err?.message ?? String(err) };
			}

			/** What to do with the one row the agent named, once it is identified. */
			async function applyTo(existing: StoredConcept): Promise<unknown> {
				/**
				 * Nothing to change is not a change.
				 *
				 * An agent re-reading a concept and proposing it back verbatim is a
				 * normal mistake — it fetched the body, the body is correct, and
				 * "write it down" fires anyway. Queuing that wastes a reviewer's
				 * attention on a diff with nothing in it, and a reviewer who sees a
				 * few of those stops reading the rest carefully.
				 */
				if (existing.body.trim() === conceptBody) {
					return {
						success: true,
						result: {
							action: 'unchanged',
							id: existing.id,
							name: existing.name,
							text:
								`"${existing.name}" already says exactly that, so there is nothing to review. ` +
								`Tell the person the rule is already recorded.`,
						},
					};
				}

				/* A rule nobody has approved yet is still the agent's to improve. */
				if (!existing.verified) {
					const refined = await updateStoredConcept({ id: existing.id, ...shared } as any);
					announce({
						type: 'concept',
						action: 'refined',
						id: existing.id,
						name: existing.name,
						body: conceptBody,
						previousBody: existing.body,
						...asProposed(refined.data),
						at: Date.now(),
					});
					return {
						success: true,
						result: {
							action: 'refined',
							id: existing.id,
							name: existing.name,
							text: `Refined the pending proposal "${existing.name}". It is still awaiting review.`,
						},
					};
				}

				/**
				 * One correction at a time.
				 *
				 * A conversation where someone disputes the same number three times
				 * should leave one thing to review, not three competing ones. The
				 * refusal tells the agent what to do instead, because "no" with no
				 * alternative is how an agent ends up trying variations.
				 */
				const pending = (await listConceptProposals()).data.find(
					(c) => c.supersedes === existing.id,
				);
				if (pending) {
					return {
						error:
							`"${existing.name}" already has a correction waiting for review (id ${pending.id}). ` +
							`Say what else you would change and leave it to the reviewer, rather than ` +
							`proposing a second one.`,
					};
				}

				/* Unspecified fields are inherited, not blanked: a correction to a
				 * body is not a statement that the concept has no dependencies. */
				const created = await createStoredConcept({
					name: existing.name,
					...shared,
					kind: shared.kind ?? (existing.kind as any),
					requires: shared.requires ?? existing.requires,
					aliases: shared.aliases ?? existing.aliases,
					returns: shared.returns ?? (existing.returns as any),
					origin: 'user_question',
					originRef: proposedBy,
					supersedes: existing.id,
				} as any);

				announce({
					type: 'concept',
					action: 'revision',
					id: created.data.id,
					name: created.data.name,
					body: conceptBody,
					replaces: existing.id,
					previousBody: existing.body,
					...asProposed(created.data),
					at: Date.now(),
				});

				/**
				 * What the correction stopped saying.
				 *
				 * A correction is a whole new body, so a rule rewritten from memory
				 * rather than from the text can quietly lose most of itself — the
				 * sort order, a join rule, the names it cited. Naming those back to
				 * the agent is the cheapest place to catch it, because it is the only
				 * moment both versions are in hand.
				 */
				const before = citations(existing.body);
				const lost = [...before].filter((c) => !citations(conceptBody).has(c));

				return {
					success: true,
					result: {
						action: 'revision',
						id: created.data.id,
						name: created.data.name,
						replaces: existing.id,
						text:
							`Recorded a change to "${existing.name}", waiting on approval. The existing rule ` +
							`stays in force until then, so say that to the person in their words — not that a ` +
							`"concept" was "proposed".` +
							(lost.length
								? ` Your version no longer mentions ${lost.map((c) => `'${c}'`).join(', ')}, ` +
									`which the current rule relies on. If dropping ${lost.length === 1 ? 'it' : 'them'} ` +
									`was not deliberate, say so in your answer so the reviewer knows.`
								: ''),
					},
				};
			}
		},
	});

}

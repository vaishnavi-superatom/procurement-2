import type { CodingAgentDefinition, TriggerEvent } from '@superatomai/sdk-node';
import { writeBridgeShims } from '@superatomai/sdk-node';
import { bridgeAccess } from './data-tools';
import { MAX_BATCH_ATTEMPTS, advanceWatermark, migrateWatermarkOutOf, readWatermark, writeBatch } from './watermark';
import {
	getConversationBatch,
	getConversationQuestions,
	getKbNodesForConcepts,
} from '../../../database/postgres/src/project-data-db/concept-sources';
import { recordAnswerValidation } from '../../../database/postgres/src/project-data-db/answer-validations';
import {
	getAllConcepts,
	createConcept,
	updateConcept,
	findDanglingRequires,
} from '../../../database/postgres/src/project-data-db/concepts';

/**
 * Concept Builder — proposes concepts from two sources.
 *
 * One agent, not two, because the hard part is shared: authoring a sound
 * concept, deduping against what exists, and keeping `requires` a real graph.
 * Only the reading task differs (inference from conversations vs translation
 * from a knowledge node), and that is two short sections of system.md.
 *
 * Everything it writes is verified:false — invisible to the question-answering
 * agent until a human approves it. See migration 0024.
 */

// Five, not ten: with validation each conversation costs real work — several
// SQL round trips — so per-run work now scales with the batch, and the fixed
// overhead no longer dominates the way it did for the read-only pass.
const BATCH_SIZE = 5;

interface ConceptProposal {
	action: 'create' | 'update';
	name: string;
	body: string;
	kind?: string;
	requires?: string[];
	returns?: Record<string, unknown>;
	aliases?: string[];
	changed?: string;
	/** kb-nodes mode: which node this came from. Stored as originRef='kb:<id>'. */
	sourceNodeId?: number | string;
	evidence?: string;
	confidence?: string;
}
/**
 * One verified answer. Recorded for every conversation examined, including the
 * ones that were right — a confirmed-correct answer is the result users most
 * want to see, and it is the one a proposals-only contract discards.
 */
interface AnswerValidation {
	conversationId: number;
	verdict: 'match' | 'mismatch' | 'unverifiable';
	reportedAnswer?: string;
	rederivedAnswer?: string;
	unit?: string;
	finding?: string;
	evidence?: Record<string, unknown>;
}

interface Output {
	proposals: ConceptProposal[];
	/** Required in conversations mode: one entry per conversation examined. */
	validations?: AnswerValidation[];
	notes?: string;
}

export interface ConceptBuilderInput {
	/** 'kb-nodes' when a node changed; otherwise the conversation batch. */
	mode?: 'conversations' | 'kb-nodes';
	/**
	 * kb-nodes mode: which nodes moved. A LIST, because the trigger debounces —
	 * one run covers every node touched in the window. Empty or omitted falls
	 * back to the most recently updated nodes.
	 */
	kbNodeIds?: Array<number | string>;
}

/**
 * The trigger announces `kb-node.changed` in the world's vocabulary
 * (`{ id, op }`); this is where it becomes this agent's vocabulary. Keeping the
 * translation here rather than at the emit site is what lets an unrelated
 * collection stay ignorant of any agent's input shape.
 */
function kbNodeIdsFrom(events: TriggerEvent[]): Array<number | string> {
	return [...new Set(
		events
			.map(e => (e.payload as { id?: number | string } | undefined)?.id)
			.filter((id): id is number | string => id !== null && id !== undefined && id !== '')
	)];
}

const VALID_KINDS = ['formula', 'definition', 'lookup', 'invariant'];

/**
 * The agent's own log. Read once for migration, then never written by us again —
 * system.md promises `memory/` is the agent's, and this file is where it keeps
 * "which conversations have I already checked". The watermark used to live in
 * it and overwrote those findings every run. See watermark.ts for the contract.
 */
const AGENT_LOG_FILE = 'memory/processed.json';

export const conceptBuilder: CodingAgentDefinition<ConceptBuilderInput, Output> = {
	id: 'concept-builder',
	title: 'Concept Builder',
	description: 'Proposes catalog concepts from answered questions and knowledge-node changes.',
	mode: 'task',
	// Project-wide: everything it learns belongs to the project, not to whoever
	// happened to ask the tenth question.
	scope: 'project',
	session: { scope: 'persistent', workspace: 'persistent' },

	// buildInput is not optional decoration here: without it the raw event
	// payload arrives as the input, `mode` is undefined, and a KB edit silently
	// ran a conversations pass instead.
	trigger: [
		{
			type: 'count', on: 'conversation.answered', every: BATCH_SIZE,
			// The batch comes from the watermark in prepare(), not from the
			// events — stated explicitly so the mode can never be left to a default.
			buildInput: (): ConceptBuilderInput => ({ mode: 'conversations' }),
		},
		{
			// Editing several nodes in a row is one reason to rebuild, not five —
			// but all five nodes are read, not just the last one.
			type: 'event', on: 'kb-node.changed', debounceMs: 30_000,
			buildInput: (events): ConceptBuilderInput => ({ mode: 'kb-nodes', kbNodeIds: kbNodeIdsFrom(events) }),
		},
	],

	// Validating five answers means many queries and several turns; the 15-minute
	// default cuts that short.
	timeoutMs: 30 * 60 * 1000,

	// The shims reach script-bridge over HTTP; without this the sandbox blocks
	// them. Scoped to this agent, not a driver default.
	networkAccessEnabled: true,

	async prepare(ws, input) {
		const mode = input?.mode ?? 'conversations';
		await ws.write('input/mode.txt', mode);

		// ./query and ./sources — regenerated every run so the bridge port is
		// always the one currently bound.
		const access = await bridgeAccess();
		if (access) writeBridgeShims(ws, access);
		await ws.write('input/data-access.txt', access
			? 'Available: run ./sources then ./query "<toolId>" "<sql>"'
			: 'UNAVAILABLE this run — you cannot verify any answer. Say so and propose nothing.');

		// Includes proposals, so it cannot re-propose something already pending,
		// and originRef, so a KB edit updates its own concepts.
		const all = (await getAllConcepts()).data;
		await ws.writeJson('input/existing-concepts.json', all.map(c => ({
			name: c.name, kind: c.kind, body: c.body, requires: c.requires,
			aliases: c.aliases, returns: c.returns,
			origin: c.origin, originRef: (c as any).originRef, verified: c.verified,
		})));

		if (mode === 'kb-nodes') {
			const nodes = await getKbNodesForConcepts(input?.kbNodeIds);
			await ws.writeJsonl('input/kb-nodes.jsonl', nodes);
			// Every requested node was deleted between the edit and this run. Say
			// so rather than leaving an empty file the agent has to interpret.
			if (!nodes.length) {
				await ws.write('input/kb-nodes-note.txt',
					'None of the changed nodes still exist — they were deleted before this run. Propose nothing.');
			}
			return;
		}

		// One batch, oldest first, resuming where the last run stopped — so
		// successive runs walk forward through history instead of re-reading the
		// newest few forever. Only successful turns: an errored or aborted answer
		// is not evidence of anything.
		const moved = await migrateWatermarkOutOf(ws.dir, AGENT_LOG_FILE);
		if (moved.migrated) {
			console.log(`[concept-builder] watermark moved out of ${AGENT_LOG_FILE} at conversation ${moved.from}; the agent's own notes were kept`);
		}
		const since = await readWatermark(ws.dir);
		const batch = await getConversationBatch(since, BATCH_SIZE);
		await ws.writeJsonl('input/conversations.jsonl', batch);

		// Records WHAT was handed over; the watermark itself does not move until
		// apply() sees what came back. Advancing here meant a timeout, a missing
		// deliverable or a schema failure burned the batch permanently — every
		// one of those paths skips apply(), and nothing rolled the position back.
		// Nothing under memory/ is written here either: that is the agent's.
		const handed = await writeBatch(ws.dir, since, batch.map(c => c.id));
		if (handed.attempt > 1) {
			console.warn(`[concept-builder] conversations ${handed.ids.join(', ')} — attempt ${handed.attempt} of ${MAX_BATCH_ATTEMPTS}`);
		}
	},

	output: {
		file: 'out/concepts.json',
		schema: {
			parse(value: unknown): Output {
				const v = value as Output;
				if (!v || !Array.isArray(v.proposals)) throw new Error('expected { proposals: [...] }');
				for (const [i, p] of v.proposals.entries()) {
					const at = `proposals[${i}]`;
					if (p.action !== 'create' && p.action !== 'update') throw new Error(`${at}.action must be create|update`);
					if (!p.name?.trim()) throw new Error(`${at}.name is required`);
					if (!p.body?.trim()) throw new Error(`${at}.body is required`);
					if (p.kind && !VALID_KINDS.includes(p.kind)) {
						throw new Error(`${at}.kind "${p.kind}" is not one of ${VALID_KINDS.join('|')}`);
					}
					if (p.requires && !Array.isArray(p.requires)) throw new Error(`${at}.requires must be an array`);
					if (p.sourceNodeId !== undefined && typeof p.sourceNodeId !== 'number' && typeof p.sourceNodeId !== 'string') {
						throw new Error(`${at}.sourceNodeId must be a number or string`);
					}
					if (p.aliases && !Array.isArray(p.aliases)) throw new Error(`${at}.aliases must be an array`);
				}
				const seen = new Set<number>();
				for (const [i, v2] of (v.validations ?? []).entries()) {
					const at = `validations[${i}]`;
					if (!Number.isFinite(v2.conversationId)) throw new Error(`${at}.conversationId must be a number`);
					if (!['match', 'mismatch', 'unverifiable'].includes(v2.verdict)) {
						throw new Error(`${at}.verdict must be match|mismatch|unverifiable`);
					}
					// One conversation, one verdict. Two entries would upsert twice and
					// the last would silently win — an agent contradicting itself about
					// the same answer is a fault worth failing the run over, not
					// something to quietly resolve by row order.
					if (seen.has(v2.conversationId)) {
						throw new Error(`${at}.conversationId ${v2.conversationId} appears more than once`);
					}
					seen.add(v2.conversationId);
				}
				return v;
			},
		},
	},

	async apply(result, input, ctx) {
		const mode = input?.mode ?? 'conversations';
		const origin = mode === 'kb-nodes' ? 'knowledge_node' : 'user_question';

		// Per PROPOSAL, not per run: one batch spans several nodes, and one node
		// can yield several concepts, so the run's own input cannot say where any
		// individual concept came from. The single-node fallback is only sound
		// when the run covered exactly one node — with several, guessing would
		// attach the concept to the wrong node, and a wrong originRef is worse
		// than none: the next edit to the real node would not find it.
		const soleNode = input?.kbNodeIds?.length === 1 ? input.kbNodeIds[0] : null;
		const refFor = (p: ConceptProposal): string | null =>
			mode !== 'kb-nodes' ? null
				: p.sourceNodeId != null ? `kb:${p.sourceNodeId}`
					: soleNode != null ? `kb:${soleNode}`
						: null;

		// Recorded before the proposals: this is the durable record of what was
		// checked, and it must survive even if applying a proposal then fails.
		let validated = 0, verdictHeld = 0;
		// One lookup for the batch — the question is snapshotted onto each row so
		// a verdict stays readable after the conversation is pruned.
		const questions = await getConversationQuestions(
			(result.validations ?? []).map(v => v.conversationId).filter(Number.isFinite)
		);
		for (const v of result.validations ?? []) {
			try {
				const rec = await recordAnswerValidation({
					conversationId: v.conversationId,
					question: questions.get(v.conversationId) ?? null,
					verdict: v.verdict,
					reportedAnswer: v.reportedAnswer ?? null,
					rederivedAnswer: v.rederivedAnswer ?? null,
					unit: v.unit ?? null,
					finding: v.finding ?? null,
					evidence: v.evidence ?? {},
					agentRunId: ctx?.runId ?? null,
				});
				// A re-check that came back 'unverifiable' leaves the earlier real
				// verdict standing. Counted separately so the summary doesn't claim
				// to have validated something it declined to overwrite.
				if (rec.skipped) verdictHeld++; else validated++;
			} catch (err: any) {
				console.warn(`[concept-builder] could not record validation for conversation ${v.conversationId}: ${err?.message ?? err}`);
			}
		}

		const all = (await getAllConcepts()).data;
		// Only real concepts, never a pending revision — otherwise a second run
		// would propose a revision of a revision.
		const existing = new Map(
			all.filter(c => c.supersedes == null).map(c => [c.name.trim().toLowerCase(), c])
		);
		const openRevisions = new Set(all.filter(c => c.supersedes != null).map(c => c.supersedes));

		let created = 0, updated = 0, revisions = 0, skipped = 0;
		const rejected: string[] = [];

		for (const p of result.proposals) {
			const key = p.name.trim().toLowerCase();
			const match = existing.get(key);
			try {
				// system.md makes sourceNodeId required in this mode for a reason:
				// without originRef the concept is unreachable by query, so a later
				// edit to that node re-creates it instead of updating it, and the
				// orphan check cannot see it. Reject rather than write an
				// untraceable rule.
				if (mode === 'kb-nodes' && refFor(p) === null) {
					skipped++;
					rejected.push(`${p.name}: no sourceNodeId, and the run covered ${input?.kbNodeIds?.length ?? 0} nodes so it cannot be inferred`);
					continue;
				}
				if (match?.verified) {
					// A human approved this rule; the agent may not rewrite it. But
					// discarding the correction loses the signal entirely, so it is
					// stored as its own unverified row pointing at the original and
					// reviewed like anything else.
					if (openRevisions.has(match.id)) {
						skipped++;
						rejected.push(`${p.name}: a revision is already pending review`);
						continue;
					}
					await createConcept({
						name: p.name.trim(), body: p.body,
						kind: (p.kind ?? match.kind) as any,
						requires: p.requires ?? match.requires,
						returns: (p.returns ?? match.returns) as any,
						aliases: p.aliases ?? match.aliases,
						origin: origin as any,
						originRef: refFor(p),
						supersedes: match.id,
						sourceId: null,
					});
					openRevisions.add(match.id);
					revisions++;
					continue;
				}

				if (match) {
					// An unverified proposal from an earlier run — refine it in place.
					await updateConcept({
						id: match.id, body: p.body,
						...(p.kind ? { kind: p.kind } : {}),
						...(p.requires ? { requires: p.requires } : {}),
						...(p.returns ? { returns: p.returns } : {}),
						...(p.aliases ? { aliases: p.aliases } : {}),
					} as any);
					updated++;
					continue;
				}

				await createConcept({
					name: p.name.trim(), body: p.body,
					kind: (p.kind ?? 'definition') as any,
					requires: p.requires ?? [], returns: (p.returns ?? {}) as any, aliases: p.aliases ?? [],
					origin: origin as any,
					originRef: refFor(p),
					sourceId: null,
					// verified is not passed: the column defaults false, which is the
					// whole safety property. Stated so a refactor cannot lose it.
				});
				created++;
			} catch (err: any) {
				skipped++;
				rejected.push(`${p.name}: ${err?.message ?? err}`);
			}
		}

		// A `requires` pointing at nothing silently degrades the whole design —
		// the dependency stops being resolvable and becomes prose again. Surface
		// it to the reviewer rather than letting it sit.
		const dangling = await findDanglingRequires();

		// LAST, and only here. apply() runs only after a validated deliverable,
		// so every failure path leaves the position alone and the batch is
		// retried. It moves to what the agent actually reported on — not to the
		// rows it was handed — and it moves after the work above has been
		// persisted, so a partial failure re-reads a conversation rather than
		// losing it.
		let advanced: string | undefined;
		let forcedSkip: number[] | undefined;
		if (mode === 'conversations' && ctx?.workspaceDir) {
			const adv = await advanceWatermark(ctx.workspaceDir, (result.validations ?? []).map(v => v.conversationId));
			if (adv) {
				advanced = `${adv.batch.since} → ${adv.to}`;
				if (adv.forced) {
					forcedSkip = adv.uncovered;
					console.error(
						`[concept-builder] conversations ${adv.uncovered.join(', ')} stepped over after ` +
						`${MAX_BATCH_ATTEMPTS} attempts without a validation — recorded in _skipped.json`
					);
				} else if (adv.uncovered.length) {
					console.warn(`[concept-builder] conversations ${adv.uncovered.join(', ')} not reported on — they will be re-read next run`);
				}
			}
		}

		return {
			summary:
				(validated ? `${validated} answer(s) validated; ` : '') +
				(verdictHeld ? `${verdictHeld} kept an earlier verdict; ` : '') +
				`${mode}: ${created} created, ${updated} updated, ${revisions} revision(s) proposed, ${skipped} skipped` +
				(dangling.count ? `, ${dangling.count} dangling requires` : '') +
				(advanced ? `; watermark ${advanced}` : '') +
				(forcedSkip?.length ? ` (stepped over ${forcedSkip.join(', ')})` : ''),
			counts: { validated, verdictHeld, created, updated, revisions, skipped, dangling: dangling.count },
			details: { rejected, dangling: dangling.data, notes: result.notes, ...(forcedSkip?.length ? { forcedSkip } : {}) },
		};
	},
};

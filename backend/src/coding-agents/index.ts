import path from 'path';
import { registerCodingAgents, startAgentTriggers, describeTriggers } from '@superatomai/sdk-node';
import type { CodingAgentDefinition } from '@superatomai/sdk-node';
import { conceptBuilder } from './concept-builder';
import { answerAgent } from './answer-agent';
import { warmNarratorSession } from './narrator/pi-session';

/**
 * This deployment's coding agents.
 *
 * Adding one is three things and nothing else:
 *   1. a folder  backend/.prompts/coding-agents/<id>/system.md   — what it does
 *   2. a file    backend/src/coding-agents/<id>.ts               — its definition
 *   3. one entry in AGENTS below
 *
 * When each agent runs is declared on its own definition (`trigger`), so this
 * file never grows a scheduler and no call site elsewhere needs to know an
 * agent exists. The backend only has to announce facts:
 *
 *   emitAgentEvent('conversation.answered', { threadId })
 *   emitAgentEvent('kb-node.changed', { id, op })
 */

const AGENTS: CodingAgentDefinition<any, any>[] = [
	// Manual only (no trigger) — driven by a question, not a schedule.
	answerAgent,
	// concept-builder is OFF: it proposes concepts on a trigger, which spends model
	// calls in the background and moves the concept store under the answer flow
	// while we are measuring it. Set SA_CONCEPT_BUILDER=on to put it back.
	...(process.env.SA_CONCEPT_BUILDER === 'on' ? [conceptBuilder] : []),
];

export function initCodingAgents(): void {

	registerCodingAgents(AGENTS, {
		// Version-controlled instructions, alongside the rest of .prompts.
		promptRoot: path.join(process.cwd(), '.prompts', 'coding-agents'),
		// Regenerated per run and gitignored — deliberately not under .prompts.
		runtimeDir: path.join(process.cwd(), '.coding-agent-runtime'),
	});

	// Only interval triggers need starting; event and count triggers wake on
	// emitAgentEvent. Safe to call with no agents registered.
	startAgentTriggers();

	for (const { agentId, triggers } of describeTriggers()) {
		console.log(`  · ${agentId}: ${triggers.join(', ') || 'manual'}`);
	}

	// The narrator's model connection, loaded now rather than on the first
	// question — otherwise that question waits ~10 s for its opening line.
	// In the background: startup does not wait for it.
	if (process.env.SA_NARRATOR !== 'off') void warmNarratorSession();
}

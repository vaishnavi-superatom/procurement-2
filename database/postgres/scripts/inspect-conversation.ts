/**
 * One-shot conversation inspector — combines what get-conversation-trace.ts
 * (the debug trace) and a dozen ad-hoc _tmp scripts (status/error/full analysis
 * text) were each doing separately, so assessing one turn is a single command
 * instead of 2-3 round-trips.
 *
 * Usage:
 *   tsx scripts/inspect-conversation.ts --latest
 *   tsx scripts/inspect-conversation.ts --id 384
 *   tsx scripts/inspect-conversation.ts --prompt "revenue forecast"   # latest match, substring, case-insensitive
 *   ... --type dashboard | report   # trace type, defaults to chat_agent
 *
 * Prints: id/createdAt/status/error, the full (untruncated) analysis text,
 * whether a script was saved (scriptBinding), then the trace — KB node
 * titles, the MainAgent turn (every tool call it made, in order, with the
 * exact input/output text — resolve_entities, resolve_concepts, source-tool
 * dispatches, write_script/execute_script/write_components/write_analysis,
 * everything), the same for an edit turn (mainAgentEdit), each SourceAgent
 * dispatch's own internal record (its own tool calls, in its own retry loop),
 * and the display-edit component-reauthor call when this turn took that path.
 */

import { db, schema } from '../src/project-data-db/drizzle-db';
import { eq, desc, ilike } from 'drizzle-orm';
import { getConversationTrace } from '../src/project-data-db/user-conversations';

const args = process.argv.slice(2);
const argVal = (flag: string) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : undefined; };

const useLatest = args.includes('--latest');
const idArg = argVal('--id');
const promptArg = argVal('--prompt');
const traceType = argVal('--type') || 'chat_agent';

async function main() {
	if (!useLatest && !idArg && !promptArg) {
		console.error('Usage: --latest | --id <n> | --prompt "<substring>"  [--type chat_agent|dashboard|report]');
		process.exit(1);
	}

	let row: any;
	if (idArg) {
		const rows = await db.select().from(schema.userConversations).where(eq(schema.userConversations.id, Number(idArg))).limit(1);
		row = rows[0];
	} else if (promptArg) {
		const rows = await db.select().from(schema.userConversations)
			.where(ilike(schema.userConversations.userprompt, `%${promptArg}%`))
			.orderBy(desc(schema.userConversations.createdAt))
			.limit(1);
		row = rows[0];
	} else {
		const rows = await db.select().from(schema.userConversations)
			.orderBy(desc(schema.userConversations.createdAt))
			.limit(1);
		row = rows[0];
	}

	if (!row) {
		console.error('No matching conversation found.');
		process.exit(1);
	}

	console.log('='.repeat(80));
	console.log(`id: ${row.id}  |  status: ${row.status}  |  createdAt: ${row.createdAt}`);
	console.log(`prompt: ${row.userprompt}`);
	if (row.response?.error) console.log(`error: ${JSON.stringify(row.response.error)}`);
	console.log(`scriptBinding: ${row.response?.scriptBinding ? row.response.scriptBinding.name + ' (' + row.response.scriptBinding.recipeId + ')' : 'none — no script executed successfully'}`);
	console.log('='.repeat(80));

	console.log('\n--- FULL ANALYSIS ---\n');
	console.log(row.response?.analysis ?? '(no analysis text)');

	console.log('\n' + '='.repeat(80));
	console.log('--- TRACE ---\n');

	const traceResult = await getConversationTrace(row.id, traceType);
	if (!traceResult) {
		console.log(`(no trace found for id=${row.id} type=${traceType})`);
		process.exit(0);
	}
	const trace: any = traceResult.trace;

	if (trace.script) {
		console.log('script: saved (see scriptBinding above for name/recipeId)');
	} else {
		console.log('script: null — no script was authored/executed this turn');
	}

	const kb = trace.kbNodes;
	if (kb) {
		const globalTitles = (kb.global || []).map((n: any) => n.title);
		const queryTitles = (kb.query || []).map((n: any) => `${n.title} (${n.similarity})`);
		console.log(`\nkbNodes.global (${globalTitles.length}): ${globalTitles.join(', ') || '(none)'}`);
		console.log(`kbNodes.query (${queryTitles.length}): ${queryTitles.join(', ') || '(none)'}`);
	}

	if (trace.conversationHistory !== undefined) {
		console.log(`\nconversationHistory: ${trace.conversationHistory ? `${trace.conversationHistory.length} chars` : '(empty — no prior context)'}`);
	}

	// Every tool call a MainAgent turn made, in call order — resolve_entities,
	// resolve_concepts, each source-tool dispatch, write_script, execute_script,
	// write_components, write_analysis, direct tools, everything. `output` is
	// the exact tool_result text the model read back.
	const printToolCall = (c: any, indent: string) => {
		console.log(`${indent}[iter ${c.iteration}] ${c.toolName}${c.forced ? ' (forced)' : ''}${c.isError ? ' ❌ ERROR' : ''} — ${c.durationMs}ms`);
		console.log(`${indent}  input: ${JSON.stringify(c.input)}`);
		console.log(`${indent}  output:\n${String(c.output ?? '').replace(/^/gm, indent + '    ')}`);
	};

	const printMainAgentTrace = (label: string, ma: any) => {
		if (!ma) {
			console.log(`\n${label}: null — this turn didn't take this path`);
			return;
		}
		console.log(`\n${label}:`);
		console.log(`  model: ${ma.model ?? '(default)'}  |  maxIterations: ${ma.maxIterations}`);
		if (ma.sent.editContext) {
			console.log(`  editContext: recipe="${ma.sent.editContext.parentName}" (${ma.sent.editContext.recipeId})`);
			console.log(`    instruction: ${ma.sent.editContext.instruction}`);
		}
		console.log(`  sent.sourceSummaries: ${ma.sent.sourceSummaries?.length ?? 0} chars`);
		console.log(`  sent.routing: ${(ma.sent.routing || []).map((r: any) => `${r.sourceName || r.sourceId}(${r.similarity.toFixed(2)})`).join(', ') || '(no pre-filter this turn)'}`);
		console.log(`  sent.conversationHistory/userAccessContext: ${ma.sent.userAccessContext ? `${ma.sent.userAccessContext.length} chars` : '(none)'} access ctx`);
		console.log(`  sent.entityCatalogText: ${ma.sent.entityCatalogText ? 'present' : '(none)'}  |  sent.conceptCatalogText: ${ma.sent.conceptCatalogText ? 'present' : '(none)'}`);
		if (ma.sent.firstIterationForcedTool) console.log(`  sent.firstIterationForcedTool: ${ma.sent.firstIterationForcedTool}`);

		console.log(`  toolCalls (${ma.toolCalls.length}):`);
		for (const c of ma.toolCalls) printToolCall(c, '    ');

		// A SEPARATE section, not folded into any tool call's input/output — this
		// is MainAgent's own embedding pre-resolution per dispatch, never actually
		// sent to SourceAgent as structured data (only as prose inside that
		// dispatch's schemaText, printed under sourceAgent below).
		if (ma.preResolvedSchemas?.length) {
			console.log(`  preResolvedSchemas (${ma.preResolvedSchemas.length}):`);
			for (const p of ma.preResolvedSchemas) {
				console.log(`    [${p.sourceId}] intent: ${p.intent}`);
				console.log(`      tables: ${p.tables.map((t: any) => `${t.table ?? '?'}(${t.similarity.toFixed(2)})`).join(', ')}`);
			}
		}

		console.log(`  iterations (${ma.iterations.length}): ${ma.iterations.map((it: any) =>
			`#${it.iteration}[${it.durationMs}ms,tools=${it.toolCallCount},in=${it.usage.inputTokens},out=${it.usage.outputTokens},cacheRead=${it.usage.cacheReadTokens},stop=${it.stopReason}]`
		).join(' ')}`);

		if (ma.error) console.log(`  error: ${ma.error}`);
		console.log(`  received.finalText:\n${(ma.received.finalText || '(empty)').replace(/^/gm, '    ')}`);
		if (ma.received.workflow) console.log(`  received.workflow: ${ma.received.workflow.name}`);
		if (ma.received.savedScriptSummary) console.log(`  received.savedScriptSummary: ${ma.received.savedScriptSummary.name} (${ma.received.savedScriptSummary.recipeId}) sources=[${ma.received.savedScriptSummary.sourceIds.join(', ')}]`);
		if (ma.received.componentCount !== undefined) console.log(`  received.componentCount: ${ma.received.componentCount}`);
	};

	printMainAgentTrace('mainAgent', trace.mainAgent);
	printMainAgentTrace('mainAgentEdit', trace.mainAgentEdit);

	// Every SourceAgent dispatch this turn — its own sent/toolCalls/received,
	// independent of what MainAgent's own toolCalls entry for the same
	// dispatch shows (that's MainAgent's flat black-box view; this is
	// SourceAgent's own nested record of what it actually did internally).
	const sourceAgentTrace = trace.sourceAgent;
	if (sourceAgentTrace?.length) {
		console.log(`\nsourceAgent — SourceAgent's own dispatch record (${sourceAgentTrace.length}):`);
		sourceAgentTrace.forEach((s: any, i: number) => {
			console.log(`\n  [${i + 1}] ${s.sourceName || s.sourceId}  |  model: ${s.model ?? '(default)'}  |  maxIterations: ${s.maxIterations ?? '?'}`);
			console.log(`      sent.intent: ${s.sent.intent}`);
			console.log(`      sent.method: ${s.sent.method}  |  sent.schemaText: ${s.sent.schemaText?.length ?? 0} chars`);
			console.log(`      toolCalls (${s.toolCalls.length}):`);
			for (const c of s.toolCalls) printToolCall(c, '        ');
			console.log(`      iterations (${s.iterations.length}): ${s.iterations.map((it: any) =>
				`#${it.iteration}[${it.durationMs}ms,tools=${it.toolCallCount},stop=${it.stopReason}]`
			).join(' ')}`);
			console.log(`      received: success=${s.received.success}${s.received.rowsReturned !== undefined ? ` rowsReturned=${s.received.rowsReturned}` : ''}${s.received.totalRowsMatched !== undefined ? ` totalRowsMatched=${s.received.totalRowsMatched}` : ''} executionTimeMs=${s.received.executionTimeMs}${s.received.error ? ` error=${s.received.error}` : ''}`);
			console.log(`      received.resultText sent to MainAgent:\n${(s.received.resultText ?? '(not captured — dispatch may have failed before returning)').replace(/^/gm, '        ')}`);
		});
	} else {
		console.log('\nsourceAgent: no dispatches recorded');
	}

	// The ScriptMatcher `edit + editTarget:'display'` reauthor call — bypasses
	// MainAgent entirely, so it only ever shows up here, never in mainAgent above.
	const cr = trace.componentReauthor;
	if (cr) {
		console.log(`\ncomponentReauthor:`);
		console.log(`  sent.instruction: ${cr.sent.instruction}`);
		console.log(`  sent.model: ${cr.sent.model ?? '(default)'}`);
		console.log(`  attempts (${cr.attempts.length}):`);
		cr.attempts.forEach((a: any, i: number) => {
			console.log(`    [${i + 1}] accepted=${a.accepted}${a.validationErrors?.length ? ` — ${a.validationErrors.join('; ')}` : ''}`);
		});
		console.log(`  received.accepted: ${cr.received.accepted}`);
	} else {
		console.log('\ncomponentReauthor: null — this turn didn\'t take the display-edit path');
	}

	process.exit(0);
}

main().catch(err => { console.error('\nError:', err.message); process.exit(1); });

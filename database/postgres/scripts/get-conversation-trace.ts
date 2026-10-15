/**
 * Fetch the debug trace for a conversation turn by (conversationId, type) —
 * the retrieval/generation trace captured alongside user_conversations.create
 * (which schema/KB nodes were retrieved, what script ran, etc). See the
 * conversationTraces table comment in drizzle/schema.ts and
 * CHAT-DEBUG-TRACE-DESIGN.md (do-websocket/packages/api) for the trace shape.
 *
 * type is required, not optional — conversationId alone is ambiguous across
 * source tables: user_conversations / dashboard_agent_conversations /
 * reports_conversations each have their own independent id sequence, so a
 * chat conversation #50 and a dashboard conversation #50 can both exist and
 * both have a trace row here.
 *
 * Usage:
 *   tsx scripts/get-conversation-trace.ts <conversationId> [type]
 *
 * type defaults to 'chat_agent' (the only flow with trace capture until
 * dashboard/report trace capture was added) — pass 'dashboard' or 'report'
 * explicitly for those flows.
 */

import { getConversationTrace } from '../src/project-data-db/user-conversations';

async function main() {
  const conversationIdArg = process.argv[2];
  const type = process.argv[3] || 'chat_agent';

  const conversationId = Number(conversationIdArg);
  if (!conversationIdArg || !Number.isInteger(conversationId)) {
    console.error("usage: tsx scripts/get-conversation-trace.ts <conversationId> [type]");
    console.error("  type: 'chat_agent' (default) | 'dashboard' | 'report'");
    process.exit(1);
  }

  const result = await getConversationTrace(conversationId, type);

  if (!result) {
    console.log(`NOT FOUND: no trace for conversationId=${conversationId} type=${type}`);
    process.exit(0);
  }

  console.log('conversationId:', conversationId);
  console.log('type:', type);
  console.log('createdAt:', result.createdAt);
  console.log('\n--- trace ---');
  console.log(JSON.stringify(result.trace, null, 2));

  process.exit(0);
}

main().catch((err) => {
  console.error('Error:', err instanceof Error ? err.message : err);
  process.exit(1);
});

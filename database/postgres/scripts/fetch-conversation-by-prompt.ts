/**
 * Fetch the full user_conversations row for an exact user prompt — for
 * inspecting what a past turn actually stored (analysis text, scriptBinding,
 * rendered component tree) without hand-writing a one-off script each time.
 *
 * Usage:
 *   tsx scripts/fetch-conversation-by-prompt.ts "<exact user prompt>" [userId] [status]
 *
 * userId and status are optional filters (status e.g. 'success' | 'error' | 'aborted').
 * The prompt must match exactly what was stored — see getConversationByUserPrompt.
 */

import { getConversationByUserPrompt } from '../src/project-data-db/user-conversations';

async function main() {
  const prompt = process.argv[2];
  const userId = process.argv[3];
  const status = process.argv[4];

  if (!prompt) {
    console.error('usage: tsx scripts/fetch-conversation-by-prompt.ts "<exact user prompt>" [userId] [status]');
    process.exit(1);
  }

  const result = await getConversationByUserPrompt(prompt, userId, status);

  if (!result.success || !result.data) {
    console.log('NOT FOUND for exact prompt match:', prompt);
    process.exit(0);
  }

  const row: any = result.data;

  console.log('id:', row.id);
  console.log('userId:', row.userId);
  console.log('threadid:', row.threadid);
  console.log('status:', row.status);
  console.log('createdAt:', row.createdAt);
  console.log('updatedAt:', row.updatedAt);
  console.log('\n--- full response ---');
  console.log(JSON.stringify(row.response, null, 2));

  process.exit(0);
}

main().catch((err) => {
  console.error('Error:', err instanceof Error ? err.message : err);
  process.exit(1);
});

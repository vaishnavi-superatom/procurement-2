/**
 * Seed Knowledge Base Nodes
 *
 * Populates the kb_nodes table with query-level knowledge nodes
 * that help the LLM generate correct SQL queries for KPI calculations.
 *
 * Usage:
 *   # If JSON has createdBy/updatedBy fields, userId is optional:
 *   pnpm script:seed-kb-nodes
 *   pnpm script:seed-kb-nodes --clear
 *   pnpm script:seed-kb-nodes --file ./path/to/custom-nodes.json
 *
 *   # Override createdBy/updatedBy with a CLI userId:
 *   pnpm script:seed-kb-nodes <userId>
 *   pnpm script:seed-kb-nodes <userId> --clear
 *   pnpm script:seed-kb-nodes <userId> --clear --file ./path/to/nodes.json
 *
 * JSON Format (array of objects):
 *   [
 *     {
 *       "title": "Node Title",
 *       "content": "Node content with SQL examples...",
 *       "category": "Financial",
 *       "tags": ["revenue", "billing"],
 *       "type": "query",
 *       "createdBy": "user-id-here",
 *       "updatedBy": "user-id-here"
 *     }
 *   ]
 */

import * as fs from 'fs';
import * as path from 'path';
import { createKbNode, getAllKbNodes } from '../src/project-data-db/kb-nodes';
import { db, schema } from '../src/project-data-db/drizzle-db';
import { ChromaManager } from '../../chromadb/src/chroma-manager';

const { kbNodes } = schema;

/**
 * Build the same document text used everywhere else a kb-node gets embedded
 * (backend/src/collections/kb-nodes.ts) — title + category + tags + content.
 */
function buildDocumentText(title: string, content: string, category?: string, tags?: string[]): string {
  let documentText = title;
  if (category) documentText += `\nCategory: ${category}`;
  if (tags && tags.length > 0) documentText += `\nTags: ${tags.join(', ')}`;
  documentText += `\n\n${content}`;
  return documentText;
}

// --- CLI argument parsing ---
const args = process.argv.slice(2);
const shouldClear = args.includes('--clear');
const fileIdx = args.indexOf('--file');
const customFile = fileIdx !== -1 && args[fileIdx + 1] ? args[fileIdx + 1] : null;

const DEFAULT_DATA_FILE = path.join(__dirname, 'kb-nodes-data.json');
const dataFile = customFile || DEFAULT_DATA_FILE;

// Get userId from CLI: first positional arg that isn't a flag
const positionalArgs = args.filter(a => !a.startsWith('--') && a !== customFile);
const CLI_USER = positionalArgs[0] || null;

interface KbNodeData {
  title: string;
  content: string;
  category?: string;
  tags?: string[];
  type?: 'query' | 'global' | 'user';
  createdBy?: string;
  updatedBy?: string;
}

async function main() {
  console.log('╔══════════════════════════════════════╗');
  console.log('║   Seeding Knowledge Base Nodes       ║');
  console.log('╚══════════════════════════════════════╝\n');

  // 1. Load JSON data
  const resolvedPath = path.resolve(dataFile);
  if (!fs.existsSync(resolvedPath)) {
    console.error(`❌ Data file not found: ${resolvedPath}`);
    console.error(`   Create the file or use --file to specify a different path.`);
    process.exit(1);
  }

  let nodes: KbNodeData[];
  try {
    const raw = fs.readFileSync(resolvedPath, 'utf-8');
    nodes = JSON.parse(raw);
    if (!Array.isArray(nodes)) {
      throw new Error('JSON must be an array of node objects');
    }
  } catch (err) {
    console.error(`❌ Failed to parse ${resolvedPath}:`, err instanceof Error ? err.message : err);
    process.exit(1);
  }

  // Determine the userId: CLI arg takes priority, then JSON fields
  const firstNodeUser = nodes[0]?.createdBy;
  const SEED_USER = CLI_USER || firstNodeUser || null;

  if (!SEED_USER) {
    console.error('❌ Error: userId is required\n');
    console.error('Provide it either:');
    console.error('  1. In the JSON as "createdBy" field on each node');
    console.error('  2. As a CLI argument: pnpm script:seed-kb-nodes <userId>\n');
    process.exit(1);
  }

  if (CLI_USER) {
    console.log(`👤 User ID (from CLI): ${CLI_USER}`);
  } else {
    console.log(`👤 User ID (from JSON): ${SEED_USER}`);
  }
  console.log(`📄 Loaded ${nodes.length} nodes from: ${resolvedPath}\n`);

  // 2. Clear existing nodes if --clear flag
  // Deletes EVERY row, not just ones matching a resolved createdBy — this file
  // is the single source of truth for kb_nodes, not a per-user additive seed.
  // Scoping the delete by createdBy left older rows (from a prior run under a
  // different creator id) behind on every reseed, silently re-duplicating the
  // whole table each time.
  if (shouldClear) {
    try {
      const deleted = await db.delete(kbNodes).returning();
      console.log(`🗑️  Cleared ${deleted.length} existing kb_nodes (entire table)\n`);
    } catch (err) {
      console.error(`⚠️  Failed to clear existing nodes:`, err instanceof Error ? err.message : err);
    }
  }

  // 3. Insert nodes
  let created = 0;
  let skipped = 0;
  let failed = 0;

  for (const node of nodes) {
    const { title, content, category, tags, type } = node;
    const nodeUser = CLI_USER || node.createdBy || SEED_USER;

    if (!title || !content) {
      console.warn(`⚠️  Skipping node with missing title or content`);
      skipped++;
      continue;
    }

    try {
      const result = await createKbNode({
        title,
        content,
        category: category || undefined,
        tags: tags || undefined,
        type: (type as 'query' | 'global' | 'user') || 'query',
        createdBy: nodeUser,
      });

      console.log(`✅ Created: "${title}" (ID: ${result.data.id}, type: ${type || 'query'}, category: ${category || 'none'})`);
      created++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('duplicate') || msg.includes('already exists')) {
        console.log(`⏭️  Skipped: "${title}" (already exists)`);
        skipped++;
      } else {
        console.error(`❌ Failed: "${title}" — ${msg}`);
        failed++;
      }
    }
  }

  // 4. Sync embeddings to ChromaDB — query-type nodes only (global/user types
  // are always injected directly and are never semantically searched). This
  // insert loop above only writes Postgres; without this step the collection
  // silently goes stale/empty relative to what was just seeded.
  if (created > 0) {
    console.log('\n📡 Syncing embeddings to ChromaDB...');
    try {
      const chroma = new ChromaManager();
      const isHealthy = await chroma.healthCheck();

      if (!isHealthy) {
        console.warn('⚠️  ChromaDB not reachable — skipping embedding sync.');
        console.warn('   Query-type kb-nodes were seeded into Postgres but will have no semantic search results');
        console.warn('   until embeddings are synced (start ChromaDB, then run kbNodes.syncAll from the backend).');
      } else {
        const allNodesResult = await getAllKbNodes(10000, 0);
        const queryNodes = (allNodesResult.data || []).filter((n: any) => (n.type || 'query') === 'query');

        // Full reset (delete + recreate) rather than upsert — guarantees the
        // collection exactly mirrors the current Postgres rows, with no
        // leftover embeddings from nodes deleted by --clear or a prior seed.
        await chroma.createCollection(true);

        if (queryNodes.length > 0) {
          await chroma.add({
            ids: queryNodes.map((n: any) => `kb_${n.id}`),
            documents: queryNodes.map((n: any) => buildDocumentText(n.title, n.content, n.category || undefined, n.tags || [])),
            metadatas: queryNodes.map((n: any) => ({
              kb_id: n.id,
              title: n.title,
              category: n.category || '',
              tags: JSON.stringify(n.tags || []),
              type: 'query',
              created_at: n.createdAt ? String(n.createdAt) : new Date().toISOString(),
            })),
          });
        }

        console.log(`✅ Embedded ${queryNodes.length} query-type kb-node(s) into ChromaDB`);
      }
    } catch (err) {
      console.error('⚠️  Failed to sync embeddings to ChromaDB:', err instanceof Error ? err.message : err);
    }
  }

  // 5. Summary
  console.log('\n╔══════════════════════════════════════╗');
  console.log(`║   Results                            ║`);
  console.log('╠══════════════════════════════════════╣');
  console.log(`║   ✅ Created:  ${String(created).padEnd(22)}║`);
  console.log(`║   ⏭️  Skipped:  ${String(skipped).padEnd(22)}║`);
  console.log(`║   ❌ Failed:   ${String(failed).padEnd(22)}║`);
  console.log(`║   📊 Total:    ${String(nodes.length).padEnd(22)}║`);
  console.log('╚══════════════════════════════════════╝');

  process.exit(failed > 0 ? 1 : 0);
}

main();

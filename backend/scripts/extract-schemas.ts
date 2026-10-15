/**
 * Extract Schemas Script
 *
 * Extracts and stores schema for all configured data sources.
 * This enriches the source tools with detailed table/column information.
 *
 * Usage:
 *   pnpm tsx scripts/extract-schemas.ts
 */

import { initializeSources, getSourceManager } from '../src/sources';

const PROJECT_ID = process.env.SUPERATOM_PROJECT_ID || 'mds';

async function main() {
  console.log('============================================');
  console.log(' Schema Extraction');
  console.log('============================================\n');

  console.log(`Project ID: ${PROJECT_ID}\n`);

  try {
    // Initialize sources
    console.log('Initializing sources...\n');
    await initializeSources(PROJECT_ID);

    const manager = getSourceManager();
    if (!manager) {
      console.log('No source manager available');
      process.exit(1);
    }

    // Extract schemas for all sources
    console.log('Extracting schemas...\n');
    const schemas = await manager.refreshAllSchemas();

    console.log(`\n============================================`);
    console.log(` Extracted ${schemas.size} Schema(s)`);
    console.log(`============================================\n`);

    for (const [sourceId, schema] of schemas) {
      const instance = manager.getInstance(sourceId);
      console.log(`\n${instance?.getName() || sourceId}:`);
      console.log(`  Entities: ${schema.entities.length}`);
      for (const entity of schema.entities.slice(0, 10)) {
        console.log(`    - ${entity.name} (${entity.fields.length} fields)`);
      }
      if (schema.entities.length > 10) {
        console.log(`    ... and ${schema.entities.length - 10} more`);
      }
    }

    // Now show the updated tools
    console.log('\n\n============================================');
    console.log(' Updated Source Tools');
    console.log('============================================\n');

    const tools = manager.getSourceTools();
    for (const tool of tools) {
      console.log('--------------------------------------------');
      console.log(`Tool: ${tool.name}`);
      console.log('--------------------------------------------');
      console.log(tool.description);
      console.log('\n');
    }

    // Shutdown
    await manager.shutdown();
    console.log('\nDone!');
    process.exit(0);

  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

main();

/**
 * View Source Tools Script
 *
 * Displays the source tools that are generated for the LLM
 * based on configured data sources.
 *
 * Usage:
 *   pnpm tsx scripts/view-source-tools.ts
 */

import { initializeSources, getSourceManager } from '../src/sources';

const PROJECT_ID = process.env.SUPERATOM_PROJECT_ID || 'mds';

async function main() {
  console.log('============================================');
  console.log(' Source Tools Viewer');
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

    // Get source tools
    const tools = manager.getSourceTools();

    console.log(`\n============================================`);
    console.log(` Found ${tools.length} Source Tool(s)`);
    console.log(`============================================\n`);

    for (const tool of tools) {
      console.log('--------------------------------------------');
      console.log(`Tool ID: ${tool.id}`);
      console.log(`Name: ${tool.name}`);
      console.log('--------------------------------------------');
      console.log('\nDESCRIPTION:');
      console.log(tool.description);
      console.log('\nPARAMETERS:');
      console.log(JSON.stringify(tool.params, null, 2));
      if (tool.outputSchema) {
        console.log('\nOUTPUT SCHEMA:');
        console.log(JSON.stringify(tool.outputSchema, null, 2));
      }
      console.log('\n');
    }

    // Shutdown
    await manager.shutdown();
    process.exit(0);

  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

main();

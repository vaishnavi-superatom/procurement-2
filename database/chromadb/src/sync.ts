#!/usr/bin/env node
/**
 * Main script to sync PostgreSQL knowledge base (kb_nodes) to ChromaDB
 */

import { program } from 'commander';
import * as dotenv from 'dotenv';
import * as path from 'path';
import { PostgresConnector } from './postgres-connector';
import { ChromaManager } from './chroma-manager';

// Load .env from chromadb directory
dotenv.config({ path: path.resolve(__dirname, '../.env') });

// Configuration
const config = {
  CHROMA_SERVER_URL: process.env.CHROMA_SERVER_URL || 'http://localhost:8000',
  COLLECTION_NAME: process.env.COLLECTION_NAME || 'knowledge_base_collection',
  KB_TABLE_NAME: process.env.KB_TABLE_NAME || 'kb_nodes',
};

/**
 * Sync knowledge base from PostgreSQL (kb_nodes) to ChromaDB
 */
async function syncKnowledgeBase(reset: boolean = false, batchSize: number = 100): Promise<void> {
  console.log('='.repeat(70));
  console.log('KNOWLEDGE BASE SYNC: PostgreSQL (kb_nodes) → ChromaDB');
  console.log('='.repeat(70));

  const pgConnector = new PostgresConnector();
  const chromaManager = new ChromaManager();

  try {
    // Step 1: Check ChromaDB server
    console.log('\n[1/6] Checking ChromaDB server...');
    const isHealthy = await chromaManager.healthCheck();
    if (!isHealthy) {
      console.error('\n✗ ChromaDB server is not running!');
      console.error('\nPlease start the ChromaDB server first:');
      console.error('  Option 1: npm run start:chroma');
      console.error('  Option 2: chroma run --host localhost --port 8000');
      process.exit(1);
    }

    // Step 2: Connect to PostgreSQL
    console.log('\n[2/6] Connecting to PostgreSQL...');
    await pgConnector.connect();

    // Step 3: Fetch data from PostgreSQL
    console.log(`\n[3/6] Fetching knowledge base entries from ${config.KB_TABLE_NAME}...`);
    const count = await pgConnector.getCount();
    console.log(`      Total entries in PostgreSQL: ${count}`);

    if (count === 0) {
      console.log(`\n⚠ No entries found in ${config.KB_TABLE_NAME} table.`);
      console.log('   Make sure the database is set up correctly:');
      console.log('   1. Run: cd ../postgres && npm run migrate');
      console.log('   2. Add some knowledge base entries via the API or directly to the database');
      return;
    }

    const documents = await pgConnector.fetchAllKnowledgeBase();

    // Step 4: Initialize ChromaDB collection
    console.log('\n[4/6] Setting up ChromaDB collection...');
    await chromaManager.createCollection(reset);

    // Step 5: Generate embeddings and store in ChromaDB
    console.log('\n[5/6] Adding documents to ChromaDB (server will generate embeddings)...');
    await chromaManager.addDocuments(documents, batchSize);

    // Step 6: Verify
    console.log('\n[6/6] Verifying sync...');
    const chromaCount = await chromaManager.getCollectionCount();
    console.log(`      Documents in ChromaDB: ${chromaCount}`);

    if (chromaCount === count) {
      console.log('\n' + '='.repeat(70));
      console.log('✓ SYNC COMPLETED SUCCESSFULLY!');
      console.log('='.repeat(70));
      console.log(`  Source table: ${config.KB_TABLE_NAME}`);
      console.log(`  PostgreSQL entries: ${count}`);
      console.log(`  ChromaDB documents: ${chromaCount}`);
      console.log(`  Collection name: ${config.COLLECTION_NAME}`);
      console.log(`  Embedding model: all-MiniLM-L6-v2 (ChromaDB default)`);
      console.log(`  Server URL: ${config.CHROMA_SERVER_URL}`);
      console.log('='.repeat(70));
    } else {
      console.log('\n⚠ Warning: Count mismatch!');
      console.log(`  PostgreSQL: ${count}, ChromaDB: ${chromaCount}`);
    }
  } catch (error) {
    console.error('\n✗ Error during sync:', error);
    process.exit(1);
  } finally {
    await pgConnector.disconnect();
  }
}

/**
 * Test semantic search on ChromaDB
 */
async function testQuery(queryText: string, nResults: number = 3): Promise<void> {
  console.log('='.repeat(70));
  console.log('TESTING SEMANTIC SEARCH');
  console.log('='.repeat(70));
  console.log(`\nQuery: "${queryText}"`);
  console.log(`Retrieving top ${nResults} results...\n`);

  const chromaManager = new ChromaManager();

  try {
    // Check server health
    const isHealthy = await chromaManager.healthCheck();
    if (!isHealthy) {
      console.error('\n✗ ChromaDB server is not running!');
      console.error('  Start the server: chroma run --host localhost --port 8000');
      process.exit(1);
    }

    await chromaManager.createCollection();

    // Check if collection has documents
    const count = await chromaManager.getCollectionCount();
    if (count === 0) {
      console.log('✗ ChromaDB collection is empty.');
      console.log('  Run: npm run sync');
      return;
    }

    // Perform query
    const results = await chromaManager.query(queryText, nResults);

    console.log('-'.repeat(70));
    for (let i = 0; i < results.ids[0].length; i++) {
      const metadata = results.metadatas[0][i];
      const document = results.documents[0][i];
      const distance = results.distances[0][i];
      const similarity = 1 - distance;

      console.log(`\n[${i + 1}] ${metadata.title}`);
      console.log(`    Similarity: ${similarity.toFixed(4)} | KB ID: ${metadata.kb_id}`);
      console.log(`    ${document.substring(0, 150)}...`);
      console.log('-'.repeat(70));
    }

    console.log(`\n✓ Search completed. Found ${results.ids[0].length} results.`);
  } catch (error) {
    console.error('\n✗ Error during query:', error);
    process.exit(1);
  }
}

/**
 * Display statistics about the ChromaDB collection
 */
async function showStats(): Promise<void> {
  console.log('='.repeat(70));
  console.log('CHROMADB STATISTICS');
  console.log('='.repeat(70));

  const chromaManager = new ChromaManager();

  try {
    // Check server health
    const isHealthy = await chromaManager.healthCheck();
    if (!isHealthy) {
      console.error('\n✗ ChromaDB server is not running!');
      console.error('  Start the server: npm run start:chroma');
      process.exit(1);
    }

    await chromaManager.createCollection();
    const count = await chromaManager.getCollectionCount();

    console.log(`\nServer URL: ${config.CHROMA_SERVER_URL}`);
    console.log(`Collection name: ${config.COLLECTION_NAME}`);
    console.log(`Source table: ${config.KB_TABLE_NAME}`);
    console.log(`Total documents: ${count}`);
    console.log(`Embedding model: all-MiniLM-L6-v2 (ChromaDB default)`);
    console.log(`Embedding dimension: 384`);

    if (count > 0) {
      console.log('\n✓ Collection is ready for queries');
    } else {
      console.log('\n⚠ Collection is empty. Run sync first.');
    }
  } catch (error) {
    console.error('\n✗ Error getting stats:', error);
    process.exit(1);
  }
}

// CLI Setup
program
  .name('sync-to-chroma')
  .description('Sync PostgreSQL knowledge base to ChromaDB with embeddings')
  .version('1.0.0');

program
  .command('sync')
  .description('Sync data from PostgreSQL to ChromaDB')
  .option('-r, --reset', 'Reset ChromaDB collection before syncing')
  .option('-b, --batch-size <size>', 'Batch size for processing documents', '100')
  .action(async (options) => {
    const reset = options.reset || false;
    const batchSize = parseInt(options.batchSize);
    await syncKnowledgeBase(reset, batchSize);
  });

program
  .command('query <text>')
  .description('Test semantic search with the given query')
  .option('-n, --results <number>', 'Number of search results to return', '3')
  .action(async (text, options) => {
    const nResults = parseInt(options.results);
    await testQuery(text, nResults);
  });

program
  .command('stats')
  .description('Show ChromaDB collection statistics')
  .action(async () => {
    await showStats();
  });

// Handle legacy --sync, --query, --stats flags
if (process.argv.includes('--sync')) {
  const resetIndex = process.argv.indexOf('--reset');
  const reset = resetIndex !== -1;
  syncKnowledgeBase(reset).catch(console.error);
} else if (process.argv.includes('--query')) {
  const queryIndex = process.argv.indexOf('--query');
  const queryText = process.argv[queryIndex + 1] || 'machine learning';
  const resultsIndex = process.argv.indexOf('--results');
  const nResults = resultsIndex !== -1 ? parseInt(process.argv[resultsIndex + 1]) : 3;
  testQuery(queryText, nResults).catch(console.error);
} else if (process.argv.includes('--stats')) {
  showStats().catch(console.error);
} else {
  // Parse commands
  program.parse(process.argv);

  // Show help if no command provided
  if (process.argv.length <= 2) {
    program.help();
  }
}

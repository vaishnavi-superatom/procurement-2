/**
 * Add Test Sources Script
 *
 * Adds PostgreSQL and Excel sources to the project_sources table for testing.
 *
 * Usage:
 *   pnpm tsx scripts/add-test-sources.ts
 *
 * Before running:
 *   1. Run setup.sh to set up the project
 *   2. Update the configuration below with your actual values
 *   3. Place your Excel file in the specified path
 */

import { randomUUID } from 'crypto';
import * as sourceService from '../../database/postgres/src/project-data-db/project-sources';
import * as projectService from '../../database/postgres/src/project-data-db/project-details';

// ============================================
// CONFIGURATION - UPDATE THESE VALUES
// ============================================

const PROJECT_ID = process.env.SUPERATOM_PROJECT_ID || 'your-project-id';

// PostgreSQL source configuration
const POSTGRES_SOURCE = {
  id: randomUUID(),
  projectId: PROJECT_ID,
  name: 'Sales Database',
  description: 'PostgreSQL database with sales and customer data',
  type: 'postgres' as const,
  config: {
    host: process.env.PG_HOST || 'localhost',
    port: parseInt(process.env.PG_PORT || '5432'),
    database: process.env.PG_DATABASE || 'ikea',
    user: process.env.PG_USER || 'postgres',
    password: process.env.PG_PASSWORD || 'postgres',
    schema: 'public',
    ssl: false,
  },
  isPrimary: true,
  isActive: true,
};

// Excel source configuration
const EXCEL_SOURCE = {
  id: randomUUID(),
  projectId: PROJECT_ID,
  name: 'Product Catalog',
  description: 'Excel file with product information and pricing',
  type: 'excel' as const,
  config: {
    // Update this path to your Excel file location
    filePath: process.env.EXCEL_FILE_PATH || '/home/gopinadh/Downloads/Inventory_Status.xlsx',
    // Specify which sheets to include (optional - defaults to all)
    // sheets: ['Products', 'Categories', 'Pricing'],
    headerRow: 1,
    refreshInterval: 60, // Refresh every 60 minutes
  },
  isPrimary: false,
  isActive: true,
};

// ============================================
// MAIN
// ============================================

async function main() {
  console.log('============================================');
  console.log(' Add Test Sources');
  console.log('============================================\n');

  console.log(`Project ID: ${PROJECT_ID}\n`);

  try {
    // First, ensure project exists in project_details
    console.log('Checking if project exists...');
    try {
      await projectService.getProjectDetails({ id: PROJECT_ID });
      console.log(`✓ Project "${PROJECT_ID}" exists\n`);
    } catch {
      // Project doesn't exist, create it
      console.log(`Project "${PROJECT_ID}" not found. Creating...`);
      await projectService.createProjectDetails({
        id: PROJECT_ID,
        name: PROJECT_ID.charAt(0).toUpperCase() + PROJECT_ID.slice(1) + ' Project',
        description: 'Test project for multi-source data architecture',
        databaseType: 'multi-source',
      });
      console.log(`✓ Project "${PROJECT_ID}" created\n`);
    }

    // Check existing sources
    console.log('Checking existing sources...');
    const existing = await sourceService.getProjectSources(PROJECT_ID, true);
    console.log(`Found ${existing.count} existing source(s)\n`);

    if (existing.count > 0) {
      console.log('Existing sources:');
      for (const source of existing.data) {
        console.log(`  - ${source.name} (${source.type}) [${source.isActive ? 'active' : 'inactive'}]`);
      }
      console.log('');

      // Ask to continue
      const readline = await import('readline');
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      const answer = await new Promise<string>((resolve) => {
        rl.question('Add new sources anyway? (y/N): ', resolve);
      });
      rl.close();

      if (answer.toLowerCase() !== 'y') {
        console.log('Aborted.');
        process.exit(0);
      }
    }

    // Add PostgreSQL source
    console.log('Adding PostgreSQL source...');
    console.log(`  Name: ${POSTGRES_SOURCE.name}`);
    console.log(`  Host: ${POSTGRES_SOURCE.config.host}:${POSTGRES_SOURCE.config.port}`);
    console.log(`  Database: ${POSTGRES_SOURCE.config.database}`);

    const pgResult = await sourceService.createProjectSource(POSTGRES_SOURCE);
    console.log(`  ✓ Created with ID: ${pgResult.data.id}\n`);

    // Add Excel source
    console.log('Adding Excel source...');
    console.log(`  Name: ${EXCEL_SOURCE.name}`);
    console.log(`  File: ${EXCEL_SOURCE.config.filePath}`);

    const excelResult = await sourceService.createProjectSource(EXCEL_SOURCE);
    console.log(`  ✓ Created with ID: ${excelResult.data.id}\n`);

    // Summary
    console.log('============================================');
    console.log(' Sources Added Successfully!');
    console.log('============================================\n');

    console.log('Next steps:');
    console.log('  1. Make sure the Excel file exists at the configured path');
    console.log('  2. Restart the backend: pnpm dev');
    console.log('  3. The sources will connect and extract schema on startup');
    console.log('  4. Try asking questions like:');
    console.log('     - "Show me all customers from the database"');
    console.log('     - "List products from the Excel catalog"');
    console.log('     - "Compare database sales with Excel pricing"');
    console.log('');

  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

main();

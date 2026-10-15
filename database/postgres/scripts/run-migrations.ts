import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import * as dotenv from 'dotenv';

// Load environment variables
dotenv.config();

async function runMigrations() {
  console.log('=========================================');
  console.log(' Running Database Migrations');
  console.log('=========================================\n');

  const connectionString = process.env.PROJECT_DATABASE_URL;

  if (!connectionString) {
    console.error('Error: PROJECT_DATABASE_URL not found in environment variables');
    process.exit(1);
  }

  console.log('✓ Environment variables loaded');

  // Create connection pool
  const pool = new Pool({
    connectionString,
  });

  // Create drizzle instance
  const db = drizzle(pool);

  try {
    console.log('Applying migrations from ./drizzle/migrations...\n');

    // Run migrations
    await migrate(db, { migrationsFolder: './drizzle/migrations' });

    console.log('\n=========================================');
    console.log('✓ Migrations applied successfully!');
    console.log('=========================================');
  } catch (error) {
    console.error('\n❌ Migration failed:');
    console.error(error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

runMigrations();

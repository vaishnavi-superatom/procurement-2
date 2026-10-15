import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from '../../drizzle/schema';
import dotenv from 'dotenv';

dotenv.config({ quiet: true });

// Create PostgreSQL connection pool
const pool = new Pool({
  connectionString: process.env.PROJECT_DATABASE_URL,
});

// Create Drizzle instance with schema
export const db = drizzle(pool, { schema });

// Export schema for use in services
export { schema };

// Extract database name from connection URL for logging
const dbName = process.env.PROJECT_DATABASE_URL?.split('/').pop()?.split('?')[0] || 'unknown';

// Log only the first pool connection — pg Pool acquires a new client per
// concurrent query during startup, which would otherwise fire this log
// multiple times for the same database.
let connectLogged = false;
pool.on('connect', () => {
  if (!connectLogged) {
    console.log(`✓ Connected to ${dbName} database`);
    connectLogged = true;
  }
});

pool.on('error', (err) => {
  console.error('Database connection error:', err);
});

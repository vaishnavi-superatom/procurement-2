import { Pool, QueryResult } from 'pg';
import dotenv from 'dotenv';

dotenv.config({ quiet: true });

// Lazy-initialized PostgreSQL connection pool
let pool: Pool | null = null;
let lastHealthCheck: number = 0;
let isConnecting: boolean = false;
let connectionPromise: Promise<Pool> | null = null;
const HEALTH_CHECK_INTERVAL = 30000; // 30 seconds - only health check if idle for this long

/**
 * Check if PostgreSQL is configured
 */
export function isConfigured(): boolean {
  return !!process.env.DATABASE_URL;
}

/**
 * Validate that the pool connection is actually working
 * Returns true if healthy, false if stale/broken
 */
async function validatePoolConnection(): Promise<boolean> {
  if (!pool) return false;

  try {
    // Quick health check query - this will fail if connection is stale
    await pool.query('SELECT 1 as health_check');
    return true;
  } catch (error) {
    console.warn('[PostgreSQL] Pool health check failed:', (error as Error).message);
    return false;
  }
}

/**
 * Force close and reset the pool
 */
async function resetPool(): Promise<void> {
  if (pool) {
    try {
      console.log('[PostgreSQL] Closing stale connection pool...');
      await pool.end();
    } catch (error) {
      console.warn('[PostgreSQL] Error closing stale pool:', (error as Error).message);
    }
    pool = null;
  }
}

/**
 * Create a new pool instance
 */
function createPool(): Pool {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL environment variable is not set');
  }

  const newPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes('localhost') ? false : {
      rejectUnauthorized: false // Required for Neon and most hosted PostgreSQL
    },
    max: 10, // Maximum number of clients in the pool
    idleTimeoutMillis: 60000,  // 60 seconds idle timeout (was 30s)
    connectionTimeoutMillis: 10000,
    allowExitOnIdle: false,
  });

  // Connection event handlers
  newPool.on('connect', () => {
    console.log('[PostgreSQL] New client connected');
  });

  newPool.on('error', (err) => {
    console.error('[PostgreSQL] Unexpected error on idle client', err);
    // Reset pool on error so next request creates a fresh one
    pool = null;
  });

  return newPool;
}

/**
 * Get or create the PostgreSQL connection pool (lazy initialization)
 * Includes health check to detect stale connections after idle periods
 * Uses locking to prevent race conditions with simultaneous connection attempts
 */
async function getPool(): Promise<Pool> {
  const now = Date.now();

  // If pool exists, validate it's actually working
  if (pool) {
    // Only do health check if enough time has passed (avoid checking on every query)
    const timeSinceLastCheck = now - lastHealthCheck;

    if (timeSinceLastCheck > HEALTH_CHECK_INTERVAL) {
      console.log('[PostgreSQL] Validating pool connection after idle period...');
      const isHealthy = await validatePoolConnection();

      if (isHealthy) {
        lastHealthCheck = now;
        console.log('[PostgreSQL] Pool connection validated successfully');
        return pool;
      } else {
        // Pool is stale - force reset and recreate
        console.warn('[PostgreSQL] Pool connection is stale, recreating...');
        await resetPool();
      }
    } else {
      // Recent health check passed, return pool
      return pool;
    }
  }

  // If another request is already creating the pool, wait for it
  if (isConnecting && connectionPromise) {
    console.log('[PostgreSQL] Waiting for existing connection attempt...');
    return connectionPromise;
  }

  // Create new pool with lock to prevent race conditions
  isConnecting = true;
  connectionPromise = (async () => {
    try {
      console.log('[PostgreSQL] Creating new connection pool...');
      pool = createPool();

      // Test the connection
      const result = await pool.query('SELECT NOW() as server_time');
      console.log('[PostgreSQL] Connected to DB, server time:', result.rows[0].server_time);

      lastHealthCheck = Date.now();

      return pool;
    } catch (error) {
      console.error('[PostgreSQL] Error initializing connection pool:', error);
      pool = null; // Ensure pool is null on failure
      throw error;
    } finally {
      isConnecting = false;
      connectionPromise = null;
    }
  })();

  return connectionPromise;
}

/**
 * Initialize and test the database connection
 */
export async function initDB(): Promise<void> {
  try {
    const p = await getPool();
    const result = await p.query('SELECT NOW() as current_time');
    console.log('[PostgreSQL] Connection pool initialized successfully');
    console.log('[PostgreSQL] Current time from DB:', result.rows[0].current_time);
  } catch (error) {
    console.error('[PostgreSQL] Error initializing database pool:', error);
  }
}

/**
 * Execute raw SQL query
 * @param sql - SQL query string
 * @param params - Optional query parameters (for prepared statements)
 * @returns Query result
 */
export async function executeQuery(sql: string, params?: any[]): Promise<any> {
  try {
    console.log('[PostgreSQL] Executing query:', sql.substring(0, 100) + (sql.length > 100 ? '...' : ''));

    const p = await getPool();
    const result: QueryResult = await p.query(sql, params);

    console.log(`[PostgreSQL] Query executed successfully, rows: ${result.rowCount}`);

    return {
      rows: result.rows,
      rowCount: result.rowCount,
      fields: result.fields?.map(f => ({
        name: f.name,
        dataTypeID: f.dataTypeID
      }))
    };
  } catch (error: any) {
    console.error('[PostgreSQL] Query error:', error.message || error);
    if (error.detail) console.error('[PostgreSQL] Detail:', error.detail);
    throw {
      error: 'Database query failed',
      message: error.message || 'Unknown database error',
      code: error.code,
      detail: error.detail
    };
  }
}

/**
 * Execute mutation query (INSERT, UPDATE, DELETE)
 * @param sql - SQL mutation query string
 * @param params - Optional query parameters (for prepared statements)
 * @returns Mutation result with affected rows count
 */
export async function executeMutation(sql: string, params?: any[]): Promise<any> {
  try {
    console.log('[PostgreSQL] Executing mutation:', sql.substring(0, 100) + (sql.length > 100 ? '...' : ''));

    const p = await getPool();
    const result: QueryResult = await p.query(sql, params);

    console.log(`[PostgreSQL] Mutation executed successfully, affected rows: ${result.rowCount}`);

    return {
      success: true,
      affectedRows: result.rowCount || 0,
      message: `Successfully affected ${result.rowCount || 0} row(s)`,
      timestamp: new Date().toISOString(),
    };
  } catch (error: any) {
    console.error('[PostgreSQL] Mutation error:', error.message || error);
    if (error.detail) console.error('[PostgreSQL] Detail:', error.detail);
    throw {
      error: 'Database mutation failed',
      message: error.message || 'Unknown database error',
      code: error.code,
      detail: error.detail
    };
  }
}

/**
 * Execute multiple queries in a transaction
 * @param queries - Array of SQL queries
 * @returns Array of results
 */
export async function executeTransaction(queries: string[]): Promise<any[]> {
  const p = await getPool();
  const client = await p.connect();

  try {
    console.log(`[PostgreSQL] Starting transaction with ${queries.length} queries`);

    await client.query('BEGIN');

    const results = [];
    for (const sql of queries) {
      const result = await client.query(sql);
      results.push({
        rows: result.rows,
        rowCount: result.rowCount
      });
    }

    await client.query('COMMIT');

    console.log('[PostgreSQL] Transaction committed successfully');
    return results;
  } catch (error: any) {
    await client.query('ROLLBACK');
    console.error('[PostgreSQL] Transaction rolled back:', error.message);
    throw {
      error: 'Transaction failed',
      message: error.message
    };
  } finally {
    client.release();
  }
}

/**
 * Get database table information
 * @param tableName - Name of the table
 * @returns Table schema information
 */
export async function getTableInfo(tableName: string): Promise<any> {
  const query = `
    SELECT
      column_name,
      data_type,
      character_maximum_length,
      is_nullable,
      column_default
    FROM information_schema.columns
    WHERE table_name = $1
    ORDER BY ordinal_position;
  `;

  try {
    const result = await executeQuery(query, [tableName]);
    return {
      tableName,
      columns: result.rows
    };
  } catch (error) {
    throw {
      error: 'Failed to get table info',
      tableName
    };
  }
}

/**
 * Test database connection
 * @returns Connection status
 */
export async function testConnection(): Promise<boolean> {
  try {
    const result = await executeQuery('SELECT NOW() as current_time');
    console.log('[PostgreSQL] Connection test successful:', result.rows[0].current_time);
    return true;
  } catch (error) {
    console.error('[PostgreSQL] Connection test failed:', error);
    return false;
  }
}

/**
 * Close all connections in the pool
 */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    console.log('[PostgreSQL] Connection pool closed');
  }
}

export default {
  isConfigured,
  executeQuery,
  executeMutation,
  executeTransaction,
  getTableInfo,
  testConnection,
  closePool
};

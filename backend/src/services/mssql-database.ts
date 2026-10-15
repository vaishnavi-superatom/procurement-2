import sql, { ConnectionPool, IResult, config as SqlConfig } from 'mssql';
import dotenv from 'dotenv';

dotenv.config({ quiet: true });

/**
 * Validate and fix common SQL syntax errors (like unbalanced parentheses, aggregates in WHERE)
 * @param sqlQuery - The SQL query to validate
 * @returns Object with validated query and any fixes applied
 */
function validateAndFixSql(sqlQuery: string): { query: string; fixed: boolean; fixMessage?: string } {
  let query = sqlQuery;
  let fixed = false;
  const fixes: string[] = [];

  // ============================================
  // FIX 1: Move aggregate functions from WHERE to HAVING
  // ============================================
  // Pattern: WHERE ... AND/OR (SUM|COUNT|AVG|MIN|MAX|COALESCE\(SUM|COALESCE\(COUNT|...)(...) = ...
  const aggregateFunctions = ['SUM', 'COUNT', 'AVG', 'MIN', 'MAX'];
  const aggregatePattern = new RegExp(
    `(WHERE\\s+.*)\\s+AND\\s+((?:COALESCE\\s*\\(\\s*)?(?:${aggregateFunctions.join('|')})\\s*\\([^)]+\\)[^)]*(?:\\))?\\s*(?:=|>|<|>=|<=|<>|!=)\\s*[^\\s]+)(.*)`,
    'i'
  );

  const aggregateMatch = query.match(aggregatePattern);
  if (aggregateMatch) {
    const beforeAggregate = aggregateMatch[1];
    const aggregateCondition = aggregateMatch[2].trim();
    let afterAggregate = aggregateMatch[3];

    // Check if there's already a HAVING clause
    const hasHaving = /\bHAVING\b/i.test(afterAggregate);
    const hasGroupBy = /\bGROUP\s+BY\b/i.test(query);

    if (hasGroupBy) {
      if (hasHaving) {
        // Add to existing HAVING
        afterAggregate = afterAggregate.replace(
          /(\bHAVING\b)/i,
          `HAVING ${aggregateCondition} AND `
        );
      } else {
        // Find ORDER BY or end of query to insert HAVING before it
        const orderByMatch = afterAggregate.match(/(\s+ORDER\s+BY\s+.*)/i);
        if (orderByMatch) {
          afterAggregate = afterAggregate.replace(
            orderByMatch[1],
            ` HAVING ${aggregateCondition}${orderByMatch[1]}`
          );
        } else {
          afterAggregate = afterAggregate + ` HAVING ${aggregateCondition}`;
        }
      }

      query = beforeAggregate + afterAggregate;
      fixed = true;
      fixes.push('Moved aggregate function from WHERE to HAVING');
      console.warn(`[MSSQL] SQL Fix Applied: Moved aggregate function from WHERE to HAVING`);
    }
  }

  // ============================================
  // FIX 2: Balance parentheses
  // ============================================
  // Count parentheses (excluding those in string literals)
  let openCount = 0;
  let closeCount = 0;
  let inString = false;
  let stringChar = '';

  for (let i = 0; i < query.length; i++) {
    const char = query[i];
    const prevChar = i > 0 ? query[i - 1] : '';

    // Handle string literals (skip content inside quotes)
    if ((char === "'" || char === '"') && prevChar !== '\\') {
      if (!inString) {
        inString = true;
        stringChar = char;
      } else if (char === stringChar) {
        // Check for escaped quote (doubled quote in SQL)
        if (i + 1 < query.length && query[i + 1] === char) {
          i++; // Skip the escaped quote
        } else {
          inString = false;
        }
      }
      continue;
    }

    if (!inString) {
      if (char === '(') openCount++;
      else if (char === ')') closeCount++;
    }
  }

  // Fix unbalanced parentheses
  if (openCount > closeCount) {
    const missingClose = openCount - closeCount;
    query = query.trimEnd();
    // Remove trailing semicolon if present, add parens, then add it back
    const hasSemicolon = query.endsWith(';');
    if (hasSemicolon) {
      query = query.slice(0, -1);
    }
    query = query + ')'.repeat(missingClose);
    if (hasSemicolon) {
      query = query + ';';
    }
    fixed = true;
    fixes.push(`Added ${missingClose} missing closing parenthesis(es)`);
    console.warn(`[MSSQL] SQL Fix Applied: Added ${missingClose} missing closing parenthesis(es)`);
  } else if (closeCount > openCount) {
    // More closing than opening - this is harder to fix automatically
    console.warn(`[MSSQL] SQL Warning: Query has ${closeCount - openCount} extra closing parenthesis(es)`);
  }

  return { query, fixed, fixMessage: fixes.length > 0 ? fixes.join('; ') : undefined };
}

// SQL Server connection configuration
function getMssqlConfig(): SqlConfig {
  // Check for full connection string first
  const connectionString = process.env.MSSQL_CONNECTION_STRING;

  if (connectionString) {
    // Parse connection string format: mssql://user:password@server/database
    const url = new URL(connectionString.replace('mssql://', 'http://'));
    return {
      user: url.username,
      password: url.password,
      server: url.hostname,
      database: url.pathname.slice(1), // Remove leading /
      port: parseInt(url.port) || 1433,
      requestTimeout: parseInt(process.env.MSSQL_REQUEST_TIMEOUT || '60000'), // 60 seconds default
      connectionTimeout: parseInt(process.env.MSSQL_CONNECTION_TIMEOUT || '30000'), // 30 seconds default
      options: {
        encrypt: process.env.MSSQL_ENCRYPT === 'true',
        trustServerCertificate: process.env.MSSQL_TRUST_CERT !== 'false', // Default to true for dev
        enableArithAbort: true,
      },
      pool: {
        max: 10,
        min: 0,
        idleTimeoutMillis: 30000,
      },
    };
  }

  // Build from individual environment variables
  const server = process.env.MSSQL_SERVER;
  const database = process.env.MSSQL_DATABASE;
  const user = process.env.MSSQL_USER;
  const password = process.env.MSSQL_PASSWORD;

  if (!server || !database) {
    console.error('✗ SQL Server connection not configured');
    console.error('  Please set MSSQL_CONNECTION_STRING or individual MSSQL_* variables');
    console.error('  Required: MSSQL_SERVER, MSSQL_DATABASE');
    console.error('  Optional: MSSQL_USER, MSSQL_PASSWORD (for SQL auth)');
    throw new Error('SQL Server connection not configured');
  }

  const config: SqlConfig = {
    server,
    database,
    port: parseInt(process.env.MSSQL_PORT || '1433'),
    requestTimeout: parseInt(process.env.MSSQL_REQUEST_TIMEOUT || '60000'), // 60 seconds default
    connectionTimeout: parseInt(process.env.MSSQL_CONNECTION_TIMEOUT || '30000'), // 30 seconds default
    options: {
      encrypt: process.env.MSSQL_ENCRYPT === 'true',
      trustServerCertificate: process.env.MSSQL_TRUST_CERT !== 'false',
      enableArithAbort: true,
    },
    pool: {
      max: 10,
      min: 0,  // No idle connections (we validate on-demand)
      idleTimeoutMillis: 60000,  // 60 seconds idle timeout
    },
  };

  // Add authentication
  if (user && password) {
    config.user = user;
    config.password = password;
  } else {
    // Windows Authentication
    config.options = {
      ...config.options,
      trustedConnection: true,
    };
  }

  return config;
}

// Connection pool instance
let pool: ConnectionPool | null = null;
let lastHealthCheck: number = 0;
let isConnecting: boolean = false;  // Lock to prevent simultaneous connection attempts
let connectionPromise: Promise<ConnectionPool> | null = null;  // Shared promise for concurrent requests
const HEALTH_CHECK_INTERVAL = 30000; // 30 seconds - only health check if idle for this long

/**
 * Validate that the pool connection is actually working
 * Returns true if healthy, false if stale/broken
 */
async function validatePoolConnection(): Promise<boolean> {
  if (!pool) return false;

  try {
    // Quick health check query - this will fail if connection is stale
    await pool.query`SELECT 1 as health_check`;
    return true;
  } catch (error) {
    console.warn('[MSSQL] Pool health check failed:', (error as Error).message);
    return false;
  }
}

/**
 * Force close and reset the pool
 */
async function resetPool(): Promise<void> {
  if (pool) {
    try {
      console.log('[MSSQL] Closing stale connection pool...');
      await pool.close();
    } catch (error) {
      console.warn('[MSSQL] Error closing stale pool:', (error as Error).message);
    }
    pool = null;
  }
}

/**
 * Get or create the SQL Server connection pool
 * Includes health check to detect stale connections after idle periods
 * Uses locking to prevent race conditions with simultaneous connection attempts
 */
async function getPool(): Promise<ConnectionPool> {
  const now = Date.now();

  // If pool exists and appears connected, validate it's actually working
  if (pool && pool.connected) {
    // Only do health check if enough time has passed (avoid checking on every query)
    const timeSinceLastCheck = now - lastHealthCheck;

    if (timeSinceLastCheck > HEALTH_CHECK_INTERVAL) {
      console.log('[MSSQL] Validating pool connection after idle period...');
      const isHealthy = await validatePoolConnection();

      if (isHealthy) {
        lastHealthCheck = now;
        console.log('[MSSQL] Pool connection validated successfully');
        return pool;
      } else {
        // Pool is stale - force reset and recreate
        console.warn('[MSSQL] Pool connection is stale, recreating...');
        await resetPool();
      }
    } else {
      // Recent health check passed, return pool
      return pool;
    }
  }

  // If another request is already creating the pool, wait for it
  if (isConnecting && connectionPromise) {
    console.log('[MSSQL] Waiting for existing connection attempt...');
    return connectionPromise;
  }

  // Create new pool with lock to prevent race conditions
  isConnecting = true;
  connectionPromise = (async () => {
    try {
      console.log('[MSSQL] Creating new connection pool...');
      const config = getMssqlConfig();
      pool = await sql.connect(config);

      console.log('[MSSQL] Connection pool initialized successfully');

      // Test the connection
      const result = await pool.query`SELECT GETDATE() as server_time`;
      console.log('[MSSQL] Connected to DB, server time:', result.recordset[0].server_time);

      lastHealthCheck = Date.now();

      return pool;
    } catch (error) {
      console.error('[MSSQL] Error initializing connection pool:', error);
      pool = null; // Ensure pool is null on failure
      throw error;
    } finally {
      isConnecting = false;
      connectionPromise = null;
    }
  })();

  return connectionPromise;
}

// Initialize connection on module load (optional - can be lazy)
if (process.env.MSSQL_SERVER || process.env.MSSQL_CONNECTION_STRING) {
  getPool().catch((err) => {
    console.error('[MSSQL] Failed to initialize pool on startup:', err.message);
  });
}

/**
 * Execute raw SQL query (SELECT)
 * @param sqlQuery - SQL query string
 * @param params - Optional query parameters as key-value pairs
 * @returns Query result
 */
export async function executeQuery(
  sqlQuery: string,
  params?: Record<string, any>
): Promise<any> {
  try {
    // Validate and fix common SQL syntax errors
    const { query: validatedQuery, fixed, fixMessage } = validateAndFixSql(sqlQuery);

    if (fixed) {
      console.log('[MSSQL] Original query had syntax issues, applied fix:', fixMessage);
    }

    console.log(
      '[MSSQL] Executing query:',
      validatedQuery.substring(0, 100) + (validatedQuery.length > 100 ? '...' : '')
    );

    const poolConnection = await getPool();
    const request = poolConnection.request();

    // Add parameters if provided
    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        request.input(key, value);
      });
    }

    const result: IResult<any> = await request.query(validatedQuery);

    console.log(`[MSSQL] Query executed successfully, rows: ${result.recordset?.length || 0}`);

    return {
      rows: result.recordset || [],
      rowCount: result.recordset?.length || 0,
      fields: result.recordset?.columns
        ? Object.keys(result.recordset.columns).map((name) => ({
            name,
            dataTypeID: result.recordset.columns[name].type,
          }))
        : [],
    };
  } catch (error: any) {
    console.error('[MSSQL] Query error:', error.message || error);
    if (error.originalError) {
      console.error('[MSSQL] Original error:', error.originalError.message);
    }
    throw {
      error: 'Database query failed',
      message: error.message || 'Unknown database error',
      code: error.code || error.number,
      detail: error.originalError?.message,
    };
  }
}

/**
 * Execute mutation query (INSERT, UPDATE, DELETE)
 * @param sqlQuery - SQL mutation query string
 * @param params - Optional query parameters as key-value pairs
 * @returns Mutation result with affected rows count
 */
export async function executeMutation(
  sqlQuery: string,
  params?: Record<string, any>
): Promise<any> {
  try {
    console.log(
      '[MSSQL] Executing mutation:',
      sqlQuery.substring(0, 100) + (sqlQuery.length > 100 ? '...' : '')
    );

    const poolConnection = await getPool();
    const request = poolConnection.request();

    // Add parameters if provided
    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        request.input(key, value);
      });
    }

    const result: IResult<any> = await request.query(sqlQuery);

    console.log(`[MSSQL] Mutation executed successfully, affected rows: ${result.rowsAffected}`);

    return {
      success: true,
      affectedRows: result.rowsAffected?.reduce((a: number, b: number) => a + b, 0) || 0,
      message: `Successfully affected ${result.rowsAffected?.reduce((a: number, b: number) => a + b, 0) || 0} row(s)`,
      timestamp: new Date().toISOString(),
    };
  } catch (error: any) {
    console.error('[MSSQL] Mutation error:', error.message || error);
    if (error.originalError) {
      console.error('[MSSQL] Original error:', error.originalError.message);
    }
    throw {
      error: 'Database mutation failed',
      message: error.message || 'Unknown database error',
      code: error.code || error.number,
      detail: error.originalError?.message,
    };
  }
}

/**
 * Execute multiple queries in a transaction
 * @param queries - Array of SQL queries
 * @returns Array of results
 */
export async function executeTransaction(queries: string[]): Promise<any[]> {
  const poolConnection = await getPool();
  const transaction = new sql.Transaction(poolConnection);

  try {
    console.log(`[MSSQL] Starting transaction with ${queries.length} queries`);

    await transaction.begin();

    const results = [];
    for (const query of queries) {
      const request = new sql.Request(transaction);
      const result = await request.query(query);
      results.push({
        rows: result.recordset || [],
        rowCount: result.recordset?.length || result.rowsAffected?.reduce((a: number, b: number) => a + b, 0) || 0,
      });
    }

    await transaction.commit();

    console.log('[MSSQL] Transaction committed successfully');
    return results;
  } catch (error: any) {
    await transaction.rollback();
    console.error('[MSSQL] Transaction rolled back:', error.message);
    throw {
      error: 'Transaction failed',
      message: error.message,
    };
  }
}

/**
 * Get database table information
 * @param tableName - Name of the table
 * @param schemaName - Schema name (default: dbo)
 * @returns Table schema information
 */
export async function getTableInfo(tableName: string, schemaName: string = 'dbo'): Promise<any> {
  const query = `
    SELECT
      c.name as column_name,
      t.name as data_type,
      c.max_length as character_maximum_length,
      CASE WHEN c.is_nullable = 1 THEN 'YES' ELSE 'NO' END as is_nullable,
      dc.definition as column_default
    FROM sys.columns c
    INNER JOIN sys.types t ON c.user_type_id = t.user_type_id
    INNER JOIN sys.tables tbl ON c.object_id = tbl.object_id
    INNER JOIN sys.schemas s ON tbl.schema_id = s.schema_id
    LEFT JOIN sys.default_constraints dc ON c.default_object_id = dc.object_id
    WHERE s.name = @schemaName AND tbl.name = @tableName
    ORDER BY c.column_id;
  `;

  try {
    const result = await executeQuery(query, { tableName, schemaName });
    return {
      tableName,
      schemaName,
      columns: result.rows,
    };
  } catch (error) {
    throw {
      error: 'Failed to get table info',
      tableName,
      schemaName,
    };
  }
}

/**
 * Test database connection
 * @returns Connection status
 */
export async function testConnection(): Promise<boolean> {
  try {
    const result = await executeQuery('SELECT GETDATE() as server_time');
    console.log('[MSSQL] Connection test successful:', result.rows[0].server_time);
    return true;
  } catch (error) {
    console.error('[MSSQL] Connection test failed:', error);
    return false;
  }
}

/**
 * Close all connections in the pool
 */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.close();
    pool = null;
    console.log('[MSSQL] Connection pool closed');
  }
}

/**
 * Check if SQL Server connection is configured
 */
export function isConfigured(): boolean {
  return !!(process.env.MSSQL_SERVER || process.env.MSSQL_CONNECTION_STRING);
}

export default {
  executeQuery,
  executeMutation,
  executeTransaction,
  getTableInfo,
  testConnection,
  closePool,
  isConfigured,
};

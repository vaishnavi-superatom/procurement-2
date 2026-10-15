import * as mssqlDb from '../services/mssql-database';
import type { CollectionContext } from './types';

/**
 * Register SQL Server database query execution collections
 */
export async function registerMssqlDatabaseCollections({ sdk }: CollectionContext): Promise<void> {
  // Check if SQL Server is configured
  if (!mssqlDb.isConfigured()) {
    console.log('⊘ Skipped: mssql-database collections (not configured)');
    console.log('  To enable, set MSSQL_SERVER and MSSQL_DATABASE in .env\n');
    return;
  }

  // Execute SQL query (SELECT)
  sdk.addCollection('mssql-database', 'execute', async (params: any) => {
    const { sql, parameters } = params;

    if (!sql || sql.trim().length === 0) {
      throw new Error('SQL query parameter is required');
    }

    try {
      const result = await mssqlDb.executeQuery(sql, parameters);

      return {
        success: true,
        data: result.rows,
        count: result.rowCount || 0,
        timestamp: new Date().toISOString(),
      };
    } catch (error: any) {
      let errorMsg = 'Unknown error';
      let errorDetail = '';

      if (error instanceof Error) {
        errorMsg = error.message;
      } else if (error && typeof error === 'object') {
        errorMsg = error.message || error.error || JSON.stringify(error);
        errorDetail = error.detail || error.code || '';
      }

      console.error('[MSSQL-DATABASE] Query failed:', errorMsg);
      if (errorDetail) console.error('[MSSQL-DATABASE] Error detail:', errorDetail);
      console.error('[MSSQL-DATABASE] Failed SQL:', sql);
      throw new Error(`SQL Server query execution failed: ${errorMsg}${errorDetail ? ' - ' + errorDetail : ''}`);
    }
  });

  // Execute SQL mutation (INSERT, UPDATE, DELETE)
  sdk.addCollection('mssql-database', 'mutation', async (params: any) => {
    const { sql, params: queryParams, values } = JSON.parse(params.sql);

    if (!sql || sql.trim().length === 0) {
      throw new Error('SQL mutation parameter is required');
    }

    try {
      // Replace @fieldName placeholders with actual values from form
      // Note: SQL Server uses @param syntax instead of $param
      let finalQuery = sql;
      const paramValues: Record<string, any> = {};

      if (values && typeof values === 'object') {
        Object.keys(values).forEach((fieldName: string) => {
          const value = values[fieldName];
          // For SQL Server, we use parameterized queries with @param syntax
          // Check if the query uses @fieldName format (recommended)
          if (sql.includes(`@${fieldName}`)) {
            paramValues[fieldName] = value;
          } else if (sql.includes(`$${fieldName}`)) {
            // Support PostgreSQL-style $fieldName and convert to inline (less secure)
            const escapedValue = String(value).replace(/'/g, "''");
            finalQuery = finalQuery.replace(new RegExp(`\\$${fieldName}`, 'g'), `'${escapedValue}'`);
          }
        });
      }

      console.log('[MSSQL-DATABASE] Executing mutation:', finalQuery);

      // If we have paramValues, use parameterized query; otherwise use inline
      const result = Object.keys(paramValues).length > 0
        ? await mssqlDb.executeMutation(finalQuery, paramValues)
        : await mssqlDb.executeMutation(finalQuery);

      console.log('[MSSQL-DATABASE] Mutation success, affected rows:', result.affectedRows);

      return {
        success: result.success,
        affectedRows: result.affectedRows,
        message: result.message,
        timestamp: result.timestamp,
      };
    } catch (error: any) {
      let errorMsg = 'Unknown error';
      let errorDetail = '';

      if (error instanceof Error) {
        errorMsg = error.message;
      } else if (error && typeof error === 'object') {
        errorMsg = error.message || error.error || JSON.stringify(error);
        errorDetail = error.detail || error.code || '';
      }

      console.error('[MSSQL-DATABASE] Mutation failed:', errorMsg);
      if (errorDetail) console.error('[MSSQL-DATABASE] Error detail:', errorDetail);
      throw new Error(`SQL Server mutation execution failed: ${errorMsg}${errorDetail ? ' - ' + errorDetail : ''}`);
    }
  });

  // Get table information
  sdk.addCollection('mssql-database', 'table-info', async (params: any) => {
    const { tableName, schemaName } = params;

    if (!tableName) {
      throw new Error('tableName parameter is required');
    }

    try {
      const result = await mssqlDb.getTableInfo(tableName, schemaName || 'dbo');

      return {
        success: true,
        data: result,
        timestamp: new Date().toISOString(),
      };
    } catch (error: any) {
      throw new Error(`Failed to get table info: ${error.message || error}`);
    }
  });

  // Test connection
  sdk.addCollection('mssql-database', 'test-connection', async () => {
    try {
      const isConnected = await mssqlDb.testConnection();

      return {
        success: isConnected,
        message: isConnected ? 'SQL Server connection successful' : 'SQL Server connection failed',
        timestamp: new Date().toISOString(),
      };
    } catch (error: any) {
      return {
        success: false,
        message: `SQL Server connection failed: ${error.message || error}`,
        timestamp: new Date().toISOString(),
      };
    }
  });

}

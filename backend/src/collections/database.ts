import * as pgDb from '../services/database';
import * as mssqlDb from '../services/mssql-database';
import type { CollectionContext } from './types';

/**
 * Detect which database is configured
 * Priority: SQL Server > PostgreSQL (if both configured, SQL Server takes priority)
 */
function getDatabaseType(): 'mssql' | 'postgresql' | null {
	if (mssqlDb.isConfigured()) {
		return 'mssql';
	}
	if (pgDb.isConfigured()) {
		return 'postgresql';
	}
	return null;
}

/**
 * Get the appropriate database service based on configuration
 */
function getDbService() {
	const dbType = getDatabaseType();
	if (dbType === 'mssql') {
		return { db: mssqlDb, type: 'mssql' as const };
	}
	return { db: pgDb, type: 'postgresql' as const };
}

/**
 * Register database query execution collections
 * Automatically routes to PostgreSQL or SQL Server based on configuration
 */
export async function registerDatabaseCollections({ sdk }: CollectionContext): Promise<void> {
	const dbType = getDatabaseType();

	if (!dbType) {
		console.log('⊘ Skipped: database collections (no database configured)');
		console.log('  To enable, set DATABASE_URL (PostgreSQL) or MSSQL_* variables (SQL Server)\n');
		return;
	}

	const { db, type } = getDbService();
	console.log(`[DATABASE] Using ${type.toUpperCase()} as the application database`);

	// Execute SQL query
	// Supports two formats:
	// 1. Plain SQL string: "SELECT * FROM orders WHERE status = 'Pending'"
	// 2. Parameterized JSON: JSON.stringify({ sql: "SELECT * FROM orders WHERE date >= $startDate", values: { startDate: "2024-01-01" } })
	sdk.addCollection('database', 'execute', async (params: any) => {
		const { sql } = params;

		if (!sql || sql.trim().length === 0) {
			throw new Error('SQL query parameter is required');
		}

		let finalQuery = sql;

		// Check if it's a parameterized query (JSON format)
		if (sql.trim().startsWith('{')) {
			try {
				const parsed = JSON.parse(sql);
				finalQuery = parsed.sql;

				// Replace $paramName placeholders with actual values
				if (parsed.values && typeof parsed.values === 'object') {
					Object.keys(parsed.values).forEach((paramName: string) => {
						const value = parsed.values[paramName];

						// Handle null values
						if (value === null || value === undefined) {
							finalQuery = finalQuery.replace(new RegExp(`\\$${paramName}`, 'g'), 'NULL');
						} else {
							// Escape single quotes to prevent SQL injection
							const escapedValue = String(value).replace(/'/g, "''");
							// Replace $paramName with 'escapedValue'
							finalQuery = finalQuery.replace(new RegExp(`\\$${paramName}`, 'g'), `'${escapedValue}'`);
						}
					});
				}

				console.log(`[DATABASE:${type}] Parameterized query:`, finalQuery);
			} catch (e) {
				// Not valid JSON, use as plain SQL (backward compatible)
				console.log(`[DATABASE:${type}] Plain SQL query:`, sql);
			}
		}

		try {
			const result = await db.executeQuery(finalQuery);

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

			console.error(`[DATABASE:${type}] Query failed:`, errorMsg);
			if (errorDetail) console.error(`[DATABASE:${type}] Error detail:`, errorDetail);
			console.error(`[DATABASE:${type}] Failed SQL:`, finalQuery);
			throw new Error(`Database query execution failed: ${errorMsg}${errorDetail ? ' - ' + errorDetail : ''}`);
		}
	});

	// Execute SQL mutation
	sdk.addCollection('database', 'mutation', async (params: any) => {
		const { sql, params: queryParams, values } = JSON.parse(params.sql);

		if (!sql || sql.trim().length === 0) {
			throw new Error('SQL mutation parameter is required');
		}

		try {
			// Replace $fieldName placeholders with actual values from form
			let finalQuery = sql;
			if (values && typeof values === 'object') {
				Object.keys(values).forEach((fieldName: string) => {
					const value = values[fieldName];
					// Escape single quotes to prevent SQL injection
					const escapedValue = String(value).replace(/'/g, "''");
					// Replace $fieldName with 'escapedValue'
					finalQuery = finalQuery.replace(new RegExp(`\\$${fieldName}`, 'g'), `'${escapedValue}'`);
				});
			}

			console.log(`[DATABASE:${type}] Executing mutation:`, finalQuery);
			const result = await db.executeMutation(finalQuery, queryParams);
			console.log(`[DATABASE:${type}] Mutation success, affected rows:`, result.affectedRows);

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

			console.error(`[DATABASE:${type}] Mutation failed:`, errorMsg);
			if (errorDetail) console.error(`[DATABASE:${type}] Error detail:`, errorDetail);
			throw new Error(`Database mutation execution failed: ${errorMsg}${errorDetail ? ' - ' + errorDetail : ''}`);
		}
	});

}

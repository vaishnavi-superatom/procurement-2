/**
 * MSSQL Schema Extractor
 *
 * Extracts database schema from MSSQL and outputs JSON matching the schema.json format.
 *
 * Usage:
 *   npx tsx analysis/code/extract_mssql_schema.ts
 *
 * Reads connection details from analysis/.env:
 *   MSSQL_SERVER, MSSQL_DATABASE, MSSQL_USER, MSSQL_PASSWORD, MSSQL_PORT
 *
 * Optional: MSSQL_OUTPUT_NAME to customize the output filename (defaults to database name)
 */

import sql from 'mssql';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

// Load env from analysis/.env
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const config: sql.config = {
  server: process.env.MSSQL_SERVER!,
  database: process.env.MSSQL_DATABASE!,
  user: process.env.MSSQL_USER!,
  password: process.env.MSSQL_PASSWORD!,
  port: parseInt(process.env.MSSQL_PORT || '1433'),
  options: {
    encrypt: false,
    trustServerCertificate: true,
  },
  requestTimeout: 120000,
  connectionTimeout: 30000,
};

const outputName = process.env.MSSQL_OUTPUT_NAME || config.database!;

// Type mapping from MSSQL native types to normalized types
function normalizeType(nativeType: string): string {
  const lower = nativeType.toLowerCase();
  if (['int', 'bigint', 'smallint', 'tinyint', 'numeric', 'decimal', 'float', 'real', 'money', 'smallmoney'].includes(lower)) return 'NUMBER';
  if (['varchar', 'nvarchar', 'char', 'nchar', 'text', 'ntext', 'uniqueidentifier', 'xml'].includes(lower)) return 'TEXT';
  if (['date', 'datetime', 'datetime2', 'smalldatetime', 'datetimeoffset', 'time'].includes(lower)) return 'TIMESTAMP';
  if (['bit'].includes(lower)) return 'BOOLEAN';
  if (['binary', 'varbinary', 'image'].includes(lower)) return 'BINARY';
  return 'TEXT';
}

// Cardinality classification
function classifyCardinality(distinct: number, rowCount: number): string {
  if (rowCount === 0) return 'low';
  const ratio = distinct / rowCount;
  if (ratio >= 0.95) return 'unique';
  if (ratio >= 0.5) return 'high';
  if (ratio >= 0.1) return 'medium';
  return 'low';
}

// Generate a simple column description
function describeColumn(tableName: string, colName: string, dataType: string, isPK: boolean, isFK: boolean): string {
  if (isPK) return `Primary key for ${tableName}`;
  if (isFK) return `Reference to related table`;
  const lower = colName.toLowerCase();
  if (lower.includes('created') && lower.includes('at')) return 'Timestamp when record was created';
  if (lower.includes('updated') && lower.includes('at')) return 'Timestamp when record was last updated';
  if (lower.includes('deleted') && lower.includes('at')) return 'Timestamp when record was deleted';
  if (lower.includes('name')) return `Name field`;
  if (lower.includes('email')) return 'Email address';
  if (lower.includes('phone')) return 'Phone number';
  if (lower.includes('address')) return 'Address field';
  if (lower.includes('description') || lower.includes('desc')) return 'Description';
  if (lower.includes('status')) return 'Status indicator';
  if (lower.includes('amount') || lower.includes('price') || lower.includes('cost') || lower.includes('total')) return 'Monetary value';
  if (lower.includes('qty') || lower.includes('quantity')) return 'Quantity';
  if (lower.includes('date')) return 'Date field';
  if (lower === 'id') return `Primary identifier`;
  // Fallback: humanize column name
  return colName.replace(/([A-Z])/g, ' $1').replace(/_/g, ' ').trim();
}

async function extractSchema() {
  console.log(`Connecting to ${config.server}:${config.port} / ${config.database} ...`);
  const pool = await sql.connect(config);
  console.log('Connected.');

  // 1. Get all user tables with row counts
  console.log('Fetching tables...');
  const tablesResult = await pool.request().query(`
    SELECT
      t.TABLE_SCHEMA,
      t.TABLE_NAME,
      p.rows AS row_count
    FROM INFORMATION_SCHEMA.TABLES t
    LEFT JOIN sys.tables st ON st.name = t.TABLE_NAME
    LEFT JOIN sys.partitions p ON st.object_id = p.object_id AND p.index_id IN (0, 1)
    WHERE t.TABLE_TYPE = 'BASE TABLE'
    ORDER BY t.TABLE_SCHEMA, t.TABLE_NAME
  `);
  console.log(`Found ${tablesResult.recordset.length} tables.`);

  // 2. Get all columns with PK and FK info
  console.log('Fetching columns...');
  const columnsResult = await pool.request().query(`
    SELECT
      c.TABLE_SCHEMA,
      c.TABLE_NAME,
      c.COLUMN_NAME,
      c.DATA_TYPE,
      c.IS_NULLABLE,
      c.CHARACTER_MAXIMUM_LENGTH,
      CASE WHEN pk.COLUMN_NAME IS NOT NULL THEN 1 ELSE 0 END AS IS_PRIMARY_KEY,
      fk.REFERENCED_TABLE_NAME,
      fk.REFERENCED_COLUMN_NAME
    FROM INFORMATION_SCHEMA.COLUMNS c
    LEFT JOIN (
      SELECT ku.TABLE_SCHEMA, ku.TABLE_NAME, ku.COLUMN_NAME
      FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
      JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku
        ON tc.CONSTRAINT_NAME = ku.CONSTRAINT_NAME
        AND tc.TABLE_SCHEMA = ku.TABLE_SCHEMA
      WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
    ) pk ON c.TABLE_SCHEMA = pk.TABLE_SCHEMA
      AND c.TABLE_NAME = pk.TABLE_NAME
      AND c.COLUMN_NAME = pk.COLUMN_NAME
    LEFT JOIN (
      SELECT
        cu.TABLE_SCHEMA,
        cu.TABLE_NAME,
        cu.COLUMN_NAME,
        ku2.TABLE_NAME AS REFERENCED_TABLE_NAME,
        ku2.COLUMN_NAME AS REFERENCED_COLUMN_NAME
      FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS rc
      JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE cu
        ON rc.CONSTRAINT_NAME = cu.CONSTRAINT_NAME
      JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku2
        ON rc.UNIQUE_CONSTRAINT_NAME = ku2.CONSTRAINT_NAME
    ) fk ON c.TABLE_SCHEMA = fk.TABLE_SCHEMA
      AND c.TABLE_NAME = fk.TABLE_NAME
      AND c.COLUMN_NAME = fk.COLUMN_NAME
    ORDER BY c.TABLE_SCHEMA, c.TABLE_NAME, c.ORDINAL_POSITION
  `);

  // Build table map
  const tableMap = new Map<string, any>();
  for (const row of tablesResult.recordset) {
    const key = `${row.TABLE_SCHEMA}.${row.TABLE_NAME}`;
    tableMap.set(key, {
      name: row.TABLE_NAME,
      fullName: key,
      rowCount: row.row_count || 0,
      description: '',
      columns: [],
    });
  }

  // Group columns by table
  const columnsByTable = new Map<string, any[]>();
  for (const col of columnsResult.recordset) {
    const key = `${col.TABLE_SCHEMA}.${col.TABLE_NAME}`;
    if (!columnsByTable.has(key)) columnsByTable.set(key, []);
    columnsByTable.get(key)!.push(col);
  }

  // 3. Process each table — get statistics and sample values
  const numericTypes = ['int', 'bigint', 'smallint', 'tinyint', 'numeric', 'decimal', 'float', 'real', 'money', 'smallmoney'];
  const dateTypes = ['date', 'datetime', 'datetime2', 'smalldatetime', 'datetimeoffset'];
  const boolTypes = ['bit'];

  let tableCount = 0;
  const totalTables = tableMap.size;

  for (const [tableKey, table] of tableMap) {
    tableCount++;
    const [schema, tableName] = tableKey.split('.');
    const cols = columnsByTable.get(tableKey) || [];
    const rowCount = table.rowCount;

    console.log(`[${tableCount}/${totalTables}] Processing ${tableKey} (${rowCount} rows, ${cols.length} columns)...`);

    for (const col of cols) {
      const isPK = col.IS_PRIMARY_KEY === 1;
      const isFK = !!col.REFERENCED_TABLE_NAME;
      const colDef: any = {
        name: col.COLUMN_NAME,
        type: normalizeType(col.DATA_TYPE),
        nativeType: col.DATA_TYPE,
        nullable: col.IS_NULLABLE === 'YES',
        description: describeColumn(tableName, col.COLUMN_NAME, col.DATA_TYPE, isPK, isFK),
      };

      if (isPK) colDef.isPrimaryKey = true;
      if (isFK) {
        colDef.isForeignKey = true;
        colDef.references = {
          table: col.REFERENCED_TABLE_NAME,
          column: col.REFERENCED_COLUMN_NAME,
        };
      }

      // Get statistics if table has rows
      if (rowCount > 0) {
        try {
          const lowerType = col.DATA_TYPE.toLowerCase();

          if (boolTypes.includes(lowerType)) {
            const statsRes = await pool.request().query(`
              SELECT
                SUM(CASE WHEN [${col.COLUMN_NAME}] = 1 THEN 1 ELSE 0 END) as true_count,
                SUM(CASE WHEN [${col.COLUMN_NAME}] = 0 THEN 1 ELSE 0 END) as false_count,
                COUNT([${col.COLUMN_NAME}]) as non_null
              FROM [${schema}].[${tableName}]
            `);
            const s = statsRes.recordset[0];
            if (s) {
              colDef.statistics = { distinct: 2 };
              colDef.cardinality = 'low';
            }
          } else if (numericTypes.includes(lowerType)) {
            const statsRes = await pool.request().query(`
              SELECT
                COUNT(DISTINCT [${col.COLUMN_NAME}]) as distinct_count,
                MIN([${col.COLUMN_NAME}]) as min_value,
                MAX([${col.COLUMN_NAME}]) as max_value
              FROM [${schema}].[${tableName}]
            `);
            const s = statsRes.recordset[0];
            if (s) {
              const distinct = s.distinct_count || 0;
              colDef.statistics = {
                distinct,
                ...(s.min_value != null ? { min: Number(s.min_value) } : {}),
                ...(s.max_value != null ? { max: Number(s.max_value) } : {}),
              };
              colDef.cardinality = classifyCardinality(distinct, rowCount);
            }
          } else if (dateTypes.includes(lowerType)) {
            const statsRes = await pool.request().query(`
              SELECT
                COUNT(DISTINCT [${col.COLUMN_NAME}]) as distinct_count,
                MIN([${col.COLUMN_NAME}]) as min_value,
                MAX([${col.COLUMN_NAME}]) as max_value
              FROM [${schema}].[${tableName}]
            `);
            const s = statsRes.recordset[0];
            if (s) {
              const distinct = s.distinct_count || 0;
              colDef.statistics = {
                distinct,
                ...(s.min_value ? { min: String(s.min_value).split('T')[0] } : {}),
                ...(s.max_value ? { max: String(s.max_value).split('T')[0] } : {}),
              };
              colDef.cardinality = classifyCardinality(distinct, rowCount);
            }
          } else {
            // Text and other types — just distinct count
            const statsRes = await pool.request().query(`
              SELECT COUNT(DISTINCT [${col.COLUMN_NAME}]) as distinct_count
              FROM [${schema}].[${tableName}]
            `);
            const s = statsRes.recordset[0];
            if (s) {
              const distinct = s.distinct_count || 0;
              colDef.statistics = { distinct };
              colDef.cardinality = classifyCardinality(distinct, rowCount);
            }
          }

          // Get sample values for low cardinality columns (distinct <= 20)
          if (colDef.statistics?.distinct && colDef.statistics.distinct <= 20 && !boolTypes.includes(lowerType)) {
            try {
              const sampleRes = await pool.request().query(`
                SELECT DISTINCT TOP 20 [${col.COLUMN_NAME}] as val
                FROM [${schema}].[${tableName}]
                WHERE [${col.COLUMN_NAME}] IS NOT NULL
                ORDER BY [${col.COLUMN_NAME}]
              `);
              const samples = sampleRes.recordset
                .map((r: any) => r.val != null ? String(r.val).replace(/\u0000/g, '') : null)
                .filter((v): v is string => !!v && v !== '');
              if (samples.length > 0) {
                colDef.sampleValues = samples;
              }
            } catch {
              // Some columns can't be sorted/distincted, skip
            }
          }
        } catch (statsErr) {
          // Skip statistics on error
        }
      }

      table.columns.push(colDef);
    }
  }

  // Build output
  const output = {
    database: config.database,
    databaseType: 'mssql',
    schema: 'dbo',
    description: `${config.database} Database (MSSQL) - Generated on ${new Date().toISOString()}`,
    tables: Array.from(tableMap.values()),
  };

  // Write to file
  const outputPath = path.resolve(__dirname, `../data/schema_${outputName}.json`);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`\nSchema written to: ${outputPath}`);
  console.log(`Tables: ${output.tables.length}`);

  await pool.close();
}

extractSchema().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

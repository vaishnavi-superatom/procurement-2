#!/usr/bin/env python3
"""
Database Analysis Script
Analyzes PostgreSQL or SQL Server database structure and generates schema.json and documentation.
Auto-detects database type from DATABASE_URL.

OUTPUT FORMAT:
    The generated schema.json follows the structure defined in:
    analysis/data/SCHEMA_STRUCTURE.md

    This file serves as the reference specification for the schema format.
    Claude Code should read SCHEMA_STRUCTURE.md to understand the expected format
    when generating or modifying schema files.

Usage:
    1. Copy .env.example to .env in the analysis folder
    2. Set DATABASE_URL in .env file:
       - PostgreSQL: postgresql://user:password@host:port/database
       - SQL Server: mssql://user:password@host:port/database
                 or: mssql://user:password@host/database?driver=ODBC+Driver+17+for+SQL+Server
    3. Run: python analyze_database.py
"""

import json
from datetime import datetime
from collections import defaultdict
import os
import re
from pathlib import Path
from urllib.parse import urlparse, parse_qs

# Load environment variables from .env file
try:
    from dotenv import load_dotenv

    # Look for .env file in the analysis folder (parent of code folder)
    script_dir = Path(__file__).parent
    env_path = script_dir.parent / '.env'

    if env_path.exists():
        load_dotenv(env_path)
        print(f"[ENV] Loaded environment from: {env_path}")
    else:
        # Also check current directory
        if Path('.env').exists():
            load_dotenv()
            print("[ENV] Loaded environment from: .env")
        else:
            print("[ENV] No .env file found. Using environment variables or defaults.")
except ImportError:
    print("[ENV] python-dotenv not installed. Using environment variables only.")
    print("      Install with: pip install python-dotenv")

# Database connection string - Set via DATABASE_URL in .env file
CONNECTION_STRING = os.getenv("DATABASE_URL")

if not CONNECTION_STRING:
    print("\n[ERROR] DATABASE_URL not set!")
    print("        Please create a .env file in the analysis folder with:")
    print("        DATABASE_URL=postgresql://user:password@host:port/database")
    print("        or")
    print("        DATABASE_URL=mssql://user:password@host:port/database")
    print("\n        Or set the DATABASE_URL environment variable.")
    exit(1)


def detect_database_type(connection_string):
    """Detect database type from connection string"""
    conn_lower = connection_string.lower()
    if conn_lower.startswith('mssql://') or conn_lower.startswith('sqlserver://'):
        return 'mssql'
    elif conn_lower.startswith('postgresql://') or conn_lower.startswith('postgres://'):
        return 'postgresql'
    else:
        # Try to guess from common patterns
        if 'sqlserver' in conn_lower or 'mssql' in conn_lower:
            return 'mssql'
        return 'postgresql'  # Default to PostgreSQL


DATABASE_TYPE = detect_database_type(CONNECTION_STRING)
print(f"[DB] Detected database type: {DATABASE_TYPE.upper()}")


# ============================================================================
# Database Adapters - Abstract the differences between PostgreSQL and SQL Server
# ============================================================================

class PostgreSQLAdapter:
    """Adapter for PostgreSQL database"""

    def __init__(self, connection_string):
        self.connection_string = connection_string
        self.conn = None
        self.cursor = None

    def connect(self):
        """Establish connection to PostgreSQL database"""
        import psycopg2
        try:
            self.conn = psycopg2.connect(self.connection_string)
            self.cursor = self.conn.cursor()
            return self
        except Exception as e:
            print(f"Error connecting to PostgreSQL: {e}")
            raise

    def close(self):
        """Close the connection"""
        if self.cursor:
            self.cursor.close()
        if self.conn:
            self.conn.close()

    def get_database_info(self):
        """Get basic database information"""
        self.cursor.execute("SELECT current_database(), current_user, version();")
        db_name, user, version = self.cursor.fetchone()
        return {
            "database_name": db_name,
            "database_type": "postgresql",
            "user": user,
            "version": version,
            "analysis_timestamp": datetime.now().isoformat()
        }

    def get_all_tables(self):
        """Get list of all tables in the database"""
        query = """
            SELECT table_schema, table_name, table_type
            FROM information_schema.tables
            WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
            ORDER BY table_schema, table_name;
        """
        self.cursor.execute(query)
        return [(row[0], row[1], row[2]) for row in self.cursor.fetchall()]

    def get_table_columns(self, schema, table):
        """Get column information for a specific table"""
        query = """
            SELECT
                column_name,
                data_type,
                character_maximum_length,
                is_nullable,
                column_default
            FROM information_schema.columns
            WHERE table_schema = %s AND table_name = %s
            ORDER BY ordinal_position;
        """
        self.cursor.execute(query, (schema, table))
        return [(row[0], row[1], row[2], row[3], row[4]) for row in self.cursor.fetchall()]

    def get_table_row_count(self, schema, table):
        """Get row count for a specific table"""
        try:
            query = f'SELECT COUNT(*) FROM "{schema}"."{table}";'
            self.cursor.execute(query)
            return self.cursor.fetchone()[0]
        except Exception as e:
            return f"Error: {str(e)}"

    def get_table_constraints(self, schema, table):
        """Get constraints for a specific table"""
        query = """
            SELECT
                tc.constraint_name,
                tc.constraint_type,
                kcu.column_name,
                ccu.table_name AS foreign_table_name,
                ccu.column_name AS foreign_column_name
            FROM information_schema.table_constraints AS tc
            LEFT JOIN information_schema.key_column_usage AS kcu
                ON tc.constraint_name = kcu.constraint_name
                AND tc.table_schema = kcu.table_schema
            LEFT JOIN information_schema.constraint_column_usage AS ccu
                ON ccu.constraint_name = tc.constraint_name
                AND ccu.table_schema = tc.table_schema
            WHERE tc.table_schema = %s AND tc.table_name = %s;
        """
        self.cursor.execute(query, (schema, table))
        return [(row[0], row[1], row[2], row[3], row[4]) for row in self.cursor.fetchall()]

    def get_indexes(self, schema, table):
        """Get indexes for a specific table"""
        query = """
            SELECT
                indexname,
                indexdef
            FROM pg_indexes
            WHERE schemaname = %s AND tablename = %s;
        """
        self.cursor.execute(query, (schema, table))
        return [(row[0], row[1]) for row in self.cursor.fetchall()]

    def get_column_statistics(self, schema, table, column, data_type):
        """Get statistics for a specific column"""
        stats = {}
        try:
            # For numeric columns
            if data_type in ['integer', 'bigint', 'numeric', 'real', 'double precision', 'smallint']:
                query = f'''
                    SELECT
                        MIN("{column}") as min_value,
                        MAX("{column}") as max_value,
                        AVG("{column}") as avg_value,
                        COUNT(DISTINCT "{column}") as distinct_count,
                        COUNT("{column}") as non_null_count
                    FROM "{schema}"."{table}";
                '''
                self.cursor.execute(query)
                result = self.cursor.fetchone()
                if result:
                    stats = {
                        "min": float(result[0]) if result[0] is not None else None,
                        "max": float(result[1]) if result[1] is not None else None,
                        "avg": float(result[2]) if result[2] is not None else None,
                        "distinct_count": result[3],
                        "non_null_count": result[4]
                    }

            # For text columns
            elif data_type in ['character varying', 'varchar', 'text', 'char', 'character', 'uuid']:
                query = f'''
                    SELECT
                        COUNT(DISTINCT "{column}") as distinct_count,
                        COUNT("{column}") as non_null_count,
                        MAX(LENGTH("{column}"::text)) as max_length,
                        MIN(LENGTH("{column}"::text)) as min_length
                    FROM "{schema}"."{table}";
                '''
                self.cursor.execute(query)
                result = self.cursor.fetchone()
                if result:
                    stats = {
                        "distinct_count": result[0],
                        "non_null_count": result[1],
                        "max_length": result[2],
                        "min_length": result[3]
                    }

            # For date/timestamp columns
            elif data_type in ['date', 'timestamp', 'timestamp without time zone', 'timestamp with time zone']:
                query = f'''
                    SELECT
                        MIN("{column}") as min_date,
                        MAX("{column}") as max_date,
                        COUNT(DISTINCT "{column}") as distinct_count,
                        COUNT("{column}") as non_null_count
                    FROM "{schema}"."{table}";
                '''
                self.cursor.execute(query)
                result = self.cursor.fetchone()
                if result:
                    stats = {
                        "min_date": str(result[0]) if result[0] is not None else None,
                        "max_date": str(result[1]) if result[1] is not None else None,
                        "distinct_count": result[2],
                        "non_null_count": result[3]
                    }

            # For boolean columns
            elif data_type == 'boolean':
                query = f'''
                    SELECT
                        COUNT(CASE WHEN "{column}" = TRUE THEN 1 END) as true_count,
                        COUNT(CASE WHEN "{column}" = FALSE THEN 1 END) as false_count,
                        COUNT("{column}") as non_null_count
                    FROM "{schema}"."{table}";
                '''
                self.cursor.execute(query)
                result = self.cursor.fetchone()
                if result:
                    stats = {
                        "true_count": result[0],
                        "false_count": result[1],
                        "non_null_count": result[2]
                    }

        except Exception as e:
            stats["error"] = str(e)

        return stats

    def get_sample_values(self, schema, table, column, data_type, distinct_count):
        """Get sample values for low cardinality columns"""
        if distinct_count > 20:
            return None

        try:
            query = f'''
                SELECT DISTINCT "{column}"
                FROM "{schema}"."{table}"
                WHERE "{column}" IS NOT NULL
                ORDER BY "{column}"
                LIMIT 20;
            '''
            self.cursor.execute(query)
            results = self.cursor.fetchall()
            return [str(row[0]) for row in results if row[0] is not None]
        except:
            return None

    def map_to_standard_type(self, db_type):
        """Map PostgreSQL types to standard types"""
        type_mapping = {
            'integer': 'NUMBER',
            'bigint': 'NUMBER',
            'smallint': 'NUMBER',
            'serial': 'NUMBER',
            'bigserial': 'NUMBER',
            'numeric': 'NUMBER',
            'decimal': 'NUMBER',
            'real': 'NUMBER',
            'double precision': 'NUMBER',
            'float': 'NUMBER',
            'character varying': 'TEXT',
            'varchar': 'TEXT',
            'text': 'TEXT',
            'char': 'TEXT',
            'character': 'TEXT',
            'uuid': 'TEXT',
            'boolean': 'BOOLEAN',
            'bool': 'BOOLEAN',
            'date': 'TIMESTAMP',
            'time': 'TIMESTAMP',
            'timetz': 'TIMESTAMP',
            'timestamp': 'TIMESTAMP',
            'timestamp without time zone': 'TIMESTAMP',
            'timestamp with time zone': 'TIMESTAMP',
            'timestamptz': 'TIMESTAMP',
            'jsonb': 'JSON',
            'json': 'JSON',
            'bytea': 'BINARY',
            'ARRAY': 'ARRAY'
        }
        # Handle array types
        if db_type.endswith('[]') or 'ARRAY' in db_type.upper():
            return 'ARRAY'
        return type_mapping.get(db_type.lower(), 'TEXT')

    def get_default_schema(self):
        """Get default schema name"""
        return "public"

    def generate_date_trunc_query(self, date_col, table_name):
        """Generate date truncation query for time-based analysis"""
        return f"SELECT DATE_TRUNC('month', {date_col}) as month, COUNT(*) as count FROM {table_name} GROUP BY month ORDER BY month DESC;"


class MSSQLAdapter:
    """Adapter for Microsoft SQL Server database"""

    def __init__(self, connection_string):
        self.connection_string = connection_string
        self.conn = None
        self.cursor = None
        self._parse_connection_string()

    def _parse_connection_string(self):
        """Parse the connection string to extract components"""
        # Handle mssql:// URL format
        if self.connection_string.startswith('mssql://') or self.connection_string.startswith('sqlserver://'):
            # Replace mssql:// with http:// for URL parsing
            url_str = self.connection_string.replace('mssql://', 'http://').replace('sqlserver://', 'http://')
            parsed = urlparse(url_str)

            self.server = parsed.hostname
            self.port = parsed.port or 1433
            self.database = parsed.path.lstrip('/').split('?')[0]
            self.user = parsed.username
            self.password = parsed.password
        else:
            raise ValueError(f"Unsupported SQL Server connection string format: {self.connection_string}")

    def connect(self):
        """Establish connection to SQL Server database using pymssql (no ODBC required)"""
        import pymssql
        try:
            self.conn = pymssql.connect(
                server=self.server,
                port=str(self.port),
                user=self.user,
                password=self.password,
                database=self.database
            )
            # Use cursor that returns results compatible with pyodbc style (tuple access)
            self.cursor = self.conn.cursor()
            return self
        except Exception as e:
            print(f"Error connecting to SQL Server: {e}")
            print("\nMake sure pymssql is installed: pip install pymssql")
            raise

    def _execute_query(self, query, params=None):
        """Execute query with parameters - converts ? placeholders to %s for pymssql"""
        # pymssql uses %s for parameters, convert ? to %s
        converted_query = query.replace('?', '%s')
        if params:
            self.cursor.execute(converted_query, params)
        else:
            self.cursor.execute(converted_query)
        return self.cursor

    def close(self):
        """Close the connection"""
        if self.cursor:
            self.cursor.close()
        if self.conn:
            self.conn.close()

    def get_database_info(self):
        """Get basic database information"""
        self.cursor.execute("SELECT DB_NAME() as db_name, SYSTEM_USER as db_user, @@VERSION as version")
        row = self.cursor.fetchone()
        return {
            "database_name": row[0],
            "database_type": "mssql",
            "user": row[1],
            "version": row[2],
            "analysis_timestamp": datetime.now().isoformat()
        }

    def get_all_tables(self):
        """Get list of all tables in the database"""
        query = """
            SELECT
                s.name as table_schema,
                t.name as table_name,
                CASE WHEN t.type = 'U' THEN 'BASE TABLE' ELSE 'VIEW' END as table_type
            FROM sys.tables t
            INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
            WHERE t.is_ms_shipped = 0
            UNION ALL
            SELECT
                s.name as table_schema,
                v.name as table_name,
                'VIEW' as table_type
            FROM sys.views v
            INNER JOIN sys.schemas s ON v.schema_id = s.schema_id
            WHERE v.is_ms_shipped = 0
            ORDER BY table_schema, table_name;
        """
        self.cursor.execute(query)
        return [(row[0], row[1], row[2]) for row in self.cursor.fetchall()]

    def get_table_columns(self, schema, table):
        """Get column information for a specific table"""
        query = """
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
            WHERE s.name = ? AND tbl.name = ?
            ORDER BY c.column_id;
        """
        self._execute_query(query, (schema, table))
        return [(row[0], row[1], row[2], row[3], row[4]) for row in self.cursor.fetchall()]

    def get_table_row_count(self, schema, table):
        """Get row count for a specific table"""
        try:
            # Use sys.dm_db_partition_stats for faster count on large tables
            query = """
                SELECT SUM(p.rows) as row_count
                FROM sys.partitions p
                INNER JOIN sys.tables t ON p.object_id = t.object_id
                INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
                WHERE s.name = ? AND t.name = ? AND p.index_id IN (0, 1)
            """
            self._execute_query(query, (schema, table))
            result = self.cursor.fetchone()
            return result[0] if result and result[0] else 0
        except Exception as e:
            # Fallback to COUNT(*) for views
            try:
                self.cursor.execute(f'SELECT COUNT(*) FROM [{schema}].[{table}]')
                return self.cursor.fetchone()[0]
            except:
                return f"Error: {str(e)}"

    def get_table_constraints(self, schema, table):
        """Get constraints for a specific table"""
        query = """
            SELECT
                kc.name as constraint_name,
                CASE
                    WHEN kc.type = 'PK' THEN 'PRIMARY KEY'
                    WHEN kc.type = 'UQ' THEN 'UNIQUE'
                END as constraint_type,
                c.name as column_name,
                NULL as foreign_table_name,
                NULL as foreign_column_name
            FROM sys.key_constraints kc
            INNER JOIN sys.tables t ON kc.parent_object_id = t.object_id
            INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
            INNER JOIN sys.index_columns ic ON kc.unique_index_id = ic.index_id AND kc.parent_object_id = ic.object_id
            INNER JOIN sys.columns c ON ic.object_id = c.object_id AND ic.column_id = c.column_id
            WHERE s.name = ? AND t.name = ?

            UNION ALL

            SELECT
                fk.name as constraint_name,
                'FOREIGN KEY' as constraint_type,
                c.name as column_name,
                ref_t.name as foreign_table_name,
                ref_c.name as foreign_column_name
            FROM sys.foreign_keys fk
            INNER JOIN sys.foreign_key_columns fkc ON fk.object_id = fkc.constraint_object_id
            INNER JOIN sys.tables t ON fk.parent_object_id = t.object_id
            INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
            INNER JOIN sys.columns c ON fkc.parent_object_id = c.object_id AND fkc.parent_column_id = c.column_id
            INNER JOIN sys.tables ref_t ON fkc.referenced_object_id = ref_t.object_id
            INNER JOIN sys.columns ref_c ON fkc.referenced_object_id = ref_c.object_id AND fkc.referenced_column_id = ref_c.column_id
            WHERE s.name = ? AND t.name = ?;
        """
        self._execute_query(query, (schema, table, schema, table))
        return [(row[0], row[1], row[2], row[3], row[4]) for row in self.cursor.fetchall()]

    def get_indexes(self, schema, table):
        """Get indexes for a specific table"""
        query = """
            SELECT
                i.name as indexname,
                'CREATE ' +
                CASE WHEN i.is_unique = 1 THEN 'UNIQUE ' ELSE '' END +
                i.type_desc COLLATE DATABASE_DEFAULT + ' INDEX [' + i.name COLLATE DATABASE_DEFAULT + '] ON [' + s.name COLLATE DATABASE_DEFAULT + '].[' + t.name COLLATE DATABASE_DEFAULT + ']' as indexdef
            FROM sys.indexes i
            INNER JOIN sys.tables t ON i.object_id = t.object_id
            INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
            WHERE s.name = ? AND t.name = ? AND i.name IS NOT NULL;
        """
        self._execute_query(query, (schema, table))
        return [(row[0], row[1]) for row in self.cursor.fetchall()]

    def get_column_statistics(self, schema, table, column, data_type):
        """Get statistics for a specific column"""
        stats = {}
        try:
            # For numeric columns
            if data_type in ['int', 'bigint', 'smallint', 'tinyint', 'numeric', 'decimal', 'float', 'real', 'money', 'smallmoney']:
                query = f'''
                    SELECT
                        MIN([{column}]) as min_value,
                        MAX([{column}]) as max_value,
                        AVG(CAST([{column}] as float)) as avg_value,
                        COUNT(DISTINCT [{column}]) as distinct_count,
                        COUNT([{column}]) as non_null_count
                    FROM [{schema}].[{table}];
                '''
                self.cursor.execute(query)
                result = self.cursor.fetchone()
                if result:
                    stats = {
                        "min": float(result[0]) if result[0] is not None else None,
                        "max": float(result[1]) if result[1] is not None else None,
                        "avg": float(result[2]) if result[2] is not None else None,
                        "distinct_count": result[3],
                        "non_null_count": result[4]
                    }

            # For text columns
            elif data_type in ['varchar', 'nvarchar', 'char', 'nchar', 'text', 'ntext', 'uniqueidentifier']:
                query = f'''
                    SELECT
                        COUNT(DISTINCT [{column}]) as distinct_count,
                        COUNT([{column}]) as non_null_count,
                        MAX(LEN(CAST([{column}] as nvarchar(max)))) as max_length,
                        MIN(LEN(CAST([{column}] as nvarchar(max)))) as min_length
                    FROM [{schema}].[{table}];
                '''
                self.cursor.execute(query)
                result = self.cursor.fetchone()
                if result:
                    stats = {
                        "distinct_count": result[0],
                        "non_null_count": result[1],
                        "max_length": result[2],
                        "min_length": result[3]
                    }

            # For date/timestamp columns
            elif data_type in ['date', 'datetime', 'datetime2', 'smalldatetime', 'datetimeoffset', 'time']:
                query = f'''
                    SELECT
                        MIN([{column}]) as min_date,
                        MAX([{column}]) as max_date,
                        COUNT(DISTINCT [{column}]) as distinct_count,
                        COUNT([{column}]) as non_null_count
                    FROM [{schema}].[{table}];
                '''
                self.cursor.execute(query)
                result = self.cursor.fetchone()
                if result:
                    stats = {
                        "min_date": str(result[0]) if result[0] is not None else None,
                        "max_date": str(result[1]) if result[1] is not None else None,
                        "distinct_count": result[2],
                        "non_null_count": result[3]
                    }

            # For boolean/bit columns
            elif data_type == 'bit':
                query = f'''
                    SELECT
                        SUM(CASE WHEN [{column}] = 1 THEN 1 ELSE 0 END) as true_count,
                        SUM(CASE WHEN [{column}] = 0 THEN 1 ELSE 0 END) as false_count,
                        COUNT([{column}]) as non_null_count
                    FROM [{schema}].[{table}];
                '''
                self.cursor.execute(query)
                result = self.cursor.fetchone()
                if result:
                    stats = {
                        "true_count": result[0],
                        "false_count": result[1],
                        "non_null_count": result[2]
                    }

        except Exception as e:
            stats["error"] = str(e)

        return stats

    def get_sample_values(self, schema, table, column, data_type, distinct_count):
        """Get sample values for low cardinality columns"""
        if distinct_count > 20:
            return None

        try:
            query = f'''
                SELECT DISTINCT TOP 20 [{column}]
                FROM [{schema}].[{table}]
                WHERE [{column}] IS NOT NULL
                ORDER BY [{column}];
            '''
            self.cursor.execute(query)
            results = self.cursor.fetchall()
            return [str(row[0]) for row in results if row[0] is not None]
        except:
            return None

    def map_to_standard_type(self, db_type):
        """Map SQL Server types to standard types"""
        type_mapping = {
            'int': 'NUMBER',
            'bigint': 'NUMBER',
            'smallint': 'NUMBER',
            'tinyint': 'NUMBER',
            'numeric': 'NUMBER',
            'decimal': 'NUMBER',
            'float': 'NUMBER',
            'real': 'NUMBER',
            'money': 'NUMBER',
            'smallmoney': 'NUMBER',
            'varchar': 'TEXT',
            'nvarchar': 'TEXT',
            'char': 'TEXT',
            'nchar': 'TEXT',
            'text': 'TEXT',
            'ntext': 'TEXT',
            'uniqueidentifier': 'TEXT',
            'bit': 'BOOLEAN',
            'date': 'TIMESTAMP',
            'datetime': 'TIMESTAMP',
            'datetime2': 'TIMESTAMP',
            'smalldatetime': 'TIMESTAMP',
            'datetimeoffset': 'TIMESTAMP',
            'time': 'TIMESTAMP',
            'binary': 'BINARY',
            'varbinary': 'BINARY',
            'image': 'BINARY',
            'xml': 'JSON',
            'json': 'JSON',
        }
        return type_mapping.get(db_type.lower(), 'TEXT')

    def get_default_schema(self):
        """Get default schema name"""
        return "dbo"

    def generate_date_trunc_query(self, date_col, table_name):
        """Generate date truncation query for time-based analysis (SQL Server syntax)"""
        return f"SELECT DATEADD(MONTH, DATEDIFF(MONTH, 0, [{date_col}]), 0) as month, COUNT(*) as count FROM {table_name} GROUP BY DATEADD(MONTH, DATEDIFF(MONTH, 0, [{date_col}]), 0) ORDER BY month DESC;"


def get_adapter(connection_string, db_type):
    """Factory function to get the appropriate database adapter"""
    if db_type == 'mssql':
        return MSSQLAdapter(connection_string)
    else:
        return PostgreSQLAdapter(connection_string)


# ============================================================================
# Common Functions (database-agnostic)
# ============================================================================

def determine_cardinality(distinct_count, total_count):
    """Determine cardinality level based on distinct count"""
    if total_count == 0:
        return None

    ratio = distinct_count / total_count

    # Unique: 95%+ distinct or matches total
    if ratio >= 0.95 or distinct_count == total_count:
        return "unique"
    # Low: 5% or less distinct values
    elif ratio <= 0.05 or distinct_count <= 10:
        return "low"
    # Medium: 5-25% distinct values
    elif ratio <= 0.25 or distinct_count <= 100:
        return "medium"
    # High: more than 25% distinct values
    else:
        return "high"


def generate_table_description(table_name, columns, constraints):
    """Auto-generate table description based on name and structure"""
    # Convert table name to readable format
    readable_name = table_name.replace('_', ' ').title()

    # Common table name patterns and their descriptions
    patterns = {
        r'^users?$': 'User accounts and profiles',
        r'^customers?$': 'Customer master data and profiles',
        r'^products?$': 'Product master catalog',
        r'^orders?$': 'Customer orders and transactions',
        r'^order_items?$': 'Individual line items within orders',
        r'^invoices?$': 'Invoice records',
        r'^payments?$': 'Payment transactions',
        r'^addresses?$': 'Shipping and billing addresses',
        r'^categories?$': 'Category hierarchy',
        r'^inventory$': 'Product inventory levels',
        r'^locations?$': 'Store and warehouse locations',
        r'^reviews?$': 'Customer reviews and ratings',
        r'^comments?$': 'User comments',
        r'^posts?$': 'User posts or content',
        r'^sessions?$': 'User session data',
        r'^logs?$': 'System or activity logs',
        r'^settings?$': 'Configuration settings',
        r'^permissions?$': 'User permissions and access control',
        r'^roles?$': 'User roles',
        r'^transactions?$': 'Financial transactions',
        r'^shipments?$': 'Shipping and delivery records',
        r'^notifications?$': 'User notifications',
        r'^messages?$': 'User messages',
        r'^files?$': 'File metadata and storage',
        r'^images?$': 'Image metadata',
        r'^tags?$': 'Content tags',
        r'^bookmarks?$': 'User bookmarks',
        r'^favorites?$': 'User favorites',
        r'^subscriptions?$': 'User subscriptions',
        r'^plans?$': 'Subscription or pricing plans',
        r'^coupons?$': 'Discount coupons',
        r'^discounts?$': 'Discount records',
        r'^taxes?$': 'Tax records',
        r'^refunds?$': 'Refund records',
        r'^returns?$': 'Return requests',
        r'^suppliers?$': 'Supplier information',
        r'^vendors?$': 'Vendor information',
        r'^employees?$': 'Employee records',
        r'^departments?$': 'Department structure',
        r'^projects?$': 'Project records',
        r'^tasks?$': 'Task management',
        r'^tickets?$': 'Support tickets',
        r'^events?$': 'Event records',
        r'^appointments?$': 'Appointment scheduling',
        r'^reservations?$': 'Reservation records',
    }

    # Check for pattern matches
    for pattern, description in patterns.items():
        if re.match(pattern, table_name.lower()):
            return description

    # Check for junction/bridge table patterns (many-to-many)
    if '_' in table_name:
        parts = table_name.split('_')
        if len(parts) == 2:
            return f"Junction table linking {parts[0]} and {parts[1]}"

    # Check for variant/detail patterns
    if 'variant' in table_name.lower():
        base = table_name.lower().replace('_variants', '').replace('_variant', '').replace('variants', '').replace('variant', '')
        if base:
            return f"Variations of {base.replace('_', ' ')}"
        return "Product or item variations"

    if 'detail' in table_name.lower():
        base = table_name.lower().replace('_details', '').replace('_detail', '').replace('details', '').replace('detail', '')
        if base:
            return f"Detailed information for {base.replace('_', ' ')}"
        return "Detailed records"

    # Check for history/audit patterns
    if 'history' in table_name.lower() or 'audit' in table_name.lower():
        return f"Historical/audit records for {readable_name.replace('History', '').replace('Audit', '').strip()}"

    # Default description
    return f"{readable_name} records"


def generate_column_description(table_name, column_name, data_type, is_pk, is_fk, fk_reference=None):
    """Auto-generate column description based on name and type"""
    col_lower = column_name.lower()

    # Primary key
    if is_pk:
        entity = table_name.replace('_', ' ').rstrip('s')
        return f"Primary key for {entity}"

    # Foreign key
    if is_fk and fk_reference:
        return f"Reference to {fk_reference['table']}"

    # ID columns (likely foreign keys even if not explicitly defined)
    if col_lower.endswith('_id') and not is_pk:
        ref_entity = col_lower[:-3].replace('_', ' ').title()
        return f"Reference to {ref_entity}"

    # Timestamp patterns
    timestamp_patterns = {
        'created_at': 'Timestamp when record was created',
        'updated_at': 'Timestamp when record was last updated',
        'deleted_at': 'Timestamp when record was soft-deleted',
        'modified_at': 'Timestamp when record was modified',
        'createdat': 'Timestamp when record was created',
        'updatedat': 'Timestamp when record was last updated',
        'createddate': 'Timestamp when record was created',
        'modifieddate': 'Timestamp when record was last updated',
        'published_at': 'Timestamp when published',
        'expires_at': 'Expiration timestamp',
        'started_at': 'Start timestamp',
        'ended_at': 'End timestamp',
        'completed_at': 'Completion timestamp',
        'cancelled_at': 'Cancellation timestamp',
        'failed_at': 'Failure timestamp',
        'last_login': 'Last login timestamp',
        'last_activity': 'Last activity timestamp',
        'order_date': 'Date when order was placed',
        'ship_date': 'Shipping date',
        'delivery_date': 'Delivery date',
        'due_date': 'Due date',
        'birth_date': 'Date of birth',
        'hire_date': 'Hire date',
    }
    if col_lower in timestamp_patterns:
        return timestamp_patterns[col_lower]

    # Boolean patterns
    if data_type in ['boolean', 'bit'] or col_lower.startswith('is_') or col_lower.startswith('has_') or col_lower.startswith('can_'):
        if col_lower.startswith('is_'):
            return f"Whether {col_lower[3:].replace('_', ' ')}"
        if col_lower.startswith('has_'):
            return f"Whether has {col_lower[4:].replace('_', ' ')}"
        if col_lower.startswith('can_'):
            return f"Whether can {col_lower[4:].replace('_', ' ')}"
        return f"Boolean flag for {col_lower.replace('_', ' ')}"

    # Common column name patterns
    column_descriptions = {
        'id': 'Unique identifier',
        'uuid': 'Unique identifier (UUID)',
        'name': 'Name or title',
        'title': 'Title',
        'description': 'Description text',
        'email': 'Email address',
        'phone': 'Phone number',
        'mobile': 'Mobile phone number',
        'address': 'Address',
        'street': 'Street address',
        'city': 'City name',
        'state': 'State or province',
        'country': 'Country',
        'postal_code': 'Postal/ZIP code',
        'zip_code': 'ZIP code',
        'zip': 'ZIP code',
        'first_name': 'First name',
        'last_name': 'Last name',
        'full_name': 'Full name',
        'username': 'Username',
        'password': 'Password (hashed)',
        'password_hash': 'Password hash',
        'status': 'Current status',
        'type': 'Type or category',
        'category': 'Category',
        'role': 'Role',
        'level': 'Level',
        'priority': 'Priority',
        'order': 'Display order',
        'sort_order': 'Sort order',
        'position': 'Position',
        'rank': 'Rank',
        'score': 'Score',
        'rating': 'Rating',
        'count': 'Count',
        'quantity': 'Quantity',
        'amount': 'Amount',
        'total': 'Total',
        'subtotal': 'Subtotal',
        'price': 'Price',
        'cost': 'Cost',
        'fee': 'Fee',
        'tax': 'Tax amount',
        'discount': 'Discount amount',
        'balance': 'Balance',
        'credit': 'Credit amount',
        'debit': 'Debit amount',
        'currency': 'Currency code',
        'weight': 'Weight',
        'height': 'Height',
        'width': 'Width',
        'depth': 'Depth',
        'length': 'Length',
        'size': 'Size',
        'color': 'Color',
        'url': 'URL',
        'link': 'Link URL',
        'image': 'Image URL or path',
        'image_url': 'Image URL',
        'avatar': 'Avatar image',
        'thumbnail': 'Thumbnail image',
        'file': 'File path or URL',
        'file_path': 'File path',
        'file_name': 'File name',
        'file_type': 'File type/MIME type',
        'file_size': 'File size',
        'content': 'Content',
        'body': 'Body content',
        'text': 'Text content',
        'message': 'Message text',
        'comment': 'Comment text',
        'note': 'Note',
        'notes': 'Notes',
        'metadata': 'Metadata (JSON)',
        'config': 'Configuration (JSON)',
        'settings': 'Settings (JSON)',
        'data': 'Data (JSON)',
        'payload': 'Payload data',
        'response': 'Response data',
        'request': 'Request data',
        'ip_address': 'IP address',
        'ip': 'IP address',
        'user_agent': 'User agent string',
        'browser': 'Browser',
        'device': 'Device',
        'platform': 'Platform',
        'version': 'Version',
        'locale': 'Locale',
        'language': 'Language',
        'timezone': 'Timezone',
        'token': 'Token',
        'code': 'Code',
        'sku': 'SKU (Stock Keeping Unit)',
        'barcode': 'Barcode',
        'serial_number': 'Serial number',
        'reference': 'Reference',
        'external_id': 'External system ID',
        'source': 'Source',
        'origin': 'Origin',
        'reason': 'Reason',
        'parent_id': 'Parent record reference (self-referential)',
    }

    if col_lower in column_descriptions:
        return column_descriptions[col_lower]

    # Pattern-based descriptions
    if col_lower.endswith('_url'):
        return f"URL for {col_lower[:-4].replace('_', ' ')}"
    if col_lower.endswith('_link'):
        return f"Link to {col_lower[:-5].replace('_', ' ')}"
    if col_lower.endswith('_path'):
        return f"File path for {col_lower[:-5].replace('_', ' ')}"
    if col_lower.endswith('_count'):
        return f"Count of {col_lower[:-6].replace('_', ' ')}"
    if col_lower.endswith('_amount'):
        return f"{col_lower[:-7].replace('_', ' ').title()} amount"
    if col_lower.endswith('_price'):
        return f"{col_lower[:-6].replace('_', ' ').title()} price"
    if col_lower.endswith('_fee'):
        return f"{col_lower[:-4].replace('_', ' ').title()} fee"
    if col_lower.endswith('_date'):
        return f"{col_lower[:-5].replace('_', ' ').title()} date"
    if col_lower.endswith('_time'):
        return f"{col_lower[:-5].replace('_', ' ').title()} time"
    if col_lower.endswith('_name'):
        return f"{col_lower[:-5].replace('_', ' ').title()} name"
    if col_lower.endswith('_type'):
        return f"{col_lower[:-5].replace('_', ' ').title()} type"
    if col_lower.endswith('_status'):
        return f"{col_lower[:-7].replace('_', ' ').title()} status"
    if col_lower.endswith('_code'):
        return f"{col_lower[:-5].replace('_', ' ').title()} code"
    if col_lower.endswith('_number'):
        return f"{col_lower[:-7].replace('_', ' ').title()} number"

    # JSON columns
    if data_type in ['json', 'jsonb', 'xml']:
        return f"{col_lower.replace('_', ' ').title()} (JSON)"

    # Default: convert column name to readable format
    return col_lower.replace('_', ' ').title()


def generate_common_queries(tables, relationships, adapter):
    """Auto-generate common queries based on table structure"""
    queries = []

    for table in tables:
        name = table['name']
        columns = table.get('columns', [])
        col_names = [c['name'] for c in columns]

        # Count query for every table
        queries.append({
            "description": f"Total {name} count",
            "query": f"SELECT COUNT(*) as total FROM {name};"
        })

        # Status breakdown if status column exists
        if 'status' in col_names:
            queries.append({
                "description": f"{name.title()} by status",
                "query": f"SELECT status, COUNT(*) as count FROM {name} GROUP BY status ORDER BY count DESC;"
            })

        # Type breakdown if type column exists
        if 'type' in col_names:
            queries.append({
                "description": f"{name.title()} by type",
                "query": f"SELECT type, COUNT(*) as count FROM {name} GROUP BY type ORDER BY count DESC;"
            })

        # Time-based analysis if timestamp columns exist
        date_cols = [c for c in col_names if c.lower() in ['created_at', 'createdat', 'createddate', 'order_date', 'orderdate', 'date', 'timestamp']]
        if date_cols:
            date_col = date_cols[0]
            queries.append({
                "description": f"{name.title()} by month",
                "query": adapter.generate_date_trunc_query(date_col, name)
            })

        # Amount/revenue analysis if amount columns exist
        amount_cols = [c for c in col_names if c in ['total_amount', 'amount', 'total', 'price', 'revenue']]
        if amount_cols:
            amount_col = amount_cols[0]
            queries.append({
                "description": f"Total {name} {amount_col.replace('_', ' ')}",
                "query": f"SELECT SUM({amount_col}) as total FROM {name};"
            })

    return queries[:15]


def analyze_database(adapter):
    """Main analysis function"""
    print("Starting database analysis...")

    adapter.connect()

    analysis_data = {
        "database_info": adapter.get_database_info(),
        "tables": []
    }

    # Get all tables
    tables = adapter.get_all_tables()
    print(f"\nFound {len(tables)} table(s) to analyze")

    for schema, table_name, table_type in tables:
        print(f"\nAnalyzing table: {schema}.{table_name}")

        table_data = {
            "schema": schema,
            "name": table_name,
            "type": table_type,
            "row_count": adapter.get_table_row_count(schema, table_name),
            "columns": [],
            "constraints": [],
            "indexes": []
        }

        # Get columns
        columns = adapter.get_table_columns(schema, table_name)
        for col_name, data_type, max_length, is_nullable, default_value in columns:
            print(f"  - Column: {col_name} ({data_type})")

            stats = adapter.get_column_statistics(schema, table_name, col_name, data_type)

            column_data = {
                "name": col_name,
                "data_type": data_type,
                "max_length": max_length,
                "is_nullable": is_nullable,
                "default_value": str(default_value) if default_value else None,
                "statistics": stats
            }

            # Add sample values for low cardinality columns
            if stats and 'distinct_count' in stats and stats['distinct_count'] and stats['distinct_count'] <= 20:
                sample_values = adapter.get_sample_values(schema, table_name, col_name, data_type, stats['distinct_count'])
                if sample_values:
                    column_data['sample_values'] = sample_values

            table_data["columns"].append(column_data)

        # Get constraints
        constraints = adapter.get_table_constraints(schema, table_name)
        for constraint_name, constraint_type, column_name, foreign_table, foreign_column in constraints:
            constraint_data = {
                "name": constraint_name,
                "type": constraint_type,
                "column": column_name,
                "foreign_table": foreign_table,
                "foreign_column": foreign_column
            }
            table_data["constraints"].append(constraint_data)

        # Get indexes
        indexes = adapter.get_indexes(schema, table_name)
        for index_name, index_def in indexes:
            index_data = {
                "name": index_name,
                "definition": index_def
            }
            table_data["indexes"].append(index_data)

        analysis_data["tables"].append(table_data)

    adapter.close()

    return analysis_data


def generate_schema_json(analysis_data, output_path, adapter):
    """Generate schema.json in the standard format"""
    print("\nGenerating schema.json...")

    db_info = analysis_data['database_info']
    db_name = db_info['database_name']
    db_type = db_info.get('database_type', 'postgresql')

    schema_data = {
        "database": db_name,
        "databaseType": db_type,
        "schema": adapter.get_default_schema(),
        "description": f"{db_name.title()} Database ({db_type.upper()}) - Generated on {db_info['analysis_timestamp']}",
        "tables": [],
        "relationships": []
    }

    # Process tables
    for table in analysis_data['tables']:
        table_schema = {
            "name": table['name'],
            "fullName": f"{table['schema']}.{table['name']}",
            "rowCount": table['row_count'] if isinstance(table['row_count'], int) else 0,
            "description": generate_table_description(table['name'], table['columns'], table['constraints']),
            "columns": []
        }

        # Process columns
        for col in table['columns']:
            # Check if primary key
            is_pk = any(c['type'] == 'PRIMARY KEY' and c['column'] == col['name']
                       for c in table['constraints'])

            # Check if foreign key
            fk_constraint = next((c for c in table['constraints']
                                 if c['type'] == 'FOREIGN KEY' and c['column'] == col['name']), None)
            is_fk = fk_constraint is not None
            fk_reference = None
            if fk_constraint:
                fk_reference = {
                    "table": fk_constraint['foreign_table'],
                    "column": fk_constraint['foreign_column']
                }

            column_schema = {
                "name": col['name'],
                "type": adapter.map_to_standard_type(col['data_type']),
                "nativeType": col['data_type'],
                "nullable": col['is_nullable'] == 'YES',
                "description": generate_column_description(
                    table['name'], col['name'], col['data_type'],
                    is_pk, is_fk, fk_reference
                )
            }

            # Add primary key flag
            if is_pk:
                column_schema['isPrimaryKey'] = True

            # Add foreign key information
            if is_fk:
                column_schema['isForeignKey'] = True
                column_schema['references'] = fk_reference

            # Add statistics
            stats = col.get('statistics', {})
            if stats and not stats.get('error'):
                stat_dict = {}

                if 'distinct_count' in stats:
                    stat_dict['distinct'] = stats['distinct_count']

                if 'min' in stats and stats['min'] is not None:
                    stat_dict['min'] = stats['min']
                if 'max' in stats and stats['max'] is not None:
                    stat_dict['max'] = stats['max']

                if stat_dict:
                    column_schema['statistics'] = stat_dict

                # Determine cardinality
                row_count = table_schema['rowCount']
                if 'distinct_count' in stats and stats['distinct_count'] and row_count > 0:
                    cardinality = determine_cardinality(
                        stats['distinct_count'],
                        row_count
                    )
                    if cardinality:
                        column_schema['cardinality'] = cardinality

                        if cardinality in ["low", "medium"] and 'sample_values' in col:
                            column_schema['sampleValues'] = col['sample_values']

            table_schema['columns'].append(column_schema)

        schema_data['tables'].append(table_schema)

    # Extract relationships
    schema_data['relationships'] = extract_relationships(analysis_data)

    # Generate common queries
    schema_data['commonQueries'] = generate_common_queries(
        schema_data['tables'],
        schema_data['relationships'],
        adapter
    )

    # Write to file
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(schema_data, f, indent=2, default=str)

    print(f"Schema JSON saved to: {output_path}")


def extract_relationships(analysis_data):
    """Extract relationship information from constraints"""
    relationships = []

    for table in analysis_data['tables']:
        for constraint in table['constraints']:
            if constraint['type'] == 'FOREIGN KEY':
                relationships.append({
                    "from": table['name'],
                    "to": constraint['foreign_table'],
                    "type": "many-to-one",
                    "keys": [constraint['column'], constraint['foreign_column']]
                })

    return relationships


def generate_schema_markdown(schema_data, output_path):
    """Generate a markdown documentation from schema.json"""
    print("\nGenerating schema.md...")

    db_type_display = schema_data.get('databaseType', 'postgresql').upper()

    md_content = f"""# {schema_data['database']} Database Schema

**Description:** {schema_data['description']}

## Overview

- **Database:** {schema_data['database']}
- **Database Type:** {db_type_display}
- **Schema:** {schema_data['schema']}
- **Total Tables:** {len(schema_data['tables'])}
- **Total Rows:** {sum(t['rowCount'] for t in schema_data['tables']):,}

## Tables

"""

    # Add table of contents
    for table in schema_data['tables']:
        md_content += f"- [{table['name']}](#{table['name'].lower()}) - {table['description']} ({table['rowCount']:,} rows)\n"

    md_content += "\n---\n\n"

    # Add detailed table documentation
    for table in schema_data['tables']:
        md_content += f"## {table['name']}\n\n"
        md_content += f"**Description:** {table['description']}\n\n"
        md_content += f"**Row Count:** {table['rowCount']:,}\n\n"

        # Columns table
        md_content += "### Columns\n\n"
        md_content += "| Column | Type | Nullable | Key | Description |\n"
        md_content += "|--------|------|----------|-----|-------------|\n"

        for col in table['columns']:
            key_indicator = ""
            if col.get('isPrimaryKey'):
                key_indicator = "PK"
            elif col.get('isForeignKey'):
                ref = col.get('references', {})
                key_indicator = f"FK -> {ref.get('table', '')}"

            native_type = col.get('nativeType', col['type'])
            md_content += f"| {col['name']} | {native_type} | "
            md_content += f"{'Yes' if col['nullable'] else 'No'} | {key_indicator} | "
            md_content += f"{col['description']} |\n"

        # Add statistics if available
        stats_cols = [c for c in table['columns'] if 'statistics' in c and c['statistics']]
        if stats_cols:
            md_content += "\n### Statistics\n\n"
            for col in stats_cols:
                stats = col['statistics']
                md_content += f"**{col['name']}:**\n"
                if 'distinct' in stats:
                    md_content += f"- Distinct values: {stats['distinct']:,}\n"
                if 'min' in stats:
                    md_content += f"- Min: {stats['min']}\n"
                if 'max' in stats:
                    md_content += f"- Max: {stats['max']}\n"
                if 'sampleValues' in col:
                    md_content += f"- Sample values: {', '.join(col['sampleValues'][:10])}\n"
                md_content += "\n"

        md_content += "---\n\n"

    # Add relationships
    if schema_data['relationships']:
        md_content += "## Relationships\n\n"
        md_content += "| From Table | To Table | Type | Foreign Key |\n"
        md_content += "|------------|----------|------|-------------|\n"

        for rel in schema_data['relationships']:
            md_content += f"| {rel['from']} | {rel['to']} | {rel['type']} | "
            md_content += f"{rel['keys'][0]} -> {rel['keys'][1]} |\n"

        md_content += "\n"

    # Add common queries
    if schema_data.get('commonQueries'):
        md_content += "## Common Queries\n\n"
        for i, query in enumerate(schema_data['commonQueries'], 1):
            md_content += f"### {i}. {query['description']}\n\n"
            md_content += f"```sql\n{query['query']}\n```\n\n"

    # Write to file
    with open(output_path, 'w', encoding='utf-8') as f:
        f.write(md_content)

    print(f"Schema markdown saved to: {output_path}")


def main():
    """Main execution function"""
    try:
        # Get database name from connection string for display
        db_name = CONNECTION_STRING.split('/')[-1].split('?')[0] if '/' in CONNECTION_STRING else 'database'

        # Create adapter based on database type
        adapter = get_adapter(CONNECTION_STRING, DATABASE_TYPE)

        # Perform analysis
        print("=" * 60)
        print(f"Database Schema Generator - {db_name}")
        print(f"Database Type: {DATABASE_TYPE.upper()}")
        print("=" * 60)
        print(f"Connection: {CONNECTION_STRING.split('@')[-1] if '@' in CONNECTION_STRING else 'configured'}")
        print("=" * 60)

        analysis_data = analyze_database(adapter)

        # Get output directory
        script_dir = os.path.dirname(os.path.abspath(__file__))
        data_dir = os.path.join(os.path.dirname(script_dir), 'data')

        # Ensure data directory exists
        os.makedirs(data_dir, exist_ok=True)

        # Generate schema.json
        schema_json_path = os.path.join(data_dir, 'schema.json')
        generate_schema_json(analysis_data, schema_json_path, adapter)

        # Load schema.json to generate markdown
        with open(schema_json_path, 'r', encoding='utf-8') as f:
            schema_data = json.load(f)

        # Generate schema.md
        schema_md_path = os.path.join(data_dir, 'schema.md')
        generate_schema_markdown(schema_data, schema_md_path)

        # Delete old analysis_data.json if it exists
        old_json_path = os.path.join(data_dir, 'analysis_data.json')
        if os.path.exists(old_json_path):
            os.remove(old_json_path)
            print(f"\n[CLEANUP] Removed old file: analysis_data.json")

        print("\n" + "=" * 60)
        print("[SUCCESS] Database schema generation completed!")
        print("=" * 60)
        print(f"  Database Type: {DATABASE_TYPE.upper()}")
        print(f"  Schema JSON: {schema_json_path}")
        print(f"  Schema Markdown: {schema_md_path}")
        print(f"  Total Tables: {len(schema_data['tables'])}")
        print(f"  Total Rows: {sum(t['rowCount'] for t in schema_data['tables']):,}")
        print(f"  Total Relationships: {len(schema_data['relationships'])}")
        print("=" * 60)

    except Exception as e:
        print(f"\n[ERROR] Error during analysis: {e}")
        import traceback
        traceback.print_exc()
        raise


if __name__ == "__main__":
    main()

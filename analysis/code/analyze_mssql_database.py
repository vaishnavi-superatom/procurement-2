#!/usr/bin/env python3
"""
Microsoft SQL Server Database Analysis Script
Analyzes SQL Server database structure and generates schema.json and documentation.
Works with any SQL Server database - automatically generates descriptions based on naming conventions.

OUTPUT FORMAT:
    The generated schema.json follows the structure defined in:
    analysis/data/SCHEMA_STRUCTURE.md

    This file serves as the reference specification for the schema format.
    Claude Code should read SCHEMA_STRUCTURE.md to understand the expected format
    when generating or modifying schema files.

Usage:
    1. Copy .env.example to .env in the analysis folder
    2. Set MSSQL_* variables in .env file
    3. Run: python analyze_mssql_database.py

Environment Variables:
    MSSQL_SERVER=your_server
    MSSQL_DATABASE=your_database
    MSSQL_USER=your_user
    MSSQL_PASSWORD=your_password
    MSSQL_PORT=1433 (optional, default: 1433)
"""

import pymssql
import json
from datetime import datetime
from collections import defaultdict
import os
import re
from pathlib import Path

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


def get_connection_config():
    """Get connection configuration from environment variables"""
    server = os.getenv("MSSQL_SERVER")
    database = os.getenv("MSSQL_DATABASE")
    user = os.getenv("MSSQL_USER")
    password = os.getenv("MSSQL_PASSWORD")
    port = os.getenv("MSSQL_PORT", "1433")

    if not all([server, database, user, password]):
        print("\n[ERROR] SQL Server connection not configured!")
        print("        Please set the following environment variables:")
        print("        MSSQL_SERVER, MSSQL_DATABASE, MSSQL_USER, MSSQL_PASSWORD")
        print("\n        Example .env:")
        print("        MSSQL_SERVER=localhost")
        print("        MSSQL_DATABASE=your_database")
        print("        MSSQL_USER=sa")
        print("        MSSQL_PASSWORD=your_password")
        print("        MSSQL_PORT=1433")
        exit(1)

    return {
        "server": server,
        "database": database,
        "user": user,
        "password": password,
        "port": port
    }


CONNECTION_CONFIG = get_connection_config()


def connect_to_database():
    """Establish connection to SQL Server database using pymssql (no ODBC required)"""
    try:
        conn = pymssql.connect(
            server=CONNECTION_CONFIG["server"],
            port=CONNECTION_CONFIG["port"],
            user=CONNECTION_CONFIG["user"],
            password=CONNECTION_CONFIG["password"],
            database=CONNECTION_CONFIG["database"]
        )
        return conn
    except Exception as e:
        print(f"Error connecting to database: {e}")
        print("\nMake sure pymssql is installed: pip install pymssql")
        raise


def get_database_info(cursor):
    """Get basic database information"""
    cursor.execute("SELECT DB_NAME() as db_name, SYSTEM_USER as current_user, @@VERSION as version")
    row = cursor.fetchone()
    return {
        "database_name": row.db_name,
        "user": row.current_user,
        "version": row.version,
        "analysis_timestamp": datetime.now().isoformat()
    }


def get_all_tables(cursor):
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
    cursor.execute(query)
    return cursor.fetchall()


def get_table_columns(cursor, schema, table):
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
        WHERE s.name = %s AND tbl.name = %s
        ORDER BY c.column_id;
    """
    cursor.execute(query, (schema, table))
    return cursor.fetchall()


def get_table_row_count(cursor, schema, table):
    """Get row count for a specific table"""
    try:
        # Use sys.dm_db_partition_stats for faster count on large tables
        query = """
            SELECT SUM(p.rows) as row_count
            FROM sys.partitions p
            INNER JOIN sys.tables t ON p.object_id = t.object_id
            INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
            WHERE s.name = %s AND t.name = %s AND p.index_id IN (0, 1)
        """
        cursor.execute(query, (schema, table))
        result = cursor.fetchone()
        return result[0] if result and result[0] else 0
    except Exception as e:
        # Fallback to COUNT(*) for views
        try:
            cursor.execute(f'SELECT COUNT(*) FROM [{schema}].[{table}]')
            return cursor.fetchone()[0]
        except:
            return f"Error: {str(e)}"


def get_table_constraints(cursor, schema, table):
    """Get constraints for a specific table"""
    query = """
        SELECT
            kc.name as constraint_name,
            CASE
                WHEN kc.type = 'PK' THEN 'PRIMARY KEY'
                WHEN kc.type = 'UQ' THEN 'UNIQUE'
                WHEN fk.name IS NOT NULL THEN 'FOREIGN KEY'
            END as constraint_type,
            c.name as column_name,
            ref_t.name as foreign_table_name,
            ref_c.name as foreign_column_name
        FROM sys.key_constraints kc
        INNER JOIN sys.tables t ON kc.parent_object_id = t.object_id
        INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
        INNER JOIN sys.index_columns ic ON kc.unique_index_id = ic.index_id AND kc.parent_object_id = ic.object_id
        INNER JOIN sys.columns c ON ic.object_id = c.object_id AND ic.column_id = c.column_id
        LEFT JOIN sys.foreign_keys fk ON 1=0
        LEFT JOIN sys.tables ref_t ON 1=0
        LEFT JOIN sys.columns ref_c ON 1=0
        WHERE s.name = %s AND t.name = %s

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
        WHERE s.name = %s AND t.name = %s;
    """
    cursor.execute(query, (schema, table, schema, table))
    return cursor.fetchall()


def get_indexes(cursor, schema, table):
    """Get indexes for a specific table"""
    query = """
        SELECT
            i.name as indexname,
            'CREATE ' +
            CASE WHEN i.is_unique = 1 THEN 'UNIQUE ' ELSE '' END +
            i.type_desc + ' INDEX [' + i.name + '] ON [' + s.name + '].[' + t.name + '] (' +
            STUFF((
                SELECT ', [' + c.name + ']' + CASE WHEN ic.is_descending_key = 1 THEN ' DESC' ELSE ' ASC' END
                FROM sys.index_columns ic
                INNER JOIN sys.columns c ON ic.object_id = c.object_id AND ic.column_id = c.column_id
                WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id
                ORDER BY ic.key_ordinal
                FOR XML PATH('')
            ), 1, 2, '') + ')' as indexdef
        FROM sys.indexes i
        INNER JOIN sys.tables t ON i.object_id = t.object_id
        INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
        WHERE s.name = %s AND t.name = %s AND i.name IS NOT NULL;
    """
    cursor.execute(query, (schema, table))
    return cursor.fetchall()


def get_column_statistics(cursor, schema, table, column, data_type):
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
            cursor.execute(query)
            result = cursor.fetchone()
            if result:
                stats = {
                    "min": float(result.min_value) if result.min_value is not None else None,
                    "max": float(result.max_value) if result.max_value is not None else None,
                    "avg": float(result.avg_value) if result.avg_value is not None else None,
                    "distinct_count": result.distinct_count,
                    "non_null_count": result.non_null_count
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
            cursor.execute(query)
            result = cursor.fetchone()
            if result:
                stats = {
                    "distinct_count": result.distinct_count,
                    "non_null_count": result.non_null_count,
                    "max_length": result.max_length,
                    "min_length": result.min_length
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
            cursor.execute(query)
            result = cursor.fetchone()
            if result:
                stats = {
                    "min_date": str(result.min_date) if result.min_date is not None else None,
                    "max_date": str(result.max_date) if result.max_date is not None else None,
                    "distinct_count": result.distinct_count,
                    "non_null_count": result.non_null_count
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
            cursor.execute(query)
            result = cursor.fetchone()
            if result:
                stats = {
                    "true_count": result.true_count,
                    "false_count": result.false_count,
                    "non_null_count": result.non_null_count
                }

    except Exception as e:
        stats["error"] = str(e)

    return stats


def analyze_database():
    """Main analysis function"""
    print("Starting SQL Server database analysis...")

    conn = connect_to_database()
    cursor = conn.cursor()

    analysis_data = {
        "database_info": get_database_info(cursor),
        "tables": []
    }

    # Get all tables
    tables = get_all_tables(cursor)
    print(f"\nFound {len(tables)} table(s) to analyze")

    for row in tables:
        schema = row.table_schema
        table_name = row.table_name
        table_type = row.table_type

        print(f"\nAnalyzing table: {schema}.{table_name}")

        table_data = {
            "schema": schema,
            "name": table_name,
            "type": table_type,
            "row_count": get_table_row_count(cursor, schema, table_name),
            "columns": [],
            "constraints": [],
            "indexes": []
        }

        # Get columns
        columns = get_table_columns(cursor, schema, table_name)
        for col in columns:
            col_name = col.column_name
            data_type = col.data_type
            max_length = col.character_maximum_length
            is_nullable = col.is_nullable
            default_value = col.column_default

            print(f"  - Column: {col_name} ({data_type})")

            stats = get_column_statistics(cursor, schema, table_name, col_name, data_type)

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
                sample_values = get_sample_values(cursor, schema, table_name, col_name, data_type, stats['distinct_count'])
                if sample_values:
                    column_data['sample_values'] = sample_values

            table_data["columns"].append(column_data)

        # Get constraints
        constraints = get_table_constraints(cursor, schema, table_name)
        for constraint in constraints:
            constraint_data = {
                "name": constraint.constraint_name,
                "type": constraint.constraint_type,
                "column": constraint.column_name,
                "foreign_table": constraint.foreign_table_name,
                "foreign_column": constraint.foreign_column_name
            }
            table_data["constraints"].append(constraint_data)

        # Get indexes
        indexes = get_indexes(cursor, schema, table_name)
        for index in indexes:
            index_data = {
                "name": index.indexname,
                "definition": index.indexdef
            }
            table_data["indexes"].append(index_data)

        analysis_data["tables"].append(table_data)

    cursor.close()
    conn.close()

    return analysis_data


def map_mssql_to_standard_type(mssql_type):
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
    return type_mapping.get(mssql_type.lower(), 'TEXT')


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


def get_sample_values(cursor, schema, table, column, data_type, distinct_count):
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
        cursor.execute(query)
        results = cursor.fetchall()
        return [str(row[0]) for row in results if row[0] is not None]
    except:
        return None


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
    }
    if col_lower in timestamp_patterns:
        return timestamp_patterns[col_lower]

    # Boolean patterns
    if data_type == 'bit' or col_lower.startswith('is_') or col_lower.startswith('has_') or col_lower.startswith('can_'):
        if col_lower.startswith('is_') or col_lower.startswith('is'):
            return f"Whether {col_lower.replace('is_', '').replace('is', '').replace('_', ' ')}"
        if col_lower.startswith('has_') or col_lower.startswith('has'):
            return f"Whether has {col_lower.replace('has_', '').replace('has', '').replace('_', ' ')}"
        if col_lower.startswith('can_') or col_lower.startswith('can'):
            return f"Whether can {col_lower.replace('can_', '').replace('can', '').replace('_', ' ')}"
        return f"Boolean flag for {col_lower.replace('_', ' ')}"

    # Common column name patterns (same as PostgreSQL version)
    column_descriptions = {
        'id': 'Unique identifier',
        'name': 'Name or title',
        'title': 'Title',
        'description': 'Description text',
        'email': 'Email address',
        'phone': 'Phone number',
        'status': 'Current status',
        'type': 'Type or category',
        'price': 'Price',
        'quantity': 'Quantity',
        'amount': 'Amount',
        'total': 'Total',
    }

    if col_lower in column_descriptions:
        return column_descriptions[col_lower]

    # Default: convert column name to readable format
    return col_lower.replace('_', ' ').title()


def generate_common_queries(tables, relationships):
    """Auto-generate common queries based on table structure (SQL Server syntax)"""
    queries = []

    for table in tables:
        name = table['name']
        schema = table.get('schema', 'dbo')
        full_name = f"[{schema}].[{name}]"
        columns = table.get('columns', [])
        col_names = [c['name'] for c in columns]

        # Count query for every table
        queries.append({
            "description": f"Total {name} count",
            "query": f"SELECT COUNT(*) as total FROM {full_name};"
        })

        # Status breakdown if status column exists
        if 'status' in col_names:
            queries.append({
                "description": f"{name.title()} by status",
                "query": f"SELECT status, COUNT(*) as count FROM {full_name} GROUP BY status ORDER BY count DESC;"
            })

        # Time-based analysis if timestamp columns exist
        date_cols = [c for c in col_names if c.lower() in ['created_at', 'createdat', 'createddate', 'order_date', 'orderdate']]
        if date_cols:
            date_col = date_cols[0]
            queries.append({
                "description": f"{name.title()} by month",
                "query": f"SELECT DATEADD(MONTH, DATEDIFF(MONTH, 0, [{date_col}]), 0) as month, COUNT(*) as count FROM {full_name} GROUP BY DATEADD(MONTH, DATEDIFF(MONTH, 0, [{date_col}]), 0) ORDER BY month DESC;"
            })

    return queries[:15]


def generate_schema_json(analysis_data, output_path):
    """Generate schema.json in the standard format"""
    print("\nGenerating schema.json...")

    db_info = analysis_data['database_info']
    db_name = db_info['database_name']

    schema_data = {
        "database": db_name,
        "databaseType": "mssql",
        "schema": "dbo",
        "description": f"{db_name.title()} Database (SQL Server) - Generated on {db_info['analysis_timestamp']}",
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
                "type": map_mssql_to_standard_type(col['data_type']),
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
        schema_data['relationships']
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

    md_content = f"""# {schema_data['database']} Database Schema (SQL Server)

**Description:** {schema_data['description']}

## Overview

- **Database:** {schema_data['database']}
- **Database Type:** Microsoft SQL Server
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

            md_content += f"| {col['name']} | {col.get('nativeType', col['type'])} | "
            md_content += f"{'Yes' if col['nullable'] else 'No'} | {key_indicator} | "
            md_content += f"{col['description']} |\n"

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
        # Get database name from connection info
        db_name = os.getenv("MSSQL_DATABASE", "database")

        # Perform analysis
        print("=" * 60)
        print(f"SQL Server Schema Generator - {db_name}")
        print("=" * 60)
        print(f"Server: {os.getenv('MSSQL_SERVER', 'configured')}")
        print("=" * 60)

        analysis_data = analyze_database()

        # Get output directory
        script_dir = os.path.dirname(os.path.abspath(__file__))
        data_dir = os.path.join(os.path.dirname(script_dir), 'data')

        # Ensure data directory exists
        os.makedirs(data_dir, exist_ok=True)

        # Generate schema.json
        schema_json_path = os.path.join(data_dir, 'schema.json')
        generate_schema_json(analysis_data, schema_json_path)

        # Load schema.json to generate markdown
        with open(schema_json_path, 'r', encoding='utf-8') as f:
            schema_data = json.load(f)

        # Generate schema.md
        schema_md_path = os.path.join(data_dir, 'schema.md')
        generate_schema_markdown(schema_data, schema_md_path)

        print("\n" + "=" * 60)
        print("[SUCCESS] SQL Server schema generation completed!")
        print("=" * 60)
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

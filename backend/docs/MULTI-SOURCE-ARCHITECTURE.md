# Multi-Source Data Architecture

## SuperAtom — Multiple Data Sources Platform

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Architecture Overview](#2-architecture-overview)
3. [Core Components](#3-core-components)
4. [Plugin System Design](#4-plugin-system-design)
5. [Supported Data Sources](#5-supported-data-sources)
6. [Data Flow & Execution Pipeline](#6-data-flow--execution-pipeline)
7. [Schema Extraction & LLM Integration](#7-schema-extraction--llm-integration)
8. [Source Lifecycle Management](#8-source-lifecycle-management)
9. [Technology Stack](#9-technology-stack)
10. [Proposal: Adding R2 Data Catalog as a Source](#10-proposal-adding-r2-data-catalog-as-a-source)

---

## 1. Executive Summary

The Multi-Source Data Architecture is a **plugin-based system** that allows the SuperAtom platform to connect to, manage, and query **multiple heterogeneous data sources** from a single unified backend. It enables an LLM (Large Language Model) to intelligently route queries across databases, files, APIs, and CRM systems — all through a common interface.

**Key Highlights:**

- **9 data source types** currently supported (PostgreSQL, MySQL, MSSQL, Excel, CSV, REST API, GraphQL, Salesforce, HubSpot)
- **Lazy-loaded plugin architecture** — only loads modules that are actually needed
- **Automatic schema extraction** with statistics and cardinality hints
- **LLM-aware tool generation** — each source auto-generates an optimized tool definition for the AI
- **Runtime source management** — add, remove, activate, deactivate sources without restarting
- **Real-time communication** via WebSocket (Cloudflare Durable Objects) for frontend-backend interaction

---

## 2. Architecture Overview

### High-Level Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                        Frontend (UI)                             │
│              SuperAtom Web SDK (WebSocket Client)                │
└────────────────────────┬─────────────────────────────────────────┘
                         │ WebSocket
                         ▼
┌──────────────────────────────────────────────────────────────────┐
│              WebSocket Bridge (Cloudflare Workers)                │
│                 Durable Object Broadcaster                       │
│          (Project-scoped, Hibernatable WebSockets)               │
└────────────────────────┬─────────────────────────────────────────┘
                         │
                         ▼
┌──────────────────────────────────────────────────────────────────┐
│                    Backend (Node.js / TypeScript)                 │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────────────┐  │
│  │ SuperAtom SDK│  │  Collections │  │     Tools Registry     │  │
│  │  (Connect)  │──│  (CRUD Ops)  │──│ (Static + Source Tools)│  │
│  └─────────────┘  └──────────────┘  └────────────────────────┘  │
│                                              │                   │
│                         ┌────────────────────┘                   │
│                         ▼                                        │
│  ┌───────────────────────────────────────────────────────────┐   │
│  │                    Source Manager                          │   │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  │   │
│  │  │ Source 1  │  │ Source 2  │  │ Source 3  │  │ Source N  │  │   │
│  │  │(Postgres) │  │ (Excel)  │  │(Salesforce│  │  (...)   │  │   │
│  │  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘  │   │
│  └───────┼──────────────┼──────────────┼──────────────┼───────┘   │
│          ▼              ▼              ▼              ▼           │
│     ┌─────────┐   ┌─────────┐   ┌──────────┐   ┌─────────┐     │
│     │ PG Pool │   │.xlsx File│   │Salesforce│   │  Other  │     │
│     │         │   │         │   │   API    │   │ Sources │     │
│     └─────────┘   └─────────┘   └──────────┘   └─────────┘     │
└──────────────────────────────────────────────────────────────────┘
                         │
                         ▼
┌──────────────────────────────────────────────────────────────────┐
│                   Project Database (PostgreSQL)                   │
│          project_sources table (source configs + schemas)        │
└──────────────────────────────────────────────────────────────────┘
```

### Directory Structure

```
backend/
├── src/
│   ├── app.ts                      # Entry point
│   ├── sa.ts                       # SDK initialization & orchestration
│   ├── collections/                # SDK collection handlers (CRUD APIs)
│   │   ├── project-sources.ts      # Source management operations
│   │   ├── database.ts             # PostgreSQL query operations
│   │   ├── mssql-database.ts       # MSSQL query operations
│   │   ├── artifacts.ts            # Artifact management
│   │   ├── bookmarks.ts            # Bookmark management
│   │   ├── dashboards.ts           # Dashboard management
│   │   └── kb-nodes.ts             # Knowledge base nodes
│   ├── sources/                    # ★ Multi-Source Plugin System
│   │   ├── core/                   # Base infrastructure
│   │   │   ├── types.ts            # All interfaces & type definitions
│   │   │   ├── base-source.ts      # Abstract base class
│   │   │   ├── registry.ts         # Module registry (singleton)
│   │   │   ├── source-manager.ts   # Instance lifecycle manager
│   │   │   └── index.ts            # Core exports
│   │   ├── postgres/               # PostgreSQL plugin
│   │   ├── mysql/                  # MySQL plugin
│   │   ├── mssql/                  # MSSQL plugin
│   │   ├── excel/                  # Excel plugin
│   │   ├── csv/                    # CSV plugin
│   │   ├── rest-api/               # REST API plugin
│   │   ├── graphql/                # GraphQL plugin
│   │   ├── salesforce/             # Salesforce plugin
│   │   ├── hubspot/                # HubSpot plugin
│   │   └── index.ts                # Lazy module loader
│   ├── services/                   # Service layer
│   └── tools/                      # Static tools (non-source)
├── package.json
├── tsconfig.json
└── ecosystem.config.js             # PM2 deployment config
```

---

## 3. Core Components

### 3.1 Source Module Interface (`SourceModule`)

Every data source plugin must export an object conforming to this interface:

```typescript
interface SourceModule {
  type: SourceType;                  // Unique identifier (e.g., 'postgres')
  name: string;                      // Display name (e.g., 'PostgreSQL')
  description: string;               // Human-readable description
  capabilities: SourceCapabilities;  // What the source can do
  createInstance(config): SourceInstance;  // Factory method
  validateConfig(config): Result;    // Config validation
  configFields: ConfigField[];       // UI form definition
}
```

### 3.2 Source Instance Interface (`SourceInstance`)

Each running source connection implements:

```typescript
interface SourceInstance {
  connect(): Promise<void>;           // Establish connection
  disconnect(): Promise<void>;        // Close connection
  healthCheck(): Promise<boolean>;    // Verify connectivity
  isConnected(): boolean;             // Connection status
  extractSchema(): Promise<Schema>;   // Metadata extraction
  getSchema(): Schema | null;         // Cached schema
  execute(params): Promise<Result>;   // Query execution
  getTool(): SourceTool;              // LLM tool definition
}
```

### 3.3 Source Capabilities

Each source declares what it can do:

```typescript
interface SourceCapabilities {
  query: boolean;          // Can execute queries (SQL, SOQL, etc.)
  write: boolean;          // Can modify data
  schema: boolean;         // Can extract metadata
  realtime: boolean;       // Supports streaming
  parameterized: boolean;  // Supports parameterized queries
}
```

### 3.4 Base Source (`BaseSource`)

Abstract class providing shared functionality:

- **Schema formatting for LLM** — converts raw schema into an optimized text description
- **Type normalization** — maps native types (varchar, nvarchar, character varying) to common types (TEXT, NUMBER, BOOLEAN)
- **Tool generation templates** — builds LLM tool definitions with schema context
- **Relationship formatting** — generates JOIN hints from foreign key data
- **Data domain hints** — infers data categories from table names
- **Statistics formatting** — includes cardinality, sample values, min/max ranges

### 3.5 Source Registry (`SourceRegistry`)

Singleton that manages module registration:

```
┌─────────────────────────────────────────────┐
│              Source Registry                  │
│                                             │
│  modules: Map<SourceType, SourceModule>     │
│                                             │
│  register(module)      → Add a plugin       │
│  createInstance(config) → Factory method     │
│  validateConfig(type)  → Validate input     │
│  getConfigFields(type) → UI form fields     │
│  getModulesInfo()      → All module info    │
└─────────────────────────────────────────────┘
```

### 3.6 Source Manager (`SourceManager`)

Per-project instance manager that handles the full lifecycle:

```
┌─────────────────────────────────────────────┐
│              Source Manager                   │
│                                             │
│  instances: Map<string, SourceInstance>      │
│                                             │
│  initialize()        → Load all from DB     │
│  addSource(config)   → Add at runtime       │
│  removeSource(id)    → Remove at runtime    │
│  reloadSource(id)    → Reconnect            │
│  getSourceTools()    → LLM tool definitions │
│  healthCheckAll()    → Check all sources    │
│  refreshAllSchemas() → Re-extract metadata  │
│  shutdown()          → Disconnect all       │
└─────────────────────────────────────────────┘
```

---

## 4. Plugin System Design

### 4.1 Lazy Loading

Modules are only imported when a source of that type is configured in the database:

```typescript
const moduleLoaders: Record<string, () => Promise<SourceModule>> = {
  postgres:    async () => (await import('./postgres')).default,
  mysql:       async () => (await import('./mysql')).default,
  mssql:       async () => (await import('./mssql')).default,
  excel:       async () => (await import('./excel')).default,
  csv:         async () => (await import('./csv')).default,
  rest_api:    async () => (await import('./rest-api')).default,
  graphql:     async () => (await import('./graphql')).default,
  salesforce:  async () => (await import('./salesforce')).default,
  hubspot:     async () => (await import('./hubspot')).default,
};
```

**Benefits:**
- Reduces startup time — only loads what's needed
- Lower memory footprint — unused SDKs aren't imported
- No hard dependencies on any single source type

### 4.2 Plugin File Structure

Each plugin consists of two files:

```
src/sources/<plugin-name>/
├── index.ts        # Module definition (config fields, validation, capabilities)
└── instance.ts     # Instance class (connection, schema, query execution)
```

### 4.3 Adding a New Plugin

To add a new data source, a developer needs to:

1. Create `src/sources/<name>/index.ts` — Define module metadata, config fields, and validation
2. Create `src/sources/<name>/instance.ts` — Implement the instance class extending `BaseSource`
3. Add the type to `SourceType` union in `src/sources/core/types.ts`
4. Add the lazy loader in `src/sources/index.ts`
5. Install any required npm dependencies

No changes needed to the core framework, registry, manager, or collections.

---

## 5. Supported Data Sources

### 5.1 Database Sources

| Source | Type Key | Driver | Capabilities |
|--------|----------|--------|-------------|
| **PostgreSQL** | `postgres` | `pg` | Query, Write, Schema, Parameterized |
| **MySQL** | `mysql` | `mysql2` | Query, Write, Schema, Parameterized |
| **MSSQL** | `mssql` | `mssql` | Query, Write, Schema, Parameterized |

**Common Features:**
- Connection pooling with lazy initialization
- Health checks with automatic stale pool reset
- Comprehensive schema extraction with table statistics
- Sample values and cardinality classification (unique, low, medium, high)
- Foreign key relationship detection
- Named parameter support
- Query validation and fixing (MSSQL: auto-balances parentheses, moves aggregates from WHERE to HAVING)

### 5.2 File-Based Sources

| Source | Type Key | Driver | Capabilities |
|--------|----------|--------|-------------|
| **Excel** | `excel` | `xlsx` | Schema (read-only) |
| **CSV** | `csv` | Custom parser | Schema (read-only) |

**Common Features:**
- File caching with configurable auto-refresh intervals
- Type inference from sample values
- Flexible column matching (case-insensitive, partial match)
- Filtering, column selection, limit, and offset support
- Multi-sheet support (Excel)
- Custom delimiters and encoding (CSV)

### 5.3 API Sources

| Source | Type Key | Driver | Capabilities |
|--------|----------|--------|-------------|
| **REST API** | `rest_api` | `fetch` (HTTP) | Write, Parameterized |
| **GraphQL** | `graphql` | `fetch` (HTTP) | Write, Parameterized |

**Common Features:**
- Multiple authentication types (None, API Key, Bearer Token, Basic Auth)
- Configurable endpoints/operations
- Path parameters, query parameters, and request body support
- Timeout management
- Response data extraction from nested JSON structures
- Health checks via test endpoints / introspection queries

### 5.4 CRM Sources

| Source | Type Key | Driver | Capabilities |
|--------|----------|--------|-------------|
| **Salesforce** | `salesforce` | `jsforce` | Query, Write, Schema |
| **HubSpot** | `hubspot` | REST API | Query, Write, Schema |

**Salesforce Features:**
- OAuth2 and username/password authentication
- SOQL query execution
- Schema extraction from standard objects (Account, Contact, Lead, Opportunity, Case, Task, Event, User, Campaign, Product2)
- Salesforce field type mapping

**HubSpot Features:**
- Access token authentication
- CRM object queries (Contacts, Companies, Deals, Tickets, Products)
- Filter operators (EQ, NEQ, LT, LTE, GT, GTE, CONTAINS_TOKEN)
- Property selection and pagination

---

## 6. Data Flow & Execution Pipeline

### 6.1 Startup Sequence

```
app.ts
  └─→ SASDK()                              [sa.ts]
       ├─→ sdk.connect()                    Connect to SuperAtom platform
       │
       ├─→ initializeSources(projectId)     [sources/core/source-manager.ts]
       │    ├─→ Load source configs from DB (project_sources table)
       │    ├─→ Identify unique source types needed
       │    ├─→ Lazy-load required modules   [sources/index.ts]
       │    ├─→ For each active source:
       │    │    ├─→ registry.createInstance(config)
       │    │    ├─→ instance.connect()
       │    │    └─→ instance.extractSchema() → Save to DB
       │    └─→ ✓ Sources initialized
       │
       ├─→ getAllTools()                     Merge source tools + static tools
       │    ├─→ sourceManager.getSourceTools()  (dynamic, from sources)
       │    └─→ STATIC_TOOLS                    (predefined tools)
       │
       ├─→ sdk.setTools(allTools)            Register tools with SDK
       │
       └─→ registerAllCollections(sdk)       Register CRUD operations
            └─→ ✓ SDK Ready
```

### 6.2 Query Execution Flow

```
User Query (via Frontend WebSocket)
  │
  ▼
SuperAtom SDK receives request
  │
  ▼
LLM analyzes query + available tools
  │  (Each source tool includes schema context,
  │   sample values, and domain hints)
  │
  ▼
LLM selects appropriate source tool
  │
  ▼
Tool function invoked → source.execute(params)
  │
  ├─→ [Database] SQL query via connection pool
  ├─→ [File]     Filter in-memory cached data
  ├─→ [API]      HTTP request to external endpoint
  └─→ [CRM]      SOQL/REST query to CRM platform
  │
  ▼
QueryResult { data[], count, metadata }
  │
  ▼
Response sent back to frontend via WebSocket
```

### 6.3 Source CRUD Operations

The `project-sources` collection exposes these operations via the SDK:

| Operation | Description |
|-----------|-------------|
| `create` | Add a new source (validates type & config, saves to DB) |
| `getAll` | List all sources for a project |
| `getOne` | Get a single source by ID |
| `update` | Update source config (handles reconnection if needed) |
| `delete` | Remove source (disconnects instance, removes from DB) |
| `testConnection` | Test connectivity without saving |
| `extractSchema` | Force re-extract schema for a source |
| `setPrimary` | Mark a source as the primary source |
| `healthCheck` | Check health of all connected sources |
| `activate` | Reconnect a deactivated source |
| `deactivate` | Disconnect without deleting (keeps config in DB) |
| `getActiveStatus` | Get connection status of all sources |
| `getSupportedTypes` | List all available source types |
| `getConfigFields` | Get UI form fields for a source type |

---

## 7. Schema Extraction & LLM Integration

### 7.1 Schema Structure

Each source extracts metadata into a common schema format:

```typescript
{
  entities: [
    {
      name: "orders",
      fullName: "public.orders",
      rowCount: 15000,
      primaryKey: ["id"],
      fields: [
        {
          name: "id",
          type: "NUMBER",
          nativeType: "integer",
          isPrimaryKey: true,
          nullable: false,
          statistics: { distinct: 15000, cardinality: "unique" }
        },
        {
          name: "status",
          type: "TEXT",
          nativeType: "varchar",
          sampleValues: ["pending", "shipped", "delivered", "cancelled"],
          statistics: { distinct: 4, cardinality: "low" }
        },
        {
          name: "customer_id",
          type: "NUMBER",
          isForeignKey: true,
          references: { entity: "customers", field: "id" }
        }
      ]
    }
  ],
  relationships: [
    { from: "orders", fromField: "customer_id", to: "customers", toField: "id", type: "many-to-one" }
  ],
  extractedAt: "2026-02-09T10:30:00Z"
}
```

### 7.2 LLM Tool Generation

Each source instance generates an LLM tool definition that includes:

1. **Source identity** — name, type, and description
2. **Table listing** — all tables with row counts
3. **Field details** — types, primary/foreign keys, constraints
4. **Sample values** — for low-cardinality fields (e.g., status columns), up to 10 sample values
5. **Statistics** — min/max ranges for numeric/date fields, cardinality hints
6. **Relationships** — foreign key mappings for JOIN guidance
7. **Data domain hints** — inferred categories from table names (e.g., "orders", "inventory", "customers")

This rich context enables the LLM to:
- Choose the right source for a given question
- Write accurate SQL with correct table/column names
- Use appropriate JOINs based on relationship data
- Apply proper GROUP BY on low-cardinality columns
- Filter using known enum values from sample data

### 7.3 Schema Caching

- Schemas are extracted once at initialization
- Cached in the `project_sources` database table
- Can be manually refreshed via the `extractSchema` collection operation
- Subsequent startups use cached schemas (avoiding re-extraction)

---

## 8. Source Lifecycle Management

### 8.1 States

```
                    ┌──────────┐
        create ──→  │  Active  │ ◄── activate
                    │(Connected│
                    │ + Tool)  │
                    └────┬─────┘
                         │
                    deactivate
                         │
                    ┌────▼─────┐
                    │ Inactive │
                    │(Config in│
                    │ DB only) │
                    └────┬─────┘
                         │
                      delete
                         │
                    ┌────▼─────┐
                    │ Deleted  │
                    │(Removed) │
                    └──────────┘
```

### 8.2 Runtime Operations

- **Add at runtime** — new sources can be added and connected without restarting the server
- **Remove at runtime** — sources can be disconnected and removed dynamically
- **Reload** — disconnect and reconnect (useful after config changes)
- **Activate/Deactivate** — toggle source availability without losing configuration
- **Health monitoring** — periodic health checks detect stale or broken connections

---

## 9. Technology Stack

| Component | Technology |
|-----------|-----------|
| **Runtime** | Node.js + TypeScript |
| **SDK** | @superatomai/sdk-node |
| **Real-time Transport** | WebSocket via Cloudflare Durable Objects |
| **Database Drivers** | pg (PostgreSQL), mysql2 (MySQL), mssql (MSSQL) |
| **File Parsers** | xlsx (Excel), Custom CSV parser |
| **CRM SDKs** | jsforce (Salesforce), REST API (HubSpot) |
| **API Clients** | Native fetch (REST API, GraphQL) |
| **LLM Providers** | Anthropic, OpenAI, Google Gemini, Groq |
| **Project Database** | PostgreSQL (Neon) |
| **ORM** | Drizzle ORM |
| **Process Manager** | PM2 |
| **Package Manager** | pnpm |

---

## 10. Proposal: Adding R2 Data Catalog as a Source

### 10.1 What is R2 Data Catalog?

R2 Data Catalog is Cloudflare's **managed Apache Iceberg catalog** built into R2 object storage. It enables storing and querying large-scale structured/tabular data (e.g., supply chain tables) with:

- **Apache Iceberg table format** — data stored as Parquet files with managed metadata
- **ACID transactions** — safe concurrent reads and writes
- **Schema evolution** — add/remove columns without rewriting data
- **Standard REST catalog interface** — compatible with Spark, DuckDB, Snowflake, PyIceberg
- **R2 SQL query engine** — serverless SQL queries directly from Cloudflare
- **Zero egress fees** — query from anywhere without data transfer costs
- **Auto-compaction** — automatic file maintenance for optimal query performance

### 10.2 Why Add R2 Data Catalog?

| Benefit | Description |
|---------|-------------|
| **Supply chain analytics** | Store and query large supply chain datasets (orders, inventory, shipments, suppliers) |
| **Cost-effective storage** | R2 has no egress fees — significantly cheaper than traditional databases for large datasets |
| **Scalability** | Iceberg tables handle petabyte-scale data efficiently |
| **Interoperability** | Same data can be queried from Spark, Snowflake, DuckDB, and now our platform |
| **Serverless queries** | R2 SQL eliminates the need to manage query infrastructure |
| **Already on Cloudflare** | Our WebSocket bridge runs on Cloudflare Workers — natural fit for the ecosystem |

### 10.3 Implementation Plan

#### Step 1: Create Plugin Directory

```
src/sources/r2-catalog/
├── index.ts        # Module definition
└── instance.ts     # Instance implementation
```

#### Step 2: Module Definition (`index.ts`)

**Type Key:** `r2_catalog`

**Config Fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `catalogUri` | text | Yes | R2 Data Catalog REST endpoint URL |
| `warehouseName` | text | Yes | Warehouse identifier (R2 bucket name) |
| `accountId` | text | Yes | Cloudflare Account ID |
| `apiToken` | password | Yes | Cloudflare API token (R2 Data Catalog + R2 storage permissions) |
| `namespace` | text | No | Default namespace to scope queries (e.g., "supply_chain") |

**Capabilities:**

```typescript
{
  query: true,          // SQL queries via R2 SQL API
  write: false,         // Read-only initially (write support can be added later)
  schema: true,         // Full Iceberg table metadata extraction
  realtime: false,      // Not a streaming source
  parameterized: true   // Parameterized SQL support
}
```

#### Step 3: Instance Implementation (`instance.ts`)

The R2 Data Catalog instance will use **HTTP REST APIs** (no additional npm packages required):

**Connection:**
```
R2 Data Catalog REST API
├── GET  /v1/namespaces              → List namespaces
├── GET  /v1/namespaces/{ns}/tables  → List tables
├── GET  /v1/namespaces/{ns}/tables/{table}  → Table metadata
└── POST /v1/namespaces/{ns}/tables/{table}/metrics  → Table stats
```

**Schema Extraction:**
1. List all namespaces in the catalog
2. For each namespace, list all Iceberg tables
3. For each table, fetch schema metadata (column names, types, partition info)
4. Map Iceberg types to our normalized types (STRING→TEXT, LONG→NUMBER, etc.)
5. Return as standard `SourceSchema` format

**Query Execution (via R2 SQL API):**
```
POST https://api.cloudflare.com/client/v4/accounts/{account_id}/r2-sql/query
Headers:
  Authorization: Bearer {api_token}
Body:
  { "sql": "SELECT * FROM supply_chain.orders WHERE status = 'in_transit'" }
```

**Health Check:**
- Call the catalog REST endpoint to verify credentials and connectivity
- Verify at least one namespace/table is accessible

#### Step 4: Register the Plugin

**In `src/sources/core/types.ts`:**
```typescript
export type SourceType =
  | 'postgres'
  | 'mssql'
  | 'mysql'
  | 'salesforce'
  | 'hubspot'
  | 'excel'
  | 'csv'
  | 'rest_api'
  | 'graphql'
  | 'r2_catalog';    // ← New
```

**In `src/sources/index.ts`:**
```typescript
const moduleLoaders: Record<string, () => Promise<SourceModule>> = {
  // ... existing loaders
  r2_catalog: async () => (await import('./r2-catalog')).default,  // ← New
};
```

#### Step 5: No Additional Dependencies

R2 Data Catalog exposes standard REST APIs. The implementation uses native `fetch` — **no new npm packages required**.

### 10.4 Example Usage

Once implemented, users can:

1. **Add R2 Data Catalog as a source** via the UI:
   - Enter Catalog URI, Warehouse Name, Account ID, and API Token
   - Test connection
   - Save

2. **Schema is auto-extracted** showing all Iceberg tables:
   ```
   supply_chain.orders       [~50,000 rows]
   supply_chain.inventory    [~120,000 rows]
   supply_chain.suppliers    [~500 rows]
   supply_chain.shipments    [~30,000 rows]
   ```

3. **LLM can query the data** using natural language:
   - User: "Show me all delayed shipments from last month"
   - LLM selects the R2 Catalog tool, generates SQL:
     ```sql
     SELECT * FROM supply_chain.shipments
     WHERE status = 'delayed'
       AND ship_date >= '2026-01-01'
     ORDER BY ship_date DESC
     ```

4. **Query executes via R2 SQL** — serverless, no infrastructure to manage

### 10.5 Architecture After Adding R2 Data Catalog

```
┌─────────────────────────────────────────────────────────────┐
│                      Source Manager                          │
│                                                             │
│  ┌──────────┐ ┌──────┐ ┌───────┐ ┌──────────┐ ┌─────────┐ │
│  │PostgreSQL│ │Excel │ │ REST  │ │Salesforce│ │   R2    │ │
│  │          │ │      │ │  API  │ │          │ │ Catalog │ │
│  └────┬─────┘ └──┬───┘ └──┬────┘ └────┬─────┘ └────┬────┘ │
│       │          │        │           │            │       │
└───────┼──────────┼────────┼───────────┼────────────┼───────┘
        │          │        │           │            │
        ▼          ▼        ▼           ▼            ▼
   ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌──────────┐
   │  PG DB │ │ .xlsx  │ │External│ │  SFDC  │ │Cloudflare│
   │        │ │  File  │ │  API   │ │  API   │ │  R2 SQL  │
   └────────┘ └────────┘ └────────┘ └────────┘ │+ Iceberg │
                                                │  Tables  │
                                                └──────────┘
```

### 10.6 Estimated Effort

| Task | Scope |
|------|-------|
| Create `r2-catalog/index.ts` | Module definition, config fields, validation |
| Create `r2-catalog/instance.ts` | REST API integration, schema extraction, R2 SQL queries |
| Update `types.ts` | Add `r2_catalog` to SourceType union |
| Update `sources/index.ts` | Add lazy loader entry |
| Testing | Connection testing, schema extraction, query execution |

The plugin architecture makes this a **self-contained addition** — no changes to the core framework, registry, manager, or any existing source plugins.

---

*Document generated: February 2026*
*Platform: SuperAtom Multiple Data Sources*

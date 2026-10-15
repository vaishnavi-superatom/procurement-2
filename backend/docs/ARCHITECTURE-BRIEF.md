# SuperAtom — Multi-Source Architecture Brief

---

## What Does It Do?

Our platform lets users **connect multiple data sources** (databases, files, APIs, CRMs) and **query them using natural language**. An LLM understands the schema of each source and automatically picks the right one to answer the user's question.

```
User: "Show me all pending orders above $500"
  → LLM picks the PostgreSQL source
  → Generates: SELECT * FROM orders WHERE status = 'pending' AND total > 500
  → Returns results to user
```

---

## How It Works (In 4 Steps)

```
Step 1: CONNECT          Step 2: EXTRACT          Step 3: GENERATE         Step 4: QUERY

User adds a source  →   System extracts      →   LLM tool is created  →  User asks questions
(e.g. PostgreSQL,        table names, columns,     with full schema         in natural language,
Excel, Salesforce)       types, sample values,     context so the LLM       LLM picks the right
via the UI               and relationships         knows what data exists   source and queries it
```

---

## Architecture at a Glance

```
                    ┌─────────────┐
                    │   Frontend  │
                    │  (Web App)  │
                    └──────┬──────┘
                           │ WebSocket
                    ┌──────▼──────┐
                    │  Cloudflare │
                    │  WebSocket  │
                    │   Bridge    │
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │   Backend   │
                    │ (Node.js)   │
                    └──────┬──────┘
                           │
              ┌────────────▼────────────┐
              │     Source Manager       │
              │  (manages all sources)   │
              └────────────┬────────────┘
                           │
        ┌──────┬───────┬───┴────┬────────┬────────┐
        ▼      ▼       ▼       ▼        ▼        ▼
    Postgres  MySQL   Excel  REST API  Sales-  HubSpot
     MSSQL            CSV    GraphQL   force
```

---

## Plugin System

Every data source is a **self-contained plugin** with just 2 files:

```
src/sources/<name>/
├── index.ts      →  What is this source? What config does it need?
└── instance.ts   →  How to connect, extract schema, and run queries
```

All plugins follow the same interface:

| Method | Purpose |
|--------|---------|
| `connect()` | Open connection to the data source |
| `disconnect()` | Close connection |
| `healthCheck()` | Verify the source is reachable |
| `extractSchema()` | Pull table names, columns, types, sample values |
| `execute(params)` | Run a query and return results |
| `getTool()` | Generate an LLM tool definition with schema context |

**Adding a new source = creating 2 files + registering it.** No changes to the core framework.

---

## Currently Supported Sources (9)

| Category | Sources | What They Do |
|----------|---------|-------------|
| **Databases** | PostgreSQL, MySQL, MSSQL | SQL queries with connection pooling, parameterized queries, relationship detection |
| **Files** | Excel, CSV | Read and filter tabular data from files, auto-refresh support |
| **APIs** | REST API, GraphQL | Call external HTTP endpoints with authentication |
| **CRMs** | Salesforce, HubSpot | Query CRM objects (contacts, deals, leads, etc.) |

---

## How the LLM Knows What to Query

When a source connects, the system extracts its **full schema** and builds an LLM tool containing:

- Table names with row counts
- Column names with data types
- Sample values for filter columns (e.g., status: "pending", "shipped", "delivered")
- Foreign key relationships (for JOINs)
- Min/max ranges for numeric fields

This lets the LLM write accurate queries without the user needing to know table or column names.

---

## Key Design Decisions

| Decision | Why |
|----------|-----|
| **Lazy loading** | Modules only load when needed — faster startup, less memory |
| **Plugin architecture** | New sources can be added without touching existing code |
| **Schema caching** | Extracted once, stored in DB, reused on restart |
| **Runtime management** | Sources can be added/removed/toggled without server restart |
| **WebSocket transport** | Real-time bidirectional communication via Cloudflare Durable Objects |

---

## Next: Adding R2 Data Catalog

**What:** Cloudflare's managed Apache Iceberg catalog — stores large-scale tabular data (like supply chain tables) as Parquet files in R2 object storage.

**Why:**

- Store and query large datasets (orders, inventory, shipments) cost-effectively
- Zero egress fees — cheaper than traditional databases at scale
- Serverless SQL queries via R2 SQL — no infrastructure to manage
- Already on Cloudflare (same platform as our WebSocket bridge)

**How:** Create a new plugin (`src/sources/r2-catalog/`) that:

1. Connects to the Iceberg REST catalog API for schema extraction
2. Queries data via the R2 SQL API
3. No new npm dependencies needed — uses standard HTTP calls

**Effort:** Self-contained plugin addition. Core framework remains unchanged.

```
┌──────────────────────────────────────────────────────────┐
│                    Source Manager                          │
│                                                          │
│  Postgres  MySQL  MSSQL  Excel  CSV  REST  GraphQL       │
│  Salesforce  HubSpot  ┌──────────────┐                   │
│                       │ R2 Catalog   │ ← NEW             │
│                       │ (Iceberg +   │                   │
│                       │  R2 SQL)     │                   │
│                       └──────────────┘                   │
└──────────────────────────────────────────────────────────┘
```

---

*February 2026 — SuperAtom Platform*

# Project Setup Guide

Complete setup guide for a new Superatom project. Follow these steps in order.

## Prerequisites

- **Node.js** (v18+)
- **Python** (v3.8+)
- **PostgreSQL** (installed and running) - for project database
- **pnpm** (install via `npm install -g pnpm`)

---

## Step 1: Analysis (Database Schema Generation)

First, analyze your source database to generate schema documentation.

### 1.1 Navigate to analysis folder

```bash
cd analysis
```

### 1.2 Create and activate Python virtual environment

```bash
# Create virtual environment
python3 -m venv venv

# Activate it
# On macOS/Linux:
source venv/bin/activate

# On Windows:
# venv\Scripts\activate
```

### 1.3 Install Python dependencies

```bash
pip install -r code/requirements.txt
```

### 1.4 Configure database connection

```bash
cp .env.example .env
```

Edit `.env` with your source database URL:

**For PostgreSQL:**
```
DATABASE_URL=postgresql://username:password@localhost:5432/your_database
```

**For SQL Server:**
```
DATABASE_URL=mssql://username:password@localhost:1433/your_database
```

The script auto-detects the database type from the URL prefix (`postgresql://` or `mssql://`).

### 1.5 Run the analysis

```bash
python code/analyze_database.py
```

**Output files:**
- `data/schema.json` - Structured schema with tables, columns, relationships
- `data/schema.md` - Human-readable documentation

---

## Step 2: PostgreSQL Database (Project Data)

Set up the project database for users, bookmarks, and conversations.

### 2.1 Navigate to postgres folder

```bash
cd database/postgres
```

### 2.2 Install dependencies

```bash
pnpm install
```

### 2.3 Run the database setup script

```bash
./scripts/setup-database.sh
```

**What this does:**
- Checks PostgreSQL connection
- Creates the database (e.g., `bluelinx_sa_data`)
- Creates `.env` file if it doesn't exist
- Syncs schema using `drizzle-kit push`
- Creates tables: `users`, `bookmarks`, `kb_nodes`, `user_conversations`

### 2.4 Create a user

**Important:** Run from the `database/postgres` directory, NOT from `scripts/`:

```bash
cd database/postgres
pnpm script:create-user
```

**Common Error:** If you see `injecting env (0) from .env`, it means you're running from the wrong directory. The `.env` file must be in your current working directory.

### 2.5 Verify setup

Check `.env` file contains:
```
PROJECT_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/bluelinx_sa_data
```

---

## Step 3: ChromaDB (Vector Database)

Set up ChromaDB for semantic search capabilities.

### 3.1 Navigate to chromadb folder

```bash
cd database/chromadb
```

### 3.2 Install Node dependencies

```bash
pnpm install
```

### 3.3 Install ChromaDB (Python)

```bash
pip install chromadb
```

### 3.4 Configure environment

```bash
cp .env.example .env
```

Edit `.env`:
```env
PROJECT_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/bluelinx_sa_data
CHROMA_SERVER_URL=http://localhost:8000
COLLECTION_NAME=knowledge_base_collection
KB_TABLE_NAME=kb_nodes
```

### 3.5 Start ChromaDB server

```bash
# Option 1: Direct command
pnpm start:chroma

# Option 2: Using PM2 (recommended for production)
pm2 start ecosystem.config.js
```

### 3.6 Sync knowledge base (optional)

```bash
# Sync kb_nodes to ChromaDB
pnpm sync

# Reset and re-sync
pnpm sync:reset
```

---

## Step 4: Frontend

Build the frontend component bundle.

### 4.1 Navigate to frontend folder

```bash
cd frontend
```

### 4.2 Install dependencies

```bash
pnpm install
```

### 4.3 Update components for your database

#### Update DatabaseOverview Component

Edit `/frontend/src/modules/DatabaseOverview/index.tsx`:

Update `ROW_COUNT_QUERIES` to match your database tables:

```typescript
const ROW_COUNT_QUERIES = [
  "SELECT 'your_table_1' as table_name, COUNT(*) as row_count FROM your_table_1",
  "SELECT 'your_table_2' as table_name, COUNT(*) as row_count FROM your_table_2",
  // ... add all your tables
].join(' UNION ALL ');
```

Update the database label badge to your project name.

#### Update Home Component

Edit `/frontend/src/modules/Home/index.tsx`:

Update all SQL queries to match your schema:
- `MONTHLY_METRICS_QUERY` - Main KPI metrics
- `PREVIOUS_MONTH_QUERY` - Comparison metrics
- `DAILY_REVENUE_QUERY` - Trend data
- `TOP_PRODUCTS_QUERY` - Top items
- `CATEGORY_SALES_QUERY` - Category breakdown
- `ORDER_STATUS_QUERY` - Status distribution
- `TOP_CUSTOMERS_QUERY` - Top customers
- `RECENT_HIGH_VALUE_ORDERS_QUERY` - Recent orders

Update the welcome popup content:
- Title and description
- Example questions relevant to your dataset

### 4.4 Build for production

```bash
pnpm build
```

The built bundle will be in `dist/` directory.

---

## Step 5: Backend

Set up the backend server.

### 5.1 Navigate to backend folder

```bash
cd backend
```

### 5.2 Install dependencies

```bash
pnpm install
```

### 5.3 Configure environment

```bash
cp .env.example .env
```

Edit `.env`:
```env
# Required: SuperAtom SDK credentials
SUPERATOM_API_KEY=your_superatom_api_key
SUPERATOM_PROJECT_ID=your-project-id

# Required: Your application database (the one you analyzed)
# For PostgreSQL:
DATABASE_URL=postgresql://user:password@localhost:5432/your_app_db
# For SQL Server (optional - enables mssql-database collections):
# MSSQL_SERVER=localhost
# MSSQL_DATABASE=your_database
# MSSQL_USER=sa
# MSSQL_PASSWORD=your_password

# Required: Project database (from Step 2)
PROJECT_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/bluelinx_sa_data

# Required: At least one LLM provider
# Standard for client deployments — a per-client proxy key. The proxy URL is
# the same for every client and must be set alongside an sk-prox-... key.
OPENROUTER_API_KEY=sk-prox-your_client_key
SUPERATOM_LLM_PROXY_URL=https://ai.superatom.ai
# OR
ANTHROPIC_API_KEY=your_anthropic_api_key
# OR
GROQ_API_KEY=your_groq_api_key
# OR
GEMINI_API_KEY=your_gemini_api_key
# OR
OPENAI_API_KEY=your_openai_api_key

# Optional: ChromaDB for semantic search
CHROMA_SERVER_URL=http://localhost:8000
```

**Note:** The backend supports both PostgreSQL and SQL Server client databases:
- PostgreSQL uses `database.execute` and `database.mutation` collections
- SQL Server uses `mssql-database.execute` and `mssql-database.mutation` collections

### 5.4 Build the backend

```bash
pnpm build
```

### 5.5 Start the server

```bash
# Development mode
pnpm dev

# Production mode (PM2)
pnpm start
```

---

## Quick Reference

### Directory Structure

```
project-root/
├── analysis/                    # Step 1: Database analysis
│   ├── code/
│   │   └── analyze_database.py
│   ├── data/
│   │   ├── schema.json          # Generated schema
│   │   └── schema.md            # Generated docs
│   └── .env                     # Source database config
│
├── database/
│   ├── postgres/                # Step 2: Project database
│   │   ├── scripts/
│   │   │   ├── setup-database.sh
│   │   │   └── create-user.ts
│   │   ├── drizzle/
│   │   │   └── schema.ts
│   │   └── .env
│   │
│   └── chromadb/                # Step 3: Vector database
│       ├── src/
│       ├── start-chroma-server.sh
│       └── .env
│
├── frontend/                    # Step 4: Frontend bundle
│   ├── src/
│   │   ├── modules/             # Update these for your DB
│   │   │   ├── DatabaseOverview/
│   │   │   └── Home/
│   │   └── superatom.ts
│   └── dist/                    # Built bundle
│
├── backend/                     # Step 5: Backend server
│   ├── src/
│   └── .env
│
└── setup.md                     # This file
```

### Common Commands

| Task | Directory | Command |
|------|-----------|---------|
| Run analysis (PostgreSQL or SQL Server) | `analysis/` | `python code/analyze_database.py` |
| Run analysis (SQL Server only) | `analysis/` | `python code/analyze_mssql_database.py` |
| Setup database | `database/postgres/` | `./scripts/setup-database.sh` |
| Create user | `database/postgres/` | `pnpm script:create-user` |
| Push schema changes | `database/postgres/` | `pnpm db:push` |
| Generate migrations | `database/postgres/` | `pnpm db:generate` |
| Apply migrations | `database/postgres/` | `pnpm db:migrate` |
| Start ChromaDB | `database/chromadb/` | `pnpm start:chroma` |
| Sync to ChromaDB | `database/chromadb/` | `pnpm sync` |
| Build frontend | `frontend/` | `pnpm build` |
| Dev frontend | `frontend/` | `pnpm dev` |
| Build backend | `backend/` | `pnpm build` |
| Start backend | `backend/` | `pnpm start` |

### Schema Changes

When you modify `drizzle/schema.ts`:

**Option A: Development (Quick)**
```bash
cd database/postgres
pnpm db:push
```

**Option B: Production (Safe)**
```bash
cd database/postgres
pnpm db:generate   # Generate migration files
pnpm db:migrate    # Apply migrations
```

### Supported Database Types

| Database | Analysis Script | Backend Collections | Connection String Format |
|----------|-----------------|---------------------|--------------------------|
| PostgreSQL | `analyze_database.py` | `database.execute`, `database.mutation` | `postgresql://user:pass@host:5432/db` |
| SQL Server | `analyze_database.py` or `analyze_mssql_database.py` | `mssql-database.execute`, `mssql-database.mutation` | `mssql://user:pass@host:1433/db` |

**Note:** The unified `analyze_database.py` auto-detects the database type from the URL prefix.

---

## Setup Checklist

- [ ] **Analysis**
  - [ ] Create Python venv and install dependencies
  - [ ] Configure `.env` with source database URL (PostgreSQL or SQL Server)
  - [ ] Run `analyze_database.py`
  - [ ] Verify `schema.json` and `schema.md` generated

- [ ] **PostgreSQL**
  - [ ] Run `pnpm install`
  - [ ] Run `setup-database.sh`
  - [ ] Run `pnpm script:create-user`
  - [ ] Verify tables created

- [ ] **ChromaDB**
  - [ ] Run `pnpm install`
  - [ ] Install `chromadb` via pip
  - [ ] Configure `.env`
  - [ ] Start ChromaDB server

- [ ] **Frontend**
  - [ ] Run `pnpm install`
  - [ ] Update `DatabaseOverview` queries for your tables
  - [ ] Update `Home` queries for your schema
  - [ ] Run `pnpm build`

- [ ] **Backend**
  - [ ] Run `pnpm install`
  - [ ] Configure `.env` with all required keys
  - [ ] For SQL Server clients: add `MSSQL_*` environment variables
  - [ ] Run `pnpm build`
  - [ ] Start server with `pnpm start`

# ChromaDB Vector Database

This folder contains the ChromaDB setup for semantic search on knowledge base entries and user conversations. It stores vector embeddings that enable similarity-based queries.

## Collections

| Collection | Source | Description |
|------------|--------|-------------|
| `knowledge_base_collection` | `kb_nodes` table | Embeddings of knowledge base entries for semantic search |
| `user_conversations_collection` | Backend SDK | Embeddings of user prompts for conversation history matching |

## Quick Start

### 1. Install Dependencies

```bash
cd database/chromadb
pnpm install
```

### 2. Install ChromaDB (Python)

ChromaDB server requires Python:

```bash
pip install chromadb
```

### 3. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` with your settings:
```env
PROJECT_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/project_data
CHROMA_SERVER_URL=http://localhost:8000
COLLECTION_NAME=knowledge_base_collection
KB_TABLE_NAME=kb_nodes
```

### 4. Start ChromaDB Server

```bash
# Option 1: Direct command
npm run start:chroma

# Option 2: Using PM2 (recommended for production)
pm2 start ecosystem.config.js
```

### 5. Sync Knowledge Base

```bash
# Sync kb_nodes to ChromaDB
npm run sync

# Reset and re-sync (clears existing embeddings)
npm run sync:reset
```

## Prerequisites

### PostgreSQL Database

Ensure the `project_data` database is set up with the `kb_nodes` table:

```bash
cd ../postgres
./scripts/setup-database.sh
```

### Python & pip

```bash
# Check Python version (3.8+ required)
python3 --version

# Install ChromaDB
pip install chromadb
```

### Node.js & pnpm

```bash
npm install -g pnpm
```

### ChromaDB Embedding Function

The `chromadb-default-embed` package is required for local embedding generation:

```bash
pnpm add chromadb-default-embed
```

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PROJECT_DATABASE_URL` | - | PostgreSQL connection string (required) |
| `CHROMA_SERVER_URL` | `http://localhost:8000` | ChromaDB server URL |
| `COLLECTION_NAME` | `knowledge_base_collection` | Default collection name |
| `KB_TABLE_NAME` | `kb_nodes` | Source table for knowledge base |

### PM2 Configuration

Customize the PM2 app name:

```bash
PM2_APP_NAME=my-chromadb pm2 start ecosystem.config.js
```

## Available Scripts

### npm/pnpm Scripts

```bash
# Start ChromaDB server
pnpm start:chroma

# Sync knowledge base to ChromaDB
pnpm sync

# Reset and sync (clears collection first)
pnpm sync:reset

# Test semantic search query
pnpm query "search text here"

# Show collection statistics
pnpm stats

# Build TypeScript
pnpm build
```

### CLI Commands

```bash
# Sync command with options
npx tsx src/sync.ts sync --reset --batch-size 50

# Query command
npx tsx src/sync.ts query "What is machine learning?" --results 5

# Stats command
npx tsx src/sync.ts stats
```

## Folder Structure

```
database/chromadb/
├── README.md                 # This file
├── .env.example              # Environment template
├── .env                      # Your local config (gitignored)
├── package.json              # Dependencies and scripts
├── ecosystem.config.js       # PM2 configuration
├── start-chroma-server.sh    # Server startup script
├── tsconfig.json             # TypeScript configuration
└── src/
    ├── types.ts              # Type definitions
    ├── chroma-manager.ts     # ChromaDB client wrapper
    ├── postgres-connector.ts # PostgreSQL data fetcher
    └── sync.ts               # CLI sync tool
```

## How It Works

### Knowledge Base Sync

1. **Fetch** data from `kb_nodes` table in PostgreSQL
2. **Prepare** documents by combining title, category, tags, and content
3. **Generate** embeddings using ChromaDB's default model (all-MiniLM-L6-v2)
4. **Store** embeddings with metadata for filtering

### Embedding Format

Each document embedding includes:
- **Text**: `{title}\nCategory: {category}\nTags: {tags}\n\n{content}`
- **Metadata**: `kb_id`, `title`, `category`, `tags` (JSON), `created_at`

### User Conversations

The `user_conversations_collection` is managed by the backend SDK (`backend/src/sa.ts`):
- Stores user prompts with their associated UI blocks
- Enables finding similar previous conversations
- Supports conversation history search with similarity threshold

## Using in Your Application

### Import ChromaManager

```typescript
import { ChromaManager } from '../../database/chromadb/src/chroma-manager';

// For knowledge base
const kbManager = new ChromaManager();

// For user conversations
const conversationManager = new ChromaManager(undefined, 'user_conversations_collection');

// Initialize collection
await kbManager.createCollection();

// Query for similar documents
const results = await kbManager.query('search text', 5);

// Add custom documents
await kbManager.add({
  ids: ['doc_1'],
  documents: ['Document content'],
  metadatas: [{ title: 'Doc Title' }]
});
```

### Query Results Format

```typescript
const results = await manager.query('search text', 3);

// results structure:
{
  ids: [['kb_1', 'kb_2', 'kb_3']],
  documents: [['content1', 'content2', 'content3']],
  metadatas: [[
    { kb_id: 1, title: 'Title 1', category: 'Cat1', tags: '["tag1"]', created_at: '...' },
    { kb_id: 2, title: 'Title 2', category: 'Cat2', tags: '["tag2"]', created_at: '...' },
    { kb_id: 3, title: 'Title 3', category: 'Cat3', tags: '["tag3"]', created_at: '...' }
  ]],
  distances: [[0.1, 0.2, 0.3]]  // Lower = more similar
}

// Convert distance to similarity score
const similarity = 1 - results.distances[0][0];
```

## Troubleshooting

### ChromaDB server not running

```
Error: ChromaDB server is not reachable
```

**Solution:** Start the server:
```bash
# Direct
chroma run --host localhost --port 8000

# Or via npm
npm run start:chroma
```

### Database connection failed

```
Error: Missing required environment variable: PROJECT_DATABASE_URL
```

**Solution:** Create `.env` file:
```bash
cp .env.example .env
# Edit .env with your database connection
```

### Empty collection after sync

```
⚠ No entries found in kb_nodes table
```

**Solution:** Add knowledge base entries:
```bash
# Check if postgres database is set up
cd ../postgres
./scripts/setup-database.sh

# Add entries via API or directly:
# INSERT INTO kb_nodes (title, content, category, tags, created_by)
# VALUES ('Title', 'Content', 'Category', ARRAY['tag1', 'tag2'], 1);
```

### Port already in use

```
Error: Address already in use :8000
```

**Solution:** Kill existing process or use different port:
```bash
# Find and kill process on port 8000
lsof -i :8000
kill -9 <PID>

# Or use different port
chroma run --host localhost --port 8001
# Update CHROMA_SERVER_URL in .env
```

### Python version error

```
Error: Python 3.8+ required
```

**Solution:** Install Python 3.8 or newer:
```bash
# Ubuntu/Debian
sudo apt install python3.10

# macOS
brew install python@3.10
```

### Missing embedding function

```
Error: Please install chromadb-default-embed as a dependency
```

**Solution:** Install the embedding package:
```bash
cd database/chromadb
pnpm add chromadb-default-embed
```

## Embedding Model

ChromaDB uses `all-MiniLM-L6-v2` by default:
- **Dimension**: 384
- **Max sequence length**: 256 tokens
- **Model size**: ~80MB

For custom embedding models, configure ChromaDB server with different settings.

## License

ISC

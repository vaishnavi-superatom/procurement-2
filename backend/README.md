# SuperAtom Backend

Node.js backend server that integrates with the SuperAtom SDK to provide AI-powered data visualization and natural language database querying capabilities.

## Features

- **SuperAtom SDK Integration**: Connects to the SuperAtom platform for AI-powered component rendering
- **Database Querying**: Execute SQL queries against your PostgreSQL database via natural language
- **LLM Providers**: Support for multiple LLM providers (Anthropic, Groq, Gemini, OpenAI)
- **ChromaDB Integration**: Optional semantic search capabilities via ChromaDB
- **PM2 Support**: Production-ready process management

## Prerequisites

- Node.js 18+
- PostgreSQL database (your application data)
- Project database (for users, bookmarks, conversations - from `database/postgres`)
- SuperAtom API key and project ID
- At least one LLM provider API key (Anthropic, Groq, Gemini, or OpenAI)

## Setup

### 1. Install Dependencies

```bash
pnpm install
```

### 2. Configure Environment

Copy the example environment file and configure your settings:

```bash
cp .env.example .env
```

Edit `.env` with your configuration:

```env
# Required: SuperAtom SDK credentials
SUPERATOM_API_KEY=your_superatom_api_key
SUPERATOM_PROJECT_ID=your-project-id

# Required: Your application database
DATABASE_URL=postgresql://user:password@localhost:5432/your_app_db

# Required: Project database (shared across projects)
PROJECT_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/project_data

# Required: At least one LLM provider
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

### 3. Build the Project

```bash
pnpm build
```

### 4. Build Frontend Bundle

The backend serves the frontend bundle. Make sure to build the frontend first:

```bash
cd ../frontend
pnpm build
```

The built assets will be in `frontend/dist/assets` by default.

## Running the Server

### Development Mode

```bash
pnpm dev
```

### Production Mode (PM2)

```bash
# Start with PM2
pnpm start

# Or with custom app name
PM2_APP_NAME=my-project-backend pnpm start

# View logs
pm2 logs superatom-backend

# Stop
pm2 stop superatom-backend
```

## Configuration Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `3000` | Server port |
| `NODE_ENV` | No | `development` | Environment mode |
| `SUPERATOM_API_KEY` | Yes | - | Your SuperAtom API key |
| `SUPERATOM_PROJECT_ID` | Yes | - | Your SuperAtom project ID |
| `BUNDLE_DIR` | No | `./frontend/dist/assets` | Path to frontend bundle |
| `USER_ID` | No | `user` | Default user ID for SDK |
| `DATABASE_URL` | Yes | - | Your application database URL |
| `PROJECT_DATABASE_URL` | Yes | - | Project database URL (users, bookmarks, etc.) |
| `ANTHROPIC_API_KEY` | Conditional | - | Anthropic API key (required if using Anthropic) |
| `GROQ_API_KEY` | Conditional | - | Groq API key (required if using Groq) |
| `GEMINI_API_KEY` | Conditional | - | Google Gemini API key (required if using Gemini) |
| `OPENAI_API_KEY` | Conditional | - | OpenAI API key (required if using OpenAI) |
| `CHROMA_SERVER_URL` | No | - | ChromaDB server URL for semantic search |

## Project Structure

```
backend/
├── src/
│   ├── app.ts              # Express app entry point
│   ├── sa.ts               # SuperAtom SDK integration
│   └── services/
│       └── database.ts     # PostgreSQL connection pool
├── dist/                   # Compiled JavaScript
├── logs/                   # PM2 log files
├── ecosystem.config.js     # PM2 configuration
├── .env.example           # Environment template
└── package.json
```

## Database Connections

The backend uses two database connections:

1. **DATABASE_URL**: Your application's main database that the AI will query (e.g., your product catalog, sales data, etc.)

2. **PROJECT_DATABASE_URL**: Shared project database that stores:
   - User accounts
   - Bookmarks
   - Knowledge base nodes (`kb_nodes`)
   - User conversations

## LLM Provider Setup

At least one LLM provider must be configured:

### Anthropic (Claude)
```env
ANTHROPIC_API_KEY=sk-ant-...
```

### Groq
```env
GROQ_API_KEY=gsk_...
```

### Google Gemini
```env
GEMINI_API_KEY=AIza...
```

### OpenAI
```env
OPENAI_API_KEY=sk-...
```

The SDK will automatically use available providers based on configured API keys.

## Customization

### Adding New Database Tools

The SuperAtom SDK is configured with database tools in `src/sa.ts`. To add custom tools:

```typescript
// In src/sa.ts, add to the tools array in createSuperAtom()
{
  name: 'my_custom_tool',
  description: 'Description for the AI',
  inputSchema: z.object({
    param1: z.string().describe('Parameter description'),
  }),
  execute: async ({ param1 }) => {
    // Your tool implementation
    return { result: 'success' };
  },
}
```

### Custom System Prompts

Modify the system prompts in `src/sa.ts` to customize AI behavior for your specific use case.

## Troubleshooting

### "Missing required environment variables"
Ensure all required variables are set in your `.env` file. The server validates config on startup.

### Database connection errors
- Verify your `DATABASE_URL` is correct
- Check if PostgreSQL is running
- Ensure the database exists and user has access

### "Bundle not found"
- Build the frontend first: `cd ../frontend && pnpm build`
- Verify `BUNDLE_DIR` path is correct

### PM2 issues
```bash
# View detailed logs
pm2 logs superatom-backend --lines 100

# Restart with fresh state
pm2 delete superatom-backend && pnpm start
```

## Scripts

| Script | Description |
|--------|-------------|
| `pnpm dev` | Run in development mode with hot reload |
| `pnpm build` | Compile TypeScript to JavaScript |
| `pnpm start` | Start with PM2 in production mode |
| `pnpm test` | Run tests |

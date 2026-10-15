# Project Data PostgreSQL Database

This folder contains the local PostgreSQL database setup that is shared across all projects. It manages user data, bookmarks, knowledge base nodes, and conversation history.

## Tables

| Table | Description |
|-------|-------------|
| `users` | User accounts and authentication |
| `bookmarks` | User-saved UI blocks and states |
| `kb_nodes` | Knowledge base entries with full-text search |
| `user_conversations` | Chat history and UI block responses |

## Quick Start

### Initial Setup (New Project)

Run this once to create the database and tables:

```bash
cd database/postgres

# Run the setup script
./scripts/setup-database.sh
```

This will:
1. Check PostgreSQL is running
2. Create the `project_data` database
3. Create `.env` file from template
4. Sync all tables to the database

### Running Migrations (Existing Project)

When the schema changes, run migrations to update:

```bash
cd database/postgres

# Run migrations
./scripts/migrate-database.sh
```

## Prerequisites

### PostgreSQL

Install PostgreSQL if not already installed:

<details>
<summary><b>Ubuntu/Debian</b></summary>

```bash
sudo apt update
sudo apt install postgresql postgresql-contrib

# Start PostgreSQL
sudo systemctl start postgresql
sudo systemctl enable postgresql
```
</details>

<details>
<summary><b>macOS</b></summary>

```bash
# Using Homebrew
brew install postgresql@15

# Start PostgreSQL
brew services start postgresql@15
```
</details>

<details>
<summary><b>Windows</b></summary>

1. Download PostgreSQL from [postgresql.org](https://www.postgresql.org/download/windows/)
2. Run the installer
3. Remember the password you set for the `postgres` user
4. PostgreSQL service starts automatically
</details>

### Node.js & pnpm

```bash
# Install pnpm if not installed
npm install -g pnpm
```

## Configuration

### Environment Variables

Create `.env` file from template:

```bash
cp .env.example .env
```

Edit `.env` with your database connection:

```
PROJECT_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/project_data
```

### Custom Database Settings

You can override default settings when running setup:

```bash
# Custom database name
DB_NAME=my_project_db ./scripts/setup-database.sh

# Custom credentials
DB_USER=myuser DB_PASSWORD=mypass ./scripts/setup-database.sh

# All options
DB_NAME=mydb DB_USER=myuser DB_PASSWORD=mypass DB_HOST=localhost DB_PORT=5432 ./scripts/setup-database.sh
```

## Available Scripts

### npm/pnpm Scripts

```bash
# Generate migration files from schema changes
pnpm db:generate

# Apply migrations to database
pnpm db:migrate

# Push schema directly (development only)
pnpm db:push

# Open Drizzle Studio (database GUI)
pnpm db:studio

# Delete user conversations
pnpm script:delete-user-conversations
```

### Shell Scripts

```bash
# Initial database setup
./scripts/setup-database.sh

# Run migrations
./scripts/migrate-database.sh
```

## Folder Structure

```
database/postgres/
├── README.md                 # This file
├── .env.example              # Environment template
├── .env                      # Your local config (gitignored)
├── package.json              # Dependencies and scripts
├── drizzle.config.ts         # Drizzle ORM configuration
├── tsconfig.json             # TypeScript configuration
├── drizzle/
│   ├── schema.ts             # Table definitions
│   ├── relations.ts          # Table relationships
│   └── migrations/           # SQL migration files
├── scripts/
│   ├── setup-database.sh     # Initial setup script
│   ├── migrate-database.sh   # Migration script
│   ├── run-migrations.ts     # Migration runner
│   └── delete-user-conversations.ts
└── src/project-data-db/
    ├── drizzle-db.ts         # Database connection
    ├── types.ts              # Shared types
    ├── users.ts              # User CRUD operations
    ├── bookmarks.ts          # Bookmark CRUD operations
    ├── kb-nodes.ts           # Knowledge base CRUD
    └── user-conversations.ts # Conversation CRUD
```

## Schema Overview

### Users Table
```sql
users (
  id            SERIAL PRIMARY KEY,
  username      VARCHAR(100) UNIQUE NOT NULL,
  email         VARCHAR(255) UNIQUE,
  password      VARCHAR(255) NOT NULL,
  fullname      VARCHAR(255),
  role          VARCHAR(50),
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)
```

### Bookmarks Table
```sql
bookmarks (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER REFERENCES users(id) ON DELETE CASCADE,
  thread_id     VARCHAR(255),
  uiblock       JSONB NOT NULL,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)
```

### KB Nodes Table
```sql
kb_nodes (
  id            SERIAL PRIMARY KEY,
  title         VARCHAR(500) NOT NULL,
  content       TEXT NOT NULL,
  category      VARCHAR(200),
  tags          TEXT[],
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)
-- Includes full-text search indexes on title and content
```

### User Conversations Table
```sql
user_conversations (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER REFERENCES users(id) ON DELETE CASCADE,
  threadid      VARCHAR(255),
  userprompt    TEXT NOT NULL,
  uiblock       JSONB NOT NULL,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)
-- Includes full-text search index on userprompt
```

## Working with Migrations

### Creating a New Migration

1. Modify schema in `drizzle/schema.ts`
2. Generate migration:
   ```bash
   pnpm db:generate
   ```
3. Review generated SQL in `drizzle/migrations/`
4. Apply migration:
   ```bash
   pnpm db:migrate
   # or
   ./scripts/migrate-database.sh
   ```

### Development: Push Schema Directly

For rapid development, push schema without migrations:

```bash
pnpm db:push
```

**Warning:** This may cause data loss. Use migrations in production.

## Troubleshooting

### PostgreSQL not running
```
Error: PostgreSQL is not running on localhost:5432
```
**Solution:** Start PostgreSQL service:
```bash
# Ubuntu/Debian
sudo systemctl start postgresql

# macOS
brew services start postgresql@15
```

### Permission denied on scripts
```
Permission denied: ./scripts/setup-database.sh
```
**Solution:** Make scripts executable:
```bash
chmod +x scripts/*.sh
```

### Database connection refused
```
Error connecting to database: connection refused
```
**Solution:**
- Check PostgreSQL is running
- Verify credentials in `.env`
- Check firewall settings

### Migration already applied
```
Error: Migration already applied
```
**Solution:** This is normal - migrations only run once. Check `drizzle/__drizzle_migrations` table for history.

### psql command not found
```
Error: psql command not found
```
**Solution:** Install PostgreSQL client:
```bash
# Ubuntu/Debian
sudo apt install postgresql-client

# macOS
brew install postgresql
```

## Using in Your Application

Import database functions in your application:

```typescript
import { db } from 'database/postgres/src/project-data-db/drizzle-db';
import { createUser, getUserByUsername } from 'database/postgres/src/project-data-db/users';
import { createBookmark, getBookmarksByUser } from 'database/postgres/src/project-data-db/bookmarks';
import { createKbNode, searchKbNodes } from 'database/postgres/src/project-data-db/kb-nodes';
import { createConversation, getUserConversations } from 'database/postgres/src/project-data-db/user-conversations';
```

## License

ISC

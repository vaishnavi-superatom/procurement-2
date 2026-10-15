#!/bin/bash

# =========================================
# Database Migration Script
# =========================================
# This script applies pending migrations to the database WITHOUT dropping data.
# Use this script when updating an existing database with schema changes.
#
# Usage:
#   ./scripts/migrate-database.sh
#
# Prerequisites:
#   - Database already exists (run setup-database.sh first)
#   - .env file with PROJECT_DATABASE_URL configured
#   - Migration files generated (pnpm db:generate)
# =========================================

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo ""
echo "========================================="
echo " Running Database Migrations"
echo "========================================="
echo ""

# Navigate to the postgres directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

echo "Working directory: $(pwd)"
echo ""

# Check if .env file exists
if [ ! -f ".env" ]; then
    echo -e "${RED}Error: .env file not found!${NC}"
    echo ""
    echo "Please create .env file:"
    echo "  cp .env.example .env"
    echo ""
    echo "Then set PROJECT_DATABASE_URL in .env file"
    exit 1
fi

# Load environment variables
set -a
source .env
set +a

# Check if PROJECT_DATABASE_URL is set
if [ -z "$PROJECT_DATABASE_URL" ]; then
    echo -e "${RED}Error: PROJECT_DATABASE_URL not set in .env file${NC}"
    echo ""
    echo "Add the following to your .env file:"
    echo "  PROJECT_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/project_data"
    exit 1
fi

echo -e "${GREEN}✓ Environment variables loaded${NC}"

# Check if pnpm is installed
if ! command -v pnpm &> /dev/null; then
    echo -e "${RED}Error: pnpm not found${NC}"
    echo "Please install pnpm: npm install -g pnpm"
    exit 1
fi

# Install dependencies if node_modules doesn't exist
if [ ! -d "node_modules" ]; then
    echo ""
    echo "Installing dependencies..."
    pnpm install
    echo -e "${GREEN}✓ Dependencies installed${NC}"
fi

# Check if migrations folder exists
if [ ! -d "drizzle/migrations" ]; then
    echo -e "${YELLOW}⚠ No migrations folder found${NC}"
    echo ""
    echo "Generating migrations from schema..."
    pnpm drizzle-kit generate
    echo -e "${GREEN}✓ Migrations generated${NC}"
fi

# Count migration files
MIGRATION_COUNT=$(ls -1 drizzle/migrations/*.sql 2>/dev/null | wc -l)
echo -e "${GREEN}✓ Found $MIGRATION_COUNT migration file(s)${NC}"

# Apply migrations to database
echo ""
echo "Applying migrations to database..."
pnpm tsx scripts/run-migrations.ts

echo ""
echo "========================================="
echo -e "${GREEN}✓ Migrations applied successfully!${NC}"
echo "========================================="
echo ""

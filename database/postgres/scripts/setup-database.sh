#!/bin/bash

# =========================================
# Project Data Database Setup Script
# =========================================
# This script creates the local PostgreSQL database and syncs the schema.
# Run this script for initial setup of a new project.
#
# Usage:
#   ./scripts/setup-database.sh
#
# Prerequisites:
#   - PostgreSQL installed and running
#   - pnpm installed
# =========================================

set -e  # Exit on error

# Navigate to the postgres directory first to find .env
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

# Parse DATABASE_URL from .env file if it exists
if [ -f ".env" ]; then
    PROJECT_DATABASE_URL=$(grep -E "^PROJECT_DATABASE_URL=" .env | cut -d '=' -f2- | tr -d '"' | tr -d "'")

    if [ -n "$PROJECT_DATABASE_URL" ]; then
        # Parse the connection string: postgresql://user:password@host:port/database
        # Remove the postgresql:// prefix
        URL_WITHOUT_PREFIX="${PROJECT_DATABASE_URL#postgresql://}"

        # Extract user:password@host:port/database
        USER_PASS="${URL_WITHOUT_PREFIX%%@*}"
        HOST_PORT_DB="${URL_WITHOUT_PREFIX#*@}"

        # Extract user and password
        DB_USER="${USER_PASS%%:*}"
        DB_PASSWORD="${USER_PASS#*:}"

        # Extract host:port and database
        HOST_PORT="${HOST_PORT_DB%%/*}"
        DB_NAME="${HOST_PORT_DB#*/}"

        # Extract host and port
        DB_HOST="${HOST_PORT%%:*}"
        DB_PORT="${HOST_PORT#*:}"

        # If no port specified, default to 5432
        if [ "$DB_PORT" = "$DB_HOST" ]; then
            DB_PORT="5432"
        fi
    fi
fi

# Default configuration (used if not parsed from .env)
DB_NAME="${DB_NAME:-project_sa_data}"
DB_USER="${DB_USER:-postgres}"
DB_PASSWORD="${DB_PASSWORD:-postgres}"
DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Detect OS
detect_os() {
    if [[ "$OSTYPE" == "darwin"* ]]; then
        OS="macos"
    elif [[ -f /etc/os-release ]]; then
        OS="linux"
    else
        OS="unknown"
    fi
}

# Run psql command - uses sudo -u postgres on Linux for local connections
run_psql() {
    local database="$1"
    local command="$2"

    if [[ "$OS" == "linux" ]] && [[ "$DB_HOST" == "localhost" || "$DB_HOST" == "127.0.0.1" ]]; then
        # Use peer authentication via sudo on Linux for local connections
        # cd to /tmp to avoid "could not change directory" permission warning
        (cd /tmp && sudo -u postgres psql -d "$database" -c "$command" 2>/dev/null)
    else
        # Use password authentication for remote connections or macOS
        PGPASSWORD=$DB_PASSWORD psql -h $DB_HOST -p $DB_PORT -U $DB_USER -d "$database" -c "$command" 2>/dev/null
    fi
}

# Run psql with clean, tuples-only output (-tAc): no header, no row-count footer.
# Use this when you need to consume the result programmatically.
run_psql_tac() {
    local database="$1"
    local command="$2"

    if [[ "$OS" == "linux" ]] && [[ "$DB_HOST" == "localhost" || "$DB_HOST" == "127.0.0.1" ]]; then
        (cd /tmp && sudo -u postgres psql -d "$database" -tAc "$command" 2>/dev/null)
    else
        PGPASSWORD=$DB_PASSWORD psql -h $DB_HOST -p $DB_PORT -U $DB_USER -d "$database" -tAc "$command" 2>/dev/null
    fi
}

# Check if database exists
check_db_exists() {
    local result
    if [[ "$OS" == "linux" ]] && [[ "$DB_HOST" == "localhost" || "$DB_HOST" == "127.0.0.1" ]]; then
        # cd to /tmp to avoid permission warning, trim whitespace from result
        result=$(cd /tmp && sudo -u postgres psql -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '$DB_NAME'" 2>/dev/null | tr -d '[:space:]')
        result="${result:-0}"
    else
        result=$(PGPASSWORD=$DB_PASSWORD psql -h $DB_HOST -p $DB_PORT -U $DB_USER -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '$DB_NAME'" 2>/dev/null | tr -d '[:space:]')
        result="${result:-0}"
    fi
    echo "$result"
}

# Setup postgres user password for application connections
setup_postgres_password() {
    if [[ "$OS" == "linux" ]] && [[ "$DB_HOST" == "localhost" || "$DB_HOST" == "127.0.0.1" ]]; then
        echo "Setting up PostgreSQL user password..."
        (cd /tmp && sudo -u postgres psql -c "ALTER USER $DB_USER PASSWORD '$DB_PASSWORD';" 2>/dev/null) || true
    fi
}

detect_os

echo ""
echo "========================================="
echo " Project Data Database Setup"
echo "========================================="
echo ""

echo "Working directory: $(pwd)"
echo ""

# Check if PostgreSQL client is installed
if ! command -v psql &> /dev/null; then
    echo -e "${RED}Error: psql command not found${NC}"
    echo "Please install PostgreSQL client tools:"
    echo "  Ubuntu/Debian: sudo apt install postgresql-client"
    echo "  macOS: brew install postgresql"
    echo "  Windows: Install PostgreSQL from postgresql.org"
    exit 1
fi

# Check if PostgreSQL is running
echo "Checking PostgreSQL connection..."
if ! pg_isready -h $DB_HOST -p $DB_PORT > /dev/null 2>&1; then
    echo -e "${RED}Error: PostgreSQL is not running on $DB_HOST:$DB_PORT${NC}"
    echo ""
    echo "Please start PostgreSQL service:"
    echo "  Ubuntu/Debian: sudo systemctl start postgresql"
    echo "  macOS: brew services start postgresql"
    echo "  Windows: Start PostgreSQL service from Services"
    exit 1
fi

echo -e "${GREEN}✓ PostgreSQL is running${NC}"

# Check if pnpm is installed
if ! command -v pnpm &> /dev/null; then
    echo -e "${RED}Error: pnpm not found${NC}"
    echo "Please install pnpm: npm install -g pnpm"
    exit 1
fi

echo -e "${GREEN}✓ pnpm is available${NC}"

# Install dependencies if node_modules doesn't exist
if [ ! -d "node_modules" ]; then
    echo ""
    echo "Installing dependencies..."
    pnpm install
    echo -e "${GREEN}✓ Dependencies installed${NC}"
fi

# Setup postgres password for later application use
setup_postgres_password

# Check if database exists
echo ""
echo "Checking if '$DB_NAME' database exists..."
DB_EXISTS=$(check_db_exists)

if [ "$DB_EXISTS" = "1" ]; then
    echo -e "${YELLOW}⚠ Database '$DB_NAME' already exists${NC}"
    echo "Keeping existing database (use DROP DATABASE manually if you want to recreate)"
else
    echo "Creating database '$DB_NAME'..."
    run_psql "postgres" "CREATE DATABASE $DB_NAME;"
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}✓ Database '$DB_NAME' created${NC}"
    else
        echo -e "${RED}Failed to create database. Trying alternative method...${NC}"
        # Fallback: try with sudo -u postgres directly
        if [[ "$OS" == "linux" ]]; then
            sudo -u postgres createdb "$DB_NAME" 2>/dev/null && echo -e "${GREEN}✓ Database '$DB_NAME' created${NC}" || echo -e "${RED}Failed to create database${NC}"
        fi
    fi
fi

# Create .env file if it doesn't exist
if [ ! -f ".env" ]; then
    echo ""
    echo "Creating .env file..."
    cp .env.example .env
    echo -e "${GREEN}✓ .env file created from .env.example${NC}"
else
    echo -e "${GREEN}✓ .env file already exists${NC}"
fi

# Run migrations to create/update schema
echo ""
echo "Running database migrations..."
export PROJECT_DATABASE_URL="postgresql://$DB_USER:$DB_PASSWORD@$DB_HOST:$DB_PORT/$DB_NAME"
pnpm drizzle-kit migrate
echo -e "${GREEN}✓ Migrations completed successfully${NC}"

echo ""
echo "========================================="
echo -e "${GREEN}✓ Database setup completed!${NC}"
echo "========================================="
echo ""
echo "Database Details:"
echo "  Name:     $DB_NAME"
echo "  User:     $DB_USER"
echo "  Host:     $DB_HOST"
echo "  Port:     $DB_PORT"
echo ""
echo "Connection String:"
echo "  postgresql://$DB_USER:****@$DB_HOST:$DB_PORT/$DB_NAME"
echo ""
echo "Tables in database (post-migration):"
TABLE_LIST=$(run_psql_tac "$DB_NAME" "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename;")
if [ -n "$TABLE_LIST" ]; then
    echo "$TABLE_LIST" | while IFS= read -r tbl; do
        [ -n "$tbl" ] && echo "  - $tbl"
    done
else
    echo "  (could not list tables — query the database manually to verify)"
fi
echo ""

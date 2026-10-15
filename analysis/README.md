# Database Analysis

This folder contains tools to analyze PostgreSQL databases and generate structured schema documentation.

## Overview

The analysis tool connects to any PostgreSQL database, extracts the schema information, and generates:
- `schema.json` - Structured schema with tables, columns, relationships, and statistics
- `schema.md` - Human-readable markdown documentation

The output format follows the specification in `data/SCHEMA_STRUCTURE.md`.

## Prerequisites

### Python Installation

This tool requires Python 3.8 or higher.

**Check if Python is installed:**
```bash
python --version
# or
python3 --version
```

**Install Python if needed:**

<details>
<summary><b>macOS</b></summary>

```bash
# Using Homebrew (recommended)
brew install python

# Or download from python.org
# https://www.python.org/downloads/macos/
```
</details>

<details>
<summary><b>Ubuntu/Debian Linux</b></summary>

```bash
sudo apt update
sudo apt install python3 python3-pip python3-venv
```
</details>

<details>
<summary><b>Windows</b></summary>

1. Download Python from [python.org](https://www.python.org/downloads/windows/)
2. Run the installer
3. **Important:** Check "Add Python to PATH" during installation
4. Restart your terminal after installation
</details>

## Quick Start

Run these commands from the `analysis` folder:

```bash
# Navigate to analysis folder
cd analysis

# 1. Create virtual environment (recommended)
python3 -m venv venv

# 2. Activate virtual environment
# On macOS/Linux:
source venv/bin/activate
# On Windows:
# venv\Scripts\activate

# 3. Install dependencies
pip install -r code/requirements.txt

# 4. Configure database connection
cp .env.example .env
# Edit .env with your database URL

# 5. Run analysis
python code/analyze_database.py
```

## Detailed Setup

### Step 1: Create Virtual Environment (Recommended)

A virtual environment keeps dependencies isolated from your system Python.

```bash
# Create virtual environment
python3 -m venv venv

# Activate it
# macOS/Linux:
source venv/bin/activate

# Windows (Command Prompt):
venv\Scripts\activate.bat

# Windows (PowerShell):
venv\Scripts\Activate.ps1
```

Your terminal prompt should now show `(venv)` prefix.

**To deactivate later:**
```bash
deactivate
```

### Step 2: Install Dependencies

```bash
pip install -r code/requirements.txt
```

This installs:
- `psycopg2-binary` - PostgreSQL database adapter
- `python-dotenv` - Environment variable management

### Step 3: Configure Database Connection

Copy the example environment file:

```bash
cp .env.example .env
```

Edit `.env` with your database connection string:

```
DATABASE_URL=postgresql://username:password@host:port/database
```

**Connection String Examples:**

```bash
# Local database with default postgres user
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/myapp

# Local database with custom user
DATABASE_URL=postgresql://myuser:mypassword@localhost:5432/mydb

# Remote database
DATABASE_URL=postgresql://admin:secretpass@db.example.com:5432/production

# With SSL enabled
DATABASE_URL=postgresql://user:pass@host:5432/db?sslmode=require

# Docker container
DATABASE_URL=postgresql://postgres:postgres@host.docker.internal:5432/mydb
```

### Step 4: Run Analysis

```bash
python code/analyze_database.py
```

**Expected output:**
```
[ENV] Loaded environment from: /path/to/analysis/.env
============================================================
Database Schema Generator - mydb
============================================================
Connection: localhost:5432/mydb
============================================================
Starting database analysis...

Found 10 table(s) to analyze

Analyzing table: public.users
  - Column: id (integer)
  - Column: email (character varying)
  ...

[SUCCESS] Database schema generation completed!
============================================================
  Schema JSON: /path/to/analysis/data/schema.json
  Schema Markdown: /path/to/analysis/data/schema.md
  Total Tables: 10
  Total Rows: 50,000
  Total Relationships: 8
============================================================
```

## Output Files

| File | Description |
|------|-------------|
| `data/schema.json` | Structured schema in JSON format |
| `data/schema.md` | Markdown documentation for the database |
| `data/SCHEMA_STRUCTURE.md` | Reference specification for schema.json format |

## Schema Format

The generated `schema.json` includes:

- **Database metadata** - Name, schema, description
- **Tables** - Name, row count, description, columns
- **Columns** - Name, type, nullable, primary/foreign keys, statistics
- **Relationships** - Foreign key relationships between tables
- **Common Queries** - Auto-generated useful queries

See `data/SCHEMA_STRUCTURE.md` for the complete format specification.

## Folder Structure

```
analysis/
├── README.md              # This file
├── .env.example           # Template for database connection
├── .env                   # Your database config (create from .env.example)
├── .gitignore             # Ignores .env and Python cache files
├── code/
│   ├── analyze_database.py    # Main analysis script
│   └── requirements.txt       # Python dependencies
└── data/
    ├── SCHEMA_STRUCTURE.md    # Schema format specification
    ├── schema.json            # Generated schema (after running analysis)
    └── schema.md              # Generated documentation (after running analysis)
```

## Troubleshooting

### Python not found
```
command not found: python
```
**Solution:** Try `python3` instead of `python`, or install Python (see Prerequisites section).

### pip not found
```
command not found: pip
```
**Solution:** Try `pip3` instead, or install pip:
```bash
# macOS/Linux
python3 -m ensurepip --upgrade

# Or install via package manager
# Ubuntu/Debian: sudo apt install python3-pip
# macOS: brew install python (includes pip)
```

### DATABASE_URL not set
```
[ERROR] DATABASE_URL not set!
```
**Solution:** Make sure you created the `.env` file with your database URL:
```bash
cp .env.example .env
# Then edit .env with your connection string
```

### Connection refused
```
Error connecting to database: connection refused
```
**Solution:** Check that:
- PostgreSQL is running (`sudo systemctl status postgresql` on Linux)
- Host and port are correct in DATABASE_URL
- Firewall allows the connection

### Authentication failed
```
Error connecting to database: password authentication failed
```
**Solution:** Verify your username and password in the DATABASE_URL.

### psycopg2 installation fails
```
Error: pg_config executable not found
```
**Solution:** Install PostgreSQL development libraries:
```bash
# Ubuntu/Debian
sudo apt install libpq-dev

# macOS
brew install postgresql

# Or use the binary package (already in requirements.txt)
pip install psycopg2-binary
```

### Permission denied on .env
```
Permission denied: '.env'
```
**Solution:** Check file permissions:
```bash
chmod 600 .env
```

### Virtual environment not activating (Windows PowerShell)
```
cannot be loaded because running scripts is disabled
```
**Solution:** Run PowerShell as Administrator and execute:
```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

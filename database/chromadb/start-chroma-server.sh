#!/bin/bash
# Script to start ChromaDB server locally

echo "=================================================================="
echo "Starting ChromaDB Server"
echo "=================================================================="

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

# Get script directory
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

# Check if Python is installed
if ! command -v python3 &> /dev/null; then
    echo -e "${RED}✗ Python 3 is not installed${NC}"
    echo "Please install Python 3.8 or higher"
    exit 1
fi

echo -e "${GREEN}✓ Python is installed${NC}"

# Check if port 8000 is already in use
if lsof -i :8000 > /dev/null 2>&1; then
    echo -e "${YELLOW}⚠ Port 8000 is already in use${NC}"
    echo "ChromaDB server may already be running"
    echo ""
    echo "To check what's using port 8000:"
    echo "  lsof -i :8000"
    echo ""
    echo "To kill the existing process:"
    echo "  kill \$(lsof -t -i :8000)"
    exit 0  # Exit gracefully so PM2 doesn't keep retrying
fi

echo -e "${GREEN}✓ Port 8000 is available${NC}"

# Check for venv and activate it
if [ -d "$SCRIPT_DIR/venv" ]; then
    echo -e "${GREEN}✓ Using virtual environment${NC}"
    source "$SCRIPT_DIR/venv/bin/activate"
fi

# Check if ChromaDB command is available
if ! command -v chroma &> /dev/null; then
    echo -e "${RED}✗ ChromaDB is not installed or not in PATH${NC}"
    echo ""
    echo "Please install ChromaDB using one of these methods:"
    echo ""
    echo "Option 1: Using pipx (recommended)"
    echo "  sudo apt install pipx"
    echo "  pipx install chromadb"
    echo "  pipx ensurepath"
    echo "  source ~/.bashrc  # Restart terminal or reload PATH"
    echo ""
    echo "Option 2: Using virtual environment"
    echo "  python3 -m venv venv"
    echo "  source venv/bin/activate"
    echo "  pip install chromadb"
    echo ""
    exit 1
fi

echo -e "${GREEN}✓ ChromaDB is installed${NC}"

# Start ChromaDB server
echo ""
echo -e "${YELLOW}Starting ChromaDB server on http://localhost:8000${NC}"
echo "Press Ctrl+C to stop the server"
echo ""

chroma run --host localhost --port 8000

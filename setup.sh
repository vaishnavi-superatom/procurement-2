#!/bin/bash

# =============================================================================
# Superatom Project Setup Script
# =============================================================================
# This script automates the complete setup process for a new Superatom project.
# It will guide you through all the steps and prompt for required configurations.
# =============================================================================

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Get the directory where the script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# =============================================================================
# Project Configuration (Multi-project support)
# =============================================================================
# These variables will be set by prompt_project_config() or --project flag
PROJECT_NAME=""
PROJECT_PREFIX=""
PROJECT_DB_NAME=""
PROJECT_BACKEND_PORT=""
PROJECT_CHROMA_PORT=""

# Default port values (will be offset by project number if needed)
DEFAULT_BACKEND_PORT=3000
DEFAULT_CHROMA_PORT=8000

# ChromaDB configuration (collected in chromadb step, reused in backend)
CHROMA_SERVER_URL=""

# =============================================================================
# OS Detection
# =============================================================================

detect_os() {
    if [[ "$OSTYPE" == "darwin"* ]]; then
        OS="macos"
        # Check for Apple Silicon vs Intel
        if [[ $(uname -m) == "arm64" ]]; then
            ARCH="arm64"
        else
            ARCH="x64"
        fi
    elif [[ -f /etc/os-release ]]; then
        . /etc/os-release
        OS="linux"
        DISTRO="$ID"
        DISTRO_VERSION="$VERSION_ID"
    else
        OS="unknown"
    fi

    print_step "Detected OS: $OS"
    if [[ "$OS" == "macos" ]]; then
        print_step "Architecture: $ARCH"
    elif [[ "$OS" == "linux" ]]; then
        print_step "Distribution: $DISTRO $DISTRO_VERSION"
    fi
}

# =============================================================================
# Auto-Install Functions
# =============================================================================

# Wait for apt lock to be released (handles unattended-upgrades, etc.)
wait_for_apt_lock() {
    local max_wait=300  # Maximum wait time in seconds (5 minutes)
    local waited=0

    while sudo fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1 || \
          sudo fuser /var/lib/apt/lists/lock >/dev/null 2>&1 || \
          sudo fuser /var/lib/dpkg/lock >/dev/null 2>&1; do
        if [ $waited -eq 0 ]; then
            print_warning "Waiting for apt lock to be released (another process is using apt)..."
        fi
        sleep 5
        waited=$((waited + 5))
        if [ $waited -ge $max_wait ]; then
            print_error "Timeout waiting for apt lock after ${max_wait} seconds"
            return 1
        fi
        echo -n "."
    done

    if [ $waited -gt 0 ]; then
        echo ""
        print_success "apt lock released after ${waited} seconds"
    fi
    return 0
}

# A single broken third-party repo makes apt-get update exit non-zero, which
# under `set -e` would kill the whole setup. Warn instead; installs still work
# from the repos that did refresh.
apt_update() {
    if ! sudo apt-get update "$@"; then
        print_warning "apt-get update reported errors (likely a broken third-party repo) — continuing"
    fi
}

# Apply OS security updates so new instances are patched from first boot.
# Runs before services start, so auto-restarting system services is safe here.
update_os_security() {
    [[ "$OS" != "linux" ]] && return 0
    print_step "Applying OS security updates (apt upgrade)..."
    wait_for_apt_lock || return 0
    apt_update -qq
    if sudo env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a apt-get -y \
            -o Dpkg::Options::="--force-confold" upgrade; then
        print_success "OS packages updated"
    else
        print_warning "Some OS updates could not be applied — review manually"
    fi
}

install_homebrew() {
    if ! command -v brew &> /dev/null; then
        print_step "Installing Homebrew..."
        /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

        # Add Homebrew to PATH for Apple Silicon
        if [[ "$ARCH" == "arm64" ]]; then
            echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zprofile
            eval "$(/opt/homebrew/bin/brew shellenv)"
        fi
        print_success "Homebrew installed"
    fi
}

install_nodejs() {
    print_step "Installing latest Node.js LTS using nvm..."

    # Install nvm if not already installed
    if [ ! -d "$HOME/.nvm" ]; then
        print_step "Installing nvm (Node Version Manager)..."
        curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
        print_success "nvm installed"
    else
        print_success "nvm already installed"
    fi

    # Load nvm for current session
    export NVM_DIR="$HOME/.nvm"
    [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
    [ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"

    # Ensure nvm is loaded in future shell sessions (.bashrc)
    local shell_rc="$HOME/.bashrc"
    if [ -f "$HOME/.zshrc" ] && [ "$SHELL" = *"zsh"* ]; then
        shell_rc="$HOME/.zshrc"
    fi
    if ! grep -q 'NVM_DIR' "$shell_rc" 2>/dev/null; then
        print_step "Adding nvm to $shell_rc for future sessions..."
        cat >> "$shell_rc" << 'NVMEOF'

# Load nvm (added by setup.sh)
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"
NVMEOF
        print_success "nvm added to $shell_rc"
    fi

    # Install latest Node.js LTS (>= 22.19 required by pi-coding-agent).
    # Keep current: older Node (e.g. v20) bundles OpenSSL 3.0.19, which Amazon
    # Inspector flags as Critical — do not pin to an old major.
    print_step "Installing latest Node.js LTS..."
    nvm install --lts
    nvm use --lts
    nvm alias default lts/*

    if command -v node &> /dev/null; then
        print_success "Node.js installed: $(node -v)"
        print_success "npm installed: $(npm -v)"
    else
        print_error "Failed to install Node.js"
        return 1
    fi
}

install_python() {
    print_step "Installing Python 3 with venv and pip..."

    if [[ "$OS" == "macos" ]]; then
        install_homebrew
        brew install python@3.11
    elif [[ "$OS" == "linux" ]]; then
        wait_for_apt_lock || return 1
        apt_update
        # Install python3, pip, venv, and version-specific venv package
        local python_version=$(python3 --version 2>/dev/null | grep -oP '\d+\.\d+' || echo "3.10")
        sudo apt-get install -y python3 python3-pip python3-venv python${python_version}-venv
    fi

    if command -v python3 &> /dev/null; then
        print_success "Python installed: $(python3 --version)"
    else
        print_error "Failed to install Python"
        return 1
    fi
}

install_python_venv() {
    print_step "Installing Python venv package..."

    if [[ "$OS" == "linux" ]]; then
        wait_for_apt_lock || return 1
        apt_update
        # Get the installed Python version and install matching venv
        local python_version=$(python3 --version | grep -oP '\d+\.\d+')
        sudo apt-get install -y python3-venv python${python_version}-venv
    fi

    print_success "Python venv installed"
}

install_postgresql() {
    print_step "Installing PostgreSQL..."

    if [[ "$OS" == "macos" ]]; then
        install_homebrew
        brew install postgresql@15
        brew services start postgresql@15

        # Add PostgreSQL to PATH
        echo 'export PATH="/opt/homebrew/opt/postgresql@15/bin:$PATH"' >> ~/.zshrc
        export PATH="/opt/homebrew/opt/postgresql@15/bin:$PATH"
    elif [[ "$OS" == "linux" ]]; then
        wait_for_apt_lock || return 1
        apt_update
        sudo apt-get install -y postgresql postgresql-contrib
        sudo systemctl start postgresql
        sudo systemctl enable postgresql
    fi

    if command -v psql &> /dev/null; then
        print_success "PostgreSQL installed"
    else
        print_error "Failed to install PostgreSQL"
        return 1
    fi
}

install_pnpm() {
    print_step "Installing pnpm globally..."

    # Ensure nvm is loaded if it exists (for nvm-installed Node.js)
    if [ -d "$HOME/.nvm" ]; then
        export NVM_DIR="$HOME/.nvm"
        [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
    fi

    if command -v npm &> /dev/null; then
        # With nvm, npm is installed in user space, so no sudo needed
        npm install -g pnpm
    else
        # Use standalone installer if npm not available
        curl -fsSL https://get.pnpm.io/install.sh | sh -

        # Source pnpm for current session
        export PNPM_HOME="$HOME/.local/share/pnpm"
        export PATH="$PNPM_HOME:$PATH"
    fi

    # Verify pnpm is accessible
    if command -v pnpm &> /dev/null; then
        print_success "pnpm installed globally: $(pnpm -v)"
    else
        # pnpm might be installed but not in PATH yet — check nvm bin
        local nvm_bin="$(npm config get prefix 2>/dev/null)/bin"
        if [ -f "$nvm_bin/pnpm" ]; then
            export PATH="$nvm_bin:$PATH"
            print_success "pnpm installed: $(pnpm -v)"
        else
            print_error "Failed to install pnpm"
            return 1
        fi
    fi
}

# Codex CLI: the coding-agent answer flow (the default) runs on it. The version
# is read from the Dockerfile so there is one pin to bump, not two.
CODEX_MIN_VERSION="0.156"
install_codex() {
    local want
    want=$(sed -n 's/^ARG CODEX_VERSION=\(.*\)$/\1/p' "$SCRIPT_DIR/Dockerfile" 2>/dev/null | head -n 1)
    want=${want:-0.156.1}
    print_step "Installing codex CLI ${want}..."

    if [ -d "$HOME/.nvm" ]; then
        export NVM_DIR="$HOME/.nvm"
        [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
    fi
    command -v npm &> /dev/null || { print_error "npm is required to install codex"; return 1; }

    # nvm installs npm in user space, so no sudo.
    npm install -g "@openai/codex@${want}" || { print_error "Failed to install codex"; return 1; }

    if command -v codex &> /dev/null; then
        print_success "codex installed: $(codex --version 2>/dev/null)"
        print_warning "codex still needs a credential: CODEX_API_KEY, or run 'codex login' as the user the backend runs as"
    else
        print_error "codex was installed but is not on PATH"
        return 1
    fi
}

# True when $1 is older than $2 (both plain x.y.z).
version_lt() {
    [ "$1" = "$2" ] && return 1
    [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -n 1)" = "$1" ]
}

install_pip() {
    print_step "Installing pip..."

    if [[ "$OS" == "macos" ]]; then
        python3 -m ensurepip --upgrade
    elif [[ "$OS" == "linux" ]]; then
        wait_for_apt_lock || return 1
        apt_update
        sudo apt-get install -y python3-pip
    fi

    if command -v pip3 &> /dev/null || command -v pip &> /dev/null; then
        print_success "pip installed"
    else
        print_error "Failed to install pip"
        return 1
    fi
}

# =============================================================================
# Helper Functions
# =============================================================================

print_header() {
    echo ""
    echo -e "${BLUE}==========================================${NC}"
    echo -e "${BLUE} $1${NC}"
    echo -e "${BLUE}==========================================${NC}"
    echo ""
}

print_step() {
    echo -e "${CYAN}➤ $1${NC}"
}

print_success() {
    echo -e "${GREEN}✓ $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}⚠ $1${NC}"
}

print_error() {
    echo -e "${RED}✗ $1${NC}"
}

prompt_input() {
    local prompt="$1"
    local default="$2"
    local var_name="$3"

    if [ -n "$default" ]; then
        read -p "$(echo -e ${CYAN}"$prompt [${default}]: "${NC})" input
        eval "$var_name=\"${input:-$default}\""
    else
        read -p "$(echo -e ${CYAN}"$prompt: "${NC})" input
        eval "$var_name=\"$input\""
    fi
}

# prompt_input, except values pre-filled by --config (install token) are kept, not asked.
# In pre-filled mode an empty value falls back to its default, or stays empty if "optional".
ask() {
    local prompt="$1" default="$2" var_name="$3" optional="${4:-}"
    if [ "$PREFILLED" = "true" ]; then
        if [ -n "${!var_name}" ]; then
            print_success "${prompt%% (*}: from install token"
            return 0
        fi
        if [ -n "$default" ]; then
            eval "$var_name=\"\$default\""
            return 0
        fi
        [ "$optional" = "optional" ] && return 0
    fi
    prompt_input "$prompt" "$default" "$var_name"
}

prompt_password() {
    local prompt="$1"
    local var_name="$2"

    read -sp "$(echo -e ${CYAN}"$prompt: "${NC})" input
    echo ""
    eval "$var_name=\"$input\""
}

prompt_yes_no() {
    local prompt="$1"
    local default="$2"

    if [ "$default" = "y" ]; then
        read -p "$(echo -e ${CYAN}"$prompt [Y/n]: "${NC})" choice
        choice="${choice:-y}"
    else
        read -p "$(echo -e ${CYAN}"$prompt [y/N]: "${NC})" choice
        choice="${choice:-n}"
    fi

    case "$choice" in
        [Yy]* ) return 0;;
        * ) return 1;;
    esac
}

check_command() {
    if command -v "$1" &> /dev/null; then
        print_success "$1 is installed"
        return 0
    else
        print_error "$1 is not installed"
        return 1
    fi
}

# =============================================================================
# Project Configuration
# =============================================================================

prompt_project_config() {
    print_header "Project Configuration"

    if [ "$PREFILLED" != "true" ]; then
        echo -e "${YELLOW}Enter a unique project name (used as prefix for database, collections, etc.)${NC}"
        echo ""
    fi

    if [ "$PREFILLED" = "true" ] && [ -n "$PROJECT_NAME" ]; then
        print_success "Project name: ${PROJECT_NAME} (from install token)"
    else
        prompt_input "Project name (e.g., acme, ikea, bluelinx)" "" PROJECT_NAME
    fi

    if [ -z "$PROJECT_NAME" ]; then
        print_error "Project name is required!"
        exit 1
    fi

    # Sanitize: lowercase, replace spaces/special chars with underscore
    PROJECT_PREFIX=$(echo "$PROJECT_NAME" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/_/g')

    echo ""
    print_success "Project prefix: ${PROJECT_PREFIX}"
    echo ""
    if [ "$DOCKER_MODE" = "true" ]; then
        echo "This will be used for:"
        echo "  - Docker stack: ${PROJECT_PREFIX} (containers, volumes and network are named after it)"
        echo "  - ChromaDB collections: ${PROJECT_PREFIX}_knowledge_base, ${PROJECT_PREFIX}_user_conversations, ..."
        if [ "$PREFILLED" != "true" ]; then
            echo "  - For dev and prod on one VM, use distinct names (e.g. ${PROJECT_NAME}-dev, ${PROJECT_NAME}-prod)"
        fi
        echo ""
        return
    fi
    echo "This will be used for:"
    echo "  - Database: ${PROJECT_PREFIX}_sa_data"
    echo "  - ChromaDB collections:"
    echo "      ${PROJECT_PREFIX}_knowledge_base"
    echo "      ${PROJECT_PREFIX}_user_conversations"
    echo "      ${PROJECT_PREFIX}_components"
    echo "      ${PROJECT_PREFIX}_bookmarks"
    echo "  - PM2 processes: ${PROJECT_PREFIX}-chromadb, ${PROJECT_PREFIX}-backend"
    echo "  - Configure data sources via UI or API after setup"
    echo ""
}

# =============================================================================
# Prerequisites Check (with Auto-Install)
# =============================================================================

check_prerequisites() {
    print_header "Checking & Installing Prerequisites"

    # Detect OS first
    detect_os

    # Load nvm if it exists (ensures nvm-installed Node.js is in PATH)
    if [ -d "$HOME/.nvm" ]; then
        export NVM_DIR="$HOME/.nvm"
        [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
    fi

    if [[ "$OS" == "unknown" ]]; then
        print_error "Unsupported operating system. Please use Ubuntu/Debian or macOS."
        exit 1
    fi

    # Patch the OS before installing/starting anything
    update_os_security

    local all_ok=true

    # Check Node.js - install if missing or below v22.19.0 (required by pi-coding-agent)
    if command -v node &> /dev/null; then
        NODE_MAJOR_VERSION=$(node -v | sed 's/^v//' | cut -d. -f1)
        if [ "$NODE_MAJOR_VERSION" -ge 22 ]; then
            print_success "Node.js is installed"
            echo "  Version: $(node -v)"
        else
            print_warning "Node.js $(node -v) is below the required v22.19.0 minimum. Installing latest Node.js LTS..."
            install_nodejs || all_ok=false
        fi
    else
        print_warning "Node.js is not installed. Installing..."
        install_nodejs || all_ok=false
    fi

    # Check Python - install if missing
    if command -v python3 &> /dev/null; then
        print_success "Python3 is installed"
        echo "  Version: $(python3 --version)"
    else
        print_warning "Python3 is not installed. Installing..."
        install_python || all_ok=false
    fi

    # Check Python venv - install if missing (required for virtual environments)
    if [[ "$OS" == "linux" ]]; then
        # Test by actually creating a temp venv (--help doesn't catch missing ensurepip)
        local test_venv_dir=$(mktemp -d)
        if python3 -m venv "$test_venv_dir/test_venv" 2>/dev/null; then
            rm -rf "$test_venv_dir"
            print_success "Python venv is available"
        else
            rm -rf "$test_venv_dir"
            print_warning "Python venv is not fully functional. Installing required packages..."
            install_python_venv || all_ok=false
        fi
    fi

    # Check PostgreSQL - install if missing
    if command -v psql &> /dev/null; then
        print_success "PostgreSQL is installed"
    else
        print_warning "PostgreSQL is not installed. Installing..."
        install_postgresql || all_ok=false
    fi

    # Check if PostgreSQL is running - start if not
    if pg_isready &> /dev/null; then
        print_success "PostgreSQL is running"
    else
        print_warning "PostgreSQL is not running. Starting..."
        if [[ "$OS" == "macos" ]]; then
            brew services start postgresql@15 2>/dev/null || brew services start postgresql 2>/dev/null
        elif [[ "$OS" == "linux" ]]; then
            sudo systemctl start postgresql
        fi

        # Wait a moment and check again
        sleep 2
        if pg_isready &> /dev/null; then
            print_success "PostgreSQL started successfully"
        else
            print_warning "PostgreSQL may not be running. Trying to continue..."
        fi
    fi

    # Check pnpm - install if missing
    if command -v pnpm &> /dev/null; then
        print_success "pnpm is installed"
        echo "  Version: $(pnpm -v)"
    else
        print_warning "pnpm is not installed. Installing..."
        install_pnpm || all_ok=false
    fi

    # Check codex - the coding-agent answer flow (the default) runs on it
    if command -v codex &> /dev/null; then
        local codex_version
        codex_version=$(codex --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n 1)
        print_success "codex is installed"
        echo "  Version: ${codex_version:-unknown}"
        if [ -n "$codex_version" ] && version_lt "$codex_version" "$CODEX_MIN_VERSION"; then
            print_warning "codex $codex_version is too old for the default answer model (needs >= $CODEX_MIN_VERSION)"
            echo "  Upgrade: npm install -g @openai/codex@latest"
        fi
    else
        print_warning "codex is not installed. Installing..."
        install_codex || print_warning "Continuing without codex — the coding-agent answer flow will not work (set SA_ANSWER_FLOW=agents in backend/.env to use MainAgent + SourceAgent)"
    fi

    # Check pip - install if missing
    if command -v pip3 &> /dev/null || command -v pip &> /dev/null; then
        print_success "pip is installed"
    else
        print_warning "pip is not installed. Installing..."
        install_pip || all_ok=false
    fi

    if [ "$all_ok" = false ]; then
        print_error "Failed to install some prerequisites. Please check the errors above."
        exit 1
    fi

    echo ""
    print_success "All prerequisites satisfied!"
}

# =============================================================================
# Step 1: PostgreSQL Database Setup
# =============================================================================

setup_postgres() {
    print_header "Step 1: PostgreSQL Database Setup"

    cd "$SCRIPT_DIR/database/postgres"
    print_step "Working directory: $(pwd)"

    # Install dependencies
    print_step "Installing Node.js dependencies..."
    pnpm install --silent
    print_success "Dependencies installed"

    # Configure .env
    print_step "Configuring environment variables..."

    if [ -f ".env" ]; then
        if prompt_yes_no "Postgres .env already exists. Overwrite?" "n"; then
            rm .env
        else
            print_warning "Keeping existing .env file"
        fi
    fi

    if [ ! -f ".env" ]; then
        echo ""
        echo -e "${YELLOW}Enter your PROJECT database connection details:${NC}"
        echo -e "${YELLOW}(This will store users, bookmarks, conversations)${NC}"
        echo ""

        prompt_input "Database host" "localhost" PG_HOST
        prompt_input "Database port" "5432" PG_PORT
        prompt_input "Database name" "${PROJECT_PREFIX}_sa_data" PG_DB_NAME
        prompt_input "Database user" "postgres" PG_USER

        # Require non-empty password
        PG_PASSWORD=""
        while [ -z "$PG_PASSWORD" ]; do
            prompt_password "Database password (required)" PG_PASSWORD
            if [ -z "$PG_PASSWORD" ]; then
                print_warning "Password cannot be empty. Please enter a password."
            fi
        done

        # For local connections on Linux, set the PostgreSQL user password using peer auth
        if [[ "$OS" == "linux" ]] && [[ "$PG_HOST" == "localhost" || "$PG_HOST" == "127.0.0.1" ]]; then
            print_step "Setting up PostgreSQL user password..."
            if (cd /tmp && sudo -u postgres psql -c "ALTER USER $PG_USER PASSWORD '$PG_PASSWORD';" 2>/dev/null); then
                print_success "PostgreSQL user password configured"
            else
                print_warning "Could not set PostgreSQL password automatically"
                echo ""
                echo -e "${YELLOW}You may need to set the password manually:${NC}"
                echo "  sudo -u postgres psql"
                echo "  ALTER USER $PG_USER PASSWORD '$PG_PASSWORD';"
                echo "  \\q"
                echo ""
            fi
        fi

        # Test the connection before proceeding
        print_step "Testing database connection..."
        if PGPASSWORD="$PG_PASSWORD" psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d postgres -c "SELECT 1" > /dev/null 2>&1; then
            print_success "Database connection successful"
        else
            print_warning "Could not connect with password authentication"
            echo ""
            echo -e "${YELLOW}Troubleshooting steps:${NC}"
            echo "1. Ensure PostgreSQL is running: sudo systemctl status postgresql"
            echo "2. Set password manually:"
            echo "   sudo -u postgres psql"
            echo "   ALTER USER $PG_USER PASSWORD '$PG_PASSWORD';"
            echo "   \\q"
            echo ""
            echo "3. Check pg_hba.conf allows password authentication:"
            echo "   sudo nano /etc/postgresql/*/main/pg_hba.conf"
            echo "   Change 'peer' to 'md5' or 'scram-sha-256' for local connections"
            echo "   sudo systemctl restart postgresql"
            echo ""

            if ! prompt_yes_no "Continue anyway?" "n"; then
                print_error "Setup aborted. Please fix PostgreSQL authentication and try again."
                return 1
            fi
        fi

        # Create .env file
        cat > .env << EOF
PROJECT_DATABASE_URL=postgresql://${PG_USER}:${PG_PASSWORD}@${PG_HOST}:${PG_PORT}/${PG_DB_NAME}
EOF

        print_success ".env file created"

        # Store for later use
        PROJECT_DATABASE_URL="postgresql://${PG_USER}:${PG_PASSWORD}@${PG_HOST}:${PG_PORT}/${PG_DB_NAME}"
    else
        # Read existing URL
        PROJECT_DATABASE_URL=$(grep PROJECT_DATABASE_URL .env | cut -d '=' -f2-)
    fi

    # Run setup script
    print_step "Running database setup script..."
    if [ -x "./scripts/setup-database.sh" ]; then
        ./scripts/setup-database.sh
    else
        chmod +x ./scripts/setup-database.sh
        ./scripts/setup-database.sh
    fi

}

# =============================================================================
# Step 2: ChromaDB Setup
# =============================================================================

setup_chromadb() {
    print_header "Step 2: ChromaDB Setup"

    cd "$SCRIPT_DIR/database/chromadb"
    print_step "Working directory: $(pwd)"

    # Install Node dependencies
    print_step "Installing Node.js dependencies..."
    # pnpm 10 blocks build scripts (esbuild, protobufjs) for packages not yet
    # explicitly approved, even though they're listed in this package's
    # onlyBuiltDependencies (pnpm-workspace.yaml) — a fresh/stale node_modules
    # state can still hit ERR_PNPM_IGNORED_BUILDS on first install. Approve
    # the known ones and retry rather than requiring manual intervention.
    if ! pnpm install --silent; then
        print_warning "pnpm install blocked some build scripts — approving and retrying..."
        pnpm approve-builds esbuild protobufjs || true
        pnpm install
    fi
    print_success "Node.js dependencies installed"

    # Create local venv and install ChromaDB Python package (required for server)
    print_step "Setting up ChromaDB Python environment..."

    if [ -d "venv" ] && [ -f "venv/bin/activate" ]; then
        print_success "Virtual environment already exists"
    else
        # Remove broken/incomplete venv if it exists
        if [ -d "venv" ]; then
            print_warning "Removing incomplete virtual environment..."
            rm -rf venv
        fi
        print_step "Creating Python virtual environment..."
        python3 -m venv venv
        print_success "Virtual environment created"
    fi

    # Activate local venv and install chromadb
    print_step "Activating virtual environment..."
    source venv/bin/activate
    print_success "Virtual environment activated"

    print_step "Installing ChromaDB Python package..."
    ./venv/bin/pip install chromadb --quiet
    deactivate
    print_success "ChromaDB installed in local venv"

    # Configure .env
    print_step "Configuring environment variables..."

    if [ -f ".env" ]; then
        if prompt_yes_no "ChromaDB .env already exists. Overwrite?" "n"; then
            rm .env
        else
            print_warning "Keeping existing .env file"
            # Read server URL for reuse in backend
            CHROMA_SERVER_URL=$(grep -E "^CHROMA_SERVER_URL=" .env | cut -d '=' -f2-)
            return
        fi
    fi

    echo ""
    echo -e "${YELLOW}Enter ChromaDB configuration:${NC}"
    echo ""

    prompt_input "ChromaDB server URL" "http://localhost:8000" CHROMA_URL
    prompt_input "Knowledge base collection name" "${PROJECT_PREFIX}_knowledge_base" CHROMA_COLLECTION
    prompt_input "User conversations collection name" "${PROJECT_PREFIX}_user_conversations" CHROMA_USER_CONVERSATIONS_COLLECTION
    prompt_input "Components collection name" "${PROJECT_PREFIX}_components" CHROMA_COMPONENTS_COLLECTION
    prompt_input "Bookmarks collection name" "${PROJECT_PREFIX}_bookmarks" CHROMA_BOOKMARKS_COLLECTION
    prompt_input "Schema tables collection name" "${PROJECT_PREFIX}_schema_tables" CHROMA_SCHEMA_TABLES_COLLECTION
    prompt_input "Source summaries collection name" "${PROJECT_PREFIX}_source_summaries" CHROMA_SOURCE_SUMMARIES_COLLECTION
    prompt_input "KB table name" "kb_nodes" CHROMA_KB_TABLE

    # Store server URL for reuse in backend
    CHROMA_SERVER_URL="$CHROMA_URL"

    # Get project database URL
    if [ -z "$PROJECT_DATABASE_URL" ]; then
        if [ -f "$SCRIPT_DIR/database/postgres/.env" ]; then
            PROJECT_DATABASE_URL=$(grep PROJECT_DATABASE_URL "$SCRIPT_DIR/database/postgres/.env" | cut -d '=' -f2-)
        else
            prompt_input "Project database URL" "postgresql://postgres:postgres@localhost:5432/${PROJECT_PREFIX}_sa_data" PROJECT_DATABASE_URL
        fi
    fi

    # Create .env file
    cat > .env << EOF
PROJECT_DATABASE_URL=${PROJECT_DATABASE_URL}
CHROMA_SERVER_URL=${CHROMA_URL}

# Knowledge base collection name
COLLECTION_NAME=${CHROMA_COLLECTION}

# User conversations collection name
USER_CONVERSATIONS_COLLECTION_NAME=${CHROMA_USER_CONVERSATIONS_COLLECTION}

# Components collection name (for display component embeddings)
COMPONENTS_COLLECTION_NAME=${CHROMA_COMPONENTS_COLLECTION}

# Bookmarks collection name (for user bookmark embeddings)
BOOKMARKS_COLLECTION_NAME=${CHROMA_BOOKMARKS_COLLECTION}

# Schema tables collection name (per-table embeddings for SourceAgent schema pre-search)
SCHEMA_TABLES_COLLECTION_NAME=${CHROMA_SCHEMA_TABLES_COLLECTION}

# Source summaries collection name (per-source embeddings for MainAgent routing pre-filter)
SOURCE_SUMMARIES_COLLECTION_NAME=${CHROMA_SOURCE_SUMMARIES_COLLECTION}

KB_TABLE_NAME=${CHROMA_KB_TABLE}
EOF

    print_success ".env file created"

    echo ""
    print_warning "To start ChromaDB server, run:"
    echo "  cd database/chromadb && pnpm start:chroma"
    echo ""
    print_warning "To sync knowledge base, run:"
    echo "  cd database/chromadb && pnpm sync"
}

# =============================================================================
# Step 3: Frontend Setup
# =============================================================================

setup_frontend() {
    print_header "Step 3: Frontend Setup"

    cd "$SCRIPT_DIR/frontend"
    print_step "Working directory: $(pwd)"

    # Install dependencies
    print_step "Installing Node.js dependencies..."
    pnpm install --silent
    print_success "Dependencies installed"

    # Configure .env (optional for frontend)
    if [ ! -f ".env" ] && [ -f ".env.example" ]; then
        print_step "Creating .env from example..."
        cp .env.example .env
        print_success ".env file created"
    fi

    if prompt_yes_no "Build frontend now?" "y"; then
        print_step "Building frontend..."
        pnpm build
        print_success "Frontend built successfully!"
        print_success "Output: dist/"
    fi
}

# =============================================================================
# Backend configuration (shared by the PM2 flow and --docker)
# =============================================================================

# Default ChromaDB collection names, as setup_chromadb proposes them.
set_default_chroma_collections() {
    CHROMA_COLLECTION="${PROJECT_PREFIX}_knowledge_base"
    CHROMA_USER_CONVERSATIONS_COLLECTION="${PROJECT_PREFIX}_user_conversations"
    CHROMA_COMPONENTS_COLLECTION="${PROJECT_PREFIX}_components"
    CHROMA_BOOKMARKS_COLLECTION="${PROJECT_PREFIX}_bookmarks"
    CHROMA_SCHEMA_TABLES_COLLECTION="${PROJECT_PREFIX}_schema_tables"
    CHROMA_SOURCE_SUMMARIES_COLLECTION="${PROJECT_PREFIX}_source_summaries"
}

# Prompts for everything backend/.env needs. DOCKER_MODE=true skips the host DB/port/Chroma questions.
collect_backend_config() {
    # Section headings only when asking; with an install token the "✓ … from install token" lines say it all.
    if [ "$PREFILLED" != "true" ]; then
        echo ""
        echo -e "${YELLOW}Enter SuperAtom SDK credentials:${NC}"
        echo ""
    fi

    ask "SuperAtom API Key" "" SUPERATOM_API_KEY
    ask "SuperAtom Project ID" "" SUPERATOM_PROJECT_ID

    # Org + admin are created in the Platform UI; setup only records their identifiers.
    if [ "$PREFILLED" != "true" ]; then
        echo ""
        echo -e "${YELLOW}SA-API / organization (create the org in the Platform UI first):${NC}"
        echo ""
    fi

    ask "SA-API Base URL" "https://sa-api.superatom.ai" SA_API_BASE_URL
    ask "Organization ID (optional, from the Platform UI)" "" SA_ORG_ID optional
    ask "Organization slug (optional, e.g. acme for acme.superatom.ai)" "" SA_ORG_SLUG optional

    # Get project database URL (Docker: the stack's own Postgres, set by docker-compose.yml)
    if [ "$DOCKER_MODE" != "true" ] && [ -z "$PROJECT_DATABASE_URL" ]; then
        if [ -f "$SCRIPT_DIR/database/postgres/.env" ]; then
            PROJECT_DATABASE_URL=$(grep PROJECT_DATABASE_URL "$SCRIPT_DIR/database/postgres/.env" | cut -d '=' -f2-)
        else
            prompt_input "Project database URL" "postgresql://postgres:postgres@localhost:5432/project_sa_data" PROJECT_DATABASE_URL
        fi
    fi

    if [ "$PREFILLED" != "true" ]; then
        echo ""
        echo -e "${YELLOW}Enter LLM Provider API Keys:${NC}"
        echo -e "${YELLOW}(At least one is required)${NC}"
        echo ""
    fi

    # Standard path for client deployments: a per-client `sk-prox-...` key issued
    # by our LLM proxy. Anthropic/Gemini/OpenAI/Groq are direct-key fallbacks.
    ask "OpenRouter API Key (sk-prox-..., standard for clients)" "" OPENROUTER_KEY
    ask "Anthropic API Key (optional, press Enter to skip)" "" ANTHROPIC_KEY optional
    ask "Gemini API Key (optional, press Enter to skip)" "" GEMINI_KEY optional
    ask "OpenAI API Key (optional, press Enter to skip)" "" OPENAI_KEY optional
    ask "Groq API Key (optional, press Enter to skip)" "" GROQ_KEY optional

    if [ -z "$ANTHROPIC_KEY" ] && [ -z "$GROQ_KEY" ] && [ -z "$GEMINI_KEY" ] && [ -z "$OPENAI_KEY" ] && [ -z "$OPENROUTER_KEY" ]; then
        print_error "At least one LLM provider API key is required!"
        prompt_input "OpenRouter API Key" "" OPENROUTER_KEY
    fi

    # Docker: no host port, and Chroma is the stack's own — only collection names are needed.
    if [ "$DOCKER_MODE" = "true" ]; then
        set_default_chroma_collections
        return
    fi

    echo ""
    echo -e "${YELLOW}Optional configurations:${NC}"
    echo ""

    prompt_input "Server port" "3000" SERVER_PORT

    # Check if ChromaDB URL was already collected in chromadb step
    if [ -n "$CHROMA_SERVER_URL" ]; then
        print_success "Using ChromaDB URL from chromadb setup step: ${CHROMA_SERVER_URL}"
        CHROMA_URL="$CHROMA_SERVER_URL"
    elif [ -f "$SCRIPT_DIR/database/chromadb/.env" ]; then
        # Try to read from chromadb/.env
        CHROMA_SERVER_URL=$(grep -E "^CHROMA_SERVER_URL=" "$SCRIPT_DIR/database/chromadb/.env" | cut -d '=' -f2-)
        if [ -n "$CHROMA_SERVER_URL" ]; then
            print_success "Using ChromaDB URL from chromadb/.env: ${CHROMA_SERVER_URL}"
            CHROMA_URL="$CHROMA_SERVER_URL"
        else
            prompt_input "ChromaDB URL (optional)" "http://localhost:8000" CHROMA_URL
        fi
    else
        prompt_input "ChromaDB URL (optional)" "http://localhost:8000" CHROMA_URL
    fi

}

# Writes .env in the current directory (backend/) from collect_backend_config's answers.
write_backend_env() {
    # Create .env file
    if [ "$DOCKER_MODE" = "true" ]; then
        # DB, Chroma and bundle paths come from docker-compose.yml.
        cat > .env << EOF
# Server Configuration (Docker stack: PROJECT_DATABASE_URL and CHROMA_SERVER_URL come from docker-compose.yml)
NODE_ENV=production

# SuperAtom SDK
SUPERATOM_API_KEY=${SUPERATOM_API_KEY}
SUPERATOM_PROJECT_ID=${SUPERATOM_PROJECT_ID}

# LLM Providers
EOF
    else
    cat > .env << EOF
# Server Configuration
PORT=${SERVER_PORT}
NODE_ENV=development

# SuperAtom SDK
SUPERATOM_API_KEY=${SUPERATOM_API_KEY}
SUPERATOM_PROJECT_ID=${SUPERATOM_PROJECT_ID}

# Frontend bundle directory
BUNDLE_DIR=../frontend/dist/assets

# Project Database (bookmarks, conversations, dashboards, etc.)
PROJECT_DATABASE_URL=${PROJECT_DATABASE_URL}

# LLM Providers
EOF
    fi

    if [ -n "$ANTHROPIC_KEY" ]; then
        echo "ANTHROPIC_API_KEY=${ANTHROPIC_KEY}" >> .env
    fi

    if [ -n "$GROQ_KEY" ]; then
        echo "GROQ_API_KEY=${GROQ_KEY}" >> .env
    fi

    if [ -n "$GEMINI_KEY" ]; then
        echo "GEMINI_API_KEY=${GEMINI_KEY}" >> .env
    fi

    if [ -n "$OPENAI_KEY" ]; then
        echo "OPENAI_API_KEY=${OPENAI_KEY}" >> .env
    fi

    # Same proxy for every client; sa.ts exits at startup if a sk-prox key has no URL.
    echo "SUPERATOM_LLM_PROXY_URL=https://ai.superatom.ai" >> .env
    if [ -n "$OPENROUTER_KEY" ]; then
        echo "OPENROUTER_API_KEY=${OPENROUTER_KEY}" >> .env
    fi

    # Add Analytics API configuration (uses SA-API URL and org from earlier)
    if [ -n "$SA_API_BASE_URL" ]; then
        echo "" >> .env
        echo "# Analytics API" >> .env
        echo "SA_API_URL=${SA_API_BASE_URL}" >> .env
        if [ -n "$SA_ORG_ID" ]; then
            echo "SA_ORG_ID=${SA_ORG_ID}" >> .env
        fi
        # Org slug → report/alert email links use https://<slug>.superatom.ai
        # so recipients skip the org-slug prompt at SSO login.
        if [ -n "$SA_ORG_SLUG" ]; then
            echo "SA_ORG_SLUG=${SA_ORG_SLUG}" >> .env
        fi
    fi

    # Add ChromaDB configuration
    if [ -n "$CHROMA_URL" ]; then
        echo "" >> .env
        echo "# ChromaDB Configuration" >> .env
        echo "CHROMA_SERVER_URL=${CHROMA_URL}" >> .env
    fi

    # Add ChromaDB collection names (reuse from chromadb setup step)
    if [ -n "$CHROMA_COLLECTION" ]; then
        echo "" >> .env
        echo "# ChromaDB Collection Names" >> .env
        echo "COLLECTION_NAME=${CHROMA_COLLECTION}" >> .env
        echo "USER_CONVERSATIONS_COLLECTION_NAME=${CHROMA_USER_CONVERSATIONS_COLLECTION}" >> .env
        echo "COMPONENTS_COLLECTION_NAME=${CHROMA_COMPONENTS_COLLECTION}" >> .env
        echo "BOOKMARKS_COLLECTION_NAME=${CHROMA_BOOKMARKS_COLLECTION}" >> .env
        echo "SCHEMA_TABLES_COLLECTION_NAME=${CHROMA_SCHEMA_TABLES_COLLECTION}" >> .env
        echo "SOURCE_SUMMARIES_COLLECTION_NAME=${CHROMA_SOURCE_SUMMARIES_COLLECTION}" >> .env
    fi

    # Cross-machine source proxy (Durable Object registry). Enabled by default;
    # proxyId auto-generates and persists to backend/.proxy-id on first boot.
    # Auth to the DO uses SUPERATOM_API_KEY (written above). See
    # docs/cross-machine-source-proxy.md.
    echo "" >> .env
    echo "# Cross-machine source proxy" >> .env
    echo "SA_PROXY_ENABLED=true" >> .env
    if [ -n "$SA_WEBSOCKET_URL" ]; then
        echo "SA_WEBSOCKET_URL=${SA_WEBSOCKET_URL}" >> .env
    fi

    # Load developer-provided secrets (gitignored .env.local) so the
    # ${SA_INTERNAL_SERVICE_TOKEN} / ${RESEND_API_KEY} expansions below resolve.
    if [ -f .env.local ]; then set -a; . ./.env.local; set +a; fi

    # Analytics & R2 file download (required for all projects)
    echo "" >> .env
    echo "# Analytics & R2 file download" >> .env
    echo "SA_ANALYTICS_ENABLED=true" >> .env
    echo "SA_INTERNAL_SERVICE_TOKEN=${SA_INTERNAL_SERVICE_TOKEN:-<your-internal-service-token>}" >> .env

    # Resend email service (required for sending reports/alerts)
    echo "" >> .env
    echo "# Resend email service" >> .env
    echo "RESEND_API_KEY=${RESEND_API_KEY:-<your-resend-api-key>}" >> .env
    echo "ALERT_FROM_EMAIL=alerts@superatom.ai" >> .env

    # Source config field-level encryption (e.g. a NetSuite integration's
    # private key) — see database/postgres/src/project-data-db/secret-crypto.ts.
    # Auto-generated fresh per project; only required if a source type with a
    # secret config field (currently NetSuite) is configured.
    echo "" >> .env
    echo "# Source config field-level encryption" >> .env
    echo "SOURCE_SECRET_ENCRYPTION_KEY=$(openssl rand -base64 32)" >> .env

}

# =============================================================================
# Step 4: Backend Setup
# =============================================================================

setup_backend() {
    print_header "Step 4: Backend Setup"

    cd "$SCRIPT_DIR/backend"
    print_step "Working directory: $(pwd)"

    # Install dependencies
    print_step "Installing Node.js dependencies..."
    # See database/chromadb setup for why this retry exists — pnpm 10 can
    # block build scripts (@google/genai, esbuild, protobufjs) on first
    # install even when they're in onlyBuiltDependencies.
    if ! pnpm install --silent; then
        print_warning "pnpm install blocked some build scripts — approving and retrying..."
        pnpm approve-builds @google/genai esbuild protobufjs || true
        pnpm install
    fi
    print_success "Dependencies installed"

    # Configure .env
    print_step "Configuring environment variables..."

    if [ -f ".env" ]; then
        if prompt_yes_no "Backend .env already exists. Overwrite?" "n"; then
            rm .env
        else
            print_warning "Keeping existing .env file"

            if prompt_yes_no "Build backend now?" "y"; then
                print_step "Building backend..."
                pnpm build
                print_success "Backend built successfully!"
            fi
            return
        fi
    fi

    collect_backend_config
    write_backend_env
    print_success ".env file created"

    # Ensure project_details row exists — required by project_sources FK constraint
    print_step "Ensuring project exists in project_details..."
    PGPASSWORD="" psql "$PROJECT_DATABASE_URL" -q <<EOSQL 2>/dev/null
INSERT INTO project_details (id, name, description, database_type)
VALUES ('${SUPERATOM_PROJECT_ID}', '${SUPERATOM_PROJECT_ID}', 'Superatom project', 'multi-source')
ON CONFLICT (id) DO NOTHING;
EOSQL
    print_success "Project details ensured for ${SUPERATOM_PROJECT_ID}"

    # Build backend
    if prompt_yes_no "Build backend now?" "y"; then
        print_step "Building backend..."
        pnpm build
        print_success "Backend built successfully!"
    fi
}

# =============================================================================
# Summary
# =============================================================================

# =============================================================================
# Start Services
# =============================================================================

# Install PM2 globally if not installed
install_pm2() {
    # Ensure nvm is loaded if it exists (for nvm-installed Node.js)
    if [ -d "$HOME/.nvm" ]; then
        export NVM_DIR="$HOME/.nvm"
        [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
    fi

    if command -v pm2 &> /dev/null; then
        print_success "PM2 is already installed"
        return 0
    fi

    print_step "Installing PM2 globally..."

    # With nvm, npm is installed in user space, so no sudo needed
    npm install -g pm2

    if command -v pm2 &> /dev/null; then
        print_success "PM2 installed globally: $(pm2 -v)"
        return 0
    else
        print_error "Failed to install PM2. Try running: source ~/.nvm/nvm.sh && npm install -g pm2"
        return 1
    fi
}

# Bound PM2 log growth. Separate from install_pm2 (which returns early when PM2
# already exists) so existing deployments get the config too, not just fresh ones.
configure_pm2_logrotate() {
    print_step "Configuring PM2 log rotation..."

    if ! pm2 install pm2-logrotate 2>/dev/null; then
        print_warning "pm2-logrotate not installed — logs will grow unbounded. Run 'pm2 install pm2-logrotate'"
        return 0
    fi

    # 10M x 14 compressed generations caps each app at a few hundred MB, on
    # instances whose root volume can be under 10G.
    pm2 set pm2-logrotate:max_size 10M
    pm2 set pm2-logrotate:retain 14
    pm2 set pm2-logrotate:compress true
    pm2 set pm2-logrotate:rotateInterval '0 0 * * *'
    # Rotate PM2's own module logs as well as the app's.
    pm2 set pm2-logrotate:rotateModule true

    print_success "PM2 log rotation configured (10M, 14 retained, compressed)"
}

# Check if ChromaDB server is already running
check_chromadb_running() {
    local chroma_url="${1:-http://localhost:8000}"
    # Try to hit ChromaDB heartbeat endpoint
    if curl -s --max-time 2 "${chroma_url}/api/v1/heartbeat" > /dev/null 2>&1; then
        return 0  # Running
    fi
    return 1  # Not running
}

# Start services using PM2 (Production mode)
start_services_pm2() {
    print_step "Starting services with PM2 (Production mode)..."

    # Install PM2 if needed
    install_pm2 || return 1

    # Bound log growth before starting anything that writes logs
    configure_pm2_logrotate

    # Create logs directories
    mkdir -p "$SCRIPT_DIR/database/chromadb/logs"
    mkdir -p "$SCRIPT_DIR/backend/logs"

    # Determine PM2 app names (use project prefix if available)
    local backend_app_name="${PROJECT_PREFIX:-superatom}-backend"

    # Check if ChromaDB is already running (shared server approach)
    local chroma_url="http://localhost:8000"
    if check_chromadb_running "$chroma_url"; then
        print_success "ChromaDB server is already running at ${chroma_url} (shared)"
        echo "  Collections for this project will use prefix: ${PROJECT_PREFIX:-default}_"
    else
        # Start ChromaDB server with PM2 (use generic name since it's shared)
        print_step "Starting shared ChromaDB server..."
        cd "$SCRIPT_DIR/database/chromadb"
        PM2_APP_NAME="chromadb-server" pm2 start ecosystem.config.js
        print_success "ChromaDB server started with PM2"

        # Wait for ChromaDB to be ready
        sleep 3
    fi

    # Start Backend server with PM2 (each project gets its own backend)
    print_step "Starting Backend server as '${backend_app_name}'..."
    cd "$SCRIPT_DIR/backend"
    PM2_APP_NAME="$backend_app_name" pm2 start ecosystem.config.js
    print_success "Backend server started with PM2"

    # Configure PM2 to resurrect services on reboot, so the app survives
    # instance restarts (without this, a reboot leaves the app down).
    print_step "Enabling PM2 startup on boot..."
    if pm2 startup systemd -u "$USER" --hp "$HOME" 2>/dev/null | grep -E '^sudo ' | bash; then
        print_success "PM2 boot service enabled"
    else
        print_warning "PM2 boot service not enabled — run 'pm2 startup' and follow the printed command"
    fi

    # Save PM2 process list (this becomes the state restored on boot)
    pm2 save

    # Prune orphaned packages from the pnpm cache (removes stale/old vulnerable copies)
    if command -v pnpm &> /dev/null; then
        pnpm store prune 2>/dev/null && print_success "pnpm store pruned" || true
    fi

    # Show status
    echo ""
    print_step "PM2 Status:"
    pm2 status

    echo ""
    print_success "Services started with PM2!"
    echo ""
    echo "Useful PM2 commands:"
    echo "  pm2 status          - Check service status"
    echo "  pm2 logs            - View all logs"
    echo "  pm2 logs chromadb-server    - View ChromaDB logs (shared)"
    echo "  pm2 logs ${backend_app_name} - View Backend logs"
    echo "  pm2 restart all     - Restart all services"
    echo "  pm2 stop all        - Stop all services"
    echo ""

    return 0
}

# Start services in terminal windows (Development mode)
start_services_dev() {
    print_step "Starting services in terminal windows (Development mode)..."

    # Detect the terminal emulator
    TERMINAL=""
    if command -v gnome-terminal &> /dev/null; then
        TERMINAL="gnome-terminal"
    elif command -v xterm &> /dev/null; then
        TERMINAL="xterm"
    elif command -v konsole &> /dev/null; then
        TERMINAL="konsole"
    elif command -v xfce4-terminal &> /dev/null; then
        TERMINAL="xfce4-terminal"
    elif command -v mate-terminal &> /dev/null; then
        TERMINAL="mate-terminal"
    elif command -v terminator &> /dev/null; then
        TERMINAL="terminator"
    fi

    if [ -z "$TERMINAL" ]; then
        print_warning "No supported terminal emulator found."
        print_warning "Falling back to PM2..."
        start_services_pm2
        return $?
    fi

    print_step "Using terminal: $TERMINAL"

    # Check if ChromaDB is already running (shared server approach)
    local chroma_url="http://localhost:8000"
    if check_chromadb_running "$chroma_url"; then
        print_success "ChromaDB server is already running at ${chroma_url} (shared)"
        echo "  Collections for this project will use prefix: ${PROJECT_PREFIX:-default}_"
    else
        # Start ChromaDB server in new terminal
        print_step "Starting ChromaDB server..."
        case $TERMINAL in
            gnome-terminal)
                gnome-terminal --title="ChromaDB Server (shared)" -- bash -c "cd $SCRIPT_DIR/database/chromadb && echo 'Starting ChromaDB Server...' && pnpm start:chroma; exec bash"
                ;;
            xterm)
                xterm -title "ChromaDB Server (shared)" -e "cd $SCRIPT_DIR/database/chromadb && echo 'Starting ChromaDB Server...' && pnpm start:chroma; bash" &
                ;;
            konsole)
                konsole --new-tab -e bash -c "cd $SCRIPT_DIR/database/chromadb && echo 'Starting ChromaDB Server...' && pnpm start:chroma; exec bash" &
                ;;
            xfce4-terminal)
                xfce4-terminal --title="ChromaDB Server (shared)" -e "bash -c 'cd $SCRIPT_DIR/database/chromadb && echo Starting ChromaDB Server... && pnpm start:chroma; exec bash'" &
                ;;
            mate-terminal)
                mate-terminal --title="ChromaDB Server (shared)" -e "bash -c 'cd $SCRIPT_DIR/database/chromadb && echo Starting ChromaDB Server... && pnpm start:chroma; exec bash'" &
                ;;
            terminator)
                terminator --title="ChromaDB Server (shared)" -e "bash -c 'cd $SCRIPT_DIR/database/chromadb && echo Starting ChromaDB Server... && pnpm start:chroma; exec bash'" &
                ;;
        esac
        print_success "ChromaDB server starting in new terminal"

        # Wait a moment for ChromaDB to start
        sleep 2
    fi

    # Start Backend server in new terminal
    print_step "Starting Backend server..."
    case $TERMINAL in
        gnome-terminal)
            gnome-terminal --title="Backend Server" -- bash -c "cd $SCRIPT_DIR/backend && echo 'Starting Backend Server...' && pnpm dev; exec bash"
            ;;
        xterm)
            xterm -title "Backend Server" -e "cd $SCRIPT_DIR/backend && echo 'Starting Backend Server...' && pnpm dev; bash" &
            ;;
        konsole)
            konsole --new-tab -e bash -c "cd $SCRIPT_DIR/backend && echo 'Starting Backend Server...' && pnpm dev; exec bash" &
            ;;
        xfce4-terminal)
            xfce4-terminal --title="Backend Server" -e "bash -c 'cd $SCRIPT_DIR/backend && echo Starting Backend Server... && pnpm dev; exec bash'" &
            ;;
        mate-terminal)
            mate-terminal --title="Backend Server" -e "bash -c 'cd $SCRIPT_DIR/backend && echo Starting Backend Server... && pnpm dev; exec bash'" &
            ;;
        terminator)
            terminator --title="Backend Server" -e "bash -c 'cd $SCRIPT_DIR/backend && echo Starting Backend Server... && pnpm dev; exec bash'" &
            ;;
    esac
    print_success "Backend server starting in new terminal"

    return 0
}

# Main start_services function - routes to dev or prod mode
start_services() {
    print_header "Starting Services"

    # Check for --prod or --dev flags (set by entry point)
    if [ "$FORCE_PROD" = "true" ]; then
        print_step "Production mode requested (--prod flag)"
        start_services_pm2
        return $?
    fi

    if [ "$FORCE_DEV" = "true" ]; then
        print_step "Development mode requested (--dev flag)"
        start_services_dev
        return $?
    fi

    # Auto-detect: Check if terminal is available
    # No terminal = headless server = production
    TERMINAL=""
    if command -v gnome-terminal &> /dev/null; then
        TERMINAL="gnome-terminal"
    elif command -v xterm &> /dev/null; then
        TERMINAL="xterm"
    elif command -v konsole &> /dev/null; then
        TERMINAL="konsole"
    elif command -v xfce4-terminal &> /dev/null; then
        TERMINAL="xfce4-terminal"
    elif command -v mate-terminal &> /dev/null; then
        TERMINAL="mate-terminal"
    elif command -v terminator &> /dev/null; then
        TERMINAL="terminator"
    fi

    if [ -z "$TERMINAL" ]; then
        print_step "No terminal emulator found - using PM2 (Production mode)"
        start_services_pm2
        return $?
    else
        print_step "Terminal emulator found - using terminal windows (Development mode)"
        start_services_dev
        return $?
    fi
}

print_summary() {
    print_header "Setup Complete!"

    # Get SUPERATOM_PROJECT_ID from backend .env if it exists
    SUPERATOM_PROJECT_ID=""
    if [ -f "$SCRIPT_DIR/backend/.env" ]; then
        SUPERATOM_PROJECT_ID=$(grep -E "^SUPERATOM_PROJECT_ID=" "$SCRIPT_DIR/backend/.env" | cut -d '=' -f2- | tr -d '"' | tr -d "'")
        SA_ORG_SLUG=$(grep -E "^SA_ORG_SLUG=" "$SCRIPT_DIR/backend/.env" | cut -d '=' -f2- | tr -d '"' | tr -d "'")
    fi

    echo -e "${GREEN}All components have been configured.${NC}"
    echo ""

    # Ask if user wants to start services
    if prompt_yes_no "Would you like to start the services now?" "y"; then
        start_services
        SERVICES_STARTED=$?
    else
        SERVICES_STARTED=1
    fi

    echo ""
    echo "Data Sources:"
    echo "  Configure data sources (PostgreSQL, MySQL, MSSQL, Excel, CSV,"
    echo "  REST API, GraphQL) via the UI or API."
    echo ""
    echo "  Add more data sources via the UI or API (PostgreSQL, MySQL,"
    echo "  Excel, CSV, REST API, GraphQL, etc.)"
    echo ""

    if [ "$SERVICES_STARTED" != "0" ]; then
        echo "To start the services manually:"
        echo ""
        echo "   # Start ChromaDB (in terminal 1)"
        echo "   cd database/chromadb && pnpm start:chroma"
        echo ""
        echo "   # Start Backend (in terminal 2)"
        echo "   cd backend && pnpm dev"
        echo ""
    fi

    echo -e "${BLUE}==========================================${NC}"
    echo -e "${BLUE} Access Your Application${NC}"
    echo -e "${BLUE}==========================================${NC}"
    echo ""
    echo "   Login: Use the org admin account created in the Platform UI."
    echo ""
    if [ -n "$SUPERATOM_PROJECT_ID" ]; then
        echo -e "   Project ID: ${CYAN}${SUPERATOM_PROJECT_ID}${NC}"
    fi
    echo ""
    echo -e "   ${YELLOW}IMPORTANT: Run this command to use pm2, node, pnpm:${NC}"
    echo -e "   ${CYAN}source ~/.bashrc${NC}"
    echo ""
    local org_prefix="${SA_ORG_SLUG:+${SA_ORG_SLUG}.}"
    echo -e "   Platform UI: ${GREEN}https://${org_prefix}platform.superatom.ai/${NC}"
    local user_host="${SA_ORG_SLUG:-live}"
    echo -e "   User UI:     ${GREEN}https://${user_host}.superatom.ai/${NC}"
    echo ""
    print_success "Happy coding!"
}

# =============================================================================
# Docker Setup (new clients): one isolated stack per project, see docker-compose.yml
# =============================================================================

DOCKER="docker"

# Installs Docker Engine + compose plugin from Docker's apt repo (Ubuntu/Debian).
install_docker() {
    local distro=""
    [ -f /etc/os-release ] && distro=$(. /etc/os-release && echo "$ID")
    if [[ "$distro" != "ubuntu" && "$distro" != "debian" ]]; then
        print_error "Automatic Docker install supports Ubuntu/Debian only."
        echo "  Install Docker Engine + the compose plugin: https://docs.docker.com/engine/install/"
        return 1
    fi

    print_step "Installing Docker Engine from Docker's official repository..."
    apt_update
    wait_for_apt_lock
    sudo apt-get install -y ca-certificates curl
    sudo install -m 0755 -d /etc/apt/keyrings
    sudo curl -fsSL "https://download.docker.com/linux/${distro}/gpg" -o /etc/apt/keyrings/docker.asc
    sudo chmod a+r /etc/apt/keyrings/docker.asc
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/${distro} $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}") stable" \
        | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
    apt_update
    sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
    sudo systemctl enable --now docker
    # Lets future logins run docker without sudo; this run falls back to sudo below.
    sudo usermod -aG docker "$USER"
    print_success "Docker installed ($(sudo docker --version))"
}

# macOS / Windows shells: Docker Desktop is required (macOS) or unsupported (Windows Server).
docker_os() {
    case "$OSTYPE" in
        darwin*) echo "macos" ;;
        msys*|cygwin*|win32*) echo "windows" ;;
        *) echo "linux" ;;   # includes WSL, which is a real Linux
    esac
}

# Ensures docker + compose work; sets $DOCKER (plain, or "sudo docker" until the group applies).
check_docker() {
    print_header "Checking Docker"
    local os
    os=$(docker_os)

    if [ "$os" = "windows" ]; then
        print_error "--docker can't run from a Windows shell: Windows Server Docker runs Windows containers only."
        echo "  Use WSL2 (Windows Server 2022+): install an Ubuntu distribution, clone this repo inside it,"
        echo "  and run ./setup.sh --docker there. Or use a Linux VM for this client."
        return 1
    fi

    if ! command -v docker &> /dev/null; then
        print_warning "Docker is not installed."
        if [ "$os" = "macos" ]; then
            print_error "Install Docker Desktop and start it, then re-run:"
            echo "  https://docs.docker.com/desktop/setup/install/mac-install/"
            return 1
        fi
        if prompt_yes_no "Install Docker now?" "y"; then
            install_docker || return 1
        else
            print_error "Docker is required for --docker. Install it and re-run."
            return 1
        fi
    fi

    if docker info > /dev/null 2>&1; then
        DOCKER="docker"
    elif [ "$os" = "macos" ]; then
        print_error "Cannot reach Docker. Start Docker Desktop (and wait until it says it's running), then re-run."
        return 1
    elif sudo docker info > /dev/null 2>&1; then
        # Typical right after install: docker group membership needs a new login.
        DOCKER="sudo docker"
        print_warning "Using sudo for docker in this run (log out and back in to use docker without sudo)."
    else
        print_error "Cannot reach the Docker daemon. Is it running? (sudo systemctl start docker)"
        return 1
    fi

    if ! $DOCKER compose version > /dev/null 2>&1; then
        if [ "$os" = "macos" ]; then
            print_error "Docker compose is missing — update Docker Desktop, then re-run."
        else
            print_error "The Docker compose plugin is missing (sudo apt-get install docker-compose-plugin)."
        fi
        return 1
    fi

    print_success "$($DOCKER --version)"
    print_success "$($DOCKER compose version)"
}

# Loads answers pre-filled by the installer (install.sh) from a KEY=value file.
# Only known keys are read; values are assigned, never evaluated.
load_config_file() {
    local file="$1" line key val var
    [ -f "$file" ] || { print_error "Config file not found: $file"; return 1; }
    while IFS= read -r line || [ -n "$line" ]; do
        case "$line" in ''|'#'*) continue ;; *=*) ;; *) continue ;; esac
        key="${line%%=*}"
        val="${line#*=}"
        case "$key" in
            PROJECT_NAME|SUPERATOM_API_KEY|SUPERATOM_PROJECT_ID|SA_ORG_ID|SA_ORG_SLUG|SA_WEBSOCKET_URL|SA_INTERNAL_SERVICE_TOKEN|RESEND_API_KEY) var="$key" ;;
            SA_API_URL) var="SA_API_BASE_URL" ;;
            OPENROUTER_API_KEY) var="OPENROUTER_KEY" ;;
            *) continue ;;
        esac
        printf -v "$var" '%s' "$val"
    done < "$file"
    PREFILLED="true"
    print_success "Loaded pre-filled configuration from $(basename "$file")"
}

# Value of KEY in an env file (empty if absent). Always succeeds: callers assign it under set -e.
read_env_value() {
    local file="$1" key="$2"
    [ -f "$file" ] || return 0
    grep -E "^${key}=" "$file" | tail -1 | cut -d '=' -f2- | tr -d '"' | tr -d "'" || true
}

# Fails if another folder already runs a stack with this name (it would share its containers/volumes).
check_stack_name_free() {
    local name="$1" config_files
    config_files=$($DOCKER compose ls -a --format json 2>/dev/null | grep -oE '\{[^}]*\}' \
        | grep -F "\"Name\":\"${name}\"" | grep -oE '"ConfigFiles":"[^"]*"' | cut -d '"' -f4)
    if [ -n "$config_files" ] && [[ "$config_files" != *"$SCRIPT_DIR/docker-compose.yml"* ]]; then
        print_error "A Docker stack named '${name}' already runs from: ${config_files}"
        echo "  Choose a different project name (e.g. ${name}-prod / ${name}-dev)."
        return 1
    fi
}

# Writes the root .env compose reads. Keeps an existing POSTGRES_PASSWORD:
# the database volume was initialised with it, so changing it locks the backend out.
write_compose_env() {
    local root_env="$SCRIPT_DIR/.env" password
    password=$(read_env_value "$root_env" POSTGRES_PASSWORD)
    if [ -z "$password" ] && $DOCKER volume inspect "${COMPOSE_PROJECT_NAME}_pgdata" > /dev/null 2>&1; then
        print_error "Volume ${COMPOSE_PROJECT_NAME}_pgdata exists but .env has no POSTGRES_PASSWORD."
        echo "  Restore the original .env, or remove the old data: docker volume rm ${COMPOSE_PROJECT_NAME}_pgdata"
        return 1
    fi
    password="${password:-$(openssl rand -hex 24)}"

    cat > "$root_env" << EOF
# docker compose settings for this project's stack (see docker-compose.yml)
COMPOSE_PROJECT_NAME=${COMPOSE_PROJECT_NAME}
POSTGRES_PASSWORD=${password}
EOF
    chmod 600 "$root_env"
    print_success "Compose settings written to .env (stack: ${COMPOSE_PROJECT_NAME})"
}

# Follows the backend's logs since its current start until the SDK reports success/failure.
# Reading from the container's own start (not ours) also covers an unchanged, still-running backend.
wait_for_backend() {
    local timeout=180 elapsed=0 container started logs
    print_step "Waiting for the backend to connect (up to ${timeout}s)..."
    while [ $elapsed -lt $timeout ]; do
        container=$($DOCKER compose ps -q backend 2>/dev/null)
        started=$([ -n "$container" ] && $DOCKER inspect -f '{{.State.StartedAt}}' "$container" 2>/dev/null || true)
        if [ -n "$started" ]; then
            logs=$($DOCKER compose logs --no-color --since "$started" backend 2>&1)
            if echo "$logs" | grep -q "SuperAtom SDK initialized successfully"; then
                print_success "Backend is up and connected"
                return 0
            fi
            if echo "$logs" | grep -q "Failed to initialize SuperAtom SDK"; then
                print_error "Backend failed to start. Last log lines:"
                echo "$logs" | tail -25
                return 1
            fi
        fi
        sleep 5
        elapsed=$((elapsed + 5))
    done
    print_warning "No result after ${timeout}s. Check: docker compose logs -f backend"
    return 1
}

setup_docker() {
    DOCKER_MODE="true"
    check_docker || exit 1
    cd "$SCRIPT_DIR"

    local root_env="$SCRIPT_DIR/.env" backend_env="$SCRIPT_DIR/backend/.env"
    COMPOSE_PROJECT_NAME=$(read_env_value "$root_env" COMPOSE_PROJECT_NAME)

    if [ -n "$CONFIG_FILE" ]; then
        if [ -f "$backend_env" ]; then
            print_warning "backend/.env already exists; ignoring --config $(basename "$CONFIG_FILE")"
        else
            load_config_file "$CONFIG_FILE" || exit 1
        fi
    fi

    if [ -n "$COMPOSE_PROJECT_NAME" ] && [ -f "$backend_env" ] \
        && prompt_yes_no "Existing setup found (stack '${COMPOSE_PROJECT_NAME}'). Keep it and just rebuild/restart?" "y"; then
        print_success "Keeping existing configuration"
    else
        prompt_project_config
        COMPOSE_PROJECT_NAME="$PROJECT_PREFIX"
        check_stack_name_free "$COMPOSE_PROJECT_NAME" || exit 1

        print_header "Backend Configuration"
        local write_backend="true"
        if [ -f "$backend_env" ]; then
            if prompt_yes_no "Backend .env already exists. Overwrite?" "n"; then
                rm "$backend_env"
            else
                print_warning "Keeping existing backend/.env"
                write_backend="false"
            fi
        fi
        if [ "$write_backend" = "true" ]; then
            collect_backend_config
            (cd "$SCRIPT_DIR/backend" && write_backend_env)
            chmod 600 "$backend_env"
            print_success "backend/.env created"
            # Its secrets now live in backend/.env; don't leave a second copy behind.
            if [ "$PREFILLED" = "true" ]; then rm -f "$CONFIG_FILE"; fi
        fi

        write_compose_env || exit 1
    fi

    print_header "Building and Starting '${COMPOSE_PROJECT_NAME}'"
    $DOCKER compose up -d --build
    echo ""
    $DOCKER compose ps
    echo ""
    wait_for_backend || true
    print_docker_summary
}

print_docker_summary() {
    local slug marker="$SCRIPT_DIR/.superatom-install" platform_ui user_ui install_url
    slug=$(read_env_value "$SCRIPT_DIR/backend/.env" SA_ORG_SLUG)
    # Installer-based setups record the right links and update source for their environment (dev/prod).
    platform_ui=$(read_env_value "$marker" PLATFORM_UI_URL)
    user_ui=$(read_env_value "$marker" USER_UI_URL)
    install_url=$(read_env_value "$marker" INSTALL_URL)
    local org_prefix="${slug:+${slug}.}"
    platform_ui="${platform_ui:-https://${org_prefix}platform.superatom.ai}"
    user_ui="${user_ui:-https://${slug:-live}.superatom.ai}"

    print_header "Docker Setup Complete"
    echo -e "   Stack:       ${CYAN}${COMPOSE_PROJECT_NAME}${NC}   (folder: ${SCRIPT_DIR})"
    echo -e "   Platform UI: ${GREEN}${platform_ui}/${NC}"
    echo -e "   User UI:     ${GREEN}${user_ui}/${NC}"
    echo ""
    echo "Run these in ${SCRIPT_DIR}:"
    echo "  $DOCKER compose ps                   - status"
    echo "  $DOCKER compose logs -f backend      - backend logs"
    echo "  $DOCKER compose restart backend      - restart the backend"
    if [ -f "$marker" ]; then
        echo "  curl -fsSL ${install_url:-https://install.superatom.ai} | sh   - update (keeps config and data)"
    else
        echo "  git pull && ./setup.sh --docker      - update (keeps config and data)"
    fi
    echo "  $DOCKER compose down                 - stop (data is kept)"
    echo ""
    echo "Data sources on this VM itself: use host.docker.internal instead of localhost."
    echo ""
}

# =============================================================================
# Main Menu
# =============================================================================

show_menu() {
    echo ""
    echo -e "${BLUE}==========================================${NC}"
    echo -e "${BLUE} Superatom Project Setup${NC}"
    echo -e "${BLUE}==========================================${NC}"
    echo ""
    echo "Select an option:"
    echo ""
    echo "  1) Run complete setup (all steps)"
    echo "  2) PostgreSQL only"
    echo "  3) ChromaDB only"
    echo "  4) Frontend only"
    echo "  5) Backend only"
    echo "  6) Check prerequisites"
    echo "  7) Docker setup (new clients: one isolated stack per project)"
    echo "  0) Exit"
    echo ""
    read -p "$(echo -e ${CYAN}"Enter choice [1]: "${NC})" choice
    choice="${choice:-1}"

    case $choice in
        1)
            check_prerequisites
            prompt_project_config
            setup_postgres
            setup_chromadb
            setup_frontend
            setup_backend
            print_summary
            ;;
        2)
            check_prerequisites
            prompt_project_config
            setup_postgres
            ;;
        3)
            check_prerequisites
            prompt_project_config
            setup_chromadb
            ;;
        4)
            check_prerequisites
            setup_frontend
            ;;
        5)
            check_prerequisites
            prompt_project_config
            setup_backend
            ;;
        6)
            check_prerequisites
            ;;
        7)
            setup_docker
            ;;
        0)
            echo "Goodbye!"
            exit 0
            ;;
        *)
            print_error "Invalid option"
            show_menu
            ;;
    esac
}

# =============================================================================
# Entry Point
# =============================================================================

# Parse all arguments to detect flags and options
FORCE_PROD="false"
FORCE_DEV="false"
HAS_START="false"
HAS_MENU="false"
HAS_POSTGRES="false"
HAS_CHROMADB="false"
HAS_FRONTEND="false"
HAS_BACKEND="false"
HAS_HELP="false"
HAS_DOCKER="false"
CONFIG_FILE=""
PREFILLED="false"
EXPECT_CONFIG="false"

for arg in "$@"; do
    if [ "$EXPECT_CONFIG" = "true" ]; then
        CONFIG_FILE="$arg"
        EXPECT_CONFIG="false"
        continue
    fi
    case $arg in
        --config)
            EXPECT_CONFIG="true"
            ;;
        --config=*)
            CONFIG_FILE="${arg#--config=}"
            ;;
        --prod)
            FORCE_PROD="true"
            ;;
        --dev)
            FORCE_DEV="true"
            ;;
        --start|-s)
            HAS_START="true"
            ;;
        --menu|-m)
            HAS_MENU="true"
            ;;
        --postgres)
            HAS_POSTGRES="true"
            ;;
        --chromadb)
            HAS_CHROMADB="true"
            ;;
        --frontend)
            HAS_FRONTEND="true"
            ;;
        --backend)
            HAS_BACKEND="true"
            ;;
        --help|-h)
            HAS_HELP="true"
            ;;
        --docker)
            HAS_DOCKER="true"
            ;;
    esac
done

if [ -n "$CONFIG_FILE" ]; then
    CONFIG_FILE="$(cd "$(dirname "$CONFIG_FILE")" 2>/dev/null && pwd)/$(basename "$CONFIG_FILE")"
fi

# If --prod or --dev is passed without --start, assume --start
if [ "$FORCE_PROD" = "true" ] || [ "$FORCE_DEV" = "true" ]; then
    if [ "$HAS_POSTGRES" = "false" ] && [ "$HAS_CHROMADB" = "false" ] && [ "$HAS_FRONTEND" = "false" ] && [ "$HAS_BACKEND" = "false" ] && [ "$HAS_MENU" = "false" ] && [ "$HAS_HELP" = "false" ]; then
        HAS_START="true"
    fi
fi

# Route based on parsed options
if [ "$HAS_HELP" = "true" ]; then
    echo "Usage: ./setup.sh [option] [flags]"
    echo ""
    echo "Options:"
    echo "  (no option)     Run complete setup (all steps)"
    echo "  --menu, -m      Show interactive menu"
    echo "  --start, -s     Start services (ChromaDB + Backend)"
    echo "  --postgres      PostgreSQL setup only"
    echo "  --chromadb      ChromaDB setup only"
    echo "  --frontend      Frontend setup only"
    echo "  --backend       Backend setup only"
    echo "  --docker        Docker setup for new clients (isolated stack per project;"
    echo "                  re-run after git pull to rebuild/update)"
    echo "  --config FILE   With --docker: pre-filled answers (written by install.sh)"
    echo "  --help, -h      Show this help message"
    echo ""
    echo "Flags (for starting services):"
    echo "  --prod          Force production mode (use PM2)"
    echo "  --dev           Force development mode (use terminal windows)"
    echo ""
    echo "Examples:"
    echo "  ./setup.sh --start --prod    Start services with PM2 (production)"
    echo "  ./setup.sh --prod            Start services with PM2 (shorthand)"
    echo "  ./setup.sh --start --dev     Start services in terminal windows (development)"
    echo "  ./setup.sh --dev             Start services in terminal windows (shorthand)"
    echo "  ./setup.sh --start           Auto-detect mode based on environment"
    echo ""
    echo "Data sources:"
    echo "  Configure data sources (PostgreSQL, MySQL, MSSQL, Excel, CSV,"
    echo "  REST API, GraphQL) via the UI or API after setup."
    echo ""
elif [ "$HAS_DOCKER" = "true" ]; then
    setup_docker
elif [ "$HAS_MENU" = "true" ]; then
    show_menu
elif [ "$HAS_POSTGRES" = "true" ]; then
    check_prerequisites
    prompt_project_config
    setup_postgres
elif [ "$HAS_CHROMADB" = "true" ]; then
    check_prerequisites
    prompt_project_config
    setup_chromadb
elif [ "$HAS_FRONTEND" = "true" ]; then
    check_prerequisites
    setup_frontend
elif [ "$HAS_BACKEND" = "true" ]; then
    check_prerequisites
    prompt_project_config
    setup_backend
elif [ "$HAS_START" = "true" ]; then
    start_services
    echo ""
    echo -e "${BLUE}==========================================${NC}"
    echo -e "${BLUE} Services Started${NC}"
    echo -e "${BLUE}==========================================${NC}"
    echo ""
    echo "   Login to the Platform UI with your org admin account."
    echo ""
elif [ $# -eq 0 ]; then
    # Default: Run complete setup (no arguments)
    check_prerequisites
    prompt_project_config
    setup_postgres
    setup_chromadb
    setup_frontend
    setup_backend
    print_summary
else
    # Unknown option
    print_error "Unknown option: $1"
    echo "Run './setup.sh --help' for usage information."
    exit 1
fi

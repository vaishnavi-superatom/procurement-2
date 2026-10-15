#!/bin/sh
# Superatom one-line installer:   curl -fsSL https://install.superatom.ai | sh
#
# New install: asks for an install token (super-admin console → project → "Generate
# install token"), prepares the install folder, and only then redeems the token, downloads
# the code and runs ./setup.sh --docker with the returned config pre-filled.
# Re-run: pick an install to update it (the project's API key authenticates the download)
# or to resume one whose setup didn't finish (no new token needed).
#
# POSIX sh on purpose (piped into dash on Ubuntu). Server responses are KEY=value
# lines, so nothing beyond curl + tar is needed on a fresh VM.
#
# Overrides (testing): SA_INSTALL_URL (default https://install.superatom.ai),
#                      SA_INSTALL_ROOT (default /opt/superatom)
set -eu

BASE_URL="${SA_INSTALL_URL:-https://install.superatom.ai}"
INSTALL_ROOT="${SA_INSTALL_ROOT:-/opt/superatom}"
REGISTRY="${HOME}/.superatom-installs"   # install folders outside INSTALL_ROOT, one per line
MARKER=".superatom-install"      # per install: project id, installed commit
MANIFEST=".superatom-files"      # per install: files that came from the tarball
PREFILL=".install.env"           # redeemed config; setup.sh deletes it once backend/.env is written

if [ -t 1 ]; then
    RED=$(printf '\033[0;31m'); GREEN=$(printf '\033[0;32m'); YELLOW=$(printf '\033[1;33m')
    CYAN=$(printf '\033[0;36m'); BLUE=$(printf '\033[0;34m'); NC=$(printf '\033[0m')
else
    RED=""; GREEN=""; YELLOW=""; CYAN=""; BLUE=""; NC=""
fi
step() { printf '%s➤ %s%s\n' "$CYAN" "$1" "$NC"; }
ok()   { printf '%s✓ %s%s\n' "$GREEN" "$1" "$NC"; }
warn() { printf '%s⚠ %s%s\n' "$YELLOW" "$1" "$NC"; }
die()  { printf '%s✗ %s%s\n' "$RED" "$1" "$NC" >&2; exit 1; }

TMP_DIR=""
cleanup() { [ -n "$TMP_DIR" ] && rm -rf "$TMP_DIR"; }
trap cleanup EXIT INT TERM

# Reads a line from the terminal (stdin is this script when piped into sh).
ask() {
    printf '%s%s%s' "$CYAN" "$1" "$NC" > /dev/tty
    IFS= read -r REPLY < /dev/tty || REPLY=""
}

ask_secret() {
    printf '%s%s%s' "$CYAN" "$1" "$NC" > /dev/tty
    stty -echo < /dev/tty 2>/dev/null || true
    IFS= read -r REPLY < /dev/tty || REPLY=""
    stty echo < /dev/tty 2>/dev/null || true
    printf '\n' > /dev/tty
}

check_system() {
    case "$(uname -s)" in
        Linux) ;;
        Darwin) warn "macOS: needs Docker Desktop running. Linux is the supported target for clients." ;;
        MINGW*|MSYS*|CYGWIN*)
            die "Windows shells are not supported. Use WSL2 (Ubuntu) on Windows Server 2022+, or a Linux VM." ;;
        *) die "Unsupported OS: $(uname -s)" ;;
    esac
    for cmd in curl tar bash; do
        command -v "$cmd" > /dev/null 2>&1 || die "'$cmd' is required. Install it and re-run."
    done
    [ -r /dev/tty ] || die "Run this from an interactive terminal (it asks for an install token)."
}

# POSTs a JSON body; server replies with KEY=value lines (or an error message).
# Usage: api_post <path> <json> <outfile> [bearer]
api_post() {
    if [ -n "${4:-}" ]; then
        status=$(curl -sS -o "$3" -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
            -H "Authorization: Bearer $4" --data "$2" "$BASE_URL$1") || die "Cannot reach $BASE_URL"
    else
        status=$(curl -sS -o "$3" -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
            --data "$2" "$BASE_URL$1") || die "Cannot reach $BASE_URL"
    fi
    if [ "$status" != "200" ]; then
        die "Server refused ($status): $(head -c 300 "$3" | tr -d '\r' | head -n 1)"
    fi
}

# Loads allowlisted KEY=value lines from a server response into R_<KEY> variables.
parse_response() {
    while IFS= read -r line || [ -n "$line" ]; do
        case "$line" in ''|'#'*) continue ;; *=*) ;; *) continue ;; esac
        key=${line%%=*}
        val=${line#*=}
        case "$key" in
            INSTALL_NAME|CODE_URL|CODE_COMMIT|SUPERATOM_API_KEY|SUPERATOM_PROJECT_ID|\
SA_API_URL|SA_ORG_ID|SA_ORG_SLUG|SA_WEBSOCKET_URL|OPENROUTER_API_KEY|SA_INTERNAL_SERVICE_TOKEN|RESEND_API_KEY|\
PLATFORM_UI_URL|USER_UI_URL) ;;
            *) continue ;;
        esac
        # Values land in env files and shell variables: refuse anything that could be interpreted.
        case "$val" in *[\"\'\`\$\\\ ]*) die "Unexpected characters in server value for $key" ;; esac
        eval "R_$key=\$val"
    done < "$1"
}

valid_name() {
    case "$1" in ''|-*|*[!a-z0-9_-]*) return 1 ;; esac
}

value_in() {
    grep -E "^$2=" "$1" 2>/dev/null | tail -n 1 | cut -d '=' -f 2- || true
}

# Creates an empty, writable install folder (with sudo if needed, then owned by the user).
# Runs BEFORE the token is redeemed, so a bad folder never costs the one-time token.
prepare_dir() {
    dir=$1
    if [ -e "$dir" ] && [ ! -d "$dir" ]; then die "$dir exists and is not a folder."; fi
    if [ -d "$dir" ] && [ -n "$(ls -A "$dir" 2>/dev/null)" ]; then
        die "$dir already exists and is not empty. Choose another folder."
    fi
    if mkdir -p "$dir" 2>/dev/null && [ -w "$dir" ]; then return 0; fi

    # Under the default root, own the root itself so later installs don't need sudo.
    case "$dir" in "$INSTALL_ROOT"/*) owned=$INSTALL_ROOT ;; *) owned=$dir ;; esac
    command -v sudo > /dev/null 2>&1 || die "Cannot create $dir (no permission, and sudo is not available)."
    ask "Creating $owned needs sudo. Continue? [Y/n]: "
    case "$REPLY" in [Nn]*) die "Choose a folder you can write to (e.g. \$HOME/<name>)." ;; esac
    sudo mkdir -p "$owned" && sudo chown "$(id -u):$(id -g)" "$owned" || die "Could not create $owned with sudo."
    mkdir -p "$dir" 2>/dev/null && [ -w "$dir" ] || die "$dir is still not writable."
}

remember_install() {
    case "$1" in "$INSTALL_ROOT"/*) return 0 ;; esac   # found by scanning the root anyway
    touch "$REGISTRY" 2>/dev/null || return 0
    grep -qxF "$1" "$REGISTRY" 2>/dev/null || printf '%s\n' "$1" >> "$REGISTRY"
}

# Downloads the code tarball into $TMP_DIR/code (top directory stripped).
download_code() {
    step "Downloading code (commit ${2:-unknown})..."
    rm -rf "$TMP_DIR/code" && mkdir -p "$TMP_DIR/code"
    curl -fsSL -o "$TMP_DIR/code.tar.gz" "$1" || die "Code download failed. Re-run the installer to retry (no new token needed)."
    tar -xzf "$TMP_DIR/code.tar.gz" -C "$TMP_DIR/code" --strip-components=1 || die "The code archive is corrupt. Re-run to retry."
    [ -f "$TMP_DIR/code/setup.sh" ] && [ -f "$TMP_DIR/code/docker-compose.yml" ] \
        || die "The downloaded code has no Docker setup (setup.sh / docker-compose.yml)."
    (cd "$TMP_DIR/code" && find . -type f | sed 's|^\./||' | LC_ALL=C sort) > "$TMP_DIR/files.new"
}

# Copies the downloaded code into $1; removes files a previous version had but this one dropped.
# Config (.env files) and Docker volumes are never in the archive, so they are untouched.
place_code() {
    if [ -f "$1/$MANIFEST" ]; then
        LC_ALL=C sort "$1/$MANIFEST" > "$TMP_DIR/files.old"
        LC_ALL=C comm -23 "$TMP_DIR/files.old" "$TMP_DIR/files.new" | while IFS= read -r gone; do
            case "$gone" in ''|/*|*..*) continue ;; esac
            rm -f "$1/$gone"
        done
    fi
    cp -a "$TMP_DIR/code/." "$1/"
    cp "$TMP_DIR/files.new" "$1/$MANIFEST"
}

# The marker also tells setup.sh's summary where updates come from and the client UI links;
# the links are only known at redeem, so later rewrites (updates) keep the recorded ones.
write_marker() {
    platform=${R_PLATFORM_UI_URL:-$(value_in "$1/$MARKER" PLATFORM_UI_URL)}
    user_ui=${R_USER_UI_URL:-$(value_in "$1/$MARKER" USER_UI_URL)}
    {
        printf 'PROJECT_ID=%s\n' "$2"
        printf 'CODE_COMMIT=%s\n' "$3"
        printf 'INSTALL_URL=%s\n' "$BASE_URL"
        [ -n "$platform" ] && printf 'PLATFORM_UI_URL=%s\n' "$platform"
        [ -n "$user_ui" ] && printf 'USER_UI_URL=%s\n' "$user_ui"
        printf 'UPDATED_AT=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    } > "$1/$MARKER.tmp"
    mv "$1/$MARKER.tmp" "$1/$MARKER"
}

run_setup() {
    cd "$1"
    step "Running ./setup.sh --docker in $1"
    echo ""
    if [ -f "$PREFILL" ]; then
        exec bash ./setup.sh --docker --config "$PREFILL" < /dev/tty
    fi
    exec bash ./setup.sh --docker < /dev/tty
}

# Latest code for a project, authenticated by its API key: fills R_CODE_URL / R_CODE_COMMIT.
fetch_update() {
    case "$2" in ''|*[!A-Za-z0-9-]*) die "Unexpected project id: $2" ;; esac
    api_post "/api/update" "{\"projectId\":\"$2\"}" "$TMP_DIR/update.txt" "$1"
    R_CODE_URL=""; R_CODE_COMMIT=""
    parse_response "$TMP_DIR/update.txt"
    [ -n "$R_CODE_URL" ] || die "Incomplete response from the server."
}

new_install() {
    ask_secret "Install token: "
    token=$(printf '%s' "$REPLY" | tr -d '[:space:]')
    case "$token" in ''|*[!A-Za-z0-9_-]*) die "That doesn't look like an install token." ;; esac

    # 1. Check the token without using it.
    step "Checking install token..."
    api_post "/api/token-info" "{\"token\":\"$token\"}" "$TMP_DIR/info.txt"
    R_INSTALL_NAME=""
    parse_response "$TMP_DIR/info.txt"
    valid_name "$R_INSTALL_NAME" || die "Server returned an invalid install name."
    ok "Token is valid for $R_INSTALL_NAME"

    # 2. Prepare the folder while the token is still unused.
    ask "Install folder [$INSTALL_ROOT/$R_INSTALL_NAME]: "
    dir=${REPLY:-$INSTALL_ROOT/$R_INSTALL_NAME}
    case "$dir" in "~"/*) dir="$HOME/${dir#\~/}" ;; /*) ;; *) dir="$(pwd)/$dir" ;; esac
    prepare_dir "$dir"
    ok "Folder ready: $dir"

    # 3. Redeem, and save the config immediately so nothing after this can lose it.
    step "Redeeming install token..."
    api_post "/api/redeem" "{\"token\":\"$token\"}" "$TMP_DIR/redeem.txt"
    R_CODE_URL=""; R_CODE_COMMIT=""; R_SUPERATOM_PROJECT_ID=""; R_PLATFORM_UI_URL=""; R_USER_UI_URL=""
    parse_response "$TMP_DIR/redeem.txt"
    valid_name "$R_INSTALL_NAME" || die "Server returned an invalid install name."
    [ -n "$R_CODE_URL" ] && [ -n "$R_SUPERATOM_PROJECT_ID" ] || die "Incomplete response from the server."
    umask 077
    {
        printf '# From install token redemption; deleted by setup.sh once backend/.env is written.\n'
        printf 'PROJECT_NAME=%s\n' "$R_INSTALL_NAME"
        for key in SUPERATOM_API_KEY SUPERATOM_PROJECT_ID SA_API_URL SA_ORG_ID SA_ORG_SLUG SA_WEBSOCKET_URL \
                   OPENROUTER_API_KEY SA_INTERNAL_SERVICE_TOKEN RESEND_API_KEY; do
            eval "val=\${R_$key:-}"
            [ -n "$val" ] && printf '%s=%s\n' "$key" "$val"
        done
    } > "$dir/$PREFILL"
    umask 022
    write_marker "$dir" "$R_SUPERATOM_PROJECT_ID" ""
    remember_install "$dir"
    ok "Project $R_INSTALL_NAME · code ${R_CODE_COMMIT:-?} (config saved; re-run resumes if anything below fails)"

    # 4. Code, then setup.
    download_code "$R_CODE_URL" "$R_CODE_COMMIT"
    place_code "$dir"
    write_marker "$dir" "$R_SUPERATOM_PROJECT_ID" "$R_CODE_COMMIT"
    ok "Code installed in $dir"
    run_setup "$dir"
}

# Redeemed earlier but setup never finished: fetch the code if it's missing, then run setup.
resume_install() {
    dir=$1
    if [ ! -f "$dir/setup.sh" ]; then
        api_key=$(value_in "$dir/$PREFILL" SUPERATOM_API_KEY)
        project_id=$(value_in "$dir/$PREFILL" SUPERATOM_PROJECT_ID)
        [ -n "$api_key" ] && [ -n "$project_id" ] || die "No saved config in $dir/$PREFILL; cannot resume."
        step "Fetching the code for the unfinished install..."
        fetch_update "$api_key" "$project_id"
        download_code "$R_CODE_URL" "$R_CODE_COMMIT"
        place_code "$dir"
        write_marker "$dir" "$project_id" "$R_CODE_COMMIT"
    fi
    run_setup "$dir"
}

update_install() {
    dir=$1
    env_file="$dir/backend/.env"
    api_key=$(value_in "$env_file" SUPERATOM_API_KEY)
    project_id=$(value_in "$env_file" SUPERATOM_PROJECT_ID)
    [ -n "$api_key" ] && [ -n "$project_id" ] || die "No API key / project id in $env_file; cannot update."

    step "Checking for updates..."
    fetch_update "$api_key" "$project_id"

    current=$(value_in "$dir/$MARKER" CODE_COMMIT)
    if [ -n "$R_CODE_COMMIT" ] && [ "$R_CODE_COMMIT" = "$current" ]; then
        ok "Already on the latest code ($current)."
        ask "Rebuild and restart anyway? [y/N]: "
        case "$REPLY" in [Yy]*) run_setup "$dir" ;; *) exit 0 ;; esac
    fi

    download_code "$R_CODE_URL" "$R_CODE_COMMIT"
    place_code "$dir"
    write_marker "$dir" "$project_id" "$R_CODE_COMMIT"
    ok "Updated ${current:-?} → ${R_CODE_COMMIT:-?}"
    run_setup "$dir"
}

# Installs under the root plus remembered folders elsewhere; one path per line.
list_installs() {
    {
        if [ -d "$INSTALL_ROOT" ]; then
            for d in "$INSTALL_ROOT"/*/; do [ -f "$d$MARKER" ] && printf '%s\n' "${d%/}"; done
        fi
        if [ -f "$REGISTRY" ]; then
            while IFS= read -r d; do [ -f "$d/$MARKER" ] && printf '%s\n' "$d"; done < "$REGISTRY"
        fi
    } | LC_ALL=C sort -u
}

unfinished() {
    [ -f "$1/$PREFILL" ] && [ ! -f "$1/backend/.env" ]
}

main() {
    printf '\n%sSuperatom installer%s\n\n' "$BLUE" "$NC"
    check_system
    TMP_DIR=$(mktemp -d)

    list_installs > "$TMP_DIR/installs.txt"
    if [ ! -s "$TMP_DIR/installs.txt" ]; then
        new_install
        return
    fi

    echo "Existing installs:"
    i=0
    while IFS= read -r d; do
        i=$((i + 1))
        if unfinished "$d"; then state="setup not finished — pick to resume"; else state="commit $(value_in "$d/$MARKER" CODE_COMMIT)"; fi
        printf '  %s) %s  (%s)\n' "$i" "$d" "$state"
    done < "$TMP_DIR/installs.txt"
    echo "  n) New install"
    ask "Choose [n]: "
    choice=${REPLY:-n}
    case "$choice" in
        n|N) new_install ;;
        *[!0-9]*) die "Invalid choice." ;;
        *)
            d=$(sed -n "${choice}p" "$TMP_DIR/installs.txt")
            [ -n "$d" ] || die "Invalid choice."
            if unfinished "$d"; then resume_install "$d"; fi
            update_install "$d"
            ;;
    esac
}

main "$@"

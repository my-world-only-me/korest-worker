#!/usr/bin/env bash
#
# KoRest — One-click deploy to Cloudflare Workers + D1
#
# Usage:
#   chmod +x deploy.sh && ./deploy.sh
#
# This script will:
#   1. Check prerequisites (node, npm, wrangler, logged in)
#   2. Prompt for Worker name (default: korest)
#   3. Create a D1 database
#   4. Auto-update wrangler.toml with the database ID
#   5. Install npm dependencies
#   6. Apply D1 schema migrations
#   7. Deploy to Cloudflare Workers
#   8. Print the deployment URL and quick test commands
#

set -euo pipefail

# ─── Colors ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

info()  { echo -e "${CYAN}[INFO]${NC}  $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
err()   { echo -e "${RED}[ERROR]${NC} $*"; }

# ─── Step 0: Locate script directory ────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo ""
echo -e "${CYAN}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║        KoRest — Cloudflare Workers Deploy       ║${NC}"
echo -e "${CYAN}║  KOReader sync server for Readest App           ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════════════╝${NC}"
echo ""

# ─── Step 1: Check prerequisites ────────────────────────────────────────────
info "Checking prerequisites..."

# Node.js
if ! command -v node &>/dev/null; then
    err "Node.js is not installed. Please install Node.js >= 18."
    err "  https://nodejs.org/"
    exit 1
fi
NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VER" -lt 18 ]; then
    err "Node.js >= 18 required. Current version: $(node -v)"
    exit 1
fi
ok "Node.js $(node -v)"

# npm
if ! command -v npm &>/dev/null; then
    err "npm is not installed."
    exit 1
fi
ok "npm $(npm -v)"

# wrangler
if ! command -v npx &>/dev/null; then
    err "npx is not installed (should come with npm)."
    exit 1
fi
ok "npx available"

# ─── Step 2: Cloudflare login check ─────────────────────────────────────────
info "Checking Cloudflare authentication..."
if ! npx wrangler whoami &>/dev/null; then
    echo ""
    warn "You are not logged into Cloudflare Workers."
    echo -e "   ${YELLOW}→ Opening browser for login...${NC}"
    npx wrangler login
    echo ""
    if ! npx wrangler whoami &>/dev/null; then
        err "Login failed. Please run 'npx wrangler login' manually, then retry."
        exit 1
    fi
fi
ACCOUNT_NAME=$(npx wrangler whoami 2>/dev/null | grep -E '^[A-Za-z]' | head -1 || echo "Cloudflare account")
ok "Logged in as: ${ACCOUNT_NAME}"

# ─── Step 3: Choose Worker name ─────────────────────────────────────────────
DEFAULT_NAME="korest"
echo ""
read -r -p "Enter Worker name [${DEFAULT_NAME}]: " WORKER_NAME
WORKER_NAME="${WORKER_NAME:-$DEFAULT_NAME}"

# Validate name (alphanumeric + hyphens only)
if ! [[ "$WORKER_NAME" =~ ^[a-zA-Z0-9-]+$ ]]; then
    err "Worker name must contain only letters, numbers, and hyphens."
    exit 1
fi

# ─── Step 4: Update wrangler.toml name ──────────────────────────────────────
if [[ "$(uname)" == "Darwin" ]]; then
    sed -i '' "s/^name = .*/name = \"$WORKER_NAME\"/" wrangler.toml 2>/dev/null || true
else
    sed -i "s/^name = .*/name = \"$WORKER_NAME\"/" wrangler.toml 2>/dev/null || true
fi
ok "Worker name set to: ${WORKER_NAME}"

# ─── Step 5: Create D1 database ─────────────────────────────────────────────
info "Creating D1 database '${WORKER_NAME}-db'..."
D1_OUTPUT=$(npx wrangler d1 create "${WORKER_NAME}-db" 2>&1 || true)

# Check if database already exists
if echo "$D1_OUTPUT" | grep -qi "already exists"; then
    warn "Database '${WORKER_NAME}-db' already exists."
    # Extract existing database_id
    DB_ID=$(npx wrangler d1 list 2>/dev/null | grep "${WORKER_NAME}-db" | awk '{print $1}' | tr -d '[:space:]' || echo "")
    if [ -z "$DB_ID" ]; then
        err "Could not find database ID. Please check 'npx wrangler d1 list'."
        exit 1
    fi
    ok "Using existing database: ${DB_ID}"
else
    # Extract database_id from creation output
    DB_ID=$(echo "$D1_OUTPUT" | grep -oE 'database_id\s*=\s*"[^"]+"' | sed 's/database_id = "//;s/"//' || echo "")
    if [ -z "$DB_ID" ]; then
        # Fallback: try to extract from "created: <uuid>" pattern
        DB_ID=$(echo "$D1_OUTPUT" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1 || echo "")
    fi
    if [ -z "$DB_ID" ]; then
        err "Failed to extract database ID. Output:\n$D1_OUTPUT"
        exit 1
    fi
    ok "D1 database created: ${DB_ID}"
fi

# ─── Step 6: Update database_id in wrangler.toml ────────────────────────────
if [[ "$(uname)" == "Darwin" ]]; then
    sed -i '' "s/database_id = \".*\"/database_id = \"$DB_ID\"/" wrangler.toml
else
    sed -i "s/database_id = \".*\"/database_id = \"$DB_ID\"/" wrangler.toml
fi
ok "wrangler.toml updated with database_id = ${DB_ID}"

# ─── Step 7: Install dependencies ───────────────────────────────────────────
echo ""
info "Installing npm dependencies..."
npm install 2>&1 | tail -1
ok "Dependencies installed"

# ─── Step 8: Apply migrations ───────────────────────────────────────────────
echo ""
info "Applying D1 schema migrations..."
npx wrangler d1 migrations apply "${WORKER_NAME}-db" 2>&1
ok "Schema migrations applied"

# ─── Step 9: Deploy ─────────────────────────────────────────────────────────
echo ""
info "Deploying ${WORKER_NAME} to Cloudflare Workers..."
DEPLOY_OUTPUT=$(npx wrangler deploy 2>&1)
echo "$DEPLOY_OUTPUT"

# ─── Step 10: Extract deployment URL ────────────────────────────────────────
DEPLOY_URL=$(echo "$DEPLOY_OUTPUT" | grep -oE 'https://[a-zA-Z0-9.-]+\.workers\.dev' | head -1 || echo "")
if [ -z "$DEPLOY_URL" ]; then
    # Fallback: construct from name
    DEPLOY_URL="https://${WORKER_NAME}.$(echo "$ACCOUNT_NAME" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9-').workers.dev"
    warn "Could not auto-detect URL. Trying: ${DEPLOY_URL}"
fi

# ─── Done ────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║              Deployment Complete! 🎉            ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${CYAN}Worker URL:${NC}  ${DEPLOY_URL}"
echo ""
echo -e "  ${YELLOW}Quick test commands:${NC}"
echo ""
echo -e "  # Health check"
echo -e "  curl ${DEPLOY_URL}/healthstatus | jq ."
echo ""
echo -e "  # Create a test user"
echo -e "  curl -X POST ${DEPLOY_URL}/users/create \\"
echo -e "    -H 'Content-Type: application/json' \\"
echo -e "    -d '{\"username\":\"demo\",\"password\":\"demo123\"}'"
echo ""
echo -e "  # Auth check"
echo -e "  curl ${DEPLOY_URL}/users/auth \\"
echo -e "    -H 'x-auth-user: demo' \\"
echo -e "    -H 'x-auth-key: demo123'"
echo ""
echo -e "  ${GREEN}Done!${NC} Configure your Readest App with:"
echo -e "  Sync Server URL → ${DEPLOY_URL}"
echo ""

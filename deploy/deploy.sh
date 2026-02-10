#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# tezit-relay: Deploy latest code to server
# Run from local machine (or as part of CI/CD).
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail

# Configuration
RELAY_HOST="${RELAY_HOST:-relay.tezit.com}"
SSH_USER="${SSH_USER:-root}"
APP_DIR="/var/tezit-relay/app"
REPO_URL="https://github.com/tezit-protocol/relay.git"

# Resolve server IP from first argument or environment
SERVER_IP="${1:-${RELAY_SERVER_IP:-}}"
if [ -z "${SERVER_IP}" ]; then
  echo "Usage: $0 <server-ip>"
  echo "  or set RELAY_SERVER_IP environment variable"
  exit 1
fi

echo "=== Deploying tezit-relay to ${SERVER_IP} ==="

# Build locally first
echo "[1/5] Building TypeScript..."
cd "$(dirname "$0")/.."
npm ci --ignore-scripts 2>/dev/null
npx tsc

# Sync files to server
echo "[2/5] Syncing to server..."
rsync -azP --delete \
  --exclude='node_modules' \
  --exclude='.git' \
  --exclude='tests' \
  --exclude='.env' \
  --exclude='*.db' \
  --exclude='*.db-wal' \
  --exclude='*.db-shm' \
  ./ "${SSH_USER}@${SERVER_IP}:${APP_DIR}/"

# Install production dependencies and restart
echo "[3/5] Installing dependencies on server..."
ssh "${SSH_USER}@${SERVER_IP}" "cd ${APP_DIR} && npm ci --omit=dev --ignore-scripts 2>/dev/null"

echo "[4/5] Pushing schema..."
ssh "${SSH_USER}@${SERVER_IP}" "cd ${APP_DIR} && npx drizzle-kit push 2>/dev/null || true"

echo "[5/5] Restarting PM2..."
ssh "${SSH_USER}@${SERVER_IP}" "pm2 startOrRestart ${APP_DIR}/deploy/ecosystem.config.cjs --update-env"

# Health check
echo ""
echo "Waiting for health check..."
sleep 3
HEALTH=$(ssh "${SSH_USER}@${SERVER_IP}" "curl -sf http://localhost:3002/health" 2>/dev/null || echo "FAILED")
echo "Health: ${HEALTH}"

if echo "${HEALTH}" | grep -q '"ok"'; then
  echo ""
  echo "=== Deploy successful ==="
  echo "Relay running at https://${RELAY_HOST}"
else
  echo ""
  echo "=== WARNING: Health check failed ==="
  echo "Check logs: ssh ${SSH_USER}@${SERVER_IP} 'pm2 logs tezit-relay --lines 30'"
fi

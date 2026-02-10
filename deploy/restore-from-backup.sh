#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# tezit-relay: Restore database from Litestream backup
# Use this to recover on a new server or after data loss.
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail

DATA_DIR="/var/tezit-relay/data"
DB_PATH="${DATA_DIR}/relay.db"
BACKUP_SOURCE="s3://tezit-backups/relay/"

echo "=== Restoring tezit-relay from backup ==="

# Stop relay if running
pm2 stop tezit-relay 2>/dev/null || true
# Stop litestream to release the DB
systemctl stop litestream 2>/dev/null || true

# Backup current DB if it exists
if [ -f "${DB_PATH}" ]; then
  TIMESTAMP=$(date +%Y%m%d_%H%M%S)
  echo "Backing up current DB to ${DB_PATH}.pre-restore.${TIMESTAMP}"
  cp "${DB_PATH}" "${DB_PATH}.pre-restore.${TIMESTAMP}"
fi

# Restore
echo "Restoring from ${BACKUP_SOURCE}..."
litestream restore -o "${DB_PATH}" "${BACKUP_SOURCE}"

# Fix permissions
chown svc-relay:svc-relay "${DB_PATH}"
chmod 600 "${DB_PATH}"

# Restart services
echo "Restarting services..."
systemctl start litestream
pm2 restart tezit-relay

sleep 3
HEALTH=$(curl -sf http://localhost:3002/health 2>/dev/null || echo "FAILED")
echo "Health: ${HEALTH}"

echo ""
echo "=== Restore complete ==="

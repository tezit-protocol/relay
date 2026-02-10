#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# tezit-relay: Configure Litestream continuous backup
# Run as root after provisioning.
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "Usage: $0 <SPACES_ACCESS_KEY_ID> <SPACES_SECRET_ACCESS_KEY>"
  echo ""
  echo "Get your Spaces keys from: https://cloud.digitalocean.com/account/api/spaces"
  exit 1
fi

SPACES_KEY="$1"
SPACES_SECRET="$2"

echo "=== Configuring Litestream backup ==="

# Copy config
cp "$(dirname "$0")/litestream.yml" /etc/litestream.yml
chmod 644 /etc/litestream.yml

# Create systemd override for credentials
mkdir -p /etc/systemd/system/litestream.service.d
cat > /etc/systemd/system/litestream.service.d/override.conf <<EOF
[Service]
Environment="LITESTREAM_ACCESS_KEY_ID=${SPACES_KEY}"
Environment="LITESTREAM_SECRET_ACCESS_KEY=${SPACES_SECRET}"
User=svc-relay
Group=svc-relay
EOF
chmod 600 /etc/systemd/system/litestream.service.d/override.conf

# Enable and start
systemctl daemon-reload
systemctl enable litestream
systemctl restart litestream

echo ""
echo "Litestream status:"
systemctl status litestream --no-pager -l || true

echo ""
echo "=== Backup configured ==="
echo "Continuous WAL replication to DO Spaces: tezit-backups/relay/"
echo "Full snapshots every 24 hours, retained for 30 days"
echo ""
echo "To restore from backup:"
echo "  litestream restore -o /var/tezit-relay/data/relay.db s3://tezit-backups/relay/"

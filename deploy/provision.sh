#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# tezit-relay: One-time server provisioning
# Run as root on a fresh Ubuntu 24.04 droplet.
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail

RELAY_USER="svc-relay"
DATA_DIR="/var/tezit-relay/data"
APP_DIR="/var/tezit-relay/app"
LOG_DIR="/var/log/tezit-relay"

echo "=== tezit-relay: Provisioning server ==="

# ── 1. System updates ────────────────────────────────────────────────────
echo "[1/8] System updates..."
apt-get update -qq
apt-get upgrade -y -qq
apt-get install -y -qq curl git ufw nginx certbot python3-certbot-nginx sqlite3 jq

# ── 2. Node.js 22 LTS ───────────────────────────────────────────────────
echo "[2/8] Installing Node.js 22 LTS..."
if ! command -v node &>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
fi
echo "Node.js $(node --version)"

# ── 3. PM2 ───────────────────────────────────────────────────────────────
echo "[3/8] Installing PM2..."
npm install -g pm2 2>/dev/null || true
pm2 startup systemd -u root --hp /root 2>/dev/null || true

# ── 4. Service user (no login shell) ────────────────────────────────────
echo "[4/8] Creating service user: ${RELAY_USER}..."
if ! id "${RELAY_USER}" &>/dev/null; then
  useradd --system --shell /usr/sbin/nologin --home /nonexistent "${RELAY_USER}"
fi

# ── 5. Directory structure ───────────────────────────────────────────────
echo "[5/8] Creating directories..."
mkdir -p "${DATA_DIR}" "${APP_DIR}" "${LOG_DIR}"
chown "${RELAY_USER}:${RELAY_USER}" "${DATA_DIR}"
chmod 700 "${DATA_DIR}"
chown "${RELAY_USER}:${RELAY_USER}" "${LOG_DIR}"
chmod 755 "${LOG_DIR}"

# ── 6. Litestream (SQLite continuous replication) ────────────────────────
echo "[6/8] Installing Litestream..."
if ! command -v litestream &>/dev/null; then
  LITESTREAM_VERSION="0.3.13"
  wget -q "https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}/litestream-v${LITESTREAM_VERSION}-linux-amd64.deb" -O /tmp/litestream.deb
  dpkg -i /tmp/litestream.deb
  rm /tmp/litestream.deb
fi
echo "Litestream $(litestream version 2>/dev/null || echo 'installed')"

# ── 7. UFW Firewall ─────────────────────────────────────────────────────
echo "[7/8] Configuring firewall..."
ufw --force reset >/dev/null 2>&1
ufw default deny incoming
ufw default allow outgoing
ufw allow ssh
ufw allow 80/tcp    # HTTP (certbot + redirect)
ufw allow 443/tcp   # HTTPS
ufw --force enable
echo "Firewall: $(ufw status | head -1)"

# ── 8. Environment file template ────────────────────────────────────────
echo "[8/8] Creating environment template..."
ENV_FILE="${APP_DIR}/.env"
if [ ! -f "${ENV_FILE}" ]; then
  cat > "${ENV_FILE}" <<'ENVEOF'
# tezit-relay production environment
NODE_ENV=production
PORT=3002

# IMPORTANT: Must match the JWT_SECRET of services using this relay
JWT_SECRET=CHANGE_ME_IN_PRODUCTION

# Federation
RELAY_HOST=relay.mypa.chat
FEDERATION_ENABLED=true
FEDERATION_MODE=allowlist
DATA_DIR=/var/tezit-relay/data
ADMIN_USER_IDS=

# Database
DATABASE_URL=file:/var/tezit-relay/data/relay.db
ENVEOF
  chmod 640 "${ENV_FILE}"
  chown "root:${RELAY_USER}" "${ENV_FILE}"
  echo "Created ${ENV_FILE} — EDIT JWT_SECRET before starting!"
else
  echo "${ENV_FILE} already exists, skipping"
fi

echo ""
echo "=== Provisioning complete ==="
echo ""
echo "Next steps:"
echo "  1. Edit ${ENV_FILE} — set JWT_SECRET and RELAY_HOST"
echo "  2. Run deploy/deploy.sh to deploy the relay code"
echo "  3. Run deploy/litestream-setup.sh to configure backups"
echo "  4. Run deploy/ssl-setup.sh <domain> to configure SSL"

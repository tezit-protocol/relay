#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# tezit-relay: Configure SSL with Let's Encrypt
# Run as root after DNS is pointed to the server.
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail

DOMAIN="${1:-relay.mypa.chat}"
EMAIL="${2:-rob@ragu.ai}"

echo "=== Setting up SSL for ${DOMAIN} ==="

# Install nginx config (without SSL first for certbot)
# Create a temporary HTTP-only config for the ACME challenge
cat > /etc/nginx/sites-available/tezit-relay <<EOF
server {
    listen 80;
    server_name ${DOMAIN};

    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    location / {
        return 200 'Waiting for SSL setup';
        add_header Content-Type text/plain;
    }
}
EOF

ln -sf /etc/nginx/sites-available/tezit-relay /etc/nginx/sites-enabled/tezit-relay
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

# Get certificate
echo "Obtaining certificate for ${DOMAIN}..."
certbot --nginx -d "${DOMAIN}" --non-interactive --agree-tos --email "${EMAIL}" --redirect

# Now install the full nginx config
echo "Installing production nginx config..."
cp /var/tezit-relay/app/deploy/nginx-relay.conf /etc/nginx/sites-available/tezit-relay

# Update domain in config if different from default
if [ "${DOMAIN}" != "relay.mypa.chat" ]; then
  sed -i "s/relay\.mypa\.chat/${DOMAIN}/g" /etc/nginx/sites-available/tezit-relay
fi

nginx -t && systemctl reload nginx

echo ""
echo "=== SSL configured ==="
echo "https://${DOMAIN} is ready"
echo "Certificate auto-renews via certbot timer"

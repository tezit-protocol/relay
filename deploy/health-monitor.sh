#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# tezit-relay: Health monitoring cron script
# Add to crontab: */5 * * * * /var/tezit-relay/app/deploy/health-monitor.sh
# Checks relay health and restarts PM2 if down. Sends alert on failure.
# ═══════════════════════════════════════════════════════════════════════════

HEALTH_URL="http://localhost:3002/health"
LOG_FILE="/var/log/tezit-relay/health-monitor.log"
ALERT_FILE="/tmp/relay-alert-sent"
MAX_RETRIES=3

log() {
  echo "$(date '+%Y-%m-%d %H:%M:%S') $1" >> "${LOG_FILE}"
}

check_health() {
  curl -sf --max-time 5 "${HEALTH_URL}" >/dev/null 2>&1
}

# Try health check with retries
for i in $(seq 1 ${MAX_RETRIES}); do
  if check_health; then
    # Healthy — clear any alert state
    if [ -f "${ALERT_FILE}" ]; then
      log "RECOVERED: Relay is healthy again"
      rm -f "${ALERT_FILE}"
    fi
    exit 0
  fi
  sleep 2
done

# All retries failed
log "UNHEALTHY: Relay failed ${MAX_RETRIES} health checks"

# Attempt restart
log "Attempting PM2 restart..."
pm2 restart tezit-relay 2>>"${LOG_FILE}"
sleep 5

if check_health; then
  log "RESTART SUCCESS: Relay recovered after restart"
  rm -f "${ALERT_FILE}"
else
  log "RESTART FAILED: Relay still unhealthy after restart"

  # Only alert once per incident (don't spam)
  if [ ! -f "${ALERT_FILE}" ]; then
    touch "${ALERT_FILE}"
    log "ALERT: Sending failure notification"

    # ntfy.sh alert (if configured)
    if [ -n "${NTFY_TOPIC:-}" ]; then
      curl -sf -d "tezit-relay is DOWN on $(hostname). PM2 restart failed." \
        -H "Title: Relay Down" \
        -H "Priority: urgent" \
        -H "Tags: rotating_light" \
        "https://ntfy.sh/${NTFY_TOPIC}" >/dev/null 2>&1 || true
    fi
  fi
fi

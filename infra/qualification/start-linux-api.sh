#!/usr/bin/env bash
# Start the EVE-X Linux control plane (API) detached with logs.
set -u
mkdir -p /root/evex-prod/data /root/evex-prod/logs
cd /root/evex-prod
export EVEX_AUTH_TOKEN="${EVEX_AUTH_TOKEN:-$(cat /root/.evex-qual-token 2>/dev/null || echo qual-canonical-token-0123456789abcdef)}"
export VM_BACKEND="${VM_BACKEND:-qemu}"
export EVEX_IMAGES=/var/lib/eve-images/qual
export EVEX_BASE_IMAGE="${EVEX_BASE_IMAGE:-eve-desktop-xorg.qcow2}"
export DATA_DIR=/root/evex-prod/data
export DATABASE_URL="${DATABASE_URL:-postgres://evex:evex-qual@127.0.0.1:5433/evex}"
export REDIS_URL="${REDIS_URL:-redis://127.0.0.1:6380}"
export OBJECT_ENDPOINT="${OBJECT_ENDPOINT:-http://127.0.0.1:3900}"
export PORT="${PORT:-8080}"
pkill -9 -f "apps/api/src/index.js" 2>/dev/null
sleep 2
setsid nohup node dist/apps/api/src/index.js > /root/evex-prod/logs/api.log 2>&1 < /dev/null &
echo "api pid $!"
sleep 5
curl -sf http://127.0.0.1:${PORT}/health; echo
curl -sf http://127.0.0.1:${PORT}/ready; echo

#!/usr/bin/env bash
# Start the EVE-X Linux control plane (API) detached with logs.
# Refusals come before ANY side effect (no mkdir/cd/pkill before auth env
# is proven present), so a misconfigured invocation changes nothing.
set -u
# Fail closed: no token or DB URL is ever defaulted. A predictable fallback
# bearer here would authenticate anyone holding the repo (and it would pass
# the >=32-char gate). Mint per host, e.g.:
#   python3 -c 'import secrets; print(secrets.token_hex(32))' > /root/.evex-qual-token
if [ -z "${EVEX_AUTH_TOKEN:-}" ]; then
  if [ -f /root/.evex-qual-token ]; then
    EVEX_AUTH_TOKEN="$(cat /root/.evex-qual-token)"
  else
    echo "refusing: EVEX_AUTH_TOKEN unset and no /root/.evex-qual-token (never use a default token)" >&2
    exit 1
  fi
fi
export EVEX_AUTH_TOKEN
if [ -z "${DATABASE_URL:-}" ]; then
  echo "refusing: DATABASE_URL unset (never default credentials)" >&2
  exit 1
fi
export DATABASE_URL
# Selftest hook (used by tests/production-gate.test.ts): validates env and
# exits before ANY side effect (no mkdir/cd/pkill/node). Never set in prod.
if [ "${EVEX_BOOT_SELFTEST:-}" = "1" ]; then
  echo "selftest-ok: boot env present, no side effects taken"
  exit 0
fi
mkdir -p /root/evex-prod/data /root/evex-prod/logs
cd /root/evex-prod
export VM_BACKEND="${VM_BACKEND:-qemu}"
export EVEX_IMAGES=/var/lib/eve-images/qual
export EVEX_BASE_IMAGE="${EVEX_BASE_IMAGE:-eve-desktop-autologin.qcow2}"
export DATA_DIR=/root/evex-prod/data
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

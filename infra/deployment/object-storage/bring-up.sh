#!/usr/bin/env bash
# Bring up the EVE-X object-storage service (Garage v2, S3 API) for
# qualification or single-node deployment. Secrets come from the environment
# (or existing files) and are NEVER written to the repository.
# Usage: GARAGE_RPC_SECRET=... GARAGE_ADMIN_TOKEN=... bash bring-up.sh [--clean]
# Result: healthy Garage on :3900 (S3) + :3903 (admin), bucket `evex`, key printed once.
set -euo pipefail
# MSYS2/Git-bash rewrites leading-slash args (e.g. /garage) into Windows
# paths, which corrupts docker exec commands. Disable that translation:
# all host paths in this script are converted explicitly via cygpath.
export MSYS_NO_PATHCONV=1
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME="${GARAGE_RUNTIME_DIR:-$HERE/.runtime-qual}"
BUCKET="${GARAGE_BUCKET:-evex}"
IMAGE="${GARAGE_IMAGE:-dxflrs/garage:v2.0.0@sha256:15b40e0dddd2e611aa746ff6f7c3bfe9f22735e4a2cc29e0abd89c268e9b79d9}"

if [ "${1:-}" = "--clean" ]; then
  docker rm -f evex-garage 2>/dev/null || true
  rm -rf "$RUNTIME"
fi
mkdir -p "$RUNTIME/meta" "$RUNTIME/data"

: "${GARAGE_RPC_SECRET:=$(python3 -c 'import secrets; print(secrets.token_hex(32))' 2>/dev/null || openssl rand -hex 32)}"
: "${GARAGE_ADMIN_TOKEN:=$(python3 -c 'import secrets; print(secrets.token_hex(32))' 2>/dev/null || openssl rand -hex 32)}"
export GARAGE_RPC_SECRET GARAGE_ADMIN_TOKEN

sed -e "s|\${GARAGE_RPC_SECRET}|${GARAGE_RPC_SECRET}|g" \
    -e "s|\${GARAGE_ADMIN_TOKEN}|${GARAGE_ADMIN_TOKEN}|g" \
  "$HERE/garage.toml.template" > "$RUNTIME/garage.toml"
chmod 600 "$RUNTIME/garage.toml"

docker rm -f evex-garage 2>/dev/null || true
# Git-bash on Windows reports Unix paths; the Docker daemon needs native
# Windows paths for bind mounts. cygpath bridges the two worlds.
MOUNT_BASE="$RUNTIME"
if command -v cygpath >/dev/null 2>&1; then MOUNT_BASE="$(cygpath -w "$RUNTIME")"; fi
docker run -d --name evex-garage \
  -p 3900:3900 -p 3903:3903 \
  -v "$MOUNT_BASE/garage.toml:/etc/garage.toml:ro" \
  -v "$MOUNT_BASE/meta:/var/lib/garage/meta" \
  -v "$MOUNT_BASE/data:/var/lib/garage/data" \
  "$IMAGE" /garage -c /etc/garage.toml server

echo "waiting for admin API..."
for i in $(seq 1 30); do
  if curl -sf -H "Authorization: Bearer ${GARAGE_ADMIN_TOKEN}" http://127.0.0.1:3903/v2/GetClusterStatus >/dev/null 2>&1; then
    echo "admin API up after ~$((i * 2))s"; break
  fi
  sleep 2
done

NODE_ID="$(docker exec evex-garage /garage -c /etc/garage.toml status 2>/dev/null | awk '$1 ~ /^[0-9a-f]{16}$/ {print $1; exit}')"
echo "node: ${NODE_ID:-unknown}"
if [ -n "$NODE_ID" ]; then
  # Idempotent: a restored data dir already carries an applied layout.
  if docker exec evex-garage /garage -c /etc/garage.toml layout show 2>/dev/null | grep -q "version: 1"; then
    echo "layout already applied (restored data); skipping"
  else
    docker exec evex-garage /garage -c /etc/garage.toml layout assign -z dc1 -c 10G "$NODE_ID" >/dev/null
    docker exec evex-garage /garage -c /etc/garage.toml layout apply --version 1 >/dev/null
    echo "layout applied"
  fi
fi

if ! docker exec evex-garage /garage -c /etc/garage.toml key info evex-key >/dev/null 2>&1; then
  docker exec evex-garage /garage -c /etc/garage.toml key create evex-key >/dev/null
fi
KEY_JSON="$(docker exec evex-garage /garage -c /etc/garage.toml key info evex-key --output-format json 2>/dev/null || true)"
echo "$KEY_JSON" > "$RUNTIME/key.json"
chmod 600 "$RUNTIME/key.json"
docker exec evex-garage /garage -c /etc/garage.toml bucket create "$BUCKET" >/dev/null 2>&1 || true
docker exec evex-garage /garage -c /etc/garage.toml bucket allow --read --write --owner "$BUCKET" --key evex-key >/dev/null
echo "bucket '$BUCKET' ready; key material in $RUNTIME/key.json (600)"

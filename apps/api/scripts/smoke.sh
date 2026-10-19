#!/usr/bin/env bash
# Starts the built server against DATABASE_URL and checks the probes. Run after `npm run build`.
set -euo pipefail
: "${DATABASE_URL:?DATABASE_URL is required}"
PORT="${PORT:-3999}"

node dist/migrate-cli.js
node dist/migrate-cli.js | grep -q "No pending migrations"   # re-running must be a no-op

NODE_ENV=development PORT="$PORT" AUTH_DEV_SECRET="smoke-secret-smoke-secret-smoke-0001" node dist/index.js >/tmp/mudatex-smoke.log 2>&1 &
PID=$!
trap 'kill "$PID" 2>/dev/null || true' EXIT

for _ in $(seq 1 30); do
  curl -fs "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -fs "http://127.0.0.1:$PORT/health" >/dev/null
curl -fs "http://127.0.0.1:$PORT/ready" | grep -q '"ready":true'
code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/v1/me")
[ "$code" = "401" ] || { echo "expected 401 for an unauthenticated call, got $code"; exit 1; }
echo "smoke test passed"

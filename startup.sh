#!/bin/sh
set -eu
cd /workspace
# :8081 is QA-only — a revive must never inherit a stale built-output preview.
node scripts/preview.mjs stop || true
if curl -sf -o /dev/null --max-time 2 http://127.0.0.1:8080/; then
  exit 0
fi
export AETHER_OPS_LOGIN="${AETHER_OPS_LOGIN:-desk}"
export AETHER_OPS_PASSWORD="${AETHER_OPS_PASSWORD:-desk-pass}"
npm run dev >>/tmp/app-startup.log 2>&1 &

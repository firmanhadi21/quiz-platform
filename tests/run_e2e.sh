#!/usr/bin/env bash
# Whole browser test in one go: scratch database, admin account, stand-in AI, app, then e2e.mjs.
#   PLAYWRIGHT=/path/to/node_modules/playwright/index.mjs tests/run_e2e.sh [screenshot-dir]
set -euo pipefail
cd "$(dirname "$0")/.."
WORK="$(mktemp -d)"; PORT="${PORT:-8765}"
trap 'kill $(jobs -p) 2>/dev/null || true; rm -rf "$WORK"' EXIT
export QUIZ_DATA="$WORK/data" QUIZ_SECURE_COOKIE=0 QUIZ_AI_SOCKET="$WORK/ai.sock" QUIZ_AI_KEY=test-key
PW="$(cd app && ../.venv/bin/python manage.py create admin@example.org "Admin Uji" admin | sed 's/.*password: //')"
.venv/bin/python tests/fake_hermes.py "$QUIZ_AI_SOCKET" &
(cd app && exec ../.venv/bin/uvicorn main:app --port "$PORT" --log-level warning) &
for _ in $(seq 40); do curl -s -o /dev/null "http://127.0.0.1:$PORT/healthz" && break; sleep 0.25; done
BASE="http://127.0.0.1:$PORT" ADMIN_EMAIL=admin@example.org ADMIN_PW="$PW" bun tests/e2e.mjs "$@"

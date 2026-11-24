#!/usr/bin/env bash
# Install or update the quiz platform on this server. Run from deploy/standalone/:
#   ./install.sh            first install, or update after `git pull`
# Needs Docker with the compose plugin, and DNS for DOMAIN pointing here.
set -euo pipefail
cd "$(dirname "$0")"

command -v docker >/dev/null || { echo "Docker is not installed: https://docs.docker.com/engine/install/" >&2; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "The Docker compose plugin is missing." >&2; exit 1; }
if [ ! -f .env ]; then
  cp .env.example .env
  chmod 600 .env
  echo "Created .env from .env.example. Fill in DOMAIN and ADMIN_EMAIL (and the AI key if wanted), then run ./install.sh again."
  exit 0
fi
# Read only what this script needs, without running .env as shell code (values may contain spaces).
val() { grep -m1 "^$1=" .env | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' || true; }
DOMAIN="$(val DOMAIN)"; ADMIN_EMAIL="$(val ADMIN_EMAIL)"; ADMIN_NAME="$(val ADMIN_NAME)"
[ -n "${DOMAIN:-}" ] && [ "$DOMAIN" != "quiz.example.sch.id" ] || { echo "Set DOMAIN in .env first." >&2; exit 1; }

echo "Building and starting (first run takes a few minutes)..."
docker compose up -d --build

echo -n "Waiting for the app"
for _ in $(seq 60); do
  if docker compose exec -T quiz python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz')" 2>/dev/null; then
    echo " ready."; break
  fi
  echo -n "."; sleep 2
done

if [ -n "${ADMIN_EMAIL:-}" ] && ! docker compose exec -T quiz python manage.py has-admin; then
  echo "Creating the first admin:"
  docker compose exec -T quiz python manage.py create "$ADMIN_EMAIL" "${ADMIN_NAME:-Admin}" admin
  echo "Sign in at https://$DOMAIN/login and change this password under your name in the menu."
fi
echo "Done: https://$DOMAIN"

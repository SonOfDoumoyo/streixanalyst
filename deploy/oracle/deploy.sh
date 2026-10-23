#!/usr/bin/env bash
# Build and start (or update) everything. Run it again after every `git pull`; it only rebuilds what changed.
set -euo pipefail
cd "$(dirname "$0")"
[ -f .env ] || { echo "No .env yet. Run ./init-env.sh first."; exit 1; }
if [ "${1:-}" = "--pull" ]; then git -C ../.. pull --ff-only; fi
docker compose up -d --build --remove-orphans
docker image prune -f >/dev/null
echo
docker compose ps
domain="$(grep '^DOMAIN=' .env | cut -d= -f2-)"
echo
echo "Open https://${domain}  (the first start takes a minute while the certificate is issued and the model loads)"

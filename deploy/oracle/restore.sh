#!/usr/bin/env bash
# Loads a .dump (from backup.sh, or `pg_dump -Fc` on Render) into this VM's database, replacing what is there.
#   ./restore.sh path/to/streix-backup.dump
set -euo pipefail
cd "$(dirname "$0")"
f="${1:-}"
[ -f "$f" ] || { echo "Usage: ./restore.sh path/to/file.dump"; exit 1; }
read -r -p "This REPLACES the database on this VM with $f. Type yes to go on: " ok
[ "$ok" = "yes" ] || { echo "Cancelled."; exit 1; }
docker compose up -d db
docker compose stop api web 2>/dev/null || true
until docker compose exec -T db pg_isready -U streix -d streix >/dev/null 2>&1; do sleep 2; done
docker compose exec -T db pg_restore -U streix -d streix --no-owner --no-acl --clean --if-exists < "$f" || \
  echo "(pg_restore printed warnings; that is normal on a first restore. Check the app after it starts.)"
docker compose up -d
echo "Restored. Open the site and sign in with your old account."

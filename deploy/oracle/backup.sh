#!/usr/bin/env bash
# Dumps the database to backups/ (kept 14 days). Runs daily from cron after setup-vm.sh. Copy backups off the VM too.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p backups
f="backups/streix-$(date +%Y%m%d-%H%M).dump"
docker compose exec -T db pg_dump -U streix -d streix -Fc --no-owner --no-acl > "$f"
[ -s "$f" ] || { rm -f "$f"; echo "backup was empty"; exit 1; }
find backups -name 'streix-*.dump' -mtime +14 -delete
echo "$(date -Is) wrote $f ($(du -h "$f" | cut -f1))"

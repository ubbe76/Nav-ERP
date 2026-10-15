#!/usr/bin/env bash
# Nightly logical backup of the Nav-ERP Postgres database.
#
# The compose stack keeps its data in the `erp_postgres_data` volume, which
# has no backup of its own — this dumps the database to a gzipped SQL file
# instead, so a lost volume (or a mistaken TRUNCATE) can be restored.
#
# Install with cron, e.g. nightly at 02:30:
#   30 2 * * * /path/to/Nav-ERP/scripts/backup-db.sh >> "$HOME/backups/nav-erp/backup.log" 2>&1
#
# Restore a dump into the running container:
#   gunzip -c erp-2026-07-20.sql.gz | docker compose exec -T postgres psql -U erp -d erp

set -euo pipefail

# Container addressing goes through docker compose's SERVICE name, resolved
# from the repo's compose file — never a hardcoded container name. G2 removed
# container_name: from compose (needed for parallel smoke stacks), so the
# actual names follow the project (dev-postgres-1 today, something else if
# the checkout moves). ERP_PG_CONTAINER remains as an escape hatch for
# pointing at a container outside this compose project.
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTAINER="${ERP_PG_CONTAINER:-}"
DB_NAME="${ERP_DB_NAME:-erp}"
DB_USER="${ERP_DB_USER:-erp}"
BACKUP_DIR="${ERP_BACKUP_DIR:-$HOME/backups/nav-erp}"
RETENTION_DAYS="${ERP_BACKUP_RETENTION_DAYS:-30}"

if [ -n "$CONTAINER" ]; then
  DUMP_CMD="docker exec ${CONTAINER} pg_dump -U ${DB_USER} ${DB_NAME}"
else
  DUMP_CMD="docker compose --project-directory ${REPO_DIR} exec -T postgres pg_dump -U ${DB_USER} ${DB_NAME}"
fi

timestamp="$(date +%F_%H%M)"
target="${BACKUP_DIR}/${DB_NAME}-${timestamp}.sql.gz"

mkdir -p "$BACKUP_DIR"

# `sg docker` because cron shells don't pick up the docker group membership.
# Write to a .part file first so a crashed run never leaves a truncated dump
# that looks like a valid backup.
if ! sg docker -c "${DUMP_CMD}" | gzip > "${target}.part"; then
  echo "$(date -Is) FEL: pg_dump misslyckades — ingen backup skriven"
  rm -f "${target}.part"
  exit 1
fi

mv "${target}.part" "$target"
echo "$(date -Is) OK: $target ($(du -h "$target" | cut -f1))"

# Prune old dumps.
find "$BACKUP_DIR" -name "${DB_NAME}-*.sql.gz" -type f -mtime "+${RETENTION_DAYS}" -print -delete |
  while read -r old; do echo "$(date -Is) rensade $old"; done

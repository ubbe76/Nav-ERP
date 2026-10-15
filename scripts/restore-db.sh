#!/usr/bin/env bash
# Restore the Nav-ERP Postgres database from a logical backup (.sql.gz) created
# by scripts/backup-db.sh or by System → Säkerhetskopiering.
#
# WARNING: this REPLACES everything in the target database. Used both for
# disaster recovery and for moving the ERP to a new server.
set -euo pipefail

# Resolve the postgres container through the compose SERVICE name — the
# container name itself is project-derived since G2 (dev-postgres-1 today)
# and must not be hardcoded. ERP_PG_CONTAINER remains as an escape hatch.
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOCKER="${ERP_DOCKER:-docker}"
CONTAINER="${ERP_PG_CONTAINER:-}"
if [ -z "$CONTAINER" ]; then
  CONTAINER="$($DOCKER compose --project-directory "$REPO_DIR" ps -q postgres)"
  if [ -z "$CONTAINER" ]; then
    echo "FEL: postgres-tjänsten kör inte (docker compose ps -q postgres gav inget)"
    exit 1
  fi
fi
DB_NAME="${ERP_DB_NAME:-erp}"
DB_USER="${ERP_DB_USER:-erp}"

FILE="${1:-}"
if [ -z "$FILE" ]; then
  echo "Användning: $0 <backup.sql.gz> [--yes]"
  echo "  Återställer databasen '${DB_NAME}' i containern '${CONTAINER}' från en dump skapad av"
  echo "  scripts/backup-db.sh eller System → Säkerhetskopiering."
  exit 1
fi
if [ ! -f "$FILE" ]; then
  echo "FEL: hittar inte filen: $FILE"
  exit 1
fi

if [ "${2:-}" != "--yes" ]; then
  echo "VARNING: detta RADERAR allt i databasen '${DB_NAME}' (container '${CONTAINER}')"
  echo "och ersätter innehållet med: ${FILE}"
  read -r -p "Skriv ÅTERSTÄLL för att fortsätta: " confirm
  if [ "$confirm" != "ÅTERSTÄLL" ]; then
    echo "Avbrutet."
    exit 1
  fi
fi

# Both schemas, not just public: the dump is a plain `pg_dump <db>` and so
# carries drizzle.__drizzle_migrations too. Leaving the drizzle schema behind
# makes the restore abort on "schema drizzle already exists" under
# ON_ERROR_STOP — which is what happens whenever the target has been migrated
# before, and the api container migrates on start. IF EXISTS because older
# installs may predate the drizzle schema.
echo "$(date -Is) Rensar schemana i '${DB_NAME}'…"
$DOCKER exec -i "$CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 \
  -c "DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public;"

echo "$(date -Is) Återställer från ${FILE}…"
gunzip -c "$FILE" | $DOCKER exec -i "$CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 >/dev/null

echo "$(date -Is) OK: databasen '${DB_NAME}' återställd. Starta om vid behov: docker compose restart api web"

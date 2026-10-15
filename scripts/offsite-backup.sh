#!/usr/bin/env bash
# Krypterad extern säkerhetskopia av Nav-ERP (bokföringslagen 7 kap.).
#
# Räkenskapsinformationen ska bevaras på ett betryggande sätt i 7 år efter
# utgången av det kalenderår då räkenskapsåret avslutades. Den lokala nattliga
# dumpen (scripts/backup-db.sh) ligger på samma disk som databasen och gallras
# efter 30 dagar — det här skriptet lägger en gpg-krypterad kopia (AES-256) på
# ett eller flera rclone-mål utanför servern.
#
#   offsite-backup.sh              daglig kopia (cron); första körningen varje
#                                  månad sparas även som månadskopia
#   offsite-backup.sh arkiv ÅÅÅÅ   årsarkiv: full dump + SIE 4-fil för
#                                  räkenskapsåret ÅÅÅÅ — raderas aldrig
#
# Struktur per mål:  <mål>/daglig/ÅÅÅÅ-MM-DD/   sparas DAILY_DAYS dagar
#                    <mål>/manad/ÅÅÅÅ-MM/       sparas MONTHLY_YEARS år
#                    <mål>/arkiv/ÅÅÅÅ/          raderas aldrig
#
# Inställningar: ~/.config/nav-erp-backup/config (skapas av
# scripts/offsite-backup-setup.sh). Återställning: scripts/offsite-restore.sh.
# Varje fil har en .sha256 bredvid sig (kontrollsumma för den krypterade filen).
set -uo pipefail

CONFIG="${NAV_ERP_BACKUP_CONFIG:-$HOME/.config/nav-erp-backup/config}"
if [ ! -r "$CONFIG" ]; then
  echo "$(date -Is) FEL: konfigurationen $CONFIG saknas — kör scripts/offsite-backup-setup.sh" >&2
  exit 2
fi
# shellcheck source=/dev/null
source "$CONFIG"
: "${REMOTES:?REMOTES saknas i $CONFIG}"
: "${PASSPHRASE_FILE:?PASSPHRASE_FILE saknas i $CONFIG}"
REPO_DIR="${REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
DB_NAME="${DB_NAME:-erp}"
DB_USER="${DB_USER:-erp}"
DAILY_DAYS="${DAILY_DAYS:-30}"
MONTHLY_YEARS="${MONTHLY_YEARS:-8}"
RCLONE="${RCLONE:-rclone}"
export PATH="$HOME/.local/bin:$PATH"

MODE="${1:-daglig}"
YEAR="${2:-}"
if [ "$MODE" = "arkiv" ] && ! [[ "$YEAR" =~ ^[0-9]{4}$ ]]; then
  echo "Användning: $0 arkiv ÅÅÅÅ" >&2
  exit 2
elif [ "$MODE" != "daglig" ] && [ "$MODE" != "arkiv" ]; then
  echo "Användning: $0 [daglig | arkiv ÅÅÅÅ]" >&2
  exit 2
fi

log() { echo "$(date -Is) $*"; }
if [ ! -r "$PASSPHRASE_FILE" ]; then
  log "FEL: lösenfrasfilen $PASSPHRASE_FILE saknas eller går inte att läsa"
  exit 2
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
STAMP="$(date +%Y-%m-%d_%H%M)"

# `docker compose` through the SERVICE name (never a hardcoded container name);
# `sg docker` because cron shells don't get the docker group membership —
# same as scripts/backup-db.sh.
compose_exec() {
  if [ -n "${ERP_PG_CONTAINER:-}" ]; then
    sg docker -c "docker exec ${ERP_PG_CONTAINER} $*"
  else
    sg docker -c "docker compose --project-directory ${REPO_DIR} exec -T postgres $*"
  fi
}

encrypt() { # <in> <out>
  gpg --batch --yes --quiet --pinentry-mode loopback --passphrase-file "$PASSPHRASE_FILE" \
    --symmetric --cipher-algo AES256 --output "$2" "$1"
}

# 1. Dump → gzip → verify it is complete → encrypt.
DUMP="$TMP/nav-erp-$STAMP.sql.gz"
if ! compose_exec "pg_dump -U ${DB_USER} ${DB_NAME}" | gzip >"$DUMP"; then
  log "FEL: pg_dump misslyckades — ingen säkerhetskopia gjord"
  exit 1
fi
# pg_dump ends a finished dump with this line — a truncated stream lacks it.
if ! gzip -dc "$DUMP" | tail -n 5 | grep -q "PostgreSQL database dump complete"; then
  log "FEL: dumpen är ofullständig — ingen säkerhetskopia gjord"
  exit 1
fi
FILES=("$DUMP")

# 2. Årsarkiv: also the SIE 4 file for the fiscal year — an open standard
#    that stays readable for seven years without PostgreSQL.
if [ "$MODE" = "arkiv" ]; then
  SIE="$TMP/nav-erp-$YEAR.se"
  if ! "$REPO_DIR/scripts/lib/export-sie.sh" "$YEAR" "$SIE"; then
    log "FEL: kunde inte exportera SIE-filen för $YEAR — inget årsarkiv gjort"
    exit 1
  fi
  FILES+=("$SIE")
fi

ENCRYPTED=()
for f in "${FILES[@]}"; do
  if ! encrypt "$f" "$f.gpg"; then
    log "FEL: krypteringen av $(basename "$f") misslyckades"
    exit 1
  fi
  (cd "$(dirname "$f")" && sha256sum "$(basename "$f").gpg" >"$(basename "$f").gpg.sha256")
  ENCRYPTED+=("$f.gpg" "$f.gpg.sha256")
done

# 3. Upload to every target. rclone verifies size/checksum of each transfer;
#    one failing target doesn't stop the others, but fails the run.
FAILED=0
TODAY="$(date +%Y-%m-%d)"
MONTH="$(date +%Y-%m)"
for remote in $REMOTES; do
  if [ "$MODE" = "arkiv" ]; then
    dests=("$remote/arkiv/$YEAR")
  else
    dests=("$remote/daglig/$TODAY")
    # First run of the month also becomes that month's copy.
    if ! "$RCLONE" lsf "$remote/manad/$MONTH" 2>/dev/null | grep -q .; then
      dests+=("$remote/manad/$MONTH")
    fi
  fi
  for dest in "${dests[@]}"; do
    ok=1
    for f in "${ENCRYPTED[@]}"; do
      "$RCLONE" copyto "$f" "$dest/$(basename "$f")" || ok=0
    done
    if [ "$ok" = 1 ]; then
      log "OK: $dest ($(du -ch "${ENCRYPTED[@]}" | tail -1 | cut -f1))"
    else
      log "FEL: uppladdningen till $dest misslyckades"
      FAILED=1
    fi
  done

  # 4. Prune — never under arkiv/.
  if [ "$MODE" = "daglig" ]; then
    cutoff_day="$(date -d "-${DAILY_DAYS} days" +%Y-%m-%d)"
    for dir in $("$RCLONE" lsf --dirs-only "$remote/daglig" 2>/dev/null); do
      d="${dir%/}"
      if [[ "$d" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] && [[ "$d" < "$cutoff_day" ]]; then
        "$RCLONE" purge "$remote/daglig/$d" && log "rensade $remote/daglig/$d"
      fi
    done
    cutoff_month="$(date -d "-${MONTHLY_YEARS} years" +%Y-%m)"
    for dir in $("$RCLONE" lsf --dirs-only "$remote/manad" 2>/dev/null); do
      m="${dir%/}"
      if [[ "$m" =~ ^[0-9]{4}-[0-9]{2}$ ]] && [[ "$m" < "$cutoff_month" ]]; then
        "$RCLONE" purge "$remote/manad/$m" && log "rensade $remote/manad/$m"
      fi
    done
  fi
done

exit "$FAILED"

#!/usr/bin/env bash
# Hämtar och dekrypterar Nav-ERP:s externa säkerhetskopior (offsite-backup.sh).
#
#   offsite-restore.sh lista                 visar kopiorna på varje mål
#   offsite-restore.sh hämta <fil> [katalog] laddar ner en .gpg-fil (sökväg på
#                                            målet, t.ex. gdrive:Nav-ERP/daglig/
#                                            2026-10-06/nav-erp-….sql.gz.gpg),
#                                            kontrollerar summan och dekrypterar
#   offsite-restore.sh verifiera             provåterställer senaste dagliga
#                                            kopian: hämtar, kontrollerar summan,
#                                            dekrypterar och testar dumpen
#
# En dekrypterad .sql.gz läses in med scripts/restore-db.sh (ERSÄTTER allt i
# databasen). En .se-fil (årsarkivets SIE 4) läses in i valfritt
# bokföringsprogram — eller i Nav-ERP under Ekonomi → SIE.
set -uo pipefail

CONFIG="${NAV_ERP_BACKUP_CONFIG:-$HOME/.config/nav-erp-backup/config}"
if [ ! -r "$CONFIG" ]; then
  echo "FEL: konfigurationen $CONFIG saknas — kör scripts/offsite-backup-setup.sh" >&2
  exit 2
fi
# shellcheck source=/dev/null
source "$CONFIG"
: "${REMOTES:?REMOTES saknas i $CONFIG}"
: "${PASSPHRASE_FILE:?PASSPHRASE_FILE saknas i $CONFIG}"
RCLONE="${RCLONE:-rclone}"
export PATH="$HOME/.local/bin:$PATH"

log() { echo "$(date -Is) $*"; }

fetch() { # <remote-path-to-.gpg> <dir> → prints the decrypted file's path
  local src="$1" dir="$2" name
  name="$(basename "$src")"
  "$RCLONE" copyto "$src" "$dir/$name" || return 1
  if "$RCLONE" copyto "$src.sha256" "$dir/$name.sha256" 2>/dev/null; then
    (cd "$dir" && sha256sum --quiet -c "$name.sha256") || { echo "FEL: kontrollsumman stämmer inte för $name" >&2; return 1; }
  else
    echo "VARNING: ingen .sha256 hittades för $name — hoppar över kontrollen" >&2
  fi
  gpg --batch --yes --quiet --pinentry-mode loopback --passphrase-file "$PASSPHRASE_FILE" \
    --decrypt --output "$dir/${name%.gpg}" "$dir/$name" || { echo "FEL: dekrypteringen misslyckades" >&2; return 1; }
  rm -f "$dir/$name" "$dir/$name.sha256"
  echo "$dir/${name%.gpg}"
}

case "${1:-}" in
  lista)
    for remote in $REMOTES; do
      echo "== $remote"
      for kind in daglig manad arkiv; do
        echo "-- $kind"
        "$RCLONE" lsf -R --files-only "$remote/$kind" 2>/dev/null | grep '\.gpg$' | sort | sed "s|^|   $remote/$kind/|"
      done
    done
    ;;
  hämta)
    [ -n "${2:-}" ] || { echo "Användning: $0 hämta <fil på målet> [katalog]" >&2; exit 2; }
    dir="${3:-.}"
    mkdir -p "$dir"
    out="$(fetch "$2" "$dir")" || exit 1
    echo "Klar: $out"
    case "$out" in
      *.sql.gz) echo "Läs in med: scripts/restore-db.sh \"$out\"" ;;
    esac
    ;;
  verifiera)
    remote="${REMOTES%% *}"
    latest="$("$RCLONE" lsf --dirs-only "$remote/daglig" 2>/dev/null | sort | tail -1)"
    [ -n "$latest" ] || { log "FEL: inga dagliga kopior på $remote"; exit 1; }
    file="$("$RCLONE" lsf --files-only "$remote/daglig/$latest" | grep '\.sql\.gz\.gpg$' | sort | tail -1)"
    [ -n "$file" ] || { log "FEL: ingen dump i $remote/daglig/$latest"; exit 1; }
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    out="$(fetch "$remote/daglig/$latest$file" "$tmp")" || { log "FEL: provåterställningen misslyckades ($latest$file)"; exit 1; }
    if gzip -t "$out" && gzip -dc "$out" | tail -n 5 | grep -q "PostgreSQL database dump complete"; then
      log "OK: provåterställning av $remote/daglig/$latest$file ($(gzip -dc "$out" | wc -c | numfmt --to=iec) okomprimerat)"
    else
      log "FEL: dumpen $latest$file är skadad eller ofullständig"
      exit 1
    fi
    ;;
  *)
    sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac

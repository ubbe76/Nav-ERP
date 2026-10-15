#!/usr/bin/env bash
# Sätter upp Nav-ERP:s krypterade externa säkerhetskopia från grunden:
#   1. kontrollerar att gpg och rclone finns
#   2. väljer (eller skapar, via `rclone config`) ett eller flera mål
#   3. skapar lösenfrasen som krypterar kopiorna
#   4. skriver ~/.config/nav-erp-backup/config
#   5. lägger in cron: daglig kopia 03:15, provåterställning den 1:a varje månad
#   6. kör valfritt en första kopia + provåterställning direkt
#
# Kan köras om när som helst — t.ex. för att byta eller lägga till mål; en
# befintlig lösenfras behålls alltid (gamla kopior går annars inte att läsa).
set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_DIR="$HOME/.config/nav-erp-backup"
CONFIG="$CONFIG_DIR/config"
PASSPHRASE_FILE="$CONFIG_DIR/passphrase"
LOG_DIR="${NAV_ERP_BACKUP_LOG_DIR:-$HOME/backups/nav-erp}"
export PATH="$HOME/.local/bin:$PATH"

ask() { # <fråga> <standard> → svar
  local answer
  read -r -p "$1 [$2]: " answer
  echo "${answer:-$2}"
}

echo "== Nav-ERP: krypterad extern säkerhetskopia"
echo

# 1. Beroenden
for tool in gpg rclone; do
  if ! command -v "$tool" >/dev/null; then
    echo "FEL: $tool saknas."
    [ "$tool" = rclone ] && echo "  Installera utan sudo: curl -fsSL https://rclone.org/install.sh | bash -s beta  (eller se https://rclone.org/downloads/)"
    [ "$tool" = gpg ] && echo "  Installera: sudo apt install gnupg"
    exit 1
  fi
done
echo "gpg och rclone finns."

# 2. Mål
echo
echo "Befintliga rclone-mål:"
rclone listremotes | sed 's/^/  /' || true
echo
echo "Välj ett befintligt mål ovan, eller skriv 'ny' för att skapa ett med rclone config"
echo "(t.ex. en svensk/EU-molntjänst via S3 eller WebDAV, en NAS via SFTP, eller Google Drive)."
echo "OBS: räkenskapsinformation ska förvaras i Sverige — elektronisk förvaring i ett annat"
echo "EU-land kräver anmälan till Skatteverket, utanför EU tillstånd. Stäm av med revisorn."
REMOTES_LIST=""
while :; do
  name="$(ask "Mål (namn utan kolon, 'ny' eller tomt för klart)" "")"
  [ -z "$name" ] && break
  if [ "$name" = "ny" ]; then
    rclone config
    continue
  fi
  name="${name%:}"
  if ! rclone listremotes | grep -qx "$name:"; then
    echo "  Hittar inget mål som heter $name — försök igen."
    continue
  fi
  folder="$(ask "  Mapp på $name" "Nav-ERP-backup")"
  if ! rclone mkdir "$name:$folder"; then
    echo "  Kunde inte skapa $name:$folder — kontrollera målet."
    continue
  fi
  REMOTES_LIST="${REMOTES_LIST:+$REMOTES_LIST }$name:$folder"
  echo "  Tillagt: $name:$folder"
done
if [ -z "$REMOTES_LIST" ]; then
  # Re-running without picking anything keeps the current targets.
  if [ -r "$CONFIG" ]; then
    # shellcheck source=/dev/null
    REMOTES_LIST="$(. "$CONFIG"; echo "${REMOTES:-}")"
  fi
  [ -n "$REMOTES_LIST" ] || { echo "FEL: inget mål valt."; exit 1; }
  echo "Behåller nuvarande mål: $REMOTES_LIST"
fi

# 3. Lösenfras
mkdir -p "$CONFIG_DIR"
chmod 700 "$CONFIG_DIR"
if [ -s "$PASSPHRASE_FILE" ]; then
  echo
  echo "Befintlig lösenfras behålls ($PASSPHRASE_FILE)."
else
  umask 077
  openssl rand -base64 48 | tr -d '\n' >"$PASSPHRASE_FILE"
  chmod 600 "$PASSPHRASE_FILE"
  echo
  echo "================================================================================"
  echo " NY LÖSENFRAS — spara den i en lösenordshanterare eller ett kassaskåp NU:"
  echo
  echo "   $(cat "$PASSPHRASE_FILE")"
  echo
  echo " Utan den går kopiorna INTE att läsa. Den ligger också i $PASSPHRASE_FILE,"
  echo " men den filen försvinner om servern gör det."
  echo "================================================================================"
  read -r -p "Tryck Enter när lösenfrasen är sparad på annat ställe … " _
fi

# 4. Inställningar
DAILY_DAYS="$(ask "Hur många dagar ska dagliga kopior sparas" "30")"
MONTHLY_YEARS="$(ask "Hur många år ska månadskopior sparas (minst 8 för 7 år efter årets slut)" "8")"
umask 077
cat >"$CONFIG" <<EOF
# Nav-ERP — krypterad extern säkerhetskopia. Skapad av offsite-backup-setup.sh
# $(date -Is). Mål separeras med mellanslag (rclone-sökvägar).
REMOTES="$REMOTES_LIST"
PASSPHRASE_FILE="$PASSPHRASE_FILE"
DAILY_DAYS=$DAILY_DAYS
MONTHLY_YEARS=$MONTHLY_YEARS
REPO_DIR="$REPO_DIR"
EOF
chmod 600 "$CONFIG"
echo "Skrev $CONFIG"

# 5. Cron — replace any earlier Nav-ERP offsite lines, keep everything else.
mkdir -p "$LOG_DIR"
DAILY_LINE="15 3 * * * $REPO_DIR/scripts/offsite-backup.sh >> $LOG_DIR/offsite.log 2>&1 # Nav-ERP: krypterad extern backup (BFL 7 kap.)"
VERIFY_LINE="0 5 1 * * $REPO_DIR/scripts/offsite-restore.sh verifiera >> $LOG_DIR/offsite.log 2>&1 # Nav-ERP: månatlig provåterställning"
if [ "$(ask "Lägga in cron (daglig kopia 03:15 + provåterställning den 1:a varje månad)?" "j")" = "j" ]; then
  { crontab -l 2>/dev/null | grep -v "scripts/offsite-backup.sh\|scripts/offsite-restore.sh verifiera"; echo "$DAILY_LINE"; echo "$VERIFY_LINE"; } | crontab -
  echo "Cron inlagt. Logg: $LOG_DIR/offsite.log"
fi

# 6. Första kopia
if [ "$(ask "Köra en första kopia och en provåterställning nu?" "j")" = "j" ]; then
  "$REPO_DIR/scripts/offsite-backup.sh" && "$REPO_DIR/scripts/offsite-restore.sh" verifiera
fi

echo
echo "Klart. Efter varje årsbokslut: kör"
echo "  $REPO_DIR/scripts/offsite-backup.sh arkiv ÅÅÅÅ"
echo "för att lägga räkenskapsårets SIE-fil och en full dump i arkiv/ÅÅÅÅ (raderas aldrig)."

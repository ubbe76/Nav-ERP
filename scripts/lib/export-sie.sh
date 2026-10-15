#!/usr/bin/env bash
# Exporterar SIE 4-filen för räkenskapsåret med etiketten ÅÅÅÅ via det körande
# API:t (GET /api/v1/sie/export) — samma fil som Ekonomi → SIE laddar ner.
# Används av offsite-backup.sh arkiv ÅÅÅÅ.
#
#   export-sie.sh ÅÅÅÅ <målfil>
#
# Autentiserar med en kortlivad (5 min) token för systemets första aktiva
# administratör, signerad med serverns JWT_SECRET ur .env — ingen inloggning
# eller sparat lösenord behövs. API:t nås på localhost:${API_PORT:-4000}.
set -uo pipefail

YEAR="${1:-}"
OUT="${2:-}"
if ! [[ "$YEAR" =~ ^[0-9]{4}$ ]] || [ -z "$OUT" ]; then
  echo "Användning: $0 ÅÅÅÅ <målfil>" >&2
  exit 2
fi

REPO_DIR="${REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
ENV_FILE="$REPO_DIR/.env"
envval() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//'; }
JWT_SECRET="$(envval JWT_SECRET)"
API_PORT="$(envval API_PORT)"
API="http://localhost:${API_PORT:-4000}/api/v1"
if [ -z "$JWT_SECRET" ]; then
  echo "FEL: JWT_SECRET saknas i $ENV_FILE" >&2
  exit 1
fi

ADMIN_ID="$(sg docker -c "docker compose --project-directory ${REPO_DIR} exec -T postgres psql -U ${DB_USER:-erp} -d ${DB_NAME:-erp} -tAc \"select id from users where role = 'admin' and active order by created_at limit 1\"" | tr -d '[:space:]')"
if [ -z "$ADMIN_ID" ]; then
  echo "FEL: hittar ingen aktiv administratör att exportera som" >&2
  exit 1
fi

TOKEN="$(cd "$REPO_DIR" && SECRET="$JWT_SECRET" SUB="$ADMIN_ID" node -e '
  const jwt = require("jsonwebtoken");
  process.stdout.write(jwt.sign({ sub: process.env.SUB, role: "admin" }, process.env.SECRET, { expiresIn: "5m" }));
')"
if [ -z "$TOKEN" ]; then
  echo "FEL: kunde inte skapa token (finns node och node_modules i $REPO_DIR?)" >&2
  exit 1
fi

FY_ID="$(curl -fsS -H "cookie: session=$TOKEN" "$API/fiscal-years" | YEAR="$YEAR" node -e '
  let s = ""; process.stdin.on("data", (c) => (s += c)).on("end", () => {
    const years = JSON.parse(s);
    const list = Array.isArray(years) ? years : years.rows ?? [];
    const fy = list.find((y) => y.label === process.env.YEAR);
    process.stdout.write(fy ? fy.id : "");
  });
')"
if [ -z "$FY_ID" ]; then
  echo "FEL: inget räkenskapsår med etiketten $YEAR" >&2
  exit 1
fi

if ! curl -fsS -H "cookie: session=$TOKEN" -o "$OUT" "$API/sie/export?fiscalYearId=$FY_ID"; then
  echo "FEL: SIE-exporten för $YEAR misslyckades" >&2
  rm -f "$OUT"
  exit 1
fi
# A SIE file always opens with #FLAGGA.
if ! head -c 200 "$OUT" | grep -aq "#FLAGGA"; then
  echo "FEL: svaret är ingen SIE-fil" >&2
  exit 1
fi

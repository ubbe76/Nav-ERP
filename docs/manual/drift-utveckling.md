# Drift & utveckling

Det här kapitlet riktar sig till den som driftar eller utvecklar Nav ERP — inte till den dagliga användaren. Fullständig teknisk dokumentation finns i projektets `README.md` och `docs/architecture.md`.

## Projektstruktur

Systemet är ett monorepo med tre delar:

- `apps/api` — REST-API:t (Fastify), en modul per område med `routes/`, `service/` och `repository/`.
- `apps/web` — webbgränssnittet (Next.js).
- `packages/db` och `packages/shared` — databasschema med migrationer (Drizzle) respektive delade typer och valideringsscheman.

Källan till sanning för databasschemat är migrationerna i `packages/db/drizzle/` — schemat ändras aldrig manuellt i databasen.

## Den här manualen

Manualen ligger som markdown i `docs/manual/` (svenska, ett kapitel per fil) och versionshanteras med koden. Den renderas i appen under **Hjälp** (`/hjalp`), och hjälpknapparna (**?**) på rutinsidorna länkar till respektive avsnitt. När en rutin eller inställning ändras uppdateras motsvarande kapitel i samma commit som funktionen.

## Tester

```bash
npm run test
```

Testerna i `apps/api` kör mot en riktig Postgres-instans i stället för att mocka databasen — lagerlogiken (append-only) och statusflödena är projektets känsligaste delar och testas på riktigt.

**Varning:** testerna **tömmer tabellerna** (TRUNCATE) i databasen som `DATABASE_URL` pekar på. `npm run test` kör därför som standard mot en separat testcontainer, `postgres-test` (databasen `erp_test` på port 5433, data i minnet), aldrig mot den databas som innehåller riktiga data. Starta den först:

```bash
docker compose --profile test up -d postgres-test
```

Containern töms när den startas om, och testkörningen sköter schemat själv, så nya migrationer behöver aldrig köras för hand. Kör bara en testkörning åt gången.

GitHub kör samma tester automatiskt vid varje ändring som skickas till projektet, tillsammans med en typkontroll och ett bygge av API:t och webben.

För att skydda mot misstag avbryts hela körningen om databasnamnet inte innehåller "test", med felmeddelandet *"Testerna TRUNCATE:ar databasen de körs mot…"*. Får du det: sätt `DATABASE_URL` till testdatabasen — ändra aldrig spärren för att komma förbi den. `npm run test` använder testdatabasen automatiskt.

Skulle data ändå gå förlorad och användartabellen bli tom, öppnas registreringssidan `/register` igen och första kontot du skapar där blir administratör — med engångskoden ur API:ts logg (se [Komma igång](/hjalp/komma-igang)).

## Backup

Databasen dumpas varje natt av `scripts/backup-db.sh`, som körs via cron:

```
30 2 * * * /sökväg/till/Nav-ERP/scripts/backup-db.sh >> "$HOME/backups/nav-erp/backup.log" 2>&1
```

- Dumparna hamnar i `~/backups/nav-erp/` (i hemkatalogen för användaren som kör skriptet) som `erp-ÅÅÅÅ-MM-DD_TTMM.sql.gz` och sparas i **30 dagar** (äldre rensas automatiskt).
- Varje körning loggas i `backup.log` med tid, filnamn och storlek — kontrollera den ibland; en misslyckad dump skriver `FEL:` och lämnar ingen halvfärdig fil efter sig.
- Katalog, retention och databasnamn kan styras med miljövariablerna `ERP_BACKUP_DIR`, `ERP_BACKUP_RETENTION_DAYS` och `ERP_DB_NAME`.

**Ladda ner en kopia på begäran:** en administratör kan när som helst hämta en färsk, komplett dump via **System → Säkerhetskopiering** i webbgränssnittet (samma `.sql.gz`-format) — praktiskt inför en riskabel ändring eller för att flytta systemet.

Återställ en dump med `scripts/restore-db.sh` (rensar databasen och läser in dumpen, efter bekräftelse — skriv `ÅTERSTÄLL`):

```bash
scripts/restore-db.sh ~/backups/nav-erp/erp-2026-07-20_0230.sql.gz
```

Eller manuellt — rensa då schemana först, annars stannar inläsningen på att tabellerna redan finns (det är just detta skriptet gör åt dig):

```bash
docker compose exec -T postgres psql -U erp -d erp \
  -c 'DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public;'
gunzip -c ~/backups/nav-erp/erp-2026-07-20_0230.sql.gz | docker compose exec -T postgres psql -U erp -d erp
```

Både `public` och `drizzle` måste bort: dumpen innehåller migrationsjournalen `drizzle.__drizzle_migrations`, och den skapas numera redan när `api`-containern startar.

Vill du bara titta i en dump utan att röra driften — återställ den i en engångsdatabas i stället (`CREATE DATABASE erp_kontroll;` och kör `ERP_DB_NAME=erp_kontroll scripts/restore-db.sh <fil> --yes`).

Observera att backupen täcker **databasen**, som innehåller allt inklusive uppladdade ritningar, underlag och arkiverade fakturor samt företagslogotyp. Själva volymen `erp_postgres_data` säkerhetskopieras inte separat.

### Krypterad extern backup (bokföringslagen)

Den nattliga dumpen ligger på **samma disk** som databasen och sparas bara 30 dagar — den skyddar mot misstag, inte mot en trasig disk, brand eller stöld. Bokföringslagen (7 kap.) kräver att räkenskapsinformationen bevaras **på ett betryggande sätt i 7 år** efter utgången av det kalenderår då räkenskapsåret avslutades. Därför finns en krypterad kopia utanför servern, byggd på `rclone` (valfri lagringstjänst) och `gpg` (AES-256):

| Mapp på målet | Innehåll | Sparas |
|---|---|---|
| `daglig/ÅÅÅÅ-MM-DD/` | krypterad dump, varje natt 03:15 | 30 dagar (`DAILY_DAYS`) |
| `manad/ÅÅÅÅ-MM/` | månadens första dagliga kopia | 8 år (`MONTHLY_YEARS`) |
| `arkiv/ÅÅÅÅ/` | räkenskapsårets **SIE 4-fil** + full dump | raderas aldrig |

Varje fil har en `.sha256`-fil bredvid sig. **Sätt upp från grunden** med

```bash
scripts/offsite-backup-setup.sh
```

som kontrollerar att `gpg` och `rclone` finns, låter dig välja ett eller flera befintliga rclone-mål — eller skapa ett nytt med `rclone config` (t.ex. en svensk/EU-molntjänst via S3 eller WebDAV, en NAS via SFTP eller Google Drive) — skapar **lösenfrasen** som krypterar kopiorna, skriver `~/.config/nav-erp-backup/config`, lägger in cron (daglig kopia + **provåterställning** den 1:a varje månad) och kör valfritt en första kopia och provåterställning direkt. Skriptet kan köras om när som helst för att byta eller lägga till mål; en befintlig lösenfras behålls.

**Lösenfrasen visas en gång vid installationen — spara den i en lösenordshanterare eller ett kassaskåp.** Utan den går kopiorna inte att läsa, och kopian på servern försvinner med servern.

**Förvaringsort:** huvudregeln är att räkenskapsinformation förvaras i Sverige. Elektronisk förvaring i ett annat EU-land kräver anmälan till Skatteverket, utanför EU krävs tillstånd. Välj en lagring i Sverige/EU eller stäm av med revisorn.

Övrigt:

- **Årsarkiv** efter varje årsbokslut: `scripts/offsite-backup.sh arkiv 2026` lägger räkenskapsårets SIE 4-fil (ett öppet standardformat som går att läsa utan PostgreSQL om sju år) och en full dump i `arkiv/2026/`. Etiketten är räkenskapsårets namn i **Ekonomi → Räkenskapsår**.
- **Lista och hämta:** `scripts/offsite-restore.sh lista` visar kopiorna; `scripts/offsite-restore.sh hämta <fil> [katalog]` laddar ner, kontrollerar summan och dekrypterar — en `.sql.gz` läses sedan in med `scripts/restore-db.sh` som ovan.
- **Provåterställning:** `scripts/offsite-restore.sh verifiera` hämtar senaste dagliga kopian, kontrollerar summan, dekrypterar och testar att dumpen är komplett. Körs automatiskt varje månad; resultatet hamnar i `~/backups/nav-erp/offsite.log` (`OK:`/`FEL:`).

## Windows

Systemet kan köras på en Windows-dator med **Docker Desktop** och WSL 2 — samma containrar som på en Linux-server. Windows är inte testat i projektet, så se det som ett alternativ för utvärdering eller en mindre installation. Installationsstegen står i README:n under *Köra på Windows*.

- Lägg repot inne i WSL (t.ex. `~/Nav-ERP` i Ubuntu-terminalen), inte under `C:\`.
- Backup- och återställningsskripten ovan är bash-skript och körs i WSL-terminalen. Den nattliga dumpen schemaläggs med cron inne i WSL eller med Windows Schemaläggaren (`wsl bash ~/Nav-ERP/scripts/backup-db.sh`).
- **Ladda ner en kopia på begäran** under **System → Säkerhetskopiering** fungerar som vanligt i webbläsaren.
- Datorn måste vara igång för att systemet ska nås.

## Tekniska begränsningar

- **Formulärens rullistor hämtar högst 1000 poster.** Registerlistorna (artiklar, kunder, ordrar …) söker och bläddrar serversidigt och skalar till tusentals poster, och artikelval görs med den sökbara artikelväljaren — men vissa rullistor i formulär (kund- och leverantörsval, ordervalen i Inleverans/Utleverans, orderlistan i stämpelterminalen) hämtar fortfarande hela registret upp till 1000 poster. Växer ett register förbi det behöver rullistan ersättas med en sökbar väljare.
- **Rapporterna ligger på två ställen.** Menyvalet **Rapporter** samlar de analyserande rapporterna (leveransprecision, statistik, kassation, kalkylutfall), medan de ekonomiska rapporterna (Balansräkning, Resultaträkning, Momsrapport) hör till bokföringen och nås från **Ekonomi**. Avancerad kapacitetsplanering ingår medvetet inte i v1 — **Beläggning** under **Planering** visar last mot schemalagd kapacitet, men schemalägger inte operationer åt dig.

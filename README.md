<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://github.com/ubbe76/Nav-ERP/raw/main/docs/assets/nav-erp-logo-dark.svg">
    <img src="https://github.com/ubbe76/Nav-ERP/raw/main/docs/assets/nav-erp-logo.svg" alt="nav | ERP" width="340">
  </picture>

  <p>
    <img alt="Licens: GPL-3.0-or-later" src="https://img.shields.io/badge/licens-GPL--3.0--or--later-2e9e6b">
    <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-3178c6">
    <img alt="Node.js ≥ 20" src="https://img.shields.io/badge/Node.js-%E2%89%A5%2020-339933">
    <img alt="PostgreSQL 16" src="https://img.shields.io/badge/PostgreSQL-16-336791">
  </p>
</div>

> [!WARNING]
> **Nav|ERP är inte redo för produktion.** Systemet är under aktiv utveckling
> och har inte prövats i skarp drift. Datamodell, API och arbetsflöden kan
> ändras utan förvarning, och det finns ingen stabil version att uppgradera
> från. Använd det inte för riktig bokföring, lön, fakturering eller
> lagerhållning ännu — prova det med exempeldata.

Ett öppet källkod-ERP för mindre/medelstora svenska tillverkande företag.
Byggt för att täcka kärnflödet **artikel → lager → inköp/försäljning →
tillverkningsorder → tidrapportering → kalkyl**.

Se [`docs/architecture.md`](docs/architecture.md) för full kravspecifikation,
datamodell och statusflöden, och [`CLAUDE.md`](CLAUDE.md) för
utvecklingskonventioner.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://github.com/ubbe76/Nav-ERP/raw/main/docs/assets/screenshot-dashboard-dark.png">
  <img src="https://github.com/ubbe76/Nav-ERP/raw/main/docs/assets/screenshot-dashboard.png" alt="Översikt-dashboarden i nav | ERP">
</picture>

### Fler vyer och teman

Webben har tre färgteman — **Ljust**, **Mörkt** och **Dracula** — som väljs
uppe till höger och sparas per webbläsare. Bilderna visar påhittade
exempeldata. Klicka på en bild för full storlek.

<table>
  <tr>
    <td width="50%">
      <a href="https://github.com/ubbe76/Nav-ERP/raw/main/docs/assets/screenshot-dashboard-dracula.png"><img src="https://github.com/ubbe76/Nav-ERP/raw/main/docs/assets/screenshot-dashboard-dracula.png" alt="Översikten i temat Dracula"></a>
      <br><sub><b>Översikt</b> i temat Dracula</sub>
    </td>
    <td width="50%">
      <a href="https://github.com/ubbe76/Nav-ERP/raw/main/docs/assets/screenshot-article.png"><img src="https://github.com/ubbe76/Nav-ERP/raw/main/docs/assets/screenshot-article.png" alt="Artikelkortets flik Beredning med artikelträd och rutt"></a>
      <br><sub><b>Artikelkortet</b> — fliken Beredning med struktur och rutt</sub>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <a href="https://github.com/ubbe76/Nav-ERP/raw/main/docs/assets/screenshot-manufacturing-orders-dark.png"><img src="https://github.com/ubbe76/Nav-ERP/raw/main/docs/assets/screenshot-manufacturing-orders-dark.png" alt="Listan över tillverkningsorder i mörkt tema"></a>
      <br><sub><b>Tillverkningsorder</b> i mörkt tema</sub>
    </td>
    <td width="50%">
      <a href="https://github.com/ubbe76/Nav-ERP/raw/main/docs/assets/screenshot-article-overview-dracula.png"><img src="https://github.com/ubbe76/Nav-ERP/raw/main/docs/assets/screenshot-article-overview-dracula.png" alt="Artikelöversikten med behov, inkommande och disponibelt i temat Dracula"></a>
      <br><sub><b>Artikelöversikten</b> — behov och inkommande med löpande disponibelt, i Dracula</sub>
    </td>
  </tr>
</table>

## Teknikstack

| Del | Teknik |
|---|---|
| Runtime | Node.js (LTS) + TypeScript (`strict`) |
| Databas | PostgreSQL 16 |
| ORM | Drizzle ORM |
| API | Fastify (`apps/api`) |
| Frontend | Next.js App Router (`apps/web`) |
| Validering | Zod (`packages/shared`) |
| Containerisering | Docker + Docker Compose |
| Tester | Vitest |

## Projektstruktur

```
apps/
├── api/            # Fastify REST-API (/api/v1), moduler i routes/service/repository
└── web/            # Next.js-frontend, designtokens + UI-komponenter
packages/
├── db/             # Drizzle-schema, migrationer, delad DB-klient
└── shared/         # Zod-scheman & delade typer
db/
└── schema_phase1.sql   # Referensschema (dokumentation, ej källa till sanning)
docs/
├── architecture.md     # Full kravspec, datamodell, statusflöden, faser
└── manual/             # Användarmanualen (svenska, ett kapitel per fil) — renderas i appen på /hjalp
```

Källan till sanning för databasschemat är Drizzle-migrationerna i
`packages/db/drizzle/`, inte `db/schema_phase1.sql`.

## Komma igång

Det finns två sätt att köra projektet på, beroende på om du utvecklar eller
bara vill driftsätta/testa det:

- **Bara Docker** (t.ex. en VPS): du behöver **inte** installera Node.js
  eller PostgreSQL på maskinen alls — allt körs i containrar, inklusive
  databasen. Se [Driftsätta på en annan server](#driftsätta-på-en-annan-server-tex-en-vps)
  nedan.
- **Lokal utveckling**: Node.js ≥ 20 på värdmaskinen + Docker (för att köra
  Postgres i en container medan `api`/`web` körs direkt med `npm run dev:*`
  för snabbare omstart/felsökning). Det är detta avsnittet nedan beskriver.

### Förutsättningar (lokal utveckling)
- Node.js ≥ 20
- Docker + Docker Compose

### Installation

```bash
cp .env.example .env
npm install
```

Fyll sedan i de två obligatoriska värdena i `.env` — Docker Compose vägrar
starta något medan de är tomma:

- **`POSTGRES_PASSWORD`** — för lokal utveckling `erp_dev_password`, som
  matchar npm-skriptens inbyggda standard (porten är bunden till
  `127.0.0.1` och nås inte från nätverket).
- **`JWT_SECRET`** — `openssl rand -hex 32`.

`.env` läses automatiskt av Docker Compose (för `POSTGRES_PASSWORD`/
`JWT_SECRET`/`WEB_ORIGIN`/`NEXT_PUBLIC_API_URL`, se docker-compose.yml). De lokala npm-skripten
(`dev:api`, `dev:web`, `db:migrate`) läser **inte** `.env` filen själva —
varje modul har istället samma lokala default inbyggd (matchar
docker-compose:s Postgres-uppgifter), så `npm install` + kommandona nedan
fungerar rakt av utan att exportera något manuellt, så länge du kör mot
standard-Postgres:en nedan. Om du pekar mot en annan databas/hemlighet,
exportera motsvarande variabel i skalet innan du kör kommandot, t.ex.
`DATABASE_URL=postgresql://... npm run db:migrate`.

### Starta databasen

```bash
docker compose up -d postgres
```

### Kör migrationer

```bash
npm run db:migrate
```

Det här steget behövs bara i det lokala utvecklingsläget, där `api` körs på
värdmaskinen med `npm run dev:api`. Kör du hela stacken i Docker migrerar
`api`-containern själv vid start (se nedan) och du kan hoppa över det.

### Starta utveckling

```bash
npm run dev:api   # Fastify på http://localhost:4000
npm run dev:web   # Next.js på http://localhost:3000
```

Vill du köra hela stacken i Docker i stället, t.ex. för att prova en riktig
produktionsbuild lokalt innan du driftsätter den på en server — se
[Driftsätta på en annan server](#driftsätta-på-en-annan-server-tex-en-vps)
nedan. Den bygger produktionsimages (ingen hot-reload), så för snabb
utveckling används `npm run dev:api`/`npm run dev:web` ovan.

### Skapa första användaren

Systemet har inga förinstallerade konton. Gå till `http://localhost:3000/register`
och skapa det första kontot där (blir automatiskt admin) — sidan loggar in
dig direkt efter skapande. Registreringen kräver en **engångskod** som
API:t skriver i sin logg när det startar och inga användare finns:

```bash
docker compose logs api | grep Engångskod   # eller titta i terminalen där npm run dev:api körs
```

Koden gör att den som råkar nå `/register` först inte kan ta
administratörskontot — bara den som kommer åt serverns logg. En ny kod
skrivs vid varje omstart; vill du bestämma den i förväg (t.ex. i en
skriptad installation), sätt `SETUP_CODE` i `.env`. `/register` stänger sig
själv så fort en användare finns, och fler användare skapas därefter av en
inloggad admin via `POST /api/v1/auth/users`.

Vill du prova systemet utan egna register: **System → Exempeldata** skapar ett
påhittat företag med artiklar, struktur och operationer, kunder, leverantörer
och lagersaldon. Det går bara på en tom installation.

Föredrar du curl framför webbgränssnittet fungerar samma engångsanrop
direkt mot API:et:

```bash
curl -X POST http://localhost:4000/api/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@example.com","password":"ett-tillräckligt-långt-lösenord","name":"Admin","setupCode":"ABCD-EFGH-JKLM"}'
```

### Tester

```bash
npm run test
```

Testerna i `apps/api` kör mot en riktig Postgres-instans (append-only
lagerlogik och BOM-cirkularitet är projektets känsligaste domänlogik och
mockas medvetet inte bort).

**Varning:** testerna TRUNCATE:ar tabellerna i databasen som
`DATABASE_URL` pekar på. `npm run test` kör som standard mot den separata
testcontainern `postgres-test` (databasen `erp_test` på port 5433, data i
RAM), aldrig mot utvecklingsdatabasen. Starta den först:

```bash
docker compose --profile test up -d postgres-test
```

Containern töms vid omstart och testkörningen migrerar den själv innan
sviten startar, så en ny migration behöver aldrig köras för hand. Kör bara
en testkörning åt gången mot den.

GitHub kör samma svit automatiskt vid varje push till `main` och på varje
pull request (`.github/workflows/ci.yml`), tillsammans med typkontroll och
bygge av API:t och webben.

## Driftsätta på en annan server (t.ex. en VPS)

Du behöver **inte installera PostgreSQL, Node.js eller något annat i förväg**
— Docker Compose sköter allt, databasen inkluderad (den körs som `postgres`-
tjänsten i `docker-compose.yml` och sparar data i en namngiven volym,
`erp_postgres_data`, som överlever omstarter). Det enda den nakna servern
faktiskt behöver är Docker själv.

### 0. Installera Docker (om det inte redan finns)

På en färsk Ubuntu/Debian-VPS:

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER   # logga ut och in igen (eller kör `newgrp docker`)
```

(Andra distributioner: se [Docker Engines officiella installationsguide](https://docs.docker.com/engine/install/).)

### 1. Klona och konfigurera

```bash
git clone https://github.com/ubbe76/Nav-ERP.git
cd Nav-ERP
cp .env.example .env
```

Ändra sedan i `.env` innan du startar något:

- **`POSTGRES_PASSWORD`** — databasens lösenord, ett nytt slumpat värde
  per installation (`openssl rand -hex 24`; det hamnar oescapat i en URL,
  så håll dig till bokstäver och siffror). Postgres använder det bara när
  databasvolymen skapas första gången — se
  [Uppdatera en befintlig installation](#uppdatera-en-befintlig-installation).
- **`JWT_SECRET`** — ett nytt slumpat värde (`openssl rand -hex 32`). Det
  signerar både inloggningssessioner och OAuth2-klienttokens, så den som
  känner till det kan logga in som vilken användare som helst.

Båda är tomma i `.env.example`, och så länge någon av dem är tom vägrar
`docker compose up` starta och avbryter direkt med t.ex.:

```
POSTGRES_PASSWORD måste sättas i .env — se .env.example
```


- **`COOKIE_SECURE`** — lämna osatt som standard (följer `NODE_ENV`, dvs.
  `Secure` i produktionscontainern). Driftsätter du på ett rent HTTP-LAN
  utan TLS-terminering framför stacken, sätt `COOKIE_SECURE=false` —
  annars skickar webbläsaren aldrig sessionscookien över okrypterad HTTP
  (webbläsarregeln för `Secure`-cookies), och inloggningen ser ut att
  misslyckas helt tyst, utan något felmeddelande.
- **`WEB_ORIGIN`** — sätt till adressen användarna öppnar i webbläsaren
  (t.ex. `https://erp.example.se` eller `http://din-server-ip:3000`), inte
  `localhost`. API:et validerar CORS mot den, så fel värde ger inloggning
  som blockeras av CORS.
- **`TRUST_PROXY`** — lämna tom om webben nås direkt. Inloggningen spärras
  ändå i 15 minuter efter 10 misslyckade försök på samma konto (och
  OAuth2-tokenanropet efter 10 på samma klient). Står en omvänd proxy som
  själv skriver `X-Forwarded-For` framför webben (nginx, Caddy, Cloudflare
  Tunnel) och all trafik går genom den, sätt `TRUST_PROXY=1` — då spärras
  även en IP-adress efter 30 misslyckade försök över alla konton. Sätt den
  aldrig utan en sådan proxy: då kan klienten själv välja vilken adress den
  ser ut att komma från, och anrop utan rubriken delar på en och samma
  räknare.
- **`NEXT_PUBLIC_API_URL`** — lämna tom. Webben skickar vidare `/api/v1/*`
  till API-containern över Docker-nätverket, så webbläsaren och externa
  integrationer (även OAuth2-tokenanropet) når API:et genom webbens adress.
  Sätt den bara om du medvetet exponerar API:et på en egen värd bakom en
  omvänd proxy.

  `INTERNAL_API_URL` (redan hårdkodad till `http://api:4000` i
  `docker-compose.yml`, inget du behöver sätta) är en separat variabel för
  anrop som `web`-containern gör åt sig själv (serversidan, t.ex. att läsa
  inloggad användare) — den går över Docker-nätverket, inte den publika
  adressen. Utan den separationen försöker containern nå sin egen värds
  publika IP, vilket vanligtvis inte går och visar sig som `Error: fetch
  failed` i webbläsaren.

### 2. Starta

```bash
docker compose up -d --build
```

Det är allt som krävs för att få igång stacken — **inget migreringssteg**.
Första gången bygger Compose produktionsimages för `api` och `web` från
grunden (flerstegs-Dockerfiles, se `apps/api/Dockerfile`/
`apps/web/Dockerfile`) — räkna med några minuters byggtid. `api`-
containerns startkommando (`CMD` i `apps/api/Dockerfile`) kör
migrationerna innan servern startar, och `depends_on`-kedjan väntar på
hälsokontroller: `web` startar inte förrän `api` svarar friskt, som i sin
tur väntar på att Postgres är frisk. Drizzle håller reda på vad som redan
körts, så migreringen är en tom operation vid varje omstart efter den
första.

På en tom databas *är* migrationerna installationen: de skapar schemat och
seedar företagsinformationsraden, nummerserierna och grundenheterna.
Verifierat end-to-end mot en databas med noll tabeller. Misslyckas en
migrering startar containern inte — bättre än att servera mot fel schema.
Felet syns med `docker compose logs api`.

### 3. Skapa första användaren

Gör det direkt efter `docker compose up`. Se
[Skapa första användaren](#skapa-första-användaren) ovan — hämta
engångskoden med `docker compose logs api | grep Engångskod`, gå till
`<din-server>:3000/register`, eller kör samma engångs-`POST /api/v1/auth/register`-
anrop på servern själv mot `localhost:4000`.

### 4. Brandvägg

Bara webbens port **3000** behöver nås utifrån — eller hellre en omvänd
proxy med HTTPS framför den (då sköter proxyn port 443 och 3000 kan stängas
för allt utom proxyn). Webbläsaren och externa integrationer når API:et
genom webbens adress.

`docker-compose.yml` binder Postgres (5432), testdatabasen (5433) och
API:et (4000) till `127.0.0.1`, så de nås bara från servern själv — av
`npm run dev:*`, migreringarna och backupskripten. Ändra inte det till
alla interface: **Docker skriver egna iptables-regler som går förbi ufw**,
så en port som compose-filen publicerar på `0.0.0.0` är nåbar från
internet även om brandväggen säger att den är stängd.

### Uppdatera en befintlig installation

```bash
git pull
docker compose up -d --build
```

Nya migrationer körs automatiskt när `api` startar — inget separat steg.

**Uppgraderar du från en version före 2026-10-14** stod databasens lösenord
`erp_dev_password` fast i `docker-compose.yml`. Nu läses det från `.env`,
och Postgres använder `POSTGRES_PASSWORD` bara när volymen skapas — en
befintlig databas behåller sitt gamla lösenord. Gör därför ett av följande
innan `docker compose up`:

- behåll lösenordet: lägg till `POSTGRES_PASSWORD=erp_dev_password` i `.env`
  (porten är numera bunden till `127.0.0.1`), eller
- byt lösenordet i databasen och skriv samma värde i `.env`:

  ```bash
  docker compose exec postgres psql -U erp -d erp -c "ALTER USER erp PASSWORD 'nytt-lösenord'"
  ```

  Byt du lösenordet behöver `npm run dev:api`/`db:migrate` på servern
  `DATABASE_URL` med det nya lösenordet.

Har din `.env` raden `NODE_ENV=development` (den stod i äldre versioner av
`.env.example`), ta bort den — annars körs containrarna i utvecklingsläge
och sessionskakan blir inte `Secure` ens bakom HTTPS.
Inget `docker compose down` behövs längre: stacken har varken
källkods-mountar eller anonyma `node_modules`-volymer kvar, så
`--build` ensamt bygger färska images med färsk kod och färska beroenden
och ersätter containrarna med dem.

### Flytta en befintlig installation till en ny server

Eftersom all data — även uppladdade ritningar, underlag, arkiverade fakturor och
företagslogotypen — ligger i Postgres räcker en databasdump för att flytta hela ERP:en.

**På den gamla servern** — ta en färsk säkerhetskopia, antingen i appen
(**System → Säkerhetskopiering → Ladda ner säkerhetskopia**) eller på servern
(`scripts/backup-db.sh`, dumpen hamnar i `~/backups/nav-erp/`). Kopiera
`.sql.gz`-filen till den nya servern.

**På den nya servern** — installera Docker (se ovan), sätt upp stacken och
återställ dumpen:

```bash
git clone https://github.com/ubbe76/Nav-ERP.git && cd Nav-ERP
cp .env.example .env            # sätt POSTGRES_PASSWORD, JWT_SECRET, WEB_ORIGIN
docker compose up -d --build
scripts/restore-db.sh erp-2026-07-20_0230.sql.gz
```

`restore-db.sh` läser in både schema och data ur dumpen, så du behöver inte köra
`migrate` separat. Att `api`-containern redan migrerat den tomma databasen vid
start gör ingen skada — skriptet rensar både `public`- och `drizzle`-schemat
innan det läser in dumpen, så det den skapade ersätts i sin helhet. Observera att ett nytt
`JWT_SECRET` gör gamla inloggningssessioner och OAuth2-klienttokens ogiltiga —
användare loggar in igen och konfiguratorns klienttokens hämtas på nytt.

### Begränsningar att känna till

`restart: unless-stopped` i `docker-compose.yml` startar om containrar som
kraschar. Volymen `erp_postgres_data` säkerhetskopieras inte i sig — använd
[`scripts/backup-db.sh`](scripts/backup-db.sh) via cron för nattliga
`pg_dump`-dumpar (30 dagars historik som standard):

```
30 2 * * * /sökväg/till/dev/scripts/backup-db.sh >> ~/backups/nav-erp/backup.log 2>&1
```

Återställ med
`gunzip -c dump.sql.gz | docker compose exec -T postgres psql -U erp -d erp`.

De nattliga dumparna ligger på **samma disk** som databasen. Bokföringslagen
kräver att räkenskapsinformationen bevaras på ett betryggande sätt i sju år,
så sätt också upp den **krypterade externa säkerhetskopian** (gpg + valfritt
rclone-mål, med årsarkiv som innehåller räkenskapsårets SIE-fil):

```bash
scripts/offsite-backup-setup.sh
```

Se manualens kapitel [Drift & utveckling](docs/manual/drift-utveckling.md#krypterad-extern-backup-bokforingslagen)
för detaljer, återställning och krav på förvaringsort.

## Status

**Version 0.1.0-alpha — inte redo för produktion**, se varningen överst. En alfaversion är till för den som vill prova systemet och ge återkoppling. Funktionerna nedan är
byggda och testade, men systemet har ännu inte använts i skarp drift.

Backend (Fas 1–5 enligt byggordningen) är klart, testat och kör: Article/BOM,
Stock, grundläggande auth (sessionscookie), Purchase, Sales, Manufacturing,
TimeReport (inkl. stämpling/närvaro), Payroll (frånvaro, övertid/OB, tidattest
och löneunderlag/PAXml-export), Costing, Economy (grundbokföring,
automatkontering, kund-/leverantörsreskontra, moms och ekonomirapporter),
Import (CSV-/Excel-import av register), System, Mail (SMTP-utskick +
PDF-generering) samt ett publikt OAuth2 client-credentials-API för en extern
konfigurator. Frontend har in-/utloggning
(inkl. engångsregistrering av första admin-kontot på `/register`), en
Översikt-dashboard byggd kring materialflödet (inköp → lager → tillverkning →
försäljning) med bevakningslista, sidomeny med undermenyer per modul,
modulhubbar med grupperade listkort, och modul-UI för hela byggordningen.
Alla registerlistor har serversidig fritextsökning, filtrering och
paginering (`?search/filter/limit/offset` → `{ rows, total }`), så
registren skalar till tusentals poster; artikelval i order- och
BOM-formulär görs med en sökbar artikelväljare i stället för dropdowns.
Alla register och strukturer är fullt redigerbara i efterhand:

- **Artikelregister** — lista/skapa/redigera (inkl. artikelnummer, typ och
  fantomflagga), artikelgrupper (3–4-siffrig kod), artikelkort med flikar
  för Struktur (BOM, redigerbara rader med cykelskydd), Rutt (redigerbara
  operationer), lagersaldo, kalkyl (för-/efterkalkyl-underlag) och
  **filer** (ritningar i PDF/JPEG/PNG, max 20 MB, som följer med
  TO-utskriften och kan bifogas i ordermejl); **flikarna anpassas efter
  artikeltyp** — Beredning visas bara för tillverkade artiklar, medan köpta
  och tjänsteartiklar i stället får en **Inköp-flik** med redigerbar
  leverantörskatalog (pris, valuta, ledtid och leverantörens artikelnummer
  per leverantör, en huvudleverantör) samt läs-loggar för inleveranser,
  inköpspriser och leverantörsfakturor; artikelregistret kan **CSV-importeras**
  (admin, egen guide med kolumnmappning, förhandsgranskning
  och atomiskt genomförande — samma flöde som leverantörs- och kundimporten)
- **Inköp** — leverantörer med leverantörskort (flikar Allmänt /
  Villkor & frakt / Kontakter: adress med postnummer/postort,
  organisationsnummer, VAT-nummer, leverans-/betalningsvillkor, speditör
  med kundnummer, samt flera kontakter med huvudkontaktsmarkering) och
  **CSV-import av leverantörer** (admin),
  **förfrågningar** (RFQ med egen FO-nummerserie: utkast → skickad →
  besvarad → beställd, konverteras till inköpsorder med raderna
  kopierade) och inköpsorder med fullt statusflöde (utkast → bekräftad →
  mottagning → stängd); orderrader kan läggas till, ändras och tas bort
  ända tills ordern är helt mottagen (antal spärras mot redan mottaget);
  **inleveransrutin** som rapporterar mottagning av hela ordern på en
  gång med beställt, mottaget och **rest** per rad och förifyllda
  restantal; **önskat leveransdatum** på ordern med möjlighet till eget
  datum per rad (utskrivet på inköpsorderns och förfrågans PDF); ny förfrågan/inköpsorder kan skapas
  direkt från leverantörskortet; **leverantörsfakturor** (leverantörs-
  reskontra med egen LF-nummerserie och statusflöde utkast → godkänd →
  betald, där fakturarader kan IO-matchas mot inköpsorderrader med pris-
  och antalsavvikelse, och underlaget kan hämtas direkt från en inlevererad
  inköpsorder; leverantörens faktura laddas upp som **underlag** (PDF/bild)
  redan vid registreringen och kan inte tas bort efter attest)
- **Försäljning** — kunder med kundkort (samma flikupplägg som
  leverantörskortet plus fliken **Adresser**: besöksadress på Allmänt,
  fakturaadress med **e-post för faktura**, och flera valbara
  **leveransadresser** med förvaldsmarkering), **CSV-import av kunder** (admin, samma guide som leverantörs- och artikelimporten),
  offert/order med fullt
  statusflöde (offert → bekräftad → tillverkning → levererad →
  fakturerad); ordern bär **kundens ordernummer**, **referens** och vald
  **leveransadress** (redigerbara på orderkortet tills levererad,
  utskrivna som "Ert ordernummer"/"Er referens" och leveransadressblock
  på offert/orderbekräftelse och plocklista); orderrader redigerbara
  tills ordern är levererad (antal spärras mot redan levererat);
  **utleveransrutin** som rapporterar leverans av hela ordern på en
  gång (med **rest** per rad) och skapar följesedel, med utskrivbar **plocklista** (PDF med restantal och
  lagerplatssaldon per artikel); ny offert eller kundorder (skapas
  direkt som bekräftad) från kundkortet eller listan; kundfakturor med
  prislistor/kundpriser, och **utfärdade fakturor och påminnelser
  arkiveras som PDF** exakt som de skickades
- **Grunddata** — delade register för leveransvillkor (förifyllbara med
  Combiterms), betalningsvillkor och speditörer, nåbara från både Inköp
  och Försäljning; villkoren ligger också på förfrågan, inköpsorder och
  offert/kundorder (snapshotas från partnern vid skapandet, redigerbara
  på dokumentkortet och utskrivna på PDF:erna)
- **Tillverkning** — resurser (maskiner/personal med timkostnad),
  tillverkningsorder med fullt statusflöde (planerad → frisläppt → pågår →
  klar → stängd), **strukturkomponenter kopplade till operationer** som
  dras automatiskt från lagret när operationen avrapporteras — för
  antal OK **+ kasserat** (kassation med obligatorisk orsak loggas per
  operation och rapporteras vid varje utstämpling i terminalen eller
  från TO-kortet; överrapportering drar mer), **utskrivbar TO**
  (PDF med operationer, material, signaturkolumner och artikelns
  ritningar inbakade), efterkalkyl; **föreslaget färdigdatum** på ny
  tillverkningsorder (arbetsdagen före artikelns första otäckta behov);
  **behovsberäkning** med orderförslag och **Skapa ordrar** (resultatet
  återanvänds en minut, **Uppdatera** räknar om), **artikelöversikt**
  med lagersaldo och löpande disponibelt antal, och beläggning per
  resurs och vecka
- **Tidrapportering & personal** — **stämpelterminal** (helskärmsvy för en
  delad skärm i verkstaden: närvarostämpling kom/gå med sifferknappsats,
  in-/utstämpling på order/operationer som materialiserar tidrapporter,
  ATF-uttag; gå hem pausar pågående arbeten så att bortavaron inte
  räknas in i rapporterad tid; planerat, klart och **kvar** visas per
  operation), manuella
  tidrapporter, personalregister med personalkort (kontakt-, anställnings-
  och löneuppgifter, schema och ATF-saldo), **scheman & kalendrar**
  (dagsscheman med raster/pauser, veckoscheman, helgdagar med förifyllda
  svenska helgdagar; standardschema per anställd med kalenderöverstyrning
  per vecka eller enskild dag), **ATF** (arbetstidsförkortning med
  intjäning i minuter/vecka, tidbank eller veckouttag per anställd),
  **produktionsgrupper** som kopplar personal och resurser samt, under
  **Tillverkning → Lön**, **löneunderlaget**: frånvarohantering
  (frånvarokoder mappade mot lönearter, registrering per anställd/dag),
  automatisk beräkning av övertid/mertid och OB ur schema mot närvaro,
  **tidattest med periodlåsning** (arbetsledaren attesterar per anställd
  och period, en låst period spärrar ändringar), löneunderlagsrapport per
  anställd och löneperiod som PDF/CSV, samt **PAXml-export** mot externa
  lönesystem
- **Lager** — saldon över alla artiklar, redigerbara lager/lagerplatser
  med automatisk reservplats `***` (transaktioner utan vald plats bokförs
  på artikelns lagerplats eller `***`), transaktionslogg (inflödesrader
  bär inköpskostnaden `unit_cost` i SEK), inventering samt
  **lagervärdering** (`/lager/vardering`, administratörer): lagrets värde
  per valfritt datum med tre metoder — standardpris, senaste inköp eller
  vägt snitt — uppdelat per artikelgrupp och nedladdningsbart som PDF
- **Ekonomi** (administratörer) — full redovisning: **Kontoplan** med
  BAS-seedning i ett klick, **Räkenskapsår** med automatiskt genererade
  perioder och låsning, **Verifikat** i egna verifikatserier (bokförs
  append-only, kan omföras, utskrivbara som verifikatlista), härledd
  **Huvudbok** (enkonto eller kontointervall), **automatkontering** som
  bokför kund- och leverantörsfakturor direkt vid fakturering styrd av
  **konteringsregler** (artikelgrupp + momssats mot standardkonton), kund-
  och leverantörsreskontra med betalningsregistrering (OCR-matchning,
  tolerans, kvittning) och betalningspåminnelser, **Momsrapport** per
  månad/kvartal med Skatteverkets rutor och bokförd momsomföring, härledda
  **Balansräkning** och **Resultaträkning**, samt **SIE-filer**
  (SIE4-export per räkenskapsår och import av ingående balanser) — nio
  sidor under Ekonomi i sidomenyn. Anpassat efter **bokföringslagen**:
  **underlag** (kvitto, kontoutdrag) kan bifogas verifikat, och bokförda
  verifikat, deras rader och underlag samt arkiverade fakturor skyddas av
  en **spärr i databasen** mot ändring och radering — rättelser görs med
  omföring
- **E-post & dokument** — utgående e-post via extern SMTP-server
  (konfigureras under Systeminställningar med testmejl-knapp):
  förfrågningar, inköpsordrar, offerter och orderbekräftelser mejlas som
  PDF-bilagor (pdfkit, med företagsuppgifter och logotyp) direkt från
  korten, med statuskoppling (förfrågan → skickad, inköpsorder →
  bekräftad, orderbekräftelse bekräftar offerten — endast när utskicket
  lyckas), valbara ritningsbilagor (artikelfiler), nedladdningsbara
  PDF:er, utskickshistorik per kort och en central e-postlogg med
  omskick av misslyckade utskick
- **System** (admin) — företagsinformation med logotyp, nummerserier,
  API-klienter (OAuth2) för integrationer, e-postlogg, samt
  systeminställningar (t.ex. parallella stämplingar, ATF-intjäning och
  E-post/SMTP)
- **Gränssnitt** — svenskt webbgränssnitt med färgtemana **Ljust**,
  **Mörkt** och **Dracula** (all text klarar WCAG AA i alla teman; nya
  teman läggs till som ett token-block), mobilanpassat
- **Hjälp** — inbyggd användarmanual på `/hjalp` (renderad från
  [`docs/manual/`](docs/manual/)) med kapitel för alla rutiner och
  inställningar

Känd begränsning: det finns ingen **årsbokslutsfunktion** — bokslutet
görs i ett annat program utifrån SIE4-exporten. Se
[`docs/architecture.md`](docs/architecture.md#8-byggordning--faser) för
full byggordning och [`TODO.md`](TODO.md) för det som återstår.

## Återkoppling och bidrag

Nav|ERP är en alfaversion, och återkoppling från dig som provar är det som
hjälper mest:

- **Fel och förslag:** öppna ett [ärende](https://github.com/ubbe76/Nav-ERP/issues/new/choose)
  med mallen Felrapport eller Förslag.
- **Säkerhetsbrister:** rapportera privat enligt [SECURITY.md](SECURITY.md) —
  aldrig i ett öppet ärende.
- **Kod:** pull requests är välkomna, se [CONTRIBUTING.md](CONTRIBUTING.md).

## Licens

Copyright © 2026 Urban Källefors

nav | ERP är fri programvara: du kan sprida den och/eller ändra den under
villkoren i GNU General Public License, publicerad av Free Software
Foundation, antingen version 3 av licensen eller (efter ditt val) valfri
senare version. Programmet sprids i hopp om att det ska vara användbart,
men UTAN NÅGON GARANTI; inte ens underförstådd garanti om SÄLJBARHET eller
LÄMPLIGHET FÖR ETT VISST ÄNDAMÅL. Se [`LICENSE`](LICENSE) för den
fullständiga licenstexten (SPDX: `GPL-3.0-or-later`).

### Tredjepartsinnehåll

- **Dracula** — färgtemat *Dracula* i webbens temaväljare bygger på
  [Dracula-paletten](https://draculatheme.com) och används under
  MIT-licensen, © 2023 Dracula Theme. Licenstexten finns i
  [`licenses/Dracula-MIT.txt`](licenses/Dracula-MIT.txt).

## Historik

Projektet startades som ett scaffolding-paket avsett att bootstrap:as med
Claude Code CLI — se
[`docs/claude-code-getting-started.md`](docs/claude-code-getting-started.md)
för den ursprungliga onboarding-guiden.

# CLAUDE.md

Detta är kontextfilen för Claude Code i det här projektet. Läs `docs/architecture.md` för fullständig kravspec innan du börjar implementera större features. Här står bara det som gäller hela kodbasen; reglerna för varje modul och funktion ligger i `.claude/rules/` och läses in automatiskt när du arbetar i filerna de gäller (listan sist).

## Projektöversikt

Ett öppet källkod-ERP för mindre/medelstora svenska tillverkande företag. Byggs av en person med daglig praktisk erfarenhet av affärssystem i tillverkande industri (inköp, tillverkning, lager, kalkyl).

**Mål:** Ett självhostat, Docker-baserat system som täcker kärnflödet artikel → lager → inköp/försäljning → tillverkningsorder → tidrapportering → kalkyl, utan onödig komplexitet kring t.ex. fleranvändarrättigheter, EDI och avancerad kapacitetsplanering.

## Teknikstack

- **Runtime:** Node.js (LTS) + TypeScript, strikt läge (`strict: true`)
- **Databas:** PostgreSQL 16
- **ORM:** Drizzle ORM (föredras över Prisma för direkt SQL-kontroll och enkla migrationer)
- **API:** REST via Fastify (enkelt, snabbt, bra TypeScript-stöd)
- **Frontend:** Next.js (App Router)
- **Auth:** Lucia eller enkel egen JWT-lösning — ingen överdriven rättighetsmodell i v1
- **Containerisering:** Docker + Docker Compose (tjänster: `postgres`, `api`, `web`, ev. `redis` senare)
- **Monorepo-struktur:** `apps/api`, `apps/web`, `packages/db` (delat Drizzle-schema + klient), `packages/shared` (delade typer/zod-scheman)

## Arkitekturprinciper

1. **Append-only händelseloggar för lager.** Aldrig UPDATE direkt på saldon — alla lagerförändringar går via `stock_transactions`, aktuellt saldo är en vy/aggregering. Varje skrivare löser platsen med `resolveStockLocation`, varje lagerminskning anropar `deactivateEmptyLocation`, och `unit_cost` stämplas bara på inflöden (`stock.md`).
2. **Explicita statusflöden.** Varje order/tillverkningsorder har en status-enum och tillståndsövergångar valideras i domänlagret, inte bara i UI. Statusmängder är vitlistor.
3. **Materialuttag kan styras av rutten.** En BOM-rad kan peka på en av artikelns egna operationer; vid frisläpp snapshotas kopplingen till TO:n. En ny TO frisläpps i sin egen create-transaktion, antal rapporteras inkrementellt och materialet dras enligt top-up-regeln (`manufacturing.md`).
4. **BOM är self-referencing.** En artikel kan vara både komponent och slutprodukt (viktigt för diskbänkskonfiguratorn — moduler/underrede).
5. **API:et ska vara integrationsvänligt** eftersom en extern produktkonfigurator (separat projekt) ska kunna skapa offert/order programmatiskt via REST-API:t med OAuth 2.0 (client credentials).
6. **Skippa medvetet i v1:** avancerad kapacitetsplanering, EDI, komplexa multivaluta-flöden, granulär fältnivårättighetsstyrning, inbyggd rapportgenerator.
7. **Artikelmodulen följer etablerade svenska ERP-konventioner i uppbyggnad och arbetsflöde** — flikar på artikelkortet, vedertagna svenska begrepp (`article.md`).
8. **Webben ska klara framtida färgteman.** Varje färg är en temaberoende token i `apps/web/styles/tokens.css`; komponenter använder bara semantiska tokens — inga hex/rgb/hsl, inga `--neutral-*`, inga `var(--x, fallback)`. `theme-tokens.test.ts` vaktar, även WCAG AA (`web-theme.md`).

## Kodkonventioner

- All kod och kommentarer på engelska, domänbegrepp får gärna ha svenska motsvarigheter i kommentarer där den svenska branschtermen är relevant (t.ex. `// MO = Manufacturing Order / tillverkningsorder`)
- Zod för all input-validering i API-lagret
- Varje modul (`apps/api/src/modules/<modul>`) har egen mapp med `routes/`, `service/`, `repository/`. Domänlogik (statusövergångar, lagertransaktioner, avrundning) i servicelagret, aldrig i route-handlers.
- **`Db | Tx`-mönstret:** hjälpare som ska kunna köras inne i en annan rutins transaktion tar `Db | Tx` och bor gärna i en lövfil (`resolveStockLocation`, `allocateVerificationNumber`, `VerificationPoster`, `replacePriceBreaks` …). Tvärmodulsläsning går via injicerade läsargränssnitt (`RegisterReferenceReader`, `StockBalanceReader`, `ArticleFileReader` …); där modulerna annars skulle bli cykliska binds läsaren sent i `app.ts` (`variantPriceRef`, `planReaderRef` …).
- **Rena beräkningsfiler:** regler som flera läsare delar bor i en ren fil utan DB-importer, med EN implementation som alla anropar (t.ex. `roundUpToMultiple`, `currency.ts`, `delivery-days.ts`, `article-overview.ts`). Webbspeglar av shared-filer kopieras byte för byte och vaktas av test — webben kan inte importera `@navet/shared`.
- **Härlett före lagrat:** öppna poster, aviseringar, ångrad följesedel, utgången offert, avvikelseminuter m.m. räknas fram ur raderna vid läsning i stället för att lagras som en status som kan glida isär.
- **Inga DB-transaktioner över HTTP.** Externa anrop (Sendify, B2Brouter, Riksbanken via `getRate`, SMTP) görs före eller efter transaktionen; reservera med en atomisk, ägarkontrollerad UPDATE och skriv resultatet efteråt.
- **Bakgrundsjobb** startas bara från `server.ts` (jobblistan, `scheduler.ts`), aldrig från `buildApp` — testerna får inga bakgrundsjobb. En körning åt gången via lease i `system_settings`.
- **Datum är Stockholmsdagar** (`localDateOf`, `Intl.DateTimeFormat` med `Europe/Stockholm`), även om containern skulle köra UTC; `docker-compose.yml` sätter `TZ: Europe/Stockholm` på `api` och `web`.
- **Id-vakten:** `rejectMalformedIds` (`apps/api/src/modules/system/middleware/reject-malformed-ids.ts`) körs efter `enforceAccess` i båda autentiserade scopen och gör en path-parameter som heter `:id`/`:…Id` men inte är ett uuid till 400 `validation-failed` — en ny path-parameter som inte är ett uuid får därför inte heta `id`/`…Id`.
- **Behörigheter:** varje modul registreras med `registerModule(..., { read, write })` i `app.ts`, enskilda rutter åsidosätter med `config: { access }` (namngivna regler i `auth/middleware/access-rules.ts`), och `enforceAccess` nekar en rutt utan regel — `permissions-coverage.test.ts` faller för en rutt utanför `registerModule`. Klientrutter (OAuth) behöver `config.clientScope`. En ny webbsida behöver en post i `apps/web/lib/pageAccess.ts` (`page-access.test.ts`), knappar döljs med `useCan`, länkar till andra moduler går via `GatedLink`. Priser är kontorsdata (`canSeePrices`). Detaljer i `permissions.md`.
- **Endast läsning:** `readOnlyGuard` vägrar allt utom GET/HEAD/OPTIONS för läskonton (403 `read-only-account`); en ny skrivande rutt som bara räknar och svarar får `config: { readOnlySafe: true }` — `read-only-account.test.ts` låser listan.
- **Bokföringsspärren:** bokförda verifikat och deras rader, låsta underlag och arkiverade fakturadokument är spärrade i Postgres (triggers, SQLSTATE `NV001` → 409 `bookkeeping-record-locked`). Ändra aldrig de tabellerna till att tillåta UPDATE/DELETE av låsta rader (`economy.md`).
- **Listmönstret:** alla obegränsade listendpoints tar `search`/filter/`limit`/`offset` (bas-zod i `packages/shared/src/list.ts`, per modul utökad med t.ex. `type`/`status`) och svarar med `{ rows, total }`. Repository:t bygger `where` en gång och kör rader + `count(*)` med samma villkor. Webbsidorna är URL-drivna (`?search=&page=`) via `ListToolbar`/`Pagination` i `apps/web/components/ui/ListControls.tsx`. Artikelval görs med den sökbara `ArticlePicker`-komboboxen (`apps/web/components/ui/ArticlePicker.tsx`, serversidig sökning, `excludeId`, `orderable`/`configurable`); övriga formulär-dropdowns (kunder, leverantörer, TO i terminalen, ordervalen i inleverans-/utleveransrutinerna) hämtar tills vidare `?limit=1000`.
- **Bekräftelser:** webben anropar aldrig `window.confirm` — Safari på iPhone kan sluta visa den och svarar då tyst Avbryt. Använd `confirmDialog(message, { confirmLabel?, danger? })` eller `confirmDelete(message)` ur `apps/web/lib/confirm.ts` (Promise<boolean>, appens dialog `ConfirmDialogHost` i `AppShell`; sidor utan AppShell monterar den själva). Vakten för osparade ändringar (`confirmLeave` i `lib/unsavedGuard.ts`) är därför också asynkron: länkklick stoppas alltid och navigeringen spelas upp igen med `router.push` efter **Lämna sidan**. `web-confirm-dialog.test.ts` underkänner varje `confirm(`-anrop utanför `lib/confirm.ts`.
- **Numeriska formulärfält:** `min` är webbläsarens *utgångspunkt för stegningen* (step base), och Firefox respekterar den även när `step="any"` — ett fält med `min="0.0001"` stegar därför 1 → 1.0001 → 2.0001. Därför: **antal `min="0" step="any"`**, **pris `step="0.01"`**, **standardkostnad (4 decimaler, numeric(14,4)) `min="0" step="any"`**, sex-decimalersfält som växelkurs `min="0" step="any"`. Aldrig ett brutet tal som `min` och aldrig `step` under 0.01. Nollor stoppas av servern (`z.coerce.number().positive()`), inte av `min`.
- **Förifyllda fält:** när servern föreslår ett värde (à-pris, kurs, leverans-/färdigdatum, moms) gäller "manuellt vinner" — en touched-flagga och en request-sekvens så ett sent svar aldrig skriver över det användaren skrivit.
- **Publikt och privat:** repot är publikt. Det privata materialet ligger i det separata privata repot `private/` i arbetskopian (ignorerat av `.gitignore`): planer/specar (`docs/superpowers` är en symlänk dit), TODO-arkivet och e2e-testerna mot de riktiga exportfilerna från det tidigare affärssystemet (`private/api-tests/*.real-files.test.ts`, som `apps/api/vitest.config.ts` tar med när katalogen finns). Inga riktiga företags-, kund- eller leverantörsuppgifter, artikelnummer eller filsökvägar ur exporterna får hamna i det publika repot — testdata är påhittad.
- Migrationer: Drizzle Kit, aldrig manuell schemaändring i produktion.

## Tester

- Vitest för unit/integration. **OBS:** `apps/api`-testerna kör mot en riktig Postgres och **TRUNCATE:ar tabellerna** i databasen som `DATABASE_URL` pekar på. `apps/api/test/setup.ts` avbryter körningen om databasnamnet inte innehåller "test" (och `npm run test` defaultar till `erp_test`), men kringgå aldrig spärren — utan den raderas dev-datan, vilket redan har hänt en gång.
- `npm run test` kör mot den **separata testcontainern** `postgres-test` (port **5433**, `docker compose --profile test up -d postgres-test`): datan ligger i RAM (tmpfs) och `fsync`/`synchronous_commit`/`full_page_writes` är avstängda, så hela sviten tar minuter i stället för timmar. Containern töms vid omstart — global-setup migrerar upp en ny databas — och ska aldrig användas till annat än tester. Startas den inte får testerna ECONNREFUSED. Fortfarande bara **en** vitest-process åt gången mot samma testdatabas.
- Tester som registrerar via `buildApp` skickar `app.setup.code.code` (engångskoden för första registreringen); tester som bygger `createAuthService` utan kod slipper kontrollen. Externa tjänster injiceras som fejkar (`test/helpers/fake-freight-provider.ts`, `fake-einvoice-provider.ts`, `MailTransportFactory`), fetch mot riksbank.se blockeras i `test/setup.ts`, och sandlådetesterna körs bara med sin nyckel i miljön.
- Skriv tester för statusflödesövergångar särskilt — de är projektets känsligaste logik.

## Användarmanualen

Användarmanualen ligger i `docs/manual/` (svenska, ett kapitel per fil) och renderas i appen på `/hjalp` (manifest i `apps/web/lib/manual.ts`, rendering med `marked` — rubriker får ankar-id via `slugifyHeading`). **Uppdatera motsvarande kapitel när en rutin eller inställning ändras — manualen committas i samma commit som funktionen.** Citera UI:ts faktiska knapp-/fält-/statusnamn ordagrant. Varje rutinsida har en kontextuell hjälpknapp (`apps/web/components/ui/HelpLink.tsx`, `chapter` + `anchor` = slugifierad rubrik) i topbaren — nya rutinsidor ska få en, och ankarna måste hållas i synk med kapitelrubrikerna (stämpelterminalen är medvetet undantagen).

## Regelfilerna i `.claude/rules/`

Varje fil har `paths:` i sin frontmatter och läses bara in när du läser en fil som matchar. Behöver du en regel utan att ha öppnat en matchande fil — läs filen direkt.

| Fil | Innehåll |
|---|---|
| `article.md` | artikelkortet, typer, nummerserier, kopiera, artikelfiler |
| `stock.md` | lagerplatser, resolvern, flytt, tomma platser, kostnad på lagerraden |
| `purchase.md` | förfrågan, IO, inleverans och ångra, leverantörskatalog, staffel, leverantörsfaktura |
| `invoice-scan.md` | fakturaskanning: Fakturainkorgen, regeltolkning, konvertering till LF-utkast, inlärning, IO-matchning, AI-tolkning, e-postlådan |
| `sales.md` | offert/kundorder, OF-/KO-nummer, Förlorad, kunder och adresser, utleverans och ångra, samlingsfaktura |
| `order-dates.md` | önskat/bekräftat leveransdatum på order och rader, effektiva datum |
| `ledgers.md` | kund- och leverantörsreskontra, betalningar, `paid` som sidoeffekt |
| `manufacturing.md` | frisläpp, rapportering, top-up, delinleverans, ångra, materialbrist, ändra TO, terminalens lista |
| `scan.md` | skanning (EAN, lagerplatsens etikettkod, `GET /scan`), etiketter, skanningsfältet |
| `planning.md` | behovsberäkningen och cachen, Skapa ordrar, avrundning, artikelöversikt, färdigdatumsförslag |
| `costing.md` | kalkylens materialkällor (förkalkyl/efterkalkyl), efterkalkylen prissatt vid uttaget, pris vid tidpunkt |
| `production-planning.md` | planerade veckor, kapacitet, Leveranstidskontroll och reservationen |
| `delivery-days.md` | fasta leveransdagar, transport- och arbetsdagar, datumintervallet |
| `configurator.md` | varianter, beställningsvara, konfigurerad TO, externt API |
| `timereport.md` | närvaro, stämpling, automatisk utstämpling, avvikelser och övertidsval |
| `economy.md` | automatkontering, manuell bokföring, återkommande verifikat, rapporter, SIE, räkenskapsinformation |
| `vat.md` | momskoder, momsrapport och omföring, periodisk sammanställning, importmoms |
| `currency.md` | valuta på dokument och betalningar, kurser, priskedjan |
| `year-end.md` | anläggningsregister, avskrivningar, årsbokslut, valutaomvärdering |
| `banking.md` | betalfiler (pain.001), camt.054, utlandsbetalningar, bankavstämning |
| `shipping.md` | frakt via Sendify, bokning/avbokning, spårning, frakt på offert och faktura |
| `einvoice.md` | e-faktura via Peppol (UBL, B2Brouter, sändningsloggen) |
| `import.md` | importmallar, flerfilsimport, artikel-/pris-/enhets-/operations-/resursimport |
| `permissions.md` | behörighetsgrupper, Personal & lön, Endast läsning, inloggningsvakterna, API-klienter |
| `alerts.md` | aviseringarna och den dagliga sammanställningen |
| `mail.md` | e-post, e-postloggen, dokumentutskick, PDF-fällor |
| `register.md` | grunddata-registren, villkor på dokumenten, radering med kopplingsflytt |
| `reports.md` | orderförteckning, offertuppföljning, leveransprecision per motpart |
| `quality.md` | reklamationer och avvikelser, Avvikelseorsaker, genvägarnas `deviationId`, reklamationsrapporten |
| `system.md` | exempeldata, Kom igång, favoriter, extern backup |
| `web-theme.md` | färgteman och tokens |

**En ny funktion** skriver sina fällor och invarianter i modulens regelfil (eller en ny fil med `paths:` och en rad i tabellen) — kort: det som inte syns i koden, varför det är byggt så, låsordningar och vilka test som vaktar. Designen och detaljerna hör hemma i specen. Rot-CLAUDE.md växer bara med det som gäller hela kodbasen.

## Vad Claude Code bör göra proaktivt

- Föreslå Drizzle-schema-ändringar som separata migrationer, aldrig skriva om hela schemat i onödan
- Fråga innan destruktiva databasoperationer
- Hålla domänlogik (statusövergångar, lagertransaktioner) i service-lagret, inte i route-handlers
- Skriva tester för statusflödesövergångar särskilt (dessa är projektets känsligaste logik)

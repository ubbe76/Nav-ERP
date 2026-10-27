---
paths:
  - "apps/api/src/modules/article/**"
  - "apps/web/app/artiklar/**"
  - "apps/web/app/varugrupper/**"
  - "apps/web/components/articles/**"
  - "apps/web/lib/articleCopy.ts"
  - "apps/web/lib/revision.ts"
  - "packages/shared/src/article.ts"
  - "apps/api/test/article*"
  - "apps/api/test/number*"
---

# Artikelregistret (Monitor G5-referens)

Artikelregistret är grunden för allt annat och ska kännas igen av någon som jobbat i Monitor G5, både i artikelkortets struktur och i begreppen.

## Struktur och typer

- **Flikar på artikelkortet** i stället för ett platt formulär: **Allmänt** (artikelnummer, benämning, typ, grundenhet, status), **Struktur**/**Beredning** (BOM + rutt), **Inköp** (leverantörsinfo, inköpsenhet + omräkningsfaktor, inköpspris), **Försäljning** (försäljningsenhet + omräkningsfaktor, prislista), **Lager** (platser, saldon ur `stock_transactions`), **Kalkyl**, **Filer**. API:t speglar det som grupperade underresurser (`/articles/:id`, `/articles/:id/bom`, `/articles/:id/stock` …), inte nödvändigtvis separata tabeller.
- **Typberoende flikar** (`ArticleTabs.tsx`, `tabsForType`): `manufactured` → **Beredning**; `purchased`/`service` → **Inköp** i stället (`InkopTab.tsx`, katalogen serveras från purchase-modulen — se `purchase.md`); `service` saknar även Lager (tjänster lagerhålls inte).
- **Typer:** `manufactured`/`purchased`/`service` i `article_type` (`packages/db/src/schema/article.ts`). **Fantomartikel** (lagerhålls aldrig, löses alltid upp till sina komponenter vid tillverkning/kalkyl) är flaggan `is_phantom`, upplöst i `bom-explosion.ts`. **Varugrupper** (`article_groups`, 1–4-siffrig kod, platt register) med UI på `/varugrupper` — se nedan.
- **BOM är self-referencing** (arkitekturprincip 4). Artikelval i kortets BOM-komponentval görs med `ArticlePicker` (`excludeId` döljer kortets egen artikel).
- Alla fält är redigerbara i efterhand, även artikelnummer/typ/fantomflagga (dubblett ⇒ 409).
- Beredningslistans tidsenhet (`routing_operations.time_unit`) växlas per rad i `BeredningView` (delade `ui/SegmentedToggle`, samma kontroll som operationsdialogen, `PATCH /articles/:id/routing/:opId { timeUnit }` utan konvertering; st/h avstängd vid stycktid 0, dold på legorader).

## Varugrupp och artikelkod (migration 0155/0156)

- **Varugrupp** är UI-namnet på `article_groups` (tabell, API-sökvägar `/article-groups` och fälten `groupId`/`articleGroupId` heter som förut — inget API-brott för integrationer; `/artikelgrupper` omdirigerar till `/varugrupper`). Koden är 1–4 siffror sedan 0156 (Monitors varugrupper är ensiffriga). Varugruppen styr **konteringen** (`posting_rules` per grupp och momskod, `economy.md`) och **momssatsen**: `article_groups.vat_rate` (25/12/6/0, CHECK).
- **Artikeln har ingen egen momssats** (`articles.vat_rate` borttagen i 0156; 0155 gav varje grupp den vanligaste satsen bland dess artiklar). Satsen härleds med `articleVatRateSql` i lövet `article/repository/article-vat-rate.ts` — enda implementationen, `coalesce(gruppens sats, 25.00)` som korrelerad subquery så den passar i varje select med `articles` i scope. Artikelns GET/lista, fakturaradens förval (`articleVatFacts`), fakturadialogens orderrader och dokument-PDF:ernas bruttouppräkning läser den. `vatRate` finns kvar i artikelns svar (härlett, read-only); POST/PATCH tar den inte längre. Fakturaraderna snapshotar satsen som förut.
- **Artikelkod** (`article_codes` i `register.ts`, Grunddata-register i register-modulen med `/article-codes`, skriv `artiklar`, radering med kopplingsflytt via `REGISTER_REFERENCES.articleCodes`) är ett rent urvals-/grupperingsbegrepp: `articles.article_code_id` (FK `restrict`), filter `articleCodeId` i artikellistan, orderförteckningen och lagervärderingen, lagervärderingens `groupBy=articleCode`, kolumnen i artikelexporten och importens `articleCode`. Den styr varken kontering eller moms.
- Kopiera från och konfiguratorns varianter: artikelkoden är ett formulärfält (förifylls av klienten som gruppen, läses aldrig från källan); varianterna tar mallens `articleCodeId` explicit i `createPlannedVariant`.

## Artikelnummerserier (migration 0127)

- `POST /articles` utan `articleNumber` får nästa **lediga** nummer ur `numberSeriesKey`, annars varugruppens `article_groups.number_series_key` (FK `set null`), annars standardserien `article` (`DEFAULT_ARTICLE_SERIES_KEY` i `number-series.ts`, seedad utan prefix från 1001); ett eget nummer vinner och rör ingen serie.
- Artikelserier är `number_series`-rader med `for_articles = true` (egna serier har unikt `name` och genererad nyckel `article_…`; `POST/DELETE /number-series` i system-modulen, admin; inbyggda kan inte byta namn eller tas bort — `BuiltInNumberSeriesError` → 400, dubblettnamn `DuplicateNumberSeriesNameError` → 409).
- Utdelningen bor i lövfilen `article/repository/article-number.ts` och skiljer sig från orderserierna: artikelserier krockar med importerade/handskrivna nummer, så `claimArticleNumber` söker första lediga nummer från seriens nästa nummer (batchvis, `SeriesExhaustedError` efter 10 000 tagna i rad) och tar det med en compare-and-set på räknaren (`WHERE next_number <= kandidat`), **utanför** artikelns transaktion; en kollision med ett handskrivet nummer ger nytt försök (högst fem, på constraint-namnet `articles_article_number_unique`).
- `GET /article-number-series` ger serierna med `nextArticleNumber` som förhandsvisning till Ny artikel och grupperegistret. Importerna, konfiguratorns varianter och exempeldatan anger alltid egna nummer.

## Kopiera från befintlig artikel

- `POST /articles` tar `copyFrom: { articleId, parts }` (delarna `information`/`beredning`/`inkop`/`filer`; delade `articleCopyFromSchema`/`articleCopyPartAllowed` i `packages/shared/src/article.ts`, webbspegel `apps/web/lib/articleCopy.ts`) och kopierar i **samma transaktion** som artikeln (repeatable read, lövfilen `article/repository/article-copy.ts`, bytea via INSERT … SELECT).
- Typregler i servicen: Beredning bara till `manufactured`, Inköp bara till `purchased`/`service` (`ArticleCopyPartNotAllowedError` → 400); okänd källa → 404.
- Information kopierar Allmänt-/planeringskolumnerna som formuläret saknar (anropet vinner); alternativa enheter + inköps-/försäljningsenhet bara vid **samma grundenhet**. Formulärets egna fält (typ, fantom, grundenhet, standardkostnad, varugrupp, artikelkod, lagerplats) läses **aldrig** från källan på servern — klienten förifyller dem. Beredning = rutt (med `routing_operation_files`) + BOM med ommappad operationslänk; Inköp = katalog med huvudleverantör + staffel; Ritningar och filer = `article_files` + ritningsnummer. Kopieras aldrig: revisioner, lager, historik, konfiguratormall, kundpriser/prislistor.
- Dialogen (`CopyFromModal`) öppnas inifrån Ny artikel — därför stoppar `Modal`s `onCancel` propagering så Esc bara stänger den översta dialogen.

## Artikelfiler (ritningar)

- `article_files` (bytea i Postgres, PDF/JPEG/PNG, max 20 MB) är subresursen `/articles/:id/files` med fliken **Filer**. Repositoryts listnings-queries får **aldrig selecta `data`-kolumnen**.
- Tvärmodulsläsning via `ArticleFileReader` (`listFiles`/`filesWithData`): **TO-utskriften** (`GET /manufacturing-orders/:id/pdf`, `renderManufacturingOrder` + `appendFilesToPdf` i `pdf-merge.ts` med pdf-lib) bakar in ritningarna som extra sidor, och **ordermejl** bifogar dem när `attachDrawings` är satt (loggas på `email_log` så omskick återanvänder valet).

## Extra benämning, Pos. och Cykeltid (0157–0159)

- `articles.extra_description` (flerradig, max 2000) skrivs ut på de dokument inställningen `extra_description_documents` listar (JSON-lista i `system_settings`, `EXTRA_DESCRIPTION_DOCUMENTS` i shared, webbspegel i `lib/types.ts`; trasigt värde ⇒ inga). EN regel för alla anropsställen: `extraDescriptionFor(settings, kind)` i `document-pdf.ts`; läses live som Ytbehandling/Färg. Plocklistan och följesedeln mäter infotexterna med `measureInfoLines` (flerradigt/radbrytning ⇒ 11pt per tryckt rad). Inte i Ny artikel-dialogen ⇒ **Kopiera från → Information** kopierar den på servern.
- `bom_components.position` (Pos., fritext ≤ 20) och `routing_operations.cycle_time_per_unit` (Cykeltid, produktiv tid, min/st som stycktiden och i samma visningsenhet) är rena informationsfält — varken frisläpp/snapshot, kalkyl eller beläggning läser dem ännu.

---
paths:
  - "apps/api/src/modules/article/**"
  - "apps/web/app/artiklar/**"
  - "apps/web/app/artikelgrupper/**"
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
- **Typer:** `manufactured`/`purchased`/`service` i `article_type` (`packages/db/src/schema/article.ts`). **Fantomartikel** (lagerhålls aldrig, löses alltid upp till sina komponenter vid tillverkning/kalkyl) är flaggan `is_phantom`, upplöst i `bom-explosion.ts`. **Artikelgrupper** (`article_groups`, 3–4-siffrig kod, platt register) med UI på `/artikelgrupper`.
- **BOM är self-referencing** (arkitekturprincip 4). Artikelval i kortets BOM-komponentval görs med `ArticlePicker` (`excludeId` döljer kortets egen artikel).
- Alla fält är redigerbara i efterhand, även artikelnummer/typ/fantomflagga (dubblett ⇒ 409).
- Beredningslistans tidsenhet (`routing_operations.time_unit`) växlas per rad i `BeredningView` (delade `ui/SegmentedToggle`, samma kontroll som operationsdialogen, `PATCH /articles/:id/routing/:opId { timeUnit }` utan konvertering; st/h avstängd vid stycktid 0, dold på legorader).

## Artikelnummerserier (migration 0127)

- `POST /articles` utan `articleNumber` får nästa **lediga** nummer ur `numberSeriesKey`, annars artikelgruppens `article_groups.number_series_key` (FK `set null`), annars standardserien `article` (`DEFAULT_ARTICLE_SERIES_KEY` i `number-series.ts`, seedad utan prefix från 1001); ett eget nummer vinner och rör ingen serie.
- Artikelserier är `number_series`-rader med `for_articles = true` (egna serier har unikt `name` och genererad nyckel `article_…`; `POST/DELETE /number-series` i system-modulen, admin; inbyggda kan inte byta namn eller tas bort — `BuiltInNumberSeriesError` → 400, dubblettnamn `DuplicateNumberSeriesNameError` → 409).
- Utdelningen bor i lövfilen `article/repository/article-number.ts` och skiljer sig från orderserierna: artikelserier krockar med importerade/handskrivna nummer, så `claimArticleNumber` söker första lediga nummer från seriens nästa nummer (batchvis, `SeriesExhaustedError` efter 10 000 tagna i rad) och tar det med en compare-and-set på räknaren (`WHERE next_number <= kandidat`), **utanför** artikelns transaktion; en kollision med ett handskrivet nummer ger nytt försök (högst fem, på constraint-namnet `articles_article_number_unique`).
- `GET /article-number-series` ger serierna med `nextArticleNumber` som förhandsvisning till Ny artikel och grupperegistret. Importerna, konfiguratorns varianter och exempeldatan anger alltid egna nummer.

## Kopiera från befintlig artikel

- `POST /articles` tar `copyFrom: { articleId, parts }` (delarna `information`/`beredning`/`inkop`/`filer`; delade `articleCopyFromSchema`/`articleCopyPartAllowed` i `packages/shared/src/article.ts`, webbspegel `apps/web/lib/articleCopy.ts`) och kopierar i **samma transaktion** som artikeln (repeatable read, lövfilen `article/repository/article-copy.ts`, bytea via INSERT … SELECT).
- Typregler i servicen: Beredning bara till `manufactured`, Inköp bara till `purchased`/`service` (`ArticleCopyPartNotAllowedError` → 400); okänd källa → 404.
- Information kopierar Allmänt-/planeringskolumnerna som formuläret saknar (anropet vinner); alternativa enheter + inköps-/försäljningsenhet bara vid **samma grundenhet**. Formulärets egna fält (typ, fantom, grundenhet, standardkostnad, grupp, lagerplats) läses **aldrig** från källan på servern — klienten förifyller dem. Beredning = rutt (med `routing_operation_files`) + BOM med ommappad operationslänk; Inköp = katalog med huvudleverantör + staffel; Ritningar och filer = `article_files` + ritningsnummer. Kopieras aldrig: revisioner, lager, historik, konfiguratormall, kundpriser/prislistor.
- Dialogen (`CopyFromModal`) öppnas inifrån Ny artikel — därför stoppar `Modal`s `onCancel` propagering så Esc bara stänger den översta dialogen.

## Artikelfiler (ritningar)

- `article_files` (bytea i Postgres, PDF/JPEG/PNG, max 20 MB) är subresursen `/articles/:id/files` med fliken **Filer**. Repositoryts listnings-queries får **aldrig selecta `data`-kolumnen**.
- Tvärmodulsläsning via `ArticleFileReader` (`listFiles`/`filesWithData`): **TO-utskriften** (`GET /manufacturing-orders/:id/pdf`, `renderManufacturingOrder` + `appendFilesToPdf` i `pdf-merge.ts` med pdf-lib) bakar in ritningarna som extra sidor, och **ordermejl** bifogar dem när `attachDrawings` är satt (loggas på `email_log` så omskick återanvänder valet).

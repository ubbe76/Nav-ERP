---
paths:
  - "apps/api/src/modules/planning/**"
  - "apps/web/app/tillverkning/behovsberakning/**"
  - "apps/web/app/artiklar/oversikt/**"
  - "apps/web/components/planning/**"
  - "apps/web/lib/moSuggestions.ts"
  - "packages/shared/src/planning.ts"
  - "packages/shared/src/units.ts"
  - "apps/web/lib/units.ts"
  - "apps/api/test/planning*"
  - "apps/api/test/requirements*"
  - "apps/api/test/due*"
  - "apps/api/test/units*"
---

# Behovsberäkning, artikelöversikt och färdigdatum

Produktionsplanering/kapacitet/Leveranstidskontroll: `production-planning.md`. Effektiva leveransdatum på orderrader: `order-dates.md`. Leveransdagar och arbetsdagar: `delivery-days.md`. Konfigurerade KO-rader som behov: `configurator.md`.

## Behovsberäkningen

- **Resultatcachen:** `planning.service.ts` cachar resultatet i `REQUIREMENTS_CACHE_MS` (60 s, delat mellan användare, promise-cachat så samtidiga anrop delar en körning, misslyckad körning cachas inte). Sidbyte/sök/filter/CSV filtrerar cachen och muterar den aldrig. `?refresh=true` (**Uppdatera**, och webben efter Skapa ordrar/förfrågan) räknar om; `createOrdersFromProposals` nollar cachen **efter** att ordrarna skapats. Svaret bär `computedAt` (**Beräknad hh:mm:ss**). Integrationstester skapar tjänsten med `requirementsCacheMs: 0`.
- **Skapa ordrar** (`POST /planning/orders`, ärlig partiell framgång): TO:erna skapas **före** IO:erna (annars ser ett inköpt material inte den nya TO:ns behov) och i low-level-code-ordning (föräldrar först, så komponentens TO hamnar före förälderns), med färdigdatumet satt serversidigt. IO:ns **Önskat leveransdatum** = samma förslag (ordern det tidigaste, en rad med senare behov sitt eget), via `suggestPurchaseDeliveryDate` med huvudleverantörens dagar och katalogens ledtid; `late` ⇒ post i `warnings` (alltid närvarande, stoppar aldrig). `repo.deliveryContext` laddas efter att TO:erna skapats och får aldrig fälla anropet (misslyckas den dateras raderna som före funktionen). Skapa ordrar sätter aldrig bekräftat datum.

## Avrundning (`articles.rounding`, migration 0090)

- Ett positivt steg med högst 3 decimaler (numeric(14,3), CHECK > 0); antal avrundas **uppåt**, alltid i **basenhet**. Rena `roundUpToMultiple(quantity, step)` (`packages/shared/src/units.ts`, spegel `apps/web/lib/units.ts`) är enda implementationen så ett förslag och ordern det blir aldrig skiljer sig.
- Behovsberäkningen (`requirements-calc.ts`) tillämpar den **sist**, efter `order_quantity`-multipeln (100 kg i 7,38 kg-stänger ⇒ 103,32); kaskaden till komponentbehov använder det avrundade förslaget; `RequirementRow.rounding` följer med till webben.
- Orderservicarna via `roundForArticle` **i servicelagret, aldrig i routes**: sales `resolveRowInput` (efter `toBaseQuantity`, **före** `resolvePrice` så staffeln ser det beställda antalet) + `updateRow`; purchase `resolveRowInput` (IO-create/addRow/förfrågan) + `updateInquiryRow` + `updateRow`; manufacturing `createManufacturingOrder` (KO→TO ärver). `POST /planning/orders` avrundar därmed även ett handredigerat förslag. `getArticle`-läsarna i de tre servicarna bär `rounding: string | null` (manufacturing-servicens `articleFiles`-parameter breddades med `getArticle`).
- En rad i alternativ enhet visar efteråt ett icke-runt antal (steget gäller basenheten); UI:t avrundar aldrig själv. Fältet ligger i Lager-flikens Planering-kort.

## Artikelöversikt (planeringsbild)

- `GET /articles/:id/overview` (planning-modulen, subresurs från ägande modul). Rena `article-overview.ts` (`buildArticleOverview`, noll DB-importer) delar statusmängderna (`DEMAND_SALES_STATUSES` m.fl. ur `requirements-calc.ts`) och `explodeOneLevel` med behovsberäkningen — invarianten `closingBalance === projected − demandDerived` testas rent och mot databasen, så läsarna kan aldrig tycka olika om vad som räknas.
- Raderna är signerade (behov < 0), datum stigande med `null` sist (tillgång före behov samma dag, sedan fast typordning och ordernummer), `balance` löpande från `onHand` (4 decimaler), utkast-IO märkta `isDraft` men räknade (som `supplyPoDraft`). Datum: KO/IO radens effektiva datum, TO `due_date` — materialrader ärver TO:ns datum. Planerade TO:ers explosion filtrerar `configuration IS NULL`. Planeringsservicens `toShipDates` flyttar KO-datum till avsändningsdagen innan de rena funktionerna körs.
- Webben: sidan `/artiklar/oversikt` (`?article=`) och den flytande **icke-modala** panelen (`ArticleOverviewProvider` i `AppShell` — EN panel per sida, `show(id)` byter artikel; `ArticleOverviewPanel` drar med pointer events, läget i localStorage, bottom sheet ≤ 640 px, z-index 40 under mobilnavens 45). `ArticleOverviewButton` på raderna i behovsberäkningen, TO-listan, artikelregistret, lagersaldon, IO-/KO-kortens rader och artikelkortets huvud; `ArticleOverviewContent` (med sökfältet) delas av sida och panel. `ArticlePicker`s `value` är `ArticlePickerValue` (id/nummer/namn).

## Färdigdatumsförslag för ny TO

- `GET /articles/:id/due-date-suggestion[?salesOrderRowId=]` föreslår **arbetsdagen före** artikelns första **skarpa behov** (KO-rad / TO-materialbehov), idag som tidigast.
- Rena `due-date-suggestion.ts` (`findFirmDemand` → `suggestDueDate`) räknar **täckning på kvantitet, inte tidsfasat**: lager + ALLA öppna IO/TO (även odaterade/sena) fördelas på behoven i datumordning — samma nettning som behovsberäkningen — och bara ett otäckt behov är skarpt. Med `salesOrderRowId` gäller radens eget datum om raden är otäckt, annars första otäckta behov; en konfigurerad rad utgår från radens leveransdatum.
- Arbetsdag = mån–fre utom heldagshelger i `holidays` (helgdag med dagschema = kortdag = arbetsdag); företaget saknar eget veckoschema.
- Webben: delade `SuggestedDueDateField` (manuellt vinner, request-sekvens) i **Ny tillverkningsorder** och KO-radens **Skapa TO** (`createFromSalesOrderRowSchema.dueDate`). Rena `POST /manufacturing-orders` utan `dueDate` lämnas medvetet odaterade (integrationer).

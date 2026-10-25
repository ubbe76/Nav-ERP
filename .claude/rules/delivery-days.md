---
paths:
  - "apps/api/src/modules/system/service/delivery-days*"
  - "apps/api/src/modules/system/repository/delivery-context*"
  - "packages/shared/src/delivery.ts"
  - "packages/shared/src/business-date.ts"
  - "apps/web/lib/useDeliveryDateSuggestion.ts"
  - "apps/web/components/ui/DeliveryDateHint*"
  - "apps/api/test/delivery-days*"
  - "apps/api/test/business*"
---

# Fasta leveransdagar, transportdagar och arbetsdagar (migration 0122)

Spec `docs/superpowers/specs/2026-10-17-fasta-leveransdagar-design.md`.

- **Data:** `suppliers` och `customers` bär `delivery_weekdays` (smallint[], ISO 1–7, tom = inga fasta dagar), `delivery_day_mode` (enum arrival|dispatch, null = förvalet) och `transit_days` (0–60, null = förvalet); zod `partnerDeliveryFields` (`packages/shared/src/delivery.ts`) sorterar och tar bort dubbletter. Förvalen är `system_settings`-nycklarna `supplier_delivery_day_mode` (arrival), `supplier_transit_days`, `customer_delivery_day_mode` (dispatch), `customer_transit_days` (0); veckodagarna har inget förval.
- **All datumlogik bor i rena `system/service/delivery-days.ts`** (noll DB-importer), även `isWorkingDay`/`previousWorkingDay`/`addDays` som `due-date-suggestion.ts` re-exporterar — EN implementation. `system/repository/delivery-context.ts` (`loadDeliveryContext`, `Db | Tx`) laddar förvalen och heldagshelgerna i fönstret `deliveryHolidayWindow`.
- Ledtid och transportdagar räknas i **arbetsdagar**; "från i dag" startar på `nextWorkingDayOnOrAfter(today)`; sökningar efter en listad dag ger upp efter 60 dagar och returnerar indatumet. `latestDispatchFor` **startar vid senaste möjliga avsändningsdag** (`latestDispatchStart`: dagen före den transit:e arbetsdagen räknat bakåt, kan vara en ikryssad lördag), inte vid leveransdatumet, eftersom transit är upp till 60 arbetsdagar — en brute-force-jämförelse i `delivery-days.test.ts` pinnar ekvivalensen.
- **Utan inställningar (inga dagar, transit 0, ledtid 0) kortsluter allt till beteendet före funktionen** (testat).
- **Datumintervallet:** fält som matar datumaritmetiken (förslagsfrågornas `date`, kundorderns `expectedDeliveryDate` i create och header-PATCH) valideras med `businessDateSchema` (`packages/shared/src/business-date.ts`, 1900-01-01–2999-12-31) — `addDays` på år 9999 ger `+010000-…` som Postgres avvisar. `deliveryHolidayWindow` klampar till samma intervall (`BUSINESS_DATE_MIN/MAX`) så äldre lagrade datum aldrig ger 500 i artikelöversikten.
- **Semantik:** leverantörens datum är ett **ankomst**datum; kundorderns `expected_delivery_date` är dagen **kunden får varan**, och behovet ligger på `shipDateFor` = avsändningsdagen. Planeringsservicens `toShipDates` gör om KO-datumen innan de rena funktionerna körs (repositoryt laddar kundens fält som `customerDelivery`); behovsnettningen är inte tidsfasad och påverkas inte.
- **Endpoints** (bara webbens förslag — `POST /quotes`/`POST /purchase-orders` utan datum förblir odaterade): `GET /supplier-delivery-date-suggestion?supplierId[&articleId][&date]` (purchase; huvudförslag bara när leverantören har dagar, radförslag med katalogradens `lead_time_days`) och `GET /customer-delivery-date-suggestion?customerId[&date]` (sales; bara när kunden har dagar). Båda ger `summary`/`warning`-texter som webben visar rakt av (`lib/useDeliveryDateSuggestion.ts` med request-sekvens, `components/ui/DeliveryDateHint.tsx`; touched-mönstret på Ny inköpsorder, Ny kundorder och IO-kortets Lägg till rad).
- Skapa ordrar daterar inköpsraderna med `suggestPurchaseDeliveryDate` ur det **råa** behovsdatumet (`DueDateSuggestion.demandDate`), katalogens ledtid och huvudleverantörens effektiva inställningar (`primarySuppliersFor` bär `supplierDelivery`) — se `planning.md`. Lego-IO:er, förfrågan, PDF:er, importerna och leveransprecisionsrapporten berörs inte. Planeringsservicen har en `today`-dep för testerna.

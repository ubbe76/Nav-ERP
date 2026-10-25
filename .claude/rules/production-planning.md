---
paths:
  - "apps/api/src/modules/planning/service/capacity-*"
  - "apps/api/src/modules/planning/service/production-plan*"
  - "apps/api/src/modules/planning/service/delivery-time-check*"
  - "apps/api/src/modules/planning/repository/**"
  - "apps/web/app/tillverkning/belaggning/**"
  - "apps/web/app/forsaljning/leveranstidskontroll/**"
  - "apps/web/lib/deliveryTimeCheck.ts"
  - "apps/web/lib/planning.ts"
  - "apps/api/test/production*"
  - "apps/api/test/capacity*"
  - "apps/api/test/delivery-time*"
---

# Produktionsplanering, kapacitet och Leveranstidskontroll

## Produktionsplanering (migration 0124)

Spec `docs/superpowers/specs/2026-10-17-produktionsplanering-design.md`.

- **Data:** varje `mo_operations`-rad kan ha en planerad vecka. Allokeringen (minuter per ISO-vecka, nycklad på måndagen) ligger i `mo_operation_plan_weeks` och speglas på `mo_operations.planned_start_week`/`planned_end_week` (+ `plan_locked`, `planned_at`; CHECK: båda eller ingen, måndagar, aldrig lås utan plan).
- **Enda skrivaren är `writeOperationPlans`** (`planning.repository.ts`): DELETE + INSERT, speglingen som EN `UPDATE … FROM (VALUES …)` per batch, `clear` nollar även låset. Varje allokering går genom rena `roundPlanWeeks` (`capacity-book.ts`: två decimaler, aldrig en rad under `MIN_PLAN_MINUTES` = 0,01 min, en bortavrundad vecka slås ihop med grannen, en operation utan rader kvar rensas) så CHECK `minutes > 0` aldrig faller. Boken bokar aldrig under 0,01 min: ledig tid under tröskeln är 0, en rest under den läggs i veckan med den sista hela biten.
- **En hinkregel:** `operationLoadWeeks` (`capacity-calc.ts`). Oplanerade operationer räknas i färdigdatumets vecka (ingen backfyllnad); planerad ⇒ återstående tid fördelad **bakifrån** över allokeringen (`remainingByPlannedWeeks`). Rapportering rör aldrig plan-raderna.
- **Motorn är ren:** `capacity-book.ts` (en placeringsregel, delad med Leveranstidskontrollen) + `production-plan.ts` (`planProduction`): prioritet färdigdatum stigande/null sist, låsta = fast last, påbörjade tvingas till innevarande vecka, lego via ledtid, horisont 104 veckor ⇒ oplanerad + varning.
  - `long_operation`: en egen operation vars återstående tid överstiger `LONG_OPERATION_WEEKS` (4) normalveckor av resursens kapacitet (40 h utan kapacitet; lego undantas) — planeras ändå.
  - Delbokningar före horisonten släpps med `book.release` så de inte blir fantomlast för nästa TO (Leveranstidskontrollen behåller dem medvetet). En TO som nått horisonten är Sen när färdigdatumet passerat (som `orderPlanStatus`).
  - Sekvensbrottstexter: en påbörjad operation tvingad före föregående ⇒ "är påbörjad"; flyttens övriga planerade operationer skickas som `fixed` ⇒ "är planerad och ligger fast"; bara ett riktigt lås ⇒ "är låst".
- **Låset `pg_advisory_xact_lock(hashtext('production_plan'))`** (`planning/repository/plan-lock.ts`) tas av Planera (`POST /planning/plan`), Flytta (`POST /planning/operations/:opId/move`, `moveOperationSchema` = måndag + `moveFollowing`, sätter `plan_locked`; 404 `operation-not-found`, 400 `plan-week-in-past`, 409 `operation-not-plannable`), Lås upp (`…/unlock`, idempotent) och **varje `createManufacturingOrderInTx`** — där **före** KO-radlåset och ordernumret. Den nya TO:n planeras mot all annan last efter `releaseInTx` via sent bundna `ManufacturingPlanReader` (`planReaderRef` i `app.ts`; horisont/Sen hamnar i `releaseWarnings`).
- `manufacturingService.createManufacturingOrderInTx(tx, input, createdBy, { plannedWeeks })` loggar inget själv; stämmer `plannedWeeks` sekvensnummer inte med TO:ns operationer (mallen ändrad) planerar motorn i stället och `releaseWarnings` säger det.
- En operation på en resurs utan kalender blir aldrig "klar" en helgdag (`weekFinishDay` → nästa arbetsdag).
- **Läsare:** `GET /planning/capacity` (per operation `moOperationId`/`hoursInWeek`/`planned`/`plannedStartWeek`/`plannedEndWeek`/`planLocked`/`late` + `summary`), `GET /terminal/operations`, `GET /manufacturing-orders[/:id][/:id/operations]` (planerade veckor, `late` via `orderPlanSummaries`), Leveranstidskontrollen (`existingOperations`).
- **Webben:** **Planera** och sammanfattningsraden i Beläggning; `MoveOperationDialog` (**Flytta…**, innevarande vecka utan ledig-tid-siffra, **Flytta även efterföljande operationer** förvald, **Lås upp**); **Planerad**/**Sen**/**Låst** på TO-lista och TO-kort; terminalens förval **Planerad vecka**.
- Tester: `production-plan.integration.test.ts` ("i dag" pinnat till en måndag 2030), `production-plan.route.test.ts`.

## Resursens kapacitet

Från veckoschemat eller, utan schema, `work_centers.hours_per_day` (**Kapacitet (timmar per dag)**, migration 0123, CHECK 0–24): timmarna mån–fre, röd dag ledig, kortdag på helgdagens dagschema. EN dagsregel `resourceDayMinutes(lookups, { weekScheduleId, hoursPerDay }, date)` i `capacity-calc.ts` för både beläggningsvyn (`hasSchedule` betyder "har kapacitet") och Leveranstidskontrollen; veckohinkar via `loadBucketMonday`.

## Leveranstidskontroll

Spec `docs/superpowers/specs/2026-10-17-leveranstidskontroll-design.md`.

- `POST /delivery-time-check` (regeln `DELIVERY_CHECK` = Försäljning eller Tillverkning) är en POST som bara läser — **inget bokas**, två kontroller ser inte varandra. Tar `rows` (`.min(1)`, tom lista ⇒ 400 även med order) och/eller `salesOrderId` (orderns öppna restrader och kund; orderns egna rader räknas inte som befintligt behov; annan status än offert/bekräftad/under tillverkning ⇒ 409 `sales-order-not-open`, `SalesOrderNotOpenError`) och valfri `customerId`.
- Trädets artikelöversikter laddas i EN batch (`repo.loadArticleOverviewInputs` med `inArray`; `loadArticleOverviewInput` delegerar dit) med ETT `deliveryContext` (`planningService.getArticleOverviews`, per artikel identisk med `getArticleOverview` — testat mot databasen).
- Reglerna i rena `delivery-time-check.ts` (`checkDeliveryTime`, noll DB-importer):
  - **Pool** per artikel ur artikelöversiktens rader (redan på avsändningsdagar): lager klart `t0`, öppen tillgång på sitt datum (odaterad = `t0` + notering), befintliga behov drar först i datumordning.
  - **Brist** på köpt artikel = `suggestPurchaseDeliveryDate` med huvudleverantörens ledtid och leveransdagar; på tillverkad = `explodeOneLevel` (fantomer) rekursivt och operationerna på en **kapacitetsbok** per resurs och vecka (innevarande vecka från i dag; klar = sista arbetsdagen i veckan operationen slutar; lego = resursens `lead_time_days` arbetsdagar; resurs utan kapacitet obegränsad; horisont `CHECK_HORIZON_WEEKS` = 104).
  - Avsändningsdag = nästa arbetsdag efter senaste klar-datum (allt klart `t0` ⇒ `t0`), leveransdatum = `deliveryFromShipDate` (`delivery-days.ts`, som `earliestCustomerDelivery` bygger på). Svaret bär per rad den **kritiska kedjan** (`DtcStep`: stock/supply/purchase/operation/subcontract) och noteringar.
  - En tillverkad artikel utan struktur och rutt ger noteringen *saknar beredning* men **inget parti** (ingen TO utan operationer).
- **Konfigurerade rader:** `deriveForManufacturing` med `allowVariants` (det läsande anropet får härleda en variantmall); en befintlig variant räknas som artikel, en mall utan konfiguration ⇒ 409 `configuration-required`. En konfigurerad orderrads redan länkade TO:er (ej avbrutna, `linkedOrders`) nettas med `uncoveredConfiguredQuantity` — samma implementation som behovsberäkningen, så raden får aldrig en andra TO. Bristen avrundas med `roundUpToMultiple`, strukturen härleds för det avrundade partiet (`DtcStructure.quantity`, `covered`); den täckta delen är klar på TO:ns planerade klar-dag (sista planerade veckan, annars färdigdatum, klar TO ⇒ i dag) och visas som `supply`-steg.
- **Webben:** **Leveranstidskontroll** på kundorderkortet och i Ny kundorder (**Använd datumet** — `PATCH /sales-orders/:id` `expectedDeliveryDate`, under huvudets statusvakt och revisionsfrågan), sidan `/forsaljning/leveranstidskontroll`, delad `DeliveryTimeCheckResult`.

## Reservationen (`POST /delivery-time-check/apply`)

`applyDeliveryTimeSchema` = `salesOrderId` + `deliveryDate` + valfritt `expectedOrders`; regeln `DELIVERY_CHECK` fast anropet skriver (KO:ns statusvakt och manufacturing-servicens regler är dubbelkontrollen). `planningService.applyDeliveryTime` gör allt i EN transaktion:

1. `production_plan`-låset **först**.
2. Kontrollen om med alla läsare bundna till transaktionen (`runDeliveryTimeCheck(request, { dbc, action: "reserve" })`; `loadArticleOverviewInputs`, `deliveryCheckOrder` (bär `linkedOrders`), `deliveryCheckArticles`, `routingsForArticles`, `primarySuppliersForArticles`, `deliveryContext` m.fl. är `Db | Tx`; konfiguratorns härledning läser committat som `prepareCreate`). `reserve` kräver bekräftad/under tillverkning (annars `SalesOrderNotOpenError(status, "reserve")`). Ett annat `deliveryDate` än klientens — eller annat antal partier än `expectedOrders` (antalet TO:er klienten visade = `batches.length`) — ⇒ 409 `delivery-time-changed` med den nya kontrollen i `result`, inget skrivet; inga `batches` ⇒ 409 `nothing-to-reserve`.
3. **Alla KO-rader som får en TO låses** (`SalesOrderDateWriter.lockRowsInTx`, sorterat, `FOR UPDATE`) så låsordningen blir advisory → rader → orderhuvud, samma som `updateRow`/`replaceRowConfiguration` (annars deadlockrisk via `markInProduction`).
4. En TO per `DtcBatch` **barn före föräldrar** via `createManufacturingOrderInTx` med `plannedWeeks` ur kontrollen (nivå 1 `salesOrderRowId` = `rowKey`; lägre nivåer `note` *"Skapad från leveranstidskontroll för KO-…"*; `dueDate` = partiets `readyDate`). Direkt efter varje TO **låses dess planerade operationer** (`repo.lockOrderPlans`; lego/0-minuters saknar plan) så Planera inte flyttar det lovade datumet förrän någon väljer **Lås upp**.
5. KO:ns Förväntat leveransdatum via `SalesOrderDateWriter.setExpectedDeliveryDateInTx` (raden `FOR UPDATE`, header-PATCH:ens statusvakt, **ingen revisionsbump**).

Ett fel var som helst rullar tillbaka allt. Svar `{ deliveryDate, shipDate, manufacturingOrders: [{ id, orderNumber, articleNumber, quantity, level, salesOrderRowId }], warnings }` (`quantity` = TO:ns faktiska antal ur `prepareCreate`s avrundning; TO:ernas `releaseWarnings` prefixade med ordernummer). Felen mappas som i `POST /manufacturing-orders`: `LinkedOrderStatusError`/`ArticleIsTemplateError`/`ConfiguratorNotToOrderModeError`/sales `ConfigurationRequiredError` ⇒ 409, `LinkedRowNotManufacturedError`/`LinkedRowArticleMismatchError`/sales `ConfigurationNotAllowedError` ⇒ 400; händelselogg efter commit: `released` per TO + `delivery_time_applied` på KO:n. Webben: kryssrutan **Skapa tillverkningsordrar för det som saknas (N st)** bara på bekräftad order eller under tillverkning (`canCreateOrders`). Tester: `delivery-time-apply.integration.test.ts`, `delivery-time-apply-configured.test.ts`, `delivery-time-apply.route.test.ts`.

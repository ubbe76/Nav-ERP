---
paths:
  - "apps/api/src/modules/manufacturing/**"
  - "apps/web/app/tillverkning/ordrar/**"
  - "apps/web/app/tillverkning/terminal/**"
  - "apps/web/app/tillverkning/pagaende/**"
  - "apps/web/components/manufacturing/**"
  - "apps/web/lib/manufacturingOrderActions.ts"
  - "apps/web/lib/materialShortage.ts"
  - "apps/web/lib/releaseWarnings.ts"
  - "apps/web/lib/terminalOperations.ts"
  - "packages/shared/src/manufacturing.ts"
  - "apps/api/test/mo*"
  - "apps/api/test/manufacturing*"
  - "apps/api/test/material*"
  - "apps/api/test/terminal*"
  - "apps/api/test/lego*"
  - "apps/api/test/e3*"
---

# Tillverkningsorder (TO)

MO = Manufacturing Order / tillverkningsorder. Planerade veckor och `production_plan`-låset: `production-planning.md`. Konfigurerad TO (`manufacturing_orders.configuration`): `configurator.md`. Stämplingarna: `timereport.md`.

## Frisläpp och rapportering

- **Materialuttag kan styras av rutten:** en BOM-rad kan peka på en av artikelns egna operationer (`bom_components.routing_operation_id`); vid frisläpp snapshotas kopplingen till `mo_material_consumptions.mo_operation_id`.
- **En ny TO frisläpps i sin egen create-transaktion** (`releaseInTx` i `manufacturing.repository.ts`, delad med **Släpp**): alla vägar (Ny tillverkningsorder, KO-radens Skapa TO, behovsberäkningens Skapa ordrar, API:t) ger en stämplingsbar order direkt. Svaret bär `releaseWarnings` (bristvarningarna; webben lämnar dem till TO-kortet via sessionStorage). `planned` finns bara kvar för äldre ordrar — tester som behöver en sådan använder `test/helpers/planned-manufacturing-order.ts`.
- **KO-länken:** `prepareCreate` prövar KO:ns status före transaktionen; i transaktionens sista steg låser `markSalesOrderInProduction` (sales-lövet `production-transition.ts`) huvudet `FOR NO KEY UPDATE` — samma lås som statusens UPDATE, så låsordningen rader → huvud är oförändrad — flyttar Bekräftad → Under tillverkning och returnerar statusen, och servicens wrapper kastar `LinkedOrderStatusError` (TO:n rullas tillbaka) för allt annat än Bekräftad/Under tillverkning. Åt andra hållet är `sales.cancel` villkorad på den lästa statusen (`updateStatus(…, fromStatus)`). Test: `manufacturing-sales-link.test.ts`.
- **Antal rapporteras inkrementellt** (varje utstämpling i terminalen + TO-kortets Slutför operation, gemensam väg `reportOperationQuantities`): OK och kasserat ackumuleras på operationen (`quantity_completed`/`quantity_scrapped`); kassation kräver orsak och loggas i `mo_operation_scrap`.
- **Kassationsorsaken (Kvalitet, 0153):** `mo_operation_scrap.reason_id` → `deviation_reasons` (CHECK `reason_id` eller `reason`); `reason` är kommentaren (eller hela orsaken på äldre rader). `assertScrapReason` i servicen avgör kravet: finns en **aktiv** orsak med `applies_scrap` krävs `scrapReasonId` (400 `scrap-reason-required`; okänd/inaktiv/icke-kassation ⇒ 400 `scrap-reason-invalid`), annars fritext som förut. Terminalen prövar den i torrkörningen (`assertMaterialBeforeOperationReport`) innan tidrapporten skrivs, och den skarpa rapporten (`materialShortageChecked`) prövar inte igen. `listScrapForOrder` bär `reasonId/reasonCode/reasonName`. Avvikelserna: `quality.md`.
- **Top-up-regeln** (`consumeLinkedMaterial`): `target = planerat/orderantal × (totalt OK + totalt kasserat)`, bara `target − redan förbrukat` bokförs. Kasserat drar alltså komponenter, överrapportering drar mer, och manuell förbrukning eller omrapportering dubbelbokförs aldrig. Vägen har medvetet **inget** planerat-tak (det hör till manuella `consumeMaterial`). Okopplat material dras i takt med inleveransen.
- **Delinleverans:** OK på orderns **sista** operation (högst sekvensnummer, även en lego-operation via IO-inleveransen) är färdiga varor. `reportOperationQuantities` tar ordern `FOR UPDATE` och lägger in mellanskillnaden mot `manufacturing_orders.quantity_received` (migration 0116, backfyllt ur `mo_receipt`) via `receiveFinishedGoods`, som också drar okopplat material upp till inlevererat antal. Frisläppt ⇒ pågår vid första inleveransen; inlevererat = orderns antal ⇒ `done` (historikraden `completed` med `automatic: true`).
- **Slutför** delar `receiveFinishedGoods`: `quantity` är det som läggs in **nu** (utelämnat = återstoden, 0 stänger en kort order). **Slutför order** går från frisläppt och frågar innan ordern stängs kort.
- **Efterrapportering på en Klar order:** `reportOperationQuantitiesInTx` och `consumeMaterial` tar emot `done` (först `closed` — **Stäng order** — låser). Antal, kassation och kopplat material bokförs som vanligt men **ingen** `receiveFinishedGoods`, inte ens från sista operationen, och statusen ändras inte — mer gods kräver att det som gjorde ordern klar ångras först. Lego-inleveransen på en klar TO blir därmed en efterrapport (bara stängd ger `operationReport: { ok: false }`). Terminalen (`stampIn`, `GET /terminal/operations`) förblir stängd för klara ordrar (regel 10); TO-kortets kort Rapportera (`ReportPanel`, grupperingen i `lib/moReportRows.ts`) visar Förbruka/Slutför/Rapportera tid även på Klar. `undoReportInTx` behöver inget: en efterrapport har `quantity_received` 0, så `stillDone` håller. Tester: `manufacturing.service.test.ts` (receipt from the last operation), `mo-report-undo.test.ts`, `legoresurser.test.ts`.
- En öppen TO räknas som tillgång (behovsberäkning, artikelöversikt) med `greatest(quantity − quantity_received, 0)`.
- **Rapporteringsloggen** (`mo_reports` + `mo_report_materials`, migration 0117, backfylld som en `migration`-rad per operation + en Slutför order-rad per klar order): varje utstämpling (även 0/0, `logTimeOnlyReport`), Slutför operation, lego-inleverans (`source = purchase_receipt`), Slutför order, manuell **Förbruka** och automatisk utstämpling (`auto_close`) skriver en rad i sin egen transaktion med exakt vad den bokförde (antal, `marked_done`, inleverans + plats, `completed_order`, materialrader + plats, `time_report_id`).
- **Ångra rapportering** (`undoReport`, `POST /manufacturing-orders/:id/reports/:reportId/undo`, admin/arbetsledare): backar exakt raden i en transaktion — material tillbaka till sin plats, varor ut från sin plats (vägras när de inte finns kvar), kassationsraden och tidrapporten bort (låst löneperiod vägrar), en klar order öppnas igen; raden får `undone_at`. Lego-rader ångras på IO:n (`undoPurchaseReceiptReportInTx` → repo `undoReportInTx` med `fromPurchaseReceipt`, se `purchase.md`); TO-kortet vägrar dem.
- Ingen **Starta** i webben (API-vägen finns kvar). **Makulera order** (`cancel`, även från pågår) ⇒ 409 så länge en levande rapport med effekt, förbrukat material eller en öppen stämpling finns.

## Materialbrist vid rapportering

- Inställningen `manufacturing_material_shortage` (`manufacturingMaterialShortage: none|warn|block`, saknad ⇒ `none` = inget ändrat beteende). "Tillgängligt" = komponentens **totala saldo över alla platser** (samma bas som `releaseInTx`s `shortageWarnings`); `service`-artiklar kontrolleras aldrig; ångra-vägarna berörs inte.
- `manufacturing/service/material-shortage.ts` (`assertMaterialAvailable`, `Db | Tx`) äger `MaterialShortageError` (409 `material-shortage`, kroppen `{ error, code, overridable, shortages[] }` via `materialShortageBody`, delad av alla fem rutterna). Den körs **inne i rapportens transaktion efter att uttagen bokförts**: summerar de dragna raderna (`ConsumedMaterialLine[]` — aldrig egen top-up-aritmetik), låser artiklarna sorterat `FOR NO KEY UPDATE` och läser sedan totalsaldot. **Inte** `FOR UPDATE` — det krockar med FK-insertens `FOR KEY SHARE` och deadlockar två rapporter som båda redan skrivit lagerrader.
- Läget läses utanför transaktionen (`createManufacturingService`s sista, valfria `settings`-läsare; utelämnad ⇒ `none`, så fixturerna fungerar) och skickas som `materialShortage: { mode, allow }` till `reportOperationQuantities`/`complete`/`consumeMaterial`. `warn` + `allowMaterialShortage: true` (flaggan finns i stop-/complete-/consume-/receive-scheman) hoppar över, `block` ignorerar flaggan.
- **Terminalen** (`doStampOut`: tidrapport, stängd session och rapport är separata operationer) kör `assertMaterialBeforeOperationReport` **före** allt skrivs — en torrkörning av samma rapport i en transaktion som alltid rullas tillbaka (`repo.dryRunOperationReport`) — och den skarpa rapporten går med `materialShortageChecked`. Fönstret däremellan kan ge negativt saldo; accepterat.
- **Lego-inleveransen** (`SubcontractOperationReporter.assertMaterialBeforeSubcontractReceipt`) torrkör bara i `warn`; i `block` står inleveransen kvar och rapporten blir `operationReport: { ok: false, message }`.
- Tester: `material-shortage.test.ts` (läge × väg) och `material-shortage.route.test.ts` (409-kroppen).

## Ändra material och operationer på en skapad TO

Spec `private/superpowers/specs/2026-10-18-andra-tillverkningsorder-design.md`.

- `POST/PATCH/DELETE /manufacturing-orders/:id/materials[/:rowId]` och `…/operations[/:opId]` (zod `createMoMaterialSchema`/`updateMoMaterialSchema`/`createMoOperationSchema`/`updateMoOperationSchema`, skriv = `tillverkning`) ändrar **bara TO:ns egna rader** (`mo_material_consumptions`/`mo_operations`, aldrig BOM/rutt), i status released/in_progress (annars 409 `manufacturing-order-not-editable`). Transaktionskropparna i `manufacturing/repository/order-edit.ts`; `shortage-warnings.ts` delas med frisläppet.
- **Material:** antal i vald enhet, lagrat i basenhet via `resolveUnitSelection` + `toBaseQuantity`. Spärrar egen artikel/fantom/variantmall/operation på annan order; dubblett fångas på constraint-namnet `mo_material_unique_per_operation`. Artikelbyte och borttag bara utan förbrukning och utan `mo_report_materials` (409 `mo-material-consumed`). Sänkt antal under förbrukat är tillåtet.
- **Operationer:** legoregeln `assertLegoFieldsForResource` (delad med rutt-CRUD); varje ändring planerar om ordern i samma transaktion via `ManufacturingPlanReader.replanOrderInTx` (Planeras regler för EN order; varningarna `long_operation`/`horizon`/`late`/`sequence` som texter; låst operation som byter resurs tappar låset). `last-operation-locked` låser vilken operation som är sist när `quantity_received > 0`.
- **Låsordning:** operationsändringar tar `production_plan`-låset → **alla** orderns operationer `FOR UPDATE` (sorterat på id) → ordern. Planskrivaren uppdaterar varje operation på ordern, så ordern före en operation skulle deadlocka mot rapporteringens operation → order. Materialändringar låser mål-operationen `FOR SHARE` (FK:ns key-share) → ordern → raden.
- Svar `{ material|operation, warnings }`, borttag av operation `{ warnings, unlinkedMaterials }`; händelselogg `material_added|changed|removed`/`operation_added|changed|removed` med before/after. Tester: `mo-edit.test.ts` (Postgres, alla spärrar + samtidig rapportering), `mo-edit.route.test.ts` (kontraktet).

## Terminalens operationslista

- `GET /terminal/operations` (+ `/terminal/stations`, `TERMINAL_READ`): en rad per stämplingsbar operation (frisläppt/pågående TO, pending, ej lego) med beredskap ur rena `terminal-readiness.ts` — första operationen alltid redo, annars föregående operations OK (även på annan station eller lego); spärrar aldrig. Bara **kopplat** material; `materials` i svaret är listan före materialfiltret.
- Förvalda stationer per anställd i `employee_work_centers`, bärs av `GET /employees/directory`. Webbens sortering/sök i `lib/terminalOperations.ts`.

## Transportkostnad på legooperationer (migration 0164)

- `routing_operations.transport_price` och `mo_operations.transport_price` (snapshot vid frisläpp, redigerbar i Ändra operationer) är ett legofält som Ställpris/Styckpris (`hasLegoFields`, `CLEARED_LEGO_FIELDS`, döljs utan prisbehörighet). **EN regel för legoorderns engångskostnad:** `legoOneOffSql(table)` i lövet `manufacturing/repository/lego-one-off.ts` = ställpris + transportkostnad (null bara när båda saknas). Den läses av behovsberäkningens legoförslag, förfrågans/IO-radens förifyllda ställpris (`resolveLegoOperationRef`) och för-/efterkalkylen — en ny läsare av legokostnaden ska gå genom den, aldrig läsa `setup_price` direkt.


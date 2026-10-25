---
paths:
  - "apps/api/src/modules/planning/repository/**"
  - "apps/api/src/modules/purchase/**"
  - "apps/api/src/modules/sales/**"
  - "apps/api/src/modules/reports/**"
---

# Leveransdatum på order och orderrader (migrationerna 0091, 0126)

- **Inköp:** `purchase_orders.expected_delivery_date` (Önskat, hela ordern) och `confirmed_delivery_date` (Bekräftat, header-PATCH); `purchase_order_rows.expected_delivery_date`/`confirmed_delivery_date` är radens avvikande datum via `POST/PATCH .../rows` (null = följer huvudet, `null` rensar). "Förifyllt på raderna" är arv — inga rader skrivs om när huvudet ändras.
- **Kundorder:** `sales_order_rows.expected_delivery_date` (`quoteRowSchema` — alltså även `POST /quotes` — och rad-POST/PATCH, null = följer huvudet).
- **Effektiva datum** är två SQL-uttryck i `planning/repository/effective-dates.ts`: `salesRowDeliveryDate` = `coalesce(rad, huvud)` och `purchaseRowArrivalDate` = `coalesce(rad bekräftat, huvud bekräftat, rad önskat, huvud önskat)` — bekräftat vinner alltid. De läses av artikelöversiktens KO-behov/IO-tillgång, de konfigurerade KO-raderna, `salesOrderRowForDueDate`, aviseringarna och orderförteckningen, så färdigdatumsförslaget, behovsberäkningens visningsdatum och Leveranstidskontrollen följer utan egen kod.
- **Listorna** (`listSalesOrders`/`listPurchaseOrders`, även CSV) bär `nextDeliveryDate` = tidigaste effektiva datum bland rader som inte är fullt levererade/mottagna, annars huvudets — KO-/IO-listornas Leveransdatum och Översiktens försenade ordrar läser det.
- **Dokument:** IO-/förfrågans PDF skriver **Önskat leveransdatum:** i huvudet (`DocumentPdfInput.requestedDeliveryDate`) och per rad bara när raden avviker (`DocumentPdfRow.requestedDeliveryDate`); IO-PDF:en skriver inte det bekräftade datumet. Offert/orderbekräftelse skriver **Leveransdatum:** i huvudet (`DocumentPdfInput.deliveryDate`) och per rad bara när raden avviker (`DocumentPdfRow.deliveryDate`, `ownDeliveryDate` i sales-servicen), plocklistan likadant (`PickListRow.deliveryDate`). IO-kortet visar/redigerar radens datum under benämningen.
- Radändringarnas `row_updated` loggar datumen i before/after bara när de faktiskt ändras (korten skickar alltid fälten).
- **Medvetet oförändrat:** leveransprecisionsrapporten (per order på huvudet, inköp mot Önskat), Leveranstidskontrollen (ett datum för hela ordern; **Använd datumet**/reservationen sätter bara huvudet, rader med eget datum behåller det) och Skapa ordrar (sätter aldrig bekräftat).

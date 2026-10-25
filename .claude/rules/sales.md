---
paths:
  - "apps/api/src/modules/sales/**"
  - "apps/web/app/forsaljning/**"
  - "apps/web/app/kunder/**"
  - "apps/web/components/sales/**"
  - "apps/web/components/partners/**"
  - "apps/web/lib/salesDocumentKind.ts"
  - "packages/shared/src/sales.ts"
  - "apps/api/test/sales*"
  - "apps/api/test/customer*"
  - "apps/api/test/quote*"
  - "apps/api/test/invoice*"
  - "apps/api/test/collective*"
  - "apps/api/test/deliveries*"
  - "apps/api/test/pallet*"
  - "apps/api/test/partner*"
---

# Försäljning: kunder, offert, kundorder, utleverans, faktura

Andra regelfiler som rör försäljningen: radernas leveransdatum `order-dates.md`, konfigurerade rader `configurator.md`, avrundning `planning.md`, valuta och priskedja `currency.md`, momskoder på fakturan `vat.md`, kundreskontran `ledgers.md`, fakturaarkivet `economy.md`, frakten `shipping.md`, e-faktura `einvoice.md`, villkorsregistren `register.md`, ordermejl/PDF `mail.md`.

## Offert och kundorder

- Offert och kundorder är rader i `sales_orders`. **Dokumentslaget härleds** (`salesDocumentKind` i `packages/shared/src/sales.ts`, webbspegel `apps/web/lib/salesDocumentKind.ts`, SQL `documentKindSql` i repositoryt): offert = status quote/lost, eller makulerad med `order_number = quote_number`; allt annat är order. `GET /sales-orders?kind=quote|order` (även CSV); sökningen träffar `quote_number`.
- **Nummerserier (migration 0138, spec `private/superpowers/specs/2026-10-22-offerter-design.md`):** en ny offert (`POST /quotes` utan `confirm`) får numret ur serien `quote` (**OF-**) i både `order_number` och `quote_number` (unik); **Ny kundorder** är en offert som bekräftas direkt (`createQuoteSchema`:s additiva `confirm`-flagga — `POST /quotes` är oförändrat för konfiguratorn) och får KO direkt (`quote_number` null). Offerter från före 0138 behåller sina KO-nummer.
- **KO-numret dras i repositoryts `updateStatus`** (transaktion, raden `FOR UPDATE`, bara när övergången faktiskt sker och posten fortfarande bär sitt OF-nummer) — alla vägar till en orderstatus (Bekräfta, orderbekräftelsemejlet, manuell status) går den vägen; Förlorad/Makulera från offert (även `markLost`) sätter tillbaka OF-numret. **Orderbekräftelsemejlet** reserverar KO-numret före renderingen (`reserveOrderNumber`, returnerar redan reserverat nummer) eftersom PDF:en måste bära det; ett misslyckat utskick behåller reservationen, statusen ändras först efter lyckad SMTP.
- Offert-PDF:en/-mejlet använder `quote_number ?? order_number`; orderbekräftelsen skriver **Vår offert:** (`DocumentPdfInput.quoteReference`). Kortets historik läser båda numren (`GET /audit-log?alsoEntityId=`).
- **Uppföljning (migration 0135, spec `docs/superpowers/specs/2026-10-21-offertuppfoljning-design.md`):** `sales_orders.quoted` (skapad som offert, `= !confirm`; backfylld bara för öppna offerter) och `quote_valid_until` (**Giltig t.o.m.**: förval i dag + `quote_validity_days` (30, 0 ⇒ null) i `createQuote` även via OAuth, aldrig vid `confirm: true`; header-PATCH bara i status quote). En utgången offert byter aldrig status själv — **Utgången** är härlett.
- **Statusen `lost`** (Förlorad): `POST /sales-orders/:id/lose { lossReasonId, lossNote? }` bara från quote (villkorad UPDATE med `lost_*` i samma sats; inaktiv orsak ⇒ 400 `quote-loss-reason-invalid`), `POST …/reopen` (**Öppna igen**) bara från lost (nollar `lost_*`, händelseloggens `reopened` bevarar orsaken); `setStatus` till lost utan orsak stämplar när/vem, från lost nollar. **Bekräfta** och orderbekräftelsemejlets övergång är villkorade på status quote (`updateStatus(…, fromStatus)`) så en samtidig Förlorad inte skrivs över. `lost` är avslutad överallt eftersom alla statusmängder är vitlistor — **en ny statusmängd för kundorder ska vara en vitlista**. Förlustorsakerna är registret `quote_loss_reasons` (register-modulen).
- **Kundens förfrågan** (`customer_inquiry_number`, migration 0139) står bredvid `customer_order_number` och `customer_reference`; "Er förfrågan:" bara på offert och orderbekräftelse, aldrig plocklista/följesedel/faktura.
- **Rader** är redigerbara (`PATCH`/`DELETE /sales-orders/:id/rows/:rowId`) tills ordern är helt levererad — radlåset i repositoryts transaktion (antal ≥ levererat, rad med leverans kan inte tas bort); en radändring i Under tillverkning räknar om orderstatusen precis som deliver. Antal avrundas med `roundForArticle` i servicen.
- Webben: **Försäljning → Offerter** (`/forsaljning/offerter`) och **Kundorder** delar `SalesOrdersPageClient` (`kind`) och `SalesOrderCardPage` (server-redirect efter `documentKind`; `/forsaljning/ordrar?status=quote|lost` skickas till Offerter).

## Kunder

- **Adresser:** kundens adressfält är besöksadressen; fakturaadress + `invoice_email` är kolumner på `customers`; valbara leveransadresser i `customer_delivery_addresses` (subresurs `/customers/:id/delivery-addresses`, max en förvald via partiellt unikt index). Kundordern bär `customer_order_number`/`customer_reference`/`delivery_address_id` (`POST /quotes`, header-PATCH med statusvakt quote/confirmed/in_production; adressen måste tillhöra orderns kund).
- **Ny leveransadress på ordern** (migration 0125): `newDeliveryAddress` (`newDeliveryAddressSchema`, utesluter `deliveryAddressId`) på `POST /quotes` och header-PATCH:en skapar adressen i orderns transaktion i `customer_delivery_addresses` — med `one_off = true` (engångsadress, CHECK aldrig förvald) om inte `saveToCustomer` — så att alla läsare (PDF:er, plocklista, frakt) fortsätter gå via `delivery_address_id`. Engångsadresser döljs i kundens lista, PATCH/DELETE-rutterna och importens matchning, kan inte väljas på en annan order, och `updateSalesOrderHeaderWithAddress` (statusvakten omläst under orderns radlås) raderar orderns gamla engångsadress när den byts.
- **Flaggor:** `our_supplier_number` (Vårt leverantörsnummer — spegel av `suppliers.our_customer_number`; skrivs **live** på offert/orderbekräftelse/faktura som "Vårt leverantörsnr hos er", medvetet ingen snapshot), `website`, `private_person`, `collective_invoicing`. **Privatperson** är ren presentation: `DocumentPdfInput.pricesIncludeVat` grossar upp à-pris/radsumma per rads `vatRate` och byter summablocket till Summa inkl. moms/Att betala + Varav moms — belopp och bokföring oförändrade; fakturan bär en `private_person`-snapshot som stämplas i `IssueStamp` vid utfärdande (aldrig i create).
- Kort: `/kunder/[id]` använder `PartnerTabs.tsx` (Allmänt / Villkor & frakt / Kontakter / Adresser via `deliveryAddresses`-propen). Kontakter (`customer_contacts`, `/customers/:id/contacts`) har max en huvudkontakt (partiellt unikt index, primärväxling i transaktion).

## Utleverans och plocklista

- **Utleverans** (`/forsaljning/utleverans`) rapporterar hela ordrar (`?order=<id>` förvald från kortet, förifyllda restantal, gemensam lagerplats) genom att loopa per-rad-endpointsen — inga batch-endpoints. **Plocklistan** (`GET /sales-orders/:id/pick-list`) visar restantal + platssaldon via `StockBalanceReader` (stockService injicerad).
- **Ångra utleverans (migration 0132):** `delivery_rows` bär `location_id` + `stock_transaction_id` (skrivs av `deliverBatch`; backfyllt genom att para leveransrad med lagerrad på order, artikel, antal och `created_at = delivered_at` — samma transaktion — med `row_number()` för samma artikel två gånger på en följesedel; oparade rader är null och kan inte ångras) och `undone_at`/`undone_by`. Enheten är **en leveransrad med hela sitt antal**; en följesedel vars alla rader är ångrade räknas som ångrad (härlett).
  - `undoDeliveryRow` (`POST /sales-orders/:id/deliveries/:deliveryId/rows/:deliveryRowId/undo`) i EN transaktion: varorna tillbaka som positiv `sales_delivery` utan `unit_cost` (`resolveStockLocation` återaktiverar en tömd plats), orderradens `quantity_delivered` ned, Levererad → Under tillverkning, raden stämplad.
  - Spärrar: orderstatus Under tillverkning/Levererad, följesedel på levande försändelse (`DeliveryOnShipmentError`), levererat efter ångra < nettofakturerat **inklusive utkast** (`DeliveryRowInvoicedError`, via `getInvoicedQuantitiesWith`), inventeringsspärren.
  - **Låsordning** följesedel → leveransrad → orderrad → order; frakten låser följesedlarna `FOR SHARE` i länkinserten och vägrar en helt ångrad (`ShipmentDeliveryUndoneError`).
  - Läsare som utesluter ångrade rader: följesedelns "Tidigare levererat" (och **Ångrad**-markering), pallkortet (helt ångrad ⇒ 409 `delivery-undone`), kolliförslaget, `listOpenDeliveries`, leveransprecisionen. Webben: **Ångra…** i kortets Följesedlar (`UndoDeliveryDialog`). Tester: `sales-delivery-undo.test.ts`, `sales-delivery-undo.route.test.ts`.

## Kundfaktura och samlingsfaktura

- Fakturamodulen är orderoberoende — `invoice_rows.sales_order_row_id` är enda orderlänken; fakturerad kvantitet räknas ur raderna.
- **Samlingsfaktura:** `runCollectiveInvoicing` (`invoice.service.ts`, `POST /collective-invoicing/run`, kandidater `GET /collective-invoicing/candidates`) bygger EN faktura per (kund, valuta) av `listInvoiceableOrders`-raderna och utfärdar valfritt direkt — varje kund sekventiellt i egna transaktioner, fel rapporteras per resultatrad; frakten tas med automatiskt. `invoiceService.create` kastar `CollectiveInvoicingCustomerError` (409) för flaggade kunder om inte `opts.collective` är satt (rutinens bakdörr, aldrig från en route); kreditfakturor och radredigering på utkast är opåverkade.
- Faktura-PDF:en skriver `orderReference` ("Order KO… · Ert ordernr …") som sub-rad per kopplad rad i stället för i huvudet, eftersom en samlingsfaktura blandar order. Sidan `/forsaljning/samlingsfakturering`; orderkortets **Fakturera** och fakturadialogen leder flaggade kunder dit.
- `Invoice.status = 'paid'` sätts och rullas tillbaka som sidoeffekt av betalningsregistreringen (se `ledgers.md`) — ingen egen anropbar övergång.

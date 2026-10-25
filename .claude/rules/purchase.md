---
paths:
  - "apps/api/src/modules/purchase/**"
  - "apps/web/app/inkop/**"
  - "apps/web/app/leverantorer/**"
  - "apps/web/components/purchase/**"
  - "apps/web/lib/legoInquiries.ts"
  - "apps/web/lib/priceQuote.ts"
  - "packages/shared/src/purchase.ts"
  - "apps/api/test/purchase*"
  - "apps/api/test/supplier*"
  - "apps/api/test/inquiry*"
  - "apps/api/test/price*"
  - "apps/api/test/lego*"
---

# Inköp: leverantörer, förfrågan, inköpsorder, inleverans, leverantörsfaktura

Andra regelfiler: radernas leveransdatum `order-dates.md`, leveransdagar `delivery-days.md`, avrundning `planning.md`, valuta `currency.md`, momskoder `vat.md`, leverantörsreskontran `ledgers.md`, betalfiler `banking.md`, villkorsregistren `register.md`, ordermejl/PDF `mail.md`.

## Förfrågan och inköpsorder

- **Förfrågan** (RFQ, `inquiries`/`inquiry_rows`, FO-serien `inquiry`): draft → sent → answered → ordered | cancelled i purchase-servicen, rader redigerbara t.o.m. answered; `POST /inquiries/:id/convert-to-order` skapar IO:n transaktionellt (obesvarade priser → 0, förfrågans villkor följer med).
- **IO-rader** är redigerbara (`PATCH`/`DELETE /purchase-orders/:id/rows/:rowId`) tills ordern är helt mottagen — radlåset i repositoryts transaktion (antal ≥ mottaget, rad med mottag kan inte tas bort); en radändring i Delvis mottagen räknar om orderstatusen precis som receive. Antal avrundas med `roundForArticle` i servicen.
- **Inleverans** (`/inkop/inleverans`) rapporterar hela ordrar (`?order=<id>`, förifyllda restantal, gemensam lagerplats) genom att loopa per-rad-endpointsen — inga batch-endpoints.
- Kort: `/leverantorer/[id]` använder `PartnerTabs.tsx` (Allmänt / Villkor & frakt / Kontakter); kontakter (`supplier_contacts`, `/suppliers/:id/contacts`) med max en huvudkontakt (partiellt unikt index, primärväxling i transaktion).

## Leverantörskatalog och staffelpriser

- Artikelkortets **Inköp**-flik (`InkopTab.tsx`, för `purchased`/`service`) läser katalogen `article_suppliers` — subresursen `/articles/:id/suppliers` **serveras från purchase-modulen** (som `/articles/:id/bom`); en huvudleverantör via partiellt unikt index + demotering i tx. Läsloggarna: inleverans (`GET /goods-receipts?articleId=`, ur `stock_transactions` `purchase_receipt`), pris (`GET /price-history?articleId=`, ur `purchase_order_rows` exkl. draft/cancelled) och `GET /supplier-invoices?articleId=`. Purchase-servicens injicerade artikelläsare har `getArticle` för katalogens existenskontroll.
- **Staffel** (`article_supplier_price_breaks`, migration 0089): ett steg är ett **absolut** pris från `from_quantity` (CHECK `> 1`; antal 1 ÄR `article_suppliers.price`), i artikelns basenhet och katalogradens valuta. Rena `purchase/service/supplier-price.ts` (`resolveSupplierPrice`: högsta steg ≤ antal, annars grundpris; matchande steg vinner även utan grundpris) delas av alla tre konsumenterna:
  - IO-kortets à-pris-förifyllning (`GET /supplier-price-quote?supplierId&articleId&quantity` i basenhet; "manuellt vinner" med touched-flagga, initialt basantal och request-sekvens; fältet lämnas orört vid saknat pris eller annan valuta än orderns),
  - behovsberäkningens Skapa ordrar (`primarySuppliersForArticles` laddar steg — aldrig hela MRP-körningen),
  - kalkylen (`costing_supplier_price_tier` `base`|`tiered`, default `base`; `resolveUnitCost` får `{ supplierPriceTier, quantity }` från `buildMaterialRow`; `used` förblir `"supplier"`).
- Stegen redigeras som **hel mängd** och skickas som `priceBreaks` på create/update (replace-the-set, `[]` rensar; dubbletter stoppas i zod, aldrig av unique-constrainten); `updateArticleSupplier` har en vakt för PATCH med enbart `priceBreaks` (tomt `set` ⇒ select). `loadPriceBreaks`/`replacePriceBreaks` (`purchase/repository/price-breaks.ts`, `Db | Tx`) är det delade DB-lövet. Artikelns eget försäljningspris är medvetet ett enda värde.

## Inleveranslogg och Ångra inleverans (migration 0118)

- Varje inleverans skriver en rad i `purchase_receipts` i sin egen transaktion (antal i basenhet, plats + `stock_transaction_id` på vanliga rader, `mo_report_id` på lego-rader — länkad efter TO-rapporten via `reportOperationQuantities`s `reportId`).
- **Ångra** (`undoReceipt`, `POST /purchase-orders/:id/receipts/:receiptId/undo`) backar exakt raden i en transaktion: varorna ut som negativ `purchase_receipt` utan `unit_cost` (vägras när de inte finns kvar, `PurchaseReceiptStockMissingError`), radens mottagna antal ned och status omräknad (`recomputeReceiptStatus`: allt ⇒ received, något ⇒ partially_received, inget ⇒ confirmed); stängd order vägras. En lego-rads TO-rapport ångras i **samma** transaktion via `manufacturing.undoPurchaseReceiptReportInTx` (repo `undoReportInTx` med `fromPurchaseReceipt`; TO-kortet vägrar fortfarande sådana rapporter); en icke-öppen TO ger `PurchaseReceiptManufacturingOrderLockedError`.
- **Låsordning rad → order** (`FOR UPDATE`) i både inleverans och ångra, samma som `updateRow`.
- Läsare av `purchase_receipt` som avser *inkommet* gods filtrerar `quantity_delta > 0` och bort ångrade kvitton. Webben: **Inleveranser** (`ReceiptsSection`) på IO-kortet.

## Leverantörsfaktura (AP)

- `supplier_invoices`/`supplier_invoice_rows` (`supplier-invoice.{repository,service,routes}.ts`), intern `LF-`-serie (`supplier_invoice`) utöver leverantörens fakturanr (unikt per leverantör). **draft → approved → paid**, avbryt från draft/approved, huvud-/rad-CRUD bara i draft (`InvalidStatusTransitionError` → 409). Header-beloppen (netto/moms/brutto) matas från pappersfakturan och är auktoritativa; radbelopp = antal × à-pris.
- **IO-matchning** är en valfri radlänk `purchaseOrderRowId` som kräver samma artikel (`PoMatchMismatchError` → 400) men **inte** samma leverantör: fakturans `supplier_id` är leverantören fakturan **betalas till** (**Betalas till en annan leverantör**, header-PATCH:ens `supplierId` i draft snapshotar om valutan och loggar `supplier_changed`; PATCH:en är villkorad på `status = 'draft'` i själva UPDATE:n). Pris-/antalsavvikelse **beräknas vid GET**, lagras aldrig; ingen lagerpåverkan. Register på `/inkop/leverantorsfakturor` (lista + kort).
- Skapa-dialogen kan hämta underlag från en inlevererad IO (`listPurchaseOrders` med `supplierId`, raderna byggs klientsidan, `POST /supplier-invoices` med `rows[]` + `purchaseOrderId` validerar). Nettot autofylls från radsumman, **Momsbelopp** = netto × **Momssats** (25 % för SEK-leverantör, annars 0 %) och brutto = netto + moms tills fältet skrivs i för hand.
- Attesten bokför L-verifikatet i samma transaktion (`economy.md`); `paid` sätts bara som sidoeffekt av utbetalningen (`ledgers.md`). Underlag: `supplier_invoice_files` (`economy.md`, Räkenskapsinformation).

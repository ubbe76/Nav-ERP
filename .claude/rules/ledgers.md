---
paths:
  - "apps/api/src/modules/sales/**/payment*"
  - "apps/api/src/modules/sales/**/open-amounts*"
  - "apps/api/src/modules/purchase/**/supplier-payment*"
  - "apps/api/src/modules/purchase/**/open-amounts*"
  - "apps/web/app/forsaljning/betalningar/**"
  - "apps/web/app/forsaljning/reskontra/**"
  - "apps/web/app/inkop/betalningar/**"
  - "apps/web/app/inkop/reskontra/**"
  - "apps/web/lib/paymentTolerance.ts"
  - "packages/shared/src/payment-tolerance.ts"
  - "apps/api/test/payment*"
  - "apps/api/test/open*"
---

# Kund- och leverantörsreskontra (B3/B4)

Valutaregler för betalningar (kursdifferens, `amount_sek`, `releasedSek`): `currency.md`. Bankfilerna som bokför via samma sömmar: `banking.md`.

- **Öppna poster är härledda**, aldrig ett lagrat saldo: `computeOpenAmounts`/`openAmountSql` i respektive moduls `open-amounts.ts`. Auktoriteten skiljer: på kundsidan är fakturaraderna facit, på leverantörssidan headerkolumnen `supplier_invoices.gross_amount` (matad från pappersfakturan).
- **Kundsidan (B3):** `customer_payments`/`customer_payment_rows` bokför registreringen (`payment.repository.ts`s `createPayment`) i serie **K**, med tolerans (`paymentTolerance`, mellanskillnaden till `postingPaymentWriteOff`) och kvittning — poster som nettar till 0 bokför inget verifikat (`verificationId` null). `invoice_reminders` bär en engångs-påminnelseavgift (`reminderFee`, partiellt unikt index `fee > 0`) bokförd i samma serie, bara på SEK-fakturor.
- **Leverantörssidan (B4):** `supplier_payments`/`supplier_payment_rows` i egen serie **U**. Förfallolistan (`/inkop/reskontra`) härleder **Förfallodatum** ur fakturadatum + betalningsvillkorets dagar (`computeDueDate` i `supplier-invoice.service.ts`) om inget datum matats in.
- **Makulering** bokför en **omföring** i samma serie och öppnar fakturan igen — append-only, inga rader skrivs om.
- **`paid` är aldrig en anropbar övergång** på någon sida: den sätts och rullas tillbaka (till `issued`/`approved`) som sidoeffekt av registrering/makulering. `POST /invoices/:id/pay` och `POST /supplier-invoices/:id/pay` finns inte; kundbetalningar registreras på `/forsaljning/betalningar`.
- Tx-sömmarna `paymentService.createInTx` och `supplierPaymentService.createInTx`/`cancelInTx` delas med bankfilerna och bankavstämningen; en faktura reserverad i en levande betalningsomgång kan inte registreras, makuleras eller få ny betalningsreferens manuellt.
- **Dröjsmålsränta** läser samma betalningsrader som `openAmountSql` (levande `applied + write_off`) som kapitalminskning, aldrig påminnelseavgiften; en påminnelseavgift efter en aktiv förseningsersättning vägras (409 `reminder-fee-after-late-fee`) — detaljer i `sales.md`.

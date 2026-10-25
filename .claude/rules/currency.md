---
paths:
  - "packages/shared/src/currency.ts"
  - "apps/web/lib/currency.ts"
  - "apps/web/lib/currencyTotals.ts"
  - "apps/web/lib/useExchangeRate.ts"
  - "apps/web/lib/useOrderRate.ts"
  - "apps/api/src/modules/system/service/exchange-rates*"
  - "apps/api/src/modules/system/repository/exchange-rates*"
  - "apps/api/src/modules/sales/service/price-resolver*"
  - "apps/web/app/ekonomi/valutakurser/**"
  - "apps/api/test/currency*"
  - "apps/api/test/valuta*"
  - "apps/api/test/exchange*"
  - "apps/api/test/foreign*"
---

# Valuta (migrationerna 0143–0146)

Spec `private/superpowers/specs/2026-10-24-valuta-design.md`. **Dokumentet är facit i sin egen valuta, bokföringen i SEK.** En faktura i EUR har sina belopp i EUR och en kurs (SEK per 1 EUR, numeric(14,6), CHECK SEK ⇔ 1); reskontran (öppet belopp, betalningar, påminnelser, betalfilen) räknas i fakturans valuta, verifikaten i SEK, och skillnaden mot det banken faktiskt drog eller satte in är **kursdifferens** (`posting_fx_gain` 3960 / `posting_fx_loss` 7960, bankavgift `posting_bank_fees` 6570).

- **All omräkning** bor i rena BigInt-funktionerna i `packages/shared/src/currency.ts` — `toSek`, `fromSek`, `sekShare`, `documentSekAmounts`/`invoiceSekAmounts` (restmetoden: skulden/fordran exakt toSek(brutto), momsen toSek(moms), öresresten på en rad så verifikatet balanserar), `releasedSek` (det SEK en betalningsrad frigör; slutreglering frigör resten så delbetalningar summerar exakt till `gross_amount_sek`), `toleranceInCurrency`, `paymentExchangeDifference`/`receiptExchangeDifference`, `revaluationDifference` — speglade byte för byte i `apps/web/lib/currency.ts` (`currency-web-mirror.shared.test.ts`).
- **Kurser:** `exchange_rates` (valuta, dag, källa `riksbank`|`manual`) är referensdata — dokumenten snapshotar sin kurs. `getRate(currency, date)` (`system/service/exchange-rates.ts`): manuell kurs för exakt dagen → Riksbankens (SWEA, `SEK{CCY}PMI`) senaste bankdag ≤ dagen, ur tabellen eller ETT intervallanrop [dag−10, dag] (anonymt tak 5/min, valfri write-only `riksbank_api_key`) → senaste manuella kursen i intervallet → `ExchangeRateUnavailableError` (409 `exchange-rate-unavailable`). `exchange_rate_source = manual` tar bara manuella. **`getRate` kan göra HTTP och anropas aldrig inne i en transaktion** — alla vägar hämtar kursen före. Testerna blockerar fetch mot riksbank.se (`test/setup.ts`). Sidan `/ekonomi/valutakurser` ("Källa: Sveriges Riksbank").
- **Leverantörssidan:** `supplier_invoices.exchange_rate` (förifylld med fakturadatumets kurs, touched-mönster, `InvoiceRateField`; källan `riksbank`/`register` = uppslag, `manual` = inskriven, `purchase_order` = reserv när uppslaget saknas, ingen källa = kurs saknas ⇒ attesten vägras; header-PATCH:ens `exchangeRate: null` = tillbaka till automatisk kurs, utelämnad slår upp igen vid valutabyte, vid datumbyte utan inskriven kurs och när kursen saknas) och `gross_amount_sek` (stämplas vid attest). `supplier_payments.currency`/`amount_sek`/`bank_fee_sek` och radernas `applied_amount_sek`/`write_off_amount_sek`; en betalning blandar aldrig valutor (400 `payment-mixed-currencies`).
- **Kundsidan:** `customers.currency`, `price_lists.currency`, `sales_orders.currency` + `exchange_rate` (snapshot vid skapandet; valutan låst när ordern har rader, 409 `sales-order-currency-locked`; `addRow` läser huvudet `FOR KEY SHARE` och vägrar en rad prissatt i en valuta som just bytts, 409 `sales-order-currency-changed`). En kundknuten OAuth-klient får bara kundens valuta (403 `client-price-not-allowed`, `clientCurrencyAllowed`).
- **Priskedjan** (`price-resolver.ts`): kundens särpris/rabattregel **bara när orderns valuta är kundens** → prislista i orderns valuta (andra valutor hoppas över) → artikelpriset (SEK) via `fromSek` med orderns kurs; konfiguratorns tillägg och fraktraden likadant; SEK avrundas aldrig om.
- **Kundfakturan** tar valutan från ordern/försändelsen (annars kundens); kursen vid **Utfärda** = `getRate(valuta, fakturadatum)` om inte `exchange_rate_manual`; **kreditfakturan alltid källfakturans kurs** (400 `invoice-exchange-rate` reason `credit`). Utfärda stämplar `invoice_rows.line_amount_sek` (samma `invoiceSekAmounts` över samma rader i samma ordning som F-verifikatet). PDF:en skriver *Moms i SEK* när valutan inte är SEK och momsen ≠ 0 (ML 17 kap. 29 §). Påminnelseavgift bara på SEK-fakturor (409 `reminder-fee-currency`); samlingsfaktureringen per (kund, valuta); e-faktura bara SEK.
- `customer_payments` speglar leverantörssidan; kvittning i valuta med SEK-skillnad bokför ett verifikat med bara kundfordran mot kursdifferens (så reskontran och 1510 aldrig glider isär).
- Marginal/TB och försäljningsstatistiken räknar med **fakturans** kurs, orderförteckningen och offertuppföljningen med **orderns**.
- **Reskontrornas SEK-summor** (`receivablesTotalAsOf`/`payablesTotalAsOf`) = Σ `gross_amount_sek` − Σ frigjort SEK, över en per-faktura-SQL som bokslutets omvärdering (`receivableForeignItemsAsOf`/`payableForeignItemsAsOf`) delar.
- Utlandsbetalningarna: `banking.md`; omvärderingen: `year-end.md`. Utanför: valutakonton i banken (camt-konto i annan valuta ⇒ **Annan valuta**), decimaler per valuta (JPY lagras med två), e-faktura i valuta, kontantrabatt.

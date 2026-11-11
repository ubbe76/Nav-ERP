---
paths:
  - "apps/api/src/modules/shipping/**"
  - "apps/api/src/scheduler.ts"
  - "apps/web/app/forsaljning/forsandelser/**"
  - "apps/web/app/system/frakt/**"
  - "apps/web/components/shipping/**"
  - "apps/web/lib/shipping.ts"
  - "packages/shared/src/shipping.ts"
  - "apps/api/test/shipping*"
  - "apps/api/test/sendify*"
  - "apps/api/test/freight*"
  - "apps/api/test/fraktgranskning*"
  - "apps/api/test/scheduler*"
---

# Frakt (Sendify)

Spec `docs/superpowers/specs/2026-10-07-frakt-sendify-design.md`.

## Sömmen och felen

- `FreightProvider` (`shipping/service/freight-provider.ts`) är enda sömmen mot förmedlaren och `sendify-provider.ts` enda filen som känner till Sendify; tester injicerar `test/helpers/fake-freight-provider.ts`. Sandlådetestet körs med `SENDIFY_SANDBOX_API_KEY`; full bokning i sandlådan fungerar bara med DHL, UPS och DSV.
- `FreightProviderError` har fem `kind`: `validation` → 400, `unauthorized` (401/403 från Sendify) → 409, `unavailable`/`booking-unknown`/`unexpected` → 502. På BOOK (`call(…, booking = true)`) är allt utom ett läsbart svar `booking-unknown` — nätverksfel, 5xx **och ett 2xx vars kropp inte går att läsa** (avbruten anslutning/timeout mitt i kroppen, tom kropp, inte JSON, inte ett objekt; loggas av leverantörens `log` med request-id) — aldrig `unexpected`, som läses som "inget hände". Reservationen **släpps** ändå (specen 3.4 steg 3, som alla bokningsfel) — försändelsen står kvar som utkast; spåret är `console.error` + händelseloggens `booking_unknown` (försändelsenummer, Sendify-id, request-id, transportör, produkt, pris), och texten säger åt användaren att kontrollera i Sendify innan nästa försök. Test: `sendify-provider.test.ts`, `fraktgranskning.test.ts`.
- Fraktinställningarna är `freight_*`-nycklar i `system_settings` (API-nyckeln write-only, aldrig loggad), upphämtningstider i `pickup_times`. **Testa anslutning** (`POST /freight-settings/test`, `testFreightConnectionSchema`) prövar inskriven nyckel/miljö utan att spara. Nyckeln går rakt in i en HTTP-header, så båda schemana delar `apiKeyText` (tryckbar ASCII, 400 annars — fetch vägrade förut tecknet och det blev "Sendify svarar inte"). Upphämtningsdatumet tas emot som `businessDateSchema` (2030-02-30 ⇒ 400, inte 500).

## Försändelsen

- `shipments` (FR-serie) hänger på en eller flera följesedlar via `shipment_deliveries` (partiellt unikt index på `delivery_id WHERE active`, avbokning sätter `active = false`). draft → booked → delivered / cancelled i `shipping.service.ts`. Alla utkastredigeringar, borttag och avbokning tar raden `FOR UPDATE`; utkastredigeringar nollar `last_rates`. `shipments.sender_address_line2` tas från företagsadressens andra rad.
- **Prissvaret** sparas i `shipments.last_rates` med `booking_token` som aldrig lämnar API:t; bokning väljer rad på `rateId`. Prishämtningen håller inget lås över Sendify-anropen, så slutskrivningen är optimistisk (`repo.storeRates`: `WHERE status = 'draft' AND provider_shipment_id = det egna AND updated_at = som läst`, jämfört på **millisekund** eftersom Postgres-defaulten har mikrosekunder; `saveProviderShipmentId` rör medvetet inte `updated_at`); ett mellanliggande byte ger `FreightShipmentChangedError` → 409.
- **Sendify-kopian skapas en gång:** `saveProviderShipmentId` skriver bara på en rad utan id (`WHERE provider_shipment_id IS NULL`) och svarar med id:t raden bär. Två samtidiga prishämtningar på ett oprissatt utkast skapar var sin kopia; förloraren raderar sin (i mån av möjlighet), uppdaterar den lagrade och prissätter den — förut kunde den senares id skrivas över ett utkast vars sparade priser (tokens) hörde till den förstas kopia, så bokningen bokade en sändning och fraktsedel/avbokning/spårning gick mot en annan. `fetchRatesFor` returnerar id:t priserna hör till; bokningens spår (`booked`, `booking_taken_over`, `console.error`) använder det, så **Boka vald produkt** på ett oprissatt utkast loggar Sendify-id:t (förut null). Test: `fraktgranskning.test.ts`.
- **Upphämtningstiden** som begärs är `requestedPickupTime` (`pickup.ts`): fönstrets Från, utom samma dag där den klampas till nu avrundat uppåt till kvart (null = `FreightPickupDayError`); det sparade fönstret rörs aldrig. `pickupProblem` delas av prishämtningen och kortets `pickupWarning` (bara utkast); `nextPickup` använder `requestedPickupTime` för idag. **Alla** prisfrågor begär den — även **Hämta transportörsprodukter** (`fetchProducts`, som förut begärde fönstrets Från också när den passerat i dag; `nextPickupSlot(current)` och `requestedPickupTime` läser samma klocka).
- Sendify kräver kontaktnamn (saknas kontakten skickas företags-/kundnamnet) och tar paket av typen Paket alltid som stapelbara (`insertParcels` lagrar dem så). Rena lövfiler: `parcels.ts` (kolliförslag, fraktsättet härleds), `pickup.ts`, `pricing.ts`, `recipient.ts`, `shipment-validation.ts`.

## Bokning och avbokning — inga DB-transaktioner över HTTP

- **Bokning** reserveras med en atomisk UPDATE (`booking_started_at`, 2 min), Sendify anropas, sedan skrivs händelseloggens `booked`-rad (försändelsenummer, Sendify-id, fraktsedelsnr, produkt, pris) FÖRE `markBooked`, som härleder `customer_price` i SQL (Sendifys pris + påslag) om inte `customer_price_manual` är satt. Faller databasen efter Sendifys bokning loggas samma spår med `console.error` och felet kastas vidare. `releaseBooking(id, claimedAt)`/`markBooked(id, claimedAt, …)` är ägarkontrollerade på `booking_started_at` (millisekund); en övertagen reservation ger `FreightBookingTakenOverError` → 409 och loggar `booking_taken_over` med samma spår direkt efter `booked`-raden (historiken visar annars en bokning raden aldrig fick). Fraktsedel/etikett (`shipment_files`) hämtas efteråt och får misslyckas.
- **Avbokning** av bokad försändelse reserverar raden med `cancel_started_at` (`CANCEL_STALE_MS` = 2 min, migration 0100) i samma tx som fakturautkastkontrollen, FÖRE Sendify-anropet; en levande reservation ger `FreightCancelInProgressError` (409), en avvisad avbokning släpper reservationen (ägarkontrollerat). Leverantören löses före reservationen så en saknad nyckel inte lämnar `cancel_started_at` satt. Upprepad API-avbokning ger 204; en vägrad avbokning av en försändelse som Sendify rapporterar som `CANCELED` räknas som genomförd (`GET /shipments/{id}`, aldrig felteksten).
- Fakturarepositoryts `create`/`addRow` låser radernas försändelser `FOR SHARE` (`assertShipmentsBillable`) och vägrar med `ShipmentNotBillableError` (409) när försändelsen inte är bokad/levererad eller en avbokningsreservation lever.

## Spårning (etapp 2)

- `tracking.service.ts` (`trackShipment` delas av **Uppdatera spårning** och jobbet). `apps/api/src/scheduler.ts` startas bara från `server.ts`, aldrig `buildApp`; kontrollerar var 5:e minut mot `freight_tracking_interval`, en körning åt gången via leasen `freight_tracking_lease_until` (atomisk upsert, 15 min), `freight_last_tracking_run_at` stämplas efter körningen. Försändelser bokade för mer än 60 dagar sedan spåras inte automatiskt; DELIVERED ⇒ `delivered` villkorat på `booked`. `trackingStatusLabel` (`tracking-status.ts`) ger svenska etiketter (händelserna bär `statusLabel`); scheduler/spårning loggar via `app.log`; webben formaterar tider i Stockholmstid (`apps/web/lib/date.ts`); schedulerns `stop()` väntar in en pågående tick.

## Frakt på offert, faktura och kund

- **Offert (etapp 3, migration 0098):** `freight-quote.service.ts` (`GET /sales-orders/:id/freight` + `/freight-parcels`, `POST …/freight-rates` + `…/freight`; **Kontrollera fraktpris**/**Lägg till frakt**) gör prisfrågan via en tillfällig Sendify-sändning som raderas igen. Prissvaret lagras på `sales_orders.freight_quote` **utan** `booking_token` (`listSalesOrders` utelämnar kolumnen) och har medvetet ingen giltighetskontroll — bokningen hämtar nya priser. `salesService.setFreightRow` lägger till eller prissätter om fraktraden (fraktartikeln ur `freight_article_id`, kundpris, antal 1; levererad fraktrad ⇒ `FreightRowDeliveredError` 409; kolliförslaget filtrerar bort fraktartikeln). Vald produkt och Sendifys pris sparas på `sales_orders.freight_product_id`/`freight_carrier_price` (händelseloggen `freight_added`) och försändelsen ärver dem vid create så **Boka vald produkt** fungerar direkt.
- **Kundförval:** `customers.default_freight_product_id` — en ny försändelse tar orderns valda produkt först, annars kundens (då utan Sendify-pris).
- **Fraktrad på faktura:** `invoice_rows.shipment_id` med partiellt unikt index `invoice_rows_shipment_unique` (dubbelfaktureringsspärr); ett makulerat utkast nollar länken i samma tx; kreditrader bär den aldrig; en order med fraktartikelrad ger ingen fraktrad från försändelsen; fraktartikeln når fakturamodulen via `InvoiceFreightReader`, kandidaterna via `GET /invoiceable-shipments`, samlingsfaktureringen tar med frakten automatiskt. Sales läser försändelser via `ShipmentReader` (kundorderns leveranslista, följesedelns Transportör/Fraktsedelsnr).

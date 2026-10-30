---
paths:
  - "apps/api/src/modules/scan/**"
  - "apps/api/src/modules/mail/service/label-pdf.ts"
  - "apps/api/src/modules/mail/service/pdf-codes.ts"
  - "packages/shared/src/scan.ts"
  - "apps/web/components/ui/ScanInput*"
  - "apps/web/app/lager/skanna/**"
  - "apps/web/components/stock/LabelPrint*"
  - "apps/web/lib/orderScan.ts"
  - "apps/web/components/ui/useOrderScan.ts"
  - "apps/web/components/purchase/GoodsReceiptPageClient*"
  - "apps/web/components/sales/DeliveryPageClient*"
  - "apps/web/lib/countScan.ts"
  - "apps/web/components/stock/StockCount*"
  - "apps/api/test/scan*"
  - "apps/api/test/web-order-scan*"
  - "apps/api/test/web-count-scan*"
---

# Skanning och etiketter (#4)

Spec `private/superpowers/specs/2026-10-29-skanning-design.md` — fyra etapper (grunden, inleverans, plock/utleverans, inventering), en i taget mergade; #4 stängdes med den sista (2026-10-30).

- **Koderna** (användarbeslut): artikelnummer och ordernummer (som pallkorten), **EAN/GTIN** i `articles.barcode` (migration 0171; CHECK på formen, partiellt unikt index `articles_barcode_unique` ⇒ 409 `duplicate-article-barcode` via `throwIfBarcodeTaken` före artikelnummerkrocken; kontrollsiffran i rena `isValidGtin`, `articleBarcodeSchema` "" ⇒ null) och **lagerplatsens etikettkod** `LP` + `stock_locations.label_number` (identity, unik; `formatLocationLabelCode`/`parseLocationLabelCode`) — kort, ASCII och stabil vid namnbyte, eftersom platsnamn kan ha å/ä/ö som Code 128 inte kodar. Leverantörens artikelnummer är medvetet inte med. Kopiera från tar aldrig med EAN (tillåtelselistan i `article-copy.ts`).
- **`GET /scan?code=`** (modulen `scan`, bara läsning, office): `normalizeScanCode` (tar bort Enter, tab, GS1-separatorn) och svarar med **alla** träffar i fast ordning — plats, artikel på EAN, artikel på nummer, IO/KO (även offertnumret)/TO — så varje rutin väljer den sort den väntar sig. Ingen träff ⇒ tom lista, aldrig 404.
- **Etiketterna** (`mail/service/label-pdf.ts`, ingen sidhuvud/inställning, importeras direkt av artikel- och lagermodulen): `POST /articles/labels` och `POST /stock/locations/labels` (regeln `LABEL_PRINT` = office, `readOnlySafe` — utskrift skriver inget; listan i `read-only-account.test.ts`), A4-ark 70 × 37 mm (3 × 8, `start` 1–24) eller 100 × 50 mm per sida, högst 2 000 etiketter. Code 128 när texten går att koda och får plats, annars QR. Ritningen av koderna är **en** implementation i `pdf-codes.ts`, delad med pallkortet.
- **Webben:** `ui/ScanInput` (handskanner = tangentbord + Enter; **Kamera** med `BarcodeDetector`, annars ZXing laddad först när dialogen öppnas — iPhone saknar BarcodeDetector; kräver https), sidan **Lager → Skanna** och etikettdialogen. Tester: `scan.shared.test.ts` (rent), `scan.route.test.ts` (EAN, uppslaget, importen, etiketterna).
- **Skanning mot en order — etapp 2 Inleverans och 3 Utleverans** (ingen migration): samma skanningsfält i `/inkop/inleverans` och `/forsaljning/utleverans`. Reglerna är EN ren fil, `apps/web/lib/orderScan.ts` (`web-order-scan.test.ts`), React-halvan EN fil, `components/ui/useOrderScan.ts` (`useScanQueue`, `useScanFeedback`, `useCountState`) plus `ScanPanel` i `ScanInput.tsx`. `resolveOrderScan(matches, orderKind, order)` väljer: plats → artikel med öppen skanningsbar rad → order av rätt sort → förklaring (räknas inte / redan klar / inte på ordern / ingen order vald / fel sorts order).
  - **Användarbeslut: räkna från noll** — första artikelskanningen nollställer de förifyllda restantalen (inskrivna värden står kvar), varje skanning +1 i radens enhet, rader med 0 bokas inte. **Inte skanningsbara** (`isScannableRow`): tjänster (`articleType = service`, därför bär IO-raderna nu `articleType`) och ställkostnadsrader (`setupForRowId`) — de behåller restantalet, annars tappas ställkostnaden tyst ur leveransen och fakturan.
  - Inleverans: överleverans varnar bara (`max: null`, toleransen är serverns); artikel utan vald order ⇒ `GET /purchase-orders?openArticleId=` (ordrar med en *öppen* rad), en träff väljs direkt och skanningen räknas när raderna laddats (`pendingCount`), flera visas som lista. Utleverans: överplock räknas upp till kundens Tillåtna överleverans (`OrderScanRow.max` ur orderns `overDeliveryPercent`, #24; som standard 0 = aldrig mer än beställt) och vägras därefter, kolumnen **Kvar att plocka** (`leftToCount`) när räkningen startat, artikel utan vald KO varnar bara (medvetet ingen `openArticleId` för kundorder — plocket utgår från ordern).
  - Skanningarna köas (`useScanQueue`) och räknas mot `countRef`, inte mot React-state — snabba handskannerskanningar får aldrig tappas. Uppslagen cachas per sida utom koder som träffar en order (statusen kan ändras).
  - **Användarbeslut:** IO-PDF:en har ordernumret som Code 128 bredvid rubriken (`DocumentPdfInput.documentNumberBarcode`), styrt av inställningen **Streckkod på inköpsorder** (`purchase_order_barcode`, på när den saknas — #23); plocklistan har det alltid (internt dokument). En implementation: `drawTitleBarcode` i `document-pdf.ts`. Test: `scan-orders.route.test.ts`.
- **Etapp 4 — Inventering** (ingen migration, admin som rutinen): ren `apps/web/lib/countScan.ts` (`resolveCountScan`, `web-count-scan.test.ts`) — plats (egen/annan) före artikel, artikel med rad före artikel utan. Listan (`StockCountScanPanel`) och kortet (`StockCountDetailClient`) delar `locationCountHref`: `GET /stock-counts?locationId=&status=open` → öppna inventeringen, annars `/lager/inventering/ny?location=` (förvald; inaktiv plats ⇒ varning, `createSession` vägrar den ändå). **Artikel och antal** (specen): skanningen markerar raden och fokuserar **Räknat** med värdet markerat — **ingen +1 per skanning** här, eftersom en handskanner skriver i fältet som har fokus och de två sätten inte går att blanda; Enter i Räknat sparar raden (PATCH) och lämnar tillbaka fokus. Artikel utan rad ⇒ `POST …/rows` (som Lägg till) och fokus när raden kommit med refreshen (`focusWhenLoaded`). Räknelistan har platsens LP-kod som streckkod (`StockCountSheetPdfInput.locationLabelCode`, detaljsvarets `locationLabelCode`). Test: `scan-count.route.test.ts`.


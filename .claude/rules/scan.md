---
paths:
  - "apps/api/src/modules/scan/**"
  - "apps/api/src/modules/mail/service/label-pdf.ts"
  - "apps/api/src/modules/mail/service/pdf-codes.ts"
  - "packages/shared/src/scan.ts"
  - "apps/web/components/ui/ScanInput*"
  - "apps/web/app/lager/skanna/**"
  - "apps/web/components/stock/LabelPrint*"
  - "apps/api/test/scan*"
---

# Skanning och etiketter (#4)

Spec `private/superpowers/specs/2026-10-29-skanning-design.md` — fyra etapper (grunden, inleverans, plock/utleverans, inventering), en i taget mergad; ärendet stängs med den sista.

- **Koderna** (användarbeslut): artikelnummer och ordernummer (som pallkorten), **EAN/GTIN** i `articles.barcode` (migration 0171; CHECK på formen, partiellt unikt index `articles_barcode_unique` ⇒ 409 `duplicate-article-barcode` via `throwIfBarcodeTaken` före artikelnummerkrocken; kontrollsiffran i rena `isValidGtin`, `articleBarcodeSchema` "" ⇒ null) och **lagerplatsens etikettkod** `LP` + `stock_locations.label_number` (identity, unik; `formatLocationLabelCode`/`parseLocationLabelCode`) — kort, ASCII och stabil vid namnbyte, eftersom platsnamn kan ha å/ä/ö som Code 128 inte kodar. Leverantörens artikelnummer är medvetet inte med. Kopiera från tar aldrig med EAN (tillåtelselistan i `article-copy.ts`).
- **`GET /scan?code=`** (modulen `scan`, bara läsning, office): `normalizeScanCode` (tar bort Enter, tab, GS1-separatorn) och svarar med **alla** träffar i fast ordning — plats, artikel på EAN, artikel på nummer, IO/KO (även offertnumret)/TO — så varje rutin väljer den sort den väntar sig. Ingen träff ⇒ tom lista, aldrig 404.
- **Etiketterna** (`mail/service/label-pdf.ts`, ingen sidhuvud/inställning, importeras direkt av artikel- och lagermodulen): `POST /articles/labels` och `POST /stock/locations/labels` (regeln `LABEL_PRINT` = office, `readOnlySafe` — utskrift skriver inget; listan i `read-only-account.test.ts`), A4-ark 70 × 37 mm (3 × 8, `start` 1–24) eller 100 × 50 mm per sida, högst 2 000 etiketter. Code 128 när texten går att koda och får plats, annars QR. Ritningen av koderna är **en** implementation i `pdf-codes.ts`, delad med pallkortet.
- **Webben:** `ui/ScanInput` (handskanner = tangentbord + Enter; **Kamera** med `BarcodeDetector`, annars ZXing laddad först när dialogen öppnas — iPhone saknar BarcodeDetector; kräver https), sidan **Lager → Skanna** och etikettdialogen. Tester: `scan.shared.test.ts` (rent), `scan.route.test.ts` (EAN, uppslaget, importen, etiketterna).

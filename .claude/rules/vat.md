---
paths:
  - "apps/api/src/modules/economy/service/vat*"
  - "apps/api/src/modules/economy/service/document-vat-code*"
  - "apps/api/src/modules/economy/service/periodic-summary*"
  - "packages/shared/src/vat*.ts"
  - "apps/web/lib/vatCodes.ts"
  - "apps/web/lib/vatBoxes.ts"
  - "apps/web/lib/useVatCodes.ts"
  - "apps/web/app/ekonomi/momsrapport/**"
  - "apps/web/app/ekonomi/momskoder/**"
  - "apps/web/app/ekonomi/periodisk-sammanstallning/**"
  - "apps/api/test/vat*"
  - "apps/api/test/periodic*"
---

# Moms: momskoder, momsrapport, periodisk sammanställning

## Momskoder (migration 0142)

Spec `private/superpowers/specs/2026-10-24-momskoder-design.md`. En momskod säger hur en rad beskattas; momsrapporten läser fortfarande **kontona** — koden är vägen till rätt konto.

- Koderna är en **fast katalog i koden** (`packages/shared/src/vat-codes.ts`, spegel `apps/web/lib/vatCodes.ts`): MP25/MP12/MP6/MF inhemska för försäljning och inköp; EUV/EUT/EXV/EXT/OB försäljning; **UTM** "Utanför momsens tillämpningsområde" (försäljning, 0 %, kind `out_of_scope`, intäkt 3990 utan ruta, ingen fakturatext, tar aldrig "Alla momskoder"-regeln, härleds aldrig av `salesVatCode` — bara räntefakturans rader, migration 0151); IEUV25/12/6, IEUT, IUTT, IOBV, IOBT, IUTV inköp; IMP25/12/6 importmoms — med slots och förväntad ruta per slot. Momsrapporten, rutorna och periodiska sammanställningen påverkas inte av UTM; UBL vägrar den (ingen e-faktura på räntefakturor i v1). Det företaget äger (namn, fakturatext, aktiv, **kontonummer** per slot — nummer, inte FK) ligger i `vat_codes` (`GET /vat-codes` office, `PATCH` ekonomi; MP25/MP12/MP6/MF kan inte inaktiveras, `vat-code-required`).
- **Försäljning:** rena `salesVatCode` (enda implementationen — fakturaraderna, offert-/orderbekräftelse-PDF:erna, kundkortet): privatperson ⇒ inhemsk (utanför EU: varor EXV); SE ⇒ inhemsk utom **Omvänd betalningsskyldighet för byggtjänster** (`customers.reverse_charge_construction`) + tjänst ⇒ OB; EU med momsnummer ⇒ EUV/EUT, EU utan ⇒ inhemsk; utanför EU ⇒ EXV/EXT. Frakt och fria rader räknas som varor.
- `invoice_rows.vat_code_id` (explicit `vatCodeId` vinner, gamla `vatRate` = inhemsk kod). Utfärda vägrar EUV/EUT/OB utan giltigt köparmomsnummer (`vat-number-required`, i issue-transaktionen; valfri medlemsstats prefix utom SE, annat land än kundens = varning; kredit kontrolleras mot källfakturans nummer). `invoice_rows.delivery_date` från orderradens senaste levande leverans (rättas vid Utfärda om leveransen ångrats). PDF:en skriver köparens momsnummer, kodernas fakturatexter och "Levererad …". UBL: MP* S, MF E, OB AE (VATEX-EU-AE + kodens text), övriga vägras.
- **Inköp:** `suppliers.country` + `default_vat_code_id` (härledd SE ⇒ MP25, EU ⇒ IEUV25, annars IUTV), `supplier_invoices.vat_code_id` + radernas (null = huvudets). Omvända koder bokför kodens kostnadskonto och **beräknad moms** (utgående + ingående) på SEK-basen via rena `reverseVatPreview`, som också är GET:ens förhandsvisning; huvudets moms bara på en inhemsk kod med sats (`supplier-invoice-vat-code`).
- **Importmoms:** `POST /import-vat` bokför underlag (4545/4549) och moms (2615/2645) i serie **IM**; tullbeslutet laddas upp på verifikatet.
- **Periodisk sammanställning:** `GET /periodic-summary` + `/file` (SKV574008, månad eller kvartal; EUV = varor, EUT = tjänster ur utfärdade fakturor/krediter per normaliserat köparmomsnummer, avstämning i öre mot ruta 35/39). Den **summerar `invoice_rows.line_amount_sek`**, aldrig `line_amount`. Kontaktuppgifterna i `/settings/vat-reporting` (ekonomi). Sidor: `/ekonomi/momskoder`, `/ekonomi/periodisk-sammanstallning`.

## Momsrapport och momsomföring (B5)

- `vat_settlements` loggar momsomföringen append-only; `vat-report.service.ts` bygger rapporten kring rena `bucketMovements` (inga sidoeffekter).
- Rutorna läses **per konto**: `accounts.vat_box` (alla deklarationens rutor sedan 0142 — `VAT_BOXES` i shared, `none` = medvetet ingen ruta, null = ej angiven). Inköpsrutorna 20–24, 37, 50 och ruta 48 är debetpositiva, övriga kreditpositiva; 49 = 10+11+12+30+31+32+60+61+62 − 48. Nya konton får BAS-förval (`defaultVatBox`, även i SIE-importen).
- Rapporten varnar för konton i klass 3/26xx/44xx/45xx med rörelse men utan ruta, för momskoders konton vars ruta inte matchar kodens slot och för konteringsregler vars konto har fel ruta. Rutorna i öre och i hela kronor (halva från noll, 49 räknad på de avrundade).
- **Omföringen är rutstyrd:** den tömmer varje konto med ruta 10/11/12/30/31/32/48/60/61/62 som rört sig, lägger ruta 49 i hela kronor på redovisningskontot och öresdifferensen på öres- och kronutjämning (de två kontona får inte själva ha en sådan ruta — varning i GET, 409 i settle). Den bokförs i serie **M** under `pg_advisory_xact_lock(hashtext('vat_settlements'))` och kräver att `[from, to]` **exakt** täcker en sammanhängande löpning av bokföringsperioder (`assertRangeCoversPeriods`) — månad, kvartal eller helår (`vat_reporting_period` förväljer).
- **Momsrapporten utesluter på identitet** avyttringsverifikat (`fixed_assets.disposal_verification_id`) och bokslutsverifikat (`year_end_closing_verifications`) i `vat-account-movements.ts`.
- `GET /vat-report/file` ger momsdeklarationen som Skatteverkets XML (`vat-file.ts`, eSKDUpload 6.0, ISO-8859-1, elementordning enligt Skatteverkets exempel 6, period = sista månaden; testad byte för byte). Rapportens knappar **Bokför importmoms** och **Ladda ned fil till Skatteverket**.

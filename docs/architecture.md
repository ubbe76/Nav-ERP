# Arkitektur & kravspecifikation

## 1. Bakgrund och mål

Ett open-source ERP-system riktat mot mindre/medelstora svenska tillverkande företag, med Monitor G5 som referens men medvetet förenklat. Byggs primärt för eget bruk hos ett företag som tillverkar industriprodukter (bl.a. konfigurerbara diskbänkar till industrikök), med sikte på att senare integrera en extern produktkonfigurator mot systemets API.

## 2. Omfattning (v1)

### Ingår
| Modul | Kärnfunktion |
|---|---|
| Artikelregister | Artiklar, artikeltyper (tillverkad/köpt/tjänst), BOM (strukturer), enheter |
| Lager | Saldon per lagerplats, transaktionslogg, in-/utleverans, inventering |
| Inköp | Leverantörer, inköpsorder, inleverans, prislistor |
| Försäljning | Kunder, offert → order → leverans → faktura |
| Tillverkningsorder | Routing/operationer, materialförbrukning, orderstatus |
| Tidrapportering | Tid per operation/tillverkningsorder, koppling till anställd |
| Löneunderlag | Frånvarokoder, övertid/mertid/OB ur närvaro mot schema, attest + periodlåsning, löneunderlagsrapport, PAXml-export |
| Kalkyl | För- och efterkalkyl per artikel/order (material + tid × kostnad) |
| Ekonomi | Kontoplan, räkenskapsår/perioder, verifikat, huvudbok |
| API | REST, OAuth2 client credentials, för extern konfigurator |

### Ingår medvetet INTE i v1
- Avancerad kapacitetsplanering (finita/ofinita resurser, scheduling-optimering)
- EDI-integrationer
- Komplexa multivaluta-flöden och valutasäkring
- Granulär fältnivårättighetsstyrning (rollbaserad auth räcker i v1)
- Inbyggd rapportgenerator (export till CSV/Excel istället)
- Lönekörning, skatteberäkning och semesterdagssaldon — systemet levererar **löneunderlag**, inte löner: frånvaroregistrering per kod, övertid/mertid och OB ur närvaro mot upplöst schema, attest per anställd + periodlåsning, löneunderlagsrapport (CSV/PDF) och PAXml-export. Själva lönekörningen sker i ett externt lönesystem.

## 3. Datamodell (konceptuell)

```
Article
 ├─ id, article_number, name, type (manufactured|purchased|service)
 ├─ unit (st, m, kg, ...)
 └─ BOM (self-referencing: parent_article_id, component_article_id, quantity)

Routing
 ├─ article_id
 └─ RoutingOperation (sequence_no, work_center_id, setup_time, run_time_per_unit)

StockLocation
 └─ id, name, warehouse_id

StockTransaction (append-only)
 ├─ article_id, location_id, quantity_delta, transaction_type
 ├─ (purchase_receipt|sales_delivery|mo_consumption|mo_receipt|inventory_adjustment)
 └─ reference_id (FK till respektive order/MO), created_at

Supplier / Customer
 └─ standard stamdata + adresser + kontaktpersoner

PurchaseOrder / PurchaseOrderRow
 └─ status: draft → confirmed → partially_received → received → closed

SalesOrder / SalesOrderRow
 └─ status: quote → confirmed → in_production → delivered → invoiced

Invoice / InvoiceRow (kundfaktura, C1)
 ├─ egen entitet, frikopplad från ordern — inte längre bara en stämpel på
 │  SalesOrder (legacy: ordrar fakturerade före C1 behåller sitt FA-nummer
 │  på sales_orders.invoice_number, aldrig rörda av denna modul)
 ├─ status: draft → issued → paid, cancelled endast från draft
 │  (korrigering av en utfärdad faktura görs med kreditfaktura, inte cancel)
 ├─ type: invoice | credit — kreditfakturor pekar på originalet via
 │  credited_invoice_id (restrict: en fakturerad faktura med krediter måste
 │  förbli läsbar)
 ├─ FA-numret (number_series-nyckeln "invoice") allokeras vid issue, inte
 │  vid create — kasserade utkast bränner aldrig nummer ur serien
 ├─ värde-snapshots (kundnamn, fakturaadress, orgnr, momsreg-nr,
 │  betalningsvillkorets kod/namn) fryses vid issue så omtryck förblir
 │  stabila oavsett senare kund-/registerredigering — samma motiv som
 │  order-/offertbekräftelsens motsvarande snapshots
 ├─ due_date och ocr_number (Luhn-kontrollsiffra) beräknas och lagras vid
 │  samma issue-transaktion
 └─ InvoiceRow: sales_order_row_id (nullable, restrict) länkar raden till
    en orderrad för delfakturering; NULL för fria rader (frakt, avrundning,
    rader utan artikelkoppling)
    ├─ ingen unique(invoice_id, article_id) — delfakturering och
    │  samlingsfaktura återanvänder legitimt samma artikel över flera
    │  fakturor
    └─ kreditraders quantity lagras POSITIV; tecknet appliceras enbart via
       invoices.type vid aggregering/PDF — en enda konvention på ett
       ställe, inte utspridd över raddata

Härledd delfakturering: fakturerad kvantitet per orderrad är INTE ett eget
lagrat fält på SalesOrderRow utan beräknas (getInvoicedQuantities) genom att
summera invoice_rows för raden, med kreditfakturors kvantitet negerad.
Överfaktureringsspärren räknar in draft-fakturor (vad är på väg att
faktureras), medan orderstatusomräkningen och restantalsberäkningen bara
ser issued/paid. Ingen skrivbar saldokolumn kan därmed hamna ur synk med de
faktiska fakturaraderna — raderna är facit, saldot är alltid en färsk
summering av dem.

CustomerPayment / CustomerPaymentRow (kundbetalning, B3 kundreskontra)
 ├─ payment_number (BET-serien, number_series-nyckeln "customer_payment"),
 │  allokerad vid registreringen (ingen draft-fas att bränna nummer ur)
 ├─ amount = det bankbelopp betalningen faktiskt förde till betalkontot —
 │  0 för en ren kvittning mellan kundens egna öppna poster
 ├─ verification_id: den bokförda K-verifikationen, NULL för en ren
 │  kvittning (rör inget konto och är därför ingen bokföringshändelse)
 ├─ cancelled_at / cancelled_by / cancellation_verification_id — append-only:
 │  en makulering sätter dessa fält och bokför en omföring i K, i stället
 │  för att radera raden — samma nullfälts-mönster som Verifications egen
 │  reverses_verification_id
 └─ CustomerPaymentRow: invoice_id, applied_amount (kassadelen, signerad —
    negativ på en kreditfakturas rad) plus write_off_amount (den härledda
    öres-/kronutjämningen inom betalningstoleransen), en rad per öppen post
    betalningen stänger

InvoiceReminder (betalningspåminnelse, B3 kundreskontra)
 ├─ invoice_id, level (1, 2, 3 … — ett löpnummer, inte unikt: två
 │  påminnelser samma sekund är en dubblettutskick, inte ett dataintegritetsfel)
 ├─ fee (0 för en avgiftsfri påminnelse) och fee_verification_id — den
 │  bokförda K-verifikationen för avgiften, NULL om ingen avgift togs ut
 └─ högst en avgiftsrad per faktura (partiellt unikt index på fee > 0) —
    lagen om ersättning för inkassokostnader tillåter bara en
    påminnelseavgift per fordran

Härlett öppet belopp: precis som fakturerad kvantitet ovan har Invoice ingen
egen saldokolumn för vad som återstår att betala. Öppet belopp beräknas
(open-amounts.ts) som fakturans bruttobelopp minus vad CustomerPaymentRow
(icke-makulerade betalningar) har stängt, plus InvoiceReminders avgifter.
Samma "raderna är facit, saldot härleds alltid"-princip som stock_transactions
(arkitekturprincip 1) och den härledda fakturerade kvantiteten ovan — det är
detta härledda beloppet, inte ett lagrat fält, som avgör om fakturan syns i
förfallolistan, om den flippar till paid (se Invoice-statusflödet nedan) och
vad en påminnelse skriver ut.

ManufacturingOrder
 ├─ article_id, quantity, status (planned|released|in_progress|done|closed)
 ├─ MOOperation (kopplad till Routing, status, actual_time)
 └─ MOMaterialConsumption (kopplad till BOM, planned vs actual quantity)

TimeReport
 └─ employee_id, mo_operation_id, date, hours

AbsenceType / Absence (frånvaro)
 ├─ absence_types: code, name, paxml_code (tidkod), active
 └─ absences: employee_id, date, absence_type_id, minutes (hel-/deldag), note

ObRule (OB-tillägg)
 └─ code, name, day_kind (weekday|saturday|sunday|holiday), start_time, end_time, paxml_code

PayrollPeriod (löneperiod = kalendermånad)
 ├─ year, month, status (open|locked), locked_at, locked_by
 ├─ summary (JSONB-snapshot av hela periodens dagsberäkning, skrivs vid låsning)
 └─ PayrollAttestation (period_id, employee_id, attested_by, attested_at)

OvertimeDisposition (övertidsdisposition)
 └─ employee_id, date, disposition (payout|comp) — per-dag-avvikelse från personalkortets övertidsersättning

AuditLog (append-only, system)
 └─ entity_type, entity_id, action, detail, user_id, created_at

CostCalculation
 └─ article_id, material_cost, labor_cost, overhead, calculated_at, type (pre|post)

Account (konto)
 └─ number (4 siffror, unikt — inte namnet: BAS-kontoplanen legitimt
    återanvänder samma namn på flera konton), name, active

FiscalYear (räkenskapsår)
 ├─ label, start_date, end_date (brutet räkenskapsår tillåtet; överlapp
 │  mot andra år valideras i service-lagret, inte en DB-constraint)
 └─ AccountingPeriod (en per kalendermånad, genereras automatiskt när
    räkenskapsåret skapas — inget separat steg)
    └─ status (open|locked), locked_at, locked_by

VerificationSeries (verifikatserie, t.ex. "A" för manuella verifikat)
 ├─ code (låst för ändring så fort serien har ett verifikat, draft eller
 │  bokfört — displayNumber byggs vid läsning av code, så en omdöpning skulle
 │  retroaktivt byta namn på redan bokförda verifikatnummer), name (alltid
 │  redigerbart)
 └─ VerificationCounter (nextNumber per serie + räkenskapsår — nollställs
    varje nytt år; raden materialiseras först vid första bokföringen så en
    misslyckad bokföring aldrig bränner ett nummer ur den obrutna serien)

Verification (verifikat)
 ├─ series_id, fiscal_year_id, verification_number (tilldelas FÖRST vid
 │  bokföring, aldrig vid create — precis som fakturans FA-nummer)
 ├─ date, description, status (draft|booked)
 ├─ reverses_verification_id (omföringslänk, nullable; högst en omföring
 │  per verifikat — partiellt unikt index)
 └─ VerificationRow
    └─ account_id, debit, credit — exakt en av dem > 0 per rad (XOR-check),
       aldrig ett tecken på ett belopp
```

Ett bokfört verifikat är append-only: när status blir `booked` går det inte
längre att lägga till, ändra eller ta bort rader (spärrat i service-lagret,
inte bara i UI:t) — en felaktig bokföring rättas med en **omföring**, ett
nytt utkast med debet och kredit spegelvända per rad mot samma konton,
kopplat till originalet via `reverses_verification_id`. Kontosaldon lagras
därför aldrig som ett eget fält: huvudboken är alltid en färsk summering av
bokförda verifikatrader för det valda kontot (löpande saldo = ingående
saldo + Σ(debet − kredit) rad för rad) — samma "raderna är facit,
saldot härleds alltid"-princip som `stock_transactions` (arkitekturprincip
1) och den härledda fakturerade kvantiteten ovan.

## 4. Statusflöden (kritisk domänlogik)

### SalesOrder
```
quote → confirmed → in_production → delivered → invoiced
                  ↘ cancelled
```

### ManufacturingOrder
```
planned → released → in_progress → done → closed
                   ↘ cancelled
```

### Invoice
```
draft → issued ⇄ paid
     ↘ cancelled
```
- `cancelled` är bara tillåtet från `draft` — en redan utfärdad faktura
  korrigeras med en kreditfaktura, inte genom att avbryta originalet
- `issued` allokerar FA-numret (number_series "invoice"), fryser
  värde-snapshotsen, sätter OCR-nummer + förfallodatum, och kör
  order-statusomräkningen i samma transaktion: om ordern står i
  `delivered` och samtliga rader nu är fullt fakturerade (issued/paid,
  drafts räknas inte) → ordern blir `invoiced`
- `issued → paid` är INTE en egen anropbar övergång utan en sidoeffekt av
  betalningsregistreringen (B3, se CustomerPayment ovan): så snart det
  härledda öppna beloppet når 0 flippar fakturan till `paid` i samma
  transaktion som betalningen bokförs — en helt kvittad kreditfaktura blir
  `paid` på exakt samma sätt. `paid → issued` är den enda baklängesövergången
  bland fakturans egna statusar: makuleras den betalning som gjorde fakturan
  fullbetald öppnas den automatiskt igen, i samma transaktion som
  makuleringens omföring. Det finns ingen manuell "markera som betald"-
  övergång (borttagen i B3 — POST /invoices/:id/pay finns inte längre)
- Kreditfaktura: en ny post med `type: "credit"` och `credited_invoice_id`
  mot originalet, samma draft → issued-flöde. Vid dess issue räknas radernas
  kvantitet negativt in i den härledda fakturerade kvantiteten — gör det en
  tidigare fullt fakturerad order ofullständig igen flippas ordern tillbaka
  `invoiced → delivered`
- De två flipparna (`delivered → invoiced`, `invoiced → delivered`) sker
  bara när ordern faktiskt står i den förväntade utgångsstatusen — en order
  som manuellt flyttats till en annan status rörs inte av omräkningen

Varje statusövergång:
- Valideras i service-lagret (inte bara DB-constraint)
- Kan trigga sidoeffekter (t.ex. `released` → reservera material i lager, `done` → skapa `stock_transaction` för färdig artikel + förbrukning av komponenter, `issued` (Invoice) / `approved` (SupplierInvoice) → bokför automatiskt ett verifikat — B2 automatkontering, se `VerificationPoster` i avsnittet **Verification** nedan — allt-eller-inget i samma transaktion som statusändringen)
- Loggas (vem, när, från/till-status) i en `status_history`-tabell per entitet, eller en gemensam `audit_log`

### Verification
```
draft → booked
```
- Ingen `cancelled` finns — ett utkast tas bort (raderna cascadar via FK),
  ett redan bokfört verifikat rättas istället med en omföring, aldrig genom
  att ändra eller ta bort dess rader
- `booked` allokerar verifikatnumret (per serie + räkenskapsår, nollställs
  varje år: `A-2026-1`, `A-2026-2`, …) i samma transaktion som en
  omvalidering av minst 2 rader, balans (Σdebet = Σkredit, avrundat), att
  varje radkonto fortfarande är aktivt, och att bokföringsperioden för
  verifikatets datum fortfarande är öppen — draften kan ha hunnit ändras (en
  admin kan ha låst perioden, eller datumet kan ha flyttats via en
  samtidig header-PATCH) mellan service-lagrets första (billiga) koll och
  bokföringens `FOR UPDATE`-lås, så repositoryt kör om samma fyra villkor
  inuti låset och rapporterar exakt vilket som brast
- Bokföring blockeras även om verifikatets datum ligger i en **låst**
  bokföringsperiod (`AccountingPeriodLockedError`) — perioder låses per
  kalendermånad och låses bara upp igen med en obligatorisk motivering, som
  skrivs till `audit_log` tillsammans med låsningen själv
- **Omföring** (`reverse`): skapar ett nytt UTKAST mot ett bokfört
  verifikat med debet och kredit spegelvända per rad på samma konton/belopp,
  så källa + omföring alltid nettar till noll per konto. Omföringen bokas
  inte automatiskt — den går genom samma `draft → booked`-väg som vilket
  annat utkast som helst. Ett verifikat kan bara omföras en gång (partiellt
  unikt index på `reverses_verification_id`)
- **Automatkontering (B2):** kund-/leverantörsfakturors `issued`/`approved`-
  övergångar (se **Invoice** ovan) bokför via samma villkor/lås som ett
  manuellt utkast, men går direkt till `booked` — det finns inget
  utkaststeg för dem. Verifikaten hamnar i två egna serier, **F**
  (Kundfakturor) och **L** (Leverantörsfakturor), som self-healing-skapas
  vid första bokningen (samma ON CONFLICT-mönster som verifikatnumreraren).
  En makulerad, redan attesterad leverantörsfaktura bokför på samma sätt en
  omföring i serie L. Implementerat i `economy/service/verification-poster.ts`.

## 5. API-design

- REST, JSON, `/api/v1/...`
- Autentisering: OAuth2 client credentials flow (liknar Monitors modell) för maskin-till-maskin, plus sessionsbaserad auth för webb-UI
- Viktiga endpoints för extern konfigurator:
  - `POST /api/v1/quotes` — skapa offert med rader (artikel + konfigurationsparametrar)
  - `GET /api/v1/articles/:id/bom` — hämta strukturer för att validera konfiguration
  - `POST /api/v1/sales-orders` — konvertera offert till order

## 6. Teknisk stack — detaljer

- **apps/api**: Fastify + TypeScript, Drizzle ORM, Zod-validering, Vitest
- **apps/web**: Next.js App Router, server actions eller REST mot apps/api
- **packages/db**: Drizzle-schema, migrationer, delad databasklient
- **packages/shared**: Zod-scheman och TypeScript-typer delade mellan api/web

## 7. Docker Compose-tjänster

- `postgres` — PostgreSQL 16, volym för persistens
- `api` — Node.js/Fastify
- `web` — Next.js
- `redis` (fas 2) — för bakgrundsjobb (t.ex. tunga kalkylkörningar, PDF-generering av fakturor)

## 8. Byggordning / faser

1. **Fas 1 — Grund:** Article, BOM, StockLocation, StockTransaction, grundläggande auth
2. **Fas 2 — Handel:** Supplier, Customer, PurchaseOrder, SalesOrder (utan tillverkning ännu)
3. **Fas 3 — Tillverkning:** Routing, ManufacturingOrder, materialförbrukning, lagerreservation
4. **Fas 4 — Uppföljning:** TimeReport, CostCalculation (för- och efterkalkyl)
5. **Fas 5 — Integration:** Publikt API för extern konfigurator, OAuth2 client credentials

## 9. Beslut på tidigare öppna frågor

- **Lagerreservation vid `released` MO**: mjuk reservation — inget låses. `release()` jämför materialbehov mot `stock_balances` och returnerar varningar vid brist, blockerar inte. Implementerat i Fas 3 (`manufacturing.service.ts`).
- **Efterkalkylens underlag**: verklig tidrapportering per MO-operation (`time_reports.hours` × arbetscentrets timkostnad) och verklig materialförbrukning (`mo_material_consumptions.quantityConsumed`) — inte planerade/schablonvärden. Implementerat i Fas 4 (`costing.service.ts`).
- **Valuta på inköpspris**: ja — artiklar ska kunna ha inköpspris i annan valuta än SEK (t.ex. EUR från utländska leverantörer). Implementerat (`apps/api/src/modules/purchase/{repository,service}/purchase.*.ts`): valutan ligger på leverantören som standardvaluta (`suppliers.currency`) och snapshotas till inköpsordern vid skapande (`purchaseOrders.currency`), tillsammans med en manuellt angiven växelkurs (`purchaseOrders.exchangeRate`, default 1 — hämtas inte automatiskt från någon extern kurskälla). `articles.standardCost`/Costing-modulen förblir SEK-baserad och har ingen koppling till inköpsorderns valuta — de är två oberoende fält, ingen automatisk omräkning sker mellan dem.
- **UI-struktur och responsivitet**: frontend ska efterlikna Monitor G5:s *strukturella* konventioner (flikar, täta datagrids för listor, dialog-baserat skapande) — inte dess hoptryckta densitet — med mer luft på formulär och detaljvyer än Monitor självt har, och vara fullt responsiv ner till telefonbredd. Beslutade brytpunkter: mobil ≤640px, tablet/sidebar-kollaps ≤1024px (dokumenterat i `apps/web/styles/tokens.css`, eftersom CSS custom properties inte kan användas i `@media`-villkor). "Ny X"-flöden skapas som modaler (native `<dialog>`, inget UI-bibliotek — `apps/web/components/ui/Modal.tsx`) istället för egna routes; sidebaren blir en hamburger-styrd overlay under 1024px (`Nav.tsx`); tabeller blir staplade, etiketterade kort under 640px istället för att överflöda (`Table.tsx`). Implementerat som grund + pilot i Inköp-modulen (Leverantörer, Inköpsordrar); övriga moduler görs om enligt samma mönster i uppföljande omgångar.

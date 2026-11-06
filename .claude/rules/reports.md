---
paths:
  - "apps/api/src/modules/reports/**"
  - "apps/web/app/rapporter/**"
  - "apps/web/components/reports/**"
  - "packages/shared/src/reports.ts"
  - "apps/api/test/reports*"
  - "apps/api/test/order-register*"
  - "apps/api/test/quote-followup*"
  - "apps/api/test/margin*"
---

# Rapporter

Rapporter-modulen och dess `rapporter`-rättighet; alla filter i URL:en.

## Orderförteckning

- `GET /reports/sales-order-register` och `/reports/purchase-order-register` (+ `/csv`, `/pdf`); sidorna `/rapporter/orderforteckning-kundorder|-inkop`, delad `OrderRegisterPageClient`.
- Urvalet (`salesOrderRegisterQuerySchema`/`purchaseOrderRegisterQuerySchema` i `packages/shared/src/reports.ts`) gäller **orderraderna**: `dateBasis` `order` (skapandedagen i Stockholm — ordrar saknar eget orderdatum) eller `delivery` (radens effektiva datum ur `planning/repository/effective-dates.ts`, samma uttryck som planeringen); `articleId`/`articleGroupId`/`openOnly` väljer rader och en order visas med de rader som matchade (värdena summerar bara dem); `status=open` = `SALES_ORDER_OPEN_STATUSES`/`PURCHASE_ORDER_OPEN_STATUSES`.
- Repositoryt (`order-register.repository.ts`) ger platta rader i basenhet; rena `order-register.ts` grupperar och räknar (kundorder antal × à-pris × (1 − rabatt), inköp + ställpris som är rest tills något på raden mottagits; radens enhet via `toUnitQuantity`/`toUnitPrice`; belopp i orderns valuta, summorna omräknade till SEK med orderns växelkurs).
- Över `ORDER_REGISTER_MAX_ROWS` (10 000) rader ⇒ 400 `order-register-too-large`, **aldrig en avkortad lista**. PDF:en är `renderOrderRegister`, den enda liggande mallen.

## Offertuppföljning

- `GET /reports/quote-followup` + `/csv` (rena `quote-followup.ts`), sidan `/rapporter/offertuppfoljning`. Utfall vunnen = confirmed/in_production/delivered/invoiced; hit rate = vunna/(vunna+förlorade) i antal och värde; makulerade utanför; värde = radernas nuvarande värde exkl. moms; Stockholmsmånad på skapandet; tak 10 000 ⇒ 400 `quote-followup-too-large`. Bara poster med `quoted = true` räknas (äldre ordrar inte, eftersom Ny kundorder också loggar `confirmed`). Statusarna och förlustorsakerna: `sales.md`.

## Leveransprecision per motpart (Kvalitet, 0153)

- `GET /reports/delivery-precision?groupBy=month|counterparty` (+ `/csv?kind&groupBy`): förvalet `month` är oförändrat; `counterparty` lägger `counterparties: { rows, totals }` på varje sida. Precisionen mäts med samma `measureOrder` som månadsvyn (`delivery-precision-calc.ts`); rena `delivery-quality-calc.ts` lägger till Avvikelser (ärenden av sidans typ med Datum i perioden, ej makulerade), Order med avvikelse/Andel felfria (av de mätta ordrarna, via ärendets `purchase_order_id`/`sales_order_id`, oavsett datum), Reklamerat antal (per artikel; total bara när alla har samma enhet, annars null) och Avvikelsekostnad (nettokostnaden ur `deviation-costs.ts`, null utan `canSeePrices`). Kvalitetsdata läses genom `PrecisionQualityReader` (quality-servicen, injicerad i `createReportsService`).
- Kassationsrapportens `groupBy=reason` grupperar på Avvikelseorsaken (`key` = orsakens id); äldre fritextrader på texten med `key` `text:<text>` och etiketten "… (fritext)".

## Kalkylutfall (#14 etapp 2)

Spec `private/superpowers/specs/2026-11-06-avvikelseanalys-efterkalkyl-design.md`; analysen själv: `costing.md`.

- `GET /reports/calculation-outcome?from&to&view=pre|analysis&groupBy=order|article|workCenter` + `/csv` (samma parametrar), `calculationOutcomeQuerySchema` (förval `pre`/`order`; `groupBy` gäller bara `analysis`), regel `rapporter`. Ingen PDF.
- **Urvalet:** varje TO:s **senaste** efterkalkyl (DISTINCT ON order, `calculated_at desc, id desc`) vars Stockholmsmånad ligger i perioden — en TO räknas bara i sitt facits period, aldrig med en äldre efterkalkyl i en tidigare. Repot (`loadCalculationOutcome`) läser huvuden, materialrader och operationsrader med **en fråga var** mot samma delfråga (handaliasad SQL, aldrig en id-lista — parametertaket), och för `pre` artikelns förkalkyler (mo null) för periodens artiklar. **EN ögonblicksbild:** frågorna körs i följd i en `repeatable read`, `read only`-transaktion (`readCalculationOutcome(tx, …)`, PIA:s mönster) — varje fråga räknar om "senaste per TO", och en Spara mellan två frågor gav annars huvud A utan rader (allt i Påslag). Ingen HTTP i transaktionen. Analysen härleds per efterkalkyl med `storedVarianceAnalysis` (samma mappning som GET `/cost-calculations/:id`); allt övrigt i rena `calc-outcome-calc.ts`.
- **Mot förkalkyl** (`preCalculationOutcome`): artikelns senaste förkalkyl ≤ efterkalkylen; en konfigurerad TO mot `configuration.cost.manufacturingCostPerUnit` (`preSource: "configuration"`, `preMultiLevel: true`, null ⇒ `onlyPost`). Efterkalkyl TVK/st delas med N (`perUnitBasis: "output"`) när analysen finns och inte är preliminär, annars med efterkalkylens antal; `calculatedTvkPerUnit` = Kalkylerat ÷ N bara då. `preliminary: true` = Ej klar, `null` = sparad före 0187. Räknare: `onlyPost`, `invalidQuantity`, `noOutput` (slutlig analys med N = 0, t.ex. Makulerad).
- **Avvikelseanalys** (`analysisOutcome`): bara slutliga analyser i summorna; `counts.preliminary`/`withoutAnalysis` räknas utanför. Belopp summeras i hela ören, så delarna summerar exakt. `kpis` gäller alltid hela ordrarna (Avvikelse = Pris + Mängd + Tid + Påslag, Tid = Timpris + Ställ + Stycke + Ej uppdelad); `totals` är tabellens summa — för Resurs bara operationsraderna (material och Påslag har ingen resurs). Resurs grupperas på (resurs, slag), timmar summerade i sin skala; Verklig ställ/stycke (efterkalkylens `setup_hours`/`run_hours` ur tidrapporternas typ, etapp 3) är null tills någon **delad** operation (`split` och typad tid) finns i gruppen; operationer som inte är delade — utan typ eller halvt typade — räknas med 0 där och hela sin tid (`unclassifiedHours` = H) under Ej uppdelad (h), så Verklig ställ + stycke + Ej uppdelad (h) = Rapporterat (h).
- CSV: alla kolumner, varav kassation och Timpris som egna kolumner, Totalt-rad i analysvyn; filnamnen `kalkylutfall-<från>-<till>.csv` och `kalkylutfall-avvikelseanalys-<groupBy>-<från>-<till>.csv`.
- Tester: `calc-outcome-calc.test.ts` (rent, även halvt typad operation i Resurs), `reports-calc-outcome.test.ts` (riktiga sparvägar: N på kortstängd, konfigurerad TO, noOutput, grupperingarna, räknarna, senaste per TO och Stockholmsmånaden, ögonblicksbilden deterministiskt med två klienter — den andra håller `cost_calculation_material_rows` låst medan en ny efterkalkyl sparas —, MO/LO med lego och Resurs, verklig ställ och stycke i Resurs, rutterna och CSV:n), `configured-manufacturing.test.ts` (konfigurerad TO via skapavägen), `reports.schema.test.ts`.

## Projektrapport

- `GET /reports/project-report?projectId&from?&to?` + `/csv` (regel `rapporter`), sidan `/rapporter/projektrapport`. Rena `project-report.ts` (`buildProjectReport`) räknar bara **resultatkonton** (klass 3 intäkt kredit-positiv, 4–8 kostnad debet-positiv; ett balanskonto som bär projektet utelämnas) ur bokförda rader med `verification_rows.project_id`; `from`/`to` utelämnade = alla tider och svaret ekar då första/sista bokförda dag (null utan rader). Kundordrarna med `sales_orders.project_id` listas med radvärdet i SEK som offertuppföljningen — bara order (`documentKindSql` i lövet `sales/repository/document-kind.ts` = `order`, aldrig offerter/förlorade) och inte makulerade. Okänt projekt ⇒ 404 `project-not-found`. Invarianterna för dimensionerna: `economy.md`.

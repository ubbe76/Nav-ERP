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

## Projektrapport

- `GET /reports/project-report?projectId&from?&to?` + `/csv` (regel `rapporter`), sidan `/rapporter/projektrapport`. Rena `project-report.ts` (`buildProjectReport`) räknar bara **resultatkonton** (klass 3 intäkt kredit-positiv, 4–8 kostnad debet-positiv; ett balanskonto som bär projektet utelämnas) ur bokförda rader med `verification_rows.project_id`; `from`/`to` utelämnade = alla tider och svaret ekar då första/sista bokförda dag (null utan rader). Kundordrarna med `sales_orders.project_id` listas med radvärdet i SEK som offertuppföljningen — bara order (`documentKindSql` i lövet `sales/repository/document-kind.ts` = `order`, aldrig offerter/förlorade) och inte makulerade. Okänt projekt ⇒ 404 `project-not-found`. Invarianterna för dimensionerna: `economy.md`.

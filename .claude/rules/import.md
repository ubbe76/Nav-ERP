---
paths:
  - "apps/api/src/modules/import/**"
  - "apps/web/app/**/import/**"
  - "apps/web/components/import/**"
  - "apps/web/lib/importEntities.ts"
  - "apps/web/lib/importFields.ts"
  - "apps/web/public/importmallar/**"
  - "docs/manual/importmallar.md"
  - "packages/shared/src/import.ts"
  - "apps/api/test/import*"
  - "apps/api/test/xlsx*"
---

# Importerna (Monitor-exporter och mallar)

E2e-testerna mot de riktiga exportfilerna ligger i det privata repot (`private/api-tests/*.real-files.test.ts`) — inga riktiga uppgifter ur exporterna i det publika repot.

## Importmallar

Spec `docs/superpowers/specs/2026-10-22-importmallar-design.md`.

- Rena `import/service/field-help.ts` är enda källan för varje importkolumns rubrik, förklaring, exempel och `text`-flagga (alla 15 entiteter; testet kräver täckning åt båda hållen, att varje rubrik kopplas till sitt eget fält av entitetens alias och att `required` stämmer med planern). Serveras till mappningssteget via `GET /imports/:entity/fields` (admin).
- `npm run generate:import-templates -w apps/api` genererar de **incheckade** mallarna `apps/web/public/importmallar/importmall-<namn>.xlsx` (blad Import med kommentarer och textformaterade nummer-/kodkolumner, blad Instruktioner; proxyn undantar `importmallar/`) och manualkapitlet `docs/manual/importmallar.md` — **redigera aldrig dem för hand**. `import-templates-generated.test.ts` jämför byte för byte och kräver att katalogen och webbens `IMPORT_TEMPLATE_FILES` är exakt `IMPORT_TEMPLATES`. **Ändras en planer eller en förklaring: uppdatera field-help och kör generatorn.**
- `xlsx-writer.ts` är handskriven och deterministisk (STORED-zip med `zlib.crc32`, OOXML med legacy-kommentarer + VML) — inget produktionsberoende. Hemsidan synkar mallarna (`hemsida/lib/sync.ts`), så Nav-main måste ha dem innan hemsidan byggs.

## Flerfilsimport "Alla filer" (paket D)

- `POST /imports/detect` (entitetslös parse, samma 20 MB-vakt) kör rena `detectImportEntity(headers)` i `import/service/detect.ts` — en **ordnad** signaturtabell över normaliserade rubriker (bom före routing före articleUnits före prisfilerna före articles, eftersom flera filer delar `artikelnummer`; den vanliga routing-signaturen kräver dessutom en tidskolumn, `needsTimeColumn`) — och svarar med `detectedEntity` + `suggestedMapping` (`{}` när okänd). Nivålistan känns medvetet inte igen. **Lego-operationslistan saknar tider och har en egen routing-signatur (Op. + Ställkostnad/Styckkostnad/Legoartikelnummer)** — utan den föll filen till artikellistan, där aliaset `namn` gjorde resursnamnet till varje artikels benämning.
- Preview och commit skickar raderna tillbaka som JSON: rutterna har `bodyLimit` 16 MB (`IMPORT_ROWS_BODY_LIMIT`), Fastifys 1 MB räckte inte för 10 000 rader (Operationslistan ≈ 2,3 MB).
- `xlsx.ts` avkodar OOXML:s `_xHHHH_` (`decodeOoxmlText`) och slår ihop CR/CRLF till `\n` — Monitors flerradiga celler kommer som `rad 1_x000d_\nrad 2`.
- `IMPORT_ENTITY_ORDER` (`packages/shared/src/import.ts`, spegel `apps/web/lib/importEntities.ts` med alla entitetskonfigurationerna) är commit-ordningen.
- Webben: `ImportWizard` är uppbruten i `MappingTable`/`ImportOptionsPanel`/`PreviewTable`/`ResultSummary` + `importTypes.ts` (`buildInitialMapping` bevarar rubrikordningen) som `MultiFileImportWizard` komponerar per fil. Entitetsbyte re-parsar via `/imports/:entity/parse`; förhandsgranskning och commit går sekventiellt genom de **befintliga** endpointsen (en transaktion per fil) med **stopp vid första fel** — efterföljande filer märks `blocked`.
- Sidan `/artiklar/import` har flikar per entitet; `TabConfig.chapter` styr HelpLink-kapitlet.

## Artikelimporten och dess delexporter (paket C)

- Tre entiteter, alla **upserts** på sin nyckel (`skipExisting` ⇒ skip):
  - `articleUnits` (`service/article-units.ts`, "Artikellista, Enheter"): **Omr.faktor är bas per EN alt-enhet, lagrad `quantity_per_base = 1/faktor`**; faktor 1-raden är grundenheten och skippas med varning vid avvikande kod; `Inköpsorder`/`Kundorder` ⇒ `purchase_unit_id`/`sales_unit_id`; okända enheter skapas.
  - `supplierPrices` (`service/supplier-prices.ts`, båda Prislista-Inköp-filerna): rader grupperas per (artikel, leverantör), första raden är katalograden, staffelfilens andra `Pris` landar på `breakPrice` via **sekundäraliaset** `{ pris: "breakPrice" }`; Gränsvärde ≤ 1 ignoreras med varning; `breaksMapped` ⇒ `replacePriceBreaks` per rad (tom lista rensar); Förvald ⇒ demotering av tidigare primär i tx; `netPrice` = Pris × (1 − Rabatt/100) med varning (katalogen har inget rabattfält).
  - `customerPrices` (`service/customer-prices.ts`): artikelregel vid `from_quantity = 1`; uppdatering nollar `discount_percent` för XOR-CHECK:en. Läser även Monitors **Artikellista, Kundkopplingar**: Pris är inte obligatorisk kolumn, rad utan kund/utan både pris och kundens art.nr ⇒ **skip** (inte radfel — filen listar alla artiklar), `customerArticleNumber` upsertas i `customer_article_numbers` (0160) i samma tx, bara när numret ändras; `created`/`updated` räknas per rad ur `plan.summary`.
- **Varugrupp och Artikelkod** (0155): Monitors kolumn **Varugrupp** (ensiffrig) mappas till `groupCode` (1–4 siffror, gamla rubriken Artikelgrupp mappas fortfarande) och **Artikelkod** till `articleCode` (max 20); koder som saknas skapas i commit-transaktionen med koden som namn (artikelkoden får "kod (2)" om namnet redan är taget, `freeName`), tom cell lämnar fältet orört. `willCreate`/`registersCreated` bär `articleCodes` bara i artikelimporten.
- Artikelimporten läser planeringsfliken: `reorderPoint`/`orderQuantity`/`rounding` (0 ⇒ null, > 3 decimaler avrundas med varning) och `lotSizingRule` — **Orderkvantitet tas bara vid `Partiformningsregel = Fast orderstorlek`** (omappad regelkolumn ⇒ tas rakt av). Benämning är inte obligatorisk i guiden (delexporterna saknar kolumnen). Importerna anger alltid egna artikelnummer (rör ingen nummerserie).
- **Inköp-flikens fält:** `quantityPerPackage` (Antal/kolli, 0 ⇒ null) och `primarySupplierNumber` (Leverantörsnr, okänd ⇒ radfel) — leverantören blir förvald i lövet `import/repository/article-primary-suppliers.ts` (`applyPrimarySuppliers` i `executeArticlePlan`s tx: demotera andra primära i en sats per chunk, sedan upsert på (artikel, leverantör) med `is_primary`; ny rad utan pris i leverantörens valuta).
- **Extra benämning** (0157): `extraDescription`, flerradig (`decodeOoxmlText`), > 2000 ⇒ radfel, tom cell orörd.
- **Revisioner:** `articleRevision`/`drawingNumber`/`drawingRevision` (Artikelrevision/Ritningsnummer/Ritningsrevision) är additiva och idempotenta — revisionen blir aktiv (läggs till om den saknas, den gamla blir inaktiv; förhandsgranskningen varnar när den aktiva byts, `articlesByNumber` bär `activeRevision`), ritningsnumret läggs till om det saknas, ritningsrevisionen gäller ritningsnumret på samma rad (krävs, annars radfel); importen tar aldrig bort något. Lövfilen `import/repository/article-revisions.ts` (`applyImportedRevisions` i `executeArticlePlan`s transaktion, ren `revisionChanges`).

## Operationsimporten och tidsenhet

- `routing_operations.time_unit` är en ren visningsinställning (lagringen är alltid min/st). Operationsimporten (`import/service/routing.ts`) läser kolumnen **Enhet** som `timeUnit` (`parseRoutingTimeUnit`/`convertRoutingTimes`, rena): **antal/timme** ⇒ Ställtid i **timmar**, Stycktid som st/h (0,2/360 ⇒ 12 min / 0,1667 min/st, lagrad `units_per_hour`; Stycktid 0 ⇒ 0 min/st + varning); minuter/timmar/sekunder per enhet konverteras till minuter, och **sekunder/enhet** sparas med visningsenheten `seconds_per_unit` (sek/st, 0167) på samma sätt som antal/timme behåller st/h; okänd enhet ⇒ radfel; omappad ⇒ minuter. Legoresurs ⇒ tider 0 + varning.
- **Lego:** Ställtid/Stycktid är inte obligatoriska kolumner — en rad på vanlig resurs utan båda är ett **radfel**, en legorad får 0/0. `subcontractSupplierNumber`/`setupPrice`/`unitPrice` (Leverantör/Ställkostnad/Styckkostnad) skrivs bara på legoresurser (annars varning + ignoreras); ny legooperation utan leverantör får resursens `supplier_id` (som `assertLegoFieldsForResource`). Vid `updateExisting` till vanlig resurs töms lego-fälten bara om operationen har några (`routingOperationsByArticle` bär `hasLegoFields`).
- **Importen var create-only och läste tiderna som minuter fram till 2026-09-06 — rutter importerade dessförinnan har fel tider och rättas med `updateExisting`** (*Uppdatera befintliga operationer*, utesluter `skipExisting` ⇒ `ImportMappingError` 400): befintlig operation (artikel + sekvensnr) får resurs/tider/tidsenhet/Kalkyl överskrivna och textfälten bara när cellen är ifylld (`RoutingUpdatePlan.patch`); `mo_operations`-snapshoten rörs aldrig (testat). `workCentersByCode` bär `type`.

- **Cykeltid** (0159) är eget fält `cycleTimePerUnit` — aliaset `cykeltid` pekade tidigare på stycktiden. Omräknas med filens tidsenhet (`convertCycleTime`, ren), 0 ⇒ null, ignoreras på legoresurs, i `updateExisting` bara från ifylld cell.

## Kundens leveransadresser

- Läser både Leveransadress-filen och **Alternativa leveransadresser** (där två kolumner heter "Namn": den första är kundens och lämnas, upprepningen mappas till `label` via sekundäraliaset). Kolumnen **Förvald** (`isDefault`) avgör per rad när den är mappad, annars gäller `setAsDefault`; en kund med förvald adress får aldrig en till (varning).

## Strukturimporten

- **Pos.** (`position`, 0158, varchar 20) och **`updateExisting`** (*Uppdatera befintliga strukturrader*, utesluter `skipExisting` ⇒ 400): befintlig (förälder, komponent) skrivs om med antal + enhet alltid, operationslänken bara när kolumnen är mappad (tom ⇒ avlänkad), Pos. bara från ifylld cell. `allBomEdges` bär radens `id`; uppdaterade rader lägger inga kanter i cykelkontrollen.

## Resursimporten

- Monitors **Produktionsgrupp** = Navs **resurs** (tresiffrigt nummer), Monitors **Avdelning** = Navs **produktionsgrupp** — begreppsväxlingen gäller genomgående i importguiderna.
- `workCenters`/`legoWorkCenters`/`productionGroups` (sida `/tillverkning/resurser/import`) läser exporten "Produktionsgruppslista" (Kostnader/Lista/Lego): bara kostnadsradsvärdet **Ordinarie** importeras ur Kostnader-filens Kostnadsrad-kolumn; avdelningar som saknas skapas som produktionsgrupper i commit-transaktionen. `work_centers` bär de importerade fälten (`default_setup_time`, `default_operation_name`, `rate_applies_to_setup`/`rate_applies_to_run`, `calc_rate_1`, `lead_time_days`/`queue_time_days`/`order_lead_time_days` på legoresurser) som rena förvalsvärden som beredningen ännu inte läser.

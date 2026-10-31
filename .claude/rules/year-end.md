---
paths:
  - "apps/api/src/modules/economy/**/fixed-asset*"
  - "apps/api/src/modules/economy/**/depreciation*"
  - "apps/api/src/modules/economy/**/year-end*"
  - "apps/api/src/modules/economy/**/fx-revaluation*"
  - "apps/api/src/modules/economy/**/accounting-period-lock*"
  - "apps/web/app/ekonomi/anlaggningar/**"
  - "apps/web/app/ekonomi/anlaggningsgrupper/**"
  - "apps/web/app/ekonomi/avskrivningsplan/**"
  - "apps/web/app/ekonomi/bokslut/**"
  - "apps/web/lib/fixedAssets.ts"
  - "apps/web/lib/yearEnd.ts"
  - "packages/shared/src/fixed-asset.ts"
  - "packages/shared/src/year-end.ts"
  - "apps/api/test/fixed*"
  - "apps/api/test/depreciation*"
  - "apps/api/test/year*"
---

# Anläggningsregister och årsbokslut

## Anläggningsregister (migrationerna 0103/0104)

Spec `docs/superpowers/specs/2026-10-08-anlaggningsregister-design.md`.

- Tabellerna `fixed_asset_categories` (fem FK-konton inkl. vinst/förlust), `fixed_assets` (AN-serie, nyckel `fixed_asset`), `fixed_asset_depreciation_runs` (en körning = ett AV-verifikat) och `fixed_asset_depreciations` (en rad per tillgång/månad, partiellt unikt index `(asset_id, month) WHERE superseded_by_run_id IS NULL`). Registret bokför aldrig anskaffningen; ackumulerad avskrivning och bokfört värde **härleds** ur gällande rader.
- **Beloppsregeln är enbart `missingMonths()`** (`depreciation-schedule.ts`): räknar om per månad (återstående underlag jämnt på återstående månader, sista månaden tar resten) — oberoende av körtakt, identisk med linjärt utan ändringar, framåtverkande vid ändrad nyttjandetid/restvärde (kostnad/datum/start/grupp låses efter första raden).
- **Ingående avskrivning** (`opening_depreciation`/"Avskriven t.o.m. månad") ligger redan i IB, bokförs aldrig av registret och visas alltid som IB ack.
- **`runDepreciation(tx, { throughMonth, scope?, date? }, userId)`** (`fixed-asset.service.ts`) är Tx-only (bokslutet anropar den), tar `pg_advisory_xact_lock(hashtext('fixed_asset_depreciations'))` först, bokför via `poster.postDepreciation` i serie **AV** daterat månadens sista dag, hämtar ikapp månader i låsta perioder på körningens datum och returnerar `null` när inget saknas (409 `nothing-to-depreciate`).
- **Ångra** är en egen rutt: bara den senaste aktiva körningen (aldrig en avyttrings ikappbokning), omföring daterad körningens datum, raderna får `superseded_by_run_id`. Den generiska **Omför** nekas för AV-verifikat (`FixedAssetVerificationError`; webben döljer knappen via `VerificationDetail.fixedAsset`).
- **Avyttring** = ikappbokning t.o.m. avyttringsmånaden + `poster.postFixedAssetDisposal` (kredit tillgång, debet ack, debet mellankonto, vinst/förlust) + statusflipp i en tx; ingen Ångra avyttring. Momsrapporten utesluter avyttringsverifikatet på identitet så fakturans kredit på mellankontot når ruta 05 (dialogen varnar när mellankontot saknar ruta 05).
- **Kontoroller över grupperna:** tillgångs- och ack-kontot stäms av per konto, så ett konto i någon av de två rollerna får ingen annan roll i **någon** grupp (`assertAccountRolesAcrossCategories`, 409 `fixed-asset-category-account-role-conflict` med `accountNumber`/`role`/`categoryName`/`otherRole`); samma roll i flera grupper är tillåten. Körs under avskrivningslåset tillsammans med skrivningen (även `createCategory` tar det nu) och vid uppdatering bara när ett konto ändras — en äldre kombination får byta namn. `seedBasCategories` prövas inte (BAS-grupperna är konsekventa).
- **`createAsset` med ingående avskrivning** tar avskrivningslåset (`DEPRECIATION_LOCK_SQL`) först i sin transaktion: beloppet låser gruppens bokföringskonton (`postingAccountsLocked`), som `updateCategory` kontrollerar under samma lås. Test: `fixed-asset-opening.test.ts` ("takes the run lock").
- Avskrivningsplanen (`fixed-asset-plan.ts`, ren; `/ekonomi/avskrivningsplan` + PDF/CSV) daterar rader på körningens verifikatdatum och stämmer av registret per konto mot `readAccountBalances`. `getPlan` läser register och huvudbok ur EN ögonblicksbild (`repeatable read`/`read only`-transaktion, `readPlan(ex, …)`), så en AV-körning som committar mellan läsningarna aldrig syns som en tillfällig avvikelse. `updateCategory` behöver inget radlås: alla gruppskrivare och körningar tar `DEPRECIATION_LOCK_SQL` först. Webben: `/ekonomi/anlaggningar` (+ `[id]`), `/ekonomi/anlaggningsgrupper`; manualkapitlet **Anläggningsregister**.

## Årsbokslut (migrationerna 0105–0106, 0146)

Spec `docs/superpowers/specs/2026-10-09-arsbokslut-design.md`.

- `fiscal_years.status` (`open|closed`, `closed_at`/`closed_by`) är auktoriteten för stängt år. `year_end_closings` (ett per år) pekar ut stegens **gällande** verifikat (lager, periodiseringspar V+R med CHECK båda-eller-ingen, valutaomvärdering, resultatöverföring); `year_end_closing_verifications` loggar allt guiden bokfört — den generiska **Omför** nekas för dem (`YearEndClosingVerificationError`) och momsrapporten utesluter dem på identitet.
- **Spärren för stängt år har tre lager:** appen (`FiscalYearClosedError extends AccountingPeriodLockedError` från `assertPostablePeriod`, `unlockPeriod` och utkasten), triggern `verifications_closed_year_lock` (vägrar bokföring i stängt år, tar `FOR SHARE` på årsraden) och `accounting_periods_closed_year_lock` (vägrar `locked → open`, läser årsraden `FOR SHARE` så en upplåsning som krockar med en stängning väntar och vägras). `closeYear` uppdaterar årsraden **före** sina kontroller så en samtidig bokföring hinner klart och syns.
- Varje skrivande steg låser bokslutsraden `FOR UPDATE` och bokför i serie **BS** via `poster.postClosingEntry`; omkörning = omföring på verifikatets eget datum + nytt verifikat, eller `unchanged` utan verifikat. Belopp i rena `year-end-calc.ts`, spärrar/varningar i rena `year-end-checks.ts`.
- Steg 3 är registrets `runDepreciation` med `date` = bokslutsdatumet. Steg 4:s återföring länkas **inte** via `reverses_verification_id` (då kunde V aldrig omföras), och nästa år skapas med `createFiscalYear` före transaktionen.
- **Valutaomvärdering** (steget `fx_revaluation` efter periodiseringarna; stegen 2–6 behåller sina nummer): öppna kund- och leverantörsfakturor i annan valuta värderas per bokslutsdagen. Kursordning: skriven i steget (`rates`) → den gällande bokningens (`year_end_closings.fx_rates`) → `getRate` hämtad före transaktionen; saknad ⇒ 409 `fx-revaluation-rate-missing`. ETT BS-verifikat (1510/2440 netto per sida mot 3960/7960 brutto per valuta) med automatisk återföring på nästa års första dag (`fx_verification_id`/`fx_reversal_verification_id`, CHECK båda-eller-ingen, `fx_booked_at` = gjort även utan verifikat; `unchanged` när belopp och kurser är desamma). Med valutaposter spärrar ett ogjort steg stängningen (`fx-revaluation-not-done`) och resultatöverföringen; en inaktuell bokning varnar (`fx-revaluation-stale`).
- **Varningarna (steg 1):** `loadWarnings` med `tolerant` (bokslutssidans GET) kör kontrollerna parallellt och var för sig — en som kastar blir varningen `check-failed` ("… kunde inte kontrolleras") och loggas via `deps.log`, resten visas. `closeYear` kör dem strikt i sin transaktion (ett SQL-fel har ändå avbrutit transaktionen). Ett år utan period för sin sista dag ⇒ 409 `fiscal-year-last-period-missing` (`lastPeriod`), inte 500.
- **Periodiseringskortets utkast** (`AccrualsCard`, localStorage per bokslut) sparas med `basis` = stegets `bookedAt`; ett utkast från ett annat bokföringsläge (någon annan har bokfört) kastas med en notis i stället för att dölja de bokförda raderna.
- Klass 3–8 avgörs med `classifyAccount`. Reskontraavstämningen per bokslutsdag är `receivablesTotalAsOf`/`payablesTotalAsOf` (+ omvärderingen). Bokslutsvarningen `bank-not-reconciled` (`unreconciledBankAccountsAsOf`).
- Öppna igen låser bara upp bokslutsmånaden. Året stängs tidigast dagen efter sin sista dag (`fiscal-year-not-ended`), inget räkenskapsår får läggas upp före ett stängt (`FiscalYearBeforeClosedYearError`), och bokslutsdatumet låses av första bokförda steget inklusive steg 3:s AV-körning (`closingDateLocked`). 8999/2099/2091/2898 är konstanter (`year-end-accounts.ts`); lager/lagerförändring är standardkonton (`posting_inventory`/`posting_inventory_change`). Webben: `/ekonomi/bokslut`; manualkapitlet **Årsbokslut**.

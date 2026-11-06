---
paths:
  - "apps/api/src/modules/costing/**"
  - "apps/web/components/costing/**"
  - "apps/web/components/system/CostingSettingsForm.tsx"
  - "apps/api/test/costing*"
  - "apps/api/test/prishistorik*"
  - "apps/api/test/work-in-progress*"
  - "apps/web/app/rapporter/produkter-i-arbete/**"
---

# Kalkyl: materialkällor, valuta och efterkalkylen vid uttaget

Spec `private/superpowers/specs/2026-10-29-prishistorik-och-efterkalkyl-design.md` (prishistorik, migration 0169); valutan i kalkylen: `currency.md`.

- **Två materialkällor** (System → Kalkyler): `costing_material_source` = **förkalkylens** (`standard`|`supplier`, `costingPreMaterialSourceSchema`; nyckeln heter som före delningen) och `costing_post_material_source` = **efterkalkylens** (`standard`|`supplier`|`actual`). 0169 kopierade det gemensamma värdet till efterkalkylen och gjorde förkalkylens `actual` till `standard`. Konfiguratorns `previewStructure` följer förkalkylens. `CostingSettingsReader.costingPostMaterialSource` är valfri — saknas den (teststubbar) gäller förkalkylens, som före delningen; `preCalculationSource` finns kvar som försvar mot en stubb med `actual`.
- **Efterkalkylen prissätter vid uttaget** (regeln `pricedAtWithdrawal` i rena `price-at.ts`, laddad av `withdrawalPrices` i `costing.service.ts`): med `standard`/`supplier` läses varje komponents standardkostnad (D1-historiken) och huvudleverantörens katalograd (`article_supplier_price_history`) per **T = senaste uttaget** (`getLatestConsumptionTimes`: max `created_at` för `mo_consumption` med negativ delta på ordern; aldrig uttagen ⇒ nu), och kursen per Stockholmsdagen av T (`priceDate` på basen ⇒ `createRateAttacher` slår upp per valuta **och dag**). Raden får `price_date`. `actual` rörs inte (viktad per uttag i `actual-cost.ts`, inleveransens `unit_cost` bär redan IO:ns kurs).
- **Pris vid T** i rena `price-at.ts`: senaste raden ≤ T, före första raden den **första** (D1:s konvention i `valuation.service.ts`); huvudleverantören = varje leverantörs tillstånd vid T, den som var `is_primary` och inte `removed`. Ingen standardhistorik alls ⇒ artikelns nuvarande värde.
- **Verklig kostnad spelar upp på värderingsdatumet** (#26, `stockValuedAt` i `getConsumptionMovingAverageCosts`). En inventering registrerad per underlagets datum väger in vid sin frysning, alltså före ett uttag som registrerats mellan frysningen och registreringen. `getLatestConsumptionTimes` (T för pris vid uttaget) är fortfarande `created_at`, eftersom ett uttag aldrig bakdateras.
- **Varför senaste uttaget, inte viktat:** raden ska visa ett pris och en kurs; den exakta vägen är Verklig kostnad.
- Specifikationsraden visar valuta/kurs och `uttag <dag>` under Priskälla (`PriceSourceCell`, även på fallback-raden).
- **Kalkylrader** (`bom_components.costing_only`, 0178): förkalkylen (`repo.explodeBom` = `explodeBom(..., "include")`, även flernivå och konfiguratorns `previewStructure`, som aldrig filtrerar `components`) prissätter dem som vilken rad som helst; `ExplodedComponent.costingOnly` följer med men lagras inte på specifikationsraden. Efterkalkylen behöver inget — den prissätter TO:ns materialrader, och frisläppet skapade aldrig någon för en kalkylrad. Test: blocket *Kalkyl structure rows* i `costing.service.test.ts`.
- Tester: `costing-price-at.test.ts` (rent), blocket *priced at the withdrawal* i `costing.service.test.ts` (backdaterar `stock_transactions.created_at` och historikens `valid_from` med SQL), `system.service.test.ts` (inställningarna), `prishistorik.test.ts` (triggerna).

## Produkter i arbete per datum (#25)

Spec `private/superpowers/specs/2026-11-06-produkter-i-arbete-design.md`; bokslutssteget i `year-end.md`.

- **PIA = efterkalkylen per D minus avräknat**, härlett ur loggarna, inget lagras. `work-in-progress.service.ts` bygger med efterkalkylens byggstenar (`buildMaterialRow`/`buildOperationRow`/`buildSubcontractOperationRow`/`directCosts`/`applyMarkups`), aritmetiken bor i rena `work-in-progress.ts` (`relievedValue`, `workInProgressRow`, `isDoneAt`, `workInProgressTotals`). `manufacturing_cost` = TVK med dagens MO/LO, `direct` utan. **TO (resursens `overhead_percent`) räknas aldrig.**
- **EN regel för pris vid uttaget:** `pricedAtWithdrawal(consumptions, drawnAt, histories, otherwise)` i `price-at.ts`. Efterkalkylen ger `getLatestConsumptionTimes` och `otherwise` = nu (oförändrat), PIA ger senaste uttaget ≤ D (`drawnAt` ur `listMaterialNet`). `createRateAttacher` och `loadCostingConfig` exporteras ur `costing.service.ts` för PIA; efterkalkylens materialkälla gäller.
- **Källorna** i lövet `costing/repository/work-in-progress.repository.ts`, en fråga per källa för alla ordrar (inga N+1): material = −Σ `mo_consumption` med `stockValuedDate` ≤ D (återlämnat drar av, netto ≤ 0 ingen rad); `actual` = `weightedActualCosts` över bara **uttagen** (negativa rader) ≤ D, medan efterkalkylens `getConsumptionMovingAverageCosts` skickar med returerna; lön = `time_reports.date` ≤ D (arbetsdagen) × dagens timkostnad; lego = `purchase_receipts` levande på D (skapad ≤ D, `undone_at` null eller > D) på IO som inte är makulerad, ställpriset en gång när radens antal > 0, ingen fallback på TO:ns snapshotpris; avräknat = `mo_receipt` ≤ D. Som i efterkalkylen ger en legoresurs bara IO-kostnad och en tidsresurs bara timmar.
- **Klar vid D är domänens egen regel** (`undoReportInTx`s `stillDone`), i `isDoneAt`: (a) en `kind = 'completion'`-rapport (Slutför/Slutför order, även 0117:s backfill) levde på D (skapad ≤ D, ångrad null eller > D), eller (b) inlevererat vid D ≥ orderantalet (delinleverans från sista operationen eller legoinleveransen, och ordrar klara före 0117). **Inte `completed_order`**: den säger bara att en rapport vände ordern till klar, och en operationsrapport som gjorde det slutar gälla när en tidigare inleverans ångras. Test: "reopens an order per D …".
- **Vilka ordrar:** delfrågan `candidateOrders(asOf)`, inte en id-lista (parametertaket). Den utesluter (1) säkert klara, alltså en **aldrig ångrad** completion-rapport skapad ≤ D (delmängd av (a); `isDoneAt` avgör resten); (2) kortstängda ordrar från före rapporteringsloggen: `closed`, `quantity_received < quantity` och ingen completion-rapport alls (0117 backfyllde bara ordrar som då var `done`, och sedan dess går en kortstängning alltid via Slutför). Det är ingen regel per dag. (3) Makulerade på eller före D, med `updated_at` som makuleringsdag (ingen skrivare rör en makulerad order). **Filtrera aldrig på nuvarande status `cancelled`**: en TO som var öppen på D skulle försvinna bakåt och ett bokfört steg bli Inaktuell. Makulering kräver att uttag och inleveranser är ångrade, så nettona per dag är redan 0 efter ångrandet. Tidrapporter överlever däremot en makulering (0/0-utstämpling, manuell tid), därför behövs gränsen på makuleringsdagen. En rad med upparbetat 0 och avräknat 0 visas inte.
- **EN ögonblicksbild:** alla DB-läsningar (`readSources`: PIA-repots läsare och kalkylrepots `getComponentCostBasis`/`getArticleLabels`/`getPriceHistories`) körs i en `repeatable read`, `read only`-transaktion (`getPlan`s mönster), i följd. En rapport som committar mitt i blir då aldrig halvt läst, och bokslutet bokför det som rapporten svarar. Kurserna (`createRateAttacher`, kan göra HTTP) hämtas **efter** transaktionen. Repona byggs på exekveraren (`createWorkInProgressRepository(ex)`, `createCostingRepository(db: Db | Tx)`).
- **Avräknat** till lagerpriset (`unit_cost` på `mo_receipt`, även konfigurerad TO:s TVK/st): en ångrad inleverans tar tillbaka från den senaste tidigare inleveransen som har kvar (FIFO:s närmevärde). Ett okänt pris kvar i lagren, eller en ångring utan motsvarighet, gör raden ovärderad (`value: null`, `unvaluedCount`, utanför summan). PIA = max(0, upparbetat − avräknat) med `capped`.
- **Avrundning:** `round2` per kolumn, upparbetat = summan av de avrundade kolumnerna, summorna = summan av raderna, `totals.relieved` bara över kända. Sortering på TO-nummer med `numeric: true`.
- `GET /costing/work-in-progress` och `…/pdf` bara admin (`requireRole`, som `/stock/valuation`), `asOf` utelämnat = Stockholms i dag. PDF:en sätter `landscape: true` (flaggan i `FinancialStatementPdfInput`; tre kolumner blir annars stående).
- **Ingen HTTP i en transaktion:** källan `supplier` kan anropa `getRate`, så bokslutssteget läser PIA före sin transaktion.
- **Accepterade avvikelser från efterkalkylen:**
  - staffeln matchas på nettot per (TO, artikel), inte per materialrad;
  - med `actual` faller ett saknat glidande snitt tillbaka på artikelns **nuvarande** standardpris, som i efterkalkylen;
  - legoinleveranser från före inleveransloggen (0118) har inga `purchase_receipts`-rader och räknas som 0;
  - ett lagerfört halvfabrikat får MO under Tillverkningskostnad, som i efterkalkylen.
- Tester: `work-in-progress.test.ts` (rent), `work-in-progress.db.test.ts` (källorna per D, klar före/efter D, delinleverans, ångrad tidigare inleverans som öppnar ordern igen, kortstängd före 0117, makulerad TO före/efter makuleringsdagen, konfigurerad TO, inleverans utan pris, `standard`/`actual`, sortering, PDF, rutterna 403/400), `costing-price-at.test.ts` (`pricedAtWithdrawal`).

## Avvikelseanalys i efterkalkylen (#14, migration 0187)

Spec `private/superpowers/specs/2026-11-06-avvikelseanalys-efterkalkyl-design.md` (beslut: Ändrad TO = ny plan, ställ/produktion i tiden = etapp 3, timkostnad per datum = etapp 4).

- **Basen = TO:ns egna, aktuella rader** för N, prissatta med **förkalkylens** regler vid **T₀ = TO:ns `created_at`**: `pricedAtWithdrawal(rader, new Map(), historik, T₀)`, `createRateAttacher` med T₀:s Stockholmsdag och `buildMaterialRow` med staffeln på **planerat** antal. Historiken laddas en gång för båda sidorna. En konfigurerad TO:s rader är dess konfiguration — `configuration.cost` används aldrig som bas. Reservpriser varnar med prefixet `Kalkylerat:`. **Efterkalkylens egna belopp rörs inte.**
- **N och ställregeln** bor i rena `cost-variance.ts`. Klar/Stängd ⇒ N = inlevererat för allt. Annars `preliminary`: en operations tid, lego och kopplade material räknas på operationens OK, okopplat material på inlevererat. Ställtiden och legots engångskostnad (`legoOneOffSql`) räknas när operationen arbetats (tid, antal eller legoinleverans) eller när ordern är klar med N > 0, annars sparas 0. K (kassationen bakom varav kassation) = den egna operationens kasserat, plus senare operationers på en klar order.
- **Sparat:** basens indata — huvudets `output_quantity`/`preliminary`/`base_priced_at`/`base_material_source` och radernas `base_*`, `scrap_quantity`, `subcontract_quantity` och `run_hours`. CHECK: huvudets fyra alla eller inga och bara på `post` (aldrig `actual`), varje radgrupp alla eller inga.
- **Härlett:** delarna lagras aldrig. `costVarianceAnalysis` räknar dem vid varje läsning: GET `/cost-calculations/:id`, post-calculate och (etapp 2) Kalkylutfall. `analysis: null` = förkalkyl eller efterkalkyl sparad före 0187. Ingen backfill, eftersom basen inte går att återskapa som den var. En sparad analys ändras aldrig: priser och efterrapporter efteråt läses inte.
- **Exakt summa:** allt räknas i hela ören (heltal).
  - Per rad avrundas Kalkylerat och Utfall till öre och Pris/Timpris med `round2`. Mängd, Stycke eller Ej uppdelad tar resten.
  - Påslaget (MO + LO med efterkalkylens procent på båda sidor, aldrig TO) avrundas en gång per sida på orderns summor.
  - Orderns delar = radernas summa. `scrap` är *varav* av Mängd och summeras inte. Utfall kan skilja några öre från TVK.
- **Förhandsvisning = sparat:** förhandsvisningen läser de beräknade raderna genom `roundAsNumeric` (Postgres avrundning av `String(värde)` till kolumnens skala). Sparandet svarar med analysen läst ur de lagrade raderna. En ny kolumn i analysen behöver sin skala i `draftVarianceAnalysis`. `base_setup_hours`/`base_run_hours` har 8 decimaler (minuter ÷ 60): med 4 räknades 4 min à 300 kr/h till 20,01.
- **Etapp 1:** tiden är ej uppdelad (`setup_hours`/`run_hours` null på efterkalkylen ⇒ U = H ⇒ Tid (ej uppdelad)). En operation helt utan tid delas i Ställ/Stycke. `base_hourly_rate` = `hourly_rate`, så Timpris = 0.
- **Känd egenhet:** efterkalkylens lego-reserv (ingen IO-inleverans) tar engångskostnaden även med OK 0. På en oarbetad legooperation (preliminär, eller N = 0) syns det som Pris.
- **Tester:**
  - `costing-variance.test.ts` (rent);
  - blocket *variance analysis* i `costing.service.test.ts` (T₀ med bakdaterad historik, valuta på T₀:s dag, kortstängd med kassation, preliminär + tillagd rad, sparad oförändrad, `null` och CHECK);
  - lego i `legoresurser.test.ts`;
  - konfigurerad TO i `configured-manufacturing.test.ts`.

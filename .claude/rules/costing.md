---
paths:
  - "apps/api/src/modules/costing/**"
  - "apps/web/components/costing/**"
  - "apps/web/components/system/CostingSettingsForm.tsx"
  - "apps/api/test/costing*"
  - "apps/api/test/prishistorik*"
---

# Kalkyl: materialkällor, valuta och efterkalkylen vid uttaget

Spec `private/superpowers/specs/2026-10-29-prishistorik-och-efterkalkyl-design.md` (prishistorik, migration 0169); valutan i kalkylen: `currency.md`.

- **Två materialkällor** (System → Kalkyler): `costing_material_source` = **förkalkylens** (`standard`|`supplier`, `costingPreMaterialSourceSchema`; nyckeln heter som före delningen) och `costing_post_material_source` = **efterkalkylens** (`standard`|`supplier`|`actual`). 0169 kopierade det gemensamma värdet till efterkalkylen och gjorde förkalkylens `actual` till `standard`. Konfiguratorns `previewStructure` följer förkalkylens. `CostingSettingsReader.costingPostMaterialSource` är valfri — saknas den (teststubbar) gäller förkalkylens, som före delningen; `preCalculationSource` finns kvar som försvar mot en stubb med `actual`.
- **Efterkalkylen prissätter vid uttaget** (`pricedAtWithdrawal` i `costing.service.ts`): med `standard`/`supplier` läses varje komponents standardkostnad (D1-historiken) och huvudleverantörens katalograd (`article_supplier_price_history`) per **T = senaste uttaget** (`getLatestConsumptionTimes`: max `created_at` för `mo_consumption` med negativ delta på ordern; aldrig uttagen ⇒ nu), och kursen per Stockholmsdagen av T (`priceDate` på basen ⇒ `createRateAttacher` slår upp per valuta **och dag**). Raden får `price_date`. `actual` rörs inte (viktad per uttag i `actual-cost.ts`, inleveransens `unit_cost` bär redan IO:ns kurs).
- **Pris vid T** i rena `price-at.ts`: senaste raden ≤ T, före första raden den **första** (D1:s konvention i `valuation.service.ts`); huvudleverantören = varje leverantörs tillstånd vid T, den som var `is_primary` och inte `removed`. Ingen standardhistorik alls ⇒ artikelns nuvarande värde.
- **Verklig kostnad spelar upp på värderingsdatumet** (#26, `stockValuedAt` i `getConsumptionMovingAverageCosts`). En inventering registrerad per underlagets datum väger in vid sin frysning, alltså före ett uttag som registrerats mellan frysningen och registreringen. `getLatestConsumptionTimes` (T för pris vid uttaget) är fortfarande `created_at`, eftersom ett uttag aldrig bakdateras.
- **Varför senaste uttaget, inte viktat:** raden ska visa ett pris och en kurs; den exakta vägen är Verklig kostnad.
- Specifikationsraden visar valuta/kurs och `uttag <dag>` under Priskälla (`PriceSourceCell`, även på fallback-raden).
- **Kalkylrader** (`bom_components.costing_only`, 0178): förkalkylen (`repo.explodeBom` = `explodeBom(..., "include")`, även flernivå och konfiguratorns `previewStructure`, som aldrig filtrerar `components`) prissätter dem som vilken rad som helst; `ExplodedComponent.costingOnly` följer med men lagras inte på specifikationsraden. Efterkalkylen behöver inget — den prissätter TO:ns materialrader, och frisläppet skapade aldrig någon för en kalkylrad. Test: blocket *Kalkyl structure rows* i `costing.service.test.ts`.
- Tester: `costing-price-at.test.ts` (rent), blocket *priced at the withdrawal* i `costing.service.test.ts` (backdaterar `stock_transactions.created_at` och historikens `valid_from` med SQL), `system.service.test.ts` (inställningarna), `prishistorik.test.ts` (triggerna).

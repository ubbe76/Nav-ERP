// apps/api/test/helpers/configured-manufacturing.ts
import { sql } from "drizzle-orm";
import { db } from "@navet/db";
import { createManufacturingRepository } from "../../src/modules/manufacturing/repository/manufacturing.repository.js";
import { createManufacturingService } from "../../src/modules/manufacturing/service/manufacturing.service.js";
import { markSalesOrderInProduction } from "../../src/modules/sales/service/production-transition.js";
import { buildToOrder, configurator, makeCustomer, salesRepository, salesService } from "./configured-rows.js";
import { testCostingSettings } from "./configurator.js";
import { testArticleService, testDocumentPdfService } from "./services.js";

// Konfigurator 4c: a to_order template WITH structure — shared by the 4c
// suites (derivation, TO creation, planning, sales cost). A helper, not a
// test file.
//
// Structure (per unit), hand-costed at quantity 1, standard cost, markups 0:
//   base BOM   SKRUV  8 st × 2 kr                          =  16
//   base op 10 wc 610 (600 kr/h) setup 6 min, run 3 min    = (6+3)/60 × 600 = 90
//   line       PLAT  BREDD/1000 st × 10 kr, linked to op 10 (BREDD 1200 ⇒ 1,2 st) = 12
//   line       AVL   1 st × 40 kr when AVLOPP selected
//   line       FANT  1 st (phantom: F1 2 st × 3 kr, F2 1 st × 4 kr) = 10
//   cond op 20 wc 620 (300 kr/h) setup 0, run 4 min when LOCK = B = 4/60 × 300 = 20
//   costing-only op 30 on the template's route (never on a TO)
// LOCK B, BREDD 1200, AVLOPP Ja ⇒ 16 + 90 + 12 + 40 + 10 + 20 + op 30's cost.
// Op 30 (wc 630, 120 kr/h, setup 0, run 5) is priced into the pre-calculation
// (costingOnly is a costing row) = 10 ⇒ TVK/st 198.
let seq = 0;
const part = (name: string, extra: Record<string, unknown> = {}) =>
  testArticleService.createArticle({
    articleNumber: `M-${(seq += 1)}-${crypto.randomUUID().slice(0, 6)}`, name, type: "purchased", unit: "st", ...extra,
  } as never);

// The manufacturing service exactly as app.ts wires it for 4c: the sales
// row reader + row lock, no audit, and the configurator's derivation as the
// ConfiguredStructureReader. One service for fixtures and assertions alike.
const mfgRepository = createManufacturingRepository(db);
export const mfg = createManufacturingService(
  mfgRepository,
  testDocumentPdfService,
  testArticleService,
  {
    findRowForManufacturing: salesRepository.findRowForManufacturing,
    lockRowForManufacturing: salesRepository.lockRowForManufacturing,
    markInProduction: markSalesOrderInProduction,
  },
  undefined,
  (t, s, q, o) => configurator.deriveForManufacturing(t, s, q, o)
);
export const mfgForFixtures = mfg;
// Resources have fixed codes so the hand-costing above holds; a test that
// builds the structure twice (two templates) shares them.
const workCenter = async (code: string, hourlyRate: number) =>
  (await mfgRepository.findWorkCenterByCode(code)) ??
  mfgForFixtures.createWorkCenter({ code, name: `Resurs ${code}`, type: "machine", hourlyRate, overheadPercent: 0, capacityFactor: 1, active: true });

export const CONFIGURED_MFG_TRUNCATE = sql`TRUNCATE work_centers, routing_operations, cost_calculations, mo_material_consumptions, mo_operations CASCADE`;

export async function resetCostingSettings() {
  Object.assign(testCostingSettings, {
    costingMaterialSource: "standard", costingMoPercent: 0, costingLoPercent: 0, costingAffoPercent: 0, costingGeneralMarkupPercent: 0,
  });
}

export async function buildToOrderWithStructure() {
  const base = await buildToOrder();
  const { article, lock, b, avlopp } = base;
  const skruv = await part("Skruv", { standardCost: 2 });
  const plat = await part("Plåt", { standardCost: 10 });
  const avl = await part("Avlopp", { standardCost: 40 });
  const f1 = await part("Del 1", { standardCost: 3 });
  const f2 = await part("Del 2", { standardCost: 4 });
  const fant = await part("Fantom", { type: "manufactured", isPhantom: true });
  await testArticleService.addBomComponent(fant.id, { componentArticleId: f1.id, quantity: 2 });
  await testArticleService.addBomComponent(fant.id, { componentArticleId: f2.id, quantity: 1 });

  await testArticleService.addBomComponent(article.id, { componentArticleId: skruv.id, quantity: 8 });
  const wc10 = await workCenter("610", 600);
  const wc20 = await workCenter("620", 300);
  const wc30 = await workCenter("630", 120);
  const op10 = await mfgForFixtures.createRoutingOperation(article.id, {
    sequenceNo: 10, workCenterId: wc10.id, setupTime: 6, runTimePerUnit: 3, description: "Kapa", comment: "Mät två gånger", printOnWorkCard: true,
  });
  await mfgForFixtures.createRoutingOperation(article.id, { sequenceNo: 30, workCenterId: wc30.id, setupTime: 0, runTimePerUnit: 5, costingOnly: true });

  // Condition shapes as configuratorConditionSchema has them: a choice group
  // is `is` + valueIds, a boolean group is `selected`.
  await configurator.createBomLine(article.id, {
    conditions: [], source: "article", componentArticleId: plat.id, quantityFormula: "BREDD / 1000", routingOperationId: op10.id,
  } as never);
  await configurator.createBomLine(article.id, {
    conditions: [{ groupId: avlopp.id, op: "selected" }], source: "article", componentArticleId: avl.id, quantity: 1,
  } as never);
  await configurator.createBomLine(article.id, { conditions: [], source: "article", componentArticleId: fant.id, quantity: 1 } as never);
  const op20 = await configurator.createOperation(article.id, {
    conditions: [{ groupId: lock.id, op: "is", valueIds: [b.id] }], sequenceNo: 20, workCenterId: wc20.id, description: "Montera lås B", setupTime: 0, runTimePerUnit: 4,
  } as never);
  return { ...base, op10, op20, wc10, wc20, wc30, parts: { skruv, plat, avl, fant, f1, f2 } };
}

export const FULL = { LOCK: "B", BREDD: 1200, AVLOPP: true } as const;

// A confirmed KO with one configured row on the structured template —
// the row Skapa TO is run from.
export async function confirmedRow(quantity = 1, selection: Record<string, unknown> = FULL) {
  const s = await buildToOrderWithStructure();
  const c = await makeCustomer();
  const { order, rows } = await salesService.createQuote(
    { customerId: c.id, confirm: true, rows: [{ articleId: s.article.id, quantity, configuration: { selection } }] } as never,
    null
  );
  return { s, order, row: rows[0]! };
}

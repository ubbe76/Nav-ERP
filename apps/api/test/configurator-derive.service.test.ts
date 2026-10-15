import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@navet/db";
import { sql } from "drizzle-orm";
import { createConfiguratorService } from "../src/modules/configurator/service/configurator.service.js";
import { InvalidConfiguratorOperationError } from "../src/modules/configurator/service/configurator.errors.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import { createManufacturingService } from "../src/modules/manufacturing/service/manufacturing.service.js";
import { makeArticle, resetConfigurator, testCostingService, testCostingSettings, variantTestDeps } from "./helpers/configurator.js";
import { testArticleService, testDocumentPdfService } from "./helpers/services.js";

// Delprojekt 2, Task 5: derive = evaluate → deriveStructure → enrichment →
// the Kalkyl tab's multi-level pre-costing of exactly the derived structure.

const service = createConfiguratorService({
  db,
  prices: async () => ({ articleNumber: "X", price: null }),
  customerExists: async () => true,
  articles: {
    exists: async (id) => (await testArticleService.getArticle(id)) != null,
    isDescendant: (articleId, ancestorId) => testArticleService.isDescendant(articleId, ancestorId),
    find: (id) => testArticleService.getArticle(id),
  },
  costing: testCostingService,
  ...variantTestDeps,
});
const mfgService = createManufacturingService(createManufacturingRepository(db), testDocumentPdfService, testArticleService);

async function reset() {
  await resetConfigurator();
  await db.execute(sql`TRUNCATE work_centers, routing_operations, cost_calculations CASCADE`);
  Object.assign(testCostingSettings, {
    costingMaterialSource: "standard", costingMoPercent: 0, costingLoPercent: 0, costingAffoPercent: 0, costingGeneralMarkupPercent: 0,
  });
}
beforeEach(reset);
afterAll(reset);

let seq = 0;
const part = (name: string, extra: Record<string, unknown> = {}) =>
  testArticleService.createArticle({
    articleNumber: `D-${(seq += 1)}-${crypto.randomUUID().slice(0, 6)}`, name, type: "purchased", unit: "st", ...extra,
  } as never);
const workCenter = (code: string, hourlyRate: number, overheadPercent = 0, type: "machine" | "subcontract" = "machine") =>
  mfgService.createWorkCenter({ code, name: `Resurs ${code}`, type, hourlyRate, overheadPercent, capacityFactor: 1, active: true });

// Hand-calculated at quantity 10 (markups 0, material at standard cost):
//   SKRUV  base         8/unit  → 80 × 2           =  160
//   PLAT   plain line   2/unit  → 20 × 10          =  200
//   HJUL   cond. line   4/unit  → 40 × 25          = 1000   (HJUL selected)
//   LASA   from choice  1/unit  → 10 × 30          =  300   (LOCK = A)
//   FANT   phantom 3/unit → F1 6/unit (×3) + F2 3/unit (×4) → 60×3 = 180, 30×4 = 120
//   HALV   semi 2/unit  → 20 units: material 20 × 50 = 1000 + (60 + 6×20)/60 h × 100 = 300 → 1300
//   operation 10 (base, 600 kr/h): (5 + 1×10)/60 × 600 = 150
//   operation 40 (conditional, 300 kr/h, run BREDD/1000 = 1,5 min): (0 + 1,5×10)/60 × 300 = 75
async function build() {
  const article = await makeArticle({ salesPrice: 1000 });
  await service.createTemplate(article.id, { mode: "variants" });
  const lock = await service.createGroup(article.id, { code: "LOCK", name: "Lås", kind: "choice", required: true });
  const lasa = await part("Lås A", { standardCost: 30 });
  const a = await service.createValue(article.id, lock.id, { code: "A", name: "A", priceAdd: 0, active: true, articleId: lasa.id });
  await service.createValue(article.id, lock.id, { code: "B", name: "B", priceAdd: 0, active: true });
  const bredd = await service.createGroup(article.id, {
    code: "BREDD", name: "Bredd", kind: "number", required: true, unit: "mm", minValue: 100, maxValue: 2000, step: null,
    defaultNumber: null, pricePerUnit: 0, priceBaseValue: 0,
  });
  const hjul = await service.createGroup(article.id, { code: "HJUL", name: "Hjul", kind: "boolean", priceAdd: 0 });

  const skruv = await part("Skruv", { standardCost: 2 });
  const plat = await part("Plåt", { standardCost: 10 });
  const hjulArt = await part("Hjul", { standardCost: 25 });
  const f1 = await part("Del 1", { standardCost: 3 });
  const f2 = await part("Del 2", { standardCost: 4 });
  const fant = await part("Fantom", { type: "manufactured", isPhantom: true });
  await testArticleService.addBomComponent(fant.id, { componentArticleId: f1.id, quantity: 2 });
  await testArticleService.addBomComponent(fant.id, { componentArticleId: f2.id, quantity: 1 });
  const ra = await part("Råmaterial", { standardCost: 50 });
  const halv = await part("Underrede", { type: "manufactured", standardCost: 999 });
  await testArticleService.addBomComponent(halv.id, { componentArticleId: ra.id, quantity: 1 });
  const wcHalv = await workCenter("201", 100);
  await mfgService.createRoutingOperation(halv.id, { sequenceNo: 10, workCenterId: wcHalv.id, setupTime: 60, runTimePerUnit: 6 });

  await testArticleService.addBomComponent(article.id, { componentArticleId: skruv.id, quantity: 8 });
  const wcA = await workCenter("202", 600);
  const wcB = await workCenter("203", 300);
  const op10 = await mfgService.createRoutingOperation(article.id, { sequenceNo: 10, workCenterId: wcA.id, setupTime: 5, runTimePerUnit: 1 });

  await service.createBomLine(article.id, { conditions: [], source: "article", componentArticleId: plat.id, quantity: 2 });
  await service.createBomLine(article.id, { conditions: [{ groupId: hjul.id, op: "selected" }], source: "article", componentArticleId: hjulArt.id, quantity: 4 });
  await service.createBomLine(article.id, { conditions: [], source: "group", componentGroupId: lock.id, quantity: 1 });
  await service.createBomLine(article.id, { conditions: [], source: "article", componentArticleId: fant.id, quantity: 3 });
  await service.createBomLine(article.id, { conditions: [], source: "article", componentArticleId: halv.id, quantity: 2 });
  const op40 = await service.createOperation(article.id, {
    conditions: [{ groupId: hjul.id, op: "selected" }], sequenceNo: 40, workCenterId: wcB.id, description: "Montera hjul", setupTime: 0, runFormula: "BREDD / 1000",
  });
  return { article, lock, a, bredd, hjul, wcA, wcB, wcHalv, op10, op40, parts: { skruv, plat, hjulArt, lasa, f1, f2, ra, halv, fant } };
}

describe("configurator derive — structure and pre-costing", () => {
  it("costs exactly the derived structure: phantom dissolved, halvfabrikat multi-level, conditional operation timed by formula", async () => {
    const s = await build();
    const r = await service.derive(s.article.id, { selection: { LOCK: "A", BREDD: 1500, HJUL: true }, quantity: 10 });
    expect(r.evaluation.valid).toBe(true);
    expect(r.structure.derivable).toBe(true);
    expect(r.structure.errors).toEqual([]);
    // enrichment
    const skruv = r.structure.materials.find((m) => m.componentArticleId === s.parts.skruv.id)!;
    expect(skruv).toMatchObject({ source: "base", articleNumber: s.parts.skruv.articleNumber, articleName: "Skruv" });
    expect(r.structure.operations.map((o) => [o.sequenceNo, o.kind, o.workCenterCode, o.workCenterName, o.costingOnly])).toEqual([
      [10, "base", "202", "Resurs 202", false], [40, "configurator", "203", "Resurs 203", false],
    ]);

    const c = r.costing!;
    expect(c).not.toBeNull();
    const byNumber = Object.fromEntries(c.materialRows.map((m) => [m.articleNumber, m.total]));
    expect(byNumber).toEqual({
      [s.parts.skruv.articleNumber]: 160,
      [s.parts.plat.articleNumber]: 200,
      [s.parts.hjulArt.articleNumber]: 1000,
      [s.parts.lasa.articleNumber]: 300,
      [s.parts.f1.articleNumber]: 180,
      [s.parts.f2.articleNumber]: 120,
      [s.parts.halv.articleNumber]: 1300,
    });
    expect(c.materialRows.some((m) => m.articleNumber === s.parts.fant.articleNumber)).toBe(false);
    expect(c.operationRows.map((o) => [o.sequenceNo, o.workCenterName, o.total])).toEqual([[10, "Resurs 202", 150], [40, "Resurs 203", 75]]);
    expect(c.quantity).toBe(10);
    expect(c.materialCost).toBe(3260);
    expect(c.operationCost).toBe(225);
    expect(c.markups).toBe(0);
    expect(c.manufacturingCost).toBe(3485);
    expect(c.manufacturingCostPerUnit).toBeCloseTo(348.5, 6);
  });

  it("the same article on lines linked to different operations: separate derived rows, costing merged per (article, operation)", async () => {
    const s = await build();
    const bult = await part("Bult", { standardCost: 1.5 });
    const l1 = await service.createBomLine(s.article.id, { conditions: [], source: "article", componentArticleId: bult.id, quantity: 1, routingOperationId: s.op10.id });
    const l2 = await service.createBomLine(s.article.id, {
      conditions: [{ groupId: s.hjul.id, op: "selected" }], source: "article", componentArticleId: bult.id, quantity: 2, configuratorOperationId: s.op40.id,
    });
    const l3 = await service.createBomLine(s.article.id, { conditions: [], source: "article", componentArticleId: bult.id, quantity: 3, routingOperationId: s.op10.id });
    const r = await service.derive(s.article.id, { selection: { LOCK: "A", BREDD: 1500, HJUL: true }, quantity: 10 });
    expect(r.structure.derivable).toBe(true);
    expect(r.structure.materials.filter((m) => m.componentArticleId === bult.id).map((m) => [m.lineId, m.quantity, m.operation?.sequenceNo])).toEqual([
      [l1.id, 1, 10], [l2.id, 2, 40], [l3.id, 3, 10],
    ]);
    // Two costing rows: (bult, op 10) = (1 + 3) × 10 = 40 units, (bult, op 40) = 2 × 10 = 20 units.
    const rows = r.costing!.materialRows.filter((m) => m.articleNumber === bult.articleNumber);
    expect(rows.map((m) => [m.quantity, m.total]).sort((a, b) => a[0]! - b[0]!)).toEqual([[20, 30], [40, 60]]);
  });

  it("drops the conditional rows when their conditions fail and applies the System → Kalkyler markups", async () => {
    const s = await build();
    testCostingSettings.costingMoPercent = 10;
    const r = await service.derive(s.article.id, { selection: { LOCK: "A", BREDD: 1500 }, quantity: 10 });
    const c = r.costing!;
    expect(c.materialRows.some((m) => m.articleNumber === s.parts.hjulArt.articleNumber)).toBe(false);
    expect(c.operationRows.map((o) => o.sequenceNo)).toEqual([10]);
    // MO 10 % on the plain material (160 + 200 + 300 + 180 + 120 = 960). The halvfabrikat row is its own level's TVK
    // (1000 material + 10 % MO + 300 labour = 1400) and carries no markup at this level.
    expect(c.markups).toBeCloseTo(96, 6);
    expect(c.materialRows.find((m) => m.articleNumber === s.parts.halv.articleNumber)!.total).toBeCloseTo(1400, 6);
    expect(c.manufacturingCost).toBeCloseTo(960 + 1400 + 150 + 96, 6);
  });

  it("the costing carries SVK: manufacturing cost plus Affo, per unit", async () => {
    const s = await build();
    Object.assign(testCostingSettings, { costingAffoPercent: 10 });
    const r = await service.derive(s.article.id, { selection: { LOCK: "A", BREDD: 1500, HJUL: true }, quantity: 10 });
    expect(r.costing!.selfCost).toBeCloseTo(r.costing!.manufacturingCost * 1.1, 6);
    expect(r.costing!.selfCostPerUnit).toBeCloseTo(r.costing!.selfCost / 10, 6);
  });

  it("an invalid configuration gives derivable false and costing null", async () => {
    const s = await build();
    const r = await service.derive(s.article.id, { selection: { LOCK: "A", BREDD: 5000 }, quantity: 10 });
    expect(r.evaluation.valid).toBe(false);
    expect(r.structure).toMatchObject({ derivable: false, materials: [], operations: [] });
    expect(r.costing).toBeNull();
  });

  it("a derivation error (alternative without article) also gives costing null", async () => {
    const s = await build();
    const r = await service.derive(s.article.id, { selection: { LOCK: "B", BREDD: 1500 }, quantity: 10 });
    expect(r.structure.derivable).toBe(false);
    expect(r.structure.errors[0]).toContain("saknar artikel");
    expect(r.costing).toBeNull();
  });

  it("costing-only base operations are included, flagged and costed", async () => {
    const s = await build();
    await mfgService.createRoutingOperation(s.article.id, { sequenceNo: 20, workCenterId: s.wcB.id, setupTime: 0, runTimePerUnit: 6, costingOnly: true });
    const r = await service.derive(s.article.id, { selection: { LOCK: "A", BREDD: 1500 }, quantity: 10 });
    expect(r.structure.operations.map((o) => [o.sequenceNo, o.costingOnly])).toEqual([[10, false], [20, true]]);
    expect(r.costing!.operationRows.map((o) => [o.sequenceNo, o.total])).toEqual([[10, 150], [20, 300]]);
  });

  it("a routing operation added later with a conditional operation's number makes the derivation fail with an error", async () => {
    const s = await build();
    const sel = { LOCK: "A", BREDD: 1500, HJUL: true };
    expect((await service.derive(s.article.id, { selection: sel, quantity: 10 })).structure.derivable).toBe(true);
    // The write path of Beredning does not know the configurator's operation numbers.
    await mfgService.createRoutingOperation(s.article.id, { sequenceNo: 40, workCenterId: s.wcA.id, setupTime: 1, runTimePerUnit: 1 });
    const r = await service.derive(s.article.id, { selection: sel, quantity: 10 });
    expect(r.structure.derivable).toBe(false);
    expect(r.structure.errors).toContain("Operationsnummer 40 finns både i rutten och bland konfiguratorns operationer");
    expect(r.costing).toBeNull();
    // Where the condition does not hold the clash is not in the route.
    expect((await service.derive(s.article.id, { selection: { LOCK: "A", BREDD: 1500 }, quantity: 10 })).structure.derivable).toBe(true);
  });
});

describe("template Kalkyl is untouched by conditional rows", () => {
  it("the existing pre-calculation of the template article is identical before and after lines and operations are added", async () => {
    const article = await makeArticle({ salesPrice: 1000 });
    const skruv = await part("Skruv", { standardCost: 2 });
    const wc = await workCenter("210", 600, 20);
    await testArticleService.addBomComponent(article.id, { componentArticleId: skruv.id, quantity: 8 });
    await mfgService.createRoutingOperation(article.id, { sequenceNo: 10, workCenterId: wc.id, setupTime: 5, runTimePerUnit: 1 });
    await service.createTemplate(article.id, { mode: "variants" });
    const before = await testCostingService.preCalculate(article.id, 10, false, true);

    const hjul = await service.createGroup(article.id, { code: "HJUL", name: "Hjul", kind: "boolean", priceAdd: 0 });
    const plat = await part("Plåt", { standardCost: 10 });
    await service.createBomLine(article.id, { conditions: [{ groupId: hjul.id, op: "selected" }], source: "article", componentArticleId: plat.id, quantity: 5 });
    await service.createOperation(article.id, { conditions: [], sequenceNo: 30, workCenterId: wc.id, setupTime: 10, runTimePerUnit: 3 });

    const after = await testCostingService.preCalculate(article.id, 10, false, true);
    expect(after).toEqual(before);
    expect(Number(after.calculation.materialCost)).toBe(160);
  });
});

describe("operation resource check", () => {
  it("the resource must be active on create and when it changes, but a description edit of an operation whose resource went inactive succeeds", async () => {
    const s = await build();
    const old = await workCenter("220", 100);
    const op = await service.createOperation(s.article.id, { conditions: [], sequenceNo: 60, workCenterId: old.id, setupTime: 1, runTimePerUnit: 1 });
    await mfgService.updateWorkCenter(old.id, { active: false });

    const edited = await service.updateOperation(s.article.id, op.id, { description: "Ny text", setupTime: 2 });
    expect(edited).toMatchObject({ description: "Ny text", setupTime: "2.00", workCenterId: old.id });
    await expect(service.createOperation(s.article.id, { conditions: [], sequenceNo: 61, workCenterId: old.id, setupTime: 1, runTimePerUnit: 1 }))
      .rejects.toBeInstanceOf(InvalidConfiguratorOperationError);
    await expect(service.updateOperation(s.article.id, s.op40.id, { workCenterId: old.id })).rejects.toBeInstanceOf(InvalidConfiguratorOperationError);
    // Moving it to the inactive resource is refused; keeping the same resource is not a change.
    expect((await service.updateOperation(s.article.id, op.id, { workCenterId: old.id })).workCenterId).toBe(old.id);
  });
});

describe("lego operations and parity with the Kalkyl tab", () => {
  it("without conditional rows the derive preview equals the existing multi-level pre-calculation (phantom, halvfabrikat, lego, merged rows, markups)", async () => {
    testCostingSettings.costingMoPercent = 10;
    testCostingSettings.costingLoPercent = 5;
    testCostingSettings.costingAffoPercent = 8;
    const article = await makeArticle({ salesPrice: 1000 });
    await service.createTemplate(article.id, { mode: "variants" });
    const skruv = await part("Skruv", { standardCost: 2 });
    const f1 = await part("Del 1", { standardCost: 3 });
    const fant = await part("Fantom", { type: "manufactured", isPhantom: true });
    await testArticleService.addBomComponent(fant.id, { componentArticleId: f1.id, quantity: 2 });
    await testArticleService.addBomComponent(fant.id, { componentArticleId: skruv.id, quantity: 1 });
    const ra = await part("Råmaterial", { standardCost: 50 });
    const halv = await part("Underrede", { type: "manufactured", standardCost: 999 });
    await testArticleService.addBomComponent(halv.id, { componentArticleId: ra.id, quantity: 1 });
    const wcH = await workCenter("231", 100, 25);
    await mfgService.createRoutingOperation(halv.id, { sequenceNo: 10, workCenterId: wcH.id, setupTime: 60, runTimePerUnit: 6 });

    await testArticleService.addBomComponent(article.id, { componentArticleId: skruv.id, quantity: 8 });
    await testArticleService.addBomComponent(article.id, { componentArticleId: fant.id, quantity: 3 });
    await testArticleService.addBomComponent(article.id, { componentArticleId: halv.id, quantity: 2 });
    const wcA = await workCenter("232", 600, 20);
    const wcL = await workCenter("233", 0, 0, "subcontract");
    await mfgService.createRoutingOperation(article.id, { sequenceNo: 10, workCenterId: wcA.id, setupTime: 5, runTimePerUnit: 1 });
    await mfgService.createRoutingOperation(article.id, { sequenceNo: 20, workCenterId: wcL.id, setupTime: 0, runTimePerUnit: 0, setupPrice: 100, unitPrice: 5.5 });

    const kalkyl = (await testCostingService.preCalculate(article.id, 10, false, true)).calculation;
    const r = await service.derive(article.id, { selection: {}, quantity: 10 });
    expect(r.structure.derivable).toBe(true);
    const c = r.costing!;
    // Lego: 100 + 5,5 × 10 = 155 bought, LO 5 %.
    expect(c.operationRows.find((o) => o.sequenceNo === 20)!.total).toBeCloseTo(155, 6);
    const tvk = ["materialCost", "materialOverhead", "laborCost", "overhead", "subcontractCost", "subcontractOverhead", "semiFinishedCost"]
      .reduce((t, k) => t + Number((kalkyl as unknown as Record<string, string>)[k]), 0);
    expect(c.manufacturingCost).toBeCloseTo(tvk, 3);
    expect(c.manufacturingCostPerUnit).toBeCloseTo(tvk / 10, 3);
    expect(c.warnings).toEqual((await testCostingService.preCalculate(article.id, 10, false, true)).warnings);
  });

  it("a conditional lego operation is priced from its own prices", async () => {
    const s = await build();
    const wcL = await workCenter("234", 0, 0, "subcontract");
    const op = await service.createOperation(s.article.id, {
      conditions: [{ groupId: s.hjul.id, op: "selected" }], sequenceNo: 50, workCenterId: wcL.id, setupTime: 0, runTimePerUnit: 0, setupPrice: 40, unitPrice: 2.25,
    });
    expect(op).toMatchObject({ setupPrice: "40.00", unitPrice: "2.2500" });
    const withLego = await service.derive(s.article.id, { selection: { LOCK: "A", BREDD: 1500, HJUL: true }, quantity: 10 });
    expect(withLego.structure.operations.find((o) => o.sequenceNo === 50)).toMatchObject({ setupPrice: 40, unitPrice: 2.25 });
    // 40 + 2,25 × 10 = 62,50 on top of the 3485 of the plain case.
    expect(withLego.costing!.operationRows.find((o) => o.sequenceNo === 50)!.total).toBeCloseTo(62.5, 6);
    expect(withLego.costing!.manufacturingCost).toBeCloseTo(3485 + 62.5, 6);
    const cleared = await service.updateOperation(s.article.id, op.id, { setupPrice: null, unitPrice: null });
    expect(cleared).toMatchObject({ setupPrice: null, unitPrice: null });
  });

  it("refuses lego prices on a non-lego resource, on create and on update", async () => {
    const s = await build();
    const wcM = await workCenter("235", 100);
    const create = await service
      .createOperation(s.article.id, { conditions: [], sequenceNo: 60, workCenterId: wcM.id, setupTime: 0, runTimePerUnit: 0, unitPrice: 3 })
      .catch((e: unknown) => e);
    expect(create).toBeInstanceOf(InvalidConfiguratorOperationError);
    expect((create as Error).message).toBe("Ställpris och styckpris kräver en legoresurs");

    const op = await service.createOperation(s.article.id, { conditions: [], sequenceNo: 60, workCenterId: wcM.id, setupTime: 0, runTimePerUnit: 0 });
    const update = await service.updateOperation(s.article.id, op.id, { setupPrice: 10 }).catch((e: unknown) => e);
    expect(update).toBeInstanceOf(InvalidConfiguratorOperationError);
    expect((update as Error).message).toBe("Ställpris och styckpris kräver en legoresurs");
  });

  it("switching a lego operation to a non-lego resource clears its prices", async () => {
    const s = await build();
    const wcL = await workCenter("236", 0, 0, "subcontract");
    const wcM = await workCenter("237", 100);
    const op = await service.createOperation(s.article.id, {
      conditions: [], sequenceNo: 70, workCenterId: wcL.id, setupTime: 0, runTimePerUnit: 0, setupPrice: 40, unitPrice: 2.25,
    });
    const moved = await service.updateOperation(s.article.id, op.id, { workCenterId: wcM.id });
    expect(moved).toMatchObject({ workCenterId: wcM.id, setupPrice: null, unitPrice: null });
    // Non-null prices alongside the switch are still refused.
    const back = await service.updateOperation(s.article.id, op.id, { workCenterId: wcL.id, setupPrice: 40 });
    expect(back).toMatchObject({ setupPrice: "40.00" });
    const refused = await service.updateOperation(s.article.id, op.id, { workCenterId: wcM.id, unitPrice: 1 }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(InvalidConfiguratorOperationError);
  });
});

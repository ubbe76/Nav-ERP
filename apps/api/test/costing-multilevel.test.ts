import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { bomComponents, costCalculationMaterialRows, costCalculations, db } from "@navet/db";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createCostingRepository } from "../src/modules/costing/repository/costing.repository.js";
import { createCostingService } from "../src/modules/costing/service/costing.service.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import { createManufacturingService } from "../src/modules/manufacturing/service/manufacturing.service.js";
import { testArticleService, testDocumentPdfService } from "./helpers/services.js";

// Flernivåkalkyl (Räkna om underliggande nivåer): a manufactured sub-assembly
// is costed from its OWN structure and routing instead of from its manually
// maintained standard cost. Opt-in per run — the first test here is the
// regression that the flag being off changes nothing.

const articleService = createArticleService(createArticleRepository(db));
const mfgService = createManufacturingService(createManufacturingRepository(db), testDocumentPdfService, testArticleService);

const costingSettings = {
  costingMaterialSource: "standard" as "standard" | "supplier" | "actual",
  costingMoPercent: 0,
  costingLoPercent: 0,
  costingAffoPercent: 0,
  costingGeneralMarkupPercent: 0,
};
const costingService = createCostingService(createCostingRepository(db), {
  getSettings: async () => costingSettings,
});

const TRUNCATE = sql`TRUNCATE cost_calculations, routing_operations, work_centers, bom_components, articles, users CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
  Object.assign(costingSettings, {
    costingMaterialSource: "standard",
    costingMoPercent: 0,
    costingLoPercent: 0,
    costingAffoPercent: 0,
    costingGeneralMarkupPercent: 0,
  });
});

afterAll(async () => {
  await db.execute(TRUNCATE);
});

let seq = 0;
const nextNumber = (prefix: string) => `${prefix}-${(seq += 1)}-${crypto.randomUUID().slice(0, 8)}`;

async function makeArticle(opts: {
  type: "manufactured" | "purchased" | "service";
  name: string;
  standardCost?: number;
  isPhantom?: boolean;
}) {
  return articleService.createArticle({
    articleNumber: nextNumber(opts.name.toUpperCase().slice(0, 6)),
    name: opts.name,
    type: opts.type,
    unit: "st",
    standardCost: opts.standardCost,
    isPhantom: opts.isPhantom,
    active: true,
  });
}

// One work center, reused: 100 kr/h, no TO unless a test asks for it.
async function makeWorkCenter(overheadPercent = 0) {
  return mfgService.createWorkCenter({
    code: String(100 + (seq % 800)),
    name: `Resurs ${(seq += 1)}`,
    hourlyRate: 100,
    overheadPercent,
    active: true,
  });
}

// setupTime/runTimePerUnit are MINUTES.
async function addRouting(articleId: string, setupTime: number, runTimePerUnit: number, overheadPercent = 0) {
  const wc = await makeWorkCenter(overheadPercent);
  await mfgService.createRoutingOperation(articleId, {
    sequenceNo: 10,
    workCenterId: wc.id,
    setupTime,
    runTimePerUnit,
  });
  return wc;
}

/**
 * SLUT (manufactured)
 *   └─ 2 x HALV (manufactured, standardCost 999 — deliberately wrong)
 *        └─ 1 x RA (purchased, standardCost 50)
 *        └─ routing: 60 min setup + 6 min/unit @ 100 kr/h
 */
async function makeTwoLevelStructure() {
  const raw = await makeArticle({ type: "purchased", name: "Ramaterial", standardCost: 50 });
  const semi = await makeArticle({ type: "manufactured", name: "Underrede", standardCost: 999 });
  const top = await makeArticle({ type: "manufactured", name: "Slutprodukt" });

  await articleService.addBomComponent(semi.id, { componentArticleId: raw.id, quantity: 1 });
  await addRouting(semi.id, 60, 6);
  await articleService.addBomComponent(top.id, { componentArticleId: semi.id, quantity: 2 });
  return { raw, semi, top };
}

async function rowsOf(calculationId: string) {
  return db
    .select()
    .from(costCalculationMaterialRows)
    .where(eq(costCalculationMaterialRows.costCalculationId, calculationId));
}

describe("flernivåkalkyl — flaggan av", () => {
  it("prices a manufactured sub-assembly at its standard cost, exactly as before", async () => {
    const { semi, top } = await makeTwoLevelStructure();

    const { calculation } = await costingService.preCalculate(top.id, 10);

    // 10 x 2 x 999 — the sub-assembly's own structure and routing are ignored.
    expect(Number(calculation.materialCost)).toBe(19980);
    expect(Number(calculation.semiFinishedCost)).toBe(0);
    expect(calculation.multiLevel).toBe(false);
    expect(semi.id).toBeTruthy();
  });
});

describe("flernivåkalkyl — flaggan på", () => {
  it("costs the sub-assembly from its own structure and routing", async () => {
    const { top } = await makeTwoLevelStructure();

    const { calculation } = await costingService.preCalculate(top.id, 10, false, true);

    // 10 finished units need 20 sub-assemblies. Its own cost for 20:
    //   material 20 x 50 = 1000
    //   labor (60 + 6 x 20) / 60 h x 100 = 300
    //   TVK = 1300
    expect(Number(calculation.semiFinishedCost)).toBe(1300);
    // The sub-assembly is NOT direct material, and its 999 standard cost is
    // nowhere in the calculation.
    expect(Number(calculation.materialCost)).toBe(0);
    // Its labor stays inside its own TVK — it is not the parent's direct labor.
    expect(Number(calculation.laborCost)).toBe(0);
    expect(calculation.multiLevel).toBe(true);
  });

  it("writes one semi row whose amount is the sub-calculation's own TVK", async () => {
    const { semi, top } = await makeTwoLevelStructure();

    const { calculation } = await costingService.preCalculate(top.id, 10, true, true);
    const rows = await rowsOf(calculation.id);

    const semiRows = rows.filter((r) => r.kind === "semi");
    expect(semiRows).toHaveLength(1);
    expect(semiRows[0]!.componentArticleId).toBe(semi.id);
    expect(semiRows[0]!.priceSource).toBe("calculated");
    expect(Number(semiRows[0]!.quantity)).toBe(20);
    expect(Number(semiRows[0]!.amount)).toBe(1300);
    // à-pris is derived from the amount, never the other way round.
    expect(Number(semiRows[0]!.unitCost)).toBe(65);
    // The raw material lives inside the sub-calculation, not on the parent.
    expect(rows.filter((r) => r.kind === "material")).toHaveLength(0);
  });

  it("lifts the sub-assembly's TO into the parent's TO bucket instead of its TVK", async () => {
    const raw = await makeArticle({ type: "purchased", name: "Ramaterial", standardCost: 50 });
    const semi = await makeArticle({ type: "manufactured", name: "Underrede", standardCost: 999 });
    const top = await makeArticle({ type: "manufactured", name: "Slutprodukt" });
    await articleService.addBomComponent(semi.id, { componentArticleId: raw.id, quantity: 1 });
    await addRouting(semi.id, 60, 6, 50); // TO 50 % on the sub-level's labor
    await articleService.addBomComponent(top.id, { componentArticleId: semi.id, quantity: 2 });
    await addRouting(top.id, 0, 30, 10); // own: 10 × 30 min = 5 h × 100 = 500, TO 50
    Object.assign(costingSettings, { costingAffoPercent: 10, costingGeneralMarkupPercent: 20 });

    const { calculation } = await costingService.preCalculate(top.id, 10, true, true);
    const rows = await rowsOf(calculation.id);

    // Sub-level: material 1000 + labor 300 = TVK 1300; its TO 300 × 50 % = 150
    // is NOT in the 1300 …
    expect(Number(calculation.semiFinishedCost)).toBe(1300);
    // … it rides on the semi row and lands in the parent's TO with the
    // parent's own 50.
    const semiRow = rows.find((r) => r.kind === "semi")!;
    expect(Number(semiRow.amount)).toBe(1300);
    expect(Number(semiRow.overheadAmount)).toBe(150);
    expect(Number(calculation.overhead)).toBe(200);
    expect(Number(calculation.laborCost)).toBe(500);
    // TVK 1800 → Affo 180 → SVK 1980 → generellt 396 → + TO 200. Affo and the
    // general markup never touch the TO, at any level.
    expect(Number(calculation.businessOverhead)).toBe(180);
    expect(Number(calculation.generalMarkup)).toBe(396);
    expect(Number(calculation.salesPrice)).toBe(1980 + 396 + 200);

    // The specification explains the whole TO bucket: operation rows + semi rows.
    const detail = await costingService.getCostCalculation(calculation.id);
    const opTo = detail!.operationRows.reduce((t, r) => t + Number(r.overheadAmount), 0);
    const semiTo = detail!.materialRows.reduce((t, r) => t + Number(r.overheadAmount), 0);
    expect(opTo).toBe(50);
    expect(opTo + semiTo).toBe(Number(calculation.overhead));
  });

  it("carries TO up through three levels", async () => {
    const raw = await makeArticle({ type: "purchased", name: "Plat", standardCost: 10 });
    const lower = await makeArticle({ type: "manufactured", name: "Detalj", standardCost: 999 });
    const middle = await makeArticle({ type: "manufactured", name: "Underrede", standardCost: 888 });
    const top = await makeArticle({ type: "manufactured", name: "Slutprodukt" });
    await articleService.addBomComponent(lower.id, { componentArticleId: raw.id, quantity: 1 });
    await addRouting(lower.id, 0, 6, 100); // 1 lower = 6 min = 10 kr labor, TO 10
    await articleService.addBomComponent(middle.id, { componentArticleId: lower.id, quantity: 2 });
    await addRouting(middle.id, 0, 6, 50); // 1 middle = 10 kr labor, TO 5
    await articleService.addBomComponent(top.id, { componentArticleId: middle.id, quantity: 1 });

    const { calculation } = await costingService.preCalculate(top.id, 10, true, true);
    const rows = await rowsOf(calculation.id);

    // 10 tops → 10 middles → 20 lowers. lower: 20 × (10 + 10) = 400 TVK, TO 200;
    // middle: 400 + 10 × 10 = 500 TVK, TO 50 own + 200 lifted = 250.
    expect(Number(calculation.semiFinishedCost)).toBe(500);
    expect(Number(calculation.overhead)).toBe(250);
    expect(rows.map((r) => [r.kind, Number(r.amount), Number(r.overheadAmount)])).toEqual([["semi", 500, 250]]);
    expect(Number(calculation.salesPrice)).toBe(750);
  });

  it("keeps MO off the halvfabrikat but lets Affo reach it", async () => {
    const { top } = await makeTwoLevelStructure();
    Object.assign(costingSettings, { costingMoPercent: 50, costingAffoPercent: 10 });

    const { calculation } = await costingService.preCalculate(top.id, 10, false, true);

    // The parent has no direct material of its own, and MO is NOT charged a
    // second time on the sub-assembly — its own MO was already applied one
    // level down. Without that rule the 1800 below would carry another 900.
    expect(Number(calculation.materialOverhead)).toBe(0);
    // Sub-level TVK: material 1000 + its own MO 500 + labor 300 = 1800.
    expect(Number(calculation.semiFinishedCost)).toBe(1800);
    // Affo is company-wide and lands on the whole TVK exactly once — which is
    // the reason the sub-level hands up its TVK and not its self cost.
    expect(Number(calculation.businessOverhead)).toBeCloseTo(180, 4);
  });

  it("applies the sub-assembly's own MO inside its manufacturing cost", async () => {
    const { top } = await makeTwoLevelStructure();
    Object.assign(costingSettings, { costingMoPercent: 50 });

    const { calculation } = await costingService.preCalculate(top.id, 10, false, true);

    // Sub-level: material 1000 + MO 500 + labor 300 = 1800.
    expect(Number(calculation.semiFinishedCost)).toBe(1800);
  });

  it("amortises the sub-assembly's setup time, so doubling the quantity costs less than twice as much", async () => {
    const { top } = await makeTwoLevelStructure();

    const ten = await costingService.preCalculate(top.id, 10, false, true);
    const twenty = await costingService.preCalculate(top.id, 20, false, true);

    // Setup is charged once per cascade, not once per unit.
    expect(Number(twenty.calculation.semiFinishedCost)).toBeLessThan(
      2 * Number(ten.calculation.semiFinishedCost)
    );
  });

  it("dissolves a phantom sitting under the sub-assembly into the sub-assembly's own cost", async () => {
    const raw = await makeArticle({ type: "purchased", name: "Skruv", standardCost: 5 });
    const phantom = await makeArticle({ type: "manufactured", name: "Fantomsats", isPhantom: true });
    const semi = await makeArticle({ type: "manufactured", name: "Underrede", standardCost: 999 });
    const top = await makeArticle({ type: "manufactured", name: "Slutprodukt" });

    await articleService.addBomComponent(phantom.id, { componentArticleId: raw.id, quantity: 4 });
    await articleService.addBomComponent(semi.id, { componentArticleId: phantom.id, quantity: 1 });
    await articleService.addBomComponent(top.id, { componentArticleId: semi.id, quantity: 1 });

    const { calculation } = await costingService.preCalculate(top.id, 1, true, true);
    const rows = await rowsOf(calculation.id);

    // 1 x 4 x 5 = 20, inside the sub-assembly — the phantom is never a row.
    expect(Number(calculation.semiFinishedCost)).toBe(20);
    expect(rows.map((r) => r.kind)).toEqual(["semi"]);
  });

  it("falls back to the standard cost, with a warning, when the sub-assembly has no structure and no routing", async () => {
    const semi = await makeArticle({ type: "manufactured", name: "Underrede", standardCost: 250 });
    const top = await makeArticle({ type: "manufactured", name: "Slutprodukt" });
    await articleService.addBomComponent(top.id, { componentArticleId: semi.id, quantity: 2 });

    const { calculation, warnings } = await costingService.preCalculate(top.id, 3, true, true);
    const rows = await rowsOf(calculation.id);

    // Priced as plain direct material, exactly as before multi-level existed.
    expect(Number(calculation.materialCost)).toBe(1500);
    expect(Number(calculation.semiFinishedCost)).toBe(0);
    expect(rows.map((r) => r.kind)).toEqual(["material"]);
    expect(warnings).toContain("Underrede: saknar struktur och rutt, använder standardpris");
  });

  it("costs a sub-assembly that has a routing but no structure", async () => {
    const semi = await makeArticle({ type: "manufactured", name: "Bearbetning", standardCost: 999 });
    const top = await makeArticle({ type: "manufactured", name: "Slutprodukt" });
    await addRouting(semi.id, 0, 30);
    await articleService.addBomComponent(top.id, { componentArticleId: semi.id, quantity: 1 });

    const { calculation } = await costingService.preCalculate(top.id, 2, false, true);

    // 2 units x 30 min = 60 min = 1 h x 100 kr.
    expect(Number(calculation.semiFinishedCost)).toBe(100);
  });

  it("cascades through three levels", async () => {
    const raw = await makeArticle({ type: "purchased", name: "Plat", standardCost: 10 });
    const lower = await makeArticle({ type: "manufactured", name: "Detalj", standardCost: 999 });
    const middle = await makeArticle({ type: "manufactured", name: "Underrede", standardCost: 888 });
    const top = await makeArticle({ type: "manufactured", name: "Slutprodukt" });

    await articleService.addBomComponent(lower.id, { componentArticleId: raw.id, quantity: 3 });
    await articleService.addBomComponent(middle.id, { componentArticleId: lower.id, quantity: 2 });
    await articleService.addBomComponent(top.id, { componentArticleId: middle.id, quantity: 1 });

    const { calculation } = await costingService.preCalculate(top.id, 5, false, true);

    // 5 tops → 5 middles → 10 lowers → 30 raw x 10 = 300. Neither 999 nor 888
    // appears anywhere: every level was recomputed.
    expect(Number(calculation.semiFinishedCost)).toBe(300);
  });

  it("falls back with a warning instead of looping forever on a cyclic structure", async () => {
    const a = await makeArticle({ type: "manufactured", name: "Aring", standardCost: 100 });
    const b = await makeArticle({ type: "manufactured", name: "Bring", standardCost: 200 });
    const top = await makeArticle({ type: "manufactured", name: "Slutprodukt" });

    await articleService.addBomComponent(a.id, { componentArticleId: b.id, quantity: 1 });
    // isDescendant refuses this one, so the cycle is inserted directly — the
    // guard exists for structures that slipped past it (a restored dump, a
    // future import path), and must degrade rather than 500 the article card.
    await db.insert(bomComponents).values({ parentArticleId: b.id, componentArticleId: a.id, quantity: "1" });
    await articleService.addBomComponent(top.id, { componentArticleId: a.id, quantity: 1 });

    const { calculation, warnings } = await costingService.preCalculate(top.id, 1, false, true);

    // A's cost resolves to B's, whose own A falls back to A's standard cost.
    expect(warnings).toContain("Aring: cyklisk struktur, använder standardpris");
    expect(Number(calculation.semiFinishedCost)).toBeGreaterThan(0);
  });

  it("costs a sub-assembly reached through two branches once, at the merged quantity", async () => {
    const raw = await makeArticle({ type: "purchased", name: "Ramaterial", standardCost: 50 });
    const semi = await makeArticle({ type: "manufactured", name: "Underrede", standardCost: 999 });
    const phantom = await makeArticle({ type: "manufactured", name: "Fantomsats", isPhantom: true });
    const top = await makeArticle({ type: "manufactured", name: "Slutprodukt" });

    await articleService.addBomComponent(semi.id, { componentArticleId: raw.id, quantity: 1 });
    await addRouting(semi.id, 60, 6);
    // The same sub-assembly reached directly and through a phantom: explodeBom
    // merges them into one line of quantity 3, so it must be costed once for 3.
    await articleService.addBomComponent(phantom.id, { componentArticleId: semi.id, quantity: 2 });
    await articleService.addBomComponent(top.id, { componentArticleId: phantom.id, quantity: 1 });

    const { calculation } = await costingService.preCalculate(top.id, 1, true, true);
    const rows = await rowsOf(calculation.id);

    expect(rows.filter((r) => r.kind === "semi")).toHaveLength(1);
    expect(Number(rows[0]!.quantity)).toBe(2);
    // material 2 x 50 = 100, labor (60 + 6 x 2)/60 x 100 = 120 → 220
    expect(Number(calculation.semiFinishedCost)).toBe(220);
  });

  it("persists the multi-level flag so a saved calculation stays explainable", async () => {
    const { top } = await makeTwoLevelStructure();

    const { calculation } = await costingService.preCalculate(top.id, 10, true, true);
    const [saved] = await db.select().from(costCalculations).where(eq(costCalculations.id, calculation.id));

    expect(saved!.multiLevel).toBe(true);
    expect(Number(saved!.semiFinishedCost)).toBe(1300);
  });
});

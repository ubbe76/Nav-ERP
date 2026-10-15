import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@navet/db";
import { linkMaterialsToOperations, manufacturingOperations } from "../src/modules/configurator/service/manufacturing-structure.js";
import { ConfiguratorNotToOrderModeError } from "../src/modules/configurator/service/configurator.errors.js";
import { buildToOrderWithStructure, CONFIGURED_MFG_TRUNCATE, FULL, resetCostingSettings } from "./helpers/configured-manufacturing.js";
import { configurator, makeCustomer, resetConfiguredRows } from "./helpers/configured-rows.js";
import { makeArticle } from "./helpers/configurator.js";

// Konfigurator 4c: one configuration's derived structure as a TO's own rows
// (manufacturing-structure.ts, pure) and the service's deriveForManufacturing
// on top of it (against the database).

describe("manufacturing-structure — pure", () => {
  const op = (sequenceNo: number, kind: "base" | "configurator", id: string, costingOnly = false) =>
    ({ kind, id, sequenceNo, workCenterId: "wc", description: null, setupTime: 1, runTimePerUnit: 2, costingOnly, setupPrice: null, unitPrice: null }) as const;

  it("drops costing-only operations and maps the template's route columns", () => {
    const rows = manufacturingOperations([
      { sequenceNo: 10, workCenterId: "wc", description: "Kapa", setupTime: 6, runTimePerUnit: 3, costingOnly: false, setupPrice: null, unitPrice: null,
        subcontractSupplierId: null, copyFrom: { id: "r10", comment: "Mät", timeUnit: "units_per_hour", printOnWorkCard: true, packingInstructions: "Plast", showNetWeight: true } },
      { sequenceNo: 20, workCenterId: "wc2", description: null, setupTime: 0, runTimePerUnit: 4, costingOnly: false, setupPrice: 50, unitPrice: 2.5,
        subcontractSupplierId: "sup", copyFrom: null },
      { sequenceNo: 30, workCenterId: "wc3", description: null, setupTime: 0, runTimePerUnit: 5, costingOnly: true, setupPrice: null, unitPrice: null,
        subcontractSupplierId: null, copyFrom: { id: "r30" } },
    ]);
    expect(rows).toEqual([
      { sequenceNo: 10, routingOperationId: "r10", workCenterId: "wc", description: "Kapa", setupTime: "6", runTimePerUnit: "3", timeUnit: "units_per_hour",
        comment: "Mät", printOnWorkCard: true, packingInstructions: "Plast", subcontractSupplierId: null, setupPrice: null, unitPrice: null, showNetWeight: true },
      { sequenceNo: 20, routingOperationId: null, workCenterId: "wc2", description: null, setupTime: "0", runTimePerUnit: "4", timeUnit: "minutes_per_unit",
        comment: null, printOnWorkCard: false, packingInstructions: null, subcontractSupplierId: "sup", setupPrice: "50", unitPrice: "2.5", showNetWeight: false },
    ]);
  });

  it("links material to a kept operation by its derived id; unknown or dropped ⇒ unlinked", () => {
    const ops = [op(10, "base", "r10"), op(20, "configurator", "c20"), op(30, "base", "r30", true)];
    const linked = linkMaterialsToOperations(
      [
        { componentArticleId: "A", componentName: "A", totalQuantity: 2, unitId: null, unitFactor: null, operationId: "r10" },
        { componentArticleId: "B", componentName: "B", totalQuantity: 1, unitId: "u", unitFactor: "0.5", operationId: "c20" },
        { componentArticleId: "C", componentName: "C", totalQuantity: 3, unitId: null, unitFactor: null, operationId: "phantom-own-op" },
        { componentArticleId: "D", componentName: "D", totalQuantity: 1, unitId: null, unitFactor: null, operationId: "r30" },
      ],
      ops,
      new Set([10, 20])
    );
    expect(linked.map((m) => [m.componentArticleId, m.operationSequenceNo, m.totalQuantity, m.unitId])).toEqual([
      ["A", 10, 2, null], ["B", 20, 1, "u"], ["C", null, 3, null], ["D", null, 1, null],
    ]);
  });

  // mo_material_consumptions is unique per (TO, article, operation) with NULLS
  // NOT DISTINCT: rows that collapse to the same key after linking must merge.
  it("merges rows of one article that both end up unlinked: phantom's own route + unlinked", () => {
    const ops = [op(10, "base", "r10")];
    const linked = linkMaterialsToOperations(
      [
        { componentArticleId: "C", componentName: "C", totalQuantity: 1.1, unitId: null, unitFactor: null, operationId: "phantom-own-op" },
        { componentArticleId: "A", componentName: "A", totalQuantity: 2, unitId: null, unitFactor: null, operationId: "r10" },
        { componentArticleId: "C", componentName: "C", totalQuantity: 2.2, unitId: null, unitFactor: null, operationId: null },
      ],
      ops,
      new Set([10])
    );
    expect(linked).toEqual([
      { componentArticleId: "C", componentName: "C", totalQuantity: 3.3, operationSequenceNo: null, unitId: null, unitFactor: null },
      { componentArticleId: "A", componentName: "A", totalQuantity: 2, operationSequenceNo: 10, unitId: null, unitFactor: null },
    ]);
  });

  it("merges a costing-only link with an unlinked row of the same article; differing units ⇒ base unit", () => {
    const ops = [op(10, "base", "r10"), op(30, "base", "r30", true)];
    const linked = linkMaterialsToOperations(
      [
        { componentArticleId: "D", componentName: "D", totalQuantity: 1, unitId: "u", unitFactor: "0.5", operationId: "r30" },
        { componentArticleId: "D", componentName: "D", totalQuantity: 4, unitId: null, unitFactor: null, operationId: null },
        // Same article on a KEPT operation stays its own row.
        { componentArticleId: "D", componentName: "D", totalQuantity: 7, unitId: "u", unitFactor: "0.5", operationId: "r10" },
      ],
      ops,
      new Set([10])
    );
    expect(linked).toEqual([
      { componentArticleId: "D", componentName: "D", totalQuantity: 5, operationSequenceNo: null, unitId: null, unitFactor: null },
      { componentArticleId: "D", componentName: "D", totalQuantity: 7, operationSequenceNo: 10, unitId: "u", unitFactor: "0.5" },
    ]);
  });
});

describe("deriveForManufacturing — against the database", () => {
  beforeEach(async () => {
    await resetConfiguredRows();
    await db.execute(CONFIGURED_MFG_TRUNCATE);
    await resetCostingSettings();
  });
  afterAll(resetConfiguredRows);

  it("derives operations, merged material × quantity and TVK/st", async () => {
    const s = await buildToOrderWithStructure();
    const r = await configurator.deriveForManufacturing(s.article.id, FULL, 2);
    expect(r.valid).toBe(true);
    expect(r.key).toBeTruthy();
    expect(r.selection.map((e) => [e.groupCode, e.value])).toEqual([["LOCK", "B"], ["AVLOPP", true], ["BREDD", 1200]]);
    expect(r.operations.map((o) => [o.sequenceNo, o.routingOperationId, o.description, o.comment, o.printOnWorkCard])).toEqual([
      [10, s.op10.id, "Kapa", "Mät två gånger", true],
      [20, null, "Montera lås B", null, false],
    ]);
    const mat = new Map(r.materials.map((m) => [m.componentArticleId, m]));
    expect(mat.get(s.parts.skruv.id)).toMatchObject({ totalQuantity: 16, operationSequenceNo: null });
    expect(mat.get(s.parts.plat.id)).toMatchObject({ totalQuantity: 2.4, operationSequenceNo: 10 });
    expect(mat.get(s.parts.avl.id)).toMatchObject({ totalQuantity: 2 });
    expect(mat.get(s.parts.f1.id)).toMatchObject({ totalQuantity: 4 });
    expect(mat.get(s.parts.f2.id)).toMatchObject({ totalQuantity: 2 });
    expect(mat.has(s.parts.fant.id)).toBe(false);
    // quantity 2: setup 6 min of op 10 is shared ⇒ (6 + 3×2)/60×600 = 120 → 60/st; rest is linear
    // 16 + 60 + 12 + 40 + 10 + 20 + 10 = 168 per unit
    expect(r.cost!.manufacturingCostPerUnit).toBe(168);
    // No Affo in the test settings ⇒ SVK/st = TVK/st.
    expect(r.cost!.selfCostPerUnit).toBe(168);
  });

  it("material quantities are rounded to four decimals (formula × quantity leaves no float noise)", async () => {
    const s = await buildToOrderWithStructure();
    // BREDD 1100 ⇒ PLAT 1,1 st/unit; 1.1 × 3 is 3.3000000000000003 in floating point.
    const r = await configurator.deriveForManufacturing(s.article.id, { ...FULL, BREDD: 1100 }, 3, { withCost: false });
    expect(r.valid).toBe(true);
    expect(r.materials.find((m) => m.componentArticleId === s.parts.plat.id)?.totalQuantity).toBe(3.3);
  });

  it("withCost false skips the costing; an invalid selection is reported, not thrown", async () => {
    const s = await buildToOrderWithStructure();
    const noCost = await configurator.deriveForManufacturing(s.article.id, FULL, 1, { withCost: false });
    expect(noCost.valid).toBe(true);
    expect(noCost.cost).toBeNull();
    const bad = await configurator.deriveForManufacturing(s.article.id, { LOCK: "B" }, 1);
    expect(bad.valid).toBe(false);
    expect(bad.errors.length).toBeGreaterThan(0);
    expect(bad.operations).toEqual([]);
    expect(bad.materials).toEqual([]);
    expect(bad.cost).toBeNull();
  });

  it("a template not in to_order is refused", async () => {
    const plain = await makeArticle();
    await configurator.createTemplate(plain.id, { mode: "variants" });
    await expect(configurator.deriveForManufacturing(plain.id, {}, 1)).rejects.toBeInstanceOf(ConfiguratorNotToOrderModeError);
  });

  it("a structure without any cost gives null, never 0", async () => {
    const s = await buildToOrderWithStructure();
    for (const p of Object.values(s.parts)) await db.execute(sql`update articles set standard_cost = null where id = ${p.id}`);
    await db.execute(sql`update work_centers set hourly_rate = 0`);
    const r = await configurator.deriveForManufacturing(s.article.id, FULL, 1);
    expect(r.valid).toBe(true);
    expect(r.cost).toEqual({ manufacturingCostPerUnit: null, selfCostPerUnit: null });
  });

  it("evaluateRowConfiguration carries the row cost at the row quantity", async () => {
    const s = await buildToOrderWithStructure();
    const c = await makeCustomer();
    const r = await configurator.evaluateRowConfiguration(s.article.id, FULL, { customerId: c.id, quantity: 2 });
    expect(r.valid).toBe(true);
    expect(r.cost).toMatchObject({ manufacturingCostPerUnit: 168, selfCostPerUnit: 168, quantity: 2 });
    expect(Date.parse(r.cost!.calculatedAt)).not.toBeNaN();
    // quantity 1: op 10's setup is carried by one unit ⇒ 90 instead of 60 ⇒ 198
    const one = await configurator.evaluateRowConfiguration(s.article.id, FULL, { customerId: c.id, quantity: 1 });
    expect(one.cost).toMatchObject({ manufacturingCostPerUnit: 198, quantity: 1 });
    // invalid ⇒ no configuration and no cost
    const bad = await configurator.evaluateRowConfiguration(s.article.id, { LOCK: "B" }, { customerId: c.id, quantity: 1 });
    expect(bad.valid).toBe(false);
    expect(bad.cost).toBeNull();
  });
});

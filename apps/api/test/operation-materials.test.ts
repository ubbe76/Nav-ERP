import { describe, expect, it } from "vitest";
import {
  compareArticleNumbers,
  isCoRunMaterial,
  linkedOperationMaterials,
  type OperationMaterial,
  type OperationMaterialRow,
} from "../src/modules/manufacturing/service/operation-materials.js";

// The shared material rule (pure): what is linked to an operation, in the
// terminal's order, and which of it is co-run material (B3).

const row = (over: Partial<OperationMaterialRow>): OperationMaterialRow => ({
  rowId: `r-${over.articleNumber ?? "X"}`,
  moOperationId: "op-1",
  articleId: `a-${over.articleNumber ?? "X"}`,
  articleNumber: "X",
  articleName: "Material",
  articleType: "purchased",
  unit: "st",
  quantityPlanned: 10,
  quantityConsumed: 0,
  ...over,
});

describe("linkedOperationMaterials", () => {
  it("groups per operation and skips the unlinked rows", () => {
    const linked = linkedOperationMaterials([
      row({ moOperationId: "op-1", articleNumber: "PLÅT-2" }),
      row({ moOperationId: null, articleNumber: "SKRUV-6" }),
      row({ moOperationId: "op-2", articleNumber: "RÖR-30", unit: "m" }),
    ]);
    expect([...linked.keys()].sort()).toEqual(["op-1", "op-2"]);
    expect(linked.get("op-1")).toEqual([
      { rowId: "r-PLÅT-2", articleId: "a-PLÅT-2", articleNumber: "PLÅT-2", articleName: "Material", articleType: "purchased", unit: "st", remainingQuantity: 10 },
    ]);
    expect(linked.get("op-2")![0]).toMatchObject({ articleNumber: "RÖR-30", unit: "m" });
  });

  it("sorts an operation's materials in natural number order: 2 before 10", () => {
    const linked = linkedOperationMaterials([
      row({ articleNumber: "BEN-10" }),
      row({ articleNumber: "BEN-2" }),
      row({ articleNumber: "ARM-1" }),
    ]);
    expect(linked.get("op-1")!.map((m) => m.articleNumber)).toEqual(["ARM-1", "BEN-2", "BEN-10"]);
    expect(compareArticleNumbers({ articleNumber: "BEN-2" }, { articleNumber: "BEN-10" })).toBeLessThan(0);
  });

  it("the rest is planned − consumed in four decimals, never below 0", () => {
    const linked = linkedOperationMaterials([
      row({ articleNumber: "A", quantityPlanned: 0.3, quantityConsumed: 0.1 }),
      row({ articleNumber: "B", quantityPlanned: 5, quantityConsumed: 5 }),
      row({ articleNumber: "C", quantityPlanned: 5, quantityConsumed: 7.5 }),
    ]);
    expect(linked.get("op-1")!.map((m) => m.remainingQuantity)).toEqual([0.2, 0, 0]);
  });

  it("keeps one entry per material row, also for the same article twice", () => {
    const linked = linkedOperationMaterials([
      row({ rowId: "r-1", articleNumber: "A", quantityPlanned: 2 }),
      row({ rowId: "r-2", articleNumber: "A", quantityPlanned: 3 }),
    ]);
    // Each entry carries its own row id.
    expect(linked.get("op-1")!.map((m) => [m.rowId, m.remainingQuantity])).toEqual([
      ["r-1", 2],
      ["r-2", 3],
    ]);
  });
});

describe("isCoRunMaterial", () => {
  const material = (over: Partial<OperationMaterial>): OperationMaterial => ({
    rowId: "r",
    articleId: "a",
    articleNumber: "A",
    articleName: "Material",
    articleType: "purchased",
    unit: "st",
    remainingQuantity: 4,
    ...over,
  });

  it("is a purchased article with something left", () => {
    expect(isCoRunMaterial(material({}))).toBe(true);
  });

  it("is never a halvfabrikat or a service", () => {
    expect(isCoRunMaterial(material({ articleType: "manufactured" }))).toBe(false);
    expect(isCoRunMaterial(material({ articleType: "service" }))).toBe(false);
  });

  it("is never a fully drawn row", () => {
    expect(isCoRunMaterial(material({ remainingQuantity: 0 }))).toBe(false);
  });
});

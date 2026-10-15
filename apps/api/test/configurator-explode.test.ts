import { describe, expect, it } from "vitest";
import { explodeDerivedMaterials, type ExplodeBom } from "../src/modules/configurator/service/configurator-explode.js";

// The derived structure's material, one level down, as the costing preview
// costs it: phantoms dissolved into their own components and rows merged per
// (article, operation) exactly like bom-explosion.ts. Pure — explodeBom stubbed.

const row = (componentArticleId: string, totalQuantity: number, extra: Record<string, unknown> = {}) => ({
  componentArticleId, componentName: componentArticleId.toUpperCase(), totalQuantity, unitId: null, unitFactor: null,
  operationId: null, isPhantom: false, ...extra,
});

const noExplode: ExplodeBom = async () => {
  throw new Error("explodeBom must not be called for a non-phantom");
};

describe("explodeDerivedMaterials", () => {
  it("keeps one row per (article, operation): same operation summed, another operation separate", async () => {
    const out = await explodeDerivedMaterials(
      [row("bult", 10, { operationId: "op10" }), row("bult", 20, { operationId: "op40" }), row("bult", 30, { operationId: "op10" }), row("bult", 5)],
      noExplode
    );
    expect(out).toEqual([
      { componentArticleId: "bult", componentName: "BULT", totalQuantity: 40, unitId: null, unitFactor: null, operationId: "op10" },
      { componentArticleId: "bult", componentName: "BULT", totalQuantity: 20, unitId: null, unitFactor: null, operationId: "op40" },
      { componentArticleId: "bult", componentName: "BULT", totalQuantity: 5, unitId: null, unitFactor: null, operationId: null },
    ]);
  });

  it("falls back to the base unit when merged rows disagree on the unit", async () => {
    const out = await explodeDerivedMaterials(
      [row("plat", 2, { unitId: "u1", unitFactor: "0.5" }), row("plat", 3, { unitId: "u2", unitFactor: "2" })],
      noExplode
    );
    expect(out).toEqual([{ componentArticleId: "plat", componentName: "PLAT", totalQuantity: 5, unitId: null, unitFactor: null, operationId: null }]);
  });

  it("dissolves a phantom into its components; parts inherit the phantom row's operation unless they carry their own", async () => {
    const calls: [string, number][] = [];
    const explodeBom: ExplodeBom = async (articleId, quantity) => {
      calls.push([articleId, quantity]);
      return [
        { componentArticleId: "f1", componentName: "F1", totalQuantity: quantity * 2, unitId: null, unitFactor: null, routingOperationId: null },
        { componentArticleId: "f2", componentName: "F2", totalQuantity: quantity, unitId: null, unitFactor: null, routingOperationId: "op20" },
      ];
    };
    const out = await explodeDerivedMaterials(
      [row("fant", 30, { isPhantom: true, operationId: "op10" }), row("f1", 4, { operationId: "op10" }), row("f2", 1)],
      explodeBom
    );
    expect(calls).toEqual([["fant", 30]]);
    expect(out.map((r) => [r.componentArticleId, r.operationId, r.totalQuantity])).toEqual([
      ["f1", "op10", 64], // 60 from the phantom + 4 direct, same operation
      ["f2", "op20", 30],
      ["f2", null, 1],
    ]);
    expect(out.some((r) => r.componentArticleId === "fant")).toBe(false);
  });

  it("returns nothing for no material", async () => {
    expect(await explodeDerivedMaterials([], noExplode)).toEqual([]);
  });
});

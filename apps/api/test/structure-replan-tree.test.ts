import { describe, expect, it } from "vitest";
import {
  replanOrders,
  replanSelection,
  replanTree,
  sameReplanExpected,
  type ReplanExpectedOrder,
} from "../src/modules/planning/service/structure-replan.js";
import type { StructureAllocation, StructureDemand, StructureOrderFacts } from "../src/modules/planning/service/structure-tree.js";

// Planera om strukturen (pure, step 5b): the tree's TOs, which of them are
// chosen, and what planStructure gets for each — from the material rows
// Strukturvyn draws. The placing is tested in structure-replan.test.ts.

const facts = (id: string, status = "released", dueDate: string | null = "2026-12-01"): [string, StructureOrderFacts] => [
  id,
  {
    manufacturingOrderId: id,
    orderNumber: `TO-${id}`,
    orderStatus: status,
    articleId: `art-${id}`,
    articleNumber: `A-${id}`,
    articleName: `Artikel ${id}`,
    remainingQuantity: 1,
    dueDate,
    plan: null,
    componentLate: false,
  },
];
const alloc = (over: Partial<StructureAllocation>): StructureAllocation => ({
  kind: "manufacturing_order",
  documentId: null,
  documentNumber: null,
  quantity: 1,
  readyDate: "2026-11-02",
  late: false,
  undated: false,
  daysLate: 0,
  isDraft: false,
  exclusive: false,
  ...over,
});
const to = (id: string, exclusive = true, readyDate: string | null = "2026-11-02") =>
  alloc({ documentId: id, documentNumber: `TO-${id}`, exclusive, readyDate, undated: readyDate === null });
const demand = (articleNumber: string, allocations: StructureAllocation[], uncovered = 0): StructureDemand => ({
  rowId: `mat:${articleNumber}`,
  articleId: `art-${articleNumber}`,
  articleNumber,
  articleName: articleNumber,
  articleType: "manufactured",
  needDate: "2026-11-10",
  quantity: 1,
  uncovered,
  allocations,
});

// p needs 10 (h, exclusive), 2 (g, shared) and a planned TO z; h needs s
// (exclusive) and the shared g again; s is bought material only.
const orders = new Map([facts("p"), facts("h"), facts("g"), facts("s"), facts("z", "planned")]);
const demandsByOrder = new Map<string, StructureDemand[]>([
  ["p", [demand("10", [to("h")]), demand("2", [to("g", false)]), demand("30", [to("z")])]],
  ["h", [demand("5", [to("s")]), demand("2", [to("g", false)])]],
  ["s", [demand("R", [alloc({ kind: "purchase_order", documentId: "io", documentNumber: "IO-1", readyDate: "2026-11-05" }), alloc({ kind: "stock" })])]],
  ["g", []],
]);
const tree = replanTree("p", orders, demandsByOrder);

describe("replanTree", () => {
  it("lists every TO once, depth first, the material rows in article number order", () => {
    // 2 before 10 before 30; g is listed under p and not again under h.
    expect(tree.map((n) => [n.manufacturingOrderId, n.level, n.parentOrderId, n.exclusive, n.open])).toEqual([
      ["p", 0, null, true, true],
      ["g", 1, "p", false, true],
      ["h", 1, "p", true, true],
      ["s", 2, "h", true, true],
      ["z", 1, "p", true, false],
    ]);
  });

  it("ends a cycle and skips a TO without a head", () => {
    const cyclic = new Map<string, StructureDemand[]>([
      ["p", [demand("1", [to("h"), to("missing")])]],
      ["h", [demand("1", [to("p")])]],
    ]);
    expect(replanTree("p", new Map([facts("p"), facts("h")]), cyclic).map((n) => n.manufacturingOrderId)).toEqual(["p", "h"]);
    expect(replanTree("nope", orders, demandsByOrder)).toEqual([]);
  });
});

describe("replanSelection", () => {
  it("the default is the top and what is open and exclusive all the way up (S31)", () => {
    const { included, valid, capped } = replanSelection(tree, undefined);
    expect([...included]).toEqual(["p", "h", "s"]);
    expect([valid, capped]).toEqual([true, false]);
    // s is exclusive to h, but under a shared h it is not preselected.
    const shared = replanTree("p", orders, new Map([...demandsByOrder, ["p", [demand("10", [to("h", false)])]]]));
    expect([...replanSelection(shared, undefined).included]).toEqual(["p"]);
  });

  it("a given choice is taken as it is — a shared TO too — when every TO's parent is chosen", () => {
    expect([...replanSelection(tree, ["g", "h"]).included]).toEqual(["p", "g", "h"]);
    expect(replanSelection(tree, []).included).toEqual(new Set(["p"]));
    // The top may be listed.
    expect(replanSelection(tree, ["p", "h"])).toMatchObject({ valid: true });
  });

  it("is not valid for a TO under an unchosen parent, a TO that is not open and a TO outside the tree — they are left out", () => {
    for (const ids of [["s"], ["h", "z"], ["h", "elsewhere"]]) {
      const { included, valid } = replanSelection(tree, ids);
      expect(valid, ids.join()).toBe(false);
      expect(included.has("s") || included.has("z") || included.has("elsewhere")).toBe(false);
    }
  });

  it("caps the default at 200 halvfabrikat", () => {
    const wide = new Map([facts("p"), ...Array.from({ length: 205 }, (_, i) => facts(`c${i}`))]);
    const rows = new Map([["p", [demand("1", Array.from({ length: 205 }, (_, i) => to(`c${i}`)))]]]);
    const { included, capped } = replanSelection(replanTree("p", wide, rows), undefined);
    expect([included.size, capped]).toEqual([201, true]);
  });
});

describe("replanOrders", () => {
  const dueDateOf = (id: string) => (id === "p" ? "2026-12-24" : (orders.get(id)?.dueDate ?? null));

  it("a chosen TO is a child, anything else dated is external, stock is left out", () => {
    const out = replanOrders(tree, new Set(["p", "h", "s"]), demandsByOrder, dueDateOf);
    expect(out.map((o) => o.manufacturingOrderId)).toEqual(["p", "h", "s"]);
    const [p, h, s] = out;
    expect(p).toMatchObject({ level: 0, parentOrderId: null, dueDate: "2026-12-24", childOrderIds: ["h"] });
    // The unchosen g and the planned z count with the pegging's ready day.
    expect(p!.externalReady).toEqual([
      { kind: "manufacturing_order", documentNumber: "TO-g", date: "2026-11-02" },
      { kind: "manufacturing_order", documentNumber: "TO-z", date: "2026-11-02" },
    ]);
    expect(h).toMatchObject({ childOrderIds: ["s"], externalReady: [{ kind: "manufacturing_order", documentNumber: "TO-g", date: "2026-11-02" }] });
    expect(s).toMatchObject({ childOrderIds: [], externalReady: [{ kind: "purchase_order", documentNumber: "IO-1", date: "2026-11-05" }], undatedSupply: [], missingMaterial: [] });
  });

  it("a TO chosen under two parents is a child of both; undated supply and missing material are only named", () => {
    const rows = new Map([
      ...demandsByOrder,
      ["s", [demand("R", [alloc({ kind: "purchase_order", documentNumber: "IO-2", readyDate: null, undated: true })], 3), demand("T", [], 1)]],
    ]);
    const out = replanOrders(tree, new Set(["p", "g", "h", "s"]), rows, dueDateOf);
    expect(out.find((o) => o.manufacturingOrderId === "p")!.childOrderIds).toEqual(["h", "g"]);
    expect(out.find((o) => o.manufacturingOrderId === "h")!.childOrderIds).toEqual(["s", "g"]);
    expect(out.find((o) => o.manufacturingOrderId === "s")).toMatchObject({
      externalReady: [],
      undatedSupply: [{ kind: "purchase_order", documentNumber: "IO-2" }],
      missingMaterial: [{ articleNumber: "R" }, { articleNumber: "T" }],
    });
  });
});

describe("sameReplanExpected", () => {
  const row = (id: string, over: Partial<ReplanExpectedOrder> = {}): ReplanExpectedOrder => ({
    manufacturingOrderId: id,
    dueDate: "2026-12-01",
    plannedStartDate: "2026-11-02",
    plannedEndDate: "2026-11-03",
    ...over,
  });
  it("the same TOs with the same dates, in any order", () => {
    expect(sameReplanExpected([row("a"), row("b")], [row("b"), row("a")])).toBe(true);
    expect(sameReplanExpected([row("a"), row("b")], [row("a")])).toBe(false);
    expect(sameReplanExpected([row("a")], [row("a"), row("b")])).toBe(false);
    expect(sameReplanExpected([row("a"), row("b")], [row("a"), row("c")])).toBe(false);
    for (const over of [{ dueDate: null }, { plannedStartDate: null }, { plannedEndDate: "2026-11-04" }]) {
      expect(sameReplanExpected([row("a")], [row("a", over)])).toBe(false);
    }
  });
});

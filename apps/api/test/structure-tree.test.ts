import { describe, expect, it } from "vitest";
import { buildArticleOverview, type ArticleOverviewInput } from "../src/modules/planning/service/article-overview.js";
import type { PlanWorkCenter } from "../src/modules/planning/service/capacity-book.js";
import { operationLoadDays, type CapacityOperationRow } from "../src/modules/planning/service/capacity-calc.js";
import { moveCandidates } from "../src/modules/planning/service/component-moves.js";
import { orderOutlook, outlookRow, type OutlookAllocation, type OutlookRowFacts } from "../src/modules/planning/service/delivery-outlook.js";
import { pegOverview, type PegDemand, type Pegging } from "../src/modules/planning/service/pegging.js";
import {
  buildStructureTree,
  exclusiveOrderIds,
  nextStructureLevel,
  STRUCTURE_MAX_DEPTH,
  STRUCTURE_MAX_NODES,
  structureDemands,
  type StructureDemand,
  type StructureDemandSource,
  type StructureGoesTo,
  type StructureInput,
  type StructureNode,
  type StructureOrderFacts,
  type StructureOrderNode,
} from "../src/modules/planning/service/structure-tree.js";

// Pure tests — no database. Strukturvyn (etapp 4): the tree is built from
// peggings loaded elsewhere, so the fixtures peg real overviews
// (buildArticleOverview → pegOverview) and map them with structureDemands,
// exactly as the service will level by level.

const TODAY = "2030-03-04"; // Monday
const NO_HOLIDAYS = new Set<string>();

type ArticleType = "manufactured" | "purchased" | "service";
const article = (articleId: string, articleNumber: string, type: ArticleType = "manufactured") => ({
  articleId,
  articleNumber,
  name: `Artikel ${articleNumber}`,
  type,
  isPhantom: false,
  active: true,
  unitCode: "st",
  reorderPoint: null,
  orderQuantity: null,
  rounding: null,
});

function overview(partial: Partial<ArticleOverviewInput> & Pick<ArticleOverviewInput, "article">) {
  return buildArticleOverview({
    onHand: 0,
    salesRows: [],
    purchaseRows: [],
    manufacturingOrders: [],
    materialRows: [],
    plannedMos: [],
    bomEdges: [],
    phantomIds: [],
    primarySupplier: null,
    ...partial,
  });
}

function materialRow(rowId: string, moId: string, orderNumber: string, needDate: string | null, quantity: number) {
  return {
    rowId,
    moId,
    orderNumber,
    orderStatus: "released" as const,
    dueDate: needDate,
    needDate,
    parentArticleId: `parent-${moId}`,
    parentArticleNumber: "P",
    parentArticleName: "Produkt",
    quantityPlanned: quantity,
    quantityConsumed: 0,
  };
}

const mo = (moId: string, orderNumber: string, dueDate: string | null, quantity: number) => ({
  moId,
  orderNumber,
  status: "released" as const,
  dueDate,
  quantity,
});

function po(rowId: string, orderNumber: string, date: string | null, quantity: number, status: "confirmed" | "draft" = "confirmed") {
  return {
    rowId,
    purchaseOrderId: `po-${rowId}`,
    orderNumber,
    orderStatus: status,
    supplierName: "Lev",
    expectedDeliveryDate: date,
    quantityOrdered: quantity,
    quantityReceived: 0,
  };
}

// A pegged set of articles — the half of the service's PeggedParents the
// tree needs.
type World = Map<string, { article: ReturnType<typeof article>; pegging: Pegging }>;
function world(overviews: ReturnType<typeof overview>[], readyDates: [string, string | null][] = []): World {
  return new Map(
    overviews.map((o) => [
      o.article.articleId,
      { article: o.article as ReturnType<typeof article>, pegging: pegOverview(o, { today: TODAY, readyDates: new Map(readyDates), offDays: NO_HOLIDAYS }) },
    ])
  );
}

// The service's parentDemands: the demand rows whose document is the parent.
function sourcesOf(w: World, parentId: string): StructureDemandSource[] {
  const out: StructureDemandSource[] = [];
  for (const { article: a, pegging } of w.values()) {
    for (const demand of pegging.demands) {
      if (demand.row && demand.row.documentId === parentId && demand.row.kind === "mo_material") out.push({ article: a, pegging, demand });
    }
  }
  return out;
}

const demandsFor = (w: World, parentIds: string[]) => new Map(parentIds.map((id) => [id, structureDemands(id, sourcesOf(w, id))]));

function facts(id: string, orderNumber: string, articleNumber: string, extra: Partial<StructureOrderFacts> = {}): StructureOrderFacts {
  return {
    manufacturingOrderId: id,
    orderNumber,
    orderStatus: "released",
    articleId: articleNumber.toLowerCase(),
    articleNumber,
    articleName: `Artikel ${articleNumber}`,
    remainingQuantity: 10,
    dueDate: null,
    plan: null,
    componentLate: false,
    ...extra,
  };
}

const factsMap = (...list: StructureOrderFacts[]) => new Map(list.map((f) => [f.manufacturingOrderId, f]));

function treeInput(partial: Partial<StructureInput> & Pick<StructureInput, "root">): StructureInput {
  return {
    today: TODAY,
    offDays: NO_HOLIDAYS,
    demandsByOrder: new Map(),
    orders: new Map(),
    operations: [],
    workCenters: new Map(),
    stamped: new Set(),
    ...partial,
  };
}

const toRoot = (id: string, goesTo: StructureGoesTo[] = []) => ({ kind: "manufacturing_order" as const, manufacturingOrderId: id, goesTo });

const orderNodes = (nodes: StructureNode[]) => nodes.filter((n): n is StructureOrderNode => n.kind === "order");
const outline = (nodes: StructureNode[]) => nodes.map((n) => `${n.level}:${n.kind}:${n.id}`);

function op(overrides: Partial<CapacityOperationRow>): CapacityOperationRow {
  return {
    moOperationId: `op-${overrides.manufacturingOrderId ?? "mo"}-${overrides.sequenceNo ?? 10}`,
    manufacturingOrderId: "mo-p",
    orderNumber: "TO-1",
    articleNumber: "P",
    articleName: "Artikel P",
    workCenterId: "wc-1",
    orderQuantity: 10,
    dueDate: null,
    sequenceNo: 10,
    setupTime: 0,
    runTimePerUnit: 6,
    operationStatus: "pending",
    quantityCompleted: null,
    quantityScrapped: 0,
    ...overrides,
  };
}

function workCenter(overrides: Partial<PlanWorkCenter> = {}): PlanWorkCenter {
  return {
    workCenterId: "wc-1",
    code: "110",
    name: "Skär",
    type: "machine",
    weekScheduleId: null,
    hoursPerDay: 8,
    capacityFactor: 1,
    leadTimeDays: null,
    queueTimeDays: null,
    ...overrides,
  };
}

// P (TO-1) needs H (halvfabrikat), 2 and 10 (purchased) and R (purchased,
// nothing at all). H's TO-2 is ready a day after P needs it and needs S,
// whose TO-3 needs the raw material RM on a late inköpsorder.
function chain() {
  const w = world(
    [
      overview({
        article: article("h", "H"),
        manufacturingOrders: [mo("mo-h", "TO-2", "2030-03-08", 10)],
        materialRows: [materialRow("p-h", "mo-p", "TO-1", "2030-03-11", 10)],
      }),
      overview({ article: article("a2", "2", "purchased"), onHand: 50, materialRows: [materialRow("p-2", "mo-p", "TO-1", "2030-03-11", 20)] }),
      overview({
        article: article("a10", "10", "purchased"),
        onHand: 3,
        purchaseRows: [po("io1", "IO-1", "2030-03-08", 4, "draft")],
        materialRows: [materialRow("p-10", "mo-p", "TO-1", "2030-03-11", 9)],
      }),
      overview({ article: article("r", "R", "purchased"), materialRows: [materialRow("p-r", "mo-p", "TO-1", "2030-03-11", 4)] }),
      overview({
        article: article("s", "S"),
        manufacturingOrders: [mo("mo-s", "TO-3", "2030-03-06", 5)],
        materialRows: [materialRow("h-s", "mo-h", "TO-2", "2030-03-07", 5)],
      }),
      overview({
        article: article("rm", "RM", "purchased"),
        purchaseRows: [po("io2", "IO-2", "2030-03-07", 8)],
        materialRows: [materialRow("s-rm", "mo-s", "TO-3", "2030-03-05", 8)],
      }),
    ],
    [["mo:mo-h", "2030-03-12"]]
  );
  const orders = factsMap(
    facts("mo-p", "TO-1", "P", { dueDate: "2030-03-15", componentLate: true }),
    facts("mo-h", "TO-2", "H", {
      dueDate: "2030-03-08",
      plan: { plannedStartDate: "2030-03-11", plannedEndDate: "2030-03-12", late: true, plannedFinish: "2030-03-12" },
    }),
    facts("mo-s", "TO-3", "S", { dueDate: "2030-03-06", remainingQuantity: 5 })
  );
  return { w, orders, demandsByOrder: demandsFor(w, ["mo-p", "mo-h", "mo-s"]) };
}

describe("buildStructureTree — a TO at the top", () => {
  it("TO → material → TO → inköpsorder / stock / missing: flat, depth first, materials by article number (2 before 10)", () => {
    const { orders, demandsByOrder } = chain();
    const result = buildStructureTree(treeInput({ root: toRoot("mo-p"), orders, demandsByOrder }));

    expect(result.root).toEqual({ kind: "manufacturing_order", manufacturingOrderId: "mo-p", orderNumber: "TO-1" });
    expect(outline(result.nodes)).toEqual([
      "0:order:mo:mo-p",
      "1:material:mat:p-2",
      "2:supply:mat:p-2/stock",
      "1:material:mat:p-10",
      "2:supply:mat:p-10/stock",
      "2:supply:mat:p-10/po:1",
      "2:missing:mat:p-10/missing",
      "1:material:mat:p-h",
      "2:order:mo:mo-h",
      "3:material:mat:h-s",
      "4:order:mo:mo-s",
      "5:material:mat:s-rm",
      "6:supply:mat:s-rm/po:0",
      "1:material:mat:p-r",
      "2:missing:mat:p-r/missing",
    ]);
    // Every node hangs on the node before it one level up.
    for (const node of result.nodes.slice(1)) {
      const parent = result.nodes.find((n) => n.id === node.parentId)!;
      expect(parent.level).toBe(node.level - 1);
    }
    expect(new Set(result.nodes.map((n) => n.id)).size).toBe(result.nodes.length);
    expect(result.truncated).toEqual({ depth: false, nodes: false, cycle: [] });
    expect(result.totals).toEqual({ orders: 3, lateOrders: 1, componentLate: 1, lockedOperations: 0, missing: 2 });
    expect(result.goesTo).toEqual([]);
  });

  it("the material rows are the pegging's demands; stock-only material is flagged, the uncovered rest is a missing leaf", () => {
    const { orders, demandsByOrder } = chain();
    const { nodes } = buildStructureTree(treeInput({ root: toRoot("mo-p"), orders, demandsByOrder }));
    const material = (id: string) => nodes.find((n) => n.id === id) as Extract<StructureNode, { kind: "material" }>;

    expect(material("mat:p-2")).toMatchObject({
      materialRowId: "mat:p-2",
      articleNumber: "2",
      articleType: "purchased",
      needDate: "2030-03-11",
      quantity: 20,
      uncovered: 0,
      fromStockOnly: true,
    });
    // Stock and an inköpsorder, and still 2 short.
    expect(material("mat:p-10")).toMatchObject({ quantity: 9, uncovered: 2, fromStockOnly: false });
    expect(nodes.find((n) => n.id === "mat:p-10/stock")).toMatchObject({ supply: "stock", documentId: null, quantity: 3, late: false });
    expect(nodes.find((n) => n.id === "mat:p-10/po:1")).toMatchObject({
      supply: "purchase_order",
      documentId: "po-io1",
      documentNumber: "IO-1",
      quantity: 4,
      readyDate: "2030-03-08",
      isDraft: true,
    });
    expect(nodes.find((n) => n.id === "mat:p-10/missing")).toEqual({
      kind: "missing",
      id: "mat:p-10/missing",
      parentId: "mat:p-10",
      level: 2,
      quantity: 2,
      manufacturable: false,
    });
    // Nothing covers R at all: not stock-only, a missing leaf alone.
    expect(material("mat:p-r")).toMatchObject({ uncovered: 4, fromStockOnly: false });
    // A halvfabrikat covered by a TO is not stock-only.
    expect(material("mat:p-h").fromStockOnly).toBe(false);
  });

  it("a missing manufactured article is manufacturable", () => {
    const w = world([overview({ article: article("h", "H"), materialRows: [materialRow("p-h", "mo-p", "TO-1", "2030-03-11", 10)] })]);
    const { nodes } = buildStructureTree(
      treeInput({ root: toRoot("mo-p"), orders: factsMap(facts("mo-p", "TO-1", "P")), demandsByOrder: demandsFor(w, ["mo-p"]) })
    );
    expect(nodes.at(-1)).toMatchObject({ kind: "missing", quantity: 10, manufacturable: true });
  });

  it("late marks are the pegging's flags and the plan summary's Sen — never a comparison of its own", () => {
    const { w, orders, demandsByOrder } = chain();
    const { nodes } = buildStructureTree(treeInput({ root: toRoot("mo-p"), orders, demandsByOrder }));

    // TO-2 against P's need: the allocation in H's pegging.
    const hDemand = w.get("h")!.pegging.demands.find((d) => d.id === "mat:p-h")!;
    const hAllocation = hDemand.allocations[0]!;
    expect(hAllocation).toMatchObject({ late: true, daysLate: 1 });
    const toH = orderNodes(nodes).find((n) => n.manufacturingOrderId === "mo-h")!;
    expect(toH.link).toEqual({
      quantity: hAllocation.quantity,
      needDate: hDemand.date,
      late: hAllocation.late,
      undated: hAllocation.undated,
      daysLate: hAllocation.daysLate,
      exclusive: true,
    });
    // The TO's own Sen and dates are the summary's.
    expect(toH).toMatchObject({ late: true, plannedStartDate: "2030-03-11", plannedEndDate: "2030-03-12", plannedFinish: "2030-03-12", dueDate: "2030-03-08" });
    // TO-3 is in time for H although its due date has no plan behind it.
    const toS = orderNodes(nodes).find((n) => n.manufacturingOrderId === "mo-s")!;
    expect(toS).toMatchObject({ late: false, plannedFinish: null });
    expect(toS.link).toMatchObject({ late: false, daysLate: 0, needDate: "2030-03-07" });
    // The inköpsorder leaf: the allocation's flags, two working days late.
    const rmAllocation = w.get("rm")!.pegging.demands.find((d) => d.id === "mat:s-rm")!.allocations[0]!;
    expect(nodes.find((n) => n.id === "mat:s-rm/po:0")).toMatchObject({
      late: rmAllocation.late,
      undated: rmAllocation.undated,
      daysLate: rmAllocation.daysLate,
      readyDate: rmAllocation.readyDate,
    });
    expect(rmAllocation).toMatchObject({ late: true, daysLate: 2 });
    // The root has no link; componentLate is the fact it was fed.
    expect(nodes[0]).toMatchObject({ link: null, componentLate: true, late: false });
  });

  it("an undated supply is undated, not late", () => {
    const w = world([
      overview({
        article: article("x", "X", "purchased"),
        purchaseRows: [po("io1", "IO-1", null, 5)],
        materialRows: [materialRow("p-x", "mo-p", "TO-1", "2030-03-11", 5)],
      }),
    ]);
    const { nodes } = buildStructureTree(
      treeInput({ root: toRoot("mo-p"), orders: factsMap(facts("mo-p", "TO-1", "P")), demandsByOrder: demandsFor(w, ["mo-p"]) })
    );
    expect(nodes.at(-1)).toMatchObject({ kind: "supply", readyDate: null, undated: true, late: false, daysLate: 0 });
  });

  it("link.exclusive is moveCandidates' answer on the same pegging", () => {
    // TO-2 (10 of H) covers P's need of 6 and another TO's need of 4; TO-5
    // covers only P.
    const w = world([
      overview({
        article: article("h", "H"),
        manufacturingOrders: [mo("mo-h", "TO-2", "2030-03-06", 10), mo("mo-h2", "TO-5", "2030-03-20", 3)],
        materialRows: [materialRow("o-h", "mo-other", "TO-9", "2030-03-08", 4), materialRow("p-h", "mo-p", "TO-1", "2030-03-11", 9)],
      }),
    ]);
    const isParentDemand = (d: PegDemand) => d.row?.documentId === "mo-p";
    const { article: a, pegging } = w.get("h")!;
    const candidates = moveCandidates(pegging, a, isParentDemand);
    expect(candidates.map((c) => [c.manufacturingOrderId, c.exclusive])).toEqual([
      ["mo-h", false],
      ["mo-h2", true],
    ]);
    expect([...exclusiveOrderIds(pegging, a, isParentDemand)]).toEqual(["mo-h2"]);

    const { nodes } = buildStructureTree(
      treeInput({
        root: toRoot("mo-p"),
        orders: factsMap(facts("mo-p", "TO-1", "P"), facts("mo-h", "TO-2", "H"), facts("mo-h2", "TO-5", "H")),
        demandsByOrder: demandsFor(w, ["mo-p"]),
      })
    );
    for (const c of candidates) {
      const node = orderNodes(nodes).find((n) => n.manufacturingOrderId === c.manufacturingOrderId)!;
      expect(node.link!.exclusive).toBe(c.exclusive);
    }
    // Two TOs under ONE material row, in the pegging's allocation order.
    expect(outline(nodes)).toEqual(["0:order:mo:mo-p", "1:material:mat:p-h", "2:order:mo:mo-h", "2:order:mo:mo-h2"]);
    expect(orderNodes(nodes).map((n) => n.link?.quantity ?? null)).toEqual([null, 6, 3]);
  });

  it("a TO covering two places is drawn once; the second place is a repeat without operations or children (S25)", () => {
    // P needs H and S, H needs S, ONE TO of S covers both.
    const w = world([
      overview({
        article: article("h", "H"),
        manufacturingOrders: [mo("mo-h", "TO-2", "2030-03-08", 10)],
        materialRows: [materialRow("p-h", "mo-p", "TO-1", "2030-03-11", 10)],
      }),
      overview({
        article: article("s", "S"),
        manufacturingOrders: [mo("mo-s", "TO-3", "2030-03-06", 20)],
        materialRows: [materialRow("h-s", "mo-h", "TO-2", "2030-03-07", 12), materialRow("p-s", "mo-p", "TO-1", "2030-03-11", 8)],
      }),
      overview({ article: article("rm", "RM", "purchased"), onHand: 99, materialRows: [materialRow("s-rm", "mo-s", "TO-3", "2030-03-05", 8)] }),
    ]);
    const operations = [op({ manufacturingOrderId: "mo-s", sequenceNo: 10, planLocked: true, plannedDays: [{ date: "2030-03-05", minutes: 60 }] })];
    const result = buildStructureTree(
      treeInput({
        root: toRoot("mo-p"),
        orders: factsMap(facts("mo-p", "TO-1", "P"), facts("mo-h", "TO-2", "H"), facts("mo-s", "TO-3", "S")),
        demandsByOrder: demandsFor(w, ["mo-p", "mo-h", "mo-s"]),
        operations,
        workCenters: new Map([["wc-1", workCenter()]]),
      })
    );
    expect(outline(result.nodes)).toEqual([
      "0:order:mo:mo-p",
      "1:material:mat:p-h",
      "2:order:mo:mo-h",
      "3:material:mat:h-s",
      "4:order:mo:mo-s",
      "5:material:mat:s-rm",
      "6:supply:mat:s-rm/stock",
      "1:material:mat:p-s",
      "2:order:mat:p-s/mo:mo-s",
    ]);
    const [first, repeat] = orderNodes(result.nodes).filter((n) => n.manufacturingOrderId === "mo-s");
    expect(first).toMatchObject({ repeatOf: null, lockedOperations: 1 });
    expect(first!.operations).toHaveLength(1);
    expect(first!.link).toMatchObject({ quantity: 12, needDate: "2030-03-07", exclusive: false });
    expect(repeat).toMatchObject({ repeatOf: "mo:mo-s", operations: [], orderNumber: "TO-3", articleNumber: "S" });
    // The repeat's link is its own place's.
    expect(repeat!.link).toMatchObject({ quantity: 8, needDate: "2030-03-11", exclusive: false });
    // Counted once.
    expect(result.totals).toMatchObject({ orders: 3, lockedOperations: 1 });
    expect(result.truncated.cycle).toEqual([]);
  });

  it("the cycle guard: a TO whose article is already on the path is drawn without children", () => {
    // TO-1 (article A) needs B from TO-2, which needs A from TO-3.
    const w = world([
      overview({
        article: article("b", "B"),
        manufacturingOrders: [mo("mo-b", "TO-2", "2030-03-08", 5)],
        materialRows: [materialRow("a-b", "mo-a", "TO-1", "2030-03-11", 5)],
      }),
      overview({
        article: article("a", "A"),
        manufacturingOrders: [mo("mo-a2", "TO-3", "2030-03-06", 5)],
        materialRows: [materialRow("b-a", "mo-b", "TO-2", "2030-03-07", 5)],
      }),
      overview({
        article: article("c", "C", "purchased"),
        onHand: 9,
        materialRows: [materialRow("a2-c", "mo-a2", "TO-3", "2030-03-05", 5)],
      }),
    ]);
    const result = buildStructureTree(
      treeInput({
        root: toRoot("mo-a"),
        orders: factsMap(facts("mo-a", "TO-1", "A"), facts("mo-b", "TO-2", "B"), facts("mo-a2", "TO-3", "A")),
        demandsByOrder: demandsFor(w, ["mo-a", "mo-b", "mo-a2"]),
      })
    );
    expect(outline(result.nodes)).toEqual(["0:order:mo:mo-a", "1:material:mat:a-b", "2:order:mo:mo-b", "3:material:mat:b-a", "4:order:mo:mo-a2"]);
    expect(result.truncated).toEqual({ depth: false, nodes: false, cycle: ["A"] });
  });

  // A straight chain of TOs built by hand: TO n needs article n+1, covered
  // by TO n+1.
  function straightChain(length: number) {
    const orders = new Map<string, StructureOrderFacts>();
    const demandsByOrder = new Map<string, StructureDemand[]>();
    for (let n = 0; n < length; n++) {
      orders.set(`mo-${n}`, facts(`mo-${n}`, `TO-${n}`, `A${n}`));
      demandsByOrder.set(
        `mo-${n}`,
        n === length - 1
          ? []
          : [
              {
                rowId: `mat:${n}`,
                articleId: `a${n + 1}`,
                articleNumber: `A${n + 1}`,
                articleName: `Artikel A${n + 1}`,
                articleType: "manufactured",
                needDate: null,
                quantity: 1,
                uncovered: 0,
                allocations: [
                  {
                    kind: "manufacturing_order",
                    documentId: `mo-${n + 1}`,
                    documentNumber: `TO-${n + 1}`,
                    quantity: 1,
                    readyDate: null,
                    late: false,
                    undated: false,
                    daysLate: 0,
                    isDraft: false,
                    exclusive: true,
                  },
                ],
              },
            ]
      );
    }
    return { orders, demandsByOrder };
  }

  it("the depth cap: the TO on level STRUCTURE_MAX_DEPTH is drawn without children and the flag is set", () => {
    const deep = buildStructureTree(treeInput({ root: toRoot("mo-0"), ...straightChain(STRUCTURE_MAX_DEPTH + 3) }));
    expect(orderNodes(deep.nodes).map((n) => n.orderNumber)).toEqual(Array.from({ length: STRUCTURE_MAX_DEPTH + 1 }, (_, n) => `TO-${n}`));
    expect(deep.nodes.at(-1)).toMatchObject({ kind: "order", orderNumber: `TO-${STRUCTURE_MAX_DEPTH}` });
    expect(deep.truncated).toEqual({ depth: true, nodes: false, cycle: [] });

    // Exactly as deep as allowed, and the last TO has nothing below: whole.
    const exact = buildStructureTree(treeInput({ root: toRoot("mo-0"), ...straightChain(STRUCTURE_MAX_DEPTH + 1) }));
    expect(orderNodes(exact.nodes)).toHaveLength(STRUCTURE_MAX_DEPTH + 1);
    expect(exact.truncated.depth).toBe(false);

    // A level the service never loaded may hide something: flagged.
    const { orders, demandsByOrder } = straightChain(STRUCTURE_MAX_DEPTH + 1);
    demandsByOrder.delete(`mo-${STRUCTURE_MAX_DEPTH}`);
    expect(buildStructureTree(treeInput({ root: toRoot("mo-0"), orders, demandsByOrder })).truncated.depth).toBe(true);
  });

  it("the node cap: past STRUCTURE_MAX_NODES the TOs are drawn without children and the flag is set", () => {
    // The root has 350 material rows, each covered by a TO with one
    // material row of its own in stock.
    const orders = factsMap(facts("mo-p", "TO-1", "P"));
    const demandsByOrder = new Map<string, StructureDemand[]>();
    const rootDemands: StructureDemand[] = [];
    const base = { needDate: null, quantity: 1, uncovered: 0 };
    const allocation = { quantity: 1, readyDate: null, late: false, undated: false, daysLate: 0, isDraft: false };
    for (let n = 0; n < 350; n++) {
      const number = String(1000 + n);
      orders.set(`mo-${n}`, facts(`mo-${n}`, `TO-C${n}`, number));
      rootDemands.push({
        ...base,
        rowId: `mat:p-${number}`,
        articleId: number,
        articleNumber: number,
        articleName: `Artikel ${number}`,
        articleType: "manufactured",
        allocations: [{ ...allocation, kind: "manufacturing_order", documentId: `mo-${n}`, documentNumber: `TO-C${n}`, exclusive: true }],
      });
      demandsByOrder.set(`mo-${n}`, [
        {
          ...base,
          rowId: `mat:c-${number}`,
          articleId: "rm",
          articleNumber: "RM",
          articleName: "Råmaterial",
          articleType: "purchased",
          allocations: [{ ...allocation, kind: "stock", documentId: null, documentNumber: null, readyDate: TODAY, exclusive: false }],
        },
      ]);
    }
    demandsByOrder.set("mo-p", rootDemands);
    const result = buildStructureTree(treeInput({ root: toRoot("mo-p"), orders, demandsByOrder }));

    expect(result.truncated).toEqual({ depth: false, nodes: true, cycle: [] });
    // Every TO is still there — only the children are cut.
    expect(result.totals.orders).toBe(351);
    const withChildren = new Set(result.nodes.filter((n) => n.kind === "material" && n.parentId !== "mo:mo-p").map((n) => n.parentId));
    expect(withChildren.size).toBeGreaterThan(0);
    expect(withChildren.size).toBeLessThan(350);
    // The cap is checked when a TO is about to get its children: the first
    // TO without them is the first one drawn at or past the cap, and none
    // after it gets any.
    const firstCut = result.nodes.findIndex((n) => n.kind === "order" && n.parentId !== null && !withChildren.has(n.id));
    expect(firstCut).toBeGreaterThanOrEqual(STRUCTURE_MAX_NODES - 1);
    expect(firstCut).toBeLessThan(STRUCTURE_MAX_NODES + 4);
    expect(result.nodes.slice(firstCut).every((n) => n.parentId === "mo:mo-p" || (n.kind === "order" && !withChildren.has(n.id)))).toBe(true);

    // Under the cap nothing is cut.
    const small = new Map([...demandsByOrder].map(([id, list]) => [id, id === "mo-p" ? list.slice(0, 100) : list]));
    expect(buildStructureTree(treeInput({ root: toRoot("mo-p"), orders, demandsByOrder: small })).truncated.nodes).toBe(false);
  });

  it("a closed TO at the top is the root alone; Går till is passed through as data (S24)", () => {
    const goesTo: StructureGoesTo[] = [
      { kind: "sales_order", documentId: "so-1", documentNumber: "KO-1", partner: "Kund", needDate: "2030-03-20", quantity: 4, late: false, daysLate: 0 },
      { kind: "mo_material", documentId: "mo-x", documentNumber: "TO-7", partner: "Artikel X", needDate: "2030-03-12", quantity: 6, late: true, daysLate: 2 },
    ];
    const result = buildStructureTree(
      treeInput({
        root: toRoot("mo-p", goesTo),
        orders: factsMap(facts("mo-p", "TO-1", "P", { orderStatus: "closed" })),
        demandsByOrder: new Map([["mo-p", []]]),
      })
    );
    expect(outline(result.nodes)).toEqual(["0:order:mo:mo-p"]);
    expect(result.nodes[0]).toMatchObject({ orderStatus: "closed", parentId: null });
    expect(result.goesTo).toEqual(goesTo);
    expect(result.truncated).toEqual({ depth: false, nodes: false, cycle: [] });
  });

  it("a TO supply without loaded facts is drawn from what the allocation knows", () => {
    const { demandsByOrder } = chain();
    const { nodes } = buildStructureTree(
      treeInput({ root: toRoot("mo-p"), orders: factsMap(facts("mo-p", "TO-1", "P")), demandsByOrder: new Map([["mo-p", demandsByOrder.get("mo-p")!]]) })
    );
    expect(orderNodes(nodes).find((n) => n.manufacturingOrderId === "mo-h")).toMatchObject({
      orderNumber: "TO-2",
      articleId: "h",
      articleNumber: "H",
      orderStatus: "",
      remainingQuantity: 10,
      late: false,
    });
    expect(() => buildStructureTree(treeInput({ root: toRoot("mo-unknown") }))).toThrow(/no facts for the root order/);
  });
});

describe("buildStructureTree — operations", () => {
  const workCenters = new Map([
    ["wc-1", workCenter()],
    ["wc-lego", workCenter({ workCenterId: "wc-lego", code: "900", name: "Ytbehandling", type: "subcontract", hoursPerDay: null, leadTimeDays: 3, queueTimeDays: 1.5 })],
  ]);

  it("the bars are operationLoadDays for the same operation, in hours; a passed day is clamped to today", () => {
    const planned = op({
      sequenceNo: 20,
      description: "Skär",
      planLocked: true,
      plannedDays: [
        { date: "2030-03-01", minutes: 30 }, // passed
        { date: "2030-03-05", minutes: 15 },
        { date: "2030-03-06", minutes: 15 },
      ],
    });
    const unplanned = op({ sequenceNo: 10, dueDate: "2030-03-12", quantityCompleted: 4 });
    const done = op({ sequenceNo: 30, operationStatus: "done", planLocked: true });
    const undated = op({ sequenceNo: 40 });
    const result = buildStructureTree(
      treeInput({
        root: toRoot("mo-p"),
        orders: factsMap(facts("mo-p", "TO-1", "P")),
        demandsByOrder: new Map([["mo-p", []]]),
        operations: [planned, unplanned, done, undated],
        workCenters,
        stamped: new Set([undated.moOperationId]),
      })
    );
    const root = result.nodes[0] as StructureOrderNode;
    // In sequence order.
    expect(root.operations.map((o) => o.sequenceNo)).toEqual([10, 20, 30, 40]);
    const [o10, o20, o30, o40] = root.operations;

    for (const [node, source] of [
      [o10, unplanned],
      [o20, planned],
      [o30, done],
    ] as const) {
      expect(node!.days).toEqual(operationLoadDays(source, TODAY).map((d) => ({ date: d.date, hours: Math.round((d.minutes / 60) * 100) / 100 })));
    }
    expect(o20!.days.every((d) => d.date >= TODAY)).toBe(true);
    expect(o20!.days.reduce((sum, d) => sum + d.hours, 0)).toBe(1);
    expect(o20).toMatchObject({
      description: "Skär",
      workCenterCode: "110",
      workCenterName: "Skär",
      subcontract: false,
      subcontractDays: null,
      planLocked: true,
      plannedStartDate: "2030-03-01",
      plannedEndDate: "2030-03-06",
      remainingHours: 1,
      started: false,
    });
    // Unplanned: one bucket on the due date; reported on ⇒ started.
    expect(o10).toMatchObject({ days: [{ date: "2030-03-12", hours: 0.6 }], started: true, remainingHours: 0.6, plannedStartDate: null });
    expect(o30).toMatchObject({ status: "done", days: [], remainingHours: 0 });
    // Neither planned nor dated: nothing to draw; stamped ⇒ started.
    expect(o40).toMatchObject({ days: [], started: true });
    // Only pending locked operations count.
    expect(root.lockedOperations).toBe(1);
    expect(result.totals.lockedOperations).toBe(1);
  });

  it("a lego operation has no bars, only its days (S26)", () => {
    const lego = op({ sequenceNo: 20, workCenterId: "wc-lego", dueDate: "2030-03-12", plannedDays: [{ date: "2030-03-06", minutes: 60 }] });
    const { nodes } = buildStructureTree(
      treeInput({
        root: toRoot("mo-p"),
        orders: factsMap(facts("mo-p", "TO-1", "P")),
        demandsByOrder: new Map([["mo-p", []]]),
        operations: [lego],
        workCenters,
      })
    );
    expect((nodes[0] as StructureOrderNode).operations[0]).toMatchObject({
      subcontract: true,
      subcontractDays: 5, // ceil(3 + 1.5)
      days: [],
      workCenterCode: "900",
    });
  });
});

describe("buildStructureTree — a kundorder at the top", () => {
  const rowFacts = (id: string, articleNumber: string, extra: Partial<OutlookRowFacts> = {}): OutlookRowFacts => ({
    salesOrderRowId: id,
    articleId: articleNumber.toLowerCase(),
    articleNumber,
    articleName: `Artikel ${articleNumber}`,
    restQuantity: 10,
    configured: false,
    promisedDate: "2030-03-14",
    promisedShipDate: "2030-03-13",
    ...extra,
  });
  const allocation = (extra: Partial<OutlookAllocation>): OutlookAllocation => ({
    kind: "stock",
    documentId: null,
    documentNumber: null,
    quantity: 1,
    readyDate: TODAY,
    late: false,
    undated: false,
    daysLate: 0,
    isDraft: false,
    componentLate: false,
    ...extra,
  });
  const deliver = (ship: string) => ship;

  it("several rows: each row with its TOs, stock, inköpsorder and missing rest; the TOs' trees below", () => {
    const { orders, demandsByOrder } = chain();
    const rows = [
      // Row 1: stock and the TO of P (late for the row).
      outlookRow({
        today: TODAY,
        row: rowFacts("r1", "P"),
        allocations: [
          allocation({ quantity: 4 }),
          allocation({ kind: "manufacturing_order", documentId: "mo-p", documentNumber: "TO-1", quantity: 6, readyDate: "2030-03-15", late: true, daysLate: 2, componentLate: true }),
        ],
        uncovered: 0,
        deliver,
      }),
      // Row 2: nothing covers it.
      outlookRow({ today: TODAY, row: rowFacts("r2", "Q", { restQuantity: 3 }), allocations: [], uncovered: 3, deliver }),
      // Row 3: a purchased article on an inköpsorder, partly.
      outlookRow({
        today: TODAY,
        row: rowFacts("r3", "10", { restQuantity: 5, promisedShipDate: null, promisedDate: null }),
        allocations: [allocation({ kind: "purchase_order", documentId: "po-9", documentNumber: "IO-9", quantity: 2, readyDate: null })],
        uncovered: 3,
        deliver,
      }),
      // Row 4: the same TO of P again — drawn once.
      outlookRow({
        today: TODAY,
        row: rowFacts("r4", "P", { promisedShipDate: "2030-03-20", promisedDate: "2030-03-21" }),
        allocations: [allocation({ kind: "manufacturing_order", documentId: "mo-p", documentNumber: "TO-1", quantity: 4, readyDate: "2030-03-15" })],
        uncovered: 0,
        deliver,
      }),
    ];
    const outlook = orderOutlook(rows, "2030-03-14");
    const result = buildStructureTree(
      treeInput({
        root: {
          kind: "sales_order",
          salesOrderId: "so-1",
          orderNumber: "KO-1",
          customerName: "Kund AB",
          outlook,
          rows: [
            { row: rows[0]!, manufacturable: true },
            { row: rows[1]!, manufacturable: true },
            { row: rows[2]!, manufacturable: false },
            { row: rows[3]!, manufacturable: true, exclusiveOrderIds: new Set(["mo-p"]) },
          ],
        },
        orders,
        demandsByOrder,
      })
    );

    expect(result.root).toEqual({ kind: "sales_order", salesOrderId: "so-1", orderNumber: "KO-1", customerName: "Kund AB", outlook });
    expect(result.goesTo).toEqual([]);
    // The rows in the order given, each with its own coverage.
    const top = result.nodes.filter((n) => n.level <= 1);
    expect(outline(top)).toEqual([
      "0:sales_row:row:r1",
      "1:supply:row:r1/stock",
      "1:order:mo:mo-p",
      "0:sales_row:row:r2",
      "1:missing:row:r2/missing",
      "0:sales_row:row:r3",
      "1:supply:row:r3/po:0",
      "1:missing:row:r3/missing",
      "0:sales_row:row:r4",
      "1:order:row:r4/mo:mo-p",
    ]);
    // The row node carries Leveransläget's row untouched.
    expect(result.nodes[0]).toEqual({ kind: "sales_row", id: "row:r1", parentId: null, level: 0, row: rows[0], orderNumber: "KO-1", customerName: "Kund AB" });
    // TO-1's whole tree hangs under row 1 (the chain: TO-2, TO-3 below it).
    const toP = result.nodes.find((n) => n.id === "mo:mo-p") as StructureOrderNode;
    expect(toP).toMatchObject({ parentId: "row:r1", level: 1, repeatOf: null });
    // The link is the row's allocation: need = the row's ship date, the
    // flags Leveransläget's.
    expect(toP.link).toEqual({ quantity: 6, needDate: "2030-03-13", late: true, undated: false, daysLate: 2, exclusive: false });
    expect(orderNodes(result.nodes).map((n) => `${n.level}:${n.orderNumber}`)).toEqual(["1:TO-1", "3:TO-2", "5:TO-3", "1:TO-1"]);
    const repeat = result.nodes.find((n) => n.id === "row:r4/mo:mo-p") as StructureOrderNode;
    expect(repeat).toMatchObject({ repeatOf: "mo:mo-p", operations: [] });
    expect(repeat.link).toEqual({ quantity: 4, needDate: "2030-03-20", late: false, undated: false, daysLate: 0, exclusive: true });
    // Nothing below the repeat.
    expect(result.nodes.at(-1)).toBe(repeat);
    // The leaves.
    expect(result.nodes.find((n) => n.id === "row:r2/missing")).toMatchObject({ quantity: 3, manufacturable: true });
    expect(result.nodes.find((n) => n.id === "row:r3/missing")).toMatchObject({ quantity: 3, manufacturable: false });
    expect(result.nodes.find((n) => n.id === "row:r3/po:0")).toMatchObject({ supply: "purchase_order", documentNumber: "IO-9", readyDate: null });
    expect(result.totals).toMatchObject({ orders: 3, missing: 4 });
  });

  it("the TOs under a kundorder row are level 1 of STRUCTURE_MAX_DEPTH", () => {
    // A chain as long as the cap allows below a TO root is one too long
    // below a row.
    const orders = new Map<string, StructureOrderFacts>();
    const demandsByOrder = new Map<string, StructureDemand[]>();
    for (let n = 0; n <= STRUCTURE_MAX_DEPTH; n++) {
      orders.set(`mo-${n}`, facts(`mo-${n}`, `TO-${n}`, `A${n}`));
      demandsByOrder.set(
        `mo-${n}`,
        n === STRUCTURE_MAX_DEPTH
          ? []
          : [
              {
                rowId: `mat:${n}`,
                articleId: `a${n + 1}`,
                articleNumber: `A${n + 1}`,
                articleName: "",
                articleType: "manufactured",
                needDate: null,
                quantity: 1,
                uncovered: 0,
                allocations: [
                  { kind: "manufacturing_order", documentId: `mo-${n + 1}`, documentNumber: `TO-${n + 1}`, quantity: 1, readyDate: null, late: false, undated: false, daysLate: 0, isDraft: false, exclusive: true },
                ],
              },
            ]
      );
    }
    const row = outlookRow({
      today: TODAY,
      row: rowFacts("r1", "A0"),
      allocations: [allocation({ kind: "manufacturing_order", documentId: "mo-0", documentNumber: "TO-0", readyDate: "2030-03-10" })],
      uncovered: 0,
      deliver,
    });
    const result = buildStructureTree(
      treeInput({
        root: { kind: "sales_order", salesOrderId: "so-1", orderNumber: "KO-1", customerName: "Kund", outlook: orderOutlook([row], null), rows: [{ row, manufacturable: true }] },
        orders,
        demandsByOrder,
      })
    );
    expect(orderNodes(result.nodes)).toHaveLength(STRUCTURE_MAX_DEPTH);
    expect(result.truncated.depth).toBe(true);
  });
});

describe("buildStructureTree — the axis", () => {
  const rootOnly = (extra: Partial<StructureOrderFacts>, operations: CapacityOperationRow[] = [], offDays = NO_HOLIDAYS) =>
    buildStructureTree(
      treeInput({
        root: toRoot("mo-p"),
        offDays,
        orders: factsMap(facts("mo-p", "TO-1", "P", extra)),
        demandsByOrder: new Map([["mo-p", []]]),
        operations,
        workCenters: new Map([["wc-1", workCenter()]]),
      })
    ).axis;

  it("at least 14 days from today when the tree has no dates, with weeks, weekdays and off days", () => {
    const axis = rootOnly({}, [], new Set(["2030-03-06"]));
    expect(axis.from).toBe(TODAY);
    expect(axis.to).toBe("2030-03-17");
    expect(axis.days).toHaveLength(14);
    expect(axis.days[0]).toEqual({ date: "2030-03-04", isoWeek: 10, weekday: 1, off: false });
    expect(axis.days[2]).toEqual({ date: "2030-03-06", isoWeek: 10, weekday: 3, off: true }); // holiday
    expect(axis.days[5]).toEqual({ date: "2030-03-09", isoWeek: 10, weekday: 6, off: true });
    expect(axis.days[6]).toEqual({ date: "2030-03-10", isoWeek: 10, weekday: 7, off: true });
    expect(axis.days[7]).toEqual({ date: "2030-03-11", isoWeek: 11, weekday: 1, off: false });
  });

  it("never before today: a passed date counts as today", () => {
    const axis = rootOnly({ dueDate: "2030-02-01" });
    expect(axis.from).toBe(TODAY);
    expect(axis.days).toHaveLength(14);
  });

  it("starts on the tree's earliest date and reaches its latest (planned days, finish, due date)", () => {
    const axis = rootOnly(
      { dueDate: "2030-04-10", plan: { plannedStartDate: "2030-03-11", plannedEndDate: "2030-03-12", late: false, plannedFinish: "2030-03-12" } },
      [op({ plannedDays: [{ date: "2030-03-11", minutes: 30 }, { date: "2030-03-12", minutes: 30 }] })]
    );
    expect(axis.from).toBe("2030-03-11");
    expect(axis.to).toBe("2030-04-10");
    expect(axis.days).toHaveLength(31);
  });

  it("at most 84 days: what lies later is outside the axis", () => {
    const axis = rootOnly({ dueDate: "2030-03-05", plan: { plannedStartDate: null, plannedEndDate: null, late: true, plannedFinish: "2031-01-15" } });
    expect(axis.from).toBe("2030-03-05");
    expect(axis.days).toHaveLength(84);
    expect(axis.to).toBe("2030-05-27");
    expect(axis.days.at(-1)!.date).toBe(axis.to);
  });

  it("need dates, inköpsorder dates and Går till count; stock's 'today' does not", () => {
    const w = world([
      overview({
        article: article("x", "X", "purchased"),
        onHand: 1,
        purchaseRows: [po("io1", "IO-1", "2030-04-02", 5)],
        materialRows: [materialRow("p-x", "mo-p", "TO-1", "2030-03-20", 6)],
      }),
    ]);
    const { axis } = buildStructureTree(
      treeInput({ root: toRoot("mo-p"), orders: factsMap(facts("mo-p", "TO-1", "P")), demandsByOrder: demandsFor(w, ["mo-p"]) })
    );
    expect(axis.from).toBe("2030-03-20");
    expect(axis.to).toBe("2030-04-02");
  });
});

describe("structureDemands and nextStructureLevel", () => {
  it("maps the parent's demands with the TO card's fields", () => {
    const { w } = chain();
    const demands = structureDemands("mo-p", sourcesOf(w, "mo-p"));
    expect(demands.map((d) => d.rowId).sort()).toEqual(["mat:p-10", "mat:p-2", "mat:p-h", "mat:p-r"]);
    expect(demands.find((d) => d.rowId === "mat:p-10")).toEqual({
      rowId: "mat:p-10",
      articleId: "a10",
      articleNumber: "10",
      articleName: "Artikel 10",
      articleType: "purchased",
      needDate: "2030-03-11",
      quantity: 9,
      uncovered: 2,
      allocations: [
        { kind: "stock", documentId: null, documentNumber: null, quantity: 3, readyDate: TODAY, late: false, undated: false, daysLate: 0, isDraft: false, exclusive: false },
        { kind: "purchase_order", documentId: "po-io1", documentNumber: "IO-1", quantity: 4, readyDate: "2030-03-08", late: false, undated: false, daysLate: 0, isDraft: true, exclusive: false },
      ],
    });
  });

  it("the next level is the TO supplies not expanded yet — one batch per level", () => {
    const { w } = chain();
    const level0 = structureDemands("mo-p", sourcesOf(w, "mo-p"));
    expect(nextStructureLevel(level0, new Set(["mo-p"]))).toEqual(["mo-h"]);
    const level1 = structureDemands("mo-h", sourcesOf(w, "mo-h"));
    expect(nextStructureLevel(level1, new Set(["mo-p", "mo-h"]))).toEqual(["mo-s"]);
    expect(nextStructureLevel(level1, new Set(["mo-p", "mo-h", "mo-s"]))).toEqual([]);
    const level2 = structureDemands("mo-s", sourcesOf(w, "mo-s"));
    expect(nextStructureLevel(level2, new Set(["mo-p", "mo-h", "mo-s"]))).toEqual([]);
  });
});

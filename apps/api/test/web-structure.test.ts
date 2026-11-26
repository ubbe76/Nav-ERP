import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ancestorIds,
  axisWeeks,
  barSegments,
  chunked,
  foldableIds,
  goesToLink,
  lockedOrderCount,
  markerIndex,
  moveTargetOf,
  nodeDates,
  nodeMarks,
  nodeTitle,
  operationDates,
  operationMovable,
  operationTitle,
  orderChildFacts,
  spanSegment,
  stockOnlyCount,
  structureOrderIds,
  totalsText,
  truncatedNotices,
  unlockStructureQuestion,
  visibleNodes,
  type StructureAxis,
  type StructureOrderNode,
} from "../../web/lib/structureTree.js";
import type { StructureNode, StructureOperation } from "../../web/lib/types.js";

// Strukturvyn (/tillverkning/struktur): the pure parts of the page
// (apps/web/lib/structureTree.ts) and the guards on the component. The tree
// itself is the API's (structure-tree.test.ts, structure.route.test.ts).

const TODAY = "2026-11-26"; // a Thursday

// Thursday 26 Nov … Wednesday 9 Dec 2026 (14 days), weekends off.
function axisFrom(from: string, days: number): StructureAxis {
  const out: StructureAxis["days"] = [];
  const start = Date.parse(`${from}T00:00:00Z`);
  for (let i = 0; i < days; i++) {
    const d = new Date(start + i * 86_400_000);
    const weekday = d.getUTCDay() || 7;
    // The week number is only grouped on — Monday starts a new one.
    const isoWeek = 48 + Math.floor((i + 3) / 7);
    out.push({ date: d.toISOString().slice(0, 10), isoWeek, weekday, off: weekday >= 6 });
  }
  return { from, to: out[out.length - 1]!.date, days: out };
}
const AXIS = axisFrom(TODAY, 14);

const operation = (over: Partial<StructureOperation> = {}): StructureOperation => ({
  moOperationId: "op-1",
  sequenceNo: 10,
  description: "Skär",
  workCenterId: "wc-1",
  workCenterCode: "110",
  workCenterName: "Laser",
  status: "pending",
  subcontract: false,
  subcontractDays: null,
  started: false,
  remainingHours: 6.5,
  planLocked: false,
  plannedStartDate: "2026-11-26",
  plannedEndDate: "2026-11-27",
  days: [
    { date: "2026-11-26", hours: 4.5 },
    { date: "2026-11-27", hours: 2 },
  ],
  ...over,
});

const order = (id: string, parentId: string | null, level: number, over: Partial<StructureOrderNode> = {}): StructureOrderNode => ({
  kind: "order",
  id: `mo:${id}`,
  parentId,
  level,
  manufacturingOrderId: id,
  orderNumber: `TO-${id}`,
  orderStatus: "released",
  articleId: `a-${id}`,
  articleNumber: `ART-${id}`,
  articleName: `Artikel ${id}`,
  remainingQuantity: 4,
  dueDate: "2026-12-04",
  plannedStartDate: "2026-11-26",
  plannedEndDate: "2026-11-27",
  plannedFinish: "2026-11-27",
  late: false,
  componentLate: false,
  link: null,
  repeatOf: null,
  lockedOperations: 0,
  operations: [],
  ...over,
});
const material = (id: string, parentId: string, level: number, fromStockOnly = false): StructureNode => ({
  kind: "material",
  id,
  parentId,
  level,
  materialRowId: id,
  articleId: `a-${id}`,
  articleNumber: `M-${id}`,
  articleName: `Material ${id}`,
  articleType: "purchased",
  needDate: "2026-12-01",
  quantity: 6,
  uncovered: 0,
  fromStockOnly,
});
const stock = (parentId: string, level: number): StructureNode => ({
  kind: "supply",
  id: `${parentId}/stock`,
  parentId,
  level,
  supply: "stock",
  documentId: null,
  documentNumber: null,
  quantity: 6,
  readyDate: TODAY,
  late: false,
  undated: false,
  daysLate: 0,
  isDraft: false,
});

// P → (mat:h → H → (mat:r → stock), mat:s → stock [stock only], mat:b → missing, mat:h2 → H again)
const TREE: StructureNode[] = [
  order("P", null, 0),
  material("mat:h", "mo:P", 1),
  order("H", "mat:h", 2, { lockedOperations: 2 }),
  material("mat:r", "mo:H", 3),
  stock("mat:r", 4),
  material("mat:s", "mo:P", 1, true),
  stock("mat:s", 2),
  { ...material("mat:b", "mo:P", 1), articleType: "manufactured", uncovered: 2 } as StructureNode,
  { kind: "missing", id: "mat:b/missing", parentId: "mat:b", level: 2, quantity: 2, manufacturable: true },
  material("mat:h2", "mo:P", 1),
  order("H", "mat:h2", 2, { id: "mat:h2/mo:H", repeatOf: "mo:H", lockedOperations: 2 }),
];
const ids = (nodes: StructureNode[]) => nodes.map((n) => n.id);

describe("visibleNodes", () => {
  it("hides the stock-only material and its leaf by default", () => {
    expect(ids(visibleNodes(TREE, new Set(), false))).toEqual([
      "mo:P", "mat:h", "mo:H", "mat:r", "mat:r/stock", "mat:b", "mat:b/missing", "mat:h2", "mat:h2/mo:H",
    ]);
    expect(visibleNodes(TREE, new Set(), true)).toHaveLength(TREE.length);
    expect(stockOnlyCount(TREE)).toBe(1);
  });

  it("a collapsed node hides its whole branch, however deep", () => {
    expect(ids(visibleNodes(TREE, new Set(["mat:h"]), true))).toEqual([
      "mo:P", "mat:h", "mat:s", "mat:s/stock", "mat:b", "mat:b/missing", "mat:h2", "mat:h2/mo:H",
    ]);
    expect(ids(visibleNodes(TREE, new Set(["mo:P"]), true))).toEqual(["mo:P"]);
  });

  it("knows what can be folded and what hides a node", () => {
    expect(foldableIds(TREE, false).has("mo:P")).toBe(true);
    expect(foldableIds(TREE, false).has("mat:r/stock")).toBe(false);
    // A TO whose only material lies in stock has nothing to fold until it is shown.
    const onlyStock: StructureNode[] = [order("X", null, 0), material("mat:x", "mo:X", 1, true), stock("mat:x", 2)];
    expect(foldableIds(onlyStock, false).has("mo:X")).toBe(false);
    expect(foldableIds(onlyStock, true).has("mo:X")).toBe(true);
    expect(ancestorIds(TREE, "mat:r/stock")).toEqual(["mat:r", "mo:H", "mat:h", "mo:P"]);
    expect(ancestorIds(TREE, "mo:P")).toEqual([]);
  });
});

describe("structureOrderIds", () => {
  it("lists every TO once, the repeated one too", () => {
    expect(structureOrderIds(TREE)).toEqual(["P", "H"]);
    // The repeat carries the same count — it is one order.
    expect(lockedOrderCount(TREE)).toBe(1);
  });

  it("splits a long list into the route's maximum", () => {
    expect(chunked([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunked([], 200)).toEqual([]);
  });

  it("asks with the numbers", () => {
    expect(unlockStructureQuestion(1, 1)).toBe("Lås upp 1 operation på 1 tillverkningsorder? Dagarna står kvar tills nästa Planera.");
    expect(unlockStructureQuestion(3, 2)).toBe("Lås upp 3 operationer på 2 tillverkningsordrar? Dagarna står kvar tills nästa Planera.");
  });

  it("finds what the TO's menu offers", () => {
    expect(orderChildFacts(TREE, "mo:P")).toEqual({ missingManufacturable: true, componentOrders: true });
    expect(orderChildFacts(TREE, "mo:H")).toEqual({ missingManufacturable: false, componentOrders: false });
  });
});

describe("the day axis", () => {
  it("markerIndex is the column, null outside the axis", () => {
    expect(markerIndex("2026-11-26", AXIS)).toBe(0);
    expect(markerIndex("2026-12-09", AXIS)).toBe(13);
    expect(markerIndex("2026-11-25", AXIS)).toBeNull();
    expect(markerIndex("2026-12-10", AXIS)).toBeNull();
    expect(markerIndex(null, AXIS)).toBeNull();
  });

  it("barSegments joins consecutive days and breaks over a weekend", () => {
    // Fri 27 Nov, then Mon 30 Nov and Tue 1 Dec.
    const op = operation({
      days: [
        { date: "2026-11-27", hours: 3 },
        { date: "2026-11-30", hours: 8 },
        { date: "2026-12-01", hours: 1.5 },
      ],
    });
    expect(barSegments(op, AXIS)).toEqual([
      { fromIndex: 1, toIndex: 1, hours: 3 },
      { fromIndex: 4, toIndex: 5, hours: 9.5 },
    ]);
  });

  it("barSegments leaves out days beyond the axis and is empty for lego", () => {
    expect(barSegments(operation({ days: [{ date: "2026-12-09", hours: 2 }, { date: "2026-12-10", hours: 2 }] }), AXIS)).toEqual([
      { fromIndex: 13, toIndex: 13, hours: 2 },
    ]);
    expect(barSegments(operation({ days: [] }), AXIS)).toEqual([]);
  });

  it("spanSegment clips the TO's days to the axis and floors a passed start at today", () => {
    expect(spanSegment("2026-11-20", "2026-12-01", AXIS, TODAY)).toEqual({ fromIndex: 0, toIndex: 5 });
    expect(spanSegment("2026-12-08", "2026-12-20", AXIS, TODAY)).toEqual({ fromIndex: 12, toIndex: 13 });
    expect(spanSegment("2026-12-10", "2026-12-12", AXIS, TODAY)).toBeNull();
    expect(spanSegment(null, null, AXIS, TODAY)).toBeNull();
  });

  it("groups the head by week", () => {
    expect(axisWeeks(AXIS)).toEqual([
      { isoWeek: 48, fromIndex: 0, span: 4 },
      { isoWeek: 49, fromIndex: 4, span: 7 },
      { isoWeek: 50, fromIndex: 11, span: 3 },
    ]);
  });
});

describe("the row texts", () => {
  const link = { quantity: 4, needDate: "2026-12-01", late: true, undated: false, daysLate: 3, exclusive: true };

  it("titles each kind", () => {
    expect(nodeTitle(TREE[0]!)).toEqual({ label: "TO-P", detail: "ART-P — Artikel P" });
    expect(nodeTitle(TREE[1]!)).toEqual({ label: "M-mat:h", detail: "Material mat:h" });
    expect(nodeTitle(TREE[4]!)).toEqual({ label: "Lager", detail: "6" });
    expect(nodeTitle(TREE[8]!)).toEqual({ label: "Saknas", detail: "2" });
  });

  it("says the TO's dates, and marks the ones the axis draws", () => {
    const node = order("H", "mat:h", 2, { link });
    expect(nodeDates(node, TODAY, AXIS)).toEqual([
      { text: "antal 4", onAxis: false },
      { text: "planerad 26–27 nov", onAxis: true },
      { text: "färdigt 4 dec", onAxis: false },
      { text: "behövs 1 dec", onAxis: true },
    ]);
    // Beyond the axis: always in words (the year when it is another one).
    const far = order("H", "mat:h", 2, { link: { ...link, needDate: "2027-03-02" }, plannedStartDate: "2026-12-08", plannedEndDate: "2026-12-11", plannedFinish: "2026-12-11" });
    expect(nodeDates(far, TODAY, AXIS)).toEqual([
      { text: "antal 4", onAxis: false },
      { text: "planerad 8–11 dec", onAxis: false },
      { text: "färdigt 4 dec", onAxis: false },
      { text: "behövs 2 mar 2027", onAxis: false },
    ]);
  });

  it("an unplanned, a closed and a repeated TO", () => {
    const unplanned = order("U", null, 0, { plannedStartDate: null, plannedEndDate: null, plannedFinish: null, dueDate: null });
    expect(nodeDates(unplanned, TODAY, AXIS).map((d) => d.text)).toEqual(["antal 4", "ej planerad", "saknar färdigdatum"]);
    expect(nodeDates(order("C", null, 0, { orderStatus: "closed" }), TODAY, AXIS).map((d) => d.text)).toEqual(["antal 4", "stängd", "färdigt 4 dec"]);
    expect(nodeDates(TREE[10]!, TODAY, AXIS).map((d) => d.text)).toEqual(["antal 4"]);
  });

  it("a lego last: ready after the last planned day", () => {
    const node = order("L", null, 0, { plannedFinish: "2026-12-03" });
    expect(nodeDates(node, TODAY, AXIS).map((d) => d.text)).toEqual(["antal 4", "planerad 26–27 nov", "klar 3 dec", "färdigt 4 dec"]);
  });

  it("marks: the coupling's lateness as text, the TO's own as pills", () => {
    const marks = nodeMarks(order("H", "mat:h", 2, { link, late: true, componentLate: true, lockedOperations: 2 }));
    expect(marks.late).toBe("3 dagar för sent");
    expect(marks.pills.map((p) => p.label)).toEqual(["Sen", "Halvfabrikat sent"]);
    expect(marks.locked).toBe(2);
    // The repeated place says only its own coupling.
    const repeat = nodeMarks(order("H", "mat:h2", 2, { link, late: true, lockedOperations: 2, repeatOf: "mo:H" }));
    expect(repeat).toEqual({ pills: [], late: "3 dagar för sent", locked: 0 });
    expect(nodeMarks(TREE[4]!)).toEqual({ pills: [], late: null, locked: 0 });
  });

  it("operations: own, lego and done", () => {
    expect(operationTitle(operation())).toBe("op 10 Skär · 110");
    expect(operationTitle(operation({ description: null }))).toBe("op 10 · 110");
    expect(operationDates(operation(), TODAY)).toBe("26–27 nov · 6,5 h kvar");
    expect(operationDates(operation({ plannedStartDate: null, plannedEndDate: null }), TODAY)).toBe("ej planerad · 6,5 h kvar");
    expect(operationDates(operation({ subcontract: true, subcontractDays: 5, days: [] }), TODAY)).toBe("Lego · 5 dagar");
    expect(operationDates(operation({ subcontract: true, subcontractDays: 1, days: [] }), TODAY)).toBe("Lego · 1 dag");
    expect(operationDates(operation({ status: "done" }), TODAY)).toBe("klar");
    expect(operationMovable(operation())).toBe(true);
    expect(operationMovable(operation({ subcontract: true }))).toBe(false);
    expect(operationMovable(operation({ status: "done" }))).toBe(false);
  });

  it("builds Flytta's target from the node, without day loads", () => {
    const target = moveTargetOf(order("P", null, 0), operation({ planLocked: true }));
    expect(target.order).toEqual({
      moOperationId: "op-1",
      orderNumber: "TO-P",
      articleNumber: "ART-P",
      articleName: "Artikel P",
      sequenceNo: 10,
      remainingHours: 6.5,
      plannedStartDate: "2026-11-26",
      plannedEndDate: "2026-11-27",
      planLocked: true,
    });
    expect(target.resource).toEqual({ code: "110", name: "Laser" });
  });

  it("sums up, and names what was cut", () => {
    expect(totalsText({ orders: 1, lateOrders: 0, componentLate: 0, lockedOperations: 0, missing: 0 })).toBe("1 tillverkningsorder");
    expect(totalsText({ orders: 3, lateOrders: 1, componentLate: 1, lockedOperations: 2, missing: 1 })).toBe(
      "3 tillverkningsordrar · 1 sen · 1 med halvfabrikat sent · 2 låsta operationer · 1 saknas"
    );
    expect(truncatedNotices({ depth: false, nodes: false, cycle: [] })).toEqual([]);
    expect(truncatedNotices({ depth: true, nodes: true, cycle: ["2210"] })).toEqual([
      "Trädet är avkortat (fler än 10 nivåer / fler än 600 rader)",
      "Strukturen går runt på artikel 2210",
    ]);
  });

  it("Går till opens the parent's own structure, one level up", () => {
    expect(goesToLink({ kind: "sales_order", documentId: "so-1", documentNumber: "KO-1234" })).toEqual({
      href: "/tillverkning/struktur?ko=so-1",
      label: "Öppna strukturen för KO-1234",
    });
    expect(goesToLink({ kind: "mo_material", documentId: "mo-1", documentNumber: "TO-1041" })).toEqual({
      href: "/tillverkning/struktur?to=mo-1",
      label: "Öppna strukturen för TO-1041",
    });
    expect(goesToLink({ kind: "stock", documentId: null, documentNumber: null })).toBeNull();
  });
});

// The view is a read view: everything that writes is the existing routes,
// behind Tillverkning and — where it asks — the app's own dialog.
describe("the component's guards", () => {
  const web = (path: string) => readFileSync(fileURLToPath(new URL(`../../web/${path}`, import.meta.url)), "utf8");
  const client = web("components/planning/StructurePageClient.tsx");

  it("derives canWrite from Tillverkning", () => {
    expect(client).toContain('const canWrite = useCan()(["tillverkning"]);');
  });

  it("guards every action with canWrite", () => {
    for (const name of ["unlockOrders", "unlockOperation", "openMove", "openComponents", "openMissing"]) {
      const fn = client.match(new RegExp(`\\n  (?:async )?function ${name}\\([^)]*\\) \\{\\n[^\\n]*`))?.[0];
      expect(fn, name).toMatch(/\{\n\s+if \(!canWrite\) return;$/);
    }
    // Nothing else in the file writes.
    const writes = [...client.matchAll(/method: "(POST|PUT|PATCH|DELETE)"/g)];
    expect(writes).toHaveLength(2);
  });

  it("renders the menus, the dialogs and Lås upp strukturen only with canWrite", () => {
    expect(client).toMatch(/\{canWrite && data\.totals\.lockedOperations > 0 && \(\s*<Button/);
    expect(client).toMatch(/canWrite && node\.kind === "order" && node\.repeatOf === null \? \(\s*<OrderMenu/);
    expect(client).toMatch(/\{canWrite && \(\s*<div className=\{styles\.menu\}>\s*<RowMenu/);
    expect(client).toMatch(/\{canWrite && \(\s*<MoveOperationDialog/);
    expect(client).toMatch(/\{canWrite && \(\s*<MoveComponentsDialog/);
    expect(client).toMatch(/\{canWrite && missingFor !== null && \(\s*<MissingComponentsDialog/);
    // A bar is a button only for someone who may move.
    expect(client).toContain("const movable = canWrite && operationMovable(op);");
  });

  it("asks through the app's dialog before unlocking orders", () => {
    expect(client).toMatch(/if \(!\(await confirmDialog\(question, \{ confirmLabel: "Lås upp" \}\)\)\) return;/);
    expect(client).not.toMatch(/window\.confirm|\bconfirm\(/);
  });

  it("reads its dates from the response, never the browser's clock", () => {
    expect(client).not.toMatch(/new Date\(|stockholmToday|Date\.now/);
    expect(web("lib/structureTree.ts")).not.toMatch(/new Date\(|Date\.now/);
  });

  it("has no drag in the read view", () => {
    expect(client).not.toMatch(/draggable|onDragStart|onDrop/);
  });
});

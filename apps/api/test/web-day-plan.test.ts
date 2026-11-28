import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  arrivalConfirmationText,
  dayPlanHref,
  dayPlanView,
  dayPlanVisa,
  dropIndex,
  isOrdersView,
  orderRowQuantity,
  orderRowsSummary,
  splitOverdue,
  loadPercent,
  loadText,
  materialDocumentHref,
  materialLine,
  materialText,
  materialTone,
  moveTargetOf,
  reorderIds,
  reorderableIds,
  runPlanStatusText,
  splitResources,
  stampText,
} from "../../web/lib/dayPlan.js";
import type { DayPlanResource, RunPlanMaterial, RunPlanRow } from "../../web/lib/types.js";

// Dagplan's pure helpers (apps/web/lib/dayPlan.ts) and the guard that
// Mötesläget cannot write.

const row = (over: Partial<RunPlanRow> = {}): RunPlanRow => ({
  key: "op-1",
  moOperationId: "op-1",
  manufacturingOrderId: "mo-1",
  orderNumber: "TO-1050",
  articleNumber: "A-100",
  articleName: "Bänkskiva",
  sequenceNo: 10,
  description: "Kapa",
  orderQuantity: 5,
  remainingQuantity: 5,
  remainingMinutes: 90,
  remainingHours: 1.5,
  setupDone: false,
  dueDate: "2026-12-04",
  date: "2026-11-26",
  late: false,
  planned: true,
  plannedStartDate: "2026-11-26",
  plannedEndDate: "2026-11-27",
  planLocked: true,
  runPosition: null,
  status: "ready",
  available: null,
  waitingForSequenceNo: null,
  reorderable: true,
  materials: [],
  materialLinked: false,
  activeStamps: [],
  ...over,
});

const material = (over: Partial<RunPlanMaterial> = {}): RunPlanMaterial => ({
  materialRowId: "row-1",
  articleId: "a-1",
  articleNumber: "1001",
  articleName: "Plåt",
  unit: "st",
  remainingQuantity: 4,
  usableOnHand: 10,
  status: "available",
  missingQuantity: 0,
  supply: null,
  ...over,
});

const resource = (over: Partial<DayPlanResource> = {}): DayPlanResource => ({
  workCenter: { id: "wc-1", code: "110", name: "Laser" },
  productionGroupId: null,
  load: { date: "2026-11-26", loadHours: 6.5, availableHours: 8, overloaded: false },
  carried: [],
  rows: [],
  rowHours: 0,
  unplannedRows: 0,
  present: [],
  materialGroups: [],
  unlinkedRowKeys: [],
  ...over,
});

describe("reorderIds", () => {
  it("moves one id to its new place and keeps the rest in order", () => {
    expect(reorderIds(["a", "b", "c", "d"], 0, 2)).toEqual(["b", "c", "a", "d"]);
    expect(reorderIds(["a", "b", "c", "d"], 3, 0)).toEqual(["d", "a", "b", "c"]);
    // Upp / Ned are a move by one.
    expect(reorderIds(["a", "b", "c"], 1, 0)).toEqual(["b", "a", "c"]);
    expect(reorderIds(["a", "b", "c"], 1, 2)).toEqual(["a", "c", "b"]);
  });
  it("returns the same order for a move that is none, without touching the input", () => {
    const ids = ["a", "b", "c"];
    expect(reorderIds(ids, 1, 1)).toEqual(ids);
    expect(reorderIds(ids, -1, 1)).toEqual(ids);
    expect(reorderIds(ids, 0, 3)).toEqual(ids);
    expect(reorderIds(ids, 0, 2)).not.toBe(ids);
    expect(ids).toEqual(["a", "b", "c"]);
  });
});

describe("dropIndex", () => {
  it("lands before or after the row the drag is dropped on", () => {
    const ids = ["a", "b", "c", "d"];
    const drop = (from: number, target: number, after: boolean) => reorderIds(ids, from, dropIndex(from, target, after));
    expect(drop(0, 2, false)).toEqual(["b", "a", "c", "d"]);
    expect(drop(0, 2, true)).toEqual(["b", "c", "a", "d"]);
    expect(drop(3, 1, false)).toEqual(["a", "d", "b", "c"]);
    expect(drop(3, 1, true)).toEqual(["a", "b", "d", "c"]);
    // Dropped next to itself: nothing moves.
    expect(drop(1, 0, true)).toEqual(ids);
    expect(drop(1, 2, false)).toEqual(ids);
  });
});

describe("reorderableIds", () => {
  it("is the day's reorderable operations only — what the order PUT wants", () => {
    const rows = [row({ moOperationId: "a" }), row({ moOperationId: "b", reorderable: false }), row({ moOperationId: null }), row({ moOperationId: "c" })];
    expect(reorderableIds(rows)).toEqual(["a", "c"]);
  });
});

describe("loadText and loadPercent", () => {
  const load = (loadHours: number, availableHours: number | null, overloaded = false) => ({ date: "2026-11-26", loadHours, availableHours, overloaded });
  it("writes load against capacity", () => {
    expect(loadText(load(6.5, 8))).toBe("6,5 h av 8 h");
    expect(loadPercent(load(6.5, 8))).toBe(81);
  });
  it("says överbelagd from the API's flag, never from its own arithmetic", () => {
    expect(loadText(load(9, 8, true))).toBe("9 h av 8 h · överbelagd");
    expect(loadText(load(9, 8, false))).toBe("9 h av 8 h");
    expect(loadPercent(load(9, 8, true))).toBe(100);
  });
  it("says ingen kapacitet for a day with 0 h", () => {
    expect(loadText(load(3, 0, true))).toBe("3 h · ingen kapacitet");
    expect(loadText(load(0, 0))).toBe("ingen kapacitet");
    expect(loadPercent(load(3, 0, true))).toBeNull();
  });
  it("shows only the load for a resource without a capacity calendar", () => {
    expect(loadText(load(3.25, null))).toBe("3,3 h");
    expect(loadPercent(load(3.25, null))).toBeNull();
  });
});

describe("materialText", () => {
  const supply = { kind: "purchase_order" as const, documentId: "po-1", documentNumber: "IO-88", date: "2026-12-02", late: false, isDraft: false };
  it("says finns for a row the usable stock covers", () => {
    expect(materialText(material())).toEqual({ tone: "ok", text: "finns", document: null, overdue: false, rest: null });
    expect(materialTone(materialText(material()))).toBe("ok");
  });
  it("says what is missing when nothing is on its way", () => {
    expect(materialText(material({ status: "short", missingQuantity: 4 })).text).toBe("saknas 4 st");
    expect(materialText(material({ status: "short", missingQuantity: 2.5, unit: null })).text).toBe("saknas 2,5");
    const missing = materialText(material({ status: "short", missingQuantity: 4 }));
    expect(missing.rest).toBeNull();
    expect(materialTone(missing)).toBe("short");
    expect(materialLine(missing)).toBe("saknas 4 st");
  });
  it("says when it comes, and on which document", () => {
    const text = materialText(material({ status: "short", missingQuantity: 0, supply }));
    expect(text).toEqual({
      tone: "short",
      text: "kommer 2 dec",
      document: { kind: "purchase_order", id: "po-1", number: "IO-88", draft: false },
      overdue: false,
      rest: null,
    });
    expect(materialTone(text)).toBe("coming");
    expect(materialLine(text)).toBe("kommer 2 dec · IO-88");
    expect(materialDocumentHref(text.document!)).toBe("/inkop/ordrar/po-1");
    const undated = materialText(material({ status: "short", supply: { ...supply, kind: "manufacturing_order", documentId: "mo-9", date: null, isDraft: true } }));
    expect(undated.text).toBe("kommer, utan datum");
    expect(undated.document?.draft).toBe(true);
    expect(materialDocumentHref(undated.document!)).toBe("/tillverkning/ordrar/mo-9");
    expect(materialLine(undated)).toBe("kommer, utan datum · IO-88 (utkast)");
  });
  it("says what is still missing beside a supply that does not cover the row", () => {
    const text = materialText(material({ status: "short", missingQuantity: 8, supply }));
    expect(text.text).toBe("kommer 2 dec");
    expect(text.rest).toBe("saknas 8 st");
    expect(materialLine(text)).toBe("kommer 2 dec · IO-88 · saknas 8 st");
    // Still on its way: the tone is the supply's, the text says the rest.
    expect(materialTone(text)).toBe("coming");
  });
  it("an overdue supply is late since its own day — never 'kommer' today", () => {
    const late = materialText(material({ status: "short", missingQuantity: 0, supply: { ...supply, date: "2026-11-25", late: true } }));
    expect(late.text).toBe("försenad sedan 25 nov");
    expect(late.overdue).toBe(true);
    expect(materialTone(late)).toBe("short");
    expect(materialLine(late)).toBe("försenad sedan 25 nov · IO-88");
    const both = materialText(material({ status: "short", missingQuantity: 1.5, supply: { ...supply, date: "2026-11-25", late: true } }));
    expect(materialLine(both)).toBe("försenad sedan 25 nov · IO-88 · saknas 1,5 st");
  });
});

describe("stampText and runPlanStatusText", () => {
  it("marks a paused stamp", () => {
    expect(stampText({ name: "Anna", paused: false })).toBe("Anna");
    expect(stampText({ name: "Anna", paused: true })).toBe("Anna (paus)");
  });
  it("uses the körplan's words for the readiness", () => {
    expect(runPlanStatusText(row({ status: "ready" }))).toBe("Redo");
    expect(runPlanStatusText(row({ status: "not_ready", waitingForSequenceNo: 10 }))).toBe("Väntar på op 10");
    expect(runPlanStatusText(row({ status: "partial", available: 2.5, waitingForSequenceNo: 10 }))).toBe("2,5 redo · väntar på op 10");
    expect(runPlanStatusText(row({ status: "planned_order" }))).toBe("Planerad TO");
  });
});

describe("moveTargetOf", () => {
  it("hands Flytta the operation and the shown day's load", () => {
    const r = resource();
    expect(moveTargetOf(row(), r)).toEqual({
      order: {
        moOperationId: "op-1",
        orderNumber: "TO-1050",
        articleNumber: "A-100",
        articleName: "Bänkskiva",
        sequenceNo: 10,
        remainingHours: 1.5,
        plannedStartDate: "2026-11-26",
        plannedEndDate: "2026-11-27",
        planLocked: true,
      },
      resource: { code: "110", name: "Laser", dayLoads: [r.load] },
    });
  });
  it("has no target for a row that is not an operation", () => {
    expect(moveTargetOf(row({ moOperationId: null }), resource())).toBeNull();
  });
});

describe("splitResources and dayPlanHref", () => {
  it("separates the resources with something to show from the idle ones", () => {
    const { busy, idle } = splitResources([
      resource({ workCenter: { id: "1", code: "110", name: "A" }, rows: [row()] }),
      resource({ workCenter: { id: "2", code: "120", name: "B" } }),
      resource({ workCenter: { id: "3", code: "130", name: "C" }, carried: [row()] }),
      resource({ workCenter: { id: "4", code: "140", name: "D" }, unplannedRows: 2 }),
    ]);
    expect(busy.map((r) => r.workCenter.code)).toEqual(["110", "130", "140"]);
    expect(idle.map((r) => r.workCenter.code)).toEqual(["120"]);
  });
  it("carries the day and the group between the page and Mötesläget", () => {
    expect(dayPlanHref("/tillverkning/dagplan", {})).toBe("/tillverkning/dagplan");
    expect(dayPlanHref("/tillverkning/dagplan/mote", { dag: "2026-11-27", grupp: "g1" })).toBe("/tillverkning/dagplan/mote?dag=2026-11-27&grupp=g1");
    expect(dayPlanHref("/tillverkning/dagplan", { dag: "", grupp: "g1" })).toBe("/tillverkning/dagplan?grupp=g1");
  });
});

// Mötesläget is read-only by construction: the page's only writes live in
// dayPlanWrites.ts, every caller of them starts by refusing without
// canWrite, and canWrite is never true in a meeting.
describe("Mötesläget never writes", () => {
  const web = (path: string) => readFileSync(fileURLToPath(new URL(`../../web/${path}`, import.meta.url)), "utf8");
  const client = web("components/planning/DayPlanPageClient.tsx");
  const WRITES = ["saveDayOrder", "moveOperationTo", "unlockOperation"];

  it("keeps every write call out of the page component", () => {
    // No apiFetch with a method here — only the plain GETs of the day plan
    // and of its order lists.
    expect(client).not.toMatch(/method:\s*["'`]/);
    expect(client.match(/apiFetch</g) ?? []).toHaveLength(2);
    expect(client).toContain("apiFetch<DayPlanResult>(`/api/v1/planning/day-plan${query}`)");
    expect(client).toContain("apiFetch<DayPlanOrdersResult>(`/api/v1/planning/day-plan/orders${query}`)");
    const writes = web("components/planning/dayPlanWrites.ts");
    for (const name of WRITES) expect(writes).toContain(`export function ${name}(`);
  });

  // Etapp 6a: the quick moves send the start day the row showed, so a move
  // made on a stale page is refused (409 operation-plan-changed).
  it("sends the row's planned start day as the move's precondition", () => {
    expect(client).toContain("await moveOperationTo(row.moOperationId, date, row.plannedStartDate);");
    const writes = web("components/planning/dayPlanWrites.ts");
    expect(writes).toMatch(/export function moveOperationTo\(moOperationId: string, date: string, expectedStartDate: string \| null\)/);
    expect(writes).toContain("JSON.stringify({ date, moveFollowing: true, expectedStartDate })");
  });

  it("derives canWrite from !meeting", () => {
    expect(client).toMatch(/const canWrite = !meeting && can\(\["tillverkning"\]\);/);
  });

  it("guards every caller of a write with canWrite", () => {
    for (const name of WRITES) {
      const calls = [...client.matchAll(new RegExp(`await ${name}\\(`, "g"))];
      expect(calls.length, name).toBeGreaterThan(0);
      for (const call of calls) {
        const before = client.slice(0, call.index);
        const fn = before.slice(before.lastIndexOf("async function "));
        expect(fn, name).toMatch(/^async function \w+\([^)]*\) \{\n\s+if \(!canWrite\) return;/);
      }
      // Never called outside those functions.
      expect(client.match(new RegExp(`\\b${name}\\(`, "g")) ?? []).toHaveLength(calls.length);
    }
  });

  it("renders the write controls only with canWrite", () => {
    // The ordering cell, the row menu and the move dialog.
    expect(client).toMatch(/\{canWrite && \(\s*<span className=\{styles\.orderCell\}>/);
    expect(client).toMatch(/\{canWrite && \(\s*<span className=\{styles\.menu\}>/);
    expect(client).toMatch(/\{canWrite && \(\s*<MoveOperationDialog/);
    expect(client.match(/<RowMenu/g) ?? []).toHaveLength(1);
    expect(client.match(/<MoveOperationDialog/g) ?? []).toHaveLength(1);
    // Skriv ut sits in the page's toolbar, which Mötesläget replaces.
    expect(client.match(/<PrintButton/g) ?? []).toHaveLength(1);
    expect(client.indexOf("<PrintButton")).toBeGreaterThan(client.indexOf("className={styles.toolbar}"));
  });

  it("never drags or reorders while a write or a reload is on its way", () => {
    // The same guard that disables Upp/Ned.
    expect(client).toContain("canDrag={canWrite && finePointer && !busy && !loading}");
    expect(client).toMatch(/async function reorder\([^)]*\) \{\n\s+if \(!canWrite\) return;\n(\s+\/\/[^\n]*\n)*\s+if \(busy \|\| loading\) return;/);
  });

  it("moves on to today when the shown day has passed, instead of keeping yesterday's picture", () => {
    // Before the background branch: Mötesläget with ?dag= over midnight.
    const outOfRange = client.indexOf('err.code === "day-plan-date-out-of-range"');
    expect(outOfRange).toBeGreaterThan(0);
    expect(outOfRange).toBeLessThan(client.indexOf("if (background) setReloadFailed(true);"));
    // Only for a day that was shown — a typed address still gets its error.
    expect(client).toContain("if (dag && shownDate.current === dag && err instanceof ApiError");
    expect(client).toMatch(/showToday\.current = \(\) =>\s+router\.replace\(dayPlanHref\(pathname, \{ dag: null,/);
  });

  it("mounts Mötesläget read-only, without the confirmation dialog", () => {
    const page = web("app/tillverkning/dagplan/mote/page.tsx");
    expect(page).toContain("<DayPlanPageClient meeting />");
    expect(page).not.toMatch(/import .*ConfirmDialogHost/);
    expect(page).not.toContain("AppShell }");
    expect(page).toContain('canOpen(user, "/tillverkning/dagplan")');
  });
});

// Utleveranser och Inleveranser (the user's wish 2026-11-28): two more
// choices under Visa that list the day's kundorder and inköpsorder rows.
describe("the order lists", () => {
  const web = (path: string) => readFileSync(fileURLToPath(new URL(`../../web/${path}`, import.meta.url)), "utf8");
  const client = web("components/planning/DayPlanPageClient.tsx");
  const lists = web("components/planning/DayPlanOrders.tsx");

  it("reads ?visa= — the order lists only with a menu, and back to the address", () => {
    expect(dayPlanView("utleveranser", true)).toBe("shipments");
    expect(dayPlanView("inleveranser", true)).toBe("arrivals");
    expect(dayPlanView("material", false)).toBe("material");
    expect(dayPlanView("utleveranser", false)).toBe("order");
    expect(dayPlanView(null, true)).toBe("order");
    expect(dayPlanView("korordning", true)).toBe("order");
    expect(["order", "material", "shipments", "arrivals"].map((v) => dayPlanVisa(v as never))).toEqual([null, "material", "utleveranser", "inleveranser"]);
    expect(isOrdersView("shipments") && isOrdersView("arrivals") && !isOrdersView("material") && !isOrdersView("order")).toBe(true);
  });

  it("words the rows", () => {
    expect(orderRowQuantity(2.5, "st")).toBe("2,5 st");
    expect(orderRowQuantity(3, null)).toBe("3");
    expect(arrivalConfirmationText(true)).toBe("Leverantören har bekräftat");
    expect(arrivalConfirmationText(false)).toBe("Leverantören har inte bekräftat");
    expect(orderRowsSummary([{ orderNumber: "KO-1" }])).toBe("1 rad på 1 order");
    expect(orderRowsSummary([{ orderNumber: "KO-1" }, { orderNumber: "KO-1" }, { orderNumber: "KO-2" }])).toBe("3 rader på 2 ordrar");
    const rows = [{ overdue: false, id: 1 }, { overdue: true, id: 2 }, { overdue: false, id: 3 }];
    expect(splitOverdue(rows)).toEqual({ overdue: [rows[1]], day: [rows[0], rows[2]] });
  });

  it("offers them only with a menu, without Grupp and without Skriv ut", () => {
    expect(client).toContain('const canSeeOrders = can(["office"]);');
    expect(client).toMatch(/\.\.\.\(canSeeOrders\s+\?\s+\[\s+\{ value: "shipments" as const, label: "Utleveranser" \},\s+\{ value: "arrivals" as const, label: "Inleveranser" \},/);
    // Grupp in neither bar, and no production group in the request.
    expect(client.match(/\{!ordersView && groupField\}/g) ?? []).toHaveLength(2);
    expect(client).not.toMatch(/\{groupField\}/);
    expect(client).toContain('const planGroup = ordersView ? "" : grupp;');
    // Skriv ut prints the körordning only.
    expect(client).toMatch(/const pdfHref =\s+data && !ordersView/);
    expect(client).toContain("<DayPlanOrders view={view} result={orders} meeting={meeting} />");
  });

  // The links work in Mötesläget too (the user's wish 2026-11-28): the
  // kundorder, the inköpsorder, what covers a row and the legorad's TO.
  it("keeps the lists read-only, with their links in Mötesläget too", () => {
    expect(lists).not.toMatch(/apiFetch|method:|onClick/);
    expect(lists.match(/<GatedLink/g) ?? []).toHaveLength(4);
    expect(lists).not.toMatch(/meeting \?\s*\(?\s*<span|meeting \?\s*\(?\s*legoText/);
  });
});

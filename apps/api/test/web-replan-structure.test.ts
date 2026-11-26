import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  REPLAN_CHANGED_NOTICE,
  blockedText,
  changeText,
  conflictResult,
  currentDueDate,
  dueDateChangeText,
  floorText,
  includedIds,
  notPlannedText,
  operationText,
  operationsText,
  overloadedDayText,
  plannedChangeText,
  replanPayload,
  replanRequest,
  requestKey,
  selectableOrders,
  sharedText,
  toggleInclude,
  validDueDate,
  writtenText,
} from "../../web/lib/replanStructure.js";
import { replannable } from "../../web/lib/structureTree.js";
import type { ReplanStructureOrder, ReplanStructureResult } from "../../web/lib/types.js";

// Planera om strukturen (the dialog on the structure page and the TO card):
// the pure parts (apps/web/lib/replanStructure.ts) and the guards on the
// component. The tree, the choice and the days are the API's
// (structure-replan*.test.ts).

const TODAY = "2026-11-26";

function order(id: string, over: Partial<ReplanStructureOrder> = {}): ReplanStructureOrder {
  return {
    manufacturingOrderId: id,
    orderNumber: `TO-${id}`,
    articleNumber: `A-${id}`,
    articleName: `Artikel ${id}`,
    level: 0,
    parentOrderId: null,
    exclusive: true,
    selectable: false,
    included: true,
    sharedWith: [],
    dueDate: { before: "2026-12-02", after: "2026-12-02", late: false },
    planned: { before: { start: "2026-12-01", end: "2026-12-03" }, after: { start: "2026-12-04", end: "2026-12-08" } },
    plannedFinish: "2026-12-08",
    lateAfter: false,
    floor: null,
    operations: [],
    ...over,
  };
}

// P (top) → H (exclusive, chosen) → S (under H, chosen); D is shared and not
// chosen, with X under it (not selectable: its parent is not chosen).
function tree(): ReplanStructureResult {
  const orders = [
    order("P"),
    order("H", { level: 1, parentOrderId: "P", selectable: true }),
    order("S", { level: 2, parentOrderId: "H", selectable: true }),
    order("D", { level: 1, parentOrderId: "P", selectable: true, included: false, exclusive: false, sharedWith: ["TO-1077"] }),
    order("X", { level: 2, parentOrderId: "D", selectable: false, included: false }),
  ];
  return {
    today: TODAY,
    top: { manufacturingOrderId: "P", orderNumber: "TO-P" },
    orders,
    overloadedDays: [],
    warnings: [],
    notes: [],
    blocked: [],
    expected: orders.map((o) => ({ manufacturingOrderId: o.manufacturingOrderId, dueDate: o.dueDate.before, plannedStartDate: "2026-12-01", plannedEndDate: "2026-12-03" })),
  };
}

describe("the choice", () => {
  it("reads the answer's choice: the halvfabrikat that were planned, never the top", () => {
    expect(includedIds(tree())).toEqual(["H", "S"]);
    expect(selectableOrders(tree()).map((o) => o.manufacturingOrderId)).toEqual(["H", "S", "D"]);
    expect(currentDueDate(tree())).toBe("2026-12-02");
  });

  it("unticking a TO takes its whole branch with it", () => {
    expect(toggleInclude(tree(), ["H", "S"], "H")).toEqual([]);
    expect(toggleInclude(tree(), ["H", "S"], "S")).toEqual(["H"]);
  });

  it("ticking adds that TO only, in the tree's order", () => {
    expect(toggleInclude(tree(), ["H", "S"], "D")).toEqual(["H", "S", "D"]);
    expect(toggleInclude(tree(), ["S", "D"], "H")).toEqual(["H", "S", "D"]);
  });

  it("never ticks the top, a TO under one that is not chosen, or an unknown one", () => {
    expect(toggleInclude(tree(), ["H"], "P")).toEqual(["H"]);
    expect(toggleInclude(tree(), ["H"], "X")).toEqual(["H"]);
    expect(toggleInclude(tree(), ["H"], "nope")).toEqual(["H"]);
  });
});

describe("the request and the payload", () => {
  it("an empty field and the top's own date both mean: leave it", () => {
    expect(replanRequest({ dueDate: "", moveComponentDueDates: true, chosen: null }, "2026-12-02")).toEqual({ dueDate: null, moveComponentDueDates: true });
    expect(replanRequest({ dueDate: "2026-12-02", moveComponentDueDates: false, chosen: ["H"] }, "2026-12-02")).toEqual({
      dueDate: null,
      moveComponentDueDates: false,
      includeOrderIds: ["H"],
    });
    expect(replanRequest({ dueDate: "2026-12-09", moveComponentDueDates: true, chosen: [] }, "2026-12-02")).toEqual({
      dueDate: "2026-12-09",
      moveComponentDueDates: true,
      includeOrderIds: [],
    });
  });

  it("leaves the choice out until there is one — the API then answers its default", () => {
    expect("includeOrderIds" in replanRequest({ dueDate: "", moveComponentDueDates: true, chosen: null }, null)).toBe(false);
  });

  it("the key tells two requests apart, whatever the order of the choice", () => {
    const base = { dueDate: null, moveComponentDueDates: true, includeOrderIds: ["H", "S"] };
    expect(requestKey(base)).toBe(requestKey({ ...base, includeOrderIds: ["S", "H"] }));
    expect(requestKey(base)).not.toBe(requestKey({ ...base, includeOrderIds: ["H"] }));
    expect(requestKey(base)).not.toBe(requestKey({ ...base, moveComponentDueDates: false }));
    expect(requestKey(base)).not.toBe(requestKey({ ...base, dueDate: "2026-12-09" }));
    // The default (no choice) is not the empty choice.
    expect(requestKey({ dueDate: null, moveComponentDueDates: true })).not.toBe(requestKey({ dueDate: null, moveComponentDueDates: true, includeOrderIds: [] }));
  });

  it("the answer to the default request is the preview of the form with the answer's choice", () => {
    const result = tree();
    const form = { dueDate: currentDueDate(result) ?? "", moveComponentDueDates: true, chosen: includedIds(result) };
    expect(replanRequest(form, currentDueDate(result))).toEqual({ dueDate: null, moveComponentDueDates: true, includeOrderIds: ["H", "S"] });
  });

  it("the write sends the preview's expected unchanged, with the TOs the preview planned", () => {
    const result = tree();
    const payload = replanPayload(result, { dueDate: "2026-12-09", moveComponentDueDates: true });
    expect(payload.expected).toBe(result.expected);
    expect(payload).toEqual({ dueDate: "2026-12-09", moveComponentDueDates: true, includeOrderIds: ["H", "S"], expected: result.expected });
  });

  it("a changed date must be today or later; the top's own passed date is left alone", () => {
    expect(validDueDate("", "2026-11-01", TODAY)).toBe(true);
    expect(validDueDate("2026-11-01", "2026-11-01", TODAY)).toBe(true);
    expect(validDueDate("2026-11-25", "2026-11-01", TODAY)).toBe(false);
    expect(validDueDate(TODAY, null, TODAY)).toBe(true);
    expect(validDueDate("2026-13", null, TODAY)).toBe(false);
  });

  it("reads the fresh preview out of a 409's body, and nothing else", () => {
    const result = tree();
    expect(conflictResult({ error: "x", code: "replan-structure-changed", result })).toBe(result);
    expect(conflictResult({ code: "replan-structure-changed" })).toBeNull();
    expect(conflictResult({ result: { orders: [] } })).toBeNull();
    expect(conflictResult(undefined)).toBeNull();
    expect(REPLAN_CHANGED_NOTICE).toBe("Planen har ändrats — förhandsvisningen är uppdaterad. Kontrollera och planera om igen.");
  });
});

describe("the texts", () => {
  it("before → after, said once when nothing changes", () => {
    expect(changeText("1–3 dec", "4–8 dec")).toBe("1–3 dec → 4–8 dec");
    expect(changeText("1–3 dec", "1–3 dec")).toBe("1–3 dec");
    expect(changeText(null, "4 dec", "ej planerad")).toBe("ej planerad → 4 dec");
    expect(plannedChangeText(order("P").planned)).toBe("1–3 dec → 4–8 dec");
    expect(plannedChangeText({ before: { start: null, end: null }, after: { start: null, end: null } })).toBe("ej planerad");
    expect(dueDateChangeText({ before: "2026-12-02", after: "2026-12-09" })).toBe("2 dec → 9 dec");
    expect(dueDateChangeText({ before: null, after: null })).toBe("saknas");
  });

  it("the golv names what the TO waits for", () => {
    expect(floorText(null)).toBeNull();
    expect(floorText({ date: "2026-12-09", source: { kind: "manufacturing_order", documentNumber: "TO-1050" } })).toBe("börjar tidigast 9 dec — när TO-1050 är klar");
    expect(floorText({ date: "2026-12-09", source: { kind: "purchase_order", documentNumber: "IO-88" } })).toBe("börjar tidigast 9 dec — när IO-88 har kommit");
    expect(floorText({ date: "2026-12-09", source: null })).toBe("börjar tidigast 9 dec — när materialet är klart");
  });

  it("a shared halvfabrikat says with whom", () => {
    expect(sharedText(order("H"))).toBeNull();
    expect(sharedText(order("D", { sharedWith: ["TO-1077"] }))).toBe("delas med TO-1077");
    expect(sharedText(order("D", { sharedWith: ["TO-1077", "TO-1078", "KO-5010"] }))).toBe("delas med TO-1077, TO-1078 och KO-5010");
    expect(notPlannedText(order("D", { sharedWith: ["TO-1077"] }))).toBe("delas med TO-1077 — planeras inte om");
    expect(notPlannedText(order("X"))).toBe("planeras inte om");
  });

  it("counts the operations and the ones that were locked", () => {
    const op = (sequenceNo: number, wasLocked: boolean) => ({
      moOperationId: `op${sequenceNo}`,
      sequenceNo,
      workCenterCode: "101",
      subcontract: false,
      started: false,
      wasLocked,
      before: { start: "2026-12-01", end: "2026-12-02" },
      after: { start: "2026-12-04", end: "2026-12-05" },
    });
    expect(operationsText(order("P", { operations: [op(10, false)] }))).toBe("1 operation");
    expect(operationsText(order("P", { operations: [op(10, true), op(20, false)] }))).toBe("2 operationer · 1 var låst och planeras om");
    expect(operationsText(order("P", { operations: [op(10, true), op(20, true)] }))).toBe("2 operationer · 2 var låsta och planeras om");
    expect(operationText(op(10, true))).toBe("op 10 · 101 · 1–2 dec → 4–5 dec");
    expect(operationText({ ...op(20, false), workCenterCode: "900", subcontract: true, before: { start: null, end: null }, after: { start: null, end: null } })).toBe(
      "op 20 · 900 · lego"
    );
  });

  it("overloaded days, blocked orders and the outcome", () => {
    expect(overloadedDayText({ workCenterCode: "101", date: "2026-12-07", loadHours: 9.5, availableHours: 8 })).toBe("101 · 7 dec: 9,5 h av 8 h");
    expect(overloadedDayText({ workCenterCode: "101", date: "2026-12-07", loadHours: 2, availableHours: 0 })).toBe("101 · 7 dec: 2 h · ingen kapacitet");
    expect(blockedText([])).toBeNull();
    expect(blockedText([{ manufacturingOrderId: "H", orderNumber: "TO-H" }])).toContain("TO-H ryms inte inom planeringshorisonten");
    expect(writtenText(tree())).toBe("3 tillverkningsordrar är omplanerade och operationerna är låsta på sina dagar.");
    expect(writtenText({ orders: [order("P")] })).toBe("1 tillverkningsorder är omplanerad och operationerna är låsta på sina dagar.");
  });

  it("offers the action on an open TO only", () => {
    expect(replannable({ orderStatus: "released" })).toBe(true);
    expect(replannable({ orderStatus: "in_progress" })).toBe(true);
    expect(replannable({ orderStatus: "planned" })).toBe(false);
    expect(replannable({ orderStatus: "completed" })).toBe(false);
  });
});

describe("the dialog's guards", () => {
  const web = (path: string) => readFileSync(fileURLToPath(new URL(`../../web/${path}`, import.meta.url)), "utf8");
  const dialog = web("components/planning/ReplanStructureDialog.tsx");
  const writes = web("components/planning/structureWrites.ts");
  const lib = web("lib/replanStructure.ts");

  it("previews after a pause, with a request sequence — a late answer never lands", () => {
    expect(dialog).toContain("const PREVIEW_DELAY_MS = 300;");
    expect(dialog).toContain("const delay = first.current ? 0 : PREVIEW_DELAY_MS;");
    expect(dialog).toContain("const seq = ++sequence.current;");
    // Both the answer and the error are dropped when a newer request exists.
    expect(dialog.match(/if \(seq !== sequence\.current\) return;/g)).toHaveLength(2);
    expect(dialog).toContain("return () => window.clearTimeout(timer);");
    // The sequence moves on even when no request is sent (the form went back
    // to the shown preview): an answer on its way is then dropped.
    expect(dialog.indexOf("const seq = ++sequence.current;")).toBeLessThan(dialog.indexOf("if (shownKey.current === key) {"));
  });

  it("writes only the preview of exactly the shown form", () => {
    expect(dialog).toContain("const current = shown !== null && shownKey.current === key && requestKey(shown.request) === key;");
    expect(dialog).toMatch(/const canSubmit = !busy && !previewing && current && validDate && previewError === null && blocked === null && written === null;/);
    expect(dialog).toContain("if (!canSubmit || !shown) return;");
    expect(dialog).toContain('<Button type="submit" variant="primary" disabled={!canSubmit}>');
    // The payload is built from the shown pair — never from the form.
    expect(dialog).toContain("writeReplanStructure(topId, replanPayload(shown.result, shown.request))");
    expect(dialog.match(/writeReplanStructure\(/g)).toHaveLength(1);
  });

  it("sends the preview's expected back unchanged", () => {
    expect(lib).toContain("expected: result.expected,");
    expect(lib.match(/expected: (?!ReplanExpectedOrder\[\];)/g)).toHaveLength(1);
    expect(dialog).not.toMatch(/expected/);
  });

  it("a 409 replan-structure-changed shows the fresh preview and its notice, on the preview and on the write", () => {
    expect(dialog.match(/err\.code === "replan-structure-changed" \? conflictResult\(err\.body\) : null/g)).toHaveLength(2);
    expect(dialog.match(/adopt\(fresh\);\s+setNotice\(REPLAN_CHANGED_NOTICE\);/g)).toHaveLength(2);
  });

  it("a typed date is never replaced by an answer (manuellt vinner, read when the answer lands)", () => {
    expect(dialog).toContain("dueDate: dueTouched.current ? formNow.current.dueDate : (due ?? \"\"),");
  });

  it("shows errors through the dictionary and never asks with the browser's confirm", () => {
    expect(dialog).toContain('apiErrorMessage(err, "Kunde inte planera om strukturen")');
    expect(dialog).toContain('apiErrorMessage(err, "Kunde inte förhandsvisa omplaneringen")');
    expect(dialog).not.toMatch(/err\.message|window\.confirm|\bconfirm\(/);
    expect(dialog).not.toMatch(/new Date\(|stockholmToday|Date\.now/);
    expect(lib).not.toMatch(/new Date\(|Date\.now|apiFetch/);
  });

  it("the two calls are the two routes, and the only writes", () => {
    expect(writes).toContain("/replan-structure/preview`");
    expect(writes).toContain("/replan-structure`");
    expect(writes.match(/method: "POST"/g)).toHaveLength(2);
    expect(dialog).not.toMatch(/apiFetch|method: "/);
  });

  it("is offered only with Tillverkning, on the structure page and the TO card", () => {
    const page = web("components/planning/StructurePageClient.tsx");
    expect(page).toMatch(/function openReplan\(node: StructureOrderNode\) \{\n\s+if \(!canWrite\) return;/);
    expect(page).toMatch(/\{canWrite && rootOrder && replannable\(rootOrder\) && \(\s*<Button/);
    expect(page).toMatch(/\{canWrite && \(\s*<ReplanStructureDialog/);
    expect(page).toContain('replannable(node) && { label: "Planera om strukturen…", onSelect: onReplan, disabled: busy },');
    const card = web("components/manufacturing/ManufacturingOrderDetail.tsx");
    expect(card).toContain('const readOnly = !can(["tillverkning"]);');
    expect(card).toContain('const canEditLines = !readOnly && (order.status === "released" || order.status === "in_progress");');
    expect(card).toMatch(/\{canEditLines && \(\s*<Button[^>]*onClick=\{\(\) => setReplanOpen\(true\)\}\s*>\s*Planera om strukturen…/);
    expect(card).toMatch(/\{canEditLines && \(\s*<ReplanStructureDialog/);
  });
});

import { describe, expect, it } from "vitest";
import {
  filterTerminalOperations,
  readinessLabel,
  sortTerminalOperations,
} from "../../web/lib/terminalOperations";
import type { TerminalOperation } from "../../web/lib/types";

let n = 0;
function op(over: Partial<TerminalOperation> = {}): TerminalOperation {
  n += 1;
  return {
    operationId: `op-${n}`,
    manufacturingOrderId: `mo-${n}`,
    orderNumber: "TO-1",
    articleNumber: "A1",
    articleName: "Bracket",
    sequenceNo: 10,
    description: null,
    workCenterId: "wc",
    workCenterCode: "110",
    workCenterName: "Svarv",
    orderQuantity: "20",
    quantityCompleted: null,
    quantityScrapped: "0",
    dueDate: null,
    plannedStartWeek: null,
    plannedEndWeek: null,
    readiness: "ready",
    available: "20",
    materials: [],
    packingInstructions: null,
    ...over,
  };
}
const mat = (articleNumber: string, articleName = "x") => ({ articleId: articleNumber, articleNumber, articleName });

describe("sortTerminalOperations", () => {
  it("urgent: due date ascending, undated last, then TO number, then sequence", () => {
    const a = op({ orderNumber: "TO-2", dueDate: null });
    const b = op({ orderNumber: "TO-3", dueDate: "2026-11-01" });
    const c = op({ orderNumber: "TO-2", dueDate: "2026-11-01", sequenceNo: 20 });
    const d = op({ orderNumber: "TO-2", dueDate: "2026-11-01", sequenceNo: 10 });
    const e = op({ orderNumber: "TO-9", dueDate: "2026-10-01", readiness: "not_ready" });
    expect(sortTerminalOperations([a, b, c, d, e], "urgent")).toEqual([e, d, c, b, a]);
  });
  it("planned: planned start week ascending, unplanned last, then as urgent", () => {
    const unplanned = op({ orderNumber: "TO-1", dueDate: "2026-10-01" });
    const w46late = op({ orderNumber: "TO-5", plannedStartWeek: "2026-11-09", plannedEndWeek: "2026-11-16", dueDate: "2026-12-01" });
    const w46early = op({ orderNumber: "TO-6", plannedStartWeek: "2026-11-09", plannedEndWeek: "2026-11-09", dueDate: "2026-11-20" });
    const w45 = op({ orderNumber: "TO-7", plannedStartWeek: "2026-11-02", plannedEndWeek: "2026-11-02", dueDate: null });
    expect(sortTerminalOperations([unplanned, w46late, w46early, w45], "planned")).toEqual([w45, w46early, w46late, unplanned]);
  });
  it("material: by first material number, no material last, then as urgent", () => {
    const none = op({ dueDate: "2026-10-01" });
    const m2late = op({ materials: [mat("M2")], dueDate: "2026-12-01" });
    const m2early = op({ materials: [mat("M2")], dueDate: "2026-11-01" });
    const m1 = op({ materials: [mat("M1"), mat("M9")], dueDate: "2027-01-01" });
    expect(sortTerminalOperations([none, m2late, m2early, m1], "material")).toEqual([m1, m2early, m2late, none]);
  });
  it("does not mutate the input", () => {
    const rows = [op({ dueDate: "2026-12-01" }), op({ dueDate: "2026-11-01" })];
    const copy = [...rows];
    sortTerminalOperations(rows, "urgent");
    expect(rows).toEqual(copy);
  });
});

describe("filterTerminalOperations", () => {
  const ready = op({ readiness: "ready" });
  const partial = op({ readiness: "partial", available: "8" });
  const notReady = op({ readiness: "not_ready" });
  it("onlyReady hides not_ready but keeps partial", () => {
    expect(filterTerminalOperations([ready, partial, notReady], { onlyReady: true, search: "" })).toEqual([ready, partial]);
    expect(filterTerminalOperations([ready, partial, notReady], { onlyReady: false, search: "" })).toHaveLength(3);
  });
  it("search requires every term across TO, article, resource, description and material", () => {
    const a = op({ orderNumber: "TO-77", description: "Grovsvarvning", materials: [mat("R-500", "Rundstång")] });
    const b = op({ orderNumber: "TO-78", workCenterName: "Fräs" });
    const rows = [a, b];
    expect(filterTerminalOperations(rows, { onlyReady: false, search: "to-77" })).toEqual([a]);
    expect(filterTerminalOperations(rows, { onlyReady: false, search: "grovsv r-500" })).toEqual([a]);
    expect(filterTerminalOperations(rows, { onlyReady: false, search: "rundstång" })).toEqual([a]);
    expect(filterTerminalOperations(rows, { onlyReady: false, search: "fräs 110" })).toEqual([b]);
    expect(filterTerminalOperations(rows, { onlyReady: false, search: "fräs to-77" })).toEqual([]);
    expect(filterTerminalOperations(rows, { onlyReady: false, search: "bracket" })).toEqual([a, b]);
  });
});

describe("readinessLabel", () => {
  it("labels ready and not ready", () => {
    expect(readinessLabel(op({ readiness: "ready" }))).toBe("Redo");
    expect(readinessLabel(op({ readiness: "not_ready" }))).toBe("Inte redo");
  });
  it("partial: available of Kvar, sv-SE, float noise hidden", () => {
    expect(readinessLabel(op({ readiness: "partial", available: "8", orderQuantity: "20", quantityCompleted: null }))).toBe("8 av 20 redo");
    expect(readinessLabel(op({ readiness: "partial", available: "8", orderQuantity: "20", quantityCompleted: "5" }))).toBe("8 av 15 redo");
    expect(readinessLabel(op({ readiness: "partial", available: "0.30000000000000004", orderQuantity: "1000.5", quantityCompleted: "0" }))).toBe("0,3 av 1 000,5 redo");
    expect(readinessLabel(op({ readiness: "ready", available: "0", orderQuantity: "5", quantityCompleted: "9" }))).toBe("Redo");
  });
});

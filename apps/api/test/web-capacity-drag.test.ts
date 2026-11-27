import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  OTHER_RESOURCE_TEXT,
  dayLoadLine,
  draggableOrder,
  dropAllowed,
  dropDayText,
  followingLine,
  moveBody,
  moveConfirmText,
  nextDropIndex,
  startIndex,
} from "../../web/lib/capacityDrag.js";
import type { CapacityDayLoad, MoveOperationPreview } from "../../web/lib/types.js";

// Beläggning's drag-to-move (etapp 6b): the pure rules of lib/capacityDrag.ts
// and source guards on the page and the dialog — a drop never writes before
// the preview has been confirmed, the precondition is always sent, and
// another resource never takes a move.

const load = (date: string, loadHours: number, availableHours: number | null, overloaded = false): CapacityDayLoad => ({
  date,
  loadHours,
  availableHours,
  overloaded,
});

// Thu 26 Nov 2026 … Wed 2 Dec; the weekend has no capacity.
const DAYS = ["2026-11-26", "2026-11-27", "2026-11-28", "2026-11-29", "2026-11-30", "2026-12-01", "2026-12-02"].map((date) => ({ date }));
const LOADS = DAYS.map((d, i) => load(d.date, 2, i === 2 || i === 3 ? 0 : 8));

const preview = (over: Partial<MoveOperationPreview> = {}): MoveOperationPreview => ({
  operation: { plannedStartDate: "2026-12-02", plannedEndDate: "2026-12-03" },
  following: [
    { moOperationId: "f1", sequenceNo: 30, plannedStartDate: "2026-12-04", plannedEndDate: "2026-12-04" },
    { moOperationId: "f2", sequenceNo: 40, plannedStartDate: null, plannedEndDate: null },
  ],
  warnings: [],
  dayLoad: { before: load("2026-12-02", 4.2, 8), after: load("2026-12-02", 9.8, 8, true) },
  ...over,
});

describe("dropAllowed", () => {
  const order = { plannedStartDate: "2026-11-26" };
  const day = (workCenterId: string, date: string, availableHours: number | null) => ({ kind: "day" as const, workCenterId, date, availableHours });

  it("takes another day of the same resource", () => {
    expect(dropAllowed(order, "wc1", day("wc1", "2026-11-27", 8))).toEqual({ ok: true });
  });

  it("refuses for each of the four reasons", () => {
    expect(dropAllowed(order, "wc1", { kind: "other" })).toEqual({ ok: false, reason: "not_a_day" });
    expect(dropAllowed(order, "wc1", day("wc2", "2026-11-27", 8))).toEqual({ ok: false, reason: "other_resource" });
    expect(dropAllowed(order, "wc1", day("wc1", "2026-11-26", 8))).toEqual({ ok: false, reason: "same_day" });
    expect(dropAllowed(order, "wc1", day("wc1", "2026-11-28", 0))).toEqual({ ok: false, reason: "no_capacity" });
  });

  it("never takes another resource, whatever the day", () => {
    // Also the operation's own day and a day without capacity there.
    for (const d of [day("wc2", "2026-11-26", 8), day("wc2", "2026-11-28", 0), day("wc2", "2026-11-27", null)]) {
      expect(dropAllowed(order, "wc1", d)).toEqual({ ok: false, reason: "other_resource" });
    }
    expect(OTHER_RESOURCE_TEXT).toBe("Byt resurs görs på TO-kortet");
  });

  it("allows every day on a resource without a calendar — the server decides", () => {
    expect(dropAllowed(order, "wc1", day("wc1", "2026-11-28", null))).toEqual({ ok: true });
  });

  it("an unplanned operation has no day of its own", () => {
    expect(dropAllowed({ plannedStartDate: null }, "wc1", day("wc1", "2026-11-26", 8))).toEqual({ ok: true });
  });
});

describe("draggableOrder and moveBody", () => {
  it("gives a grip only in the day view and only with Tillverkning", () => {
    const order = { moOperationId: "op1" };
    expect(draggableOrder(order, "day", true)).toBe(true);
    expect(draggableOrder(order, "week", true)).toBe(false);
    expect(draggableOrder(order, "day", false)).toBe(false);
  });

  it("always moves the following operations and sends the start day the view showed", () => {
    expect(moveBody({ plannedStartDate: "2026-11-26" }, "2026-12-02")).toEqual({
      date: "2026-12-02",
      moveFollowing: true,
      expectedStartDate: "2026-11-26",
    });
    // Unplanned is null — sent, never left out (left out = no check).
    const body = moveBody({ plannedStartDate: null }, "2026-12-02");
    expect(body.expectedStartDate).toBeNull();
    expect(JSON.parse(JSON.stringify(body))).toHaveProperty("expectedStartDate", null);
  });
});

describe("nextDropIndex", () => {
  it("steps to the next day with capacity, over the weekend", () => {
    expect(nextDropIndex(DAYS, LOADS, 0, 1)).toBe(1);
    expect(nextDropIndex(DAYS, LOADS, 1, 1)).toBe(4);
    expect(nextDropIndex(DAYS, LOADS, 4, -1)).toBe(1);
  });

  it("stays at the edges", () => {
    expect(nextDropIndex(DAYS, LOADS, 0, -1)).toBe(0);
    expect(nextDropIndex(DAYS, LOADS, 6, 1)).toBe(6);
    // Only days without capacity ahead: stays too.
    expect(nextDropIndex(DAYS.slice(0, 4), LOADS.slice(0, 4), 1, 1)).toBe(1);
  });

  it("starts from outside the visible days", () => {
    expect(startIndex(DAYS, { plannedStartDate: null })).toBe(-1);
    expect(startIndex(DAYS, { plannedStartDate: "2026-11-20" })).toBe(-1);
    expect(startIndex(DAYS, { plannedStartDate: "2026-11-30" })).toBe(4);
    expect(nextDropIndex(DAYS, LOADS, -1, 1)).toBe(0);
    expect(nextDropIndex(DAYS, LOADS, -1, -1)).toBe(-1);
  });

  it("skips nothing on a resource without a calendar", () => {
    const none = DAYS.map((d) => load(d.date, 0, null));
    expect(nextDropIndex(DAYS, none, 1, 1)).toBe(2);
    expect(nextDropIndex(DAYS, [], 1, 1)).toBe(2);
  });
});

describe("the texts", () => {
  it("reads out the target day", () => {
    expect(dropDayText("2026-12-02", load("2026-12-02", 5, 8))).toBe("ons 2 dec — ledigt 3 h av 8");
    expect(dropDayText("2026-12-02", load("2026-12-02", 9, 8, true))).toBe("ons 2 dec — ledigt 0 h av 8");
    expect(dropDayText("2026-11-28", load("2026-11-28", 0, 0))).toBe("lör 28 nov — ingen kapacitet");
    expect(dropDayText("2026-12-02", load("2026-12-02", 5, null))).toBe("ons 2 dec");
    expect(dropDayText("2026-12-02", undefined)).toBe("ons 2 dec");
  });

  it("writes the day's load before → after", () => {
    expect(dayLoadLine(preview().dayLoad)).toBe("Dagens last 4,2 h → 9,8 h av 8 h (överbelagd)");
    expect(dayLoadLine({ before: load("d", 0, 8), after: load("d", 3, 8) })).toBe("Dagens last 0 h → 3 h av 8 h");
    // No calendar: no capacity to measure against.
    expect(dayLoadLine({ before: load("d", 1, null), after: load("d", 4.5, null) })).toBe("Dagens last 1 h → 4,5 h");
  });

  it("lists the following operations with their new days", () => {
    expect(followingLine(preview())).toBe("Följer med: op 30 (4 dec), op 40");
    expect(followingLine(preview({ following: [] }))).toBeNull();
  });

  it("asks with the whole preview", () => {
    expect(moveConfirmText({ orderNumber: "TO-1050", sequenceNo: 20 }, "2026-12-02", preview())).toBe(
      [
        "Flytta op 20 på TO-1050 till ons 2 dec? Efterföljande operationer följer med och operationen låses.",
        "",
        "Planeras 2–3 dec",
        "Följer med: op 30 (4 dec), op 40",
        "Dagens last 4,2 h → 9,8 h av 8 h (överbelagd)",
      ].join("\n")
    );
  });

  it("names every warning of the preview in the question", () => {
    const warning = (message: string) => ({ kind: "late" as const, manufacturingOrderId: "m1", orderNumber: "TO-1050", message });
    const text = moveConfirmText(
      { orderNumber: "TO-1050", sequenceNo: 20 },
      "2026-12-02",
      preview({ following: [], warnings: [warning("TO-1050 blir klar 9 dec, efter färdigdatumet 4 dec"), warning("Op 20 börjar före föregående operation är klar")] })
    );
    expect(text).toContain("\n\nObservera:\n– TO-1050 blir klar 9 dec, efter färdigdatumet 4 dec\n– Op 20 börjar före föregående operation är klar");
    expect(text).not.toContain("Följer med");
  });
});

describe("source guards", () => {
  const web = (path: string) => readFileSync(fileURLToPath(new URL(`../../web/${path}`, import.meta.url)), "utf8");
  const page = web("components/planning/BelaggningPageClient.tsx");
  const dialog = web("components/planning/MoveOperationDialog.tsx");
  const writes = web("components/planning/dayPlanWrites.ts");

  it("drags only with Tillverkning, in the day view, with a fine pointer and with nothing running", () => {
    expect(page).toContain('window.matchMedia("(pointer: fine)")');
    expect(page).toMatch(/const canDrag = canPlan && data\?\.granularity === "day" && finePointer;/);
    expect(page).toMatch(/const moveReady = canDrag && !loading && !moveBusy && !planBusy;/);
    expect(page).toContain("{moveDrag.canDrag && draggableOrder(o, granularity, moveDrag.canPlan) && (");
    expect(page).toContain("draggable={moveDrag.ready}");
    // Every way to start or finish a move refuses while something runs.
    for (const handler of ["onDragStart: (order, workCenterId) => {", "onGrip: (order, resource) => {"]) {
      expect(page.slice(page.indexOf(handler)), handler).toMatch(/^[^\n]+\n\s+if \(!moveReady\) return;/);
    }
    expect(page).toMatch(/onDrop: \(resource, date\) => \{[^}]*?if \(!move \|\| !moveReady\) return;/);
  });

  it("makes the grip a button the keyboard can use", () => {
    const at = page.indexOf("className={styles.grip}");
    const grip = page.slice(page.lastIndexOf("<", at), page.indexOf("<GripVertical"));
    expect(grip).toMatch(/<button\s+type="button"\s+className=\{styles\.grip\}/);
    expect(grip).toContain("aria-label={`${moveLabel(o)} med piltangenterna`}");
    expect(grip).toContain("onKeyDown={onGripKeyDown}");
    expect(page).toMatch(/e\.key === "ArrowLeft" \|\| e\.key === "ArrowRight"/);
    expect(page).toMatch(/e\.key === "Escape"/);
    expect(page).toContain('aria-live="polite"');
  });

  it("asks with the preview before every drop move, and writes only after the answer", () => {
    // ONE function moves after a drop, and it is the only caller of the write.
    expect(page.match(/\bmoveOperationTo\(/g) ?? []).toHaveLength(1);
    expect(page.match(/\bpreviewMove\(/g) ?? []).toHaveLength(1);
    expect(page).not.toMatch(/operations\/\$\{[^}]+\}\/move/);
    const fn = page.slice(page.indexOf("async function moveByDrop("), page.indexOf("function dayTarget("));
    const previewAt = fn.indexOf("const preview = await previewMove(order.moOperationId, body);");
    const confirmAt = fn.indexOf('const ok = await confirmDialog(moveConfirmText(order, date, preview), { confirmLabel: "Flytta" });');
    const refuseAt = fn.indexOf("if (!ok) return;");
    const writeAt = fn.indexOf("await moveOperationTo(order.moOperationId, body.date, body.expectedStartDate);");
    expect(previewAt).toBeGreaterThan(-1);
    expect(confirmAt).toBeGreaterThan(previewAt);
    expect(refuseAt).toBeGreaterThan(confirmAt);
    expect(writeAt).toBeGreaterThan(refuseAt);
    expect(fn).toMatch(/^async function moveByDrop\([^)]*\) \{\n\s+if \(!canPlan \|\| moveBusy\) return;/);
    // The body — with the precondition — is capacityDrag's, for both calls.
    expect(fn).toContain("const body = moveBody(order, date);");
    // A refused preview is shown as it is; a changed plan reads again.
    expect(fn).toContain('apiErrorMessage(err, "Kunde inte flytta operationen")');
    expect(fn).toMatch(/err\.code === "operation-plan-changed"\) setReloadTick/);
    // Both callers of moveByDrop went through dropAllowed first.
    const calls = [...page.matchAll(/void moveByDrop\(/g)];
    expect(calls).toHaveLength(2);
    for (const call of calls) expect(page.slice(call.index! - 160, call.index!)).toMatch(/dropAllowed\(/);
  });

  it("never moves on a drop on another resource, and takes no drop on a day without capacity", () => {
    expect(page).toContain('else if (verdict.reason === "other_resource") setMoveError(OTHER_RESOURCE_TEXT);');
    // Only "ok" and (to say why not) "other_resource" accept the dragover.
    expect(page).toMatch(/if \(drop\.state === "ok" \|\| drop\.state === "other_resource"\) \{[^}]*e\.preventDefault\(\);/);
    expect(page).toContain('e.dataTransfer.dropEffect = "none";');
    // Only the resource's day cells are drop targets: Senare, Odaterat and Summa get none.
    expect(page.match(/\sdrop=\{/g) ?? []).toHaveLength(1);
    expect(page).toContain('drop={granularity === "day" ? dropFor(moveDrag.days[i]?.date) : undefined}');
  });

  it("the page never calls window.confirm", () => {
    expect(page).not.toMatch(/window\.confirm|[^a-zA-Z]confirm\(/);
  });

  it("the dialog previews before Flytta and always sends expectedStartDate", () => {
    expect(writes).toContain("/move/preview`");
    expect(writes).toMatch(/export function previewMove\(\s*moOperationId: string,\s*input: \{ date: string; moveFollowing: boolean; expectedStartDate: string \| null \}/);
    expect(dialog).toContain("const expectedStartDate = order.plannedStartDate;");
    expect(dialog).toContain("previewMove(moOperationId, { date, moveFollowing, expectedStartDate })");
    expect(dialog).toContain("body: JSON.stringify({ date, moveFollowing, expectedStartDate }),");
    // The one write of a move in the dialog.
    expect(dialog.match(/\/move`/g) ?? []).toHaveLength(1);
    // Debounced with a request sequence.
    expect(dialog).toContain("const PREVIEW_DELAY_MS = 300;");
    expect(dialog).toContain("if (seq !== sequence.current) return;");
    // Flytta needs a preview of what is shown, without an error.
    expect(dialog).toContain("if (!validDate || !shown || previewError || busy) return;");
    expect(dialog).toContain("disabled={busy || !validDate || !shown || previewError !== null}");
    // The warnings and the day's load come before the buttons.
    expect(dialog.indexOf("shown.warnings.map")).toBeGreaterThan(-1);
    expect(dialog.indexOf("shown.warnings.map")).toBeLessThan(dialog.indexOf("<FormActions>"));
    expect(dialog.indexOf("dayLoadLine(shown.dayLoad)")).toBeLessThan(dialog.indexOf("<FormActions>"));
  });
});

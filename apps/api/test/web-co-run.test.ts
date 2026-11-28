import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  coRunFollowingText,
  coRunLoadText,
  coRunOperationText,
  coRunPayload,
  coRunSupplyText,
  defaultCoRunDate,
  materialGroupText,
  materialSections,
  rowMaterialNeed,
  runPlanView,
  selectableForCoRun,
  selectedInListOrder,
} from "../../web/lib/coRun.js";
import { dayPlanHref } from "../../web/lib/dayPlan.js";
import type { RunPlanMaterial, RunPlanMaterialGroup, RunPlanRow } from "../../web/lib/types.js";

// Planera efter material and Samkör: the web's pure helpers
// (apps/web/lib/coRun.ts) and the source guards around the selection and the
// dialog — who may choose, where the writes live, that Mötesläget has neither.

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
  plannedEndDate: "2026-11-26",
  planLocked: false,
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

const group = (over: Partial<RunPlanMaterialGroup> = {}): RunPlanMaterialGroup => ({
  articleId: "a-1",
  articleNumber: "1001",
  articleName: "Plåt",
  unit: "st",
  totalRemainingQuantity: 14.5,
  usableOnHand: 22,
  short: false,
  rowKeys: [],
  ...over,
});

const op = (id: string, over: Partial<RunPlanRow> = {}): RunPlanRow => row({ key: id, moOperationId: id, ...over });

describe("the view", () => {
  it("is Material only for ?visa=material", () => {
    expect(runPlanView("material")).toBe("material");
    expect(runPlanView(null)).toBe("order");
    expect(runPlanView("")).toBe("order");
    expect(runPlanView("korordning")).toBe("order");
  });
  it("is carried in Dagplan's address", () => {
    expect(dayPlanHref("/tillverkning/dagplan", { dag: "2026-11-27", visa: "material" })).toBe("/tillverkning/dagplan?dag=2026-11-27&visa=material");
    expect(dayPlanHref("/tillverkning/dagplan", { visa: null })).toBe("/tillverkning/dagplan");
  });
});

describe("selectableForCoRun", () => {
  it("takes an open order's operation with time left", () => {
    expect(selectableForCoRun(row())).toBe(true);
    expect(selectableForCoRun(row({ status: "not_ready", plannedStartDate: null }))).toBe(true);
    expect(selectableForCoRun(row({ remainingMinutes: 0.01 }))).toBe(true);
  });
  it("refuses a Planerad TO's row, a row without an operation and one without time", () => {
    expect(selectableForCoRun(row({ status: "planned_order", moOperationId: null }))).toBe(false);
    expect(selectableForCoRun(row({ status: "planned_order" }))).toBe(false);
    expect(selectableForCoRun(row({ moOperationId: null }))).toBe(false);
    expect(selectableForCoRun(row({ remainingMinutes: 0.009 }))).toBe(false);
    expect(selectableForCoRun(row({ remainingMinutes: 0 }))).toBe(false);
  });
});

describe("defaultCoRunDate", () => {
  const today = "2026-11-26";
  it("is the earliest planned start that has not passed", () => {
    expect(defaultCoRunDate([{ plannedStartDate: "2026-12-02" }, { plannedStartDate: "2026-11-30" }, { plannedStartDate: "2026-12-01" }], today)).toBe(
      "2026-11-30"
    );
    expect(defaultCoRunDate([{ plannedStartDate: today }, { plannedStartDate: "2026-11-30" }], today)).toBe(today);
  });
  it("skips passed and unplanned starts, and falls back on today", () => {
    expect(defaultCoRunDate([{ plannedStartDate: "2026-11-24" }, { plannedStartDate: null }, { plannedStartDate: "2026-12-03" }], today)).toBe("2026-12-03");
    expect(defaultCoRunDate([{ plannedStartDate: "2026-11-24" }, { plannedStartDate: null }], today)).toBe(today);
    expect(defaultCoRunDate([], today)).toBe(today);
  });
});

describe("coRunPayload", () => {
  it("sends the operations in the given order with the start day the list showed", () => {
    expect(
      coRunPayload("wc-1", "2026-11-30", [
        op("op-b", { plannedStartDate: "2026-12-01" }),
        op("op-a", { plannedStartDate: null }),
        op("op-c", { plannedStartDate: "2026-11-24" }),
      ])
    ).toEqual({
      workCenterId: "wc-1",
      date: "2026-11-30",
      operations: [
        { moOperationId: "op-b", plannedStartDate: "2026-12-01" },
        { moOperationId: "op-a", plannedStartDate: null },
        { moOperationId: "op-c", plannedStartDate: "2026-11-24" },
      ],
    });
  });
  it("sends an operation once and never a row without one", () => {
    const payload = coRunPayload("wc-1", "2026-11-30", [op("op-a"), op("op-a"), row({ key: "p-1", moOperationId: null }), op("op-b")]);
    expect(payload.operations.map((o) => o.moOperationId)).toEqual(["op-a", "op-b"]);
  });
});

describe("selectedInListOrder", () => {
  it("gives the chosen rows in the order of the list, whatever order they were ticked in", () => {
    const rows = [op("op-a"), op("op-b"), op("op-c"), op("op-d")];
    expect(selectedInListOrder(rows, new Set(["op-d", "op-a", "op-c"])).map((r) => r.moOperationId)).toEqual(["op-a", "op-c", "op-d"]);
  });
  it("counts an operation once and drops what cannot be chosen", () => {
    const rows = [op("op-a"), op("op-a"), op("op-b", { remainingMinutes: 0 }), op("op-c", { status: "planned_order" })];
    expect(selectedInListOrder(rows, new Set(["op-a", "op-b", "op-c", "gone"])).map((r) => r.moOperationId)).toEqual(["op-a"]);
  });
});

describe("materialSections", () => {
  const plate = material();
  const profile = material({ articleId: "a-2", articleNumber: "1901", articleName: "Profil" });
  const rows = [
    op("op-a", { materials: [plate], materialLinked: true }),
    op("op-b", { materials: [plate, profile], materialLinked: true }),
    op("op-c"), // nothing linked
    op("op-d", { materials: [], materialLinked: true }), // everything drawn
    row({ key: "planned-1", moOperationId: null, status: "planned_order" }),
    op("op-e", { materials: [profile], materialLinked: true }),
  ];
  const groups = [group({ rowKeys: ["op-a", "op-b"] }), group({ articleId: "a-2", articleNumber: "1901", rowKeys: ["op-b", "op-e"] })];
  const sections = materialSections(rows, groups, ["op-c"]);

  it("puts the rows under the API's groups, a row with two materials in both", () => {
    expect(sections.groups.map((g) => [g.group.articleNumber, g.rows.map((r) => r.key)])).toEqual([
      ["1001", ["op-a", "op-b"]],
      ["1901", ["op-b", "op-e"]],
    ]);
  });
  it("keeps the unlinked rows, the fully drawn and the rest apart", () => {
    expect(sections.unlinked.map((r) => r.key)).toEqual(["op-c"]);
    expect(sections.drawn.map((r) => r.key)).toEqual(["op-d"]);
    expect(sections.other.map((r) => r.key)).toEqual(["planned-1"]);
  });
  it("loses no row", () => {
    const shown = new Set([...sections.groups.flatMap((g) => g.rows), ...sections.unlinked, ...sections.drawn, ...sections.other].map((r) => r.key));
    expect([...shown].sort()).toEqual(rows.map((r) => r.key).sort());
  });
  it("ignores keys that are not listed and drops a group without rows", () => {
    const partial = materialSections([rows[0]!], [...groups, group({ articleId: "a-3", rowKeys: ["gone"] })], ["gone-too"]);
    expect(partial.groups.map((g) => g.rows.map((r) => r.key))).toEqual([["op-a"]]);
    expect(partial.unlinked).toEqual([]);
  });
});

describe("the texts", () => {
  it("says the group's need against the usable balance", () => {
    expect(materialGroupText(group())).toBe("behov 14,5 st · användbart saldo 22 st");
    expect(materialGroupText(group({ unit: null, totalRemainingQuantity: 3, usableOnHand: 0 }))).toBe("behov 3 · användbart saldo 0");
  });
  it("sums a row's own need of the group's article", () => {
    const short = material({ remainingQuantity: 1.25, status: "short", missingQuantity: 1 });
    const both = rowMaterialNeed(row({ materials: [material({ remainingQuantity: 2.5 }), short, material({ articleId: "a-2" })] }), "a-1");
    expect(both?.text).toBe("3,75 st");
    // The status shown is the short row's when one of them is short.
    expect(both?.material).toBe(short);
    expect(rowMaterialNeed(row({ materials: [material({ articleId: "a-2" })] }), "a-1")).toBeNull();
  });
  it("says where a group's missing material comes from and what nothing covers of the chosen rows", () => {
    const supply = { kind: "purchase_order" as const, documentId: "po-1", documentNumber: "IO-88", date: "2026-12-02", late: false, isDraft: false };
    const covered = material({ status: "short", missingQuantity: 0, supply });
    expect(coRunSupplyText([row({ materials: [covered] })], "a-1")).toBe("kommer 2 dec · IO-88");
    // The rows together: 3 + 5 that nothing covers.
    const rows = [
      row({ materials: [material({ materialRowId: "r-1", status: "short", missingQuantity: 3, supply })] }),
      row({ key: "op-2", moOperationId: "op-2", materials: [material({ materialRowId: "r-2", status: "short", missingQuantity: 5 }), material({ articleId: "a-2", status: "short", missingQuantity: 9 })] }),
    ];
    expect(coRunSupplyText(rows, "a-1")).toBe("kommer 2 dec · IO-88 · saknas 8 st");
    const late = [row({ materials: [material({ status: "short", missingQuantity: 0, supply: { ...supply, date: "2026-11-25", late: true } })] })];
    expect(coRunSupplyText(late, "a-1")).toBe("försenad sedan 25 nov · IO-88");
    // Nothing on its way, or nothing short: no text.
    expect(coRunSupplyText(rows, "a-2")).toBeNull();
    expect(coRunSupplyText([row({ materials: [material()] })], "a-1")).toBeNull();
  });
  it("says where each chosen operation goes", () => {
    const base = { fromDate: "2026-11-26", plannedStartDate: "2026-12-02", plannedEndDate: "2026-12-02" };
    expect(coRunOperationText({ ...base, outcome: "moved" })).toBe("tors 26 nov → ons 2 dec");
    expect(coRunOperationText({ ...base, outcome: "moved", plannedEndDate: "2026-12-03" })).toBe("tors 26 nov → ons 2 dec (klar tors 3 dec)");
    expect(coRunOperationText({ ...base, outcome: "moved", fromDate: null })).toBe("ej planerad → ons 2 dec");
    expect(coRunOperationText({ ...base, outcome: "already_on_day" })).toBe("ligger redan på dagen");
    expect(coRunOperationText({ fromDate: "2026-11-26", plannedStartDate: null, plannedEndDate: null, outcome: "not_placed" })).toBe("ryms inte inom två år");
  });
  it("says where a following operation goes", () => {
    expect(coRunFollowingText({ fromStartDate: "2026-11-26", plannedStartDate: "2026-11-30", plannedEndDate: "2026-12-01" })).toBe("tors 26 nov → 30 nov–1 dec");
    expect(coRunFollowingText({ fromStartDate: null, plannedStartDate: "2026-11-30", plannedEndDate: "2026-11-30" })).toBe("ej planerad → 30 nov");
    expect(coRunFollowingText({ fromStartDate: "2026-11-26", plannedStartDate: null, plannedEndDate: null })).toBe("tors 26 nov → ej planerad");
  });
  it("says the day's load before and after, with the API's own flags", () => {
    const load = (loadHours: number, availableHours: number | null, overloaded = false) => ({ date: "2026-12-02", loadHours, availableHours, overloaded });
    expect(coRunLoadText({ before: load(4.2, 8), after: load(7.8, 8) })).toBe("4,2 h → 7,8 h av 8 h");
    expect(coRunLoadText({ before: load(4.2, 8), after: load(9.8, 8, true) })).toBe("4,2 h → 9,8 h av 8 h · överbelagd");
    expect(coRunLoadText({ before: load(0, null), after: load(3, null) })).toBe("0 h → 3 h");
    expect(coRunLoadText({ before: load(0, 0), after: load(3, 0, true) })).toBe("0 h → 3 h · ingen kapacitet");
  });
});

// Source guards, as the other web-* tests: the selection and the dialog are
// for users with Tillverkning, the two POSTs live with the page's other
// writes, and the pure file stays pure.
describe("the Material view and Samkör in the pages", () => {
  const web = (path: string) => readFileSync(fileURLToPath(new URL(`../../web/${path}`, import.meta.url)), "utf8");
  const dayPlan = web("components/planning/DayPlanPageClient.tsx");
  const runPlan = web("components/manufacturing/RunPlanPageClient.tsx");
  const groups = web("components/planning/MaterialGroups.tsx");
  const dialog = web("components/planning/CoRunDialog.tsx");

  it("keeps lib/coRun.ts free of fetch and React", () => {
    const lib = web("lib/coRun.ts");
    expect(lib).not.toMatch(/apiFetch|from "react"|"use client"/);
  });

  // Mötesläget has Grupp and Visa too (the user's wish 2026-11-27), but its
  // Material view stays read-only: canSelect is canWrite, which is never true
  // in a meeting, and the rows carry no links.
  it("shows Material in Mötesläget without checkboxes or links", () => {
    // Material is the resource sections' own view (planView), beside the
    // order lists (web-day-plan.test.ts).
    expect(dayPlan).toMatch(/const view: DayPlanView = dayPlanView\(searchParams\.get\("visa"\), canSeeOrders\);/);
    expect(dayPlan).toMatch(/const planView: RunPlanView = view === "material" \? "material" : "order";/);
    expect(dayPlan).toMatch(/<ResourceSection[^>]*view=\{planView\}/s);
    // One switch, rendered in both the page's toolbar and Mötesläget's bar.
    expect(dayPlan.match(/<SegmentedToggle/g) ?? []).toHaveLength(1);
    expect(dayPlan.match(/\{viewField\}/g) ?? []).toHaveLength(2);
    expect(dayPlan).toMatch(/<MaterialGroups[^>]*canSelect=\{canWrite\}\s+links=\{!meeting\}/s);
    expect(dayPlan).toMatch(/const canWrite = !meeting && can\(\["tillverkning"\]\);/);
  });

  it("offers the checkboxes and the dialog only with Tillverkning", () => {
    expect(dayPlan).toMatch(/<MaterialGroups[^>]*canSelect=\{canWrite\}/s);
    expect(dayPlan).toMatch(/\{canWrite && data && \(\s*<CoRunDialog/);
    expect(dayPlan.match(/<CoRunDialog/g) ?? []).toHaveLength(1);
    expect(runPlan).toMatch(/const canOrder = useCan\(\)\(\["tillverkning"\]\);/);
    expect(runPlan).toMatch(/<MaterialGroups[^>]*canSelect=\{canOrder\}/s);
    expect(runPlan).toMatch(/\{canOrder && data && \(\s*<CoRunDialog/);
    // No checkbox without the right, and only on a row that can be chosen.
    expect(groups).toMatch(/const selecting = canSelect && onCoRun !== undefined;/);
    expect(groups).toMatch(/\{id && selectableForCoRun\(row\) && \(\s*<Checkbox/);
    expect(groups.match(/<Checkbox/g) ?? []).toHaveLength(1);
  });

  it("never writes from the Material view itself", () => {
    expect(groups).not.toMatch(/apiFetch|dayPlanWrites/);
    // The dialog's two calls are the ones in dayPlanWrites.ts — no fetch of its own.
    expect(dialog).not.toMatch(/apiFetch|method:\s*["'`]/);
    const writes = web("components/planning/dayPlanWrites.ts");
    expect(writes).toContain('"/api/v1/planning/co-run/preview"');
    expect(writes).toContain('"/api/v1/planning/co-run"');
    expect(dialog).toContain("previewCoRun(coRunPayload(workCenter.id, date, rows))");
    expect(dialog).toContain("writeCoRun(coRunPayload(workCenter.id, date, rows))");
  });

  it("asks the server's day, pauses before a preview and drops a late answer", () => {
    expect(dialog).toContain("min={today}");
    expect(dialog).not.toMatch(/stockholmToday|new Date\(/);
    expect(dialog).toContain("const PREVIEW_DELAY_MS = 300;");
    expect(dialog.match(/if \(seq !== sequence\.current\) return;/g) ?? []).toHaveLength(2);
    // Samkör needs a preview of the day that is shown, without an error.
    expect(dialog).toContain("preview !== null && preview.date === date && previewError === null");
  });

  it("treats 409 co-run-changed alike on the preview and the write: the page's onConflict", () => {
    expect(dialog.match(/err\.code === "co-run-changed"/g) ?? []).toHaveLength(2);
    // The preview's branch sits in the preview's catch, after the sequence test.
    expect(dialog).toMatch(/if \(seq !== sequence\.current\) return;\s+const message = apiErrorMessage\(err, "Kunde inte förhandsvisa samkörningen"\);[\s\S]{0,260}onConflictNow\.current\(message\);\s+else setPreviewError\(message\);/);
    // Both pages close the dialog, say so in a notice and read again.
    for (const page of [dayPlan, runPlan]) expect(page).toMatch(/onConflict=\{\(message\) => \{[\s\S]{0,260}setCoRunTarget\(null\);\s+setNotice\(/);
  });

  it("starts the dialog on the page's day in Dagplan and on the chosen rows' day in Körplan", () => {
    expect(dayPlan).toContain("setCoRunTarget({ workCenter: resource.workCenter, rows, date: data.date })");
    expect(runPlan).toContain("date: defaultCoRunDate(rows, data.today)");
  });
});

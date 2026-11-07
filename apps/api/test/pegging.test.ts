import { describe, expect, it } from "vitest";
import { buildArticleOverview, type ArticleOverview, type ArticleOverviewInput, type ArticleOverviewRow } from "../src/modules/planning/service/article-overview.js";
import { pegOverview, STOCK_PEG_ID } from "../src/modules/planning/service/pegging.js";
import { findFirmDemand, type FirmDemand } from "../src/modules/planning/service/due-date-suggestion.js";

// Pure tests — no database. Pegging (#9): FIFO allocation of stock and the
// open supplies to the demands in overview order, and the invariant that
// the quantity left uncovered per demand is exactly the prefix-sum walk
// findFirmDemand used before it was rewritten on top of pegOverview.

const TODAY = "2030-03-04"; // Monday
const NO_HOLIDAYS = new Set<string>();

function overview(partial: Partial<ArticleOverviewInput>) {
  return buildArticleOverview({
    article: {
      articleId: "a",
      articleNumber: "A",
      name: "Artikel a",
      type: "manufactured",
      isPhantom: false,
      active: true,
      unitCode: "st",
      reorderPoint: null,
      orderQuantity: null,
      rounding: null,
    },
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

function salesRow(rowId: string, orderNumber: string, date: string | null, quantity: number) {
  return {
    rowId,
    salesOrderId: `so-${rowId}`,
    orderNumber,
    orderStatus: "confirmed" as const,
    customerName: "Kund",
    expectedDeliveryDate: date,
    quantityOrdered: quantity,
    quantityDelivered: 0,
  };
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

function mo(moId: string, orderNumber: string, dueDate: string | null, quantity: number) {
  return { moId, orderNumber, status: "released" as const, dueDate, quantity };
}

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

const peg = (o: ArticleOverview, readyDates: [string, string | null][] = [], offDays = NO_HOLIDAYS) =>
  pegOverview(o, { today: TODAY, readyDates: new Map(readyDates), offDays });

const allocs = (p: ReturnType<typeof pegOverview>, demandId: string) =>
  p.demands.find((d) => d.id === demandId)!.allocations.map((a) => [a.supplyId, a.quantity]);

describe("pegOverview — FIFO", () => {
  it("stock first, then the supplies in overview order; each demand takes from the first supply with something left", () => {
    const o = overview({
      onHand: 5,
      purchaseRows: [po("p1", "IO-1", "2030-03-06", 10)],
      manufacturingOrders: [mo("m1", "TO-1", "2030-03-08", 10)],
      salesRows: [salesRow("r1", "KO-1", "2030-03-10", 8), salesRow("r2", "KO-2", "2030-03-12", 12), salesRow("r3", "KO-3", "2030-03-14", 10)],
    });
    const p = peg(o);
    expect(p.supplies.map((s) => s.id)).toEqual([STOCK_PEG_ID, "po:p1", "mo:m1"]);
    expect(allocs(p, "so:r1")).toEqual([
      [STOCK_PEG_ID, 5],
      ["po:p1", 3],
    ]);
    expect(allocs(p, "so:r2")).toEqual([
      ["po:p1", 7],
      ["mo:m1", 5],
    ]);
    expect(allocs(p, "so:r3")).toEqual([["mo:m1", 5]]);
    expect(p.demands.map((d) => d.uncovered)).toEqual([0, 0, 5]);
    expect(p.supplies.map((s) => s.surplus)).toEqual([0, 0, 0]);
    // The supply side mirrors the demand side.
    expect(p.supplies[2]!.allocations.map((a) => [a.demandId, a.quantity])).toEqual([
      ["so:r2", 5],
      ["so:r3", 5],
    ]);
  });

  it("negative stock is a demand today before every other, filled by the first supply", () => {
    const o = overview({
      onHand: -4,
      manufacturingOrders: [mo("m1", "TO-1", "2030-03-08", 10)],
      salesRows: [salesRow("r1", "KO-1", "2030-03-10", 8)],
    });
    const p = peg(o);
    expect(p.demands.map((d) => [d.id, d.date, d.quantity])).toEqual([
      [STOCK_PEG_ID, TODAY, 4],
      ["so:r1", "2030-03-10", 8],
    ]);
    expect(allocs(p, STOCK_PEG_ID)).toEqual([["mo:m1", 4]]);
    // The TO is ready after today — late for the shortage, by 4 working days.
    expect(p.demands[0]!.allocations[0]).toMatchObject({ late: true, daysLate: 4, readyDate: "2030-03-08" });
    expect(allocs(p, "so:r1")).toEqual([["mo:m1", 6]]);
    expect(p.demands[1]!.uncovered).toBe(2);
    expect(p.supplies).toHaveLength(1);
  });

  it("the surplus is what no demand takes — till lager", () => {
    const o = overview({
      onHand: 2,
      manufacturingOrders: [mo("m1", "TO-1", "2030-03-08", 10), mo("m2", "TO-2", "2030-03-15", 10)],
      salesRows: [salesRow("r1", "KO-1", "2030-03-10", 5)],
    });
    const p = peg(o);
    expect(p.supplies.map((s) => [s.id, s.surplus])).toEqual([
      [STOCK_PEG_ID, 0],
      ["mo:m1", 7],
      ["mo:m2", 10],
    ]);
    // No demands at all: everything is surplus.
    const idle = peg(overview({ onHand: 3, manufacturingOrders: [mo("m1", "TO-1", null, 4)] }));
    expect(idle.supplies.map((s) => s.surplus)).toEqual([3, 4]);
    expect(idle.demands).toEqual([]);
  });

  it("rounds at the overview's four decimals so an exactly covered demand is not a 1e-15 shortage", () => {
    const o = overview({
      onHand: 0.1,
      purchaseRows: [po("p1", "IO-1", "2030-03-06", 0.2)],
      salesRows: [salesRow("r1", "KO-1", "2030-03-10", 0.3)],
    });
    const p = peg(o);
    expect(p.demands[0]!.uncovered).toBe(0);
    expect(p.supplies.map((s) => s.surplus)).toEqual([0, 0]);
  });
});

describe("pegOverview — late, on time, undated", () => {
  it("is late when the supply's ready date lies after the demand's; the same day is on time", () => {
    const o = overview({
      manufacturingOrders: [mo("m1", "TO-1", "2030-03-10", 5), mo("m2", "TO-2", "2030-03-14", 5)],
      salesRows: [salesRow("r1", "KO-1", "2030-03-10", 5), salesRow("r2", "KO-2", "2030-03-12", 5)],
    });
    const p = peg(o);
    expect(p.demands[0]!.allocations[0]).toMatchObject({ supplyId: "mo:m1", late: false, undated: false, daysLate: 0, readyDate: "2030-03-10" });
    // Tue 12 → Thu 14: two working days late.
    expect(p.demands[1]!.allocations[0]).toMatchObject({ supplyId: "mo:m2", late: true, undated: false, daysLate: 2, readyDate: "2030-03-14" });
  });

  it("reads the TO's ready date from readyDates (plannedFinish) instead of its due date", () => {
    const o = overview({
      manufacturingOrders: [mo("m1", "TO-1", "2030-03-10", 5)],
      salesRows: [salesRow("r1", "KO-1", "2030-03-12", 5)],
    });
    // Due in time, but the plan finishes it the week after.
    expect(peg(o, [["mo:m1", "2030-03-15"]]).demands[0]!.allocations[0]).toMatchObject({ late: true, daysLate: 3, readyDate: "2030-03-15" });
    // The plan says null = undated.
    expect(peg(o, [["mo:m1", null]]).demands[0]!.allocations[0]).toMatchObject({ late: false, undated: true, readyDate: null, daysLate: 0 });
  });

  it("counts daysLate in working days — weekends and full-day holidays are skipped", () => {
    const o = overview({
      manufacturingOrders: [mo("m1", "TO-1", "2030-03-13", 5)], // Wed next week
      salesRows: [salesRow("r1", "KO-1", "2030-03-07", 5)], // Thu
    });
    expect(peg(o).demands[0]!.allocations[0]!.daysLate).toBe(4); // Fri 8, Mon 11, Tue 12, Wed 13
    expect(peg(o, [], new Set(["2030-03-08", "2030-03-12"])).demands[0]!.allocations[0]!.daysLate).toBe(2);
  });

  it("floors a passed ready date at today — passed is not done", () => {
    const o = overview({
      manufacturingOrders: [mo("m1", "TO-1", "2030-02-20", 6)],
      salesRows: [salesRow("r1", "KO-1", "2030-02-25", 5), salesRow("r2", "KO-2", TODAY, 1)],
    });
    const p = peg(o);
    // Both demand and supply have passed; the supply is ready today at the
    // earliest, the demand was wanted on Feb 25: late by the working days
    // between then and today.
    expect(p.demands[0]!.allocations[0]).toMatchObject({ readyDate: TODAY, late: true, daysLate: 5 });
    expect(p.demands[1]!.allocations[0]).toMatchObject({ readyDate: TODAY, late: false });
    expect(p.supplies[0]!.readyDate).toBe(TODAY);
  });

  it("an undated supply against a dated demand is undated, not late; an undated demand is never late", () => {
    const o = overview({
      manufacturingOrders: [mo("m1", "TO-1", null, 5), mo("m2", "TO-2", "2030-03-20", 5)],
      salesRows: [salesRow("r1", "KO-1", "2030-03-10", 5), salesRow("r2", "KO-2", null, 5)],
    });
    const p = peg(o);
    // Overview order: dated supply first (undated last), dated demand first.
    expect(p.demands[0]!.allocations[0]).toMatchObject({ supplyId: "mo:m2", late: true, undated: false, daysLate: 8 });
    expect(p.demands[1]!.allocations[0]).toMatchObject({ supplyId: "mo:m1", late: false, undated: false, daysLate: 0, readyDate: null });
    const o2 = overview({ manufacturingOrders: [mo("m1", "TO-1", null, 5)], salesRows: [salesRow("r1", "KO-1", "2030-03-10", 5)] });
    expect(peg(o2).demands[0]!.allocations[0]).toMatchObject({ late: false, undated: true, daysLate: 0 });
  });

  it("stock is ready today and never late or undated — not even for a demand whose date has passed", () => {
    const o = overview({ onHand: 10, salesRows: [salesRow("r1", "KO-1", "2030-02-01", 5), salesRow("r2", "KO-2", null, 5)] });
    const p = peg(o);
    expect(p.demands.map((d) => d.allocations[0])).toEqual([
      expect.objectContaining({ supplyId: STOCK_PEG_ID, late: false, undated: false, readyDate: TODAY, daysLate: 0 }),
      expect.objectContaining({ supplyId: STOCK_PEG_ID, late: false, undated: false, readyDate: TODAY, daysLate: 0 }),
    ]);
  });
});

describe("pegOverview — several parents sharing one child TO", () => {
  it("the child TO goes to the parents in need-date order; the first is late, the second on time, the rest uncovered", () => {
    const o = overview({
      manufacturingOrders: [mo("child", "TO-C", "2030-03-18", 10)],
      materialRows: [
        materialRow("mb", "parentB", "TO-B", "2030-03-22", 6),
        materialRow("ma", "parentA", "TO-A", "2030-03-15", 6),
      ],
    });
    const p = peg(o);
    expect(p.demands.map((d) => d.id)).toEqual(["mat:ma", "mat:mb"]);
    expect(p.demands[0]!.allocations).toEqual([expect.objectContaining({ supplyId: "mo:child", quantity: 6, late: true, daysLate: 1 })]);
    expect(p.demands[1]!.allocations).toEqual([expect.objectContaining({ supplyId: "mo:child", quantity: 4, late: false })]);
    expect(p.demands[1]!.uncovered).toBe(2);
    expect(p.supplies[0]!.allocations.map((a) => [a.demandId, a.quantity])).toEqual([
      ["mat:ma", 6],
      ["mat:mb", 4],
    ]);
    expect(p.supplies[0]!.surplus).toBe(0);
  });
});

// --- The invariant with findFirmDemand ------------------------------------
// The old walk, kept here as the reference: available = onHand + Σ supply,
// then each demand in order draws it down; a demand is uncovered by
// clamp(−prefix, 0, quantity).
function referenceUncovered(o: ArticleOverview): Map<string, number> {
  const round4 = (n: number) => Math.round((n + Number.EPSILON) * 1e4) / 1e4;
  let available = round4(o.rows.filter((r) => r.direction === "supply").reduce((sum, r) => sum + r.quantity, o.onHand));
  const out = new Map<string, number>();
  for (const row of o.rows) {
    if (row.direction !== "demand") continue;
    const before = available;
    available = round4(available + row.quantity);
    const quantity = round4(-row.quantity);
    out.set(row.id, available >= 0 ? 0 : before <= 0 ? quantity : round4(-available));
  }
  return out;
}

// findFirmDemand as it was before the rewrite — the reference the rewrite
// must match on every overview.
function referenceFindFirmDemand(o: ArticleOverview, opts: { today: string; salesOrderRowId?: string }): FirmDemand | null {
  const round4 = (n: number) => Math.round((n + Number.EPSILON) * 1e4) / 1e4;
  let available = round4(o.rows.filter((r) => r.direction === "supply").reduce((sum, r) => sum + r.quantity, o.onHand));
  if (available < 0) return { date: opts.today, source: "shortage", documentType: null, documentId: null, documentNumber: null };
  const uncovered: ArticleOverviewRow[] = [];
  for (const row of o.rows) {
    if (row.direction !== "demand") continue;
    available = round4(available + row.quantity);
    if (available < 0) uncovered.push(row);
  }
  const from = (row: ArticleOverviewRow, source: FirmDemand["source"]): FirmDemand => ({
    date: row.date!,
    source,
    documentType: row.documentType,
    documentId: row.documentId,
    documentNumber: row.documentNumber,
  });
  if (opts.salesOrderRowId) {
    const linked = uncovered.find((r) => r.id === `so:${opts.salesOrderRowId}`);
    if (linked && linked.date !== null) return from(linked, "sales_order_row");
  }
  const first = uncovered[0];
  return first && first.date !== null ? from(first, "shortage") : null;
}

// Deterministic pseudo-random overviews (LCG) — the same every run.
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
function randomOverview(rnd: () => number): ArticleOverview {
  const date = () => (rnd() < 0.2 ? null : `2030-03-${String(1 + Math.floor(rnd() * 28)).padStart(2, "0")}`);
  const qty = () => Math.round(rnd() * 200) / 10;
  const n = () => Math.floor(rnd() * 4);
  return overview({
    onHand: Math.round((rnd() - 0.3) * 300) / 10,
    salesRows: Array.from({ length: n() }, (_, i) => salesRow(`r${i}`, `KO-${i}`, date(), qty() + 0.1)),
    materialRows: Array.from({ length: n() }, (_, i) => materialRow(`m${i}`, `p${i}`, `TO-P${i}`, date(), qty() + 0.1)),
    purchaseRows: Array.from({ length: n() }, (_, i) => po(`p${i}`, `IO-${i}`, date(), qty() + 0.1, rnd() < 0.2 ? "draft" : "confirmed")),
    manufacturingOrders: Array.from({ length: n() }, (_, i) => mo(`c${i}`, `TO-C${i}`, date(), qty() + 0.1)),
  });
}

describe("invariant — pegging leaves exactly what findFirmDemand's old walk left", () => {
  it("the uncovered quantity per demand equals the prefix-sum walk, over 500 random overviews", () => {
    const rnd = lcg(9);
    for (let i = 0; i < 500; i++) {
      const o = randomOverview(rnd);
      const p = peg(o);
      const reference = referenceUncovered(o);
      for (const d of p.demands) {
        if (d.id === STOCK_PEG_ID) continue;
        expect(d.uncovered, `overview ${i}, demand ${d.id}`).toBe(reference.get(d.id));
      }
      // The negative-stock demand is uncovered exactly when the old walk's
      // pool was negative from the start.
      const pool = o.rows.filter((r) => r.direction === "supply").reduce((sum, r) => sum + r.quantity, o.onHand);
      const stock = p.demands.find((d) => d.id === STOCK_PEG_ID);
      expect((stock?.uncovered ?? 0) > 0, `overview ${i}, stock`).toBe(Math.round(pool * 1e4) < 0);
      // Conservation: every supply is allocated or surplus, every demand
      // allocated or uncovered.
      for (const s of p.supplies) expect(Math.round((s.allocations.reduce((a, x) => a + x.quantity, 0) + s.surplus) * 1e4)).toBe(Math.round(s.quantity * 1e4));
      for (const d of p.demands) expect(Math.round((d.allocations.reduce((a, x) => a + x.quantity, 0) + d.uncovered) * 1e4)).toBe(Math.round(d.quantity * 1e4));
    }
  });

  it("findFirmDemand answers exactly as before the rewrite, with and without a linked row", () => {
    const rnd = lcg(42);
    for (let i = 0; i < 500; i++) {
      const o = randomOverview(rnd);
      expect(findFirmDemand(o, { today: TODAY }), `overview ${i}`).toEqual(referenceFindFirmDemand(o, { today: TODAY }));
      const linked = o.rows.find((r) => r.kind === "sales_order");
      const salesOrderRowId = linked ? linked.id.slice(3) : "r0";
      expect(findFirmDemand(o, { today: TODAY, salesOrderRowId }), `overview ${i}, linked`).toEqual(
        referenceFindFirmDemand(o, { today: TODAY, salesOrderRowId })
      );
    }
  });
});

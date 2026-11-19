import { describe, expect, it } from "vitest";
import {
  deliveryShortageSummary,
  deliveryShortageText,
  deliveryStockShortages,
  unfinishedManufacturingOrders,
  usableOnHand,
  type DeliveryStockBalance,
  type DeliveryStockRow,
} from "../../web/lib/deliveryStock";

// Utleverans: I lager per row and the warning when Leverera nu is more than
// the stock (the server books the shortage as a minus — a warning, never a
// block), naming the row's TOs that are not done yet.

const balance = (articleId: string, locationId: string, quantityOnHand: number, locationBlocked = false): DeliveryStockBalance => ({
  articleId,
  locationId,
  quantityOnHand: String(quantityOnHand),
  locationBlocked,
});

const row = (id: string, articleId: string, quantity: number, over: Partial<DeliveryStockRow> = {}): DeliveryStockRow => ({
  id,
  articleId,
  articleType: "manufactured",
  quantity,
  locationId: null,
  ...over,
});

describe("usableOnHand", () => {
  it("leaves a plus on a spärrad lagerplats out and keeps a minus there (onHandByArticle's split)", () => {
    expect(usableOnHand([balance("a", "l1", 10), balance("a", "l2", 5, true)])).toBe(10);
    expect(usableOnHand([balance("a", "l1", 10), balance("a", "l2", -3, true)])).toBe(7);
    expect(usableOnHand([])).toBe(0);
  });

  it("rounds the sum to four decimals", () => {
    expect(usableOnHand([balance("a", "l1", 0.1), balance("a", "l2", 0.2)])).toBe(0.3);
  });
});

describe("deliveryStockShortages", () => {
  const balances = {
    a: [balance("a", "l1", 3), balance("a", "l2", 4)],
    b: [balance("b", "l1", 20)],
  };

  it("warns about a row whose Leverera nu is more than the usable stock", () => {
    expect(deliveryStockShortages([row("r1", "a", 10), row("r2", "b", 5)], balances)).toEqual({
      r1: { available: 7, demand: 10, rowCount: 1, locationId: null },
    });
  });

  it("lets a row through that the stock covers exactly", () => {
    expect(deliveryStockShortages([row("r1", "a", 7)], balances)).toEqual({});
  });

  it("adds up the rows of the same article that take from the same source", () => {
    const shortages = deliveryStockShortages([row("r1", "a", 4), row("r2", "a", 4)], balances);
    expect(shortages.r1).toEqual({ available: 7, demand: 8, rowCount: 2, locationId: null });
    expect(shortages.r2).toEqual(shortages.r1);
  });

  it("judges a row with a chosen place by that place's balance", () => {
    expect(deliveryStockShortages([row("r1", "a", 4, { locationId: "l1" })], balances)).toEqual({
      r1: { available: 3, demand: 4, rowCount: 1, locationId: "l1" },
    });
    expect(deliveryStockShortages([row("r1", "a", 4, { locationId: "l2" })], balances)).toEqual({});
  });

  it("does not count a spärrad lagerplats' plus for Automatiskt", () => {
    const blocked = { a: [balance("a", "l1", 2), balance("a", "l9", 50, true)] };
    expect(deliveryStockShortages([row("r1", "a", 5)], blocked).r1?.available).toBe(2);
  });

  it("treats an article without balances as having none", () => {
    expect(deliveryStockShortages([row("r1", "x", 1)], balances).r1).toEqual({
      available: 0,
      demand: 1,
      rowCount: 1,
      locationId: null,
    });
  });

  it("leaves tjänster and rows with nothing to deliver now out", () => {
    expect(deliveryStockShortages([row("r1", "x", 5, { articleType: "service" }), row("r2", "x", 0)], balances)).toEqual({});
  });

  it("warns about nothing while the balances are not known", () => {
    expect(deliveryStockShortages([row("r1", "x", 5)], null)).toEqual({});
  });
});

describe("unfinishedManufacturingOrders", () => {
  it("keeps Planerad, Frisläppt and Pågår", () => {
    const mos = ["planned", "released", "in_progress", "done", "closed", "cancelled"].map((status) => ({ status }));
    expect(unfinishedManufacturingOrders(mos).map((m) => m.status)).toEqual(["planned", "released", "in_progress"]);
  });
});

describe("deliveryShortageText", () => {
  const unit = { unitCode: "st", unitFactor: null };

  it("says what is in stock and what is to be delivered", () => {
    expect(
      deliveryShortageText({ available: 3, demand: 10, rowCount: 1, locationId: null }, { ...unit, manufacturingOrders: [] }, null)
    ).toBe("Saldot räcker inte: 3 st i lager, 10 st ska levereras.");
  });

  it("names the chosen place and the rows sharing it", () => {
    expect(
      deliveryShortageText({ available: 3, demand: 8, rowCount: 2, locationId: "l1" }, { ...unit, manufacturingOrders: [] }, "Huvudlager — A1")
    ).toBe("Saldot räcker inte: 3 st på Huvudlager — A1, 8 st ska levereras på 2 rader.");
  });

  it("names the TOs that are not done, leaving a done one out", () => {
    const shortage = { available: 3, demand: 18, rowCount: 1, locationId: null };
    const mo = (orderNumber: string, status: string) => ({ orderNumber, status });
    expect(deliveryShortageText(shortage, { ...unit, manufacturingOrders: [mo("TO-1042", "released")] }, null)).toBe(
      "Saldot räcker inte: 3 st i lager, 18 st ska levereras. TO-1042 är inte klar."
    );
    expect(
      deliveryShortageText(
        shortage,
        { ...unit, manufacturingOrders: [mo("TO-1", "planned"), mo("TO-2", "in_progress"), mo("TO-3", "done"), mo("TO-4", "released")] },
        null
      )
    ).toBe("Saldot räcker inte: 3 st i lager, 18 st ska levereras. TO-1, TO-2 och TO-4 är inte klara.");
  });

  it("shows the quantities in the row's unit", () => {
    // 10 st per fp: the row is in fp, the stock in st (the base unit).
    expect(
      deliveryShortageText(
        { available: 25, demand: 40, rowCount: 1, locationId: null },
        { unitCode: "fp", unitFactor: "0.1", manufacturingOrders: [] },
        null
      )
    ).toBe("Saldot räcker inte: 2,5 fp i lager, 4 fp ska levereras.");
  });

  it("shows a minus balance as it is", () => {
    expect(
      deliveryShortageText({ available: -2, demand: 1, rowCount: 1, locationId: null }, { ...unit, manufacturingOrders: [] }, null)
    ).toBe("Saldot räcker inte: −2 st i lager, 1 st ska levereras.");
  });
});

describe("deliveryShortageSummary", () => {
  it("is null when every row is covered", () => {
    expect(deliveryShortageSummary([])).toBeNull();
  });

  it("names a single row and its TO", () => {
    expect(deliveryShortageSummary([{ articleNumber: "100-200", unfinishedMo: true }])).toBe(
      "Saldot räcker inte för 100-200 — tillverkningsordern är inte klar. Levereras den ändå går saldot minus."
    );
    expect(deliveryShortageSummary([{ articleNumber: "100-200", unfinishedMo: false }])).toBe(
      "Saldot räcker inte för 100-200. Levereras den ändå går saldot minus."
    );
  });

  it("counts several rows, names them and says how many wait for a TO", () => {
    const rows = (waiting: number) => [0, 1, 2].map((i) => ({ articleNumber: `A${i}`, unfinishedMo: i < waiting }));
    expect(deliveryShortageSummary(rows(0))).toBe("Saldot räcker inte för 3 rader (A0, A1, A2). Levereras de ändå går saldot minus.");
    expect(deliveryShortageSummary(rows(2))).toBe(
      "Saldot räcker inte för 3 rader (A0, A1, A2) — tillverkningen är inte klar för 2 av dem. Levereras de ändå går saldot minus."
    );
    expect(deliveryShortageSummary(rows(3))).toBe(
      "Saldot räcker inte för 3 rader (A0, A1, A2) — tillverkningen är inte klar för någon av dem. Levereras de ändå går saldot minus."
    );
  });

  it("names the first five rows only", () => {
    const rows = [0, 1, 2, 3, 4, 5, 6].map((i) => ({ articleNumber: `A${i}`, unfinishedMo: false }));
    expect(deliveryShortageSummary(rows)).toBe(
      "Saldot räcker inte för 7 rader (A0, A1, A2, A3, A4 m.fl.). Levereras de ändå går saldot minus."
    );
  });
});

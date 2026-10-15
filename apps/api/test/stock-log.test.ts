import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  customers,
  db,
  manufacturingOrders,
  purchaseOrders,
  salesOrders,
  stockCountSessions,
  stockTransactions,
  suppliers,
} from "@navet/db";
import { listStockTransactionsQuerySchema } from "@navet/shared";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { createStockService } from "../src/modules/stock/service/stock.service.js";

// Förbättrad lagerlogg: filters, running balance, source document, who and
// value on GET /stock/transactions (repository-level, real database).

const articleService = createArticleService(createArticleRepository(db));
const stockService = createStockService(createStockRepository(db));
const authRepo = createAuthRepository(db);

const TRUNCATE = sql`TRUNCATE stock_transactions, stock_count_sessions, stock_locations, warehouses, sales_order_rows, sales_orders, customers, purchase_order_rows, purchase_orders, suppliers, manufacturing_orders, bom_components, articles, users CASCADE`;
beforeEach(async () => {
  await db.execute(TRUNCATE);
});
afterAll(async () => {
  await db.execute(TRUNCATE);
});

const q = (over: Record<string, unknown> = {}) => listStockTransactionsQuerySchema.parse({ ...over });

async function makeArticle(tag = "A") {
  return articleService.createArticle({
    articleNumber: `LOG-${tag}-${crypto.randomUUID().slice(0, 6)}`,
    name: `Artikel ${tag}`,
    type: "purchased",
    unit: "st",
    active: true,
  });
}
async function makeLocation(name: string) {
  const existing = (await stockService.listWarehouses()).find((w) => w.name === "Huvudlager");
  const wh = existing ?? (await stockService.createWarehouse({ name: "Huvudlager", active: true }));
  return stockService.createLocation({ warehouseId: wh.id, name, active: true });
}
async function makeUser(name = "Kalle Kula") {
  return authRepo.create({
    email: `log-${crypto.randomUUID()}@example.com`,
    passwordHash: "x",
    name,
    role: "admin",
  });
}
// Direct insert so created_at can be controlled (Stockholm day boundaries).
async function insertTx(v: {
  articleId: string;
  locationId: string;
  delta: number;
  type?: (typeof stockTransactions.$inferInsert)["transactionType"];
  at?: string;
  referenceId?: string;
  unitCost?: string;
  createdBy?: string;
  note?: string;
}) {
  const [row] = await db
    .insert(stockTransactions)
    .values({
      articleId: v.articleId,
      locationId: v.locationId,
      quantityDelta: String(v.delta),
      transactionType: v.type ?? "inventory_adjustment",
      createdAt: v.at ? new Date(v.at) : undefined,
      referenceId: v.referenceId,
      unitCost: v.unitCost,
      createdBy: v.createdBy,
      note: v.note,
    })
    .returning();
  return row!;
}

describe("lagerlogg — filters", () => {
  it("filters on article, location, type and direction", async () => {
    const a = await makeArticle("A");
    const b = await makeArticle("B");
    const l1 = await makeLocation("A1");
    const l2 = await makeLocation("A2");
    await insertTx({ articleId: a.id, locationId: l1.id, delta: 10 });
    await insertTx({ articleId: a.id, locationId: l2.id, delta: -2, type: "sales_delivery" });
    await insertTx({ articleId: b.id, locationId: l1.id, delta: 5 });

    expect((await stockService.listTransactions(q({ articleId: a.id }))).total).toBe(2);
    expect((await stockService.listTransactions(q({ locationId: l1.id }))).total).toBe(2);
    expect((await stockService.listTransactions(q({ type: "sales_delivery" }))).total).toBe(1);
    const out = await stockService.listTransactions(q({ direction: "out" }));
    expect(out.rows.map((r) => r.quantityDelta)).toEqual(["-2.0000"]);
    expect((await stockService.listTransactions(q({ direction: "in" }))).total).toBe(2);
  });

  it("treats from/to as inclusive Stockholm calendar days", async () => {
    const a = await makeArticle();
    const l = await makeLocation("A1");
    // 2026-03-10 23:30 Stockholm (CET, UTC+1) = 22:30Z; 2026-03-11 00:30 Stockholm = 23:30Z on the 10th
    await insertTx({ articleId: a.id, locationId: l.id, delta: 1, at: "2026-03-10T22:30:00Z", note: "sen 10:e" });
    await insertTx({ articleId: a.id, locationId: l.id, delta: 1, at: "2026-03-10T23:30:00Z", note: "tidig 11:e" });
    await insertTx({ articleId: a.id, locationId: l.id, delta: 1, at: "2026-03-11T22:59:00Z", note: "sen 11:e" });
    await insertTx({ articleId: a.id, locationId: l.id, delta: 1, at: "2026-03-11T23:00:00Z", note: "tidig 12:e" });

    const day11 = await stockService.listTransactions(q({ from: "2026-03-11", to: "2026-03-11" }));
    expect(day11.rows.map((r) => r.note).sort()).toEqual(["sen 11:e", "tidig 11:e"]);
    expect((await stockService.listTransactions(q({ from: "2026-03-12" }))).rows.map((r) => r.note)).toEqual(["tidig 12:e"]);
    expect((await stockService.listTransactions(q({ to: "2026-03-10" }))).rows.map((r) => r.note)).toEqual(["sen 10:e"]);
  });

  it("rejects a malformed or impossible date in the schema", () => {
    expect(listStockTransactionsQuerySchema.safeParse({ from: "2026-02-31" }).success).toBe(false);
    expect(listStockTransactionsQuerySchema.safeParse({ to: "10/3" }).success).toBe(false);
  });
});

describe("lagerlogg — running balance", () => {
  it("is null without an article filter", async () => {
    const a = await makeArticle();
    const l = await makeLocation("A1");
    await insertTx({ articleId: a.id, locationId: l.id, delta: 4 });
    const res = await stockService.listTransactions(q());
    expect(res.rows[0]!.balance).toBeNull();
  });

  it("is the true balance after each row, newest row equals stock_balances, and ignores other filters", async () => {
    const a = await makeArticle();
    const l1 = await makeLocation("A1");
    const l2 = await makeLocation("A2");
    await insertTx({ articleId: a.id, locationId: l1.id, delta: 10, at: "2026-01-01T10:00:00Z" });
    await insertTx({ articleId: a.id, locationId: l2.id, delta: 5, at: "2026-01-02T10:00:00Z" });
    await insertTx({ articleId: a.id, locationId: l1.id, delta: -3, type: "sales_delivery", at: "2026-01-03T10:00:00Z" });
    await insertTx({ articleId: a.id, locationId: l1.id, delta: 2, at: "2026-01-04T10:00:00Z" });

    const all = await stockService.listTransactions(q({ articleId: a.id }));
    expect(all.rows.map((r) => Number(r.balance))).toEqual([14, 12, 15, 10]);

    // Filtering to outflows must not change the balance (computed before filters)
    const outOnly = await stockService.listTransactions(q({ articleId: a.id, direction: "out" }));
    expect(outOnly.rows.map((r) => Number(r.balance))).toEqual([12]);
    const dated = await stockService.listTransactions(q({ articleId: a.id, from: "2026-01-04" }));
    expect(dated.rows.map((r) => Number(r.balance))).toEqual([14]);

    // Location partition
    const perLoc = await stockService.listTransactions(q({ articleId: a.id, locationId: l1.id }));
    expect(perLoc.rows.map((r) => Number(r.balance))).toEqual([9, 7, 10]);

    const balances = await stockService.getBalances({ articleId: a.id, limit: 50, offset: 0 });
    const total = balances.rows.reduce((s, r) => s + Number(r.quantityOnHand), 0);
    expect(Number(all.rows[0]!.balance)).toBe(total);
    const l1Balance = balances.rows.find((r) => r.locationId === l1.id)!;
    expect(Number(perLoc.rows[0]!.balance)).toBe(Number(l1Balance.quantityOnHand));
  });

  it("orders rows with equal created_at deterministically (created_at desc, id desc) and balances follow", async () => {
    const a = await makeArticle();
    const l = await makeLocation("A1");
    const at = "2026-02-01T10:00:00Z";
    for (const d of [1, 2, 3, 4]) await insertTx({ articleId: a.id, locationId: l.id, delta: d, at });
    const res = await stockService.listTransactions(q({ articleId: a.id }));
    const ids = res.rows.map((r) => r.id);
    expect(ids).toEqual([...ids].sort().reverse());
    expect(Number(res.rows[0]!.balance)).toBe(10);
    // each balance minus the next-older row's balance equals this row's delta
    for (let i = 0; i < res.rows.length - 1; i++) {
      expect(Number(res.rows[i]!.balance) - Number(res.rows[i + 1]!.balance)).toBe(Number(res.rows[i]!.quantityDelta));
    }
  });
});

describe("lagerlogg — fix round 1", () => {
  it("records who made a manual adjustment (recordTransaction takes the user)", async () => {
    const a = await makeArticle();
    const l = await makeLocation("A1");
    const user = await makeUser("Greta Gran");
    await stockService.recordTransaction(
      { articleId: a.id, locationId: l.id, quantityDelta: 3, transactionType: "inventory_adjustment" },
      user.id
    );
    const res = await stockService.listTransactions(q({ articleId: a.id }));
    expect(res.rows[0]!.createdByName).toBe("Greta Gran");
  });

  it("a transfer never shows a phantom balance (outflow before inflow at the same instant)", async () => {
    const a = await makeArticle();
    const from = await makeLocation("A1");
    const to = await makeLocation("B2");
    await insertTx({ articleId: a.id, locationId: from.id, delta: 10, at: "2026-01-01T10:00:00Z" });
    const user = await makeUser();
    // Several transfers so a random uuid tie-break would show up reliably.
    for (let i = 0; i < 6; i++) {
      await stockService.transferStock({ fromLocationId: from.id, toLocationId: to.id, rows: [{ articleId: a.id, quantity: 1 }] }, user.id);
    }
    const res = await stockService.listTransactions(q({ articleId: a.id }));
    expect(res.rows.length).toBe(13);
    expect(Math.max(...res.rows.map((r) => Number(r.balance)))).toBe(10);
    expect(Math.min(...res.rows.map((r) => Number(r.balance)))).toBe(9);
  });

  it("a single transfer reads 10 → 8 → 10 in the log", async () => {
    const a = await makeArticle();
    const from = await makeLocation("A1");
    const to = await makeLocation("B2");
    await insertTx({ articleId: a.id, locationId: from.id, delta: 10, at: "2026-01-01T10:00:00Z" });
    const user = await makeUser();
    await stockService.transferStock({ fromLocationId: from.id, toLocationId: to.id, rows: [{ articleId: a.id, quantity: 2 }] }, user.id);
    const res = await stockService.listTransactions(q({ articleId: a.id }));
    expect(res.rows.map((r) => Number(r.balance))).toEqual([10, 8, 10]);
    // per location: from-location 10 -> 8, to-location 2
    const fromLoc = await stockService.listTransactions(q({ articleId: a.id, locationId: from.id }));
    expect(fromLoc.rows.map((r) => Number(r.balance))).toEqual([8, 10]);
    const toLoc = await stockService.listTransactions(q({ articleId: a.id, locationId: to.id }));
    expect(toLoc.rows.map((r) => Number(r.balance))).toEqual([2]);
  });

  it("puts rows on the right Stockholm day across the clock changes", async () => {
    const a = await makeArticle();
    const l = await makeLocation("A1");
    // 2026-03-29: spring forward at 02:00 (CET→CEST). 00:30 CET = 23:30Z on the 28th; 23:30 CEST = 21:30Z.
    await insertTx({ articleId: a.id, locationId: l.id, delta: 1, at: "2026-03-28T23:30:00Z", note: "mar-00:30" });
    await insertTx({ articleId: a.id, locationId: l.id, delta: 1, at: "2026-03-29T21:30:00Z", note: "mar-23:30" });
    await insertTx({ articleId: a.id, locationId: l.id, delta: 1, at: "2026-03-28T22:30:00Z", note: "mar-prev-23:30" });
    await insertTx({ articleId: a.id, locationId: l.id, delta: 1, at: "2026-03-29T22:30:00Z", note: "mar-next-00:30" });
    const mar = await stockService.listTransactions(q({ from: "2026-03-29", to: "2026-03-29" }));
    expect(mar.rows.map((r) => r.note).sort()).toEqual(["mar-00:30", "mar-23:30"]);
    // 2026-10-25: fall back at 03:00 (CEST→CET). 00:30 CEST = 22:30Z on the 24th; 23:30 CET = 22:30Z.
    await insertTx({ articleId: a.id, locationId: l.id, delta: 1, at: "2026-10-24T22:30:00Z", note: "okt-00:30" });
    await insertTx({ articleId: a.id, locationId: l.id, delta: 1, at: "2026-10-25T22:30:00Z", note: "okt-23:30" });
    await insertTx({ articleId: a.id, locationId: l.id, delta: 1, at: "2026-10-24T21:30:00Z", note: "okt-prev-23:30" });
    await insertTx({ articleId: a.id, locationId: l.id, delta: 1, at: "2026-10-25T23:30:00Z", note: "okt-next-00:30" });
    const okt = await stockService.listTransactions(q({ from: "2026-10-25", to: "2026-10-25" }));
    expect(okt.rows.map((r) => r.note).sort()).toEqual(["okt-00:30", "okt-23:30"]);
  });
});

describe("lagerlogg — who and value", () => {
  it("returns createdByName (null when absent) and value = delta × unit cost (null without cost)", async () => {
    const a = await makeArticle();
    const l = await makeLocation("A1");
    const user = await makeUser("Kalle Kula");
    await insertTx({ articleId: a.id, locationId: l.id, delta: 4, unitCost: "12.5000", createdBy: user.id, at: "2026-01-01T10:00:00Z" });
    await insertTx({ articleId: a.id, locationId: l.id, delta: -1, at: "2026-01-02T10:00:00Z" });
    const res = await stockService.listTransactions(q({ articleId: a.id }));
    const [out, inflow] = res.rows;
    expect(out!.createdByName).toBeNull();
    expect(out!.value).toBeNull();
    expect(inflow!.createdByName).toBe("Kalle Kula");
    expect(Number(inflow!.value)).toBe(50);
  });
});

describe("lagerlogg — source document", () => {
  it("resolves purchase order, sales order, manufacturing order, stock count, manual and unresolvable", async () => {
    const a = await makeArticle();
    const l = await makeLocation("A1");
    const [sup] = await db.insert(suppliers).values({ supplierNumber: "S1", name: "Lev AB" }).returning();
    const [po] = await db.insert(purchaseOrders).values({ orderNumber: "IO-9001", supplierId: sup!.id }).returning();
    const [cust] = await db.insert(customers).values({ customerNumber: "C1", name: "Kund AB" }).returning();
    const [so] = await db.insert(salesOrders).values({ orderNumber: "KO-9001", customerId: cust!.id }).returning();
    const [mo] = await db
      .insert(manufacturingOrders)
      .values({ orderNumber: "TO-9001", articleId: a.id, quantity: "1" })
      .returning();
    const [count] = await db
      .insert(stockCountSessions)
      .values({ countNumber: "INV-9001", locationId: l.id, blocksTransactions: false })
      .returning();

    await insertTx({ articleId: a.id, locationId: l.id, delta: 1, type: "purchase_receipt", referenceId: po!.id, at: "2026-01-01T10:00:00Z" });
    await insertTx({ articleId: a.id, locationId: l.id, delta: -1, type: "sales_delivery", referenceId: so!.id, at: "2026-01-02T10:00:00Z" });
    await insertTx({ articleId: a.id, locationId: l.id, delta: -1, type: "mo_consumption", referenceId: mo!.id, at: "2026-01-03T10:00:00Z" });
    await insertTx({ articleId: a.id, locationId: l.id, delta: 1, type: "mo_receipt", referenceId: mo!.id, at: "2026-01-04T10:00:00Z" });
    await insertTx({ articleId: a.id, locationId: l.id, delta: 1, type: "inventory_adjustment", referenceId: count!.id, at: "2026-01-05T10:00:00Z" });
    await insertTx({ articleId: a.id, locationId: l.id, delta: 1, type: "inventory_adjustment", at: "2026-01-06T10:00:00Z" });
    await insertTx({ articleId: a.id, locationId: l.id, delta: 1, type: "purchase_receipt", referenceId: crypto.randomUUID(), at: "2026-01-07T10:00:00Z" });

    const refs = (await stockService.listTransactions(q({ articleId: a.id }))).rows.map((r) => r.reference);
    expect(refs).toEqual([
      null,
      { kind: "manual" },
      { kind: "stock_count", id: count!.id, number: "INV-9001" },
      { kind: "manufacturing_order", id: mo!.id, number: "TO-9001" },
      { kind: "manufacturing_order", id: mo!.id, number: "TO-9001" },
      { kind: "sales_order", id: so!.id, number: "KO-9001" },
      { kind: "purchase_order", id: po!.id, number: "IO-9001" },
    ]);
  });

  it("resolves a transfer to the counterpart location (other leg of the same article)", async () => {
    const a = await makeArticle();
    const b = await makeArticle("B");
    const from = await makeLocation("A1");
    const to = await makeLocation("B2");
    await stockService.recordTransaction({ articleId: a.id, locationId: from.id, quantityDelta: 5, transactionType: "inventory_adjustment" });
    await stockService.recordTransaction({ articleId: b.id, locationId: from.id, quantityDelta: 5, transactionType: "inventory_adjustment" });
    const user = await makeUser();
    await stockService.transferStock(
      { fromLocationId: from.id, toLocationId: to.id, rows: [{ articleId: a.id, quantity: 2 }, { articleId: b.id, quantity: 1 }] },
      user.id
    );
    const res = await stockService.listTransactions(q({ articleId: a.id, type: "stock_transfer" }));
    const outLeg = res.rows.find((r) => Number(r.quantityDelta) < 0)!;
    const inLeg = res.rows.find((r) => Number(r.quantityDelta) > 0)!;
    expect(outLeg.reference).toEqual({ kind: "transfer", counterpartLocation: "Huvudlager — B2" });
    expect(inLeg.reference).toEqual({ kind: "transfer", counterpartLocation: "Huvudlager — A1" });
    expect(outLeg.createdByName).toBe("Kalle Kula");
  });
});

describe("lagerlogg — index", () => {
  it("has the created_at and reference_id indexes", async () => {
    const res = await db.execute(
      sql`select indexname from pg_indexes where indexname in ('idx_stock_transactions_created_at', 'idx_stock_transactions_reference_id')`
    );
    expect(res.length).toBe(2);
  });
});

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@navet/db";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { createStockService } from "../src/modules/stock/service/stock.service.js";

const articleService = createArticleService(createArticleRepository(db));
const stockService = createStockService(createStockRepository(db));
const authRepo = createAuthRepository(db);

beforeEach(async () => {
  await db.execute(
    sql`TRUNCATE stock_transactions, stock_locations, warehouses, bom_components, articles, users CASCADE`
  );
});

afterAll(async () => {
  await db.execute(
    sql`TRUNCATE stock_transactions, stock_locations, warehouses, bom_components, articles, users CASCADE`
  );
});

async function makeLocation() {
  const warehouse = await stockService.createWarehouse({ name: "Huvudlager", active: true });
  return stockService.createLocation({ warehouseId: warehouse.id, name: "A1", active: true });
}

describe("stock service — append-only transaction log", () => {
  it("derives the current balance from the sum of recorded transactions", async () => {
    const article = await articleService.createArticle({
      articleNumber: "ART-1",
      name: "Test Article",
      type: "purchased",
      unit: "st",
      active: true,
    });
    const location = await makeLocation();

    await stockService.recordTransaction({
      articleId: article.id,
      locationId: location.id,
      quantityDelta: 10,
      transactionType: "inventory_adjustment",
    });
    await stockService.recordTransaction({
      articleId: article.id,
      locationId: location.id,
      quantityDelta: -3,
      transactionType: "sales_delivery",
    });

    const balances = await stockService.getBalances({ articleId: article.id, limit: 50, offset: 0 });
    expect(balances.rows).toHaveLength(1);
    expect(balances.rows[0]?.quantityOnHand).toBe("7.0000");
  });

  it("never allows a direct UPDATE of a balance — only new transaction rows", async () => {
    // Architecture invariant (CLAUDE.md #1): stock_balances is a view over
    // stock_transactions, so attempting to UPDATE it directly must fail.
    await expect(
      db.execute(sql`UPDATE stock_balances SET quantity_on_hand = 999`)
    ).rejects.toThrow();
  });

  it("keeps every transaction as its own row (append-only, no mutation)", async () => {
    const article = await articleService.createArticle({
      articleNumber: "ART-2",
      name: "Test Article 2",
      type: "purchased",
      unit: "st",
      active: true,
    });
    const location = await makeLocation();

    await stockService.recordTransaction({
      articleId: article.id,
      locationId: location.id,
      quantityDelta: 5,
      transactionType: "purchase_receipt",
    });
    await stockService.recordTransaction({
      articleId: article.id,
      locationId: location.id,
      quantityDelta: 5,
      transactionType: "purchase_receipt",
    });

    const rows = await db.execute(
      sql`SELECT * FROM stock_transactions WHERE article_id = ${article.id}`
    );
    expect(rows.length).toBe(2);
  });
});

describe("stock service — mandatory location with *** fallback", () => {
  async function makeArticle(defaultLocationId?: string) {
    return articleService.createArticle({
      articleNumber: `ART-LOC-${crypto.randomUUID()}`,
      name: "Platsartikel",
      type: "purchased",
      unit: "st",
      active: true,
      ...(defaultLocationId ? { defaultLocationId } : {}),
    });
  }

  it("gives a new article the *** location when none is chosen, reusing it for the next article", async () => {
    const a = await makeArticle();
    const b = await makeArticle();

    const locations = await stockService.listLocations();
    const fallbacks = locations.filter((l) => l.name === "***");
    expect(fallbacks).toHaveLength(1);
    expect(a.defaultLocationId).toBe(fallbacks[0]!.id);
    expect(b.defaultLocationId).toBe(fallbacks[0]!.id);
  });

  it("keeps an explicitly chosen location on the article", async () => {
    const location = await makeLocation();
    const article = await makeArticle(location.id);
    expect(article.defaultLocationId).toBe(location.id);
  });

  it("resolves transactions: explicit location wins, then the article's, never NULL", async () => {
    const location = await makeLocation();
    const article = await makeArticle(location.id);

    // No location given → the article's default.
    const resolved = await stockService.recordTransaction({
      articleId: article.id,
      quantityDelta: 5,
      transactionType: "inventory_adjustment",
    });
    expect(resolved?.locationId).toBe(location.id);

    // Explicit location wins over the article default.
    const warehouse = await stockService.createWarehouse({ name: "Annat lager", active: true });
    const other = await stockService.createLocation({ warehouseId: warehouse.id, name: "B1", active: true });
    const explicit = await stockService.recordTransaction({
      articleId: article.id,
      locationId: other.id,
      quantityDelta: 5,
      transactionType: "inventory_adjustment",
    });
    expect(explicit?.locationId).toBe(other.id);
  });

  it("edits warehouses and locations, and 404s on unknown ids", async () => {
    const location = await makeLocation();

    const warehouse = await stockService.updateWarehouse(location.warehouseId, { name: "Omdöpt lager" });
    expect(warehouse.name).toBe("Omdöpt lager");

    const renamed = await stockService.updateLocation(location.id, { name: "C9", active: false });
    expect(renamed.name).toBe("C9");
    expect(renamed.active).toBe(false);

    await expect(
      stockService.updateWarehouse("00000000-0000-0000-0000-000000000000", { name: "x" })
    ).rejects.toThrow("not found");
    await expect(
      stockService.updateLocation("00000000-0000-0000-0000-000000000000", { name: "x" })
    ).rejects.toThrow("not found");
  });
});

describe("stock service — lagerflytt och rensning av tomma lagerplatser", () => {
  // Bypasses authService.register (bootstrap-only) since the transfer only
  // needs a valid user id for createdBy.
  async function makeUser() {
    return authRepo.create({
      email: `lager-${crypto.randomUUID()}@example.com`,
      passwordHash: "not-a-real-hash",
      name: "Lagerarbetare",
      role: "admin",
    });
  }

  async function makeArticle(defaultLocationId?: string) {
    return articleService.createArticle({
      articleNumber: `ART-FLYTT-${crypto.randomUUID()}`,
      name: "Flyttartikel",
      type: "purchased",
      unit: "st",
      active: true,
      ...(defaultLocationId ? { defaultLocationId } : {}),
    });
  }

  // Two locations in the same warehouse — A1 (source) and B2 (target).
  async function makeLocationPair() {
    const warehouse = await stockService.createWarehouse({ name: "Huvudlager", active: true });
    const from = await stockService.createLocation({ warehouseId: warehouse.id, name: "A1", active: true });
    const to = await stockService.createLocation({ warehouseId: warehouse.id, name: "B2", active: true });
    return { from, to };
  }

  async function stock(articleId: string, locationId: string, quantity: number) {
    return stockService.recordTransaction({
      articleId,
      locationId,
      quantityDelta: quantity,
      transactionType: "inventory_adjustment",
    });
  }

  async function balanceAt(articleId: string, locationId: string) {
    const balances = await stockService.getBalances({ articleId, limit: 50, offset: 0 });
    return balances.rows.find((row) => row.locationId === locationId)?.quantityOnHand ?? null;
  }

  it("moves a balance with two paired transactions sharing one reference", async () => {
    const user = await makeUser();
    const { from, to } = await makeLocationPair();
    const article = await makeArticle(from.id);
    await stock(article.id, from.id, 12);

    const result = await stockService.transferStock(
      { fromLocationId: from.id, toLocationId: to.id, rows: [{ articleId: article.id, quantity: 5 }] },
      user.id
    );

    expect(result.movedRows).toBe(1);
    expect(await balanceAt(article.id, from.id)).toBe("7.0000");
    expect(await balanceAt(article.id, to.id)).toBe("5.0000");

    const transfers = (await stockService.listTransactions({ limit: 50, offset: 0 })).rows.filter(
      (row) => row.transactionType === "stock_transfer"
    );
    expect(transfers).toHaveLength(2);
    expect(new Set(transfers.map((row) => row.referenceId))).toEqual(new Set([result.transferId]));
    expect(transfers.map((row) => row.quantityDelta).sort()).toEqual(["-5.0000", "5.0000"]);
  });

  it("refuses to move more than the source location holds", async () => {
    const user = await makeUser();
    const { from, to } = await makeLocationPair();
    const article = await makeArticle(from.id);
    await stock(article.id, from.id, 3);

    await expect(
      stockService.transferStock(
        { fromLocationId: from.id, toLocationId: to.id, rows: [{ articleId: article.id, quantity: 4 }] },
        user.id
      )
    ).rejects.toThrow("Otillräckligt saldo");

    // Nothing was booked — the whole transfer is one transaction.
    expect(await balanceAt(article.id, from.id)).toBe("3.0000");
    expect(await balanceAt(article.id, to.id)).toBeNull();
  });

  it("deactivates the source location when the move empties it", async () => {
    const user = await makeUser();
    const { from, to } = await makeLocationPair();
    const article = await makeArticle(from.id);
    await stock(article.id, from.id, 12);

    const result = await stockService.transferStock(
      { fromLocationId: from.id, toLocationId: to.id, rows: [{ articleId: article.id, quantity: 12 }] },
      user.id
    );

    expect(result.deactivatedSourceLocation).toBe(true);
    const active = await stockService.listLocations();
    expect(active.map((l) => l.id)).not.toContain(from.id);
    const all = await stockService.listLocations({ includeInactive: true });
    expect(all.find((l) => l.id === from.id)?.active).toBe(false);
  });

  it("keeps the source location when it still holds another article", async () => {
    const user = await makeUser();
    const { from, to } = await makeLocationPair();
    const moved = await makeArticle(from.id);
    const staying = await makeArticle(from.id);
    await stock(moved.id, from.id, 12);
    await stock(staying.id, from.id, 1);

    const result = await stockService.transferStock(
      { fromLocationId: from.id, toLocationId: to.id, rows: [{ articleId: moved.id, quantity: 12 }] },
      user.id
    );

    expect(result.deactivatedSourceLocation).toBe(false);
    expect((await stockService.listLocations()).map((l) => l.id)).toContain(from.id);
  });

  it("does not treat +5/-5 across two articles as an empty location", async () => {
    const user = await makeUser();
    const { from, to } = await makeLocationPair();
    const positive = await makeArticle(from.id);
    const negative = await makeArticle(from.id);
    await stock(positive.id, from.id, 10);
    await stock(negative.id, from.id, -5);

    const result = await stockService.transferStock(
      { fromLocationId: from.id, toLocationId: to.id, rows: [{ articleId: positive.id, quantity: 5 }] },
      user.id
    );

    // Location nets to zero overall (5 + -5) but still holds both articles.
    expect(result.deactivatedSourceLocation).toBe(false);
  });

  it("never deactivates the *** fallback location, even when empty", async () => {
    const user = await makeUser();
    const article = await makeArticle();
    const fallbackId = article.defaultLocationId!;
    const warehouse = await stockService.createWarehouse({ name: "Huvudlager", active: true });
    const to = await stockService.createLocation({ warehouseId: warehouse.id, name: "B2", active: true });
    await stock(article.id, fallbackId, 4);

    const result = await stockService.transferStock(
      { fromLocationId: fallbackId, toLocationId: to.id, rows: [{ articleId: article.id, quantity: 4 }] },
      user.id
    );

    expect(result.deactivatedSourceLocation).toBe(false);
    const fallback = (await stockService.listLocations()).find((l) => l.id === fallbackId);
    expect(fallback?.name).toBe("***");
    expect(fallback?.active).toBe(true);
  });

  it("moves a moved article's default location to the target when the source empties", async () => {
    const user = await makeUser();
    const { from, to } = await makeLocationPair();
    const article = await makeArticle(from.id);
    await stock(article.id, from.id, 12);

    await stockService.transferStock(
      { fromLocationId: from.id, toLocationId: to.id, rows: [{ articleId: article.id, quantity: 12 }] },
      user.id
    );

    const updated = await articleService.getArticle(article.id);
    expect(updated?.defaultLocationId).toBe(to.id);
  });

  it("clears the default location of articles that pointed at a pruned location without moving", async () => {
    const user = await makeUser();
    const { from, to } = await makeLocationPair();
    const moved = await makeArticle(from.id);
    // Points at A1 but has never had a balance there, so it is not part of the move.
    const bystander = await makeArticle(from.id);
    await stock(moved.id, from.id, 12);

    await stockService.transferStock(
      { fromLocationId: from.id, toLocationId: to.id, rows: [{ articleId: moved.id, quantity: 12 }] },
      user.id
    );

    const updated = await articleService.getArticle(bystander.id);
    expect(updated?.defaultLocationId).toBeNull();
  });

  it("refuses to move into a deactivated location", async () => {
    const user = await makeUser();
    const { from, to } = await makeLocationPair();
    const article = await makeArticle(from.id);
    await stock(article.id, from.id, 5);
    await stockService.updateLocation(to.id, { active: false });

    await expect(
      stockService.transferStock(
        { fromLocationId: from.id, toLocationId: to.id, rows: [{ articleId: article.id, quantity: 5 }] },
        user.id
      )
    ).rejects.toThrow("inaktiv");
  });

  it("404s on an unknown location", async () => {
    const user = await makeUser();
    const { from } = await makeLocationPair();
    const article = await makeArticle(from.id);
    await stock(article.id, from.id, 5);

    await expect(
      stockService.transferStock(
        {
          fromLocationId: from.id,
          toLocationId: "00000000-0000-0000-0000-000000000000",
          rows: [{ articleId: article.id, quantity: 5 }],
        },
        user.id
      )
    ).rejects.toThrow("not found");
  });

  it("prunes outside the transfer routine too — a negative adjustment that empties a location", async () => {
    const { from } = await makeLocationPair();
    const article = await makeArticle(from.id);
    await stock(article.id, from.id, 4);
    expect((await stockService.listLocations()).map((l) => l.id)).toContain(from.id);

    await stock(article.id, from.id, -4);

    expect((await stockService.listLocations()).map((l) => l.id)).not.toContain(from.id);
  });

  it("leaves zero balances out of the balance list", async () => {
    const { from } = await makeLocationPair();
    const article = await makeArticle(from.id);
    await stock(article.id, from.id, 4);
    await stock(article.id, from.id, -4);

    const balances = await stockService.getBalances({ articleId: article.id, limit: 50, offset: 0 });
    expect(balances.rows).toHaveLength(0);
    expect(balances.total).toBe(0);
  });

  it("filters balances by location for the transfer routine's row list", async () => {
    const { from, to } = await makeLocationPair();
    const a = await makeArticle(from.id);
    const b = await makeArticle(from.id);
    await stock(a.id, from.id, 3);
    await stock(b.id, from.id, 7);
    await stock(a.id, to.id, 1);

    const atSource = await stockService.getBalances({ locationId: from.id, limit: 50, offset: 0 });
    expect(atSource.total).toBe(2);
    expect(atSource.rows.every((row) => row.locationId === from.id)).toBe(true);
  });

  // Invariant: a location holding a balance is always active, so stock can
  // never hide on a deactivated location. Enforced from both directions.
  it("revives a deactivated location when a movement is booked into it", async () => {
    const user = await makeUser();
    const { from, to } = await makeLocationPair();
    const article = await makeArticle(from.id);
    await stock(article.id, from.id, 6);
    await stockService.transferStock(
      { fromLocationId: from.id, toLocationId: to.id, rows: [{ articleId: article.id, quantity: 6 }] },
      user.id
    );
    expect((await stockService.listLocations()).map((l) => l.id)).not.toContain(from.id);

    // An explicit posting to the retired location brings it back rather than
    // leaving the stock invisible.
    await stock(article.id, from.id, 2);

    const active = await stockService.listLocations();
    expect(active.map((l) => l.id)).toContain(from.id);
    expect(await balanceAt(article.id, from.id)).toBe("2.0000");
  });

  it("revives a deactivated location for a negative movement too, so the debt is visible", async () => {
    const user = await makeUser();
    const { from, to } = await makeLocationPair();
    const article = await makeArticle(from.id);
    await stock(article.id, from.id, 3);
    await stockService.transferStock(
      { fromLocationId: from.id, toLocationId: to.id, rows: [{ articleId: article.id, quantity: 3 }] },
      user.id
    );

    await stock(article.id, from.id, -1);

    expect((await stockService.listLocations()).map((l) => l.id)).toContain(from.id);
    expect(await balanceAt(article.id, from.id)).toBe("-1.0000");
  });

  it("refuses to deactivate a location by hand while it still holds stock", async () => {
    const { from } = await makeLocationPair();
    const article = await makeArticle(from.id);
    await stock(article.id, from.id, 5);

    await expect(stockService.updateLocation(from.id, { active: false })).rejects.toThrow(
      "har saldo kvar"
    );
    expect((await stockService.listLocations()).map((l) => l.id)).toContain(from.id);

    // Renaming an occupied location is still fine — only retiring is blocked.
    const renamed = await stockService.updateLocation(from.id, { name: "A9" });
    expect(renamed.name).toBe("A9");
  });

  it("allows deactivating an emptied location by hand", async () => {
    const { from } = await makeLocationPair();
    const article = await makeArticle(from.id);
    await stock(article.id, from.id, 5);
    await stock(article.id, from.id, -5); // auto-deactivates

    // Already inactive; re-activate and retire it again by hand.
    const revived = await stockService.updateLocation(from.id, { active: true });
    expect(revived.active).toBe(true);
    const retired = await stockService.updateLocation(from.id, { active: false });
    expect(retired.active).toBe(false);
  });

  it("does not let a location holding only a negative balance be deactivated", async () => {
    const { from } = await makeLocationPair();
    const article = await makeArticle(from.id);
    await stock(article.id, from.id, -4);

    await expect(stockService.updateLocation(from.id, { active: false })).rejects.toThrow(
      "har saldo kvar"
    );
  });

  it("resolves past a deactivated default location back to ***", async () => {
    const { from } = await makeLocationPair();
    const article = await makeArticle(from.id);
    await stockService.updateLocation(from.id, { active: false });

    const booked = await stockService.recordTransaction({
      articleId: article.id,
      quantityDelta: 2,
      transactionType: "purchase_receipt",
    });

    const fallback = (await stockService.listLocations()).find((l) => l.name === "***");
    expect(booked?.locationId).toBe(fallback?.id);
  });
});

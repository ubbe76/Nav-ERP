import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, asc, eq, sql } from "drizzle-orm";
import { articleAlternativeLocations, articles, db, permissionGroups, stockLocations, stockTransactions } from "@navet/db";
import { buildApp as buildRealApp } from "../src/app.js";
import { testDocumentPdfService, testSystemService } from "./helpers/services.js";
import { waitForLockWaiter } from "./helpers/year-end.js";
import { pdfText } from "./helpers/pdf.js";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createAuthService } from "../src/modules/auth/service/auth.service.js";
import { createMailRepository } from "../src/modules/mail/repository/mail.repository.js";
import { createMailService } from "../src/modules/mail/service/mail.service.js";
import { createRegisterRepository } from "../src/modules/register/repository/register.repository.js";
import { createRegisterService } from "../src/modules/register/service/register.service.js";
import { createSalesRepository } from "../src/modules/sales/repository/sales.repository.js";
import { resolvePrice } from "../src/modules/sales/service/price-resolver.js";
import { createSalesService } from "../src/modules/sales/service/sales.service.js";
import { replaceArticleLocations } from "../src/modules/stock/repository/article-locations.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { deactivateEmptyLocation } from "../src/modules/stock/service/location-lifecycle.js";
import { getOrCreateFallbackLocation, usableArticleLocations } from "../src/modules/stock/service/location-resolver.js";
import { allocateOutflowLocations } from "../src/modules/stock/service/outflow-locations.js";
import { ArticleLocationInvalidError, ArticleNotFoundError, createStockService } from "../src/modules/stock/service/stock.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";

// Flera lagerplatser per artikel (etapp 3, migration 0186): the huvudplats
// and the alternative places in order — PUT's rules, the resolver's order
// for inflows, Automatiskt and the pick list in the same order, the cleanup
// of a retired temporary place, the transfer's followers, Kopiera från, the
// lock against a draw in progress, and the routes' rules.

const auditRepository = createAuditRepository(db);
const articleService = createArticleService(createArticleRepository(db));
const stockService = createStockService(createStockRepository(db), auditRepository);
const authRepo = createAuthRepository(db);
const registerService = createRegisterService(createRegisterRepository(db));
const mailService = createMailService(createMailRepository(db), testSystemService, () => ({ async sendMail() {} }));
const salesService = createSalesService(
  createSalesRepository(db),
  registerService,
  mailService,
  testDocumentPdfService,
  stockService,
  articleService,
  testSystemService,
  (query) => resolvePrice(db, query),
  auditRepository
);

const TABLES = sql`TRUNCATE audit_log, delivery_row_locations, delivery_rows, deliveries, sales_order_rows, sales_orders, customers,
  stock_transactions, stock_locations, warehouses, article_suppliers, articles, user_settings, users CASCADE`;
// Only this file's groups — never TRUNCATE permission_groups (the seeded ones).
const DELETE_GROUPS = sql`DELETE FROM permission_groups WHERE code LIKE 'ALP%'`;

let user: { id: string };
let warehouseId: string | null = null;

beforeEach(async () => {
  warehouseId = null;
  await db.execute(TABLES);
  await db.execute(DELETE_GROUPS);
  user = await authRepo.create({ email: `alt-${crypto.randomUUID()}@example.com`, passwordHash: "x", name: "Lagerchef", role: "admin" });
});

afterAll(async () => {
  await db.execute(TABLES);
  await db.execute(DELETE_GROUPS);
});

async function place(name: string, opts: { fixed?: boolean; active?: boolean; blocked?: boolean } = {}) {
  warehouseId ??= (await stockService.createWarehouse({ name: "Huvudlager", active: true })).id;
  return stockService.createLocation({
    warehouseId,
    name,
    active: opts.active ?? true,
    fixed: opts.fixed ?? true,
    blocked: opts.blocked ?? false,
  });
}

async function article(number: string, defaultLocationId?: string) {
  return articleService.createArticle({ articleNumber: number, name: number, type: "purchased", unit: "st", active: true, defaultLocationId });
}

const set = (articleId: string, primaryLocationId: string | null, alternativeLocationIds: string[]) =>
  stockService.setArticleLocations(articleId, { primaryLocationId, alternativeLocationIds });

async function stock(articleId: string, locationId: string | undefined, quantityDelta: number) {
  return stockService.recordTransaction({ articleId, locationId, quantityDelta, transactionType: "inventory_adjustment" }, user.id);
}

async function balance(articleId: string, locationId: string) {
  const [row] = await db
    .select({ q: sql<string>`coalesce(sum(${stockTransactions.quantityDelta}), 0)` })
    .from(stockTransactions)
    .where(and(eq(stockTransactions.articleId, articleId), eq(stockTransactions.locationId, locationId)));
  return Number(row!.q);
}

async function assignments(articleId: string) {
  return db
    .select({ locationId: articleAlternativeLocations.locationId, sortOrder: articleAlternativeLocations.sortOrder })
    .from(articleAlternativeLocations)
    .where(eq(articleAlternativeLocations.articleId, articleId))
    .orderBy(asc(articleAlternativeLocations.sortOrder));
}

async function primaryOf(articleId: string) {
  const [row] = await db.select({ defaultLocationId: articles.defaultLocationId }).from(articles).where(eq(articles.id, articleId));
  return row!.defaultLocationId;
}

async function locationRow(id: string) {
  const [row] = await db.select().from(stockLocations).where(eq(stockLocations.id, id));
  return row!;
}

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

describe("PUT /articles/:id/locations — the whole set", () => {
  it("replaces the huvudplats and the alternatives in order, and GET answers with the article's balance on each", async () => {
    const a1 = await place("A1");
    const b1 = await place("B1");
    const c1 = await place("C1");
    const x = await article("X-1", a1.id);
    await stock(x.id, b1.id, 3);

    const saved = await set(x.id, a1.id, [b1.id, c1.id]);
    expect(saved).toEqual({
      primary: expect.objectContaining({ locationId: a1.id, name: "A1", warehouseName: "Huvudlager", active: true, blocked: false, fixed: true, quantityOnHand: "0.0000", labelCode: expect.stringMatching(/^LP\d{4}$/) }),
      alternatives: [
        expect.objectContaining({ locationId: b1.id, name: "B1", quantityOnHand: "3.0000" }),
        expect.objectContaining({ locationId: c1.id, name: "C1", quantityOnHand: "0.0000" }),
      ],
    });
    expect(await assignments(x.id)).toEqual([
      { locationId: b1.id, sortOrder: 1 },
      { locationId: c1.id, sortOrder: 2 },
    ]);
    expect(await stockService.getArticleLocations(x.id)).toEqual(saved);

    // The whole set again: the old alternatives are gone, the order is 1..n.
    const again = await set(x.id, c1.id, [a1.id]);
    expect(again.primary!.locationId).toBe(c1.id);
    expect(again.alternatives.map((p) => p.locationId)).toEqual([a1.id]);
    expect(await assignments(x.id)).toEqual([{ locationId: a1.id, sortOrder: 1 }]);
    expect(await primaryOf(x.id)).toBe(c1.id);

    // No huvudplats and no alternatives.
    expect(await set(x.id, null, [])).toEqual({ primary: null, alternatives: [] });
    expect(await primaryOf(x.id)).toBeNull();
  });

  it("shows a place that is both the huvudplats and listed as an alternative only as the huvudplats", async () => {
    const a1 = await place("A1");
    const b1 = await place("B1");
    const x = await article("X-1", a1.id);
    await set(x.id, a1.id, [b1.id]);
    // PATCH /articles (integrations) may still set the huvudplats.
    await articleService.updateArticle(x.id, { defaultLocationId: b1.id });
    expect(await stockService.getArticleLocations(x.id)).toMatchObject({ primary: { locationId: b1.id }, alternatives: [] });
  });

  it("refuses a duplicate, the huvudplats in the list, more than 20, an unknown place and *** as an alternative", async () => {
    const a1 = await place("A1");
    const b1 = await place("B1");
    const x = await article("X-1", a1.id);
    const fallback = await getOrCreateFallbackLocation(db);

    const refusal = async (primary: string | null, alternatives: string[]) => {
      const err = await set(x.id, primary, alternatives).then(
        () => null,
        (e: unknown) => e
      );
      expect(err).toBeInstanceOf(ArticleLocationInvalidError);
      return (err as Error).message;
    };
    expect(await refusal(a1.id, [b1.id, b1.id])).toBe("Samma lagerplats står flera gånger bland de alternativa lagerplatserna.");
    expect(await refusal(a1.id, [b1.id, a1.id])).toBe("Huvudplatsen kan inte också vara en alternativ lagerplats.");
    expect(await refusal(a1.id, Array.from({ length: 21 }, () => crypto.randomUUID()))).toBe("En artikel kan ha högst 20 alternativa lagerplatser.");
    expect(await refusal(a1.id, [crypto.randomUUID()])).toBe("Lagerplatsen finns inte längre — ladda om sidan.");
    expect(await refusal(crypto.randomUUID(), [])).toBe("Lagerplatsen finns inte längre — ladda om sidan.");
    expect(await refusal(a1.id, [fallback])).toContain("Reservplatsen *** kan inte vara en alternativ lagerplats");
    // *** may be the huvudplats — every article created without a place has it.
    expect((await set(x.id, fallback, [b1.id])).primary!.name).toBe("***");
    // Exactly 20 is fine.
    const twenty = [];
    for (let i = 1; i <= 20; i++) twenty.push((await place(`H${i}`)).id);
    expect((await set(x.id, a1.id, twenty)).alternatives).toHaveLength(20);
    // Nothing refused was written.
    expect(await primaryOf(x.id)).toBe(a1.id);
    await expect(set(crypto.randomUUID(), null, [])).rejects.toBeInstanceOf(ArticleNotFoundError);
  });

  it("refuses an inactive or blocked place that is new in its role, lets one that was already there stay", async () => {
    const a1 = await place("A1");
    const kept = await place("K-kvar");
    const off = await place("Avställd");
    const x = await article("X-1", a1.id);
    await set(x.id, a1.id, [kept.id, off.id]);
    // Blocked and retired AFTER they were chosen.
    await stockService.blockLocation(kept.id, null, user.id);
    await stockService.updateLocation(off.id, { active: false });
    const fresh = await place("K-ny", { blocked: true });
    const inactive = await place("Inaktiv", { active: false });

    // The card sends back what it shows: the kept ones pass, in a new order too.
    const saved = await set(x.id, a1.id, [off.id, kept.id]);
    expect(saved.alternatives.map((p) => [p.name, p.active, p.blocked])).toEqual([
      ["Avställd", false, false],
      ["K-kvar", true, true],
    ]);

    await expect(set(x.id, a1.id, [kept.id, fresh.id])).rejects.toThrow(
      "Lagerplatsen Huvudlager — K-ny är spärrad och kan inte läggas till som alternativ lagerplats."
    );
    await expect(set(x.id, a1.id, [inactive.id])).rejects.toThrow(
      "Lagerplatsen Huvudlager — Inaktiv är inaktiv och kan inte läggas till som alternativ lagerplats."
    );
    // New as the huvudplats — even one that was an alternative.
    await expect(set(x.id, kept.id, [])).rejects.toThrow("Lagerplatsen Huvudlager — K-kvar är spärrad och kan inte väljas som huvudplats.");
    await expect(set(x.id, inactive.id, [])).rejects.toThrow("Lagerplatsen Huvudlager — Inaktiv är inaktiv och kan inte väljas som huvudplats.");

    // A huvudplats blocked after it was chosen stays.
    await stockService.blockLocation(a1.id, null, user.id);
    expect((await set(x.id, a1.id, [])).primary).toMatchObject({ locationId: a1.id, blocked: true });
    expect(await assignments(x.id)).toEqual([]);
  });
});

describe("the order of the article's places", () => {
  it("an inflow without a place lands on the huvudplats, else the first usable alternative, else ***", async () => {
    const main = await place("P");
    const alt1 = await place("Z1");
    const alt2 = await place("Z2");
    const x = await article("X-1", main.id);
    await set(x.id, main.id, [alt1.id, alt2.id]);

    await stock(x.id, undefined, 1);
    expect(await balance(x.id, main.id)).toBe(1);
    // Not topped up where stock already lies: alt1 has some, the inflow still goes to P.
    await stock(x.id, alt1.id, 5);
    await stock(x.id, undefined, 1);
    expect([await balance(x.id, main.id), await balance(x.id, alt1.id)]).toEqual([2, 5]);

    await stockService.blockLocation(main.id, null, user.id);
    await stock(x.id, undefined, 1);
    expect(await balance(x.id, alt1.id)).toBe(6);

    await stockService.blockLocation(alt1.id, null, user.id);
    await stock(x.id, undefined, 1);
    expect(await balance(x.id, alt2.id)).toBe(1);

    // An inactive huvudplats is skipped the same way.
    const off = await place("Q");
    const y = await article("Y-1", off.id);
    await set(y.id, off.id, [alt2.id]);
    await stockService.updateLocation(off.id, { active: false });
    await stock(y.id, undefined, 2);
    expect(await balance(y.id, alt2.id)).toBe(2);

    // None usable: ***.
    await stockService.blockLocation(alt2.id, null, user.id);
    await stock(x.id, undefined, 1);
    expect(await balance(x.id, await getOrCreateFallbackLocation(db))).toBe(1);

    // The batch form answers the same for several articles at once.
    const z = await article("Z-1");
    const usable = await usableArticleLocations(db, [x.id, y.id, z.id]);
    expect([usable.get(x.id), usable.get(y.id), usable.get(z.id)]).toEqual([undefined, undefined, await getOrCreateFallbackLocation(db)]);
  });

  it("Automatiskt and the pick list take the huvudplats, the alternatives in order, the others and *** last", async () => {
    const main = await place("P");
    const alt1 = await place("Z9");
    const alt2 = await place("M5");
    const other = await place("A1");
    const fallback = await getOrCreateFallbackLocation(db);
    const x = await article("X-1", main.id);
    await set(x.id, main.id, [alt1.id, alt2.id]);
    for (const id of [fallback, other.id, alt2.id, alt1.id, main.id]) await stock(x.id, id, 2);

    const automatic = await db.transaction((tx) => allocateOutflowLocations(tx, x.id, 10));
    expect(automatic).toEqual([main.id, alt1.id, alt2.id, other.id, fallback].map((locationId) => ({ locationId, quantity: 2 })));
    const pickOrder = (await stockService.balancesForArticles([x.id])).map((b) => b.locationId);
    expect(pickOrder).toEqual(automatic.map((p) => p.locationId));
    expect((await stockService.balancesForArticles([x.id])).map((b) => b.preference)).toEqual([0, 1, 2, null, null]);

    // The paper itself, and a blocked alternative skipped on both.
    await stockService.blockLocation(alt1.id, null, user.id);
    const customer = await salesService.createCustomer({ name: "Kund AB", active: true });
    const { order } = await salesService.createQuote({ customerId: customer.id, rows: [{ articleId: x.id, quantity: 5, unitPrice: 10 }] }, user.id);
    await salesService.confirm(order.id);
    const text = pdfText((await salesService.getPickListPdf(order.id)).content);
    const at = (s: string) => text.indexOf(s);
    expect(text).not.toContain("Z9");
    expect([at("Huvudlager — P: 2"), at("Huvudlager — M5: 2"), at("Huvudlager — A1: 2"), at("*** — ***: 2")].every((i) => i >= 0)).toBe(true);
    expect(at("Huvudlager — P: 2") < at("Huvudlager — M5: 2") && at("Huvudlager — M5: 2") < at("Huvudlager — A1: 2") && at("Huvudlager — A1: 2") < at("*** — ***: 2")).toBe(true);
    const skipping = await db.transaction((tx) => allocateOutflowLocations(tx, x.id, 5));
    expect(skipping).toEqual([
      { locationId: main.id, quantity: 2 },
      { locationId: alt2.id, quantity: 2 },
      { locationId: other.id, quantity: 1 },
    ]);
  });

  it("the remainder of Automatiskt goes negative on the first usable of the article's places", async () => {
    const main = await place("P");
    const alt1 = await place("Z1");
    const x = await article("X-1", main.id);
    await set(x.id, main.id, [alt1.id]);
    await stock(x.id, alt1.id, 2);
    expect(await db.transaction((tx) => allocateOutflowLocations(tx, x.id, 5))).toEqual([
      { locationId: alt1.id, quantity: 2 },
      { locationId: main.id, quantity: 3 },
    ]);
    // A blocked huvudplats: the shortfall merges into alternative 1's part.
    await stockService.blockLocation(main.id, null, user.id);
    expect(await db.transaction((tx) => allocateOutflowLocations(tx, x.id, 5))).toEqual([{ locationId: alt1.id, quantity: 5 }]);
  });
});

describe("a retired temporary place and the transfer", () => {
  it("deactivateEmptyLocation removes the place as huvudplats and as alternative; an inflow then goes to alternative 1", async () => {
    const t = await place("T1", { fixed: false });
    const u = await place("U1", { fixed: false });
    const b = await place("B1");
    const x = await article("X-1", t.id);
    const y = await article("Y-1", b.id);
    await set(x.id, t.id, [b.id, u.id]);
    await set(y.id, b.id, [u.id]);
    await stock(x.id, t.id, 5);
    await stock(y.id, u.id, 2);

    await stock(x.id, t.id, -5);
    expect(await locationRow(t.id)).toMatchObject({ active: false });
    expect(await primaryOf(x.id)).toBeNull();
    // No alternative is promoted, but the next inflow goes to alternative 1.
    await stock(x.id, undefined, 4);
    expect(await balance(x.id, b.id)).toBe(4);

    await stock(y.id, u.id, -2);
    expect(await locationRow(u.id)).toMatchObject({ active: false });
    expect(await assignments(x.id)).toEqual([{ locationId: b.id, sortOrder: 1 }]);
    expect(await assignments(y.id)).toEqual([]);
    expect(await stockService.getArticleLocations(x.id)).toMatchObject({ primary: null, alternatives: [{ locationId: b.id }] });
    // A fixed place is never pruned, nor its assignments.
    await stock(x.id, b.id, -4);
    expect(await assignments(x.id)).toEqual([{ locationId: b.id, sortOrder: 1 }]);
  });

  it("only the huvudplats follows a transfer; an emptied temporary source leaves the other lists", async () => {
    const t = await place("T1", { fixed: false });
    const m = await place("M1");
    const s = await place("S1");
    const x = await article("X-1", t.id);
    const y = await article("Y-1", s.id);
    await set(x.id, t.id, [s.id]);
    await set(y.id, s.id, [t.id]);
    await stock(x.id, t.id, 4);

    const moved = await stockService.transferStock({ fromLocationId: t.id, toLocationId: m.id, rows: [{ articleId: x.id, quantity: 4 }] }, user.id);
    expect(moved.deactivatedSourceLocation).toBe(true);
    expect(await primaryOf(x.id)).toBe(m.id);
    expect(await assignments(x.id)).toEqual([{ locationId: s.id, sortOrder: 1 }]);
    expect(await assignments(y.id)).toEqual([]);
  });
});

describe("Kopiera från", () => {
  it("never copies the alternative places — the client fills in the huvudplats", async () => {
    const a1 = await place("A1");
    const b1 = await place("B1");
    const source = await article("SRC-1", a1.id);
    await set(source.id, a1.id, [b1.id]);

    const copy = await articleService.createArticle({
      articleNumber: "NEW-1",
      name: "Kopia",
      type: "purchased",
      unit: "st",
      active: true,
      defaultLocationId: a1.id,
      copyFrom: { articleId: source.id, parts: ["information", "inkop", "filer"] },
    });
    expect(await stockService.getArticleLocations(copy.id)).toMatchObject({ primary: { locationId: a1.id }, alternatives: [] });
    expect(await assignments(copy.id)).toEqual([]);
  });
});

// The lock order article → place, as in every draw: PUT takes the article
// row FOR NO KEY UPDATE first, so a draw reads either the whole old order or
// the whole new one; its places FOR SHARE after, against the cleanup.
describe("the lock between PUT and a draw", () => {
  async function threePlaces() {
    const p = await place("P");
    const b = await place("B");
    const c = await place("C");
    const x = await article("X-1", p.id);
    await set(x.id, p.id, [b.id, c.id]);
    await stock(x.id, b.id, 5);
    await stock(x.id, c.id, 5);
    return { p, b, c, x };
  }

  it("a draw waits for a PUT in progress and then follows the new order", async () => {
    const { p, b, c, x } = await threePlaces();
    const written = gate();
    const release = gate();
    const put = db.transaction(async (tx) => {
      await replaceArticleLocations(tx, x.id, { primaryLocationId: p.id, alternativeLocationIds: [c.id, b.id] });
      written.open();
      await release.promise;
    });
    put.catch(() => written.open());
    await written.promise;
    const draw = db.transaction((tx) => allocateOutflowLocations(tx, x.id, 7));
    // Released even when the wait fails, so the open transaction never hangs the file.
    await waitForLockWaiter().finally(release.open);
    await put;

    expect(await draw).toEqual([
      { locationId: c.id, quantity: 5 },
      { locationId: b.id, quantity: 2 },
    ]);
  });

  it("a PUT waits for a draw that read the old order, and answers with what the draw left", async () => {
    const { p, b, c, x } = await threePlaces();
    const drawn = gate();
    const release = gate();
    const draw = db.transaction(async (tx) => {
      const parts = await allocateOutflowLocations(tx, x.id, 7);
      for (const part of parts) {
        await tx.insert(stockTransactions).values({ articleId: x.id, locationId: part.locationId, quantityDelta: String(-part.quantity), transactionType: "sales_delivery" });
      }
      drawn.open();
      await release.promise;
      return parts;
    });
    draw.catch(() => drawn.open());
    await drawn.promise;
    const put = set(x.id, p.id, [c.id, b.id]);
    await waitForLockWaiter().finally(release.open);

    expect(await draw).toEqual([
      { locationId: b.id, quantity: 5 },
      { locationId: c.id, quantity: 2 },
    ]);
    expect((await put).alternatives.map((l) => [l.name, l.quantityOnHand])).toEqual([
      ["C", "3.0000"],
      ["B", "0.0000"],
    ]);
  });

  it("a draw holds an empty alternative place, so a cleanup of it waits and then finds the draw's minus", async () => {
    const u = await place("U1", { fixed: false });
    const x = await article("X-1");
    const y = await article("Y-1");
    // No huvudplats: U1 is where X's inflows and its remainder go.
    await set(x.id, null, [u.id]);
    await stock(y.id, u.id, 2);
    const drawn = gate();
    const release = gate();
    // X has nothing anywhere: the whole draw is the remainder, on U1 (the
    // first usable of its places), and U1 is held FOR SHARE meanwhile.
    const draw = db.transaction(async (tx) => {
      const parts = await allocateOutflowLocations(tx, x.id, 3);
      for (const part of parts) {
        await tx.insert(stockTransactions).values({ articleId: x.id, locationId: part.locationId, quantityDelta: String(-part.quantity), transactionType: "sales_delivery" });
      }
      drawn.open();
      await release.promise;
      return parts;
    });
    draw.catch(() => drawn.open());
    await drawn.promise;
    // Y's last 2 out of U1: it looks empty to this transaction (X's minus is
    // not committed), so the cleanup asks for the place and waits.
    const cleanup = stock(y.id, u.id, -2);
    await waitForLockWaiter().finally(release.open);

    expect(await draw).toEqual([{ locationId: u.id, quantity: 3 }]);
    await cleanup;
    expect(await locationRow(u.id)).toMatchObject({ active: true });
    expect(await assignments(x.id)).toEqual([{ locationId: u.id, sortOrder: 1 }]);
    expect(await balance(x.id, u.id)).toBe(-3);
  });

  it("a PUT keeping a temporary alternative waits for the cleanup that retires it, then refuses it as inactive", async () => {
    const a1 = await place("A1");
    const u = await place("U1", { fixed: false });
    const x = await article("X-1", a1.id);
    const y = await article("Y-1");
    await set(x.id, a1.id, [u.id]);
    await stock(y.id, u.id, 2);
    const retired = gate();
    const release = gate();
    const cleanup = db.transaction(async (tx) => {
      await tx.insert(stockTransactions).values({ articleId: y.id, locationId: u.id, quantityDelta: "-2", transactionType: "sales_delivery" });
      const deactivated = await deactivateEmptyLocation(tx, u.id);
      retired.open();
      await release.promise;
      return deactivated;
    });
    cleanup.catch(() => retired.open());
    await retired.promise;
    const put = set(x.id, a1.id, [u.id]).then(
      () => null,
      (e: unknown) => e
    );
    await waitForLockWaiter().finally(release.open);

    expect(await cleanup).toBe(true);
    const err = await put;
    expect(err).toBeInstanceOf(ArticleLocationInvalidError);
    expect((err as Error).message).toBe("Lagerplatsen Huvudlager — U1 är inaktiv och kan inte läggas till som alternativ lagerplats.");
    expect(await assignments(x.id)).toEqual([]);
  });
});

describe("GET/PUT /articles/:id/locations — routes", () => {
  const authService = createAuthService(createAuthRepository(db), "unused", createAuditRepository(db));
  const PASSWORD = "correcthorsebattery";
  let app: ReturnType<typeof buildRealApp>;

  beforeAll(async () => {
    app = buildRealApp();
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  async function userCookie(permissions: string[], readOnly = false) {
    const [group] = await db
      .insert(permissionGroups)
      .values({ code: `ALP${crypto.randomUUID().slice(0, 6)}`, name: "Lagerplatser", permissions })
      .returning();
    const email = `alp-${crypto.randomUUID()}@example.com`;
    await authService.createUser({ email, password: PASSWORD, name: "Användare", role: "user", permissionGroupId: group!.id, readOnly });
    const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PASSWORD } });
    expect(res.statusCode).toBe(200);
    return `session=${res.cookies.find((c) => c.name === "session")!.value}`;
  }
  const call = (cookie: string, method: "GET" | "PUT", url: string, payload?: unknown) =>
    app.inject({ method, url: `/api/v1${url}`, headers: { cookie }, ...(payload === undefined ? {} : { payload: payload as never }) });

  it("reads with office, writes with Artiklar or Lager, answers 400/404 with codes", async () => {
    const a1 = await place("A1");
    const b1 = await place("B1");
    const k = await place("K1", { blocked: true });
    const x = await article("X-1", a1.id);
    const body = { primaryLocationId: a1.id, alternativeLocationIds: [b1.id] };

    const buyer = await userCookie(["inkop"]);
    expect((await call(buyer, "GET", `/articles/${x.id}/locations`)).statusCode).toBe(200);
    expect((await call(buyer, "PUT", `/articles/${x.id}/locations`, body)).statusCode).toBe(403);

    for (const permissions of [["lager"], ["artiklar"]]) {
      const cookie = await userCookie(permissions);
      const res = await call(cookie, "PUT", `/articles/${x.id}/locations`, body);
      expect(res.statusCode, permissions[0]).toBe(200);
      expect(res.json()).toMatchObject({ primary: { locationId: a1.id }, alternatives: [{ locationId: b1.id, name: "B1" }] });
    }

    const lager = await userCookie(["lager"]);
    const blocked = await call(lager, "PUT", `/articles/${x.id}/locations`, { primaryLocationId: a1.id, alternativeLocationIds: [k.id] });
    expect([blocked.statusCode, blocked.json().code]).toEqual([400, "article-location-invalid"]);
    expect(blocked.json().error).toBe("Lagerplatsen Huvudlager — K1 är spärrad och kan inte läggas till som alternativ lagerplats.");
    const twice = await call(lager, "PUT", `/articles/${x.id}/locations`, { primaryLocationId: a1.id, alternativeLocationIds: [b1.id, b1.id] });
    expect([twice.statusCode, twice.json().code]).toEqual([400, "article-location-invalid"]);
    const shape = await call(lager, "PUT", `/articles/${x.id}/locations`, { primaryLocationId: "x", alternativeLocationIds: [] });
    expect([shape.statusCode, shape.json().code]).toEqual([400, "validation-failed"]);
    const unknown = await call(lager, "GET", `/articles/${crypto.randomUUID()}/locations`);
    expect([unknown.statusCode, unknown.json().code]).toEqual([404, "article-not-found"]);
    const unknownPut = await call(lager, "PUT", `/articles/${crypto.randomUUID()}/locations`, body);
    expect([unknownPut.statusCode, unknownPut.json().code]).toEqual([404, "article-not-found"]);
  });

  it("refuses a read-only account with 403 read-only-account", async () => {
    const a1 = await place("A1");
    const x = await article("X-1", a1.id);
    const readOnly = await userCookie(["lager", "artiklar"], true);
    const refused = await call(readOnly, "PUT", `/articles/${x.id}/locations`, { primaryLocationId: null, alternativeLocationIds: [] });
    expect([refused.statusCode, refused.json().code]).toEqual([403, "read-only-account"]);
    expect(await primaryOf(x.id)).toBe(a1.id);
    expect((await call(readOnly, "GET", `/articles/${x.id}/locations`)).statusCode).toBe(200);
  });
});

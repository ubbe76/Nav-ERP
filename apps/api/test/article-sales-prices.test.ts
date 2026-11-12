import { articleCustomerPricesSchema, articlePriceListRowsSchema, createArticleSchema } from "@navet/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { auditLog, customerArticleNumbers, customerPrices, db, permissionGroups, priceListRows, type Tx } from "@navet/db";
import { buildApp } from "../src/app.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createAuthService } from "../src/modules/auth/service/auth.service.js";
import { lockArticleSalesPair } from "../src/modules/sales/repository/article-sales-prices.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { testArticleService } from "./helpers/services.js";
import { waitForLockWaiter } from "./helpers/year-end.js";
import { parsed } from "./helpers/parsed.js";

// Artikelkortets flik Försäljning through the real app: the one read
// (GET /articles/:id/sales-prices) and the two PUTs that replace a staffel by
// diffing on fromQuantity — the customer's article prices + kundens
// artikelnummer, and the article's rows in a price list. All data is made up.

const authService = createAuthService(createAuthRepository(db), "unused", createAuditRepository(db));
const PASSWORD = "correcthorsebattery";
const UNKNOWN = "00000000-0000-4000-8000-000000000000";
const TRUNCATE = sql`TRUNCATE audit_log, customer_article_numbers, customer_prices, price_list_rows, price_lists, sales_order_rows, sales_orders, customers, article_groups, articles, user_settings, users CASCADE`;
// Only this file's groups — never TRUNCATE permission_groups (the seeded ones).
const DELETE_GROUPS = sql`DELETE FROM permission_groups WHERE code LIKE 'AFP%'`;

let app: ReturnType<typeof buildApp>;
let admin: string;

async function reset() {
  await db.execute(TRUNCATE);
  await db.execute(DELETE_GROUPS);
}

beforeAll(async () => {
  app = buildApp();
  await app.ready();
});

beforeEach(async () => {
  await reset();
  const email = `admin-${crypto.randomUUID()}@example.com`;
  await authService.createUser({ email, password: PASSWORD, name: "Admin", role: "admin" });
  admin = await login(email);
});

afterAll(async () => {
  await app.close();
  await reset();
});

async function login(email: string) {
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PASSWORD } });
  expect(res.statusCode).toBe(200);
  return `session=${res.cookies.find((c) => c.name === "session")!.value}`;
}

async function userCookie(permissions: string[], readOnly = false) {
  const [group] = await db
    .insert(permissionGroups)
    .values({ code: `AFP${crypto.randomUUID().slice(0, 6)}`, name: "Artikelns försäljning", permissions })
    .returning();
  const email = `afp-${crypto.randomUUID()}@example.com`;
  await authService.createUser({ email, password: PASSWORD, name: "Användare", role: "user", permissionGroupId: group!.id, readOnly });
  return login(email);
}

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
const call = (cookie: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url: `/api/v1${url}`, headers: { cookie }, ...(payload === undefined ? {} : { payload: payload as never }) });

async function makeArticle(groupId?: string) {
  return testArticleService.createArticle(
    parsed(createArticleSchema, {
      articleNumber: `AFP-${crypto.randomUUID().slice(0, 8)}`,
      name: "Diskbänk",
      type: "purchased",
      active: true,
      groupId,
    })
  );
}

async function makeCustomer(customerNumber: string, fields: Record<string, unknown> = {}) {
  const res = await call(admin, "POST", "/customers", { customerNumber, name: `Kund ${customerNumber}`, ...fields });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string };
}

async function makePriceList(code: string, currency = "SEK") {
  const res = await call(admin, "POST", "/price-lists", { code, name: `Lista ${code}`, currency });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string };
}

type PriceRow = { id: string; fromQuantity: string; unitPrice: string | null; discountPercent: string | null; setupPrice: string | null };
type CustomerEntry = {
  customerId: string;
  customerNumber: string;
  customerName: string;
  currency: string;
  customerArticleNumber: string | null;
  prices: PriceRow[];
};
type PriceListEntry = { priceListId: string; code: string; name: string; currency: string; rows: { id: string; fromQuantity: string; unitPrice: string }[] };
type SalesPrices = {
  customers: CustomerEntry[];
  priceLists: PriceListEntry[];
  articleGroup: { id: string; code: string; name: string } | null;
  groupRules: Array<Omit<CustomerEntry, "customerArticleNumber" | "prices"> & { hasArticlePrices: boolean; rules: PriceRow[] }>;
};

async function read(articleId: string, cookie = admin) {
  const res = await call(cookie, "GET", `/articles/${articleId}/sales-prices`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as SalesPrices;
}

const putCustomer = (articleId: string, customerId: string, payload: unknown, cookie = admin) =>
  call(cookie, "PUT", `/articles/${articleId}/customer-prices/${customerId}`, payload);
const putList = (articleId: string, priceListId: string, payload: unknown, cookie = admin) =>
  call(cookie, "PUT", `/articles/${articleId}/price-lists/${priceListId}`, payload);

async function saveCustomer(articleId: string, customerId: string, payload: unknown) {
  const res = await putCustomer(articleId, customerId, payload);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as CustomerEntry | null;
}

async function audits(entityType: string) {
  return db
    .select({ action: auditLog.action, entityId: auditLog.entityId, detail: auditLog.detail })
    .from(auditLog)
    .where(eq(auditLog.entityType, entityType))
    .orderBy(asc(auditLog.createdAt), asc(auditLog.id));
}
const clearAudit = () => db.delete(auditLog).where(inArray(auditLog.entityType, ["customer_price", "customer_article_number", "price_list"]));

// Runs `action` while another transaction holds what `lock` took, and lets
// that transaction commit once `action` is waiting on it. `beforeCommit`
// runs in the holder once `action` waits.
async function whileHolding<T>(lock: (tx: Tx) => Promise<unknown>, action: () => Promise<T>, beforeCommit?: (tx: Tx) => Promise<unknown>) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let locked!: () => void;
  const hasLocks = new Promise<void>((resolve) => (locked = resolve));
  const holder = db.transaction(async (tx) => {
    await lock(tx);
    locked();
    await gate;
    await beforeCommit?.(tx);
  });
  await Promise.race([hasLocks, holder]);
  const acting = action();
  try {
    await waitForLockWaiter();
  } finally {
    release(); // never leave the holder's locks behind a failed wait
  }
  await holder;
  return acting;
}

describe("the body schemas", () => {
  it("normalises a blank kundens artikelnummer to null and trims it", () => {
    expect(parsed(articleCustomerPricesSchema, { customerArticleNumber: "  ", prices: [] }).customerArticleNumber).toBeNull();
    expect(parsed(articleCustomerPricesSchema, { customerArticleNumber: " KA-1 ", prices: [] }).customerArticleNumber).toBe("KA-1");
  });

  it("compares fromQuantity in the column's four decimals", () => {
    const prices = [
      { fromQuantity: 1, unitPrice: 10 },
      { fromQuantity: "1.00001", unitPrice: 9 },
    ];
    expect(articleCustomerPricesSchema.safeParse({ customerArticleNumber: null, prices }).success).toBe(false);
    expect(articlePriceListRowsSchema.safeParse({ rows: prices }).success).toBe(false);
    // A step the column would store as 0.
    expect(articlePriceListRowsSchema.safeParse({ rows: [{ fromQuantity: 0.00004, unitPrice: 9 }] }).success).toBe(false);
  });

  it("takes at most 50 steps", () => {
    const rows = Array.from({ length: 51 }, (_, i) => ({ fromQuantity: i + 1, unitPrice: 1 }));
    expect(articlePriceListRowsSchema.safeParse({ rows }).success).toBe(false);
    expect(articleCustomerPricesSchema.safeParse({ customerArticleNumber: null, prices: rows }).success).toBe(false);
    expect(articlePriceListRowsSchema.safeParse({ rows: rows.slice(0, 50) }).success).toBe(true);
  });
});

describe("GET /articles/:id/sales-prices", () => {
  it("lists the customers with an article number, prices or both, sorted on the customer number", async () => {
    const article = await makeArticle();
    const other = await makeArticle();
    const both = await makeCustomer("1003");
    const onlyNumber = await makeCustomer("1001");
    const onlyPrices = await makeCustomer("1002", { currency: "EUR" });
    const elsewhere = await makeCustomer("1004");

    await saveCustomer(article.id, both.id, {
      customerArticleNumber: "KA-4411",
      // Sent descending — the answer is ascending on fromQuantity.
      prices: [
        { fromQuantity: 100, unitPrice: 229.5 },
        { fromQuantity: 1, unitPrice: 245, setupPrice: 500 },
        { fromQuantity: 10, discountPercent: 5 },
      ],
    });
    await saveCustomer(article.id, onlyNumber.id, { customerArticleNumber: "X-1", prices: [] });
    await saveCustomer(article.id, onlyPrices.id, { customerArticleNumber: null, prices: [{ fromQuantity: 1, unitPrice: 20 }] });
    // Another article's rows never show up.
    await saveCustomer(other.id, elsewhere.id, { customerArticleNumber: "ANNAN", prices: [{ fromQuantity: 1, unitPrice: 1 }] });

    const result = await read(article.id);
    expect(result.customers.map((c) => c.customerNumber)).toEqual(["1001", "1002", "1003"]);
    expect(result.customers[0]).toMatchObject({ customerId: onlyNumber.id, customerName: "Kund 1001", currency: "SEK", customerArticleNumber: "X-1", prices: [] });
    expect(result.customers[1]).toMatchObject({ customerId: onlyPrices.id, currency: "EUR", customerArticleNumber: null });
    expect(result.customers[1]!.prices).toMatchObject([{ fromQuantity: "1.0000", unitPrice: "20.0000", discountPercent: null, setupPrice: null }]);
    expect(result.customers[2]).toMatchObject({ customerId: both.id, customerArticleNumber: "KA-4411" });
    expect(result.customers[2]!.prices.map(({ id: _id, ...rest }) => rest)).toEqual([
      { fromQuantity: "1.0000", unitPrice: "245.0000", discountPercent: null, setupPrice: "500.0000" },
      { fromQuantity: "10.0000", unitPrice: null, discountPercent: "5.00", setupPrice: null },
      { fromQuantity: "100.0000", unitPrice: "229.5000", discountPercent: null, setupPrice: null },
    ]);
    expect(result.articleGroup).toBeNull();
    expect(result.groupRules).toEqual([]);
  });

  it("lists every price list sorted on the code, with the article's rows or none", async () => {
    const article = await makeArticle();
    const other = await makeArticle();
    const euro = await makePriceList("B-EUR", "EUR");
    const standard = await makePriceList("A-STD");
    await makePriceList("C-TOM");
    expect((await putList(article.id, euro.id, { rows: [{ fromQuantity: 50, unitPrice: 18 }, { fromQuantity: 1, unitPrice: 20 }] })).statusCode).toBe(200);
    expect((await putList(other.id, standard.id, { rows: [{ fromQuantity: 1, unitPrice: 7 }] })).statusCode).toBe(200);

    const { priceLists } = await read(article.id);
    expect(priceLists.map((l) => [l.code, l.name, l.currency, l.rows.map((r) => [r.fromQuantity, r.unitPrice])])).toEqual([
      ["A-STD", "Lista A-STD", "SEK", []],
      ["B-EUR", "Lista B-EUR", "EUR", [["1.0000", "20.0000"], ["50.0000", "18.0000"]]],
      ["C-TOM", "Lista C-TOM", "SEK", []],
    ]);
    expect(priceLists[1]!.priceListId).toBe(euro.id);
  });

  it("lists the customers' rules on the article's varugrupp and flags those with article prices too", async () => {
    const group = await testArticleService.createArticleGroup({ code: "101", name: "Diskbänkar" });
    const otherGroup = await testArticleService.createArticleGroup({ code: "102", name: "Blandare" });
    const article = await makeArticle(group.id);
    const withBoth = await makeCustomer("2002");
    const groupOnly = await makeCustomer("2001", { currency: "EUR" });
    const otherRule = await makeCustomer("2003");

    for (const [customerId, body] of [
      [withBoth.id, { articleGroupId: group.id, fromQuantity: 10, discountPercent: 12 }],
      [withBoth.id, { articleGroupId: group.id, fromQuantity: 1, discountPercent: 10 }],
      [groupOnly.id, { articleGroupId: group.id, fromQuantity: 1, unitPrice: 99, setupPrice: 250 }],
      [otherRule.id, { articleGroupId: otherGroup.id, fromQuantity: 1, discountPercent: 3 }],
    ] as const) {
      expect((await call(admin, "POST", `/customers/${customerId}/prices`, body)).statusCode).toBe(201);
    }
    await saveCustomer(article.id, withBoth.id, { customerArticleNumber: null, prices: [{ fromQuantity: 1, unitPrice: 200 }] });

    const result = await read(article.id);
    expect(result.articleGroup).toEqual({ id: group.id, code: "101", name: "Diskbänkar" });
    expect(result.groupRules.map((r) => [r.customerNumber, r.currency, r.hasArticlePrices])).toEqual([
      ["2001", "EUR", false],
      ["2002", "SEK", true],
    ]);
    expect(result.groupRules[0]!.rules).toMatchObject([{ fromQuantity: "1.0000", unitPrice: "99.0000", discountPercent: null, setupPrice: "250.0000" }]);
    expect(result.groupRules[1]!.rules.map((r) => [r.fromQuantity, r.discountPercent])).toEqual([["1.0000", "10.00"], ["10.0000", "12.00"]]);
    // The group rules are not article prices.
    expect(result.customers.map((c) => c.customerNumber)).toEqual(["2002"]);
  });

  it("404s for an unknown article", async () => {
    const res = await call(admin, "GET", `/articles/${UNKNOWN}/sales-prices`);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: "article-not-found" });
  });
});

describe("PUT /articles/:id/customer-prices/:customerId", () => {
  it("diffs on fromQuantity: an unchanged step keeps its row untouched, a new one is inserted, a missing one deleted", async () => {
    const article = await makeArticle();
    const customer = await makeCustomer("3001");
    const first = await saveCustomer(article.id, customer.id, {
      customerArticleNumber: null,
      prices: [
        { fromQuantity: 1, unitPrice: 100 },
        { fromQuantity: 10, unitPrice: 90 },
        { fromQuantity: 100, unitPrice: 80 },
      ],
    });
    const [one, ten, hundred] = first!.prices;
    expect((await audits("customer_price")).map((a) => a.action)).toEqual(["created", "created", "created"]);
    expect((await audits("customer_price"))[0]).toEqual({
      action: "created",
      entityId: one!.id,
      detail: { customerId: customer.id, articleId: article.id, articleGroupId: null, fromQuantity: "1.0000", unitPrice: "100.0000", discountPercent: null },
    });
    await clearAudit();

    // "1.0000" and 1 are the same step; 10 changes price; 100 goes; 50 is new.
    const second = await saveCustomer(article.id, customer.id, {
      customerArticleNumber: null,
      prices: [
        { fromQuantity: "1.0000", unitPrice: "100" },
        { fromQuantity: 10, unitPrice: 85 },
        { fromQuantity: 50, unitPrice: 82 },
      ],
    });
    expect(second!.prices.map((p) => [p.fromQuantity, p.unitPrice])).toEqual([
      ["1.0000", "100.0000"],
      ["10.0000", "85.0000"],
      ["50.0000", "82.0000"],
    ]);
    expect(second!.prices[0]!.id).toBe(one!.id);
    expect(second!.prices[1]!.id).toBe(ten!.id);
    expect(second!.prices[2]!.id).not.toBe(hundred!.id);

    // Only what differed is logged — nothing for the unchanged step.
    const log = await audits("customer_price");
    expect(log).toHaveLength(3);
    expect(log.find((a) => a.action === "deleted")).toEqual({
      action: "deleted",
      entityId: hundred!.id,
      detail: { fromQuantity: "100.0000", unitPrice: "80.0000", discountPercent: null },
    });
    expect(log.find((a) => a.action === "updated")).toEqual({
      action: "updated",
      entityId: ten!.id,
      detail: {
        before: { fromQuantity: "10.0000", unitPrice: "90.0000", discountPercent: null, setupPrice: null },
        after: { fromQuantity: "10.0000", unitPrice: "85.0000", discountPercent: null, setupPrice: null },
      },
    });
    expect(log.find((a) => a.action === "created")).toMatchObject({ entityId: second!.prices[2]!.id, detail: { fromQuantity: "50.0000", unitPrice: "82.0000" } });

    // The same body again writes and logs nothing.
    await clearAudit();
    const third = await saveCustomer(article.id, customer.id, {
      customerArticleNumber: null,
      prices: second!.prices.map(({ fromQuantity, unitPrice }) => ({ fromQuantity, unitPrice })),
    });
    expect(third).toEqual(second);
    expect(await audits("customer_price")).toEqual([]);
  });

  it("switches a step between price and discount, and sets and clears the ställpris (0 = none)", async () => {
    const article = await makeArticle();
    const customer = await makeCustomer("3002");
    const first = await saveCustomer(article.id, customer.id, { customerArticleNumber: null, prices: [{ fromQuantity: 1, unitPrice: 100 }] });
    const id = first!.prices[0]!.id;

    const discount = await saveCustomer(article.id, customer.id, { customerArticleNumber: null, prices: [{ fromQuantity: 1, discountPercent: 7.5, setupPrice: 300 }] });
    expect(discount!.prices).toEqual([{ id, fromQuantity: "1.0000", unitPrice: null, discountPercent: "7.50", setupPrice: "300.0000" }]);

    await clearAudit();
    const price = await saveCustomer(article.id, customer.id, { customerArticleNumber: null, prices: [{ fromQuantity: 1, unitPrice: 95, discountPercent: null, setupPrice: 0 }] });
    expect(price!.prices).toEqual([{ id, fromQuantity: "1.0000", unitPrice: "95.0000", discountPercent: null, setupPrice: null }]);
    expect(await audits("customer_price")).toEqual([
      {
        action: "updated",
        entityId: id,
        detail: {
          before: { fromQuantity: "1.0000", unitPrice: null, discountPercent: "7.50", setupPrice: "300.0000" },
          after: { fromQuantity: "1.0000", unitPrice: "95.0000", discountPercent: null, setupPrice: null },
        },
      },
    ]);
  });

  it("creates, changes and removes kundens artikelnummer with the customer card's audit entries", async () => {
    const article = await makeArticle();
    const customer = await makeCustomer("3003");

    const created = await saveCustomer(article.id, customer.id, { customerArticleNumber: " KA-1 ", prices: [] });
    expect(created).toMatchObject({ customerId: customer.id, customerNumber: "3003", customerArticleNumber: "KA-1", prices: [] });
    const [row] = await db.select().from(customerArticleNumbers).where(eq(customerArticleNumbers.customerId, customer.id));

    // The same number again: nothing written.
    await saveCustomer(article.id, customer.id, { customerArticleNumber: "KA-1", prices: [] });
    const changed = await saveCustomer(article.id, customer.id, { customerArticleNumber: "KA-2", prices: [] });
    expect(changed!.customerArticleNumber).toBe("KA-2");
    // The customer card reads the same row.
    const card = await call(admin, "GET", `/customers/${customer.id}/article-numbers`);
    expect(card.json()).toMatchObject([{ id: row!.id, articleId: article.id, customerArticleNumber: "KA-2" }]);

    // A blank number with nothing else left: the customer is gone.
    const removed = await saveCustomer(article.id, customer.id, { customerArticleNumber: "", prices: [] });
    expect(removed).toBeNull();
    expect((await read(article.id)).customers).toEqual([]);

    expect(await audits("customer_article_number")).toEqual([
      { action: "created", entityId: row!.id, detail: { customerId: customer.id, articleId: article.id, customerArticleNumber: "KA-1" } },
      { action: "updated", entityId: row!.id, detail: { before: "KA-1", after: "KA-2" } },
      { action: "deleted", entityId: row!.id, detail: { customerId: customer.id, articleId: article.id, customerArticleNumber: "KA-2" } },
    ]);
  });

  it("an empty staffel and no number answers null and removes the customer; other articles' and group rules stay", async () => {
    const group = await testArticleService.createArticleGroup({ code: "201", name: "Rör" });
    const article = await makeArticle(group.id);
    const other = await makeArticle();
    const customer = await makeCustomer("3004");
    await saveCustomer(article.id, customer.id, { customerArticleNumber: "KA-9", prices: [{ fromQuantity: 1, unitPrice: 10 }, { fromQuantity: 5, unitPrice: 9 }] });
    await saveCustomer(other.id, customer.id, { customerArticleNumber: "KA-10", prices: [{ fromQuantity: 1, unitPrice: 50 }] });
    expect((await call(admin, "POST", `/customers/${customer.id}/prices`, { articleGroupId: group.id, discountPercent: 4 })).statusCode).toBe(201);

    expect(await saveCustomer(article.id, customer.id, { customerArticleNumber: null, prices: [] })).toBeNull();
    const result = await read(article.id);
    expect(result.customers).toEqual([]);
    expect(result.groupRules).toMatchObject([{ customerId: customer.id, hasArticlePrices: false }]);
    expect((await read(other.id)).customers).toMatchObject([{ customerArticleNumber: "KA-10", prices: [{ unitPrice: "50.0000" }] }]);
  });

  it("400s for both or neither of price and discount, a repeated fromQuantity, an oversized number and a blank", async () => {
    const article = await makeArticle();
    const customer = await makeCustomer("3005");
    const bodies: unknown[] = [
      { customerArticleNumber: null, prices: [{ fromQuantity: 1, unitPrice: 10, discountPercent: 5 }] },
      { customerArticleNumber: null, prices: [{ fromQuantity: 1 }] },
      { customerArticleNumber: null, prices: [{ fromQuantity: 1, unitPrice: 10 }, { fromQuantity: "1.0000", unitPrice: 9 }] },
      { customerArticleNumber: null, prices: [{ fromQuantity: 1, unitPrice: 10_000_000_000 }] },
      { customerArticleNumber: null, prices: [{ fromQuantity: 10_000_000_000, unitPrice: 10 }] },
      { customerArticleNumber: null, prices: [{ fromQuantity: 1, unitPrice: 10, setupPrice: 10_000_000_000 }] },
      { customerArticleNumber: null, prices: [{ fromQuantity: "", unitPrice: 10 }] },
      { customerArticleNumber: null, prices: [{ fromQuantity: 1, unitPrice: "" }] },
      { customerArticleNumber: null, prices: [{ fromQuantity: 0, unitPrice: 10 }] },
      { customerArticleNumber: null, prices: [{ fromQuantity: 1, discountPercent: 101 }] },
      { customerArticleNumber: "x".repeat(51), prices: [] },
      { prices: [] },
      { customerArticleNumber: null },
    ];
    for (const body of bodies) {
      const res = await putCustomer(article.id, customer.id, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(res.json()).toMatchObject({ code: "validation-failed" });
    }
    expect(await db.select().from(customerPrices)).toEqual([]);
  });

  it("404s for an unknown customer or article, 400 for a malformed id", async () => {
    const article = await makeArticle();
    const customer = await makeCustomer("3006");
    const body = { customerArticleNumber: "KA", prices: [{ fromQuantity: 1, unitPrice: 10 }] };
    const noCustomer = await putCustomer(article.id, UNKNOWN, body);
    expect(noCustomer.statusCode).toBe(404);
    expect(noCustomer.json()).toMatchObject({ code: "customer-not-found" });
    const noArticle = await putCustomer(UNKNOWN, customer.id, body);
    expect(noArticle.statusCode).toBe(404);
    expect(noArticle.json()).toMatchObject({ code: "article-not-found" });
    expect((await putCustomer(article.id, "1001", body)).statusCode).toBe(400);
  });

  it("409s when the customer card's POST of the same fromQuantity commits during the save, and writes nothing", async () => {
    const article = await makeArticle();
    const customer = await makeCustomer("3007");
    await saveCustomer(article.id, customer.id, { customerArticleNumber: null, prices: [{ fromQuantity: 1, unitPrice: 100 }] });

    // The customer card's insert, uncommitted: the PUT's insert of step 10
    // waits on the unique index until it commits.
    const res = await whileHolding(
      (tx) => tx.insert(customerPrices).values({ customerId: customer.id, articleId: article.id, fromQuantity: "10", unitPrice: "77" }),
      () =>
        putCustomer(article.id, customer.id, {
          customerArticleNumber: "KA-7",
          prices: [
            { fromQuantity: 1, unitPrice: 95 },
            { fromQuantity: 5, unitPrice: 92 },
            { fromQuantity: 10, unitPrice: 90 },
          ],
        })
    );
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json()).toMatchObject({ code: "duplicate-customer-price" });

    // The whole save rolled back: the old price, no step 5, no number — and
    // the customer card's row.
    const [entry] = (await read(article.id)).customers;
    expect(entry!.customerArticleNumber).toBeNull();
    expect(entry!.prices.map((p) => [p.fromQuantity, p.unitPrice])).toEqual([
      ["1.0000", "100.0000"],
      ["10.0000", "77.0000"],
    ]);
  });

  it("takes the pair's lock before it reads: a save that waits diffs against what the first one committed", async () => {
    const article = await makeArticle();
    const customer = await makeCustomer("3008");
    const otherCustomer = await makeCustomer("3009");
    await saveCustomer(article.id, customer.id, { customerArticleNumber: null, prices: [{ fromQuantity: 1, unitPrice: 100 }] });

    // Another pair's lock does not block.
    await db.transaction(async (tx) => {
      await lockArticleSalesPair(tx, "customer", otherCustomer.id, article.id);
      await lockArticleSalesPair(tx, "price_list", customer.id, article.id);
      await saveCustomer(article.id, customer.id, { customerArticleNumber: null, prices: [{ fromQuantity: 1, unitPrice: 101 }] });
    });

    // The "first save" holds the lock, adds step 5 and reprices step 1 while
    // the second waits. Had the second read before the lock, its insert of
    // step 5 would have met the unique index (409) and step 1 = 101 would
    // have looked unchanged.
    const res = await whileHolding(
      (tx) => lockArticleSalesPair(tx, "customer", customer.id, article.id),
      () =>
        putCustomer(article.id, customer.id, {
          customerArticleNumber: null,
          prices: [
            { fromQuantity: 1, unitPrice: 101 },
            { fromQuantity: 5, unitPrice: 92 },
          ],
        }),
      async (tx) => {
        await tx.insert(customerPrices).values({ customerId: customer.id, articleId: article.id, fromQuantity: "5", unitPrice: "70" });
        await tx.insert(customerPrices).values({ customerId: customer.id, articleId: article.id, fromQuantity: "20", unitPrice: "60" });
        await tx
          .update(customerPrices)
          .set({ unitPrice: "150" })
          .where(and(eq(customerPrices.customerId, customer.id), eq(customerPrices.fromQuantity, "1")));
      }
    );
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as CustomerEntry).prices.map((p) => [p.fromQuantity, p.unitPrice])).toEqual([
      ["1.0000", "101.0000"],
      ["5.0000", "92.0000"],
    ]);
  });

  it("two simultaneous saves of the same pair both succeed and leave exactly one of the two staffels", async () => {
    const article = await makeArticle();
    const customer = await makeCustomer("3010");
    const a = { customerArticleNumber: "A", prices: [{ fromQuantity: 1, unitPrice: 10 }, { fromQuantity: 10, unitPrice: 9 }] };
    const b = { customerArticleNumber: "B", prices: [{ fromQuantity: 1, unitPrice: 20 }, { fromQuantity: 10, unitPrice: 19 }, { fromQuantity: 30, unitPrice: 18 }] };
    // Without the lock both would insert step 1 and one would get the 409.
    const [first, second] = await Promise.all([putCustomer(article.id, customer.id, a), putCustomer(article.id, customer.id, b)]);
    expect([first.statusCode, second.statusCode]).toEqual([200, 200]);

    const [entry] = (await read(article.id)).customers;
    const state = [entry!.customerArticleNumber, entry!.prices.map((p) => Number(p.unitPrice))];
    expect([
      ["A", [10, 9]],
      ["B", [20, 19, 18]],
    ]).toContainEqual(state);
  });

  it("the price chain answers the new customer price and staffel", async () => {
    const article = await makeArticle();
    const customer = await makeCustomer("3011");
    await saveCustomer(article.id, customer.id, {
      customerArticleNumber: null,
      prices: [
        { fromQuantity: 1, unitPrice: 245 },
        { fromQuantity: 100, unitPrice: 229.5 },
      ],
    });
    const quote = async (quantity: number) => {
      const res = await call(admin, "GET", `/price-quote?customerId=${customer.id}&articleId=${article.id}&quantity=${quantity}`);
      expect(res.statusCode, res.body).toBe(200);
      return (res.json() as { price: { unitPrice: number; source: string } | null }).price;
    };
    expect(await quote(99)).toMatchObject({ unitPrice: 245, source: "customer_article" });
    expect(await quote(100)).toMatchObject({ unitPrice: 229.5, source: "customer_article" });

    await saveCustomer(article.id, customer.id, { customerArticleNumber: null, prices: [{ fromQuantity: 1, unitPrice: 240 }] });
    expect(await quote(100)).toMatchObject({ unitPrice: 240, source: "customer_article" });
  });
});

describe("PUT /articles/:id/price-lists/:priceListId", () => {
  it("diffs on fromQuantity and logs the register's audit entries", async () => {
    const article = await makeArticle();
    const list = await makePriceList("STD");
    const first = await putList(article.id, list.id, { rows: [{ fromQuantity: 1, unitPrice: 100 }, { fromQuantity: 10, unitPrice: 90 }, { fromQuantity: 100, unitPrice: 80 }] });
    expect(first.statusCode, first.body).toBe(200);
    const before = first.json() as PriceListEntry;
    expect(before).toMatchObject({ priceListId: list.id, code: "STD", name: "Lista STD", currency: "SEK" });
    const [one, ten, hundred] = before.rows;
    await clearAudit();

    const second = await putList(article.id, list.id, { rows: [{ fromQuantity: "1.0000", unitPrice: 100 }, { fromQuantity: 10, unitPrice: 85 }, { fromQuantity: 50, unitPrice: 82 }] });
    expect(second.statusCode, second.body).toBe(200);
    const after = second.json() as PriceListEntry;
    expect(after.rows.map((r) => [r.fromQuantity, r.unitPrice])).toEqual([
      ["1.0000", "100.0000"],
      ["10.0000", "85.0000"],
      ["50.0000", "82.0000"],
    ]);
    expect([after.rows[0]!.id, after.rows[1]!.id]).toEqual([one!.id, ten!.id]);
    expect(after.rows[2]!.id).not.toBe(hundred!.id);

    const log = await audits("price_list");
    expect(log).toHaveLength(3);
    expect(log.every((a) => a.entityId === "STD")).toBe(true);
    expect(log.find((a) => a.action === "row_deleted")!.detail).toEqual({ articleNumber: article.articleNumber, fromQuantity: "100.0000", unitPrice: "80.0000" });
    expect(log.find((a) => a.action === "row_updated")!.detail).toEqual({
      articleNumber: article.articleNumber,
      before: { fromQuantity: "10.0000", unitPrice: "90.0000" },
      after: { fromQuantity: "10.0000", unitPrice: "85.0000" },
    });
    expect(log.find((a) => a.action === "row_added")!.detail).toEqual({ articleNumber: article.articleNumber, fromQuantity: "50.0000", unitPrice: "82.0000" });

    // The register reads the same rows.
    const register = await call(admin, "GET", `/price-lists/${list.id}`);
    expect((register.json() as { rows: { id: string }[] }).rows.map((r) => r.id).sort()).toEqual(after.rows.map((r) => r.id).sort());

    // Empty rows = the article leaves the list.
    await clearAudit();
    const emptied = await putList(article.id, list.id, { rows: [] });
    expect(emptied.statusCode).toBe(200);
    expect((emptied.json() as PriceListEntry).rows).toEqual([]);
    expect(await db.select().from(priceListRows).where(eq(priceListRows.priceListId, list.id))).toEqual([]);
    expect((await audits("price_list")).map((a) => a.action)).toEqual(["row_deleted", "row_deleted", "row_deleted"]);
  });

  it("400s for a repeated fromQuantity, an oversized or blank number and a missing price; 404s for unknown ids", async () => {
    const article = await makeArticle();
    const list = await makePriceList("STD");
    for (const body of [
      { rows: [{ fromQuantity: 1, unitPrice: 10 }, { fromQuantity: 1, unitPrice: 9 }] },
      { rows: [{ fromQuantity: 1, unitPrice: 10_000_000_000 }] },
      { rows: [{ fromQuantity: 1, unitPrice: "" }] },
      { rows: [{ fromQuantity: 1 }] },
      { rows: [{ fromQuantity: -1, unitPrice: 5 }] },
      {},
    ]) {
      const res = await putList(article.id, list.id, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
    }
    const body = { rows: [{ fromQuantity: 1, unitPrice: 10 }] };
    const noList = await putList(article.id, UNKNOWN, body);
    expect(noList.statusCode).toBe(404);
    expect(noList.json()).toMatchObject({ code: "price-list-not-found" });
    const noArticle = await putList(UNKNOWN, list.id, body);
    expect(noArticle.statusCode).toBe(404);
    expect(noArticle.json()).toMatchObject({ code: "article-not-found" });
  });

  it("409s when the register's POST of the same fromQuantity commits during the save", async () => {
    const article = await makeArticle();
    const list = await makePriceList("STD");
    const res = await whileHolding(
      (tx) => tx.insert(priceListRows).values({ priceListId: list.id, articleId: article.id, fromQuantity: "10", unitPrice: "77" }),
      () => putList(article.id, list.id, { rows: [{ fromQuantity: 1, unitPrice: 95 }, { fromQuantity: 10, unitPrice: 90 }] })
    );
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json()).toMatchObject({ code: "duplicate-price-list-row" });
    const [entry] = (await read(article.id)).priceLists;
    expect(entry!.rows.map((r) => [r.fromQuantity, r.unitPrice])).toEqual([["10.0000", "77.0000"]]);
  });

  it("a save that waits on the pair's lock diffs against what the first one committed", async () => {
    const article = await makeArticle();
    const list = await makePriceList("STD");
    const res = await whileHolding(
      (tx) => lockArticleSalesPair(tx, "price_list", list.id, article.id),
      () => putList(article.id, list.id, { rows: [{ fromQuantity: 1, unitPrice: 95 }] }),
      (tx) =>
        tx.insert(priceListRows).values([
          { priceListId: list.id, articleId: article.id, fromQuantity: "1", unitPrice: "70" },
          { priceListId: list.id, articleId: article.id, fromQuantity: "20", unitPrice: "60" },
        ])
    );
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as PriceListEntry).rows.map((r) => [r.fromQuantity, r.unitPrice])).toEqual([["1.0000", "95.0000"]]);
  });
});

describe("permissions", () => {
  it("office users read; the customer prices need Försäljning; the price list rows need admin", async () => {
    const article = await makeArticle();
    const customer = await makeCustomer("4001");
    const list = await makePriceList("STD");
    const customerBody = { customerArticleNumber: "KA", prices: [{ fromQuantity: 1, unitPrice: 10 }] };
    const listBody = { rows: [{ fromQuantity: 1, unitPrice: 10 }] };

    const articlesOnly = await userCookie(["artiklar"]);
    expect((await call(articlesOnly, "GET", `/articles/${article.id}/sales-prices`)).statusCode).toBe(200);
    expect((await putCustomer(article.id, customer.id, customerBody, articlesOnly)).statusCode).toBe(403);
    expect((await putList(article.id, list.id, listBody, articlesOnly)).statusCode).toBe(403);

    const sales = await userCookie(["forsaljning"]);
    expect((await putCustomer(article.id, customer.id, customerBody, sales)).statusCode).toBe(200);
    expect((await putList(article.id, list.id, listBody, sales)).statusCode).toBe(403);
    expect((await read(article.id, sales)).priceLists[0]!.rows).toEqual([]);

    // The stamping terminal is not an office user.
    const terminal = await userCookie(["terminal"]);
    expect((await call(terminal, "GET", `/articles/${article.id}/sales-prices`)).statusCode).toBe(403);

    expect((await putList(article.id, list.id, listBody)).statusCode).toBe(200);
  });

  it("a read-only account reads but both PUTs are 403 read-only-account", async () => {
    const article = await makeArticle();
    const customer = await makeCustomer("4002");
    const list = await makePriceList("STD");
    const readOnly = await userCookie(["forsaljning"], true);
    expect((await call(readOnly, "GET", `/articles/${article.id}/sales-prices`)).statusCode).toBe(200);
    for (const res of [
      await putCustomer(article.id, customer.id, { customerArticleNumber: "KA", prices: [] }, readOnly),
      await putList(article.id, list.id, { rows: [{ fromQuantity: 1, unitPrice: 10 }] }, readOnly),
    ]) {
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: "read-only-account" });
    }
    expect((await read(article.id)).customers).toEqual([]);
  });
});

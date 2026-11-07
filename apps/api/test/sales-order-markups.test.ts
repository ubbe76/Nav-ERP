import { API_CLIENT_SCOPES, fromSek } from "@navet/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, asc, eq, sql } from "drizzle-orm";
import {
  articles,
  auditLog,
  costCalculations,
  customers,
  db,
  invoiceRows,
  invoices,
  permissionGroups,
  priceListRows,
  priceLists,
  salesOrderRows,
  salesOrders,
  systemSettings,
} from "@navet/db";
import { buildApp } from "../src/app.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createAuthService } from "../src/modules/auth/service/auth.service.js";
import { createOAuthRepository } from "../src/modules/oauth/repository/oauth.repository.js";
import { createOAuthService } from "../src/modules/oauth/service/oauth.service.js";
import { createSalesRepository, type PlannedRowReprice } from "../src/modules/sales/repository/sales.repository.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { resetConfigurator } from "./helpers/configurator.js";
import { buildToOrder, buildVariants } from "./helpers/configured-rows.js";
import { testArticleService } from "./helpers/services.js";
import { waitForLockWaiter } from "./helpers/year-end.js";

// Påslag på offert och order (#16 etapp 3) through the real app: the order
// header's two price markups (order → kund → varugrupp → företaget, field by
// field), the Kalkylpris they give, and — beslut 3 — the repricing of the
// Kalkylpris rows that are neither delivered nor invoiced when they change,
// after a confirmation: the preview (nothing written), the 409 without
// confirmRepricing, the save, the audit entry, the lock order against a
// concurrent row PATCH, the currency, the permissions, the quote that is
// confirmed and the OAuth API.
//
// The förkalkyl is the spec's example (påhittad): 50 st, SVK 10 000 (TVK
// 8 000 + Affo 25 %), base B = dM + MO = 6 000, TO 500, g₀ 40 % ⇒ 4 000,
// m₀ 10 % ⇒ 600, F₀ = 15 100 (302 kr/st). With g and m:
//   Kalkylpris/st = (15 100 + 10 000 × (g − 40)/100 + 6 000 × (m − 10)/100) / 50
// g 20 m 0 ⇒ 250, g 30 m 0 ⇒ 270, g 40 m 0 ⇒ 290, g 20 m 5 ⇒ 256.

const authService = createAuthService(createAuthRepository(db), "unused", createAuditRepository(db));
const oauthService = createOAuthService(createOAuthRepository(db), "unused");
const salesRepository = createSalesRepository(db);
const PASSWORD = "correcthorsebattery";
const TRUNCATE = sql`TRUNCATE audit_log, cost_calculations, customer_prices, price_list_rows, price_lists, invoice_rows, invoices, sales_order_rows, sales_orders, customers, api_clients, article_groups, user_settings, stock_transactions, stock_locations, warehouses, users CASCADE`;
// Only this file's groups — never TRUNCATE permission_groups (the seeded ones).
const DELETE_GROUPS = sql`DELETE FROM permission_groups WHERE code LIKE 'POM%'`;
const DELETE_SETTINGS = sql`DELETE FROM system_settings WHERE key IN ('costing_general_markup_percent', 'costing_material_markup_percent', 'freight_article_id')`;

let app: ReturnType<typeof buildApp>;
let admin: string;

async function reset() {
  await resetConfigurator();
  await db.execute(TRUNCATE);
  await db.execute(DELETE_GROUPS);
  await db.execute(DELETE_SETTINGS);
}

beforeAll(async () => {
  app = buildApp();
  await app.ready();
});

beforeEach(async () => {
  await reset();
  admin = (await adminSession()).cookie;
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

async function adminSession() {
  const email = `admin-${crypto.randomUUID()}@example.com`;
  const user = await authService.createUser({ email, password: PASSWORD, name: "Admin", role: "admin" });
  return { user, cookie: await login(email) };
}

async function userCookie(permissions: string[], readOnly = false) {
  const [group] = await db
    .insert(permissionGroups)
    .values({ code: `POM${crypto.randomUUID().slice(0, 6)}`, name: "Orderpåslag", permissions })
    .returning();
  const email = `pom-${crypto.randomUUID()}@example.com`;
  await authService.createUser({ email, password: PASSWORD, name: "Användare", role: "user", permissionGroupId: group!.id, readOnly });
  return login(email);
}

type Method = "GET" | "POST" | "PATCH" | "PUT";
const call = (cookie: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url: `/api/v1${url}`, headers: { cookie }, ...(payload === undefined ? {} : { payload: payload as never }) });

async function makeArticle(opts: { salesPrice?: number } = {}) {
  const article = await testArticleService.createArticle({
    articleNumber: `OP-${crypto.randomUUID().slice(0, 8)}`,
    name: "Diskbänk",
    type: "manufactured",
    unit: "st",
    active: true,
  });
  if (opts.salesPrice !== undefined) await db.update(articles).set({ salesPrice: String(opts.salesPrice) }).where(eq(articles.id, article.id));
  return article;
}

// The spec's förkalkyl as header columns (see the file header).
async function saveCalculation(articleId: string, overrides: Partial<typeof costCalculations.$inferInsert> = {}) {
  const [row] = await db
    .insert(costCalculations)
    .values({
      articleId,
      type: "pre",
      quantity: "50",
      materialCost: "5000",
      materialOverhead: "1000",
      laborCost: "2000",
      overhead: "500",
      businessOverhead: "2000",
      affoPercent: "25",
      generalMarkup: "4000",
      materialMarkup: "600",
      salesPrice: "15100",
      generalMarkupPercent: "40",
      materialMarkupPercent: "10",
      materialMarkupBase: "6000",
      ...overrides,
    })
    .returning();
  return row!;
}

async function makeCustomer(fields: Record<string, unknown> = {}) {
  const res = await call(admin, "POST", "/customers", { name: "Kund AB", ...fields });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string };
}

type Row = { id: string; unitPrice: string; discountPercent: string; calculatedPrice: boolean; priceOrigin: string };
async function createQuote(payload: Record<string, unknown>) {
  const res = await call(admin, "POST", "/quotes", payload);
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { order: { id: string; orderNumber: string }; rows: Row[] };
}

async function addRow(orderId: string, payload: Record<string, unknown>, cookie = admin) {
  const res = await call(cookie, "POST", `/sales-orders/${orderId}/rows`, payload);
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as Row;
}

const patchHeader = (orderId: string, payload: Record<string, unknown>, cookie = admin) =>
  call(cookie, "PATCH", `/sales-orders/${orderId}`, payload);
const preview = (orderId: string, payload: Record<string, unknown>, cookie = admin) =>
  call(cookie, "POST", `/sales-orders/${orderId}/markups/preview`, payload);

const storedRows = (orderId: string) =>
  db
    .select({
      id: salesOrderRows.id,
      unitPrice: salesOrderRows.unitPrice,
      discountPercent: salesOrderRows.discountPercent,
      priceOrigin: salesOrderRows.priceOrigin,
      quantityOrdered: salesOrderRows.quantityOrdered,
      unitFactor: salesOrderRows.unitFactor,
    })
    .from(salesOrderRows)
    .where(eq(salesOrderRows.salesOrderId, orderId))
    .orderBy(asc(salesOrderRows.createdAt), asc(salesOrderRows.id));

const storedOrder = async (orderId: string) =>
  (
    await db
      .select({
        generalMarkupPercent: salesOrders.generalMarkupPercent,
        materialMarkupPercent: salesOrders.materialMarkupPercent,
        revision: salesOrders.revision,
        exchangeRate: salesOrders.exchangeRate,
      })
      .from(salesOrders)
      .where(eq(salesOrders.id, orderId))
  )[0]!;

const markupAudits = () =>
  db
    .select({ entityType: auditLog.entityType, entityId: auditLog.entityId, detail: auditLog.detail })
    .from(auditLog)
    .where(and(eq(auditLog.entityType, "sales_order"), eq(auditLog.action, "markups_changed")))
    .orderBy(asc(auditLog.createdAt), asc(auditLog.id));

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Until `n` transactions wait on a lock (pg_stat_activity), as
// helpers/year-end.ts's waitForLockWaiter does for one.
async function waitForLockWaiters(n: number, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [row] = [
      ...(await db.execute(
        sql`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`
      )),
    ] as { n: number }[];
    if ((row?.n ?? 0) >= n) return;
    await sleep(20);
  }
  throw new Error(`Fewer than ${n} transactions started waiting on a lock`);
}

// A Kalkylpris order: the customer has 20 % / 0 %, the article the spec's förkalkyl.
async function calculatedOrder(customerFields: Record<string, unknown> = { generalMarkupPercent: 20, materialMarkupPercent: 0 }) {
  const article = await makeArticle({ salesPrice: 300 });
  await saveCalculation(article.id);
  const customer = await makeCustomer(customerFields);
  return { article, customer };
}

describe("orderns påslag — fälten", () => {
  it("GET carries the order's own two fields and the customer's as customerMarkups; PATCH field by field, null inherits, omitted leaves them", async () => {
    const customer = await makeCustomer({ generalMarkupPercent: 20 });
    const article = await makeArticle({ salesPrice: 300 });
    const { order } = await createQuote({ customerId: customer.id, rows: [{ articleId: article.id, quantity: 1, unitPrice: 300 }] });

    const fresh = (await call(admin, "GET", `/sales-orders/${order.id}`)).json();
    expect(fresh).toMatchObject({
      generalMarkupPercent: null,
      materialMarkupPercent: null,
      customerMarkups: { generalMarkupPercent: "20.00", materialMarkupPercent: null },
    });

    // A handwritten row only: nothing to reprice, so no confirmation needed.
    const zeroed = await patchHeader(order.id, { materialMarkupPercent: 0 });
    expect(zeroed.statusCode, zeroed.body).toBe(200);
    expect(zeroed.json()).toMatchObject({ generalMarkupPercent: null, materialMarkupPercent: "0.00" });
    expect(zeroed.json().repricing).toMatchObject({
      changed: true,
      before: { generalMarkupPercent: null, materialMarkupPercent: null },
      after: { generalMarkupPercent: null, materialMarkupPercent: 0 },
      rows: [],
      kept: [{ reason: "manual" }],
    });
    const other = await patchHeader(order.id, { customerReference: "Anna" });
    expect(other.json()).toMatchObject({ generalMarkupPercent: null, materialMarkupPercent: "0.00" });
    expect(other.json()).not.toHaveProperty("repricing");
    // Two decimals, like the column.
    const both = await patchHeader(order.id, { generalMarkupPercent: 12.346, materialMarkupPercent: null });
    expect(both.json()).toMatchObject({ generalMarkupPercent: "12.35", materialMarkupPercent: null });
    expect((await call(admin, "GET", `/sales-orders/${order.id}`)).json()).toMatchObject({
      generalMarkupPercent: "12.35",
      materialMarkupPercent: null,
    });
  });

  it("refuses a percentage outside 0–1000 in the API and in the database", async () => {
    const customer = await makeCustomer();
    const article = await makeArticle({ salesPrice: 300 });
    const { order } = await createQuote({ customerId: customer.id, rows: [{ articleId: article.id, quantity: 1, unitPrice: 300 }] });
    for (const generalMarkupPercent of [-1, 1000.01, "20"]) {
      const res = await patchHeader(order.id, { generalMarkupPercent });
      expect([generalMarkupPercent, res.statusCode, res.json().code]).toEqual([generalMarkupPercent, 400, "validation-failed"]);
    }
    expect((await preview(order.id, { moPercent: 10 })).statusCode).toBe(400);
    await expect(db.execute(sql`update sales_orders set general_markup_percent = 1000.01`)).rejects.toThrow();
    await expect(db.execute(sql`update sales_orders set material_markup_percent = -0.01`)).rejects.toThrow();
  });

  it("are never set on create — POST /quotes drops them", async () => {
    const customer = await makeCustomer();
    const article = await makeArticle({ salesPrice: 300 });
    const { order } = await createQuote({
      customerId: customer.id,
      generalMarkupPercent: 30,
      materialMarkupPercent: 0,
      rows: [{ articleId: article.id, quantity: 1 }],
    });
    expect(await storedOrder(order.id)).toMatchObject({ generalMarkupPercent: null, materialMarkupPercent: null });
  });
});

describe("orderns påslag i priskedjan", () => {
  it("gives the Kalkylpris on its own — without a customer markup — and goes before the customer's, field by field", async () => {
    const article = await makeArticle({ salesPrice: 300 });
    await saveCalculation(article.id);
    const plain = await makeCustomer();
    const { order } = await createQuote({ customerId: plain.id, rows: [{ articleId: article.id, quantity: 1 }] });
    expect((await storedRows(order.id))[0]).toMatchObject({ unitPrice: "300.0000", priceOrigin: "chain" });

    // The article-price row was priced by the chain, so the order's markup reprices it too (0197).
    expect((await patchHeader(order.id, { generalMarkupPercent: 20, confirmRepricing: true })).statusCode).toBe(200);
    expect((await storedRows(order.id))[0]).toMatchObject({ unitPrice: "250.0000", priceOrigin: "calculated" });
    // The company has 0 % material: 15 100 − 2 000 − 600 ⇒ 250.
    const row = await addRow(order.id, { articleId: article.id, quantity: 1 });
    expect(row).toMatchObject({ unitPrice: "250.0000", calculatedPrice: true });
    const quote = (
      await call(admin, "GET", `/price-quote?customerId=${plain.id}&articleId=${article.id}&quantity=1&salesOrderId=${order.id}`)
    ).json();
    expect(quote.price).toEqual({ unitPrice: 250, discountPercent: 0, source: "calculated" });
    expect(quote.calculated).toMatchObject({ generalMarkup: { percent: 20, level: "order" }, materialMarkup: { percent: 0, level: "company" } });
    // Without the order the customer has nothing of its own: the article's price.
    expect((await call(admin, "GET", `/price-quote?customerId=${plain.id}&articleId=${article.id}&quantity=1`)).json().price.source).toBe("article");

    // The customer's 30 % / 5 % under the order's 20 % / —: generellt from the order, material from the customer.
    const negotiated = await makeCustomer({ generalMarkupPercent: 30, materialMarkupPercent: 5 });
    const second = await createQuote({ customerId: negotiated.id, rows: [{ articleId: article.id, quantity: 1 }] });
    expect(second.rows[0]).toMatchObject({ unitPrice: "276.0000", calculatedPrice: true }); // 15 100 − 1 000 − 300
    const saved = await patchHeader(second.order.id, { generalMarkupPercent: 20, materialMarkupPercent: null, confirmRepricing: true });
    expect(saved.statusCode, saved.body).toBe(200);
    expect((await storedRows(second.order.id))[0]).toMatchObject({ unitPrice: "256.0000", priceOrigin: "calculated" });
    const onOrder = (
      await call(admin, "GET", `/price-quote?customerId=${negotiated.id}&articleId=${article.id}&quantity=1&salesOrderId=${second.order.id}`)
    ).json();
    expect(onOrder.calculated).toMatchObject({ generalMarkup: { percent: 20, level: "order" }, materialMarkup: { percent: 5, level: "customer" } });
  });
});

describe("omräkningen när orderns påslag ändras", () => {
  // R1 Kalkylpris, R2 handwritten, R3 Kalkylpris partly delivered, R4
  // Kalkylpris on a draft invoice, R5 a beställningsvara and R6 the freight
  // row (both given the origin calculated by hand — neither can follow the
  // markups).
  async function mixedOrder() {
    const { article, customer } = await calculatedOrder();
    const { article: template } = await buildToOrder();
    const freightArticle = await makeArticle();
    await db.insert(systemSettings).values({ key: "freight_article_id", value: freightArticle.id });
    const { order, rows } = await createQuote({
      customerId: customer.id,
      rows: [
        { articleId: article.id, quantity: 1 },
        { articleId: article.id, quantity: 1, unitPrice: 199 },
        { articleId: article.id, quantity: 3 },
        { articleId: article.id, quantity: 1 },
        { articleId: template.id, quantity: 1, configuration: { selection: { LOCK: "B", BREDD: 800 } } },
        { articleId: freightArticle.id, quantity: 1, unitPrice: 150 },
      ],
    });
    const [r1, r2, r3, r4, r5, r6] = rows.map((r) => r.id) as [string, string, string, string, string, string];
    await db.update(salesOrderRows).set({ quantityDelivered: "1" }).where(eq(salesOrderRows.id, r3));
    await db.update(salesOrderRows).set({ priceOrigin: "calculated" }).where(eq(salesOrderRows.id, r5));
    await db.update(salesOrderRows).set({ priceOrigin: "calculated" }).where(eq(salesOrderRows.id, r6));
    const [vatCode] = await db.execute<{ id: string }>(sql`select id from vat_codes order by code limit 1`);
    const [invoice] = await db.insert(invoices).values({ customerId: customer.id }).returning();
    await db.insert(invoiceRows).values({
      invoiceId: invoice!.id,
      salesOrderRowId: r4,
      articleId: article.id,
      description: "Diskbänk",
      quantity: "1",
      unitPrice: "250",
      vatCodeId: vatCode!.id,
      vatRate: "25",
      lineAmount: "250",
      vatAmount: "62.5",
    });
    return { order, article, customer, rows: { r1, r2, r3, r4, r5, r6 } };
  }

  it("previews which rows change and how, writing nothing", async () => {
    const { order, rows } = await mixedOrder();
    const before = { rows: await storedRows(order.id), order: await storedOrder(order.id), audits: (await markupAudits()).length };

    const res = await preview(order.id, { generalMarkupPercent: 30 });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({
      changed: true,
      before: { generalMarkupPercent: null, materialMarkupPercent: null },
      after: { generalMarkupPercent: 30, materialMarkupPercent: null },
      currency: "SEK",
      exchangeRate: 1,
      rows: [
        {
          rowId: rows.r1,
          articleId: expect.any(String),
          articleNumber: expect.any(String),
          quantity: 1,
          before: { unitPrice: 250, discountPercent: 0, priceOrigin: "calculated" },
          after: { unitPrice: 270, discountPercent: 0, source: "calculated", priceOrigin: "calculated" },
          calculatedPrice: true,
        },
      ],
      kept: [
        { rowId: rows.r2, articleNumber: expect.any(String), reason: "manual" },
        { rowId: rows.r3, articleNumber: expect.any(String), reason: "delivered" },
        { rowId: rows.r4, articleNumber: expect.any(String), reason: "invoiced" },
        { rowId: rows.r5, articleNumber: expect.any(String), reason: "manual" },
        { rowId: rows.r6, articleNumber: expect.any(String), reason: "manual" },
      ],
    });
    // Omitted = the order's current value; unchanged markups preview nothing.
    expect((await preview(order.id, {})).json()).toMatchObject({ changed: false, rows: [], kept: [] });

    expect({ rows: await storedRows(order.id), order: await storedOrder(order.id), audits: (await markupAudits()).length }).toEqual(before);
  });

  it("asks for the confirmation, then reprices only the Kalkylpris rows that are neither delivered nor invoiced — and logs it", async () => {
    const { order, rows } = await mixedOrder();
    const before = await storedRows(order.id);
    const revision = (await storedOrder(order.id)).revision;

    const unconfirmed = await patchHeader(order.id, { generalMarkupPercent: 30, customerReference: "Anna" });
    expect([unconfirmed.statusCode, unconfirmed.json().code]).toEqual([409, "markup-repricing-not-confirmed"]);
    expect(unconfirmed.json().repricing).toMatchObject({ changed: true, rows: [{ rowId: rows.r1, after: { unitPrice: 270 } }] });
    // Nothing written — not even the other field.
    expect(await storedRows(order.id)).toEqual(before);
    expect(await storedOrder(order.id)).toMatchObject({ generalMarkupPercent: null, revision });
    expect((await call(admin, "GET", `/sales-orders/${order.id}`)).json().customerReference).toBeNull();

    const saved = await patchHeader(order.id, { generalMarkupPercent: 30, customerReference: "Anna", confirmRepricing: true });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json()).toMatchObject({ generalMarkupPercent: "30.00", customerReference: "Anna" });
    expect(saved.json().repricing.rows.map((r: { rowId: string }) => r.rowId)).toEqual([rows.r1]);
    expect(saved.json().repricing.kept.map((k: { reason: string }) => k.reason)).toEqual(["manual", "delivered", "invoiced", "manual", "manual"]);

    const after = await storedRows(order.id);
    expect(after[0]).toMatchObject({ unitPrice: "270.0000", discountPercent: "0.00", priceOrigin: "calculated" });
    // Handwritten, delivered, invoiced, configured and freight rows: untouched.
    expect(after.slice(1)).toEqual(before.slice(1));
    // One content change, one revision.
    expect((await storedOrder(order.id)).revision).toBe(revision + 1);

    const audits = await markupAudits();
    expect(audits).toEqual([
      {
        entityType: "sales_order",
        entityId: order.orderNumber,
        detail: {
          before: { generalMarkupPercent: null, materialMarkupPercent: null },
          after: { generalMarkupPercent: 30, materialMarkupPercent: null },
          rows: [
            {
              rowId: rows.r1,
              articleNumber: expect.any(String),
              before: { unitPrice: 250, discountPercent: 0, priceOrigin: "calculated" },
              after: { unitPrice: 270, discountPercent: 0, source: "calculated", priceOrigin: "calculated" },
            },
          ],
          kept: 5,
        },
      },
    ]);
  });

  it("reprices nothing when the markups do not actually change — a newer förkalkyl alone never moves a price", async () => {
    const { article, customer } = await calculatedOrder();
    const { order } = await createQuote({ customerId: customer.id, rows: [{ articleId: article.id, quantity: 1 }] });
    expect((await patchHeader(order.id, { generalMarkupPercent: 30, confirmRepricing: true })).statusCode).toBe(200);
    await saveCalculation(article.id, { calculatedAt: new Date(Date.now() + 60_000), salesPrice: "16100" });
    const revision = (await storedOrder(order.id)).revision;

    // The card sends both fields on every save, without confirming.
    const same = await patchHeader(order.id, { generalMarkupPercent: 30, materialMarkupPercent: null, customerReference: "B" });
    expect(same.statusCode, same.body).toBe(200);
    expect(same.json().repricing).toMatchObject({ changed: false, rows: [], kept: [] });
    expect((await storedRows(order.id))[0]).toMatchObject({ unitPrice: "270.0000" });
    expect((await storedOrder(order.id)).revision).toBe(revision + 1);
    expect(await markupAudits()).toHaveLength(1);
  });

  it("takes the chain's new answer: cleared order markups on a customer without its own give the article's price, and the row stays chain", async () => {
    const { article, customer } = await calculatedOrder({});
    const { order } = await createQuote({ customerId: customer.id, rows: [{ articleId: article.id, quantity: 1, unitPrice: 300 }] });
    await patchHeader(order.id, { generalMarkupPercent: 20 });
    const row = await addRow(order.id, { articleId: article.id, quantity: 2 });
    expect(row).toMatchObject({ unitPrice: "250.0000", calculatedPrice: true });

    const previewed = (await preview(order.id, { generalMarkupPercent: null })).json();
    expect(previewed.rows).toEqual([
      expect.objectContaining({
        rowId: row.id,
        before: { unitPrice: 250, discountPercent: 0, priceOrigin: "calculated" },
        after: { unitPrice: 300, discountPercent: 0, source: "article", priceOrigin: "chain" },
        calculatedPrice: false,
      }),
    ]);
    expect((await patchHeader(order.id, { generalMarkupPercent: null, confirmRepricing: true })).statusCode).toBe(200);
    expect((await storedRows(order.id))[1]).toMatchObject({ unitPrice: "300.0000", priceOrigin: "chain" });
  });

  it("prices in the order's currency at its rate — the new one when the same save changes it; a new rate alone reprices nothing", async () => {
    const { article, customer } = await calculatedOrder();
    const { order, rows } = await createQuote({ customerId: customer.id, currency: "EUR", exchangeRate: 11.5, rows: [{ articleId: article.id, quantity: 1 }] });
    expect(Number(rows[0]!.unitPrice)).toBe(fromSek(250, 11.5));

    const saved = await patchHeader(order.id, { generalMarkupPercent: 30, confirmRepricing: true });
    expect(saved.json().repricing).toMatchObject({ currency: "EUR", exchangeRate: 11.5, rows: [{ after: { unitPrice: fromSek(270, 11.5) } }] });
    expect(Number((await storedRows(order.id))[0]!.unitPrice)).toBe(fromSek(270, 11.5));

    const withRate = await patchHeader(order.id, { generalMarkupPercent: 40, exchangeRate: 12, confirmRepricing: true });
    expect(withRate.statusCode, withRate.body).toBe(200);
    expect(Number((await storedRows(order.id))[0]!.unitPrice)).toBe(fromSek(290, 12));

    expect((await patchHeader(order.id, { exchangeRate: 11 })).statusCode).toBe(200);
    expect(Number((await storedRows(order.id))[0]!.unitPrice)).toBe(fromSek(290, 12));
  });
});

describe("låsordningen — rad → order", () => {
  it("a row PATCH holding its row lock does not deadlock the header's repricing: the header waits for the row, then plans again", async () => {
    const { article, customer } = await calculatedOrder();
    const { order, rows } = await createQuote({ customerId: customer.id, rows: [{ articleId: article.id, quantity: 1 }] });
    const rowId = rows[0]!.id;
    const revision = (await storedOrder(order.id)).revision;

    // A row PATCH's transaction (updateRow): the row FOR UPDATE first …
    const holding = gate();
    const goOn = gate();
    const rowEdit = db.transaction(async (tx) => {
      await tx.select({ id: salesOrderRows.id }).from(salesOrderRows).where(eq(salesOrderRows.id, rowId)).for("update");
      holding.open();
      await goOn.promise;
      // … then the order: the markups FOR KEY SHARE and the revision bump.
      await tx
        .select({ id: salesOrders.id })
        .from(salesOrders)
        .where(eq(salesOrders.id, order.id))
        .for("key share");
      await tx.update(salesOrderRows).set({ quantityOrdered: "3" }).where(eq(salesOrderRows.id, rowId));
      await tx.update(salesOrders).set({ revision: sql`${salesOrders.revision} + 1` }).where(eq(salesOrders.id, order.id));
    });
    rowEdit.catch(() => holding.open());
    await holding.promise;
    try {
      // The header PATCH plans, then locks the row — and waits for it.
      const header = patchHeader(order.id, { generalMarkupPercent: 30, confirmRepricing: true });
      await waitForLockWaiter();
      goOn.open();
      // Had the header taken the order first, the row edit's order lock
      // would wait for it (a deadlock, 40P01 after deadlock_timeout).
      const edit = await Promise.race([rowEdit.then(() => "committed" as const), sleep(5000).then(() => "waited" as const)]);
      expect(edit).toBe("committed");
      const res = await header;
      expect(res.statusCode, res.body).toBe(200);
      // Planned again with the committed quantity: 3 × Kalkylpris 270.
      expect(res.json().repricing.rows).toEqual([expect.objectContaining({ rowId, quantity: 3, after: expect.objectContaining({ unitPrice: 270 }) })]);
      expect((await storedRows(order.id))[0]).toMatchObject({ quantityOrdered: "3.0000", unitPrice: "270.0000", priceOrigin: "calculated" });
      expect((await storedOrder(order.id)).revision).toBe(revision + 2);
    } finally {
      goOn.open();
    }
  });

  it("a row priced by the chain with the old markups is refused when a header save changed them meanwhile", async () => {
    const { article, customer } = await calculatedOrder();
    const { order, rows } = await createQuote({ customerId: customer.id, rows: [{ articleId: article.id, quantity: 1, unitPrice: 199 }] });

    // A header save in flight: its row locks (none here), the order FOR UPDATE and the new markups.
    const holding = gate();
    const commit = gate();
    const headerSave = db.transaction(async (tx) => {
      await tx.select({ id: salesOrders.id }).from(salesOrders).where(eq(salesOrders.id, order.id)).for("update");
      await tx.update(salesOrders).set({ generalMarkupPercent: "30" }).where(eq(salesOrders.id, order.id));
      holding.open();
      await commit.promise;
    });
    headerSave.catch(() => holding.open());
    await holding.promise;
    try {
      // Priced with the customer's 20 % (the order's markups as read: none) …
      const added = call(admin, "POST", `/sales-orders/${order.id}/rows`, { articleId: article.id, quantity: 1 });
      const edited = call(admin, "PATCH", `/sales-orders/${order.id}/rows/${rows[0]!.id}`, { quantity: 2 });
      await waitForLockWaiters(2);
      commit.open();
      await headerSave;
      // … and refused once they read the new ones under their locks.
      for (const res of await Promise.all([added, edited])) {
        expect([res.statusCode, res.json().code]).toEqual([409, "sales-order-markups-changed"]);
      }
      expect(await storedRows(order.id)).toEqual([expect.objectContaining({ unitPrice: "199.0000", quantityOrdered: "1.0000" })]);
    } finally {
      commit.open();
    }
  });

  it("re-checks the plan under the locks: a row changed, a candidate not planned or other markups ⇒ stale, nothing written", async () => {
    const { article, customer } = await calculatedOrder();
    const { order } = await createQuote({ customerId: customer.id, rows: [{ articleId: article.id, quantity: 1 }, { articleId: article.id, quantity: 2 }] });
    const [first, second] = await storedRows(order.id);
    const planOf = (row: typeof first, unitPrice = row!.unitPrice): PlannedRowReprice => ({
      articleId: article.id,
      quantityOrdered: row!.quantityOrdered,
      unitFactor: row!.unitFactor,
      unitPrice,
      discountPercent: row!.discountPercent,
      priceOrigin: row!.priceOrigin,
      after: { unitPrice: 270, discountPercent: 0, priceOrigin: "calculated" },
    });
    const expected = { currency: "SEK", exchangeRate: "1.000000", generalMarkupPercent: null, materialMarkupPercent: null };
    const attempt = (reprice: Map<string, PlannedRowReprice>, exp = expected) =>
      salesRepository.updateSalesOrderHeaderWithAddress(order.id, { generalMarkupPercent: 30 }, { expected: exp, reprice });

    expect(await attempt(new Map([[first!.id, planOf(first)]]))).toEqual({ ok: false, reason: "stale" });
    expect(await attempt(new Map([[first!.id, planOf(first)], [second!.id, planOf(second, "251.0000")]]))).toEqual({ ok: false, reason: "stale" });
    expect(
      await attempt(new Map([[first!.id, planOf(first)], [second!.id, planOf(second)]]), { ...expected, generalMarkupPercent: "10.00" })
    ).toEqual({ ok: false, reason: "stale" });
    expect(await storedOrder(order.id)).toMatchObject({ generalMarkupPercent: null });
    expect((await storedRows(order.id)).map((r) => r.unitPrice)).toEqual(["250.0000", "250.0000"]);

    const ok = await attempt(new Map([[first!.id, planOf(first)], [second!.id, planOf(second)]]));
    expect(ok).toMatchObject({ ok: true, repriced: [first!.id, second!.id].sort(), kept: [] });
  });

  it("concurrent header and row PATCHes never deadlock", async () => {
    const { article, customer } = await calculatedOrder();
    const { order, rows } = await createQuote({
      customerId: customer.id,
      rows: [{ articleId: article.id, quantity: 1 }, { articleId: article.id, quantity: 1 }],
    });
    for (let i = 0; i < 8; i++) {
      const results = await Promise.all([
        patchHeader(order.id, { generalMarkupPercent: i % 2 === 0 ? 30 : 20, confirmRepricing: true }),
        call(admin, "PATCH", `/sales-orders/${order.id}/rows/${rows[i % 2]!.id}`, { quantity: i + 2 }),
        call(admin, "PATCH", `/sales-orders/${order.id}/rows/${rows[(i + 1) % 2]!.id}`, { quantity: i + 3, unitPrice: 260 }),
      ]);
      for (const res of results) {
        expect([200, 409], res.body).toContain(res.statusCode);
        if (res.statusCode === 409) expect(["sales-order-markups-changed", "markup-repricing-conflict"]).toContain(res.json().code);
      }
    }
  });
});

describe("behörighet", () => {
  it("Försäljning sets the order's markups; Artiklar alone cannot; a read-only account previews but cannot save", async () => {
    const { article, customer } = await calculatedOrder();
    const { order } = await createQuote({ customerId: customer.id, rows: [{ articleId: article.id, quantity: 1 }] });

    const articlesOnly = await userCookie(["artiklar"]);
    expect((await call(articlesOnly, "GET", `/sales-orders/${order.id}`)).json()).toHaveProperty("customerMarkups");
    expect((await preview(order.id, { generalMarkupPercent: 30 }, articlesOnly)).statusCode).toBe(403);
    expect((await patchHeader(order.id, { generalMarkupPercent: 30, confirmRepricing: true }, articlesOnly)).statusCode).toBe(403);

    const readOnly = await userCookie(["forsaljning"], true);
    const previewed = await preview(order.id, { generalMarkupPercent: 30 }, readOnly);
    expect([previewed.statusCode, previewed.json().rows.length]).toEqual([200, 1]);
    const refused = await patchHeader(order.id, { generalMarkupPercent: 30, confirmRepricing: true }, readOnly);
    expect([refused.statusCode, refused.json().code]).toEqual([403, "read-only-account"]);

    const seller = await userCookie(["forsaljning"]);
    expect((await patchHeader(order.id, { generalMarkupPercent: 30, confirmRepricing: true }, seller)).statusCode).toBe(200);
    expect((await storedRows(order.id))[0]).toMatchObject({ unitPrice: "270.0000" });
  });

  it("follows the header's status guard: a cancelled order neither previews nor saves; an unknown one is a 404", async () => {
    const { article, customer } = await calculatedOrder();
    const { order } = await createQuote({ customerId: customer.id, rows: [{ articleId: article.id, quantity: 1 }] });
    await db.update(salesOrders).set({ status: "cancelled" }).where(eq(salesOrders.id, order.id));
    expect((await preview(order.id, { generalMarkupPercent: 30 })).json().code).toBe("invalid-status-transition");
    expect((await patchHeader(order.id, { generalMarkupPercent: 30, confirmRepricing: true })).statusCode).toBe(409);
    expect((await preview(crypto.randomUUID(), { generalMarkupPercent: 30 })).statusCode).toBe(404);
  });
});

describe("offert till order och det externa API:t", () => {
  async function client() {
    const { user } = await adminSession();
    const { client, clientSecret } = await oauthService.createApiClient({ name: "Hemsidan", scopes: [...API_CLIENT_SCOPES] }, user.id);
    const token = await app.inject({ method: "POST", url: "/api/v1/oauth/token", payload: { clientId: client.id, clientSecret } });
    return { authorization: `Bearer ${(token.json() as { accessToken: string }).accessToken}` };
  }

  it("a quote that is confirmed keeps its markups and its prices — the same row — and its new rows get them", async () => {
    const { article, customer } = await calculatedOrder({});
    const { order } = await createQuote({ customerId: customer.id, rows: [{ articleId: article.id, quantity: 1, unitPrice: 300 }] });
    await patchHeader(order.id, { generalMarkupPercent: 20 });
    const row = await addRow(order.id, { articleId: article.id, quantity: 1 });

    const confirmed = await call(admin, "POST", `/sales-orders/${order.id}/confirm`);
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    expect(confirmed.json()).toMatchObject({ status: "confirmed", generalMarkupPercent: "20.00", materialMarkupPercent: null });
    expect((await storedRows(order.id)).find((r) => r.id === row.id)).toMatchObject({ unitPrice: "250.0000", priceOrigin: "calculated" });
    expect(await addRow(order.id, { articleId: article.id, quantity: 1 })).toMatchObject({ unitPrice: "250.0000", calculatedPrice: true });
  });

  it("a client never sets the order's markups and never reads them back", async () => {
    const { article, customer } = await calculatedOrder();
    const headers = await client();
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/quotes",
      headers,
      payload: { customerId: customer.id, generalMarkupPercent: 0, rows: [{ articleId: article.id, quantity: 1 }] },
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json().order).not.toHaveProperty("generalMarkupPercent");
    expect(created.json().order).not.toHaveProperty("materialMarkupPercent");
    expect(created.json().rows[0]).toMatchObject({ unitPrice: "250.0000" });
    const orderId = created.json().order.id as string;
    expect(await storedOrder(orderId)).toMatchObject({ generalMarkupPercent: null, materialMarkupPercent: null });

    // A seller gives the quote markups; the client's confirmation does not show them.
    await patchHeader(orderId, { generalMarkupPercent: 30, confirmRepricing: true });
    const confirmed = await app.inject({ method: "POST", url: `/api/v1/sales-orders/${orderId}/confirm`, headers });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    expect(confirmed.json()).toMatchObject({ status: "confirmed" });
    expect(confirmed.json()).not.toHaveProperty("generalMarkupPercent");
    expect(confirmed.json()).not.toHaveProperty("materialMarkupPercent");
  });
});

// The review of etapp 3 (2026-11-07): the row's price origin (0197) instead
// of 0195's calculated_price boolean — manual (an à-pris or a rabatt written
// by hand), chain (the price chain, any step) or calculated (its Kalkylpris)
// — on every write path, the repricing of the chain rows, and the smaller
// findings (the preview's rate, the kept reasons under the locks, the
// beställningsvara's 409) and the test gaps.
describe("granskningen av etapp 3 — prisets ursprung", () => {
  const patchRow = (orderId: string, rowId: string, body: Record<string, unknown>) =>
    call(admin, "PATCH", `/sales-orders/${orderId}/rows/${rowId}`, body);
  const planned = (row: Awaited<ReturnType<typeof storedRows>>[number], articleId: string): PlannedRowReprice => ({
    articleId,
    quantityOrdered: row.quantityOrdered,
    unitFactor: row.unitFactor,
    unitPrice: row.unitPrice,
    discountPercent: row.discountPercent,
    priceOrigin: row.priceOrigin,
    after: { unitPrice: 270, discountPercent: 0, priceOrigin: "calculated" },
  });
  async function invoiceRowFor(invoiceId: string, salesOrderRowId: string, articleId: string) {
    const [vatCode] = await db.execute<{ id: string }>(sql`select id from vat_codes order by code limit 1`);
    await db.insert(invoiceRows).values({
      invoiceId,
      salesOrderRowId,
      articleId,
      description: "Diskbänk",
      quantity: "1",
      unitPrice: "250",
      vatCodeId: vatCode!.id,
      vatRate: "25",
      lineAmount: "250",
      vatAmount: "62.5",
    });
  }

  // Finding 1: the card's Ändra resends price and quantity with the new
  // rabatt; only the price was compared, so the row stayed calculated and the
  // next markup change wrote the chain's rabatt 0 over it.
  it("a rabatt written on Ändra with the same price and quantity makes the row handwritten — a markup change never zeroes it", async () => {
    const { article, customer } = await calculatedOrder();
    const { order, rows } = await createQuote({
      customerId: customer.id,
      rows: [{ articleId: article.id, quantity: 1 }, { articleId: article.id, quantity: 1 }],
    });
    const [discounted, resent] = rows as [Row, Row];
    expect(rows.map((r) => r.priceOrigin)).toEqual(["calculated", "calculated"]);

    const res = await patchRow(order.id, discounted.id, { quantity: 1, unitPrice: 250, discountPercent: 10 });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().row).toMatchObject({ unitPrice: "250.0000", discountPercent: "10.00", priceOrigin: "manual", calculatedPrice: false });
    // The same values resent keep the origin — manual here, calculated on the other row.
    expect((await patchRow(order.id, discounted.id, { quantity: 1, unitPrice: 250, discountPercent: 10 })).json().row).toMatchObject({
      priceOrigin: "manual",
    });
    expect((await patchRow(order.id, resent.id, { quantity: 1, unitPrice: 250, discountPercent: 0 })).json().row).toMatchObject({
      priceOrigin: "calculated",
    });

    const saved = await patchHeader(order.id, { generalMarkupPercent: 30, confirmRepricing: true });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().repricing.rows.map((r: { rowId: string }) => r.rowId)).toEqual([resent.id]);
    expect(saved.json().repricing.kept).toEqual([{ rowId: discounted.id, articleNumber: article.articleNumber, reason: "manual" }]);
    expect(await storedRows(order.id)).toEqual([
      expect.objectContaining({ id: discounted.id, unitPrice: "250.0000", discountPercent: "10.00", priceOrigin: "manual" }),
      expect.objectContaining({ id: resent.id, unitPrice: "270.0000", discountPercent: "0.00", priceOrigin: "calculated" }),
    ]);
  });

  it("sets the origin on every write path: POST /quotes, Lägg till rad, Ändra, Ändra konfiguration and offert till order", async () => {
    const { article, customer } = await calculatedOrder(); // the customer's 20 % / 0 % ⇒ Kalkylpris 250
    const uncalculated = await makeArticle({ salesPrice: 100 });
    const { article: toOrder } = await buildToOrder();
    const { template } = await buildVariants();
    const beställningsvara = { articleId: toOrder.id, quantity: 1, configuration: { selection: { LOCK: "B", BREDD: 800 } } };
    const { order, rows } = await createQuote({
      customerId: customer.id,
      rows: [
        { articleId: article.id, quantity: 1 }, // the Kalkylpris
        { articleId: uncalculated.id, quantity: 1 }, // no förkalkyl: the article's price
        { articleId: article.id, quantity: 1, unitPrice: 250 }, // an à-pris — even the chain's figure
        { articleId: article.id, quantity: 1, discountPercent: 0 }, // a rabatt — even the chain's 0
        beställningsvara, // priced by its template
        { articleId: template.id, quantity: 1, configuration: { selection: { LOCK: "A", BREDD: 900 } } }, // a variant: the template's chain
      ],
    });
    expect(rows.map((r) => [r.priceOrigin, r.calculatedPrice])).toEqual([
      ["calculated", true],
      ["chain", false],
      ["manual", false],
      ["manual", false],
      ["manual", false],
      ["chain", false],
    ]);
    const [calculatedRow, chainRow, , , configuredRow, variantRow] = rows as [Row, Row, Row, Row, Row, Row];

    // Lägg till rad: the same rules.
    const add = async (payload: Record<string, unknown>) => (await addRow(order.id, payload)).priceOrigin;
    expect(await add({ articleId: article.id, quantity: 1 })).toBe("calculated");
    expect(await add({ articleId: uncalculated.id, quantity: 1 })).toBe("chain");
    expect(await add({ articleId: article.id, quantity: 1, unitPrice: 199 })).toBe("manual");
    expect(await add({ articleId: article.id, quantity: 1, discountPercent: 5 })).toBe("manual");
    expect(await add(beställningsvara)).toBe("manual");

    // Ändra: the same values keep the origin, a changed à-pris or rabatt is
    // handwritten, a new quantity with the à-pris omitted is the chain's
    // answer (with a rabatt sent along: handwritten).
    const edit = async (rowId: string, body: Record<string, unknown>) => {
      const res = await patchRow(order.id, rowId, body);
      expect(res.statusCode, res.body).toBe(200);
      return [res.json().row.unitPrice, res.json().row.priceOrigin];
    };
    expect(await edit(chainRow.id, { quantity: 1, unitPrice: 100, discountPercent: 0 })).toEqual(["100.0000", "chain"]);
    expect(await edit(chainRow.id, { discountPercent: 0 })).toEqual(["100.0000", "chain"]);
    expect(await edit(chainRow.id, { quantity: 2 })).toEqual(["100.0000", "chain"]);
    expect(await edit(chainRow.id, { quantity: 2, unitPrice: 90 })).toEqual(["90.0000", "manual"]);
    expect(await edit(chainRow.id, { quantity: 2, unitPrice: 90, discountPercent: 0 })).toEqual(["90.0000", "manual"]);
    expect(await edit(chainRow.id, { quantity: 3 })).toEqual(["100.0000", "chain"]);
    expect(await edit(chainRow.id, { discountPercent: 5 })).toEqual(["100.0000", "manual"]);
    expect(await edit(chainRow.id, { quantity: 4 })).toEqual(["100.0000", "chain"]);
    expect(await edit(chainRow.id, { quantity: 5, discountPercent: 5 })).toEqual(["100.0000", "manual"]);
    expect(await edit(calculatedRow.id, { quantity: 2 })).toEqual(["250.0000", "calculated"]);
    // A beställningsvara's new quantity is priced by its template: still manual.
    expect(await edit(configuredRow.id, { quantity: 2 })).toEqual(["1050.0000", "manual"]);

    // Ändra konfiguration: the beställningsvara stays manual, the variant row takes the chain's origin.
    const reconfigure = async (rowId: string, selection: Record<string, unknown>) => {
      const res = await call(admin, "PUT", `/sales-orders/${order.id}/rows/${rowId}/configuration`, { selection });
      expect(res.statusCode, res.body).toBe(200);
      return res.json().row.priceOrigin;
    };
    await db.update(salesOrderRows).set({ priceOrigin: "chain" }).where(eq(salesOrderRows.id, configuredRow.id));
    expect(await reconfigure(configuredRow.id, { LOCK: "A", BREDD: 800 })).toBe("manual");
    await db.update(salesOrderRows).set({ unitPrice: "1", priceOrigin: "manual" }).where(eq(salesOrderRows.id, variantRow.id));
    expect(await reconfigure(variantRow.id, { LOCK: "B", BREDD: 900 })).toBe("chain");

    // Offert till order: the same rows, so the origins stand.
    const before = (await storedRows(order.id)).map((r) => [r.id, r.priceOrigin]);
    expect((await call(admin, "POST", `/sales-orders/${order.id}/confirm`)).statusCode).toBe(200);
    expect((await storedRows(order.id)).map((r) => [r.id, r.priceOrigin])).toEqual(before);
    // GET rows carries both the origin and the derived tag.
    const listed = (await call(admin, "GET", `/sales-orders/${order.id}/rows`)).json() as { priceOrigin: string; calculatedPrice: boolean }[];
    expect(listed.every((r) => r.calculatedPrice === (r.priceOrigin === "calculated"))).toBe(true);
  });

  it("an article-price row gets the Kalkylpris when the order gets a markup, setting a cleared markup again undoes the clearing, and a price-list row keeps its price", async () => {
    const article = await makeArticle({ salesPrice: 300 });
    await saveCalculation(article.id);
    const listed = await makeArticle({ salesPrice: 300 });
    await saveCalculation(listed.id);
    const [list] = await db.insert(priceLists).values({ code: "PL-OM", name: "Lista OM" }).returning();
    await db.insert(priceListRows).values({ priceListId: list!.id, articleId: listed.id, fromQuantity: "1", unitPrice: "260" });
    // No markup anywhere yet: the rows get the article's price and the price list's.
    const customer = await makeCustomer();
    await db.update(customers).set({ priceListId: list!.id }).where(eq(customers.id, customer.id));
    const { order, rows } = await createQuote({
      customerId: customer.id,
      rows: [
        { articleId: article.id, quantity: 1 },
        { articleId: listed.id, quantity: 1 },
        { articleId: article.id, quantity: 1, unitPrice: 300 },
      ],
    });
    const [plain, fromList, handwritten] = rows as [Row, Row, Row];
    expect(rows.map((r) => [r.unitPrice, r.priceOrigin])).toEqual([
      ["300.0000", "chain"],
      ["260.0000", "chain"],
      ["300.0000", "manual"],
    ]);

    const previewed = (await preview(order.id, { generalMarkupPercent: 20 })).json();
    expect(previewed.rows).toEqual([
      expect.objectContaining({
        rowId: plain.id,
        before: { unitPrice: 300, discountPercent: 0, priceOrigin: "chain" },
        after: { unitPrice: 250, discountPercent: 0, source: "calculated", priceOrigin: "calculated" },
        calculatedPrice: true,
      }),
    ]);
    expect(previewed.kept).toEqual([
      { rowId: fromList.id, articleNumber: listed.articleNumber, reason: "unchanged" },
      { rowId: handwritten.id, articleNumber: article.articleNumber, reason: "manual" },
    ]);

    const markup = async (generalMarkupPercent: number | null) => {
      const res = await patchHeader(order.id, { generalMarkupPercent, confirmRepricing: true });
      expect(res.statusCode, res.body).toBe(200);
      return (await storedRows(order.id)).map((r) => [r.unitPrice, r.priceOrigin]);
    };
    const withMarkup = [
      ["250.0000", "calculated"],
      ["260.0000", "chain"],
      ["300.0000", "manual"],
    ];
    expect(await markup(20)).toEqual(withMarkup);
    // Cleared by mistake: the article's price again — and the row still follows the markups …
    expect(await markup(null)).toEqual([
      ["300.0000", "chain"],
      ["260.0000", "chain"],
      ["300.0000", "manual"],
    ]);
    // … so setting the markup again undoes the clearing.
    expect(await markup(20)).toEqual(withMarkup);
  });

  // Finding 3: the PATCH plans with the rate of the same save; the preview did not take it.
  it("previews with the rate the same save gives the order, under the header's rules", async () => {
    const { article, customer } = await calculatedOrder();
    const { order } = await createQuote({ customerId: customer.id, currency: "EUR", exchangeRate: 11.5, rows: [{ articleId: article.id, quantity: 1 }] });

    const withRate = await preview(order.id, { generalMarkupPercent: 30, exchangeRate: 12 });
    expect(withRate.statusCode, withRate.body).toBe(200);
    expect(withRate.json()).toMatchObject({
      exchangeRate: 12,
      rows: [{ before: { unitPrice: fromSek(250, 11.5) }, after: { unitPrice: fromSek(270, 12) } }],
    });
    expect((await preview(order.id, { generalMarkupPercent: 30 })).json()).toMatchObject({
      exchangeRate: 11.5,
      rows: [{ after: { unitPrice: fromSek(270, 11.5) } }],
    });
    expect((await storedOrder(order.id)).exchangeRate).toBe("11.500000");
    const saved = await patchHeader(order.id, { generalMarkupPercent: 30, exchangeRate: 12, confirmRepricing: true });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().repricing.rows).toEqual(withRate.json().rows);

    // SEK only at 1; the rate only as a quote or a confirmed order.
    const sek = await createQuote({ customerId: customer.id, rows: [{ articleId: article.id, quantity: 1 }] });
    const refused = await preview(sek.order.id, { generalMarkupPercent: 30, exchangeRate: 2 });
    expect([refused.statusCode, refused.json().code]).toEqual([400, "sales-order-exchange-rate"]);
    expect((await preview(sek.order.id, { generalMarkupPercent: 30, exchangeRate: 1 })).statusCode).toBe(200);
    await db.update(salesOrders).set({ status: "in_production" }).where(eq(salesOrders.id, order.id));
    expect((await preview(order.id, { generalMarkupPercent: 40, exchangeRate: 13 })).json().code).toBe("invalid-status-transition");
    expect((await preview(order.id, { generalMarkupPercent: 40 })).statusCode).toBe(200);
  });

  // Finding 5: a planned row the lock no longer selects was reported as
  // "delivered" whatever had happened to it.
  it("says why each planned row kept its price when it left the candidates before the locks: deleted, handwritten, delivered or invoiced", async () => {
    const { article, customer } = await calculatedOrder();
    const { order, rows } = await createQuote({
      customerId: customer.id,
      rows: Array.from({ length: 5 }, () => ({ articleId: article.id, quantity: 1 })),
    });
    // The header locks the candidates in id order: the first one is held while the others change.
    const [first, deleted, manual, delivered, invoiced] = rows.map((r) => r.id).sort() as [string, string, string, string, string];
    const holding = gate();
    const goOn = gate();
    const writer = db.transaction(async (tx) => {
      await tx.select({ id: salesOrderRows.id }).from(salesOrderRows).where(eq(salesOrderRows.id, first)).for("update");
      holding.open();
      await goOn.promise;
      await tx.delete(salesOrderRows).where(eq(salesOrderRows.id, deleted));
      await tx.update(salesOrderRows).set({ unitPrice: "199", priceOrigin: "manual" }).where(eq(salesOrderRows.id, manual));
      await tx.update(salesOrderRows).set({ quantityDelivered: "1" }).where(eq(salesOrderRows.id, delivered));
    });
    writer.catch(() => holding.open());
    await holding.promise;
    const [draft] = await db.insert(invoices).values({ customerId: customer.id }).returning();
    try {
      // Planned with all five, then waits for the first row.
      const header = patchHeader(order.id, { generalMarkupPercent: 30, confirmRepricing: true });
      await waitForLockWaiter();
      await invoiceRowFor(draft!.id, invoiced, article.id);
      goOn.open();
      await writer;
      const res = await header;
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().repricing.rows.map((r: { rowId: string }) => r.rowId)).toEqual([first]);
      const reasons = Object.fromEntries(
        (res.json().repricing.kept as { rowId: string; reason: string }[]).map((k) => [k.rowId, k.reason])
      );
      expect(reasons).toEqual({ [deleted]: "deleted", [manual]: "manual", [delivered]: "delivered", [invoiced]: "invoiced" });
      expect((await markupAudits())[0]!.detail).toMatchObject({ kept: 4 });
      expect(Object.fromEntries((await storedRows(order.id)).map((r) => [r.id, r.unitPrice]))).toEqual({
        [first]: "270.0000",
        [manual]: "199.0000",
        [delivered]: "250.0000",
        [invoiced]: "250.0000",
      });
    } finally {
      goOn.open();
    }
  });

  // Test gap: the candidates re-read under the order's lock.
  it("re-reads the candidates under the order's lock: a row that became one after the row locks makes the plan stale", async () => {
    const { article, customer } = await calculatedOrder();
    const { order } = await createQuote({ customerId: customer.id, rows: [{ articleId: article.id, quantity: 1 }] });
    const [row] = await storedRows(order.id);
    const expected = { currency: "SEK", exchangeRate: "1.000000", generalMarkupPercent: null, materialMarkupPercent: null };
    // Another writer holds the order and adds a Kalkylpris row before it commits.
    const holding = gate();
    const commit = gate();
    const writer = db.transaction(async (tx) => {
      await tx.select({ id: salesOrders.id }).from(salesOrders).where(eq(salesOrders.id, order.id)).for("no key update");
      holding.open();
      await commit.promise;
      await tx
        .insert(salesOrderRows)
        .values({ salesOrderId: order.id, articleId: article.id, quantityOrdered: "1", unitPrice: "250", priceOrigin: "calculated" });
    });
    writer.catch(() => holding.open());
    await holding.promise;
    try {
      // The plan's row is locked, then the order's lock waits for the writer.
      const attempt = salesRepository.updateSalesOrderHeaderWithAddress(
        order.id,
        { generalMarkupPercent: 30 },
        { expected, reprice: new Map([[row!.id, planned(row!, article.id)]]) }
      );
      await waitForLockWaiter();
      commit.open();
      await writer;
      expect(await attempt).toEqual({ ok: false, reason: "stale" });
    } finally {
      commit.open();
    }
    expect(await storedOrder(order.id)).toMatchObject({ generalMarkupPercent: null });
    expect((await storedRows(order.id)).map((r) => r.unitPrice)).toEqual(["250.0000", "250.0000"]);
    // Planned again, the save takes both.
    const saved = await patchHeader(order.id, { generalMarkupPercent: 30, confirmRepricing: true });
    expect(saved.json().repricing.rows).toHaveLength(2);
  });

  // Test gap: the currency and the rate re-read under the order's lock.
  it("re-reads the currency and the rate under the order's lock: another than planned ⇒ stale, nothing written", async () => {
    const { article, customer } = await calculatedOrder();
    const { order } = await createQuote({ customerId: customer.id, currency: "EUR", exchangeRate: 11.5, rows: [{ articleId: article.id, quantity: 1 }] });
    const [row] = await storedRows(order.id);
    const attempt = () =>
      salesRepository.updateSalesOrderHeaderWithAddress(
        order.id,
        { generalMarkupPercent: 30 },
        {
          expected: { currency: "EUR", exchangeRate: "11.500000", generalMarkupPercent: null, materialMarkupPercent: null },
          reprice: new Map([[row!.id, planned(row!, article.id)]]),
        }
      );
    await db.update(salesOrders).set({ exchangeRate: "12" }).where(eq(salesOrders.id, order.id));
    expect(await attempt()).toEqual({ ok: false, reason: "stale" });
    await db.update(salesOrders).set({ currency: "NOK", exchangeRate: "11.5" }).where(eq(salesOrders.id, order.id));
    expect(await attempt()).toEqual({ ok: false, reason: "stale" });
    expect(await storedOrder(order.id)).toMatchObject({ generalMarkupPercent: null });
    expect((await storedRows(order.id))[0]!.unitPrice).toBe(row!.unitPrice);
    await db.update(salesOrders).set({ currency: "EUR" }).where(eq(salesOrders.id, order.id));
    expect(await attempt()).toMatchObject({ ok: true, repriced: [row!.id], kept: [] });
  });

  // Test gap + finding 6: Ändra konfiguration's markups re-check, and no 409
  // for a beställningsvara, whose template chain never reads the markups.
  it("refuses Ändra konfiguration on a variant row priced with the old markups, but adds a beställningsvara meanwhile", async () => {
    const { template } = await buildVariants();
    const { article: toOrder } = await buildToOrder();
    const customer = await makeCustomer();
    const { order, rows } = await createQuote({
      customerId: customer.id,
      rows: [{ articleId: template.id, quantity: 1, configuration: { selection: { LOCK: "A", BREDD: 900 } } }],
    });
    expect(rows[0]).toMatchObject({ unitPrice: "1000.0000", priceOrigin: "chain" });

    // A header save in flight: the order FOR UPDATE and the new markups.
    const holding = gate();
    const commit = gate();
    const headerSave = db.transaction(async (tx) => {
      await tx.select({ id: salesOrders.id }).from(salesOrders).where(eq(salesOrders.id, order.id)).for("update");
      await tx.update(salesOrders).set({ generalMarkupPercent: "30" }).where(eq(salesOrders.id, order.id));
      holding.open();
      await commit.promise;
    });
    headerSave.catch(() => holding.open());
    await holding.promise;
    try {
      const reconfigured = call(admin, "PUT", `/sales-orders/${order.id}/rows/${rows[0]!.id}/configuration`, {
        selection: { LOCK: "B", BREDD: 900 },
      });
      const added = call(admin, "POST", `/sales-orders/${order.id}/rows`, {
        articleId: toOrder.id,
        quantity: 1,
        configuration: { selection: { LOCK: "A", BREDD: 800 } },
      });
      await waitForLockWaiters(2);
      commit.open();
      await headerSave;
      const [reconfiguredRes, addedRes] = await Promise.all([reconfigured, added]);
      expect([reconfiguredRes.statusCode, reconfiguredRes.json().code]).toEqual([409, "sales-order-markups-changed"]);
      expect(addedRes.statusCode, addedRes.body).toBe(201);
      expect(addedRes.json()).toMatchObject({ unitPrice: "1000.0000", priceOrigin: "manual" });
    } finally {
      commit.open();
    }
    expect((await storedRows(order.id))[0]).toMatchObject({ id: rows[0]!.id, unitPrice: "1000.0000" });
  });

  // Test gap: deliverBatch locks its rows in id order before the loop.
  it("Utleverans locks its rows in id order, so it never waits crosswise with the header's id-ordered row locks", async () => {
    const { article, customer } = await calculatedOrder();
    const { order, rows } = await createQuote({
      customerId: customer.id,
      confirm: true,
      rows: [{ articleId: article.id, quantity: 1 }, { articleId: article.id, quantity: 1 }],
    });
    expect((await call(admin, "POST", `/sales-orders/${order.id}/start-production`)).statusCode).toBe(200);
    const [low, high] = rows.map((r) => r.id).sort() as [string, string];

    // The header's repricing: the candidate rows FOR UPDATE in id order — low, then high.
    const holding = gate();
    const goOn = gate();
    const header = db.transaction(async (tx) => {
      await tx.select({ id: salesOrderRows.id }).from(salesOrderRows).where(eq(salesOrderRows.id, low)).for("update");
      holding.open();
      await goOn.promise;
      await tx.select({ id: salesOrderRows.id }).from(salesOrderRows).where(eq(salesOrderRows.id, high)).for("update");
    });
    header.catch(() => holding.open());
    await holding.promise;
    try {
      // The delivery names its rows high first.
      const delivery = call(admin, "POST", `/sales-orders/${order.id}/deliver`, {
        rows: [
          { rowId: high, quantity: 1 },
          { rowId: low, quantity: 1 },
        ],
      });
      await waitForLockWaiter();
      goOn.open();
      // Had the delivery taken `high` before waiting for `low`, the header's
      // second lock would deadlock with it (40P01 after deadlock_timeout).
      const outcome = await Promise.race([header.then(() => "locked" as const), sleep(5000).then(() => "waited" as const)]);
      expect(outcome).toBe("locked");
      const res = await delivery;
      expect(res.statusCode, res.body).toBe(201);
    } finally {
      goOn.open();
    }
  });

  // Test gap: a credit note counts as invoiced, a cancelled invoice does not.
  it("keeps a row on a credit note and reprices one on a cancelled invoice", async () => {
    const { article, customer } = await calculatedOrder();
    const { order, rows } = await createQuote({
      customerId: customer.id,
      rows: [{ articleId: article.id, quantity: 1 }, { articleId: article.id, quantity: 1 }],
    });
    const [onCancelled, onCredit] = rows as [Row, Row];
    const [cancelled] = await db.insert(invoices).values({ customerId: customer.id, status: "cancelled" }).returning();
    const [credit] = await db.insert(invoices).values({ customerId: customer.id, type: "credit" }).returning();
    await invoiceRowFor(cancelled!.id, onCancelled.id, article.id);
    await invoiceRowFor(credit!.id, onCredit.id, article.id);

    const res = await patchHeader(order.id, { generalMarkupPercent: 30, confirmRepricing: true });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().repricing.rows.map((r: { rowId: string }) => r.rowId)).toEqual([onCancelled.id]);
    expect(res.json().repricing.kept).toEqual([{ rowId: onCredit.id, articleNumber: article.articleNumber, reason: "invoiced" }]);
    expect((await storedRows(order.id)).map((r) => r.unitPrice)).toEqual(["270.0000", "250.0000"]);
  });
});

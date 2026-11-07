import { API_CLIENT_SCOPES, fromSek } from "@navet/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  articles,
  auditLog,
  costCalculations,
  customerPrices,
  customers,
  db,
  permissionGroups,
  priceListRows,
  priceLists,
  salesOrderRows,
  systemSettings,
} from "@navet/db";
import { buildApp } from "../src/app.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createAuthService } from "../src/modules/auth/service/auth.service.js";
import { createOAuthRepository } from "../src/modules/oauth/repository/oauth.repository.js";
import { createOAuthService } from "../src/modules/oauth/service/oauth.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { resetConfigurator } from "./helpers/configurator.js";
import { buildToOrder, buildVariants, configurator } from "./helpers/configured-rows.js";
import { testArticleService } from "./helpers/services.js";

// Påslag per kund och Kalkylpris (#16 etapp 2) through the real app: the
// customer's two price markups, the price chain's Kalkylpris step (after the
// price list, before the article's price, never with the customer discount),
// the rows' calculated_price flag, the configurator's rows and the OAuth API.
//
// The förkalkyl is the spec's example (påhittad): 50 st, SVK 10 000
// (dM 5 000 + MO 1 000 + dL 3 000 + Affo 1 000), base B = dM + MO = 6 000,
// TO 500, g₀ 40 % ⇒ 4 000, m₀ 10 % ⇒ 600, F₀ = 15 100 (302 kr/st).
// A customer with g = 20 % and m = 0 %: P = 15 100 − 2 000 − 600 = 12 500,
// i.e. 250 kr/st; TB/st = 250 − 200.

const authService = createAuthService(createAuthRepository(db), "unused", createAuditRepository(db));
const oauthService = createOAuthService(createOAuthRepository(db), "unused");
const PASSWORD = "correcthorsebattery";
const TRUNCATE = sql`TRUNCATE audit_log, cost_calculations, customer_prices, price_list_rows, price_lists, invoice_rows, invoices, sales_order_rows, sales_orders, customers, api_clients, article_groups, user_settings, users CASCADE`;
// Only this file's groups — never TRUNCATE permission_groups (the seeded ones).
const DELETE_GROUPS = sql`DELETE FROM permission_groups WHERE code LIKE 'PKU%'`;
const SETTING_KEYS = ["costing_general_markup_percent", "costing_material_markup_percent", "setup_charge_article_id"];
const DELETE_SETTINGS = sql`DELETE FROM system_settings WHERE key IN ('costing_general_markup_percent', 'costing_material_markup_percent', 'setup_charge_article_id')`;

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
    .values({ code: `PKU${crypto.randomUUID().slice(0, 6)}`, name: "Påslag", permissions })
    .returning();
  const email = `pku-${crypto.randomUUID()}@example.com`;
  await authService.createUser({ email, password: PASSWORD, name: "Användare", role: "user", permissionGroupId: group!.id, readOnly });
  return login(email);
}

type Method = "GET" | "POST" | "PATCH" | "PUT";
const call = (cookie: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url: `/api/v1${url}`, headers: { cookie }, ...(payload === undefined ? {} : { payload: payload as never }) });

async function setSetting(key: (typeof SETTING_KEYS)[number], value: string) {
  await db.insert(systemSettings).values({ key, value }).onConflictDoUpdate({ target: systemSettings.key, set: { value } });
}

async function makeArticle(opts: { salesPrice?: number; groupId?: string } = {}) {
  const article = await testArticleService.createArticle({
    articleNumber: `KP-${crypto.randomUUID().slice(0, 8)}`,
    name: "Diskbänk",
    type: "manufactured",
    unit: "st",
    active: true,
    ...(opts.groupId ? { groupId: opts.groupId } : {}),
  });
  if (opts.salesPrice !== undefined) await db.update(articles).set({ salesPrice: String(opts.salesPrice) }).where(eq(articles.id, article.id));
  return article;
}

// A saved förkalkyl written as the header columns (the spec's example unless
// overridden). Every bucket is explicit so SVK and F₀ are known exactly.
async function saveCalculation(articleId: string, overrides: Partial<typeof costCalculations.$inferInsert> = {}) {
  const [row] = await db
    .insert(costCalculations)
    .values({
      articleId,
      type: "pre",
      quantity: "50",
      materialCost: "5000",
      materialOverhead: "1000",
      laborCost: "3000",
      overhead: "500",
      businessOverhead: "1000",
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
  return res.json() as { id: string; generalMarkupPercent: string | null; materialMarkupPercent: string | null };
}

const priceQuote = (cookie: string, q: Record<string, string | number>) =>
  call(cookie, "GET", `/price-quote?${new URLSearchParams(Object.entries(q).map(([k, v]) => [k, String(v)])).toString()}`);

async function createQuote(payload: Record<string, unknown>) {
  const res = await call(admin, "POST", "/quotes", payload);
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { order: { id: string }; rows: { id: string; unitPrice: string; discountPercent: string; calculatedPrice: boolean }[] };
}

const storedRows = (orderId: string) =>
  db
    .select({ id: salesOrderRows.id, unitPrice: salesOrderRows.unitPrice, calculatedPrice: salesOrderRows.calculatedPrice })
    .from(salesOrderRows)
    .where(eq(salesOrderRows.salesOrderId, orderId))
    .orderBy(salesOrderRows.createdAt, salesOrderRows.id);

describe("kundens påslag — /customers", () => {
  it("creates, updates and reads the two fields: null inherits, 0 is 0 %, omitted leaves them; audited only when they change", async () => {
    const created = await makeCustomer({ generalMarkupPercent: 20 });
    expect(created).toMatchObject({ generalMarkupPercent: "20.00", materialMarkupPercent: null });

    const zeroed = await call(admin, "PATCH", `/customers/${created.id}`, { materialMarkupPercent: 0 });
    expect(zeroed.json()).toMatchObject({ generalMarkupPercent: "20.00", materialMarkupPercent: "0.00" });
    // The card sends both on every save: the same values log nothing.
    await call(admin, "PATCH", `/customers/${created.id}`, { name: "Kund AB", generalMarkupPercent: 20, materialMarkupPercent: 0 });
    const renamed = await call(admin, "PATCH", `/customers/${created.id}`, { name: "Kund AB 2" });
    expect(renamed.json()).toMatchObject({ generalMarkupPercent: "20.00", materialMarkupPercent: "0.00" });
    const cleared = await call(admin, "PATCH", `/customers/${created.id}`, { generalMarkupPercent: null });
    expect(cleared.json()).toMatchObject({ generalMarkupPercent: null, materialMarkupPercent: "0.00" });
    expect((await call(admin, "GET", `/customers/${created.id}`)).json()).toMatchObject({ generalMarkupPercent: null, materialMarkupPercent: "0.00" });
    // A customer without markups writes no audit entry on create.
    const plain = await makeCustomer();

    const entries = await db
      .select({ entityId: auditLog.entityId, detail: auditLog.detail })
      .from(auditLog)
      .where(and(eq(auditLog.entityType, "customer"), eq(auditLog.action, "markups_changed")))
      .orderBy(auditLog.createdAt, auditLog.id);
    expect(entries).toEqual([
      { entityId: created.id, detail: { before: { generalMarkupPercent: null, materialMarkupPercent: null }, after: { generalMarkupPercent: 20, materialMarkupPercent: null } } },
      { entityId: created.id, detail: { before: { generalMarkupPercent: 20, materialMarkupPercent: null }, after: { generalMarkupPercent: 20, materialMarkupPercent: 0 } } },
      { entityId: created.id, detail: { before: { generalMarkupPercent: 20, materialMarkupPercent: 0 }, after: { generalMarkupPercent: null, materialMarkupPercent: 0 } } },
    ]);
    expect(entries.some((e) => e.entityId === plain.id)).toBe(false);
  });

  it("refuses a percentage outside 0–1000 in the API and in the database", async () => {
    for (const generalMarkupPercent of [-1, 1000.01, "20"]) {
      const res = await call(admin, "POST", "/customers", { name: "Kund", generalMarkupPercent });
      expect([generalMarkupPercent, res.statusCode, res.json().code]).toEqual([generalMarkupPercent, 400, "validation-failed"]);
    }
    const ok = await makeCustomer({ materialMarkupPercent: 1000 });
    expect(ok.materialMarkupPercent).toBe("1000.00");
    await expect(db.execute(sql`update customers set general_markup_percent = 1000.01`)).rejects.toThrow();
    await expect(db.execute(sql`update customers set material_markup_percent = -0.01`)).rejects.toThrow();
  });

  it("reads with office and writes with Försäljning, like the rest of the customer card; a read-only account cannot write", async () => {
    const customer = await makeCustomer();
    const articlesOnly = await userCookie(["artiklar"]);
    expect((await call(articlesOnly, "GET", `/customers/${customer.id}`)).statusCode).toBe(200);
    expect((await call(articlesOnly, "PATCH", `/customers/${customer.id}`, { generalMarkupPercent: 30 })).statusCode).toBe(403);

    const readOnly = await userCookie(["forsaljning"], true);
    const refused = await call(readOnly, "PATCH", `/customers/${customer.id}`, { generalMarkupPercent: 30 });
    expect([refused.statusCode, refused.json().code]).toEqual([403, "read-only-account"]);

    const seller = await userCookie(["forsaljning"]);
    const res = await call(seller, "PATCH", `/customers/${customer.id}`, { generalMarkupPercent: 30 });
    expect([res.statusCode, res.json().generalMarkupPercent]).toEqual([200, "30.00"]);
  });
});

describe("Kalkylpris i priskedjan — GET /price-quote", () => {
  it("prices with the customer's markups on the latest förkalkyl, with the level of each markup", async () => {
    const article = await makeArticle({ salesPrice: 300 });
    const calculation = await saveCalculation(article.id);
    const customer = await makeCustomer({ generalMarkupPercent: 20, materialMarkupPercent: 0 });

    const res = await priceQuote(admin, { customerId: customer.id, articleId: article.id, quantity: 5 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      articleNumber: article.articleNumber,
      price: { unitPrice: 250, discountPercent: 0, source: "calculated" },
      calculated: {
        calculationId: calculation.id,
        calculatedAt: calculation.calculatedAt.toISOString(),
        quantity: 50,
        generalMarkup: { percent: 20, level: "customer" },
        materialMarkup: { percent: 0, level: "customer" },
      },
      currency: "SEK",
      exchangeRate: 1,
    });
  });

  it("resolves field by field: an empty customer field inherits the varugrupp's, then the company's", async () => {
    const [group] = await db.execute<{ id: string }>(
      sql`insert into article_groups (code, name, material_markup_percent) values ('77', 'Bänkar', 15) returning id`
    );
    const grouped = await makeArticle({ salesPrice: 300, groupId: group!.id });
    await saveCalculation(grouped.id);
    const plain = await makeArticle({ salesPrice: 300 });
    await saveCalculation(plain.id);
    await setSetting("costing_material_markup_percent", "10");
    const customer = await makeCustomer({ generalMarkupPercent: 20 });

    // 15 100 − 2 000 + 6 000 × (15 − 10) % = 13 400 ⇒ 268.
    const viaGroup = (await priceQuote(admin, { customerId: customer.id, articleId: grouped.id, quantity: 1 })).json();
    expect(viaGroup.price).toEqual({ unitPrice: 268, discountPercent: 0, source: "calculated" });
    expect(viaGroup.calculated).toMatchObject({ generalMarkup: { percent: 20, level: "customer" }, materialMarkup: { percent: 15, level: "group" } });
    // The company's 10 % = the calculation's m₀: only the general markup moves ⇒ 13 100 ⇒ 262.
    const viaCompany = (await priceQuote(admin, { customerId: customer.id, articleId: plain.id, quantity: 1 })).json();
    expect(viaCompany.price).toEqual({ unitPrice: 262, discountPercent: 0, source: "calculated" });
    expect(viaCompany.calculated).toMatchObject({ materialMarkup: { percent: 10, level: "company" } });
  });

  it("changes nothing for a customer without markups of its own — the article's price, no calculation detail", async () => {
    const article = await makeArticle({ salesPrice: 300 });
    await saveCalculation(article.id);
    const customer = await makeCustomer({ discountPercent: 10 });
    const res = (await priceQuote(admin, { customerId: customer.id, articleId: article.id, quantity: 1 })).json();
    expect(res.price).toEqual({ unitPrice: 300, discountPercent: 10, source: "customer_discount" });
    expect(res).not.toHaveProperty("calculated");
    expect(res).not.toHaveProperty("calculatedPriceUnavailable");
  });

  it("lets every agreement go first: the customer's article price, its group rule and the price list", async () => {
    const [group] = await db.execute<{ id: string }>(sql`insert into article_groups (code, name) values ('78', 'Underreden') returning id`);
    const article = await makeArticle({ salesPrice: 300, groupId: group!.id });
    await saveCalculation(article.id);
    const customer = await makeCustomer({ generalMarkupPercent: 20, materialMarkupPercent: 0 });
    const quote = async () => (await priceQuote(admin, { customerId: customer.id, articleId: article.id, quantity: 1 })).json();

    const [list] = await db.insert(priceLists).values({ code: "PL-KP", name: "Lista KP" }).returning();
    await db.update(customers).set({ priceListId: list!.id }).where(eq(customers.id, customer.id));
    await db.insert(priceListRows).values({ priceListId: list!.id, articleId: article.id, fromQuantity: "1", unitPrice: "280" });
    expect((await quote()).price).toEqual({ unitPrice: 280, discountPercent: 0, source: "price_list" });

    // A discount-form group rule takes the list/article price as its base, never the Kalkylpris.
    await db.insert(customerPrices).values({ customerId: customer.id, articleGroupId: group!.id, fromQuantity: "1", discountPercent: "5" });
    expect((await quote()).price).toEqual({ unitPrice: 280, discountPercent: 5, source: "customer_group" });

    await db.insert(customerPrices).values({ customerId: customer.id, articleId: article.id, fromQuantity: "1", unitPrice: "275" });
    const agreed = await quote();
    expect(agreed.price).toEqual({ unitPrice: 275, discountPercent: 0, source: "customer_article" });
    expect(agreed).not.toHaveProperty("calculated");
  });

  it("puts no customer discount on the Kalkylpris; without a förkalkyl the article's price gets it, with the reason", async () => {
    const article = await makeArticle({ salesPrice: 300 });
    await saveCalculation(article.id);
    const uncalculated = await makeArticle({ salesPrice: 300 });
    const unpriced = await makeArticle();
    const customer = await makeCustomer({ generalMarkupPercent: 20, materialMarkupPercent: 0, discountPercent: 10 });

    const calculated = (await priceQuote(admin, { customerId: customer.id, articleId: article.id, quantity: 1 })).json();
    expect(calculated.price).toEqual({ unitPrice: 250, discountPercent: 0, source: "calculated" });

    const fallback = (await priceQuote(admin, { customerId: customer.id, articleId: uncalculated.id, quantity: 1 })).json();
    expect(fallback.price).toEqual({ unitPrice: 300, discountPercent: 10, source: "customer_discount" });
    expect(fallback.calculatedPriceUnavailable).toBe("no-calculation");
    expect(fallback).not.toHaveProperty("calculated");

    const nothing = (await priceQuote(admin, { customerId: customer.id, articleId: unpriced.id, quantity: 1 })).json();
    expect(nothing).toMatchObject({ price: null, calculatedPriceUnavailable: "no-calculation" });
    // A row without à-pris on such an article has no price at all.
    const refused = await call(admin, "POST", "/quotes", { customerId: customer.id, rows: [{ articleId: unpriced.id, quantity: 1 }] });
    expect([refused.statusCode, refused.json().code]).toEqual([400, "price-not-found"]);
  });

  it("needs the base only when the material markup moves (a multi-level calculation from before 0194)", async () => {
    const article = await makeArticle({ salesPrice: 300 });
    await saveCalculation(article.id, { multiLevel: true, semiFinishedCost: "0", materialMarkupBase: null });
    const movesMaterial = await makeCustomer({ generalMarkupPercent: 20, materialMarkupPercent: 0 });
    const keepsMaterial = await makeCustomer({ generalMarkupPercent: 20, materialMarkupPercent: 10 });

    const missing = (await priceQuote(admin, { customerId: movesMaterial.id, articleId: article.id, quantity: 1 })).json();
    expect(missing.price).toEqual({ unitPrice: 300, discountPercent: 0, source: "article" });
    expect(missing.calculatedPriceUnavailable).toBe("material-base-missing");
    // m = m₀: the base is not needed — 15 100 − 2 000 ⇒ 262.
    const ok = (await priceQuote(admin, { customerId: keepsMaterial.id, articleId: article.id, quantity: 1 })).json();
    expect(ok.price).toEqual({ unitPrice: 262, discountPercent: 0, source: "calculated" });
  });

  it("is exact against the latest calculation's own percentages — a trial included — and equals Sätt försäljningspris with them", async () => {
    const article = await makeArticle({ salesPrice: 300 });
    // An older calculation never counts.
    await saveCalculation(article.id, { calculatedAt: new Date("2026-01-01T08:00:00Z") });
    // Odd figures: SVK = 312.1111 + 31.2111 + 401.0007 + 0.5 + 156.4122 = 901.2351, B = 343.3222.
    const latest = await saveCalculation(article.id, {
      calculatedAt: new Date("2026-11-01T08:00:00Z"),
      quantity: "7",
      materialCost: "312.1111",
      materialOverhead: "31.2111",
      laborCost: "401.0007",
      subcontractCost: "0.5",
      businessOverhead: "156.4122",
      overhead: "12.3456",
      generalMarkupPercent: "33.33",
      generalMarkup: "300.3846",
      materialMarkupPercent: "7.77",
      materialMarkup: "26.6761",
      salesPrice: "1240.6414",
      materialMarkupBase: "343.3222",
      generalMarkupLevel: "trial",
    });
    const same = await makeCustomer({ generalMarkupPercent: 33.33, materialMarkupPercent: 7.77 });
    const other = await makeCustomer({ generalMarkupPercent: 12.5, materialMarkupPercent: 0 });

    const sameQuote = (await priceQuote(admin, { customerId: same.id, articleId: article.id, quantity: 1 })).json();
    expect(sameQuote.calculated.calculationId).toBe(latest.id);
    const applied = await call(admin, "POST", `/cost-calculations/${latest.id}/apply-sales-price`);
    expect(applied.statusCode).toBe(200);
    expect(sameQuote.price.unitPrice).toBe(Number(applied.json().article.salesPrice)); // round4(1240.6414 / 7) = 177.2345
    expect(sameQuote.price.unitPrice).toBe(177.2345);

    // P = F₀ + SVK × (12.5 − 33.33)% + B × (0 − 7.77)%.
    const expected = Math.round(((1240.6414 + (901.2351 * (12.5 - 33.33)) / 100 + (343.3222 * (0 - 7.77)) / 100) / 7) * 10000) / 10000;
    const otherQuote = (await priceQuote(admin, { customerId: other.id, articleId: article.id, quantity: 1 })).json();
    expect(otherQuote.price.unitPrice).toBe(expected);
    expect(otherQuote.price.unitPrice).toBe(146.6054);
  });

  it("is in SEK converted with the order's rate (fromSek), like the article's price", async () => {
    const article = await makeArticle({ salesPrice: 300 });
    await saveCalculation(article.id);
    const customer = await makeCustomer({ generalMarkupPercent: 20, materialMarkupPercent: 0 });

    const inEur = (await priceQuote(admin, { customerId: customer.id, articleId: article.id, quantity: 1, currency: "EUR", exchangeRate: 11.5 })).json();
    expect(inEur).toMatchObject({ price: { unitPrice: fromSek(250, 11.5), discountPercent: 0, source: "calculated" }, currency: "EUR", exchangeRate: 11.5 });
    expect(inEur.price.unitPrice).toBe(21.74);

    // On an order in EUR the row is priced in the order's currency; the preview with salesOrderId agrees.
    const { order, rows } = await createQuote({ customerId: customer.id, currency: "EUR", exchangeRate: 11.5, rows: [{ articleId: article.id, quantity: 2 }] });
    expect([Number(rows[0]!.unitPrice), rows[0]!.calculatedPrice]).toEqual([21.74, true]);
    const onOrder = (await priceQuote(admin, { customerId: customer.id, articleId: article.id, quantity: 2, salesOrderId: order.id })).json();
    expect(onOrder.price.unitPrice).toBe(21.74);
  });
});

describe("calculated_price på orderraden", () => {
  async function setup() {
    const article = await makeArticle({ salesPrice: 300 });
    await saveCalculation(article.id);
    const customer = await makeCustomer({ generalMarkupPercent: 20, materialMarkupPercent: 0 });
    return { article, customer };
  }

  it("is set when the à-pris is omitted and the chain gave the Kalkylpris; an explicit à-pris — even the same — is false", async () => {
    const { article, customer } = await setup();
    // The same article on three rows: two priced by the chain, one by hand.
    const { order, rows } = await createQuote({
      customerId: customer.id,
      rows: [
        { articleId: article.id, quantity: 1 },
        { articleId: article.id, quantity: 4 },
        { articleId: article.id, quantity: 1, unitPrice: 250 },
      ],
    });
    expect(rows.map((r) => [Number(r.unitPrice), Number(r.discountPercent), r.calculatedPrice])).toEqual([
      [250, 0, true],
      [250, 0, true],
      [250, 0, false],
    ]);
    // A row added later: a second row on the article, priced the same way.
    const added = await call(admin, "POST", `/sales-orders/${order.id}/rows`, { articleId: article.id, quantity: 2 });
    expect(added.statusCode).toBe(201);
    expect(added.json()).toMatchObject({ unitPrice: "250.0000", calculatedPrice: true });
    const handwritten = await call(admin, "POST", `/sales-orders/${order.id}/rows`, { articleId: article.id, quantity: 2, unitPrice: 199 });
    expect(handwritten.json()).toMatchObject({ unitPrice: "199.0000", calculatedPrice: false });

    // listRows: the flag and the TB basis, which is the calculation's SVK/st on every row (TB/st 250 − 200).
    const listed = (await call(admin, "GET", `/sales-orders/${order.id}/rows`)).json() as { calculatedPrice: boolean; selfCostPerUnit: number }[];
    expect(listed.map((r) => r.calculatedPrice)).toEqual([true, true, false, true, false]);
    expect(new Set(listed.map((r) => r.selfCostPerUnit))).toEqual(new Set([200]));
  });

  it("on Ändra: the same à-pris keeps it, another clears it, a quantity change without à-pris takes the chain's answer", async () => {
    const { article, customer } = await setup();
    const { order, rows } = await createQuote({ customerId: customer.id, rows: [{ articleId: article.id, quantity: 1 }, { articleId: article.id, quantity: 1 }] });
    const [first, second] = rows as [(typeof rows)[number], (typeof rows)[number]];
    const patch = (rowId: string, body: Record<string, unknown>) => call(admin, "PATCH", `/sales-orders/${order.id}/rows/${rowId}`, body);

    // The card sends price and quantity on every save.
    expect((await patch(first.id, { quantity: 1, unitPrice: 250, discountPercent: 0 })).json().row).toMatchObject({ calculatedPrice: true });
    expect((await patch(first.id, { expectedDeliveryDate: "2026-12-01" })).json().row).toMatchObject({ calculatedPrice: true });
    expect((await patch(first.id, { quantity: 3 })).json().row).toMatchObject({ unitPrice: "250.0000", calculatedPrice: true });
    expect((await patch(first.id, { quantity: 3, unitPrice: 240 })).json().row).toMatchObject({ unitPrice: "240.0000", calculatedPrice: false });
    // A handwritten row stays handwritten when its à-pris is resent.
    expect((await patch(first.id, { quantity: 3, unitPrice: 240 })).json().row).toMatchObject({ calculatedPrice: false });
    // A quantity change with the à-pris omitted is the chain's answer again.
    expect((await patch(first.id, { quantity: 5 })).json().row).toMatchObject({ unitPrice: "250.0000", calculatedPrice: true });

    // Once the price list covers the article, the chain's answer is the list — not calculated.
    const [list] = await db.insert(priceLists).values({ code: "PL-KQ", name: "Lista KQ" }).returning();
    await db.update(customers).set({ priceListId: list!.id }).where(eq(customers.id, customer.id));
    await db.insert(priceListRows).values({ priceListId: list!.id, articleId: article.id, fromQuantity: "1", unitPrice: "260" });
    expect((await patch(second.id, { quantity: 2 })).json().row).toMatchObject({ unitPrice: "260.0000", calculatedPrice: false });
    expect((await storedRows(order.id)).map((r) => r.calculatedPrice)).toEqual([true, false]);
  });

  it("gives a Kalkylpris row no Ställkostnad row — the ställpris only comes from a matched customer rule", async () => {
    const { article, customer } = await setup();
    const setupArticle = await makeArticle({ salesPrice: 1 });
    await setSetting("setup_charge_article_id", setupArticle.id);
    const { order, rows } = await createQuote({ customerId: customer.id, rows: [{ articleId: article.id, quantity: 1 }] });
    expect(rows).toHaveLength(1);
    expect(await storedRows(order.id)).toHaveLength(1);
  });
});

describe("konfiguratorn och Kalkylpriset", () => {
  it("a beställningsvara row is priced by its template (base + additions) even with customer markups and a förkalkyl on the template", async () => {
    const { article } = await buildToOrder();
    await saveCalculation(article.id);
    const customer = await makeCustomer({ generalMarkupPercent: 20, materialMarkupPercent: 0 });
    const { rows } = await createQuote({
      customerId: customer.id,
      rows: [{ articleId: article.id, quantity: 1, configuration: { selection: { LOCK: "B", BREDD: 800 } } }],
    });
    // 1 000 + LOCK B 50.
    expect([Number(rows[0]!.unitPrice), rows[0]!.calculatedPrice]).toEqual([1050, false]);
    expect((rows[0] as unknown as { configuration: { price: { source: string } } }).configuration.price.source).toBe("article");
  });

  it("a variant takes the template's chain first; only a variant the template cannot price falls to its own Kalkylpris", async () => {
    const customer = await makeCustomer({ generalMarkupPercent: 20, materialMarkupPercent: 0 });

    // Template with a base price: the variant step wins, never a Kalkylpris.
    const { template } = await buildVariants();
    const { article: variant } = await configurator.resolveVariant(template.id, { LOCK: "B", BREDD: 1200 }, null);
    await saveCalculation(variant.id);
    const viaTemplate = await createQuote({ customerId: customer.id, rows: [{ articleId: template.id, quantity: 1, configuration: { selection: { LOCK: "B", BREDD: 1200 } } }] });
    expect(viaTemplate.rows.map((r) => [Number(r.unitPrice), r.calculatedPrice])).toEqual([[1050, false]]);

    // Template without a base price: the variant's own chain, where the Kalkylpris applies.
    await db.update(articles).set({ salesPrice: null }).where(eq(articles.id, template.id));
    const own = await createQuote({ customerId: customer.id, rows: [{ articleId: template.id, quantity: 1, configuration: { selection: { LOCK: "B", BREDD: 1200 } } }] });
    expect(own.rows.map((r) => [Number(r.unitPrice), r.calculatedPrice])).toEqual([[250, true]]);
    const quote = (await priceQuote(admin, { customerId: customer.id, articleId: variant.id, quantity: 1 })).json();
    expect(quote.price.source).toBe("calculated");

    // Ändra konfiguration replaces the price through the chain and keeps the flag in step with it.
    const reconfigure = async (selection: Record<string, unknown>) => {
      const res = await call(admin, "PUT", `/sales-orders/${own.order.id}/rows/${own.rows[0]!.id}/configuration`, { selection });
      expect(res.statusCode, res.body).toBe(200);
      return res.json().row as { articleId: string; unitPrice: string; calculatedPrice: boolean };
    };
    const { article: other } = await configurator.resolveVariant(template.id, { LOCK: "A", BREDD: 900 }, null);
    await saveCalculation(other.id, { generalMarkupPercent: "30" }); // 15 100 − 1 000 − 600 ⇒ 270
    expect(await reconfigure({ LOCK: "A", BREDD: 900 })).toMatchObject({ articleId: other.id, unitPrice: "270.0000", calculatedPrice: true });
    // With the template's base price back, the template's chain prices the variant again.
    await db.update(articles).set({ salesPrice: "1000" }).where(eq(articles.id, template.id));
    expect(await reconfigure({ LOCK: "B", BREDD: 1200 })).toMatchObject({ articleId: variant.id, unitPrice: "1050.0000", calculatedPrice: false });
  });
});

describe("OAuth — /price-quote och POST /quotes", () => {
  async function client() {
    const { user } = await adminSession();
    const { client, clientSecret } = await oauthService.createApiClient({ name: "Hemsidan", scopes: [...API_CLIENT_SCOPES] }, user.id);
    const token = await app.inject({ method: "POST", url: "/api/v1/oauth/token", payload: { clientId: client.id, clientSecret } });
    expect(token.statusCode).toBe(200);
    return { authorization: `Bearer ${(token.json() as { accessToken: string }).accessToken}` };
  }

  it("gives a client the Kalkylpris but never its basis; a session gets both", async () => {
    const article = await makeArticle({ salesPrice: 300 });
    await saveCalculation(article.id);
    const customer = await makeCustomer({ generalMarkupPercent: 20, materialMarkupPercent: 0 });
    const headers = await client();
    const url = `/api/v1/price-quote?customerId=${customer.id}&articleId=${article.id}&quantity=1`;

    const forClient = await app.inject({ method: "GET", url, headers });
    expect(forClient.statusCode).toBe(200);
    expect(forClient.json()).toEqual({
      articleNumber: article.articleNumber,
      price: { unitPrice: 250, discountPercent: 0, source: "calculated" },
      currency: "SEK",
      exchangeRate: 1,
    });
    expect((await app.inject({ method: "GET", url, headers: { cookie: admin } })).json()).toHaveProperty("calculated.calculationId");

    // A quote without prices: the chain prices the row with the Kalkylpris.
    const created = await app.inject({ method: "POST", url: "/api/v1/quotes", headers, payload: { customerId: customer.id, rows: [{ articleId: article.id, quantity: 1 }] } });
    expect(created.statusCode).toBe(201);
    expect(created.json().rows).toEqual([expect.objectContaining({ unitPrice: "250.0000", discountPercent: "0.00", calculatedPrice: true })]);
    expect(created.json().rows[0]).not.toHaveProperty("configurationCost");
    const stored = await db.select({ calculatedPrice: salesOrderRows.calculatedPrice }).from(salesOrderRows).where(inArray(salesOrderRows.id, [created.json().rows[0].id]));
    expect(stored).toEqual([{ calculatedPrice: true }]);
  });
});

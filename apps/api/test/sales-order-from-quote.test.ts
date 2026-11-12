import { createArticleSchema, salesDocumentKind, salesOrderStatusSchema } from "@navet/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, asc, eq, sql } from "drizzle-orm";
import {
  auditLog,
  customerDeliveryAddresses,
  db,
  numberSeries,
  permissionGroups,
  quoteLossReasons,
  salesOrderRows,
  salesOrders,
} from "@navet/db";
import { buildApp } from "../src/app.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createAuthService } from "../src/modules/auth/service/auth.service.js";
import { createSalesRepository } from "../src/modules/sales/repository/sales.repository.js";
import { documentKindSql } from "../src/modules/sales/repository/document-kind.js";
import { quoteOutcome } from "../src/modules/reports/service/quote-followup.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { addDays, stockholmToday } from "../src/modules/system/service/delivery-days.js";
import { pdfText } from "./helpers/pdf.js";
import { testArticleService } from "./helpers/services.js";
import { parsed } from "./helpers/parsed.js";

// Skapa kundorder från offert through the real app: the quote stays and
// becomes Order (ordered), a NEW order is made as a copy of it — header,
// rows and prices as they are, its own KO- number — and the quote can give
// more orders. Order is a final status for the quote: every transition from
// it is refused. The copy, the numbers, the status flow, the document kind,
// the follow-up (Utgången, Offerter att följa upp, Offertuppföljning), the
// order confirmation's "Vår offert:", the audit trail, the permissions and
// the concurrency (two at once; against Förlorad) — the last two
// deterministically, against a held lock on the quote.

const authService = createAuthService(createAuthRepository(db), "unused", createAuditRepository(db));
const salesRepository = createSalesRepository(db);
const PASSWORD = "correcthorsebattery";
const TRUNCATE = sql`TRUNCATE audit_log, email_log, sales_order_rows, sales_orders, customer_delivery_addresses, customers, quote_loss_reasons, articles, user_settings, users CASCADE`;
// Only this file's groups — never TRUNCATE permission_groups (the seeded ones).
const DELETE_GROUPS = sql`DELETE FROM permission_groups WHERE code LIKE 'KFO%'`;

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
  admin = await adminCookie();
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

async function adminCookie() {
  const email = `admin-${crypto.randomUUID()}@example.com`;
  await authService.createUser({ email, password: PASSWORD, name: "Admin", role: "admin" });
  return login(email);
}

async function userCookie(permissions: string[], readOnly = false) {
  const [group] = await db
    .insert(permissionGroups)
    .values({ code: `KFO${crypto.randomUUID().slice(0, 6)}`, name: "Kundorder från offert", permissions })
    .returning();
  const email = `kfo-${crypto.randomUUID()}@example.com`;
  await authService.createUser({ email, password: PASSWORD, name: "Användare", role: "user", permissionGroupId: group!.id, readOnly });
  return login(email);
}

type Method = "GET" | "POST" | "PATCH" | "DELETE";
const call = (cookie: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url: `/api/v1${url}`, headers: { cookie }, ...(payload === undefined ? {} : { payload: payload as never }) });

async function makeArticle(name = "Diskbänk") {
  return testArticleService.createArticle(
    parsed(createArticleSchema, { articleNumber: `KF-${crypto.randomUUID().slice(0, 8)}`, name, type: "purchased", active: true })
  );
}

async function makeCustomer() {
  const res = await call(admin, "POST", "/customers", { name: "Kund AB" });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string };
}

type Created = { order: { id: string; orderNumber: string; quoteNumber: string | null; status: string }; rows: { id: string }[] };
async function makeQuote(extra: Record<string, unknown> = {}) {
  const customer = await makeCustomer();
  const article = await makeArticle();
  const res = await call(admin, "POST", "/quotes", {
    customerId: customer.id,
    rows: [{ articleId: article.id, quantity: 2, unitPrice: 100 }],
    ...extra,
  });
  expect(res.statusCode, res.body).toBe(201);
  return { customer, article, ...(res.json() as Created) };
}

const createOrder = (quoteId: string, cookie = admin) => call(cookie, "POST", `/sales-orders/${quoteId}/create-order`);

async function createOrderOk(quoteId: string) {
  const res = await createOrder(quoteId);
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string; orderNumber: string };
}

async function header(id: string) {
  const [row] = await db.select().from(salesOrders).where(eq(salesOrders.id, id));
  return row!;
}

// The card's order: created_at, then id (listRowsByOrder).
async function rowsOf(orderId: string) {
  return db
    .select()
    .from(salesOrderRows)
    .where(eq(salesOrderRows.salesOrderId, orderId))
    .orderBy(asc(salesOrderRows.createdAt), asc(salesOrderRows.id));
}

async function audits(entityId: string, action: string) {
  return db.select().from(auditLog).where(and(eq(auditLog.entityId, entityId), eq(auditLog.action, action)));
}

async function makeLossReason() {
  const [reason] = await db.insert(quoteLossReasons).values({ code: "PRIS", name: "Pris" }).returning();
  return reason!;
}

// The sessions waiting on a lock right now (the year-end helper's query,
// with a count: two callers must both be queued before the lock is let go).
async function waitForLockWaiters(n: number, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await db.execute(
      sql`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`
    );
    const [row] = [...result] as { n: number }[];
    if ((row?.n ?? 0) >= n) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Fewer than ${n} transactions started waiting on a lock`);
}

// Holds the quote's row lock (FOR UPDATE) in a transaction of its own until
// `release` is called — the callers started meanwhile all queue behind it.
async function holdQuoteLock(quoteId: string) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let locked!: () => void;
  const isLocked = new Promise<void>((resolve) => (locked = resolve));
  const done = db.transaction(async (tx) => {
    await tx.select({ id: salesOrders.id }).from(salesOrders).where(eq(salesOrders.id, quoteId)).for("update");
    locked();
    await released;
  });
  await isLocked;
  return { release, done };
}

describe("the copy", () => {
  it("makes a confirmed order with its own KO- number, the quote's header and nothing that belongs to the quote", async () => {
    const { order: quote, customer } = await makeQuote({
      customerOrderNumber: "PO-77",
      customerInquiryNumber: "RFQ-5",
      customerReference: "Anna Andersson",
      expectedDeliveryDate: "2031-03-14",
      note: "Leverans till port 3",
      currency: "EUR",
      exchangeRate: 11.25,
    });
    expect(quote.orderNumber).toMatch(/^OF-/);
    // Header fields the create schema does not take: the markups (card
    // only), the freight choice and a revision above 1.
    await db
      .update(salesOrders)
      .set({ generalMarkupPercent: "22.50", materialMarkupPercent: "4.00", freightCarrierPrice: "345.60", revision: 4 })
      .where(eq(salesOrders.id, quote.id));
    const [next] = await db.select().from(numberSeries).where(eq(numberSeries.key, "sales_order"));

    const created = await createOrderOk(quote.id);
    expect(created.orderNumber).toMatch(/^KO-/);
    expect(Object.keys(created).sort()).toEqual(["id", "orderNumber"]);
    expect(created.orderNumber).toBe(`${next!.prefix}${next!.nextNumber}`);

    const before = await header(quote.id);
    const order = await header(created.id);
    expect(order).toMatchObject({
      orderNumber: created.orderNumber,
      quoteNumber: null,
      sourceQuoteId: quote.id,
      status: "confirmed",
      quoted: false,
      quoteValidUntil: null,
      revision: 1,
      customerId: customer.id,
      customerOrderNumber: "PO-77",
      customerInquiryNumber: "RFQ-5",
      customerReference: "Anna Andersson",
      expectedDeliveryDate: "2031-03-14",
      note: "Leverans till port 3",
      currency: "EUR",
      exchangeRate: "11.250000",
      generalMarkupPercent: "22.50",
      materialMarkupPercent: "4.00",
      freightCarrierPrice: "345.60",
      deliveryTermId: before.deliveryTermId,
      paymentTermId: before.paymentTermId,
      lostReasonId: null,
      lostAt: null,
    });
    expect(salesDocumentKind(order)).toBe("order");

    // The quote stays: its OF- number, its Giltig t.o.m. and its revision
    // (a status change never bumps it) — only the status moved.
    expect(before).toMatchObject({
      orderNumber: quote.orderNumber,
      quoteNumber: quote.orderNumber,
      status: "ordered",
      quoted: true,
      revision: 4,
      sourceQuoteId: null,
    });
    expect(before.quoteValidUntil).toBe(addDays(stockholmToday(), 30));
  });

  it("copies the rows in the quote's order with prices, origin, unit, date, configuration, ställkostnad and freight — no price chain", async () => {
    const { order: quote, article } = await makeQuote();
    const setupArticle = await makeArticle("Ställkostnad");
    const freightArticle = await makeArticle("Frakt");
    const configured = await makeArticle("Beställningsvara");
    const [first] = await rowsOf(quote.id);
    // The article's sales price is nowhere near the row's: a chain would move it.
    await db
      .update(salesOrderRows)
      .set({ unitPrice: "123.4567", discountPercent: "7.50", priceOrigin: "calculated", expectedDeliveryDate: "2031-04-01", unitFactor: "2.500000" })
      .where(eq(salesOrderRows.id, first!.id));
    const base = first!.createdAt.getTime();
    const configuration = { templateArticleId: configured.id, selection: { bredd: 1200 }, lines: [{ label: "Bredd", value: "1200" }] };
    const configurationCost = { selfCostPerUnit: 812.5, calculatedAt: "2030-01-02T03:04:05.000Z" };
    // Written in an order the ids do not follow: the ställkostnadsrad right
    // after its article row, then a configured row, then the freight row.
    await db.insert(salesOrderRows).values([
      {
        salesOrderId: quote.id,
        articleId: setupArticle.id,
        quantityOrdered: "1",
        unitPrice: "950",
        setupForRowId: first!.id,
        createdAt: new Date(base + 1),
      },
      {
        salesOrderId: quote.id,
        articleId: configured.id,
        quantityOrdered: "3",
        unitPrice: "4999.5",
        configuration,
        configurationCost,
        createdAt: new Date(base + 2),
      },
      { salesOrderId: quote.id, articleId: freightArticle.id, quantityOrdered: "1", unitPrice: "345.6", createdAt: new Date(base + 3) },
    ]);
    // Something delivered on the quote's row must not follow (it cannot be
    // on a real quote; the copy starts at 0 whatever the source says).
    await db.update(salesOrderRows).set({ quantityDelivered: "1" }).where(eq(salesOrderRows.id, first!.id));

    const created = await createOrderOk(quote.id);
    const source = await rowsOf(quote.id);
    const copy = await rowsOf(created.id);
    expect(copy.map((r) => r.articleId)).toEqual([article.id, setupArticle.id, configured.id, freightArticle.id]);
    expect(copy.map((r) => r.articleId)).toEqual(source.map((r) => r.articleId));
    // New rows, not the quote's.
    expect(copy.some((r) => source.some((s) => s.id === r.id))).toBe(false);
    expect(copy[0]).toMatchObject({
      quantityOrdered: "2.0000",
      quantityDelivered: "0.0000",
      unitPrice: "123.4567",
      discountPercent: "7.50",
      priceOrigin: "calculated",
      expectedDeliveryDate: "2031-04-01",
      unitFactor: "2.500000",
      unitId: source[0]!.unitId,
      setupForRowId: null,
      configuration: null,
    });
    // The ställkostnadsrad points at the COPY of its article row.
    expect(copy[1]).toMatchObject({ unitPrice: "950.0000", setupForRowId: copy[0]!.id, priceOrigin: "manual" });
    expect(copy[2]).toMatchObject({ quantityOrdered: "3.0000", unitPrice: "4999.5000", configuration, configurationCost });
    expect(copy[3]).toMatchObject({ unitPrice: "345.6000", setupForRowId: null });
    // Stamped a millisecond apart, so the order survives every later read.
    const stamps = copy.map((r) => r.createdAt.getTime());
    expect(stamps).toEqual([...stamps].sort((a, b) => a - b));
    expect(new Set(stamps).size).toBe(4);
    // And the API's own row list agrees.
    const listed = (await call(admin, "GET", `/sales-orders/${created.id}/rows`)).json() as { articleId: string }[];
    expect(listed.map((r) => r.articleId)).toEqual(copy.map((r) => r.articleId));
  });

  it("gives the order its own copy of an engångsadress, and points at a saved address", async () => {
    const oneOff = await makeQuote({
      newDeliveryAddress: { label: "Bygget", address: "Grusvägen 1", postalCode: "123 45", city: "Småstad", country: "SE" },
    });
    const quoteAddressId = (await header(oneOff.order.id)).deliveryAddressId!;
    const created = await createOrderOk(oneOff.order.id);
    const orderAddressId = (await header(created.id)).deliveryAddressId!;
    expect(orderAddressId).not.toBe(quoteAddressId);
    const [copy] = await db.select().from(customerDeliveryAddresses).where(eq(customerDeliveryAddresses.id, orderAddressId));
    expect(copy).toMatchObject({
      customerId: oneOff.customer.id,
      label: "Bygget",
      address: "Grusvägen 1",
      postalCode: "123 45",
      city: "Småstad",
      country: "SE",
      oneOff: true,
      isDefault: false,
    });
    // The quote switching away deletes ITS one-off — the order keeps its own.
    const moved = await call(admin, "PATCH", `/sales-orders/${oneOff.order.id}`, { deliveryAddressId: null });
    expect(moved.statusCode, moved.body).toBe(200);
    expect(await db.select().from(customerDeliveryAddresses).where(eq(customerDeliveryAddresses.id, quoteAddressId))).toHaveLength(0);
    expect((await header(created.id)).deliveryAddressId).toBe(orderAddressId);

    const saved = await makeQuote({
      newDeliveryAddress: { label: "Lagret", address: "Hamngatan 2", postalCode: "543 21", city: "Storstad", country: "SE", saveToCustomer: true },
    });
    const savedAddressId = (await header(saved.order.id)).deliveryAddressId!;
    const second = await createOrderOk(saved.order.id);
    expect((await header(second.id)).deliveryAddressId).toBe(savedAddressId);
  });

  it("an order takes over the KO- number a failed order confirmation mail reserved on the quote", async () => {
    const { order: quote } = await makeQuote();
    const reserved = await salesRepository.reserveOrderNumber(quote.id);
    expect(reserved).toMatch(/^KO-/);
    expect((await header(quote.id)).orderNumber).toBe(reserved);
    const created = await createOrderOk(quote.id);
    expect(created.orderNumber).toBe(reserved);
    expect(await header(quote.id)).toMatchObject({ orderNumber: quote.orderNumber, quoteNumber: quote.orderNumber, status: "ordered" });
  });
});

describe("the status flow", () => {
  it("quote → ordered → ordered: two orders, and the second gets the rows the quote has then", async () => {
    const { order: quote } = await makeQuote();
    const first = await createOrderOk(quote.id);
    expect((await header(quote.id)).status).toBe("ordered");

    // Beslut 8: an ordered quote is edited like any quote — header and rows.
    const extra = await makeArticle("Blandare");
    const patched = await call(admin, "PATCH", `/sales-orders/${quote.id}`, {
      customerReference: "Bo Berg",
      quoteValidUntil: "2031-01-31",
      exchangeRate: 1,
    });
    expect(patched.statusCode, patched.body).toBe(200);
    const added = await call(admin, "POST", `/sales-orders/${quote.id}/rows`, { articleId: extra.id, quantity: 5, unitPrice: 40 });
    expect(added.statusCode, added.body).toBe(201);
    const [firstRow] = await rowsOf(quote.id);
    const changed = await call(admin, "PATCH", `/sales-orders/${quote.id}/rows/${firstRow!.id}`, { unitPrice: 111 });
    expect(changed.statusCode, changed.body).toBe(200);
    const removed = await call(admin, "DELETE", `/sales-orders/${quote.id}/rows/${(added.json() as { id: string }).id}`);
    expect(removed.statusCode, removed.body).toBeLessThan(300);
    const readded = await call(admin, "POST", `/sales-orders/${quote.id}/rows`, { articleId: extra.id, quantity: 6, unitPrice: 41 });
    expect(readded.statusCode, readded.body).toBe(201);
    // Still Order, and the quote's documents print.
    expect((await header(quote.id)).status).toBe("ordered");
    const pdf = await call(admin, "GET", `/sales-orders/${quote.id}/pdf?variant=quote`);
    expect(pdf.statusCode).toBe(200);
    expect(pdfText(pdf.rawPayload)).toContain(quote.orderNumber);

    const second = await createOrderOk(quote.id);
    expect(second.orderNumber).not.toBe(first.orderNumber);
    expect((await header(quote.id)).status).toBe("ordered");
    // The first order is what the quote was then; the second what it is now.
    expect((await rowsOf(first.id)).map((r) => [r.quantityOrdered, r.unitPrice])).toEqual([["2.0000", "100.0000"]]);
    expect((await rowsOf(second.id)).map((r) => [r.quantityOrdered, r.unitPrice])).toEqual([
      ["2.0000", "111.0000"],
      ["6.0000", "41.0000"],
    ]);
    expect((await header(second.id)).customerReference).toBe("Bo Berg");
    expect((await header(first.id)).customerReference).toBeNull();

    const card = (await call(admin, "GET", `/sales-orders/${quote.id}`)).json();
    expect(card.documentKind).toBe("quote");
    expect(card.sourceQuote).toBeNull();
    expect(card.ordersFromQuote).toEqual([
      { id: first.id, orderNumber: first.orderNumber, status: "confirmed", createdAt: expect.any(String) },
      { id: second.id, orderNumber: second.orderNumber, status: "confirmed", createdAt: expect.any(String) },
    ]);
    const orderCard = (await call(admin, "GET", `/sales-orders/${second.id}`)).json();
    expect(orderCard.documentKind).toBe("order");
    expect(orderCard.sourceQuote).toEqual({ id: quote.id, quoteNumber: quote.orderNumber });
    expect(orderCard.ordersFromQuote).toEqual([]);
    expect(orderCard).not.toHaveProperty("sourceQuoteNumber");
  });

  it("works on a quote past its Giltig t.o.m.", async () => {
    const { order: quote } = await makeQuote({ quoteValidUntil: addDays(stockholmToday(), -10) });
    await createOrderOk(quote.id);
  });

  it("409 from lost, cancelled and from an order; 404 for an unknown id; nothing is created", async () => {
    const reason = await makeLossReason();
    const lost = await makeQuote();
    expect((await call(admin, "POST", `/sales-orders/${lost.order.id}/lose`, { lossReasonId: reason.id })).statusCode).toBe(200);
    const cancelled = await makeQuote();
    expect((await call(admin, "POST", `/sales-orders/${cancelled.order.id}/cancel`)).statusCode).toBe(200);
    const confirmed = await makeQuote({ confirm: true });
    const quote = await makeQuote();
    const fromQuote = await createOrderOk(quote.order.id);
    const before = await db.select({ id: salesOrders.id }).from(salesOrders);

    for (const id of [lost.order.id, cancelled.order.id, confirmed.order.id, fromQuote.id]) {
      const res = await createOrder(id);
      expect([res.statusCode, res.json().code], id).toEqual([409, "invalid-status-transition"]);
    }
    const unknown = await createOrder(crypto.randomUUID());
    expect([unknown.statusCode, unknown.json().code]).toEqual([404, "sales-order-not-found"]);
    expect((await createOrder("not-a-uuid")).statusCode).toBe(400);
    expect(await db.select({ id: salesOrders.id }).from(salesOrders)).toHaveLength(before.length);

    // A lost quote is reopened first.
    expect((await call(admin, "POST", `/sales-orders/${lost.order.id}/reopen`)).statusCode).toBe(200);
    await createOrderOk(lost.order.id);
  });

  it("Order is final: Förlorad, Makulera, Öppna igen, Bekräfta, the confirmation mail and the manual status are all refused", async () => {
    const reason = await makeLossReason();
    const { order: quote } = await makeQuote();
    await createOrderOk(quote.id);
    const attempts: [string, unknown?][] = [
      [`/sales-orders/${quote.id}/lose`, { lossReasonId: reason.id }],
      [`/sales-orders/${quote.id}/cancel`],
      [`/sales-orders/${quote.id}/reopen`],
      [`/sales-orders/${quote.id}/confirm`],
      [`/sales-orders/${quote.id}/start-production`],
      [`/sales-orders/${quote.id}/send-email`, { variant: "confirmation", to: "kund@example.com", subject: "Order", message: "Hej" }],
      ...salesOrderStatusSchema.options
        .filter((status) => status !== "ordered")
        .map((status): [string, unknown] => [`/sales-orders/${quote.id}/set-status`, { status }]),
    ];
    for (const [url, payload] of attempts) {
      const res = await call(admin, "POST", url, payload);
      expect(res.statusCode, `${url} ${JSON.stringify(payload)}: ${res.body}`).toBe(409);
      // Bekräfta/Makulera/… name the reason; start-production is the old
      // "not confirmed" answer.
      expect(res.json().code, url).toBe(url.endsWith("/start-production") ? "invalid-status-transition" : "quote-already-ordered");
    }
    expect(await header(quote.id)).toMatchObject({ status: "ordered", orderNumber: quote.orderNumber, lostAt: null });
    // No mail went out for the refused confirmation.
    expect((await db.execute(sql`SELECT count(*)::int AS n FROM email_log`))[0]).toMatchObject({ n: 0 });

    // And Order cannot be set by hand on anything.
    const other = await makeQuote();
    const byHand = await call(admin, "POST", `/sales-orders/${other.order.id}/set-status`, { status: "ordered" });
    expect([byHand.statusCode, byHand.json().code]).toEqual([409, "invalid-status-transition"]);
    expect((await header(other.order.id)).status).toBe("quote");
    // The manual status still works where it did.
    const manual = await call(admin, "POST", `/sales-orders/${other.order.id}/set-status`, { status: "delivered" });
    expect(manual.statusCode, manual.body).toBe(200);
    expect(manual.json().status).toBe("delivered");
  });

  it("the repository refuses to leave or enter Order under the row lock, whatever the caller checked", async () => {
    const { order: quote } = await makeQuote();
    await createOrderOk(quote.id);
    expect(await salesRepository.updateStatus(quote.id, "confirmed")).toBeNull();
    expect(await salesRepository.updateStatus(quote.id, "lost")).toBeNull();
    expect(await salesRepository.markLost(quote.id, { reasonId: (await makeLossReason()).id, note: null, userId: null })).toBeNull();
    expect(await salesRepository.reopenLost(quote.id)).toBeNull();
    expect(await salesRepository.reserveOrderNumber(quote.id)).toBeNull();
    const other = await makeQuote();
    expect(await salesRepository.updateStatus(other.order.id, "ordered")).toBeNull();
    expect(await header(quote.id)).toMatchObject({ status: "ordered", orderNumber: quote.orderNumber });
  });

  it("the database refuses an order that points at itself as its quote", async () => {
    const { order: quote } = await makeQuote();
    await expect(db.update(salesOrders).set({ sourceQuoteId: quote.id }).where(eq(salesOrders.id, quote.id))).rejects.toMatchObject({
      cause: expect.objectContaining({ constraint_name: "sales_orders_source_quote_not_self" }),
    });
  });
});

describe("the document kind", () => {
  it("ordered is a quote in shared, in SQL and in the lists", async () => {
    for (const quoteNumber of [null, "OF-1"])
      for (const orderNumber of ["OF-1", "KO-1"])
        expect(salesDocumentKind({ status: "ordered", orderNumber, quoteNumber })).toBe("quote");

    const { order: quote } = await makeQuote();
    const created = await createOrderOk(quote.id);
    // SQL against shared, for every status and number combination.
    const untouched = await makeQuote();
    for (const status of salesOrderStatusSchema.options)
      for (const numbered of ["quote", "order"] as const) {
        await db
          .update(salesOrders)
          .set({ status, orderNumber: numbered === "quote" ? untouched.order.orderNumber : `KO-X${status}`.slice(0, 20) })
          .where(eq(salesOrders.id, untouched.order.id));
        const [row] = await db
          .select({ status: salesOrders.status, orderNumber: salesOrders.orderNumber, quoteNumber: salesOrders.quoteNumber, kind: documentKindSql })
          .from(salesOrders)
          .where(eq(salesOrders.id, untouched.order.id));
        expect(row!.kind, `${status}/${numbered}`).toBe(salesDocumentKind(row!));
      }
    await db.delete(salesOrders).where(eq(salesOrders.id, untouched.order.id));

    type Listed = { rows: { id: string; documentKind: string; status: string }[]; total: number };
    const quotes = (await call(admin, "GET", "/sales-orders?kind=quote")).json() as Listed;
    expect(quotes.rows.map((r) => [r.id, r.documentKind, r.status])).toEqual([[quote.id, "quote", "ordered"]]);
    const orders = (await call(admin, "GET", "/sales-orders?kind=order")).json() as Listed;
    expect(orders.rows.map((r) => [r.id, r.documentKind, r.status])).toEqual([[created.id, "order", "confirmed"]]);
    // The status filter knows the new status; the quote-only one leaves it out.
    const ordered = (await call(admin, "GET", "/sales-orders?kind=quote&status=ordered")).json() as Listed;
    expect(ordered.rows.map((r) => r.id)).toEqual([quote.id]);
    expect(((await call(admin, "GET", "/sales-orders?kind=quote&status=quote")).json() as Listed).total).toBe(0);
    // Sen is an order's filter — never an ordered quote, however old its date.
    await db.update(salesOrders).set({ expectedDeliveryDate: "2020-01-01" }).where(eq(salesOrders.id, quote.id));
    expect(((await call(admin, "GET", "/sales-orders?status=late")).json() as Listed).rows.map((r) => r.id)).not.toContain(quote.id);
    // The CSV names the status.
    const csv = await call(admin, "GET", "/sales-orders/csv?kind=quote");
    expect(csv.statusCode).toBe(200);
    expect(csv.body).toMatch(/Order/);
  });
});

describe("the follow-up", () => {
  it("an ordered quote is never Utgången and never in Offerter att följa upp", async () => {
    const expired = addDays(stockholmToday(), -3);
    const { order: quote } = await makeQuote({ quoteValidUntil: expired });
    const open = await makeQuote({ quoteValidUntil: expired });
    await createOrderOk(quote.id);

    const alerts = (await call(admin, "GET", "/alerts")).json() as { groups: { kind: string; count: number; items: { key: string }[] }[] };
    const group = alerts.groups.find((g) => g.kind === "quote_followup")!;
    expect(group.items.map((i) => i.key)).toEqual([open.order.id]);
    expect(group.count).toBe(1);
  });

  it("Offertuppföljningen counts an ordered quote as won — and not the orders made from it", async () => {
    expect(quoteOutcome("ordered")).toBe("won");
    const expired = addDays(stockholmToday(), -3);
    const { order: quote } = await makeQuote({ quoteValidUntil: expired });
    await createOrderOk(quote.id);
    await createOrderOk(quote.id);
    const open = await makeQuote({ quoteValidUntil: expired });

    const today = stockholmToday();
    const res = await call(admin, "GET", `/reports/quote-followup?from=${today}&to=${today}`);
    expect(res.statusCode, res.body).toBe(200);
    const report = res.json() as {
      quotes: { id: string; outcome: string; expired: boolean; value: number; documentKind: string; status: string }[];
      totals: { count: number; won: number; wonValue: number; open: number; expired: number; hitRateCount: number | null };
    };
    // Two quotes — the two orders (quoted = false) are not rows.
    expect(report.quotes.map((q) => [q.id, q.outcome, q.expired, q.value, q.documentKind, q.status]).sort()).toEqual(
      [
        [quote.id, "won", false, 200, "quote", "ordered"],
        [open.order.id, "open", true, 200, "quote", "quote"],
      ].sort()
    );
    expect(report.totals).toMatchObject({ count: 2, won: 1, wonValue: 200, open: 1, expired: 1, hitRateCount: 1 });
  });
});

describe("the documents and the audit trail", () => {
  it("the order confirmation prints Vår offert from the source quote; the quote keeps its own number", async () => {
    const { order: quote } = await makeQuote();
    const created = await createOrderOk(quote.id);
    const confirmation = await call(admin, "GET", `/sales-orders/${created.id}/pdf?variant=confirmation`);
    expect(confirmation.statusCode).toBe(200);
    const text = pdfText(confirmation.rawPayload);
    expect(text).toContain(created.orderNumber);
    expect(text).toContain(`Vår offert: ${quote.orderNumber}`);

    // A quote confirmed the old way prints its own number, as before.
    const old = await makeQuote();
    const confirmed = await call(admin, "POST", `/sales-orders/${old.order.id}/confirm`);
    expect(confirmed.statusCode).toBe(200);
    const oldText = pdfText((await call(admin, "GET", `/sales-orders/${old.order.id}/pdf?variant=confirmation`)).rawPayload);
    expect(oldText).toContain(`Vår offert: ${old.order.orderNumber}`);
    // Ny kundorder has none.
    const direct = await makeQuote({ confirm: true });
    const directText = pdfText((await call(admin, "GET", `/sales-orders/${direct.order.id}/pdf?variant=confirmation`)).rawPayload);
    expect(directText).not.toContain("Vår offert");
  });

  it("logs order_created on the quote and created_from_quote on the order", async () => {
    const { order: quote } = await makeQuote();
    const created = await createOrderOk(quote.id);
    const onQuote = await audits(quote.orderNumber, "order_created");
    expect(onQuote).toHaveLength(1);
    expect(onQuote[0]).toMatchObject({ entityType: "sales_order", detail: { orderNumber: created.orderNumber, orderId: created.id } });
    expect(onQuote[0]!.userId).not.toBeNull();
    const onOrder = await audits(created.orderNumber, "created_from_quote");
    expect(onOrder).toHaveLength(1);
    expect(onOrder[0]).toMatchObject({ entityType: "sales_order", detail: { quoteNumber: quote.orderNumber, quoteId: quote.id } });
  });
});

describe("permissions", () => {
  it("needs Försäljning to write; a read-only account is refused", async () => {
    const { order: quote } = await makeQuote();
    const purchasing = await userCookie(["inkop"]);
    const denied = await createOrder(quote.id, purchasing);
    expect(denied.statusCode).toBe(403);
    const readOnly = await userCookie(["forsaljning"], true);
    const refused = await createOrder(quote.id, readOnly);
    expect([refused.statusCode, refused.json().code]).toEqual([403, "read-only-account"]);
    expect((await app.inject({ method: "POST", url: `/api/v1/sales-orders/${quote.id}/create-order` })).statusCode).toBe(401);
    expect((await header(quote.id)).status).toBe("quote");

    const sales = await userCookie(["forsaljning"]);
    const ok = await createOrder(quote.id, sales);
    expect(ok.statusCode, ok.body).toBe(201);
    // The card's new fields are readable with the module's read rule.
    const card = await call(purchasing, "GET", `/sales-orders/${quote.id}`);
    expect(card.statusCode).toBe(200);
    expect(card.json().ordersFromQuote).toHaveLength(1);
  });
});

describe("concurrency", () => {
  it("two Skapa kundorder at once give two orders with two KO- numbers, and the quote is Order", async () => {
    const { order: quote } = await makeQuote();
    const held = await holdQuoteLock(quote.id);
    const a = createOrder(quote.id);
    const b = createOrder(quote.id);
    // Both are queued on the quote's row before either may run.
    await waitForLockWaiters(2);
    held.release();
    await held.done;
    const [first, second] = await Promise.all([a, b]);
    expect([first.statusCode, second.statusCode], `${first.body} ${second.body}`).toEqual([201, 201]);
    const numbers = [first.json().orderNumber, second.json().orderNumber] as string[];
    expect(new Set(numbers).size).toBe(2);
    for (const n of numbers) expect(n).toMatch(/^KO-/);
    expect(await header(quote.id)).toMatchObject({ status: "ordered", orderNumber: quote.orderNumber });
    const made = await db.select().from(salesOrders).where(eq(salesOrders.sourceQuoteId, quote.id));
    expect(made.map((o) => o.orderNumber).sort()).toEqual([...numbers].sort());
    for (const order of made) expect(await rowsOf(order.id)).toHaveLength(1);
    expect(await audits(quote.orderNumber, "order_created")).toHaveLength(2);
  });

  it("Skapa kundorder against a concurrent Förlorad: exactly one wins", async () => {
    const reason = await makeLossReason();
    const { order: quote } = await makeQuote();
    const held = await holdQuoteLock(quote.id);
    const lose = call(admin, "POST", `/sales-orders/${quote.id}/lose`, { lossReasonId: reason.id });
    const create = createOrder(quote.id);
    await waitForLockWaiters(2);
    held.release();
    await held.done;
    const [lost, created] = await Promise.all([lose, create]);
    const winners = [lost.statusCode === 200, created.statusCode === 201].filter(Boolean);
    expect(winners, `${lost.statusCode} ${created.statusCode}`).toHaveLength(1);
    const after = await header(quote.id);
    const orders = await db.select().from(salesOrders).where(eq(salesOrders.sourceQuoteId, quote.id));
    if (created.statusCode === 201) {
      expect(lost.statusCode).toBe(409);
      expect(after).toMatchObject({ status: "ordered", lostReasonId: null, lostAt: null });
      expect(orders).toHaveLength(1);
    } else {
      expect(created.statusCode).toBe(409);
      expect(after.status).toBe("lost");
      expect(orders).toHaveLength(0);
    }
  });

  it("a Förlorad that committed first refuses the order, and an order that committed first refuses Förlorad", async () => {
    const reason = await makeLossReason();
    // Förlorad holds the row (its UPDATE is in flight); the order waits and then sees lost.
    const a = await makeQuote();
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let marked!: () => void;
    const isMarked = new Promise<void>((resolve) => (marked = resolve));
    const losing = db.transaction(async (tx) => {
      await tx.update(salesOrders).set({ status: "lost", lostAt: new Date() }).where(and(eq(salesOrders.id, a.order.id), eq(salesOrders.status, "quote")));
      marked();
      await released;
    });
    await isMarked;
    const waiting = createOrder(a.order.id);
    await waitForLockWaiters(1);
    release();
    await losing;
    const refused = await waiting;
    expect([refused.statusCode, refused.json().code]).toEqual([409, "invalid-status-transition"]);
    expect(await db.select().from(salesOrders).where(eq(salesOrders.sourceQuoteId, a.order.id))).toHaveLength(0);

    // The order's transaction holds the row; markLost's conditional UPDATE
    // waits, re-reads the status and matches nothing.
    const b = await makeQuote();
    const held = await holdQuoteLock(b.order.id);
    const create = createOrder(b.order.id);
    await waitForLockWaiters(1);
    // Queued behind the create (row locks are granted in order).
    const lose = salesRepository.markLost(b.order.id, { reasonId: reason.id, note: null, userId: null });
    await waitForLockWaiters(2);
    held.release();
    await held.done;
    expect((await create).statusCode).toBe(201);
    expect(await lose).toBeNull();
    expect((await header(b.order.id)).status).toBe("ordered");
  });
});

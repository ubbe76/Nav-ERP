import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { customers, db, permissionGroups, quoteLossReasons, salesOrderRows, salesOrders } from "@navet/db";
import type { QuoteFollowupReport } from "@navet/shared";
import { buildApp } from "../src/app.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createAuthService } from "../src/modules/auth/service/auth.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { createQuoteFollowupRepository, QUOTE_FOLLOWUP_MAX_ROWS } from "../src/modules/reports/repository/quote-followup.repository.js";
import { createQuoteFollowupService, QuoteFollowupTooLargeError } from "../src/modules/reports/service/quote-followup.service.js";
import { testArticleService } from "./helpers/services.js";

// GET /reports/quote-followup (+ /csv) against Postgres and the real app:
// the selection (quoted only, creation day in Stockholm, customer filter),
// the values from the current rows, the ceiling, the CSV and the Rapporter
// permission.

const authService = createAuthService(createAuthRepository(db), "unused", createAuditRepository(db));
const PASSWORD = "correcthorsebattery";
const TODAY = "2030-03-04";
const service = createQuoteFollowupService(createQuoteFollowupRepository(db), { today: () => TODAY });

const TRUNCATE = sql`TRUNCATE sales_order_rows, sales_orders, customers, quote_loss_reasons, articles, user_settings, users, audit_log CASCADE`;
const DELETE_GROUPS = sql`DELETE FROM permission_groups WHERE code LIKE 'QFU%'`;

let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  app = buildApp();
  await app.ready();
});
beforeEach(async () => {
  await db.execute(TRUNCATE);
  await db.execute(DELETE_GROUPS);
});
afterAll(async () => {
  await app.close();
  await db.execute(TRUNCATE);
  await db.execute(DELETE_GROUPS);
});

const suffix = () => crypto.randomUUID().slice(0, 8);

async function makeCustomer(name: string, number = `K${suffix()}`) {
  const [row] = await db.insert(customers).values({ customerNumber: number, name }).returning();
  return row!;
}

async function makeArticle() {
  return testArticleService.createArticle({ articleNumber: `A-${suffix()}`, name: "Vara", type: "purchased", unit: "st", active: true });
}

async function quote(
  customerId: string,
  createdAt: string,
  over: Partial<typeof salesOrders.$inferInsert> & { rows?: { quantity: number; unitPrice: number; discount?: number }[] } = {}
) {
  const { rows = [{ quantity: 2, unitPrice: 100 }], ...fields } = over;
  const [order] = await db
    .insert(salesOrders)
    .values({
      orderNumber: `KO-${suffix()}`,
      customerId,
      status: "quote",
      quoted: true,
      createdAt: new Date(createdAt),
      ...fields,
    })
    .returning();
  for (const row of rows) {
    const article = await makeArticle();
    await db.insert(salesOrderRows).values({
      salesOrderId: order!.id,
      articleId: article.id,
      quantityOrdered: String(row.quantity),
      unitPrice: String(row.unitPrice),
      discountPercent: String(row.discount ?? 0),
    });
  }
  return order!;
}

describe("quote follow-up service", () => {
  it("selects quoted orders by Stockholm creation day, values the current rows and derives outcomes", async () => {
    const anna = await makeCustomer("Anna Storkök AB", "10001");
    const [reason] = await db.insert(quoteLossReasons).values({ code: "PRIS", name: "Pris" }).returning();
    // 23:30 UTC on Jan 31 is Feb 1 00:30 in Stockholm — inside a February range.
    const feb = await quote(anna.id, "2030-01-31T23:30:00Z", { status: "confirmed", rows: [{ quantity: 10, unitPrice: 100, discount: 10 }] });
    const lost = await quote(anna.id, "2030-02-10T10:00:00Z", { status: "lost", lostReasonId: reason!.id, lostNote: "Dyrt", quoteValidUntil: "2030-02-20" });
    const expired = await quote(anna.id, "2030-02-15T10:00:00Z", { quoteValidUntil: "2030-03-03" });
    await quote(anna.id, "2030-02-16T10:00:00Z", { status: "cancelled" });
    // Outside: created in March (Stockholm), and a direct order (quoted = false).
    await quote(anna.id, "2030-02-28T23:30:00Z"); // March 1 in Stockholm
    await quote(anna.id, "2030-02-05T10:00:00Z", { quoted: false, status: "confirmed" });

    const report = await service.get({ from: "2030-02-01", to: "2030-02-28" });
    expect(report.quotes.map((q) => [q.orderNumber, q.createdDate, q.outcome, q.expired, q.value])).toEqual([
      [feb.orderNumber, "2030-02-01", "won", false, 900],
      [lost.orderNumber, "2030-02-10", "lost", false, 200],
      [expired.orderNumber, "2030-02-15", "open", true, 200],
      [expect.any(String), "2030-02-16", "cancelled", false, 200],
    ]);
    expect(report.quotes[1]!.lostReason).toEqual({ id: reason!.id, code: "PRIS", name: "Pris" });
    expect(report.quotes[1]!.lostNote).toBe("Dyrt");
    expect(report.totals).toMatchObject({ count: 4, won: 1, lost: 1, open: 1, expired: 1, cancelled: 1, hitRateCount: 0.5 });
    expect(report.totals.hitRateValue).toBe(Math.round((900 / 1100) * 10000) / 10000);
    expect(report.customers).toHaveLength(1);
    expect(report.customers[0]).toMatchObject({ customerNumber: "10001", customerName: "Anna Storkök AB", count: 4 });
    expect(report.months.map((m) => [m.month, m.count])).toEqual([["2030-02", 4]]);
    expect(report.lossReasons).toEqual([{ reasonId: reason!.id, code: "PRIS", name: "Pris", count: 1, value: 200, share: 1 }]);
  });

  it("filters on the customer and tells the range back", async () => {
    const anna = await makeCustomer("Anna");
    const bert = await makeCustomer("Bert");
    await quote(anna.id, "2030-01-10T10:00:00Z");
    await quote(bert.id, "2030-01-11T10:00:00Z");
    const report = await service.get({ from: "2030-01-01", to: "2030-12-31", customerId: bert.id });
    expect(report).toMatchObject({ from: "2030-01-01", to: "2030-12-31", customerId: bert.id });
    expect(report.quotes.map((q) => q.customerName)).toEqual(["Bert"]);
    expect(report.customers.map((c) => c.customerName)).toEqual(["Bert"]);
  });

  it("refuses a selection over the ceiling instead of cutting it", async () => {
    const anna = await makeCustomer("Anna");
    const rows = Array.from({ length: QUOTE_FOLLOWUP_MAX_ROWS + 1 }, (_, i) => ({
      orderNumber: `KO-${i}`,
      customerId: anna.id,
      status: "quote" as const,
      quoted: true,
      createdAt: new Date("2030-01-10T10:00:00Z"),
    }));
    for (let i = 0; i < rows.length; i += 2000) await db.insert(salesOrders).values(rows.slice(i, i + 2000));
    await expect(service.get({ from: "2030-01-01", to: "2030-12-31" })).rejects.toThrow(QuoteFollowupTooLargeError);
  });

  it("the CSV is the quote list with Swedish headers and outcomes", async () => {
    const anna = await makeCustomer("Anna Storkök AB", "10001");
    await quote(anna.id, "2030-01-10T10:00:00Z", { status: "lost", quoteValidUntil: "2030-01-31" });
    await quote(anna.id, "2030-01-11T10:00:00Z", { quoteValidUntil: "2030-02-01" });
    const { filename, content } = await service.getCsv({ from: "2030-01-01", to: "2030-12-31" });
    expect(filename).toBe("offertuppfoljning-2030-01-01-2030-12-31.csv");
    const lines = content.split(/\r?\n/).filter((l) => l !== "");
    expect(lines[0]!.replace(/^\ufeff/, "")).toBe("Offert;Order;Kundnummer;Kund;Skapad;Giltig t.o.m.;Status;Utfall;Förlustorsak;Kommentar;Värde");
    expect(lines[1]).toContain(";10001;Anna Storkök AB;2030-01-10;2030-01-31;Förlorad;Förlorad;Ingen orsak angiven;;200,00");
    expect(lines[2]).toContain(";2030-01-11;2030-02-01;Offert;Utgången;;;200,00");
  });

  // Offerter (0138): Offert = the OF- number (an older quote's KO- number
  // when it has none), Order = the KO- number a won OF- quote took.
  it("shows the quote number as Offert and a won quote's order number as Order", async () => {
    const anna = await makeCustomer("Anna Storkök AB", "10001");
    const won = await quote(anna.id, "2030-01-10T10:00:00Z", { status: "confirmed", orderNumber: "KO-QF1", quoteNumber: "OF-QF1" });
    const open = await quote(anna.id, "2030-01-11T10:00:00Z", { orderNumber: "OF-QF2", quoteNumber: "OF-QF2" });
    const legacy = await quote(anna.id, "2030-01-12T10:00:00Z", { orderNumber: "KO-QF3" });
    const cancelled = await quote(anna.id, "2030-01-13T10:00:00Z", { status: "cancelled", orderNumber: "OF-QF4", quoteNumber: "OF-QF4" });

    const report = await service.get({ from: "2030-01-01", to: "2030-12-31" });
    expect(report.quotes.map((q) => [q.id, q.quoteNumber, q.orderNumber, q.documentKind])).toEqual([
      [won.id, "OF-QF1", "KO-QF1", "order"],
      [open.id, "OF-QF2", "OF-QF2", "quote"],
      [legacy.id, "KO-QF3", "KO-QF3", "quote"],
      [cancelled.id, "OF-QF4", "OF-QF4", "quote"],
    ]);

    const { content } = await service.getCsv({ from: "2030-01-01", to: "2030-12-31" });
    const lines = content.split(/\r?\n/).filter((l) => l !== "");
    expect(lines[1]).toMatch(/^OF-QF1;KO-QF1;10001;/);
    expect(lines[2]).toMatch(/^OF-QF2;;10001;/);
    expect(lines[3]).toMatch(/^KO-QF3;;10001;/);
  });
});

describe("GET /reports/quote-followup", () => {
  async function login(email: string) {
    const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PASSWORD } });
    expect(res.statusCode).toBe(200);
    return `session=${res.cookies.find((c) => c.name === "session")!.value}`;
  }
  async function userCookie(permissions: string[]) {
    const [group] = await db
      .insert(permissionGroups)
      .values({ code: `QFU${crypto.randomUUID().slice(0, 6)}`, name: "Test", permissions })
      .returning();
    const email = `user-${crypto.randomUUID()}@example.com`;
    await authService.createUser({ email, password: PASSWORD, name: "Användare", role: "user", permissionGroupId: group!.id });
    return login(email);
  }

  it("needs a session and the Rapporter permission; validates the range", async () => {
    const url = "/api/v1/reports/quote-followup?from=2030-01-01&to=2030-12-31";
    expect((await app.inject({ url })).statusCode).toBe(401);
    const sales = await userCookie(["forsaljning"]);
    expect((await app.inject({ url, headers: { cookie: sales } })).statusCode).toBe(403);
    const reports = await userCookie(["rapporter"]);
    expect((await app.inject({ url, headers: { cookie: reports } })).statusCode).toBe(200);
    expect((await app.inject({ url: "/api/v1/reports/quote-followup?from=2030-01-01", headers: { cookie: reports } })).statusCode).toBe(400);
    expect(
      (await app.inject({ url: "/api/v1/reports/quote-followup?from=2030-12-31&to=2030-01-01", headers: { cookie: reports } })).statusCode
    ).toBe(400);
  });

  it("answers the documented shape and serves the CSV", async () => {
    const anna = await makeCustomer("Anna Storkök AB", "10001");
    await quote(anna.id, "2030-01-10T10:00:00Z", { status: "confirmed" });
    const cookie = await userCookie(["rapporter"]);
    const res = await app.inject({ url: "/api/v1/reports/quote-followup?from=2030-01-01&to=2030-12-31", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json<QuoteFollowupReport>();
    expect(body.totals).toMatchObject({ count: 1, won: 1, hitRateCount: 1, hitRateValue: 1 });
    expect(body.customers[0]).toMatchObject({ customerName: "Anna Storkök AB", hitRateCount: 1 });
    expect(body.months).toEqual([expect.objectContaining({ month: "2030-01", won: 1 })]);
    expect(body.lossReasons).toEqual([]);
    expect(body.quotes[0]).toMatchObject({ outcome: "won", expired: false, lostReason: null, value: 200 });

    const csv = await app.inject({ url: "/api/v1/reports/quote-followup/csv?from=2030-01-01&to=2030-12-31", headers: { cookie } });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.headers["content-disposition"]).toContain("offertuppfoljning-2030-01-01-2030-12-31.csv");
    expect(csv.body).toContain("Vunnen");
  });
});

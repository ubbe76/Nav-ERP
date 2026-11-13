import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gunzipSync } from "node:zlib";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  auditLog,
  customers,
  db,
  invoiceRows,
  invoices,
  lateInterestCharges,
  numberSeries,
  purchaseOrderRows,
  purchaseOrders,
  purchaseReceipts,
  stockTransactions,
  suppliers,
  systemSettings,
} from "@navet/db";
import { createArticleSchema, projectReportQuerySchema, quoteFollowupQuerySchema, salesOrderRegisterQuerySchema } from "@navet/shared";
import { buildApp } from "../src/app.js";
import { createDatabaseBackup, type DumpProcess } from "../src/modules/system/service/backup.js";
import { documentSeriesKeys, documentSeriesTarget } from "../src/modules/system/service/number-series.js";
import { createExchangeRateService } from "../src/modules/system/service/exchange-rates.js";
import { createReportsRepository } from "../src/modules/reports/repository/reports.repository.js";
import { getOrCreateFallbackLocation } from "../src/modules/stock/service/location-resolver.js";
import { testArticleService } from "./helpers/services.js";
import { parsed } from "./helpers/parsed.js";
import { vatCodeId } from "./helpers/vat-codes.js";

// Systemgranskningen (omgång 7, 2026-11-11): the system module (backup,
// Nummerserier, Tillägg, valutakurser, inställningar) and the reports. The
// förfallodag rule (dueDateFromTerm) is tested in due-date.test.ts.

const TRUNCATE = sql`TRUNCATE late_interest_charges, invoice_rows, invoices, customers, purchase_receipts, purchase_order_rows, purchase_orders, suppliers, stock_transactions, articles, exchange_rates, audit_log, user_settings, users CASCADE`;
const SETTING_KEYS = ["allow_multiple_stamps", "quote_validity_days", "setup_charge_article_id", "exchange_rate_source", "riksbank_api_key"];
const PASSWORD = "ett-tillräckligt-långt-lösenord";

let app: ReturnType<typeof buildApp>;
let admin: string;
let savedSeries: (typeof numberSeries.$inferSelect)[] = [];

const cookieOf = (res: { cookies: { name: string; value: string }[] }) => res.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
const asAdmin = (method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: { cookie: admin }, ...(payload === undefined ? {} : { payload: payload as never }) });

async function resetSettings() {
  await db.delete(systemSettings).where(inArray(systemSettings.key, SETTING_KEYS));
}

beforeAll(async () => {
  savedSeries = await db.select().from(numberSeries).where(inArray(numberSeries.key, ["purchase_order"]));
  app = buildApp();
  await app.ready();
});

beforeEach(async () => {
  await db.execute(TRUNCATE);
  await resetSettings();
  await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: { email: "admin@example.com", password: PASSWORD, name: "Admin", setupCode: app.setup.code.code },
  });
  admin = cookieOf(await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "admin@example.com", password: PASSWORD } }));
});

afterEach(async () => {
  for (const row of savedSeries) {
    await db.update(numberSeries).set({ prefix: row.prefix, nextNumber: row.nextNumber, digits: row.digits }).where(eq(numberSeries.key, row.key));
  }
});

afterAll(async () => {
  await app.close();
  await db.execute(TRUNCATE);
  await resetSettings();
});

// --- 1. Säkerhetskopiering ---------------------------------------------------

describe("Säkerhetskopiering: an aborted download ends pg_dump", () => {
  // pg_dump is not in the test environment: a node child stands in. The
  // endless one writes like a large dump and blocks on write() once nobody
  // reads its pipe.
  const child = (script: string): DumpProcess => spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
  const ENDLESS = "const b = Buffer.alloc(65536, 120); const w = () => { while (process.stdout.write(b)); process.stdout.once('drain', w); }; w();";
  let dump: DumpProcess | undefined;

  afterEach(() => {
    if (dump && dump.exitCode === null && dump.signalCode === null) dump.kill("SIGKILL");
    dump = undefined;
  });

  const exitWithin = (process: DumpProcess, ms: number) =>
    Promise.race([
      once(process, "exit"),
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error("pg_dump still running")), ms)),
    ]);

  it("kills the dump when the stream is destroyed before the end (the client went away)", async () => {
    const { stream } = createDatabaseBackup("postgres://unused", new Date(), () => (dump = child(ENDLESS)));
    await once(stream, "data");
    const exited = exitWithin(dump!, 5000);
    stream.destroy();
    await exited;
    expect(dump!.exitCode !== null || dump!.signalCode !== null).toBe(true);
  });

  it("streams a finished dump whole and leaves the process to exit by itself", async () => {
    const { stream } = createDatabaseBackup("postgres://unused", new Date(), () => (dump = child("process.stdout.write('-- dump\\nSELECT 1;\\n')")));
    const exited = once(dump!, "exit");
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    expect(gunzipSync(Buffer.concat(chunks)).toString()).toBe("-- dump\nSELECT 1;\n");
    await exited;
    expect({ code: dump!.exitCode, signal: dump!.signalCode }).toEqual({ code: 0, signal: null });
  });
});

// --- 2. Nummerserier ----------------------------------------------------------

describe("Nummerserier: a series that cannot issue its next number is refused", () => {
  async function series(key: string) {
    const [row] = await db.select().from(numberSeries).where(eq(numberSeries.key, key));
    return row!;
  }

  async function createPurchaseOrder() {
    const [supplier] = await db.insert(suppliers).values({ supplierNumber: `L-${randomUUID().slice(0, 8)}`, name: "Lev AB" }).returning();
    const res = await asAdmin("POST", "/purchase-orders", { supplierId: supplier!.id });
    return res;
  }

  it("409 number-series-too-long when prefix + digits or the next number overflow the document column — nothing saved", async () => {
    const before = await series("purchase_order");
    const tooLong = await asAdmin("PATCH", "/number-series/purchase_order", { prefix: "INKOPSORDER-2026-", digits: 4 });
    expect(tooLong.statusCode).toBe(409);
    expect(tooLong.json()).toMatchObject({ code: "number-series-too-long" });
    expect(tooLong.json().number).toHaveLength(21);

    // A short prefix whose next number has grown to ten digits.
    const grown = await asAdmin("PATCH", "/number-series/purchase_order", { prefix: "ABCDEFGHIJK", nextNumber: 2_000_000_000, digits: 0 });
    expect(grown.statusCode).toBe(409);
    expect(grown.json()).toMatchObject({ code: "number-series-too-long", number: "ABCDEFGHIJK2000000000" });

    expect(await series("purchase_order")).toEqual(before);
    expect(await db.select().from(auditLog).where(eq(auditLog.entityType, "number_series"))).toEqual([]);
  });

  it("accepts exactly the column's 20 characters, and the next document gets that number", async () => {
    const ok = await asAdmin("PATCH", "/number-series/purchase_order", { prefix: "INKOPSORDER-2026", digits: 4, nextNumber: 7 });
    expect(ok.statusCode).toBe(200);
    expect((await createPurchaseOrder()).statusCode).toBe(201);
    expect((await db.select({ number: purchaseOrders.orderNumber }).from(purchaseOrders)).map((r) => r.number)).toEqual(["INKOPSORDER-20260007"]);
  });

  it("409 number-series-number-taken when the first number is already on a document", async () => {
    expect((await createPurchaseOrder()).statusCode).toBe(201);
    const [order] = await db.select({ number: purchaseOrders.orderNumber }).from(purchaseOrders);
    const { prefix, nextNumber } = await series("purchase_order");
    const taken = Number(order!.number.slice(prefix.length));
    expect(nextNumber).toBe(taken + 1);

    const res = await asAdmin("PATCH", "/number-series/purchase_order", { nextNumber: taken });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "number-series-number-taken", number: order!.number });
    expect((await series("purchase_order")).nextNumber).toBe(taken + 1);
    // Past it is fine.
    expect((await asAdmin("PATCH", "/number-series/purchase_order", { nextNumber: taken + 5 })).statusCode).toBe(200);
  });

  it("a create that meets a taken number (a counter moved back some other way) answers 409 document-number-taken, not 500", async () => {
    expect((await createPurchaseOrder()).statusCode).toBe(201);
    const { nextNumber } = await series("purchase_order");
    // Behind Nummerserier's back, as an import or a restore could.
    await db.update(numberSeries).set({ nextNumber: nextNumber - 1 }).where(eq(numberSeries.key, "purchase_order"));

    const res = await createPurchaseOrder();
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "document-number-taken" });
    // The create rolled back with its number.
    expect((await series("purchase_order")).nextNumber).toBe(nextNumber - 1);
    expect(await db.select().from(purchaseOrders)).toHaveLength(1);
  });

  it("knows the column of every document series in number_series, and the columns match the database", async () => {
    // The article and the serial number series (0215) step over taken numbers themselves.
    const seeded = await db
      .select({ key: numberSeries.key })
      .from(numberSeries)
      .where(and(eq(numberSeries.forArticles, false), eq(numberSeries.forSerials, false)));
    const registerSeries = ["customer", "supplier"];
    expect(seeded.map((r) => r.key).filter((key) => !registerSeries.includes(key)).sort()).toEqual([...documentSeriesKeys()].sort());
    for (const key of [...registerSeries, "article", "serial"]) expect(documentSeriesTarget(key)).toBeNull();

    for (const key of documentSeriesKeys()) {
      const target = documentSeriesTarget(key)!;
      const rows = await db.execute(sql`
        select c.character_maximum_length as width
        from information_schema.table_constraints tc
        join information_schema.key_column_usage k on k.constraint_name = tc.constraint_name and k.table_schema = tc.table_schema
        join information_schema.columns c on c.table_schema = tc.table_schema and c.table_name = tc.table_name and c.column_name = k.column_name
        where tc.table_schema = 'public' and tc.constraint_type = 'UNIQUE'
          and tc.constraint_name = ${target.constraint} and tc.table_name = ${target.table} and k.column_name = ${target.column}`);
      expect({ key, width: rows.map((r) => Number((r as { width: number }).width)) }).toEqual({ key, width: [target.width] });
    }
  });
});

// --- 3. Tillägg ------------------------------------------------------------------

describe("Tillägg: a manifest whose body fails after the headers", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    // Headers and the start of the body, then the connection drops: Node's
    // fetch rejects the body read with TypeError "terminated".
    server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": "1000" });
      res.write('{"format":"nav-plugin",');
      setTimeout(() => res.socket?.destroy(), 20);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it("answers 502 plugin-manifest-unreachable, not 500", async () => {
    const res = await asAdmin("POST", "/plugins/preview", { baseUrl });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ code: "plugin-manifest-unreachable", error: "Manifestet kunde inte hämtas: anslutningen bröts under hämtningen" });
  });
});

// --- 4. Valutakurser -------------------------------------------------------------

describe("Valutakurser: a manual rate for a day after today", () => {
  function service() {
    const calls: string[] = [];
    const svc = createExchangeRateService({
      db,
      fetch: (async (input: Parameters<typeof fetch>[0]) => {
        calls.push(String(input));
        return new Response(null, { status: 500 });
      }) as typeof fetch,
      today: () => "2026-10-24",
      clock: () => Date.now(),
      log: () => {},
      timeoutMs: 50,
    });
    return { svc, calls };
  }

  it("wins for exactly that day — Riksbanken is never asked", async () => {
    const { svc, calls } = service();
    await svc.createManualRate({ currency: "EUR", date: "2026-11-20", rate: 11.5 }, null);
    expect(await svc.getRate("EUR", "2026-11-20")).toEqual({ currency: "EUR", requestedDate: "2026-11-20", date: "2026-11-20", rate: 11.5, source: "manual" });
    expect(calls).toEqual([]);
  });

  it("wins in the setting manual too; another future day still takes the latest manual rate through today", async () => {
    const { svc, calls } = service();
    await svc.updateSettings({ source: "manual" }, null);
    await svc.createManualRate({ currency: "EUR", date: "2026-10-20", rate: 11.1 }, null);
    await svc.createManualRate({ currency: "EUR", date: "2026-11-20", rate: 11.5 }, null);
    expect(await svc.getRate("EUR", "2026-11-20")).toMatchObject({ date: "2026-11-20", rate: 11.5, source: "manual" });
    expect(await svc.getRate("EUR", "2026-11-21")).toMatchObject({ requestedDate: "2026-11-21", date: "2026-10-20", rate: 11.1 });
    expect(calls).toEqual([]);
  });
});

// --- 6. PATCH /settings ----------------------------------------------------------

describe("Inställningar: PATCH /settings is all or nothing", () => {
  const stored = async () =>
    (await db.select().from(systemSettings).where(inArray(systemSettings.key, SETTING_KEYS))).map((r) => [r.key, r.value]).sort();

  it("an unknown Ställkostnadsartikel refuses the whole request — nothing written, nothing logged", async () => {
    const res = await asAdmin("PATCH", "/settings", { allowMultipleStamps: true, quoteValidityDays: 45, setupChargeArticleId: randomUUID() });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "setup-charge-article-not-found" });
    expect(await stored()).toEqual([]);
    expect(await db.select().from(auditLog).where(eq(auditLog.entityType, "system_settings"))).toEqual([]);
  });

  it("a valid change is written and logged as before", async () => {
    const article = await testArticleService.createArticle(
      parsed(createArticleSchema, { articleNumber: "STALL", name: "Ställkostnad", type: "service", active: true })
    );
    const res = await asAdmin("PATCH", "/settings", { allowMultipleStamps: true, quoteValidityDays: 45, setupChargeArticleId: article.id });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ allowMultipleStamps: true, quoteValidityDays: 45, setupChargeArticleId: article.id });
    const [entry] = await db.select().from(auditLog).where(eq(auditLog.entityType, "system_settings"));
    expect((entry!.detail as { changedKeys: string[] }).changedKeys.sort()).toEqual(["allow_multiple_stamps", "quote_validity_days", "setup_charge_article_id"]);
  });
});

// --- 7. Leveransprecision, inköp --------------------------------------------------

describe("Leveransprecision: the purchase side's last inleverans", () => {
  const T = (minute: number) => new Date(Date.UTC(2026, 9, 1, 8, minute));

  async function receivedOrder(orderNumber: string, rows: number) {
    const [supplier] = await db.insert(suppliers).values({ supplierNumber: `S-${orderNumber}`, name: "Lev AB" }).returning();
    const [order] = await db
      .insert(purchaseOrders)
      .values({ orderNumber, supplierId: supplier!.id, status: "received", expectedDeliveryDate: "2026-10-01" })
      .returning();
    const article = await testArticleService.createArticle(
      parsed(createArticleSchema, { articleNumber: `A-${orderNumber}`, name: "Artikel", type: "purchased", active: true })
    );
    const orderRows = await db
      .insert(purchaseOrderRows)
      .values(Array.from({ length: rows }, () => ({ purchaseOrderId: order!.id, articleId: article.id, quantityOrdered: "1", quantityReceived: "1", unitPrice: "10" })))
      .returning();
    return { order: order!, rows: orderRows, articleId: article.id };
  }

  // A lego or service row: a receipt log row and no stock movement.
  async function receiptWithoutStock(orderId: string, rowId: string, at: Date, undone = false) {
    await db.insert(purchaseReceipts).values({ purchaseOrderId: orderId, purchaseOrderRowId: rowId, quantity: "1", createdAt: at, undoneAt: undone ? at : null });
  }

  async function stockReceipt(orderId: string, articleId: string, at: Date) {
    const locationId = await getOrCreateFallbackLocation(db);
    const [st] = await db
      .insert(stockTransactions)
      .values({ articleId, locationId, quantityDelta: "1", transactionType: "purchase_receipt", referenceId: orderId, createdAt: at })
      .returning();
    return st!.id;
  }

  it("counts lego and service rows (receipt log only), takes the later of a mixed order, and still reads receipts from before the log", async () => {
    const lego = await receivedOrder("P-LEGO", 1);
    await receiptWithoutStock(lego.order.id, lego.rows[0]!.id, T(1));

    const service = await receivedOrder("P-SERVICE", 1);
    await receiptWithoutStock(service.order.id, service.rows[0]!.id, T(2));

    // A stocked row received at T(3), the lego row at T(4): the lego row is the last one.
    const mixed = await receivedOrder("P-MIXED", 2);
    const stId = await stockReceipt(mixed.order.id, mixed.articleId, T(3));
    await db.insert(purchaseReceipts).values({ purchaseOrderId: mixed.order.id, purchaseOrderRowId: mixed.rows[0]!.id, quantity: "1", stockTransactionId: stId, createdAt: T(3) });
    await receiptWithoutStock(mixed.order.id, mixed.rows[1]!.id, T(4));

    // Received before 0118: a stock movement without a log row.
    const old = await receivedOrder("P-OLD", 1);
    await stockReceipt(old.order.id, old.articleId, T(5));

    // An undone lego receipt is no delivery.
    const undone = await receivedOrder("P-UNDONE", 1);
    await receiptWithoutStock(undone.order.id, undone.rows[0]!.id, T(6), true);

    const measured = new Map(
      (await createReportsRepository(db).loadPurchasePrecisionOrders()).map((r) => [r.orderId, r.completedAt])
    );
    expect({
      lego: measured.get(lego.order.id),
      service: measured.get(service.order.id),
      mixed: measured.get(mixed.order.id),
      old: measured.get(old.order.id),
      undone: measured.get(undone.order.id),
    }).toEqual({
      lego: T(1).toISOString(),
      service: T(2).toISOString(),
      mixed: T(4).toISOString(),
      old: T(5).toISOString(),
      undone: null,
    });
  });
});

// --- 8. Räntefakturor i försäljningsstatistiken -----------------------------------

describe("Försäljningsstatistik and Marginal/TB leave räntefakturor out", () => {
  it("counts the ordinary invoice only — not the räntefaktura nor its (partial) credit", async () => {
    const [customer] = await db.insert(customers).values({ customerNumber: "K-1", name: "Kund AB" }).returning();
    const vatCode = await vatCodeId("MP25");
    const issued = { customerId: customer!.id, status: "issued" as const, invoiceDate: "2026-05-15", exchangeRate: "1" };
    const row = (invoiceId: string, lineAmount: string) => ({
      invoiceId,
      description: "Rad",
      quantity: "1",
      unitPrice: lineAmount,
      vatCodeId: vatCode,
      vatRate: "0",
      lineAmount,
      vatAmount: "0",
    });

    const [invoice] = await db.insert(invoices).values({ ...issued, invoiceNumber: "FA-1" }).returning();
    await db.insert(invoiceRows).values(row(invoice!.id, "1000"));
    const [interestInvoice] = await db.insert(invoices).values({ ...issued, invoiceNumber: "FA-2", note: "Räntefaktura" }).returning();
    const [interestRow] = await db.insert(invoiceRows).values(row(interestInvoice!.id, "200")).returning();
    await db.insert(lateInterestCharges).values({
      invoiceId: invoice!.id,
      fromDate: "2026-04-01",
      toDate: "2026-04-30",
      days: 30,
      amount: "200",
      chargeInvoiceId: interestInvoice!.id,
      chargeInvoiceRowId: interestRow!.id,
    });
    const [credit] = await db
      .insert(invoices)
      .values({ ...issued, invoiceNumber: "FA-3", type: "credit", creditedInvoiceId: interestInvoice!.id })
      .returning();
    await db.insert(invoiceRows).values(row(credit!.id, "50"));

    const repo = createReportsRepository(db);
    const range = { from: "2026-05", to: "2026-05" };
    expect(await repo.loadSalesStatistics({ groupBy: "month", ...range })).toEqual([
      { key: "2026-05", label: "2026-05", netAmount: 1000, quantity: null, invoiceCount: 1 },
    ]);
    expect(await repo.loadSalesStatistics({ groupBy: "customer", ...range })).toMatchObject([{ label: "Kund AB", netAmount: 1000, invoiceCount: 1 }]);
    expect(await repo.loadSalesStatistics({ groupBy: "article", ...range })).toMatchObject([{ label: "(Fritextrader)", netAmount: 1000, invoiceCount: 1 }]);
    expect((await repo.loadInvoiceMarginRows(range)).map((r) => r.netAmount)).toEqual([1000]);
  });
});

// --- 9. Rapporternas datum --------------------------------------------------------

describe("Rapporterna: an impossible calendar day is a 400, not a 500", () => {
  it("refuses 2026-02-30 in the schemas", () => {
    expect(salesOrderRegisterQuerySchema.safeParse({ from: "2026-02-30" }).success).toBe(false);
    expect(quoteFollowupQuerySchema.safeParse({ from: "2026-02-01", to: "2026-02-30" }).success).toBe(false);
    expect(projectReportQuerySchema.safeParse({ projectId: randomUUID(), to: "2026-13-01" }).success).toBe(false);
    expect(salesOrderRegisterQuerySchema.safeParse({ from: "2028-02-29" }).success).toBe(true);
  });

  it("answers 400 validation-failed on the routes", async () => {
    for (const url of [
      "/reports/sales-order-register?from=2026-02-30",
      "/reports/purchase-order-register?dateBasis=delivery&to=2026-04-31",
      `/reports/project-report?projectId=${randomUUID()}&from=2026-02-30`,
    ]) {
      const res = await asAdmin("GET", url);
      expect({ url, status: res.statusCode, code: res.json().code }).toEqual({ url, status: 400, code: "validation-failed" });
    }
  });
});

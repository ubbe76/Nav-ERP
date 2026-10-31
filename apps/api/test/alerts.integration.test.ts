import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  customers,
  db,
  einvoiceTransmissions,
  recurringVerificationRuns,
  recurringVerifications,
  verificationSeries,
  verificationTemplates,
  emailLog,
  invoiceRows,
  invoices,
  paymentBatchItems,
  paymentBatches,
  paymentTerms,
  purchaseOrderRows,
  purchaseOrders,
  salesOrderRows,
  salesOrders,
  supplierInvoices,
  suppliers,
} from "@navet/db";
import {
  listManufacturingOrdersQuerySchema,
  listPurchaseOrdersQuerySchema,
  listSalesOrdersQuerySchema,
  type AlertKind,
  type AlertsResponse,
} from "@navet/shared";
import { testArticleService, testDocumentPdfService } from "./helpers/services.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import { createManufacturingService } from "../src/modules/manufacturing/service/manufacturing.service.js";
import { createPlanningRepository } from "../src/modules/planning/repository/planning.repository.js";
import { createPlanningService } from "../src/modules/planning/service/planning.service.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { createStockService } from "../src/modules/stock/service/stock.service.js";
import { createAlertsRepository } from "../src/modules/alerts/repository/alerts.repository.js";
import { createPurchaseRepository } from "../src/modules/purchase/repository/purchase.repository.js";
import { createSalesRepository } from "../src/modules/sales/repository/sales.repository.js";
import { createAlertsService, EMAIL_FAILED_DAYS } from "../src/modules/alerts/service/alerts.service.js";
import { vatCodeId } from "./helpers/vat-codes.js";

// Aviseringar against Postgres: per kind one case that gives a row and one
// borderline case that must not. "Today" is pinned to Monday 2030-03-04 (as
// the production-plan suite does) so the date rules are exact whatever day
// the suite runs; Utskick som misslyckades measures against the real clock,
// since email_log.created_at defaults to now().
const TODAY = "2030-03-04";
const YESTERDAY = "2030-03-03";
const TOMORROW = "2030-03-05";

const authRepo = createAuthRepository(db);
const stockService = createStockService(createStockRepository(db));
// No plan reader: the TOs are created unplanned, which is what makes an
// overdue one Sen (orderPlanStatus) without a capacity world.
const mfgService = createManufacturingService(createManufacturingRepository(db), testDocumentPdfService, testArticleService);
const planningService = createPlanningService(createPlanningRepository(db), {
  purchase: {
    createPurchaseOrder: async () => {
      throw new Error("not used");
    },
    addRow: async () => {},
    cancel: async () => {},
  },
  manufacturing: mfgService,
  requirementsCacheMs: 0,
  today: () => TODAY,
});
let supplierInvoiceDays = 7;
let quoteFollowupDays = 7;
const alerts = createAlertsService({
  repo: createAlertsRepository(db),
  planning: planningService,
  settings: { supplierInvoiceDays: async () => supplierInvoiceDays, quoteFollowupDays: async () => quoteFollowupDays },
  today: () => TODAY,
});

const TRUNCATE = sql`TRUNCATE recurring_verification_runs, recurring_verifications, verification_template_rows, verification_templates, verification_series,
  email_log, einvoice_transmissions, invoice_rows, invoices, payment_batch_items, payment_batches,
  supplier_invoices, purchase_order_rows, purchase_orders, sales_order_rows, sales_orders, customers, suppliers, payment_terms,
  mo_operation_plan_weeks, mo_reports, mo_report_materials, mo_operation_scrap, mo_material_consumptions, mo_operations,
  manufacturing_orders, routing_operations, work_centers, production_groups, stock_transactions, stock_locations, warehouses,
  bom_components, article_suppliers, articles, users CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
  supplierInvoiceDays = 7;
  quoteFollowupDays = 7;
});
afterAll(async () => {
  await db.execute(TRUNCATE);
});

async function group(kind: AlertKind) {
  const result: AlertsResponse = await alerts.computeAlerts([kind]);
  expect(result.groups).toHaveLength(1);
  return result.groups[0]!;
}

const suffix = () => crypto.randomUUID().slice(0, 8);

async function makeArticle(type: "purchased" | "manufactured", extra: { reorderPoint?: number; orderQuantity?: number } = {}) {
  return testArticleService.createArticle({
    articleNumber: `A-${suffix()}`,
    name: type === "purchased" ? "Köpt del" : "Tillverkad vara",
    type,
    unit: "st",
    active: true,
    ...extra,
  });
}

async function makeCustomer() {
  const [row] = await db.insert(customers).values({ customerNumber: `K${suffix()}`, name: "Kund AB" }).returning();
  return row!;
}

async function makeSupplier(paymentTermId: string | null = null) {
  const [row] = await db
    .insert(suppliers)
    .values({ supplierNumber: `L${suffix()}`, name: "Leverantör AB", paymentTermId })
    .returning();
  return row!;
}

async function makeUser() {
  return authRepo.create({ email: `alerts-${suffix()}@example.com`, passwordHash: "x", name: "Testare", role: "admin" });
}

async function salesOrder(
  status: "quote" | "confirmed" | "in_production" | "delivered",
  headerDate: string | null,
  rows: { quantity: number; delivered?: number; date?: string | null }[]
) {
  const customer = await makeCustomer();
  const article = await makeArticle("purchased");
  const [order] = await db
    .insert(salesOrders)
    .values({ orderNumber: `KO-${suffix()}`, customerId: customer.id, status, expectedDeliveryDate: headerDate })
    .returning();
  for (const row of rows) {
    const rowArticle = rows.length > 1 ? await makeArticle("purchased") : article;
    await db.insert(salesOrderRows).values({
      salesOrderId: order!.id,
      articleId: rowArticle.id,
      quantityOrdered: String(row.quantity),
      quantityDelivered: String(row.delivered ?? 0),
      unitPrice: "100",
      expectedDeliveryDate: row.date ?? null,
    });
  }
  return order!;
}

async function purchaseOrder(
  status: "draft" | "confirmed" | "partially_received" | "received" | "cancelled",
  header: { expected?: string | null; confirmed?: string | null },
  rows: { quantity: number; received?: number; expected?: string | null; confirmed?: string | null }[]
) {
  const supplier = await makeSupplier();
  const [order] = await db
    .insert(purchaseOrders)
    .values({
      orderNumber: `IO-${suffix()}`,
      supplierId: supplier.id,
      status,
      expectedDeliveryDate: header.expected ?? null,
      confirmedDeliveryDate: header.confirmed ?? null,
    })
    .returning();
  for (const row of rows) {
    const article = await makeArticle("purchased");
    await db.insert(purchaseOrderRows).values({
      purchaseOrderId: order!.id,
      articleId: article.id,
      quantityOrdered: String(row.quantity),
      quantityReceived: String(row.received ?? 0),
      unitPrice: "10",
      expectedDeliveryDate: row.expected ?? null,
      confirmedDeliveryDate: row.confirmed ?? null,
    });
  }
  return order!;
}

async function customerInvoice(status: "draft" | "issued" | "paid", dueDate: string | null, gross = 1000) {
  const customer = await makeCustomer();
  const [invoice] = await db
    .insert(invoices)
    .values({
      invoiceNumber: `F-${suffix()}`,
      customerId: customer.id,
      status,
      invoiceDate: "2030-02-01",
      dueDate,
      customerName: customer.name,
    })
    .returning();
  await db.insert(invoiceRows).values({
    invoiceId: invoice!.id,
    description: "Vara",
    quantity: "1",
    unitPrice: String(gross * 0.8),
    vatRate: "25",
    vatCodeId: await vatCodeId("MP25"),
    lineAmount: String(gross * 0.8),
    vatAmount: String(gross * 0.2),
  });
  return invoice!;
}

async function supplierInvoice(opts: {
  status?: "draft" | "approved" | "paid";
  dueDate?: string | null;
  invoiceDate?: string;
  paymentTermCode?: string | null;
  gross?: number;
  currency?: string;
}) {
  let paymentTermId: string | null = null;
  if (opts.paymentTermCode) {
    const [term] = await db
      .insert(paymentTerms)
      .values({ code: opts.paymentTermCode, name: `${opts.paymentTermCode} dagar ${suffix()}` })
      .returning();
    paymentTermId = term!.id;
  }
  const supplier = await makeSupplier(paymentTermId);
  const [invoice] = await db
    .insert(supplierInvoices)
    .values({
      registrationNumber: `LF-${suffix()}`,
      invoiceNumber: `INV-${suffix()}`,
      supplierId: supplier.id,
      vatCodeId: await vatCodeId("MP25"),
      invoiceDate: opts.invoiceDate ?? "2030-02-20",
      dueDate: opts.dueDate ?? null,
      status: opts.status ?? "approved",
      grossAmount: String(opts.gross ?? 500),
      ...(opts.currency ? { currency: opts.currency, exchangeRate: "11.131", exchangeRateSource: "manual" } : {}),
    })
    .returning();
  return { invoice: invoice!, supplier };
}

async function reserveInBatch(invoiceId: string, supplierId: string, status: "pending" | "exported" | "confirmed" | "cancelled") {
  const [batch] = await db
    .insert(paymentBatches)
    .values({ batchNumber: `BO-${suffix()}`, status: status === "confirmed" ? "confirmed" : "draft", bankAccountNumber: "1930" })
    .returning();
  await db.insert(paymentBatchItems).values({
    batchId: batch!.id,
    seq: 1,
    endToEndId: `${batch!.batchNumber}-1`,
    supplierInvoiceId: invoiceId,
    supplierId,
    amount: "500",
    executionDate: TOMORROW,
    status,
  });
}

async function transmission(invoiceId: string, environment: "production" | "sandbox", status: "sending" | "sent" | "delivered" | "rejected" | "failed", startedAt: Date) {
  await db.insert(einvoiceTransmissions).values({
    invoiceId,
    provider: "b2brouter",
    environment,
    recipientId: "0007:5565555555",
    status,
    errorMessage: status === "failed" ? "Kunde inte nå accesspunkten" : null,
    document: Buffer.from("<Invoice/>"),
    sha256: "0".repeat(64),
    startedAt,
  });
}

async function email(
  documentType: "invoice" | "purchase_order" | "test" | "alert_digest",
  documentId: string | null,
  status: "sent" | "failed",
  daysAgo: number,
  recipient = "kund@example.com"
) {
  const [row] = await db
    .insert(emailLog)
    .values({
      documentType,
      documentId,
      recipient,
      subject: `Mejl ${suffix()}`,
      status,
      error: status === "failed" ? "SMTP timeout" : null,
      createdAt: new Date(Date.now() - daysAgo * 86_400_000),
    })
    .returning();
  return row!;
}

describe("stock_negative", () => {
  it("lists an article whose total over every location is below zero, lowest first", async () => {
    const user = await makeUser();
    const a = await makeArticle("purchased");
    const b = await makeArticle("purchased");
    const ok = await makeArticle("purchased");
    await stockService.recordTransaction({ articleId: a.id, quantityDelta: -3, transactionType: "inventory_adjustment" }, user.id);
    await stockService.recordTransaction({ articleId: b.id, quantityDelta: -10, transactionType: "inventory_adjustment" }, user.id);
    // A location at -2 and another at +2: the article's total is 0 — not negative.
    await stockService.recordTransaction({ articleId: ok.id, quantityDelta: 2, transactionType: "inventory_adjustment" }, user.id);
    const [loc] = await db.execute<{ id: string }>(
      sql`INSERT INTO stock_locations (warehouse_id, name) SELECT warehouse_id, 'B1' FROM stock_locations LIMIT 1 RETURNING id`
    );
    await stockService.recordTransaction({ articleId: ok.id, locationId: loc!.id, quantityDelta: -2, transactionType: "inventory_adjustment" }, user.id);

    const g = await group("stock_negative");
    expect(g).toMatchObject({ kind: "stock_negative", label: "Negativt saldo", severity: "red", count: 2, error: false, listHref: "/lager/saldon" });
    expect(g.items.map((i) => [i.key, i.href, i.secondary, i.severity])).toEqual([
      [b.id, `/artiklar/oversikt?article=${b.id}`, "Saldo -10", "red"],
      [a.id, `/artiklar/oversikt?article=${a.id}`, "Saldo -3", "red"],
    ]);
    expect(g.items[0]!.primary).toBe(`${b.articleNumber} ${b.name}`);
  });
});

describe("sales_order_late", () => {
  it("a confirmed order with rest and a passed effective date is late; days and the earliest date are shown", async () => {
    const late = await salesOrder("confirmed", "2030-03-01", [{ quantity: 5, delivered: 2 }]);
    const inProduction = await salesOrder("in_production", YESTERDAY, [{ quantity: 1 }]);
    const g = await group("sales_order_late");
    expect(g.count).toBe(2);
    expect(g.items.map((i) => [i.key, i.date, i.secondary])).toEqual([
      [late.id, "2030-03-01", "3 dagar försenad · leveransdatum 2030-03-01"],
      [inProduction.id, YESTERDAY, "1 dag försenad · leveransdatum 2030-03-03"],
    ]);
    expect(g.items[0]!.href).toBe(`/forsaljning/ordrar/${late.id}`);
    expect(g.items[0]!.primary).toBe(`${late.orderNumber} Kund AB`);
  });

  it("ignores a fully delivered order, a quote, today's date and an order delivered in full on the late row", async () => {
    await salesOrder("delivered", "2030-02-01", [{ quantity: 5, delivered: 5 }]);
    await salesOrder("quote", "2030-02-01", [{ quantity: 5 }]);
    await salesOrder("confirmed", TODAY, [{ quantity: 5 }]);
    await salesOrder("confirmed", "2030-02-01", [{ quantity: 5, delivered: 5 }]);
    await salesOrder("confirmed", null, [{ quantity: 5 }]);
    expect((await group("sales_order_late")).count).toBe(0);
  });

  it("a row's own date before the order's makes the order late, and wins as the earliest date", async () => {
    const order = await salesOrder("confirmed", "2030-04-01", [{ quantity: 1, date: "2030-02-28" }, { quantity: 1 }]);
    const g = await group("sales_order_late");
    expect(g.items.map((i) => [i.key, i.date])).toEqual([[order.id, "2030-02-28"]]);
    // The other way round: the row's later date shields it from the header's.
    await db.execute(TRUNCATE);
    await salesOrder("confirmed", "2030-02-01", [{ quantity: 1, date: "2030-04-01" }]);
    expect((await group("sales_order_late")).count).toBe(0);
  });
});

describe("purchase_order_late", () => {
  it("draft, confirmed and partially received orders with rest and a passed arrival date are late", async () => {
    const draft = await purchaseOrder("draft", { expected: "2030-03-01" }, [{ quantity: 10 }]);
    const partial = await purchaseOrder("partially_received", { expected: YESTERDAY }, [{ quantity: 10, received: 4 }]);
    const g = await group("purchase_order_late");
    expect(g.items.map((i) => [i.key, i.date, i.href])).toEqual([
      [draft.id, "2030-03-01", `/inkop/ordrar/${draft.id}`],
      [partial.id, YESTERDAY, `/inkop/ordrar/${partial.id}`],
    ]);
    expect(g.items[0]!.secondary).toBe("3 dagar försenad · leveransdatum 2030-03-01");
  });

  it("a confirmed date in the future wins over a passed requested date; received and cancelled orders never count", async () => {
    await purchaseOrder("confirmed", { expected: "2030-02-01", confirmed: "2030-03-20" }, [{ quantity: 10 }]);
    await purchaseOrder("confirmed", { expected: "2030-02-01" }, [{ quantity: 10, confirmed: "2030-03-20" }]);
    await purchaseOrder("received", { expected: "2030-02-01" }, [{ quantity: 10, received: 10 }]);
    await purchaseOrder("cancelled", { expected: "2030-02-01" }, [{ quantity: 10 }]);
    expect((await group("purchase_order_late")).count).toBe(0);
    // ...and a passed confirmed date makes the order late even with a future requested date.
    const late = await purchaseOrder("confirmed", { expected: "2030-04-01", confirmed: "2030-02-15" }, [{ quantity: 10 }]);
    const g = await group("purchase_order_late");
    expect(g.items.map((i) => [i.key, i.date])).toEqual([[late.id, "2030-02-15"]]);
  });
});

describe("manufacturing_order_late", () => {
  async function routedArticle() {
    const wc = await mfgService.createWorkCenter({ code: `${100 + Math.floor(Math.random() * 800)}`, name: "Kap", active: true });
    const article = await makeArticle("manufactured");
    await mfgService.createRoutingOperation(article.id, { sequenceNo: 10, workCenterId: wc.id, setupTime: 0, runTimePerUnit: 30 });
    return article;
  }

  it("an open order the plan calls Sen is listed; a future one and a done one are not", async () => {
    const user = await makeUser();
    const article = await routedArticle();
    const late = await mfgService.createManufacturingOrder({ articleId: article.id, quantity: 2, dueDate: YESTERDAY }, user.id);
    await mfgService.createManufacturingOrder({ articleId: article.id, quantity: 2, dueDate: "2030-03-29" }, user.id);
    const done = await mfgService.createManufacturingOrder({ articleId: article.id, quantity: 1, dueDate: "2030-02-01" }, user.id);
    await db.execute(sql`UPDATE manufacturing_orders SET status = 'done' WHERE id = ${done.id}`);

    const summaries = await planningService.orderPlanSummaries([late.id]);
    expect(summaries.get(late.id)?.late).toBe(true);
    const g = await group("manufacturing_order_late");
    expect(g.items.map((i) => [i.key, i.date, i.href])).toEqual([[late.id, YESTERDAY, `/tillverkning/ordrar/${late.id}`]]);
    expect(g.items[0]!.primary).toBe(`${late.orderNumber} ${article.articleNumber} ${article.name}`);
    expect(g.items[0]!.secondary).toBe(`Sen enligt planeringen · färdigdatum ${YESTERDAY}`);
  });
});

// The order lists' status filter Sen (late-orders.ts, orderPlanSummaries):
// exactly the orders Aviseringarna call late, so the list a group links to
// and the group never disagree.
describe("the order lists' status filter Sen", () => {
  const salesRepo = createSalesRepository(db);
  const purchaseRepo = createPurchaseRepository(db);
  // Lists through the plan, like app.ts; the TOs are created by the
  // unplanned mfgService above.
  const listingMfgService = createManufacturingService(
    createManufacturingRepository(db),
    testDocumentPdfService,
    testArticleService,
    undefined as never,
    undefined,
    undefined,
    undefined,
    undefined,
    planningService
  );
  const ids = (rows: { id: string }[]) => rows.map((r) => r.id).sort();
  const keys = (items: { key: string }[]) => items.map((i) => i.key).sort();

  it("lists exactly the late kund- and inköpsorder, and combines with a real status", async () => {
    const late = await salesOrder("confirmed", "2030-03-01", [{ quantity: 5, delivered: 2 }]);
    const inProduction = await salesOrder("in_production", YESTERDAY, [{ quantity: 1 }]);
    await salesOrder("confirmed", TODAY, [{ quantity: 5 }]);
    await salesOrder("confirmed", "2030-02-01", [{ quantity: 5, delivered: 5 }]);
    await salesOrder("delivered", "2030-02-01", [{ quantity: 5, delivered: 5 }]);
    await salesOrder("quote", "2030-02-01", [{ quantity: 5 }]);
    await salesOrder("confirmed", "2030-04-01", [{ quantity: 1, date: "2030-04-02" }]);

    const sales = await salesRepo.listSalesOrders(listSalesOrdersQuerySchema.parse({ status: "late" }), TODAY);
    expect(ids(sales.rows)).toEqual([late.id, inProduction.id].sort());
    expect(sales.total).toBe(2);
    expect(ids(sales.rows)).toEqual(keys((await group("sales_order_late")).items));
    const both = await salesRepo.listSalesOrders(listSalesOrdersQuerySchema.parse({ status: "late,in_production" }), TODAY);
    expect(ids(both.rows)).toEqual([inProduction.id]);

    const draft = await purchaseOrder("draft", { expected: "2030-03-01" }, [{ quantity: 10 }]);
    const partial = await purchaseOrder("partially_received", { expected: YESTERDAY }, [{ quantity: 10, received: 4 }]);
    await purchaseOrder("confirmed", { expected: "2030-02-01", confirmed: "2030-03-20" }, [{ quantity: 10 }]);
    await purchaseOrder("received", { expected: "2030-02-01" }, [{ quantity: 10, received: 10 }]);
    await purchaseOrder("cancelled", { expected: "2030-02-01" }, [{ quantity: 10 }]);

    const purchases = await purchaseRepo.listPurchaseOrders(listPurchaseOrdersQuerySchema.parse({ status: "late" }), TODAY);
    expect(ids(purchases.rows)).toEqual([draft.id, partial.id].sort());
    expect(ids(purchases.rows)).toEqual(keys((await group("purchase_order_late")).items));
  });

  it("lists the TOs the plan calls Sen, with paging and the total in SQL", async () => {
    const user = await makeUser();
    const wc = await mfgService.createWorkCenter({ code: "310", name: "Kap", active: true });
    const article = await makeArticle("manufactured");
    await mfgService.createRoutingOperation(article.id, { sequenceNo: 10, workCenterId: wc.id, setupTime: 0, runTimePerUnit: 30 });
    const first = await mfgService.createManufacturingOrder({ articleId: article.id, quantity: 2, dueDate: YESTERDAY }, user.id);
    const second = await mfgService.createManufacturingOrder({ articleId: article.id, quantity: 2, dueDate: "2030-02-20" }, user.id);
    await mfgService.createManufacturingOrder({ articleId: article.id, quantity: 2, dueDate: "2030-03-29" }, user.id);
    const done = await mfgService.createManufacturingOrder({ articleId: article.id, quantity: 1, dueDate: "2030-02-01" }, user.id);
    await db.execute(sql`UPDATE manufacturing_orders SET status = 'done' WHERE id = ${done.id}`);

    const all = await listingMfgService.listManufacturingOrders(listManufacturingOrdersQuerySchema.parse({ status: "late" }));
    expect(ids(all.rows)).toEqual([first.id, second.id].sort());
    expect(all.rows.every((r) => r.late)).toBe(true);
    expect(ids(all.rows)).toEqual(keys((await group("manufacturing_order_late")).items));

    const page = await listingMfgService.listManufacturingOrders(listManufacturingOrdersQuerySchema.parse({ status: "late", limit: "1" }));
    expect([page.rows.length, page.total]).toEqual([1, 2]);
    // A real status narrows it further; done is never Sen.
    const narrowed = await listingMfgService.listManufacturingOrders(listManufacturingOrdersQuerySchema.parse({ status: "late,done" }));
    expect(narrowed.total).toBe(0);
  });

  it("the status param takes late beside the real statuses and still refuses anything else", () => {
    expect(listSalesOrdersQuerySchema.parse({ status: "late,confirmed" }).status).toEqual(["late", "confirmed"]);
    expect(() => listPurchaseOrdersQuerySchema.parse({ status: "sen" })).toThrow();
    expect(() => listManufacturingOrdersQuerySchema.parse({ status: "late,overdue" })).toThrow();
  });
});

describe("purchase_needed / manufacture_needed", () => {
  it("lists the behovsberäkning's purchase and manufacture proposals with the suggested quantity and projected balance", async () => {
    const user = await makeUser();
    const part = await makeArticle("purchased", { reorderPoint: 10, orderQuantity: 25 });
    const product = await makeArticle("manufactured", { reorderPoint: 4 });
    // Covered: stock above the reorder point ⇒ no proposal.
    const covered = await makeArticle("purchased", { reorderPoint: 10 });
    await stockService.recordTransaction({ articleId: covered.id, quantityDelta: 12, transactionType: "inventory_adjustment" }, user.id);

    const purchase = await group("purchase_needed");
    expect(purchase.items.map((i) => [i.key, i.href, i.secondary])).toEqual([
      [part.id, `/artiklar/oversikt?article=${part.id}`, "Föreslaget antal 25 st · projekterat saldo 0 st"],
    ]);
    expect(purchase.listHref).toBe("/tillverkning/behovsberakning");
    const manufacture = await group("manufacture_needed");
    expect(manufacture.items.map((i) => [i.key, i.secondary])).toEqual([[product.id, "Föreslaget antal 4 st · projekterat saldo 0 st"]]);
  });
});

describe("customer_invoice_overdue", () => {
  it("an issued invoice with an open amount and a passed due date is overdue", async () => {
    const overdue = await customerInvoice("issued", "2030-02-28");
    const g = await group("customer_invoice_overdue");
    expect(g.items.map((i) => [i.key, i.date, i.severity, i.href])).toEqual([
      [overdue.id, "2030-02-28", "red", `/forsaljning/fakturor/${overdue.id}`],
    ]);
    expect(g.items[0]!.primary).toBe(`${overdue.invoiceNumber} Kund AB`);
    // sv-SE groups thousands with a no-break space.
    expect(g.items[0]!.secondary!.replace(/\s/g, " ")).toBe("Förföll 2030-02-28 (4 dagar försenad) · 1 000,00 kr kvar");
  });

  it("ignores a draft, one due today, one due later and a paid one", async () => {
    await customerInvoice("draft", "2030-02-01");
    await customerInvoice("issued", TODAY);
    await customerInvoice("issued", "2030-03-20");
    await customerInvoice("paid", "2030-02-01");
    expect((await group("customer_invoice_overdue")).count).toBe(0);
  });
});

describe("supplier_invoice_due", () => {
  it("an approved invoice due within N days is yellow, an overdue one red, one further ahead left out", async () => {
    const soon = await supplierInvoice({ dueDate: "2030-03-10" });
    const overdue = await supplierInvoice({ dueDate: "2030-03-01" });
    await supplierInvoice({ dueDate: "2030-03-12" });
    const g = await group("supplier_invoice_due");
    expect(g.severity).toBe("red");
    expect(g.items.map((i) => [i.key, i.date, i.severity])).toEqual([
      [overdue.invoice.id, "2030-03-01", "red"],
      [soon.invoice.id, "2030-03-10", "yellow"],
    ]);
    expect(g.items[0]!.secondary).toBe("Förföll 2030-03-01 (3 dagar försenad) · 500,00 kr");
    expect(g.items[1]!.secondary).toBe("Förfaller 2030-03-10 · 500,00 kr");
    expect(g.items[1]!.href).toBe(`/inkop/leverantorsfakturor/${soon.invoice.id}`);
    expect(g.items[1]!.primary).toBe(`${soon.invoice.registrationNumber} Leverantör AB (${soon.invoice.invoiceNumber})`);

    // The window follows the setting.
    supplierInvoiceDays = 10;
    expect((await group("supplier_invoice_due")).count).toBe(3);
    supplierInvoiceDays = 0;
    expect((await group("supplier_invoice_due")).items.map((i) => i.key)).toEqual([overdue.invoice.id]);
  });

  // Valuta: the open amount is in the invoice's own currency — the alert
  // names it instead of kr.
  it("names the currency of a foreign invoice", async () => {
    await supplierInvoice({ dueDate: "2030-03-10", currency: "EUR" });
    expect((await group("supplier_invoice_due")).items[0]!.secondary).toBe("Förfaller 2030-03-10 · 500,00 EUR");
  });

  it("the group is yellow when nothing is overdue", async () => {
    await supplierInvoice({ dueDate: TOMORROW });
    expect((await group("supplier_invoice_due")).severity).toBe("yellow");
  });

  it("derives a missing due date from the supplier's payment term, and skips one with neither", async () => {
    // 2030-02-20 + 10 days = 2030-03-02: overdue.
    const derived = await supplierInvoice({ dueDate: null, invoiceDate: "2030-02-20", paymentTermCode: "10" });
    await supplierInvoice({ dueDate: null, invoiceDate: "2030-02-20", paymentTermCode: "KONTANT" });
    await supplierInvoice({ dueDate: null, invoiceDate: "2030-02-20" });
    const g = await group("supplier_invoice_due");
    expect(g.items.map((i) => [i.key, i.date, i.severity])).toEqual([[derived.invoice.id, "2030-03-02", "red"]]);
  });

  it("leaves out an invoice reserved in a live payment batch, but not one in a cancelled or confirmed batch", async () => {
    const reserved = await supplierInvoice({ dueDate: TOMORROW });
    await reserveInBatch(reserved.invoice.id, reserved.supplier.id, "pending");
    const exported = await supplierInvoice({ dueDate: TOMORROW });
    await reserveInBatch(exported.invoice.id, exported.supplier.id, "exported");
    const cancelled = await supplierInvoice({ dueDate: TOMORROW });
    await reserveInBatch(cancelled.invoice.id, cancelled.supplier.id, "cancelled");
    expect((await group("supplier_invoice_due")).items.map((i) => i.key)).toEqual([cancelled.invoice.id]);
  });

  it("ignores drafts, paid invoices and settled ones", async () => {
    await supplierInvoice({ status: "draft", dueDate: YESTERDAY });
    await supplierInvoice({ status: "paid", dueDate: YESTERDAY });
    await supplierInvoice({ dueDate: YESTERDAY, gross: 0 });
    expect((await group("supplier_invoice_due")).count).toBe(0);
  });
});

describe("quote_followup", () => {
  async function quote(status: "quote" | "lost" | "confirmed" | "cancelled", validUntil: string | null) {
    const customer = await makeCustomer();
    const [order] = await db
      .insert(salesOrders)
      .values({ orderNumber: `KO-${suffix()}`, customerId: customer.id, status, quoted: true, quoteValidUntil: validUntil })
      .returning();
    return order!;
  }

  it("an expired quote is red, one expiring within N days yellow, earliest first; later ones are left out", async () => {
    const soon = await quote("quote", "2030-03-07");
    const expired = await quote("quote", "2030-03-01");
    const today = await quote("quote", TODAY);
    await quote("quote", "2030-03-12"); // day 8 — outside the 7-day window
    const g = await group("quote_followup");
    expect(g.severity).toBe("red");
    expect(g.count).toBe(3);
    expect(g.items.map((i) => [i.key, i.severity, i.date, i.secondary])).toEqual([
      [expired.id, "red", "2030-03-01", "Gick ut 2030-03-01"],
      [today.id, "yellow", TODAY, `Går ut ${TODAY} (i dag)`],
      [soon.id, "yellow", "2030-03-07", "Går ut 2030-03-07 (om 3 dagar)"],
    ]);
    expect(g.items[0]!.href).toBe(`/forsaljning/offerter/${expired.id}`);
    expect(g.items[0]!.primary).toBe(`${expired.orderNumber} Kund AB`);
    expect(g.listHref).toBe("/forsaljning/offerter?status=quote");
  });

  it("the window follows the setting: the day exactly N ahead is in, 0 days means today only", async () => {
    await quote("quote", "2030-03-11"); // day 7
    await quote("quote", TOMORROW);
    expect((await group("quote_followup")).count).toBe(2);
    quoteFollowupDays = 0;
    expect((await group("quote_followup")).count).toBe(0);
    await quote("quote", TODAY);
    expect((await group("quote_followup")).count).toBe(1);
  });

  it("the group is yellow when nothing has expired, and ignores lost, confirmed, cancelled and undated quotes", async () => {
    await quote("quote", TOMORROW);
    await quote("lost", "2030-01-01");
    await quote("confirmed", "2030-01-01");
    await quote("cancelled", "2030-01-01");
    await quote("quote", null);
    const g = await group("quote_followup");
    expect(g.severity).toBe("yellow");
    expect(g.count).toBe(1);
  });
});

describe("einvoice_failed", () => {
  const t = (minutes: number) => new Date(Date.UTC(2030, 2, 1, 10, minutes));

  it("an invoice whose latest production transmission failed or was rejected is listed", async () => {
    const failed = await customerInvoice("issued", "2030-04-01");
    await transmission(failed.id, "production", "failed", t(0));
    // A rejection is the sent row's status flipping (the status job updates
    // the row in place), so the row is rejected and no live row remains.
    const rejected = await customerInvoice("issued", "2030-04-01");
    await transmission(rejected.id, "production", "rejected", t(2));
    const g = await group("einvoice_failed");
    expect(g.items.map((i) => [i.key, i.severity, i.href, i.secondary])).toEqual([
      [failed.id, "red", `/forsaljning/fakturor/${failed.id}`, "Sändningen misslyckades · Kunde inte nå accesspunkten"],
      [rejected.id, "red", `/forsaljning/fakturor/${rejected.id}`, "Avvisad av mottagaren"],
    ]);
  });

  it("a failed sandbox transmission never counts, and a failure followed by a live resend is resolved", async () => {
    const sandbox = await customerInvoice("issued", "2030-04-01");
    await transmission(sandbox.id, "sandbox", "failed", t(0));
    const resent = await customerInvoice("issued", "2030-04-01");
    await transmission(resent.id, "production", "failed", t(0));
    await transmission(resent.id, "production", "sent", t(5));
    // A production failure with a later SANDBOX success is still a failure.
    const stillFailed = await customerInvoice("issued", "2030-04-01");
    await transmission(stillFailed.id, "production", "failed", t(0));
    await transmission(stillFailed.id, "sandbox", "delivered", t(5));
    const g = await group("einvoice_failed");
    expect(g.items.map((i) => i.key)).toEqual([stillFailed.id]);
  });
});

describe("email_failed", () => {
  it("a failed send within 14 days is listed with the document's card; older ones and test mails are not", async () => {
    const invoice = await customerInvoice("issued", "2030-04-01");
    const recent = await email("invoice", invoice.id, "failed", 3);
    await email("invoice", invoice.id, "failed", EMAIL_FAILED_DAYS + 1);
    await email("test", null, "failed", 1);
    const g = await group("email_failed");
    expect(g.items.map((i) => [i.key, i.href, i.severity])).toEqual([[recent.id, `/forsaljning/fakturor/${invoice.id}`, "red"]]);
    expect(g.items[0]!.primary).toBe(`Faktura: ${recent.subject}`);
    expect(g.items[0]!.secondary).toBe("Till kund@example.com · SMTP timeout");
    expect(g.listHref).toBe("/system/e-postlogg");
  });

  it("a failure followed by a successful resend of the same document is resolved; another document's success is not", async () => {
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();
    await email("purchase_order", a, "failed", 5);
    await email("purchase_order", a, "sent", 4);
    const stillFailed = await email("purchase_order", b, "failed", 5);
    await email("invoice", b, "sent", 4);
    // A success BEFORE the failure does not resolve it.
    const failedAfter = await email("purchase_order", a, "failed", 2);
    const g = await group("email_failed");
    expect(g.items.map((i) => i.key)).toEqual([stillFailed.id, failedAfter.id]);
  });

  it("a failed alert digest (no document id) is resolved only by a later digest to the SAME recipient", async () => {
    const toA = await email("alert_digest", null, "failed", 3, "a@example.com");
    await email("alert_digest", null, "sent", 2, "b@example.com");
    await email("alert_digest", null, "failed", 3, "c@example.com");
    await email("alert_digest", null, "sent", 2, "c@example.com");
    const g = await group("email_failed");
    expect(g.items.map((i) => [i.key, i.href])).toEqual([[toA.id, "/system/e-postlogg"]]);
    expect(g.items[0]!.primary).toBe(`Daglig sammanställning: ${toA.subject}`);
  });
});

describe("recurring_verification_failed", () => {
  async function recurringPost(templateName: string) {
    const [series] = await db.insert(verificationSeries).values({ code: `S${crypto.randomUUID().slice(0, 4)}`, name: "Serie" }).returning();
    const [template] = await db.insert(verificationTemplates).values({ name: templateName, seriesId: series!.id, description: "x" }).returning();
    const [post] = await db
      .insert(recurringVerifications)
      .values({ templateId: template!.id, dayOfMonth: 1, startMonth: "2030-01", mode: "draft" })
      .returning();
    return post!;
  }

  it("lists every failed month of a post with the reason, oldest month first; created months and deleted posts never", async () => {
    const hyra = await recurringPost("Hyra");
    const leasing = await recurringPost("Leasing");
    const [feb] = await db
      .insert(recurringVerificationRuns)
      .values({ recurringId: hyra.id, month: "2030-02", status: "failed", error: "Perioden är låst (2030-02-01)" })
      .returning();
    const [jan] = await db
      .insert(recurringVerificationRuns)
      .values({ recurringId: leasing.id, month: "2030-01", status: "failed", error: "Ett konto på mallen är inaktivt" })
      .returning();
    // An unlinked failed row (its post was deleted), a successful month and
    // a month skipped during a pause are not matters to attend to.
    await db.insert(recurringVerificationRuns).values({ recurringId: null, month: "2030-01", status: "failed", error: "x" });
    await db.insert(recurringVerificationRuns).values({ recurringId: hyra.id, month: "2030-03", status: "skipped" });
    const g = await group("recurring_verification_failed");
    expect(g.label).toBe("Återkommande verifikat som misslyckats");
    expect(g.listHref).toBe("/ekonomi/aterkommande-verifikat");
    expect(g.items.map((i) => [i.key, i.href, i.severity, i.primary, i.secondary, i.date])).toEqual([
      [jan!.id, "/ekonomi/aterkommande-verifikat", "red", "Leasing 2030-01", "Kunde inte skapas: Ett konto på mallen är inaktivt", "2030-01-01"],
      [feb!.id, "/ekonomi/aterkommande-verifikat", "red", "Hyra 2030-02", "Kunde inte skapas: Perioden är låst (2030-02-01)", "2030-02-01"],
    ]);
  });
});

describe("computeAlerts", () => {
  it("answers only the requested kinds, in catalog order, and a failing reader does not take the others down", async () => {
    await salesOrder("confirmed", YESTERDAY, [{ quantity: 1 }]);
    const result = await alerts.computeAlerts(["sales_order_late", "stock_negative"]);
    expect(result.groups.map((g) => [g.kind, g.count, g.error])).toEqual([
      ["stock_negative", 0, false],
      ["sales_order_late", 1, false],
    ]);
    expect(Date.parse(result.computedAt)).not.toBeNaN();

    const broken = createAlertsService({
      repo: createAlertsRepository(db),
      planning: {
        requirementProposals: async () => {
          throw new Error("MRP exploded");
        },
        orderPlanSummaries: async () => new Map(),
      },
      settings: { supplierInvoiceDays: async () => 7, quoteFollowupDays: async () => 7 },
      today: () => TODAY,
      log: () => {},
    });
    const partial = await broken.computeAlerts(["purchase_needed", "sales_order_late"]);
    expect(partial.groups.map((g) => [g.kind, g.count, g.error, g.message])).toEqual([
      ["sales_order_late", 1, false, null],
      ["purchase_needed", 0, true, "Kunde inte räkna fram behöver beställas — se serverloggen."],
    ]);
  });

  it("caps the rows at 200 while count is the real number", async () => {
    const user = await makeUser();
    for (let i = 0; i < 205; i++) {
      const article = await makeArticle("purchased");
      await stockService.recordTransaction({ articleId: article.id, quantityDelta: -1, transactionType: "inventory_adjustment" }, user.id);
    }
    const g = await group("stock_negative");
    expect(g.count).toBe(205);
    expect(g.items).toHaveLength(200);
  });
});

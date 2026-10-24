import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { customers, db, invoiceRows, salesOrderRows, shipmentDeliveries, shipments } from "@navet/db";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createInvoiceRepository } from "../src/modules/sales/repository/invoice.repository.js";
import { createInvoiceService, InvoiceRowCurrencyMismatchError } from "../src/modules/sales/service/invoice.service.js";
import { createMailRepository } from "../src/modules/mail/repository/mail.repository.js";
import { createMailService } from "../src/modules/mail/service/mail.service.js";
import { createDocumentPdfService } from "../src/modules/mail/service/document-pdf.js";
import { createSystemRepository } from "../src/modules/system/repository/system.repository.js";
import { createSystemService } from "../src/modules/system/service/system.service.js";
import { createVerificationPoster } from "../src/modules/economy/service/verification-poster.js";
import { ExchangeRateUnavailableError, type ExchangeRateReader } from "../src/modules/system/service/exchange-rates.js";
import { DEFAULT_POSTING_SETTINGS, setupPostingBaseline } from "./helpers/services.js";
import { enableFreight, makeArticle, makeCustomer, makeDelivery } from "./helpers/shipping-fixtures.js";

// Valuta steg 3: a freight row from a shipment on an invoice in another
// currency — the kundpris (SEK) converted with the shipment's order's rate.

const articleService = createArticleService(createArticleRepository(db));
const systemService = createSystemService(createSystemRepository(db));
const mailService = createMailService(createMailRepository(db), systemService, () => ({ async sendMail() {} }));
const rates: ExchangeRateReader = {
  async getRate(currency, date) {
    if (currency === "NOK") return { currency, requestedDate: date, date, rate: 0.9, source: "riksbank" };
    throw new ExchangeRateUnavailableError(currency, date);
  },
};
let freightArticleId: string;
const invoiceService = createInvoiceService(
  createInvoiceRepository(db),
  mailService,
  createDocumentPdfService(systemService),
  createVerificationPoster({ read: async () => ({ ...DEFAULT_POSTING_SETTINGS }) }),
  undefined,
  articleService,
  { freightArticleId: async () => freightArticleId },
  rates
);

const TRUNCATE = sql`TRUNCATE posting_rules, verification_rows, verifications, verification_counters, verification_series, accounting_periods, fiscal_years, accounts, invoice_documents, invoice_rows, invoices, shipment_tracking_events, shipment_files, shipment_parcels, shipment_deliveries, shipments, freight_products, delivery_rows, deliveries, sales_order_rows, sales_orders, customers, payment_terms, stock_transactions, stock_locations, warehouses, bom_components, articles, audit_log, users CASCADE`;

let biller: string;
let seq = 0;
beforeEach(async () => {
  await db.execute(TRUNCATE);
  await setupPostingBaseline();
  await enableFreight();
  biller = (await createAuthRepository(db).create({ email: `ff-${crypto.randomUUID()}@example.com`, passwordHash: "x", name: "B", role: "admin" })).id;
  freightArticleId = (await makeArticle({ type: "service", articleNumber: "F", name: "Frakt" })).id;
});
afterAll(async () => {
  await db.execute(TRUNCATE);
});

async function shipmentOn(customerId: string, order: { currency: string; exchangeRate: string }) {
  const article = await makeArticle({ weight: 5 });
  const delivery = await makeDelivery(customerId, [{ articleId: article.id, quantity: 2 }], { status: "delivered", ...order });
  const [s] = await db
    .insert(shipments)
    .values({
      shipmentNumber: `FR-FX-${Date.now() % 1_000_000}-${++seq}`,
      status: "booked",
      providerShipmentId: `snd-fx-${seq}`,
      customerId,
      recipientName: "Mottagare",
      pickupDate: "2026-10-08",
      pickupFrom: "08:00",
      pickupTo: "16:00",
      customerPrice: "450.00",
      carrierPrice: "400.00",
      bookedAt: new Date(),
    })
    .returning();
  await db.insert(shipmentDeliveries).values({ shipmentId: s!.id, deliveryId: delivery.deliveryId });
  const [orderRow] = await db.select().from(salesOrderRows).where(eq(salesOrderRows.salesOrderId, delivery.orderId));
  return { shipment: s!, orderRow: orderRow! };
}

describe("fraktrad på faktura i valuta", () => {
  it("lists the shipment in its order's currency, the kundpris converted with the order's rate", async () => {
    const customer = await makeCustomer();
    const { shipment } = await shipmentOn(customer.id, { currency: "EUR", exchangeRate: "10" });
    const [row] = await invoiceService.listInvoiceableShipments(customer.id);
    expect(row).toMatchObject({ shipmentId: shipment.id, customerPrice: "450.00", currency: "EUR", unitPrice: 45 });
  });

  it("a SEK shipment keeps its kundpris; a shipment of an EUR order cannot go on a SEK invoice", async () => {
    const customer = await makeCustomer();
    const sek = await shipmentOn(customer.id, { currency: "SEK", exchangeRate: "1" });
    const eur = await shipmentOn(customer.id, { currency: "EUR", exchangeRate: "10" });
    const listed = await invoiceService.listInvoiceableShipments(customer.id);
    expect(listed.map((r) => [r.currency, r.unitPrice])).toEqual([
      ["SEK", 450],
      ["EUR", 45],
    ]);
    const row = (shipmentId: string, unitPrice: number) => ({ articleId: freightArticleId, shipmentId, description: "Frakt", quantity: 1, unitPrice });
    const draft = await invoiceService.create({ customerId: customer.id, rows: [row(sek.shipment.id, 450)] }, biller);
    expect(draft!.currency).toBe("SEK");
    await expect(invoiceService.addRow(draft!.id, row(eur.shipment.id, 45))).rejects.toBeInstanceOf(InvoiceRowCurrencyMismatchError);
    // An invoice with the EUR shipment as its first row takes EUR.
    const eurDraft = await invoiceService.create({ customerId: customer.id, rows: [row(eur.shipment.id, 45)] }, biller);
    expect(eurDraft!.currency).toBe("EUR");
  });

  it("samlingsfakturering bills the EUR order's freight on the EUR invoice at the order's rate", async () => {
    const customer = await makeCustomer();
    await db.update(customers).set({ collectiveInvoicing: true, currency: "EUR" }).where(eq(customers.id, customer.id));
    await shipmentOn(customer.id, { currency: "EUR", exchangeRate: "10" });
    const { results } = await invoiceService.runCollectiveInvoicing({ customerIds: [customer.id], issue: false }, biller);
    expect(results.map((r) => [r.currency, r.status])).toEqual([["EUR", "draft"]]);
    const rows = await db.select().from(invoiceRows).where(eq(invoiceRows.invoiceId, results[0]!.invoiceId!));
    const freight = rows.find((r) => r.shipmentId !== null)!;
    expect(Number(freight.unitPrice)).toBe(45);
  });
});

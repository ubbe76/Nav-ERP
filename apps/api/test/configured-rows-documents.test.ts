import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, emailLog } from "@navet/db";
import type { OrderRowConfiguration } from "@navet/shared";
import Fastify from "fastify";
import { mailRoutes } from "../src/modules/mail/routes/mail.routes.js";
import { pdfText } from "./helpers/pdf.js";
import {
  buildToOrder,
  invoiceService,
  mailService,
  makeLocation,
  makeUser,
  purchaseService,
  resetDocuments,
  salesService,
  seedStock,
  sentMails,
} from "./helpers/configured-rows.js";

// Konfigurator 4b, Task 5: the choice lines of a configured row on every
// customer document — offert/orderbekräftelse (Visa tilläggspriser), the
// invoice (copy on invoice_rows, customer's setting at issue, archived),
// plocklista and följesedel (never prices).

beforeEach(async () => {
  await resetDocuments();
  sentMails.length = 0;
});
afterAll(resetDocuments);

const SEL = { LOCK: "B", BREDD: 1200, AVLOPP: true };
const makeCustomer = (showConfigurationPrices = false) =>
  salesService.createCustomer({ name: "Kund AB", active: true, showConfigurationPrices });

async function configuredOrder(customerId: string) {
  const { article } = await buildToOrder();
  const { order, rows } = await salesService.createQuote(
    {
      customerId,
      rows: [
        { articleId: article.id, quantity: 2, configuration: { selection: SEL } },
        { articleId: article.id, quantity: 1, configuration: { selection: { LOCK: "A", BREDD: 800 } } },
      ],
    } as never,
    null
  );
  // The rows are picked by their choices, never by position — createQuote's
  // RETURNING order and listRowsByOrder's sort are not what these tests are
  // about. rowB is the Lås B / 1 200 mm row every document test delivers and
  // invoices; the Lås A / 800 mm row stays undelivered.
  const pick = (lock: string) =>
    rows.find((r) => (r.configuration as OrderRowConfiguration).selection.some((e) => e.groupCode === "LOCK" && e.value === lock))!;
  const rowB = pick("B");
  expect(rowB).toBeDefined();
  expect(pick("A")).toBeDefined();
  return { article, order, rows, rowB };
}

async function deliveredOrder(customerId: string, userId: string) {
  const { article, order, rows, rowB } = await configuredOrder(customerId);
  await salesService.confirm(order.id);
  await salesService.startProduction(order.id);
  const location = await makeLocation();
  await seedStock(article.id, location.id, 5);
  const delivered = await salesService.deliverGoods(order.id, rowB.id, { locationId: location.id, quantity: 2 }, userId);
  return { article, order, rows, rowB, delivered };
}

describe("quote / order confirmation", () => {
  it("prints the choice lines in order, without Nej and empty groups, and additions only with the flag", async () => {
    const c = await makeCustomer(false);
    const { order } = await configuredOrder(c.id);
    const plain = pdfText((await salesService.getSalesOrderPdf(order.id, "quote")).content);
    expect(plain).toContain("Lås: Lås B");
    expect(plain).toContain("Avlopp: Ja");
    expect(plain).toContain("Bredd: 1 200 mm");
    expect(plain).toContain("Bredd: 800 mm");
    expect(plain.indexOf("Lås: Lås B")).toBeLessThan(plain.indexOf("Avlopp: Ja"));
    expect(plain).not.toContain("(+ ");
    const priced = pdfText((await salesService.getSalesOrderPdf(order.id, "confirmation", true)).content);
    expect(priced).toContain("Lås: Lås B (+ 50,00)");
    expect(priced).toContain("Avlopp: Ja (+ 100,00)");
    expect(priced).toContain("Bredd: 1 200 mm");
    expect(priced).not.toContain("Bredd: 1 200 mm (+");
    // The second row (LOCK A, +0; no Avlopp) prints no addition at all.
    expect(priced).toContain("Lås: Lås A");
    expect(priced).not.toContain("Lås: Lås A (+");
  });

  it("the customer's setting is the default; an explicit false overrides it", async () => {
    const c = await makeCustomer(true);
    const { order } = await configuredOrder(c.id);
    expect(pdfText((await salesService.getSalesOrderPdf(order.id, "quote")).content)).toContain("(+ 50,00)");
    expect(pdfText((await salesService.getSalesOrderPdf(order.id, "quote", false)).content)).not.toContain("(+ 50,00)");
  });

  it("the email logs the resolved flag and resend reuses it even after the customer changes", async () => {
    const c = await makeCustomer(false);
    const { order } = await configuredOrder(c.id);
    await salesService.sendSalesOrderEmail(order.id, {
      to: "k@kund.se",
      subject: "Offert",
      message: "",
      attachDrawings: false,
      variant: "quote",
      showConfigurationPrices: true,
    });
    const [entry] = await db.select().from(emailLog).where(eq(emailLog.documentId, order.id));
    expect(entry!.showConfigurationPrices).toBe(true);
    expect(pdfText(sentMails[0]!.attachments![0]!.content)).toContain("(+ 50,00)");

    // The customer setting flips — a resend still prints the prices.
    await salesService.updateCustomer(c.id, { showConfigurationPrices: false } as never);
    const user = await makeUser();
    const app = Fastify();
    app.decorateRequest("user", null);
    app.addHook("preHandler", async (req) => {
      req.user = { id: user.id, email: user.email, name: user.name, role: "admin" } as never;
    });
    await app.register(mailRoutes, { service: mailService, purchaseService, salesService, invoiceService });
    const res = await app.inject({ method: "POST", url: `/email-log/${entry!.id}/resend` });
    expect(res.statusCode).toBe(200);
    expect(sentMails).toHaveLength(2);
    expect(pdfText(sentMails[1]!.attachments![0]!.content)).toContain("(+ 50,00)");
    const entries = await db.select().from(emailLog).where(eq(emailLog.documentId, order.id));
    expect(entries.map((e) => e.showConfigurationPrices)).toEqual([true, true]);
    await app.close();
  });

  it("an email without the flag takes the customer's setting and logs it", async () => {
    const c = await makeCustomer(true);
    const { order } = await configuredOrder(c.id);
    await salesService.sendSalesOrderEmail(order.id, {
      to: "k@kund.se",
      subject: "Offert",
      message: "",
      attachDrawings: false,
      variant: "quote",
    });
    const [entry] = await db.select().from(emailLog).where(eq(emailLog.documentId, order.id));
    expect(entry!.showConfigurationPrices).toBe(true);
    expect(pdfText(sentMails[0]!.attachments![0]!.content)).toContain("(+ 50,00)");
  });
});

describe("pick list and delivery note", () => {
  it("print the choice lines and never the additions", async () => {
    const user = await makeUser();
    const c = await makeCustomer(true);
    const { article, order, rowB } = await configuredOrder(c.id);
    await salesService.confirm(order.id);
    await salesService.startProduction(order.id);
    const pick = pdfText((await salesService.getPickListPdf(order.id)).content);
    expect(pick).toContain("Lås: Lås B");
    expect(pick).toContain("Bredd: 1 200 mm");
    expect(pick).not.toContain("(+ ");
    const location = await makeLocation();
    await seedStock(article.id, location.id, 5);
    const delivered = await salesService.deliverGoods(order.id, rowB.id, { locationId: location.id, quantity: 2 }, user.id);
    const note = pdfText((await salesService.deliveryNotePdf(delivered.deliveryId)).pdf);
    expect(note).toContain("Lås: Lås B");
    expect(note).toContain("Avlopp: Ja");
    expect(note).toContain("Bredd: 1 200 mm");
    expect(note).not.toContain("(+ ");
    // Only the delivered row is on the delivery note.
    expect(note).not.toContain("Bredd: 800 mm");
  });
});

describe("invoice", () => {
  it("the row copies the configuration, the PDF follows the customer's setting at issue, the credit note copies it too", async () => {
    const user = await makeUser();
    const c = await makeCustomer(true);
    const { article, order, rowB } = await deliveredOrder(c.id, user.id);
    // The delivered row, read back through the list the card and PDFs use.
    const orderRow = (await salesService.listRows(order.id)).find((r) => r.id === rowB.id);
    expect(orderRow!.configuration).not.toBeNull();
    const draft = await invoiceService.create(
      {
        customerId: c.id,
        rows: [
          {
            articleId: article.id,
            salesOrderRowId: orderRow!.id,
            description: "Korg",
            quantity: 2,
            unitPrice: 1150,
            discountPercent: 0,
          },
        ],
      },
      user.id
    );
    expect(draft!.rows[0]!.configuration).toEqual(orderRow!.configuration);

    const issued = await invoiceService.issue(draft!.id, user.id);
    const text = pdfText((await invoiceService.renderPdf(issued!.id)).content);
    expect(text).toContain("Lås: Lås B (+ 50,00)");
    expect(text).toContain("Avlopp: Ja (+ 100,00)");
    expect(text).toContain("Bredd: 1 200 mm");

    // Flipping the customer afterwards does not change the archived PDF.
    await salesService.updateCustomer(c.id, { showConfigurationPrices: false } as never);
    expect(pdfText((await invoiceService.renderPdf(issued!.id)).content)).toContain("(+ 50,00)");

    const credit = await invoiceService.createCredit(issued!.id, {}, user.id);
    expect(credit!.rows[0]!.configuration).toEqual(orderRow!.configuration);
    const issuedCredit = await invoiceService.issue(credit!.id, user.id);
    const creditText = pdfText((await invoiceService.renderPdf(issuedCredit!.id)).content);
    expect(creditText).toContain("Lås: Lås B");
    // Issued after the customer flipped to false: no additions on the credit.
    expect(creditText).not.toContain("(+ 50,00)");
  });

  it("collective invoicing carries the configuration", async () => {
    const user = await makeUser();
    const c = await salesService.createCustomer({ name: "Samling AB", active: true, collectiveInvoicing: true });
    const { article } = await deliveredOrder(c.id, user.id);
    const { results } = await invoiceService.runCollectiveInvoicing({ customerIds: [c.id], issue: false }, user.id);
    expect(results[0]!.status).not.toBe("failed");
    const invoice = await invoiceService.getInvoice(results[0]!.invoiceId!);
    expect(invoice!.rows[0]!.configuration).toMatchObject({ templateArticleId: article.id });
  });

  it("a free row has no configuration; listInvoiceableOrders carries the order row's", async () => {
    const user = await makeUser();
    const c = await makeCustomer();
    await deliveredOrder(c.id, user.id);
    const candidates = await invoiceService.listInvoiceableOrders(c.id);
    expect(candidates[0]!.rows[0]!.configuration).toMatchObject({ key: expect.any(String) });
    const draft = await invoiceService.create(
      { customerId: c.id, rows: [{ description: "Frakt", quantity: 1, unitPrice: 100 }] },
      user.id
    );
    expect(draft!.rows[0]!.configuration).toBeNull();
  });

  it("a row edited on the draft keeps the order row's copy", async () => {
    const user = await makeUser();
    const c = await makeCustomer();
    const { article, order, rowB } = await deliveredOrder(c.id, user.id);
    const orderRow = (await salesService.listRows(order.id)).find((r) => r.id === rowB.id);
    const draft = await invoiceService.create(
      {
        customerId: c.id,
        rows: [{ articleId: article.id, salesOrderRowId: orderRow!.id, description: "Korg", quantity: 2, unitPrice: 1150 }],
      },
      user.id
    );
    await invoiceService.updateRow(draft!.id, draft!.rows[0]!.id, { quantity: 1 }, user.id);
    const after = await invoiceService.getInvoice(draft!.id);
    expect(after!.rows[0]!.configuration).toEqual(orderRow!.configuration);
  });
});

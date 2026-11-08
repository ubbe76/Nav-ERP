import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db, vatCodes } from "@navet/db";
import { createRoutingOperationSchema, createWorkCenterSchema, createArticleSchema, createPurchaseOrderSchema, createStockLocationSchema } from "@navet/shared";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createSalesRepository } from "../src/modules/sales/repository/sales.repository.js";
import { createSalesService } from "../src/modules/sales/service/sales.service.js";
import { markSalesOrderInProduction } from "../src/modules/sales/service/production-transition.js";
import { resolvePrice } from "../src/modules/sales/service/price-resolver.js";
import { createInvoiceRepository } from "../src/modules/sales/repository/invoice.repository.js";
import { createInvoiceService } from "../src/modules/sales/service/invoice.service.js";
import { createPurchaseRepository } from "../src/modules/purchase/repository/purchase.repository.js";
import { createPurchaseService } from "../src/modules/purchase/service/purchase.service.js";
import { createQualityRepository } from "../src/modules/quality/repository/quality.repository.js";
import { createQualityService } from "../src/modules/quality/service/quality.service.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import { createManufacturingService } from "../src/modules/manufacturing/service/manufacturing.service.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { createStockService } from "../src/modules/stock/service/stock.service.js";
import { createRegisterRepository } from "../src/modules/register/repository/register.repository.js";
import { createRegisterService } from "../src/modules/register/service/register.service.js";
import { createMailRepository } from "../src/modules/mail/repository/mail.repository.js";
import { createMailService, type MailTransportFactory } from "../src/modules/mail/service/mail.service.js";
import { createDocumentPdfService } from "../src/modules/mail/service/document-pdf.js";
import { createSystemRepository } from "../src/modules/system/repository/system.repository.js";
import { createSystemService } from "../src/modules/system/service/system.service.js";
import { createVerificationPoster } from "../src/modules/economy/service/verification-poster.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { pdfText } from "./helpers/pdf.js";
import { DEFAULT_POSTING_SETTINGS, setupPostingBaseline, testArticleService } from "./helpers/services.js";
import { resetVatCodes } from "./helpers/vat-codes.js";
import { parsed } from "./helpers/parsed.js";

// Dokument på engelska (#7), step 2: the customer- and supplier-facing PDFs
// in English. One English customer/supplier per case; the Swedish documents
// are pinned by the ~42 other pdfText suites, this file asserts the English
// side and that the English fields never leak into a Swedish document. All
// data made up.

const articleService = createArticleService(createArticleRepository(db));
const stockService = createStockService(createStockRepository(db));
const authRepo = createAuthRepository(db);
const registerService = createRegisterService(createRegisterRepository(db));
const auditRepository = createAuditRepository(db);

const sentMails: { to: string; subject: string; attachments?: { filename: string; content: Buffer }[] }[] = [];
const fakeTransportFactory: MailTransportFactory = () => ({
  async sendMail(opts) {
    sentMails.push(opts);
  },
});

const systemService = createSystemService(createSystemRepository(db));
const mailService = createMailService(createMailRepository(db), systemService, fakeTransportFactory);
const pdf = createDocumentPdfService(systemService);
const salesRepository = createSalesRepository(db);
const salesService = createSalesService(
  salesRepository,
  registerService,
  mailService,
  pdf,
  stockService,
  articleService,
  systemService,
  (query) => resolvePrice(db, query),
  auditRepository
);
const invoiceService = createInvoiceService(
  createInvoiceRepository(db),
  mailService,
  pdf,
  createVerificationPoster({ read: async () => ({ ...DEFAULT_POSTING_SETTINGS }) }),
  auditRepository,
  articleService,
  undefined,
  null,
  null,
  // Extra benämning on the invoice follows the setting (set in beforeEach).
  systemService
);
const purchaseService = createPurchaseService(
  createPurchaseRepository(db),
  registerService,
  mailService,
  pdf,
  articleService,
  systemService,
  {
    reportOperationQuantities: async () => {
      throw new Error("not wired");
    },
    assertMaterialBeforeSubcontractReceipt: async () => {},
    undoPurchaseReceiptReportInTx: async () => {
      throw new Error("not wired");
    },
    updateRoutingOperation: async () => {
      throw new Error("not wired");
    },
  },
  auditRepository
);
const quality = createQualityService({ repo: createQualityRepository(db), pdf, mail: mailService });
const mfgService = createManufacturingService(
  createManufacturingRepository(db),
  pdf,
  testArticleService,
  {
    findRowForManufacturing: salesRepository.findRowForManufacturing,
    lockRowForManufacturing: salesRepository.lockRowForManufacturing,
    markInProduction: markSalesOrderInProduction,
  },
  undefined,
  undefined,
  undefined,
  systemService
);

// number_series and vat_codes are never truncated (shared base data).
const TRUNCATE = sql`TRUNCATE posting_rules, verification_rows, verifications, verification_counters, verification_series, accounting_periods, fiscal_years, accounts, invoice_reminders, invoice_rows, invoices, deviations, inquiry_rows, inquiries, purchase_order_rows, purchase_orders, suppliers, mo_reports, delivery_rows, deliveries, mo_operation_scrap, mo_material_consumptions, mo_operations, manufacturing_orders, routing_operations, work_centers, production_groups, sales_order_rows, sales_orders, customer_delivery_addresses, customers, delivery_terms, payment_terms, stock_transactions, stock_locations, warehouses, bom_components, articles, units, email_log, audit_log, users CASCADE`;

// Swedish fixed words that must never appear on an English document.
const SWEDISH_WORDS = [
  "Benämning",
  "Antal",
  "Summa",
  "Moms",
  "Förfallodatum",
  "Ordernummer",
  "Leveransadress",
  "LEVERANSADRESS",
  "Betalningsvillkor",
  "Leveransvillkor",
  "Er referens",
  "Vår referens",
  "Godkänd för F-skatt",
  "Org.nr",
  "Säte",
  "Kundnr",
  "Datum",
  "Artikelnummer",
  "Enhet",
  "À-pris",
  "Rabatt",
  "Att betala",
  "Speditör",
  "Ert ordernummer",
  "Ert art.nr",
  "Priser inklusive moms",
  "Ångrad",
  "Tidigare levererat",
];

// Visual check: PDF_DUMP_DIR=<dir> writes every rendered document there, to
// rasterize with pdftoppm when a label or a column width changes.
function dump(filename: string, content: Buffer) {
  const dir = process.env.PDF_DUMP_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), content);
}

function expectEnglish(text: string, words: string[] = SWEDISH_WORDS) {
  for (const word of words) expect(text, `Swedish "${word}" on an English document`).not.toContain(word);
}

let userId: string;

beforeEach(async () => {
  await db.execute(TRUNCATE);
  sentMails.length = 0;
  await setupPostingBaseline();
  await systemService.updateSettings({
    smtpHost: "smtp.test.local",
    smtpFromEmail: "erp@test.local",
    extraDescriptionDocuments: ["quote", "orderConfirmation", "invoice", "deliveryNote", "inquiry", "purchaseOrder"],
  });
  await systemService.updateCompanyInfo({
    orgNumber: "556000-0001",
    vatNumber: "SE556000000101",
    companySeat: "Kiruna",
    fSkatt: true,
    bankgiro: "123-4567",
  });
  userId = (
    await authRepo.create({
      email: `en-${crypto.randomUUID()}@example.com`,
      passwordHash: "not-a-real-hash",
      name: "Seller",
      role: "admin",
    })
  ).id;
});

afterAll(async () => {
  await db.execute(TRUNCATE);
  await systemService.updateSettings({ extraDescriptionDocuments: [] });
  await systemService.updateCompanyInfo({ orgNumber: null, vatNumber: null, companySeat: null, fSkatt: false, bankgiro: null });
  await resetVatCodes();
});

// --- fixtures -------------------------------------------------------------

async function makeBaseData() {
  await registerService.units.create({ code: "st", name: "Styck", codeEn: "pcs" });
  const unit = (await registerService.units.list())[0]!;
  const deliveryTerm = await registerService.deliveryTerms.create({ code: "EXW", name: "Från fabrik", nameEn: "Ex Works" } as never);
  const paymentTerm = await registerService.paymentTerms.create({ code: "30", name: "30 dagar netto", nameEn: "30 days net" } as never);
  const article = await articleService.createArticle(parsed(createArticleSchema, {
    articleNumber: "SB-1200",
    name: "Diskbänk 1200",
    nameEn: "Sink unit 1200",
    extraDescription: "Borstat rostfritt stål",
    extraDescriptionEn: "Brushed stainless steel",
    type: "manufactured",
    unitId: unit.id,
    active: true,
  }));
  // An article WITHOUT English texts — the fallback to Swedish data.
  const plain = await articleService.createArticle(parsed(createArticleSchema, {
    articleNumber: "UND-600",
    name: "Underrede 600",
    type: "manufactured",
    unitId: unit.id,
    active: true,
  }));
  return { unit, deliveryTerm, paymentTerm, article, plain };
}

async function makeCustomer(language: "sv" | "en", terms: { deliveryTerm: { id: string }; paymentTerm: { id: string } }, extra: Record<string, unknown> = {}) {
  return salesService.createCustomer({
    name: language === "en" ? "Customer Ltd" : "Kund AB",
    active: true,
    country: "SE",
    language,
    email: "buyer@example.com",
    invoiceEmail: "invoice@example.com",
    address: "Storgatan 1",
    postalCode: "123 45",
    city: "Stad",
    deliveryTermId: terms.deliveryTerm.id,
    paymentTermId: terms.paymentTerm.id,
    ...extra,
  } as never);
}

async function makeQuote(customerId: string, articleId: string, plainId: string, opts: { confirm?: boolean } = {}) {
  const address = await salesService.createDeliveryAddress(customerId, {
    label: "Werk 2",
    address: "Hauptstraße 1",
    postalCode: "10115",
    city: "Berlin",
    country: "DE",
    isDefault: false,
  });
  return salesService.createQuote(
    {
      customerId,
      confirm: opts.confirm ?? false,
      customerOrderNumber: "PO-4711",
      customerReference: "Ms Buyer",
      deliveryAddressId: address.id,
      rows: [
        { articleId, quantity: 1, unitPrice: 1234.5, discountPercent: 10 },
        { articleId: plainId, quantity: 2, unitPrice: 100 },
      ],
    },
    userId
  );
}

// --- quote and order confirmation -----------------------------------------

describe("quote and order confirmation in English", () => {
  it("prints the English title, labels, terms, unit, article texts, country and numbers — no Swedish fixed words", async () => {
    const base = await makeBaseData();
    const customer = await makeCustomer("en", base);
    const { order } = await makeQuote(customer.id, base.article.id, base.plain.id);

    const quote = await salesService.getSalesOrderPdf(order.id, "quote");
    dump(quote.filename, quote.content);
    expect(quote.filename).toBe(`Quotation-${order.orderNumber}.pdf`);
    const text = pdfText(quote.content);
    for (const part of [
      `Quotation ${order.orderNumber}`,
      "Date:",
      `Customer no.: ${customer.customerNumber}`,
      "Your order number: PO-4711",
      "Your reference: Ms Buyer",
      "CUSTOMER",
      "DELIVERY ADDRESS",
      "Germany",
      "Delivery terms: EXW · Ex Works",
      "Payment terms: 30 · 30 days net",
      "Item no.",
      "Description",
      "Qty",
      "Unit",
      "Unit price",
      "Discount",
      "Amount",
      "Sink unit 1200",
      "Brushed stainless steel",
      "pcs",
      "1,234.50", // the unit price, en-GB
      "1,111.05", // 1 234,50 × 0,9
      "10%", // the discount, English style
      "Total SEK",
      "Reg. no: 556000-0001",
      "VAT no: SE556000000101",
      "Registered office: Kiruna",
      "Approved for F-tax",
      "Bankgiro: 123-4567",
    ]) {
      expect(text).toContain(part);
    }
    // The article without English texts falls back to its Swedish name.
    expect(text).toContain("Underrede 600");
    expect(text).not.toContain("Diskbänk 1200");
    expect(text).not.toContain("Borstat rostfritt");
    expect(text).not.toContain("1 234,50");
    expect(text).not.toContain("10 %");
    expect(text).not.toMatch(/\dst/); // "1st" — the unit is pcs
    expect(text).not.toContain("Tyskland");
    expectEnglish(text);
    // The quote's validity line follows the language.
    if (order.quoteValidUntil) {
      expect(text).toContain(`This quotation is valid until ${order.quoteValidUntil}.`);
      expect(text).not.toContain("Offerten gäller");
    }

    // The order confirmation: same document, English title and filename.
    await salesService.confirm(order.id);
    const confirmed = (await salesService.getSalesOrder(order.id))!;
    const confirmation = await salesService.getSalesOrderPdf(order.id, "confirmation");
    dump(confirmation.filename, confirmation.content);
    expect(confirmation.filename).toBe(`Order-confirmation-${confirmed.orderNumber}.pdf`);
    const confirmationText = pdfText(confirmation.content);
    expect(confirmationText).toContain(`Order confirmation ${confirmed.orderNumber}`);
    expect(confirmationText).toContain(`Our quotation: ${order.orderNumber}`);
    expect(confirmationText).not.toContain("Orderbekräftelse");
    expect(confirmationText).not.toContain("Vår offert");
    expectEnglish(confirmationText);
  });

  it("a Swedish customer's quote is unchanged by the filled-in English fields", async () => {
    const base = await makeBaseData();
    const customer = await makeCustomer("sv", base);
    const { order } = await makeQuote(customer.id, base.article.id, base.plain.id);

    const quote = await salesService.getSalesOrderPdf(order.id, "quote");
    expect(quote.filename).toBe(`Offert-${order.orderNumber}.pdf`);
    const text = pdfText(quote.content);
    for (const part of [
      `Offert ${order.orderNumber}`,
      "Datum:",
      "KUND",
      "LEVERANSADRESS",
      "Tyskland",
      "Leveransvillkor: EXW · Från fabrik",
      "Betalningsvillkor: 30 · 30 dagar netto",
      "Benämning",
      "Antal",
      "Diskbänk 1200",
      "Borstat rostfritt stål",
      " st",
      "10 %",
      "Godkänd för F-skatt",
      "Org.nr: 556000-0001",
    ]) {
      expect(text).toContain(part);
    }
    for (const english of ["Sink unit", "Brushed", "pcs", "Ex Works", "Germany", "Quotation", "Approved for F-tax", "1,234.50"]) {
      expect(text).not.toContain(english);
    }
  });

  it("English document, English fields empty ⇒ the Swedish data texts with English labels", async () => {
    const base = await makeBaseData();
    await articleService.updateArticle(base.article.id, { nameEn: null, extraDescriptionEn: null });
    await registerService.deliveryTerms.update(base.deliveryTerm.id, { code: "EXW", name: "Från fabrik", nameEn: null } as never);
    await registerService.units.update(base.unit.id, { code: "st", name: "Styck", codeEn: null } as never);
    const customer = await makeCustomer("en", base);
    const { order } = await makeQuote(customer.id, base.article.id, base.plain.id);

    const text = pdfText((await salesService.getSalesOrderPdf(order.id, "quote")).content);
    expect(text).toContain("Quotation");
    expect(text).toContain("Diskbänk 1200");
    expect(text).toContain("Borstat rostfritt stål");
    expect(text).toContain("Delivery terms: EXW · Från fabrik");
    expect(text).toMatch(/\dst/);
    expect(text).not.toContain("pcs");
    expectEnglish(text);
  });
});

// --- invoice, credit note, reminder ---------------------------------------

describe("invoice, credit note and payment reminder in English", () => {
  async function issuedEnglishInvoice() {
    const base = await makeBaseData();
    const customer = await makeCustomer("en", base);
    const draft = await invoiceService.create(
      {
        customerId: customer.id,
        rows: [
          { articleId: base.article.id, description: "x", quantity: 1, unitPrice: 1234.5, vatRate: 25 },
          { description: "Installation on site", quantity: 1, unitPrice: 100, vatRate: 25 },
        ],
      },
      userId
    );
    const issued = (await invoiceService.issue(draft!.id, userId))!;
    return { base, customer, issued };
  }

  it("the issued invoice: English title, labels, VAT line, payment box, footer and number format; stays English when the customer turns Swedish", async () => {
    const { customer, issued } = await issuedEnglishInvoice();

    const { filename, content } = await invoiceService.renderPdf(issued.id);
    dump(filename, content);
    expect(filename).toBe(`Invoice-${issued.invoiceNumber}.pdf`);
    const text = pdfText(content);
    for (const part of [
      `Invoice ${issued.invoiceNumber}`,
      "Due date:",
      `Customer no.: ${customer.customerNumber}`,
      "INVOICE ADDRESS",
      "Sink unit 1200",
      "Brushed stainless steel",
      "Installation on site",
      "pcs",
      "1,234.50",
      "Total excl. VAT SEK",
      "1,334.50",
      "VAT (25%)",
      "333.63",
      "Amount due SEK",
      "1,668.13",
      "PAYMENT",
      `OCR number: ${issued.ocrNumber}`,
      "Bankgiro: 123-4567",
      "Approved for F-tax",
    ]) {
      expect(text).toContain(part);
    }
    expect(text).not.toContain("Moms (25 %)");
    expect(text).not.toContain("OCR-nummer");
    expect(text).not.toContain("BETALNING");
    expectEnglish(text);

    // The customer switches to Swedish: the archived invoice, a reprint and
    // the reminder are still in English (stamped language).
    await salesService.updateCustomer(customer.id, { language: "sv" });
    const reprint = await invoiceService.renderPdf(issued.id);
    expect(reprint.filename).toBe(`Invoice-${issued.invoiceNumber}.pdf`);
    expect(pdfText(reprint.content)).toContain(`Invoice ${issued.invoiceNumber}`);

    await invoiceService.sendReminder(issued.id, { to: "invoice@example.com", subject: "Reminder", message: "Please pay.", withFee: true }, userId);
    expect(sentMails).toHaveLength(1);
    const attachment = sentMails[0]!.attachments![0]!;
    dump(attachment.filename, attachment.content);
    expect(attachment.filename).toBe(`Payment-reminder-${issued.invoiceNumber}.pdf`);
    const reminder = pdfText(attachment.content);
    for (const part of [
      "Payment reminder 1",
      `Invoice ${issued.invoiceNumber}`,
      "Invoice date:",
      "Due date:",
      "INVOICE ADDRESS",
      "According to our records, the invoice below has not been paid. Please pay at your earliest convenience.",
      "Invoice amount incl. VAT SEK",
      "1,668.13",
      "Reminder fee",
      "Amount due SEK",
      "PAYMENT",
    ]) {
      expect(reminder).toContain(part);
    }
    expect(reminder).not.toContain("Betalningspåminnelse");
    expect(reminder).not.toContain("Påminnelseavgift");
    expect(reminder).not.toContain("Fakturabelopp");
    expectEnglish(reminder);
    // The archived reminder serves the same English bytes.
    const reminders = (await invoiceService.getInvoice(issued.id))!.reminders;
    const archived = await invoiceService.reminderPdf(issued.id, reminders[0]!.id);
    expect(archived.filename).toBe(`Payment-reminder-${issued.invoiceNumber}.pdf`);
    expect(pdfText(archived.content)).toContain("Payment reminder 1");
  });

  it("the credit note: 'Credit note', 'Credit note for invoice X' on its own line, negated en-GB amounts", async () => {
    const { issued } = await issuedEnglishInvoice();
    const credit = await invoiceService.createCredit(issued.id, {}, userId);
    const issuedCredit = (await invoiceService.issue(credit!.id, userId))!;

    const { filename, content } = await invoiceService.renderPdf(issuedCredit.id);
    dump(filename, content);
    expect(filename).toBe(`Credit-note-${issuedCredit.invoiceNumber}.pdf`);
    const text = pdfText(content);
    expect(text).toContain(`Credit note ${issuedCredit.invoiceNumber}`);
    expect(text).toContain(`Credit note for invoice ${issued.invoiceNumber}`);
    expect(text).not.toContain("Order number");
    expect(text).not.toContain("Krediterar");
    expect(text).not.toContain("Kreditfaktura");
    expect(text).toContain("-1,668.13");
    expect(text).toContain("Amount due SEK");
    expectEnglish(text);
  });

  it("an English invoice to an EU customer prints the English VAT code name and invoice text (fallback to Swedish when empty)", async () => {
    const base = await makeBaseData();
    const customer = await makeCustomer("en", base, { country: "DE", vatNumber: "DE123456789", name: "Kunde GmbH" });
    const draft = await invoiceService.create(
      { customerId: customer.id, rows: [{ articleId: base.article.id, description: "x", quantity: 1, unitPrice: 100 }] },
      userId
    );
    const issued = (await invoiceService.issue(draft!.id, userId))!;
    const text = pdfText((await invoiceService.renderPdf(issued.id)).content);
    // The seeded English texts of EUV (migration 0175's backfill).
    expect(text).toContain("Goods to another EU country");
    expect(text).toContain("Intra-Community supply (Article 138 of the VAT Directive)");
    expect(text).not.toContain("Unionsintern");
    expect(text).toContain(`Your VAT no.: DE123456789`);
    expectEnglish(text);

    // With the English texts cleared the Swedish ones print on the next
    // English invoice.
    await db.update(vatCodes).set({ nameEn: null, invoiceTextEn: null }).where(eq(vatCodes.code, "EUV"));
    const second = await invoiceService.create(
      { customerId: customer.id, rows: [{ articleId: base.article.id, description: "x", quantity: 1, unitPrice: 100 }] },
      userId
    );
    const secondIssued = (await invoiceService.issue(second!.id, userId))!;
    const secondText = pdfText((await invoiceService.renderPdf(secondIssued.id)).content);
    expect(secondText).toContain("Invoice ");
    expect(secondText).not.toContain("Goods to another EU country");
    expect(secondText).toContain("Varor till annat EU-land");
  });
});

// --- delivery note and pallet cards ---------------------------------------

describe("delivery note and the customer's pallet card in English", () => {
  async function deliver(language: "sv" | "en") {
    const base = await makeBaseData();
    const customer = await makeCustomer(language, base);
    const warehouse = await stockService.createWarehouse({ name: "Huvudlager", active: true });
    const location = await stockService.createLocation(parsed(createStockLocationSchema, { warehouseId: warehouse!.id, name: "A1", active: true }));
    for (const article of [base.article, base.plain]) {
      await stockService.recordTransaction({ articleId: article.id, locationId: location.id, quantityDelta: 10, transactionType: "inventory_adjustment" });
    }
    const { order, rows } = await makeQuote(customer.id, base.article.id, base.plain.id, { confirm: true });
    await salesService.startProduction(order.id);
    const result = await salesService.deliverBatch(
      order.id,
      { locationId: location.id, rows: rows.map((r) => ({ rowId: r.id, quantity: 1 })) },
      userId
    );
    return { base, customer, order, deliveryId: result.deliveryId, deliveryNumber: result.deliveryNumber };
  }

  it("the delivery note: English title, header lines, columns, article texts and unit", async () => {
    const { order, deliveryId, deliveryNumber } = await deliver("en");
    const { pdf: content, filename } = await salesService.deliveryNotePdf(deliveryId);
    dump(filename, content);
    expect(filename).toBe(`Delivery-note-${deliveryNumber}.pdf`);
    const text = pdfText(content);
    for (const part of [
      `Delivery note ${deliveryNumber}`,
      "Delivery date:",
      `Order number: ${order.orderNumber}`,
      "Customer: Customer Ltd",
      "Your order number: PO-4711",
      "Your reference: Ms Buyer",
      "Delivery address: Werk 2, Hauptstraße 1, 10115 Berlin, Germany",
      "Item",
      "Description",
      "Delivered",
      "Unit",
      "Prev. delivered",
      "Sink unit 1200",
      "Brushed stainless steel",
      "Underrede 600",
      "pcs",
    ]) {
      expect(text).toContain(part);
    }
    expect(text).not.toContain("Följesedel");
    expect(text).not.toContain("Kund:");
    expectEnglish(text);
  });

  it("the delivery pallet card: PALLET CARD · TO CUSTOMER, English cells and parcel line", async () => {
    const { order, deliveryId, deliveryNumber } = await deliver("en");
    const { pdf: content, filename } = await salesService.deliveryPalletCardPdf(deliveryId);
    dump(filename, content);
    expect(filename).toBe(`Pallet-card-${deliveryNumber}.pdf`);
    const text = pdfText(content);
    for (const part of [
      "PALLET CARD",
      "TO CUSTOMER",
      "ITEM NO.",
      "DESCRIPTION",
      "Sink unit 1200",
      "QUANTITY",
      "1 pcs",
      "Parcel 1 of 1",
      "CUSTOMER",
      "Customer Ltd",
      "DELIVERY ADDRESS",
      "Germany",
      "CUSTOMER'S ORDER NUMBER",
      "PO-4711",
      "OUR ORDER NUMBER",
      order.orderNumber,
      "DATE",
      "REFERENCE",
      deliveryNumber,
      "Page 1 of 2",
    ]) {
      expect(text).toContain(part);
    }
    for (const swedish of ["PALLKORT", "TILL KUND", "ARTIKELNUMMER", "BENÄMNING", "ANTAL", "Kolli", "KUNDENS ORDERNUMMER", "DATUM", "REFERENS", "Sida 1 av", "Tyskland"]) {
      expect(text).not.toContain(swedish);
    }
  });

  it("a Swedish customer's delivery note and pallet card are unchanged", async () => {
    const { deliveryId, deliveryNumber } = await deliver("sv");
    const note = await salesService.deliveryNotePdf(deliveryId);
    expect(note.filename).toBe(`foljesedel-${deliveryNumber}.pdf`);
    expect(pdfText(note.pdf)).toContain(`Följesedel ${deliveryNumber}`);
    expect(pdfText(note.pdf)).toContain("Diskbänk 1200");
    expect(pdfText(note.pdf)).not.toContain("Sink unit");
    const card = await salesService.deliveryPalletCardPdf(deliveryId);
    expect(card.filename).toBe(`pallkort-${deliveryNumber}.pdf`);
    expect(pdfText(card.pdf)).toContain("TILL KUND");
    expect(pdfText(card.pdf)).toContain("Kolli 1 av 1");
    expect(pdfText(card.pdf)).not.toContain("TO CUSTOMER");
  });

  it("the final pallet card of a KO-linked manufacturing order follows the customer; the internal card stays Swedish", async () => {
    const base = await makeBaseData();
    const customer = await makeCustomer("en", base);
    const workCenter = await mfgService.createWorkCenter(createWorkCenterSchema.parse({ code: "150", name: "Svets" }));
    for (const [sequenceNo, description] of [
      [10, "Kapning"],
      [20, "Montering"],
    ] as const) {
      await mfgService.createRoutingOperation(
        base.article.id,
        createRoutingOperationSchema.parse({ sequenceNo, description, workCenterId: workCenter.id, setupTime: 10, runTimePerUnit: 2 })
      );
    }
    const { order, rows } = await salesService.createQuote(
      { customerId: customer.id, confirm: true, customerOrderNumber: "PO-77", rows: [{ articleId: base.article.id, quantity: 10, unitPrice: 100 }] },
      userId
    );
    const mo = await mfgService.createManufacturingOrder({ quantity: 10, salesOrderRowId: rows[0]!.id }, null);
    const operations = (await mfgService.listOperations(mo.id)).sort((a, b) => a.sequenceNo - b.sequenceNo);

    const final = await mfgService.getOperationPalletCardPdf(mo.id, operations[1]!.id, [7]);
    expect(final.filename).toBe(`Pallet-card-${mo.orderNumber}-op20.pdf`);
    const finalText = pdfText(final.content);
    for (const part of ["PALLET CARD", "TO CUSTOMER", "Sink unit 1200", "7 pcs", "Parcel 1 of 1", "Customer Ltd", "PO-77", order.orderNumber, "OUR ORDER NUMBER"]) {
      expect(finalText).toContain(part);
    }
    expect(finalText).not.toContain("TILL KUND");
    expect(finalText).not.toContain("Diskbänk");

    const internal = await mfgService.getOperationPalletCardPdf(mo.id, operations[0]!.id, [3]);
    expect(internal.filename).toBe(`pallkort-${mo.orderNumber}-op10.pdf`);
    const internalText = pdfText(internal.content);
    for (const part of ["PALLKORT", "INTERNT", "Diskbänk 1200", "3 st", "Kolli 1 av 1", "TILLVERKNINGSORDER", "NÄSTA OPERATION", "20 · Montering"]) {
      expect(internalText).toContain(part);
    }
    expect(internalText).not.toContain("PALLET CARD");
    expect(internalText).not.toContain("Sink unit");
  });
});

// --- inquiry and purchase order -------------------------------------------

describe("request for quotation and purchase order in English", () => {
  async function englishSupplier(base: Awaited<ReturnType<typeof makeBaseData>>, language: "sv" | "en" = "en") {
    return purchaseService.createSupplier({
      name: language === "en" ? "Supplier GmbH" : "Leverantör AB",
      active: true,
      country: language === "en" ? "DE" : "SE",
      currency: language === "en" ? "EUR" : "SEK",
      language,
      address: "Industriestraße 5",
      postalCode: "80331",
      city: "München",
      deliveryTermId: base.deliveryTerm.id,
      paymentTermId: base.paymentTerm.id,
      ourCustomerNumber: "C-900",
    } as never);
  }

  it("the inquiry: English title, labels and unpriced rows; the purchase order: English title, references, total", async () => {
    const base = await makeBaseData();
    const supplier = await englishSupplier(base);
    const { inquiry } = await purchaseService.createInquiry(
      { supplierId: supplier.id, expectedDeliveryDate: "2030-01-15", rows: [{ articleId: base.article.id, quantity: 5 }, { articleId: base.plain.id, quantity: 2 }] },
      userId
    );
    const rfq = await purchaseService.getInquiryPdf(inquiry.id);
    dump(rfq.filename, rfq.content);
    expect(rfq.filename).toBe(`Request-for-quotation-${inquiry.inquiryNumber}.pdf`);
    const rfqText = pdfText(rfq.content);
    for (const part of [
      `Request for quotation ${inquiry.inquiryNumber}`,
      "Date:",
      "Requested delivery date: 2030-01-15",
      "Our customer number with you: C-900",
      "SUPPLIER",
      "Supplier GmbH",
      "Germany",
      "Delivery terms: EXW · Ex Works",
      "Payment terms: 30 · 30 days net",
      "Item no.",
      "Description",
      "Qty",
      "Unit price",
      "Sink unit 1200",
      "Brushed stainless steel",
      "Underrede 600",
      "pcs",
      "Approved for F-tax",
    ]) {
      expect(rfqText).toContain(part);
    }
    expect(rfqText).not.toContain("Förfrågan");
    expect(rfqText).not.toContain("Önskat leveransdatum");
    expect(rfqText).not.toContain("LEVERANTÖR");
    expect(rfqText).not.toContain("Vårt kundnummer hos er");
    expectEnglish(rfqText);

    const order = await purchaseService.createPurchaseOrder(
      { supplierId: supplier.id, expectedDeliveryDate: "2030-01-15", yourReference: "Herr Lieferant", ourReference: "Buyer" } as never,
      userId
    );
    await purchaseService.addRow(order.id, { articleId: base.article.id, quantity: 3, unitPrice: 1234.5 });
    const po = await purchaseService.getPurchaseOrderPdf(order.id);
    dump(po.filename, po.content);
    expect(po.filename).toBe(`Purchase-order-${order.orderNumber}.pdf`);
    const poText = pdfText(po.content);
    for (const part of [
      `Purchase order ${order.orderNumber}`,
      "Your reference: Herr Lieferant",
      "Our reference: Buyer",
      "Requested delivery date: 2030-01-15",
      "SUPPLIER",
      "Sink unit 1200",
      "pcs",
      "1,234.50",
      // Moms på inköpsordern: a German supplier charges no Swedish VAT
      // (IEUV25 derived from DE) — 0 % is printed, never an amount to pay.
      "Total excl. VAT EUR3,703.50",
      "VAT (0%)0.00",
      "Total incl. VAT EUR3,703.50",
    ]) {
      expect(poText).toContain(part);
    }
    expect(poText).not.toContain("Amount due");
    expect(poText).not.toContain("Inköpsorder");
    expect(poText).not.toContain("3 703,50");
    expectEnglish(poText);
  });

  it("a Swedish supplier's documents keep their Swedish texts and bare filenames", async () => {
    const base = await makeBaseData();
    const supplier = await englishSupplier(base, "sv");
    const { inquiry } = await purchaseService.createInquiry({ supplierId: supplier.id, rows: [{ articleId: base.article.id, quantity: 5 }] }, userId);
    const rfq = await purchaseService.getInquiryPdf(inquiry.id);
    expect(rfq.filename).toBe(`${inquiry.inquiryNumber}.pdf`);
    expect(pdfText(rfq.content)).toContain(`Förfrågan ${inquiry.inquiryNumber}`);
    expect(pdfText(rfq.content)).toContain("Diskbänk 1200");
    expect(pdfText(rfq.content)).toContain("Leveransvillkor: EXW · Från fabrik");
    expect(pdfText(rfq.content)).not.toContain("Sink unit");
    const order = await purchaseService.createPurchaseOrder(parsed(createPurchaseOrderSchema, { supplierId: supplier.id }), userId);
    await purchaseService.addRow(order.id, { articleId: base.article.id, quantity: 3, unitPrice: 10 });
    const po = await purchaseService.getPurchaseOrderPdf(order.id);
    expect(po.filename).toBe(`${order.orderNumber}.pdf`);
    expect(pdfText(po.content)).toContain(`Inköpsorder ${order.orderNumber}`);
  });
});

// --- deviation report -----------------------------------------------------

describe("the complaint notice (reklamationsbesked) in English", () => {
  it("follows the customer's language: English title, labels, article name, unit and decision; the internal report stays Swedish", async () => {
    const base = await makeBaseData();
    const customer = await makeCustomer("en", base);
    const complaint = await quality.create(
      {
        type: "customer",
        title: "Scratched sink",
        customerId: customer.id,
        counterpartyReference: "REK-77",
        articleId: base.article.id,
        quantity: 2,
        description: "Scratches on the top side",
        causeAnalysis: "Packaging",
        correctiveAction: "Replaced",
      },
      null,
      { seePrices: true }
    );
    await quality.update(complaint.id, { decision: "accepted" }, null, { seePrices: true });

    const { filename, content } = await quality.renderPdf(complaint.id, { details: true });
    dump(filename, content);
    expect(filename).toBe(`Complaint-notice-${complaint.deviationNumber}.pdf`);
    const text = pdfText(content);
    for (const part of [
      "Complaint notice",
      `Number: ${complaint.deviationNumber}`,
      "Date:",
      "Your reference: REK-77",
      "CUSTOMER",
      "Customer Ltd",
      "SUBJECT",
      "Scratched sink",
      "ITEM",
      "SB-1200 Sink unit 1200",
      "QUANTITY",
      "2 pcs",
      "DESCRIPTION",
      "ROOT CAUSE ANALYSIS",
      "CORRECTIVE ACTION",
      "DECISION",
      "Accepted",
      "Approved for F-tax",
    ]) {
      expect(text).toContain(part);
    }
    for (const swedish of ["Reklamationsbesked", "Nummer:", "Datum:", "Er referens", "ÄRENDE", "ARTIKEL", "ANTAL", "BESKRIVNING", "ORSAKSANALYS", "ÅTGÄRD", "BESLUT", "Godkänd", "Diskbänk", "2 st"]) {
      expect(text).not.toContain(swedish);
    }

    const internal = await quality.create({ type: "internal", title: "Sprucken svets", articleId: base.article.id, quantity: 1 }, null, { seePrices: true });
    const internalPdf = await quality.renderPdf(internal.id, { details: false });
    expect(internalPdf.filename).toBe(`Avvikelserapport-${internal.deviationNumber}.pdf`);
    const internalText = pdfText(internalPdf.content);
    expect(internalText).toContain("Avvikelserapport");
    expect(internalText).toContain("ÄRENDE");
    expect(internalText).toContain("SB-1200 Diskbänk 1200");
    expect(internalText).toContain("1 st");
  });
});

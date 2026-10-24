import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db, supplierInvoiceRows, vatCodes } from "@navet/db";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createSalesRepository } from "../src/modules/sales/repository/sales.repository.js";
import { createSalesService } from "../src/modules/sales/service/sales.service.js";
import { resolvePrice } from "../src/modules/sales/service/price-resolver.js";
import { createPurchaseRepository } from "../src/modules/purchase/repository/purchase.repository.js";
import { createPurchaseService } from "../src/modules/purchase/service/purchase.service.js";
import { createSupplierInvoiceRepository } from "../src/modules/purchase/repository/supplier-invoice.repository.js";
import { createSupplierInvoiceService } from "../src/modules/purchase/service/supplier-invoice.service.js";
import { InvalidVatCodeError } from "../src/modules/economy/service/document-vat-code.js";
import { createVerificationPoster } from "../src/modules/economy/service/verification-poster.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { createStockService } from "../src/modules/stock/service/stock.service.js";
import { createRegisterRepository } from "../src/modules/register/repository/register.repository.js";
import { createRegisterService } from "../src/modules/register/service/register.service.js";
import { createMailRepository } from "../src/modules/mail/repository/mail.repository.js";
import { createMailService } from "../src/modules/mail/service/mail.service.js";
import { createDocumentPdfService } from "../src/modules/mail/service/document-pdf.js";
import { createSystemRepository } from "../src/modules/system/repository/system.repository.js";
import { createSystemService } from "../src/modules/system/service/system.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { DEFAULT_POSTING_SETTINGS, setupPostingBaseline } from "./helpers/services.js";
import { resetVatCodes, vatCodeId } from "./helpers/vat-codes.js";

// Momskoder steg 2 (spec 4.6, 5): the customer's Omvänd betalningsskyldighet
// för byggtjänster and Momsbehandling, the supplier's Land and Momskod
// (förval), and the supplier invoice's momskoder (header and rows) with the
// förhandsvisning of omvänd moms.

const articleService = createArticleService(createArticleRepository(db));
const stockService = createStockService(createStockRepository(db));
const authRepo = createAuthRepository(db);
const registerService = createRegisterService(createRegisterRepository(db));
const systemService = createSystemService(createSystemRepository(db));
const mailService = createMailService(createMailRepository(db), systemService);
const documentPdfService = createDocumentPdfService(systemService);
const auditRepository = createAuditRepository(db);
const salesService = createSalesService(
  createSalesRepository(db),
  registerService,
  mailService,
  documentPdfService,
  stockService,
  articleService,
  systemService,
  (query) => resolvePrice(db, query),
  auditRepository
);
const purchaseService = createPurchaseService(
  createPurchaseRepository(db),
  registerService,
  mailService,
  documentPdfService,
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
  }
);
const supplierInvoiceService = createSupplierInvoiceService(
  createSupplierInvoiceRepository(db),
  createVerificationPoster({ read: async () => ({ ...DEFAULT_POSTING_SETTINGS }) }),
  auditRepository
);

const TRUNCATE = sql`TRUNCATE supplier_invoice_files, posting_rules, verification_rows, verifications, verification_counters, verification_series, accounting_periods, fiscal_years, accounts, supplier_invoice_rows, supplier_invoices, supplier_contacts, suppliers, invoice_rows, invoices, sales_order_rows, sales_orders, customers, bom_components, articles, audit_log, users CASCADE`;
const TODAY = new Date().toLocaleDateString("sv-SE");

let userId: string;

beforeEach(async () => {
  await db.execute(TRUNCATE);
  await resetVatCodes();
  await setupPostingBaseline();
  userId = (await authRepo.create({ email: `pvc-${crypto.randomUUID()}@example.com`, passwordHash: "x", name: "AP", role: "admin" })).id;
});

afterAll(async () => {
  await db.execute(TRUNCATE);
  await resetVatCodes();
});

describe("customers — Omvänd betalningsskyldighet för byggtjänster and Momsbehandling", () => {
  it("stores reverseChargeConstruction on create/PATCH and answers vatTreatment on every read", async () => {
    const created = await salesService.createCustomer({ name: "Bygg AB", active: true, reverseChargeConstruction: true } as never);
    expect(created.reverseChargeConstruction).toBe(true);
    expect(created.vatTreatment).toBe("domestic");

    const fetched = await salesService.getCustomer(created.id);
    expect(fetched!.reverseChargeConstruction).toBe(true);
    expect(fetched!.vatTreatment).toBe("domestic");

    const moved = await salesService.updateCustomer(created.id, { country: "DE", reverseChargeConstruction: false });
    expect(moved.reverseChargeConstruction).toBe(false);
    expect(moved.vatTreatment).toBe("domestic_no_vat_number");
    expect((await salesService.updateCustomer(created.id, { vatNumber: "DE123456789" })).vatTreatment).toBe("eu");
    expect((await salesService.updateCustomer(created.id, { country: "US" })).vatTreatment).toBe("export");
    expect((await salesService.updateCustomer(created.id, { country: "DK", privatePerson: true })).vatTreatment).toBe("private_eu");
    expect((await salesService.updateCustomer(created.id, { country: "NO" })).vatTreatment).toBe("private_export");
  });

  it("answers vatNumberWarning for an EU company customer whose number is another member state's, or no member state's", async () => {
    const created = await salesService.createCustomer({ name: "Kunde GmbH", active: true, country: "DE", vatNumber: "DE123456789" } as never);
    expect(created.vatNumberWarning).toBeNull();
    const other = await salesService.updateCustomer(created.id, { vatNumber: "ATU12345678" });
    expect(other.vatNumberWarning).toEqual({ reason: "eu_country_mismatch", prefix: "AT", expectedPrefix: "DE" });
    expect((await salesService.getCustomer(created.id))!.vatNumberWarning).toEqual(other.vatNumberWarning);
    expect((await salesService.updateCustomer(created.id, { vatNumber: "123456789" })).vatNumberWarning).toEqual({
      reason: "eu_format",
      expectedPrefix: "DE",
    });
    // Not an EU company customer: nothing to say.
    expect((await salesService.updateCustomer(created.id, { country: "SE" })).vatNumberWarning).toBeNull();
  });

  it("defaults reverseChargeConstruction to false", async () => {
    const created = await salesService.createCustomer({ name: "Kund AB", active: true } as never);
    expect(created.reverseChargeConstruction).toBe(false);
  });
});

describe("suppliers — Land and Momskod (förval)", () => {
  it("derives the default code from the country when the supplier has none", async () => {
    const se = await purchaseService.createSupplier({ name: "Svensk AB", currency: "SEK", active: true } as never);
    expect(se.country).toBe("SE");
    expect(se.defaultVatCodeId).toBeNull();
    expect(se.defaultVatCode).toEqual({ id: await vatCodeId("MP25"), code: "MP25", name: "Moms 25 %", rate: 25, derived: true });

    const de = await purchaseService.createSupplier({ name: "Lieferant GmbH", currency: "EUR", country: "DE", active: true } as never);
    expect((await purchaseService.getSupplier(de.id))!.defaultVatCode).toMatchObject({ code: "IEUV25", derived: true });

    const cn = await purchaseService.updateSupplier(de.id, { country: "CN" });
    expect(cn.country).toBe("CN");
    expect(cn.defaultVatCode).toMatchObject({ code: "IUTV", derived: true });
  });

  it("uses the supplier's own code, and clears it back to the derived one", async () => {
    const supplier = await purchaseService.createSupplier({
      name: "Tjänst Ltd",
      currency: "SEK",
      country: "GB",
      defaultVatCodeId: await vatCodeId("IUTT"),
      active: true,
    } as never);
    expect(supplier.defaultVatCode).toMatchObject({ code: "IUTT", rate: 25, derived: false });
    const cleared = await purchaseService.updateSupplier(supplier.id, { defaultVatCodeId: null });
    expect(cleared.defaultVatCode).toMatchObject({ code: "IUTV", derived: true });
  });

  it("keeps an own förval that was deactivated since when a PATCH leaves it unchanged, but refuses choosing it anew", async () => {
    const ieut = await vatCodeId("IEUT");
    const supplier = await purchaseService.createSupplier({
      name: "Tjänst GmbH",
      currency: "EUR",
      country: "DE",
      defaultVatCodeId: ieut,
      active: true,
    } as never);
    const other = await purchaseService.createSupplier({ name: "Annan GmbH", currency: "EUR", country: "DE", active: true } as never);
    await db.update(vatCodes).set({ active: false }).where(eq(vatCodes.code, "IEUT"));

    // The card sends the whole form back — the unchanged code must not lock it.
    const renamed = await purchaseService.updateSupplier(supplier.id, { name: "Tjänst GmbH & Co", defaultVatCodeId: ieut });
    expect(renamed.name).toBe("Tjänst GmbH & Co");
    expect(renamed.defaultVatCode).toMatchObject({ code: "IEUT", derived: false });
    // Another supplier cannot pick the inactive code.
    await expect(purchaseService.updateSupplier(other.id, { defaultVatCodeId: ieut })).rejects.toMatchObject({
      name: "InvalidVatCodeError",
      reason: "inactive",
    });
    // Nor can an unknown supplier id slip past the check.
    await expect(purchaseService.updateSupplier(crypto.randomUUID(), { defaultVatCodeId: ieut })).rejects.toMatchObject({
      reason: "inactive",
    });
  });

  it("refuses a sales, import, inactive or unknown code as the supplier's förval", async () => {
    const supplier = await purchaseService.createSupplier({ name: "Lev AB", currency: "SEK", active: true } as never);
    await expect(purchaseService.updateSupplier(supplier.id, { defaultVatCodeId: await vatCodeId("EUV") })).rejects.toMatchObject({
      name: "InvalidVatCodeError",
      reason: "not_applicable",
    });
    await expect(purchaseService.updateSupplier(supplier.id, { defaultVatCodeId: await vatCodeId("IMP25") })).rejects.toMatchObject({
      reason: "not_applicable",
    });
    await expect(purchaseService.updateSupplier(supplier.id, { defaultVatCodeId: crypto.randomUUID() })).rejects.toMatchObject({
      reason: "unknown",
    });
    await db.update(vatCodes).set({ active: false }).where(eq(vatCodes.code, "IEUT"));
    await expect(
      purchaseService.createSupplier({ name: "Ny", currency: "SEK", defaultVatCodeId: await vatCodeId("IEUT"), active: true } as never)
    ).rejects.toBeInstanceOf(InvalidVatCodeError);
  });
});

describe("supplier invoices — momskoder", () => {
  async function supplier(overrides: Record<string, unknown> = {}) {
    return purchaseService.createSupplier({ name: "Lev AB", currency: "SEK", active: true, ...overrides } as never);
  }

  it("starts from the supplier's förval (own or derived) and lets an explicit code win", async () => {
    const se = await supplier();
    const a = await supplierInvoiceService.create({ supplierId: se.id, invoiceNumber: "A-1", invoiceDate: TODAY, rows: [] } as never, userId);
    expect(a!.vatCode).toEqual({ id: await vatCodeId("MP25"), code: "MP25", name: "Moms 25 %", rate: 25 });

    const de = await supplier({ name: "Lieferant GmbH", country: "DE" });
    const b = await supplierInvoiceService.create({ supplierId: de.id, invoiceNumber: "B-1", invoiceDate: TODAY, rows: [] } as never, userId);
    expect(b!.vatCode.code).toBe("IEUV25");

    const own = await supplier({ name: "Bygg AB", defaultVatCodeId: await vatCodeId("IOBT") });
    const c = await supplierInvoiceService.create({ supplierId: own.id, invoiceNumber: "C-1", invoiceDate: TODAY, rows: [] } as never, userId);
    expect(c!.vatCode.code).toBe("IOBT");

    const explicit = await supplierInvoiceService.create(
      { supplierId: de.id, invoiceNumber: "B-2", invoiceDate: TODAY, vatCodeId: await vatCodeId("MF"), rows: [] } as never,
      userId
    );
    expect(explicit!.vatCode.code).toBe("MF");
  });

  it("stores the rows' own codes (null = the header's) and previews the omvänd moms per code", async () => {
    const de = await supplier({ name: "Lieferant GmbH", country: "DE" });
    const invoice = await supplierInvoiceService.create(
      {
        supplierId: de.id,
        invoiceNumber: "R-1",
        invoiceDate: TODAY,
        netAmount: 1500,
        vatAmount: 0,
        grossAmount: 1500,
        rows: [
          { description: "Plåt", quantity: 1, unitPrice: 1000 },
          { description: "Konsulttjänst", quantity: 1, unitPrice: 300, vatCodeId: await vatCodeId("IEUT") },
        ],
      } as never,
      userId
    );
    expect(invoice!.vatCode.code).toBe("IEUV25");
    expect(invoice!.rows.map((r) => r.vatCode?.code ?? null)).toEqual([null, "IEUT"]);
    expect(invoice!.rows[1]!.vatCode).toEqual({ id: await vatCodeId("IEUT"), code: "IEUT", name: "Inköp tjänster från EU 25 %", rate: 25 });
    // Header code takes the row without a code and the remainder (200 freight
    // typed only into the header): IEUV25 1200 ⇒ 300, IEUT 300 ⇒ 75.
    expect(invoice!.reverseVat).toEqual([
      { code: "IEUV25", base: 1200, vat: 300 },
      { code: "IEUT", base: 300, vat: 75 },
    ]);

    // A domestic invoice previews nothing.
    const se = await supplier();
    const domestic = await supplierInvoiceService.create(
      { supplierId: se.id, invoiceNumber: "D-1", invoiceDate: TODAY, netAmount: 100, vatAmount: 25, grossAmount: 125, rows: [] } as never,
      userId
    );
    expect(domestic!.reverseVat).toEqual([]);
  });

  it("warns (never refuses) about a domestic code with VAT but no momsbelopp, and a non-SEK supplier with land Sverige", async () => {
    // A German supplier wrongly left on Sverige: MP25 is derived, no VAT typed.
    const misfiled = await supplier({ name: "Lieferant GmbH", currency: "EUR" });
    const invoice = await supplierInvoiceService.create(
      { supplierId: misfiled.id, invoiceNumber: "W-1", invoiceDate: TODAY, netAmount: 1000, vatAmount: 0, grossAmount: 1000, rows: [] } as never,
      userId
    );
    expect(invoice!.vatCode.code).toBe("MP25");
    expect(invoice!.warnings).toEqual([
      "Momskoden MP25 har 25 % moms men fakturan har inget momsbelopp — kontrollera momskoden (utlandsköp ska ha en omvänd kod)",
      "Leverantören har annan valuta än SEK men land Sverige — kontrollera landet",
    ]);

    // A row with its own MP12 and the header on an omvänd code: the row is
    // what lacks VAT.
    const se = await supplier();
    const rowCoded = await supplierInvoiceService.create(
      {
        supplierId: se.id,
        invoiceNumber: "W-2",
        invoiceDate: TODAY,
        vatCodeId: await vatCodeId("IOBV"),
        netAmount: 1000,
        vatAmount: 0,
        grossAmount: 1000,
        rows: [
          { description: "Bygg", quantity: 1, unitPrice: 800 },
          { description: "Livsmedel", quantity: 1, unitPrice: 200, vatCodeId: await vatCodeId("MP12") },
        ],
      } as never,
      userId
    );
    expect(rowCoded!.warnings).toEqual([
      "Momskoden MP12 har 12 % moms men fakturan har inget momsbelopp — kontrollera momskoden (utlandsköp ska ha en omvänd kod)",
    ]);

    // In order: VAT typed, an omvänd code, MF, a zero net.
    for (const [number, extra] of [
      ["W-3", { netAmount: 1000, vatAmount: 250, grossAmount: 1250 }],
      ["W-4", { netAmount: 1000, vatAmount: 0, grossAmount: 1000, vatCodeId: await vatCodeId("IEUV25") }],
      ["W-5", { netAmount: 1000, vatAmount: 0, grossAmount: 1000, vatCodeId: await vatCodeId("MF") }],
      ["W-6", { netAmount: 0, vatAmount: 0, grossAmount: 0 }],
    ] as const) {
      const ok = await supplierInvoiceService.create(
        { supplierId: se.id, invoiceNumber: number, invoiceDate: TODAY, rows: [], ...extra } as never,
        userId
      );
      expect([number, ok!.warnings]).toEqual([number, []]);
    }
  });

  it("changes the header code in draft only and the rows' codes through the row endpoints", async () => {
    const se = await supplier();
    const invoice = await supplierInvoiceService.create(
      {
        supplierId: se.id,
        invoiceNumber: "P-1",
        invoiceDate: TODAY,
        netAmount: 1000,
        vatAmount: 0,
        grossAmount: 1000,
        rows: [{ description: "Rad", quantity: 1, unitPrice: 1000 }],
      } as never,
      userId
    );
    const patched = await supplierInvoiceService.updateHeader(invoice!.id, { vatCodeId: await vatCodeId("IOBV") }, userId);
    expect(patched!.vatCode.code).toBe("IOBV");
    expect(patched!.reverseVat).toEqual([{ code: "IOBV", base: 1000, vat: 250 }]);

    const rowId = invoice!.rows[0]!.id;
    await supplierInvoiceService.updateRow(invoice!.id, rowId, { vatCodeId: await vatCodeId("MF") });
    let [row] = await db.select().from(supplierInvoiceRows).where(eq(supplierInvoiceRows.id, rowId));
    expect(row!.vatCodeId).toBe(await vatCodeId("MF"));
    // An unrelated PATCH keeps it — even after the code was deactivated.
    await db.update(vatCodes).set({ active: false }).where(eq(vatCodes.code, "MF"));
    await supplierInvoiceService.updateRow(invoice!.id, rowId, { description: "Ny text" });
    [row] = await db.select().from(supplierInvoiceRows).where(eq(supplierInvoiceRows.id, rowId));
    expect(row!.vatCodeId).toBe(await vatCodeId("MF"));
    // null = back to following the header.
    await supplierInvoiceService.updateRow(invoice!.id, rowId, { vatCodeId: null });
    [row] = await db.select().from(supplierInvoiceRows).where(eq(supplierInvoiceRows.id, rowId));
    expect(row!.vatCodeId).toBeNull();

    const added = await supplierInvoiceService.addRow(invoice!.id, { description: "Extra", quantity: 1, unitPrice: 10, vatCodeId: await vatCodeId("IUTV") } as never);
    expect(added.vatCodeId).toBe(await vatCodeId("IUTV"));

    // Attest books the omvänd moms the preview showed, then the header is frozen.
    await supplierInvoiceService.updateHeader(invoice!.id, { netAmount: 1010, grossAmount: 1010 }, userId);
    const approved = await supplierInvoiceService.approve(invoice!.id, userId);
    expect(approved!.status).toBe("approved");
    await expect(supplierInvoiceService.updateHeader(invoice!.id, { vatCodeId: await vatCodeId("MP25") }, userId)).rejects.toThrow(
      /Cannot change a supplier invoice/
    );
  });

  it("refuses a sales code, an inactive code or an unknown code on the header and the rows", async () => {
    const se = await supplier();
    const base = { supplierId: se.id, invoiceDate: TODAY, rows: [] };
    await expect(
      supplierInvoiceService.create({ ...base, invoiceNumber: "X-1", vatCodeId: await vatCodeId("EUV") } as never, userId)
    ).rejects.toMatchObject({ name: "InvalidVatCodeError", reason: "not_applicable", document: "purchase" });
    await expect(
      supplierInvoiceService.create(
        { ...base, invoiceNumber: "X-2", rows: [{ description: "R", quantity: 1, unitPrice: 1, vatCodeId: crypto.randomUUID() }] } as never,
        userId
      )
    ).rejects.toMatchObject({ reason: "unknown" });
    await db.update(vatCodes).set({ active: false }).where(eq(vatCodes.code, "IEUV6"));
    await expect(
      supplierInvoiceService.create({ ...base, invoiceNumber: "X-3", vatCodeId: await vatCodeId("IEUV6") } as never, userId)
    ).rejects.toMatchObject({ reason: "inactive" });
    // A supplier whose own förval was deactivated since: the invoice says so
    // rather than silently taking another code.
    const stale = await supplier({ name: "Gammal", defaultVatCodeId: await vatCodeId("IEUV12") });
    await db.update(vatCodes).set({ active: false }).where(eq(vatCodes.code, "IEUV12"));
    await expect(
      supplierInvoiceService.create({ supplierId: stale.id, invoiceDate: TODAY, invoiceNumber: "X-4", rows: [] } as never, userId)
    ).rejects.toMatchObject({ reason: "inactive" });
  });
});

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { auditLog, db, numberSeries, systemSettings } from "@navet/db";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createPurchaseRepository } from "../src/modules/purchase/repository/purchase.repository.js";
import {
  createPurchaseService,
  DeliveryAddressNotFoundError,
  DuplicatePurchaseOrderRowError,
  DuplicateSupplierNumberError,
  InquiryNotFoundError,
  InvalidStatusTransitionError,
  OverReceiptError,
  PurchaseOrderNotFoundError,
  RowHasReceiptsError,
  SupplierNotFoundError,
} from "../src/modules/purchase/service/purchase.service.js";
import { PDFDocument } from "pdf-lib";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { createStockCountRepository } from "../src/modules/stock/repository/stock-count.repository.js";
import { createRegisterRepository } from "../src/modules/register/repository/register.repository.js";
import { createRegisterService, RegisterEntryNotFoundError } from "../src/modules/register/service/register.service.js";
import { createStockService, LocationUnderStockCountError } from "../src/modules/stock/service/stock.service.js";
import { createMailRepository } from "../src/modules/mail/repository/mail.repository.js";
import {
  createMailService,
  MailSendError,
  type MailTransportFactory,
} from "../src/modules/mail/service/mail.service.js";
import { createDocumentPdfService } from "../src/modules/mail/service/document-pdf.js";
import { pdfText } from "./helpers/pdf.js";
import { createSystemRepository } from "../src/modules/system/repository/system.repository.js";
import { createSystemService } from "../src/modules/system/service/system.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";

const articleService = createArticleService(createArticleRepository(db));
const stockService = createStockService(createStockRepository(db));
const stockCountRepo = createStockCountRepository(db);
const authRepo = createAuthRepository(db);
const registerService = createRegisterService(createRegisterRepository(db));
const auditRepository = createAuditRepository(db);

// Fake SMTP transport — records outgoing mails, fails on demand.
const sentMails: { to: string; subject: string; attachments?: { filename: string; content: Buffer }[] }[] = [];
let failNextSend = false;
const fakeTransportFactory: MailTransportFactory = () => ({
  async sendMail(opts) {
    if (failNextSend) {
      failNextSend = false;
      throw new Error("SMTP connection refused");
    }
    sentMails.push(opts);
  },
});

const systemService = createSystemService(createSystemRepository(db));
const mailService = createMailService(createMailRepository(db), systemService, fakeTransportFactory);
const documentPdfService = createDocumentPdfService(systemService);
const purchaseService = createPurchaseService(
  createPurchaseRepository(db),
  registerService,
  mailService,
  documentPdfService,
  articleService,
  systemService,
  // Lego (Etapp G): SubcontractOperationReporter — never reached in this
  // suite, and loud if it ever is.
  {
    reportOperationQuantities: async () => { throw new Error("SubcontractOperationReporter not wired in this test"); },
    assertMaterialBeforeSubcontractReceipt: async () => {},
    undoPurchaseReceiptReportInTx: async () => { throw new Error("SubcontractOperationReporter not wired in this test"); },
    updateRoutingOperation: async () => { throw new Error("RoutingPriceWriter not wired in this test"); },
  },
  auditRepository
);

beforeEach(async () => {
  await db.execute(
    sql`TRUNCATE email_log, audit_log, inquiry_rows, inquiries, purchase_order_rows, purchase_orders, supplier_contacts, supplier_delivery_addresses, suppliers, delivery_terms, payment_terms, carriers, stock_transactions, stock_locations, warehouses, bom_components, articles, users CASCADE`
  );
  sentMails.length = 0;
  failNextSend = false;
  // SMTP configured — individual tests blank the host to probe the
  // not-configured path.
  await systemService.updateSettings({ smtpHost: "smtp.test.local", smtpFromEmail: "erp@test.local" });
  // Tillåten överleverans at its default (0 %) — system_settings survives the
  // truncate, and anything else (a test, a manual check against erp_test)
  // may have left a value behind.
  await db.delete(systemSettings).where(eq(systemSettings.key, "purchase_over_receipt_percent"));
});

afterAll(async () => {
  await db.execute(
    sql`TRUNCATE email_log, audit_log, inquiry_rows, inquiries, purchase_order_rows, purchase_orders, supplier_contacts, supplier_delivery_addresses, suppliers, delivery_terms, payment_terms, carriers, stock_transactions, stock_locations, warehouses, bom_components, articles, users CASCADE`
  );
});

// Bypasses authService.register (bootstrap-only, one admin) since these
// tests only need a valid user id for createdBy — not auth policy itself.
async function makeUser() {
  return authRepo.create({
    email: `buyer-${crypto.randomUUID()}@example.com`,
    passwordHash: "not-a-real-hash",
    name: "Buyer",
    role: "admin",
  });
}

async function makeSupplier() {
  return purchaseService.createSupplier({ name: "ACME AB", active: true });
}

async function makeArticle(articleNumber: string) {
  return articleService.createArticle({ articleNumber, name: articleNumber, type: "purchased", unit: "st", active: true });
}

async function makeLocation() {
  const warehouse = await stockService.createWarehouse({ name: "Huvudlager", active: true });
  return stockService.createLocation({ warehouseId: warehouse.id, name: "A1", active: true });
}

async function makeOrderWithRow(quantity = 10) {
  const user = await makeUser();
  const supplier = await makeSupplier();
  const article = await makeArticle(`ART-PO-${crypto.randomUUID()}`);
  const location = await makeLocation();
  const order = await purchaseService.createPurchaseOrder({ supplierId: supplier.id }, user.id);
  const row = await purchaseService.addRow(order.id, { articleId: article.id, quantity, unitPrice: 42 });
  return { user, supplier, article, location, order, row };
}

describe("purchase service — order lifecycle", () => {
  it("creates a supplier, a draft order and a row on it", async () => {
    const { order, row } = await makeOrderWithRow(10);

    expect(order.status).toBe("draft");
    expect(order.orderNumber.startsWith("IO-")).toBe(true);
    expect(row.quantityOrdered).toBe("10.0000");
    expect(row.quantityReceived).toBe("0.0000");
  });

  it("allows adding rows through partially_received but blocks once fully received", async () => {
    const { order, row, location, user } = await makeOrderWithRow(10);
    // One article per row — the row table has a unique (order, article) index.
    const articleB = await makeArticle(`ART-PO-${crypto.randomUUID()}`);
    const articleC = await makeArticle(`ART-PO-${crypto.randomUUID()}`);
    const articleD = await makeArticle(`ART-PO-${crypto.randomUUID()}`);
    await purchaseService.confirm(order.id);

    // Editable statuses: confirmed and partially_received both accept new rows.
    await purchaseService.addRow(order.id, { articleId: articleB.id, quantity: 1, unitPrice: 1 });
    await purchaseService.receiveGoods(order.id, row.id, { locationId: location.id, quantity: 4 }, user.id);
    await purchaseService.addRow(order.id, { articleId: articleC.id, quantity: 2, unitPrice: 1 });

    // Receive everything → the order locks.
    const rows = await purchaseService.listRows(order.id);
    for (const r of rows) {
      const remaining = Number(r.quantityOrdered) - Number(r.quantityReceived);
      if (remaining > 0) {
        await purchaseService.receiveGoods(order.id, r.id, { locationId: location.id, quantity: remaining }, user.id);
      }
    }
    await expect(
      purchaseService.addRow(order.id, { articleId: articleD.id, quantity: 1, unitPrice: 1 })
    ).rejects.toThrow(InvalidStatusTransitionError);
  });

  it("refuses the same article twice on an order with a domain error, not the raw unique violation", async () => {
    const { order, article } = await makeOrderWithRow(10);
    await expect(purchaseService.addRow(order.id, { articleId: article.id, quantity: 1, unitPrice: 1 })).rejects.toThrow(
      DuplicatePurchaseOrderRowError
    );
    expect(await purchaseService.listRows(order.id)).toHaveLength(1);
  });

  it("allows cancel from draft and from confirmed", async () => {
    const draftOrder = await makeOrderWithRow(5).then((r) => r.order);
    const cancelledDraft = await purchaseService.cancel(draftOrder.id);
    expect(cancelledDraft?.status).toBe("cancelled");

    const { order: confirmedOrder } = await makeOrderWithRow(5);
    await purchaseService.confirm(confirmedOrder.id);
    const cancelledConfirmed = await purchaseService.cancel(confirmedOrder.id);
    expect(cancelledConfirmed?.status).toBe("cancelled");
  });

  it("blocks cancel once anything has been received", async () => {
    const { order, row, location, user } = await makeOrderWithRow(10);
    await purchaseService.confirm(order.id);
    await purchaseService.receiveGoods(order.id, row.id, { locationId: location.id, quantity: 1 }, user.id);

    await expect(purchaseService.cancel(order.id)).rejects.toThrow(InvalidStatusTransitionError);
  });
});

describe("purchase service — goods receipt", () => {
  it("moves to partially_received on a partial delivery, then received once fully covered", async () => {
    const { order, row, location, user } = await makeOrderWithRow(10);
    await purchaseService.confirm(order.id);

    const first = await purchaseService.receiveGoods(order.id, row.id, { locationId: location.id, quantity: 4 }, user.id);
    expect(first.orderStatus).toBe("partially_received");
    expect(first.row.quantityReceived).toBe("4.0000");

    const second = await purchaseService.receiveGoods(order.id, row.id, { locationId: location.id, quantity: 6 }, user.id);
    expect(second.orderStatus).toBe("received");
    expect(second.row.quantityReceived).toBe("10.0000");
  });

  it("rejects receiving more than what remains on the row", async () => {
    const { order, row, location, user } = await makeOrderWithRow(10);
    await purchaseService.confirm(order.id);
    await purchaseService.receiveGoods(order.id, row.id, { locationId: location.id, quantity: 8 }, user.id);

    await expect(
      purchaseService.receiveGoods(order.id, row.id, { locationId: location.id, quantity: 3 }, user.id)
    ).rejects.toThrow(OverReceiptError);
  });

  describe("Tillåten överleverans (purchaseOverReceiptPercent)", () => {
    // system_settings survives the per-test truncate — every case removes the
    // key again so the rest of the run sees the default (0 %).
    async function withOverReceiptPercent(percent: number | null, run: () => Promise<void>) {
      await systemService.updateSettings({ purchaseOverReceiptPercent: percent });
      try {
        await run();
      } finally {
        await db.delete(systemSettings).where(eq(systemSettings.key, "purchase_over_receipt_percent"));
      }
    }

    it("stops at the ordered quantity by default, carrying the limit on the error", async () => {
      const { order, row, location, user } = await makeOrderWithRow(10);
      await purchaseService.confirm(order.id);

      const err = await purchaseService
        .receiveGoods(order.id, row.id, { locationId: location.id, quantity: 10.5 }, user.id)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(OverReceiptError);
      expect((err as OverReceiptError).limit).toEqual({ allowedPercent: 0, maxQuantity: 10 });
    });

    it("accepts a receipt up to ordered × (1 + percent) and rejects one past it", async () => {
      await withOverReceiptPercent(10, async () => {
        const { order, row, location, user } = await makeOrderWithRow(10);
        await purchaseService.confirm(order.id);
        await purchaseService.receiveGoods(order.id, row.id, { locationId: location.id, quantity: 6 }, user.id);

        const err = await purchaseService
          .receiveGoods(order.id, row.id, { locationId: location.id, quantity: 5.5 }, user.id)
          .catch((e: unknown) => e);
        expect(err).toBeInstanceOf(OverReceiptError);
        expect((err as OverReceiptError).limit).toEqual({ allowedPercent: 10, maxQuantity: 11 });

        // Exactly on the limit (10 × 1.1 is 11.000000000000002 in floats).
        const result = await purchaseService.receiveGoods(order.id, row.id, { locationId: location.id, quantity: 5 }, user.id);
        expect(result.row.quantityReceived).toBe("11.0000");
        expect(result.orderStatus).toBe("received");

        const [balance] = [
          ...(await db.execute<{ q: string }>(
            sql`SELECT coalesce(sum(quantity_delta), 0)::text AS q FROM stock_transactions WHERE reference_id = ${order.id}`
          )),
        ];
        expect(Number(balance!.q)).toBe(11);
      });
    });

    it("has no limit when the setting is cleared (null)", async () => {
      await withOverReceiptPercent(null, async () => {
        const { order, row, location, user } = await makeOrderWithRow(10);
        await purchaseService.confirm(order.id);
        const result = await purchaseService.receiveGoods(order.id, row.id, { locationId: location.id, quantity: 250 }, user.id);
        expect(result.row.quantityReceived).toBe("250.0000");
        expect(result.orderStatus).toBe("received");
      });
    });

    it("still refuses a row edit below the over-received quantity", async () => {
      await withOverReceiptPercent(null, async () => {
        const { order, row, location, user } = await makeOrderWithRow(10);
        await purchaseService.confirm(order.id);
        const articleB = await makeArticle(`ART-PO-${crypto.randomUUID()}`);
        // A second, open row keeps the order editable (partially_received).
        await purchaseService.addRow(order.id, { articleId: articleB.id, quantity: 1, unitPrice: 1 });
        await purchaseService.receiveGoods(order.id, row.id, { locationId: location.id, quantity: 12 }, user.id);

        await expect(purchaseService.updateRow(order.id, row.id, { quantity: 11 })).rejects.toThrow(OverReceiptError);
        const updated = await purchaseService.updateRow(order.id, row.id, { quantity: 12 });
        expect(updated.row.quantityOrdered).toBe("12.0000");
      });
    });
  });

  it("rejects receiving against a draft order", async () => {
    const { order, row, location, user } = await makeOrderWithRow(10);

    await expect(
      purchaseService.receiveGoods(order.id, row.id, { locationId: location.id, quantity: 1 }, user.id)
    ).rejects.toThrow(InvalidStatusTransitionError);
  });

  it("records a stock_transactions row and reflects it in stock_balances", async () => {
    const { order, row, article, location, user } = await makeOrderWithRow(10);
    await purchaseService.confirm(order.id);
    await purchaseService.receiveGoods(order.id, row.id, { locationId: location.id, quantity: 7 }, user.id);

    const balances = await stockService.getBalances({ articleId: article.id, limit: 50, offset: 0 });
    expect(balances.rows).toHaveLength(1);
    expect(balances.rows[0]?.quantityOnHand).toBe("7.0000");
  });

  it("refuses a receipt against a location under a blocking count", async () => {
    const { order, row, location, user } = await makeOrderWithRow(10);
    await purchaseService.confirm(order.id);
    await stockCountRepo.createSession({ locationId: location.id, blocksTransactions: true }, null);

    await expect(
      purchaseService.receiveGoods(order.id, row.id, { locationId: location.id, quantity: 1 }, user.id)
    ).rejects.toBeInstanceOf(LocationUnderStockCountError);
  });
});

describe("purchase service — closing", () => {
  it("closes an order only once fully received", async () => {
    const { order, row, location, user } = await makeOrderWithRow(5);
    await purchaseService.confirm(order.id);

    await expect(purchaseService.close(order.id)).rejects.toThrow(InvalidStatusTransitionError);

    await purchaseService.receiveGoods(order.id, row.id, { locationId: location.id, quantity: 5 }, user.id);
    const closed = await purchaseService.close(order.id);
    expect(closed?.status).toBe("closed");
  });
});

describe("purchase service — currency", () => {
  it("defaults to SEK / exchange rate 1 when the supplier doesn't specify a currency", async () => {
    const user = await makeUser();
    const supplier = await purchaseService.createSupplier({ name: "Svensk Leverantör AB", active: true });

    const order = await purchaseService.createPurchaseOrder({ supplierId: supplier.id }, user.id);

    expect(order.currency).toBe("SEK");
    expect(order.exchangeRate).toBe("1.000000");
  });

  it("snapshots the supplier's currency onto the order at creation", async () => {
    const user = await makeUser();
    const supplier = await purchaseService.createSupplier({ name: "Deutsche Lieferant GmbH", currency: "EUR", active: true });

    const order = await purchaseService.createPurchaseOrder(
      { supplierId: supplier.id, exchangeRate: 11.5 },
      user.id
    );

    expect(order.currency).toBe("EUR");
    expect(order.exchangeRate).toBe("11.500000");
  });

  it("throws SupplierNotFoundError for a missing supplier", async () => {
    const user = await makeUser();
    const fakeId = "00000000-0000-0000-0000-000000000000";

    await expect(purchaseService.createPurchaseOrder({ supplierId: fakeId }, user.id)).rejects.toThrow(
      SupplierNotFoundError
    );
  });
});

describe("purchase service — order list filters", () => {
  it("filters purchase orders by supplierId, combined with status", async () => {
    const user = await makeUser();
    const s1 = await purchaseService.createSupplier({ name: "Filter S1", active: true });
    const s2 = await purchaseService.createSupplier({ name: "Filter S2", active: true });
    const article = await makeArticle(`ART-SF-${crypto.randomUUID()}`);
    const o1 = await purchaseService.createPurchaseOrder({ supplierId: s1.id }, user.id);
    await purchaseService.addRow(o1.id, { articleId: article.id, quantity: 1, unitPrice: 1 });
    await purchaseService.confirm(o1.id);
    await purchaseService.createPurchaseOrder({ supplierId: s2.id }, user.id);

    const forS1 = await purchaseService.listPurchaseOrders({ supplierId: s1.id, limit: 50, offset: 0 });
    expect(forS1.total).toBe(1);
    expect(forS1.rows[0]?.supplierId).toBe(s1.id);

    const confirmedForS1 = await purchaseService.listPurchaseOrders({
      supplierId: s1.id,
      status: ["confirmed"],
      limit: 50,
      offset: 0,
    });
    expect(confirmedForS1.total).toBe(1);
    const draftForS1 = await purchaseService.listPurchaseOrders({
      supplierId: s1.id,
      status: ["draft"],
      limit: 50,
      offset: 0,
    });
    expect(draftForS1.total).toBe(0);
  });

  it("search also matches an order's article number/benämning, not just order number/leverantör", async () => {
    const user = await makeUser();
    const supplier = await purchaseService.createSupplier({ name: "Artikelsök AB", active: true });
    const article = await articleService.createArticle({
      articleNumber: `ART-SEARCH-${crypto.randomUUID()}`,
      name: `Söktermbenämning-${crypto.randomUUID()}`,
      type: "purchased",
      unit: "st",
      active: true,
    });
    const matching = await purchaseService.createPurchaseOrder({ supplierId: supplier.id }, user.id);
    await purchaseService.addRow(matching.id, { articleId: article.id, quantity: 1, unitPrice: 1 });
    // No matching row — must not be found by an article-only search term.
    const unrelated = await purchaseService.createPurchaseOrder({ supplierId: supplier.id }, user.id);

    const byNumber = await purchaseService.listPurchaseOrders({
      search: article.articleNumber,
      limit: 50,
      offset: 0,
    });
    expect(byNumber.rows.map((r) => r.id)).toEqual([matching.id]);

    const byName = await purchaseService.listPurchaseOrders({ search: article.name, limit: 50, offset: 0 });
    expect(byName.rows.map((r) => r.id)).toEqual([matching.id]);

    expect(byNumber.rows.map((r) => r.id)).not.toContain(unrelated.id);
  });

  it("withOpenRows adds an accurate openRowCount, and costs nothing when omitted", async () => {
    const { order, row, location, user } = await makeOrderWithRow(10);
    await purchaseService.confirm(order.id);
    // Partially received — the row still has 6 open.
    await purchaseService.receiveGoods(order.id, row.id, { locationId: location.id, quantity: 4 }, user.id);

    const withoutFlag = await purchaseService.listPurchaseOrders({
      search: order.orderNumber,
      limit: 50,
      offset: 0,
    });
    expect(withoutFlag.rows[0]).not.toHaveProperty("openRowCount");

    const withFlag = await purchaseService.listPurchaseOrders({
      search: order.orderNumber,
      withOpenRows: true,
      limit: 50,
      offset: 0,
    });
    expect(withFlag.rows[0]?.openRowCount).toBe(1);

    // Fully receive the row — it no longer counts as open.
    await purchaseService.receiveGoods(order.id, row.id, { locationId: location.id, quantity: 6 }, user.id);
    const afterFullyReceived = await purchaseService.listPurchaseOrders({
      search: order.orderNumber,
      withOpenRows: true,
      limit: 50,
      offset: 0,
    });
    expect(afterFullyReceived.rows[0]?.openRowCount).toBe(0);
  });
});

describe("purchase — editable suppliers", () => {
  it("updates supplier fields and 404s on unknown ids", async () => {
    const supplier = await makeSupplier();
    const updated = await purchaseService.updateSupplier(supplier.id, {
      name: "Stål & Plåt AB",
      phone: "0383-123 45",
      currency: "EUR",
    });
    expect(updated.name).toBe("Stål & Plåt AB");
    expect(updated.currency).toBe("EUR");

    await expect(purchaseService.updateSupplier(crypto.randomUUID(), { name: "X" })).rejects.toBeInstanceOf(
      SupplierNotFoundError
    );
  });

  it("rejects changing a supplier's number to one already taken, own unchanged number is fine", async () => {
    const a = await purchaseService.createSupplier({ name: "Lev F", supplierNumber: "NUM-A", active: true });
    await purchaseService.createSupplier({ name: "Lev G", supplierNumber: "NUM-B", active: true });

    await expect(purchaseService.updateSupplier(a.id, { supplierNumber: "NUM-B" })).rejects.toThrow(
      DuplicateSupplierNumberError
    );

    // PATCH:ing the supplier's own unchanged number is a no-op, not a duplicate.
    const same = await purchaseService.updateSupplier(a.id, { supplierNumber: "NUM-A", name: "Lev F2" });
    expect(same.supplierNumber).toBe("NUM-A");
    expect(same.name).toBe("Lev F2");
  });

  it("finds suppliers by supplier number in the list search", async () => {
    await purchaseService.createSupplier({ name: "Söklev AB", supplierNumber: "SOKNUM-42", active: true });
    await purchaseService.createSupplier({ name: "Annan AB", active: true });

    const hit = await purchaseService.listSuppliers({ search: "soknum", limit: 50, offset: 0 });
    expect(hit.total).toBe(1);
    expect(hit.rows[0]!.supplierNumber).toBe("SOKNUM-42");
  });
});

describe("purchase service — supplier card fields", () => {
  it("stores address, terms and carrier references", async () => {
    const term = await registerService.paymentTerms.create({ code: "30", name: "30 dagar netto" });
    const supplier = await purchaseService.createSupplier({
      name: "Kortleverantör AB",
      postalCode: "421 44",
      city: "Västra Frölunda",
      orgNumber: "556111-0002",
      vatNumber: "SE556111000201",
      paymentTermId: term.id,
      currency: "SEK",
      active: true,
    });
    expect(supplier.city).toBe("Västra Frölunda");

    const found = await purchaseService.getSupplier(supplier.id);
    expect(found?.paymentTermCode).toBe("30");
    expect(found?.paymentTermName).toBe("30 dagar netto");
  });

  it("rejects an unknown carrier reference", async () => {
    const supplier = await purchaseService.createSupplier({ name: "Lev utan spedit", currency: "SEK", active: true });
    await expect(
      purchaseService.updateSupplier(supplier.id, { carrierId: "00000000-0000-0000-0000-000000000000" })
    ).rejects.toThrow(RegisterEntryNotFoundError);
  });
});

describe("purchase service — supplier contacts", () => {
  it("creates, lists (primary first) and moves the primary flag", async () => {
    const supplier = await purchaseService.createSupplier({ name: "Kontaktlev AB", currency: "SEK", active: true });
    const first = await purchaseService.createSupplierContact(supplier.id, { name: "Sune Säljare", isPrimary: true });
    const second = await purchaseService.createSupplierContact(supplier.id, {
      name: "Alva Order",
      mobile: "072-999 88 77",
      isPrimary: false,
    });

    let list = await purchaseService.listSupplierContacts(supplier.id);
    expect(list.map((c) => c.name)).toEqual(["Sune Säljare", "Alva Order"]);

    await purchaseService.updateSupplierContact(supplier.id, second.id, { isPrimary: true });
    list = await purchaseService.listSupplierContacts(supplier.id);
    expect(list.filter((c) => c.isPrimary).map((c) => c.id)).toEqual([second.id]);
    expect(list.find((c) => c.id === first.id)?.isPrimary).toBe(false);
  });

  it("404s for an unknown supplier", async () => {
    await expect(
      purchaseService.createSupplierContact("00000000-0000-0000-0000-000000000000", { name: "X", isPrimary: false })
    ).rejects.toThrow(SupplierNotFoundError);
  });
});

// Etapp C: leveransadresser på leverantörskortet — mirrors sales
// service's "delivery addresses" suite for customers.
describe("purchase service — supplier delivery addresses", () => {
  it("creates, lists, updates and deletes delivery addresses on a supplier", async () => {
    const supplier = await makeSupplier();

    const created = await purchaseService.createSupplierDeliveryAddress(supplier.id, {
      label: "Huvudlager",
      address: "Lagervägen 1",
      postalCode: "123 45",
      city: "Göteborg",
      isDefault: true,
    });
    expect(created.isDefault).toBe(true);

    await purchaseService.createSupplierDeliveryAddress(supplier.id, {
      label: "Filial Nord",
      address: "Norrvägen 2",
      isDefault: false,
    });

    const list = await purchaseService.listSupplierDeliveryAddresses(supplier.id);
    expect(list).toHaveLength(2);
    // Default first, then by label.
    expect(list[0]!.label).toBe("Huvudlager");

    const updated = await purchaseService.updateSupplierDeliveryAddress(supplier.id, created.id, { city: "Mölndal" });
    expect(updated.city).toBe("Mölndal");

    await purchaseService.deleteSupplierDeliveryAddress(supplier.id, created.id);
    expect(await purchaseService.listSupplierDeliveryAddresses(supplier.id)).toHaveLength(1);
  });

  it("keeps at most one default — setting a new default demotes the old one", async () => {
    const supplier = await makeSupplier();
    const first = await purchaseService.createSupplierDeliveryAddress(supplier.id, {
      label: "A",
      address: "Gata 1",
      isDefault: true,
    });
    const second = await purchaseService.createSupplierDeliveryAddress(supplier.id, {
      label: "B",
      address: "Gata 2",
      isDefault: true,
    });

    const list = await purchaseService.listSupplierDeliveryAddresses(supplier.id);
    expect(list.find((a) => a.id === first.id)!.isDefault).toBe(false);
    expect(list.find((a) => a.id === second.id)!.isDefault).toBe(true);

    // Promoting via PATCH demotes as well.
    await purchaseService.updateSupplierDeliveryAddress(supplier.id, first.id, { isDefault: true });
    const after = await purchaseService.listSupplierDeliveryAddresses(supplier.id);
    expect(after.find((a) => a.id === first.id)!.isDefault).toBe(true);
    expect(after.find((a) => a.id === second.id)!.isDefault).toBe(false);
  });

  it("scopes addresses to their supplier (404 across suppliers)", async () => {
    const supplier = await makeSupplier();
    const other = await purchaseService.createSupplier({ name: "Annan Lev AB", active: true });
    const address = await purchaseService.createSupplierDeliveryAddress(supplier.id, {
      label: "A",
      address: "Gata 1",
      isDefault: false,
    });

    await expect(
      purchaseService.updateSupplierDeliveryAddress(other.id, address.id, { city: "Fel" })
    ).rejects.toThrow(DeliveryAddressNotFoundError);
    await expect(purchaseService.deleteSupplierDeliveryAddress(other.id, address.id)).rejects.toThrow(
      DeliveryAddressNotFoundError
    );
    await expect(purchaseService.listSupplierDeliveryAddresses(crypto.randomUUID())).rejects.toThrow(
      SupplierNotFoundError
    );
  });
});

describe("purchase service — inquiries (förfrågan)", () => {
  async function makeInquiry() {
    const user = await makeUser();
    const supplier = await makeSupplier();
    const article = await makeArticle(`ART-INQ-${crypto.randomUUID()}`);
    const { inquiry, rows } = await purchaseService.createInquiry(
      { supplierId: supplier.id, rows: [{ articleId: article.id, quantity: 25 }] },
      user.id
    );
    return { user, supplier, article, inquiry, rows };
  }

  it("creates an inquiry with an FO number and priceless rows", async () => {
    const { inquiry, rows } = await makeInquiry();
    expect(inquiry.inquiryNumber).toMatch(/^FO-\d+$/);
    expect(inquiry.status).toBe("draft");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.unitPrice).toBeNull();
  });

  it("walks the full flow draft → sent → answered → ordered with rows copied", async () => {
    const { user, inquiry, article, rows } = await makeInquiry();

    await purchaseService.sendInquiry(inquiry.id);
    await purchaseService.markInquiryAnswered(inquiry.id);
    // Supplier answered: fill in the price before converting.
    await purchaseService.updateInquiryRow(inquiry.id, rows[0]!.id, { unitPrice: 12.5 });

    const order = await purchaseService.convertInquiryToOrder(inquiry.id, user.id);
    expect(order.orderNumber).toMatch(/^IO-\d+$/);
    expect(order.status).toBe("draft");

    const after = await purchaseService.getInquiry(inquiry.id);
    expect(after?.status).toBe("ordered");
    expect(after?.purchaseOrderId).toBe(order.id);
    expect(after?.purchaseOrderNumber).toBe(order.orderNumber);

    const orderRows = await purchaseService.listRows(order.id);
    expect(orderRows).toHaveLength(1);
    expect(orderRows[0]?.articleId).toBe(article.id);
    expect(Number(orderRows[0]?.quantityOrdered)).toBe(25);
    expect(Number(orderRows[0]?.unitPrice)).toBe(12.5);
  });

  it("converts an unanswered price to 0 on the purchase order", async () => {
    const { user, inquiry } = await makeInquiry();
    await purchaseService.sendInquiry(inquiry.id);
    const order = await purchaseService.convertInquiryToOrder(inquiry.id, user.id);
    const orderRows = await purchaseService.listRows(order.id);
    expect(Number(orderRows[0]?.unitPrice)).toBe(0);
  });

  it("rejects invalid transitions", async () => {
    const { user, inquiry } = await makeInquiry();

    // draft → answered and draft → ordered are not allowed
    await expect(purchaseService.markInquiryAnswered(inquiry.id)).rejects.toThrow(InvalidStatusTransitionError);
    await expect(purchaseService.convertInquiryToOrder(inquiry.id, user.id)).rejects.toThrow(
      InvalidStatusTransitionError
    );

    await purchaseService.sendInquiry(inquiry.id);
    // sent → sent is not allowed
    await expect(purchaseService.sendInquiry(inquiry.id)).rejects.toThrow(InvalidStatusTransitionError);

    await purchaseService.convertInquiryToOrder(inquiry.id, user.id);
    // ordered is terminal: no cancel, no re-convert
    await expect(purchaseService.cancelInquiry(inquiry.id)).rejects.toThrow(InvalidStatusTransitionError);
    await expect(purchaseService.convertInquiryToOrder(inquiry.id, user.id)).rejects.toThrow(
      InvalidStatusTransitionError
    );
  });

  it("freezes rows after ordering and scopes row ids to their inquiry", async () => {
    const { user, inquiry, rows } = await makeInquiry();
    await purchaseService.sendInquiry(inquiry.id);
    await purchaseService.convertInquiryToOrder(inquiry.id, user.id);
    await expect(purchaseService.updateInquiryRow(inquiry.id, rows[0]!.id, { quantity: 1 })).rejects.toThrow(
      InvalidStatusTransitionError
    );

    const other = await makeInquiry();
    await expect(
      purchaseService.updateInquiryRow(other.inquiry.id, rows[0]!.id, { quantity: 1 })
    ).rejects.toThrow(/not found/);
  });

  it("cancels from draft and lists with status filter", async () => {
    const { inquiry } = await makeInquiry();
    await purchaseService.cancelInquiry(inquiry.id);

    const cancelled = await purchaseService.listInquiries({ status: ["cancelled"], limit: 50, offset: 0 });
    expect(cancelled.total).toBe(1);
    expect(cancelled.rows[0]?.id).toBe(inquiry.id);

    await expect(purchaseService.listInquiryRows("00000000-0000-0000-0000-000000000000")).rejects.toThrow(
      InquiryNotFoundError
    );
  });
});

describe("purchase service — document email", () => {
  async function makeInquiry() {
    const user = await makeUser();
    const supplier = await makeSupplier();
    const article = await makeArticle(`ART-MAIL-${crypto.randomUUID()}`);
    const { inquiry } = await purchaseService.createInquiry(
      { supplierId: supplier.id, rows: [{ articleId: article.id, quantity: 5 }] },
      user.id
    );
    return { user, supplier, article, inquiry };
  }

  const sendInput = { to: "leverantor@example.com", subject: "Förfrågan", message: "Se bilaga" };

  it("emails a draft inquiry with a PDF attachment and marks it sent", async () => {
    const { inquiry } = await makeInquiry();

    const updated = await purchaseService.sendInquiryEmail(inquiry.id, sendInput);
    expect(updated?.status).toBe("sent");

    expect(sentMails).toHaveLength(1);
    expect(sentMails[0]?.to).toBe("leverantor@example.com");
    expect(sentMails[0]?.attachments?.[0]?.filename).toBe(`${inquiry.inquiryNumber}.pdf`);
    expect(sentMails[0]?.attachments?.[0]?.content.subarray(0, 4).toString()).toBe("%PDF");

    const log = await mailService.listEmailLog({ documentId: inquiry.id, limit: 50, offset: 0 });
    expect(log.total).toBe(1);
    expect(log.rows[0]?.status).toBe("sent");
    expect(log.rows[0]?.documentType).toBe("inquiry");
  });

  it("resends an already-sent inquiry without a new transition", async () => {
    const { inquiry } = await makeInquiry();
    await purchaseService.sendInquiryEmail(inquiry.id, sendInput);

    const resent = await purchaseService.sendInquiryEmail(inquiry.id, sendInput);
    expect(resent?.status).toBe("sent");
    expect(sentMails).toHaveLength(2);
  });

  it("refuses to email ordered or cancelled inquiries", async () => {
    const { inquiry } = await makeInquiry();
    await purchaseService.cancelInquiry(inquiry.id);

    await expect(purchaseService.sendInquiryEmail(inquiry.id, sendInput)).rejects.toThrow(
      InvalidStatusTransitionError
    );
    expect(sentMails).toHaveLength(0);
  });

  it("keeps the draft status and logs a failed row when SMTP errors", async () => {
    const { inquiry } = await makeInquiry();
    failNextSend = true;

    await expect(purchaseService.sendInquiryEmail(inquiry.id, sendInput)).rejects.toThrow(MailSendError);

    const after = await purchaseService.getInquiry(inquiry.id);
    expect(after?.status).toBe("draft");

    const log = await mailService.listEmailLog({ documentId: inquiry.id, limit: 50, offset: 0 });
    expect(log.total).toBe(1);
    expect(log.rows[0]?.status).toBe("failed");
    expect(log.rows[0]?.error).toContain("SMTP connection refused");
  });

  it("emails a draft purchase order and confirms it; resends don't re-transition", async () => {
    const { order } = await makeOrderWithRow(3);

    const confirmed = await purchaseService.sendPurchaseOrderEmail(order.id, sendInput);
    expect(confirmed?.status).toBe("confirmed");
    expect(sentMails[0]?.attachments?.[0]?.filename).toBe(`${order.orderNumber}.pdf`);

    const resent = await purchaseService.sendPurchaseOrderEmail(order.id, sendInput);
    expect(resent?.status).toBe("confirmed");
    expect(sentMails).toHaveLength(2);
  });

  it("refuses to email a cancelled purchase order", async () => {
    const { order } = await makeOrderWithRow(3);
    await purchaseService.cancel(order.id);

    await expect(purchaseService.sendPurchaseOrderEmail(order.id, sendInput)).rejects.toThrow(
      InvalidStatusTransitionError
    );
  });
});

// articles.rounding (Avrundning): the service rounds the BASE quantity up to
// the article's step on IO rows and RFQ rows, on create and on PATCH.
describe("purchase service — Avrundning on rows", () => {
  async function makeRoundedArticle(rounding: number) {
    return articleService.createArticle({
      articleNumber: `ART-RND-${crypto.randomUUID()}`,
      name: "Rundad artikel",
      type: "purchased",
      unit: "st",
      rounding,
      active: true,
    });
  }

  it("rounds purchase-order row quantities up on addRow and updateRow", async () => {
    const user = await makeUser();
    const supplier = await makeSupplier();
    const article = await makeRoundedArticle(5);
    const order = await purchaseService.createPurchaseOrder({ supplierId: supplier.id }, user.id);

    const row = await purchaseService.addRow(order.id, { articleId: article.id, quantity: 12, unitPrice: 42 });
    expect(row.quantityOrdered).toBe("15.0000");

    const patched = await purchaseService.updateRow(order.id, row.id, { quantity: 16 });
    expect(patched.row.quantityOrdered).toBe("20.0000");

    const priceOnly = await purchaseService.updateRow(order.id, row.id, { unitPrice: 43 });
    expect(priceOnly.row.quantityOrdered).toBe("20.0000");
  });

  it("supports fractional steps", async () => {
    const user = await makeUser();
    const supplier = await makeSupplier();
    // 7.38 kg bars: 100 kg → 14 bars = 103.32 kg.
    const article = await makeRoundedArticle(7.38);
    const order = await purchaseService.createPurchaseOrder({ supplierId: supplier.id }, user.id);
    const row = await purchaseService.addRow(order.id, { articleId: article.id, quantity: 100, unitPrice: 20 });
    expect(row.quantityOrdered).toBe("103.3200");
  });

  it("rounds inquiry (förfrågan) row quantities on create and on PATCH", async () => {
    const user = await makeUser();
    const supplier = await makeSupplier();
    const article = await makeRoundedArticle(5);

    const { inquiry, rows } = await purchaseService.createInquiry(
      { supplierId: supplier.id, rows: [{ articleId: article.id, quantity: 12 }] },
      user.id
    );
    expect(rows[0]!.quantity).toBe("15.0000");

    const patched = await purchaseService.updateInquiryRow(inquiry.id, rows[0]!.id, { quantity: 21 });
    expect(patched.quantity).toBe("25.0000");
  });
});

describe("purchase service — row editing", () => {
  it("updates quantity and price on a confirmed order", async () => {
    const { order, row } = await makeOrderWithRow(10);
    await purchaseService.confirm(order.id);

    const result = await purchaseService.updateRow(order.id, row.id, { quantity: 7, unitPrice: 55.5 });
    expect(result.row.quantityOrdered).toBe("7.0000");
    expect(result.row.unitPrice).toBe("55.5000");
    expect(result.orderStatus).toBe("confirmed");
  });

  it("refuses a quantity below what's already received", async () => {
    const { order, row, location, user } = await makeOrderWithRow(10);
    await purchaseService.confirm(order.id);
    await purchaseService.receiveGoods(order.id, row.id, { locationId: location.id, quantity: 4 }, user.id);

    await expect(purchaseService.updateRow(order.id, row.id, { quantity: 3 })).rejects.toThrow(OverReceiptError);
  });

  it("completes a partially received order when the quantity is lowered to what's received", async () => {
    const { order, row, location, user } = await makeOrderWithRow(10);
    await purchaseService.confirm(order.id);
    await purchaseService.receiveGoods(order.id, row.id, { locationId: location.id, quantity: 4 }, user.id);

    const result = await purchaseService.updateRow(order.id, row.id, { quantity: 4 });
    expect(result.orderStatus).toBe("received");
    expect((await purchaseService.getPurchaseOrder(order.id))?.status).toBe("received");
  });

  it("deletes an untouched row but refuses one with receipts", async () => {
    const { order, row, location, user } = await makeOrderWithRow(10);
    const articleB = await makeArticle(`ART-PO-${crypto.randomUUID()}`);
    await purchaseService.confirm(order.id);
    const extraRow = await purchaseService.addRow(order.id, { articleId: articleB.id, quantity: 5, unitPrice: 2 });
    await purchaseService.receiveGoods(order.id, row.id, { locationId: location.id, quantity: 4 }, user.id);

    await expect(purchaseService.deleteRow(order.id, row.id)).rejects.toThrow(RowHasReceiptsError);
    await purchaseService.deleteRow(order.id, extraRow.id);
    expect(await purchaseService.listRows(order.id)).toHaveLength(1);
  });

  it("locks rows on cancelled orders and 404s for foreign rows", async () => {
    const { order, row } = await makeOrderWithRow(10);
    const { order: otherOrder } = await makeOrderWithRow(5);
    await purchaseService.cancel(order.id);

    await expect(purchaseService.updateRow(order.id, row.id, { quantity: 2 })).rejects.toThrow(
      InvalidStatusTransitionError
    );
    // Row ids are scoped to their order.
    await expect(purchaseService.updateRow(otherOrder.id, row.id, { quantity: 2 })).rejects.toThrow(
      "not found"
    );
  });
});

describe("purchase service — drawings in order email", () => {
  const PNG_1PX = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64"
  );

  it("attaches the articles' drawings when asked, document first", async () => {
    const { order, article } = await makeOrderWithRow(3);
    await articleService.addFile(article.id, {
      filename: "ritning.png",
      contentType: "image/png",
      data: PNG_1PX,
    });

    await purchaseService.sendPurchaseOrderEmail(order.id, {
      to: "lev@example.com",
      subject: "Order",
      message: "Se bilagor",
      attachDrawings: true,
    });

    const attachments = sentMails[0]?.attachments ?? [];
    expect(attachments.map((a) => a.filename)).toEqual([`${order.orderNumber}.pdf`, "ritning.png"]);
  });

  it("sends only the document when drawings are opted out", async () => {
    const { order, article } = await makeOrderWithRow(3);
    await articleService.addFile(article.id, {
      filename: "ritning.png",
      contentType: "image/png",
      data: PNG_1PX,
    });

    await purchaseService.sendPurchaseOrderEmail(order.id, {
      to: "lev@example.com",
      subject: "Order",
      message: "Utan ritningar",
      attachDrawings: false,
    });

    expect(sentMails[0]?.attachments).toHaveLength(1);
  });
});

describe("purchase service — document terms (villkor)", () => {
  async function makeSupplierWithTerms() {
    const deliveryTerm = await registerService.deliveryTerms.create({ code: "CIP", name: "CIP Göteborg" });
    const paymentTerm = await registerService.paymentTerms.create({ code: "N30", name: "30 dagar netto" });
    const carrier = await registerService.carriers.create({ code: "DHL", name: "DHL Freight" });
    const supplier = await purchaseService.createSupplier({
      name: "Villkor AB",
      active: true,
      deliveryTermId: deliveryTerm.id,
      paymentTermId: paymentTerm.id,
      carrierId: carrier.id,
    });
    return { supplier, deliveryTerm, paymentTerm, carrier };
  }

  it("snapshots the supplier's terms onto a new purchase order and inquiry", async () => {
    const user = await makeUser();
    const { supplier, deliveryTerm, paymentTerm, carrier } = await makeSupplierWithTerms();
    const article = await makeArticle(`ART-TERM-${crypto.randomUUID()}`);

    const order = await purchaseService.createPurchaseOrder({ supplierId: supplier.id }, user.id);
    const fetchedOrder = await purchaseService.getPurchaseOrder(order.id);
    expect(fetchedOrder!.deliveryTermId).toBe(deliveryTerm.id);
    expect(fetchedOrder!.paymentTermId).toBe(paymentTerm.id);
    expect(fetchedOrder!.carrierId).toBe(carrier.id);
    expect(fetchedOrder!.deliveryTermCode).toBe("CIP");

    const { inquiry } = await purchaseService.createInquiry(
      { supplierId: supplier.id, rows: [{ articleId: article.id, quantity: 1 }] },
      user.id
    );
    const fetchedInquiry = await purchaseService.getInquiry(inquiry.id);
    expect(fetchedInquiry!.deliveryTermId).toBe(deliveryTerm.id);
    expect(fetchedInquiry!.carrierCode).toBe("DHL");
  });

  it("leaves terms null when the supplier has none", async () => {
    const user = await makeUser();
    const supplier = await makeSupplier();
    const order = await purchaseService.createPurchaseOrder({ supplierId: supplier.id }, user.id);
    expect(order.deliveryTermId).toBeNull();
    expect(order.paymentTermId).toBeNull();
    expect(order.carrierId).toBeNull();
  });

  it("carries the inquiry's terms to the purchase order on convert", async () => {
    const user = await makeUser();
    const { supplier, paymentTerm } = await makeSupplierWithTerms();
    const article = await makeArticle(`ART-TERM-${crypto.randomUUID()}`);
    const { inquiry } = await purchaseService.createInquiry(
      { supplierId: supplier.id, rows: [{ articleId: article.id, quantity: 2 }] },
      user.id
    );
    // Change one term on the inquiry, then convert — the order should get
    // the inquiry's terms, not the supplier's.
    const otherTerm = await registerService.deliveryTerms.create({ code: "EXW", name: "Ex Works" });
    await purchaseService.updateInquiryHeader(inquiry.id, { deliveryTermId: otherTerm.id });
    await purchaseService.sendInquiry(inquiry.id);
    const order = await purchaseService.convertInquiryToOrder(inquiry.id, user.id);
    expect(order.deliveryTermId).toBe(otherTerm.id);
    expect(order.paymentTermId).toBe(paymentTerm.id);
  });

  it("updates PO header terms while editable but refuses after received/cancelled", async () => {
    const { order, row, location, user } = await makeOrderWithRow(5);
    const term = await registerService.deliveryTerms.create({ code: "FCA", name: "Free Carrier" });

    const updated = await purchaseService.updatePurchaseOrderHeader(order.id, { deliveryTermId: term.id });
    expect(updated!.deliveryTermCode).toBe("FCA");

    // Unknown register id → 404-style error.
    await expect(
      purchaseService.updatePurchaseOrderHeader(order.id, { carrierId: crypto.randomUUID() })
    ).rejects.toThrow(RegisterEntryNotFoundError);

    await purchaseService.confirm(order.id);
    await purchaseService.receiveGoods(order.id, row.id, { locationId: location.id, quantity: 5 }, user.id);
    await expect(
      purchaseService.updatePurchaseOrderHeader(order.id, { deliveryTermId: null })
    ).rejects.toThrow(InvalidStatusTransitionError);
  });

  it("updates PO header fields (delivery date, exchange rate, references, note)", async () => {
    const { order } = await makeOrderWithRow(5);

    const updated = await purchaseService.updatePurchaseOrderHeader(order.id, {
      expectedDeliveryDate: "2026-08-15",
      exchangeRate: 11.25,
      yourReference: "Anna Andersson",
      ourReference: "Ubbe",
      note: "Ring före leverans",
    });
    expect(updated!.expectedDeliveryDate).toBe("2026-08-15");
    expect(updated!.exchangeRate).toBe("11.250000");
    expect(updated!.yourReference).toBe("Anna Andersson");
    expect(updated!.ourReference).toBe("Ubbe");
    expect(updated!.note).toBe("Ring före leverans");

    // Nulling clears the optional fields; the exchange rate stays.
    const cleared = await purchaseService.updatePurchaseOrderHeader(order.id, {
      expectedDeliveryDate: null,
      yourReference: null,
    });
    expect(cleared!.expectedDeliveryDate).toBeNull();
    expect(cleared!.yourReference).toBeNull();
    expect(cleared!.ourReference).toBe("Ubbe");
    expect(cleared!.exchangeRate).toBe("11.250000");
  });

  it("stores references given at order creation", async () => {
    const user = await makeUser();
    const supplier = await makeSupplier();
    const order = await purchaseService.createPurchaseOrder(
      { supplierId: supplier.id, yourReference: "Anna Andersson", ourReference: "Ubbe" },
      user.id
    );
    expect(order.yourReference).toBe("Anna Andersson");
    expect(order.ourReference).toBe("Ubbe");
  });

  it("bumps the revision on content changes but not on status transitions or receipts", async () => {
    const { order, row, location, user } = await makeOrderWithRow(10);
    // makeOrderWithRow creates the order (rev 1) and adds one row (bump → 2).
    expect((await purchaseService.getPurchaseOrder(order.id))!.revision).toBe(2);

    await purchaseService.updatePurchaseOrderHeader(order.id, { ourReference: "Ubbe" });
    expect((await purchaseService.getPurchaseOrder(order.id))!.revision).toBe(3);

    await purchaseService.updateRow(order.id, row.id, { quantity: 8 });
    expect((await purchaseService.getPurchaseOrder(order.id))!.revision).toBe(4);

    // One row per article per order — the extra row needs its own article.
    const otherArticle = await makeArticle(`ART-REV-${crypto.randomUUID()}`);
    const extra = await purchaseService.addRow(order.id, { articleId: otherArticle.id, quantity: 1, unitPrice: 1 });
    await purchaseService.deleteRow(order.id, extra.id);
    expect((await purchaseService.getPurchaseOrder(order.id))!.revision).toBe(6);

    // Status transitions and receipts leave the revision untouched.
    await purchaseService.confirm(order.id);
    await purchaseService.receiveGoods(order.id, row.id, { locationId: location.id, quantity: 2 }, user.id);
    expect((await purchaseService.getPurchaseOrder(order.id))!.revision).toBe(6);

    // A rejected row edit (quantity below received) does not bump either.
    await expect(purchaseService.updateRow(order.id, row.id, { quantity: 1 })).rejects.toThrow();
    expect((await purchaseService.getPurchaseOrder(order.id))!.revision).toBe(6);
  });

  it("saves without bumping the revision when bumpRevision is false", async () => {
    const { order, row } = await makeOrderWithRow(10);
    // makeOrderWithRow creates the order (rev 1) and adds one row (bump → 2).
    expect((await purchaseService.getPurchaseOrder(order.id))!.revision).toBe(2);

    await purchaseService.updatePurchaseOrderHeader(order.id, { ourReference: "Ubbe", bumpRevision: false });
    await purchaseService.updateRow(order.id, row.id, { quantity: 8, bumpRevision: false });
    const otherArticle = await makeArticle(`ART-NOBUMP-${crypto.randomUUID()}`);
    const extra = await purchaseService.addRow(order.id, {
      articleId: otherArticle.id,
      quantity: 1,
      unitPrice: 1,
      bumpRevision: false,
    });
    await purchaseService.deleteRow(order.id, extra.id, false);

    const after = await purchaseService.getPurchaseOrder(order.id);
    expect(after!.revision).toBe(2);
    // The edits themselves went through.
    expect(after!.ourReference).toBe("Ubbe");
    expect((await purchaseService.listRows(order.id)).length).toBe(1);
  });

  it("sets any status manually, in any direction, without bumping the revision", async () => {
    const { order } = await makeOrderWithRow(5);
    await purchaseService.cancel(order.id);
    expect((await purchaseService.getPurchaseOrder(order.id))!.status).toBe("cancelled");

    // Cancelled is terminal for the state machine — the manual override
    // deliberately ignores that.
    const revived = await purchaseService.setStatus(order.id, "confirmed");
    expect(revived!.status).toBe("confirmed");

    const closed = await purchaseService.setStatus(order.id, "closed");
    expect(closed!.status).toBe("closed");
    const reopened = await purchaseService.setStatus(order.id, "draft");
    expect(reopened!.status).toBe("draft");
    expect(reopened!.revision).toBe(2); // creation + one row, nothing more
  });

  it("merges several purchase orders into one PDF in the given order (NOTES.md #9)", async () => {
    const { order: first } = await makeOrderWithRow(2);
    const { order: second } = await makeOrderWithRow(3);
    const [a, b] = await Promise.all([purchaseService.getPurchaseOrderPdf(first.id), purchaseService.getPurchaseOrderPdf(second.id)]);
    const pagesOf = async (buffer: Buffer) => (await PDFDocument.load(buffer)).getPageCount();

    const merged = await purchaseService.getPurchaseOrdersPdf([second.id, first.id]);
    expect(merged.filename).toBe("inkopsordrar-2-st.pdf");
    expect(await pagesOf(merged.content)).toBe((await pagesOf(a.content)) + (await pagesOf(b.content)));
    const text = pdfText(merged.content);
    expect(text.indexOf(second.orderNumber)).toBeGreaterThan(-1);
    expect(text.indexOf(second.orderNumber)).toBeLessThan(text.indexOf(first.orderNumber));

    // An unknown id fails the whole batch — nothing is silently dropped.
    await expect(purchaseService.getPurchaseOrdersPdf([first.id, crypto.randomUUID()])).rejects.toBeInstanceOf(
      PurchaseOrderNotFoundError
    );
  });

  it("prints article/drawing revisions on the PO PDF only when the setting is on", async () => {
    const { order, article } = await makeOrderWithRow(2);
    await articleService.createRevision(article.id, { revision: "B", isActive: false });
    const drawing = await articleService.createDrawing(article.id, { drawingNumber: "4711" });
    await articleService.createDrawingRevision(article.id, drawing.id, { revision: "C", isActive: false });

    // system_settings is not truncated between tests — set both states
    // explicitly and leave the flag off afterwards.
    await systemService.updateSettings({ showRevisionsOnDocuments: false });
    const off = await purchaseService.getPurchaseOrderPdf(order.id);
    expect(pdfText(off.content)).not.toContain("Ritn 4711");

    await systemService.updateSettings({ showRevisionsOnDocuments: true });
    try {
      const on = await purchaseService.getPurchaseOrderPdf(order.id);
      expect(pdfText(on.content)).toContain("Rev B · Ritn 4711 rev C");
    } finally {
      await systemService.updateSettings({ showRevisionsOnDocuments: false });
    }
  });

  it("prints Er/Vår referens on the purchase order PDF", async () => {
    const { order } = await makeOrderWithRow(2);
    await purchaseService.updatePurchaseOrderHeader(order.id, {
      yourReference: "Anna Andersson",
      ourReference: "Ubbe",
    });

    const { content } = await purchaseService.getPurchaseOrderPdf(order.id);
    const text = pdfText(content);
    expect(text).toContain("Er referens: Anna Andersson");
    expect(text).toContain("Vår referens: Ubbe");
    // Created (rev 1) + one row + the header update above = rev 3, printed
    // directly after the order number in the document title.
    expect(text).toContain(`${order.orderNumber} / 3`);
  });

  it("prints the order revision after the order number only when the setting is on", async () => {
    const { order } = await makeOrderWithRow(2); // rev 2

    // system_settings is not truncated between tests — the setting defaults
    // on; turn it off and restore afterwards.
    await systemService.updateSettings({ showOrderRevisionOnDocuments: false });
    try {
      const off = await purchaseService.getPurchaseOrderPdf(order.id);
      expect(pdfText(off.content)).toContain(order.orderNumber);
      expect(pdfText(off.content)).not.toContain(`${order.orderNumber} / `);
    } finally {
      await systemService.updateSettings({ showOrderRevisionOnDocuments: true });
    }

    const on = await purchaseService.getPurchaseOrderPdf(order.id);
    expect(pdfText(on.content)).toContain(`${order.orderNumber} / 2`);
  });

  it("updates inquiry header terms until ordered", async () => {
    const user = await makeUser();
    const supplier = await makeSupplier();
    const article = await makeArticle(`ART-TERM-${crypto.randomUUID()}`);
    const { inquiry } = await purchaseService.createInquiry(
      { supplierId: supplier.id, rows: [{ articleId: article.id, quantity: 1 }] },
      user.id
    );
    const term = await registerService.paymentTerms.create({ code: "N10", name: "10 dagar netto" });
    const updated = await purchaseService.updateInquiryHeader(inquiry.id, { paymentTermId: term.id });
    expect(updated!.paymentTermCode).toBe("N10");

    await purchaseService.sendInquiry(inquiry.id);
    await purchaseService.convertInquiryToOrder(inquiry.id, user.id);
    await expect(
      purchaseService.updateInquiryHeader(inquiry.id, { paymentTermId: null })
    ).rejects.toThrow(InvalidStatusTransitionError);
  });

  it("renders the PO PDF with terms set", async () => {
    const user = await makeUser();
    const { supplier } = await makeSupplierWithTerms();
    const article = await makeArticle(`ART-TERM-${crypto.randomUUID()}`);
    const order = await purchaseService.createPurchaseOrder({ supplierId: supplier.id }, user.id);
    await purchaseService.addRow(order.id, { articleId: article.id, quantity: 1, unitPrice: 10 });
    const { content } = await purchaseService.getPurchaseOrderPdf(order.id);
    expect(content.subarray(0, 4).toString()).toBe("%PDF");
  });

  it("prints our carrier customer number on the PO only when freight is on our account", async () => {
    const user = await makeUser();
    const carrier = await registerService.carriers.create({ code: "DHLX", name: "DHL Express" });
    await systemService.addCompanyCarrier({ carrierId: carrier.id, customerNumber: "ACME-999" });
    const supplier = await purchaseService.createSupplier({ name: "Fraktlev AB", active: true, carrierId: carrier.id });
    const article = await makeArticle(`ART-FR-${crypto.randomUUID()}`);
    const order = await purchaseService.createPurchaseOrder({ supplierId: supplier.id }, user.id);
    await purchaseService.addRow(order.id, { articleId: article.id, quantity: 1, unitPrice: 10 });

    // Off by default → the carrier prints but not our customer number.
    let text = pdfText((await purchaseService.getPurchaseOrderPdf(order.id)).content);
    expect(text).toContain("DHL Express");
    expect(text).not.toContain("Vårt kundnr");

    // "Frakt på vårt konto" on → our number is printed next to the carrier.
    await purchaseService.updatePurchaseOrderHeader(order.id, { freightPaidByUs: true });
    text = pdfText((await purchaseService.getPurchaseOrderPdf(order.id)).content);
    expect(text).toContain("Vårt kundnr: ACME-999");
  });
});

describe("supplier numbers (leverantörsnummer)", () => {
  it("auto-allocates sequential supplier numbers from the number series", async () => {
    const a = await purchaseService.createSupplier({ name: "Lev A", active: true });
    const b = await purchaseService.createSupplier({ name: "Lev B", active: true });

    // number_series is never truncated, so the counter survives across
    // tests — assert the relative sequence, never absolute values. (The
    // "walks past" test below pins nextNumber immediately before asserting,
    // so absolute values there are safe despite the shared counter.)
    expect(a.supplierNumber).toMatch(/^\d+$/);
    expect(Number(b.supplierNumber)).toBe(Number(a.supplierNumber) + 1);
  });

  it("respects a manually supplied supplier number", async () => {
    const c = await purchaseService.createSupplier({ name: "Lev C", supplierNumber: "LEV-77", active: true });
    expect(c.supplierNumber).toBe("LEV-77");
  });

  it("rejects a duplicate supplier number at create", async () => {
    await purchaseService.createSupplier({ name: "Lev D", supplierNumber: "DUBLETT-1", active: true });
    await expect(
      purchaseService.createSupplier({ name: "Lev E", supplierNumber: "DUBLETT-1", active: true })
    ).rejects.toThrow(DuplicateSupplierNumberError);
  });

  it("walks past a manually taken number instead of wedging the series", async () => {
    // Take a number by hand, then point the series straight at it: the next
    // auto-allocated create must step over it rather than fail — and keep
    // working afterwards.
    const taken = await purchaseService.createSupplier({ name: "Upptagen AB", supplierNumber: "9100", active: true });
    await db.update(numberSeries).set({ nextNumber: 9100 }).where(eq(numberSeries.key, "supplier"));

    const next = await purchaseService.createSupplier({ name: "Nästa AB", active: true });
    expect(next.supplierNumber).toBe("9101");
    expect(taken.supplierNumber).toBe("9100");

    const after = await purchaseService.createSupplier({ name: "Därefter AB", active: true });
    expect(after.supplierNumber).toBe("9102");
  });

  it("still rejects a manually supplied duplicate without retrying", async () => {
    await purchaseService.createSupplier({ name: "Först AB", supplierNumber: "9200", active: true });
    const [before] = await db.select().from(numberSeries).where(eq(numberSeries.key, "supplier"));

    await expect(
      purchaseService.createSupplier({ name: "Andra AB", supplierNumber: "9200", active: true })
    ).rejects.toThrow(DuplicateSupplierNumberError);

    // Asserting only the thrown error would also pass if the code retried
    // (and burned numbers) before giving up — prove "without retrying" by
    // checking the series counter didn't move at all.
    const [after] = await db.select().from(numberSeries).where(eq(numberSeries.key, "supplier"));
    expect(after!.nextNumber).toBe(before!.nextNumber);
  });
});

describe("our customer number at the supplier (vårt kundnummer hos leverantören)", () => {
  it("stores the number at create, updates it, and clears it with null", async () => {
    const created = await purchaseService.createSupplier({
      name: "Nummerlev AB",
      active: true,
      ourCustomerNumber: "KUND-4711",
    });
    expect(created.ourCustomerNumber).toBe("KUND-4711");

    const updated = await purchaseService.updateSupplier(created.id, { ourCustomerNumber: "KUND-4712" });
    expect(updated.ourCustomerNumber).toBe("KUND-4712");

    const cleared = await purchaseService.updateSupplier(created.id, { ourCustomerNumber: null });
    expect(cleared.ourCustomerNumber).toBeNull();
  });

  it("is NOT unique — two suppliers may give us the same number", async () => {
    await purchaseService.createSupplier({ name: "Lev X", active: true, ourCustomerNumber: "SAMMA-1" });
    const second = await purchaseService.createSupplier({ name: "Lev Y", active: true, ourCustomerNumber: "SAMMA-1" });
    expect(second.ourCustomerNumber).toBe("SAMMA-1");
  });

  it("prints 'Vårt kundnummer hos er' on inquiry and PO PDFs", async () => {
    const user = await makeUser();
    const supplier = await purchaseService.createSupplier({
      name: "Nummerlev AB",
      active: true,
      ourCustomerNumber: "KUND-4711",
    });
    const article = await makeArticle(`ART-OCN-${crypto.randomUUID()}`);

    const { inquiry } = await purchaseService.createInquiry(
      { supplierId: supplier.id, rows: [{ articleId: article.id, quantity: 1 }] },
      user.id
    );
    expect(pdfText((await purchaseService.getInquiryPdf(inquiry.id)).content)).toContain(
      "Vårt kundnummer hos er: KUND-4711"
    );

    const order = await purchaseService.createPurchaseOrder({ supplierId: supplier.id }, user.id);
    await purchaseService.addRow(order.id, { articleId: article.id, quantity: 1, unitPrice: 10 });
    expect(pdfText((await purchaseService.getPurchaseOrderPdf(order.id)).content)).toContain(
      "Vårt kundnummer hos er: KUND-4711"
    );
  });

  it("prints nothing when the supplier has no our-customer-number", async () => {
    const { order } = await makeOrderWithRow(1);
    expect(pdfText((await purchaseService.getPurchaseOrderPdf(order.id)).content)).not.toContain(
      "Vårt kundnummer hos er"
    );
  });
});

// G1: audit trail — one representative assertion per action class (same
// auditRows helper pattern as payroll-attest.test.ts / sales.service.test.ts).
async function auditRows(entityType: string, action: string) {
  return db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.entityType, entityType), eq(auditLog.action, action)));
}

describe("purchase service — audit trail", () => {
  it("logs order status transitions with the acting user", async () => {
    const { order, user } = await makeOrderWithRow(5);
    await purchaseService.confirm(order.id, user.id);

    const confirmed = await auditRows("purchase_order", "confirmed");
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0]!.entityId).toBe(order.orderNumber);
    expect(confirmed[0]!.userId).toBe(user.id);

    await purchaseService.setStatus(order.id, "closed", user.id);
    const statusSet = await auditRows("purchase_order", "status_set");
    expect(statusSet).toHaveLength(1);
    expect(statusSet[0]!.detail).toMatchObject({ before: "confirmed", after: "closed" });
  });

  it("logs cancel and close", async () => {
    const { order: draftOrder, user } = await makeOrderWithRow(5);
    await purchaseService.cancel(draftOrder.id, user.id);
    const cancelled = await auditRows("purchase_order", "cancelled");
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]!.entityId).toBe(draftOrder.orderNumber);

    const { order, user: user2, row, location } = await makeOrderWithRow(5);
    await purchaseService.confirm(order.id, user2.id);
    await purchaseService.receiveGoods(order.id, row.id, { locationId: location.id, quantity: 5 }, user2.id);
    await purchaseService.close(order.id, user2.id);
    const closed = await auditRows("purchase_order", "closed");
    expect(closed).toHaveLength(1);
    expect(closed[0]!.entityId).toBe(order.orderNumber);
  });

  it("logs row_added/row_updated/row_deleted under the parent order with article number and before/after", async () => {
    // makeOrderWithRow's own addRow (for the order's first row) already
    // emits a row_added — scope every assertion below to articleB's row.
    const { order, user } = await makeOrderWithRow(5);
    const articleB = await makeArticle(`ART-PO-${crypto.randomUUID()}`);
    const extra = await purchaseService.addRow(order.id, { articleId: articleB.id, quantity: 2, unitPrice: 10 }, user.id);

    const added = (await auditRows("purchase_order_row", "row_added")).filter(
      (row: any) => row.detail?.articleNumber === articleB.articleNumber
    );
    expect(added).toHaveLength(1);
    expect(added[0]!.entityId).toBe(order.orderNumber);
    expect(added[0]!.detail).toMatchObject({ articleNumber: articleB.articleNumber, quantity: "2.0000" });

    await purchaseService.updateRow(order.id, extra.id, { quantity: 3 }, user.id);
    const updated = await auditRows("purchase_order_row", "row_updated");
    expect(updated).toHaveLength(1);
    expect(updated[0]!.detail).toMatchObject({
      articleNumber: articleB.articleNumber,
      before: { quantity: "2.0000" },
      after: { quantity: "3.0000" },
    });

    await purchaseService.deleteRow(order.id, extra.id, true, user.id);
    const deleted = await auditRows("purchase_order_row", "row_deleted");
    expect(deleted).toHaveLength(1);
    expect(deleted[0]!.detail).toMatchObject({ articleNumber: articleB.articleNumber });
  });

  it("logs goods_received with quantity + article", async () => {
    const { order, row, user, location } = await makeOrderWithRow(10);
    await purchaseService.confirm(order.id, user.id);
    await purchaseService.receiveGoods(order.id, row.id, { locationId: location.id, quantity: 4 }, user.id);

    const received = await auditRows("purchase_order_row", "goods_received");
    expect(received).toHaveLength(1);
    expect(received[0]!.entityId).toBe(order.orderNumber);
    expect(received[0]!.detail).toMatchObject({ quantity: 4 });
    expect(received[0]!.userId).toBe(user.id);
  });

  it("logs inquiry status transitions", async () => {
    const user = await makeUser();
    const supplier = await makeSupplier();
    const article = await makeArticle(`ART-INQ-${crypto.randomUUID()}`);
    const { inquiry } = await purchaseService.createInquiry(
      { supplierId: supplier.id, rows: [{ articleId: article.id, quantity: 1 }] },
      user.id
    );

    await purchaseService.sendInquiry(inquiry.id, user.id);
    const sent = await auditRows("inquiry", "sent");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.entityId).toBe(inquiry.inquiryNumber);

    await purchaseService.markInquiryAnswered(inquiry.id, user.id);
    const answered = await auditRows("inquiry", "answered");
    expect(answered).toHaveLength(1);
    expect(answered[0]!.entityId).toBe(inquiry.inquiryNumber);

    const { inquiry: other } = await purchaseService.createInquiry(
      { supplierId: supplier.id, rows: [{ articleId: article.id, quantity: 1 }] },
      user.id
    );
    await purchaseService.cancelInquiry(other.id, user.id);
    const cancelled = await auditRows("inquiry", "cancelled");
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]!.entityId).toBe(other.inquiryNumber);
  });
});

describe("purchase service — önskat leveransdatum", () => {
  it("stores a row's own date, and PATCH sets and clears it (null = follows the order)", async () => {
    const { order, article } = await makeOrderWithRow(5);
    const other = await makeArticle(`ART-DD-${crypto.randomUUID()}`);
    const own = await purchaseService.addRow(order.id, {
      articleId: other.id,
      quantity: 2,
      unitPrice: 10,
      expectedDeliveryDate: "2030-03-15",
    });
    expect(own.expectedDeliveryDate).toBe("2030-03-15");

    const rows = await purchaseService.listRows(order.id);
    expect(rows.find((r) => r.articleId === article.id)!.expectedDeliveryDate).toBeNull();

    const changed = await purchaseService.updateRow(order.id, own.id, { expectedDeliveryDate: "2030-03-20" });
    expect(changed.row!.expectedDeliveryDate).toBe("2030-03-20");
    const cleared = await purchaseService.updateRow(order.id, own.id, { expectedDeliveryDate: null });
    expect(cleared.row!.expectedDeliveryDate).toBeNull();
  });

  it("Bekräftat leveransdatum: set on the header and per row, null clears, Nästa leveransdatum follows", async () => {
    const user = await makeUser();
    const supplier = await makeSupplier();
    const location = await makeLocation();
    const a = await makeArticle(`ART-CF-A-${crypto.randomUUID()}`);
    const b = await makeArticle(`ART-CF-B-${crypto.randomUUID()}`);
    const order = await purchaseService.createPurchaseOrder(
      { supplierId: supplier.id, expectedDeliveryDate: "2030-03-04" },
      user.id
    );
    const rowA = await purchaseService.addRow(order.id, { articleId: a.id, quantity: 1, unitPrice: 1 });
    const rowB = await purchaseService.addRow(order.id, {
      articleId: b.id,
      quantity: 1,
      unitPrice: 1,
      confirmedDeliveryDate: "2030-03-25",
    });
    expect(rowB.confirmedDeliveryDate).toBe("2030-03-25");

    const nextOf = async () =>
      (await purchaseService.listPurchaseOrders({ search: order.orderNumber, limit: 10, offset: 0 })).rows.find(
        (o) => o.id === order.id
      )!.nextDeliveryDate;
    // Row A has nothing of its own: the order's requested date.
    expect(await nextOf()).toBe("2030-03-04");

    await purchaseService.updatePurchaseOrderHeader(order.id, { confirmedDeliveryDate: "2030-03-11" });
    expect((await purchaseService.getPurchaseOrder(order.id))!.confirmedDeliveryDate).toBe("2030-03-11");
    expect(await nextOf()).toBe("2030-03-11");

    await purchaseService.confirm(order.id);
    await purchaseService.receiveGoods(order.id, rowA.id, { locationId: location.id, quantity: 1 }, user.id);
    // Row A is received — row B's own confirmation remains.
    expect(await nextOf()).toBe("2030-03-25");

    const cleared = await purchaseService.updateRow(order.id, rowB.id, { confirmedDeliveryDate: null });
    expect(cleared.row!.confirmedDeliveryDate).toBeNull();
    expect(await nextOf()).toBe("2030-03-11");
  });

  it("PATCH persists a lego row's ställpris (it used to be dropped)", async () => {
    const { order, row } = await makeOrderWithRow(5);
    const patched = await purchaseService.updateRow(order.id, row.id, { setupPrice: 350 });
    expect(Number(patched.row!.setupPrice)).toBe(350);
  });

  it("prints Önskat leveransdatum in the PO header, and per row only where the row differs", async () => {
    const user = await makeUser();
    const supplier = await makeSupplier();
    const a = await makeArticle(`ART-DDA-${crypto.randomUUID()}`);
    const b = await makeArticle(`ART-DDB-${crypto.randomUUID()}`);
    const c = await makeArticle(`ART-DDC-${crypto.randomUUID()}`);
    const order = await purchaseService.createPurchaseOrder(
      { supplierId: supplier.id, expectedDeliveryDate: "2030-03-04" },
      user.id
    );
    await purchaseService.addRow(order.id, { articleId: a.id, quantity: 1, unitPrice: 1 }); // follows
    await purchaseService.addRow(order.id, { articleId: b.id, quantity: 1, unitPrice: 1, expectedDeliveryDate: "2030-03-04" }); // same as header
    await purchaseService.addRow(order.id, { articleId: c.id, quantity: 1, unitPrice: 1, expectedDeliveryDate: "2030-03-15" });

    const text = pdfText((await purchaseService.getPurchaseOrderPdf(order.id)).content);
    expect(text).toContain("Önskat leveransdatum: 2030-03-04");
    expect(text).toContain("Önskat leveransdatum: 2030-03-15");
    expect(text.split("Önskat leveransdatum:").length - 1).toBe(2); // header + the one differing row
  });

  it("prints the inquiry's Önskat leveransdatum on its PDF", async () => {
    const user = await makeUser();
    const supplier = await makeSupplier();
    const a = await makeArticle(`ART-DDI-${crypto.randomUUID()}`);
    const { inquiry } = await purchaseService.createInquiry(
      { supplierId: supplier.id, expectedDeliveryDate: "2030-04-01", rows: [{ articleId: a.id, quantity: 3 }] },
      user.id
    );
    const text = pdfText((await purchaseService.getInquiryPdf(inquiry.id)).content);
    expect(text).toContain("Önskat leveransdatum: 2030-04-01");
  });
});

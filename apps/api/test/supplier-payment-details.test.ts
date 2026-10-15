import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@navet/db";
import { createPurchaseRepository } from "../src/modules/purchase/repository/purchase.repository.js";
import { createPurchaseService, InvalidSupplierPaymentDetailsError } from "../src/modules/purchase/service/purchase.service.js";
import { createSupplierInvoiceRepository } from "../src/modules/purchase/repository/supplier-invoice.repository.js";
import { createSupplierInvoiceService } from "../src/modules/purchase/service/supplier-invoice.service.js";
import { InvalidStatusTransitionError } from "../src/modules/purchase/service/purchase.service.js";
import { createRegisterRepository } from "../src/modules/register/repository/register.repository.js";
import { createRegisterService } from "../src/modules/register/service/register.service.js";
import { createMailRepository } from "../src/modules/mail/repository/mail.repository.js";
import { createMailService } from "../src/modules/mail/service/mail.service.js";
import { createVerificationPoster } from "../src/modules/economy/service/verification-poster.js";
import { readPostingSettings } from "../src/modules/system/service/posting-settings.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { testArticleService, testDocumentPdfService, testSystemService } from "./helpers/services.js";
import { failure } from "./helpers/year-end.js";
import { makeApprovedSupplierInvoice, makeSupplier, resetBanking, setupBanking } from "./helpers/banking.js";

const purchaseService = createPurchaseService(
  createPurchaseRepository(db),
  createRegisterService(createRegisterRepository(db)),
  createMailService(createMailRepository(db), testSystemService, () => ({ async sendMail() {} })),
  testDocumentPdfService,
  testArticleService,
  testSystemService,
  {
    reportOperationQuantities: async () => { throw new Error("not wired"); },
    assertMaterialBeforeSubcontractReceipt: async () => {},
    undoPurchaseReceiptReportInTx: async () => { throw new Error("SubcontractOperationReporter not wired in this test"); },
    updateRoutingOperation: async () => { throw new Error("not wired"); },
  },
  createAuditRepository(db)
);
const supplierInvoiceService = createSupplierInvoiceService(
  createSupplierInvoiceRepository(db),
  createVerificationPoster({ read: readPostingSettings }),
  createAuditRepository(db)
);

let userId: string;
beforeEach(async () => {
  await resetBanking();
  userId = (await setupBanking()).user.id;
});
afterAll(resetBanking);

describe("leverantörens betalningsuppgifter", () => {
  it("stores normalized details on create", async () => {
    const supplier = await purchaseService.createSupplier({
      name: "Plåtlagret AB", currency: "SEK", active: true, paymentMethod: "bankgiro", bankgiro: "5050-1055",
    });
    expect(supplier).toMatchObject({ paymentMethod: "bankgiro", bankgiro: "50501055" });
  });

  it("checks the merged state on update: switching method needs the stored number", async () => {
    const supplier = await makeSupplier({ plusgiro: "4892162" });
    const switched = await purchaseService.updateSupplier(supplier.id, { paymentMethod: "plusgiro" });
    expect(switched.paymentMethod).toBe("plusgiro");
    const error = await failure(purchaseService.updateSupplier(supplier.id, { paymentMethod: "bankgiro" }));
    expect(error).toBeInstanceOf(InvalidSupplierPaymentDetailsError);
    expect((error as InvalidSupplierPaymentDetailsError).problems).toEqual({ bankgiro: "Bankgiro saknas" });
    // Clearing the field the method needs is refused too.
    const cleared = await failure(purchaseService.updateSupplier(supplier.id, { plusgiro: "" }));
    expect((cleared as InvalidSupplierPaymentDetailsError).problems).toEqual({ plusgiro: "Plusgiro saknas" });
  });

  it("rejects a bad check digit", async () => {
    const error = await failure(
      purchaseService.createSupplier({ name: "X", currency: "SEK", active: true, paymentMethod: "bankgiro", bankgiro: "5050-1056" })
    );
    expect((error as InvalidSupplierPaymentDetailsError).problems.bankgiro).toMatch(/kontrollsiffra/);
  });
});

describe("fakturans betalningsreferens", () => {
  it("is set on an approved invoice and cleared with null", async () => {
    const supplier = await makeSupplier();
    const invoice = await makeApprovedSupplierInvoice(supplier.id, { registrationNumber: "LF-T10", gross: 500 });
    const set = await supplierInvoiceService.updatePaymentReference(invoice.id, { paymentReference: { kind: "ocr", value: "4605127" } }, userId);
    expect(set).toMatchObject({ paymentReferenceKind: "ocr", paymentReference: "4605127" });
    const cleared = await supplierInvoiceService.updatePaymentReference(invoice.id, { paymentReference: null }, userId);
    expect(cleared).toMatchObject({ paymentReferenceKind: null, paymentReference: null });
  });

  it("is refused on a paid or cancelled invoice", async () => {
    const supplier = await makeSupplier();
    const invoice = await makeApprovedSupplierInvoice(supplier.id, { registrationNumber: "LF-T11", gross: 500 });
    await db.execute(sql`UPDATE supplier_invoices SET status = 'paid' WHERE id = ${invoice.id}`);
    const error = await failure(
      supplierInvoiceService.updatePaymentReference(invoice.id, { paymentReference: { kind: "message", value: "x" } }, userId)
    );
    expect(error).toBeInstanceOf(InvalidStatusTransitionError);
  });
});

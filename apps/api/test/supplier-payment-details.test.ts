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

// Valuta steg 2: an IBAN of any country, a foreign account number with BIC
// or bank id, avgiftsfördelning and betalningskod; a payee abroad needs
// street, town and country.
describe("leverantörens uppgifter för utlandsbetalning", () => {
  const usPayee = {
    name: "Lakeside Tooling Inc.",
    currency: "USD",
    active: true,
    country: "US",
    address: "400 Harbor Drive",
    postalCode: "60601",
    city: "Chicago",
    paymentMethod: "foreign_account" as const,
    foreignAccountNumber: "1234 5678 9012",
    clearingSystem: "usaba",
    clearingMemberId: "123-456-780",
    bankName: "Example Bank N.A.",
    chargeBearer: "DEBT" as const,
    paymentReportingCode: "130",
  };

  it("stores a foreign account number with its bank id, normalized; förval SHAR and 101", async () => {
    const us = await purchaseService.createSupplier(usPayee);
    expect(us).toMatchObject({
      paymentMethod: "foreign_account",
      foreignAccountNumber: "123456789012",
      clearingSystem: "USABA",
      clearingMemberId: "123456780",
      bankName: "Example Bank N.A.",
      chargeBearer: "DEBT",
      paymentReportingCode: "130",
    });
    const de = await purchaseService.createSupplier({
      name: "Müller GmbH", currency: "EUR", active: true, country: "DE", address: "Hauptstraße 5", city: "Berlin", paymentMethod: "iban", iban: "DE89 3704 0044 0532 0130 00",
    });
    expect(de).toMatchObject({ paymentMethod: "iban", iban: "DE89370400440532013000", bic: null, chargeBearer: "SHAR", paymentReportingCode: "101" });
  });

  it("refuses a payee abroad without street and town, and a foreign account without BIC or bank id", async () => {
    const error = await failure(purchaseService.createSupplier({ ...usPayee, address: undefined, city: undefined, clearingSystem: undefined, clearingMemberId: undefined }));
    expect(error).toBeInstanceOf(InvalidSupplierPaymentDetailsError);
    expect((error as InvalidSupplierPaymentDetailsError).problems).toEqual({
      bic: "Ange BIC eller bank-id (t.ex. ABA routing number)",
      address: "Gatuadress krävs för en utländsk mottagare",
      city: "Ort krävs för en utländsk mottagare",
    });
    const bic = await failure(purchaseService.createSupplier({ name: "Ankara AŞ", currency: "TRY", active: true, country: "TR", address: "Cad. 1", city: "Ankara", paymentMethod: "iban", iban: "TR330006100519786457841326" }));
    expect((bic as InvalidSupplierPaymentDetailsError).problems).toEqual({ bic: "BIC krävs för IBAN utanför SEPA-området" });
  });

  it("holds an address-only PATCH to the address rules, and the payment details to all of them", async () => {
    const us = await purchaseService.createSupplier(usPayee);
    const blank = await failure(purchaseService.updateSupplier(us.id, { address: "" }));
    expect((blank as InvalidSupplierPaymentDetailsError).problems).toEqual({ address: "Gatuadress krävs för en utländsk mottagare" });
    const sweden = await failure(purchaseService.updateSupplier(us.id, { country: "SE" }));
    expect((sweden as InvalidSupplierPaymentDetailsError).problems).toEqual({ country: "Ett utländskt kontonummer kräver att leverantörens land inte är Sverige" });
    // An older foreign payee without BIC (stored before the rule): an address
    // edit is not locked by it, a payment-detail edit is.
    const old = await makeSupplier({ name: "Old Ltd", country: "TR", paymentMethod: "iban", iban: "TR330006100519786457841326" });
    expect((await purchaseService.updateSupplier(old.id, { address: "Cad. 1", city: "Ankara" })).address).toBe("Cad. 1");
    const touched = await failure(purchaseService.updateSupplier(old.id, { chargeBearer: "DEBT" }));
    expect((touched as InvalidSupplierPaymentDetailsError).problems).toEqual({ bic: "BIC krävs för IBAN utanför SEPA-området" });
  });

  it("the database keeps a foreign account's bank id together and refuses an unknown charge bearer", async () => {
    await expect(makeSupplier({ name: "X", country: "US", paymentMethod: "foreign_account", foreignAccountNumber: "1" })).rejects.toThrow();
    await expect(makeSupplier({ name: "Y", clearingSystem: "USABA" })).rejects.toThrow();
    await expect(makeSupplier({ name: "Z", chargeBearer: "CRED" as never })).rejects.toThrow();
    await expect(makeSupplier({ name: "W", paymentReportingCode: "1a1" })).rejects.toThrow();
    const ok = await makeSupplier({ name: "V", country: "US", paymentMethod: "foreign_account", foreignAccountNumber: "1", clearingSystem: "USABA", clearingMemberId: "123456780" });
    expect(ok.paymentMethod).toBe("foreign_account");
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

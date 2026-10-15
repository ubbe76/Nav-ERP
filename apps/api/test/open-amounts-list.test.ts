import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { customerPaymentRows, db, invoiceReminders, invoices } from "@navet/db";
import { createVerificationPoster } from "../src/modules/economy/service/verification-poster.js";
import { readPostingSettings } from "../src/modules/system/service/posting-settings.js";
import { createPaymentRepository } from "../src/modules/sales/repository/payment.repository.js";
import { computeOpenAmounts as computeReceivables } from "../src/modules/sales/repository/open-amounts.js";
import { createPaymentService } from "../src/modules/sales/service/payment.service.js";
import { createSupplierPaymentRepository } from "../src/modules/purchase/repository/supplier-payment.repository.js";
import { computeOpenAmounts as computePayables } from "../src/modules/purchase/repository/open-amounts.js";
import { createSupplierPaymentService } from "../src/modules/purchase/service/supplier-payment.service.js";
import {
  BANK_YEAR,
  makeApprovedSupplierInvoice,
  makeCustomer,
  makeIssuedCustomerInvoice,
  makeSupplier,
  resetBanking,
  setupBanking,
} from "./helpers/banking.js";

const poster = createVerificationPoster({ read: readPostingSettings });
const paymentRepo = createPaymentRepository(db);
const paymentService = createPaymentService(paymentRepo, poster);
const supplierPaymentRepo = createSupplierPaymentRepository(db);
const supplierPaymentService = createSupplierPaymentService(supplierPaymentRepo, poster);

let userId: string;
beforeEach(async () => {
  await resetBanking();
  userId = (await setupBanking()).user.id;
});
afterAll(resetBanking);

// The list's joined aggregates must agree with the per-id authority
// (computeOpenAmounts' correlated openAmountSql) for every kind of open item —
// partly paid, credited, reminded, and paid-then-cancelled — while items that
// closed (paid in full, or within tolerance with a write-off) stay out.
describe("öppna poster-listan efter omskrivningen", () => {
  it("kundreskontran: varje rad har samma öppna belopp som computeOpenAmounts", async () => {
    const a = await makeCustomer("Alfa AB");
    const b = await makeCustomer("Beta AB");
    const partly = await makeIssuedCustomerInvoice(a.id, { invoiceNumber: "FA-9001", gross: 1000 });
    const reminded = await makeIssuedCustomerInvoice(a.id, { invoiceNumber: "FA-9002", gross: 500 });
    const credit = await makeIssuedCustomerInvoice(b.id, { invoiceNumber: "FA-9003", gross: 200, type: "credit" });
    const cancelledPay = await makeIssuedCustomerInvoice(b.id, { invoiceNumber: "FA-9004", gross: 300 });
    const settled = await makeIssuedCustomerInvoice(b.id, { invoiceNumber: "FA-9005", gross: 100 });
    const writtenOff = await makeIssuedCustomerInvoice(b.id, { invoiceNumber: "FA-9006", gross: 1000 });
    await db.insert(invoiceReminders).values({ invoiceId: reminded.id, level: 1, fee: "60" });
    const base = { paymentDate: `${BANK_YEAR}-10-02`, bankAccountNumber: "1930", note: null };
    await paymentService.create({ ...base, customerId: a.id, amount: 400, rows: [{ invoiceId: partly.id, appliedAmount: 400 }] }, userId);
    const toCancel = await paymentService.create(
      { ...base, customerId: b.id, amount: 300, rows: [{ invoiceId: cancelledPay.id, appliedAmount: 300 }] },
      userId
    );
    // Fixed 2024 date for the omföring (C1): only fiscal year 2024 exists.
    await paymentService.cancel(toCancel.id, userId, { date: `${BANK_YEAR}-10-17` });
    await paymentService.create({ ...base, customerId: b.id, amount: 100, rows: [{ invoiceId: settled.id, appliedAmount: 100 }] }, userId);
    // 999,40 on 1 000 closes within the 1 kr tolerance: 0,60 written off.
    await paymentService.create(
      { ...base, customerId: b.id, amount: 999.4, rows: [{ invoiceId: writtenOff.id, appliedAmount: 999.4 }] },
      userId
    );
    const [writeOffRow] = await db.select().from(customerPaymentRows).where(eq(customerPaymentRows.invoiceId, writtenOff.id));
    expect(writeOffRow!.writeOffAmount).toBe("0.60");

    const list = await paymentRepo.listOpenInvoices({ limit: 50, offset: 0, overdueOnly: false });
    const authority = await computeReceivables(db, [
      partly.id,
      reminded.id,
      credit.id,
      cancelledPay.id,
      settled.id,
      writtenOff.id,
    ]);
    expect(authority.get(writtenOff.id)).toBe(0);
    expect(list.total).toBe(4);
    expect(list.rows.map((r) => r.invoiceNumber).sort()).toEqual(["FA-9001", "FA-9002", "FA-9003", "FA-9004"]);
    for (const row of list.rows) expect(row.openAmount).toBe(authority.get(row.id));
    expect(list.rows.find((r) => r.invoiceNumber === "FA-9002")!.openAmount).toBe(560);
    expect(list.rows.find((r) => r.invoiceNumber === "FA-9003")!.openAmount).toBe(-200);
    expect(list.rows.find((r) => r.invoiceNumber === "FA-9003")!.grossAmount).toBe(-200);
    // Paging keeps the same total.
    const page = await paymentRepo.listOpenInvoices({ limit: 2, offset: 2, overdueOnly: false });
    expect(page.total).toBe(4);
    expect(page.rows).toHaveLength(2);

    // The paid-flip already hides FA-9006 by status. Forced back to issued,
    // only the write-off term of the aggregate keeps it out of the list.
    await db.update(invoices).set({ status: "issued" }).where(eq(invoices.id, writtenOff.id));
    const forced = await paymentRepo.listOpenInvoices({ limit: 50, offset: 0, overdueOnly: false });
    expect(forced.total).toBe(4);
    expect(forced.rows.map((r) => r.invoiceNumber)).not.toContain("FA-9006");
  });

  it("leverantörsreskontran: samma sak för attesterade fakturor", async () => {
    const supplier = await makeSupplier({ name: "Gamma AB" });
    const partly = await makeApprovedSupplierInvoice(supplier.id, { registrationNumber: "LF-9001", gross: 1000 });
    const creditNote = await makeApprovedSupplierInvoice(supplier.id, { registrationNumber: "LF-9002", gross: -250 });
    const settled = await makeApprovedSupplierInvoice(supplier.id, { registrationNumber: "LF-9003", gross: 80 });
    const base = { supplierId: supplier.id, paymentDate: `${BANK_YEAR}-10-02`, bankAccountNumber: "1930", note: null };
    await supplierPaymentService.create({ ...base, amount: 600, rows: [{ supplierInvoiceId: partly.id, appliedAmount: 600 }] }, userId);
    await supplierPaymentService.create({ ...base, amount: 80, rows: [{ supplierInvoiceId: settled.id, appliedAmount: 80 }] }, userId);

    const list = await supplierPaymentRepo.listOpenInvoices({ limit: 50, offset: 0, overdueOnly: false });
    const authority = await computePayables(db, [partly.id, creditNote.id, settled.id]);
    expect(list.total).toBe(2);
    for (const row of list.rows) expect(row.openAmount).toBe(authority.get(row.id));
    expect(list.rows.map((r) => r.openAmount).sort((x, y) => x - y)).toEqual([-250, 400]);
  });

  // Carried from Task 1: the AP half of "paid-then-cancelled". The payment
  // flips the invoice to paid (out of the list); its cancellation — dated in
  // the fixed 2024 year — reopens it with the FULL gross as its open amount.
  it("leverantörsreskontran: en betald och sedan makulerad faktura är öppen igen med hela beloppet", async () => {
    const supplier = await makeSupplier({ name: "Delta AB" });
    const invoice = await makeApprovedSupplierInvoice(supplier.id, { registrationNumber: "LF-9101", gross: 1250 });
    const payment = await supplierPaymentService.create(
      {
        supplierId: supplier.id,
        paymentDate: `${BANK_YEAR}-10-02`,
        bankAccountNumber: "1930",
        note: null,
        amount: 1250,
        rows: [{ supplierInvoiceId: invoice.id, appliedAmount: 1250 }],
      },
      userId
    );
    const paid = await supplierPaymentRepo.listOpenInvoices({ limit: 50, offset: 0, overdueOnly: false });
    expect(paid.rows.map((r) => r.registrationNumber)).not.toContain("LF-9101");

    await supplierPaymentService.cancel(payment.id, userId, { date: `${BANK_YEAR}-10-17` });

    const list = await supplierPaymentRepo.listOpenInvoices({ limit: 50, offset: 0, overdueOnly: false });
    const authority = await computePayables(db, [invoice.id]);
    expect(list.total).toBe(1);
    expect(list.rows[0]!.registrationNumber).toBe("LF-9101");
    expect(list.rows[0]!.openAmount).toBe(1250);
    expect(list.rows[0]!.openAmount).toBe(authority.get(invoice.id));
  });
});

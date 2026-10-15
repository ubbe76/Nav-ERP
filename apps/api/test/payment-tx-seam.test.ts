import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { count, eq } from "drizzle-orm";
import { customerPayments, db, paymentBatchItems, supplierInvoices, supplierPayments, verifications } from "@navet/db";
import { createVerificationPoster } from "../src/modules/economy/service/verification-poster.js";
import { readPostingSettings } from "../src/modules/system/service/posting-settings.js";
import { createSupplierPaymentRepository } from "../src/modules/purchase/repository/supplier-payment.repository.js";
import {
  createSupplierPaymentService,
  SupplierInvoiceReservedError,
  SupplierPaymentRowMismatchError,
} from "../src/modules/purchase/service/supplier-payment.service.js";
import { createSupplierInvoiceRepository } from "../src/modules/purchase/repository/supplier-invoice.repository.js";
import {
  createSupplierInvoiceService,
  SupplierInvoiceInPaymentBatchError,
} from "../src/modules/purchase/service/supplier-invoice.service.js";
import { createPaymentRepository } from "../src/modules/sales/repository/payment.repository.js";
import { createPaymentService } from "../src/modules/sales/service/payment.service.js";
import { isUniqueViolation } from "../src/modules/system/service/db-errors.js";
import { failure } from "./helpers/year-end.js";
import {
  BANK_YEAR,
  makeApprovedSupplierInvoice,
  makeBankEntry,
  makeBatchItem,
  makeCustomer,
  makeIssuedCustomerInvoice,
  makeSupplier,
  resetBanking,
  setupBanking,
} from "./helpers/banking.js";

const poster = createVerificationPoster({ read: readPostingSettings });
const supplierPayments_ = createSupplierPaymentService(createSupplierPaymentRepository(db), poster);
const supplierInvoices_ = createSupplierInvoiceService(createSupplierInvoiceRepository(db), poster);
const payments = createPaymentService(createPaymentRepository(db), poster);

let userId: string;
beforeEach(async () => {
  await resetBanking();
  userId = (await setupBanking()).user.id;
});
afterAll(resetBanking);

const DATE = `${BANK_YEAR}-10-15`;

async function supplierWithInvoice(gross = 1000) {
  const supplier = await makeSupplier({ paymentMethod: "bankgiro", bankgiro: "50501055" });
  const invoice = await makeApprovedSupplierInvoice(supplier.id, { registrationNumber: `LF-S${Math.round(gross)}`, gross });
  return { supplier, invoice };
}

function supplierInput(supplierId: string, invoiceId: string, amount: number) {
  return { supplierId, paymentDate: DATE, bankAccountNumber: "1930", amount, note: null, rows: [{ supplierInvoiceId: invoiceId, appliedAmount: amount }] };
}

describe("leverantörsbetalning i anroparens transaktion", () => {
  it("writes the batch link in the payment's own INSERT and rolls back with the caller", async () => {
    const { supplier, invoice } = await supplierWithInvoice();
    const { item } = await makeBatchItem({ supplierInvoiceId: invoice.id, supplierId: supplier.id, amount: 1000 });

    const rolledBack = await failure(
      db.transaction(async (tx) => {
        await supplierPayments_.createInTx(tx, supplierInput(supplier.id, invoice.id, 1000), userId, { paymentBatchItemId: item.id, bankFileEntryId: null });
        throw new Error("caller aborts");
      })
    );
    expect((rolledBack as Error).message).toBe("caller aborts");
    expect((await db.select({ n: count() }).from(supplierPayments))[0]!.n).toBe(0);
    expect((await db.select({ n: count() }).from(verifications))[0]!.n).toBe(0);
    const [still] = await db.select({ status: supplierInvoices.status }).from(supplierInvoices).where(eq(supplierInvoices.id, invoice.id));
    expect(still!.status).toBe("approved");

    const created = await db.transaction((tx) =>
      supplierPayments_.createInTx(tx, supplierInput(supplier.id, invoice.id, 1000), userId, { paymentBatchItemId: item.id, bankFileEntryId: null })
    );
    expect(created.paymentNumber).toMatch(/^UTB-/);
    const [payment] = await db.select().from(supplierPayments).where(eq(supplierPayments.id, created.paymentId));
    expect(payment!.paymentBatchItemId).toBe(item.id);
    expect(payment!.paymentDate).toBe(DATE);
  });

  it("refuses a manual registration — and another batch row — on a reserved invoice", async () => {
    const { supplier, invoice } = await supplierWithInvoice();
    const { item } = await makeBatchItem({ supplierInvoiceId: invoice.id, supplierId: supplier.id, amount: 1000 });
    const manual = await failure(supplierPayments_.create(supplierInput(supplier.id, invoice.id, 1000), userId));
    expect(manual).toBeInstanceOf(SupplierInvoiceReservedError);
    const other = await failure(
      db.transaction((tx) =>
        supplierPayments_.createInTx(tx, supplierInput(supplier.id, invoice.id, 1000), userId, {
          paymentBatchItemId: "00000000-0000-4000-8000-000000000000",
          bankFileEntryId: null,
        })
      )
    );
    expect(other).toBeInstanceOf(SupplierInvoiceReservedError);
    // The reserving row itself may book.
    await db.transaction((tx) =>
      supplierPayments_.createInTx(tx, supplierInput(supplier.id, invoice.id, 1000), userId, { paymentBatchItemId: item.id, bankFileEntryId: null })
    );
  });

  // Task 7 carry: the seam defends itself — a link must be an EXPORTED row
  // reserving one of the payment's own invoices.
  it("refuses a link to another invoice's row, a pending row or a no-longer-live row", async () => {
    const { supplier, invoice } = await supplierWithInvoice(1000);
    const other = await makeApprovedSupplierInvoice(supplier.id, { registrationNumber: "LF-S2", gross: 500 });
    const { item: otherItem } = await makeBatchItem({ supplierInvoiceId: other.id, supplierId: supplier.id, amount: 500 });
    const link = (paymentBatchItemId: string) => ({ paymentBatchItemId, bankFileEntryId: null });

    const foreign = await failure(db.transaction((tx) => supplierPayments_.createInTx(tx, supplierInput(supplier.id, invoice.id, 1000), userId, link(otherItem.id))));
    expect(foreign).toBeInstanceOf(SupplierPaymentRowMismatchError);

    const { item: pending } = await makeBatchItem({ supplierInvoiceId: invoice.id, supplierId: supplier.id, amount: 1000, status: "pending" });
    const notSent = await failure(db.transaction((tx) => supplierPayments_.createInTx(tx, supplierInput(supplier.id, invoice.id, 1000), userId, link(pending.id))));
    expect(notSent).toBeInstanceOf(SupplierPaymentRowMismatchError);

    await db.update(paymentBatchItems).set({ status: "rejected" }).where(eq(paymentBatchItems.id, pending.id));
    const closed = await failure(db.transaction((tx) => supplierPayments_.createInTx(tx, supplierInput(supplier.id, invoice.id, 1000), userId, link(pending.id))));
    expect(closed).toBeInstanceOf(SupplierPaymentRowMismatchError);
    expect((await db.select({ n: count() }).from(supplierPayments))[0]!.n).toBe(0);
  });

  it("marks the batch row returned when its payment is cancelled, dating the omföring as asked", async () => {
    const { supplier, invoice } = await supplierWithInvoice();
    const { item } = await makeBatchItem({ supplierInvoiceId: invoice.id, supplierId: supplier.id, amount: 1000 });
    const created = await db.transaction((tx) =>
      supplierPayments_.createInTx(tx, supplierInput(supplier.id, invoice.id, 1000), userId, { paymentBatchItemId: item.id, bankFileEntryId: null })
    );
    await db.update(paymentBatchItems).set({ status: "confirmed" }).where(eq(paymentBatchItems.id, item.id));

    const result = await db.transaction((tx) => supplierPayments_.cancelInTx(tx, created.paymentId, userId, { date: `${BANK_YEAR}-10-17` }));
    expect(result.paymentBatchItemId).toBe(item.id);
    const [row] = await db.select({ status: paymentBatchItems.status }).from(paymentBatchItems).where(eq(paymentBatchItems.id, item.id));
    expect(row!.status).toBe("returned");
    const [payment] = await db.select().from(supplierPayments).where(eq(supplierPayments.id, created.paymentId));
    const [omforing] = await db.select({ date: verifications.date }).from(verifications).where(eq(verifications.id, payment!.cancellationVerificationId!));
    expect(omforing!.date).toBe(`${BANK_YEAR}-10-17`);
    const [reopened] = await db.select({ status: supplierInvoices.status }).from(supplierInvoices).where(eq(supplierInvoices.id, invoice.id));
    expect(reopened!.status).toBe("approved");
  });

  // C5: the return path locks omgång → omgångsrad → betalning, so a manual
  // Makulera must take the batch row BEFORE the payment or the two can
  // deadlock. While another transaction holds the row, the cancellation waits
  // without having locked the payment; once released it completes and — by
  // hand, too — leaves the row "returned".
  it("locks the batch row before the payment, and a manual cancel also marks the row returned", async () => {
    const { supplier, invoice } = await supplierWithInvoice();
    const { item } = await makeBatchItem({ supplierInvoiceId: invoice.id, supplierId: supplier.id, amount: 1000 });
    const created = await db.transaction((tx) =>
      supplierPayments_.createInTx(tx, supplierInput(supplier.id, invoice.id, 1000), userId, { paymentBatchItemId: item.id, bankFileEntryId: null })
    );
    await db.update(paymentBatchItems).set({ status: "confirmed" }).where(eq(paymentBatchItems.id, item.id));

    let cancelling: Promise<unknown> | undefined;
    await db.transaction(async (tx) => {
      await tx.select({ id: paymentBatchItems.id }).from(paymentBatchItems).where(eq(paymentBatchItems.id, item.id)).for("update");
      cancelling = supplierPayments_.cancel(created.paymentId, userId, { date: `${BANK_YEAR}-10-17` }).catch((err: unknown) => err);
      await new Promise((resolve) => setTimeout(resolve, 300));
      // NOWAIT fails (55P03) if the waiting cancellation already holds the payment.
      const [payment] = await tx
        .select({ id: supplierPayments.id })
        .from(supplierPayments)
        .where(eq(supplierPayments.id, created.paymentId))
        .for("update", { noWait: true });
      expect(payment!.id).toBe(created.paymentId);
    });
    const outcome = await cancelling;
    expect(outcome).not.toBeInstanceOf(Error);

    const [row] = await db.select({ status: paymentBatchItems.status }).from(paymentBatchItems).where(eq(paymentBatchItems.id, item.id));
    expect(row!.status).toBe("returned");
  });

  it("refuses to cancel or re-reference an invoice in a live batch, naming the batch", async () => {
    const { supplier, invoice } = await supplierWithInvoice();
    await makeBatchItem({ supplierInvoiceId: invoice.id, supplierId: supplier.id, amount: 1000, batchNumber: "BO-T77" });
    const cancel = await failure(supplierInvoices_.cancel(invoice.id, userId));
    expect(cancel).toBeInstanceOf(SupplierInvoiceInPaymentBatchError);
    expect((cancel as SupplierInvoiceInPaymentBatchError).batchNumber).toBe("BO-T77");
    const reference = await failure(
      supplierInvoices_.updatePaymentReference(invoice.id, { paymentReference: { kind: "ocr", value: "4605127" } }, userId)
    );
    expect(reference).toBeInstanceOf(SupplierInvoiceInPaymentBatchError);
  });
});

describe("kundbetalning i anroparens transaktion", () => {
  it("links the bank entry and allows only one live payment per entry", async () => {
    const customer = await makeCustomer("Fönsterbolaget AB");
    const invoice = await makeIssuedCustomerInvoice(customer.id, { invoiceNumber: "FA-5012", gross: 10000 });
    const { entry } = await makeBankEntry({ direction: "credit", amount: 5000 });
    const input = { customerId: customer.id, paymentDate: DATE, bankAccountNumber: "1930", amount: 5000, note: null, rows: [{ invoiceId: invoice.id, appliedAmount: 5000 }] };

    const first = await db.transaction((tx) => payments.createInTx(tx, input, userId, { bankFileEntryId: entry.id }));
    expect(first.paymentNumber).toMatch(/^BET-/);
    const [stored] = await db.select().from(customerPayments).where(eq(customerPayments.id, first.paymentId));
    expect(stored!.bankFileEntryId).toBe(entry.id);

    const second = await failure(db.transaction((tx) => payments.createInTx(tx, input, userId, { bankFileEntryId: entry.id })));
    expect(isUniqueViolation(second)).toBe(true);

    // A cancelled payment frees the entry for a new booking.
    // Fixed 2024 date for the omföring: only fiscal year 2024 exists.
    await payments.cancel(first.paymentId, userId, { date: `${BANK_YEAR}-10-16` });
    await db.transaction((tx) => payments.createInTx(tx, input, userId, { bankFileEntryId: entry.id }));
  });
});

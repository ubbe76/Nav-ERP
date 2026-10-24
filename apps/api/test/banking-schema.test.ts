import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { bankFileEntries, bankFiles, db, numberSeries, paymentBatchItems, paymentBatches, suppliers, supplierInvoices } from "@navet/db";
import { isBookkeepingLockViolation } from "../src/modules/system/service/db-errors.js";
import { expectConstraint, failure } from "./helpers/year-end.js";
import { makeApprovedSupplierInvoice, makeSupplier, resetBanking, setupBanking } from "./helpers/banking.js";

let userId: string;
beforeEach(async () => {
  await resetBanking();
  userId = (await setupBanking()).user.id;
});
afterAll(resetBanking);

async function makeBatch(number: string) {
  const [batch] = await db.insert(paymentBatches).values({ batchNumber: number, bankAccountNumber: "1930" }).returning();
  return batch!;
}

describe("migration 0107", () => {
  it("seeds the BO- number series", async () => {
    const [row] = await db.select().from(numberSeries).where(eq(numberSeries.key, "payment_batch"));
    expect(row?.prefix).toBe("BO-");
  });

  it("requires the field the supplier's payment method names", async () => {
    await expectConstraint(
      db.insert(suppliers).values({ name: "X", supplierNumber: "T-1", paymentMethod: "bankgiro" }),
      "suppliers_payment_method_details"
    );
    await expectConstraint(
      db.insert(suppliers).values({ name: "X", supplierNumber: "T-2", paymentMethod: "bank_account", bankClearing: "8327" }),
      "suppliers_payment_method_details"
    );
    const ok = await makeSupplier({ paymentMethod: "bankgiro", bankgiro: "50501055" });
    expect(ok.paymentMethod).toBe("bankgiro");
  });

  it("keeps the invoice's reference kind and value together", async () => {
    const supplier = await makeSupplier();
    await expectConstraint(
      makeApprovedSupplierInvoice(supplier.id, { registrationNumber: "LF-T1", gross: 100, paymentReferenceKind: "ocr" }),
      "supplier_invoices_payment_reference_pair"
    );
  });

  it("reserves an invoice in at most one live batch row", async () => {
    const supplier = await makeSupplier();
    const invoice = await makeApprovedSupplierInvoice(supplier.id, { registrationNumber: "LF-T2", gross: 100 });
    const a = await makeBatch("BO-T1");
    const b = await makeBatch("BO-T2");
    const row = { supplierInvoiceId: invoice.id, supplierId: supplier.id, amount: "100", executionDate: "2024-10-15" };
    await db.insert(paymentBatchItems).values({ ...row, batchId: a.id, seq: 1, endToEndId: "BO-T1-1" });
    await expectConstraint(
      db.insert(paymentBatchItems).values({ ...row, batchId: b.id, seq: 1, endToEndId: "BO-T2-1" }),
      "payment_batch_items_invoice_live"
    );
    // A rejected row frees the invoice.
    await db.update(paymentBatchItems).set({ status: "rejected" }).where(eq(paymentBatchItems.batchId, a.id));
    await db.insert(paymentBatchItems).values({ ...row, batchId: b.id, seq: 1, endToEndId: "BO-T2-1" });
    await expectConstraint(
      db.insert(paymentBatchItems).values({ ...row, batchId: b.id, seq: 2, endToEndId: "BO-T2-2", amount: "0", supplierInvoiceId: invoice.id }),
      "payment_batch_items_amount_positive"
    );
  });

  it("locks an archived bank file but lets a deleted user's id be nulled", async () => {
    const [file] = await db
      .insert(bankFiles)
      .values({
        direction: "incoming", messageType: "camt.054.001.02", filename: "a.xml", contentType: "application/xml",
        sizeBytes: 3, sha256: "a".repeat(64), data: Buffer.from("abc"), uploadedBy: userId,
      })
      .returning();
    const update = await failure(db.update(bankFiles).set({ filename: "b.xml" }).where(eq(bankFiles.id, file!.id)));
    expect(isBookkeepingLockViolation(update)).toBe(true);
    const del = await failure(db.delete(bankFiles).where(eq(bankFiles.id, file!.id)));
    expect(isBookkeepingLockViolation(del)).toBe(true);
    await db.update(bankFiles).set({ uploadedBy: null }).where(eq(bankFiles.id, file!.id));
    const [after] = await db.select({ uploadedBy: bankFiles.uploadedBy, filename: bankFiles.filename }).from(bankFiles);
    expect(after).toEqual({ uploadedBy: null, filename: "a.xml" });
  });

  it("ties an outgoing file to its batch and an incoming file to its hash", async () => {
    const base = { messageType: "x", filename: "f.xml", contentType: "application/xml", sizeBytes: 1, data: Buffer.from("x") };
    await expectConstraint(
      db.insert(bankFiles).values({ ...base, direction: "outgoing", sha256: "b".repeat(64) }),
      "bank_files_batch_direction"
    );
    await db.insert(bankFiles).values({ ...base, direction: "incoming", sha256: "c".repeat(64) });
    await expectConstraint(
      db.insert(bankFiles).values({ ...base, direction: "incoming", sha256: "c".repeat(64) }),
      "bank_files_incoming_sha256"
    );
    const batch = await makeBatch("BO-T3");
    await db.insert(bankFiles).values({ ...base, direction: "outgoing", paymentBatchId: batch.id, sha256: "c".repeat(64) });
    await expectConstraint(
      db.insert(bankFiles).values({ ...base, direction: "outgoing", paymentBatchId: batch.id, sha256: "d".repeat(64) }),
      "bank_files_one_per_batch"
    );
  });

  it("never lets an empty supplier invoice reference column through raw SQL either", async () => {
    const supplier = await makeSupplier();
    const invoice = await makeApprovedSupplierInvoice(supplier.id, { registrationNumber: "LF-T4", gross: 10 });
    await expectConstraint(
      db.execute(sql`UPDATE supplier_invoices SET payment_reference = '4605127' WHERE id = ${invoice.id}`),
      "supplier_invoices_payment_reference_pair"
    );
    await db.update(supplierInvoices).set({ paymentReferenceKind: "ocr", paymentReference: "4605127" }).where(eq(supplierInvoices.id, invoice.id));
  });
});

describe("migration 0144 (utlandsbetalningar)", () => {
  it("gives a batch row its currency (förval SEK) and keeps a bank entry's instructed amount and currency together", async () => {
    const supplier = await makeSupplier();
    const invoice = await makeApprovedSupplierInvoice(supplier.id, { registrationNumber: "LF-T20", gross: 100 });
    const batch = await makeBatch("BO-T20");
    const [row] = await db
      .insert(paymentBatchItems)
      .values({ batchId: batch.id, seq: 1, endToEndId: "BO-T20-1", supplierInvoiceId: invoice.id, supplierId: supplier.id, amount: "100", executionDate: "2024-10-15" })
      .returning();
    expect(row!.currency).toBe("SEK");
    const [file] = await db
      .insert(bankFiles)
      .values({ direction: "incoming", messageType: "camt.054.001.02", filename: "fx.xml", contentType: "application/xml", sizeBytes: 1, sha256: "e".repeat(64), data: Buffer.from("x") })
      .returning();
    const entry = {
      bankFileId: file!.id, dedupeSource: "tx_acct_svcr_ref" as const, direction: "debit" as const, account: "1", amount: "13938.75", currency: "SEK",
      bookingDate: "2024-10-15", remittance: [], position: 0,
    };
    await expectConstraint(db.insert(bankFileEntries).values({ ...entry, dedupeKey: "k1", instructedAmount: "1250" }), "bank_file_entries_instructed_pair");
    await expectConstraint(db.insert(bankFileEntries).values({ ...entry, dedupeKey: "k2", chargesAmount: "-1" }), "bank_file_entries_charges_non_negative");
    const [ok] = await db
      .insert(bankFileEntries)
      .values({ ...entry, dedupeKey: "k3", instructedAmount: "1250", instructedCurrency: "EUR", chargesAmount: "25", currencyExchange: { sourceCurrency: "SEK", targetCurrency: "EUR", unitCurrency: "EUR", rate: "11.131" } })
      .returning();
    expect(ok).toMatchObject({ instructedAmount: "1250.00", instructedCurrency: "EUR", chargesAmount: "25.00" });
  });
});

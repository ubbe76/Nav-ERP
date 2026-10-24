import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, count, eq, sql } from "drizzle-orm";
import { auditLog, bankFiles, db, paymentBatchItems, paymentBatches, supplierInvoices, supplierPayments, systemSettings, verifications } from "@navet/db";
import {
  BankSettingsIncompleteError,
  PaymentFileInvalidError,
  SupplierInvoicesNotPayableError,
} from "../src/modules/banking/service/banking.errors.js";
import { createSupplierInvoiceRepository } from "../src/modules/purchase/repository/supplier-invoice.repository.js";
import { createSupplierInvoiceService } from "../src/modules/purchase/service/supplier-invoice.service.js";
import { InvalidStatusTransitionError } from "../src/modules/purchase/service/purchase.service.js";
import { failure } from "./helpers/year-end.js";
import { testEconomyService } from "./helpers/services.js";
import { validateAgainstXsd } from "./helpers/xsd.js";
import {
  buildPaymentBatchService,
  configureSwedbank,
  makeApprovedSupplierInvoice,
  makeSupplier,
  numericPart,
  periodStarting,
  resetBanking,
  resetBankSettings,
  setupBanking,
  snapshotCompany,
  swedbankSupplier,
  testPoster,
  testSupplierPaymentService,
} from "./helpers/banking.js";

const service = buildPaymentBatchService();
let restoreCompany: () => Promise<void>;
let userId: string;
beforeAll(async () => {
  restoreCompany = await snapshotCompany();
});
beforeEach(async () => {
  await resetBanking();
  await resetBankSettings();
  userId = (await setupBanking()).user.id;
  await configureSwedbank();
});
afterAll(async () => {
  await resetBankSettings();
  await restoreCompany();
  await resetBanking();
});

// The spec's three invoices, in 2024: due 10-15, 10-12 (plusgiro) and one
// already overdue (09-30 → paid today, 2024-10-09).
async function threeInvoices() {
  const bg = await swedbankSupplier();
  const pg = await makeSupplier({ name: "Svets & Montage i Exempelby AB", postalCode: "827 30", city: "Ljusdal", paymentMethod: "plusgiro", plusgiro: "4892162" });
  const acct = await makeSupplier({ name: "Exempelhydraulik AB", postalCode: "803 09", city: "Gävle", paymentMethod: "bank_account", bankClearing: "83279", bankAccountNumber: "9941234123" });
  const a = await makeApprovedSupplierInvoice(bg.id, { registrationNumber: "LF-41", gross: 12500, dueDate: "2024-10-15", paymentReferenceKind: "ocr", paymentReference: "4605127" });
  const b = await makeApprovedSupplierInvoice(pg.id, { registrationNumber: "LF-42", gross: 3480, dueDate: "2024-10-12", paymentReferenceKind: "message", paymentReference: "Faktura 2026-118" });
  const c = await makeApprovedSupplierInvoice(acct.id, { registrationNumber: "LF-43", gross: 8850, dueDate: "2024-09-30", invoiceNumber: "88213" });
  return { a, b, c };
}

describe("skapa omgång", () => {
  it("reserves the invoices with one row each: open amount, EndToEndId, date = max(due, today)", async () => {
    const { a, b, c } = await threeInvoices();
    const batch = await service.create({ invoiceIds: [a.id, b.id, c.id] }, userId);
    expect(batch.status).toBe("draft");
    expect(batch.bankAccountNumber).toBe("1930");
    const n = numericPart(batch.batchNumber);
    expect(batch.items.map((i) => [i.seq, i.endToEndId, i.registrationNumber, i.amount, i.executionDate, i.status])).toEqual([
      [1, `BO-${n}-1`, "LF-41", 12500, "2024-10-15", "pending"],
      [2, `BO-${n}-2`, "LF-42", 3480, "2024-10-12", "pending"],
      [3, `BO-${n}-3`, "LF-43", 8850, "2024-10-09", "pending"],
    ]);
    expect(batch.items[1]!.warnings).toEqual(['Mottagarens namn skickas som "Svets och Montage i Exempelby AB"']);
  });

  it("refuses every unpayable invoice in one error", async () => {
    const ok = await swedbankSupplier();
    const noDetails = await makeSupplier({ name: "Utan Konto AB" });
    const foreign = await makeSupplier({ name: "Nordic Fasteners GmbH", paymentMethod: "iban", iban: "DE89370400440532013000", bic: "COBADEFF" });
    const credit = await makeApprovedSupplierInvoice(ok.id, { registrationNumber: "LF-50", gross: -200 });
    const missing = await makeApprovedSupplierInvoice(noDetails.id, { registrationNumber: "LF-51", gross: 100 });
    const abroad = await makeApprovedSupplierInvoice(foreign.id, { registrationNumber: "LF-52", gross: 4100 });
    const reserved = await makeApprovedSupplierInvoice(ok.id, { registrationNumber: "LF-53", gross: 100 });
    const first = await service.create({ invoiceIds: [reserved.id] }, userId);
    const error = await failure(service.create({ invoiceIds: [credit.id, missing.id, abroad.id, reserved.id] }, userId));
    expect(error).toBeInstanceOf(SupplierInvoicesNotPayableError);
    // Valuta steg 2: the foreign IBAN (LF-52) is payable now.
    expect((error as SupplierInvoicesNotPayableError).details).toEqual([
      { invoiceId: credit.id, registrationNumber: "LF-50", reason: "credit_note" },
      { invoiceId: missing.id, registrationNumber: "LF-51", reason: "no_payment_details" },
      { invoiceId: reserved.id, registrationNumber: "LF-53", reason: "already_in_batch", batchNumber: first.batchNumber },
    ]);
  });

  // Valuta steg 2: an invoice in another currency goes into the batch in
  // its own currency (utlandsbetalningar, foreign-payment-batch.test.ts).
  it("takes a foreign-currency invoice and a foreign IBAN, in the invoice's currency", async () => {
    const foreign = await makeSupplier({ name: "Nordic Fasteners GmbH", paymentMethod: "iban", iban: "DE89370400440532013000", bic: "COBADEFF", country: "DE" });
    const eur = await makeApprovedSupplierInvoice(foreign.id, { registrationNumber: "LF-60", gross: 100, currency: "EUR" });
    const batch = await service.create({ invoiceIds: [eur.id] }, userId);
    expect(batch.items.map((i) => [i.registrationNumber, i.amount, i.currency, i.paymentKind])).toEqual([["LF-60", 100, "EUR", "sepa"]]);
    expect(batch.totalAmount).toBe(0);
    expect(batch.totalsByCurrency).toEqual([{ currency: "EUR", amount: 100 }]);
  });

  it("refuses without bank settings", async () => {
    await resetBankSettings();
    const { a } = await threeInvoices();
    expect(await failure(service.create({ invoiceIds: [a.id] }, userId))).toBeInstanceOf(BankSettingsIncompleteError);
  });

  it("lists the invoice's batch rows on the invoice detail", async () => {
    const { a } = await threeInvoices();
    const batch = await service.create({ invoiceIds: [a.id] }, userId);
    const detail = await createSupplierInvoiceService(createSupplierInvoiceRepository(db), testPoster).getInvoice(a.id);
    expect(detail!.paymentBatches).toEqual([{ batchId: batch.id, batchNumber: batch.batchNumber, endToEndId: batch.items[0]!.endToEndId, itemStatus: "pending" }]);
  });
});

describe("redigera utkast", () => {
  it("edits amount/date within limits, removes a row, and refuses edits after export", async () => {
    const { a, b } = await threeInvoices();
    const batch = await service.create({ invoiceIds: [a.id, b.id] }, userId);
    const [first, second] = batch.items;
    const edited = await service.updateItem(batch.id, first!.id, { amount: 10000, executionDate: "2024-10-20" }, userId);
    expect(edited.items[0]).toMatchObject({ amount: 10000, executionDate: "2024-10-20" });
    expect((await failure(service.updateItem(batch.id, first!.id, { amount: 12500.01 }, userId))) as Error).toHaveProperty("name", "InvalidPaymentBatchItemError");
    expect((await failure(service.updateItem(batch.id, first!.id, { executionDate: "2024-10-08" }, userId))) as Error).toHaveProperty("name", "InvalidPaymentBatchItemError");
    // positive() lets 0.004 through zod; it rounds to 0 and is refused (not a CHECK 500).
    expect((await failure(service.updateItem(batch.id, first!.id, { amount: 0.004 }, userId))) as Error).toHaveProperty("name", "InvalidPaymentBatchItemError");
    const removed = await service.removeItem(batch.id, second!.id, userId);
    expect(removed.items).toHaveLength(1);
    await service.export(batch.id, userId);
    expect(await failure(service.updateItem(batch.id, first!.id, { amount: 1 }, userId))).toBeInstanceOf(InvalidStatusTransitionError);
  });
});

describe("exportera", () => {
  it("archives the XSD-valid pain.001 with sha256 and snapshots what the file said", async () => {
    const { a, b, c } = await threeInvoices();
    const batch = await service.create({ invoiceIds: [a.id, b.id, c.id] }, userId);
    const exported = await service.export(batch.id, userId);
    expect(exported.status).toBe("exported");
    expect(exported.items.every((i) => i.status === "exported")).toBe(true);
    expect(exported.items[2]!.creditor).toMatchObject({ method: "bank_account", account: "832799941234123", reference: "88213", referenceKind: "message" });
    const file = await service.getFile(batch.id);
    expect(file.filename).toBe(`${batch.batchNumber}.xml`);
    expect(await validateAgainstXsd(file.data.toString("utf8"), "pain.001.001.03")).toEqual([]);
    expect(file.data.toString("utf8")).toContain(`<MsgId>${batch.batchNumber}</MsgId>`);
    expect(file.data.toString("utf8")).toContain("<CreDtTm>2024-10-09T12:00:00</CreDtTm>");
    expect(exported.file).toMatchObject({ sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(await failure(service.export(batch.id, userId))).toBeInstanceOf(InvalidStatusTransitionError);
  });

  it("moves passed execution dates to today and logs it", async () => {
    const { a } = await threeInvoices();
    const batch = await service.create({ invoiceIds: [a.id] }, userId);
    const later = buildPaymentBatchService(() => new Date("2024-10-20T10:00:00Z"));
    const exported = await later.export(batch.id, userId);
    expect(exported.items[0]!.executionDate).toBe("2024-10-20");
    const [entry] = await db.select().from(auditLog).where(and(eq(auditLog.entityType, "payment_batch"), eq(auditLog.action, "exported")));
    expect((entry!.detail as { movedDates: unknown[] }).movedDates).toEqual([{ endToEndId: exported.items[0]!.endToEndId, from: "2024-10-15", to: "2024-10-20" }]);
  });

  it("refuses a file the bank would reject and writes nothing", async () => {
    const supplier = await swedbankSupplier({ city: null });
    const invoice = await makeApprovedSupplierInvoice(supplier.id, { registrationNumber: "LF-60", gross: 100 });
    const batch = await service.create({ invoiceIds: [invoice.id] }, userId);
    const error = await failure(service.export(batch.id, userId));
    expect(error).toBeInstanceOf(PaymentFileInvalidError);
    expect((error as PaymentFileInvalidError).violations.map((v) => v.field)).toEqual(["creditorCity"]);
    expect((await service.get(batch.id)).status).toBe("draft");
    expect((await db.select({ n: count() }).from(bankFiles))[0]!.n).toBe(0);
  });
});

describe("bekräfta, avvisa, retur och makulera", () => {
  // The bank file / manual confirmation comes after the execution date.
  const after15th = buildPaymentBatchService(() => new Date("2024-10-16T10:00:00Z"));

  it("Bekräfta utförd books one UTB per row with the batch's account and links, then confirms the batch", async () => {
    const { a, b, c } = await threeInvoices();
    const batch = await service.create({ invoiceIds: [a.id, b.id, c.id] }, userId);
    await service.export(batch.id, userId);
    const { results, batch: after } = await after15th.confirm(batch.id, { paymentDate: "2024-10-15" }, userId);
    expect(results.map((r) => r.ok)).toEqual([true, true, true]);
    expect(after.status).toBe("confirmed");
    const payments = await db.select().from(supplierPayments);
    expect(payments).toHaveLength(3);
    for (const p of payments) {
      expect(p).toMatchObject({ paymentDate: "2024-10-15", bankAccountNumber: "1930", bankFileEntryId: null });
      expect(after.items.map((i) => i.id)).toContain(p.paymentBatchItemId);
    }
    const statuses = await db.select({ status: supplierInvoices.status }).from(supplierInvoices);
    expect(statuses.every((s) => s.status === "paid")).toBe(true);
  });

  // Review Focus 3: confirmation dated in a locked period.
  it("a locked period fails each row with nothing half-written", async () => {
    const { a, b } = await threeInvoices();
    const batch = await service.create({ invoiceIds: [a.id, b.id] }, userId);
    await service.export(batch.id, userId);
    await testEconomyService.lockPeriod((await periodStarting("2024-10-01")).id, userId);
    const { results, batch: after } = await after15th.confirm(batch.id, { paymentDate: "2024-10-15" }, userId);
    expect(results.map((r) => [r.ok, r.error?.code])).toEqual([
      [false, "accounting-period-locked"],
      [false, "accounting-period-locked"],
    ]);
    expect(after.status).toBe("exported");
    expect(after.items.map((i) => i.status)).toEqual(["exported", "exported"]);
    expect((await db.select({ n: count() }).from(supplierPayments))[0]!.n).toBe(0);
    expect((await db.select({ n: count() }).from(verifications))[0]!.n).toBe(0);
  });

  // Final review (spec §4.4 confirmManual(id, { paymentDate, itemIds })):
  // only the chosen rows are confirmed, and a chosen id that is not an
  // exported row of this batch is answered per row — never silently dropped.
  it("Bekräfta utförd confirms only the chosen rows and reports the ones it cannot confirm", async () => {
    const { a, b, c } = await threeInvoices();
    const batch = await service.create({ invoiceIds: [a.id, b.id, c.id] }, userId);
    await service.export(batch.id, userId);
    await service.rejectItem(batch.id, batch.items[1]!.id, { reason: "Avvisad i internetbanken" }, userId);
    const foreign = "00000000-0000-4000-8000-000000000000";
    const { results, batch: after } = await after15th.confirm(
      batch.id,
      { paymentDate: "2024-10-15", itemIds: [foreign, batch.items[1]!.id, batch.items[0]!.id] },
      userId
    );
    expect(results.map((r) => [r.itemId, r.ok, r.error?.code])).toEqual([
      [batch.items[0]!.id, true, undefined],
      [batch.items[1]!.id, false, "payment-batch-item-not-confirmable"],
      [foreign, false, "payment-batch-item-not-confirmable"],
    ]);
    // The third row was not chosen: it still waits for the bank.
    expect(after.items.map((i) => i.status)).toEqual(["confirmed", "rejected", "exported"]);
    expect(after.status).toBe("exported");
    expect((await db.select({ n: count() }).from(supplierPayments))[0]!.n).toBe(1);
  });

  it("a date in the future is refused before anything runs", async () => {
    const { a } = await threeInvoices();
    const batch = await service.create({ invoiceIds: [a.id] }, userId);
    await service.export(batch.id, userId);
    expect(await failure(service.confirm(batch.id, { paymentDate: "2024-10-10" }, userId))).toHaveProperty("name", "InvalidPaymentDateError");
  });

  it("Markera som avvisad frees the invoice; the last open row closes the batch", async () => {
    const { a, b } = await threeInvoices();
    const batch = await service.create({ invoiceIds: [a.id, b.id] }, userId);
    await service.export(batch.id, userId);
    await service.confirm(batch.id, { paymentDate: "2024-10-09", itemIds: [batch.items[0]!.id] }, userId);
    expect((await service.get(batch.id)).status).toBe("exported");
    const rejected = await service.rejectItem(batch.id, batch.items[1]!.id, { reason: "Fel kontonummer enligt banken" }, userId);
    expect(rejected.status).toBe("confirmed");
    expect(rejected.items[1]).toMatchObject({ status: "rejected", rejectedReason: "Fel kontonummer enligt banken" });
    const again = await service.create({ invoiceIds: [b.id] }, userId);
    expect(again.items).toHaveLength(1);
  });

  it("a bank return cancels the UTB on the return's booking date and reopens the invoice", async () => {
    const { a } = await threeInvoices();
    const batch = await service.create({ invoiceIds: [a.id] }, userId);
    await service.export(batch.id, userId);
    await service.confirm(batch.id, { paymentDate: "2024-10-09" }, userId);
    const itemId = batch.items[0]!.id;
    await db.transaction((tx) => service.returnItemInTx(tx, itemId, { id: null, bookingDate: "2024-10-09", returnReason: "AC01" }, userId));
    const after = await service.get(batch.id);
    expect(after.items[0]).toMatchObject({ status: "returned" });
    const [payment] = await db.select().from(supplierPayments);
    expect(payment!.cancelledAt).not.toBeNull();
    const [invoice] = await db.select({ status: supplierInvoices.status }).from(supplierInvoices).where(eq(supplierInvoices.id, a.id));
    expect(invoice!.status).toBe("approved");
  });

  it("Makulera omgång works from draft and from exported without confirmations, never after one", async () => {
    const { a, b } = await threeInvoices();
    const draft = await service.create({ invoiceIds: [a.id] }, userId);
    expect((await service.cancel(draft.id, userId)).status).toBe("cancelled");
    const exported = await service.create({ invoiceIds: [a.id, b.id] }, userId);
    await service.export(exported.id, userId);
    await service.confirm(exported.id, { paymentDate: "2024-10-09", itemIds: [exported.items[0]!.id] }, userId);
    expect(await failure(service.cancel(exported.id, userId))).toBeInstanceOf(InvalidStatusTransitionError);
    const [file] = await db.select({ id: bankFiles.id }).from(bankFiles).where(eq(bankFiles.paymentBatchId, exported.id));
    expect(file).toBeDefined();
    const items = await db.select({ status: paymentBatchItems.status }).from(paymentBatchItems).where(eq(paymentBatchItems.batchId, draft.id));
    expect(items.map((i) => i.status)).toEqual(["cancelled"]);
    const [b2] = await db.select({ status: paymentBatches.status }).from(paymentBatches).where(eq(paymentBatches.id, draft.id));
    expect(b2!.status).toBe("cancelled");
  });
});

// Polls until `n` backends of this database wait on a lock (no fixed sleep).
async function waitForLockWaiters(n: number) {
  for (let i = 0; i < 200; i++) {
    const [row] = [...(await db.execute(sql`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`))] as { n: number }[];
    if (row!.n >= n) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${n} lock waiters`);
}

// Spec §12 cases owned by this task, beyond the brief's status flow.
describe("spec §12: reservation, inställningar och samtidighet", () => {
  const after15th = buildPaymentBatchService(() => new Date("2024-10-16T10:00:00Z"));

  it("all rows rejected ⇒ the batch is confirmed with no booking at all (documented)", async () => {
    const { a, b } = await threeInvoices();
    const batch = await service.create({ invoiceIds: [a.id, b.id] }, userId);
    await service.export(batch.id, userId);
    await service.rejectItem(batch.id, batch.items[0]!.id, { reason: "Avvisad i internetbanken" }, userId);
    const after = await service.rejectItem(batch.id, batch.items[1]!.id, { reason: "Avvisad i internetbanken" }, userId);
    expect(after.status).toBe("confirmed");
    expect(after.confirmedAt).not.toBeNull();
    expect(after.items.map((i) => i.status)).toEqual(["rejected", "rejected"]);
    expect((await db.select({ n: count() }).from(supplierPayments))[0]!.n).toBe(0);
    expect((await db.select({ n: count() }).from(verifications))[0]!.n).toBe(0);
    const [entry] = await db.select().from(auditLog).where(and(eq(auditLog.entityType, "payment_batch"), eq(auditLog.action, "confirmed")));
    expect(entry).toBeDefined();
    // Both invoices are free again.
    expect((await service.create({ invoiceIds: [a.id, b.id] }, userId)).items).toHaveLength(2);
  });

  it("settings changed after creation: incomplete ⇒ 409 at export with nothing written; a changed id is read live", async () => {
    const { a } = await threeInvoices();
    const batch = await service.create({ invoiceIds: [a.id] }, userId);
    await db.delete(systemSettings).where(eq(systemSettings.key, "bank_initiating_party_id"));
    const error = await failure(service.export(batch.id, userId));
    expect(error).toBeInstanceOf(BankSettingsIncompleteError);
    expect((await service.get(batch.id)).status).toBe("draft");
    expect((await db.select({ n: count() }).from(bankFiles))[0]!.n).toBe(0);

    // Stored raw (hyphen, lower case): the file carries BankReady's normalized id.
    await db.insert(systemSettings).values({ key: "bank_initiating_party_id", value: "123456789123-b002" });
    await service.export(batch.id, userId);
    const xml = (await service.getFile(batch.id)).data.toString("utf8");
    expect(xml).toContain("<Id>123456789123B002</Id>");
    expect(await validateAgainstXsd(xml, "pain.001.001.03")).toEqual([]);
  });

  it("the same invoice in two concurrent creations ⇒ one batch, one already_in_batch", async () => {
    const { a } = await threeInvoices();
    const outcomes = await Promise.allSettled([service.create({ invoiceIds: [a.id] }, userId), service.create({ invoiceIds: [a.id] }, userId)]);
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((o) => o.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(SupplierInvoicesNotPayableError);
    expect((rejected.reason as SupplierInvoicesNotPayableError).details[0]!.reason).toBe("already_in_batch");
    expect((await db.select({ n: count() }).from(paymentBatchItems))[0]!.n).toBe(1);
  });

  // Spec §12 "manuell och camt samtidigt ⇒ exakt en UTB". The camt path
  // (Task 8) books through the same confirmItemInTx, so the row lock pinned
  // here is what serializes it; this pins manual-vs-manual.
  it("two concurrent Bekräfta utförd book exactly one UTB per row; the loser's row reports not-confirmable", async () => {
    const { a } = await threeInvoices();
    const batch = await service.create({ invoiceIds: [a.id] }, userId);
    await service.export(batch.id, userId);
    // Hold the batch so both confirmations read the row as exported and
    // queue on the batch lock — then release them together.
    let both: Promise<Awaited<ReturnType<typeof service.confirm>>[]> | undefined;
    await db.transaction(async (holder) => {
      await holder.select({ id: paymentBatches.id }).from(paymentBatches).where(eq(paymentBatches.id, batch.id)).for("update");
      both = Promise.all([
        after15th.confirm(batch.id, { paymentDate: "2024-10-15" }, userId),
        after15th.confirm(batch.id, { paymentDate: "2024-10-15" }, userId),
      ]);
      await waitForLockWaiters(2);
    });
    const [first, second] = await both!;
    const results = [...first.results, ...second.results];
    expect(results).toHaveLength(2);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const loser = results.find((r) => !r.ok)!;
    expect(loser.ok === false && loser.error.code).toBe("payment-batch-item-not-confirmable");
    expect((await db.select({ n: count() }).from(supplierPayments))[0]!.n).toBe(1);
    expect((await service.get(batch.id)).status).toBe("confirmed");
  });

  // Binding carry from Task 7: a confirmed row always has its live UTB.
  it("a return of a confirmed row without a live payment is refused, nothing written", async () => {
    const { a } = await threeInvoices();
    const batch = await service.create({ invoiceIds: [a.id] }, userId);
    await service.export(batch.id, userId);
    await db.update(paymentBatchItems).set({ status: "confirmed" }).where(eq(paymentBatchItems.id, batch.items[0]!.id));
    const error = await failure(db.transaction((tx) => service.returnItemInTx(tx, batch.items[0]!.id, { id: null, bookingDate: "2024-10-09", returnReason: "AC01" }, userId)));
    expect((error as Error).message).toContain("has no live payment");
    const [item] = await db.select({ status: paymentBatchItems.status }).from(paymentBatchItems).where(eq(paymentBatchItems.id, batch.items[0]!.id));
    expect(item!.status).toBe("confirmed");
  });

  it("confirming a row that is no longer exported (rejected) is refused per row", async () => {
    const { a, b } = await threeInvoices();
    const batch = await service.create({ invoiceIds: [a.id, b.id] }, userId);
    await service.export(batch.id, userId);
    await service.rejectItem(batch.id, batch.items[1]!.id, { reason: "Fel konto" }, userId);
    const error = await failure(db.transaction((tx) => service.confirmItemInTx(tx, batch.items[1]!.id, { paymentDate: "2024-10-09", bankFileEntryId: null }, userId)));
    expect(error).toHaveProperty("name", "PaymentBatchItemNotConfirmableError");
    expect((await db.select({ n: count() }).from(supplierPayments))[0]!.n).toBe(0);
  });
});

// Spec §4.6: the purchase module's views of a reserved / batch-paid invoice.
describe("öppna poster och betalningskortet", () => {
  it("open items carry the live batch and the payment method; the UTB detail names its batch row", async () => {
    const { a, b } = await threeInvoices();
    const batch = await service.create({ invoiceIds: [a.id] }, userId);
    const open = await testSupplierPaymentService.listOpenInvoices({ limit: 50, offset: 0 });
    const rowA = open.rows.find((r) => r.id === a.id)!;
    const rowB = open.rows.find((r) => r.id === b.id)!;
    expect(rowA).toMatchObject({ supplierPaymentMethod: "bankgiro", paymentBatch: { id: batch.id, batchNumber: batch.batchNumber, status: "draft" } });
    expect(rowB).toMatchObject({ supplierPaymentMethod: "plusgiro", paymentBatch: null });
    expect(rowA).not.toHaveProperty("paymentBatchId");
    expect(open.total).toBe(3);

    await service.export(batch.id, userId);
    const { results } = await service.confirm(batch.id, { paymentDate: "2024-10-09" }, userId);
    const [payment] = await db.select({ id: supplierPayments.id }).from(supplierPayments);
    const detail = await testSupplierPaymentService.getPayment(payment!.id);
    expect(results[0]!.ok).toBe(true);
    expect(detail!.paymentBatchItem).toEqual({ id: batch.items[0]!.id, batchId: batch.id, batchNumber: batch.batchNumber, endToEndId: batch.items[0]!.endToEndId });
    // A paid invoice is no open item; a rejected row no longer shows.
    expect((await testSupplierPaymentService.listOpenInvoices({ limit: 50, offset: 0 })).rows.map((r) => r.id)).not.toContain(a.id);
  });
});

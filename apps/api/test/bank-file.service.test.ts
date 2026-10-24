import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, count, eq, sql } from "drizzle-orm";
import { auditLog, bankFileEntries, bankFiles, companyInfo, customerPayments, db, invoices, paymentBatches, paymentBatchItems, supplierInvoices, supplierPayments, verifications } from "@navet/db";
import { createBankFileRepository } from "../src/modules/banking/repository/bank-file.repository.js";
import { createBankFileService } from "../src/modules/banking/service/bank-file.service.js";
import { computeOpenAmounts } from "../src/modules/purchase/repository/open-amounts.js";
import { isUniqueViolation } from "../src/modules/system/service/db-errors.js";
import { computeOcrNumber } from "../src/modules/system/service/ocr.js";
import { testEconomyService } from "./helpers/services.js";
import { camtFile } from "./helpers/camt.js";
import {
  buildBankFileService,
  buildPaymentBatchService,
  configureSwedbank,
  fixtureXml,
  makeApprovedSupplierInvoice,
  makeCustomer,
  makeIssuedCustomerInvoice,
  periodStarting,
  resetBanking,
  resetBankSettings,
  setupBanking,
  snapshotCompany,
  swedbankSupplier,
  testPaymentService,
  testSupplierPaymentService,
} from "./helpers/banking.js";

const files = buildBankFileService();
const batches = buildPaymentBatchService();
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

const upload = (xml: string, filename = "camt054.xml") => files.upload({ filename, contentType: "application/xml", data: Buffer.from(xml) }, userId);

// Polls until `n` backends of this database wait on a lock (no fixed sleep).
async function waitForLockWaiters(n: number) {
  for (let i = 0; i < 200; i++) {
    const [row] = [...(await db.execute(sql`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`))] as { n: number }[];
    if (row!.n >= n) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${n} lock waiters`);
}

// The worked example's customers and open invoices (spec "Inbetalning").
async function receivables() {
  const fonster = await makeCustomer("AB Fönsterbolaget");
  const ror = await makeCustomer("Rörfirman i Exempelby AB");
  const bygg = await makeCustomer("Bygg & Kakel i Älvby AB");
  const alfa = await makeCustomer("Alfa Verkstad AB");
  return {
    fonster,
    fa5012: await makeIssuedCustomerInvoice(fonster.id, { invoiceNumber: "FA-5012", gross: 10000 }),
    fa5015: await makeIssuedCustomerInvoice(ror.id, { invoiceNumber: "FA-5015", gross: 10000 }),
    fa5020: await makeIssuedCustomerInvoice(bygg.id, { invoiceNumber: "FA-5020", gross: 6250 }),
    fa5030: await makeIssuedCustomerInvoice(alfa.id, { invoiceNumber: "FA-5030", gross: 7000 }),
    fa5031: await makeIssuedCustomerInvoice(alfa.id, { invoiceNumber: "FA-5031", gross: 500, type: "credit" }),
  };
}

describe("uppladdning", () => {
  it("stores one file and one row per transaction; the same bytes again change nothing", async () => {
    const first = await upload(fixtureXml("camt054-swedbank-credit.xml"));
    expect(first.created).toBe(true);
    expect(first.file).toMatchObject({ entryCount: 5, skippedDuplicates: 0, warnings: ["Post med status PDNG hoppades över (bara bokförda poster läses)"] });
    const again = await upload(fixtureXml("camt054-swedbank-credit.xml"), "samma-fil-nytt-namn.xml");
    expect(again).toMatchObject({ created: false, file: { id: first.file.id } });
    expect((await db.select({ n: count() }).from(bankFiles))[0]!.n).toBe(1);
    expect((await db.select({ n: count() }).from(bankFileEntries))[0]!.n).toBe(5);
    const logged = await db.select().from(auditLog).where(and(eq(auditLog.entityType, "bank_file"), eq(auditLog.action, "uploaded")));
    expect(logged).toHaveLength(1);
  });

  it("skips entries an overlapping file already brought in", async () => {
    await upload(fixtureXml("camt054-swedbank-credit.xml"));
    const overlapping = camtFile({
      messageId: "SWEDSESSCRED20241009999999",
      account: "821491234567890",
      entries: [
        {
          direction: "credit",
          amount: 10500,
          bookingDate: "2024-10-09",
          txs: [
            { acctSvcrRef: "202410098402000100000001", amount: 10000, counterparty: "AB FONSTERBOLAGET", refs: [{ type: "CINV", value: "501262", amount: 10000 }] },
            { acctSvcrRef: "202410098402000100000099", amount: 500, counterparty: "NY KUND AB" },
          ],
        },
      ],
    });
    const first = (await db.select({ id: bankFiles.id }).from(bankFiles))[0]!;
    const second = await upload(overlapping, "camt054_20241009.xml");
    expect(second.file).toMatchObject({ entryCount: 1, skippedDuplicates: 1 });
    // Spec §6.1: the answer names the file the skipped entries came from,
    // and the new file's own summary says so for good.
    expect(second.skippedFrom).toEqual([{ bankFileId: first.id, filename: "camt054.xml", count: 1 }]);
    expect(second.file.warnings).toContain("1 post var redan inläst (fil camt054.xml)");
    expect((await upload(fixtureXml("camt054-swedbank-credit.xml"))).skippedFrom).toEqual([]);
  });

  it("a fresh file names no earlier file", async () => {
    const { skippedFrom, file } = await upload(fixtureXml("camt054-swedbank-credit.xml"));
    expect(skippedFrom).toEqual([]);
    expect(file.warnings).toEqual(["Post med status PDNG hoppades över (bara bokförda poster läses)"]);
  });

  it("the same bytes uploaded concurrently become one file", async () => {
    const xml = fixtureXml("camt054-swedbank-credit.xml");
    const outcomes = await Promise.all([upload(xml), upload(xml)]);
    expect(outcomes.filter((o) => o.created)).toHaveLength(1);
    expect(outcomes[0]!.file.id).toBe(outcomes[1]!.file.id);
    expect((await db.select({ n: count() }).from(bankFileEntries))[0]!.n).toBe(5);
  });

  // Final review: a bank reference repeated within one file is two entries,
  // never one silently dropped by the unique key.
  it("keeps both transactions when one file repeats a bank reference, and says so", async () => {
    const xml = camtFile({
      messageId: "DUP-1",
      entries: [
        { direction: "credit", amount: 100, bookingDate: "2024-10-09", txs: [{ acctSvcrRef: "SAME", amount: 100, counterparty: "A AB" }] },
        { direction: "credit", amount: 250, bookingDate: "2024-10-09", txs: [{ acctSvcrRef: "SAME", amount: 250, counterparty: "B AB" }] },
      ],
    });
    const { file } = await upload(xml);
    expect(file.entryCount).toBe(2);
    expect(file.warnings).toEqual([expect.stringContaining("samma bankreferens")]);
    const stored = await db.select({ key: bankFileEntries.dedupeKey, amount: bankFileEntries.amount }).from(bankFileEntries).orderBy(bankFileEntries.position);
    expect(stored).toEqual([
      { key: "5512348|tx:SAME", amount: "100.00" },
      { key: "5512348|tx:SAME#2", amount: "250.00" },
    ]);
    // The same repeat in an overlapping file is recognised, not read again.
    const again = await upload(xml.replace("DUP-1", "DUP-2"), "igen.xml");
    expect(again.file).toMatchObject({ entryCount: 0, skippedDuplicates: 2 });
  });

  // Final review: the notification's own account (Ntfctn/Acct) is shown, and
  // a file for an account the company does not have is flagged — live, so
  // completing Företagsinformation clears it.
  it("names the notification's account and warns when it is none of the company's", async () => {
    const own = await upload(fixtureXml("camt054-swedbank-debit.xml"));
    expect(await files.get(own.file.id)).toMatchObject({ accounts: ["5512348"], accountWarning: null });

    const foreign = await upload(fixtureXml("camt054-nordea-credit.xml"));
    const flagged = await files.get(foreign.file.id);
    expect(flagged.accounts).toEqual(["SE4550000000058398257466"]);
    expect(flagged.accountWarning).toBe(
      "Avin gäller kontot SE4550000000058398257466, som inte är något av företagets konton i Företagsinformation (IBAN, bankgiro, plusgiro). Kontrollera att filen hör till företaget."
    );
    await db.update(companyInfo).set({ iban: "SE45 5000 0000 0583 9825 7466" });
    expect((await files.get(foreign.file.id)).accountWarning).toBeNull();

    // Swedbank reports the bank account (BBAN) behind the bankgiro: it is the
    // company's when the company's IBAN carries that account number.
    const bban = await upload(fixtureXml("camt054-swedbank-credit.xml"));
    expect(await files.get(bban.file.id)).toMatchObject({ accounts: ["821491234567890"], accountWarning: expect.stringContaining("821491234567890") });
    await db.update(companyInfo).set({ iban: "SE13 8000 0821 4912 3456 7890" });
    expect((await files.get(bban.file.id)).accountWarning).toBeNull();
  });

  it("a file that is not a camt.054 stores nothing", async () => {
    const error = await upload("<!DOCTYPE x><x/>").catch((e: Error) => e);
    expect(error).toHaveProperty("name", "BankFileParseError");
    expect((await db.select({ n: count() }).from(bankFiles))[0]!.n).toBe(0);
  });
});

describe("inbetalningar (camt.054 kredit)", () => {
  it("previews the worked example: Matchad, Matchad delbetalning, Förslag, Matchad med kreditnota, Omatchad", async () => {
    await receivables();
    const { file } = await upload(fixtureXml("camt054-swedbank-credit.xml"));
    const view = await files.incomingView(file.id);
    expect(view.map((e) => [e.amount, e.state, e.proposal?.basis ?? null, e.proposal?.partial ?? null])).toEqual([
      [10000, "matched", "ocr", false],
      [9930, "matched", "ocr", true],
      [6250, "suggested", "amount_name", false],
      [6500, "matched", "ocr", false],
      [1200, "unmatched", null, false],
    ]);
    // A warning per content-hash entry (spec §1.6/§3.5), none on the others.
    expect(view.map((e) => e.warning)).toEqual([null, null, null, null, "Banken angav ingen unik referens — posten känns igen på sitt innehåll"]);
  });

  it("books the chosen entries in series K, linked to the entry, each in its own transaction", async () => {
    const r = await receivables();
    const { file } = await upload(fixtureXml("camt054-swedbank-credit.xml"));
    const view = await files.incomingView(file.id);
    const pick = (i: number) => ({ entryId: view[i]!.id, customerId: view[i]!.proposal!.customerId!, rows: view[i]!.proposal!.rows.map((r) => ({ invoiceId: r.invoiceId, appliedAmount: r.appliedAmount })) });
    const { results } = await files.bookIncoming(file.id, { entries: [pick(0), pick(1), pick(2), { ...pick(3), rows: [{ invoiceId: r.fa5030.id, appliedAmount: 6000 }] }] }, userId);
    expect(results.map((x) => [x.ok, x.ok ? x.paymentNumber.startsWith("BET-") : x.error.code])).toEqual([
      [true, true],
      [true, true],
      [true, true],
      [false, "bank-entry-amount-mismatch"],
    ]);
    const payments = await db.select().from(customerPayments);
    expect(payments).toHaveLength(3);
    expect(payments.every((p) => p.paymentDate === "2024-10-09" && p.bankAccountNumber === "1930" && p.bankFileEntryId !== null)).toBe(true);
    const series = await db.execute(sql`SELECT DISTINCT s.code FROM verifications v JOIN verification_series s ON s.id = v.series_id`);
    expect([...series].map((row) => (row as { code: string }).code)).toEqual(["K"]);
    const [fa5012] = await db.select({ status: invoices.status }).from(invoices).where(eq(invoices.id, r.fa5012.id));
    expect(fa5012!.status).toBe("paid");
    const after = await files.incomingView(file.id);
    expect(after.map((e) => e.state)).toEqual(["booked", "booked", "booked", "matched", "unmatched"]);
    expect(after[0]!.payment!.paymentNumber).toBe(results[0]!.ok ? results[0]!.paymentNumber : null);
    const again = await files.bookIncoming(file.id, { entries: [pick(0)] }, userId);
    expect(again.results[0]).toMatchObject({ ok: false, error: { code: "bank-entry-already-booked" } });
    // The payment detail names the bank file it was booked from.
    const detail = await testPaymentService.getPayment(payments.find((p) => p.bankFileEntryId === view[0]!.id)!.id);
    expect(detail!.bankFileEntry).toMatchObject({ bankFileId: file.id, filename: "camt054.xml", dedupeKey: "821491234567890|tx:202410098402000100000001" });
    const logged = await db.select().from(auditLog).where(and(eq(auditLog.entityType, "bank_file"), eq(auditLog.action, "entry_booked")));
    expect(logged).toHaveLength(3);
  });

  // Only the entry's own live-payment indexes mean "already booked"; any
  // other unique violation is a real error and propagates as such.
  it("maps only the *_entry_live unique violations to bank-entry-already-booked", async () => {
    const violation = (constraint: string) => Object.assign(new Error(`duplicate key value violates unique constraint "${constraint}"`), { code: "23505", constraint_name: constraint });
    let constraint = "customer_payments_entry_live";
    const fake = createBankFileService({
      db,
      repo: createBankFileRepository(db),
      batches: buildPaymentBatchService(),
      customerPayments: {
        createInTx: async () => {
          throw violation(constraint);
        },
      },
      receivables: { openReceivables: async () => [], closedByOcrs: async () => [], customersWithOpenItems: async () => [] },
    });
    const { file } = await fake.upload({ filename: "k.xml", contentType: "application/xml", data: Buffer.from(fixtureXml("camt054-swedbank-credit.xml")) }, userId);
    const [entry] = await fake.incomingView(file.id);
    const body = { entries: [{ entryId: entry!.id, customerId: entry!.id, rows: [{ invoiceId: entry!.id, appliedAmount: 10000 }] }] };
    expect((await fake.bookIncoming(file.id, body, userId)).results[0]).toMatchObject({ ok: false, error: { code: "bank-entry-already-booked" } });
    constraint = "customer_payments_payment_number_unique";
    const other = (await fake.bookIncoming(file.id, body, userId)).results[0]!;
    expect(other.ok).toBe(false);
    expect(other.ok === false && other.error.code).not.toBe("bank-entry-already-booked");
    expect(other.ok === false && other.error.error).toContain("customer_payments_payment_number_unique");
    // The real driver error carries the index name where the check reads it.
    const customer = await makeCustomer();
    const live = (n: string) => ({ paymentNumber: n, customerId: customer.id, paymentDate: "2024-10-09", bankAccountNumber: "1930", amount: "1", amountSek: "1", bankFileEntryId: entry!.id });
    await db.insert(customerPayments).values(live("T-1"));
    const real = await db.insert(customerPayments).values(live("T-2")).catch((e: unknown) => e);
    expect(isUniqueViolation(real, "customer_payments_entry_live")).toBe(true);
    expect(isUniqueViolation(real, "customer_payments_payment_number_unique")).toBe(false);
  });

  it("books an entry exactly once under concurrency", async () => {
    await receivables();
    const { file } = await upload(fixtureXml("camt054-swedbank-credit.xml"));
    const [first] = await files.incomingView(file.id);
    const body = { entries: [{ entryId: first!.id, customerId: first!.proposal!.customerId!, rows: [{ invoiceId: first!.proposal!.rows[0]!.invoiceId, appliedAmount: 10000 }] }] };
    const outcomes = await Promise.all([files.bookIncoming(file.id, body, userId), files.bookIncoming(file.id, body, userId)]);
    expect(outcomes.flatMap((o) => o.results).filter((x) => x.ok)).toHaveLength(1);
    expect((await db.select({ n: count() }).from(customerPayments))[0]!.n).toBe(1);
  });

  // Review Focus 4: the preview went stale before booking.
  it("a stale preview fails that row only and leaves the entry unbooked", async () => {
    const r = await receivables();
    const { file } = await upload(fixtureXml("camt054-swedbank-credit.xml"));
    const view = await files.incomingView(file.id);
    await testPaymentService.create(
      { customerId: r.fonster.id, paymentDate: "2024-10-09", bankAccountNumber: "1930", amount: 10000, note: null, rows: [{ invoiceId: r.fa5012.id, appliedAmount: 10000 }] },
      userId
    );
    const pick = (i: number) => ({ entryId: view[i]!.id, customerId: view[i]!.proposal!.customerId!, rows: view[i]!.proposal!.rows.map((x) => ({ invoiceId: x.invoiceId, appliedAmount: x.appliedAmount })) });
    const { results } = await files.bookIncoming(file.id, { entries: [pick(0), pick(1)] }, userId);
    expect(results.map((x) => (x.ok ? "ok" : x.error.code))).toEqual(["invoice-not-open", "ok"]);
    const now = await files.incomingView(file.id);
    expect(now[0]!.state).toBe("unmatched");
    expect(now[0]!.proposal!.reason).toBe(`OCR ${computeOcrNumber("FA-5012")} tillhör FA-5012 som redan är betald — möjlig dubbelbetalning`);
  });

  it("a cancelled BET frees the entry for a new booking", async () => {
    await receivables();
    const { file } = await upload(fixtureXml("camt054-swedbank-credit.xml"));
    const [first] = await files.incomingView(file.id);
    await files.bookIncoming(file.id, { entries: [{ entryId: first!.id, customerId: first!.proposal!.customerId!, rows: [{ invoiceId: first!.proposal!.rows[0]!.invoiceId, appliedAmount: 10000 }] }] }, userId);
    const [payment] = await db.select().from(customerPayments);
    await testPaymentService.cancel(payment!.id, userId, { date: "2024-10-09" });
    expect((await files.incomingView(file.id))[0]!.state).toBe("matched");
    const rebooked = await files.bookIncoming(file.id, { entries: [{ entryId: first!.id, customerId: first!.proposal!.customerId!, rows: [{ invoiceId: first!.proposal!.rows[0]!.invoiceId, appliedAmount: 10000 }] }] }, userId);
    expect(rebooked.results[0]).toMatchObject({ ok: true });
  });

  it("Hanterad utanför Nav hides an entry from booking and can be undone; the direction must match", async () => {
    const { file } = await upload(fixtureXml("camt054-swedbank-credit.xml"));
    const view = await files.incomingView(file.id);
    await files.ignore(file.id, "incoming", view[4]!.id, { reason: "Överföring mellan egna konton" }, userId);
    expect((await files.incomingView(file.id))[4]).toMatchObject({ state: "ignored", ignoreReason: "Överföring mellan egna konton" });
    expect((await files.ignore(file.id, "outgoing", view[3]!.id, { reason: "x" }, userId).catch((e: Error) => e)) as Error).toHaveProperty("name", "BankEntryDirectionError");
    const booked = await files.bookIncoming(file.id, { entries: [{ entryId: view[4]!.id, customerId: view[0]!.id, rows: [{ invoiceId: view[0]!.id, appliedAmount: 1200 }] }] }, userId);
    expect(booked.results[0]).toMatchObject({ ok: false, error: { code: "bank-entry-already-booked" } });
    await files.restore(file.id, "incoming", view[4]!.id, userId);
    expect((await files.incomingView(file.id))[4]!.state).toBe("unmatched");
  });

  it("an entry in another currency is never matched; it can only be handled outside Nav", async () => {
    await receivables();
    const xml = camtFile({
      messageId: "EUR-1",
      entries: [{ direction: "credit", amount: 777, bookingDate: "2024-10-09", txs: [{ acctSvcrRef: "EUR-TX-1", amount: 777, counterparty: "AB FONSTERBOLAGET", refs: [{ type: "CINV", value: "501262" }] }] }],
    }).replaceAll('Ccy="SEK">777.00', 'Ccy="EUR">777.00');
    const { file } = await upload(xml);
    const [entry] = await files.incomingView(file.id);
    expect(entry).toMatchObject({ state: "not_sek", currency: "EUR", proposal: null, warning: "Posten är i EUR — bara SEK hanteras. Markera den som Hanterad utanför Nav." });
    const { results } = await files.bookIncoming(file.id, { entries: [{ entryId: entry!.id, customerId: entry!.id, rows: [{ invoiceId: entry!.id, appliedAmount: 777 }] }] }, userId);
    expect(results[0]).toMatchObject({ ok: false, error: { code: "bank-entry-direction" } });
  });
});

describe("utbetalningar (camt.054 debet och retur)", () => {
  async function exportedBatch() {
    const supplier = await swedbankSupplier();
    const ids = [];
    for (const [nr, gross] of [["LF-81", 12500], ["LF-82", 3480], ["LF-83", 8850]] as const) {
      ids.push((await makeApprovedSupplierInvoice(supplier.id, { registrationNumber: nr, gross, dueDate: "2024-10-15" })).id);
    }
    const batch = await batches.create({ invoiceIds: ids }, userId);
    return batches.export(batch.id, userId);
  }
  const debit = (batch: Awaited<ReturnType<typeof exportedBatch>>, seqs: number[], bookingDate = "2024-10-15", amountOf = (n: number) => n) =>
    camtFile({
      messageId: `DEBT-${bookingDate}-${seqs.join("")}`,
      entries: [
        {
          direction: "debit",
          amount: seqs.reduce((s, q) => s + amountOf(batch.items[q - 1]!.amount), 0),
          bookingDate,
          acctSvcrRef: `E-${bookingDate}-${seqs.join("")}`,
          txs: seqs.map((q) => ({ acctSvcrRef: `T-${batch.items[q - 1]!.endToEndId}-${bookingDate}`, msgId: batch.batchNumber, endToEndId: batch.items[q - 1]!.endToEndId, amount: amountOf(batch.items[q - 1]!.amount) })),
        },
      ],
    });
  const returnOf = (batch: Awaited<ReturnType<typeof exportedBatch>>, seq: number, bookingDate: string) =>
    camtFile({
      messageId: `RET-${seq}-${bookingDate}`,
      entries: [
        {
          direction: "credit",
          reversal: true,
          amount: batch.items[seq - 1]!.amount,
          bookingDate,
          txs: [{ acctSvcrRef: `R-${seq}-${bookingDate}`, msgId: batch.batchNumber, endToEndId: batch.items[seq - 1]!.endToEndId, amount: batch.items[seq - 1]!.amount, returnReason: "AC01" }],
        },
      ],
    });

  it("confirms our payments by EndToEndId; the batch waits for the third", async () => {
    const batch = await exportedBatch();
    const { file } = await upload(debit(batch, [1, 3]));
    const view = await files.outgoingView(file.id);
    expect(view.map((e) => [e.endToEndId, e.state])).toEqual([
      [batch.items[0]!.endToEndId, "matched"],
      [batch.items[2]!.endToEndId, "matched"],
    ]);
    const { results } = await files.bookOutgoing(file.id, { entryIds: view.map((e) => e.id) }, userId);
    expect(results.every((x) => x.ok)).toBe(true);
    const payments = await db.select().from(supplierPayments);
    expect(payments.map((p) => [p.paymentDate, p.bankFileEntryId !== null, p.paymentBatchItemId !== null])).toEqual([
      ["2024-10-15", true, true],
      ["2024-10-15", true, true],
    ]);
    const after = await batches.get(batch.id);
    expect(after.status).toBe("exported");
    expect(after.confirmedCount).toBe(2);
    expect((await files.outgoingView(file.id)).map((e) => e.state)).toEqual(["booked", "booked"]);
    // The UTB detail names the bank file that confirmed it.
    const detail = await testSupplierPaymentService.getPayment(payments[0]!.id);
    expect(detail!.bankFileEntry).toMatchObject({ bankFileId: file.id, filename: "camt054.xml" });
    // Booking the same entry again is refused per row.
    const again = await files.bookOutgoing(file.id, { entryIds: [view[0]!.id] }, userId);
    expect(again.results[0]).toMatchObject({ ok: false, error: { code: "bank-entry-already-booked" } });
  });

  // Spec §6.2 "Redan bekräftad … Visas med UTB-länk": the UTB was booked by
  // hand (or from another file), so the entry itself carries no payment.
  it("a debit for a row confirmed by hand is 'already confirmed' and shows that row's UTB", async () => {
    const batch = await exportedBatch();
    const manual = await batches.confirm(batch.id, { paymentDate: "2024-10-09", itemIds: [batch.items[0]!.id] }, userId);
    const utb = manual.results[0]!;
    const { file } = await upload(debit(batch, [1], "2024-10-09"));
    const [entry] = await files.outgoingView(file.id);
    expect(entry).toMatchObject({ state: "already_confirmed", payment: null, item: { paymentNumber: utb.ok ? utb.paymentNumber : null } });
    expect(entry!.item!.paymentId).toBe((await db.select({ id: supplierPayments.id }).from(supplierPayments))[0]!.id);
  });

  it("refuses a debit with another amount than we sent", async () => {
    const batch = await exportedBatch();
    const { file } = await upload(debit(batch, [1], "2024-10-15", (n) => n - 100));
    const [entry] = await files.outgoingView(file.id);
    expect(entry!.state).toBe("amount_mismatch");
    const { results } = await files.bookOutgoing(file.id, { entryIds: [entry!.id] }, userId);
    expect(results[0]).toMatchObject({ ok: false, error: { code: "bank-entry-amount-differs" } });
  });

  it("a debit that is not ours is unknown and can only be handled outside Nav", async () => {
    const { file } = await upload(
      camtFile({ messageId: "CARD-1", entries: [{ direction: "debit", amount: 349, bookingDate: "2024-10-10", txs: [{ acctSvcrRef: "CARD-TX-1", amount: 349, counterparty: "KONTORSMATERIAL AB" }] }] })
    );
    const [entry] = await files.outgoingView(file.id);
    expect(entry!.state).toBe("unknown");
    const { results } = await files.bookOutgoing(file.id, { entryIds: [entry!.id] }, userId);
    expect(results[0]).toMatchObject({ ok: false, error: { code: "bank-entry-not-matched" } });
    // A credit is not an outgoing entry.
    const credit = await upload(fixtureXml("camt054-swedbank-credit.xml"));
    const [incoming] = await files.incomingView(credit.file.id);
    const wrong = await files.bookOutgoing(credit.file.id, { entryIds: [incoming!.id] }, userId);
    expect(wrong.results[0]).toMatchObject({ ok: false, error: { code: "bank-entry-direction" } });
    await files.ignore(file.id, "outgoing", entry!.id, { reason: "Kortköp" }, userId);
    expect((await files.outgoingView(file.id))[0]).toMatchObject({ state: "ignored", ignoreReason: "Kortköp" });
  });

  it("a return cancels the UTB on the return's booking date and reopens the invoice", async () => {
    const batch = await exportedBatch();
    const confirmed = await upload(debit(batch, [3]));
    await files.bookOutgoing(confirmed.file.id, { entryIds: (await files.outgoingView(confirmed.file.id)).map((e) => e.id) }, userId);
    const returned = await upload(returnOf(batch, 3, "2024-10-17"));
    const [ret] = await files.outgoingView(returned.file.id);
    expect(ret).toMatchObject({ state: "return", returnReason: "AC01" });
    const { results } = await files.bookOutgoing(returned.file.id, { entryIds: [ret!.id] }, userId);
    expect(results[0]).toMatchObject({ ok: true, paymentNumber: batch.items[2]!.endToEndId });
    const [item] = await db.select().from(paymentBatchItems).where(eq(paymentBatchItems.id, batch.items[2]!.id));
    expect(item).toMatchObject({ status: "returned", returnBankFileEntryId: ret!.id });
    const [payment] = await db.select().from(supplierPayments);
    const [omforing] = await db.select({ date: verifications.date }).from(verifications).where(eq(verifications.id, payment!.cancellationVerificationId!));
    expect(omforing!.date).toBe("2024-10-17");
    // The debit entry stays handled: its payment was cancelled by the return, not undone.
    expect((await files.outgoingView(confirmed.file.id))[0]!.state).toBe("booked");
    expect((await files.outgoingView(returned.file.id))[0]!.state).toBe("booked");
    // …and the invoice is an open item again, for its full amount.
    const invoiceId = batch.items[2]!.supplierInvoiceId;
    const [invoice] = await db.select({ status: supplierInvoices.status }).from(supplierInvoices).where(eq(supplierInvoices.id, invoiceId));
    expect(invoice!.status).toBe("approved");
    expect((await computeOpenAmounts(db, [invoiceId])).get(invoiceId)).toBe(8850);
  });

  // Binding carry from Task 7: a return dated before the UTB is refused per row.
  it("refuses a return the bank booked before the payment date; nothing is written", async () => {
    const batch = await exportedBatch();
    const confirmed = await upload(debit(batch, [3]));
    await files.bookOutgoing(confirmed.file.id, { entryIds: (await files.outgoingView(confirmed.file.id)).map((e) => e.id) }, userId);
    const returned = await upload(returnOf(batch, 3, "2024-10-14"));
    const [ret] = await files.outgoingView(returned.file.id);
    const { results } = await files.bookOutgoing(returned.file.id, { entryIds: [ret!.id] }, userId);
    expect(results[0]).toMatchObject({ ok: false, error: { code: "bank-return-before-payment" } });
    const [item] = await db.select().from(paymentBatchItems).where(eq(paymentBatchItems.id, batch.items[2]!.id));
    expect(item).toMatchObject({ status: "confirmed", returnBankFileEntryId: null });
    const [payment] = await db.select().from(supplierPayments);
    expect(payment!.cancelledAt).toBeNull();
  });

  // Final review: a return of another amount than the row is never booked
  // automatically — like a debit that differs, it waits for a manual check.
  it("a return of another amount than the row is 'amount differs' and books nothing", async () => {
    const batch = await exportedBatch();
    const confirmed = await upload(debit(batch, [3]));
    await files.bookOutgoing(confirmed.file.id, { entryIds: (await files.outgoingView(confirmed.file.id)).map((e) => e.id) }, userId);
    const partial = returnOf(batch, 3, "2024-10-17").replace(/>8850\.00</g, ">850.00<");
    const returned = await upload(partial);
    const [ret] = await files.outgoingView(returned.file.id);
    expect(ret).toMatchObject({ state: "amount_mismatch", amount: 850, reversal: true });
    const { results } = await files.bookOutgoing(returned.file.id, { entryIds: [ret!.id] }, userId);
    expect(results[0]).toMatchObject({ ok: false, error: { code: "bank-entry-amount-differs" } });
    const [item] = await db.select().from(paymentBatchItems).where(eq(paymentBatchItems.id, batch.items[2]!.id));
    expect(item).toMatchObject({ status: "confirmed", returnBankFileEntryId: null });
    const [payment] = await db.select().from(supplierPayments);
    expect(payment!.cancelledAt).toBeNull();
    // An exported (never confirmed) row is not rejected by a differing return either.
    const other = await upload(returnOf(batch, 2, "2024-10-16").replace(/>3480\.00</g, ">3000.00<"));
    const [ret2] = await files.outgoingView(other.file.id);
    expect(ret2!.state).toBe("amount_mismatch");
    expect((await files.bookOutgoing(other.file.id, { entryIds: [ret2!.id] }, userId)).results[0]).toMatchObject({ ok: false, error: { code: "bank-entry-amount-differs" } });
    const [row2] = await db.select().from(paymentBatchItems).where(eq(paymentBatchItems.id, batch.items[1]!.id));
    expect(row2!.status).toBe("exported");
  });

  // Spec §4.5: a return of a row never confirmed rejects it without a booking,
  // and the debit — if it arrives later — counts as handled (net zero).
  it("a return of an exported row rejects it ('Returnerad av banken'); its debit is then handled", async () => {
    const batch = await exportedBatch();
    const returned = await upload(returnOf(batch, 2, "2024-10-16"));
    const [ret] = await files.outgoingView(returned.file.id);
    expect(ret!.state).toBe("return");
    const { results } = await files.bookOutgoing(returned.file.id, { entryIds: [ret!.id] }, userId);
    expect(results[0]).toMatchObject({ ok: true });
    const [item] = await db.select().from(paymentBatchItems).where(eq(paymentBatchItems.id, batch.items[1]!.id));
    expect(item).toMatchObject({ status: "rejected", rejectedReason: "Returnerad av banken (AC01)", returnBankFileEntryId: ret!.id });
    expect((await db.select({ n: count() }).from(supplierPayments))[0]!.n).toBe(0);
    expect((await files.outgoingView(returned.file.id))[0]!.state).toBe("booked");
    const late = await upload(debit(batch, [2]));
    const [lateDebit] = await files.outgoingView(late.file.id);
    expect(lateDebit!.state).toBe("booked");
    const again = await files.bookOutgoing(late.file.id, { entryIds: [lateDebit!.id] }, userId);
    expect(again.results[0]).toMatchObject({ ok: false, error: { code: "bank-entry-already-booked" } });
    expect((await db.select({ n: count() }).from(supplierPayments))[0]!.n).toBe(0);
  });

  // Review Focus 3 (camt path): mixed booking dates around a locked month.
  it("books the open month's debit and fails the locked month's, nothing half-written", async () => {
    const batch = await exportedBatch();
    await testEconomyService.lockPeriod((await periodStarting("2024-10-01")).id, userId);
    const october = await upload(debit(batch, [1], "2024-10-15"));
    const november = await upload(debit(batch, [2], "2024-11-04"));
    const entryIds = [(await files.outgoingView(october.file.id))[0]!.id];
    const lateIds = [(await files.outgoingView(november.file.id))[0]!.id];
    const oct = await files.bookOutgoing(october.file.id, { entryIds }, userId);
    const nov = await files.bookOutgoing(november.file.id, { entryIds: lateIds }, userId);
    expect(oct.results[0]).toMatchObject({ ok: false, error: { code: "accounting-period-locked" } });
    expect(nov.results[0]).toMatchObject({ ok: true });
    const items = await db.select({ id: paymentBatchItems.id, status: paymentBatchItems.status }).from(paymentBatchItems);
    expect(items.find((i) => i.id === batch.items[0]!.id)!.status).toBe("exported");
    expect(items.find((i) => i.id === batch.items[1]!.id)!.status).toBe("confirmed");
    expect((await db.select({ n: count() }).from(supplierPayments))[0]!.n).toBe(1);
    // The failed entry is still unhandled, and no audit entry claims it was booked.
    expect((await files.outgoingView(october.file.id))[0]!.state).toBe("matched");
    const booked = await db.select().from(auditLog).where(and(eq(auditLog.entityType, "bank_file"), eq(auditLog.action, "entry_booked")));
    expect(booked).toHaveLength(1);
  });

  // Spec §12: "manuell och camt samtidigt ⇒ exakt en UTB (radlås + indexet)".
  it("a manual Bekräfta utförd and a camt confirmation of the same row at once book exactly one UTB", async () => {
    const batch = await exportedBatch();
    const { file } = await upload(debit(batch, [1], "2024-10-09"));
    const [entry] = await files.outgoingView(file.id);
    // Hold the batch so both paths queue on its lock (the camt path holds the
    // entry, the manual path has read the row as exported) — then release.
    let both: Promise<[Awaited<ReturnType<typeof batches.confirm>>, Awaited<ReturnType<typeof files.bookOutgoing>>]> | undefined;
    await db.transaction(async (holder) => {
      await holder.select({ id: paymentBatches.id }).from(paymentBatches).where(eq(paymentBatches.id, batch.id)).for("update");
      both = Promise.all([batches.confirm(batch.id, { paymentDate: "2024-10-09", itemIds: [batch.items[0]!.id] }, userId), files.bookOutgoing(file.id, { entryIds: [entry!.id] }, userId)]);
      await waitForLockWaiters(2);
    });
    const [manual, camt] = await both!;
    const results = [...manual.results, ...camt.results];
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const loser = results.find((r) => !r.ok)!;
    expect(loser.ok === false && loser.error.code).toBe("payment-batch-item-not-confirmable");
    const payments = await db.select().from(supplierPayments).where(eq(supplierPayments.paymentBatchItemId, batch.items[0]!.id));
    expect(payments).toHaveLength(1);
  });
});

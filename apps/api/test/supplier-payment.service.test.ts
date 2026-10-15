import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, asc, eq, sql } from "drizzle-orm";
import {
  accounts,
  auditLog,
  db,
  paymentTerms,
  suppliers,
  supplierInvoices,
  supplierPaymentRows,
  supplierPayments,
  verificationRows,
  verifications,
  verificationSeries,
} from "@navet/db";
import { round2 } from "@navet/shared";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import {
  createVerificationPoster,
  PaymentBankAccountConflictError,
} from "../src/modules/economy/service/verification-poster.js";
import { readPostingSettings } from "../src/modules/system/service/posting-settings.js";
import { createSupplierInvoiceRepository } from "../src/modules/purchase/repository/supplier-invoice.repository.js";
import {
  createSupplierInvoiceService,
  SupplierInvoiceHasPaymentsError,
  SupplierInvoiceNotFoundError,
} from "../src/modules/purchase/service/supplier-invoice.service.js";
import { createSupplierPaymentRepository } from "../src/modules/purchase/repository/supplier-payment.repository.js";
import {
  createSupplierPaymentService,
  SupplierInvoiceNotOpenError,
  SupplierPaymentAlreadyCancelledError,
  SupplierPaymentExceedsOpenAmountError,
  SupplierPaymentNotFoundError,
  SupplierPaymentRowMismatchError,
  VerificationAlreadyReversedError,
} from "../src/modules/purchase/service/supplier-payment.service.js";
import { InvalidStatusTransitionError } from "../src/modules/purchase/service/purchase.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import {
  DEFAULT_POSTING_SETTINGS,
  setupPostingBaseline,
  testEconomyService,
  testSystemService,
} from "./helpers/services.js";

// B4 leverantörsreskontra: registering a supplier payment settles open items
// and books the U verification inside ONE transaction. This suite drives the
// real wiring end to end — the poster is built on the real readPostingSettings
// leaf (exactly as app.ts does) and the invoices are real attested supplier
// invoices (whose attest books its own L verification in the same transaction),
// so the settings → open amounts → verification → paid-flip path is the one
// production runs.
const authRepo = createAuthRepository(db);
const poster = createVerificationPoster({ read: readPostingSettings });
const auditRepository = createAuditRepository(db);
const supplierInvoiceService = createSupplierInvoiceService(createSupplierInvoiceRepository(db), poster, auditRepository);
const supplierPaymentService = createSupplierPaymentService(createSupplierPaymentRepository(db), poster, auditRepository);

// number_series is NEVER truncated (shared, sequence-like base data) — every
// assertion below is relative to the UTB/verifikat number the previous
// registration produced, never an absolute one.
const TRUNCATE = sql`TRUNCATE posting_rules, verification_rows, verifications, verification_counters, verification_series, accounting_periods, fiscal_years, accounts, supplier_payment_rows, supplier_payments, supplier_invoice_rows, supplier_invoices, suppliers, payment_terms, audit_log, users CASCADE`;

const TODAY = new Date().toLocaleDateString("sv-SE");

beforeEach(async () => {
  await db.execute(TRUNCATE);
  await setupPostingBaseline();
  // system_settings survives the truncate (it is shared base data), so the
  // posting roles AND the tolerance are reset explicitly — another suite may
  // have pointed a role somewhere else or moved the tolerance, and two cases
  // below deliberately repoint postingPaymentWriteOff themselves.
  await testSystemService.updateSettings({ ...DEFAULT_POSTING_SETTINGS, paymentTolerance: 5 });
});

afterAll(async () => {
  await db.execute(TRUNCATE);
  await testSystemService.updateSettings({ ...DEFAULT_POSTING_SETTINGS, paymentTolerance: 5 });
});

async function makeUser() {
  return authRepo.create({
    email: `ap-pay-${crypto.randomUUID()}@example.com`,
    passwordHash: "not-a-real-hash",
    name: "Reskontra",
    role: "admin",
  });
}

async function makeSupplier(name = "Lev AB", paymentTermId: string | null = null) {
  const [row] = await db
    .insert(suppliers)
    .values({ name, supplierNumber: `TEST-${crypto.randomUUID()}`, currency: "SEK", active: true, paymentTermId })
    .returning();
  return row!;
}

// payment_terms IS truncated by this suite, so the fixture is created fresh
// every time. The codes/names below are still unique to this file ("45" and
// "AP-KONTANT", never the "N30"/"30 dagar netto" purchase.service.test.ts and
// sales.service.test.ts use, nor the "30"/"KONTANT" of
// supplier-invoice.service.test.ts) so an aborted run of another suite can
// never collide with them. The CODE is what the due date is derived from —
// parseInt("45") days, NaN for anything that is not a number of days.
async function makePaymentTerm(code: string, name: string) {
  const [row] = await db.insert(paymentTerms).values({ code, name }).returning();
  return row!;
}

// A draft supplier invoice whose header amounts add up to `gross` (net + 25 %
// VAT). A negative gross IS a supplier credit note — there is no type column
// on this side, the sign carries it (see open-amounts.ts).
async function makeDraftInvoice(
  supplierId: string,
  userId: string,
  gross: number,
  options: { dueDate?: string | null; invoiceDate?: string } = {}
) {
  const netAmount = round2(gross * 0.8);
  const invoice = await supplierInvoiceService.create(
    {
      supplierId,
      invoiceNumber: `INV-${crypto.randomUUID()}`,
      invoiceDate: options.invoiceDate ?? TODAY,
      ...(options.dueDate !== undefined ? { dueDate: options.dueDate } : {}),
      netAmount,
      vatAmount: round2(gross - netAmount),
      grossAmount: gross,
      rows: [],
    },
    userId
  );
  return invoice!;
}

// The open item every payment test starts from: an attested invoice (the
// attest books its own L verification inside the same transaction).
async function makeApprovedInvoice(
  supplierId: string,
  userId: string,
  gross: number,
  options: { dueDate?: string | null; invoiceDate?: string } = {}
) {
  const draft = await makeDraftInvoice(supplierId, userId, gross, options);
  return (await supplierInvoiceService.approve(draft.id, userId))!;
}

async function loadVerification(verificationId: string) {
  const [verification] = await db
    .select({
      id: verifications.id,
      seriesCode: verificationSeries.code,
      verificationNumber: verifications.verificationNumber,
      date: verifications.date,
      description: verifications.description,
      status: verifications.status,
      reversesVerificationId: verifications.reversesVerificationId,
    })
    .from(verifications)
    .innerJoin(verificationSeries, eq(verificationSeries.id, verifications.seriesId))
    .where(eq(verifications.id, verificationId));
  const rows = await db
    .select({ number: accounts.number, debit: verificationRows.debit, credit: verificationRows.credit })
    .from(verificationRows)
    .innerJoin(accounts, eq(accounts.id, verificationRows.accountId))
    .where(eq(verificationRows.verificationId, verificationId))
    .orderBy(asc(verificationRows.createdAt));
  return { ...verification!, rows };
}

// The (single) verification pointing back at a source — the omföring.
async function reversalOf(sourceVerificationId: string) {
  const rows = await db
    .select({ id: verifications.id })
    .from(verifications)
    .where(eq(verifications.reversesVerificationId, sourceVerificationId));
  return rows.length === 0 ? null : loadVerification(rows[0]!.id);
}

// Every produced verification must balance and every row must be debit XOR
// credit — asserted on top of the per-test row expectations.
function expectBalanced(rows: { debit: string; credit: string }[]) {
  const debit = rows.reduce((sum, row) => sum + Number(row.debit), 0);
  const credit = rows.reduce((sum, row) => sum + Number(row.credit), 0);
  expect(debit).toBeCloseTo(credit, 2);
  for (const row of rows) {
    expect(Number(row.debit) === 0).not.toBe(Number(row.credit) === 0);
  }
}

function numericPart(documentNumber: string) {
  return Number(documentNumber.replace(/^\D+/, ""));
}

// U-2026-7 -> 7 (the display number carries series and year too).
function verificationNumberPart(displayNumber: string) {
  return Number(displayNumber.split("-").pop());
}

async function invoiceStatus(invoiceId: string) {
  const [row] = await db
    .select({ status: supplierInvoices.status, paidAt: supplierInvoices.paidAt })
    .from(supplierInvoices)
    .where(eq(supplierInvoices.id, invoiceId));
  return row!;
}

async function countPayments() {
  const rows = await db.select({ id: supplierPayments.id }).from(supplierPayments);
  return rows.length;
}

async function countVerifications() {
  const rows = await db.select({ id: verifications.id }).from(verifications);
  return rows.length;
}

// The verifikatserier materialized so far — the U series must NOT exist after
// a payment that booked nothing.
async function series(code: string) {
  return db.select({ id: verificationSeries.id }).from(verificationSeries).where(eq(verificationSeries.code, code));
}

describe("leverantörsreskontra — öppna poster", () => {
  it("lists approved supplier invoices with a non-zero open amount, credit notes negative, due date first", async () => {
    const user = await makeUser();
    const supplier = await makeSupplier();
    const invoice = await makeApprovedInvoice(supplier.id, user.id, 1250, { dueDate: "2026-03-01" });
    const credit = await makeApprovedInvoice(supplier.id, user.id, -125, { dueDate: "2026-02-01" });
    // A draft is not an obligation yet, so it is not an open item at all.
    await makeDraftInvoice(supplier.id, user.id, 500);
    // A makulerad invoice never was one either.
    const cancelled = await makeApprovedInvoice(supplier.id, user.id, 300);
    await supplierInvoiceService.cancel(cancelled.id, user.id);
    // ... and one marked paid before B4 shipped is deliberately never
    // reopened by this ledger (the status filter is exactly "approved").
    const legacyPaid = await makeApprovedInvoice(supplier.id, user.id, 800);
    await db
      .update(supplierInvoices)
      .set({ status: "paid", paidAt: new Date() })
      .where(eq(supplierInvoices.id, legacyPaid.id));

    const { rows, total } = await supplierPaymentService.listOpenInvoices({ limit: 50, offset: 0 });
    expect(total).toBe(2);
    expect(rows.map((row) => row.id)).toEqual([credit.id, invoice.id]);
    expect(rows[0]!.openAmount).toBe(-125);
    expect(rows[0]!.grossAmount).toBe(-125);
    expect(rows[1]!.openAmount).toBe(1250);
    expect(rows[1]!.supplierName).toBe("Lev AB");
    expect(rows[1]!.registrationNumber).toBe(invoice.registrationNumber);
    expect(rows[1]!.invoiceNumber).toBe(invoice.invoiceNumber);
  });

  it("same due date: ties break on createdAt (insertion order), not the LF number's text sort", async () => {
    const user = await makeUser();
    const supplier = await makeSupplier();
    const first = await makeApprovedInvoice(supplier.id, user.id, 100, { dueDate: "2026-03-01" });
    const second = await makeApprovedInvoice(supplier.id, user.id, 100, { dueDate: "2026-03-01" });
    // Forcing registrationNumber into "LF-2"/"LF-10" territory reproduces the
    // bug a plain asc(registrationNumber) tie-break had: "LF-10" sorts
    // BEFORE "LF-2" as text, even though LF-2 was created (and is due) first.
    await db.update(supplierInvoices).set({ registrationNumber: "LF-2" }).where(eq(supplierInvoices.id, first.id));
    await db.update(supplierInvoices).set({ registrationNumber: "LF-10" }).where(eq(supplierInvoices.id, second.id));

    const { rows } = await supplierPaymentService.listOpenInvoices({ supplierId: supplier.id, limit: 50, offset: 0 });
    // createdAt order (first created first), not the text-sorted LF-10/LF-2.
    expect(rows.map((row) => row.id)).toEqual([first.id, second.id]);
  });

  it("filters on supplier and on overdue only — an invoice without a due date is never förfallen and sorts last", async () => {
    const user = await makeUser();
    const a = await makeSupplier("A AB");
    const b = await makeSupplier("B AB");
    const overdue = await makeApprovedInvoice(a.id, user.id, 500, { dueDate: "2020-01-01" });
    const future = await makeApprovedInvoice(a.id, user.id, 500, { dueDate: "2999-01-01" });
    // No payment term and no explicit date: the paper invoice simply carried
    // none (a "KONTANT"-style term produces the same null).
    const undated = await makeApprovedInvoice(a.id, user.id, 500);
    const other = await makeApprovedInvoice(b.id, user.id, 500, { dueDate: "2020-01-01" });

    const forA = await supplierPaymentService.listOpenInvoices({ supplierId: a.id, limit: 50, offset: 0 });
    expect(forA.total).toBe(3);
    expect(forA.rows.every((row) => row.supplierId === a.id)).toBe(true);
    // NULLS LAST: no due date is not "oldest".
    expect(forA.rows.map((row) => row.id)).toEqual([overdue.id, future.id, undated.id]);
    expect(forA.rows[2]!.dueDate).toBeNull();

    const overdueOnly = await supplierPaymentService.listOpenInvoices({ overdueOnly: true, limit: 50, offset: 0 });
    expect(overdueOnly.total).toBe(2);
    expect(overdueOnly.rows.map((row) => row.id).sort()).toEqual([overdue.id, other.id].sort());

    const both = await supplierPaymentService.listOpenInvoices({
      supplierId: a.id,
      overdueOnly: true,
      limit: 50,
      offset: 0,
    });
    expect(both.rows.map((row) => row.id)).toEqual([overdue.id]);
  });

  it("carries the payment term's due date into the förfallolista — a term that is no number of days leaves none — and searches on number, supplier invoice number and supplier name", async () => {
    const user = await makeUser();
    const term = await makePaymentTerm("45", "AP 45 dagar netto");
    const cashTerm = await makePaymentTerm("AP-KONTANT", "AP Kontant");
    const supplier = await makeSupplier("Termin AB", term.id);
    const other = await makeSupplier("Kontant AB", cashTerm.id);
    const invoice = await makeApprovedInvoice(supplier.id, user.id, 1250);
    const cashInvoice = await makeApprovedInvoice(other.id, user.id, 400);

    // invoiceDate + 45 days, computed the same way the service does (local
    // components, never an ISO parse — that lands on UTC midnight).
    const [y, m, d] = TODAY.split("-").map(Number);
    const expectedDue = new Date(y!, m! - 1, d! + 45).toLocaleDateString("sv-SE");
    const all = await supplierPaymentService.listOpenInvoices({ limit: 50, offset: 0 });
    expect(all.rows.find((row) => row.id === invoice.id)!.dueDate).toBe(expectedDue);
    // "AP-KONTANT" is no number of days, so the invoice carries no due date at
    // all — and an open item without one is never förfallen (NULL <
    // CURRENT_DATE is NULL, not true).
    expect(all.rows.find((row) => row.id === cashInvoice.id)!.dueDate).toBeNull();
    const overdue = await supplierPaymentService.listOpenInvoices({ overdueOnly: true, limit: 50, offset: 0 });
    expect(overdue.rows).toHaveLength(0);

    const byRegistration = await supplierPaymentService.listOpenInvoices({
      search: invoice.registrationNumber,
      limit: 50,
      offset: 0,
    });
    expect(byRegistration.rows.map((row) => row.id)).toEqual([invoice.id]);

    const byInvoiceNumber = await supplierPaymentService.listOpenInvoices({
      search: invoice.invoiceNumber,
      limit: 50,
      offset: 0,
    });
    expect(byInvoiceNumber.rows.map((row) => row.id)).toEqual([invoice.id]);

    const bySupplier = await supplierPaymentService.listOpenInvoices({ search: "Termin", limit: 50, offset: 0 });
    expect(bySupplier.rows.map((row) => row.id)).toEqual([invoice.id]);
  });

  it("derives the open amount from the header gross minus everything the payment rows settled", async () => {
    const user = await makeUser();
    const supplier = await makeSupplier();
    const invoice = await makeApprovedInvoice(supplier.id, user.id, 1000);

    await supplierPaymentService.create(
      {
        supplierId: supplier.id,
        paymentDate: TODAY,
        bankAccountNumber: "1930",
        amount: 400,
        rows: [{ supplierInvoiceId: invoice.id, appliedAmount: 400 }],
      },
      user.id
    );
    const afterPart = await supplierPaymentService.listOpenInvoices({ limit: 50, offset: 0 });
    expect(afterPart.rows[0]!.openAmount).toBe(600);
    expect(afterPart.rows[0]!.grossAmount).toBe(1000);

    // The write-off settles the open item just as the cash does: 595 + 5 = 600.
    await supplierPaymentService.create(
      {
        supplierId: supplier.id,
        paymentDate: TODAY,
        bankAccountNumber: "1930",
        amount: 595,
        rows: [{ supplierInvoiceId: invoice.id, appliedAmount: 595 }],
      },
      user.id
    );
    expect((await supplierPaymentService.listOpenInvoices({ limit: 50, offset: 0 })).total).toBe(0);
    expect((await invoiceStatus(invoice.id)).status).toBe("paid");
  });
});

describe("leverantörsreskontra — betalningsregistrering", () => {
  it("a full payment books a U verification, closes the invoice and leaves nothing open", async () => {
    const user = await makeUser();
    const supplier = await makeSupplier();
    const invoice = await makeApprovedInvoice(supplier.id, user.id, 1250);

    const payment = await supplierPaymentService.create(
      {
        supplierId: supplier.id,
        paymentDate: TODAY,
        bankAccountNumber: "1930",
        amount: 1250,
        note: "Bankgiro",
        rows: [{ supplierInvoiceId: invoice.id, appliedAmount: 1250 }],
      },
      user.id
    );

    expect(payment.paymentNumber.startsWith("UTB-")).toBe(true);
    expect(payment.amount).toBe("1250.00");
    expect(payment.supplierName).toBe("Lev AB");
    expect(payment.note).toBe("Bankgiro");
    expect(payment.cancelledAt).toBeNull();
    expect(payment.rows).toHaveLength(1);
    expect(payment.rows[0]!.appliedAmount).toBe("1250.00");
    expect(payment.rows[0]!.writeOffAmount).toBe("0.00");
    expect(payment.rows[0]!.registrationNumber).toBe(invoice.registrationNumber);

    expect(payment.verificationId).not.toBeNull();
    expect(payment.verificationDisplayNumber!.startsWith("U-")).toBe(true);
    const verification = await loadVerification(payment.verificationId!);
    expect(verification.seriesCode).toBe("U");
    expect(verification.status).toBe("booked");
    expect(verification.date).toBe(TODAY);
    expect(verification.description).toBe(`Betalning ${payment.paymentNumber} — Lev AB`);
    // Money leaving the company: the bank is credited and the
    // leverantörsskuld debited — the sign mirror of the customer ledger.
    expect(verification.rows).toEqual([
      { number: "1930", debit: "0.00", credit: "1250.00" },
      { number: "2440", debit: "1250.00", credit: "0.00" },
    ]);
    expectBalanced(verification.rows);

    const status = await invoiceStatus(invoice.id);
    expect(status.status).toBe("paid");
    expect(status.paidAt).not.toBeNull();
    expect((await supplierPaymentService.listOpenInvoices({ limit: 50, offset: 0 })).total).toBe(0);
  });

  it("a partial payment leaves the rest open, writes nothing off and keeps the invoice approved", async () => {
    const user = await makeUser();
    const supplier = await makeSupplier();
    const invoice = await makeApprovedInvoice(supplier.id, user.id, 1000);

    const payment = await supplierPaymentService.create(
      {
        supplierId: supplier.id,
        paymentDate: TODAY,
        bankAccountNumber: "1930",
        amount: 400,
        rows: [{ supplierInvoiceId: invoice.id, appliedAmount: 400 }],
      },
      user.id
    );

    expect(payment.rows[0]!.writeOffAmount).toBe("0.00");
    const status = await invoiceStatus(invoice.id);
    expect(status.status).toBe("approved");
    expect(status.paidAt).toBeNull();
    const open = await supplierPaymentService.listOpenInvoices({ limit: 50, offset: 0 });
    expect(open.rows[0]!.openAmount).toBe(600);

    const verification = await loadVerification(payment.verificationId!);
    expect(verification.rows).toEqual([
      { number: "1930", debit: "0.00", credit: "400.00" },
      { number: "2440", debit: "400.00", credit: "0.00" },
    ]);
    expectBalanced(verification.rows);
  });

  it("an underpayment within tolerance writes the difference off on the credit side and closes the invoice", async () => {
    const user = await makeUser();
    const supplier = await makeSupplier();
    const invoice = await makeApprovedInvoice(supplier.id, user.id, 1000);

    const payment = await supplierPaymentService.create(
      {
        supplierId: supplier.id,
        paymentDate: TODAY,
        bankAccountNumber: "1930",
        amount: 995,
        rows: [{ supplierInvoiceId: invoice.id, appliedAmount: 995 }],
      },
      user.id
    );

    expect(payment.rows[0]!.writeOffAmount).toBe("5.00");
    expect((await invoiceStatus(invoice.id)).status).toBe("paid");
    const verification = await loadVerification(payment.verificationId!);
    const byAccount = Object.fromEntries(verification.rows.map((row) => [row.number, row]));
    expect(byAccount["1930"]).toEqual({ number: "1930", debit: "0.00", credit: "995.00" });
    // The whole debt goes off the payable; the 5 kr never paid is a gain.
    expect(byAccount["2440"]).toEqual({ number: "2440", debit: "1000.00", credit: "0.00" });
    expect(byAccount["3740"]).toEqual({ number: "3740", debit: "0.00", credit: "5.00" });
    expectBalanced(verification.rows);
  });

  it("an overpayment within tolerance debits the write-off account and closes the invoice", async () => {
    const user = await makeUser();
    const supplier = await makeSupplier();
    const invoice = await makeApprovedInvoice(supplier.id, user.id, 1000);

    const payment = await supplierPaymentService.create(
      {
        supplierId: supplier.id,
        paymentDate: TODAY,
        bankAccountNumber: "1930",
        amount: 1003,
        rows: [{ supplierInvoiceId: invoice.id, appliedAmount: 1003 }],
      },
      user.id
    );

    expect(payment.rows[0]!.writeOffAmount).toBe("-3.00");
    expect((await invoiceStatus(invoice.id)).status).toBe("paid");
    const verification = await loadVerification(payment.verificationId!);
    const byAccount = Object.fromEntries(verification.rows.map((row) => [row.number, row]));
    expect(byAccount["1930"]).toEqual({ number: "1930", debit: "0.00", credit: "1003.00" });
    expect(byAccount["2440"]).toEqual({ number: "2440", debit: "1000.00", credit: "0.00" });
    expect(byAccount["3740"]).toEqual({ number: "3740", debit: "3.00", credit: "0.00" });
    expectBalanced(verification.rows);
  });

  it("a payment beyond the tolerance is refused and leaves no payment and no verification behind", async () => {
    const user = await makeUser();
    const supplier = await makeSupplier();
    const invoice = await makeApprovedInvoice(supplier.id, user.id, 1000);
    const verificationsBefore = await countVerifications();

    const error = await supplierPaymentService
      .create(
        {
          supplierId: supplier.id,
          paymentDate: TODAY,
          bankAccountNumber: "1930",
          amount: 1010,
          rows: [{ supplierInvoiceId: invoice.id, appliedAmount: 1010 }],
        },
        user.id
      )
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(SupplierPaymentExceedsOpenAmountError);
    // The message names the invoice by its internal LF handle — the one
    // number that is unique across every supplier.
    expect((error as SupplierPaymentExceedsOpenAmountError).registrationNumber).toBe(invoice.registrationNumber);
    expect((error as SupplierPaymentExceedsOpenAmountError).open).toBe(1000);
    expect((error as SupplierPaymentExceedsOpenAmountError).applied).toBe(1010);

    expect(await countPayments()).toBe(0);
    expect(await countVerifications()).toBe(verificationsBefore);
    expect(await series("U")).toHaveLength(0);
    expect((await invoiceStatus(invoice.id)).status).toBe("approved");
  });

  it("burns neither a UTB number nor a verifikatnummer on a rejected registration", async () => {
    const user = await makeUser();
    const supplier = await makeSupplier();
    const first = await makeApprovedInvoice(supplier.id, user.id, 100);
    const blocked = await makeApprovedInvoice(supplier.id, user.id, 100);
    const last = await makeApprovedInvoice(supplier.id, user.id, 100);

    // Where the two series stand before the rejected attempt.
    const before = await supplierPaymentService.create(
      {
        supplierId: supplier.id,
        paymentDate: TODAY,
        bankAccountNumber: "1930",
        amount: 100,
        rows: [{ supplierInvoiceId: first.id, appliedAmount: 100 }],
      },
      user.id
    );

    await expect(
      supplierPaymentService.create(
        {
          supplierId: supplier.id,
          paymentDate: TODAY,
          bankAccountNumber: "1930",
          amount: 200,
          rows: [{ supplierInvoiceId: blocked.id, appliedAmount: 200 }],
        },
        user.id
      )
    ).rejects.toThrow(SupplierPaymentExceedsOpenAmountError);

    // Both allocations happened INSIDE the rejected transaction and rolled
    // back with it, so the next registration takes the very next numbers.
    const after = await supplierPaymentService.create(
      {
        supplierId: supplier.id,
        paymentDate: TODAY,
        bankAccountNumber: "1930",
        amount: 100,
        rows: [{ supplierInvoiceId: last.id, appliedAmount: 100 }],
      },
      user.id
    );
    expect(numericPart(after.paymentNumber)).toBe(numericPart(before.paymentNumber) + 1);
    expect(verificationNumberPart(after.verificationDisplayNumber!)).toBe(
      verificationNumberPart(before.verificationDisplayNumber!) + 1
    );
  });

  it("refuses a draft invoice, a paid one, one belonging to another supplier and an unknown one", async () => {
    const user = await makeUser();
    const supplier = await makeSupplier("A AB");
    const other = await makeSupplier("B AB");
    const draft = await makeDraftInvoice(supplier.id, user.id, 100);
    const foreign = await makeApprovedInvoice(other.id, user.id, 100);
    const paid = await makeApprovedInvoice(supplier.id, user.id, 100);
    await supplierPaymentService.create(
      {
        supplierId: supplier.id,
        paymentDate: TODAY,
        bankAccountNumber: "1930",
        amount: 100,
        rows: [{ supplierInvoiceId: paid.id, appliedAmount: 100 }],
      },
      user.id
    );
    const paymentsBefore = await countPayments();

    const base = { supplierId: supplier.id, paymentDate: TODAY, bankAccountNumber: "1930", amount: 100 };
    await expect(
      supplierPaymentService.create(
        { ...base, rows: [{ supplierInvoiceId: draft.id, appliedAmount: 100 }] },
        user.id
      )
    ).rejects.toThrow(SupplierInvoiceNotOpenError);
    await expect(
      supplierPaymentService.create({ ...base, rows: [{ supplierInvoiceId: paid.id, appliedAmount: 100 }] }, user.id)
    ).rejects.toThrow(/is not an approved invoice/);
    await expect(
      supplierPaymentService.create(
        { ...base, rows: [{ supplierInvoiceId: foreign.id, appliedAmount: 100 }] },
        user.id
      )
    ).rejects.toThrow(SupplierPaymentRowMismatchError);
    await expect(
      supplierPaymentService.create(
        { ...base, rows: [{ supplierInvoiceId: crypto.randomUUID(), appliedAmount: 100 }] },
        user.id
      )
    ).rejects.toThrow(SupplierInvoiceNotFoundError);

    expect(await countPayments()).toBe(paymentsBefore);
  });

  it("refuses an approved invoice with nothing left open", async () => {
    const user = await makeUser();
    const supplier = await makeSupplier();
    const invoice = await makeApprovedInvoice(supplier.id, user.id, 100);
    await supplierPaymentService.create(
      {
        supplierId: supplier.id,
        paymentDate: TODAY,
        bankAccountNumber: "1930",
        amount: 100,
        rows: [{ supplierInvoiceId: invoice.id, appliedAmount: 100 }],
      },
      user.id
    );
    // The status guard normally shadows the open-amount guard — a fully
    // settled invoice is "paid" and stops there. Approved WITH nothing open
    // is what a hand-corrected status leaves behind, and it is the only state
    // that reaches the second guard, so it is written straight into the row.
    await db
      .update(supplierInvoices)
      .set({ status: "approved", paidAt: null })
      .where(eq(supplierInvoices.id, invoice.id));

    await expect(
      supplierPaymentService.create(
        {
          supplierId: supplier.id,
          paymentDate: TODAY,
          bankAccountNumber: "1930",
          amount: 100,
          rows: [{ supplierInvoiceId: invoice.id, appliedAmount: 100 }],
        },
        user.id
      )
    ).rejects.toThrow(/has no open amount left/);
  });

  it("refuses an amount pointing the opposite way to the open amount, in both directions", async () => {
    const user = await makeUser();
    const supplier = await makeSupplier();
    const invoice = await makeApprovedInvoice(supplier.id, user.id, 1000);
    const credit = await makeApprovedInvoice(supplier.id, user.id, -250);

    // Money coming IN on a supplier invoice is never a partial payment.
    await expect(
      supplierPaymentService.create(
        {
          supplierId: supplier.id,
          paymentDate: TODAY,
          bankAccountNumber: "1930",
          amount: -100,
          rows: [{ supplierInvoiceId: invoice.id, appliedAmount: -100 }],
        },
        user.id
      )
    ).rejects.toThrow(/points the opposite way/);
    // ... and paying OUT on a credit note is the same mistake mirrored.
    await expect(
      supplierPaymentService.create(
        {
          supplierId: supplier.id,
          paymentDate: TODAY,
          bankAccountNumber: "1930",
          amount: 100,
          rows: [{ supplierInvoiceId: credit.id, appliedAmount: 100 }],
        },
        user.id
      )
    ).rejects.toThrow(SupplierPaymentRowMismatchError);

    expect(await countPayments()).toBe(0);
  });

  it("refuses rows that do not add up to the bank amount, duplicate rows, zero rows and an empty row set", async () => {
    const user = await makeUser();
    const supplier = await makeSupplier();
    const invoice = await makeApprovedInvoice(supplier.id, user.id, 1000);

    const base = { supplierId: supplier.id, paymentDate: TODAY, bankAccountNumber: "1930" };
    // Σ applied ≠ amount.
    await expect(
      supplierPaymentService.create(
        { ...base, amount: 900, rows: [{ supplierInvoiceId: invoice.id, appliedAmount: 1000 }] },
        user.id
      )
    ).rejects.toThrow(SupplierPaymentRowMismatchError);
    // The same open item twice — each row would be measured against the same
    // open amount and could jointly overpay it.
    await expect(
      supplierPaymentService.create(
        {
          ...base,
          amount: 1000,
          rows: [
            { supplierInvoiceId: invoice.id, appliedAmount: 600 },
            { supplierInvoiceId: invoice.id, appliedAmount: 400 },
          ],
        },
        user.id
      )
    ).rejects.toThrow(SupplierPaymentRowMismatchError);
    // A row that settles nothing.
    await expect(
      supplierPaymentService.create(
        { ...base, amount: 0, rows: [{ supplierInvoiceId: invoice.id, appliedAmount: 0 }] },
        user.id
      )
    ).rejects.toThrow(SupplierPaymentRowMismatchError);
    // No rows at all: the poster would read an empty set with bank 0 as a
    // pure kvittning and return null, so the service has to catch it.
    await expect(supplierPaymentService.create({ ...base, amount: 0, rows: [] }, user.id)).rejects.toThrow(
      SupplierPaymentRowMismatchError
    );

    expect(await countPayments()).toBe(0);
  });

  it("a pure kvittning of a credit note against an invoice books nothing but closes both", async () => {
    const user = await makeUser();
    const supplier = await makeSupplier();
    const invoice = await makeApprovedInvoice(supplier.id, user.id, 125);
    const credit = await makeApprovedInvoice(supplier.id, user.id, -125);
    const verificationsBefore = await countVerifications();

    const payment = await supplierPaymentService.create(
      {
        supplierId: supplier.id,
        paymentDate: TODAY,
        bankAccountNumber: "1930",
        amount: 0,
        rows: [
          { supplierInvoiceId: invoice.id, appliedAmount: 125 },
          { supplierInvoiceId: credit.id, appliedAmount: -125 },
        ],
      },
      user.id
    );

    expect(payment.verificationId).toBeNull();
    expect(payment.verificationDisplayNumber).toBeNull();
    expect(await countVerifications()).toBe(verificationsBefore);
    // Not even the U series is materialized by a non-event (the L series the
    // two attests created is untouched proof the truncate ran).
    expect(await series("U")).toHaveLength(0);
    expect(await series("L")).toHaveLength(1);

    expect((await invoiceStatus(invoice.id)).status).toBe("paid");
    expect((await invoiceStatus(credit.id)).status).toBe("paid");
    expect((await supplierPaymentService.listOpenInvoices({ limit: 50, offset: 0 })).total).toBe(0);
  });

  it("a kvittning WITH a write-off still books — at bank 0", async () => {
    const user = await makeUser();
    const supplier = await makeSupplier();
    const invoice = await makeApprovedInvoice(supplier.id, user.id, 1000);
    const credit = await makeApprovedInvoice(supplier.id, user.id, -1002);

    // The credit note is 2 kr bigger than the invoice: netting them settles
    // the invoice 2 kr "too well" (inside the 5 kr tolerance, so it closes
    // with a write-off) while no money moves at all — Σ applied = 0.
    const payment = await supplierPaymentService.create(
      {
        supplierId: supplier.id,
        paymentDate: TODAY,
        bankAccountNumber: "1930",
        amount: 0,
        rows: [
          { supplierInvoiceId: invoice.id, appliedAmount: 1002 },
          { supplierInvoiceId: credit.id, appliedAmount: -1002 },
        ],
      },
      user.id
    );

    expect(payment.rows[0]!.writeOffAmount).toBe("-2.00");
    expect(payment.rows[1]!.writeOffAmount).toBe("0.00");
    expect(payment.verificationId).not.toBeNull();
    const verification = await loadVerification(payment.verificationId!);
    // No bank row at all — the betalkonto is not even resolved for a payment
    // that moves no money.
    expect(verification.rows).toEqual([
      { number: "2440", debit: "0.00", credit: "2.00" },
      { number: "3740", debit: "2.00", credit: "0.00" },
    ]);
    expectBalanced(verification.rows);

    expect((await invoiceStatus(invoice.id)).status).toBe("paid");
    expect((await invoiceStatus(credit.id)).status).toBe("paid");
    expect((await supplierPaymentService.listOpenInvoices({ limit: 50, offset: 0 })).total).toBe(0);
  });

  it("a mixed payment (bank + kvittning) nets the payable into one row", async () => {
    const user = await makeUser();
    const supplier = await makeSupplier();
    const invoice = await makeApprovedInvoice(supplier.id, user.id, 1000);
    const credit = await makeApprovedInvoice(supplier.id, user.id, -400);

    const payment = await supplierPaymentService.create(
      {
        supplierId: supplier.id,
        paymentDate: TODAY,
        bankAccountNumber: "1930",
        amount: 600,
        rows: [
          { supplierInvoiceId: invoice.id, appliedAmount: 1000 },
          { supplierInvoiceId: credit.id, appliedAmount: -400 },
        ],
      },
      user.id
    );

    const verification = await loadVerification(payment.verificationId!);
    expect(verification.rows).toEqual([
      { number: "1930", debit: "0.00", credit: "600.00" },
      { number: "2440", debit: "600.00", credit: "0.00" },
    ]);
    expectBalanced(verification.rows);
    expect((await invoiceStatus(invoice.id)).status).toBe("paid");
    expect((await invoiceStatus(credit.id)).status).toBe("paid");
  });

  it("two concurrent payments against the same invoice cannot both settle it", async () => {
    const user = await makeUser();
    const supplier = await makeSupplier();
    const invoice = await makeApprovedInvoice(supplier.id, user.id, 1000);

    const register = () =>
      supplierPaymentService.create(
        {
          supplierId: supplier.id,
          paymentDate: TODAY,
          bankAccountNumber: "1930",
          amount: 600,
          rows: [{ supplierInvoiceId: invoice.id, appliedAmount: 600 }],
        },
        user.id
      );

    const results = await Promise.allSettled([register(), register()]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(SupplierPaymentExceedsOpenAmountError);

    expect(await countPayments()).toBe(1);
    expect((await invoiceStatus(invoice.id)).status).toBe("approved");
    const open = await supplierPaymentService.listOpenInvoices({ limit: 50, offset: 0 });
    expect(open.rows[0]!.openAmount).toBe(400);

    // Neither a UTB number nor a U number was burned by the loser.
    const winner = (
      fulfilled[0] as PromiseFulfilledResult<{ paymentNumber: string; verificationDisplayNumber: string | null }>
    ).value;
    const rest = await makeApprovedInvoice(supplier.id, user.id, 100);
    const next = await supplierPaymentService.create(
      {
        supplierId: supplier.id,
        paymentDate: TODAY,
        bankAccountNumber: "1930",
        amount: 100,
        rows: [{ supplierInvoiceId: rest.id, appliedAmount: 100 }],
      },
      user.id
    );
    expect(numericPart(next.paymentNumber)).toBe(numericPart(winner.paymentNumber) + 1);
    expect(verificationNumberPart(next.verificationDisplayNumber!)).toBe(
      verificationNumberPart(winner.verificationDisplayNumber!) + 1
    );
  });

  it("refuses a betalkonto that is the payable account or the write-off account", async () => {
    const user = await makeUser();
    const supplier = await makeSupplier();
    const invoice = await makeApprovedInvoice(supplier.id, user.id, 1000);
    const verificationsBefore = await countVerifications();

    // 2440 as betalkonto: the bank's −1000 would cancel the payable's +1000,
    // so the payment would book nothing at all while real money left the
    // account. The picker offers every active account, so it is one click away.
    const payableConflict = await supplierPaymentService
      .create(
        {
          supplierId: supplier.id,
          paymentDate: TODAY,
          bankAccountNumber: "2440",
          amount: 1000,
          rows: [{ supplierInvoiceId: invoice.id, appliedAmount: 1000 }],
        },
        user.id
      )
      .catch((err: unknown) => err);
    expect(payableConflict).toBeInstanceOf(PaymentBankAccountConflictError);
    expect((payableConflict as PaymentBankAccountConflictError).accountNumber).toBe("2440");

    // 3740 as betalkonto for an underpayment: the bank movement would be
    // absorbed by öres- och kronutjämning, leaving a balanced pair with no
    // bank row in it at all.
    const writeOffConflict = await supplierPaymentService
      .create(
        {
          supplierId: supplier.id,
          paymentDate: TODAY,
          bankAccountNumber: "3740",
          amount: 995,
          rows: [{ supplierInvoiceId: invoice.id, appliedAmount: 995 }],
        },
        user.id
      )
      .catch((err: unknown) => err);
    expect(writeOffConflict).toBeInstanceOf(PaymentBankAccountConflictError);
    expect((writeOffConflict as PaymentBankAccountConflictError).accountNumber).toBe("3740");

    // Neither attempt left anything behind.
    expect(await countPayments()).toBe(0);
    expect(await countVerifications()).toBe(verificationsBefore);
    expect(await series("U")).toHaveLength(0);
    expect((await invoiceStatus(invoice.id)).status).toBe("approved");
  });

  it("refuses a write-off account that IS the payable account — the write-off would hide a residue on 2440", async () => {
    const user = await makeUser();
    const supplier = await makeSupplier();
    const invoice = await makeApprovedInvoice(supplier.id, user.id, 1000);
    const verificationsBefore = await countVerifications();
    // öres- och kronutjämning pointed at 2440: the write-off's −5 would cancel
    // part of the rows' +1000 and the payment would book [1930 K 995,
    // 2440 D 995] — a balanced verification WITH a bank row, so nothing
    // downstream complains while 5 kr of supplier debt stays on the payable
    // for ever and the derived open amount calls the invoice settled.
    await testSystemService.updateSettings({
      ...DEFAULT_POSTING_SETTINGS,
      paymentTolerance: 5,
      postingPaymentWriteOff: "2440",
    });

    const error = await supplierPaymentService
      .create(
        {
          supplierId: supplier.id,
          paymentDate: TODAY,
          bankAccountNumber: "1930",
          amount: 995,
          rows: [{ supplierInvoiceId: invoice.id, appliedAmount: 995 }],
        },
        user.id
      )
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(PaymentBankAccountConflictError);
    expect((error as PaymentBankAccountConflictError).accountNumber).toBe("2440");
    expect((error as PaymentBankAccountConflictError).roleLabel).toBe("payment write-off account");
    expect(await countPayments()).toBe(0);
    expect(await countVerifications()).toBe(verificationsBefore);
    expect((await invoiceStatus(invoice.id)).status).toBe("approved");
  });
});

describe("leverantörsreskontra — makulering", () => {
  it("reverses the U verification, reopens the invoice and clears paidAt", async () => {
    const user = await makeUser();
    const supplier = await makeSupplier();
    const invoice = await makeApprovedInvoice(supplier.id, user.id, 1250);
    const payment = await supplierPaymentService.create(
      {
        supplierId: supplier.id,
        paymentDate: TODAY,
        bankAccountNumber: "1930",
        amount: 1250,
        rows: [{ supplierInvoiceId: invoice.id, appliedAmount: 1250 }],
      },
      user.id
    );

    const cancelled = await supplierPaymentService.cancel(payment.id, user.id);
    expect(cancelled.cancelledAt).not.toBeNull();
    expect(cancelled.cancelledBy).toBe(user.id);
    expect(cancelled.cancellationVerificationId).not.toBeNull();
    expect(cancelled.cancellationDisplayNumber!.startsWith("U-")).toBe(true);

    const reversal = await reversalOf(payment.verificationId!);
    expect(reversal!.seriesCode).toBe("U");
    expect(reversal!.status).toBe("booked");
    expect(reversal!.date).toBe(TODAY);
    expect(reversal!.description).toBe(`Makulering betalning ${payment.paymentNumber} — Lev AB`);
    expect(reversal!.rows).toEqual([
      { number: "1930", debit: "1250.00", credit: "0.00" },
      { number: "2440", debit: "0.00", credit: "1250.00" },
    ]);
    expectBalanced(reversal!.rows);

    const status = await invoiceStatus(invoice.id);
    expect(status.status).toBe("approved");
    expect(status.paidAt).toBeNull();
    const open = await supplierPaymentService.listOpenInvoices({ limit: 50, offset: 0 });
    expect(open.rows[0]!.openAmount).toBe(1250);
  });

  it("a cancelled payment's rows stop settling: the invoice is open again and can be paid over", async () => {
    const user = await makeUser();
    const supplier = await makeSupplier();
    const invoice = await makeApprovedInvoice(supplier.id, user.id, 1000);
    // A DELBETALNING never flipped the invoice, so the cancellation must not
    // touch its status — only what the derived open amount reports.
    const payment = await supplierPaymentService.create(
      {
        supplierId: supplier.id,
        paymentDate: TODAY,
        bankAccountNumber: "1930",
        amount: 400,
        rows: [{ supplierInvoiceId: invoice.id, appliedAmount: 400 }],
      },
      user.id
    );
    expect((await invoiceStatus(invoice.id)).status).toBe("approved");

    await supplierPaymentService.cancel(payment.id, user.id);
    expect((await invoiceStatus(invoice.id)).status).toBe("approved");
    const open = await supplierPaymentService.listOpenInvoices({ limit: 50, offset: 0 });
    expect(open.rows.map((row) => row.openAmount)).toEqual([1000]);

    // The whole amount is payable again — the cancelled rows are still in the
    // table (append-only) but settle nothing.
    const redone = await supplierPaymentService.create(
      {
        supplierId: supplier.id,
        paymentDate: TODAY,
        bankAccountNumber: "1930",
        amount: 1000,
        rows: [{ supplierInvoiceId: invoice.id, appliedAmount: 1000 }],
      },
      user.id
    );
    expect(redone.verificationId).not.toBeNull();
    expect((await invoiceStatus(invoice.id)).status).toBe("paid");
    expect((await supplierPaymentService.listOpenInvoices({ limit: 50, offset: 0 })).total).toBe(0);
  });

  it("cancelling the closing payment reopens the invoice for the rest only — the earlier part payment still counts", async () => {
    const user = await makeUser();
    const supplier = await makeSupplier();
    const invoice = await makeApprovedInvoice(supplier.id, user.id, 1000);

    await supplierPaymentService.create(
      {
        supplierId: supplier.id,
        paymentDate: TODAY,
        bankAccountNumber: "1930",
        amount: 600,
        rows: [{ supplierInvoiceId: invoice.id, appliedAmount: 600 }],
      },
      user.id
    );
    const closing = await supplierPaymentService.create(
      {
        supplierId: supplier.id,
        paymentDate: TODAY,
        bankAccountNumber: "1930",
        amount: 400,
        rows: [{ supplierInvoiceId: invoice.id, appliedAmount: 400 }],
      },
      user.id
    );
    expect((await invoiceStatus(invoice.id)).status).toBe("paid");

    await supplierPaymentService.cancel(closing.id, user.id);

    const status = await invoiceStatus(invoice.id);
    expect(status.status).toBe("approved");
    expect(status.paidAt).toBeNull();
    expect((await supplierInvoiceService.getInvoice(invoice.id))!.openAmount).toBe(400);
    const open = await supplierPaymentService.listOpenInvoices({ limit: 50, offset: 0 });
    expect(open.rows.map((row) => row.openAmount)).toEqual([400]);
  });

  it("cancelling a pure kvittning reverses nothing but reopens both open items", async () => {
    const user = await makeUser();
    const supplier = await makeSupplier();
    const invoice = await makeApprovedInvoice(supplier.id, user.id, 125);
    const credit = await makeApprovedInvoice(supplier.id, user.id, -125);
    const payment = await supplierPaymentService.create(
      {
        supplierId: supplier.id,
        paymentDate: TODAY,
        bankAccountNumber: "1930",
        amount: 0,
        rows: [
          { supplierInvoiceId: invoice.id, appliedAmount: 125 },
          { supplierInvoiceId: credit.id, appliedAmount: -125 },
        ],
      },
      user.id
    );
    const verificationsBefore = await countVerifications();

    const cancelled = await supplierPaymentService.cancel(payment.id, user.id);
    expect(cancelled.cancelledAt).not.toBeNull();
    expect(cancelled.cancellationVerificationId).toBeNull();
    expect(cancelled.cancellationDisplayNumber).toBeNull();
    expect(await countVerifications()).toBe(verificationsBefore);

    expect((await invoiceStatus(invoice.id)).status).toBe("approved");
    expect((await invoiceStatus(credit.id)).status).toBe("approved");
    expect((await supplierPaymentService.listOpenInvoices({ limit: 50, offset: 0 })).total).toBe(2);
  });

  it("a cancellation of another payment leaves the invoice that payment never touched alone", async () => {
    const user = await makeUser();
    const supplier = await makeSupplier();
    const a = await makeApprovedInvoice(supplier.id, user.id, 1000);
    const b = await makeApprovedInvoice(supplier.id, user.id, 500);
    const first = await supplierPaymentService.create(
      {
        supplierId: supplier.id,
        paymentDate: TODAY,
        bankAccountNumber: "1930",
        amount: 1000,
        rows: [{ supplierInvoiceId: a.id, appliedAmount: 1000 }],
      },
      user.id
    );
    await supplierPaymentService.create(
      {
        supplierId: supplier.id,
        paymentDate: TODAY,
        bankAccountNumber: "1930",
        amount: 500,
        rows: [{ supplierInvoiceId: b.id, appliedAmount: 500 }],
      },
      user.id
    );

    await supplierPaymentService.cancel(first.id, user.id);
    expect((await invoiceStatus(a.id)).status).toBe("approved");
    expect((await invoiceStatus(b.id)).status).toBe("paid");
  });

  it("refuses a second cancellation and an unknown payment", async () => {
    const user = await makeUser();
    const supplier = await makeSupplier();
    const invoice = await makeApprovedInvoice(supplier.id, user.id, 1000);
    const payment = await supplierPaymentService.create(
      {
        supplierId: supplier.id,
        paymentDate: TODAY,
        bankAccountNumber: "1930",
        amount: 1000,
        rows: [{ supplierInvoiceId: invoice.id, appliedAmount: 1000 }],
      },
      user.id
    );

    await supplierPaymentService.cancel(payment.id, user.id);
    await expect(supplierPaymentService.cancel(payment.id, user.id)).rejects.toThrow(
      SupplierPaymentAlreadyCancelledError
    );
    await expect(supplierPaymentService.cancel(crypto.randomUUID(), user.id)).rejects.toThrow(
      SupplierPaymentNotFoundError
    );
  });

  it("an unbooked manual omföring on the payment's verification blocks the cancellation", async () => {
    const user = await makeUser();
    const supplier = await makeSupplier();
    const invoice = await makeApprovedInvoice(supplier.id, user.id, 1000);
    const payment = await supplierPaymentService.create(
      {
        supplierId: supplier.id,
        paymentDate: TODAY,
        bankAccountNumber: "1930",
        amount: 1000,
        rows: [{ supplierInvoiceId: invoice.id, appliedAmount: 1000 }],
      },
      user.id
    );
    // A manual Omför under Ekonomi → Verifikat starts as a DRAFT, which is no
    // correction at all — the partial unique index refuses the cancellation's
    // own omföring.
    const draft = await testEconomyService.reverse(payment.verificationId!, user.id);
    expect((await testEconomyService.findVerificationById(draft.id)).status).toBe("draft");

    await expect(supplierPaymentService.cancel(payment.id, user.id)).rejects.toThrow(VerificationAlreadyReversedError);

    const [stored] = await db.select().from(supplierPayments).where(eq(supplierPayments.id, payment.id));
    expect(stored!.cancelledAt).toBeNull();
    expect((await invoiceStatus(invoice.id)).status).toBe("paid");

    // Booking the manual omföring is the way out: the cancellation then goes
    // through without a second omföring of its own.
    await testEconomyService.book(draft.id, user.id);
    const cancelled = await supplierPaymentService.cancel(payment.id, user.id);
    expect(cancelled.cancelledAt).not.toBeNull();
    expect(cancelled.cancellationVerificationId).toBeNull();
    expect((await invoiceStatus(invoice.id)).status).toBe("approved");
  });
});

describe("leverantörsreskontra — betalningslista och fakturakort", () => {
  it("lists payments per supplier with their verification and cancellation numbers", async () => {
    const user = await makeUser();
    const a = await makeSupplier("A AB");
    const b = await makeSupplier("B AB");
    const invoiceA = await makeApprovedInvoice(a.id, user.id, 1000);
    const invoiceB = await makeApprovedInvoice(b.id, user.id, 500);
    const paymentA = await supplierPaymentService.create(
      {
        supplierId: a.id,
        paymentDate: TODAY,
        bankAccountNumber: "1930",
        amount: 1000,
        rows: [{ supplierInvoiceId: invoiceA.id, appliedAmount: 1000 }],
      },
      user.id
    );
    await supplierPaymentService.create(
      {
        supplierId: b.id,
        paymentDate: TODAY,
        bankAccountNumber: "1930",
        amount: 500,
        rows: [{ supplierInvoiceId: invoiceB.id, appliedAmount: 500 }],
      },
      user.id
    );
    await supplierPaymentService.cancel(paymentA.id, user.id);

    const all = await supplierPaymentService.list({ limit: 50, offset: 0 });
    expect(all.total).toBe(2);

    const forA = await supplierPaymentService.list({ supplierId: a.id, limit: 50, offset: 0 });
    expect(forA.total).toBe(1);
    expect(forA.rows[0]!.supplierName).toBe("A AB");
    expect(forA.rows[0]!.verificationDisplayNumber!.startsWith("U-")).toBe(true);
    expect(forA.rows[0]!.cancellationDisplayNumber!.startsWith("U-")).toBe(true);
    expect(forA.rows[0]!.cancelledAt).not.toBeNull();

    const bySearch = await supplierPaymentService.list({ search: paymentA.paymentNumber, limit: 50, offset: 0 });
    expect(bySearch.rows.map((row) => row.id)).toEqual([paymentA.id]);

    const bySupplierName = await supplierPaymentService.list({ search: "B AB", limit: 50, offset: 0 });
    expect(bySupplierName.rows.map((row) => row.supplierName)).toEqual(["B AB"]);

    expect(await supplierPaymentService.getPayment(crypto.randomUUID())).toBeNull();
  });

  it("the invoice detail carries the open amount and the payments that settled it", async () => {
    const user = await makeUser();
    const supplier = await makeSupplier();
    const invoice = await makeApprovedInvoice(supplier.id, user.id, 1000);
    const payment = await supplierPaymentService.create(
      {
        supplierId: supplier.id,
        paymentDate: TODAY,
        bankAccountNumber: "1930",
        amount: 400,
        rows: [{ supplierInvoiceId: invoice.id, appliedAmount: 400 }],
      },
      user.id
    );

    const detail = await supplierInvoiceService.getInvoice(invoice.id);
    expect(detail!.openAmount).toBe(600);
    expect(detail!.payments).toHaveLength(1);
    expect(detail!.payments[0]!.paymentId).toBe(payment.id);
    expect(detail!.payments[0]!.paymentNumber).toBe(payment.paymentNumber);
    expect(detail!.payments[0]!.paymentDate).toBe(TODAY);
    expect(detail!.payments[0]!.appliedAmount).toBe("400.00");
    expect(detail!.payments[0]!.writeOffAmount).toBe("0.00");
    expect(detail!.payments[0]!.cancelledAt).toBeNull();
    expect(detail!.payments[0]!.verificationDisplayNumber!.startsWith("U-")).toBe(true);

    // A cancelled payment stays on the card (append-only) but stops counting.
    await supplierPaymentService.cancel(payment.id, user.id);
    const afterCancel = await supplierInvoiceService.getInvoice(invoice.id);
    expect(afterCancel!.openAmount).toBe(1000);
    expect(afterCancel!.payments).toHaveLength(1);
    expect(afterCancel!.payments[0]!.cancelledAt).not.toBeNull();

    // A draft simply reports its own gross as open.
    const draft = await makeDraftInvoice(supplier.id, user.id, 250);
    expect((await supplierInvoiceService.getInvoice(draft.id))!.openAmount).toBe(250);
  });

  it("the payment rows carry the invoice numbers and keep their input order", async () => {
    const user = await makeUser();
    const supplier = await makeSupplier();
    const first = await makeApprovedInvoice(supplier.id, user.id, 100);
    const second = await makeApprovedInvoice(supplier.id, user.id, 200, { dueDate: "2026-05-05" });
    const third = await makeApprovedInvoice(supplier.id, user.id, 300);

    const payment = await supplierPaymentService.create(
      {
        supplierId: supplier.id,
        paymentDate: TODAY,
        bankAccountNumber: "1930",
        amount: 600,
        rows: [
          { supplierInvoiceId: third.id, appliedAmount: 300 },
          { supplierInvoiceId: first.id, appliedAmount: 100 },
          { supplierInvoiceId: second.id, appliedAmount: 200 },
        ],
      },
      user.id
    );

    expect(payment.rows.map((row) => row.supplierInvoiceId)).toEqual([third.id, first.id, second.id]);
    expect(payment.rows.map((row) => row.registrationNumber)).toEqual([
      third.registrationNumber,
      first.registrationNumber,
      second.registrationNumber,
    ]);
    expect(payment.rows.map((row) => row.invoiceNumber)).toEqual([
      third.invoiceNumber,
      first.invoiceNumber,
      second.invoiceNumber,
    ]);
    expect(payment.rows[2]!.invoiceDueDate).toBe("2026-05-05");

    const stored = await db
      .select({ supplierInvoiceId: supplierPaymentRows.supplierInvoiceId })
      .from(supplierPaymentRows)
      .where(eq(supplierPaymentRows.paymentId, payment.id))
      .orderBy(asc(supplierPaymentRows.createdAt));
    expect(stored.map((row) => row.supplierInvoiceId)).toEqual([third.id, first.id, second.id]);
  });

  it("an approved invoice with a live payment cannot be makulerad until the payment is", async () => {
    const user = await makeUser();
    const supplier = await makeSupplier();
    const invoice = await makeApprovedInvoice(supplier.id, user.id, 1000);
    const payment = await supplierPaymentService.create(
      {
        supplierId: supplier.id,
        paymentDate: TODAY,
        bankAccountNumber: "1930",
        amount: 400,
        rows: [{ supplierInvoiceId: invoice.id, appliedAmount: 400 }],
      },
      user.id
    );

    await expect(supplierInvoiceService.cancel(invoice.id, user.id)).rejects.toThrow(SupplierInvoiceHasPaymentsError);
    expect((await invoiceStatus(invoice.id)).status).toBe("approved");

    // Cancelling the payment removes the obstacle — its rows settle nothing
    // any more, exactly as open-amounts.ts sees it.
    await supplierPaymentService.cancel(payment.id, user.id);
    const cancelled = await supplierInvoiceService.cancel(invoice.id, user.id);
    expect(cancelled!.status).toBe("cancelled");
    expect((await supplierPaymentService.listOpenInvoices({ limit: 50, offset: 0 })).total).toBe(0);
  });

  it("paid is terminal: neither attest nor makulering is offered on a settled invoice", async () => {
    const user = await makeUser();
    const supplier = await makeSupplier();
    const invoice = await makeApprovedInvoice(supplier.id, user.id, 1000);
    await supplierPaymentService.create(
      {
        supplierId: supplier.id,
        paymentDate: TODAY,
        bankAccountNumber: "1930",
        amount: 1000,
        rows: [{ supplierInvoiceId: invoice.id, appliedAmount: 1000 }],
      },
      user.id
    );
    expect((await invoiceStatus(invoice.id)).status).toBe("paid");

    await expect(supplierInvoiceService.approve(invoice.id, user.id)).rejects.toThrow(InvalidStatusTransitionError);
    await expect(supplierInvoiceService.cancel(invoice.id, user.id)).rejects.toThrow(InvalidStatusTransitionError);
    expect((await invoiceStatus(invoice.id)).status).toBe("paid");
  });

  it("has no pay() surface at all — paid is a side effect of the payment registration", async () => {
    // B4 removed POST /supplier-invoices/:id/pay: "paid" is set by the
    // registration and unset by its cancellation, never as a transition of
    // its own.
    expect("pay" in supplierInvoiceService).toBe(false);
    expect("markPaid" in supplierInvoiceService).toBe(false);
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

describe("leverantörsreskontra — audit trail", () => {
  it("logs created and cancelled under the payment's UTB-number", async () => {
    const user = await makeUser();
    const supplier = await makeSupplier();
    const invoice = await makeApprovedInvoice(supplier.id, user.id, 1000);

    const payment = await supplierPaymentService.create(
      {
        supplierId: supplier.id,
        paymentDate: TODAY,
        bankAccountNumber: "1930",
        amount: 1000,
        rows: [{ supplierInvoiceId: invoice.id, appliedAmount: 1000 }],
      },
      user.id
    );

    const created = await auditRows("supplier_payment", "created");
    expect(created).toHaveLength(1);
    expect(created[0]!.entityId).toBe(payment.paymentNumber);
    expect(created[0]!.userId).toBe(user.id);

    await supplierPaymentService.cancel(payment.id, user.id);
    const cancelled = await auditRows("supplier_payment", "cancelled");
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]!.entityId).toBe(payment.paymentNumber);
  });
});

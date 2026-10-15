import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, asc, eq, sql } from "drizzle-orm";
import {
  accounts,
  auditLog,
  customerPaymentRows,
  customerPayments,
  customers,
  db,
  invoices,
  verificationRows,
  verifications,
  verificationSeries,
} from "@navet/db";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { createVerificationPoster } from "../src/modules/economy/service/verification-poster.js";
import { readPostingSettings } from "../src/modules/system/service/posting-settings.js";
import { createInvoiceRepository } from "../src/modules/sales/repository/invoice.repository.js";
import { createInvoiceService } from "../src/modules/sales/service/invoice.service.js";
import { createPaymentRepository } from "../src/modules/sales/repository/payment.repository.js";
import {
  createPaymentService,
  InvalidOcrError,
  InvoiceNotOpenError,
  PaymentAlreadyCancelledError,
  PaymentExceedsOpenAmountError,
  PaymentNotFoundError,
  PaymentRowMismatchError,
  VerificationAlreadyReversedError,
} from "../src/modules/sales/service/payment.service.js";
import { InvoiceNotFoundError } from "../src/modules/sales/service/invoice.service.js";
import {
  DEFAULT_POSTING_SETTINGS,
  setupPostingBaseline,
  testEconomyService,
  testSystemService,
} from "./helpers/services.js";

// B3 kundreskontra: registering a customer payment settles open items and
// books the K verification inside ONE transaction. This suite drives the real
// wiring end to end — the poster is built on the real readPostingSettings leaf
// (exactly as app.ts does) and the invoices are real issued C1 invoices, so
// the settings → open amounts → verification → paid-flip path is the one
// production runs.
const authRepo = createAuthRepository(db);
const poster = createVerificationPoster({ read: readPostingSettings });

// This suite never mails or prints — the collaborators only exist because the
// invoice service constructor takes them.
const mailStub = {
  async sendMail() {
    return null;
  },
};
const pdfStub = {
  async render() {
    return Buffer.alloc(0);
  },
  // Never called here — the reminder flow has its own suite
  // (invoice-reminder.service.test.ts); this only satisfies the renderer
  // interface the invoice service takes.
  async renderPaymentReminder() {
    return Buffer.alloc(0);
  },
};
const invoiceRepo = createInvoiceRepository(db);
const auditRepository = createAuditRepository(db);
const invoiceService = createInvoiceService(invoiceRepo, mailStub, pdfStub, poster, auditRepository);
const paymentService = createPaymentService(createPaymentRepository(db), poster, auditRepository);

// number_series is NEVER truncated (shared, sequence-like base data) — every
// assertion below is relative to the BET/verifikat number the previous
// registration produced, never an absolute one.
const TRUNCATE = sql`TRUNCATE posting_rules, verification_rows, verifications, verification_counters, verification_series, accounting_periods, fiscal_years, accounts, customer_payment_rows, customer_payments, invoice_rows, invoices, customers, audit_log, users CASCADE`;

const TODAY = new Date().toLocaleDateString("sv-SE");

// Same fixture as invoice-reminder.service.test.ts's own MAIL — this suite
// only needs sendReminder for the Påminnelser-column fixture below, not for
// exercising the reminder flow itself (that whole flow has its own suite).
const MAIL = { to: "kund@example.com", subject: "Betalningspåminnelse", message: "Vänligen betala." };

beforeEach(async () => {
  await db.execute(TRUNCATE);
  await setupPostingBaseline();
  // system_settings survives the truncate (it is shared base data), so the
  // posting roles, the tolerance AND the reminder fee are all reset
  // explicitly — another suite may have pointed a role somewhere else, moved
  // the tolerance, or zeroed the fee.
  await testSystemService.updateSettings({ ...DEFAULT_POSTING_SETTINGS, paymentTolerance: 5, reminderFee: 60 });
});

afterAll(async () => {
  await db.execute(TRUNCATE);
  await testSystemService.updateSettings({ ...DEFAULT_POSTING_SETTINGS, paymentTolerance: 5, reminderFee: 60 });
});

async function makeUser() {
  return authRepo.create({
    email: `pay-${crypto.randomUUID()}@example.com`,
    passwordHash: "not-a-real-hash",
    name: "Reskontra",
    role: "admin",
  });
}

async function makeCustomer(name = "Kund AB") {
  const [row] = await db
    .insert(customers)
    .values({ name, customerNumber: `TEST-${crypto.randomUUID()}`, active: true })
    .returning();
  return row!;
}

// An issued invoice whose gross is exactly `gross` (net + 25 % VAT).
async function makeIssuedInvoice(customerId: string, userId: string, gross: number) {
  const draft = await invoiceService.create(
    { customerId, rows: [{ description: "Leverans", quantity: 1, unitPrice: gross / 1.25, vatRate: 25 }] },
    userId
  );
  return (await invoiceService.issue(draft!.id, userId))!;
}

// An issued credit note against `sourceId` for the whole amount.
async function makeIssuedCredit(sourceId: string, userId: string) {
  const credit = await invoiceService.createCredit(sourceId, {}, userId);
  return (await invoiceService.issue(credit!.id, userId))!;
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

// K-2026-7 -> 7 (the display number carries series and year too).
function verificationNumberPart(displayNumber: string) {
  return Number(displayNumber.split("-").pop());
}

async function invoiceStatus(invoiceId: string) {
  const [row] = await db
    .select({ status: invoices.status, paidAt: invoices.paidAt })
    .from(invoices)
    .where(eq(invoices.id, invoiceId));
  return row!;
}

async function countPayments() {
  const rows = await db.select({ id: customerPayments.id }).from(customerPayments);
  return rows.length;
}

async function countVerifications() {
  const rows = await db.select({ id: verifications.id }).from(verifications);
  return rows.length;
}

describe("kundreskontra — öppna poster", () => {
  it("lists issued invoices with a non-zero open amount, credits negative, due date first", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    const invoice = await makeIssuedInvoice(customer.id, user.id, 1000);
    const credit = await makeIssuedCredit(invoice.id, user.id);
    // A draft is not an open item at all.
    await invoiceService.create(
      { customerId: customer.id, rows: [{ description: "Utkast", quantity: 1, unitPrice: 100 }] },
      user.id
    );
    // Frozen due dates so the ordering is deterministic (the payment term
    // decides them at issue; these invoices have none).
    await db.update(invoices).set({ dueDate: "2026-03-01" }).where(eq(invoices.id, invoice.id));
    await db.update(invoices).set({ dueDate: "2026-02-01" }).where(eq(invoices.id, credit.id));

    const { rows, total } = await paymentService.listOpenInvoices({ limit: 50, offset: 0 });
    expect(total).toBe(2);
    expect(rows.map((r) => r.id)).toEqual([credit.id, invoice.id]);
    expect(rows[0]!.openAmount).toBe(-1000);
    expect(rows[0]!.type).toBe("credit");
    expect(rows[1]!.openAmount).toBe(1000);
    expect(rows[1]!.customerName).toBe("Kund AB");
    expect(rows[1]!.ocrNumber).not.toBeNull();
  });

  it("same due date: ties break on createdAt (insertion order), not the FA number's text sort", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    const first = await makeIssuedInvoice(customer.id, user.id, 100);
    const second = await makeIssuedInvoice(customer.id, user.id, 100);
    // Same due date on both, so only the secondary sort decides. Forcing
    // invoiceNumber into "FA-2"/"FA-10" territory reproduces the bug a plain
    // asc(invoiceNumber) tie-break had: "FA-10" sorts BEFORE "FA-2" as text,
    // even though FA-2 was issued (and is due) first.
    await db.update(invoices).set({ dueDate: "2026-03-01", invoiceNumber: "FA-2" }).where(eq(invoices.id, first.id));
    await db
      .update(invoices)
      .set({ dueDate: "2026-03-01", invoiceNumber: "FA-10" })
      .where(eq(invoices.id, second.id));

    const { rows } = await paymentService.listOpenInvoices({ customerId: customer.id, limit: 50, offset: 0 });
    // createdAt order (first issued first), not the text-sorted FA-10/FA-2.
    expect(rows.map((r) => r.id)).toEqual([first.id, second.id]);
  });

  it("filters on customer and on overdue only", async () => {
    const user = await makeUser();
    const a = await makeCustomer("A AB");
    const b = await makeCustomer("B AB");
    const overdue = await makeIssuedInvoice(a.id, user.id, 500);
    const future = await makeIssuedInvoice(a.id, user.id, 500);
    const other = await makeIssuedInvoice(b.id, user.id, 500);
    await db.update(invoices).set({ dueDate: "2020-01-01" }).where(eq(invoices.id, overdue.id));
    await db.update(invoices).set({ dueDate: "2999-01-01" }).where(eq(invoices.id, future.id));
    await db.update(invoices).set({ dueDate: "2020-01-01" }).where(eq(invoices.id, other.id));

    const forA = await paymentService.listOpenInvoices({ customerId: a.id, limit: 50, offset: 0 });
    expect(forA.total).toBe(2);
    expect(forA.rows.every((r) => r.customerId === a.id)).toBe(true);

    const overdueOnly = await paymentService.listOpenInvoices({ overdueOnly: true, limit: 50, offset: 0 });
    expect(overdueOnly.total).toBe(2);
    expect(overdueOnly.rows.map((r) => r.id).sort()).toEqual([overdue.id, other.id].sort());

    const both = await paymentService.listOpenInvoices({
      customerId: a.id,
      overdueOnly: true,
      limit: 50,
      offset: 0,
    });
    expect(both.rows.map((r) => r.id)).toEqual([overdue.id]);
  });

  it("summarizes påminnelser per invoice: reminderCount + whether a fee was ever charged", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    const reminded = await makeIssuedInvoice(customer.id, user.id, 1000);
    const untouched = await makeIssuedInvoice(customer.id, user.id, 500);

    // Fee-free (level 1), then a fee-charging one (level 2) — mirrors
    // invoice-reminder.service.test.ts's own send pattern.
    await invoiceService.sendReminder(reminded.id, { ...MAIL, withFee: false }, user.id);
    await invoiceService.sendReminder(reminded.id, { ...MAIL, withFee: true }, user.id);

    const { rows } = await paymentService.listOpenInvoices({ customerId: customer.id, limit: 50, offset: 0 });
    const remindedRow = rows.find((r) => r.id === reminded.id)!;
    const untouchedRow = rows.find((r) => r.id === untouched.id)!;

    expect(remindedRow.reminderCount).toBe(2);
    expect(remindedRow.reminderFeeCharged).toBe(true);
    expect(untouchedRow.reminderCount).toBe(0);
    expect(untouchedRow.reminderFeeCharged).toBe(false);
  });

  it("finds an open invoice by its OCR number; rejects a malformed one and misses a settled one", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    const invoice = await makeIssuedInvoice(customer.id, user.id, 1000);

    const found = await paymentService.findOpenByOcr(invoice.ocrNumber!);
    expect(found!.id).toBe(invoice.id);
    expect(found!.openAmount).toBe(1000);

    await expect(paymentService.findOpenByOcr("12345")).rejects.toThrow(InvalidOcrError);
    await expect(paymentService.findOpenByOcr("abc")).rejects.toThrow(InvalidOcrError);

    // Valid OCR (same construction), but no invoice carries it.
    const unknown = await paymentService.findOpenByOcr(computeOcrLike("999999"));
    expect(unknown).toBeNull();

    // Settled invoices are no longer open items.
    await paymentService.create(
      {
        customerId: customer.id,
        paymentDate: TODAY,
        bankAccountNumber: "1930",
        amount: 1000,
        rows: [{ invoiceId: invoice.id, appliedAmount: 1000 }],
      },
      user.id
    );
    expect(await paymentService.findOpenByOcr(invoice.ocrNumber!)).toBeNull();
  });
});

// Mirrors computeOcrNumber for a base that belongs to no invoice — kept local
// so the test does not depend on the production helper for its own fixture.
function computeOcrLike(base: string) {
  const withLength = base + String((base.length + 2) % 10);
  let sum = 0;
  for (let i = 0; i < withLength.length; i++) {
    let d = Number(withLength[withLength.length - 1 - i]);
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return withLength + String((10 - (sum % 10)) % 10);
}

describe("kundreskontra — betalningsregistrering", () => {
  it("a full payment books a K verification, closes the invoice and leaves nothing open", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    const invoice = await makeIssuedInvoice(customer.id, user.id, 1000);

    const payment = await paymentService.create(
      {
        customerId: customer.id,
        paymentDate: TODAY,
        bankAccountNumber: "1930",
        amount: 1000,
        note: "Bankgiro",
        rows: [{ invoiceId: invoice.id, appliedAmount: 1000 }],
      },
      user.id
    );

    expect(payment.paymentNumber.startsWith("BET-")).toBe(true);
    expect(payment.amount).toBe("1000.00");
    expect(payment.cancelledAt).toBeNull();
    expect(payment.rows).toHaveLength(1);
    expect(payment.rows[0]!.appliedAmount).toBe("1000.00");
    expect(payment.rows[0]!.writeOffAmount).toBe("0.00");
    expect(payment.rows[0]!.invoiceNumber).toBe(invoice.invoiceNumber);

    expect(payment.verificationId).not.toBeNull();
    expect(payment.verificationDisplayNumber!.startsWith("K-")).toBe(true);
    const verification = await loadVerification(payment.verificationId!);
    expect(verification.seriesCode).toBe("K");
    expect(verification.status).toBe("booked");
    expect(verification.date).toBe(TODAY);
    expect(verification.description).toBe(`Betalning ${payment.paymentNumber} — Kund AB`);
    expect(verification.rows).toEqual([
      { number: "1930", debit: "1000.00", credit: "0.00" },
      { number: "1510", debit: "0.00", credit: "1000.00" },
    ]);
    expectBalanced(verification.rows);

    const status = await invoiceStatus(invoice.id);
    expect(status.status).toBe("paid");
    expect(status.paidAt).not.toBeNull();
    expect((await paymentService.listOpenInvoices({ limit: 50, offset: 0 })).total).toBe(0);
  });

  it("a partial payment leaves the rest open, writes nothing off and keeps the invoice issued", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    const invoice = await makeIssuedInvoice(customer.id, user.id, 1000);

    const payment = await paymentService.create(
      {
        customerId: customer.id,
        paymentDate: TODAY,
        bankAccountNumber: "1930",
        amount: 400,
        rows: [{ invoiceId: invoice.id, appliedAmount: 400 }],
      },
      user.id
    );

    expect(payment.rows[0]!.writeOffAmount).toBe("0.00");
    expect((await invoiceStatus(invoice.id)).status).toBe("issued");
    const open = await paymentService.listOpenInvoices({ limit: 50, offset: 0 });
    expect(open.rows[0]!.openAmount).toBe(600);

    const verification = await loadVerification(payment.verificationId!);
    expect(verification.rows).toEqual([
      { number: "1930", debit: "400.00", credit: "0.00" },
      { number: "1510", debit: "0.00", credit: "400.00" },
    ]);
  });

  it("an underpayment within tolerance writes off the difference and closes the invoice", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    const invoice = await makeIssuedInvoice(customer.id, user.id, 1000);

    const payment = await paymentService.create(
      {
        customerId: customer.id,
        paymentDate: TODAY,
        bankAccountNumber: "1930",
        amount: 995,
        rows: [{ invoiceId: invoice.id, appliedAmount: 995 }],
      },
      user.id
    );

    expect(payment.rows[0]!.writeOffAmount).toBe("5.00");
    expect((await invoiceStatus(invoice.id)).status).toBe("paid");
    const verification = await loadVerification(payment.verificationId!);
    const byAccount = Object.fromEntries(verification.rows.map((r) => [r.number, r]));
    expect(byAccount["1930"]).toEqual({ number: "1930", debit: "995.00", credit: "0.00" });
    expect(byAccount["1510"]).toEqual({ number: "1510", debit: "0.00", credit: "1000.00" });
    expect(byAccount["3740"]).toEqual({ number: "3740", debit: "5.00", credit: "0.00" });
    expectBalanced(verification.rows);
  });

  it("an overpayment within tolerance credits the write-off account and closes the invoice", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    const invoice = await makeIssuedInvoice(customer.id, user.id, 1000);

    const payment = await paymentService.create(
      {
        customerId: customer.id,
        paymentDate: TODAY,
        bankAccountNumber: "1930",
        amount: 1003,
        rows: [{ invoiceId: invoice.id, appliedAmount: 1003 }],
      },
      user.id
    );

    expect(payment.rows[0]!.writeOffAmount).toBe("-3.00");
    expect((await invoiceStatus(invoice.id)).status).toBe("paid");
    const verification = await loadVerification(payment.verificationId!);
    const byAccount = Object.fromEntries(verification.rows.map((r) => [r.number, r]));
    expect(byAccount["1930"]).toEqual({ number: "1930", debit: "1003.00", credit: "0.00" });
    expect(byAccount["1510"]).toEqual({ number: "1510", debit: "0.00", credit: "1000.00" });
    expect(byAccount["3740"]).toEqual({ number: "3740", debit: "0.00", credit: "3.00" });
    expectBalanced(verification.rows);
  });

  it("an overpayment beyond tolerance is refused and leaves no payment, no verification and no burnt number", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    const invoice = await makeIssuedInvoice(customer.id, user.id, 1000);
    const verificationsBefore = await countVerifications();

    await expect(
      paymentService.create(
        {
          customerId: customer.id,
          paymentDate: TODAY,
          bankAccountNumber: "1930",
          amount: 1010,
          rows: [{ invoiceId: invoice.id, appliedAmount: 1010 }],
        },
        user.id
      )
    ).rejects.toThrow(PaymentExceedsOpenAmountError);

    expect(await countPayments()).toBe(0);
    expect(await countVerifications()).toBe(verificationsBefore);
    expect((await invoiceStatus(invoice.id)).status).toBe("issued");

    // The BET number the rejected attempt allocated rolled back with it: the
    // next registration takes it.
    const first = await paymentService.create(
      {
        customerId: customer.id,
        paymentDate: TODAY,
        bankAccountNumber: "1930",
        amount: 1000,
        rows: [{ invoiceId: invoice.id, appliedAmount: 1000 }],
      },
      user.id
    );
    const second = await makeIssuedInvoice(customer.id, user.id, 100);
    const next = await paymentService.create(
      {
        customerId: customer.id,
        paymentDate: TODAY,
        bankAccountNumber: "1930",
        amount: 100,
        rows: [{ invoiceId: second.id, appliedAmount: 100 }],
      },
      user.id
    );
    expect(numericPart(next.paymentNumber)).toBe(numericPart(first.paymentNumber) + 1);
  });

  it("a pure kvittning of a credit note against an invoice books nothing but closes both", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    const invoice = await makeIssuedInvoice(customer.id, user.id, 1000);
    const credit = await makeIssuedCredit(invoice.id, user.id);
    const verificationsBefore = await countVerifications();

    const payment = await paymentService.create(
      {
        customerId: customer.id,
        paymentDate: TODAY,
        bankAccountNumber: "1930",
        amount: 0,
        rows: [
          { invoiceId: invoice.id, appliedAmount: 1000 },
          { invoiceId: credit.id, appliedAmount: -1000 },
        ],
      },
      user.id
    );

    expect(payment.verificationId).toBeNull();
    expect(payment.verificationDisplayNumber).toBeNull();
    expect(await countVerifications()).toBe(verificationsBefore);
    // Not even the K series is materialized by a non-event.
    const series = await db.select().from(verificationSeries).where(eq(verificationSeries.code, "K"));
    expect(series).toHaveLength(0);

    expect((await invoiceStatus(invoice.id)).status).toBe("paid");
    expect((await invoiceStatus(credit.id)).status).toBe("paid");
    expect((await paymentService.listOpenInvoices({ limit: 50, offset: 0 })).total).toBe(0);
  });

  it("a mixed payment (bank + kvittning) nets the receivable into one row", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    const invoice = await makeIssuedInvoice(customer.id, user.id, 1000);
    const source = await makeIssuedInvoice(customer.id, user.id, 400);
    const credit = await makeIssuedCredit(source.id, user.id);
    // The source invoice is settled by the credit's own kvittning below, so
    // pay it off first to keep this case to the two open items under test.
    await paymentService.create(
      {
        customerId: customer.id,
        paymentDate: TODAY,
        bankAccountNumber: "1930",
        amount: 400,
        rows: [{ invoiceId: source.id, appliedAmount: 400 }],
      },
      user.id
    );

    const payment = await paymentService.create(
      {
        customerId: customer.id,
        paymentDate: TODAY,
        bankAccountNumber: "1930",
        amount: 600,
        rows: [
          { invoiceId: invoice.id, appliedAmount: 1000 },
          { invoiceId: credit.id, appliedAmount: -400 },
        ],
      },
      user.id
    );

    const verification = await loadVerification(payment.verificationId!);
    expect(verification.rows).toEqual([
      { number: "1930", debit: "600.00", credit: "0.00" },
      { number: "1510", debit: "0.00", credit: "600.00" },
    ]);
    expectBalanced(verification.rows);
    expect((await invoiceStatus(invoice.id)).status).toBe("paid");
    expect((await invoiceStatus(credit.id)).status).toBe("paid");
  });

  it("applies the tolerance to a CREDIT note too: 3 kr too much paid out closes it and lands on 3740", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    const invoice = await makeIssuedInvoice(customer.id, user.id, 1000);
    const source = await makeIssuedInvoice(customer.id, user.id, 250);
    const credit = await makeIssuedCredit(source.id, user.id);
    // The credit's source invoice is settled separately, so the payment below
    // is exactly the two open items under test (same fixture shape as the
    // mixed payment above).
    await paymentService.create(
      {
        customerId: customer.id,
        paymentDate: TODAY,
        bankAccountNumber: "1930",
        amount: 250,
        rows: [{ invoiceId: source.id, appliedAmount: 250 }],
      },
      user.id
    );

    // The credit note is open −250 but 253 is deducted from the payment: the
    // signs mirror an underpaid invoice, so the 3 kr difference is inside the
    // 5 kr tolerance and the credit CLOSES. The invoice row keeps the sum
    // honest: B = 1000 − 253 = 747.
    const payment = await paymentService.create(
      {
        customerId: customer.id,
        paymentDate: TODAY,
        bankAccountNumber: "1930",
        amount: 747,
        rows: [
          { invoiceId: invoice.id, appliedAmount: 1000 },
          { invoiceId: credit.id, appliedAmount: -253 },
        ],
      },
      user.id
    );

    expect(payment.rows[0]!.writeOffAmount).toBe("0.00");
    expect(payment.rows[1]!.writeOffAmount).toBe("3.00");

    const verification = await loadVerification(payment.verificationId!);
    expectBalanced(verification.rows);
    const byAccount = Object.fromEntries(verification.rows.map((r) => [r.number, r]));
    expect(byAccount["1930"]).toEqual({ number: "1930", debit: "747.00", credit: "0.00" });
    // 1000 off the invoice, 250 back onto the credit note → 750 net.
    expect(byAccount["1510"]).toEqual({ number: "1510", debit: "0.00", credit: "750.00" });
    expect(byAccount["3740"]).toEqual({ number: "3740", debit: "3.00", credit: "0.00" });

    expect((await invoiceStatus(invoice.id)).status).toBe("paid");
    expect((await invoiceStatus(credit.id)).status).toBe("paid");
    expect((await paymentService.listOpenInvoices({ limit: 50, offset: 0 })).total).toBe(0);
  });

  it("refuses an invoice belonging to another customer, a draft invoice and an unknown one", async () => {
    const user = await makeUser();
    const customer = await makeCustomer("A AB");
    const other = await makeCustomer("B AB");
    const foreign = await makeIssuedInvoice(other.id, user.id, 100);
    const draft = await invoiceService.create(
      { customerId: customer.id, rows: [{ description: "Utkast", quantity: 1, unitPrice: 100 }] },
      user.id
    );

    await expect(
      paymentService.create(
        {
          customerId: customer.id,
          paymentDate: TODAY,
          bankAccountNumber: "1930",
          amount: 100,
          rows: [{ invoiceId: foreign.id, appliedAmount: 100 }],
        },
        user.id
      )
    ).rejects.toThrow(PaymentRowMismatchError);

    await expect(
      paymentService.create(
        {
          customerId: customer.id,
          paymentDate: TODAY,
          bankAccountNumber: "1930",
          amount: 100,
          rows: [{ invoiceId: draft!.id, appliedAmount: 100 }],
        },
        user.id
      )
    ).rejects.toThrow(InvoiceNotOpenError);

    await expect(
      paymentService.create(
        {
          customerId: customer.id,
          paymentDate: TODAY,
          bankAccountNumber: "1930",
          amount: 100,
          rows: [{ invoiceId: crypto.randomUUID(), appliedAmount: 100 }],
        },
        user.id
      )
    ).rejects.toThrow(InvoiceNotFoundError);

    expect(await countPayments()).toBe(0);
  });

  it("refuses rows that do not add up to the bank amount, duplicate rows, zero rows and a wrong sign", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    const invoice = await makeIssuedInvoice(customer.id, user.id, 1000);

    const base = { customerId: customer.id, paymentDate: TODAY, bankAccountNumber: "1930" };
    // Σ applied ≠ amount.
    await expect(
      paymentService.create(
        { ...base, amount: 900, rows: [{ invoiceId: invoice.id, appliedAmount: 1000 }] },
        user.id
      )
    ).rejects.toThrow(PaymentRowMismatchError);
    // The same open item twice.
    await expect(
      paymentService.create(
        {
          ...base,
          amount: 1000,
          rows: [
            { invoiceId: invoice.id, appliedAmount: 600 },
            { invoiceId: invoice.id, appliedAmount: 400 },
          ],
        },
        user.id
      )
    ).rejects.toThrow(PaymentRowMismatchError);
    // A row that settles nothing.
    await expect(
      paymentService.create({ ...base, amount: 0, rows: [{ invoiceId: invoice.id, appliedAmount: 0 }] }, user.id)
    ).rejects.toThrow(PaymentRowMismatchError);
    // A negative amount against a positive open item (a credit-note sign on
    // an invoice) — never a partial payment, always a mistake.
    await expect(
      paymentService.create({ ...base, amount: -100, rows: [{ invoiceId: invoice.id, appliedAmount: -100 }] }, user.id)
    ).rejects.toThrow(PaymentRowMismatchError);

    expect(await countPayments()).toBe(0);
  });

  it("two concurrent payments against the same invoice cannot both settle it", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    const invoice = await makeIssuedInvoice(customer.id, user.id, 1000);

    const register = () =>
      paymentService.create(
        {
          customerId: customer.id,
          paymentDate: TODAY,
          bankAccountNumber: "1930",
          amount: 600,
          rows: [{ invoiceId: invoice.id, appliedAmount: 600 }],
        },
        user.id
      );

    const results = await Promise.allSettled([register(), register()]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(PaymentExceedsOpenAmountError);

    expect(await countPayments()).toBe(1);
    expect((await invoiceStatus(invoice.id)).status).toBe("issued");
    const open = await paymentService.listOpenInvoices({ limit: 50, offset: 0 });
    expect(open.rows[0]!.openAmount).toBe(400);

    // Neither a BET number nor a K number was burned by the loser.
    const winner = (fulfilled[0] as PromiseFulfilledResult<{ paymentNumber: string; verificationDisplayNumber: string | null }>)
      .value;
    const rest = await makeIssuedInvoice(customer.id, user.id, 100);
    const next = await paymentService.create(
      {
        customerId: customer.id,
        paymentDate: TODAY,
        bankAccountNumber: "1930",
        amount: 100,
        rows: [{ invoiceId: rest.id, appliedAmount: 100 }],
      },
      user.id
    );
    expect(numericPart(next.paymentNumber)).toBe(numericPart(winner.paymentNumber) + 1);
    expect(verificationNumberPart(next.verificationDisplayNumber!)).toBe(
      verificationNumberPart(winner.verificationDisplayNumber!) + 1
    );
  });
});

describe("kundreskontra — makulering", () => {
  it("reverses the K verification, reopens the invoice and clears paidAt", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    const invoice = await makeIssuedInvoice(customer.id, user.id, 1000);
    const payment = await paymentService.create(
      {
        customerId: customer.id,
        paymentDate: TODAY,
        bankAccountNumber: "1930",
        amount: 1000,
        rows: [{ invoiceId: invoice.id, appliedAmount: 1000 }],
      },
      user.id
    );

    const cancelled = await paymentService.cancel(payment.id, user.id);
    expect(cancelled.cancelledAt).not.toBeNull();
    expect(cancelled.cancelledBy).toBe(user.id);
    expect(cancelled.cancellationVerificationId).not.toBeNull();
    expect(cancelled.cancellationDisplayNumber!.startsWith("K-")).toBe(true);

    const reversal = await reversalOf(payment.verificationId!);
    expect(reversal!.seriesCode).toBe("K");
    expect(reversal!.status).toBe("booked");
    expect(reversal!.rows).toEqual([
      { number: "1930", debit: "0.00", credit: "1000.00" },
      { number: "1510", debit: "1000.00", credit: "0.00" },
    ]);
    expectBalanced(reversal!.rows);

    const status = await invoiceStatus(invoice.id);
    expect(status.status).toBe("issued");
    expect(status.paidAt).toBeNull();
    const open = await paymentService.listOpenInvoices({ limit: 50, offset: 0 });
    expect(open.rows[0]!.openAmount).toBe(1000);
  });

  it("cancelling a pure kvittning reverses nothing but reopens both open items", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    const invoice = await makeIssuedInvoice(customer.id, user.id, 1000);
    const credit = await makeIssuedCredit(invoice.id, user.id);
    const payment = await paymentService.create(
      {
        customerId: customer.id,
        paymentDate: TODAY,
        bankAccountNumber: "1930",
        amount: 0,
        rows: [
          { invoiceId: invoice.id, appliedAmount: 1000 },
          { invoiceId: credit.id, appliedAmount: -1000 },
        ],
      },
      user.id
    );
    const verificationsBefore = await countVerifications();

    const cancelled = await paymentService.cancel(payment.id, user.id);
    expect(cancelled.cancellationVerificationId).toBeNull();
    expect(await countVerifications()).toBe(verificationsBefore);

    expect((await invoiceStatus(invoice.id)).status).toBe("issued");
    expect((await invoiceStatus(credit.id)).status).toBe("issued");
    const open = await paymentService.listOpenInvoices({ limit: 50, offset: 0 });
    expect(open.total).toBe(2);
  });

  it("a partly settled invoice is not touched by a cancellation of another payment", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    const a = await makeIssuedInvoice(customer.id, user.id, 1000);
    const b = await makeIssuedInvoice(customer.id, user.id, 500);
    const first = await paymentService.create(
      {
        customerId: customer.id,
        paymentDate: TODAY,
        bankAccountNumber: "1930",
        amount: 1000,
        rows: [{ invoiceId: a.id, appliedAmount: 1000 }],
      },
      user.id
    );
    await paymentService.create(
      {
        customerId: customer.id,
        paymentDate: TODAY,
        bankAccountNumber: "1930",
        amount: 500,
        rows: [{ invoiceId: b.id, appliedAmount: 500 }],
      },
      user.id
    );

    await paymentService.cancel(first.id, user.id);
    expect((await invoiceStatus(a.id)).status).toBe("issued");
    expect((await invoiceStatus(b.id)).status).toBe("paid");
  });

  it("cancelling the closing payment reopens the invoice for the rest only — the earlier part payment still counts", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    const invoice = await makeIssuedInvoice(customer.id, user.id, 1000);

    // Delbetalning: 600 of 1000 — the invoice stays open for the rest.
    await paymentService.create(
      {
        customerId: customer.id,
        paymentDate: TODAY,
        bankAccountNumber: "1930",
        amount: 600,
        rows: [{ invoiceId: invoice.id, appliedAmount: 600 }],
      },
      user.id
    );
    expect((await invoiceStatus(invoice.id)).status).toBe("issued");
    expect((await invoiceService.getInvoice(invoice.id))!.openAmount).toBe(400);

    // Slutbetalning: the remaining 400 closes it.
    const closing = await paymentService.create(
      {
        customerId: customer.id,
        paymentDate: TODAY,
        bankAccountNumber: "1930",
        amount: 400,
        rows: [{ invoiceId: invoice.id, appliedAmount: 400 }],
      },
      user.id
    );
    expect((await invoiceStatus(invoice.id)).status).toBe("paid");

    // Cancelling only the LAST payment reopens the invoice for what that
    // payment settled — never for the whole amount: the open amount is
    // derived from every non-cancelled payment row, so the 600 stands.
    await paymentService.cancel(closing.id, user.id);

    const status = await invoiceStatus(invoice.id);
    expect(status.status).toBe("issued");
    expect(status.paidAt).toBeNull();
    expect((await invoiceService.getInvoice(invoice.id))!.openAmount).toBe(400);
    const open = await paymentService.listOpenInvoices({ limit: 50, offset: 0 });
    expect(open.rows.map((r) => r.openAmount)).toEqual([400]);
  });

  it("refuses a second cancellation and an unknown payment", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    const invoice = await makeIssuedInvoice(customer.id, user.id, 1000);
    const payment = await paymentService.create(
      {
        customerId: customer.id,
        paymentDate: TODAY,
        bankAccountNumber: "1930",
        amount: 1000,
        rows: [{ invoiceId: invoice.id, appliedAmount: 1000 }],
      },
      user.id
    );

    await paymentService.cancel(payment.id, user.id);
    await expect(paymentService.cancel(payment.id, user.id)).rejects.toThrow(PaymentAlreadyCancelledError);
    await expect(paymentService.cancel(crypto.randomUUID(), user.id)).rejects.toThrow(PaymentNotFoundError);
  });

  it("an unbooked manual omföring on the payment's verification blocks the cancellation", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    const invoice = await makeIssuedInvoice(customer.id, user.id, 1000);
    const payment = await paymentService.create(
      {
        customerId: customer.id,
        paymentDate: TODAY,
        bankAccountNumber: "1930",
        amount: 1000,
        rows: [{ invoiceId: invoice.id, appliedAmount: 1000 }],
      },
      user.id
    );
    // A manual Omför under Ekonomi → Verifikat starts as a DRAFT, which is no
    // correction at all — the partial unique index refuses the cancellation's
    // own omföring.
    await testEconomyService.reverse(payment.verificationId!, user.id);

    await expect(paymentService.cancel(payment.id, user.id)).rejects.toThrow(VerificationAlreadyReversedError);

    const [stored] = await db.select().from(customerPayments).where(eq(customerPayments.id, payment.id));
    expect(stored!.cancelledAt).toBeNull();
    expect((await invoiceStatus(invoice.id)).status).toBe("paid");
  });
});

describe("kundreskontra — betalningslista och fakturakort", () => {
  it("lists payments per customer with their verification and cancellation numbers", async () => {
    const user = await makeUser();
    const a = await makeCustomer("A AB");
    const b = await makeCustomer("B AB");
    const invoiceA = await makeIssuedInvoice(a.id, user.id, 1000);
    const invoiceB = await makeIssuedInvoice(b.id, user.id, 500);
    const paymentA = await paymentService.create(
      {
        customerId: a.id,
        paymentDate: TODAY,
        bankAccountNumber: "1930",
        amount: 1000,
        rows: [{ invoiceId: invoiceA.id, appliedAmount: 1000 }],
      },
      user.id
    );
    await paymentService.create(
      {
        customerId: b.id,
        paymentDate: TODAY,
        bankAccountNumber: "1930",
        amount: 500,
        rows: [{ invoiceId: invoiceB.id, appliedAmount: 500 }],
      },
      user.id
    );
    await paymentService.cancel(paymentA.id, user.id);

    const all = await paymentService.list({ limit: 50, offset: 0 });
    expect(all.total).toBe(2);

    const forA = await paymentService.list({ customerId: a.id, limit: 50, offset: 0 });
    expect(forA.total).toBe(1);
    expect(forA.rows[0]!.customerName).toBe("A AB");
    expect(forA.rows[0]!.verificationDisplayNumber!.startsWith("K-")).toBe(true);
    expect(forA.rows[0]!.cancellationDisplayNumber!.startsWith("K-")).toBe(true);
    expect(forA.rows[0]!.cancelledAt).not.toBeNull();

    const bySearch = await paymentService.list({ search: paymentA.paymentNumber, limit: 50, offset: 0 });
    expect(bySearch.rows.map((r) => r.id)).toEqual([paymentA.id]);

    expect(await paymentService.getPayment(crypto.randomUUID())).toBeNull();
  });

  it("the invoice detail carries the open amount and the payments that settled it", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    const invoice = await makeIssuedInvoice(customer.id, user.id, 1000);
    const payment = await paymentService.create(
      {
        customerId: customer.id,
        paymentDate: TODAY,
        bankAccountNumber: "1930",
        amount: 400,
        rows: [{ invoiceId: invoice.id, appliedAmount: 400 }],
      },
      user.id
    );

    const detail = await invoiceService.getInvoice(invoice.id);
    expect(detail!.openAmount).toBe(600);
    expect(detail!.payments).toHaveLength(1);
    expect(detail!.payments[0]!.paymentId).toBe(payment.id);
    expect(detail!.payments[0]!.paymentNumber).toBe(payment.paymentNumber);
    expect(detail!.payments[0]!.appliedAmount).toBe("400.00");
    expect(detail!.payments[0]!.writeOffAmount).toBe("0.00");
    expect(detail!.payments[0]!.cancelledAt).toBeNull();
    expect(detail!.payments[0]!.verificationDisplayNumber!.startsWith("K-")).toBe(true);

    // A cancelled payment stays on the card (append-only) but stops counting.
    await paymentService.cancel(payment.id, user.id);
    const afterCancel = await invoiceService.getInvoice(invoice.id);
    expect(afterCancel!.openAmount).toBe(1000);
    expect(afterCancel!.payments).toHaveLength(1);
    expect(afterCancel!.payments[0]!.cancelledAt).not.toBeNull();
  });

  it("the payment rows keep their input order (strictly increasing stamps)", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    const first = await makeIssuedInvoice(customer.id, user.id, 100);
    const second = await makeIssuedInvoice(customer.id, user.id, 200);
    const third = await makeIssuedInvoice(customer.id, user.id, 300);

    const payment = await paymentService.create(
      {
        customerId: customer.id,
        paymentDate: TODAY,
        bankAccountNumber: "1930",
        amount: 600,
        rows: [
          { invoiceId: third.id, appliedAmount: 300 },
          { invoiceId: first.id, appliedAmount: 100 },
          { invoiceId: second.id, appliedAmount: 200 },
        ],
      },
      user.id
    );

    expect(payment.rows.map((r) => r.invoiceId)).toEqual([third.id, first.id, second.id]);
    const stored = await db
      .select({ invoiceId: customerPaymentRows.invoiceId })
      .from(customerPaymentRows)
      .where(eq(customerPaymentRows.paymentId, payment.id))
      .orderBy(asc(customerPaymentRows.createdAt));
    expect(stored.map((r) => r.invoiceId)).toEqual([third.id, first.id, second.id]);
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

describe("kundreskontra — audit trail", () => {
  it("logs created and cancelled under the payment's BET-number", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    const invoice = await makeIssuedInvoice(customer.id, user.id, 1000);

    const payment = await paymentService.create(
      {
        customerId: customer.id,
        paymentDate: TODAY,
        bankAccountNumber: "1930",
        amount: 1000,
        rows: [{ invoiceId: invoice.id, appliedAmount: 1000 }],
      },
      user.id
    );

    const created = await auditRows("customer_payment", "created");
    expect(created).toHaveLength(1);
    expect(created[0]!.entityId).toBe(payment.paymentNumber);
    expect(created[0]!.userId).toBe(user.id);

    await paymentService.cancel(payment.id, user.id);
    const cancelled = await auditRows("customer_payment", "cancelled");
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]!.entityId).toBe(payment.paymentNumber);
  });
});

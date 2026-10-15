import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { asc, eq, sql } from "drizzle-orm";
import {
  accounts,
  customers,
  db,
  emailLog,
  invoiceReminders,
  invoices,
  verificationRows,
  verifications,
  verificationSeries,
} from "@navet/db";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createVerificationPoster } from "../src/modules/economy/service/verification-poster.js";
import { readPostingSettings } from "../src/modules/system/service/posting-settings.js";
import { createMailRepository } from "../src/modules/mail/repository/mail.repository.js";
import { createMailService, MailSendError, type MailTransportFactory } from "../src/modules/mail/service/mail.service.js";
import { createDocumentPdfService } from "../src/modules/mail/service/document-pdf.js";
import { createSystemRepository } from "../src/modules/system/repository/system.repository.js";
import { createSystemService } from "../src/modules/system/service/system.service.js";
import { createInvoiceRepository } from "../src/modules/sales/repository/invoice.repository.js";
import {
  createInvoiceService,
  InvoiceNotFoundError,
  NothingToRemindError,
  ReminderFeeAlreadyChargedError,
} from "../src/modules/sales/service/invoice.service.js";
import { InvalidStatusTransitionError } from "../src/modules/sales/service/sales.service.js";
import { createPaymentRepository } from "../src/modules/sales/repository/payment.repository.js";
import { createPaymentService } from "../src/modules/sales/service/payment.service.js";
import { AccountingPeriodLockedError } from "../src/modules/economy/service/accounting-period-lock.js";
import { MissingPostingAccountError } from "../src/modules/economy/service/verification-poster.js";
import { pdfText } from "./helpers/pdf.js";
import {
  DEFAULT_POSTING_SETTINGS,
  setupPostingBaseline,
  testEconomyService,
  testSystemService,
} from "./helpers/services.js";

// B3 kundreskontra, Task 6: betalningspåminnelser. The reminder is an email
// with a PDF; the statutory one-time fee it may carry is a real bokförings-
// händelse that lands on the open item. This suite drives the whole wiring —
// real PDF renderer, real mail service (fake SMTP transport), real poster on
// the real readPostingSettings leaf — because the ORDER of the steps (SMTP
// first, then one transaction) is the thing that must not regress.
const authRepo = createAuthRepository(db);
const poster = createVerificationPoster({ read: readPostingSettings });

// The fake transport: records what was "sent", can be told to fail, and can
// be gated so a test can interleave another transaction with a send in flight.
type SentMail = {
  to: string;
  subject: string;
  text: string;
  attachments?: { filename: string; content: Buffer }[];
};
const sentMails: SentMail[] = [];
let failNextSend = false;
let sendGate: (() => Promise<void>) | null = null;
const fakeTransportFactory: MailTransportFactory = () => ({
  async sendMail(opts) {
    if (sendGate) await sendGate();
    if (failNextSend) {
      failNextSend = false;
      throw new Error("smtp down");
    }
    sentMails.push(opts as SentMail);
  },
});

const systemService = createSystemService(createSystemRepository(db));
const mailService = createMailService(createMailRepository(db), systemService, fakeTransportFactory);
const documentPdfService = createDocumentPdfService(systemService);
const invoiceRepo = createInvoiceRepository(db);
const invoiceService = createInvoiceService(invoiceRepo, mailService, documentPdfService, poster);
const paymentService = createPaymentService(createPaymentRepository(db), poster);

// number_series is NEVER truncated (shared, sequence-like base data).
const TRUNCATE = sql`TRUNCATE posting_rules, verification_rows, verifications, verification_counters, verification_series, accounting_periods, fiscal_years, accounts, customer_payment_rows, customer_payments, invoice_reminders, invoice_rows, invoices, customers, email_log, audit_log, users CASCADE`;

const TODAY = new Date().toLocaleDateString("sv-SE");

// Mirrors document-pdf.ts's formatNumber (sv-SE uses U+00A0 as the thousands
// separator, so a literal " " in an expectation would never match).
function sv(n: number): string {
  return n.toLocaleString("sv-SE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace("−", "-");
}

beforeEach(async () => {
  await db.execute(TRUNCATE);
  await setupPostingBaseline();
  sentMails.length = 0;
  failNextSend = false;
  sendGate = null;
  // system_settings survives the truncate (shared base data), so the posting
  // roles, the tolerance, the reminder fee AND the SMTP config are all reset.
  await testSystemService.updateSettings({
    ...DEFAULT_POSTING_SETTINGS,
    paymentTolerance: 5,
    reminderFee: 60,
    smtpHost: "smtp.test.local",
    smtpFromEmail: "erp@test.local",
  });
});

afterAll(async () => {
  await db.execute(TRUNCATE);
  await testSystemService.updateSettings({ ...DEFAULT_POSTING_SETTINGS, paymentTolerance: 5, reminderFee: 60 });
});

async function makeUser() {
  return authRepo.create({
    email: `rem-${crypto.randomUUID()}@example.com`,
    passwordHash: "not-a-real-hash",
    name: "Reskontra",
    role: "admin",
  });
}

async function makeCustomer(name = "Kund AB") {
  const [row] = await db
    .insert(customers)
    .values({
      name,
      customerNumber: `TEST-${crypto.randomUUID()}`,
      active: true,
      invoiceAddress: "Fakturagatan 1",
      invoicePostalCode: "12345",
      invoiceCity: "Stad",
    })
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

const MAIL = { to: "kund@example.com", subject: "Betalningspåminnelse", message: "Vänligen betala." };

async function loadVerification(verificationId: string) {
  const [verification] = await db
    .select({
      id: verifications.id,
      seriesCode: verificationSeries.code,
      verificationNumber: verifications.verificationNumber,
      date: verifications.date,
      description: verifications.description,
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

async function remindersOf(invoiceId: string) {
  return db
    .select()
    .from(invoiceReminders)
    .where(eq(invoiceReminders.invoiceId, invoiceId))
    .orderBy(asc(invoiceReminders.level));
}

async function countVerifications() {
  const rows = await db.select({ id: verifications.id }).from(verifications);
  return rows.length;
}

async function openAmountOf(invoiceId: string) {
  return (await invoiceService.getInvoice(invoiceId))!.openAmount;
}

// The accounting period covering today — what a reminder fee would be booked
// into (same helper as customer-invoice-posting.test.ts's).
async function currentPeriod(fiscalYearId: string) {
  const year = await testEconomyService.findFiscalYearById(fiscalYearId);
  return year.periods.find((period) => period.startDate <= TODAY && period.endDate >= TODAY)!;
}

async function invoiceStatus(invoiceId: string) {
  const [row] = await db.select({ status: invoices.status }).from(invoices).where(eq(invoices.id, invoiceId));
  return row!.status;
}

describe("kundreskontra — betalningspåminnelser", () => {
  it("sends a fee-free reminder: level 1, no verification, open amount untouched, logged as payment_reminder", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    const invoice = await makeIssuedInvoice(customer.id, user.id, 1000);
    const verificationsBefore = await countVerifications();

    await invoiceService.sendReminder(invoice.id, { ...MAIL, withFee: false }, user.id);

    expect(sentMails).toHaveLength(1);
    expect(sentMails[0]!.to).toBe("kund@example.com");
    expect(sentMails[0]!.attachments![0]!.filename).toContain(invoice.invoiceNumber!);

    const reminders = await remindersOf(invoice.id);
    expect(reminders).toHaveLength(1);
    expect(reminders[0]!.level).toBe(1);
    expect(Number(reminders[0]!.fee)).toBe(0);
    expect(reminders[0]!.feeVerificationId).toBeNull();
    expect(reminders[0]!.createdBy).toBe(user.id);

    // A fee-free reminder is not a bokföringshändelse and changes nothing.
    expect(await countVerifications()).toBe(verificationsBefore);
    expect(await openAmountOf(invoice.id)).toBe(1000);
    expect(await invoiceStatus(invoice.id)).toBe("issued");

    const log = await db.select().from(emailLog).where(eq(emailLog.documentId, invoice.id));
    expect(log).toHaveLength(1);
    expect(log[0]!.documentType).toBe("payment_reminder");
    expect(log[0]!.status).toBe("sent");

    // The invoice card's own reminder history.
    const card = await invoiceService.getInvoice(invoice.id);
    expect(card!.reminders).toHaveLength(1);
    expect(card!.reminders[0]!.level).toBe(1);
    expect(Number(card!.reminders[0]!.fee)).toBe(0);
    expect(card!.reminders[0]!.feeVerificationDisplayNumber).toBeNull();
  });

  it("charges the statutory fee: K verification 1510/3540, and the fee joins the open amount", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    const invoice = await makeIssuedInvoice(customer.id, user.id, 1000);

    await invoiceService.sendReminder(invoice.id, { ...MAIL, withFee: true }, user.id);

    const reminders = await remindersOf(invoice.id);
    expect(reminders).toHaveLength(1);
    expect(Number(reminders[0]!.fee)).toBe(60);
    expect(reminders[0]!.feeVerificationId).not.toBeNull();

    const verification = await loadVerification(reminders[0]!.feeVerificationId!);
    expect(verification.seriesCode).toBe("K");
    expect(verification.date).toBe(TODAY);
    expect(verification.description).toContain(invoice.invoiceNumber!);
    expect(verification.rows).toHaveLength(2);
    const byAccount = new Map(verification.rows.map((row) => [row.number, row]));
    expect(Number(byAccount.get("1510")!.debit)).toBe(60);
    expect(Number(byAccount.get("1510")!.credit)).toBe(0);
    expect(Number(byAccount.get("3540")!.credit)).toBe(60);
    expect(Number(byAccount.get("3540")!.debit)).toBe(0);

    // THE point of the whole task: the fee lands on the open item.
    expect(await openAmountOf(invoice.id)).toBe(1060);
    expect(await invoiceStatus(invoice.id)).toBe("issued");

    const card = await invoiceService.getInvoice(invoice.id);
    expect(card!.reminders[0]!.feeVerificationDisplayNumber).toMatch(/^K-/);
  });

  it("the invoice closes only when the invoice amount AND the fee are paid", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    const invoice = await makeIssuedInvoice(customer.id, user.id, 1000);
    await invoiceService.sendReminder(invoice.id, { ...MAIL, withFee: true }, user.id);

    // Paying only the invoice amount leaves the fee open (60 kr is well
    // beyond the 5 kr tolerance, so nothing is written off).
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
    expect(await invoiceStatus(invoice.id)).toBe("issued");
    expect(await openAmountOf(invoice.id)).toBe(60);

    await paymentService.create(
      {
        customerId: customer.id,
        paymentDate: TODAY,
        bankAccountNumber: "1930",
        amount: 60,
        rows: [{ invoiceId: invoice.id, appliedAmount: 60 }],
      },
      user.id
    );
    expect(await invoiceStatus(invoice.id)).toBe("paid");
    expect(await openAmountOf(invoice.id)).toBe(0);
  });

  it("takes the fee amount from the settings, not from a constant", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    const invoice = await makeIssuedInvoice(customer.id, user.id, 1000);
    await testSystemService.updateSettings({ reminderFee: 75 });

    await invoiceService.sendReminder(invoice.id, { ...MAIL, withFee: true }, user.id);

    expect(Number((await remindersOf(invoice.id))[0]!.fee)).toBe(75);
    expect(await openAmountOf(invoice.id)).toBe(1075);
  });

  it("refuses a second fee — through the service guard, and through the partial unique index for anything bypassing it", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    const invoice = await makeIssuedInvoice(customer.id, user.id, 1000);
    await invoiceService.sendReminder(invoice.id, { ...MAIL, withFee: true }, user.id);
    const verificationsAfterFirst = await countVerifications();

    await expect(invoiceService.sendReminder(invoice.id, { ...MAIL, withFee: true }, user.id)).rejects.toThrow(
      ReminderFeeAlreadyChargedError
    );
    // The guard runs BEFORE the SMTP send: nothing went out, nothing booked.
    expect(sentMails).toHaveLength(1);
    expect(await remindersOf(invoice.id)).toHaveLength(1);
    expect(await countVerifications()).toBe(verificationsAfterFirst);
    expect(await openAmountOf(invoice.id)).toBe(1060);

    // The statutory guarantee is the index, not the guard: a second fee row
    // is impossible even for a writer that never asked the service. Drizzle
    // wraps the driver error ("Failed query: ..."), so the assertion is on the
    // 23505 code — exactly what the service's isUniqueViolation reads.
    const duplicate = await db
      .insert(invoiceReminders)
      .values({ invoiceId: invoice.id, level: 9, fee: "60.00" })
      .then(() => null)
      .catch((err: unknown) => err);
    expect(duplicate).toBeInstanceOf(Error);
    const code =
      (duplicate as { code?: string }).code ?? ((duplicate as { cause?: { code?: string } }).cause ?? {}).code;
    expect(code).toBe("23505");
    // Fee-free rows are unconstrained — the index is partial.
    await db.insert(invoiceReminders).values({ invoiceId: invoice.id, level: 9, fee: "0" });
    await db.insert(invoiceReminders).values({ invoiceId: invoice.id, level: 10, fee: "0" });
    expect(await remindersOf(invoice.id)).toHaveLength(3);
  });

  it("numbers further fee-free reminders and keeps the single fee", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    const invoice = await makeIssuedInvoice(customer.id, user.id, 1000);

    await invoiceService.sendReminder(invoice.id, { ...MAIL, withFee: true }, user.id);
    await invoiceService.sendReminder(invoice.id, { ...MAIL, withFee: false }, user.id);
    const card = await invoiceService.sendReminder(invoice.id, { ...MAIL, withFee: false }, user.id);

    expect(sentMails).toHaveLength(3);
    const reminders = await remindersOf(invoice.id);
    expect(reminders.map((r) => r.level)).toEqual([1, 2, 3]);
    expect(reminders.map((r) => Number(r.fee))).toEqual([60, 0, 0]);
    expect(card.reminders).toHaveLength(3);
    // Still exactly one fee in the open amount.
    expect(await openAmountOf(invoice.id)).toBe(1060);
  });

  it("refuses to remind about a draft, a cancelled invoice, a paid invoice, a credit note and an invoice with nothing open", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();

    const draft = await invoiceService.create(
      { customerId: customer.id, rows: [{ description: "Utkast", quantity: 1, unitPrice: 100 }] },
      user.id
    );
    await expect(invoiceService.sendReminder(draft!.id, { ...MAIL, withFee: false }, user.id)).rejects.toThrow(
      InvalidStatusTransitionError
    );

    const invoice = await makeIssuedInvoice(customer.id, user.id, 1000);
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
    await expect(invoiceService.sendReminder(invoice.id, { ...MAIL, withFee: false }, user.id)).rejects.toThrow(
      InvalidStatusTransitionError
    );

    // Issued with nothing open (the paid-flip forced back through the test
    // seam) — a reminder would demand 0 kr.
    await invoiceRepo.updateStatus(invoice.id, "issued");
    await expect(invoiceService.sendReminder(invoice.id, { ...MAIL, withFee: false }, user.id)).rejects.toThrow(
      NothingToRemindError
    );

    // A credit note owes the customer money; its open amount is negative.
    const source = await makeIssuedInvoice(customer.id, user.id, 500);
    const credit = await invoiceService.issue((await invoiceService.createCredit(source.id, {}, user.id))!.id, user.id);
    await expect(invoiceService.sendReminder(credit!.id, { ...MAIL, withFee: false }, user.id)).rejects.toThrow(
      NothingToRemindError
    );

    await expect(
      invoiceService.sendReminder(crypto.randomUUID(), { ...MAIL, withFee: false }, user.id)
    ).rejects.toThrow(InvoiceNotFoundError);

    expect(sentMails).toHaveLength(0);
  });

  it("refuses a fee reminder BEFORE mailing when the accounting period is locked", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    const { fiscalYearId } = await setupPostingBaseline();
    const invoice = await makeIssuedInvoice(customer.id, user.id, 1000);
    const period = await currentPeriod(fiscalYearId);
    await testEconomyService.lockPeriod(period.id, user.id);

    await expect(invoiceService.sendReminder(invoice.id, { ...MAIL, withFee: true }, user.id)).rejects.toThrow(
      AccountingPeriodLockedError
    );

    // The whole point: a misconfiguration must not cost the customer an email
    // it can only fail on, over and over.
    expect(sentMails).toHaveLength(0);
    expect(await db.select().from(emailLog).where(eq(emailLog.documentId, invoice.id))).toHaveLength(0);
    expect(await remindersOf(invoice.id)).toHaveLength(0);
    expect(await openAmountOf(invoice.id)).toBe(1000);

    // A FEE-FREE reminder books nothing, so a locked period is none of its
    // business — it must still go out.
    await invoiceService.sendReminder(invoice.id, { ...MAIL, withFee: false }, user.id);
    expect(sentMails).toHaveLength(1);
    expect(await remindersOf(invoice.id)).toHaveLength(1);
    expect(await openAmountOf(invoice.id)).toBe(1000);

    // Unlocked again, the fee reminder goes through.
    await testEconomyService.unlockPeriod(period.id, "Rättelse", user.id);
    await invoiceService.sendReminder(invoice.id, { ...MAIL, withFee: true }, user.id);
    expect(sentMails).toHaveLength(2);
    expect(await openAmountOf(invoice.id)).toBe(1060);
  });

  it("refuses a fee reminder BEFORE mailing when the fee account is inactive or missing", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    const invoice = await makeIssuedInvoice(customer.id, user.id, 1000);

    // Deactivated fee account (3540).
    await db.update(accounts).set({ active: false }).where(eq(accounts.number, "3540"));
    await expect(invoiceService.sendReminder(invoice.id, { ...MAIL, withFee: true }, user.id)).rejects.toThrow(
      MissingPostingAccountError
    );
    expect(sentMails).toHaveLength(0);
    expect(await db.select().from(emailLog).where(eq(emailLog.documentId, invoice.id))).toHaveLength(0);
    expect(await remindersOf(invoice.id)).toHaveLength(0);

    // A fee account number that no account carries at all.
    await db.update(accounts).set({ active: true }).where(eq(accounts.number, "3540"));
    await testSystemService.updateSettings({ postingReminderFeeAccount: "3599" });
    await expect(invoiceService.sendReminder(invoice.id, { ...MAIL, withFee: true }, user.id)).rejects.toThrow(
      MissingPostingAccountError
    );
    expect(sentMails).toHaveLength(0);

    // Same for the receivable side of the posting.
    await testSystemService.updateSettings({ postingReminderFeeAccount: "3540" });
    await db.update(accounts).set({ active: false }).where(eq(accounts.number, "1510"));
    await expect(invoiceService.sendReminder(invoice.id, { ...MAIL, withFee: true }, user.id)).rejects.toThrow(
      MissingPostingAccountError
    );
    expect(sentMails).toHaveLength(0);

    // And a fee-free reminder is still legal with the accounts in that state.
    await invoiceService.sendReminder(invoice.id, { ...MAIL, withFee: false }, user.id);
    expect(sentMails).toHaveLength(1);
    expect(await remindersOf(invoice.id)).toHaveLength(1);
  });

  it("a failed SMTP send persists no reminder, no fee and no verification — only the failed log entry", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    const invoice = await makeIssuedInvoice(customer.id, user.id, 1000);
    const verificationsBefore = await countVerifications();
    failNextSend = true;

    await expect(invoiceService.sendReminder(invoice.id, { ...MAIL, withFee: true }, user.id)).rejects.toThrow(
      MailSendError
    );

    expect(await remindersOf(invoice.id)).toHaveLength(0);
    expect(await countVerifications()).toBe(verificationsBefore);
    expect(await openAmountOf(invoice.id)).toBe(1000);
    const log = await db.select().from(emailLog).where(eq(emailLog.documentId, invoice.id));
    expect(log).toHaveLength(1);
    expect(log[0]!.documentType).toBe("payment_reminder");
    expect(log[0]!.status).toBe("failed");
  });

  it("a payment that closes the invoice while the email is in flight makes the fee refuse to persist", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    const invoice = await makeIssuedInvoice(customer.id, user.id, 1000);

    // Hold the send open, let the customer pay in full, then release it: the
    // transaction's row-locked re-check is what has to notice.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached!: () => void;
    const reachedSmtp = new Promise<void>((resolve) => {
      reached = resolve;
    });
    sendGate = async () => {
      reached();
      await gate;
    };

    const pending = invoiceService.sendReminder(invoice.id, { ...MAIL, withFee: true }, user.id);
    await reachedSmtp;
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
    release();

    await expect(pending).rejects.toThrow(InvalidStatusTransitionError);
    // The email DID go out (that is why it is logged as sent) but nothing was
    // charged — a retry is the documented recovery.
    expect(sentMails).toHaveLength(1);
    expect(await remindersOf(invoice.id)).toHaveLength(0);
    expect(await invoiceStatus(invoice.id)).toBe("paid");
    expect(await openAmountOf(invoice.id)).toBe(0);
  });

  it("prints the level, the stored amounts, the fee and the OCR reference on the PDF", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    const invoice = await makeIssuedInvoice(customer.id, user.id, 1000);
    // A part payment first, so "Betalt/krediterat" is a real figure.
    await paymentService.create(
      {
        customerId: customer.id,
        paymentDate: TODAY,
        bankAccountNumber: "1930",
        amount: 400,
        rows: [{ invoiceId: invoice.id, appliedAmount: 400 }],
      },
      user.id
    );

    await invoiceService.sendReminder(invoice.id, { ...MAIL, withFee: true }, user.id);

    const text = pdfText(sentMails[0]!.attachments![0]!.content);
    expect(text).toContain("Betalningspåminnelse 1");
    expect(text).toContain(`Faktura ${invoice.invoiceNumber}`);
    expect(text).toContain("Kund AB");
    expect(text).toContain("Fakturabelopp inkl. moms");
    expect(text).toContain("Betalt/krediterat");
    expect(text).toContain("Påminnelseavgift");
    expect(text).toContain("Att betala");
    expect(text).toContain(sv(1000));
    expect(text).toContain(sv(-400));
    expect(text).toContain(sv(60));
    expect(text).toContain(sv(660)); // 1000 - 400 + 60
    expect(text).toContain(`OCR-nummer: ${invoice.ocrNumber}`);
  });

  it("leaves the settled line off entirely when nothing has been paid", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    const invoice = await makeIssuedInvoice(customer.id, user.id, 1000);

    // The most common reminder of all: an untouched invoice. Printing the
    // deduction here would render 0 as "-0,00" (sv-SE keeps the sign), which
    // reads as an error on a document that goes to the customer — so the line
    // is skipped, exactly like the fee line is when no fee is charged.
    await invoiceService.sendReminder(invoice.id, { ...MAIL, withFee: false }, user.id);

    const text = pdfText(sentMails[0]!.attachments![0]!.content);
    expect(text).not.toContain("Betalt/krediterat");
    expect(text).not.toContain("-0,00");
    // The rest of the summary is unchanged.
    expect(text).toContain("Fakturabelopp inkl. moms");
    expect(text).toContain("Att betala");
    expect(text).toContain(sv(1000));
  });

  it("previews the reminder PDF without sending or persisting anything", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    const invoice = await makeIssuedInvoice(customer.id, user.id, 1000);
    const verificationsBefore = await countVerifications();

    const withFee = await invoiceService.renderReminderPdf(invoice.id, true);
    const withoutFee = await invoiceService.renderReminderPdf(invoice.id, false);

    expect(pdfText(withFee.content)).toContain(sv(1060));
    expect(pdfText(withoutFee.content)).toContain(sv(1000));
    expect(pdfText(withoutFee.content)).not.toContain("Påminnelseavgift");

    expect(sentMails).toHaveLength(0);
    expect(await remindersOf(invoice.id)).toHaveLength(0);
    expect(await countVerifications()).toBe(verificationsBefore);
    expect(await openAmountOf(invoice.id)).toBe(1000);

    // A charged fee is already in the open amount, so a "with fee" preview
    // after the fact must not add a second one.
    await invoiceService.sendReminder(invoice.id, { ...MAIL, withFee: true }, user.id);
    const afterCharge = await invoiceService.renderReminderPdf(invoice.id, true);
    expect(pdfText(afterCharge.content)).toContain(sv(1060));
    expect(pdfText(afterCharge.content)).not.toContain(sv(1120));
  });
});


// Arkiverade fakturadokument: the invoice and every sent reminder are kept as
// the exact PDF bytes — reprints/emails never follow later company changes.
describe("archived invoice documents (bokföringslagen: verifikationen oförändrad)", () => {
  async function archivedRows(invoiceId: string) {
    return (await db.execute(
      sql`SELECT kind, reminder_id, sha256 FROM invoice_documents WHERE invoice_id = ${invoiceId} ORDER BY created_at`
    )) as unknown as { kind: string; reminder_id: string | null; sha256: string }[];
  }

  it("archives the PDF at issue and serves those exact bytes, even after the company info changes", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    const invoice = await makeIssuedInvoice(customer.id, user.id, 1250);

    const rows = await archivedRows(invoice.id);
    expect(rows.map((r) => r.kind)).toEqual(["invoice"]);

    const original = await systemService.getCompanyInfo();
    try {
      await systemService.updateCompanyInfo({ name: "Helt Nytt Företagsnamn AB" });
      const reprint = await invoiceService.renderPdf(invoice.id);
      const hash = (await import("node:crypto")).createHash("sha256").update(reprint.content).digest("hex");
      expect(hash).toBe(rows[0]!.sha256);
      expect(pdfText(reprint.content)).not.toContain("Helt Nytt Företagsnamn AB");
    } finally {
      await systemService.updateCompanyInfo({ name: original.name });
    }
    expect(await archivedRows(invoice.id)).toHaveLength(1);
  });

  it("archives on first print for an invoice issued before the archive existed", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    const invoice = await makeIssuedInvoice(customer.id, user.id, 500);
    // Simulate an invoice issued before the archive existed. The archive is
    // insert-only (migration 0095's lock trigger refuses the DELETE), so the
    // trigger is switched off for just this test-only setup statement.
    await db.execute(sql`ALTER TABLE invoice_documents DISABLE TRIGGER invoice_documents_bookkeeping_lock`);
    try {
      await db.execute(sql`DELETE FROM invoice_documents WHERE invoice_id = ${invoice.id}`);
    } finally {
      await db.execute(sql`ALTER TABLE invoice_documents ENABLE TRIGGER invoice_documents_bookkeeping_lock`);
    }

    const first = await invoiceService.renderPdf(invoice.id);
    const second = await invoiceService.renderPdf(invoice.id);
    expect(Buffer.compare(first.content, second.content)).toBe(0);
    expect(await archivedRows(invoice.id)).toHaveLength(1);
  });

  it("archives each sent reminder exactly as emailed, in the reminder's own transaction", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    const invoice = await makeIssuedInvoice(customer.id, user.id, 1000);
    await invoiceService.sendReminder(invoice.id, { ...MAIL, withFee: false }, user.id);

    const reminders = await remindersOf(invoice.id);
    const archived = await invoiceService.reminderPdf(invoice.id, reminders[0]!.id);
    expect(Buffer.compare(archived.content, sentMails.at(-1)!.attachments![0]!.content)).toBe(0);
    const detail = await invoiceService.getInvoice(invoice.id);
    expect(detail!.reminders[0]!.documentId).not.toBeNull();
  });
});

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { asc, eq, sql } from "drizzle-orm";
import {
  accounts,
  customers,
  db,
  invoiceRows,
  invoices,
  lateInterestCharges,
  referenceRates,
  verificationRows,
  verifications,
  verificationSeries,
} from "@navet/db";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createVerificationPoster } from "../src/modules/economy/service/verification-poster.js";
import { readPostingSettings } from "../src/modules/system/service/posting-settings.js";
import { createMailRepository } from "../src/modules/mail/repository/mail.repository.js";
import { createMailService, type MailTransportFactory } from "../src/modules/mail/service/mail.service.js";
import { createDocumentPdfService } from "../src/modules/mail/service/document-pdf.js";
import { createSystemRepository } from "../src/modules/system/repository/system.repository.js";
import { createSystemService } from "../src/modules/system/service/system.service.js";
import { referenceRatesFor } from "../src/modules/system/repository/reference-rates.js";
import { createInvoiceRepository } from "../src/modules/sales/repository/invoice.repository.js";
import { createInvoiceService, ReminderFeeAfterLateFeeError } from "../src/modules/sales/service/invoice.service.js";
import {
  createLateInterestService,
  LateInterestAlreadyChargedError,
  LateInterestDisabledError,
} from "../src/modules/sales/service/late-interest.service.js";
import { createPaymentRepository } from "../src/modules/sales/repository/payment.repository.js";
import { createPaymentService } from "../src/modules/sales/service/payment.service.js";
import { addDays, halfYearStartsBetween } from "../src/modules/sales/service/late-interest.js";
import { pdfText } from "./helpers/pdf.js";
import { DEFAULT_POSTING_SETTINGS, POSTING_BASELINE_YEAR, setupPostingBaseline, testSystemService } from "./helpers/services.js";

// Dröjsmålsränta och förseningsersättning (etapp 5 C): Räntefakturering end
// to end — the candidates, Skapa räntefakturor (one invoice per customer,
// UTM rows on 8313/3990, the dubbeldebiteringsspärr), what frees a period,
// the påminnelseavgift after a förseningsersättning, and the PDF texts.

const authRepo = createAuthRepository(db);
const poster = createVerificationPoster({ read: readPostingSettings });
const sentMails: { to: string; attachments?: { filename: string; content: Buffer }[] }[] = [];
const fakeTransportFactory: MailTransportFactory = () => ({
  async sendMail(opts) {
    sentMails.push(opts as (typeof sentMails)[number]);
  },
});
const systemService = createSystemService(createSystemRepository(db));
const mailService = createMailService(createMailRepository(db), systemService, fakeTransportFactory);
const documentPdfService = createDocumentPdfService(systemService);
const invoiceRepo = createInvoiceRepository(db);
// The referensräntor straight from the table — the fetch has its own suite.
const referenceRateReader = {
  async ensureReferenceRates(starts: string[]) {
    return new Map([...(await referenceRatesFor(db, starts))].map(([start, row]) => [start, row.rate] as const));
  },
};
const invoiceService = createInvoiceService(
  invoiceRepo,
  mailService,
  documentPdfService,
  poster,
  undefined,
  undefined,
  undefined,
  null,
  referenceRateReader
);
const paymentService = createPaymentService(createPaymentRepository(db), poster);
const lateInterestService = createLateInterestService({
  db,
  invoiceRepo,
  invoices: { issue: (id, userId) => invoiceService.issue(id, userId) },
  referenceRates: referenceRateReader,
});

const TRUNCATE = sql`TRUNCATE late_interest_charges, reference_rates, posting_rules, verification_rows, verifications, verification_counters, verification_series, accounting_periods, fiscal_years, accounts, customer_payment_rows, customer_payments, invoice_reminders, invoice_documents, invoice_rows, invoices, customers, email_log, audit_log, users CASCADE`;

const Y = POSTING_BASELINE_YEAR;
const TODAY = new Date().toLocaleDateString("sv-SE");
// Fixed dates inside the baseline fiscal year: due 1 September, asOf 20 October.
const DUE = `${Y}-09-01`;
const AS_OF = `${Y}-10-20`;

const LATE_INTEREST_SETTINGS = {
  ...DEFAULT_POSTING_SETTINGS,
  paymentTolerance: 5,
  reminderFee: 60,
  lateInterestEnabled: true,
  lateInterestMargin: 8,
  lateInterestMinAmount: 100,
  lateFeeEnabled: true,
  postingLateInterest: "8313",
  postingLateFee: "3990",
  smtpHost: "smtp.test.local",
  smtpFromEmail: "erp@test.local",
};

beforeEach(async () => {
  await db.execute(TRUNCATE);
  await setupPostingBaseline();
  sentMails.length = 0;
  await testSystemService.updateSettings(LATE_INTEREST_SETTINGS);
  // Referensränta 2 % / 4 % for the year's two half-years (and the ones a
  // "today"-relative period may touch).
  const starts = new Set([`${Y}-01-01`, `${Y}-07-01`, ...halfYearStartsBetween(addDays(TODAY, -60), TODAY)]);
  await db.insert(referenceRates).values([...starts].map((validFrom) => ({ validFrom, rate: validFrom.endsWith("-07-01") ? "4" : "2", source: "riksbank" })));
});

afterAll(async () => {
  await db.execute(TRUNCATE);
  await testSystemService.updateSettings({ ...LATE_INTEREST_SETTINGS, lateInterestEnabled: false, lateFeeEnabled: false });
});

async function makeUser() {
  return authRepo.create({ email: `li-${crypto.randomUUID()}@example.com`, passwordHash: "x", name: "Ränta", role: "admin" });
}

async function makeCustomer(name = "Kund AB", extra: Partial<typeof customers.$inferInsert> = {}) {
  const [row] = await db
    .insert(customers)
    .values({ name, customerNumber: `TEST-${crypto.randomUUID()}`, active: true, invoiceAddress: "Gatan 1", ...extra })
    .returning();
  return row!;
}

// An issued invoice of exactly `gross` (net + 25 %), due on `dueDate`.
async function makeInvoice(customerId: string, userId: string, gross: number, dueDate = DUE, currency = "SEK") {
  const draft = await invoiceService.create(
    { customerId, currency, ...(currency === "SEK" ? {} : { exchangeRate: 11 }), rows: [{ description: "Leverans", quantity: 1, unitPrice: gross / 1.25, vatRate: 25 }] },
    userId
  );
  const issued = (await invoiceService.issue(draft!.id, userId))!;
  await db.update(invoices).set({ dueDate }).where(eq(invoices.id, issued.id));
  return issued;
}

async function pay(customerId: string, invoiceId: string, amount: number, paymentDate: string, userId: string) {
  return paymentService.create(
    { customerId, paymentDate, bankAccountNumber: "1930", amount, rows: [{ invoiceId, appliedAmount: amount }] },
    userId
  );
}

async function verificationRowsOf(verificationId: string) {
  const rows = await db
    .select({ number: accounts.number, debit: verificationRows.debit, credit: verificationRows.credit })
    .from(verificationRows)
    .innerJoin(accounts, eq(accounts.id, verificationRows.accountId))
    .where(eq(verificationRows.verificationId, verificationId))
    .orderBy(asc(accounts.number));
  const [header] = await db
    .select({ seriesCode: verificationSeries.code })
    .from(verifications)
    .innerJoin(verificationSeries, eq(verificationSeries.id, verifications.seriesId))
    .where(eq(verifications.id, verificationId));
  return { seriesCode: header!.seriesCode, rows: rows.map((r) => ({ number: r.number, debit: Number(r.debit), credit: Number(r.credit) })) };
}

const candidates = (query: { asOf?: string; customerId?: string; includeUnpaid?: boolean } = {}) =>
  lateInterestService.listCandidates({ asOf: AS_OF, includeUnpaid: true, ...query });

describe("Räntefakturering — kandidaterna", () => {
  it("lists a late-paid invoice with the contract's 19 days at 12,00 % and the förseningsersättning", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    const invoice = await makeInvoice(customer.id, user.id, 10000);
    await pay(customer.id, invoice.id, 10000, `${Y}-09-20`, user.id);

    const { rows, rateMissing, asOf } = await candidates();
    expect(asOf).toBe(AS_OF);
    expect(rateMissing).toEqual([]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      customerName: "Kund AB",
      privatePerson: false,
      dueDate: DUE,
      paidDate: `${Y}-09-20`,
      principal: 10000,
      openAmount: 0,
      fromDate: `${Y}-09-02`,
      toDate: `${Y}-09-20`,
      days: 19,
      rate: 12,
      rates: [12],
      interest: 62.47,
      fee: 450,
      belowMinimum: true,
      rateMissing: false,
    });
    expect(rows[0]!.segments).toEqual([{ from: `${Y}-09-02`, to: `${Y}-09-20`, days: 19, rate: 12, amount: 62.47 }]);
  });

  it("runs an unpaid invoice through asOf, and leaves it out without Ta med obetalda fakturor", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    const invoice = await makeInvoice(customer.id, user.id, 36500);
    await pay(customer.id, invoice.id, 18250, `${Y}-09-11`, user.id);

    const { rows } = await candidates();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ invoiceId: invoice.id, paidDate: null, openAmount: 18250, fromDate: `${Y}-09-02`, toDate: AS_OF, days: 49, fee: 450 });
    // 10 days on 36 500 + 39 days on 18 250, all at 12 %.
    expect(rows[0]!.interest).toBe(120 + 234);
    expect(rows[0]!.belowMinimum).toBe(false);

    expect((await candidates({ includeUnpaid: false })).rows).toEqual([]);
  });

  it("lists nothing for an invoice paid in time, a customer without Dröjsmålsränta, a foreign currency, or a räntefaktura", async () => {
    const user = await makeUser();
    const onTime = await makeCustomer("I tid AB");
    const paidOnDue = await makeInvoice(onTime.id, user.id, 1000);
    await pay(onTime.id, paidOnDue.id, 1000, DUE, user.id);
    const noInterest = await makeCustomer("Utan ränta AB", { lateInterest: false });
    await makeInvoice(noInterest.id, user.id, 1000);
    const eur = await makeCustomer("Euro AB", { currency: "EUR" });
    await makeInvoice(eur.id, user.id, 1000, DUE, "EUR");

    expect((await candidates()).rows).toEqual([]);

    // A räntefaktura (an interest invoice, overdue itself) is never a candidate.
    const late = await makeCustomer("Sen AB");
    const source = await makeInvoice(late.id, user.id, 36500);
    const { created } = await lateInterestService.createInvoices(
      { asOf: AS_OF, issue: true, items: [{ invoiceId: source.id, fromDate: `${Y}-09-02`, includeInterest: true, includeFee: false, fee: 0 }] },
      user.id
    );
    await db.update(invoices).set({ dueDate: DUE }).where(eq(invoices.id, created[0]!.invoiceId));
    const { rows } = await candidates();
    expect(rows.map((r) => r.invoiceId)).toEqual([source.id]);
  });

  it("offers no förseningsersättning to a privatperson, a customer without it, or when Debitera förseningsersättning is off", async () => {
    const user = await makeUser();
    const person = await makeCustomer("Anna", { privatePerson: true });
    await makeInvoice(person.id, user.id, 36500);
    const noFee = await makeCustomer("Utan ersättning AB", { lateFee: false });
    await makeInvoice(noFee.id, user.id, 36500);

    const { rows } = await candidates();
    expect(rows.map((r) => [r.customerName, r.fee, r.privatePerson])).toEqual([
      ["Anna", 0, true],
      ["Utan ersättning AB", 0, false],
    ]);

    await testSystemService.updateSettings({ lateFeeEnabled: false });
    const company = await makeCustomer("Bolag AB");
    await makeInvoice(company.id, user.id, 36500);
    expect((await candidates({ customerId: company.id })).rows[0]!.fee).toBe(0);
  });

  it("reduces the förseningsersättning by a charged påminnelseavgift and uses the Avtalad räntesats", async () => {
    const user = await makeUser();
    const customer = await makeCustomer("Avtal AB", { lateInterestRate: "15" });
    const invoice = await makeInvoice(customer.id, user.id, 36500);
    await invoiceService.sendReminder(invoice.id, { to: "k@example.com", subject: "P", message: "", withFee: true }, user.id);
    await pay(customer.id, invoice.id, 36500, `${Y}-09-11`, user.id);

    const { rows } = await candidates();
    expect(rows).toHaveLength(1);
    // 10 days at 15 % on 36 500 = 150; fee 450 − 60.
    expect(rows[0]).toMatchObject({ days: 10, rate: 15, rates: [15], interest: 150, fee: 390, openAmount: 0 });
  });

  it("reports rateMissing for a half-year without a referensränta and no amount", async () => {
    await db.delete(referenceRates).where(eq(referenceRates.validFrom, `${Y}-07-01`));
    const user = await makeUser();
    const customer = await makeCustomer();
    const invoice = await makeInvoice(customer.id, user.id, 36500);

    const { rows, rateMissing } = await candidates();
    expect(rateMissing).toEqual([`${Y}-07-01`]);
    expect(rows[0]).toMatchObject({ invoiceId: invoice.id, interest: null, rate: null, rates: [], rateMissing: true, fee: 450, belowMinimum: false });
  });

  it("refuses when Debitera dröjsmålsränta is off", async () => {
    await testSystemService.updateSettings({ lateInterestEnabled: false });
    await expect(candidates()).rejects.toBeInstanceOf(LateInterestDisabledError);
    await expect(lateInterestService.createInvoices({ asOf: AS_OF, issue: false, items: [] }, "x")).rejects.toBeInstanceOf(
      LateInterestDisabledError
    );
  });
});

describe("Skapa räntefakturor", () => {
  it("creates ONE räntefaktura per customer with UTM rows on 8313/3990, books it without VAT, and records the charges", async () => {
    const user = await makeUser();
    const a = await makeCustomer("Alfa AB");
    const b = await makeCustomer("Beta AB");
    const a1 = await makeInvoice(a.id, user.id, 36500);
    const a2 = await makeInvoice(a.id, user.id, 36500);
    const b1 = await makeInvoice(b.id, user.id, 36500);
    await pay(a.id, a1.id, 36500, `${Y}-09-11`, user.id);
    await pay(a.id, a2.id, 36500, `${Y}-09-21`, user.id);

    const list = await candidates();
    const result = await lateInterestService.createInvoices(
      {
        asOf: AS_OF,
        issue: true,
        items: list.rows.map((row) => ({ invoiceId: row.invoiceId, fromDate: row.fromDate, includeInterest: true, includeFee: true, fee: row.fee })),
      },
      user.id
    );
    expect(result.skipped).toEqual([]);
    expect(result.issueFailed).toEqual([]);
    expect(result.created.map((c) => [c.customerName, c.status, c.total])).toEqual([
      // 120 + 240 interest + 2 × 450
      ["Alfa AB", "issued", 1260],
      // 49 days on 36 500 at 12 % = 588 + 450
      ["Beta AB", "issued", 1038],
    ]);
    expect(result.created.every((c) => c.invoiceNumber?.startsWith("FA-"))).toBe(true);

    const alfa = (await invoiceService.getInvoice(result.created[0]!.invoiceId))!;
    expect(alfa.note).toBe("Räntefaktura");
    expect(alfa.currency).toBe("SEK");
    expect(alfa.isLateInterestInvoice).toBe(true);
    expect(alfa.rows.map((r) => [r.description, Number(r.lineAmount), Number(r.vatAmount), r.vatCode.code, r.revenueAccount])).toEqual([
      [`Dröjsmålsränta ${a1.invoiceNumber}, ${Y}-09-02–${Y}-09-11 (10 dagar, 12,00 %)`, 120, 0, "UTM", "8313"],
      [`Förseningsersättning ${a1.invoiceNumber}`, 450, 0, "UTM", "3990"],
      [`Dröjsmålsränta ${a2.invoiceNumber}, ${Y}-09-02–${Y}-09-21 (20 dagar, 12,00 %)`, 240, 0, "UTM", "8313"],
      [`Förseningsersättning ${a2.invoiceNumber}`, 450, 0, "UTM", "3990"],
    ]);
    const verification = await verificationRowsOf(alfa.verificationId!);
    expect(verification.seriesCode).toBe("F");
    expect(verification.rows).toEqual([
      { number: "1510", debit: 1260, credit: 0 },
      { number: "3990", debit: 0, credit: 900 },
      { number: "8313", debit: 0, credit: 360 },
    ]);

    // The source invoice's card shows its charges, active.
    const source = (await invoiceService.getInvoice(a1.id))!;
    expect(source.isLateInterestInvoice).toBe(false);
    expect(source.lateInterestCharges.map((c) => [c.fromDate, c.toDate, c.days, c.amount, c.fee, c.chargeInvoiceNumber, c.active])).toEqual([
      [`${Y}-09-02`, `${Y}-09-11`, 10, 120, 0, alfa.invoiceNumber, true],
      [null, null, 0, 0, 450, alfa.invoiceNumber, true],
    ]);
    expect(await db.select().from(lateInterestCharges)).toHaveLength(6);
    expect(result.created[1]!.invoiceId).not.toBe(alfa.id);
    expect((await invoiceService.getInvoice(result.created[1]!.invoiceId))!.rows.map((r) => r.description)).toEqual([
      `Dröjsmålsränta ${b1.invoiceNumber}, ${Y}-09-02–${AS_OF} (49 dagar, 12,00 %)`,
      `Förseningsersättning ${b1.invoiceNumber}`,
    ]);

    // The second run has nothing left: the period is charged, the fee too.
    expect((await candidates()).rows).toEqual([]);
  });

  it("drops the interest under Minsta räntebelopp but keeps the fee, and skips a customer with nothing left", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    const invoice = await makeInvoice(customer.id, user.id, 10000);
    await pay(customer.id, invoice.id, 10000, `${Y}-09-20`, user.id);
    const [row] = (await candidates()).rows;
    expect(row!.interest).toBe(62.47);

    const withFee = await lateInterestService.createInvoices(
      { asOf: AS_OF, issue: false, items: [{ invoiceId: invoice.id, fromDate: row!.fromDate, includeInterest: true, includeFee: true, fee: 450 }] },
      user.id
    );
    expect(withFee.created).toHaveLength(1);
    expect(withFee.created[0]).toMatchObject({ status: "draft", invoiceNumber: null, total: 450 });
    const draft = (await invoiceService.getInvoice(withFee.created[0]!.invoiceId))!;
    expect(draft.rows.map((r) => r.description)).toEqual([`Förseningsersättning ${invoice.invoiceNumber}`]);

    // Interest only, below the minimum ⇒ nothing to invoice.
    const second = await makeInvoice(customer.id, user.id, 10000);
    await pay(customer.id, second.id, 10000, `${Y}-09-20`, user.id);
    const onlyInterest = await lateInterestService.createInvoices(
      { asOf: AS_OF, issue: false, items: [{ invoiceId: second.id, fromDate: `${Y}-09-02`, includeInterest: true, includeFee: false, fee: 0 }] },
      user.id
    );
    expect(onlyInterest.created).toEqual([]);
    expect(onlyInterest.skipped).toEqual([{ customerName: "Kund AB", reason: "Räntan 62,47 kr understiger minsta beloppet 100,00 kr" }]);
  });

  it("never charges a period twice: the next run starts after the last to_date, a stale selection is refused, a concurrent run loses", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    const invoice = await makeInvoice(customer.id, user.id, 36500);
    const first = await lateInterestService.createInvoices(
      { asOf: `${Y}-10-01`, issue: false, items: [{ invoiceId: invoice.id, fromDate: `${Y}-09-02`, includeInterest: true, includeFee: false, fee: 0 }] },
      user.id
    );
    expect(first.created).toHaveLength(1);

    // Later, with the invoice still unpaid: the period resumes on 10-02.
    const { rows } = await candidates();
    expect(rows[0]).toMatchObject({ fromDate: `${Y}-10-02`, toDate: AS_OF, days: 19, fee: 450 });

    // The stale selection (the old period start) is a conflict.
    await expect(
      lateInterestService.createInvoices(
        { asOf: AS_OF, issue: false, items: [{ invoiceId: invoice.id, fromDate: `${Y}-09-02`, includeInterest: true, includeFee: false, fee: 0 }] },
        user.id
      )
    ).rejects.toMatchObject({ name: "LateInterestAlreadyChargedError", invoiceIds: [invoice.id] });
    // A fee that no longer matches is one too.
    await expect(
      lateInterestService.createInvoices(
        { asOf: AS_OF, issue: false, items: [{ invoiceId: invoice.id, fromDate: `${Y}-10-02`, includeInterest: false, includeFee: true, fee: 390 }] },
        user.id
      )
    ).rejects.toBeInstanceOf(LateInterestAlreadyChargedError);

    // Two identical runs at once: exactly one creates, the other gets 409.
    const run = () =>
      lateInterestService.createInvoices(
        { asOf: AS_OF, issue: false, items: [{ invoiceId: invoice.id, fromDate: `${Y}-10-02`, includeInterest: true, includeFee: true, fee: 450 }] },
        user.id
      );
    const outcomes = await Promise.allSettled([run(), run()]);
    const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
    const rejected = outcomes.filter((o) => o.status === "rejected") as PromiseRejectedResult[];
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(LateInterestAlreadyChargedError);
    expect(await db.select().from(lateInterestCharges)).toHaveLength(3);
    expect((await candidates()).rows).toEqual([]);
  });

  it("frees the period and the fee when the räntefaktura is cancelled, its row deleted or it is fully credited — not when partially credited", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    const invoice = await makeInvoice(customer.id, user.id, 36500);
    const items = [{ invoiceId: invoice.id, fromDate: `${Y}-09-02`, includeInterest: true, includeFee: true, fee: 450 }];

    // Cancelled draft.
    const draft = (await lateInterestService.createInvoices({ asOf: AS_OF, issue: false, items }, user.id)).created[0]!;
    expect((await candidates()).rows).toEqual([]);
    await invoiceService.cancel(draft.invoiceId, user.id);
    expect((await invoiceService.getInvoice(invoice.id))!.lateInterestCharges.map((c) => c.active)).toEqual([false, false]);
    expect((await candidates()).rows[0]).toMatchObject({ fromDate: `${Y}-09-02`, fee: 450 });

    // Deleted row on a draft: the charge is gone with it (cascade).
    const second = (await lateInterestService.createInvoices({ asOf: AS_OF, issue: false, items }, user.id)).created[0]!;
    const secondRows = (await invoiceService.getInvoice(second.invoiceId))!.rows;
    await invoiceService.deleteRow(second.invoiceId, secondRows.find((r) => r.description.startsWith("Förseningsersättning"))!.id, user.id);
    const charges = (await invoiceService.getInvoice(invoice.id))!.lateInterestCharges.filter((c) => c.active);
    expect(charges.map((c) => c.fee)).toEqual([0]);
    expect((await candidates()).rows[0]).toMatchObject({ interest: 0, days: 0, fee: 450 });
    await invoiceService.cancel(second.invoiceId, user.id);

    // Issued, then partially credited: still active.
    const issued = (await lateInterestService.createInvoices({ asOf: AS_OF, issue: true, items }, user.id)).created[0]!;
    expect(issued.status).toBe("issued");
    const partial = await invoiceService.createCredit(issued.invoiceId, { rows: [{ description: "Delkredit", quantity: 1, unitPrice: 100, vatRate: 0 }] }, user.id);
    await invoiceService.issue(partial!.id, user.id);
    expect((await candidates()).rows).toEqual([]);
    expect((await invoiceService.getInvoice(invoice.id))!.lateInterestCharges.filter((c) => c.active)).toHaveLength(2);

    // Fully credited: inactive, period and fee free again. The credit note
    // copies the rows' revenue accounts.
    const full = await invoiceService.createCredit(issued.invoiceId, {}, user.id);
    expect((await invoiceService.getInvoice(full!.id))!.rows.map((r) => r.revenueAccount)).toEqual(["8313", "3990"]);
    await invoiceService.issue(full!.id, user.id);
    const afterCredit = (await invoiceService.getInvoice(invoice.id))!.lateInterestCharges;
    expect(afterCredit.filter((c) => c.chargeInvoiceId === issued.invoiceId).map((c) => c.active)).toEqual([false, false]);
    expect((await candidates()).rows[0]).toMatchObject({ fromDate: `${Y}-09-02`, fee: 450 });
  });

  it("refuses a påminnelseavgift once an active förseningsersättning is charged, and the reminder PDF carries the texts", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    const dueDate = addDays(TODAY, -30);
    const invoice = await makeInvoice(customer.id, user.id, 36500, dueDate);
    const mail = { to: "k@example.com", subject: "P", message: "" };

    // Before any charge: the reminder PDF informs about the accrued interest.
    const preview = await invoiceService.renderReminderPdf(invoice.id, false);
    const text = await pdfText(preview.content);
    expect(text).toContain("Vid betalning efter förfallodagen debiteras dröjsmålsränta enligt räntelagen.");
    expect(text).toMatch(new RegExp(`Upplupen dröjsmålsränta t.o.m. ${TODAY}: \\d`));

    await lateInterestService.createInvoices(
      { asOf: TODAY, issue: true, items: [{ invoiceId: invoice.id, fromDate: addDays(dueDate, 1), includeInterest: false, includeFee: true, fee: 450 }] },
      user.id
    );
    await expect(invoiceService.sendReminder(invoice.id, { ...mail, withFee: true }, user.id)).rejects.toBeInstanceOf(ReminderFeeAfterLateFeeError);
    expect(sentMails).toHaveLength(0);
    // Without a fee it still goes out; the preview drops the fee quietly.
    await invoiceService.sendReminder(invoice.id, { ...mail, withFee: false }, user.id);
    expect(sentMails).toHaveLength(1);
    const withFee = await pdfText((await invoiceService.renderReminderPdf(invoice.id, true)).content);
    expect(withFee).not.toContain("Påminnelseavgift");
  });

  it("prints the terms text on the invoice PDF — not on a credit note, not on a räntefaktura, not when the routine or the customer is off", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    const invoice = await makeInvoice(customer.id, user.id, 36500);
    const TERMS = "Vid betalning efter förfallodagen debiteras dröjsmålsränta enligt räntelagen.";
    expect(await pdfText((await invoiceService.renderPdf(invoice.id)).content)).toContain(TERMS);

    const credit = await invoiceService.createCredit(invoice.id, {}, user.id);
    await invoiceService.issue(credit!.id, user.id);
    expect(await pdfText((await invoiceService.renderPdf(credit!.id)).content)).not.toContain(TERMS);

    const run = await lateInterestService.createInvoices(
      { asOf: AS_OF, issue: true, items: [{ invoiceId: invoice.id, fromDate: `${Y}-09-02`, includeInterest: true, includeFee: false, fee: 0 }] },
      user.id
    );
    expect(await pdfText((await invoiceService.renderPdf(run.created[0]!.invoiceId)).content)).not.toContain(TERMS);

    const quiet = await makeCustomer("Tyst AB", { lateInterest: false });
    const quietInvoice = await makeInvoice(quiet.id, user.id, 1000);
    expect(await pdfText((await invoiceService.renderPdf(quietInvoice.id)).content)).not.toContain(TERMS);

    await testSystemService.updateSettings({ lateInterestEnabled: false });
    const off = await makeInvoice(customer.id, user.id, 1000);
    expect(await pdfText((await invoiceService.renderPdf(off.id)).content)).not.toContain(TERMS);
  });

  it("keeps the row's revenue account through a PATCH and refuses Utfärda when the account is inactive", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    const invoice = await makeInvoice(customer.id, user.id, 36500);
    const run = await lateInterestService.createInvoices(
      { asOf: AS_OF, issue: false, items: [{ invoiceId: invoice.id, fromDate: `${Y}-09-02`, includeInterest: true, includeFee: false, fee: 0 }] },
      user.id
    );
    const draft = (await invoiceService.getInvoice(run.created[0]!.invoiceId))!;
    const row = draft.rows[0]!;
    const patched = await invoiceService.updateRow(draft.id, row.id, { description: "Ränta" }, user.id);
    expect(patched!.revenueAccount).toBe("8313");
    expect(Number(patched!.lineAmount)).toBe(588);

    await db.update(accounts).set({ active: false }).where(eq(accounts.number, "8313"));
    await expect(invoiceService.issue(draft.id, user.id)).rejects.toMatchObject({ name: "MissingPostingAccountError" });
    expect((await db.select({ status: invoices.status }).from(invoices).where(eq(invoices.id, draft.id)))[0]!.status).toBe("draft");
    expect((await db.select().from(invoiceRows).where(eq(invoiceRows.invoiceId, draft.id)))[0]!.revenueAccount).toBe("8313");
  });
});

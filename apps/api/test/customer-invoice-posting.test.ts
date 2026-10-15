import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { asc, eq, sql } from "drizzle-orm";
import {
  accounts,
  articleGroups,
  customers,
  db,
  invoiceRows,
  invoices,
  verificationRows,
  verifications,
  verificationSeries,
} from "@navet/db";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { AccountingPeriodLockedError } from "../src/modules/economy/service/accounting-period-lock.js";
import {
  MissingPostingAccountError,
  UnknownVatRateError,
  createVerificationPoster,
} from "../src/modules/economy/service/verification-poster.js";
import { readPostingSettings } from "../src/modules/system/service/posting-settings.js";
import { createInvoiceRepository } from "../src/modules/sales/repository/invoice.repository.js";
import { createInvoiceService } from "../src/modules/sales/service/invoice.service.js";
import {
  DEFAULT_POSTING_SETTINGS,
  POSTING_BASELINE_YEAR,
  setupPostingBaseline,
  testEconomyService,
  testSystemService,
} from "./helpers/services.js";

// B2: issuing a customer invoice books an F verification inside the SAME
// transaction as the FA-number allocation. This suite drives the real wiring
// end to end — the poster is constructed on the real readPostingSettings leaf
// (exactly as app.ts does), so the settings→accounts→verification path is
// the one production runs.
const articleService = createArticleService(createArticleRepository(db));
const authRepo = createAuthRepository(db);
const invoiceRepo = createInvoiceRepository(db);
const poster = createVerificationPoster({ read: readPostingSettings });

// This suite never mails or prints — the collaborators only exist because
// the service constructor takes them.
const mailStub = {
  async sendMail() {
    return null;
  },
};
const pdfStub = {
  async render() {
    return Buffer.alloc(0);
  },
  // Never called here — only satisfies the renderer interface the invoice
  // service takes (the reminder flow has its own suite).
  async renderPaymentReminder() {
    return Buffer.alloc(0);
  },
};
const invoiceService = createInvoiceService(invoiceRepo, mailStub, pdfStub, poster);

// number_series is NEVER truncated (shared, sequence-like base data) — every
// assertion below is therefore relative to the FA number the previous issue
// produced, never an absolute one.
const TRUNCATE = sql`TRUNCATE posting_rules, verification_rows, verifications, verification_counters, verification_series, accounting_periods, fiscal_years, accounts, article_groups, invoice_rows, invoices, customers, articles, audit_log, users CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
  await setupPostingBaseline();
  // system_settings survives the truncate (it is shared base data), so the
  // posting roles are reset explicitly — a suite that ran earlier may have
  // pointed one of them somewhere else.
  await testSystemService.updateSettings({ ...DEFAULT_POSTING_SETTINGS });
});

afterAll(async () => {
  await db.execute(TRUNCATE);
  await testSystemService.updateSettings({ ...DEFAULT_POSTING_SETTINGS });
});

async function makeUser() {
  return authRepo.create({
    email: `posting-${crypto.randomUUID()}@example.com`,
    passwordHash: "not-a-real-hash",
    name: "Fakturerare",
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

async function makeArticleGroup(code: string, name: string) {
  const [row] = await db.insert(articleGroups).values({ code, name }).returning();
  return row!;
}

async function makeArticle(opts: { groupId?: string; vatRate?: number } = {}) {
  return articleService.createArticle({
    articleNumber: `ART-POST-${crypto.randomUUID()}`,
    name: "Konteringsartikel",
    type: "manufactured",
    active: true,
    ...(opts.groupId !== undefined ? { groupId: opts.groupId } : {}),
    ...(opts.vatRate !== undefined ? { vatRate: opts.vatRate } : {}),
  });
}

type RowInput = {
  description: string;
  articleId?: string;
  quantity: number;
  unitPrice: number;
  vatRate?: number;
  discountPercent?: number;
};

async function makeDraft(customerId: string, rows: RowInput[], userId: string) {
  const draft = await invoiceService.create({ customerId, rows }, userId);
  return draft!;
}

async function accountId(number: string) {
  const [row] = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.number, number));
  return row!.id;
}

// The verification a given invoice booked, with its rows joined to account
// numbers and ordered the way the poster wrote them.
async function verificationFor(invoiceId: string) {
  const [invoice] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
  if (!invoice?.verificationId) return null;
  const [verification] = await db
    .select({
      id: verifications.id,
      seriesCode: verificationSeries.code,
      verificationNumber: verifications.verificationNumber,
      date: verifications.date,
      description: verifications.description,
      status: verifications.status,
      createdBy: verifications.createdBy,
      bookedBy: verifications.bookedBy,
      reversesVerificationId: verifications.reversesVerificationId,
    })
    .from(verifications)
    .innerJoin(verificationSeries, eq(verificationSeries.id, verifications.seriesId))
    .where(eq(verifications.id, invoice.verificationId));
  const rows = await db
    .select({ number: accounts.number, debit: verificationRows.debit, credit: verificationRows.credit })
    .from(verificationRows)
    .innerJoin(accounts, eq(accounts.id, verificationRows.accountId))
    .where(eq(verificationRows.verificationId, invoice.verificationId))
    .orderBy(asc(verificationRows.createdAt));
  return { ...verification!, rows };
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

function numericPart(invoiceNumber: string) {
  return Number(invoiceNumber.replace(/^\D+/, ""));
}

// The period covering today — the invoice date every issue() below stamps.
async function currentPeriod(fiscalYearId: string) {
  const year = await testEconomyService.findFiscalYearById(fiscalYearId);
  const today = new Date().toLocaleDateString("sv-SE");
  return year.periods.find((period) => period.startDate <= today && period.endDate >= today)!;
}

describe("kundfaktura — automatkontering vid utfärdande (B2)", () => {
  it("books an F verification with receivable, revenue and outgoing VAT when the invoice is issued", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    const draft = await makeDraft(
      customer.id,
      [{ description: "Konsultarvode", quantity: 2, unitPrice: 500, vatRate: 25 }],
      user.id
    );

    const issued = await invoiceService.issue(draft.id, user.id);
    expect(issued!.status).toBe("issued");
    expect(issued!.verificationId).not.toBeNull();

    const verification = await verificationFor(draft.id);
    expect(verification!.status).toBe("booked");
    expect(verification!.seriesCode).toBe("F");
    expect(verification!.verificationNumber).not.toBeNull();
    expect(verification!.date).toBe(issued!.invoiceDate);
    expect(verification!.description).toBe(`Kundfaktura ${issued!.invoiceNumber} — Kund AB`);
    expect(verification!.createdBy).toBe(user.id);
    expect(verification!.bookedBy).toBe(user.id);
    expect(verification!.reversesVerificationId).toBeNull();

    expect(verification!.rows).toEqual([
      { number: "1510", debit: "1250.00", credit: "0.00" },
      { number: "3001", debit: "0.00", credit: "1000.00" },
      { number: "2610", debit: "0.00", credit: "250.00" },
    ]);
    expectBalanced(verification!.rows);
  });

  it("uses the article group's posting rule for the revenue account", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    const group = await makeArticleGroup("1000", "Legoarbeten");
    const article = await makeArticle({ groupId: group.id });
    await testEconomyService.createPostingRule({
      articleGroupId: group.id,
      vatRate: 25,
      revenueAccountId: await accountId("3990"),
      costAccountId: null,
    });

    const draft = await makeDraft(
      customer.id,
      [{ description: "Legoarbete", articleId: article.id, quantity: 1, unitPrice: 1000, vatRate: 25 }],
      user.id
    );
    await invoiceService.issue(draft.id, user.id);

    const verification = await verificationFor(draft.id);
    expect(verification!.rows).toEqual([
      { number: "1510", debit: "1250.00", credit: "0.00" },
      { number: "3990", debit: "0.00", credit: "1000.00" },
      { number: "2610", debit: "0.00", credit: "250.00" },
    ]);
    expectBalanced(verification!.rows);
  });

  it("splits mixed VAT rates per rate and writes no VAT row for a 0 % row", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    const draft = await makeDraft(
      customer.id,
      [
        { description: "25 %", quantity: 1, unitPrice: 400, vatRate: 25 }, // 400 + 100
        { description: "12 %", quantity: 1, unitPrice: 200, vatRate: 12 }, // 200 + 24
        { description: "6 %", quantity: 1, unitPrice: 100, vatRate: 6 }, // 100 + 6
        { description: "0 %", quantity: 1, unitPrice: 50, vatRate: 0 }, // 50 + 0
      ],
      user.id
    );
    await invoiceService.issue(draft.id, user.id);

    const verification = await verificationFor(draft.id);
    expect(verification!.rows).toEqual([
      { number: "1510", debit: "880.00", credit: "0.00" },
      { number: "3001", debit: "0.00", credit: "400.00" },
      { number: "2610", debit: "0.00", credit: "100.00" },
      { number: "3002", debit: "0.00", credit: "200.00" },
      { number: "2620", debit: "0.00", credit: "24.00" },
      { number: "3003", debit: "0.00", credit: "100.00" },
      { number: "2630", debit: "0.00", credit: "6.00" },
      { number: "3004", debit: "0.00", credit: "50.00" },
    ]);
    expectBalanced(verification!.rows);
  });

  it("applies each row's discountPercent before splitting per VAT rate", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    const draft = await makeDraft(
      customer.id,
      [
        { description: "25 %, 10 % rabatt", quantity: 1, unitPrice: 400, vatRate: 25, discountPercent: 10 }, // 360 + 90
        { description: "12 %, 20 % rabatt", quantity: 1, unitPrice: 200, vatRate: 12, discountPercent: 20 }, // 160 + 19.20
        { description: "6 %, ingen rabatt", quantity: 1, unitPrice: 100, vatRate: 6 }, // 100 + 6
        { description: "0 %, 50 % rabatt", quantity: 1, unitPrice: 50, vatRate: 0, discountPercent: 50 }, // 25 + 0
      ],
      user.id
    );
    await invoiceService.issue(draft.id, user.id);

    const verification = await verificationFor(draft.id);
    expect(verification!.rows).toEqual([
      { number: "1510", debit: "760.20", credit: "0.00" },
      { number: "3001", debit: "0.00", credit: "360.00" },
      { number: "2610", debit: "0.00", credit: "90.00" },
      { number: "3002", debit: "0.00", credit: "160.00" },
      { number: "2620", debit: "0.00", credit: "19.20" },
      { number: "3003", debit: "0.00", credit: "100.00" },
      { number: "2630", debit: "0.00", credit: "6.00" },
      { number: "3004", debit: "0.00", credit: "25.00" },
    ]);
    expectBalanced(verification!.rows);
  });

  it("mirrors the posting for a credit note with a discounted row (sign flips, discount stays baked into the amount)", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    const draft = await makeDraft(
      customer.id,
      [{ description: "Rabatterad vara", quantity: 10, unitPrice: 100, vatRate: 25, discountPercent: 10 }],
      user.id
    );
    const issued = await invoiceService.issue(draft.id, user.id);

    // Default mirror prefill (no input.rows override) must carry the source
    // row's own discountPercent along with quantity/unitPrice — otherwise
    // the credit note would credit back the undiscounted amount.
    const credit = await invoiceService.createCredit(issued!.id, {}, user.id);
    await invoiceService.issue(credit!.id, user.id);

    const verification = await verificationFor(credit!.id);
    expect(verification!.rows).toEqual([
      { number: "1510", debit: "0.00", credit: "1125.00" },
      { number: "3001", debit: "900.00", credit: "0.00" },
      { number: "2610", debit: "225.00", credit: "0.00" },
    ]);
    expectBalanced(verification!.rows);
  });

  it("mirrors the posting for a credit note", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    const draft = await makeDraft(
      customer.id,
      [{ description: "Konsultarvode", quantity: 2, unitPrice: 500, vatRate: 25 }],
      user.id
    );
    const issued = await invoiceService.issue(draft.id, user.id);

    const credit = await invoiceService.createCredit(issued!.id, {}, user.id);
    const issuedCredit = await invoiceService.issue(credit!.id, user.id);

    const verification = await verificationFor(credit!.id);
    expect(verification!.description).toBe(`Kreditfaktura ${issuedCredit!.invoiceNumber} — Kund AB`);
    // Not a reversal — the credit note is its own document.
    expect(verification!.reversesVerificationId).toBeNull();
    expect(verification!.rows).toEqual([
      { number: "1510", debit: "0.00", credit: "1250.00" },
      { number: "3001", debit: "1000.00", credit: "0.00" },
      { number: "2610", debit: "250.00", credit: "0.00" },
    ]);
    expectBalanced(verification!.rows);
  });

  it("blocks the issue when the accounting period is locked, keeps the draft and burns no FA number", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    const { fiscalYearId } = await setupPostingBaseline();

    // A first invoice establishes where the FA series currently stands.
    const before = await makeDraft(customer.id, [{ description: "A", quantity: 1, unitPrice: 100 }], user.id);
    const issuedBefore = await invoiceService.issue(before.id, user.id);

    const period = await currentPeriod(fiscalYearId);
    await testEconomyService.lockPeriod(period.id, user.id);

    const blocked = await makeDraft(customer.id, [{ description: "B", quantity: 1, unitPrice: 100 }], user.id);
    await expect(invoiceService.issue(blocked.id, user.id)).rejects.toThrow(AccountingPeriodLockedError);

    const stillDraft = await invoiceService.getInvoice(blocked.id);
    expect(stillDraft!.status).toBe("draft");
    expect(stillDraft!.invoiceNumber).toBeNull();
    expect(stillDraft!.verificationId).toBeNull();

    await testEconomyService.unlockPeriod(period.id, "Rättelse", user.id);
    const issuedAfter = await invoiceService.issue(blocked.id, user.id);
    // The blocked attempt rolled its number allocation back, so the series
    // continues unbroken.
    expect(numericPart(issuedAfter!.invoiceNumber!)).toBe(numericPart(issuedBefore!.invoiceNumber!) + 1);
  });

  it("refuses to issue an invoice carrying an unknown VAT rate", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    const draft = await makeDraft(customer.id, [{ description: "Udda sats", quantity: 1, unitPrice: 100 }], user.id);
    // vatRateSchema only admits 25/12/6/0, so an 8 % row can only come from
    // hand-edited/legacy data — written directly here.
    await db.update(invoiceRows).set({ vatRate: "8.00" }).where(eq(invoiceRows.invoiceId, draft.id));

    await expect(invoiceService.issue(draft.id, user.id)).rejects.toThrow(UnknownVatRateError);
    const stillDraft = await invoiceService.getInvoice(draft.id);
    expect(stillDraft!.status).toBe("draft");
    expect(stillDraft!.invoiceNumber).toBeNull();
  });

  it("refuses to issue when a posting account in the settings is missing from the chart of accounts", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    await testSystemService.updateSettings({ postingRevenue25: "9999" });

    const draft = await makeDraft(customer.id, [{ description: "A", quantity: 1, unitPrice: 100 }], user.id);
    await expect(invoiceService.issue(draft.id, user.id)).rejects.toThrow(MissingPostingAccountError);

    const stillDraft = await invoiceService.getInvoice(draft.id);
    expect(stillDraft!.status).toBe("draft");
    expect(stillDraft!.invoiceNumber).toBeNull();
    expect(stillDraft!.verificationId).toBeNull();
  });

  it("two concurrent issues produce exactly one verification and one FA number", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    const draft = await makeDraft(customer.id, [{ description: "A", quantity: 1, unitPrice: 100 }], user.id);

    const results = await Promise.allSettled([
      invoiceService.issue(draft.id, user.id),
      invoiceService.issue(draft.id, user.id),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);

    const booked = await db.select().from(verifications);
    expect(booked).toHaveLength(1);

    const issued = await invoiceService.getInvoice(draft.id);
    expect(issued!.status).toBe("issued");
    expect(issued!.verificationId).toBe(booked[0]!.id);

    // The loser's rollback returned both its FA number and its verifikatnummer.
    const next = await makeDraft(customer.id, [{ description: "B", quantity: 1, unitPrice: 100 }], user.id);
    const issuedNext = await invoiceService.issue(next.id, user.id);
    expect(numericPart(issuedNext!.invoiceNumber!)).toBe(numericPart(issued!.invoiceNumber!) + 1);
    const nextVerification = await verificationFor(next.id);
    expect(nextVerification!.verificationNumber).toBe(booked[0]!.verificationNumber! + 1);
  });

  it("exposes the verification's display number on the detail GET and in the list", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    const draft = await makeDraft(customer.id, [{ description: "A", quantity: 1, unitPrice: 100 }], user.id);
    const issued = await invoiceService.issue(draft.id, user.id);

    const verification = await verificationFor(draft.id);
    const expected = `F-${POSTING_BASELINE_YEAR}-${verification!.verificationNumber}`;
    expect(issued!.verificationDisplayNumber).toBe(expected);

    const listed = await invoiceService.list({ limit: 50, offset: 0 });
    expect(listed.rows.find((row) => row.id === draft.id)!.verificationDisplayNumber).toBe(expected);
  });

  it("leaves a draft without a verification link", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    const draft = await makeDraft(customer.id, [{ description: "A", quantity: 1, unitPrice: 100 }], user.id);

    const loaded = await invoiceService.getInvoice(draft.id);
    expect(loaded!.verificationId).toBeNull();
    expect(loaded!.verificationDisplayNumber).toBeNull();
  });
});

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, asc, eq, getTableColumns, sql } from "drizzle-orm";
import {
  accounts,
  articleGroups,
  auditLog,
  db,
  fiscalYears,
  verificationCounters,
  verificationRows,
  verifications,
  verificationSeries,
} from "@navet/db";
import { round2 } from "@navet/shared";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createEconomyRepository } from "../src/modules/economy/repository/economy.repository.js";
import { createEconomyService } from "../src/modules/economy/service/economy.service.js";
import { AccountingPeriodLockedError } from "../src/modules/economy/service/accounting-period-lock.js";
import { BAS_STANDARD_ACCOUNTS } from "../src/modules/economy/service/bas-accounts.js";
import {
  MissingPostingAccountError,
  NoAccountingPeriodForPostingError,
  NonSekSupplierInvoiceError,
  PaymentAmountMismatchError,
  PaymentBankAccountConflictError,
  SupplierInvoiceAmountMismatchError,
  UnknownVatRateError,
  ZeroAmountPostingError,
  createVerificationPoster,
} from "../src/modules/economy/service/verification-poster.js";

const repo = createEconomyRepository(db);
const authRepo = createAuthRepository(db);
// The poster writes audit entries through the caller's tx (not through the
// AuditWriter interface), so the service here only exists for the setup
// fixtures (fiscal years, accounts, period locking, posting rules) — a no-op
// audit stub is enough for it, same idiom as economy-posting-rules.test.ts.
const service = createEconomyService(repo, { log: async () => {} });

// article_groups/posting_rules join the B1 list; number_series is NEVER
// truncated (it is shared, sequence-like base data).
const TRUNCATE = sql`TRUNCATE verification_rows, verifications, verification_counters, verification_series, accounting_periods, fiscal_years, accounts, posting_rules, article_groups, audit_log, users CASCADE`;

// The 15 posting accounts as readPostingSettings resolves them (codeSetting
// fallbacks — every field is always a populated 4-digit string). Individual
// tests mutate the live copy to point a role at a missing account.
const DEFAULT_POSTING_SETTINGS = {
  postingAccountsReceivable: "1510",
  postingVatOut25: "2610",
  postingVatOut12: "2620",
  postingVatOut6: "2630",
  postingRevenue25: "3001",
  postingRevenue12: "3002",
  postingRevenue6: "3003",
  postingRevenue0: "3004",
  postingAccountsPayable: "2440",
  postingVatIn: "2640",
  postingDefaultCost: "4010",
  postingBank: "1930",
  postingReminderFeeAccount: "3540",
  postingPaymentWriteOff: "3740",
  // Momsrapport (B5).
  postingVatSettlement: "2650",
};
let postingSettings = { ...DEFAULT_POSTING_SETTINGS };
const poster = createVerificationPoster({ read: async () => postingSettings });

beforeEach(async () => {
  await db.execute(TRUNCATE);
  postingSettings = { ...DEFAULT_POSTING_SETTINGS };
});

afterAll(async () => {
  await db.execute(TRUNCATE);
});

// Same rationale as economy-verifications.test.ts: the fiscal year must cover
// "today" so nothing here goes red when the real calendar rolls over.
const CURRENT_YEAR = new Date().getFullYear();
const FISCAL_YEAR_LABEL = String(CURRENT_YEAR);
const INVOICE_DATE = `${CURRENT_YEAR}-03-15`;
const CANCEL_DATE = `${CURRENT_YEAR}-04-01`;
const PAYMENT_DATE = `${CURRENT_YEAR}-04-10`;
const REMINDER_DATE = `${CURRENT_YEAR}-05-02`;
const UNCOVERED_DATE = `${CURRENT_YEAR - 5}-03-15`;

async function setupPosting() {
  const user = await authRepo.create({
    email: `verification-poster-${crypto.randomUUID()}@example.com`,
    passwordHash: "not-a-real-hash",
    name: "Ekonomiadmin",
    role: "admin",
  });
  await service.createFiscalYear({
    label: FISCAL_YEAR_LABEL,
    startDate: `${CURRENT_YEAR}-01-01`,
    endDate: `${CURRENT_YEAR}-12-31`,
  });
  // The posting settings' defaults are all BAS numbers — seed the standard
  // chart so every role resolves without per-test account fixtures.
  await repo.seedAccounts(BAS_STANDARD_ACCOUNTS);
  return { user };
}

async function makeArticleGroup(code: string, name: string) {
  const [row] = await db.insert(articleGroups).values({ code, name }).returning();
  return row!;
}

async function accountByNumber(number: string) {
  const account = await repo.findAccountByNumber(number);
  return account!;
}

const CUSTOMER_DOC = {
  invoiceNumber: "FA-1001",
  type: "invoice" as const,
  invoiceDate: INVOICE_DATE,
  customerName: "Testkund AB",
};

const SUPPLIER_DOC = {
  registrationNumber: "LF-12",
  invoiceNumber: "INV-9",
  supplierName: "Leverantör AB",
  invoiceDate: INVOICE_DATE,
  currency: "SEK",
  netAmount: 1000,
  vatAmount: 250,
  grossAmount: 1250,
};

// The bank account is chosen per payment (snapshot on the payment row), so it
// travels on the document — not in the posting settings.
const PAYMENT_DOC = {
  paymentNumber: "BET-1",
  paymentDate: PAYMENT_DATE,
  bankAccountNumber: "1930",
  bankAmount: 1250,
  customerName: "Testkund AB",
};

// The supplier side's mirror (B4): the same document shape, but the money
// leaves the bank and settles a leverantörsskuld instead of a fordran.
const SUPPLIER_PAYMENT_DOC = {
  paymentNumber: "UTB-1",
  paymentDate: PAYMENT_DATE,
  bankAccountNumber: "1930",
  bankAmount: 125,
  supplierName: "Leverantör AB",
};

const REMINDER_DOC = {
  invoiceNumber: "FA-1001",
  reminderDate: REMINDER_DATE,
  customerName: "Testkund AB",
  feeAmount: 60,
};

type PostedRow = { account: string; debit: number; credit: number };

async function loadVerification(id: string) {
  const [header] = await db
    .select({ ...getTableColumns(verifications), seriesCode: verificationSeries.code, yearLabel: fiscalYears.label })
    .from(verifications)
    .innerJoin(verificationSeries, eq(verificationSeries.id, verifications.seriesId))
    .innerJoin(fiscalYears, eq(fiscalYears.id, verifications.fiscalYearId))
    .where(eq(verifications.id, id));
  const rows = await db
    .select({ accountNumber: accounts.number, debit: verificationRows.debit, credit: verificationRows.credit })
    .from(verificationRows)
    .innerJoin(accounts, eq(accounts.id, verificationRows.accountId))
    .where(eq(verificationRows.verificationId, id))
    .orderBy(asc(verificationRows.createdAt));
  return {
    ...header!,
    rows: rows.map((row) => ({ account: row.accountNumber, debit: Number(row.debit), credit: Number(row.credit) })),
  };
}

// Every produced verification must satisfy the BFL invariants the manual
// booking path also enforces: at least two rows, debit total = credit total,
// and debit XOR credit per row.
function expectBalanced(rows: PostedRow[]) {
  expect(rows.length).toBeGreaterThanOrEqual(2);
  for (const row of rows) {
    expect(row.debit).toBeGreaterThanOrEqual(0);
    expect(row.credit).toBeGreaterThanOrEqual(0);
    expect((row.debit === 0) !== (row.credit === 0)).toBe(true);
  }
  const totalDebit = round2(rows.reduce((sum, row) => sum + row.debit, 0));
  const totalCredit = round2(rows.reduce((sum, row) => sum + row.credit, 0));
  expect(totalDebit).toBe(totalCredit);
}

function byAccount(rows: PostedRow[]) {
  return Object.fromEntries(rows.map((row) => [row.account, { debit: row.debit, credit: row.credit }]));
}

describe("verification poster — customer invoice", () => {
  it("posts the default path: AR debit gross, revenue credit, outgoing VAT credit", async () => {
    const { user } = await setupPosting();

    const posted = await db.transaction((tx) =>
      poster.postCustomerInvoice(
        tx,
        CUSTOMER_DOC,
        [{ articleGroupId: null, lineAmount: 1000, vatAmount: 250, vatRate: 25 }],
        user.id
      )
    );

    expect(posted.displayNumber).toBe(`F-${FISCAL_YEAR_LABEL}-1`);
    const verification = await loadVerification(posted.verificationId);
    expect(verification.status).toBe("booked");
    expect(verification.verificationNumber).toBe(1);
    expect(verification.seriesCode).toBe("F");
    expect(verification.date).toBe(INVOICE_DATE);
    expect(verification.description).toBe("Kundfaktura FA-1001 — Testkund AB");
    expect(verification.createdBy).toBe(user.id);
    expect(verification.bookedBy).toBe(user.id);
    expect(verification.bookedAt).not.toBeNull();
    expect(verification.reversesVerificationId).toBeNull();

    expectBalanced(verification.rows);
    expect(verification.rows).toEqual([
      { account: "1510", debit: 1250, credit: 0 },
      { account: "3001", debit: 0, credit: 1000 },
      { account: "2610", debit: 0, credit: 250 },
    ]);
  });

  it("uses the exact (group, rate) posting rule for the revenue account", async () => {
    const { user } = await setupPosting();
    const group = await makeArticleGroup("310", "Diskbänkar");
    const revenue = await accountByNumber("3105");
    await service.createPostingRule({
      articleGroupId: group.id,
      vatRate: 25,
      revenueAccountId: revenue.id,
      costAccountId: null,
    });

    const posted = await db.transaction((tx) =>
      poster.postCustomerInvoice(
        tx,
        CUSTOMER_DOC,
        [{ articleGroupId: group.id, lineAmount: 1000, vatAmount: 250, vatRate: 25 }],
        user.id
      )
    );

    const { rows } = await loadVerification(posted.verificationId);
    expectBalanced(rows);
    expect(byAccount(rows)["3105"]).toEqual({ debit: 0, credit: 1000 });
    expect(byAccount(rows)["3001"]).toBeUndefined();
  });

  it("falls back to the group's catch-all (null rate) rule when no rate-specific rule matches", async () => {
    const { user } = await setupPosting();
    const group = await makeArticleGroup("310", "Diskbänkar");
    const revenue = await accountByNumber("3108");
    await service.createPostingRule({
      articleGroupId: group.id,
      vatRate: null,
      revenueAccountId: revenue.id,
      costAccountId: null,
    });

    const posted = await db.transaction((tx) =>
      poster.postCustomerInvoice(
        tx,
        CUSTOMER_DOC,
        [{ articleGroupId: group.id, lineAmount: 1000, vatAmount: 250, vatRate: 25 }],
        user.id
      )
    );

    const { rows } = await loadVerification(posted.verificationId);
    expectBalanced(rows);
    expect(byAccount(rows)["3108"]).toEqual({ debit: 0, credit: 1000 });
  });

  it("falls through a matching rule that has no revenue account (cost-only rule) to the next step", async () => {
    const { user } = await setupPosting();
    const group = await makeArticleGroup("310", "Diskbänkar");
    const cost = await accountByNumber("4600");
    const catchAllRevenue = await accountByNumber("3108");
    // Rate-specific rule is cost-only -> ignored for revenue; the catch-all
    // rule below is the next step, then the default account.
    await service.createPostingRule({ articleGroupId: group.id, vatRate: 25, revenueAccountId: null, costAccountId: cost.id });
    await service.createPostingRule({
      articleGroupId: group.id,
      vatRate: null,
      revenueAccountId: catchAllRevenue.id,
      costAccountId: null,
    });

    const posted = await db.transaction((tx) =>
      poster.postCustomerInvoice(
        tx,
        CUSTOMER_DOC,
        [{ articleGroupId: group.id, lineAmount: 1000, vatAmount: 250, vatRate: 25 }],
        user.id
      )
    );

    const { rows } = await loadVerification(posted.verificationId);
    expectBalanced(rows);
    expect(byAccount(rows)["3108"]).toEqual({ debit: 0, credit: 1000 });
  });

  it("falls back to the settings default when the group has no usable rule at all", async () => {
    const { user } = await setupPosting();
    const group = await makeArticleGroup("310", "Diskbänkar");
    const cost = await accountByNumber("4600");
    await service.createPostingRule({ articleGroupId: group.id, vatRate: null, revenueAccountId: null, costAccountId: cost.id });

    const posted = await db.transaction((tx) =>
      poster.postCustomerInvoice(
        tx,
        CUSTOMER_DOC,
        [{ articleGroupId: group.id, lineAmount: 1000, vatAmount: 250, vatRate: 25 }],
        user.id
      )
    );

    const { rows } = await loadVerification(posted.verificationId);
    expectBalanced(rows);
    expect(byAccount(rows)["3001"]).toEqual({ debit: 0, credit: 1000 });
  });

  it("splits mixed VAT rates per rate and writes no VAT row for 0 %", async () => {
    const { user } = await setupPosting();

    const posted = await db.transaction((tx) =>
      poster.postCustomerInvoice(
        tx,
        CUSTOMER_DOC,
        [
          { articleGroupId: null, lineAmount: 1000, vatAmount: 250, vatRate: 25 },
          { articleGroupId: null, lineAmount: 500, vatAmount: 60, vatRate: 12 },
          { articleGroupId: null, lineAmount: 200, vatAmount: 12, vatRate: 6 },
          { articleGroupId: null, lineAmount: 100, vatAmount: 0, vatRate: 0 },
        ],
        user.id
      )
    );

    const { rows } = await loadVerification(posted.verificationId);
    expectBalanced(rows);
    const amounts = byAccount(rows);
    expect(amounts["1510"]).toEqual({ debit: 2122, credit: 0 });
    expect(amounts["3001"]).toEqual({ debit: 0, credit: 1000 });
    expect(amounts["2610"]).toEqual({ debit: 0, credit: 250 });
    expect(amounts["3002"]).toEqual({ debit: 0, credit: 500 });
    expect(amounts["2620"]).toEqual({ debit: 0, credit: 60 });
    expect(amounts["3003"]).toEqual({ debit: 0, credit: 200 });
    expect(amounts["2630"]).toEqual({ debit: 0, credit: 12 });
    expect(amounts["3004"]).toEqual({ debit: 0, credit: 100 });
    // 0 % has no VAT account at all — never a zero row, never a 2640 row.
    expect(rows).toHaveLength(8);
  });

  it("merges several invoice rows that resolve to the same account into one verification row", async () => {
    const { user } = await setupPosting();

    const posted = await db.transaction((tx) =>
      poster.postCustomerInvoice(
        tx,
        CUSTOMER_DOC,
        [
          { articleGroupId: null, lineAmount: 1000, vatAmount: 250, vatRate: 25 },
          { articleGroupId: null, lineAmount: 400, vatAmount: 100, vatRate: 25 },
        ],
        user.id
      )
    );

    const { rows } = await loadVerification(posted.verificationId);
    expectBalanced(rows);
    expect(rows).toEqual([
      { account: "1510", debit: 1750, credit: 0 },
      { account: "3001", debit: 0, credit: 1400 },
      { account: "2610", debit: 0, credit: 350 },
    ]);
  });

  it("mirrors every contribution (including AR) for a credit invoice", async () => {
    const { user } = await setupPosting();

    const posted = await db.transaction((tx) =>
      poster.postCustomerInvoice(
        tx,
        { ...CUSTOMER_DOC, invoiceNumber: "FA-1002", type: "credit" },
        [{ articleGroupId: null, lineAmount: 1000, vatAmount: 250, vatRate: 25 }],
        user.id
      )
    );

    const verification = await loadVerification(posted.verificationId);
    expect(verification.description).toBe("Kreditfaktura FA-1002 — Testkund AB");
    // A credit invoice is NOT a reversal — no reversesVerificationId link.
    expect(verification.reversesVerificationId).toBeNull();
    expectBalanced(verification.rows);
    expect(verification.rows).toEqual([
      { account: "1510", debit: 0, credit: 1250 },
      { account: "3001", debit: 1000, credit: 0 },
      { account: "2610", debit: 250, credit: 0 },
    ]);
  });

  it("rejects an unknown VAT rate (UnknownVatRateError)", async () => {
    const { user } = await setupPosting();

    await expect(
      db.transaction((tx) =>
        poster.postCustomerInvoice(
          tx,
          CUSTOMER_DOC,
          [{ articleGroupId: null, lineAmount: 1000, vatAmount: 215, vatRate: 21.5 }],
          user.id
        )
      )
    ).rejects.toBeInstanceOf(UnknownVatRateError);

    expect(await db.select().from(verifications)).toHaveLength(0);
  });

  it("rejects a settings account number that does not exist (MissingPostingAccountError)", async () => {
    const { user } = await setupPosting();
    postingSettings.postingRevenue25 = "9999";

    const error = await db
      .transaction((tx) =>
        poster.postCustomerInvoice(
          tx,
          CUSTOMER_DOC,
          [{ articleGroupId: null, lineAmount: 1000, vatAmount: 250, vatRate: 25 }],
          user.id
        )
      )
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(MissingPostingAccountError);
    expect((error as MissingPostingAccountError).accountNumber).toBe("9999");
    expect(await db.select().from(verifications)).toHaveLength(0);
  });

  it("rejects an inactive posting account (MissingPostingAccountError)", async () => {
    const { user } = await setupPosting();
    const receivable = await accountByNumber("1510");
    await service.updateAccount(receivable.id, { active: false });

    const error = await db
      .transaction((tx) =>
        poster.postCustomerInvoice(
          tx,
          CUSTOMER_DOC,
          [{ articleGroupId: null, lineAmount: 1000, vatAmount: 250, vatRate: 25 }],
          user.id
        )
      )
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(MissingPostingAccountError);
    expect((error as MissingPostingAccountError).accountNumber).toBe("1510");
  });

  it("rejects posting into a locked accounting period (AccountingPeriodLockedError)", async () => {
    const { user } = await setupPosting();
    const period = await repo.findPeriodForDate(INVOICE_DATE);
    await service.lockPeriod(period!.id, user.id);

    await expect(
      db.transaction((tx) =>
        poster.postCustomerInvoice(
          tx,
          CUSTOMER_DOC,
          [{ articleGroupId: null, lineAmount: 1000, vatAmount: 250, vatRate: 25 }],
          user.id
        )
      )
    ).rejects.toBeInstanceOf(AccountingPeriodLockedError);

    expect(await db.select().from(verifications)).toHaveLength(0);
  });

  it("rejects a date no fiscal year covers (NoAccountingPeriodForPostingError)", async () => {
    const { user } = await setupPosting();

    await expect(
      db.transaction((tx) =>
        poster.postCustomerInvoice(
          tx,
          { ...CUSTOMER_DOC, invoiceDate: UNCOVERED_DATE },
          [{ articleGroupId: null, lineAmount: 1000, vatAmount: 250, vatRate: 25 }],
          user.id
        )
      )
    ).rejects.toBeInstanceOf(NoAccountingPeriodForPostingError);
  });

  it("rejects a zero-amount invoice (ZeroAmountPostingError)", async () => {
    const { user } = await setupPosting();

    await expect(
      db.transaction((tx) =>
        poster.postCustomerInvoice(
          tx,
          CUSTOMER_DOC,
          [{ articleGroupId: null, lineAmount: 0, vatAmount: 0, vatRate: 25 }],
          user.id
        )
      )
    ).rejects.toBeInstanceOf(ZeroAmountPostingError);
  });

  it("writes an audit entry through the caller's transaction", async () => {
    const { user } = await setupPosting();

    const posted = await db.transaction((tx) =>
      poster.postCustomerInvoice(
        tx,
        CUSTOMER_DOC,
        [{ articleGroupId: null, lineAmount: 1000, vatAmount: 250, vatRate: 25 }],
        user.id
      )
    );

    const entries = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityType, "verification"), eq(auditLog.action, "booked")));
    expect(entries).toHaveLength(1);
    expect(entries[0]!.entityId).toBe(posted.displayNumber);
    expect(entries[0]!.userId).toBe(user.id);
    expect(entries[0]!.detail).toEqual({ source: "customer_invoice", document: "FA-1001" });
  });
});

describe("verification poster — series and numbering", () => {
  it("lazily creates the F series once and reuses it, numbering consecutively", async () => {
    const { user } = await setupPosting();
    const rows = [{ articleGroupId: null, lineAmount: 1000, vatAmount: 250, vatRate: 25 }];

    const first = await db.transaction((tx) => poster.postCustomerInvoice(tx, CUSTOMER_DOC, rows, user.id));
    const second = await db.transaction((tx) =>
      poster.postCustomerInvoice(tx, { ...CUSTOMER_DOC, invoiceNumber: "FA-1002" }, rows, user.id)
    );

    expect(first.displayNumber).toBe(`F-${FISCAL_YEAR_LABEL}-1`);
    expect(second.displayNumber).toBe(`F-${FISCAL_YEAR_LABEL}-2`);
    const series = await db.select().from(verificationSeries);
    expect(series).toHaveLength(1);
    expect(series[0]!.code).toBe("F");
    expect(series[0]!.name).toBe("Kundfakturor");
  });

  it("creates a separate L series for supplier invoices", async () => {
    const { user } = await setupPosting();

    await db.transaction((tx) =>
      poster.postCustomerInvoice(
        tx,
        CUSTOMER_DOC,
        [{ articleGroupId: null, lineAmount: 1000, vatAmount: 250, vatRate: 25 }],
        user.id
      )
    );
    const supplier = await db.transaction((tx) =>
      poster.postSupplierInvoice(tx, SUPPLIER_DOC, [{ articleGroupId: null, vatRate: 25, lineAmount: 1000 }], user.id)
    );

    // Numbering is per (series, fiscal year) — L starts over at 1.
    expect(supplier.displayNumber).toBe(`L-${FISCAL_YEAR_LABEL}-1`);
    const series = await db.select().from(verificationSeries).orderBy(asc(verificationSeries.code));
    expect(series.map((row) => `${row.code}/${row.name}`)).toEqual(["F/Kundfakturor", "L/Leverantörsfakturor"]);
  });

  it("burns no verification number when the caller's transaction rolls back", async () => {
    const { user } = await setupPosting();
    const rows = [{ articleGroupId: null, lineAmount: 1000, vatAmount: 250, vatRate: 25 }];

    await expect(
      db.transaction(async (tx) => {
        await poster.postCustomerInvoice(tx, CUSTOMER_DOC, rows, user.id);
        throw new Error("consumer failed after posting");
      })
    ).rejects.toThrow("consumer failed after posting");

    // The lazily created series rolls back with everything else.
    expect(await db.select().from(verifications)).toHaveLength(0);
    expect(await db.select().from(verificationSeries)).toHaveLength(0);

    const retried = await db.transaction((tx) => poster.postCustomerInvoice(tx, CUSTOMER_DOC, rows, user.id));
    expect(retried.displayNumber).toBe(`F-${FISCAL_YEAR_LABEL}-1`);
  });
});

describe("verification poster — supplier invoice", () => {
  it("posts the default path: AP credit gross, incoming VAT debit, cost debit", async () => {
    const { user } = await setupPosting();

    const posted = await db.transaction((tx) =>
      poster.postSupplierInvoice(tx, SUPPLIER_DOC, [{ articleGroupId: null, vatRate: 25, lineAmount: 1000 }], user.id)
    );

    const verification = await loadVerification(posted.verificationId);
    expect(verification.status).toBe("booked");
    expect(verification.seriesCode).toBe("L");
    expect(verification.date).toBe(INVOICE_DATE);
    expect(verification.description).toBe("Leverantörsfaktura LF-12 (INV-9) — Leverantör AB");
    expectBalanced(verification.rows);
    expect(verification.rows).toEqual([
      { account: "2440", debit: 0, credit: 1250 },
      { account: "2640", debit: 250, credit: 0 },
      { account: "4010", debit: 1000, credit: 0 },
    ]);
  });

  it("uses the article group's posting rule for the cost account", async () => {
    const { user } = await setupPosting();
    const group = await makeArticleGroup("310", "Diskbänkar");
    const cost = await accountByNumber("4600");
    await service.createPostingRule({ articleGroupId: group.id, vatRate: 25, revenueAccountId: null, costAccountId: cost.id });

    const posted = await db.transaction((tx) =>
      poster.postSupplierInvoice(tx, SUPPLIER_DOC, [{ articleGroupId: group.id, vatRate: 25, lineAmount: 1000 }], user.id)
    );

    const { rows } = await loadVerification(posted.verificationId);
    expectBalanced(rows);
    expect(byAccount(rows)["4600"]).toEqual({ debit: 1000, credit: 0 });
    expect(byAccount(rows)["4010"]).toBeUndefined();
  });

  it("books a positive remainder (freight/fees) on the default cost account", async () => {
    const { user } = await setupPosting();
    const group = await makeArticleGroup("310", "Diskbänkar");
    const cost = await accountByNumber("4600");
    await service.createPostingRule({ articleGroupId: group.id, vatRate: null, revenueAccountId: null, costAccountId: cost.id });

    const posted = await db.transaction((tx) =>
      poster.postSupplierInvoice(tx, SUPPLIER_DOC, [{ articleGroupId: group.id, vatRate: 25, lineAmount: 900 }], user.id)
    );

    const { rows } = await loadVerification(posted.verificationId);
    expectBalanced(rows);
    expect(byAccount(rows)["4600"]).toEqual({ debit: 900, credit: 0 });
    expect(byAccount(rows)["4010"]).toEqual({ debit: 100, credit: 0 });
  });

  it("books a negative remainder (rows exceeding header net) as a credit on the default cost account", async () => {
    const { user } = await setupPosting();
    const group = await makeArticleGroup("310", "Diskbänkar");
    const cost = await accountByNumber("4600");
    await service.createPostingRule({ articleGroupId: group.id, vatRate: null, revenueAccountId: null, costAccountId: cost.id });

    const posted = await db.transaction((tx) =>
      poster.postSupplierInvoice(tx, SUPPLIER_DOC, [{ articleGroupId: group.id, vatRate: 25, lineAmount: 1100 }], user.id)
    );

    const { rows } = await loadVerification(posted.verificationId);
    expectBalanced(rows);
    expect(byAccount(rows)["4600"]).toEqual({ debit: 1100, credit: 0 });
    expect(byAccount(rows)["4010"]).toEqual({ debit: 0, credit: 100 });
  });

  it("books the whole header net on the default cost account when there are no rows", async () => {
    const { user } = await setupPosting();

    const posted = await db.transaction((tx) => poster.postSupplierInvoice(tx, SUPPLIER_DOC, [], user.id));

    const { rows } = await loadVerification(posted.verificationId);
    expectBalanced(rows);
    expect(byAccount(rows)["4010"]).toEqual({ debit: 1000, credit: 0 });
    expect(byAccount(rows)["2440"]).toEqual({ debit: 0, credit: 1250 });
  });

  it("books a row without an article group on the default cost account", async () => {
    const { user } = await setupPosting();

    const posted = await db.transaction((tx) =>
      poster.postSupplierInvoice(tx, SUPPLIER_DOC, [{ articleGroupId: null, vatRate: null, lineAmount: 1000 }], user.id)
    );

    const { rows } = await loadVerification(posted.verificationId);
    expectBalanced(rows);
    expect(byAccount(rows)["4010"]).toEqual({ debit: 1000, credit: 0 });
  });

  it("writes no VAT row when the header VAT is zero", async () => {
    const { user } = await setupPosting();

    const posted = await db.transaction((tx) =>
      poster.postSupplierInvoice(
        tx,
        { ...SUPPLIER_DOC, vatAmount: 0, grossAmount: 1000 },
        [{ articleGroupId: null, vatRate: 0, lineAmount: 1000 }],
        user.id
      )
    );

    const { rows } = await loadVerification(posted.verificationId);
    expectBalanced(rows);
    expect(rows).toEqual([
      { account: "2440", debit: 0, credit: 1000 },
      { account: "4010", debit: 1000, credit: 0 },
    ]);
  });

  it("rejects header amounts that do not add up (SupplierInvoiceAmountMismatchError)", async () => {
    const { user } = await setupPosting();

    await expect(
      db.transaction((tx) =>
        poster.postSupplierInvoice(
          tx,
          { ...SUPPLIER_DOC, grossAmount: 1300 },
          [{ articleGroupId: null, vatRate: 25, lineAmount: 1000 }],
          user.id
        )
      )
    ).rejects.toBeInstanceOf(SupplierInvoiceAmountMismatchError);

    expect(await db.select().from(verifications)).toHaveLength(0);
  });

  it("rejects a non-SEK supplier invoice (NonSekSupplierInvoiceError)", async () => {
    const { user } = await setupPosting();

    const error = await db
      .transaction((tx) =>
        poster.postSupplierInvoice(
          tx,
          { ...SUPPLIER_DOC, currency: "EUR" },
          [{ articleGroupId: null, vatRate: 25, lineAmount: 1000 }],
          user.id
        )
      )
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(NonSekSupplierInvoiceError);
    expect((error as NonSekSupplierInvoiceError).currency).toBe("EUR");
  });

  it("rejects a zero-amount supplier invoice (ZeroAmountPostingError)", async () => {
    const { user } = await setupPosting();

    await expect(
      db.transaction((tx) =>
        poster.postSupplierInvoice(
          tx,
          { ...SUPPLIER_DOC, netAmount: 0, vatAmount: 0, grossAmount: 0 },
          [],
          user.id
        )
      )
    ).rejects.toBeInstanceOf(ZeroAmountPostingError);
  });

  it("rejects an invoice date in a locked accounting period (AccountingPeriodLockedError)", async () => {
    const { user } = await setupPosting();
    const period = await repo.findPeriodForDate(INVOICE_DATE);
    await service.lockPeriod(period!.id, user.id);

    await expect(
      db.transaction((tx) =>
        poster.postSupplierInvoice(tx, SUPPLIER_DOC, [{ articleGroupId: null, vatRate: 25, lineAmount: 1000 }], user.id)
      )
    ).rejects.toBeInstanceOf(AccountingPeriodLockedError);
  });

  it("audits the supplier invoice with its own source label", async () => {
    const { user } = await setupPosting();

    const posted = await db.transaction((tx) =>
      poster.postSupplierInvoice(tx, SUPPLIER_DOC, [{ articleGroupId: null, vatRate: 25, lineAmount: 1000 }], user.id)
    );

    const entries = await db.select().from(auditLog).where(eq(auditLog.entityType, "verification"));
    expect(entries).toHaveLength(1);
    expect(entries[0]!.entityId).toBe(posted.displayNumber);
    expect(entries[0]!.detail).toEqual({ source: "supplier_invoice", document: "LF-12" });
  });
});

describe("verification poster — reversal", () => {
  async function postSupplier(userId: string) {
    return db.transaction((tx) =>
      poster.postSupplierInvoice(tx, SUPPLIER_DOC, [{ articleGroupId: null, vatRate: 25, lineAmount: 1000 }], userId)
    );
  }

  it("books a mirrored reversal linked to the source verification", async () => {
    const { user } = await setupPosting();
    const source = await postSupplier(user.id);

    const result = await db.transaction((tx) =>
      poster.reverseBookedVerification(
        tx,
        source.verificationId,
        { date: CANCEL_DATE, description: "Makulering LF-12 (INV-9) — Leverantör AB" },
        user.id
      )
    );

    expect("verificationId" in result).toBe(true);
    const reversal = await loadVerification((result as { verificationId: string }).verificationId);
    expect(reversal.status).toBe("booked");
    expect(reversal.reversesVerificationId).toBe(source.verificationId);
    expect(reversal.seriesCode).toBe("L");
    expect(reversal.verificationNumber).toBe(2);
    expect(reversal.date).toBe(CANCEL_DATE);
    expect(reversal.description).toBe("Makulering LF-12 (INV-9) — Leverantör AB");
    expectBalanced(reversal.rows);
    expect(reversal.rows).toEqual([
      { account: "2440", debit: 1250, credit: 0 },
      { account: "2640", debit: 0, credit: 250 },
      { account: "4010", debit: 0, credit: 1000 },
    ]);
  });

  it("reports alreadyReversed instead of booking a second reversal", async () => {
    const { user } = await setupPosting();
    const source = await postSupplier(user.id);
    await db.transaction((tx) =>
      poster.reverseBookedVerification(tx, source.verificationId, { date: CANCEL_DATE, description: "Makulering" }, user.id)
    );

    const second = await db.transaction((tx) =>
      poster.reverseBookedVerification(tx, source.verificationId, { date: CANCEL_DATE, description: "Makulering" }, user.id)
    );

    expect(second).toEqual({ alreadyReversed: true });
    expect(await db.select().from(verifications)).toHaveLength(2);
  });

  it("rejects a reversal into a locked accounting period", async () => {
    const { user } = await setupPosting();
    const source = await postSupplier(user.id);
    const period = await repo.findPeriodForDate(CANCEL_DATE);
    await service.lockPeriod(period!.id, user.id);

    await expect(
      db.transaction((tx) =>
        poster.reverseBookedVerification(tx, source.verificationId, { date: CANCEL_DATE, description: "Makulering" }, user.id)
      )
    ).rejects.toBeInstanceOf(AccountingPeriodLockedError);

    expect(await db.select().from(verifications)).toHaveLength(1);
  });
});

describe("verification poster — customer payment", () => {
  it("posts a full payment: bank debit, accounts receivable credit", async () => {
    const { user } = await setupPosting();

    const posted = await db.transaction((tx) =>
      poster.postCustomerPayment(tx, PAYMENT_DOC, [{ appliedAmount: 1250, writeOffAmount: 0 }], user.id)
    );

    expect(posted).not.toBeNull();
    expect(posted!.displayNumber).toBe(`K-${FISCAL_YEAR_LABEL}-1`);
    const verification = await loadVerification(posted!.verificationId);
    expect(verification.status).toBe("booked");
    expect(verification.seriesCode).toBe("K");
    expect(verification.date).toBe(PAYMENT_DATE);
    expect(verification.description).toBe("Betalning BET-1 — Testkund AB");
    expect(verification.createdBy).toBe(user.id);
    expect(verification.bookedBy).toBe(user.id);
    expect(verification.bookedAt).not.toBeNull();
    expect(verification.reversesVerificationId).toBeNull();

    expectBalanced(verification.rows);
    expect(verification.rows).toEqual([
      { account: "1930", debit: 1250, credit: 0 },
      { account: "1510", debit: 0, credit: 1250 },
    ]);
  });

  it("merges several settled invoices into one accounts receivable row", async () => {
    const { user } = await setupPosting();

    const posted = await db.transaction((tx) =>
      poster.postCustomerPayment(
        tx,
        PAYMENT_DOC,
        [
          { appliedAmount: 800, writeOffAmount: 0 },
          { appliedAmount: 450, writeOffAmount: 0 },
        ],
        user.id
      )
    );

    const { rows } = await loadVerification(posted!.verificationId);
    expectBalanced(rows);
    expect(rows).toEqual([
      { account: "1930", debit: 1250, credit: 0 },
      { account: "1510", debit: 0, credit: 1250 },
    ]);
  });

  it("debits the write-off account for an under-payment within tolerance", async () => {
    const { user } = await setupPosting();

    const posted = await db.transaction((tx) =>
      poster.postCustomerPayment(
        tx,
        { ...PAYMENT_DOC, bankAmount: 995 },
        [{ appliedAmount: 995, writeOffAmount: 5 }],
        user.id
      )
    );

    const { rows } = await loadVerification(posted!.verificationId);
    expectBalanced(rows);
    // The whole open amount (995 + 5) leaves the receivable; the 5 kr the
    // customer never paid lands on öres- och kronutjämning.
    expect(byAccount(rows)).toEqual({
      "1930": { debit: 995, credit: 0 },
      "1510": { debit: 0, credit: 1000 },
      "3740": { debit: 5, credit: 0 },
    });
  });

  it("credits the write-off account for an over-payment within tolerance", async () => {
    const { user } = await setupPosting();

    const posted = await db.transaction((tx) =>
      poster.postCustomerPayment(
        tx,
        { ...PAYMENT_DOC, bankAmount: 1005 },
        [{ appliedAmount: 1005, writeOffAmount: -5 }],
        user.id
      )
    );

    const { rows } = await loadVerification(posted!.verificationId);
    expectBalanced(rows);
    expect(byAccount(rows)).toEqual({
      "1930": { debit: 1005, credit: 0 },
      "1510": { debit: 0, credit: 1000 },
      "3740": { debit: 0, credit: 5 },
    });
  });

  it("books nothing at all for a pure netting of an invoice against a credit note", async () => {
    const { user } = await setupPosting();

    const posted = await db.transaction((tx) =>
      poster.postCustomerPayment(
        tx,
        { ...PAYMENT_DOC, bankAmount: 0 },
        [
          { appliedAmount: 1000, writeOffAmount: 0 },
          { appliedAmount: -1000, writeOffAmount: 0 },
        ],
        user.id
      )
    );

    // Kvittning between two open items on the same receivable account is not a
    // bookkeeping event — and it must not even materialize the K series.
    expect(posted).toBeNull();
    expect(await db.select().from(verifications)).toHaveLength(0);
    expect(await db.select().from(verificationRows)).toHaveLength(0);
    expect(await db.select().from(verificationSeries)).toHaveLength(0);
    expect(await db.select().from(verificationCounters)).toHaveLength(0);
    expect(await db.select().from(auditLog).where(eq(auditLog.entityType, "verification"))).toHaveLength(0);
  });

  it("does not touch the bank account at all for a pure netting", async () => {
    const { user } = await setupPosting();
    // Even a deactivated betalkonto cannot block a netting that never debits
    // it — the account is only resolved when money actually moved.
    const bank = await accountByNumber("1930");
    await service.updateAccount(bank.id, { active: false });

    const posted = await db.transaction((tx) =>
      poster.postCustomerPayment(
        tx,
        { ...PAYMENT_DOC, bankAmount: 0 },
        [
          { appliedAmount: 700, writeOffAmount: 0 },
          { appliedAmount: -700, writeOffAmount: 0 },
        ],
        user.id
      )
    );

    expect(posted).toBeNull();
  });

  it("nets the bank part against the settled credit note for a mixed payment", async () => {
    const { user } = await setupPosting();

    const posted = await db.transaction((tx) =>
      poster.postCustomerPayment(
        tx,
        { ...PAYMENT_DOC, bankAmount: 700 },
        [
          { appliedAmount: 1000, writeOffAmount: 0 },
          { appliedAmount: -300, writeOffAmount: 0 },
        ],
        user.id
      )
    );

    const { rows } = await loadVerification(posted!.verificationId);
    expectBalanced(rows);
    // One netted receivable row (1000 − 300), not two opposing rows.
    expect(rows).toEqual([
      { account: "1930", debit: 700, credit: 0 },
      { account: "1510", debit: 0, credit: 700 },
    ]);
  });

  it("posts against the bank account the payment itself carries", async () => {
    const { user } = await setupPosting();

    const posted = await db.transaction((tx) =>
      poster.postCustomerPayment(
        tx,
        { ...PAYMENT_DOC, bankAccountNumber: "1910" },
        [{ appliedAmount: 1250, writeOffAmount: 0 }],
        user.id
      )
    );

    const { rows } = await loadVerification(posted!.verificationId);
    expectBalanced(rows);
    expect(byAccount(rows)["1910"]).toEqual({ debit: 1250, credit: 0 });
    expect(byAccount(rows)["1930"]).toBeUndefined();
  });

  it("rejects an inactive bank account (MissingPostingAccountError)", async () => {
    const { user } = await setupPosting();
    const bank = await accountByNumber("1930");
    await service.updateAccount(bank.id, { active: false });

    const error = await db
      .transaction((tx) => poster.postCustomerPayment(tx, PAYMENT_DOC, [{ appliedAmount: 1250, writeOffAmount: 0 }], user.id))
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(MissingPostingAccountError);
    expect((error as MissingPostingAccountError).accountNumber).toBe("1930");
    expect((error as MissingPostingAccountError).roleLabel).toBe("payment bank account");
    expect(await db.select().from(verifications)).toHaveLength(0);
  });

  it("rejects a bank account number that does not exist (MissingPostingAccountError)", async () => {
    const { user } = await setupPosting();

    const error = await db
      .transaction((tx) =>
        poster.postCustomerPayment(
          tx,
          { ...PAYMENT_DOC, bankAccountNumber: "9999" },
          [{ appliedAmount: 1250, writeOffAmount: 0 }],
          user.id
        )
      )
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(MissingPostingAccountError);
    expect((error as MissingPostingAccountError).accountNumber).toBe("9999");
    expect(await db.select().from(verifications)).toHaveLength(0);
  });

  it("rejects a write-off account that is missing from the chart of accounts", async () => {
    const { user } = await setupPosting();
    postingSettings.postingPaymentWriteOff = "9999";

    const error = await db
      .transaction((tx) =>
        poster.postCustomerPayment(
          tx,
          { ...PAYMENT_DOC, bankAmount: 995 },
          [{ appliedAmount: 995, writeOffAmount: 5 }],
          user.id
        )
      )
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(MissingPostingAccountError);
    expect((error as MissingPostingAccountError).accountNumber).toBe("9999");
    expect(await db.select().from(verifications)).toHaveLength(0);
  });

  it("refuses to swallow a payment whose bank account cancels its own posting", async () => {
    const { user } = await setupPosting();

    const error = await db
      .transaction((tx) =>
        // Picking the receivable account as the betalkonto makes every
        // contribution land on 1510 and net to nothing. The ledger effect
        // really is zero — but a payment that hit the bank must never book
        // nothing and pass for a kvittning, so it is rejected instead.
        poster.postCustomerPayment(
          tx,
          { ...PAYMENT_DOC, bankAccountNumber: "1510" },
          [{ appliedAmount: 1250, writeOffAmount: 0 }],
          user.id
        )
      )
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(PaymentBankAccountConflictError);
    expect((error as PaymentBankAccountConflictError).accountNumber).toBe("1510");
    expect(await db.select().from(verifications)).toHaveLength(0);
    expect(await db.select().from(verificationSeries)).toHaveLength(0);
  });

  it("refuses the same betalkonto even when the surviving rows would balance on their own", async () => {
    const { user } = await setupPosting();

    const error = await db
      .transaction((tx) =>
        // The dangerous shape: 1510 as betalkonto for a 995 kr payment of a
        // 1000 kr invoice. The bank's +995 cancels 995 of the receivable's
        // −1000 and what is left, [1510 K 5, 3740 D 5], is a perfectly
        // balanced two-row verification — so the empty-row backstop would
        // never fire and 995 kr of real bank money would vanish from the
        // books behind a verification that looks entirely correct.
        poster.postCustomerPayment(
          tx,
          { ...PAYMENT_DOC, bankAccountNumber: "1510", bankAmount: 995 },
          [{ appliedAmount: 995, writeOffAmount: 5 }],
          user.id
        )
      )
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(PaymentBankAccountConflictError);
    expect((error as PaymentBankAccountConflictError).accountNumber).toBe("1510");
    expect(await db.select().from(verifications)).toHaveLength(0);
    expect(await db.select().from(verificationRows)).toHaveLength(0);
    expect(await db.select().from(verificationSeries)).toHaveLength(0);
  });

  it("refuses the write-off account as the betalkonto too", async () => {
    const { user } = await setupPosting();

    const error = await db
      .transaction((tx) =>
        // Same silent omission one account over: the bank movement would be
        // absorbed by öres- och kronutjämning (+1005 − 5 on 3740), leaving a
        // balanced pair with no bank row in it at all.
        poster.postCustomerPayment(
          tx,
          { ...PAYMENT_DOC, bankAccountNumber: "3740", bankAmount: 1005 },
          [{ appliedAmount: 1005, writeOffAmount: -5 }],
          user.id
        )
      )
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(PaymentBankAccountConflictError);
    expect((error as PaymentBankAccountConflictError).accountNumber).toBe("3740");
    expect(await db.select().from(verifications)).toHaveLength(0);
  });

  it("still books a bank-less kvittning whose tolerance write-off is a real ledger event", async () => {
    const { user } = await setupPosting();

    const posted = await db.transaction((tx) =>
      // The legitimate neighbour of the two cases above: no money moved
      // (bankAmount 0), but one of the netted items was settled 5 kr short,
      // so öres- och kronutjämning genuinely changes. This is NOT the
      // "books nothing" kvittning — it must produce a verification.
      poster.postCustomerPayment(
        tx,
        { ...PAYMENT_DOC, bankAmount: 0 },
        [
          { appliedAmount: 1000, writeOffAmount: 5 },
          { appliedAmount: -1000, writeOffAmount: 0 },
        ],
        user.id
      )
    );

    expect(posted).not.toBeNull();
    const { rows } = await loadVerification(posted!.verificationId);
    expectBalanced(rows);
    expect(rows).toEqual([
      { account: "1510", debit: 0, credit: 5 },
      { account: "3740", debit: 5, credit: 0 },
    ]);
  });

  it("rejects a payment date in a locked accounting period (AccountingPeriodLockedError)", async () => {
    const { user } = await setupPosting();
    const period = await repo.findPeriodForDate(PAYMENT_DATE);
    await service.lockPeriod(period!.id, user.id);

    await expect(
      db.transaction((tx) => poster.postCustomerPayment(tx, PAYMENT_DOC, [{ appliedAmount: 1250, writeOffAmount: 0 }], user.id))
    ).rejects.toBeInstanceOf(AccountingPeriodLockedError);

    expect(await db.select().from(verifications)).toHaveLength(0);
    expect(await db.select().from(verificationSeries)).toHaveLength(0);
  });

  it("rejects a bank amount that does not equal the applied total (PaymentAmountMismatchError)", async () => {
    const { user } = await setupPosting();

    const error = await db
      .transaction((tx) =>
        poster.postCustomerPayment(tx, { ...PAYMENT_DOC, bankAmount: 1250 }, [{ appliedAmount: 500, writeOffAmount: 0 }], user.id)
      )
      .catch((err: unknown) => err);

    // Only B = Σ applied balances — without this guard the mismatch would
    // reach insertBookedVerification's programming-error asserts (a 500).
    expect(error).toBeInstanceOf(PaymentAmountMismatchError);
    expect(await db.select().from(verifications)).toHaveLength(0);
    expect(await db.select().from(verificationSeries)).toHaveLength(0);
  });

  it("rejects a write-off account that IS accounts receivable — the write-off would absorb itself", async () => {
    const { user } = await setupPosting();
    // öres- och kronutjämning pointed at 1510: the write-off's +5 cancels part
    // of the rows' −1000 and the payment books [1930 D 995, 1510 K 995] — a
    // balanced verification WITH a bank row, so nothing downstream complains
    // while the 5 kr the customer never paid stays on the receivable for ever
    // and the derived open amount calls the invoice settled.
    postingSettings.postingPaymentWriteOff = "1510";

    const error = await db
      .transaction((tx) =>
        poster.postCustomerPayment(
          tx,
          { ...PAYMENT_DOC, bankAmount: 995 },
          [{ appliedAmount: 995, writeOffAmount: 5 }],
          user.id
        )
      )
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(PaymentBankAccountConflictError);
    expect((error as PaymentBankAccountConflictError).accountNumber).toBe("1510");
    expect((error as PaymentBankAccountConflictError).roleLabel).toBe("payment write-off account");
    expect(await db.select().from(verifications)).toHaveLength(0);
    expect(await db.select().from(verificationSeries)).toHaveLength(0);
  });

  it("rejects the same misconfiguration on a bank-less kvittning that carries a write-off", async () => {
    const { user } = await setupPosting();
    postingSettings.postingPaymentWriteOff = "1510";

    const error = await db
      .transaction((tx) =>
        // No bank movement at all (125 + −125 = 0 = bankAmount, so the applied
        // identity holds), but a real 5 kr write-off. This is why the check
        // sits OUTSIDE the bankAmount !== 0 branch: moved inside it, the
        // write-off's +5 would cancel the receivable's −5, every contribution
        // would net to zero and the poster would return null — reporting a
        // ledger event that genuinely changes 3740 as "nothing to book".
        poster.postCustomerPayment(
          tx,
          { ...PAYMENT_DOC, bankAmount: 0 },
          [
            { appliedAmount: 125, writeOffAmount: 5 },
            { appliedAmount: -125, writeOffAmount: 0 },
          ],
          user.id
        )
      )
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(PaymentBankAccountConflictError);
    expect((error as PaymentBankAccountConflictError).accountNumber).toBe("1510");
    expect((error as PaymentBankAccountConflictError).roleLabel).toBe("payment write-off account");
    expect(await db.select().from(verifications)).toHaveLength(0);
    expect(await db.select().from(verificationSeries)).toHaveLength(0);
  });

  it("still books a payment that produces no write-off when the write-off account is misconfigured", async () => {
    const { user } = await setupPosting();
    postingSettings.postingPaymentWriteOff = "1510";

    const posted = await db.transaction((tx) =>
      poster.postCustomerPayment(tx, PAYMENT_DOC, [{ appliedAmount: 1250, writeOffAmount: 0 }], user.id)
    );

    // The check above is conditional on there BEING a write-off: a retired (or
    // simply wrong) öres- och kronutjämning account must not block exact
    // payments, which never resolve it at all.
    const { rows } = await loadVerification(posted!.verificationId);
    expectBalanced(rows);
    expect(rows).toEqual([
      { account: "1930", debit: 1250, credit: 0 },
      { account: "1510", debit: 0, credit: 1250 },
    ]);
  });

  it("writes an audit entry with the customer_payment source", async () => {
    const { user } = await setupPosting();

    const posted = await db.transaction((tx) =>
      poster.postCustomerPayment(tx, PAYMENT_DOC, [{ appliedAmount: 1250, writeOffAmount: 0 }], user.id)
    );

    const entries = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityType, "verification"), eq(auditLog.action, "booked")));
    expect(entries).toHaveLength(1);
    expect(entries[0]!.entityId).toBe(posted!.displayNumber);
    expect(entries[0]!.userId).toBe(user.id);
    expect(entries[0]!.detail).toEqual({ source: "customer_payment", document: "BET-1" });
  });
});

describe("verification poster — reminder fee", () => {
  it("posts the fee: accounts receivable debit, fee account credit, no VAT", async () => {
    const { user } = await setupPosting();

    const posted = await db.transaction((tx) => poster.postReminderFee(tx, REMINDER_DOC, user.id));

    expect(posted.displayNumber).toBe(`K-${FISCAL_YEAR_LABEL}-1`);
    const verification = await loadVerification(posted.verificationId);
    expect(verification.status).toBe("booked");
    expect(verification.seriesCode).toBe("K");
    expect(verification.date).toBe(REMINDER_DATE);
    expect(verification.description).toBe("Påminnelseavgift faktura FA-1001 — Testkund AB");

    expectBalanced(verification.rows);
    // A statutory reminder fee is VAT-free: exactly two rows, no 26xx row.
    expect(verification.rows).toEqual([
      { account: "1510", debit: 60, credit: 0 },
      { account: "3540", debit: 0, credit: 60 },
    ]);

    const entries = await db.select().from(auditLog).where(eq(auditLog.entityType, "verification"));
    expect(entries).toHaveLength(1);
    expect(entries[0]!.detail).toEqual({ source: "invoice_reminder", document: "FA-1001" });
  });

  it("rejects a zero or negative fee (ZeroAmountPostingError)", async () => {
    const { user } = await setupPosting();

    await expect(
      db.transaction((tx) => poster.postReminderFee(tx, { ...REMINDER_DOC, feeAmount: 0 }, user.id))
    ).rejects.toBeInstanceOf(ZeroAmountPostingError);
    await expect(
      db.transaction((tx) => poster.postReminderFee(tx, { ...REMINDER_DOC, feeAmount: -60 }, user.id))
    ).rejects.toBeInstanceOf(ZeroAmountPostingError);

    expect(await db.select().from(verifications)).toHaveLength(0);
    expect(await db.select().from(verificationSeries)).toHaveLength(0);
  });

  it("rejects a fee account that is missing from the chart of accounts", async () => {
    const { user } = await setupPosting();
    postingSettings.postingReminderFeeAccount = "9999";

    const error = await db
      .transaction((tx) => poster.postReminderFee(tx, REMINDER_DOC, user.id))
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(MissingPostingAccountError);
    expect((error as MissingPostingAccountError).accountNumber).toBe("9999");
    expect(await db.select().from(verifications)).toHaveLength(0);
  });

  it("rejects a fee account that IS accounts receivable — typed, not a row-count assert", async () => {
    const { user } = await setupPosting();
    // Both roles on 1510: the debit and the credit cancel, so the fee would
    // be charged to the customer with nothing whatsoever in the books.
    postingSettings.postingReminderFeeAccount = "1510";

    const error = await db
      .transaction((tx) => poster.postReminderFee(tx, REMINDER_DOC, user.id))
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(PaymentBankAccountConflictError);
    expect((error as PaymentBankAccountConflictError).accountNumber).toBe("1510");
    expect(await db.select().from(verifications)).toHaveLength(0);
    expect(await db.select().from(verificationSeries)).toHaveLength(0);

    // ...and the pre-flight says the same thing, so the reminder is refused
    // BEFORE the email goes out (this is static configuration, not a race).
    await expect(poster.assertReminderFeePostable(db, REMINDER_DATE)).rejects.toBeInstanceOf(
      PaymentBankAccountConflictError
    );
  });
});

describe("verification poster — kundreskontra series K", () => {
  it("shares one K series between payments and fees, numbering consecutively per year", async () => {
    const { user } = await setupPosting();

    const invoice = await db.transaction((tx) =>
      poster.postCustomerInvoice(
        tx,
        CUSTOMER_DOC,
        [{ articleGroupId: null, lineAmount: 1000, vatAmount: 250, vatRate: 25 }],
        user.id
      )
    );
    const payment = await db.transaction((tx) =>
      poster.postCustomerPayment(tx, PAYMENT_DOC, [{ appliedAmount: 1250, writeOffAmount: 0 }], user.id)
    );
    const fee = await db.transaction((tx) => poster.postReminderFee(tx, REMINDER_DOC, user.id));

    // Numbering is per (series, fiscal year): F and K count independently.
    expect(invoice.displayNumber).toBe(`F-${FISCAL_YEAR_LABEL}-1`);
    expect(payment!.displayNumber).toBe(`K-${FISCAL_YEAR_LABEL}-1`);
    expect(fee.displayNumber).toBe(`K-${FISCAL_YEAR_LABEL}-2`);

    const series = await db.select().from(verificationSeries).orderBy(asc(verificationSeries.code));
    expect(series.map((row) => `${row.code}/${row.name}`)).toEqual(["F/Kundfakturor", "K/Kundreskontra"]);
  });

  it("books the reversal of a payment verification in the K series", async () => {
    const { user } = await setupPosting();
    const payment = await db.transaction((tx) =>
      poster.postCustomerPayment(tx, PAYMENT_DOC, [{ appliedAmount: 1250, writeOffAmount: 0 }], user.id)
    );

    const result = await db.transaction((tx) =>
      poster.reverseBookedVerification(
        tx,
        payment!.verificationId,
        { date: CANCEL_DATE, description: "Makulerad betalning BET-1 — Testkund AB" },
        user.id
      )
    );

    const reversal = await loadVerification((result as { verificationId: string }).verificationId);
    // The reversal inherits the source's series — a cancelled payment lands
    // next to the payment it corrects.
    expect(reversal.seriesCode).toBe("K");
    expect(reversal.verificationNumber).toBe(2);
    expect(reversal.reversesVerificationId).toBe(payment!.verificationId);
    expect(reversal.date).toBe(CANCEL_DATE);
    expectBalanced(reversal.rows);
    expect(reversal.rows).toEqual([
      { account: "1930", debit: 0, credit: 1250 },
      { account: "1510", debit: 1250, credit: 0 },
    ]);
  });

  it("burns no K number when the caller's transaction rolls back", async () => {
    const { user } = await setupPosting();
    const rows = [{ appliedAmount: 1250, writeOffAmount: 0 }];

    await expect(
      db.transaction(async (tx) => {
        await poster.postCustomerPayment(tx, PAYMENT_DOC, rows, user.id);
        throw new Error("consumer failed after posting");
      })
    ).rejects.toThrow("consumer failed after posting");

    expect(await db.select().from(verifications)).toHaveLength(0);
    expect(await db.select().from(verificationSeries)).toHaveLength(0);
    expect(await db.select().from(verificationCounters)).toHaveLength(0);

    const retried = await db.transaction((tx) => poster.postCustomerPayment(tx, PAYMENT_DOC, rows, user.id));
    expect(retried!.displayNumber).toBe(`K-${FISCAL_YEAR_LABEL}-1`);
  });
});

describe("verification poster — supplier payment", () => {
  it("posts a full payment: accounts payable debit, bank credit", async () => {
    const { user } = await setupPosting();

    const posted = await db.transaction((tx) =>
      poster.postSupplierPayment(tx, SUPPLIER_PAYMENT_DOC, [{ appliedAmount: 125, writeOffAmount: 0 }], user.id)
    );

    expect(posted).not.toBeNull();
    expect(posted!.displayNumber).toBe(`U-${FISCAL_YEAR_LABEL}-1`);
    const verification = await loadVerification(posted!.verificationId);
    expect(verification.status).toBe("booked");
    expect(verification.seriesCode).toBe("U");
    expect(verification.date).toBe(PAYMENT_DATE);
    expect(verification.description).toBe("Betalning UTB-1 — Leverantör AB");
    expect(verification.createdBy).toBe(user.id);
    expect(verification.bookedBy).toBe(user.id);
    expect(verification.bookedAt).not.toBeNull();
    expect(verification.reversesVerificationId).toBeNull();

    expectBalanced(verification.rows);
    // Every sign is the customer payment's mirror: the bank is credited (money
    // out) and the leverantörsskuld debited. Row order follows the accumulator's
    // insertion order — bank first, exactly as on the customer side.
    expect(verification.rows).toEqual([
      { account: "1930", debit: 0, credit: 125 },
      { account: "2440", debit: 125, credit: 0 },
    ]);
  });

  it("merges several settled invoices into one accounts payable row", async () => {
    const { user } = await setupPosting();

    const posted = await db.transaction((tx) =>
      poster.postSupplierPayment(
        tx,
        SUPPLIER_PAYMENT_DOC,
        [
          { appliedAmount: 100, writeOffAmount: 0 },
          { appliedAmount: 25, writeOffAmount: 0 },
        ],
        user.id
      )
    );

    const { rows } = await loadVerification(posted!.verificationId);
    expectBalanced(rows);
    expect(rows).toEqual([
      { account: "1930", debit: 0, credit: 125 },
      { account: "2440", debit: 125, credit: 0 },
    ]);
  });

  it("credits the write-off account for an under-payment within tolerance", async () => {
    const { user } = await setupPosting();

    const posted = await db.transaction((tx) =>
      poster.postSupplierPayment(
        tx,
        { ...SUPPLIER_PAYMENT_DOC, bankAmount: 120 },
        [{ appliedAmount: 120, writeOffAmount: 5 }],
        user.id
      )
    );

    const { rows } = await loadVerification(posted!.verificationId);
    expectBalanced(rows);
    // The whole debt (120 + 5) leaves the payable; the 5 kr we never had to pay
    // is a gain on öres- och kronutjämning — the opposite side from the
    // customer under-payment, which debits it.
    expect(byAccount(rows)).toEqual({
      "1930": { debit: 0, credit: 120 },
      "2440": { debit: 125, credit: 0 },
      "3740": { debit: 0, credit: 5 },
    });
  });

  it("debits the write-off account for an over-payment within tolerance", async () => {
    const { user } = await setupPosting();

    const posted = await db.transaction((tx) =>
      poster.postSupplierPayment(
        tx,
        { ...SUPPLIER_PAYMENT_DOC, bankAmount: 130 },
        [{ appliedAmount: 130, writeOffAmount: -5 }],
        user.id
      )
    );

    const { rows } = await loadVerification(posted!.verificationId);
    expectBalanced(rows);
    expect(byAccount(rows)).toEqual({
      "1930": { debit: 0, credit: 130 },
      "2440": { debit: 125, credit: 0 },
      "3740": { debit: 5, credit: 0 },
    });
  });

  it("books nothing at all for a pure netting of an invoice against a supplier credit note", async () => {
    const { user } = await setupPosting();

    const posted = await db.transaction((tx) =>
      poster.postSupplierPayment(
        tx,
        { ...SUPPLIER_PAYMENT_DOC, bankAmount: 0 },
        [
          { appliedAmount: 125, writeOffAmount: 0 },
          { appliedAmount: -125, writeOffAmount: 0 },
        ],
        user.id
      )
    );

    // Kvittning between two open items on the same payable account is not a
    // bookkeeping event — and it must not even materialize the U series.
    expect(posted).toBeNull();
    expect(await db.select().from(verifications)).toHaveLength(0);
    expect(await db.select().from(verificationRows)).toHaveLength(0);
    expect(await db.select().from(verificationSeries)).toHaveLength(0);
    expect(await db.select().from(verificationCounters)).toHaveLength(0);
    expect(await db.select().from(auditLog).where(eq(auditLog.entityType, "verification"))).toHaveLength(0);
  });

  it("does not touch the bank account at all for a pure netting", async () => {
    const { user } = await setupPosting();
    // Even a deactivated betalkonto cannot block a netting that never credits
    // it — the account is only resolved when money actually moved.
    const bank = await accountByNumber("1930");
    await service.updateAccount(bank.id, { active: false });

    const posted = await db.transaction((tx) =>
      poster.postSupplierPayment(
        tx,
        { ...SUPPLIER_PAYMENT_DOC, bankAmount: 0 },
        [
          { appliedAmount: 70, writeOffAmount: 0 },
          { appliedAmount: -70, writeOffAmount: 0 },
        ],
        user.id
      )
    );

    expect(posted).toBeNull();
  });

  it("still books a bank-less kvittning whose tolerance write-off is a real ledger event", async () => {
    const { user } = await setupPosting();

    const posted = await db.transaction((tx) =>
      // No money moved (bankAmount 0), but one of the netted items was settled
      // 5 kr short, so öres- och kronutjämning genuinely changes. This is NOT
      // the "books nothing" kvittning — it must produce a verification.
      poster.postSupplierPayment(
        tx,
        { ...SUPPLIER_PAYMENT_DOC, bankAmount: 0 },
        [
          { appliedAmount: 125, writeOffAmount: 5 },
          { appliedAmount: -125, writeOffAmount: 0 },
        ],
        user.id
      )
    );

    expect(posted).not.toBeNull();
    const { rows } = await loadVerification(posted!.verificationId);
    expectBalanced(rows);
    expect(rows).toEqual([
      { account: "2440", debit: 5, credit: 0 },
      { account: "3740", debit: 0, credit: 5 },
    ]);
  });

  it("rejects a bank amount that does not equal the applied total (PaymentAmountMismatchError)", async () => {
    const { user } = await setupPosting();

    const error = await db
      .transaction((tx) =>
        poster.postSupplierPayment(
          tx,
          { ...SUPPLIER_PAYMENT_DOC, bankAmount: 125 },
          [{ appliedAmount: 50, writeOffAmount: 0 }],
          user.id
        )
      )
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(PaymentAmountMismatchError);
    expect(await db.select().from(verifications)).toHaveLength(0);
    expect(await db.select().from(verificationSeries)).toHaveLength(0);
  });

  it("refuses to swallow a payment whose bank account cancels its own posting", async () => {
    const { user } = await setupPosting();

    const error = await db
      .transaction((tx) =>
        // Picking the payable account as the betalkonto makes every
        // contribution land on 2440 and net to nothing. The ledger effect
        // really is zero — but money that left the bank must never book
        // nothing and pass for a kvittning.
        poster.postSupplierPayment(
          tx,
          { ...SUPPLIER_PAYMENT_DOC, bankAccountNumber: "2440" },
          [{ appliedAmount: 125, writeOffAmount: 0 }],
          user.id
        )
      )
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(PaymentBankAccountConflictError);
    expect((error as PaymentBankAccountConflictError).accountNumber).toBe("2440");
    expect((error as PaymentBankAccountConflictError).roleLabel).toBe("payment bank account");
    expect(await db.select().from(verifications)).toHaveLength(0);
    expect(await db.select().from(verificationSeries)).toHaveLength(0);
  });

  it("refuses the same betalkonto even when the surviving rows would balance on their own", async () => {
    const { user } = await setupPosting();

    const error = await db
      .transaction((tx) =>
        // The dangerous shape: 2440 as betalkonto for a 120 kr payment of a
        // 125 kr debt. The bank's −120 cancels 120 of the payable's +125 and
        // what is left, [2440 D 5, 3740 K 5], is a perfectly balanced two-row
        // verification — so the empty-row backstop would never fire and 120 kr
        // that really left the bank would vanish from the books.
        poster.postSupplierPayment(
          tx,
          { ...SUPPLIER_PAYMENT_DOC, bankAccountNumber: "2440", bankAmount: 120 },
          [{ appliedAmount: 120, writeOffAmount: 5 }],
          user.id
        )
      )
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(PaymentBankAccountConflictError);
    expect((error as PaymentBankAccountConflictError).accountNumber).toBe("2440");
    expect(await db.select().from(verifications)).toHaveLength(0);
    expect(await db.select().from(verificationRows)).toHaveLength(0);
    expect(await db.select().from(verificationSeries)).toHaveLength(0);
  });

  it("refuses the write-off account as the betalkonto too", async () => {
    const { user } = await setupPosting();

    const error = await db
      .transaction((tx) =>
        // Same silent omission one account over: the bank movement would be
        // absorbed by öres- och kronutjämning (−130 + 5 on 3740), leaving a
        // balanced pair with no bank row in it at all.
        poster.postSupplierPayment(
          tx,
          { ...SUPPLIER_PAYMENT_DOC, bankAccountNumber: "3740", bankAmount: 130 },
          [{ appliedAmount: 130, writeOffAmount: -5 }],
          user.id
        )
      )
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(PaymentBankAccountConflictError);
    expect((error as PaymentBankAccountConflictError).accountNumber).toBe("3740");
    expect(await db.select().from(verifications)).toHaveLength(0);
  });

  it("rejects a write-off account that IS accounts payable — the write-off would absorb itself", async () => {
    const { user } = await setupPosting();
    // The supplier side of B3's residual: with 3740 pointed at 2440 the
    // write-off's −5 cancels part of the rows' +125 and the payment books
    // [1930 K 120, 2440 D 120] — balanced, bank row present, and the 5 kr we
    // never paid stays on the leverantörsskuld while the derived open amount
    // calls the invoice settled.
    postingSettings.postingPaymentWriteOff = "2440";

    const error = await db
      .transaction((tx) =>
        poster.postSupplierPayment(
          tx,
          { ...SUPPLIER_PAYMENT_DOC, bankAmount: 120 },
          [{ appliedAmount: 120, writeOffAmount: 5 }],
          user.id
        )
      )
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(PaymentBankAccountConflictError);
    expect((error as PaymentBankAccountConflictError).accountNumber).toBe("2440");
    expect((error as PaymentBankAccountConflictError).roleLabel).toBe("payment write-off account");
    expect(await db.select().from(verifications)).toHaveLength(0);
    expect(await db.select().from(verificationSeries)).toHaveLength(0);
  });

  it("rejects the same misconfiguration on a bank-less kvittning that carries a write-off", async () => {
    const { user } = await setupPosting();
    postingSettings.postingPaymentWriteOff = "2440";

    const error = await db
      .transaction((tx) =>
        // The supplier-side twin of the customer test: no money left the bank
        // (125 + −125 = 0 = bankAmount), but 5 kr is genuinely written off. The
        // check must fire from OUTSIDE the bankAmount !== 0 branch — inside it,
        // the write-off's −5 would cancel the payable's +5, everything would
        // net to zero and the poster would silently return null instead of
        // booking the öres- och kronutjämning that really happened.
        poster.postSupplierPayment(
          tx,
          { ...SUPPLIER_PAYMENT_DOC, bankAmount: 0 },
          [
            { appliedAmount: 125, writeOffAmount: 5 },
            { appliedAmount: -125, writeOffAmount: 0 },
          ],
          user.id
        )
      )
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(PaymentBankAccountConflictError);
    expect((error as PaymentBankAccountConflictError).accountNumber).toBe("2440");
    expect((error as PaymentBankAccountConflictError).roleLabel).toBe("payment write-off account");
    expect(await db.select().from(verifications)).toHaveLength(0);
    expect(await db.select().from(verificationSeries)).toHaveLength(0);
  });

  it("still books a payment that produces no write-off when the write-off account is misconfigured", async () => {
    const { user } = await setupPosting();
    postingSettings.postingPaymentWriteOff = "2440";

    const posted = await db.transaction((tx) =>
      poster.postSupplierPayment(tx, SUPPLIER_PAYMENT_DOC, [{ appliedAmount: 125, writeOffAmount: 0 }], user.id)
    );

    // Conditional check, same as on the customer side: an exact payment never
    // resolves the write-off account, so a misconfigured one cannot block it.
    const { rows } = await loadVerification(posted!.verificationId);
    expectBalanced(rows);
    expect(rows).toEqual([
      { account: "1930", debit: 0, credit: 125 },
      { account: "2440", debit: 125, credit: 0 },
    ]);
  });

  it("rejects an inactive bank account (MissingPostingAccountError)", async () => {
    const { user } = await setupPosting();
    const bank = await accountByNumber("1930");
    await service.updateAccount(bank.id, { active: false });

    const error = await db
      .transaction((tx) =>
        poster.postSupplierPayment(tx, SUPPLIER_PAYMENT_DOC, [{ appliedAmount: 125, writeOffAmount: 0 }], user.id)
      )
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(MissingPostingAccountError);
    expect((error as MissingPostingAccountError).accountNumber).toBe("1930");
    expect((error as MissingPostingAccountError).roleLabel).toBe("payment bank account");
    expect(await db.select().from(verifications)).toHaveLength(0);
  });

  it("rejects a payment date in a locked accounting period (AccountingPeriodLockedError)", async () => {
    const { user } = await setupPosting();
    const period = await repo.findPeriodForDate(PAYMENT_DATE);
    await service.lockPeriod(period!.id, user.id);

    await expect(
      db.transaction((tx) =>
        poster.postSupplierPayment(tx, SUPPLIER_PAYMENT_DOC, [{ appliedAmount: 125, writeOffAmount: 0 }], user.id)
      )
    ).rejects.toBeInstanceOf(AccountingPeriodLockedError);

    expect(await db.select().from(verifications)).toHaveLength(0);
    expect(await db.select().from(verificationSeries)).toHaveLength(0);
  });

  it("writes an audit entry with the supplier_payment source", async () => {
    const { user } = await setupPosting();

    const posted = await db.transaction((tx) =>
      poster.postSupplierPayment(tx, SUPPLIER_PAYMENT_DOC, [{ appliedAmount: 125, writeOffAmount: 0 }], user.id)
    );

    const entries = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityType, "verification"), eq(auditLog.action, "booked")));
    expect(entries).toHaveLength(1);
    expect(entries[0]!.entityId).toBe(posted!.displayNumber);
    expect(entries[0]!.userId).toBe(user.id);
    expect(entries[0]!.detail).toEqual({ source: "supplier_payment", document: "UTB-1" });
  });
});

describe("verification poster — leverantörsreskontra series U", () => {
  it("lazily creates the U series once and reuses it, numbering separately from L", async () => {
    const { user } = await setupPosting();

    const invoice = await db.transaction((tx) =>
      poster.postSupplierInvoice(tx, SUPPLIER_DOC, [{ articleGroupId: null, vatRate: 25, lineAmount: 1000 }], user.id)
    );
    const first = await db.transaction((tx) =>
      poster.postSupplierPayment(tx, SUPPLIER_PAYMENT_DOC, [{ appliedAmount: 125, writeOffAmount: 0 }], user.id)
    );
    const second = await db.transaction((tx) =>
      poster.postSupplierPayment(
        tx,
        { ...SUPPLIER_PAYMENT_DOC, paymentNumber: "UTB-2" },
        [{ appliedAmount: 125, writeOffAmount: 0 }],
        user.id
      )
    );

    // Numbering is per (series, fiscal year): the supplier debt (L) and its
    // settlement (U) count independently.
    expect(invoice.displayNumber).toBe(`L-${FISCAL_YEAR_LABEL}-1`);
    expect(first!.displayNumber).toBe(`U-${FISCAL_YEAR_LABEL}-1`);
    expect(second!.displayNumber).toBe(`U-${FISCAL_YEAR_LABEL}-2`);

    const series = await db.select().from(verificationSeries).orderBy(asc(verificationSeries.code));
    expect(series.map((row) => `${row.code}/${row.name}`)).toEqual([
      "L/Leverantörsfakturor",
      "U/Leverantörsreskontra",
    ]);
  });

  it("books the reversal of a supplier payment verification in the U series", async () => {
    const { user } = await setupPosting();
    const payment = await db.transaction((tx) =>
      poster.postSupplierPayment(tx, SUPPLIER_PAYMENT_DOC, [{ appliedAmount: 125, writeOffAmount: 0 }], user.id)
    );

    const result = await db.transaction((tx) =>
      poster.reverseBookedVerification(
        tx,
        payment!.verificationId,
        { date: CANCEL_DATE, description: "Makulerad betalning UTB-1 — Leverantör AB" },
        user.id
      )
    );

    const reversal = await loadVerification((result as { verificationId: string }).verificationId);
    expect(reversal.seriesCode).toBe("U");
    expect(reversal.verificationNumber).toBe(2);
    expect(reversal.reversesVerificationId).toBe(payment!.verificationId);
    expect(reversal.date).toBe(CANCEL_DATE);
    expectBalanced(reversal.rows);
    expect(reversal.rows).toEqual([
      { account: "1930", debit: 125, credit: 0 },
      { account: "2440", debit: 0, credit: 125 },
    ]);
  });

  it("burns no U number when the caller's transaction rolls back", async () => {
    const { user } = await setupPosting();
    const rows = [{ appliedAmount: 125, writeOffAmount: 0 }];

    await expect(
      db.transaction(async (tx) => {
        await poster.postSupplierPayment(tx, SUPPLIER_PAYMENT_DOC, rows, user.id);
        throw new Error("consumer failed after posting");
      })
    ).rejects.toThrow("consumer failed after posting");

    expect(await db.select().from(verifications)).toHaveLength(0);
    expect(await db.select().from(verificationSeries)).toHaveLength(0);
    expect(await db.select().from(verificationCounters)).toHaveLength(0);

    const retried = await db.transaction((tx) => poster.postSupplierPayment(tx, SUPPLIER_PAYMENT_DOC, rows, user.id));
    expect(retried!.displayNumber).toBe(`U-${FISCAL_YEAR_LABEL}-1`);
  });
});

// Momsomföring (B5): the settle path computes each configured VAT account's
// net movement over the declared range and hands the poster a movement list;
// the poster mirrors every net onto the account (emptying it) and puts the
// sum on redovisningskontot för moms (2650). Sign convention: net =
// Σdebit − Σkredit, so utgående moms arrives negative (credit-normal) and
// ingående moms positive — a payable period nets 2650 on the credit side, a
// momsfordran on the debit side, out of the same arithmetic.
describe("verification poster — vat settlement", () => {
  const SETTLEMENT_FROM = `${CURRENT_YEAR}-03-01`;
  const SETTLEMENT_TO = `${CURRENT_YEAR}-03-31`;
  const SETTLEMENT_DOC = {
    fromDate: SETTLEMENT_FROM,
    toDate: SETTLEMENT_TO,
    movements: [
      { accountNumber: "2610", net: -1000 },
      { accountNumber: "2640", net: 400 },
    ],
  };

  it("books a balanced M verification on the range's end date, netting the accounts onto 2650", async () => {
    const { user } = await setupPosting();

    const result = await db.transaction((tx) => poster.postVatSettlement(tx, SETTLEMENT_DOC, user.id));

    expect(result.displayNumber).toBe(`M-${FISCAL_YEAR_LABEL}-1`);
    const verification = await loadVerification(result.verificationId);
    expect(verification.seriesCode).toBe("M");
    expect(verification.status).toBe("booked");
    expect(verification.date).toBe(SETTLEMENT_TO);
    expect(verification.description).toBe(`Momsredovisning ${SETTLEMENT_FROM} – ${SETTLEMENT_TO}`);
    expectBalanced(verification.rows);
    expect(byAccount(verification.rows)).toEqual({
      "2610": { debit: 1000, credit: 0 },
      "2640": { debit: 0, credit: 400 },
      "2650": { debit: 0, credit: 600 },
    });
  });

  it("a momsfordran period nets 2650 on the debit side", async () => {
    const { user } = await setupPosting();

    const result = await db.transaction((tx) =>
      poster.postVatSettlement(
        tx,
        {
          ...SETTLEMENT_DOC,
          movements: [
            { accountNumber: "2610", net: -100 },
            { accountNumber: "2640", net: 400 },
          ],
        },
        user.id
      )
    );

    const verification = await loadVerification(result.verificationId);
    expectBalanced(verification.rows);
    expect(byAccount(verification.rows)["2650"]).toEqual({ debit: 300, credit: 0 });
  });

  it("in- and outgoing VAT that cancel exactly book two rows and no 2650 row at all", async () => {
    const { user } = await setupPosting();

    const result = await db.transaction((tx) =>
      poster.postVatSettlement(
        tx,
        {
          ...SETTLEMENT_DOC,
          movements: [
            { accountNumber: "2610", net: -400 },
            { accountNumber: "2640", net: 400 },
          ],
        },
        user.id
      )
    );

    const verification = await loadVerification(result.verificationId);
    expectBalanced(verification.rows);
    expect(byAccount(verification.rows)).toEqual({
      "2610": { debit: 400, credit: 0 },
      "2640": { debit: 0, credit: 400 },
    });
  });

  it("skips accounts whose net movement is zero", async () => {
    const { user } = await setupPosting();

    const result = await db.transaction((tx) =>
      poster.postVatSettlement(
        tx,
        {
          ...SETTLEMENT_DOC,
          movements: [
            { accountNumber: "2610", net: -1000 },
            { accountNumber: "2620", net: 0 },
            { accountNumber: "2640", net: 400 },
          ],
        },
        user.id
      )
    );

    const verification = await loadVerification(result.verificationId);
    expect(Object.keys(byAccount(verification.rows)).sort()).toEqual(["2610", "2640", "2650"]);
  });

  it("throws ZeroAmountPostingError when every movement nets zero (nothing to omföra)", async () => {
    const { user } = await setupPosting();

    await expect(
      db.transaction((tx) =>
        poster.postVatSettlement(
          tx,
          { ...SETTLEMENT_DOC, movements: [{ accountNumber: "2610", net: 0 }] },
          user.id
        )
      )
    ).rejects.toBeInstanceOf(ZeroAmountPostingError);
    await expect(
      db.transaction((tx) => poster.postVatSettlement(tx, { ...SETTLEMENT_DOC, movements: [] }, user.id))
    ).rejects.toBeInstanceOf(ZeroAmountPostingError);

    expect(await db.select().from(verifications)).toHaveLength(0);
  });

  it("creates the M series lazily and numbers consecutively", async () => {
    const { user } = await setupPosting();

    const first = await db.transaction((tx) => poster.postVatSettlement(tx, SETTLEMENT_DOC, user.id));
    const second = await db.transaction((tx) =>
      poster.postVatSettlement(
        tx,
        { ...SETTLEMENT_DOC, fromDate: `${CURRENT_YEAR}-04-01`, toDate: `${CURRENT_YEAR}-04-30` },
        user.id
      )
    );

    expect(first.displayNumber).toBe(`M-${FISCAL_YEAR_LABEL}-1`);
    expect(second.displayNumber).toBe(`M-${FISCAL_YEAR_LABEL}-2`);
    const series = await db.select().from(verificationSeries);
    expect(series).toHaveLength(1);
    expect(series[0]!.code).toBe("M");
    expect(series[0]!.name).toBe("Momsredovisning");
  });

  it("rejects a range whose end date lies in a locked period, writing nothing", async () => {
    const { user } = await setupPosting();
    const period = await repo.findPeriodForDate(SETTLEMENT_TO);
    await service.lockPeriod(period!.id, user.id);

    await expect(
      db.transaction((tx) => poster.postVatSettlement(tx, SETTLEMENT_DOC, user.id))
    ).rejects.toBeInstanceOf(AccountingPeriodLockedError);

    expect(await db.select().from(verifications)).toHaveLength(0);
  });

  it("rejects a missing/unseeded settlement account (MissingPostingAccountError)", async () => {
    const { user } = await setupPosting();
    postingSettings = { ...postingSettings, postingVatSettlement: "9998" };

    const error = await db
      .transaction((tx) => poster.postVatSettlement(tx, SETTLEMENT_DOC, user.id))
      .then(() => null)
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(MissingPostingAccountError);
    expect((error as MissingPostingAccountError).accountNumber).toBe("9998");
  });

  it("writes the audit entry through the caller's tx with source vat_settlement", async () => {
    const { user } = await setupPosting();

    const result = await db.transaction((tx) => poster.postVatSettlement(tx, SETTLEMENT_DOC, user.id));

    const entries = await db.select().from(auditLog).where(eq(auditLog.entityType, "verification"));
    expect(entries).toHaveLength(1);
    expect(entries[0]!.entityId).toBe(result.displayNumber);
    expect(entries[0]!.detail).toMatchObject({
      source: "vat_settlement",
      document: `${SETTLEMENT_FROM}–${SETTLEMENT_TO}`,
    });
  });
});

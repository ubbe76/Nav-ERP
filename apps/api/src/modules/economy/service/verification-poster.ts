import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";
import {
  accountingPeriods,
  accounts,
  auditLog,
  fiscalYears,
  postingRules,
  verificationRows,
  verifications,
  verificationSeries,
  type Db,
  type Tx,
} from "@navet/db";
import { isVatRate, round2, type VatRate } from "@navet/shared";
import { AccountingPeriodLockedError, FiscalYearClosedError } from "./accounting-period-lock.js";
import { disposalPostingRows } from "./depreciation-schedule.js";
import { allocateVerificationNumber } from "./verification-number.js";

// Automatkontering (B2/B3): turns a customer/supplier invoice, a customer
// payment or a reminder fee into a BOOKED verification. Every function here is
// Tx-composable by design — the consumer (sales' issueInvoice, purchase's
// approve/cancel, sales' payment registration and reminder sending) calls it
// from INSIDE its own status-flip transaction, so the verification, the
// verifikatnummer and the document's status change either all commit or all
// roll back (BFL: obruten verifikatserie, append-only bokföring). Same seam as
// stock's resolveStockLocation and this module's own
// allocateVerificationNumber.
//
// Leaf-style on purpose: nothing is imported from economy.service.ts (which
// imports the repository), so consumers can depend on the poster without
// dragging the whole economy module in — they import the error classes from
// here directly.

// --- Verifikatserier owned by the auto-posting ---
// Lazily created inside the caller's transaction (ON CONFLICT DO NOTHING +
// re-select, the self-healing idiom from verification-number.ts): no seed
// migration, so a rolled-back posting takes the series with it and the test
// suites can truncate verification_series freely.
const CUSTOMER_INVOICE_SERIES = { code: "F", name: "Kundfakturor" } as const;
const SUPPLIER_INVOICE_SERIES = { code: "L", name: "Leverantörsfakturor" } as const;
// Kundreskontra (B3): payments and reminder fees share one series — both are
// events on an already invoiced receivable, and keeping them together makes
// the K series read as the customer ledger's own journal.
const CUSTOMER_LEDGER_SERIES = { code: "K", name: "Kundreskontra" } as const;
// Leverantörsreskontra (B4): the K series' mirror on the supplier side —
// payments OUT against an already booked leverantörsskuld. Its own series
// rather than more L verifications: L is the debt arising (an attested
// supplier invoice), U is the same debt being settled.
const SUPPLIER_LEDGER_SERIES = { code: "U", name: "Leverantörsreskontra" } as const;
// Momsrapport (B5): momsomföringar get their own journal — an M verification
// is the period's VAT declaration event, not a document posting.
const VAT_SETTLEMENT_SERIES = { code: "M", name: "Momsredovisning" } as const;

// SIE opening-balance import (B6b): the imported balances become one booked
// verification of their own, so they show up in the ledger, the balance
// sheet and a later SIE export with no special-casing anywhere.
export const OPENING_BALANCE_SERIES = { code: "I", name: "Ingående balanser" } as const;

// Anläggningsregister (ekonomi etapp 2, delprojekt 2): depreciation runs,
// their undo reversals and disposal verifications share one journal —
// the register's own series, as K covers both payments and reminder fees.
const FIXED_ASSET_SERIES = { code: "AV", name: "Anläggningar" } as const;

// Årsbokslut (delprojekt 3): every verification the closing guide books —
// lagerförändring, periodiseringar and their reversal, resultatöverföring,
// vinstdisposition and the guide's own omföringar.
const YEAR_END_SERIES = { code: "BS", name: "Bokslut" } as const;

export type ClosingEntrySource =
  | "year_end_inventory"
  | "year_end_accruals"
  | "year_end_accrual_reversal"
  | "year_end_result_transfer"
  | "year_end_profit_disposition";

// verifications.description is varchar(255), and a customer/supplier name is
// varchar(255) on its own — a long partner name would otherwise abort the
// whole invoicing transaction with a raw 22001.
const DESCRIPTION_MAX_LENGTH = 255;

// --- Errors (mapped to 409 by the consuming routes) ---

// The account number a posting role resolves to does not exist in the chart
// of accounts, or exists but is inactive. Carries both the number and the
// role so the message can name what to fix ("2610 / outgoing VAT 25 %").
export class MissingPostingAccountError extends Error {
  constructor(
    public accountNumber: string,
    public roleLabel: string
  ) {
    super(`Posting account ${accountNumber} (${roleLabel}) is missing or inactive`);
    this.name = "MissingPostingAccountError";
  }
}

// A document row carries a VAT rate outside the Swedish set {25, 12, 6, 0} —
// there is no VAT account for it, and silently posting it somewhere else
// would be a mis-posting.
export class UnknownVatRateError extends Error {
  constructor(public rate: number) {
    super(`No VAT account is configured for rate ${rate}`);
    this.name = "UnknownVatRateError";
  }
}

// The supplier invoice's header amounts are typed in by hand from the paper
// invoice and are authoritative for the posting — so they must at least add
// up before they become a verification.
export class SupplierInvoiceAmountMismatchError extends Error {
  constructor(
    public net: number,
    public vat: number,
    public gross: number
  ) {
    super(`Supplier invoice amounts do not add up: net ${net} + VAT ${vat} != gross ${gross}`);
    this.name = "SupplierInvoiceAmountMismatchError";
  }
}

// Foreign-currency supplier invoices are converted to SEK by hand at
// registration (B2 has no currency conversion) — posting one as-is would put
// foreign amounts in the ledger.
export class NonSekSupplierInvoiceError extends Error {
  constructor(public currency: string) {
    super(`Supplier invoices in ${currency} cannot be posted — only SEK is supported`);
    this.name = "NonSekSupplierInvoiceError";
  }
}

// A customer payment's bank amount does not equal what its rows settle. That
// sum is exactly the condition under which the payment verification balances
// (bank +B, receivable −Σ(applied + writeOff), write-off +Σ writeOff → net
// B − Σ applied), so the poster states it as its own precondition instead of
// letting a caller bug reach insertBookedVerification's asserts — which are
// plain Errors (a 500 with a programming-error message) and would, for a
// single-account payment, be the only thing between a bad caller and a
// one-row verification. Unreachable through the payment service, which
// validates the same identity before it opens its transaction.
export class PaymentAmountMismatchError extends Error {
  constructor(
    public bankAmount: number,
    public appliedTotal: number
  ) {
    super(`Payment bank amount ${bankAmount} does not equal the applied total ${appliedTotal}`);
    this.name = "PaymentAmountMismatchError";
  }
}

// Two roles in the SAME posting point at one account, so a real movement
// would net itself away instead of being booked. The account picker offers
// every active account, so picking accounts receivable (1510) as the
// betalkonto is one click — and the remaining contributions can still balance
// on their own (1510 as betalkonto WITH a write-off leaves a tidy
// 1510/3740 pair and no bank row at all), which is exactly what makes it
// dangerous: the ledger effect looks legitimate while the money that hit the
// bank never enters the books. The reminder fee's own degenerate setting (fee
// account = accounts receivable) is the same failure with the same remedy.
// Rejected instead, naming the account to change.
export class PaymentBankAccountConflictError extends Error {
  constructor(
    public accountNumber: string,
    // Which role picked the colliding account. Defaults to the payment's
    // betalkonto — the case this error was written for, and the only one a
    // user picks per document rather than in the posting settings.
    public roleLabel = "payment bank account"
  ) {
    super(`The ${roleLabel} ${accountNumber} cancels the posting's own rows — choose another account`);
    this.name = "PaymentBankAccountConflictError";
  }
}

// No accounting period (and therefore no fiscal year) covers the document
// date. Distinct from AccountingPeriodLockedError, which means the period
// exists but is closed.
export class NoAccountingPeriodForPostingError extends Error {
  constructor(public date: string) {
    super(`No accounting period covers date ${date}`);
    this.name = "NoAccountingPeriodForPostingError";
  }
}

// A document that nets to zero has nothing to post — booking it would
// produce a verification with no rows at all.
export class ZeroAmountPostingError extends Error {
  constructor() {
    super("Cannot post a document with a zero total amount");
    this.name = "ZeroAmountPostingError";
  }
}

// --- Input/settings shapes ---

// The 14 posting accounts, as 4-digit account-number strings. Structurally
// satisfied by system/service/posting-settings.js's PostingSettings (whose
// codeSetting fallbacks guarantee every field is populated) — declared here,
// at the consumer, same DI convention as CostingSettingsReader/
// DocumentSettingsReader. Db|Tx-composable: read() is called with the
// CALLER's own transaction (postCustomerInvoice/postSupplierInvoice below),
// so the settings read lands on the same connection as the rest of the
// posting rather than a separate round trip outside the tx.
export interface PostingSettingsReader {
  read(executor: Db | Tx): Promise<PostingAccountNumbers>;
}

export interface PostingAccountNumbers {
  postingAccountsReceivable: string;
  postingVatOut25: string;
  postingVatOut12: string;
  postingVatOut6: string;
  postingRevenue25: string;
  postingRevenue12: string;
  postingRevenue6: string;
  postingRevenue0: string;
  postingAccountsPayable: string;
  postingVatIn: string;
  postingDefaultCost: string;
  // Kundreskontra (B3). postingReminderFeeAccount and postingPaymentWriteOff
  // are read by postReminderFee/postCustomerPayment below; postingBank is
  // NOT — the betalkonto is chosen per payment and travels on the document
  // (CustomerPaymentDocument.bankAccountNumber), the setting only supplies
  // the registration form's default. It stays on this type because read()
  // returns the whole posting-settings surface every time.
  postingBank: string;
  postingReminderFeeAccount: string;
  postingPaymentWriteOff: string;
  // Momsrapport (B5): redovisningskonto för moms — postVatSettlement's
  // counter account.
  postingVatSettlement: string;
  // Årsbokslut (steg 2): read by the year-end service, not by the poster.
  postingInventory: string;
  postingInventoryChange: string;
}

export type CustomerInvoiceDocument = {
  invoiceNumber: string;
  type: "invoice" | "credit";
  invoiceDate: string;
  customerName: string;
};

// articleGroupId comes from the invoice row's article (null for free-text
// rows and for articles without a group).
export type CustomerInvoiceDocumentRow = {
  articleGroupId: string | null;
  lineAmount: number;
  vatAmount: number;
  vatRate: number;
};

export type SupplierInvoiceDocument = {
  registrationNumber: string;
  invoiceNumber: string;
  supplierName: string;
  invoiceDate: string;
  currency: string;
  netAmount: number;
  vatAmount: number;
  grossAmount: number;
};

// vatRate is nullable here (supplier invoice rows carry no rate of their
// own — the VAT comes from the header); it is only a posting-rule lookup key.
export type SupplierInvoiceDocumentRow = {
  articleGroupId: string | null;
  vatRate: number | null;
  lineAmount: number;
};

// bankAccountNumber is the account the money actually landed on, picked per
// payment and snapshotted on the payment row — not a posting setting (see
// PostingAccountNumbers.postingBank). bankAmount is the bank part only: 0 for
// a pure kvittning between open items.
export type CustomerPaymentDocument = {
  paymentNumber: string;
  paymentDate: string;
  bankAccountNumber: string;
  bankAmount: number;
  customerName: string;
};

// One row per settled open item, both amounts signed: appliedAmount is
// positive when it settles an invoice and negative when it settles a credit
// note (kvittning), and writeOffAmount is the server-computed tolerance
// difference — positive = the customer underpaid and the rest is written off
// (öres- och kronutjämning debited), negative = the customer overpaid and the
// surplus is kept (credited).
export type CustomerPaymentDocumentRow = {
  appliedAmount: number;
  writeOffAmount: number;
};

// Leverantörsreskontra (B4), the mirror of CustomerPaymentDocument:
// bankAccountNumber is the account the money actually left from, picked per
// payment and snapshotted on the payment row (not a posting setting — see
// PostingAccountNumbers.postingBank), and bankAmount is the bank part only,
// 0 for a pure kvittning between open items.
export type SupplierPaymentDocument = {
  paymentNumber: string;
  paymentDate: string;
  bankAccountNumber: string;
  bankAmount: number;
  supplierName: string;
};

// One row per settled open item, both amounts signed and read in the supplier
// direction: appliedAmount is positive when it settles an ordinary supplier
// invoice (money out) and negative when it settles a supplier credit note
// (kvittning), and writeOffAmount is the server-computed tolerance difference —
// positive = we paid less than the invoice and the remainder is written off,
// negative = we paid more and the surplus is written off the other way.
export type SupplierPaymentDocumentRow = {
  appliedAmount: number;
  writeOffAmount: number;
};

// Momsomföring (B5). The CALLER (vat-report service) computes each
// configured VAT account's net movement (Σdebit − Σkredit over the declared
// range, prior settlements and their reversals excluded) inside the same tx
// — this stays a pure posting leaf like its siblings. Positive net = the
// account currently sits on the debit side (ingående moms), negative =
// credit side (utgående moms).
export type VatSettlementDocument = {
  fromDate: string;
  toDate: string;
  movements: { accountNumber: string; net: number }[];
};

export type InvoiceReminderDocument = {
  invoiceNumber: string;
  reminderDate: string;
  customerName: string;
  feeAmount: number;
};

// One contribution per tillgångsgrupp: debet kostnadskonto, kredit ack-konto.
// Accounts come as IDs (the category's FK columns), not numbers.
export type DepreciationDocument = {
  date: string;
  description: string;
  rows: { expenseAccountId: string; accumulatedAccountId: string; amount: number }[];
};

// Avyttring: kredit tillgångskonto (anskaffningsvärdet), debet ack-konto,
// debet mellankonto (priset), kredit vinst / debet förlust — rows from
// disposalPostingRows, so the preview and the posting can never disagree.
// accumulatedDepreciation includes the opening amount (ingående avskrivning).
export type FixedAssetDisposalDocument = {
  date: string;
  assetNumber: string;
  assetName: string;
  disposalType: "sale" | "scrap";
  accounts: { asset: string; accumulated: string; gain: string; loss: string; intermediate: string | null };
  acquisitionCost: number;
  accumulatedDepreciation: number;
  disposalPrice: number;
};

// --- Internal shapes ---

type PostingRow = { accountId: string; debit: number; credit: number };

type PostingHeader = {
  series: { id: string; code: string };
  date: string;
  description: string;
  reversesVerificationId?: string;
};

// What the audit entry says the verification came from.
type PostingAuditContext = { source: string; document: string };

type LoadedPostingRule = {
  articleGroupId: string;
  vatRate: string | null;
  revenueAccountId: string | null;
  costAccountId: string | null;
};

// --- Amount construction ---

// Signed accumulator: one net amount per account, positive = debit and
// negative = credit. Credit invoices (every contribution mirrored), negative
// supplier remainders and two document rows landing on the same account all
// fall out of the same arithmetic — the debit/credit split happens exactly
// once, at the end, which is also what keeps the XOR check satisfiable.
function createAmountAccumulator() {
  const netByAccount = new Map<string, number>();
  return {
    add(accountId: string, amount: number) {
      netByAccount.set(accountId, round2((netByAccount.get(accountId) ?? 0) + amount));
    },
    // Map preserves insertion order, so rows come out in the order the
    // document was walked (balance account first, then its rows).
    toRows(): PostingRow[] {
      const rows: PostingRow[] = [];
      for (const [accountId, net] of netByAccount) {
        // An account whose contributions cancel out is no row at all — a zero
        // row would violate the debit-XOR-credit check anyway.
        if (net === 0) continue;
        rows.push({ accountId, debit: net > 0 ? net : 0, credit: net < 0 ? -net : 0 });
      }
      return rows;
    },
  };
}

// --- Account and rule lookup ---

// Settings hold account NUMBERS; verification rows need account ids. Read
// through the caller's tx so an account deactivated earlier in the same
// transaction is seen, and cached per posting since several roles/rows share
// accounts.
// Db|Tx-composable for the same reason assertPostablePeriod above is: the
// posting paths pass their own transaction, the pre-flight helpers ask the
// same question outside one.
function createPostingAccountResolver(executor: Db | Tx) {
  const idByNumber = new Map<string, string>();
  return async function resolveAccount(number: string, roleLabel: string): Promise<string> {
    const cached = idByNumber.get(number);
    if (cached) return cached;

    const [account] = await executor
      .select({ id: accounts.id, active: accounts.active })
      .from(accounts)
      .where(eq(accounts.number, number));
    if (!account || !account.active) throw new MissingPostingAccountError(number, roleLabel);

    idByNumber.set(number, account.id);
    return account.id;
  };
}

// Konteringsregler for the document's article groups: ONE inArray select, all
// matching done in memory (a document has a handful of groups at most, and
// this runs inside someone else's transaction — keep the round trips down).
// The rules' own accounts are loaded in a second batched select so an account
// deactivated after the rule was written can be rejected instead of silently
// entering the ledger.
async function createRuleAccountResolver(tx: Tx, documentRows: { articleGroupId: string | null }[]) {
  const groupIds = [...new Set(documentRows.map((row) => row.articleGroupId).filter((id): id is string => id !== null))];
  const rules: LoadedPostingRule[] =
    groupIds.length === 0
      ? []
      : await tx
          .select({
            articleGroupId: postingRules.articleGroupId,
            vatRate: postingRules.vatRate,
            revenueAccountId: postingRules.revenueAccountId,
            costAccountId: postingRules.costAccountId,
          })
          .from(postingRules)
          .where(inArray(postingRules.articleGroupId, groupIds));

  const ruleAccountIds = [
    ...new Set(
      rules.flatMap((rule) => [rule.revenueAccountId, rule.costAccountId]).filter((id): id is string => id !== null)
    ),
  ];
  const ruleAccounts =
    ruleAccountIds.length === 0
      ? []
      : await tx
          .select({ id: accounts.id, number: accounts.number, active: accounts.active })
          .from(accounts)
          .where(inArray(accounts.id, ruleAccountIds));
  const accountById = new Map(ruleAccounts.map((account) => [account.id, account] as const));

  // Resolution order (spec): rule (group, rate) -> rule (group, all rates) ->
  // null, meaning "use the settings default". A rule that has no account for
  // THIS side (revenue-only/cost-only rules are legal) falls through to the
  // next step rather than blocking.
  return function ruleAccount(
    articleGroupId: string | null,
    vatRate: number | null,
    side: "revenue" | "cost",
    roleLabel: string
  ): string | null {
    if (articleGroupId === null) return null;
    const pick = (rule: LoadedPostingRule) => (side === "revenue" ? rule.revenueAccountId : rule.costAccountId);

    const candidates: (string | null)[] = [];
    if (vatRate !== null) {
      const exact = rules.find(
        (rule) => rule.articleGroupId === articleGroupId && rule.vatRate !== null && Number(rule.vatRate) === vatRate
      );
      if (exact) candidates.push(pick(exact));
    }
    const catchAll = rules.find((rule) => rule.articleGroupId === articleGroupId && rule.vatRate === null);
    if (catchAll) candidates.push(pick(catchAll));

    for (const accountId of candidates) {
      if (accountId === null) continue;
      const account = accountById.get(accountId);
      // Unreachable: posting_rules' account FKs are ON DELETE restrict.
      if (!account) throw new Error(`Posting rule references unknown account ${accountId}`);
      // An inactive account gets the same error as a missing settings account:
      // B1 refuses to book manual rows on inactive accounts, and the automatic
      // path must not be a way around that.
      if (!account.active) throw new MissingPostingAccountError(account.number, roleLabel);
      return accountId;
    }
    return null;
  };
}

// Rate → settings-field maps (B5): keyed by the shared VatRate union, so a
// fifth rate added to vatRates refuses to compile until its account wiring
// exists here. 0 % deliberately has no outgoing VAT entry — a zero-rated row
// posts no VAT row at all.
const OUTGOING_VAT_SETTING_BY_RATE: Record<Exclude<VatRate, 0>, keyof PostingAccountNumbers> = {
  25: "postingVatOut25",
  12: "postingVatOut12",
  6: "postingVatOut6",
};

const REVENUE_SETTING_BY_RATE: Record<VatRate, keyof PostingAccountNumbers> = {
  25: "postingRevenue25",
  12: "postingRevenue12",
  6: "postingRevenue6",
  0: "postingRevenue0",
};

// Utgående moms per rate. 0 % has no VAT row at all (returns null); anything
// outside the Swedish set is a data error. Called once per document row, so
// it doubles as the rate validation.
function outgoingVatAccountNumber(rate: number, settings: PostingAccountNumbers): string | null {
  if (!isVatRate(rate)) throw new UnknownVatRateError(rate);
  if (rate === 0) return null;
  return settings[OUTGOING_VAT_SETTING_BY_RATE[rate]];
}

function defaultRevenueAccountNumber(rate: number, settings: PostingAccountNumbers): string {
  if (!isVatRate(rate)) throw new UnknownVatRateError(rate);
  return settings[REVENUE_SETTING_BY_RATE[rate]];
}

// Exported for its unit test. Truncates by CODE POINTS (Array.from), which is
// both what varchar(255) actually counts and what keeps a surrogate pair
// (emoji) from being split at the boundary into a lone surrogate.
export function truncateDescription(text: string): string {
  if (text.length <= DESCRIPTION_MAX_LENGTH) return text;
  const chars = Array.from(text);
  return chars.length <= DESCRIPTION_MAX_LENGTH ? text : chars.slice(0, DESCRIPTION_MAX_LENGTH).join("");
}

// --- Series + the booking itself ---

// Get-or-create inside the caller's transaction. A concurrent creator wins
// the unique index and this one simply re-selects its row (the insert blocks
// until that transaction commits, then does nothing) — same self-healing
// shape as the verification counter's lazy materialization.
async function ensureSeries(tx: Tx, series: { code: string; name: string }): Promise<{ id: string; code: string }> {
  const find = () =>
    tx
      .select({ id: verificationSeries.id, code: verificationSeries.code })
      .from(verificationSeries)
      .where(eq(verificationSeries.code, series.code));

  let [row] = await find();
  if (!row) {
    await tx
      .insert(verificationSeries)
      .values({ code: series.code, name: series.name })
      .onConflictDoNothing({ target: verificationSeries.code });
    [row] = await find();
  }
  if (!row) throw new Error(`verification series ${series.code} could not be materialized`);
  return row;
}

// "May something be booked on this date at all?" — no period covering it and
// a locked period are different errors (same query shape as
// economy.repository.ts's in-tx re-check). Takes a Db or a Tx: the write path
// below calls it inside the caller's transaction, the pre-flight helpers call
// it outside one, before something irreversible happens.
export async function assertPostablePeriod(executor: Db | Tx, date: string): Promise<void> {
  const [period] = await executor
    .select({ status: accountingPeriods.status, yearStatus: fiscalYears.status })
    .from(accountingPeriods)
    .innerJoin(fiscalYears, eq(fiscalYears.id, accountingPeriods.fiscalYearId))
    .where(and(lte(accountingPeriods.startDate, date), gte(accountingPeriods.endDate, date)));
  if (!period) throw new NoAccountingPeriodForPostingError(date);
  if (period.yearStatus === "closed") throw new FiscalYearClosedError(date);
  if (period.status === "locked") throw new AccountingPeriodLockedError(date);
}

// By-ID sibling of createPostingAccountResolver for the fixed-asset
// postings, whose accounts are the category's FK columns. Missing and
// inactive are the same misconfiguration here; the error names the number
// when the row exists so the message points at the right account.
async function requireActiveAccountById(executor: Db | Tx, accountId: string, roleLabel: string): Promise<void> {
  const [account] = await executor
    .select({ number: accounts.number, active: accounts.active })
    .from(accounts)
    .where(eq(accounts.id, accountId));
  if (!account || !account.active) throw new MissingPostingAccountError(account?.number ?? accountId, roleLabel);
}

// The single write path: everything the poster produces is a BOOKED
// verification with a number — there is no draft stage and no code path that
// inserts a verification without allocating one.
async function insertBookedVerification(
  tx: Tx,
  header: PostingHeader,
  rows: PostingRow[],
  audit: PostingAuditContext,
  userId: string
): Promise<{ verificationId: string; displayNumber: string }> {
  // Period status via the caller's tx. There is no TOCTOU window here — a
  // concurrent lock either committed before this read or waits behind this
  // transaction. (The pre-flight callers below run the same check OUTSIDE a
  // transaction, where the window is real but only shrinks the misconfiguration
  // case; this in-tx call stays the authority.)
  await assertPostablePeriod(tx, header.date);

  // Periods only exist inside a fiscal year, so a covering period implies a
  // covering year — the guard is for the impossible case (a period whose year
  // was edited out from under it) and reports it as the same missing-period
  // condition rather than crashing on a null.
  const [year] = await tx
    .select({ id: fiscalYears.id, label: fiscalYears.label })
    .from(fiscalYears)
    .where(and(lte(fiscalYears.startDate, header.date), gte(fiscalYears.endDate, header.date)));
  if (!year) throw new NoAccountingPeriodForPostingError(header.date);

  // Balance assert. Unreachable by construction (the signed accumulator can
  // only produce a balanced set), hence plain Errors: these are programming
  // errors, not user-facing 409s — but a silently unbalanced verification
  // would be an accounting-law problem, so they are checked anyway.
  if (rows.length < 2) throw new Error(`Refusing to book a verification with ${rows.length} row(s)`);
  const totalDebit = round2(rows.reduce((sum, row) => sum + row.debit, 0));
  const totalCredit = round2(rows.reduce((sum, row) => sum + row.credit, 0));
  if (totalDebit !== totalCredit) {
    throw new Error(`Refusing to book an unbalanced verification: debit ${totalDebit} != credit ${totalCredit}`);
  }

  // Tx-only allocator: a failure anywhere after this point rolls the number
  // back with the rest of the caller's transaction.
  const verificationNumber = await allocateVerificationNumber(tx, header.series.id, year.id);

  const [verification] = await tx
    .insert(verifications)
    .values({
      seriesId: header.series.id,
      fiscalYearId: year.id,
      verificationNumber,
      date: header.date,
      description: header.description,
      status: "booked",
      reversesVerificationId: header.reversesVerificationId ?? null,
      // The user who triggered the document event owns the verification in
      // both roles — it is created and booked in the same instant.
      createdBy: userId,
      bookedBy: userId,
      bookedAt: new Date(),
    })
    .returning();

  // Explicit, strictly increasing createdAt per row: Postgres evaluates
  // now() once per transaction, so a multi-row insert would give every row
  // the same timestamp and leave the card's ORDER BY createdAt without a
  // tie-break (idiom from economy.repository.ts's createVerification).
  const now = Date.now();
  await tx.insert(verificationRows).values(
    rows.map((row, index) => ({
      verificationId: verification!.id,
      accountId: row.accountId,
      debit: String(row.debit),
      credit: String(row.credit),
      description: null,
      createdAt: new Date(now + index),
    }))
  );

  const displayNumber = `${header.series.code}-${year.label}-${verificationNumber}`;

  // Audit goes through the CALLER's tx rather than the AuditWriter interface
  // (which owns its own connection): the poster cannot know when the foreign
  // transaction commits, and an audit entry for a verification that ended up
  // rolled back would be a lie. Deliberate deviation from economy.service's
  // book(), which logs after its own commit.
  await tx.insert(auditLog).values({
    entityType: "verification",
    entityId: displayNumber,
    action: "booked",
    detail: { source: audit.source, document: audit.document },
    userId,
  });

  return { verificationId: verification!.id, displayNumber };
}

export function createVerificationPoster(settings: PostingSettingsReader) {
  return {
    // Kundfaktura -> series F, dated on the invoice date. Debit accounts
    // receivable with the gross, credit revenue per row (rule -> rule
    // catch-all -> settings default per rate) and credit outgoing VAT per
    // rate. A credit invoice mirrors every contribution — it is NOT a
    // reversal (no reversesVerificationId): the credit note is its own
    // document in its own right.
    async postCustomerInvoice(
      tx: Tx,
      doc: CustomerInvoiceDocument,
      rows: CustomerInvoiceDocumentRow[],
      userId: string
    ): Promise<{ verificationId: string; displayNumber: string }> {
      // Settings are read through the CALLER's own tx — one extra query on
      // the same connection as the rest of the posting, not a separate round
      // trip on its own connection outside the transaction boundary.
      const postingAccounts = await settings.read(tx);

      // Normalize to öre ONCE: the accumulator then only ever sums 2-decimal
      // values, so the gross can never drift a cent away from the sum of the
      // contributions and the balance assert cannot fire on rounding.
      const documentRows = rows.map((row) => ({
        articleGroupId: row.articleGroupId,
        lineAmount: round2(row.lineAmount),
        vatAmount: round2(row.vatAmount),
        vatRate: row.vatRate,
      }));

      const gross = round2(documentRows.reduce((sum, row) => sum + row.lineAmount + row.vatAmount, 0));
      if (gross === 0) throw new ZeroAmountPostingError();

      const sign = doc.type === "credit" ? -1 : 1;
      const resolveAccount = createPostingAccountResolver(tx);
      const ruleAccount = await createRuleAccountResolver(tx, documentRows);
      const amounts = createAmountAccumulator();

      amounts.add(await resolveAccount(postingAccounts.postingAccountsReceivable, "accounts receivable"), sign * gross);

      for (const row of documentRows) {
        // Also validates the rate: an unknown one throws before anything is
        // resolved. A 0 % row has no VAT account — a 0 % row carrying VAT
        // would be contradictory input and the balance assert catches it.
        const vatAccountNumber = outgoingVatAccountNumber(row.vatRate, postingAccounts);

        const ruleRevenue = ruleAccount(row.articleGroupId, row.vatRate, "revenue", "posting rule revenue account");
        const revenueAccountId =
          ruleRevenue ??
          (await resolveAccount(defaultRevenueAccountNumber(row.vatRate, postingAccounts), `revenue ${row.vatRate} %`));
        amounts.add(revenueAccountId, -sign * row.lineAmount);

        if (vatAccountNumber !== null) {
          const vatAccountId = await resolveAccount(vatAccountNumber, `outgoing VAT ${row.vatRate} %`);
          amounts.add(vatAccountId, -sign * row.vatAmount);
        }
      }

      const series = await ensureSeries(tx, CUSTOMER_INVOICE_SERIES);
      const label = doc.type === "credit" ? "Kreditfaktura" : "Kundfaktura";
      return insertBookedVerification(
        tx,
        {
          series,
          date: doc.invoiceDate,
          // Swedish, like every other user-facing string — this is what the
          // verification list is searched by.
          description: truncateDescription(`${label} ${doc.invoiceNumber} — ${doc.customerName}`),
        },
        amounts.toRows(),
        { source: "customer_invoice", document: doc.invoiceNumber },
        userId
      );
    },

    // Leverantörsfaktura -> series L, dated on the SUPPLIER's invoice date
    // (that is what decides the period). The header amounts are authoritative:
    // credit accounts payable with the gross, debit incoming VAT with the
    // header VAT, debit the cost accounts per row, and put whatever the rows
    // do not explain (freight, fees, öresavrundning) on the default cost
    // account — signed, so rows exceeding the header net become a credit.
    async postSupplierInvoice(
      tx: Tx,
      doc: SupplierInvoiceDocument,
      rows: SupplierInvoiceDocumentRow[],
      userId: string
    ): Promise<{ verificationId: string; displayNumber: string }> {
      if (doc.currency !== "SEK") throw new NonSekSupplierInvoiceError(doc.currency);

      const net = round2(doc.netAmount);
      const vat = round2(doc.vatAmount);
      const gross = round2(doc.grossAmount);
      // The header amounts are typed in from the paper invoice and are not
      // validated anywhere else today — check them before they become ledger
      // entries that no longer balance against the supplier debt.
      if (round2(net + vat) !== gross) throw new SupplierInvoiceAmountMismatchError(net, vat, gross);
      if (gross === 0) throw new ZeroAmountPostingError();

      // Same in-tx read as postCustomerInvoice above.
      const postingAccounts = await settings.read(tx);
      const documentRows = rows.map((row) => ({
        articleGroupId: row.articleGroupId,
        vatRate: row.vatRate,
        lineAmount: round2(row.lineAmount),
      }));

      const resolveAccount = createPostingAccountResolver(tx);
      const ruleAccount = await createRuleAccountResolver(tx, documentRows);
      const amounts = createAmountAccumulator();

      amounts.add(await resolveAccount(postingAccounts.postingAccountsPayable, "accounts payable"), -gross);
      if (vat !== 0) {
        amounts.add(await resolveAccount(postingAccounts.postingVatIn, "incoming VAT"), vat);
      }

      for (const row of documentRows) {
        const ruleCost = ruleAccount(row.articleGroupId, row.vatRate, "cost", "posting rule cost account");
        const costAccountId =
          ruleCost ?? (await resolveAccount(postingAccounts.postingDefaultCost, "default cost account"));
        amounts.add(costAccountId, row.lineAmount);
      }

      const rowTotal = round2(documentRows.reduce((sum, row) => sum + row.lineAmount, 0));
      const remainder = round2(net - rowTotal);
      if (remainder !== 0) {
        const defaultCostAccountId = await resolveAccount(postingAccounts.postingDefaultCost, "default cost account");
        amounts.add(defaultCostAccountId, remainder);
      }

      const series = await ensureSeries(tx, SUPPLIER_INVOICE_SERIES);
      return insertBookedVerification(
        tx,
        {
          series,
          date: doc.invoiceDate,
          description: truncateDescription(
            `Leverantörsfaktura ${doc.registrationNumber} (${doc.invoiceNumber}) — ${doc.supplierName}`
          ),
        },
        amounts.toRows(),
        { source: "supplier_invoice", document: doc.registrationNumber },
        userId
      );
    },

    // Kundbetalning -> series K, dated on the payment date. Debit the payment's
    // own bank account with what actually hit the bank, credit accounts
    // receivable with everything the payment settles (applied + write-off per
    // row, signed — a credit-note row settles negatively) and put the tolerance
    // difference on öres- och kronutjämning. The signed accumulator covers
    // every combination: underpayment, overpayment, kvittning and mixes of
    // them are the same arithmetic, no special cases.
    //
    // Returns null when the payment moves nothing in the ledger — see the
    // netting check below.
    async postCustomerPayment(
      tx: Tx,
      doc: CustomerPaymentDocument,
      rows: CustomerPaymentDocumentRow[],
      userId: string
    ): Promise<{ verificationId: string; displayNumber: string } | null> {
      // Same in-tx settings read as the invoice postings above.
      const postingAccounts = await settings.read(tx);

      // Normalize to öre ONCE (postCustomerInvoice's rationale): the
      // accumulator then only ever sums 2-decimal values, so the bank amount
      // cannot drift a cent away from the sum of the contributions.
      const bankAmount = round2(doc.bankAmount);
      const paymentRows = rows.map((row) => ({
        appliedAmount: round2(row.appliedAmount),
        writeOffAmount: round2(row.writeOffAmount),
      }));

      // The balance precondition, stated where it can still be a typed error.
      const appliedTotal = round2(paymentRows.reduce((sum, row) => sum + row.appliedAmount, 0));
      if (bankAmount !== appliedTotal) throw new PaymentAmountMismatchError(bankAmount, appliedTotal);

      const resolveAccount = createPostingAccountResolver(tx);
      const amounts = createAmountAccumulator();

      // The two accounts the payment contributes NEGATIVE amounts to are
      // resolved before anything is added, so the bank account below can be
      // checked against both while the accumulator is still empty. Rows whose
      // write-offs cancel each other out (one under-, one overpayment) leave
      // no write-off row at all — and then there is no write-off account to
      // collide with either, which is why the resolve is conditional.
      const receivableAccountId = await resolveAccount(postingAccounts.postingAccountsReceivable, "accounts receivable");
      const writeOffTotal = round2(paymentRows.reduce((sum, row) => sum + row.writeOffAmount, 0));
      const writeOffAccountId =
        writeOffTotal === 0
          ? null
          : await resolveAccount(
              postingAccounts.postingPaymentWriteOff,
              "payment write-off (öres- och kronutjämning)"
            );

      // öres- och kronutjämning pointed at the receivable itself absorbs the
      // write-off silently: the +writeOffTotal lands on the very account the
      // rows credited −(applied + writeOff), so 1510 is reduced by what was
      // PAID while the derived open amount treats the item as fully settled.
      // The verification balances, has a bank row and looks entirely correct —
      // but the written-off residue stays on the receivable for ever with no
      // 3740 row to explain it. Same silent-omission family as the betalkonto
      // conflicts below and the reminder fee's fee-account check, and B3's
      // known residual; reported as the settings mistake it is. Conditional by
      // construction (null when writeOffTotal is 0, and null is never an
      // account id): a retired write-off account must not block payments that
      // produce no write-off at all.
      if (writeOffAccountId === receivableAccountId) {
        throw new PaymentBankAccountConflictError(postingAccounts.postingPaymentWriteOff, "payment write-off account");
      }

      // A pure kvittning never touches the bank, so the account is not even
      // resolved: a retired betalkonto on the payment must not block a netting
      // that does not use it.
      if (bankAmount !== 0) {
        const bankAccountId = await resolveAccount(doc.bankAccountNumber, "payment bank account");
        // A betalkonto that IS one of those two accounts cancels the bank
        // movement against a contribution of the opposite sign, and the
        // REMAINING rows can still balance perfectly well on their own: 1510
        // as betalkonto for a 995 kr payment of a 1000 kr invoice books
        // [1510 K 5, 3740 D 5] — two balanced rows, so the empty-row backstop
        // below never fires and 995 kr of real bank money silently never
        // enters the books. Refused here, before a single contribution is
        // added, rather than left to a check that only catches the case where
        // EVERYTHING nets out.
        if (bankAccountId === receivableAccountId || bankAccountId === writeOffAccountId) {
          throw new PaymentBankAccountConflictError(doc.bankAccountNumber);
        }
        amounts.add(bankAccountId, bankAmount);
      }

      for (const row of paymentRows) {
        amounts.add(receivableAccountId, -(row.appliedAmount + row.writeOffAmount));
      }

      if (writeOffAccountId !== null) amounts.add(writeOffAccountId, writeOffTotal);

      const postingRows = amounts.toRows();
      // Kvittning between open items on the SAME receivable account — a credit
      // note settled against an invoice with no money moving — nets every
      // contribution to zero. Moving an amount from one open item to another
      // inside 1510 changes no account balance, so it is not a
      // bokföringshändelse and gets no verification: the payment record itself
      // (with verificationId null) is the audit trail, and the open amounts
      // are derived from its rows anyway.
      //
      // Checked BEFORE ensureSeries and insertBookedVerification: the former
      // would lazily materialize the K series for a non-event, the latter
      // would throw its row-count assert (a plain Error -> 500) on an empty
      // row set. With the bank/applied identity above, an empty and a
      // >= 2-row set are the only shapes that can reach here — a non-empty
      // set sums to zero, so it can never be a single row.
      if (postingRows.length === 0) {
        // ... but "nothing to book" is only true for a payment that moved no
        // money; a bank amount that vanished into the netting is a
        // misconfigured betalkonto, not a kvittning. The identity check above
        // already refuses every way that can happen — this is the backstop
        // that keeps the invariant local to the return.
        if (bankAmount !== 0) throw new PaymentBankAccountConflictError(doc.bankAccountNumber);
        return null;
      }

      const series = await ensureSeries(tx, CUSTOMER_LEDGER_SERIES);
      return insertBookedVerification(
        tx,
        {
          series,
          date: doc.paymentDate,
          description: truncateDescription(`Betalning ${doc.paymentNumber} — ${doc.customerName}`),
        },
        postingRows,
        { source: "customer_payment", document: doc.paymentNumber },
        userId
      );
    },

    // Leverantörsbetalning -> series U, dated on the payment date. The mirror
    // of postCustomerPayment with every sign flipped: debit accounts payable
    // with everything the payment settles (applied + write-off per row,
    // signed — a supplier credit note settles negatively), credit the
    // payment's own bank account with what actually left the bank, and put the
    // tolerance difference on öres- och kronutjämning. The signed accumulator
    // covers underpayment, overpayment, kvittning and mixes of them with no
    // special cases, exactly as it does on the customer side.
    //
    // Returns null when the payment moves nothing in the ledger — see the
    // netting check below.
    async postSupplierPayment(
      tx: Tx,
      doc: SupplierPaymentDocument,
      rows: SupplierPaymentDocumentRow[],
      userId: string
    ): Promise<{ verificationId: string; displayNumber: string } | null> {
      // Same in-tx settings read as every posting above.
      const postingAccounts = await settings.read(tx);

      // Normalize to öre ONCE (postCustomerInvoice's rationale): the
      // accumulator then only ever sums 2-decimal values, so the bank amount
      // cannot drift a cent away from the sum of the contributions.
      const bankAmount = round2(doc.bankAmount);
      const paymentRows = rows.map((row) => ({
        appliedAmount: round2(row.appliedAmount),
        writeOffAmount: round2(row.writeOffAmount),
      }));

      // The balance precondition, stated where it can still be a typed error.
      const appliedTotal = round2(paymentRows.reduce((sum, row) => sum + row.appliedAmount, 0));
      if (bankAmount !== appliedTotal) throw new PaymentAmountMismatchError(bankAmount, appliedTotal);

      const resolveAccount = createPostingAccountResolver(tx);
      const amounts = createAmountAccumulator();

      // The two accounts the payment contributes POSITIVE amounts to (the sign
      // mirror of the customer side, where they take the negative ones) are
      // resolved before anything is added, so the bank account below can be
      // checked against both while the accumulator is still empty. Rows whose
      // write-offs cancel each other out leave no write-off row at all — and
      // then there is no write-off account to collide with either, which is why
      // the resolve is conditional.
      const payableAccountId = await resolveAccount(postingAccounts.postingAccountsPayable, "accounts payable");
      const writeOffTotal = round2(paymentRows.reduce((sum, row) => sum + row.writeOffAmount, 0));
      const writeOffAccountId =
        writeOffTotal === 0
          ? null
          : await resolveAccount(
              postingAccounts.postingPaymentWriteOff,
              "payment write-off (öres- och kronutjämning)"
            );

      // Same silent absorption as in postCustomerPayment above, one ledger
      // over: a write-off booked back onto 2440 cancels against the rows' own
      // debit, so the supplier debt is reduced only by what was actually paid
      // while the derived open amount calls the invoice settled — a balanced,
      // ordinary-looking verification hiding a permanent residue on the
      // payable. Conditional by construction (null when writeOffTotal is 0).
      if (writeOffAccountId === payableAccountId) {
        throw new PaymentBankAccountConflictError(postingAccounts.postingPaymentWriteOff, "payment write-off account");
      }

      // A pure kvittning never touches the bank, so the account is not even
      // resolved: a retired betalkonto on the payment must not block a netting
      // that does not use it.
      if (bankAmount !== 0) {
        const bankAccountId = await resolveAccount(doc.bankAccountNumber, "payment bank account");
        // A betalkonto that IS one of those two accounts cancels the bank
        // movement against a contribution of the opposite sign while the
        // REMAINING rows still balance on their own (2440 as betalkonto for a
        // 120 kr payment of a 125 kr invoice books [2440 D 5, 3740 K 5] — two
        // tidy rows, so the empty-row backstop below never fires and 120 kr of
        // real money leaving the bank silently never enters the books).
        // Refused here, before a single contribution is added.
        if (bankAccountId === payableAccountId || bankAccountId === writeOffAccountId) {
          throw new PaymentBankAccountConflictError(doc.bankAccountNumber);
        }
        // Kredit: money leaving the company — the sign mirror of the customer
        // payment's bank debit.
        amounts.add(bankAccountId, -bankAmount);
      }

      // Debet: the leverantörsskuld shrinks by everything the row settles,
      // the paid part and the written-off part alike.
      for (const row of paymentRows) {
        amounts.add(payableAccountId, row.appliedAmount + row.writeOffAmount);
      }

      if (writeOffAccountId !== null) amounts.add(writeOffAccountId, -writeOffTotal);

      const postingRows = amounts.toRows();
      // Kvittning between open items on the SAME payable account — a supplier
      // credit note settled against an invoice with no money moving — nets
      // every contribution to zero. Moving an amount from one open item to
      // another inside 2440 changes no account balance, so it is not a
      // bokföringshändelse and gets no verification: the payment record itself
      // (with verificationId null) is the audit trail, and the open amounts are
      // derived from its rows anyway.
      //
      // Checked BEFORE ensureSeries and insertBookedVerification: the former
      // would lazily materialize the U series for a non-event, the latter would
      // throw its row-count assert (a plain Error -> 500) on an empty row set.
      // With the bank/applied identity above, an empty and a >= 2-row set are
      // the only shapes that can reach here — a non-empty set sums to zero, so
      // it can never be a single row.
      if (postingRows.length === 0) {
        // ... but "nothing to book" is only true for a payment that moved no
        // money; a bank amount that vanished into the netting is a
        // misconfigured betalkonto, not a kvittning. The identity check above
        // already refuses every way that can happen — this is the backstop that
        // keeps the invariant local to the return.
        if (bankAmount !== 0) throw new PaymentBankAccountConflictError(doc.bankAccountNumber);
        return null;
      }

      const series = await ensureSeries(tx, SUPPLIER_LEDGER_SERIES);
      return insertBookedVerification(
        tx,
        {
          series,
          date: doc.paymentDate,
          description: truncateDescription(`Betalning ${doc.paymentNumber} — ${doc.supplierName}`),
        },
        postingRows,
        { source: "supplier_payment", document: doc.paymentNumber },
        userId
      );
    },

    // Påminnelseavgift -> series K, dated on the reminder date. Debit accounts
    // receivable and credit the fee account: the fee increases what the
    // customer owes on the invoice, so it becomes part of that invoice's open
    // amount. VAT-free by design — a statutory reminder fee (lagen om
    // ersättning för inkassokostnader) is compensation, not consideration for
    // a supply, so there is no VAT row and no rate anywhere in this path.
    async postReminderFee(
      tx: Tx,
      doc: InvoiceReminderDocument,
      userId: string
    ): Promise<{ verificationId: string; displayNumber: string }> {
      const fee = round2(doc.feeAmount);
      // A fee-less reminder must not be posted at all (the caller decides
      // whether to charge), and a negative fee is not a reminder — this path
      // does not model crediting one.
      if (fee <= 0) throw new ZeroAmountPostingError();

      const postingAccounts = await settings.read(tx);
      const resolveAccount = createPostingAccountResolver(tx);
      const amounts = createAmountAccumulator();

      const receivableAccountId = await resolveAccount(postingAccounts.postingAccountsReceivable, "accounts receivable");
      const feeAccountId = await resolveAccount(postingAccounts.postingReminderFeeAccount, "reminder fee");
      // Both roles on one account is the same silent-omission trap as the
      // payment's betalkonto: the debit and the credit cancel, the fee is
      // charged to the customer with nothing at all in the books, and
      // insertBookedVerification's row-count assert (a plain Error -> 500)
      // would be the only thing to say so. It is a posting-settings mistake,
      // so it is reported as one.
      if (feeAccountId === receivableAccountId) {
        throw new PaymentBankAccountConflictError(postingAccounts.postingReminderFeeAccount, "reminder fee account");
      }
      amounts.add(receivableAccountId, fee);
      amounts.add(feeAccountId, -fee);

      const series = await ensureSeries(tx, CUSTOMER_LEDGER_SERIES);
      return insertBookedVerification(
        tx,
        {
          series,
          date: doc.reminderDate,
          description: truncateDescription(`Påminnelseavgift faktura ${doc.invoiceNumber} — ${doc.customerName}`),
        },
        amounts.toRows(),
        { source: "invoice_reminder", document: doc.invoiceNumber },
        userId
      );
    },

    // Momsomföring (B5) -> series M, dated on the declared range's END (the
    // period's sista dag) — so assertPostablePeriod judges only that date and
    // a quarter whose earlier months are already locked settles fine. Every
    // non-zero net is mirrored onto its account (emptying it for the range)
    // and the sum lands on redovisningskontot för moms: a payable period
    // credits it, a momsfordran debits it, and in-/utgående that cancel
    // exactly leave no settlement row at all — all out of the accumulator's
    // `add(account, -net); add(settlement, +net)` arithmetic.
    async postVatSettlement(
      tx: Tx,
      doc: VatSettlementDocument,
      userId: string,
      // The settle path has already read the posting settings inside the same
      // transaction (for its guards) — passing them in closes the READ
      // COMMITTED window where a concurrent settings PATCH could repoint
      // 2650 between the two reads. Optional so other callers/tests keep
      // working unchanged.
      providedAccounts?: PostingAccountNumbers
    ): Promise<{ verificationId: string; displayNumber: string }> {
      const movements = doc.movements
        .map((movement) => ({ ...movement, net: round2(movement.net) }))
        .filter((movement) => movement.net !== 0);
      // Nothing to omföra is not a bokföringshändelse — the user pressed the
      // button on an empty period, so say so instead of booking noise.
      if (movements.length === 0) throw new ZeroAmountPostingError();

      const postingAccounts = providedAccounts ?? (await settings.read(tx));
      const resolveAccount = createPostingAccountResolver(tx);
      const amounts = createAmountAccumulator();

      // Resolved even when the nets would cancel to no 2650 row: a missing
      // or inactive redovisningskonto is a misconfiguration worth rejecting
      // regardless of this particular period's arithmetic.
      const settlementAccountId = await resolveAccount(postingAccounts.postingVatSettlement, "VAT settlement");
      for (const movement of movements) {
        amounts.add(await resolveAccount(movement.accountNumber, "VAT"), -movement.net);
        amounts.add(settlementAccountId, movement.net);
      }

      const series = await ensureSeries(tx, VAT_SETTLEMENT_SERIES);
      return insertBookedVerification(
        tx,
        {
          series,
          date: doc.toDate,
          description: truncateDescription(`Momsredovisning ${doc.fromDate} – ${doc.toDate}`),
        },
        amounts.toRows(),
        { source: "vat_settlement", document: `${doc.fromDate}–${doc.toDate}` },
        userId
      );
    },

    // SIE opening balances. The caller has already resolved every account id
    // and verified that the balances net to zero — insertBookedVerification
    // would throw a bare Error otherwise, which is not a user-facing message.
    async postOpeningBalances(
      tx: Tx,
      doc: { date: string; balances: { accountId: string; amount: number }[] },
      userId: string
    ): Promise<{ verificationId: string; displayNumber: string }> {
      const amounts = createAmountAccumulator();
      for (const balance of doc.balances) amounts.add(balance.accountId, balance.amount);

      const rows = amounts.toRows();
      if (rows.length === 0) throw new ZeroAmountPostingError();

      const series = await ensureSeries(tx, OPENING_BALANCE_SERIES);
      return insertBookedVerification(
        tx,
        { series, date: doc.date, description: truncateDescription(`Ingående balanser ${doc.date}`) },
        rows,
        { source: "sie_opening_balances", document: doc.date },
        userId
      );
    },

    // PRE-FLIGHT for postReminderFee: the same MISCONFIGURATION preconditions
    // it enforces — both accounts exist and are active, the reminder date
    // falls inside an accounting period, and that period is open — asked
    // BEFORE the caller does something it cannot take back (sending the
    // påminnelse email; see invoice.service.ts's sendReminder).
    //
    // Without it, an absent 3540, a deactivated one or a locked month means
    // the customer receives the reminder and the posting then fails inside the
    // transaction: nothing is recorded, and "skicka igen" mails them a second
    // time and fails identically until an admin changes a setting. None of
    // those conditions is a race — they are static configuration, so checking
    // them early is not a guess about the future.
    //
    // The in-tx posting REMAINS the authority: this deliberately duplicates no
    // arithmetic, only the two lookups, and the window between them is a real
    // race (someone locking the period in those milliseconds), which the
    // caller's documented retry covers.
    async assertReminderFeePostable(executor: Db | Tx, reminderDate: string): Promise<void> {
      const postingAccounts = await settings.read(executor);
      const resolveAccount = createPostingAccountResolver(executor);
      // Same numbers and the same roleLabels postReminderFee resolves, so the
      // error a user sees here is the error they would have seen later —
      // including the two roles landing on ONE account, which is static
      // configuration exactly like a missing account is.
      const receivableAccountId = await resolveAccount(postingAccounts.postingAccountsReceivable, "accounts receivable");
      const feeAccountId = await resolveAccount(postingAccounts.postingReminderFeeAccount, "reminder fee");
      if (feeAccountId === receivableAccountId) {
        throw new PaymentBankAccountConflictError(postingAccounts.postingReminderFeeAccount, "reminder fee account");
      }
      await assertPostablePeriod(executor, reminderDate);
    },

    // Avskrivningskörning → series AV, dated by the caller (the month's
    // last day, or the disposal day for a catch-up). Two categories on the
    // same expense account merge into one row through the accumulator.
    async postDepreciation(
      tx: Tx,
      doc: DepreciationDocument,
      userId: string
    ): Promise<{ verificationId: string; displayNumber: string }> {
      const amounts = createAmountAccumulator();
      for (const row of doc.rows) {
        const amount = round2(row.amount);
        if (amount <= 0) continue;
        await requireActiveAccountById(tx, row.expenseAccountId, "depreciation expense");
        await requireActiveAccountById(tx, row.accumulatedAccountId, "accumulated depreciation");
        amounts.add(row.expenseAccountId, amount);
        amounts.add(row.accumulatedAccountId, -amount);
      }
      const rows = amounts.toRows();
      // The service returns null before ever calling this on an empty plan;
      // reaching here with nothing is a programming error, reported as the
      // same user-facing guard as every other empty posting.
      if (rows.length === 0) throw new ZeroAmountPostingError();

      const series = await ensureSeries(tx, FIXED_ASSET_SERIES);
      return insertBookedVerification(
        tx,
        { series, date: doc.date, description: truncateDescription(doc.description) },
        rows,
        { source: "fixed_asset_depreciation", document: doc.description },
        userId
      );
    },

    // Avyttring/utrangering → series AV, dated on the disposal day (after
    // the catch-up run, so it takes the higher number). The gain account
    // used as mellankonto merges with the gain row through the accumulator
    // into one debit of the book value (spec 6).
    async postFixedAssetDisposal(
      tx: Tx,
      doc: FixedAssetDisposalDocument,
      userId: string
    ): Promise<{ verificationId: string; displayNumber: string }> {
      const amounts = createAmountAccumulator();
      for (const row of disposalPostingRows(doc)) {
        const accountId = row.role === "intermediate" ? doc.accounts.intermediate : doc.accounts[row.role];
        // Unreachable through the service (a sale always carries its
        // mellankonto); a bare Error is the right signal for a caller bug.
        if (!accountId) throw new Error("A disposal with a price needs an intermediate account");
        await requireActiveAccountById(tx, accountId, `disposal ${row.role}`);
        amounts.add(accountId, row.amount);
      }
      const rows = amounts.toRows();
      if (rows.length < 2) throw new ZeroAmountPostingError();

      const series = await ensureSeries(tx, FIXED_ASSET_SERIES);
      const label = doc.disposalType === "sale" ? "Avyttring" : "Utrangering";
      return insertBookedVerification(
        tx,
        { series, date: doc.date, description: truncateDescription(`${label} ${doc.assetNumber} ${doc.assetName}`) },
        rows,
        { source: "fixed_asset_disposal", document: doc.assetNumber },
        userId
      );
    },

    // Bokslutsverifikat → series BS. The service computes signed amounts
    // (year-end-calc.ts); the accumulator nets them per account. Accounts
    // come as ids and are re-checked active inside the caller's tx.
    async postClosingEntry(
      tx: Tx,
      doc: { date: string; description: string; amounts: { accountId: string; amount: number }[]; source: ClosingEntrySource; document: string },
      userId: string
    ): Promise<{ verificationId: string; displayNumber: string }> {
      const amounts = createAmountAccumulator();
      for (const row of doc.amounts) {
        const amount = round2(row.amount);
        if (amount === 0) continue;
        await requireActiveAccountById(tx, row.accountId, doc.source);
        amounts.add(row.accountId, amount);
      }
      const rows = amounts.toRows();
      // The service returns before calling with nothing to book.
      if (rows.length < 2) throw new ZeroAmountPostingError();

      const series = await ensureSeries(tx, YEAR_END_SERIES);
      return insertBookedVerification(
        tx,
        { series, date: doc.date, description: truncateDescription(doc.description) },
        rows,
        { source: doc.source, document: doc.document },
        userId
      );
    },

    // Omföring of a booked verification: a mirrored, immediately booked
    // verification linked back to the source (verifications are append-only —
    // a cancelled supplier invoice is corrected, never edited). Dated on the
    // cancellation day, so THAT date's period must be open.
    //
    // A source that already has a BOOKED reversal (e.g. a manual Omför that
    // was booked) is reported rather than duplicated: the correction already
    // stands in the books, so the caller's own transition should still go
    // through. The status filter is load-bearing — a manual Omför starts as a
    // DRAFT (economy.service's reverse()), and a draft is neither part of the
    // books nor permanent (it can be deleted), so it is NOT yet a correction
    // and must not let a cancellation commit with nothing booked. A draft
    // reversal therefore falls through to the insert below and collides with
    // the partial unique index verifications_reverses_unique (which spans
    // drafts too) → 23505 → the caller's 409, telling the user to book or
    // delete the manual omföring first.
    //
    // That same unique index is the real guarantee behind this pre-check: a
    // 23505 from a manual reversal committing between the check and the
    // insert propagates to the caller (mapped to 409 there).
    async reverseBookedVerification(
      tx: Tx,
      sourceVerificationId: string,
      opts: { date: string; description: string },
      userId: string
    ): Promise<{ verificationId: string } | { alreadyReversed: true }> {
      const [existing] = await tx
        .select({ id: verifications.id })
        .from(verifications)
        .where(
          and(
            eq(verifications.reversesVerificationId, sourceVerificationId),
            eq(verifications.status, "booked")
          )
        );
      if (existing) return { alreadyReversed: true };

      const [source] = await tx
        .select({
          seriesId: verifications.seriesId,
          seriesCode: verificationSeries.code,
          yearLabel: fiscalYears.label,
          verificationNumber: verifications.verificationNumber,
          status: verifications.status,
        })
        .from(verifications)
        .innerJoin(verificationSeries, eq(verificationSeries.id, verifications.seriesId))
        .innerJoin(fiscalYears, eq(fiscalYears.id, verifications.fiscalYearId))
        .where(eq(verifications.id, sourceVerificationId));
      // Unreachable through the consumers (they pass an id they just read off
      // their own document row, and the poster only ever writes booked ones).
      if (!source || source.status !== "booked") {
        throw new Error(`Verification ${sourceVerificationId} is not a booked verification`);
      }

      const sourceRows = await tx
        .select({ accountId: verificationRows.accountId, debit: verificationRows.debit, credit: verificationRows.credit })
        .from(verificationRows)
        .where(eq(verificationRows.verificationId, sourceVerificationId))
        .orderBy(asc(verificationRows.createdAt));
      // Debit and credit swap places, amounts and accounts stay — source plus
      // reversal nets to zero on every account.
      const mirrored = sourceRows.map((row) => ({
        accountId: row.accountId,
        debit: round2(Number(row.credit)),
        credit: round2(Number(row.debit)),
      }));

      // The reversal belongs to the same series as its source (L for a
      // cancelled supplier invoice, K for a cancelled customer payment), so
      // the two sit next to each other in the series.
      const posted = await insertBookedVerification(
        tx,
        {
          series: { id: source.seriesId, code: source.seriesCode },
          date: opts.date,
          description: truncateDescription(opts.description),
          reversesVerificationId: sourceVerificationId,
        },
        mirrored,
        {
          source: "verification_reversal",
          document: `${source.seriesCode}-${source.yearLabel}-${source.verificationNumber}`,
        },
        userId
      );
      return { verificationId: posted.verificationId };
    },
  };
}

export type VerificationPoster = ReturnType<typeof createVerificationPoster>;

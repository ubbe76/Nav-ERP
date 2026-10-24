import { createHash } from "node:crypto";
import type {
  CreateAccountInput,
  CreateFiscalYearInput,
  CreatePostingRuleInput,
  CreateVerificationInput,
  CreateVerificationSeriesInput,
  LedgerQuery,
  ListAccountsQuery,
  ListVerificationsQuery,
  UpdateAccountInput,
  UpdatePostingRuleInput,
  UpdateVerificationInput,
  UpdateVerificationSeriesInput,
  VerificationRowInput,
} from "@navet/shared";
import { isVatCode, round2, vatCodeEntry } from "@navet/shared";
import type { Tx } from "@navet/db";
import {
  bookFailureReason,
  type BookFailure,
  type EconomyRepository,
  type PostingRulePatch,
  type VerificationRowWrite,
} from "../repository/economy.repository.js";
import { stockholmToday } from "../../system/service/delivery-days.js";
// Append-only audit trail (same interface payroll/timereport already write
// to) — wired for Task 4's fiscal year period locking (lock/unlock).
import type { AuditWriter } from "../../system/repository/audit.repository.js";
import { isUniqueViolation } from "../../system/service/db-errors.js";
import { BAS_STANDARD_ACCOUNTS, defaultVatBox } from "./bas-accounts.js";
import { classifyAccount } from "./bas-report-lines.js";
// AccountingPeriodLockedError lives in the leaf file (no dependency on this
// service) so future modules can consume the period-lock guard without a
// cycle — re-exported here so routes/tests keep a single import surface for
// every economy error, same trick as generateMonthlyPeriods below.
import { AccountingPeriodLockedError, FiscalYearClosedError } from "./accounting-period-lock.js";
export { AccountingPeriodLockedError, FiscalYearClosedError };
// Month generation itself is a pure, DB-free helper that lives in the
// leaf-like month-periods.ts (imported by economy.repository.ts too, inside
// its create transaction) — re-exported here so this aggregator keeps
// exposing it under its previous, still-documented public surface.
export { generateMonthlyPeriods } from "./month-periods.js";
export type { MonthlyPeriodBounds } from "./month-periods.js";

export class AccountNotFoundError extends Error {
  constructor(id: string) {
    super(`Account ${id} not found`);
    this.name = "AccountNotFoundError";
  }
}

export class DuplicateAccountNumberError extends Error {
  constructor(number: string) {
    super(`An account with number "${number}" already exists`);
    this.name = "DuplicateAccountNumberError";
  }
}

// --- Räkenskapsår & periods ---

export class OverlappingFiscalYearError extends Error {
  constructor(label: string) {
    super(`Fiscal year "${label}" overlaps an existing fiscal year`);
    this.name = "OverlappingFiscalYearError";
  }
}

// A closed year's opening balance is derived from all earlier bookings; a
// year created before it could take bookings that silently change it.
export class FiscalYearBeforeClosedYearError extends Error {
  constructor(label: string, closedLabel: string) {
    super(`Fiscal year "${label}" would end before the closed fiscal year ${closedLabel}`);
    this.name = "FiscalYearBeforeClosedYearError";
  }
}

export class FiscalYearNotFoundError extends Error {
  constructor(id: string) {
    super(`Fiscal year ${id} not found`);
    this.name = "FiscalYearNotFoundError";
  }
}

// fiscal_years.label is unique in the DB — a non-overlapping date range with
// a reused label still hits that constraint, and without this catch it
// surfaced as a raw 500 instead of a mapped 409 (same isUniqueViolation
// idiom as DuplicateAccountNumberError above).
export class DuplicateFiscalYearLabelError extends Error {
  constructor(label: string) {
    super(`A fiscal year with label "${label}" already exists`);
    this.name = "DuplicateFiscalYearLabelError";
  }
}

export class AccountingPeriodNotFoundError extends Error {
  constructor(id: string) {
    super(`Accounting period ${id} not found`);
    this.name = "AccountingPeriodNotFoundError";
  }
}

// Repo-conditional lock failed — either the period was already locked (a
// second lock attempt) or, on unlock, was already open.
export class PeriodAlreadyLockedError extends Error {
  constructor(id: string) {
    super(`Accounting period ${id} is already locked`);
    this.name = "PeriodAlreadyLockedError";
  }
}

export class PeriodNotLockedError extends Error {
  constructor(id: string) {
    super(`Accounting period ${id} is not locked`);
    this.name = "PeriodNotLockedError";
  }
}

// --- Verifikatserier ---

export class DuplicateVerificationSeriesError extends Error {
  constructor(code: string) {
    super(`A verification series with code "${code}" already exists`);
    this.name = "DuplicateVerificationSeriesError";
  }
}

export class VerificationSeriesNotFoundError extends Error {
  constructor(id: string) {
    super(`Verification series ${id} not found`);
    this.name = "VerificationSeriesNotFoundError";
  }
}

// A series' code is read into every historical verifikat's displayNumber
// ("<code>-<year>-<n>", built at read time, never stored) — renaming it once
// the series has been used would retroactively renumber already-booked
// verifikat and orphan audit_log entityIds that reference the old string.
// The name has no such downstream reader, so it stays editable regardless.
export class SeriesCodeLockedError extends Error {
  constructor(id: string) {
    super(`Verification series ${id} has verifications and its code can no longer be changed`);
    this.name = "SeriesCodeLockedError";
  }
}

// --- Verifikat (verifications) ---

// Underlag on a verification — same formats/cap as the supplier invoice's.
export const VERIFICATION_FILE_TYPES = ["application/pdf", "image/jpeg", "image/png"] as const;
export const MAX_VERIFICATION_FILE_BYTES = 20 * 1024 * 1024;

export class VerificationFileNotFoundError extends Error {
  constructor(id: string) {
    super(`Verification file ${id} not found`);
    this.name = "VerificationFileNotFoundError";
  }
}

export class InvalidVerificationFileTypeError extends Error {
  constructor(contentType: string) {
    super(`Filtypen ${contentType} stöds inte — ladda upp PDF, JPEG eller PNG`);
    this.name = "InvalidVerificationFileTypeError";
  }
}

// A booked verifikat's underlag is räkenskapsinformation (bokföringslagen
// 7 kap: kept 7 år) — it can be added to, never removed. 409.
export class VerificationFileLockedError extends Error {
  constructor() {
    super("Underlaget kan bara tas bort medan verifikatet är ett utkast — efter bokföring är det räkenskapsinformation");
    this.name = "VerificationFileLockedError";
  }
}

export class VerificationNotFoundError extends Error {
  constructor(id: string) {
    super(`Verification ${id} not found`);
    this.name = "VerificationNotFoundError";
  }
}

export class VerificationRowNotFoundError extends Error {
  constructor(id: string) {
    super(`Verification row ${id} not found`);
    this.name = "VerificationRowNotFoundError";
  }
}

// Draft-conditioned write lost its race, or was attempted on a verification
// that is no longer a draft — the repo-level "empty match" convention (see
// updateVerificationHeader/addRow/updateRow/deleteRow/deleteVerification in
// economy.repository.ts) is always normalized to this one error.
export class InvalidVerificationStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidVerificationStateError";
  }
}

// `date` (create, or a header PATCH that changes it) falls outside every
// fiscal year's [startDate, endDate] range.
export class NoFiscalYearForDateError extends Error {
  constructor(date: string) {
    super(`No fiscal year covers date ${date}`);
    this.name = "NoFiscalYearForDateError";
  }
}

export class InactiveAccountError extends Error {
  constructor(id: string) {
    super(`Account ${id} is inactive`);
    this.name = "InactiveAccountError";
  }
}

// --- Bokför (booking) & Omför (reversal) ---

// A verification needs at least 2 rows to be booked — a single row can
// never balance (debit and credit are mutually exclusive per row, enforced
// by verificationRowInputSchema's XOR refine).
export class TooFewVerificationRowsError extends Error {
  constructor(id: string) {
    super(`Verification ${id} needs at least 2 rows to be booked`);
    this.name = "TooFewVerificationRowsError";
  }
}

// round2(Σdebit) !== round2(Σcredit) — the difference is embedded in the
// message so the caller doesn't have to recompute it.
export class UnbalancedVerificationError extends Error {
  constructor(totalDebit: number, totalCredit: number) {
    super(
      `Verification is not balanced: debit ${totalDebit} does not equal credit ${totalCredit} ` +
        `(difference ${round2(totalDebit - totalCredit)})`
    );
    this.name = "UnbalancedVerificationError";
  }
}

// `date` has a fiscal year (checked at create time) but no accounting
// period covers it — impossible by construction (createFiscalYearWithPeriods
// always generates full monthly coverage for the year), but the guard is
// cheap so it runs at booking anyway.
export class NoAccountingPeriodError extends Error {
  constructor(date: string) {
    super(`No accounting period covers date ${date}`);
    this.name = "NoAccountingPeriodError";
  }
}

// The source verification already has a linked reversal — the partial
// unique index (verifications_reverses_unique) guarantees at most one, this
// is the friendly pre-check in front of that race.
export class AlreadyReversedError extends Error {
  constructor(id: string) {
    super(`Verification ${id} has already been reversed`);
    this.name = "AlreadyReversedError";
  }
}

// The anläggningsregister owns its AV verifications: a manual Omför would
// zero the ledger while the register's rows still count, and the next run
// would NOT refill them — a permanent drift. Undo goes through the register.
export class FixedAssetVerificationError extends Error {
  constructor(id: string) {
    super(`Verification ${id} belongs to the fixed asset register — undo it from Anläggningsregistret`);
    this.name = "FixedAssetVerificationError";
  }
}

// The closing guide owns its BS verifications: the closing row points at the
// live ones, so a manual Omför would let the guide and the ledger drift.
export class YearEndClosingVerificationError extends Error {
  constructor(id: string) {
    super(`Verification ${id} belongs to the year-end closing — redo the step in the closing guide`);
    this.name = "YearEndClosingVerificationError";
  }
}

// --- Konteringsregler (B2 automatkontering) ---

export class PostingRuleNotFoundError extends Error {
  constructor(id: string) {
    super(`Posting rule ${id} not found`);
    this.name = "PostingRuleNotFoundError";
  }
}

// A local class, not a re-export of article.service.ts's own
// ArticleGroupNotFoundError — this module never imports the article module
// (each module owns its own error classes, same as every other
// NotFoundError in this file).
export class ArticleGroupNotFoundError extends Error {
  constructor(id: string) {
    super(`Article group ${id} not found`);
    this.name = "ArticleGroupNotFoundError";
  }
}

// Fired on the real unique-constraint violation (posting_rules_group_code_
// unique / posting_rules_group_nocode_unique) — a null code in the message
// reads as "all codes" (the catch-all rule), matching the schema's own
// null-code semantics.
export class DuplicatePostingRuleError extends Error {
  constructor(articleGroupId: string, vatCode: string | null) {
    super(
      vatCode === null
        ? `A catch-all posting rule (all VAT codes) already exists for article group ${articleGroupId}`
        : `A posting rule for article group ${articleGroupId} and VAT code ${vatCode} already exists`
    );
    this.name = "DuplicatePostingRuleError";
  }
}

export class VatCodeNotFoundError extends Error {
  constructor(id: string) {
    super(`VAT code ${id} not found`);
    this.name = "VatCodeNotFoundError";
  }
}

// Konteringsregler steer customer and supplier invoices; the importmoms
// posting has no article group, so a rule for an import code could never
// apply.
export class PostingRuleVatCodeError extends Error {
  constructor(code: string) {
    super(`VAT code ${code} is only used for import VAT and cannot have a posting rule`);
    this.name = "PostingRuleVatCodeError";
  }
}

// updatePostingRuleSchema's "at least one account" refine only sees the PATCH
// payload, not the stored row (documented at packages/shared/src/economy.ts
// ~line 150) — this is thrown by the SERVICE once it merges the patch onto
// the stored row and finds both accounts null. Deliberately its own error
// class (not a reused zod path) since it can only be detected after the DB
// read.
export class PostingRuleNoAccountsError extends Error {
  constructor(id: string) {
    super(`Posting rule ${id} must have at least one of revenueAccountId or costAccountId set`);
    this.name = "PostingRuleNoAccountsError";
  }
}

// Builds the verifikatnummer shown on the card/list: a booked verification
// reads "<seriesCode>-<yearLabel>-<verificationNumber>" (e.g. "A-2026-17");
// a draft has no number yet and always reads "Utkast", regardless of any
// stray verificationNumber value.
// Exported for the B6a reports, which build the same label for the general
// ledger printout and the verification list.
export function displayNumber(v: { status: string; seriesCode: string; yearLabel: string; verificationNumber: number | null }): string {
  if (v.status === "booked" && v.verificationNumber !== null) {
    return `${v.seriesCode}-${v.yearLabel}-${v.verificationNumber}`;
  }
  return "Utkast";
}

// Row validation shared by create/addRow/updateRow: the account must exist
// and be active, and amounts are round2:ed before storage — zod's XOR refine
// (verificationRowInputSchema) already guarantees the debit/credit shape by
// the time input reaches here.
async function resolveVerificationRow(repo: EconomyRepository, input: VerificationRowInput): Promise<VerificationRowWrite> {
  const account = await repo.findAccountById(input.accountId);
  if (!account) throw new AccountNotFoundError(input.accountId);
  if (!account.active) throw new InactiveAccountError(input.accountId);
  return {
    accountId: input.accountId,
    debit: round2(input.debit),
    credit: round2(input.credit),
    description: input.description ?? null,
  };
}

// Same existence + active check as resolveVerificationRow above, reused by
// posting rules' revenue/cost account validation — an unknown account is a
// mapped 404 (never a raw FK violation), an inactive one a mapped 400.
async function requireActiveAccount(repo: EconomyRepository, accountId: string): Promise<void> {
  const account = await repo.findAccountById(accountId);
  if (!account) throw new AccountNotFoundError(accountId);
  if (!account.active) throw new InactiveAccountError(accountId);
}

// The repository's discriminated booking failure → this module's error
// classes. Shared by book() and every create-and-book composition (Spara och
// bokför, recurring runs, the SIE import) so a locked period or an inactive
// account reads the same whichever path found it. `race` = no longer a draft.
export function bookFailureError(id: string, failure: BookFailure): Error {
  switch (failure.reason) {
    case "too_few_rows":
      return new TooFewVerificationRowsError(id);
    case "unbalanced":
      return new UnbalancedVerificationError(failure.totalDebit, failure.totalCredit);
    case "inactive_account":
      return new InactiveAccountError(failure.accountId);
    case "locked_period":
      return new AccountingPeriodLockedError(failure.date);
    case "no_period":
      return new NoAccountingPeriodError(failure.date);
    case "race":
      return new InvalidVerificationStateError(`Cannot book verification ${id}: it is no longer a draft`);
  }
}

// What a create-and-book composition hands in: the header without the fiscal
// year (resolved from `date` inside the transaction) and rows already
// validated by the caller (accounts exist and are active, amounts round2:ed).
export type VerificationComposeInput = {
  seriesId: string;
  date: string;
  description: string;
  rows: VerificationRowWrite[];
};

export function createEconomyService(repo: EconomyRepository, audit: AuditWriter) {
  // A rule's momskod must exist and be usable on an invoice (not an import
  // code). An inactive code is allowed — the Momskoder page warns about it.
  async function requirePostingRuleVatCode(id: string) {
    const vatCode = await repo.findVatCodeById(id);
    if (!vatCode) throw new VatCodeNotFoundError(id);
    if (isVatCode(vatCode.code) && vatCodeEntry(vatCode.code).direction === "import") {
      throw new PostingRuleVatCodeError(vatCode.code);
    }
    return vatCode;
  }

  const service = {
    async listAccounts(query: ListAccountsQuery) {
      return repo.listAccounts(query);
    },

    // Active accounts as number + name, for pickers outside Ekonomi — see the
    // route's own comment on why this one is not admin-only.
    async listAccountOptions() {
      return repo.listAccountOptions();
    },

    async createAccount(input: CreateAccountInput) {
      // Omitted vatBox = the BAS default for the number; an explicit null
      // stays null (the user chose "Ej angiven").
      const vatBox = input.vatBox === undefined ? defaultVatBox(input.number) : input.vatBox;
      try {
        return await repo.createAccount({ number: input.number, name: input.name, vatBox });
      } catch (err) {
        if (isUniqueViolation(err)) throw new DuplicateAccountNumberError(input.number);
        throw err;
      }
    },

    // number is immutable — not part of UpdateAccountInput, so there is
    // nothing here to strip; the schema already keeps it out.
    async updateAccount(id: string, input: UpdateAccountInput) {
      const updated = await repo.updateAccount(id, input);
      if (!updated) throw new AccountNotFoundError(id);
      return updated;
    },

    // Idempotent pre-fill with the BAS standard chart of accounts (same shape
    // as payroll's seedStandardAbsenceTypes): existing numbers — including a
    // renamed 1930 — are left untouched.
    async seedBasAccounts() {
      const created = await repo.seedAccounts(BAS_STANDARD_ACCOUNTS);
      return { created, skipped: BAS_STANDARD_ACCOUNTS.length - created };
    },

    // --- Räkenskapsår & periods ---

    // Overlap check happens here (not a DB constraint, mirroring
    // OverlappingFiscalYearError living in this file): two years overlap iff
    // the new range and an existing one share at least one day — edge-to-edge
    // (new start = existing end + 1 day) is fine. Month generation itself is
    // pure and runs inside the repo's create transaction.
    async createFiscalYear(input: CreateFiscalYearInput) {
      const existing = await repo.listFiscalYears();
      const overlaps = existing.some((year) => input.startDate <= year.endDate && input.endDate >= year.startDate);
      if (overlaps) throw new OverlappingFiscalYearError(input.label);
      const laterClosed = existing.find((year) => year.status === "closed" && input.endDate < year.startDate);
      if (laterClosed) throw new FiscalYearBeforeClosedYearError(input.label, laterClosed.label);
      try {
        return await repo.createFiscalYearWithPeriods(input);
      } catch (err) {
        if (isUniqueViolation(err)) throw new DuplicateFiscalYearLabelError(input.label);
        throw err;
      }
    },

    async listFiscalYears() {
      return repo.listFiscalYears();
    },

    async findFiscalYearById(id: string) {
      const year = await repo.findFiscalYearById(id);
      if (!year) throw new FiscalYearNotFoundError(id);
      return year;
    },

    // Freeze a period: conditional on the repo (`WHERE status='open'`) —
    // an already-locked period returns null and becomes a 409, not a silent
    // re-stamp of lockedAt/lockedBy.
    async lockPeriod(id: string, userId: string) {
      const period = await repo.findPeriodById(id);
      if (!period) throw new AccountingPeriodNotFoundError(id);

      const locked = await repo.lockPeriod(id, userId);
      if (!locked) throw new PeriodAlreadyLockedError(id);

      const year = await repo.findFiscalYearById(period.fiscalYearId);
      await audit.log({
        entityType: "accounting_period",
        entityId: `${year!.label}-${period.startDate.slice(0, 7)}`,
        action: "locked",
        userId,
      });

      return locked;
    },

    // Reopen a locked period — allowed in an open fiscal year (a closed
    // year is reopened under Bokslut instead; trigger
    // accounting_periods_closed_year_lock backs this up), and always audited
    // with the reason (mandatory in unlockPeriodSchema) so the trail explains
    // why a closed month was touched again.
    async unlockPeriod(id: string, reason: string, userId: string) {
      const period = await repo.findPeriodById(id);
      if (!period) throw new AccountingPeriodNotFoundError(id);
      const owningYear = await repo.findFiscalYearById(period.fiscalYearId);
      if (owningYear?.status === "closed") throw new FiscalYearClosedError(owningYear.label);

      const unlocked = await repo.unlockPeriod(id);
      if (!unlocked) throw new PeriodNotLockedError(id);

      const year = await repo.findFiscalYearById(period.fiscalYearId);
      await audit.log({
        entityType: "accounting_period",
        entityId: `${year!.label}-${period.startDate.slice(0, 7)}`,
        action: "unlocked",
        detail: { reason },
        userId,
      });

      return unlocked;
    },

    // --- Verifikatserier ---

    async listSeries() {
      return repo.listSeries();
    },

    // Precheck for the common case (cheap, and the same findSeriesByCode
    // lookup also powers update's self-exclusion below) PLUS a catch on the
    // real unique constraint (same isUniqueViolation idiom as createAccount
    // above) — the precheck alone is a TOCTOU gap: two concurrent POSTs with
    // the same code can both pass it and race to the insert.
    async createSeries(input: CreateVerificationSeriesInput) {
      if (await repo.findSeriesByCode(input.code)) throw new DuplicateVerificationSeriesError(input.code);
      try {
        return await repo.createSeries(input);
      } catch (err) {
        if (isUniqueViolation(err)) throw new DuplicateVerificationSeriesError(input.code);
        throw err;
      }
    },

    // A series may keep its own code — conflicts only count on a different
    // row (self-exclusion, same rule as register.service.ts's forRegister).
    // An ACTUAL code change (not just re-submitting the same value) is
    // additionally refused once the series has any verification — see
    // SeriesCodeLockedError above; the name has no such restriction.
    async updateSeries(id: string, input: UpdateVerificationSeriesInput) {
      if (input.code) {
        const existing = await repo.findSeriesByCode(input.code);
        if (existing && existing.id !== id) throw new DuplicateVerificationSeriesError(input.code);

        const current = await repo.findSeriesById(id);
        if (!current) throw new VerificationSeriesNotFoundError(id);
        if (input.code !== current.code) {
          if (await repo.seriesHasVerifications(id)) throw new SeriesCodeLockedError(id);
        }
      }

      let updated;
      try {
        updated = await repo.updateSeries(id, input);
      } catch (err) {
        // TOCTOU catch-all behind the precheck above, same idiom as
        // createSeries — a real unique violation can only come from `code`.
        if (isUniqueViolation(err) && input.code) throw new DuplicateVerificationSeriesError(input.code);
        throw err;
      }
      if (!updated) throw new VerificationSeriesNotFoundError(id);
      return updated;
    },

    // --- Verifikat (verifications) ---

    async listVerifications(query: ListVerificationsQuery) {
      const { rows, total } = await repo.listVerifications(query);
      return { rows: rows.map((row) => ({ ...row, displayNumber: displayNumber(row) })), total };
    },

    async findVerificationById(id: string) {
      const verification = await repo.findVerificationById(id);
      if (!verification) throw new VerificationNotFoundError(id);

      // Reverse-direction lookup: does some OTHER verification reverse THIS
      // one? (repo.findReversalOf is otherwise only used the forward way, as
      // reverse()'s AlreadyReversedError pre-check.) A reversal may itself
      // still be a draft, so its displayNumber can read "Utkast" here — the
      // shared builder already handles that.
      const reversal = await repo.findReversalOf(id);
      const reversedBy = reversal ? { id: reversal.id, displayNumber: displayNumber(reversal) } : null;

      const files = await repo.listVerificationFiles(id);
      const fixedAsset = await repo.findFixedAssetLink(id);
      const yearEnd = await repo.findYearEndLink(id);
      return { ...verification, displayNumber: displayNumber(verification), reversedBy, files, fixedAsset, yearEnd };
    },

    // --- Underlag (kvitto, kontoutdrag, avtal) ---

    // Addable in every status — a missing kvitto can be attached after
    // booking; only removal is restricted (deleteFile).
    async addFile(
      verificationId: string,
      file: { filename: string; contentType: string; data: Buffer },
      userId: string | null
    ) {
      const verification = await repo.findVerificationById(verificationId);
      if (!verification) throw new VerificationNotFoundError(verificationId);
      if (!(VERIFICATION_FILE_TYPES as readonly string[]).includes(file.contentType)) {
        throw new InvalidVerificationFileTypeError(file.contentType);
      }
      const sha256 = createHash("sha256").update(file.data).digest("hex");
      const row = await repo.addVerificationFile({
        verificationId,
        filename: file.filename,
        contentType: file.contentType,
        sizeBytes: file.data.length,
        sha256,
        data: file.data,
        uploadedBy: userId,
      });
      await audit.log({
        entityType: "verification",
        entityId: displayNumber(verification),
        action: "file_added",
        detail: { filename: row.filename, sizeBytes: row.sizeBytes, sha256 },
        userId,
      });
      return row;
    },

    async listFiles(verificationId: string) {
      if (!(await repo.findVerificationById(verificationId))) throw new VerificationNotFoundError(verificationId);
      return repo.listVerificationFiles(verificationId);
    },

    async downloadFile(verificationId: string, fileId: string) {
      const file = await repo.findVerificationFile(verificationId, fileId);
      if (!file) throw new VerificationFileNotFoundError(fileId);
      return file;
    },

    async deleteFile(verificationId: string, fileId: string, userId: string | null) {
      const verification = await repo.findVerificationById(verificationId);
      if (!verification) throw new VerificationNotFoundError(verificationId);
      const result = await repo.deleteVerificationFileIfDraft(verificationId, fileId);
      if (!result.ok) {
        if (result.reason === "locked") throw new VerificationFileLockedError();
        throw new VerificationFileNotFoundError(fileId);
      }
      await audit.log({
        entityType: "verification",
        entityId: displayNumber(verification),
        action: "file_deleted",
        detail: { filename: result.filename, sha256: result.sha256 },
        userId,
      });
    },

    // fiscalYearId is resolved from `date` here — never accepted from the
    // client (createVerificationSchema deliberately omits it), same as the
    // verifikatnummer which is only allocated at booking (Task 7). Rows are
    // optional (empty array OK); the >=2-rows rule belongs to booking, not
    // this create.
    async createVerification(input: CreateVerificationInput, createdBy: string) {
      if (!(await repo.findSeriesById(input.seriesId))) throw new VerificationSeriesNotFoundError(input.seriesId);

      const year = await repo.findFiscalYearForDate(input.date);
      if (!year) throw new NoFiscalYearForDateError(input.date);
      if (year.status === "closed") throw new FiscalYearClosedError(year.label);

      const rows: VerificationRowWrite[] = [];
      for (const r of input.rows) {
        rows.push(await resolveVerificationRow(repo, r));
      }

      // Spara och bokför: create + book in one transaction, so a refused
      // booking (unbalanced, locked period) leaves no draft behind.
      if (input.book) {
        const { id } = await repo.transaction((tx) =>
          service.createVerificationInTx(tx, { seriesId: input.seriesId, date: input.date, description: input.description, rows }, createdBy, {
            book: true,
          })
        );
        const booked = await service.findVerificationById(id);
        await audit.log({ entityType: "verification", entityId: booked.displayNumber, action: "booked", userId: createdBy });
        return booked;
      }

      const header = await repo.createVerification(
        { seriesId: input.seriesId, fiscalYearId: year.id, date: input.date, description: input.description },
        rows,
        createdBy
      );
      return service.findVerificationById(header.id);
    },

    // The one create-and-book composition, inside the CALLER's transaction:
    // Spara och bokför above, a recurring post's monthly run and the SIE
    // verification import all go through here, so "created and booked at
    // once" has exactly one implementation — the repo's create followed by
    // the repo's booking body with all of its in-tx re-checks. The fiscal
    // year is resolved through the tx; rows are the caller's (validated)
    // VerificationRowWrite[]. A refused booking throws this module's own
    // error (bookFailureError), which rolls the caller's transaction back.
    async createVerificationInTx(
      tx: Tx,
      input: VerificationComposeInput,
      // null for a recurring post's job run (no user behind it).
      createdBy: string | null,
      opts: { book: boolean }
    ): Promise<{ id: string; verificationNumber: number | null }> {
      const year = await repo.findFiscalYearForDateTx(tx, input.date);
      if (!year) throw new NoFiscalYearForDateError(input.date);
      if (year.status === "closed") throw new FiscalYearClosedError(year.label);

      const header = await repo.createVerificationInTx(
        tx,
        { seriesId: input.seriesId, fiscalYearId: year.id, date: input.date, description: input.description },
        input.rows,
        createdBy
      );
      if (!opts.book) return { id: header.id, verificationNumber: null };

      try {
        const result = await repo.bookVerificationInTx(tx, header.id, createdBy);
        return { id: header.id, verificationNumber: result.verification.verificationNumber };
      } catch (err) {
        const failure = bookFailureReason(err);
        if (failure) throw bookFailureError(header.id, failure);
        throw err;
      }
    },

    // PUT /verifications/:id/rows — replace-the-set in one transaction under
    // the verification's row lock (the table editor saves every row at
    // once). Draft only; an empty list clears the rows. Same per-row
    // validation as addRow.
    async replaceRows(id: string, input: VerificationRowInput[]) {
      const existing = await repo.findRawById(id);
      if (!existing) throw new VerificationNotFoundError(id);
      if (existing.status !== "draft") {
        throw new InvalidVerificationStateError(`Cannot change rows on verification ${id}: it is not a draft`);
      }
      const rows: VerificationRowWrite[] = [];
      for (const r of input) rows.push(await resolveVerificationRow(repo, r));

      const replaced = await repo.replaceRows(id, rows);
      if (!replaced) throw new InvalidVerificationStateError(`Cannot change rows on verification ${id}: it is no longer a draft`);
      return service.findVerificationById(id);
    },

    // Kopiera: a new draft with the source's series, description and rows,
    // dated today (Stockholm). Works from every status. A row on an account
    // that has since been deactivated is left out and reported in
    // `warnings` — the copy must be bookable, and silently keeping the row
    // would only move the refusal to Bokför.
    async copy(id: string, userId: string) {
      const source = await service.findVerificationById(id);
      const today = stockholmToday();
      const year = await repo.findFiscalYearForDate(today);
      if (!year) throw new NoFiscalYearForDateError(today);
      if (year.status === "closed") throw new FiscalYearClosedError(year.label);

      const warnings: string[] = [];
      const rows: VerificationRowWrite[] = [];
      for (const row of source.rows) {
        const account = await repo.findAccountById(row.accountId);
        if (!account || !account.active) {
          warnings.push(`Konto ${row.accountNumber} ${row.accountName} är inaktivt — raden utelämnades`);
          continue;
        }
        rows.push({
          accountId: row.accountId,
          debit: round2(Number(row.debit)),
          credit: round2(Number(row.credit)),
          description: row.description,
        });
      }

      const header = await repo.createVerification(
        { seriesId: source.seriesId, fiscalYearId: year.id, date: today, description: source.description },
        rows,
        userId
      );
      await audit.log({
        entityType: "verification",
        entityId: source.displayNumber,
        action: "copied",
        detail: { copyId: header.id, rows: rows.length, skippedRows: warnings.length },
        userId,
      });
      return { verification: await service.findVerificationById(header.id), warnings };
    },

    // Header edits are allowed only in draft. A date change re-resolves
    // fiscalYearId (a draft may move across a fiscal year boundary) — a date
    // landing outside every fiscal year is rejected before the
    // draft-conditioned write even runs.
    async updateVerificationHeader(id: string, input: UpdateVerificationInput) {
      const existing = await repo.findRawById(id);
      if (!existing) throw new VerificationNotFoundError(id);
      if (existing.status !== "draft") {
        throw new InvalidVerificationStateError(`Cannot change verification ${id}: it is not a draft`);
      }

      const patch: { seriesId?: string; date?: string; fiscalYearId?: string; description?: string } = {};
      if (input.seriesId !== undefined) {
        if (!(await repo.findSeriesById(input.seriesId))) throw new VerificationSeriesNotFoundError(input.seriesId);
        patch.seriesId = input.seriesId;
      }
      if (input.description !== undefined) patch.description = input.description;
      if (input.date !== undefined) {
        const year = await repo.findFiscalYearForDate(input.date);
        if (!year) throw new NoFiscalYearForDateError(input.date);
        if (year.status === "closed") throw new FiscalYearClosedError(year.label);
        patch.date = input.date;
        patch.fiscalYearId = year.id;
      }

      const updated = await repo.updateVerificationHeader(id, patch);
      // null means a concurrent booking (Task 7) already froze this
      // verification between the check above and the repo's own row-locked
      // draft guard.
      if (!updated) throw new InvalidVerificationStateError(`Cannot change verification ${id}: it is no longer a draft`);
      return service.findVerificationById(id);
    },

    // Draft only — rows cascade via the FK.
    async deleteVerification(id: string) {
      const existing = await repo.findRawById(id);
      if (!existing) throw new VerificationNotFoundError(id);
      if (existing.status !== "draft") {
        throw new InvalidVerificationStateError(`Cannot delete verification ${id}: it is not a draft`);
      }
      const deleted = await repo.deleteVerification(id);
      if (!deleted) throw new InvalidVerificationStateError(`Cannot delete verification ${id}: it is no longer a draft`);
    },

    async addRow(verificationId: string, input: VerificationRowInput) {
      const existing = await repo.findRawById(verificationId);
      if (!existing) throw new VerificationNotFoundError(verificationId);
      if (existing.status !== "draft") {
        throw new InvalidVerificationStateError(`Cannot change rows on verification ${verificationId}: it is not a draft`);
      }
      const row = await repo.addRow(verificationId, await resolveVerificationRow(repo, input));
      if (!row) {
        throw new InvalidVerificationStateError(`Cannot add a row to verification ${verificationId}: it is no longer a draft`);
      }
      return row;
    },

    // Full-replace: verificationRowInputSchema carries every field (same
    // schema as create), so there is no partial-patch merge to do — just
    // re-validate the account and re-round the amounts.
    async updateRow(verificationId: string, rowId: string, input: VerificationRowInput) {
      const existing = await repo.findRawById(verificationId);
      if (!existing) throw new VerificationNotFoundError(verificationId);
      if (existing.status !== "draft") {
        throw new InvalidVerificationStateError(`Cannot change rows on verification ${verificationId}: it is not a draft`);
      }
      const existingRow = await repo.findRow(verificationId, rowId);
      if (!existingRow) throw new VerificationRowNotFoundError(rowId);

      const row = await repo.updateRow(verificationId, rowId, await resolveVerificationRow(repo, input));
      if (!row) {
        throw new InvalidVerificationStateError(`Cannot change rows on verification ${verificationId}: it is no longer a draft`);
      }
      return row;
    },

    async deleteRow(verificationId: string, rowId: string) {
      const existing = await repo.findRawById(verificationId);
      if (!existing) throw new VerificationNotFoundError(verificationId);
      if (existing.status !== "draft") {
        throw new InvalidVerificationStateError(`Cannot change rows on verification ${verificationId}: it is not a draft`);
      }
      const existingRow = await repo.findRow(verificationId, rowId);
      if (!existingRow) throw new VerificationRowNotFoundError(rowId);

      const row = await repo.deleteRow(verificationId, rowId);
      if (!row) {
        throw new InvalidVerificationStateError(`Cannot change rows on verification ${verificationId}: it is no longer a draft`);
      }
    },

    // draft -> booked, the commitment point. Guards run in order: exists;
    // is draft; >=2 rows; balanced (round2'd sums); every referenced account
    // is active; the date's accounting period exists and is open. This is
    // the FAST PATH — cheap, and gives specific errors for the common case
    // — but it reads against an UNLOCKED snapshot, so it cannot be trusted
    // alone: a concurrent row/account edit is still legal right up until
    // repo.bookVerification's own transaction commits (status is still
    // "draft"). repo.bookVerification re-validates the SAME three
    // conditions again under its FOR UPDATE lock and reports which one (if
    // any) still failed via a discriminated result — this fast path's job
    // is only to keep the common case cheap and its error specific; the
    // repo's re-check is the actual guarantee that a broken verification is
    // never booked (same split as invoiceService.issue() + the repo's
    // validateCommittedQuantities-inside-tx).
    async book(id: string, userId: string) {
      const verification = await repo.findVerificationById(id);
      if (!verification) throw new VerificationNotFoundError(id);
      if (verification.status !== "draft") {
        throw new InvalidVerificationStateError(`Cannot book verification ${id}: it is not a draft`);
      }
      if (verification.rows.length < 2) throw new TooFewVerificationRowsError(id);

      const totalDebit = round2(verification.rows.reduce((sum, row) => sum + Number(row.debit), 0));
      const totalCredit = round2(verification.rows.reduce((sum, row) => sum + Number(row.credit), 0));
      if (totalDebit !== totalCredit) throw new UnbalancedVerificationError(totalDebit, totalCredit);

      // Re-check every referenced account is still active — a row's account
      // could have been deactivated after the row was added to the draft.
      const accountIds = [...new Set(verification.rows.map((row) => row.accountId))];
      for (const accountId of accountIds) {
        const account = await repo.findAccountById(accountId);
        if (!account || !account.active) throw new InactiveAccountError(accountId);
      }

      const periodStatus = await repo.getPeriodStatusForDate(verification.date);
      if (periodStatus === null) throw new NoAccountingPeriodError(verification.date);
      if (periodStatus === "locked") throw new AccountingPeriodLockedError(verification.date);

      const result = await repo.bookVerification(id, userId);
      // The in-tx re-checks (see repo.bookVerificationInTx) — including the
      // period for `existing.date` under the FOR UPDATE lock, which catches
      // both an admin lock landing mid-booking and a concurrent header PATCH
      // moving `date` to a period the fast path above never saw at all.
      if (!result.ok) throw bookFailureError(id, result);

      const booked = await service.findVerificationById(result.verification.id);
      await audit.log({ entityType: "verification", entityId: booked.displayNumber, action: "booked", userId });
      return booked;
    },

    // Omför: raises a mirrored DRAFT against a booked source — debit and
    // credit swapped per row, same accounts/amounts, so source + reversal
    // always net to zero per account. The new draft is NOT auto-booked; the
    // caller books it separately through the ordinary book() above. The
    // reversesVerificationId link is written atomically with the draft's
    // header/row insert (repo.createVerification, one transaction) so no
    // unlinked reversal draft is ever observable.
    async reverse(id: string, userId: string) {
      const source = await repo.findRawById(id);
      if (!source) throw new VerificationNotFoundError(id);
      if (source.status !== "booked") {
        throw new InvalidVerificationStateError(`Cannot reverse verification ${id}: it is not booked`);
      }
      if (await repo.findFixedAssetLink(id)) throw new FixedAssetVerificationError(id);
      if (await repo.findYearEndLink(id)) throw new YearEndClosingVerificationError(id);
      // Friendly pre-check — the partial unique index on
      // reversesVerificationId is the real guarantee, caught below.
      if (await repo.findReversalOf(id)) throw new AlreadyReversedError(id);

      const sourceDetail = await service.findVerificationById(id);
      const today = new Date().toLocaleDateString("sv-SE");
      const year = await repo.findFiscalYearForDate(today);
      if (!year) throw new NoFiscalYearForDateError(today);
      // repo.createVerification has no year check of its own — the mirror
      // draft must not land in a closed year (createVerification's guard).
      if (year.status === "closed") throw new FiscalYearClosedError(year.label);

      const mirroredRows: VerificationRowWrite[] = sourceDetail.rows.map((row) => ({
        accountId: row.accountId,
        debit: round2(Number(row.credit)),
        credit: round2(Number(row.debit)),
        description: row.description,
      }));

      let header;
      try {
        header = await repo.createVerification(
          {
            seriesId: sourceDetail.seriesId,
            fiscalYearId: year.id,
            date: today,
            description: `Omföring av ${sourceDetail.displayNumber}`,
            reversesVerificationId: id,
          },
          mirroredRows,
          userId
        );
      } catch (err) {
        if (isUniqueViolation(err)) throw new AlreadyReversedError(id);
        throw err;
      }

      await audit.log({
        entityType: "verification",
        entityId: sourceDetail.displayNumber,
        action: "reversal_created",
        userId,
      });
      return service.findVerificationById(header.id);
    },

    // --- Huvudbok (general ledger) ---

    // Ledger = pure aggregation over BOOKED verifications only, re-derived on
    // every call — nothing here is ever stored. The repo hands back opening
    // balance + raw rows (amounts as numeric strings, same convention as
    // every other repo); this layer converts to numbers to walk the running
    // balance (running = opening + cumulative Σ(debit − credit)) and layers
    // displayNumber on top, same "<seriesCode>-<yearLabel>-<n>" builder used
    // by findVerificationById/listVerifications — every row here is booked
    // by construction (the repo only ever selects status='booked' rows), so
    // displayNumber never falls back to "Utkast".
    async getLedger(query: LedgerQuery) {
      const account = await repo.findAccountById(query.accountId);
      if (!account) throw new AccountNotFoundError(query.accountId);

      // A result account (class 3–8) starts every fiscal year at 0 — its IB
      // counts only from the start of the year containing `from` (same rule
      // as the multi-account huvudbok). Outside any year: cumulative.
      const openingFrom =
        query.from && classifyAccount(account.number).report !== "balanceSheet"
          ? (await repo.findFiscalYearForDate(query.from))?.startDate
          : undefined;
      const { openingBalance, rows } = await repo.getLedger(query.accountId, query.from, query.to, openingFrom);

      let running = round2(Number(openingBalance));
      const openingBalanceNumber = running;
      const ledgerRows = rows.map((row) => {
        running = round2(running + Number(row.debit) - Number(row.credit));
        return {
          date: row.date,
          seriesCode: row.seriesCode,
          yearLabel: row.yearLabel,
          verificationNumber: row.verificationNumber,
          displayNumber: displayNumber({
            status: "booked",
            seriesCode: row.seriesCode,
            yearLabel: row.yearLabel,
            verificationNumber: row.verificationNumber,
          }),
          description: row.description,
          debit: row.debit,
          credit: row.credit,
          verificationId: row.verificationId,
          balance: running,
        };
      });

      return {
        accountId: query.accountId,
        accountNumber: account.number,
        accountName: account.name,
        from: query.from ?? null,
        to: query.to ?? null,
        openingBalance: openingBalanceNumber,
        closingBalance: running,
        rows: ledgerRows,
      };
    },

    // --- Konteringsregler (B2 automatkontering) ---

    async listPostingRules() {
      return repo.listPostingRules();
    },

    // Validates the referenced article group and both accounts (existence +
    // active, same resolveVerificationRow-style checks) before the insert —
    // an unknown/inactive account is reported as a mapped 404/400, never a
    // raw FK violation. The (group, vatRate) uniqueness itself is left to
    // the DB's two partial indexes, caught below via isUniqueViolation (same
    // idiom as createAccount/createSeries) rather than a TOCTOU-prone
    // pre-check.
    async createPostingRule(input: CreatePostingRuleInput) {
      if (!(await repo.findArticleGroupById(input.articleGroupId))) {
        throw new ArticleGroupNotFoundError(input.articleGroupId);
      }
      const vatCodeId = input.vatCodeId ?? null;
      const vatCode = vatCodeId === null ? null : await requirePostingRuleVatCode(vatCodeId);
      if (input.revenueAccountId !== null) await requireActiveAccount(repo, input.revenueAccountId);
      if (input.costAccountId !== null) await requireActiveAccount(repo, input.costAccountId);

      try {
        return await repo.createPostingRule({
          articleGroupId: input.articleGroupId,
          vatCodeId,
          revenueAccountId: input.revenueAccountId,
          costAccountId: input.costAccountId,
        });
      } catch (err) {
        if (isUniqueViolation(err)) throw new DuplicatePostingRuleError(input.articleGroupId, vatCode?.code ?? null);
        throw err;
      }
    },

    // Partial patch — every touched reference is re-validated the same way
    // createPostingRule does. The "at least one account" invariant is
    // re-checked here against the MERGED result (stored row + patch), not
    // just the patch itself: updatePostingRuleSchema's own refine can only
    // see the patch (see PostingRuleNoAccountsError's comment above), so a
    // payload like {revenueAccountId: null} alone would otherwise silently
    // null out the group's only account when the stored costAccountId is
    // also null.
    async updatePostingRule(id: string, input: UpdatePostingRuleInput) {
      const existing = await repo.findPostingRuleById(id);
      if (!existing) throw new PostingRuleNotFoundError(id);

      if (input.articleGroupId !== undefined) {
        if (!(await repo.findArticleGroupById(input.articleGroupId))) {
          throw new ArticleGroupNotFoundError(input.articleGroupId);
        }
      }
      if (input.vatCodeId !== undefined && input.vatCodeId !== null) await requirePostingRuleVatCode(input.vatCodeId);
      if (input.revenueAccountId !== undefined && input.revenueAccountId !== null) {
        await requireActiveAccount(repo, input.revenueAccountId);
      }
      if (input.costAccountId !== undefined && input.costAccountId !== null) {
        await requireActiveAccount(repo, input.costAccountId);
      }

      const mergedRevenueAccountId = input.revenueAccountId !== undefined ? input.revenueAccountId : existing.revenueAccountId;
      const mergedCostAccountId = input.costAccountId !== undefined ? input.costAccountId : existing.costAccountId;
      if (mergedRevenueAccountId === null && mergedCostAccountId === null) {
        throw new PostingRuleNoAccountsError(id);
      }

      const patch: PostingRulePatch = {};
      if (input.articleGroupId !== undefined) patch.articleGroupId = input.articleGroupId;
      if (input.vatCodeId !== undefined) patch.vatCodeId = input.vatCodeId;
      if (input.revenueAccountId !== undefined) patch.revenueAccountId = input.revenueAccountId;
      if (input.costAccountId !== undefined) patch.costAccountId = input.costAccountId;

      try {
        const updated = await repo.updatePostingRule(id, patch);
        if (!updated) throw new PostingRuleNotFoundError(id);
        return updated;
      } catch (err) {
        if (isUniqueViolation(err)) {
          const mergedArticleGroupId = input.articleGroupId ?? existing.articleGroupId;
          const mergedVatCodeId = input.vatCodeId !== undefined ? input.vatCodeId : existing.vatCodeId;
          const mergedVatCode = mergedVatCodeId === null ? null : await repo.findVatCodeById(mergedVatCodeId);
          throw new DuplicatePostingRuleError(mergedArticleGroupId, mergedVatCode?.code ?? null);
        }
        throw err;
      }
    },

    async deletePostingRule(id: string) {
      const deleted = await repo.deletePostingRule(id);
      if (!deleted) throw new PostingRuleNotFoundError(id);
    },
  };

  return service;
}

export type EconomyService = ReturnType<typeof createEconomyService>;

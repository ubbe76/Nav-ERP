import { and, asc, count, desc, eq, getTableColumns, gte, ilike, inArray, lt, lte, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  accountingPeriods,
  accounts,
  articleGroups,
  costCenters,
  fiscalYears,
  projects,
  fixedAssetDepreciationRuns,
  fixedAssets,
  postingRules,
  users,
  vatCodes,
  verificationFiles,
  verificationRows,
  verifications,
  verificationSeries,
  yearEndClosings,
  yearEndClosingVerifications,
  type Db,
  type Tx,
} from "@navet/db";
import {
  ilikePattern,
  round2,
  type CreateFiscalYearInput,
  type CreateVerificationSeriesInput,
  type ListAccountsQuery,
  type ListVerificationsQuery,
  type UpdateAccountInput,
  type UpdateVerificationSeriesInput,
  type DimensionIds,
  type VatBoxSetting,
} from "@navet/shared";
import { generateMonthlyPeriods } from "../service/month-periods.js";
import { allocateVerificationNumber } from "../service/verification-number.js";
import { resolveDimensions, type DimensionInput } from "../service/dimension-check.js";

// Internal signal thrown INSIDE bookVerification's transaction when the
// draft-conditioned UPDATE matches no row — forces a rollback that undoes
// the number allocation too (a lost race never burns a number). Never
// exported; the catch right below normalizes it to a `{ ok: false, reason:
// "race" }` result, same idiom as invoiceRepository's IssueRaceError.
class BookRaceError extends Error {}

// The service's own book() pre-checks (row count / balance / active
// accounts) run against an UNLOCKED read taken before this transaction
// opens — a concurrent row/account edit is still legal at that point
// (status is still "draft" until the UPDATE below commits), so it can
// invalidate those checks in the window before the FOR UPDATE lock closes
// it. Booked verifications are immutable, so re-validating ONLY under the
// lock (not just at the service's fast path) is the only way to keep an
// unbalanced/too-few-rows/inactive-account verification from ever being
// booked — same bug class C1's issueInvoice closed with
// validateCommittedQuantities-inside-tx. These three signals are internal
// (never exported); the catch below turns each into its own discriminated
// failure reason so the service can raise its own, already-defined error
// classes without this repository importing them (which would invert the
// module's dependency direction).
class TooFewRowsAtBookingError extends Error {}
class UnbalancedAtBookingError extends Error {
  constructor(
    public totalDebit: number,
    public totalCredit: number
  ) {
    super();
  }
}
class InactiveAccountAtBookingError extends Error {
  constructor(public accountId: string) {
    super();
  }
}
// Fourth in-tx re-check, same TOCTOU rationale as the three above: the
// service's fast-path period-status read (repo.getPeriodStatusForDate) runs
// against an unlocked snapshot BEFORE this transaction opens, so it misses
// two races — an admin locking the period mid-booking, and a concurrent
// header PATCH moving `date` to a different (possibly locked) period between
// the fast path and this transaction. `existing.date`, read under the FOR
// UPDATE lock above, is the only value that can be trusted here.
class LockedPeriodAtBookingError extends Error {
  constructor(public date: string) {
    super();
  }
}
class NoPeriodAtBookingError extends Error {
  constructor(public date: string) {
    super();
  }
}
// Fifth in-tx check (kostnadsställen och projekt): a row on an account with
// Kräver kostnadsställe but no cost center. Read under the same lock as the
// others — the flag can be set between the draft and Bokför.
class CostCenterRequiredAtBookingError extends Error {
  constructor(public accountNumbers: string[]) {
    super();
  }
}

// Maps the booking body's internal signals to the discriminated failure
// result bookVerification() returns — null for any other error. Exported for
// the service's in-transaction compositions (create + book), which catch
// around their own db.transaction() the same way bookVerification does.
export type BookFailure =
  | { ok: false; reason: "race" }
  | { ok: false; reason: "too_few_rows" }
  | { ok: false; reason: "unbalanced"; totalDebit: number; totalCredit: number }
  | { ok: false; reason: "inactive_account"; accountId: string }
  | { ok: false; reason: "locked_period"; date: string }
  | { ok: false; reason: "no_period"; date: string }
  | { ok: false; reason: "cost_center_required"; accountNumbers: string[] };

export function bookFailureReason(err: unknown): BookFailure | null {
  if (err instanceof BookRaceError) return { ok: false, reason: "race" };
  if (err instanceof TooFewRowsAtBookingError) return { ok: false, reason: "too_few_rows" };
  if (err instanceof UnbalancedAtBookingError) {
    return { ok: false, reason: "unbalanced", totalDebit: err.totalDebit, totalCredit: err.totalCredit };
  }
  if (err instanceof InactiveAccountAtBookingError) return { ok: false, reason: "inactive_account", accountId: err.accountId };
  if (err instanceof LockedPeriodAtBookingError) return { ok: false, reason: "locked_period", date: err.date };
  if (err instanceof NoPeriodAtBookingError) return { ok: false, reason: "no_period", date: err.date };
  if (err instanceof CostCenterRequiredAtBookingError) return { ok: false, reason: "cost_center_required", accountNumbers: err.accountNumbers };
  return null;
}

// A verification header ready to write — fiscalYearId is always resolved by
// the SERVICE from `date` (findFiscalYearForDate), never accepted from the
// client, same division of labor as invoiceRepository's InvoiceHeaderWrite.
export type VerificationHeaderWrite = {
  seriesId: string;
  fiscalYearId: string;
  date: string;
  description: string;
  // Set only when this draft is the mirror of a booked verification (Omför)
  // — written atomically with the header/row insert (same transaction) so
  // no unlinked reversal draft is ever observable. The partial unique index
  // (verifications_reverses_unique) is the actual race guarantee; the
  // service's pre-check is just the friendly 409 in front of it.
  reversesVerificationId?: string;
};

// Header patch (draft only). fiscalYearId is included only when the service
// re-resolved it because `date` changed — omitted otherwise, leaving the
// stored value untouched.
type VerificationHeaderPatch = {
  seriesId?: string;
  date?: string;
  fiscalYearId?: string;
  description?: string;
};

// A row ready to write — debit/credit already round2:ed by the service (the
// XOR shape itself is guaranteed by verificationRowInputSchema before this
// type is ever constructed).
export type VerificationRowWrite = {
  accountId: string;
  debit: number;
  credit: number;
  description: string | null;
  // Kostnadsställen och projekt — omitted = none (direct repository callers
  // and the compositions that predate the dimensions).
  costCenterId?: string | null;
  projectId?: string | null;
};

// The aliases every row read joins so a row can show its objects as
// { id, code, name } | null.
const rowCostCenters = alias(costCenters, "row_cost_centers");
const rowProjects = alias(projects, "row_projects");
const rowDimensionColumns = {
  costCenter: {
    id: rowCostCenters.id,
    code: rowCostCenters.code,
    name: rowCostCenters.name,
  },
  project: {
    id: rowProjects.id,
    code: rowProjects.code,
    name: rowProjects.name,
  },
};

// drizzle hands a nested selection off a LEFT JOIN back as null when the
// join found nothing, so the { id, code, name } | null shape needs no
// post-processing.

// A posting rule ready to write — vatCodeId null = "Alla momskoder".
export type PostingRuleWrite = {
  articleGroupId: string;
  vatCodeId: string | null;
  revenueAccountId: string | null;
  costAccountId: string | null;
};

// Partial — only the fields the service actually wants to change are
// present, same convention as VerificationHeaderPatch above.
export type PostingRulePatch = Partial<PostingRuleWrite>;

// Kontoplan (chart of accounts). NOT the generic register family — see
// schema/economy.ts: BAS legitimately repeats names across accounts, so only
// the 4-digit number is unique, and listing sorts by number rather than name.
export function createEconomyRepository(db: Db) {
  // The booking body itself, composable into a caller's transaction (Spara
  // och bokför, a recurring run and the SIE verification import all create
  // and book in ONE transaction). Throws the internal signals; the caller
  // maps them with bookFailureReason() — a throw is what rolls the caller's
  // whole transaction back, including the create.
  async function bookVerificationInTx(tx: Tx, id: string, userId: string | null) {
    const [existing] = await tx.select().from(verifications).where(eq(verifications.id, id)).for("update");
    if (!existing || existing.status !== "draft") throw new BookRaceError();

    const lockedRows = await tx
      .select({
        accountId: verificationRows.accountId,
        debit: verificationRows.debit,
        credit: verificationRows.credit,
        costCenterId: verificationRows.costCenterId,
      })
      .from(verificationRows)
      .where(eq(verificationRows.verificationId, id));
    if (lockedRows.length < 2) throw new TooFewRowsAtBookingError();

    const totalDebit = round2(lockedRows.reduce((sum, row) => sum + Number(row.debit), 0));
    const totalCredit = round2(lockedRows.reduce((sum, row) => sum + Number(row.credit), 0));
    if (totalDebit !== totalCredit) throw new UnbalancedAtBookingError(totalDebit, totalCredit);

    const accountIds = [...new Set(lockedRows.map((row) => row.accountId))];
    const lockedAccounts = await tx
      .select({ id: accounts.id, number: accounts.number, active: accounts.active, costCenterRequired: accounts.costCenterRequired })
      .from(accounts)
      .where(inArray(accounts.id, accountIds));
    const accountById = new Map(lockedAccounts.map((account) => [account.id, account] as const));
    for (const accountId of accountIds) {
      const account = accountById.get(accountId);
      if (!account || !account.active) throw new InactiveAccountAtBookingError(accountId);
    }

    // Kräver kostnadsställe: a manual booking never passes without one on
    // such an account (the automatkontering books through the poster, which
    // does not come here — it warns instead).
    const missingCostCenter = [
      ...new Set(
        lockedRows
          .filter((row) => row.costCenterId === null && accountById.get(row.accountId)?.costCenterRequired)
          .map((row) => accountById.get(row.accountId)!.number)
      ),
    ].sort();
    if (missingCostCenter.length > 0) throw new CostCenterRequiredAtBookingError(missingCostCenter);

    // Fourth re-check, under the same lock: `existing.date` is the ONLY
    // value proven fresh at this point — a concurrent header PATCH could
    // have moved the draft's date to a different period between the
    // service's fast path and here, and that fresh date was never
    // period-checked at all until now. Same query shape as
    // getPeriodStatusForDate, but via `tx` so it sees the locked row.
    const [periodRow] = await tx
      .select({ status: accountingPeriods.status })
      .from(accountingPeriods)
      .where(and(lte(accountingPeriods.startDate, existing.date), gte(accountingPeriods.endDate, existing.date)));
    const periodStatus = periodRow?.status ?? null;
    if (periodStatus === null) throw new NoPeriodAtBookingError(existing.date);
    if (periodStatus === "locked") throw new LockedPeriodAtBookingError(existing.date);

    const verificationNumber = await allocateVerificationNumber(tx, existing.seriesId, existing.fiscalYearId);

    const [row] = await tx
      .update(verifications)
      .set({
        verificationNumber,
        status: "booked",
        bookedAt: new Date(),
        bookedBy: userId,
        updatedAt: new Date(),
      })
      .where(and(eq(verifications.id, id), eq(verifications.status, "draft")))
      .returning();
    if (!row) throw new BookRaceError();
    return { ok: true as const, verification: row };
  }

  // The header + row insert itself, composable into a caller's transaction
  // (see bookVerificationInTx). No number allocation here — the
  // verifikatnummer is assigned at booking.
  async function createVerificationInTx(tx: Tx, header: VerificationHeaderWrite, rows: VerificationRowWrite[], createdBy: string | null) {
    const [verification] = await tx
      .insert(verifications)
      .values({
        seriesId: header.seriesId,
        fiscalYearId: header.fiscalYearId,
        date: header.date,
        description: header.description,
        reversesVerificationId: header.reversesVerificationId ?? null,
        createdBy,
      })
      .returning();
    if (rows.length > 0) {
      // createdAt is stamped explicitly, one tick per row, instead of
      // relying on the column's now()-default: Postgres evaluates now()
      // once per transaction, so every row in this single multi-row INSERT
      // would otherwise share the exact same timestamp — leaving the row
      // listing's `ORDER BY createdAt` with nothing to break the tie, so
      // ties resolve however the planner's access path happens to visit
      // them (occasionally NOT insertion order). Explicit, strictly
      // increasing timestamps make that order deterministic and match input
      // order (same fix as invoiceRepository.create).
      const now = Date.now();
      await tx.insert(verificationRows).values(
        rows.map((r, i) => ({
          verificationId: verification!.id,
          accountId: r.accountId,
          debit: String(r.debit),
          credit: String(r.credit),
          description: r.description,
          costCenterId: r.costCenterId ?? null,
          projectId: r.projectId ?? null,
          createdAt: new Date(now + i),
        }))
      );
    }
    return verification!;
  }

  return {
    // For the service's own compositions (create + book in one transaction)
    // — the service never imports the db client itself.
    transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
      return db.transaction(fn);
    },

    async listAccounts(query: ListAccountsQuery) {
      const conditions = [];
      if (!query.includeInactive) conditions.push(eq(accounts.active, true));
      if (query.search) {
        const pattern = ilikePattern(query.search);
        conditions.push(or(ilike(accounts.number, pattern), ilike(accounts.name, pattern)));
      }
      const where = conditions.length > 0 ? and(...conditions) : undefined;

      const [rows, totalRows] = await Promise.all([
        db.select().from(accounts).where(where).orderBy(asc(accounts.number)).limit(query.limit).offset(query.offset),
        db.select({ total: count() }).from(accounts).where(where),
      ]);
      return { rows, total: totalRows[0]!.total };
    },

    // Number + name for every ACTIVE account, nothing else — the dropdown
    // feed for pickers outside Ekonomi (B3's betalkonto on the payment form).
    // Deliberately not the full account row: no balances, no flags, no
    // inactive accounts.
    async listAccountOptions() {
      return db
        .select({ number: accounts.number, name: accounts.name })
        .from(accounts)
        .where(eq(accounts.active, true))
        .orderBy(asc(accounts.number));
    },

    async findAccountById(id: string) {
      const [row] = await db.select().from(accounts).where(eq(accounts.id, id));
      return row ?? null;
    },

    async findAccountByNumber(number: string) {
      const [row] = await db.select().from(accounts).where(eq(accounts.number, number));
      return row ?? null;
    },

    async createAccount(input: { number: string; name: string; vatBox: VatBoxSetting | null; costCenterRequired?: boolean }) {
      const [row] = await db.insert(accounts).values(input).returning();
      return row!;
    },

    async updateAccount(id: string, input: UpdateAccountInput) {
      const [row] = await db.update(accounts).set(input).where(eq(accounts.id, id)).returning();
      return row ?? null;
    },

    // Seeds the BAS standard accounts in ONE round-trip: existing numbers are
    // left untouched (onConflictDoNothing, e.g. a renamed 1930 survives a
    // re-run) rather than N per-entry insert-if-missing calls.
    async seedAccounts(entries: { number: string; name: string; vatBox?: VatBoxSetting }[]) {
      const rows = await db
        .insert(accounts)
        .values(entries.map((entry) => ({ number: entry.number, name: entry.name, vatBox: entry.vatBox ?? null })))
        .onConflictDoNothing({ target: accounts.number })
        .returning();
      return rows.length;
    },

    // --- Räkenskapsår & periods ---

    // Creates the year and its generated monthly periods in one transaction
    // — a failed period insert (e.g. a constraint violation) must never leave
    // an orphan fiscal-year row behind. Month generation is a pure function
    // (month-periods.ts, leaf-like — no dependency on this repository or on
    // economy.service.ts) called from inside the transaction.
    async createFiscalYearWithPeriods(input: CreateFiscalYearInput) {
      return db.transaction(async (tx) => {
        const [year] = await tx
          .insert(fiscalYears)
          .values({ label: input.label, startDate: input.startDate, endDate: input.endDate })
          .returning();

        const periodValues = generateMonthlyPeriods(input.startDate, input.endDate).map((period) => ({
          fiscalYearId: year!.id,
          startDate: period.startDate,
          endDate: period.endDate,
        }));
        const periods = await tx.insert(accountingPeriods).values(periodValues).returning();
        // Multi-row INSERT...RETURNING order isn't guaranteed by Postgres —
        // sort explicitly rather than relying on it, same as
        // findFiscalYearById's periods query.
        periods.sort((a, b) => a.startDate.localeCompare(b.startDate));

        return { ...year!, periods };
      });
    },

    // Newest year first, each with its period count — a lightweight second
    // query rather than a join+groupBy, since the number of fiscal years is
    // always small (one per accounting year the company has ever had).
    async listFiscalYears() {
      const years = await db.select().from(fiscalYears).orderBy(desc(fiscalYears.startDate));
      if (years.length === 0) return [];

      const counts = await db
        .select({ fiscalYearId: accountingPeriods.fiscalYearId, periodCount: count() })
        .from(accountingPeriods)
        .where(
          inArray(
            accountingPeriods.fiscalYearId,
            years.map((year) => year.id)
          )
        )
        .groupBy(accountingPeriods.fiscalYearId);
      const countByYear = new Map(counts.map((row) => [row.fiscalYearId, row.periodCount]));

      return years.map((year) => ({ ...year, periodCount: countByYear.get(year.id) ?? 0 }));
    },

    async findFiscalYearById(id: string) {
      const [year] = await db.select().from(fiscalYears).where(eq(fiscalYears.id, id));
      if (!year) return null;

      const periods = await db
        .select()
        .from(accountingPeriods)
        .where(eq(accountingPeriods.fiscalYearId, id))
        .orderBy(asc(accountingPeriods.startDate));
      return { ...year, periods };
    },

    async findFiscalYearForDate(date: string) {
      const [year] = await db
        .select()
        .from(fiscalYears)
        .where(and(lte(fiscalYears.startDate, date), gte(fiscalYears.endDate, date)));
      return year ?? null;
    },

    async findPeriodById(id: string) {
      const [row] = await db.select().from(accountingPeriods).where(eq(accountingPeriods.id, id));
      return row ?? null;
    },

    async findPeriodForDate(date: string) {
      const [row] = await db
        .select()
        .from(accountingPeriods)
        .where(and(lte(accountingPeriods.startDate, date), gte(accountingPeriods.endDate, date)));
      return row ?? null;
    },

    // Status-only read for the lock-checker leaf file. A date with no
    // covering period returns null (not "open") — distinct from payroll's
    // convention, see accounting-period-lock.ts's header comment.
    async getPeriodStatusForDate(date: string): Promise<"open" | "locked" | null> {
      const [row] = await db
        .select({ status: accountingPeriods.status })
        .from(accountingPeriods)
        .where(and(lte(accountingPeriods.startDate, date), gte(accountingPeriods.endDate, date)));
      return row?.status ?? null;
    },

    // Conditional lock: only flips a period that is currently open. An
    // already-locked period matches no row, so this returns null and the
    // service turns that into a 409 instead of re-stamping lockedAt/lockedBy.
    async lockPeriod(id: string, userId: string) {
      const [row] = await db
        .update(accountingPeriods)
        .set({ status: "locked", lockedAt: new Date(), lockedBy: userId })
        .where(and(eq(accountingPeriods.id, id), eq(accountingPeriods.status, "open")))
        .returning();
      return row ?? null;
    },

    // Conditional unlock: only flips a period that is currently locked.
    async unlockPeriod(id: string) {
      const [row] = await db
        .update(accountingPeriods)
        .set({ status: "open", lockedAt: null, lockedBy: null })
        .where(and(eq(accountingPeriods.id, id), eq(accountingPeriods.status, "locked")))
        .returning();
      return row ?? null;
    },

    // --- Verifikatserier ---
    // Small register (A = manuella, B2 adds more) — list all, no pagination,
    // same shape as listFiscalYears.
    async listSeries() {
      return db.select().from(verificationSeries).orderBy(asc(verificationSeries.code));
    },

    async findSeriesByCode(code: string) {
      const [row] = await db.select().from(verificationSeries).where(eq(verificationSeries.code, code));
      return row ?? null;
    },

    // Existence check for a referenced seriesId (verifications.seriesId) —
    // used by economy.service.ts's createVerification/updateVerificationHeader
    // so a bogus/deleted id is reported as a mapped 404 instead of a raw FK
    // violation surfacing as a 500 (arkitekturprincip 5: integration-friendly).
    async findSeriesById(id: string) {
      const [row] = await db.select().from(verificationSeries).where(eq(verificationSeries.id, id));
      return row ?? null;
    },

    async createSeries(input: CreateVerificationSeriesInput) {
      const [row] = await db.insert(verificationSeries).values(input).returning();
      return row!;
    },

    async updateSeries(id: string, input: UpdateVerificationSeriesInput) {
      const [row] = await db.update(verificationSeries).set(input).where(eq(verificationSeries.id, id)).returning();
      return row ?? null;
    },

    // Guard for the service's code-lock rule (SeriesCodeLockedError): a
    // series that has ever been used to create a verification — draft or
    // booked — must keep its code, since displayNumber is built at read time
    // from seriesCode and a rename would retroactively renumber every
    // historical verifikat string. Counts ANY verification, not just booked
    // ones (a simpler, more conservative rule than distinguishing the two).
    async seriesHasVerifications(seriesId: string): Promise<boolean> {
      // The caller only asks "any at all?" — LIMIT 1 instead of a full COUNT
      // over a table with no plain seriesId index.
      const [row] = await db
        .select({ id: verifications.id })
        .from(verifications)
        .where(eq(verifications.seriesId, seriesId))
        .limit(1);
      return row !== undefined;
    },

    // --- Verifikat (verifications) ---

    async listVerifications(query: ListVerificationsQuery) {
      const conditions = [];
      if (query.search) conditions.push(ilike(verifications.description, ilikePattern(query.search)));
      if (query.fiscalYearId) conditions.push(eq(verifications.fiscalYearId, query.fiscalYearId));
      if (query.seriesId) conditions.push(eq(verifications.seriesId, query.seriesId));
      if (query.status) conditions.push(inArray(verifications.status, query.status));
      const where = conditions.length > 0 ? and(...conditions) : undefined;

      // seriesCode/yearLabel joined here so the service can build the
      // displayNumber ("A-2026-17" / "Utkast") without a per-row round trip.
      const [rows, totalRows] = await Promise.all([
        db
          .select({ ...getTableColumns(verifications), seriesCode: verificationSeries.code, yearLabel: fiscalYears.label })
          .from(verifications)
          .innerJoin(verificationSeries, eq(verificationSeries.id, verifications.seriesId))
          .innerJoin(fiscalYears, eq(fiscalYears.id, verifications.fiscalYearId))
          .where(where)
          .orderBy(desc(verifications.date), desc(verifications.createdAt))
          .limit(query.limit)
          .offset(query.offset),
        db
          .select({ total: count() })
          .from(verifications)
          .innerJoin(verificationSeries, eq(verificationSeries.id, verifications.seriesId))
          .innerJoin(fiscalYears, eq(fiscalYears.id, verifications.fiscalYearId))
          .where(where),
      ]);
      return { rows, total: totalRows[0]!.total };
    },

    // Unpaginated sibling of listVerifications for the B6a printout: the
    // same filter set plus an optional date range, ordered for printing.
    // Two queries, never N+1 — headers first, then every row for those ids.
    async listVerificationsForReport(query: {
      from?: string;
      to?: string;
      fiscalYearId?: string;
      seriesId?: string;
      status?: ("draft" | "booked")[];
      search?: string;
      costCenterId?: string;
      projectId?: string;
    }) {
      const conditions = [];
      if (query.search) conditions.push(ilike(verifications.description, ilikePattern(query.search)));
      if (query.fiscalYearId) conditions.push(eq(verifications.fiscalYearId, query.fiscalYearId));
      if (query.seriesId) conditions.push(eq(verifications.seriesId, query.seriesId));
      if (query.status) conditions.push(inArray(verifications.status, query.status));
      if (query.from) conditions.push(gte(verifications.date, query.from));
      if (query.to) conditions.push(lte(verifications.date, query.to));
      // Kostnadsställen och projekt: verifications with at least one row on
      // the object(s) — every row of those verifications is then listed.
      const dimensionConditions = [];
      if (query.costCenterId) dimensionConditions.push(eq(verificationRows.costCenterId, query.costCenterId));
      if (query.projectId) dimensionConditions.push(eq(verificationRows.projectId, query.projectId));
      if (dimensionConditions.length > 0) {
        conditions.push(
          sql`exists (select 1 from ${verificationRows} where ${verificationRows.verificationId} = ${verifications.id} and ${and(...dimensionConditions)})`
        );
      }
      const where = conditions.length > 0 ? and(...conditions) : undefined;

      const headers = await db
        .select({
          ...getTableColumns(verifications),
          seriesCode: verificationSeries.code,
          yearLabel: fiscalYears.label,
        })
        .from(verifications)
        .innerJoin(verificationSeries, eq(verificationSeries.id, verifications.seriesId))
        .innerJoin(fiscalYears, eq(fiscalYears.id, verifications.fiscalYearId))
        .where(where)
        .orderBy(asc(verifications.date), asc(verifications.verificationNumber), asc(verificationSeries.code));

      if (headers.length === 0) return { headers, rows: [] };

      const rows = await db
        .select({
          ...getTableColumns(verificationRows),
          accountNumber: accounts.number,
          accountName: accounts.name,
          ...rowDimensionColumns,
        })
        .from(verificationRows)
        .innerJoin(accounts, eq(accounts.id, verificationRows.accountId))
        .leftJoin(rowCostCenters, eq(rowCostCenters.id, verificationRows.costCenterId))
        .leftJoin(rowProjects, eq(rowProjects.id, verificationRows.projectId))
        .where(
          inArray(
            verificationRows.verificationId,
            headers.map((header) => header.id)
          )
        )
        .orderBy(asc(verificationRows.verificationId), asc(verificationRows.createdAt));

      return { headers, rows };
    },

    // Guard against importing opening balances twice — the second import
    // would double every balance. Keyed on the I series, which only the SIE
    // importer ever writes to.
    async findOpeningBalanceVerification(fiscalYearId: string) {
      const [row] = await db
        .select({
          seriesCode: verificationSeries.code,
          yearLabel: fiscalYears.label,
          verificationNumber: verifications.verificationNumber,
        })
        .from(verifications)
        .innerJoin(verificationSeries, eq(verificationSeries.id, verifications.seriesId))
        .innerJoin(fiscalYears, eq(fiscalYears.id, verifications.fiscalYearId))
        .where(
          and(
            eq(verifications.fiscalYearId, fiscalYearId),
            eq(verificationSeries.code, "I"),
            eq(verifications.status, "booked")
          )
        )
        .limit(1);
      if (!row) return null;
      return { displayNumber: `${row.seriesCode}-${row.yearLabel}-${row.verificationNumber}` };
    },

    // Latest booked verification date strictly before `date` — the SIE
    // importer's guard against double-counting an opening balance the ledger
    // already carries forward on its own.
    async findLatestBookedDateBefore(date: string) {
      const [row] = await db
        .select({ date: verifications.date })
        .from(verifications)
        .where(and(eq(verifications.status, "booked"), lt(verifications.date, date)))
        .orderBy(desc(verifications.date))
        .limit(1);
      return row?.date ?? null;
    },

    // Tx-scoped account lookup/create for the SIE import, which must create
    // missing accounts and book against them inside one transaction.
    async findAccountByNumberTx(tx: Tx, number: string) {
      const [account] = await tx.select().from(accounts).where(eq(accounts.number, number));
      return account ?? null;
    },

    async createAccountTx(tx: Tx, input: { number: string; name: string; vatBox: VatBoxSetting | null }) {
      await tx.insert(accounts).values(input).onConflictDoNothing({ target: accounts.number });
    },

    // Kostnadsställen och projekt: every object of the two registers for the
    // SIE export's #OBJEKT lines — inactive and closed ones included, since a
    // booked row may still carry them.
    async listSieObjects(): Promise<{ dimension: 1 | 6; code: string; name: string }[]> {
      const [cc, pr] = await Promise.all([
        db.select({ code: costCenters.code, name: costCenters.name }).from(costCenters).orderBy(asc(costCenters.code)),
        db.select({ code: projects.code, name: projects.name }).from(projects).orderBy(asc(projects.code)),
      ]);
      return [...cc.map((row) => ({ dimension: 1 as const, ...row })), ...pr.map((row) => ({ dimension: 6 as const, ...row }))];
    },

    // Every BOOKED verification of a fiscal year with its rows, for the SIE
    // export. Ordered series then ascending number — the SIE spec requires
    // ascending verification numbers within a series. Two queries, no N+1.
    async listVerificationsForSie(fiscalYearId: string) {
      const headers = await db
        .select({
          id: verifications.id,
          seriesCode: verificationSeries.code,
          verificationNumber: verifications.verificationNumber,
          date: verifications.date,
          description: verifications.description,
        })
        .from(verifications)
        .innerJoin(verificationSeries, eq(verificationSeries.id, verifications.seriesId))
        .where(and(eq(verifications.fiscalYearId, fiscalYearId), eq(verifications.status, "booked")))
        .orderBy(asc(verificationSeries.code), asc(verifications.verificationNumber));

      if (headers.length === 0) return [];

      const rows = await db
        .select({
          verificationId: verificationRows.verificationId,
          accountNumber: accounts.number,
          debit: verificationRows.debit,
          credit: verificationRows.credit,
          description: verificationRows.description,
          // SIE object codes (#TRANS {1 "kod" 6 "kod"}).
          costCenterCode: rowCostCenters.code,
          projectCode: rowProjects.code,
        })
        .from(verificationRows)
        .innerJoin(accounts, eq(accounts.id, verificationRows.accountId))
        .leftJoin(rowCostCenters, eq(rowCostCenters.id, verificationRows.costCenterId))
        .leftJoin(rowProjects, eq(rowProjects.id, verificationRows.projectId))
        .where(
          inArray(
            verificationRows.verificationId,
            headers.map((header) => header.id)
          )
        )
        .orderBy(asc(verificationRows.verificationId), asc(verificationRows.createdAt));

      const rowsByVerification = new Map<string, typeof rows>();
      for (const row of rows) {
        const existing = rowsByVerification.get(row.verificationId) ?? [];
        existing.push(row);
        rowsByVerification.set(row.verificationId, existing);
      }

      return headers.map((header) => ({
        seriesCode: header.seriesCode,
        // Booked by construction, so the number is never null.
        verificationNumber: header.verificationNumber!,
        date: header.date,
        description: header.description,
        rows: (rowsByVerification.get(header.id) ?? []).map((row) => ({
          accountNumber: row.accountNumber,
          debit: row.debit,
          credit: row.credit,
          description: row.description,
          costCenterCode: row.costCenterCode,
          projectCode: row.projectCode,
        })),
      }));
    },

    // Joined header (series code + year label) + rows (account number/name)
    // for the card — the service layers displayNumber on top of the header.
    // The creator's and booker's names are joined here too (soft-deleted
    // users included — the signature must outlive the account), so the card
    // never needs the admin-only user list.
    async findVerificationById(id: string) {
      const creator = alias(users, "verification_creator");
      const booker = alias(users, "verification_booker");
      const [header] = await db
        .select({
          ...getTableColumns(verifications),
          seriesCode: verificationSeries.code,
          yearLabel: fiscalYears.label,
          createdByName: creator.name,
          bookedByName: booker.name,
        })
        .from(verifications)
        .innerJoin(verificationSeries, eq(verificationSeries.id, verifications.seriesId))
        .innerJoin(fiscalYears, eq(fiscalYears.id, verifications.fiscalYearId))
        .leftJoin(creator, eq(creator.id, verifications.createdBy))
        .leftJoin(booker, eq(booker.id, verifications.bookedBy))
        .where(eq(verifications.id, id));
      if (!header) return null;

      const rows = await db
        .select({
          ...getTableColumns(verificationRows),
          accountNumber: accounts.number,
          accountName: accounts.name,
          // Kräver kostnadsställe — the service turns a required-but-missing
          // cost center into the card's `warnings`.
          accountCostCenterRequired: accounts.costCenterRequired,
          ...rowDimensionColumns,
        })
        .from(verificationRows)
        .innerJoin(accounts, eq(accounts.id, verificationRows.accountId))
        .leftJoin(rowCostCenters, eq(rowCostCenters.id, verificationRows.costCenterId))
        .leftJoin(rowProjects, eq(rowProjects.id, verificationRows.projectId))
        .where(eq(verificationRows.verificationId, id))
        .orderBy(asc(verificationRows.createdAt));

      return { ...header, rows };
    },

    // Raw row for status/transition checks (no joins) — same split as
    // invoiceRepository's findById/findRawById.
    async findRawById(id: string) {
      const [row] = await db.select().from(verifications).where(eq(verifications.id, id));
      return row ?? null;
    },

    // Doubles as (a) the service's reverse() pre-check (AlreadyReversedError)
    // — a friendlier 409 in front of the real guarantee, the partial unique
    // index on reversesVerificationId (verifications_reverses_unique) — and
    // (b) the reverse-direction lookup for the booked card's "Omförd genom"
    // link (findVerificationById's reversedBy). seriesCode/yearLabel are
    // joined (same shape as findVerificationById's header query) so the
    // service can build the reversal's OWN displayNumber — it may still be a
    // draft ("Utkast") if the reversal itself hasn't been booked yet.
    async findReversalOf(sourceId: string) {
      const [row] = await db
        .select({ ...getTableColumns(verifications), seriesCode: verificationSeries.code, yearLabel: fiscalYears.label })
        .from(verifications)
        .innerJoin(verificationSeries, eq(verificationSeries.id, verifications.seriesId))
        .innerJoin(fiscalYears, eq(fiscalYears.id, verifications.fiscalYearId))
        .where(eq(verifications.reversesVerificationId, sourceId));
      return row ?? null;
    },

    // Anläggningsregister: is this verification one the register owns (a
    // depreciation run, its undo reversal, or a disposal)? The service's
    // reverse() refuses those — the register's own undo is the only path —
    // and the detail response links back to the register.
    async findFixedAssetLink(
      verificationId: string
    ): Promise<{ kind: "depreciation_run" | "reversal" | "disposal"; runId: string | null; assetId: string | null } | null> {
      const [run] = await db
        .select({ id: fixedAssetDepreciationRuns.id, verificationId: fixedAssetDepreciationRuns.verificationId })
        .from(fixedAssetDepreciationRuns)
        .where(
          or(
            eq(fixedAssetDepreciationRuns.verificationId, verificationId),
            eq(fixedAssetDepreciationRuns.reversalVerificationId, verificationId)
          )
        );
      if (run) return { kind: run.verificationId === verificationId ? "depreciation_run" : "reversal", runId: run.id, assetId: null };
      const [asset] = await db.select({ id: fixedAssets.id }).from(fixedAssets).where(eq(fixedAssets.disposalVerificationId, verificationId));
      if (asset) return { kind: "disposal", runId: null, assetId: asset.id };
      return null;
    },

    // Årsbokslut: the closing that booked this verification, if any — the
    // card's link and economyService.reverse's refusal both read it.
    async findYearEndLink(verificationId: string) {
      const [row] = await db
        .select({
          closingId: yearEndClosingVerifications.closingId,
          fiscalYearId: yearEndClosings.fiscalYearId,
          fiscalYearLabel: fiscalYears.label,
          step: yearEndClosingVerifications.step,
          role: yearEndClosingVerifications.role,
        })
        .from(yearEndClosingVerifications)
        .innerJoin(yearEndClosings, eq(yearEndClosings.id, yearEndClosingVerifications.closingId))
        .innerJoin(fiscalYears, eq(fiscalYears.id, yearEndClosings.fiscalYearId))
        .where(eq(yearEndClosingVerifications.verificationId, verificationId));
      return row ?? null;
    },

    // Booking = the commitment point. One transaction: re-read the draft FOR
    // UPDATE; re-validate row-count/balance/active-accounts UNDER that lock
    // (see the class comments above — the service's own checks ran against
    // an unlocked read and can't be trusted alone); allocate the number
    // (Tx-only allocator — rolls back with everything else); conditional
    // status flip (WHERE status='draft'; empty returning throws inside the
    // tx so a lost race never burns a number — same pattern as the invoice
    // module's issueInvoice). The FOR UPDATE read serializes concurrent
    // booking attempts on the SAME row: whoever loses the row lock bails out
    // (BookRaceError) as soon as it sees a non-draft status, BEFORE calling
    // the allocator, so the common "already booked" race never even touches
    // the counter. The conditional UPDATE right after is effectively
    // guaranteed to match once the FOR UPDATE check passed (we hold the
    // lock until commit) — kept anyway to mirror the documented
    // invoice-module template exactly. Returns a discriminated result (not
    // `row | null`) so the service can raise its own specific error class
    // per failure reason — same shape as invoiceRepository's
    // IssueInvoiceResult.
    async bookVerification(id: string, userId: string) {
      try {
        return await db.transaction(async (tx) => bookVerificationInTx(tx, id, userId));
      } catch (err) {
        const failure = bookFailureReason(err);
        if (failure) return failure;
        throw err;
      }
    },

    bookVerificationInTx,

    // Header + rows in one transaction — no number allocation here (the
    // verifikatnummer is assigned at booking, Task 7).
    async createVerification(header: VerificationHeaderWrite, rows: VerificationRowWrite[], createdBy: string) {
      return db.transaction(async (tx) => createVerificationInTx(tx, header, rows, createdBy));
    },

    createVerificationInTx,

    // Replace-the-set (PUT /verifications/:id/rows): every row out, the new
    // ones in, under the verification's row lock and only while it is a
    // draft — null when it no longer is (same convention as addRow). The
    // explicit createdAt ticks keep the card's row order = input order, as
    // in createVerificationInTx.
    async replaceRows(verificationId: string, rows: VerificationRowWrite[]) {
      return db.transaction(async (tx) => {
        const [verification] = await tx.select().from(verifications).where(eq(verifications.id, verificationId)).for("update");
        if (!verification || verification.status !== "draft") return null;
        await tx.delete(verificationRows).where(eq(verificationRows.verificationId, verificationId));
        if (rows.length > 0) {
          const now = Date.now();
          await tx.insert(verificationRows).values(
            rows.map((r, i) => ({
              verificationId,
              accountId: r.accountId,
              debit: String(r.debit),
              credit: String(r.credit),
              description: r.description,
              costCenterId: r.costCenterId ?? null,
              projectId: r.projectId ?? null,
              createdAt: new Date(now + i),
            }))
          );
        }
        await tx.update(verifications).set({ updatedAt: new Date() }).where(eq(verifications.id, verificationId));
        return verification;
      });
    },

    // Tx-scoped siblings for the compositions that create verifications
    // inside their own transaction (recurring runs, the SIE import): the
    // fiscal year for a date, and account rows by number — through the
    // caller's tx so an account created a statement earlier is seen.
    async findFiscalYearForDateTx(tx: Tx, date: string) {
      const [year] = await tx
        .select()
        .from(fiscalYears)
        .where(and(lte(fiscalYears.startDate, date), gte(fiscalYears.endDate, date)));
      return year ?? null;
    },

    async accountsByNumbers(executor: Db | Tx | null, numbers: string[]) {
      if (numbers.length === 0) return new Map<string, { id: string; number: string; name: string; active: boolean }>();
      const rows = await (executor ?? db)
        .select({ id: accounts.id, number: accounts.number, name: accounts.name, active: accounts.active })
        .from(accounts)
        .where(inArray(accounts.number, [...new Set(numbers)]));
      return new Map(rows.map((row) => [row.number, row] as const));
    },

    // Get-or-create a series inside the caller's transaction — the same
    // self-healing shape as the poster's F/L/K series (a concurrent creator
    // wins the unique index; this one re-selects).
    async ensureSeriesTx(tx: Tx, series: { code: string; name: string }) {
      const find = () => tx.select().from(verificationSeries).where(eq(verificationSeries.code, series.code));
      let [row] = await find();
      if (!row) {
        await tx.insert(verificationSeries).values(series).onConflictDoNothing({ target: verificationSeries.code });
        [row] = await find();
      }
      if (!row) throw new Error(`verification series ${series.code} could not be materialized`);
      return row;
    },

    // Underlag written inside the caller's transaction (the SIE import
    // attaches the file to every verification it creates). Never returns data.
    async addVerificationFileTx(
      tx: Tx,
      input: {
        verificationId: string;
        filename: string;
        contentType: string;
        sizeBytes: number;
        sha256: string;
        data: Buffer;
        uploadedBy: string | null;
      }
    ) {
      const { data: _data, ...columns } = getTableColumns(verificationFiles);
      const [row] = await tx.insert(verificationFiles).values(input).returning(columns);
      return row!;
    },

    // Row-locks the verification and re-checks status = "draft" in the same
    // transaction — the service's own status guard reads the verification
    // BEFORE this transaction opens, so a concurrent booking (Task 7) between
    // that read and this write would otherwise land a header edit on a
    // just-booked verification. Returns null (no write performed) when the
    // verification is no longer a draft, same "lost the race" convention as
    // invoiceRepository's updateHeader.
    async updateVerificationHeader(id: string, patch: VerificationHeaderPatch) {
      return db.transaction(async (tx) => {
        const [verification] = await tx.select().from(verifications).where(eq(verifications.id, id)).for("update");
        if (!verification || verification.status !== "draft") return null;
        const [row] = await tx
          .update(verifications)
          .set({ ...patch, updatedAt: new Date() })
          .where(eq(verifications.id, id))
          .returning();
        return row ?? null;
      });
    },

    // Draft only. Rows cascade (verification_rows.verification_id ON DELETE
    // cascade) — no separate row delete needed.
    async deleteVerification(id: string) {
      return db.transaction(async (tx) => {
        const [verification] = await tx.select().from(verifications).where(eq(verifications.id, id)).for("update");
        if (!verification || verification.status !== "draft") return null;
        // A draft's underlag goes with it (it was never booked) — the FK is
        // restrict precisely so nothing else can remove a booked one's.
        await tx.delete(verificationFiles).where(eq(verificationFiles.verificationId, id));
        const [row] = await tx.delete(verifications).where(eq(verifications.id, id)).returning();
        return row ?? null;
      });
    },

    // Same draft-only row-lock guard as updateVerificationHeader above.
    async addRow(verificationId: string, row: VerificationRowWrite) {
      return db.transaction(async (tx) => {
        const [verification] = await tx.select().from(verifications).where(eq(verifications.id, verificationId)).for("update");
        if (!verification || verification.status !== "draft") return null;
        const [inserted] = await tx
          .insert(verificationRows)
          .values({
            verificationId,
            accountId: row.accountId,
            debit: String(row.debit),
            credit: String(row.credit),
            description: row.description,
            costCenterId: row.costCenterId ?? null,
            projectId: row.projectId ?? null,
          })
          .returning();
        return inserted ?? null;
      });
    },

    // Scoped to the verification so a row id from another verification 404s.
    async findRow(verificationId: string, rowId: string) {
      const [row] = await db
        .select()
        .from(verificationRows)
        .where(and(eq(verificationRows.id, rowId), eq(verificationRows.verificationId, verificationId)));
      return row ?? null;
    },

    // Full-replace (verificationRowInputSchema carries every field — no
    // partial merge needed). Same draft-only row-lock guard as addRow above.
    async updateRow(verificationId: string, rowId: string, row: VerificationRowWrite) {
      return db.transaction(async (tx) => {
        const [verification] = await tx.select().from(verifications).where(eq(verifications.id, verificationId)).for("update");
        if (!verification || verification.status !== "draft") return null;
        const [updated] = await tx
          .update(verificationRows)
          .set({
            accountId: row.accountId,
            debit: String(row.debit),
            credit: String(row.credit),
            description: row.description,
            costCenterId: row.costCenterId ?? null,
            projectId: row.projectId ?? null,
          })
          .where(and(eq(verificationRows.id, rowId), eq(verificationRows.verificationId, verificationId)))
          .returning();
        return updated ?? null;
      });
    },

    // Same draft-only row-lock guard as addRow above.
    async deleteRow(verificationId: string, rowId: string) {
      return db.transaction(async (tx) => {
        const [verification] = await tx.select().from(verifications).where(eq(verifications.id, verificationId)).for("update");
        if (!verification || verification.status !== "draft") return null;
        const [row] = await tx
          .delete(verificationRows)
          .where(and(eq(verificationRows.id, rowId), eq(verificationRows.verificationId, verificationId)))
          .returning();
        return row ?? null;
      });
    },

    // --- Huvudbok (general ledger, derived — never stored) ---

    // Pure aggregation over BOOKED rows only — a draft never contributes to
    // opening balance, rows, or (by construction) closing balance. `from`
    // is the [from, to] range's lower bound: opening balance sums every
    // booked row on this account STRICTLY BEFORE it (date < from), while the
    // rows themselves are inclusive at both ends (date >= from, date <= to).
    // When `from` is absent, the range starts at the beginning of time, so
    // there is no "before" window at all — opening balance is trivially 0,
    // not the sum of all history (the SUM query is skipped entirely rather
    // than run unfiltered, which would silently compute the wrong thing).
    // openingFrom: the opening window's lower bound (a result account's
    // fiscal-year start); absent = all history.
    // Kostnadsställen och projekt: `filter` keeps only the rows carrying the
    // object(s) — for the opening balance too, so the running balance is the
    // object's own.
    async getLedger(accountId: string, from?: string, to?: string, openingFrom?: string, filter: { costCenterId?: string; projectId?: string } = {}) {
      const dimensionConditions = [];
      if (filter.costCenterId) dimensionConditions.push(eq(verificationRows.costCenterId, filter.costCenterId));
      if (filter.projectId) dimensionConditions.push(eq(verificationRows.projectId, filter.projectId));
      let openingBalance = "0";
      if (from) {
        const openingConditions = [eq(verificationRows.accountId, accountId), eq(verifications.status, "booked"), lt(verifications.date, from), ...dimensionConditions];
        if (openingFrom) openingConditions.push(gte(verifications.date, openingFrom));
        const [openingRow] = await db
          .select({
            opening: sql<string>`COALESCE(SUM(${verificationRows.debit} - ${verificationRows.credit}), 0)`,
          })
          .from(verificationRows)
          .innerJoin(verifications, eq(verifications.id, verificationRows.verificationId))
          .where(and(...openingConditions));
        openingBalance = openingRow?.opening ?? "0";
      }

      const rowConditions = [eq(verificationRows.accountId, accountId), eq(verifications.status, "booked"), ...dimensionConditions];
      if (from) rowConditions.push(gte(verifications.date, from));
      if (to) rowConditions.push(lte(verifications.date, to));

      // seriesCode is a third sort key (tie-break within the same
      // (date, verificationNumber) across series — verificationNumber is
      // only unique per series×year, so two series can share a number on
      // the same day) for a deterministic order.
      const rows = await db
        .select({
          date: verifications.date,
          seriesCode: verificationSeries.code,
          yearLabel: fiscalYears.label,
          verificationNumber: verifications.verificationNumber,
          // Row description falls back to the verification header's when
          // the row itself has none.
          description: sql<string>`COALESCE(${verificationRows.description}, ${verifications.description})`,
          debit: verificationRows.debit,
          credit: verificationRows.credit,
          verificationId: verifications.id,
          ...rowDimensionColumns,
        })
        .from(verificationRows)
        .innerJoin(verifications, eq(verifications.id, verificationRows.verificationId))
        .innerJoin(verificationSeries, eq(verificationSeries.id, verifications.seriesId))
        .innerJoin(fiscalYears, eq(fiscalYears.id, verifications.fiscalYearId))
        .leftJoin(rowCostCenters, eq(rowCostCenters.id, verificationRows.costCenterId))
        .leftJoin(rowProjects, eq(rowProjects.id, verificationRows.projectId))
        .where(and(...rowConditions))
        .orderBy(asc(verifications.date), asc(verifications.verificationNumber), asc(verificationSeries.code));

      return { openingBalance, rows };
    },

    // Multi-account sibling of getLedger (B6a printout). Returns ROWS only —
    // opening balances come from readAccountBalances, so this stays a single
    // flat query. Account order comes first in the sort so the printout
    // groups per account; the (date, verificationNumber, seriesCode) trio
    // after it is getLedger's tie-break, kept identical on purpose.
    // Kostnadsställen och projekt: `filter` keeps only the rows carrying the
    // object(s) — the opening balances come from readAccountBalances with
    // the same filter, so the two never disagree.
    async getGeneralLedgerRows(
      from: string,
      to: string,
      accountFrom: string,
      accountTo: string,
      filter: { costCenterId?: string; projectId?: string } = {}
    ) {
      const conditions = [
        eq(verifications.status, "booked"),
        gte(verifications.date, from),
        lte(verifications.date, to),
        gte(accounts.number, accountFrom),
        lte(accounts.number, accountTo),
      ];
      if (filter.costCenterId) conditions.push(eq(verificationRows.costCenterId, filter.costCenterId));
      if (filter.projectId) conditions.push(eq(verificationRows.projectId, filter.projectId));
      const rows = await db
        .select({
          accountId: verificationRows.accountId,
          accountNumber: accounts.number,
          date: verifications.date,
          seriesCode: verificationSeries.code,
          yearLabel: fiscalYears.label,
          verificationNumber: verifications.verificationNumber,
          description: sql<string>`COALESCE(${verificationRows.description}, ${verifications.description})`,
          debit: verificationRows.debit,
          credit: verificationRows.credit,
          verificationId: verifications.id,
          ...rowDimensionColumns,
        })
        .from(verificationRows)
        .innerJoin(verifications, eq(verifications.id, verificationRows.verificationId))
        .innerJoin(verificationSeries, eq(verificationSeries.id, verifications.seriesId))
        .innerJoin(fiscalYears, eq(fiscalYears.id, verifications.fiscalYearId))
        .innerJoin(accounts, eq(accounts.id, verificationRows.accountId))
        .leftJoin(rowCostCenters, eq(rowCostCenters.id, verificationRows.costCenterId))
        .leftJoin(rowProjects, eq(rowProjects.id, verificationRows.projectId))
        .where(and(...conditions))
        .orderBy(
          asc(accounts.number),
          asc(verifications.date),
          asc(verifications.verificationNumber),
          asc(verificationSeries.code)
        );
      return rows;
    },

    // Kostnadsställen och projekt: the one dimension check, through this
    // repository's connection (the service never imports the db client).
    async resolveRowDimensions(input: DimensionInput, existing: DimensionIds | null = null): Promise<DimensionIds> {
      return resolveDimensions(db, input, { existing });
    },

    // --- Konteringsregler (B2 automatkontering) ---

    // Existence check for a referenced articleGroupId — same
    // integration-friendly-404 rationale as findSeriesById above (a bogus id
    // is reported as a mapped 404, not a raw FK violation).
    async findArticleGroupById(id: string) {
      const [row] = await db.select().from(articleGroups).where(eq(articleGroups.id, id));
      return row ?? null;
    },

    async findPostingRuleById(id: string) {
      const [row] = await db.select().from(postingRules).where(eq(postingRules.id, id));
      return row ?? null;
    },

    // List-all, no pagination (small register, same shape as listSeries) —
    // joined with the article group's code/name, the momskod's code/name and
    // BOTH accounts' number/name/momsruta via two aliased instances of
    // `accounts` (a rule can reference two different accounts, so one join
    // per side, same trick as invoiceRepository.listInvoiceableOrders's
    // aliased `units`). Either account may be null (revenue-only or
    // cost-only rule), hence left joins. Ordered by group code, then momskod
    // with NULLS LAST so a group's "Alla momskoder" rule always sorts after
    // its code-specific rules.
    async listPostingRules() {
      const revenueAccounts = alias(accounts, "revenue_accounts");
      const costAccounts = alias(accounts, "cost_accounts");
      return db
        .select({
          ...getTableColumns(postingRules),
          groupCode: articleGroups.code,
          groupName: articleGroups.name,
          vatCode: vatCodes.code,
          vatCodeName: vatCodes.name,
          revenueAccountNumber: revenueAccounts.number,
          revenueAccountName: revenueAccounts.name,
          revenueAccountVatBox: revenueAccounts.vatBox,
          costAccountNumber: costAccounts.number,
          costAccountName: costAccounts.name,
          costAccountVatBox: costAccounts.vatBox,
        })
        .from(postingRules)
        .innerJoin(articleGroups, eq(articleGroups.id, postingRules.articleGroupId))
        .leftJoin(vatCodes, eq(vatCodes.id, postingRules.vatCodeId))
        .leftJoin(revenueAccounts, eq(revenueAccounts.id, postingRules.revenueAccountId))
        .leftJoin(costAccounts, eq(costAccounts.id, postingRules.costAccountId))
        .orderBy(asc(articleGroups.code), sql`${vatCodes.code} ASC NULLS LAST`);
    },

    async findVatCodeById(id: string) {
      const [row] = await db.select().from(vatCodes).where(eq(vatCodes.id, id));
      return row ?? null;
    },

    async createPostingRule(input: PostingRuleWrite) {
      const [row] = await db.insert(postingRules).values(input).returning();
      return row!;
    },

    async updatePostingRule(id: string, patch: PostingRulePatch) {
      const [row] = await db.update(postingRules).set(patch).where(eq(postingRules.id, id)).returning();
      return row ?? null;
    },

    async deletePostingRule(id: string) {
      const [row] = await db.delete(postingRules).where(eq(postingRules.id, id)).returning();
      return row ?? null;
    },

    // --- Underlag on a verification. Listing never selects data. ---

    async listVerificationFiles(verificationId: string) {
      const { data: _data, ...columns } = getTableColumns(verificationFiles);
      return db
        .select(columns)
        .from(verificationFiles)
        .where(eq(verificationFiles.verificationId, verificationId))
        .orderBy(asc(verificationFiles.createdAt));
    },

    async addVerificationFile(input: {
      verificationId: string;
      filename: string;
      contentType: string;
      sizeBytes: number;
      sha256: string;
      data: Buffer;
      uploadedBy: string | null;
    }) {
      const { data: _data, ...columns } = getTableColumns(verificationFiles);
      const [row] = await db.insert(verificationFiles).values(input).returning(columns);
      return row!;
    },

    async findVerificationFile(verificationId: string, fileId: string) {
      const [row] = await db
        .select()
        .from(verificationFiles)
        .where(and(eq(verificationFiles.id, fileId), eq(verificationFiles.verificationId, verificationId)));
      return row ?? null;
    },

    // Draft only, under the verification's row lock — a booking racing this
    // delete either sees the file or waits, so a booked verifikat can never
    // lose its underlag.
    async deleteVerificationFileIfDraft(
      verificationId: string,
      fileId: string
    ): Promise<{ ok: true; filename: string; sha256: string } | { ok: false; reason: "not_found" | "locked" }> {
      return db.transaction(async (tx) => {
        const [verification] = await tx
          .select({ status: verifications.status })
          .from(verifications)
          .where(eq(verifications.id, verificationId))
          .for("update");
        if (!verification) return { ok: false, reason: "not_found" };
        if (verification.status !== "draft") return { ok: false, reason: "locked" };
        const [row] = await tx
          .delete(verificationFiles)
          .where(and(eq(verificationFiles.id, fileId), eq(verificationFiles.verificationId, verificationId)))
          .returning({ filename: verificationFiles.filename, sha256: verificationFiles.sha256 });
        return row ? { ok: true, ...row } : { ok: false, reason: "not_found" };
      });
    },
  };
}

export type EconomyRepository = ReturnType<typeof createEconomyRepository>;

import { and, asc, count, desc, eq, gt, gte, inArray, isNull, lte, max, sql, type SQL } from "drizzle-orm";
import {
  accounts,
  bankAccounts,
  bankFileEntries,
  bankFiles,
  bankMatchEntries,
  bankMatchRows,
  bankMatches,
  bankReconciliations,
  bankRules,
  bankStatementEntries,
  bankStatements,
  customerPayments,
  fiscalYears,
  supplierPayments,
  systemSettings,
  vatCodes,
  verificationRows,
  verificationSeries,
  verifications,
  type BankCsvMapping,
  type BankStatementEntryDetails,
  type Db,
  type Tx,
} from "@navet/db";
import { round2 } from "@navet/shared";

// Bankavstämning — the data access. Every "is it matched?" question is
// answered by the live link rows (bank_match_entries/bank_match_rows with
// active = true), never by a flag on the entry or the verification row.
// Correlated subqueries name their tables explicitly (the bank-file
// repository's lesson: drizzle renders a single-table select's column
// unqualified, and an unqualified "id" inside the subquery binds wrong).

export type BankAccountRow = typeof bankAccounts.$inferSelect;
export type BankStatementEntryRow = typeof bankStatementEntries.$inferSelect;
export type BankRuleRow = typeof bankRules.$inferSelect;
export type BankMatchRow = typeof bankMatches.$inferSelect;
export type BankReconciliationRow = typeof bankReconciliations.$inferSelect;

export interface StatementEntryView {
  id: string;
  bankAccountId: string;
  bankStatementId: string;
  bookingDate: string;
  valueDate: string | null;
  amount: number;
  currency: string;
  text: string;
  reference: string | null;
  counterparty: string | null;
  details: BankStatementEntryDetails;
  reversal: boolean;
  bankFileId: string;
  createdAt: Date;
}

export interface LedgerRowView {
  id: string;
  verificationId: string;
  verificationDisplayNumber: string;
  verificationStatus: string;
  accountId: string;
  date: string;
  description: string;
  // debit − credit on the bank's ledger account.
  amount: number;
  // The bank references (camt.054 AcctSvcrRef / EndToEndId) of the payment
  // this verification was booked from, if any.
  references: string[];
}

const E = sql.raw(`"bank_statement_entries"`);
const VR = sql.raw(`"verification_rows"`);
const entryUnmatched = sql`NOT EXISTS (SELECT 1 FROM bank_match_entries me WHERE me.entry_id = ${E}."id" AND me.active)`;
const rowUnmatched = sql`NOT EXISTS (SELECT 1 FROM bank_match_rows mr WHERE mr.verification_row_id = ${VR}."id" AND mr.active)`;

const entryView = {
  id: bankStatementEntries.id,
  bankAccountId: bankStatementEntries.bankAccountId,
  bankStatementId: bankStatementEntries.bankStatementId,
  bookingDate: bankStatementEntries.bookingDate,
  valueDate: bankStatementEntries.valueDate,
  amount: bankStatementEntries.amount,
  currency: bankStatementEntries.currency,
  text: bankStatementEntries.text,
  reference: bankStatementEntries.reference,
  counterparty: bankStatementEntries.counterparty,
  details: bankStatementEntries.details,
  reversal: bankStatementEntries.reversal,
  bankFileId: bankStatementEntries.bankFileId,
  createdAt: bankStatementEntries.createdAt,
};

function toEntryView(row: { [K in keyof StatementEntryView]: K extends "amount" ? string | number : StatementEntryView[K] }): StatementEntryView {
  return { ...row, amount: round2(Number(row.amount)) };
}

const displayNumber = (seriesCode: string, yearLabel: string, status: string, n: number | null) =>
  status === "booked" && n !== null ? `${seriesCode}-${yearLabel}-${n}` : "Utkast";

// The advisory lock every matching write on a bank account takes first:
// matching, booking an entry, undo, the reconciliation mark.
export async function lockBankAccount(tx: Tx, bankAccountId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`bank_account:${bankAccountId}`}))`);
}

// Årsbokslut: the active bank accounts not reconciled through `date` (no
// mark at all, or the latest mark before it).
export async function unreconciledBankAccountsAsOf(
  executor: Db | Tx,
  date: string
): Promise<{ id: string; name: string; ledgerAccount: string; reconciledThrough: string | null }[]> {
  const rows = await executor
    .select({
      id: bankAccounts.id,
      name: bankAccounts.name,
      ledgerAccount: bankAccounts.ledgerAccount,
      reconciledThrough: sql<string | null>`(SELECT max(r.through_date) FROM bank_reconciliations r WHERE r.bank_account_id = "bank_accounts"."id")`,
    })
    .from(bankAccounts)
    .where(eq(bankAccounts.active, true))
    .orderBy(asc(bankAccounts.ledgerAccount), asc(bankAccounts.name));
  return rows.filter((row) => row.reconciledThrough === null || row.reconciledThrough < date);
}

export function createBankReconciliationRepository(db: Db) {
  async function loadReferences(executor: Db | Tx, verificationIds: string[]): Promise<Map<string, string[]>> {
    const map = new Map<string, string[]>();
    if (verificationIds.length === 0) return map;
    const refsOf = (e: typeof bankFileEntries) => ({
      endToEndId: e.endToEndId,
      dedupeKey: e.dedupeKey,
      dedupeSource: e.dedupeSource,
    });
    const [fromCustomers, fromSuppliers] = await Promise.all([
      executor
        .select({ verificationId: customerPayments.verificationId, ...refsOf(bankFileEntries) })
        .from(customerPayments)
        .innerJoin(bankFileEntries, eq(bankFileEntries.id, customerPayments.bankFileEntryId))
        .where(and(inArray(customerPayments.verificationId, verificationIds), isNull(customerPayments.cancelledAt))),
      executor
        .select({ verificationId: supplierPayments.verificationId, ...refsOf(bankFileEntries) })
        .from(supplierPayments)
        .innerJoin(bankFileEntries, eq(bankFileEntries.id, supplierPayments.bankFileEntryId))
        .where(and(inArray(supplierPayments.verificationId, verificationIds), isNull(supplierPayments.cancelledAt))),
    ]);
    for (const row of [...fromCustomers, ...fromSuppliers]) {
      if (!row.verificationId) continue;
      const refs = map.get(row.verificationId) ?? [];
      if (row.endToEndId) refs.push(row.endToEndId);
      // "<account>|tx:<AcctSvcrRef>" (a repeat in the file gets "#2" — kept
      // as is, it never meets a statement reference).
      if (row.dedupeSource === "tx_acct_svcr_ref") refs.push(row.dedupeKey.slice(row.dedupeKey.indexOf("|tx:") + 4));
      map.set(row.verificationId, refs);
    }
    return map;
  }

  async function ledgerRows(executor: Db | Tx, where: SQL): Promise<LedgerRowView[]> {
    const rows = await executor
      .select({
        id: verificationRows.id,
        verificationId: verifications.id,
        status: verifications.status,
        seriesCode: verificationSeries.code,
        yearLabel: fiscalYears.label,
        verificationNumber: verifications.verificationNumber,
        accountId: verificationRows.accountId,
        date: verifications.date,
        description: verifications.description,
        rowDescription: verificationRows.description,
        debit: verificationRows.debit,
        credit: verificationRows.credit,
      })
      .from(verificationRows)
      .innerJoin(verifications, eq(verifications.id, verificationRows.verificationId))
      .innerJoin(verificationSeries, eq(verificationSeries.id, verifications.seriesId))
      .innerJoin(fiscalYears, eq(fiscalYears.id, verifications.fiscalYearId))
      .where(where)
      .orderBy(asc(verifications.date), asc(verifications.verificationNumber), asc(verificationRows.createdAt));
    const references = await loadReferences(executor, [...new Set(rows.map((r) => r.verificationId))]);
    return rows.map((r) => ({
      id: r.id,
      verificationId: r.verificationId,
      verificationDisplayNumber: displayNumber(r.seriesCode, r.yearLabel, r.status, r.verificationNumber),
      verificationStatus: r.status,
      accountId: r.accountId,
      date: r.date,
      description: r.rowDescription ?? r.description,
      amount: round2(Number(r.debit) - Number(r.credit)),
      references: references.get(r.verificationId) ?? [],
    }));
  }

  const repo = {
    // --- Bankkonton ---
    async listAccounts(includeInactive: boolean) {
      return db
        .select({
          account: bankAccounts,
          ledgerAccountName: accounts.name,
          reconciledThrough: sql<string | null>`(SELECT max(r.through_date) FROM bank_reconciliations r WHERE r.bank_account_id = "bank_accounts"."id")`,
          lastStatementDate: sql<string | null>`(SELECT max(e.booking_date) FROM bank_statement_entries e WHERE e.bank_account_id = "bank_accounts"."id")`,
          unmatchedCount: sql<number>`(SELECT count(*) FROM bank_statement_entries e WHERE e.bank_account_id = "bank_accounts"."id" AND NOT EXISTS (SELECT 1 FROM bank_match_entries me WHERE me.entry_id = e.id AND me.active))`,
        })
        .from(bankAccounts)
        .leftJoin(accounts, eq(accounts.number, bankAccounts.ledgerAccount))
        .where(includeInactive ? undefined : eq(bankAccounts.active, true))
        .orderBy(asc(bankAccounts.ledgerAccount), asc(bankAccounts.name));
    },

    async countAccounts(): Promise<number> {
      const [row] = await db.select({ n: count() }).from(bankAccounts);
      return row!.n;
    },

    async findAccount(executor: Db | Tx, id: string): Promise<BankAccountRow | null> {
      const [row] = await executor.select().from(bankAccounts).where(eq(bankAccounts.id, id));
      return row ?? null;
    },

    async findAccountByIdentifier(executor: Db | Tx, identifier: string): Promise<BankAccountRow | null> {
      const [row] = await executor.select().from(bankAccounts).where(eq(bankAccounts.identifier, identifier));
      return row ?? null;
    },

    async insertAccount(values: typeof bankAccounts.$inferInsert): Promise<BankAccountRow> {
      const [row] = await db.insert(bankAccounts).values(values).returning();
      return row!;
    },

    async updateAccount(executor: Db | Tx, id: string, values: Partial<typeof bankAccounts.$inferInsert>): Promise<BankAccountRow | null> {
      const [row] = await executor
        .update(bankAccounts)
        .set({ ...values, updatedAt: new Date() })
        .where(eq(bankAccounts.id, id))
        .returning();
      return row ?? null;
    },

    async findLedgerAccountByNumber(executor: Db | Tx, number: string) {
      const [row] = await executor.select().from(accounts).where(eq(accounts.number, number));
      return row ?? null;
    },

    async findLedgerAccountById(executor: Db | Tx, id: string) {
      const [row] = await executor.select().from(accounts).where(eq(accounts.id, id));
      return row ?? null;
    },

    async findVatCode(executor: Db | Tx, code: string) {
      const [row] = await executor.select().from(vatCodes).where(eq(vatCodes.code, code));
      return row ?? null;
    },

    async findSeriesById(executor: Db | Tx, id: string) {
      const [row] = await executor.select({ id: verificationSeries.id, code: verificationSeries.code }).from(verificationSeries).where(eq(verificationSeries.id, id));
      return row ?? null;
    },

    // Get-or-create inside the caller's transaction (the poster's idiom):
    // ON CONFLICT DO NOTHING + re-select.
    async ensureSeries(tx: Tx, series: { code: string; name: string }): Promise<{ id: string; code: string }> {
      const find = () => tx.select({ id: verificationSeries.id, code: verificationSeries.code }).from(verificationSeries).where(eq(verificationSeries.code, series.code));
      let [row] = await find();
      if (!row) {
        await tx.insert(verificationSeries).values({ code: series.code, name: series.name }).onConflictDoNothing({ target: verificationSeries.code });
        [row] = await find();
      }
      if (!row) throw new Error(`verification series ${series.code} could not be materialized`);
      return row;
    },

    async verificationDisplay(executor: Db | Tx, id: string): Promise<{ id: string; displayNumber: string } | null> {
      const [row] = await executor
        .select({ id: verifications.id, status: verifications.status, n: verifications.verificationNumber, code: verificationSeries.code, year: fiscalYears.label })
        .from(verifications)
        .innerJoin(verificationSeries, eq(verificationSeries.id, verifications.seriesId))
        .innerJoin(fiscalYears, eq(fiscalYears.id, verifications.fiscalYearId))
        .where(eq(verifications.id, id));
      return row ? { id: row.id, displayNumber: displayNumber(row.code, row.year, row.status, row.n) } : null;
    },

    // The rows of a (just booked) verification on the bank's ledger account.
    async verificationRowsOnAccount(tx: Tx, verificationId: string, accountId: string): Promise<string[]> {
      const rows = await tx
        .select({ id: verificationRows.id })
        .from(verificationRows)
        .where(and(eq(verificationRows.verificationId, verificationId), eq(verificationRows.accountId, accountId)))
        .orderBy(asc(verificationRows.createdAt));
      return rows.map((r) => r.id);
    },

    // --- Settings (bank_* keys in system_settings, as the bank settings) ---
    async getSetting(key: string): Promise<string | null> {
      const [row] = await db.select({ value: systemSettings.value }).from(systemSettings).where(eq(systemSettings.key, key));
      return row?.value ?? null;
    },
    async setSetting(executor: Db | Tx, key: string, value: string): Promise<void> {
      await executor.insert(systemSettings).values({ key, value }).onConflictDoUpdate({ target: systemSettings.key, set: { value } });
    },

    // --- Files, statements, entries ---
    async findIncomingFileBySha(executor: Db | Tx, sha256: string): Promise<{ id: string; filename: string } | null> {
      const [row] = await executor
        .select({ id: bankFiles.id, filename: bankFiles.filename })
        .from(bankFiles)
        .where(and(eq(bankFiles.sha256, sha256), eq(bankFiles.direction, "incoming")));
      return row ?? null;
    },

    async insertFile(tx: Tx, values: typeof bankFiles.$inferInsert): Promise<{ id: string; filename: string }> {
      const [row] = await tx.insert(bankFiles).values(values).returning({ id: bankFiles.id, filename: bankFiles.filename });
      return row!;
    },

    async existingEntryKeys(executor: Db | Tx, keys: string[]): Promise<Set<string>> {
      if (keys.length === 0) return new Set();
      const rows = await executor.select({ key: bankStatementEntries.dedupeKey }).from(bankStatementEntries).where(inArray(bankStatementEntries.dedupeKey, keys));
      return new Set(rows.map((r) => r.key));
    },

    async insertStatement(tx: Tx, values: typeof bankStatements.$inferInsert) {
      const [row] = await tx.insert(bankStatements).values(values).returning();
      return row!;
    },

    // ON CONFLICT DO NOTHING on the dedupe key: an overlapping or repeated
    // file (or a concurrent import) never duplicates an entry.
    async insertEntries(tx: Tx, rows: (typeof bankStatementEntries.$inferInsert)[]): Promise<string[]> {
      if (rows.length === 0) return [];
      const inserted = await tx.insert(bankStatementEntries).values(rows).onConflictDoNothing({ target: bankStatementEntries.dedupeKey }).returning({ id: bankStatementEntries.id });
      return inserted.map((r) => r.id);
    },

    async findEntry(executor: Db | Tx, id: string): Promise<StatementEntryView | null> {
      const [row] = await executor.select(entryView).from(bankStatementEntries).where(eq(bankStatementEntries.id, id));
      return row ? toEntryView(row) : null;
    },

    async lockEntry(tx: Tx, id: string): Promise<StatementEntryView | null> {
      const [row] = await tx.select(entryView).from(bankStatementEntries).where(eq(bankStatementEntries.id, id)).for("update");
      return row ? toEntryView(row) : null;
    },

    async entriesByIds(executor: Db | Tx, ids: string[]): Promise<StatementEntryView[]> {
      if (ids.length === 0) return [];
      const rows = await executor.select(entryView).from(bankStatementEntries).where(inArray(bankStatementEntries.id, ids)).orderBy(asc(bankStatementEntries.bookingDate), asc(bankStatementEntries.position));
      return rows.map(toEntryView);
    },

    async isEntryMatched(executor: Db | Tx, id: string): Promise<boolean> {
      const [row] = await executor.select({ n: count() }).from(bankMatchEntries).where(and(eq(bankMatchEntries.entryId, id), eq(bankMatchEntries.active, true)));
      return row!.n > 0;
    },

    async anyMatched(executor: Db | Tx, entryIds: string[], rowIds: string[]): Promise<boolean> {
      if (entryIds.length > 0) {
        const [e] = await executor.select({ n: count() }).from(bankMatchEntries).where(and(inArray(bankMatchEntries.entryId, entryIds), eq(bankMatchEntries.active, true)));
        if (e!.n > 0) return true;
      }
      if (rowIds.length > 0) {
        const [r] = await executor.select({ n: count() }).from(bankMatchRows).where(and(inArray(bankMatchRows.verificationRowId, rowIds), eq(bankMatchRows.active, true)));
        if (r!.n > 0) return true;
      }
      return false;
    },

    async unmatchedEntries(executor: Db | Tx, bankAccountId: string, range: { from?: string; to?: string }): Promise<StatementEntryView[]> {
      const conditions: SQL[] = [eq(bankStatementEntries.bankAccountId, bankAccountId), entryUnmatched];
      if (range.from) conditions.push(gte(bankStatementEntries.bookingDate, range.from));
      if (range.to) conditions.push(lte(bankStatementEntries.bookingDate, range.to));
      const rows = await executor
        .select(entryView)
        .from(bankStatementEntries)
        .where(and(...conditions))
        .orderBy(asc(bankStatementEntries.bookingDate), asc(bankStatementEntries.position));
      return rows.map(toEntryView);
    },

    async unmatchedEntriesCount(executor: Db | Tx, bankAccountId: string, through: string): Promise<number> {
      const [row] = await executor
        .select({ n: count() })
        .from(bankStatementEntries)
        .where(and(eq(bankStatementEntries.bankAccountId, bankAccountId), lte(bankStatementEntries.bookingDate, through), entryUnmatched));
      return row!.n;
    },

    async unmatchedEntriesSum(executor: Db | Tx, bankAccountId: string, through: string): Promise<number> {
      const [row] = await executor
        .select({ total: sql<string | null>`sum(${bankStatementEntries.amount})` })
        .from(bankStatementEntries)
        .where(and(eq(bankStatementEntries.bankAccountId, bankAccountId), lte(bankStatementEntries.bookingDate, through), entryUnmatched));
      return round2(Number(row?.total ?? 0));
    },

    // Booked verification rows on the ledger account without a live match.
    async unmatchedRows(executor: Db | Tx, ledgerAccountId: string, range: { from?: string; to?: string }): Promise<LedgerRowView[]> {
      const conditions: SQL[] = [eq(verificationRows.accountId, ledgerAccountId), eq(verifications.status, "booked"), rowUnmatched];
      if (range.from) conditions.push(gte(verifications.date, range.from));
      if (range.to) conditions.push(lte(verifications.date, range.to));
      return ledgerRows(executor, and(...conditions)!);
    },

    async unmatchedRowsCount(executor: Db | Tx, ledgerAccountId: string, through: string): Promise<number> {
      const [row] = await executor
        .select({ n: count() })
        .from(verificationRows)
        .innerJoin(verifications, eq(verifications.id, verificationRows.verificationId))
        .where(and(eq(verificationRows.accountId, ledgerAccountId), eq(verifications.status, "booked"), lte(verifications.date, through), rowUnmatched));
      return row!.n;
    },

    async unmatchedRowsSum(executor: Db | Tx, ledgerAccountId: string, through: string): Promise<number> {
      const [row] = await executor
        .select({ total: sql<string | null>`sum(${verificationRows.debit} - ${verificationRows.credit})` })
        .from(verificationRows)
        .innerJoin(verifications, eq(verifications.id, verificationRows.verificationId))
        .where(and(eq(verificationRows.accountId, ledgerAccountId), eq(verifications.status, "booked"), lte(verifications.date, through), rowUnmatched));
      return round2(Number(row?.total ?? 0));
    },

    async rowsByIds(executor: Db | Tx, ids: string[]): Promise<LedgerRowView[]> {
      if (ids.length === 0) return [];
      return ledgerRows(executor, inArray(verificationRows.id, ids));
    },

    // debit − credit on the ledger account for every booked verification
    // dated on or before `through`.
    async ledgerBalanceThrough(executor: Db | Tx, ledgerAccountId: string, through: string): Promise<number> {
      const [row] = await executor
        .select({ total: sql<string | null>`sum(${verificationRows.debit} - ${verificationRows.credit})` })
        .from(verificationRows)
        .innerJoin(verifications, eq(verifications.id, verificationRows.verificationId))
        .where(and(eq(verificationRows.accountId, ledgerAccountId), eq(verifications.status, "booked"), lte(verifications.date, through)));
      return round2(Number(row?.total ?? 0));
    },

    // The latest statement closing balance on or before `through`.
    async latestStatementBalance(executor: Db | Tx, bankAccountId: string, through: string): Promise<{ balance: number; date: string } | null> {
      const [row] = await executor
        .select({ balance: bankStatements.closingBalance, date: bankStatements.closingBalanceDate })
        .from(bankStatements)
        .where(and(eq(bankStatements.bankAccountId, bankAccountId), lte(bankStatements.closingBalanceDate, through)))
        .orderBy(desc(bankStatements.closingBalanceDate), desc(bankStatements.createdAt))
        .limit(1);
      return row && row.balance !== null && row.date !== null ? { balance: round2(Number(row.balance)), date: row.date } : null;
    },

    async entriesBetween(executor: Db | Tx, bankAccountId: string, afterDate: string, through: string): Promise<number> {
      const [row] = await executor
        .select({ n: count() })
        .from(bankStatementEntries)
        .where(and(eq(bankStatementEntries.bankAccountId, bankAccountId), sql`${bankStatementEntries.bookingDate} > ${afterDate}`, lte(bankStatementEntries.bookingDate, through)));
      return row!.n;
    },

    // --- Matches ---
    async insertMatch(tx: Tx, values: { bankAccountId: string; kind: "auto" | "manual" | "created"; createdBy: string | null }, entryIds: string[], rowIds: string[]): Promise<string> {
      const [match] = await tx.insert(bankMatches).values(values).returning({ id: bankMatches.id });
      if (entryIds.length > 0) await tx.insert(bankMatchEntries).values(entryIds.map((entryId) => ({ matchId: match!.id, entryId })));
      if (rowIds.length > 0) await tx.insert(bankMatchRows).values(rowIds.map((verificationRowId) => ({ matchId: match!.id, verificationRowId })));
      return match!.id;
    },

    async findMatch(executor: Db | Tx, id: string): Promise<BankMatchRow | null> {
      const [row] = await executor.select().from(bankMatches).where(eq(bankMatches.id, id));
      return row ?? null;
    },

    async lockMatch(tx: Tx, id: string): Promise<BankMatchRow | null> {
      const [row] = await tx.select().from(bankMatches).where(eq(bankMatches.id, id)).for("update");
      return row ?? null;
    },

    async undoMatch(tx: Tx, id: string, userId: string): Promise<void> {
      const now = new Date();
      await tx.update(bankMatches).set({ undoneAt: now, undoneBy: userId }).where(eq(bankMatches.id, id));
      await tx.update(bankMatchEntries).set({ active: false }).where(eq(bankMatchEntries.matchId, id));
      await tx.update(bankMatchRows).set({ active: false }).where(eq(bankMatchRows.matchId, id));
    },

    // The matches touching the period: live ones with an entry booked or a
    // row dated inside it.
    async matchesInRange(executor: Db | Tx, bankAccountId: string, from: string, to: string): Promise<BankMatchRow[]> {
      return executor
        .select()
        .from(bankMatches)
        .where(
          and(
            eq(bankMatches.bankAccountId, bankAccountId),
            isNull(bankMatches.undoneAt),
            sql`(EXISTS (SELECT 1 FROM bank_match_entries me JOIN bank_statement_entries e ON e.id = me.entry_id WHERE me.match_id = "bank_matches"."id" AND e.booking_date BETWEEN ${from} AND ${to})
              OR EXISTS (SELECT 1 FROM bank_match_rows mr JOIN verification_rows vr ON vr.id = mr.verification_row_id JOIN verifications v ON v.id = vr.verification_id WHERE mr.match_id = "bank_matches"."id" AND v.date BETWEEN ${from} AND ${to}))`
          )
        )
        .orderBy(desc(bankMatches.createdAt));
    },

    async matchLinks(executor: Db | Tx, matchIds: string[]): Promise<{ entries: Map<string, StatementEntryView[]>; rows: Map<string, LedgerRowView[]> }> {
      const entries = new Map<string, StatementEntryView[]>();
      const rows = new Map<string, LedgerRowView[]>();
      if (matchIds.length === 0) return { entries, rows };
      const entryLinks = await executor
        .select({ matchId: bankMatchEntries.matchId, entry: entryView })
        .from(bankMatchEntries)
        .innerJoin(bankStatementEntries, eq(bankStatementEntries.id, bankMatchEntries.entryId))
        .where(inArray(bankMatchEntries.matchId, matchIds))
        .orderBy(asc(bankStatementEntries.bookingDate), asc(bankStatementEntries.position));
      for (const link of entryLinks) {
        const list = entries.get(link.matchId) ?? [];
        list.push(toEntryView(link.entry));
        entries.set(link.matchId, list);
      }
      const rowLinks = await executor
        .select({ matchId: bankMatchRows.matchId, rowId: bankMatchRows.verificationRowId })
        .from(bankMatchRows)
        .where(inArray(bankMatchRows.matchId, matchIds));
      const views = await ledgerRows(executor, inArray(verificationRows.id, rowLinks.map((l) => l.rowId)));
      const byId = new Map(views.map((v) => [v.id, v]));
      for (const link of rowLinks) {
        const view = byId.get(link.rowId);
        if (!view) continue;
        const list = rows.get(link.matchId) ?? [];
        list.push(view);
        rows.set(link.matchId, list);
      }
      return { entries, rows };
    },

    // --- Bankregler ---
    async listRules(): Promise<BankRuleRow[]> {
      return db.select().from(bankRules).orderBy(asc(bankRules.sortOrder), asc(bankRules.createdAt));
    },
    async countRules(): Promise<number> {
      const [row] = await db.select({ n: count() }).from(bankRules);
      return row!.n;
    },
    async findRule(id: string): Promise<BankRuleRow | null> {
      const [row] = await db.select().from(bankRules).where(eq(bankRules.id, id));
      return row ?? null;
    },
    async insertRules(executor: Db | Tx, values: (typeof bankRules.$inferInsert)[]): Promise<BankRuleRow[]> {
      if (values.length === 0) return [];
      return executor.insert(bankRules).values(values).returning();
    },
    async updateRule(id: string, values: Partial<typeof bankRules.$inferInsert>): Promise<BankRuleRow | null> {
      const [row] = await db
        .update(bankRules)
        .set({ ...values, updatedAt: new Date() })
        .where(eq(bankRules.id, id))
        .returning();
      return row ?? null;
    },
    async deleteRule(id: string): Promise<boolean> {
      const deleted = await db.delete(bankRules).where(eq(bankRules.id, id)).returning({ id: bankRules.id });
      return deleted.length > 0;
    },
    async maxRuleSortOrder(): Promise<number> {
      const [row] = await db.select({ m: max(bankRules.sortOrder) }).from(bankRules);
      return row?.m ?? 0;
    },

    // --- Avstämd t.o.m. ---
    async listReconciliations(executor: Db | Tx, bankAccountId: string): Promise<BankReconciliationRow[]> {
      return executor.select().from(bankReconciliations).where(eq(bankReconciliations.bankAccountId, bankAccountId)).orderBy(desc(bankReconciliations.throughDate), desc(bankReconciliations.createdAt));
    },
    async latestReconciliation(executor: Db | Tx, bankAccountId: string): Promise<BankReconciliationRow | null> {
      const [row] = await executor
        .select()
        .from(bankReconciliations)
        .where(eq(bankReconciliations.bankAccountId, bankAccountId))
        .orderBy(desc(bankReconciliations.throughDate), desc(bankReconciliations.createdAt))
        .limit(1);
      return row ?? null;
    },
    async insertReconciliation(tx: Tx, values: typeof bankReconciliations.$inferInsert): Promise<BankReconciliationRow> {
      const [row] = await tx.insert(bankReconciliations).values(values).returning();
      return row!;
    },

    // Rows on the ledger account dated on or before the mark that were
    // booked after it was made — the "bokföringen har ändrats" warning.
    async rowsBookedAfter(executor: Db | Tx, ledgerAccountId: string, through: string, since: Date): Promise<number> {
      const [row] = await executor
        .select({ n: count() })
        .from(verificationRows)
        .innerJoin(verifications, eq(verifications.id, verificationRows.verificationId))
        .where(and(eq(verificationRows.accountId, ledgerAccountId), eq(verifications.status, "booked"), lte(verifications.date, through), gt(verifications.bookedAt, since)));
      return row!.n;
    },

    // --- Aviseringar ---
    async unreconciledEntriesBefore(date: string): Promise<(StatementEntryView & { accountName: string })[]> {
      const rows = await db
        .select({ ...entryView, accountName: bankAccounts.name })
        .from(bankStatementEntries)
        .innerJoin(bankAccounts, eq(bankAccounts.id, bankStatementEntries.bankAccountId))
        .where(and(sql`${bankStatementEntries.bookingDate} < ${date}`, entryUnmatched))
        .orderBy(asc(bankStatementEntries.bookingDate), asc(bankStatementEntries.position));
      return rows.map((r) => ({ ...toEntryView(r), accountName: r.accountName }));
    },
  };
  return repo;
}

export type BankReconciliationRepository = ReturnType<typeof createBankReconciliationRepository>;
export type { BankCsvMapping };

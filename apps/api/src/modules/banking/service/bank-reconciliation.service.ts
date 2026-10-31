import { createHash } from "node:crypto";
import { auditLog, type BankCsvMapping, type Db, type Tx } from "@navet/db";
import {
  isCompleteCsvMapping,
  normalizeBankIdentifier,
  round2,
  vatCodeEntry,
  type AutoMatchInput,
  type BankCsvMappingInput,
  type BankStatementImportFields,
  type BankStatementPreviewFields,
  type BookBankEntriesByRuleInput,
  type BookBankEntryInput,
  type CreateBankAccountInput,
  type CreateBankMatchInput,
  type CreateBankOpeningInput,
  type CreateBankReconciliationInput,
  type CreateBankRuleInput,
  type BankReconciliationQuery,
  type UpdateBankAccountInput,
  type UpdateBankRuleInput,
  type VerificationRowInput,
} from "@navet/shared";
import { isUniqueViolation } from "../../system/service/db-errors.js";
import { errorBody } from "../../system/service/error-body.js";
import type { PostingSettings } from "../../system/service/posting-settings.js";
import type { VerificationComposeInput } from "../../economy/service/economy.service.js";
import type { VerificationRowWrite } from "../../economy/repository/economy.repository.js";
import { AccountingPeriodLockedError } from "../../economy/service/accounting-period-lock.js";
import {
  CostCenterInactiveError,
  CostCenterNotFoundError,
  CostCenterRequiredError,
  ProjectClosedError,
  ProjectNotFoundError,
  dimensionRef,
  loadDimensionRefs,
  resolveDimensions,
} from "../../economy/service/dimension-check.js";
import {
  AccountNotFoundError,
  InactiveAccountError,
  NoAccountingPeriodError,
  NoFiscalYearForDateError,
  TooFewVerificationRowsError,
  UnbalancedVerificationError,
  VerificationSeriesNotFoundError,
} from "../../economy/service/economy.service.js";
import {
  lockBankAccount,
  type BankAccountRow,
  type BankMatchRow,
  type BankReconciliationRepository,
  type BankReconciliationRow,
  type BankRuleRow,
  type LedgerRowView,
  type StatementEntryView,
} from "../repository/bank-reconciliation.repository.js";
import { reportableError as reportError } from "./reportable-error.js";
import {
  BankAccountIdentifierLockedError,
  BankAccountIdentifierTakenError,
  BankAccountInUseError,
  BankAccountLedgerMissingError,
  BankAccountNotFoundError,
  BankAccountRequiredError,
  BankEntryBookMismatchError,
  BankFileParseError,
  BankMatchAlreadyMatchedError,
  BankMatchAlreadyUndoneError,
  BankMatchNotFoundError,
  BankMatchSumMismatchError,
  BankMatchWrongAccountError,
  BankOpeningBalanceMismatchError,
  BankOpeningNotAllowedError,
  BankReconciliationIncompleteError,
  BankRuleAccountMissingError,
  BankRuleAmbiguousError,
  BankRuleMissingError,
  BankRuleNotFoundError,
  BankStatementAccountMismatchError,
  BankStatementAccountUnknownError,
  BankStatementCsvMappingError,
  BankStatementCurrencyError,
  BankStatementEntryNotFoundError,
  BankStatementFormatError,
} from "./banking.errors.js";
import { parseBankStatementCsv, readBankCsvHeaders } from "./bank-statement-csv.js";
import { parseCamt053, type ParsedStatement } from "./iso20022/camt053-parser.js";
import { proposeMatches, type MatchProposal } from "./match-proposals.js";
import { reconciliationSummary, type ReconciliationSummary } from "./reconciliation-summary.js";

// The known-error whitelist and the generic text live in reportable-error.ts
// (shared with the bank files' per-entry results); re-exported for the tests.
export { UNEXPECTED_ERROR_TEXT, isKnownBankError } from "./reportable-error.js";

// Bankavstämning (etapp 4) — spec §1–§5. The statement side of a bank
// account is imported from camt.053 or CSV, matched against the verification
// rows on the account's ledger account (debit − credit), missing entries are
// booked straight from the statement (series B, verification + match in ONE
// transaction through economy's createVerificationInTx — the single
// create-and-book path), and the account is marked Avstämd t.o.m. a day.
// Every matching write takes the bank account's advisory lock first; the
// partial unique indexes on the live link rows are the final guard.

export interface BankAccountView {
  id: string;
  name: string;
  identifier: string;
  ledgerAccount: string;
  ledgerAccountName: string | null;
  currency: string;
  active: boolean;
  csvMapping: BankCsvMapping | null;
  reconciledThrough: string | null;
  lastStatementDate: string | null;
  unmatchedCount: number;
  // Entries or matchings exist: ledgerAccount and currency are locked.
  hasActivity: boolean;
}

export interface RuleSuggestion {
  ruleId: string;
  accountNumber: string;
  description: string | null;
  vatCode: string | null;
  // Kostnadsställen och projekt: prefilled on the counter row.
  costCenterId: string | null;
  projectId: string | null;
}

export interface EntryView extends StatementEntryView {
  ruleSuggestion: RuleSuggestion | null;
}

export interface LedgerRowOut {
  id: string;
  verificationId: string;
  verificationDisplayNumber: string;
  date: string;
  description: string;
  amount: number;
}

export interface MatchView {
  id: string;
  kind: BankMatchRow["kind"];
  createdAt: Date;
  createdBy: string | null;
  undoneAt: Date | null;
  entries: StatementEntryView[];
  rows: LedgerRowOut[];
}

export interface ReconciliationView {
  id: string;
  throughDate: string;
  statementBalance: number;
  ledgerBalance: number;
  // The Startpunkt's mark: written by the opening matching (`matchId`).
  opening: boolean;
  matchId: string | null;
  createdAt: Date;
  createdBy: string | null;
}

export interface PreviewEntry {
  bookingDate: string;
  valueDate: string | null;
  amount: number;
  text: string;
  reference: string | null;
  counterparty: string | null;
  duplicate: boolean;
  ruleId: string | null;
}

export interface StatementPreview {
  accountIdentifier: string | null;
  bankAccountId: string | null;
  from: string | null;
  to: string | null;
  openingBalance: number | null;
  closingBalance: number | null;
  entryCount: number;
  newEntryCount: number;
  duplicateCount: number;
  entries: PreviewEntry[];
}

export interface BankStatementPreviewResult {
  sha256: string;
  format: "camt.053" | "csv";
  statements: StatementPreview[];
  csvHeaders: string[] | null;
  needsMapping: boolean;
  unknownAccounts: string[];
  warnings: string[];
  blockers: string[];
}

export interface BankRuleView {
  id: string;
  textContains: string;
  direction: "in" | "out" | "both";
  accountNumber: string;
  accountName: string | null;
  vatCode: string | null;
  description: string | null;
  autoBook: boolean;
  active: boolean;
  sortOrder: number;
  // Kostnadsställen och projekt on the counter row the rule books.
  costCenterId: string | null;
  projectId: string | null;
  costCenter: { id: string; code: string; name: string } | null;
  project: { id: string; code: string; name: string } | null;
}

export interface BankReconciliationServiceDeps {
  db: Db;
  repo: BankReconciliationRepository;
  // economyService: the one create-and-book composition.
  economy: {
    createVerificationInTx(tx: Tx, input: VerificationComposeInput, createdBy: string | null, opts: { book: boolean }): Promise<{ id: string; verificationNumber: number | null }>;
  };
  settings: { read(executor: Db | Tx): Promise<PostingSettings> };
  // The company's own IBAN (the first bank account is prefilled from it).
  company: { readCompany(): Promise<{ iban: string | null }> };
  now?: () => Date;
  // Where unexpected errors (never shown to the user) are reported.
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

export const BANK_SERIES = { code: "B", name: "Bank" } as const;
const RULES_SEEDED_KEY = "bank_rules_seeded";
const MAX_FILE_BYTES = 20 * 1024 * 1024;

// Spec §3: the suggested rules a company starts with — removable.
export const DEFAULT_BANK_RULES: CreateBankRuleInput[] = [
  { textContains: "avgift", direction: "both", accountNumber: "6570", vatCode: null, description: "Bankavgift", autoBook: false, active: true, sortOrder: 10 },
  { textContains: "ränta", direction: "in", accountNumber: "8310", vatCode: null, description: "Ränteintäkt", autoBook: false, active: true, sortOrder: 20 },
  { textContains: "ränta", direction: "out", accountNumber: "8410", vatCode: null, description: "Räntekostnad", autoBook: false, active: true, sortOrder: 30 },
  { textContains: "skatteverket", direction: "both", accountNumber: "1630", vatCode: null, description: "Skattekonto", autoBook: false, active: true, sortOrder: 40 },
  { textContains: "skattekonto", direction: "both", accountNumber: "1630", vatCode: null, description: "Skattekonto", autoBook: false, active: true, sortOrder: 50 },
];

// Does the rule apply to the entry? Case-insensitive contains on the text
// (and the counterparty — a bank fee may only name the bank there), the
// direction by the amount's sign.
export function ruleMatches(rule: Pick<BankRuleRow, "textContains" | "direction" | "active">, entry: { text: string; counterparty: string | null; amount: number }): boolean {
  if (!rule.active) return false;
  if (rule.direction === "in" && entry.amount < 0) return false;
  if (rule.direction === "out" && entry.amount > 0) return false;
  const needle = rule.textContains.trim().toLowerCase();
  if (needle === "") return false;
  return entry.text.toLowerCase().includes(needle) || (entry.counterparty?.toLowerCase().includes(needle) ?? false);
}

// The one rule for an entry — or none / several.
export function matchingRules<R extends Pick<BankRuleRow, "textContains" | "direction" | "active">>(rules: readonly R[], entry: { text: string; counterparty: string | null; amount: number }): R[] {
  return rules.filter((rule) => ruleMatches(rule, entry));
}

const isXml = (data: Buffer) => {
  let i = 0;
  if (data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) i = 3;
  while (i < data.length && (data[i] === 0x20 || data[i] === 0x09 || data[i] === 0x0a || data[i] === 0x0d)) i++;
  return data[i] === 0x3c; // "<"
};

// The bank references an entry carries that a camt.054 entry (and so a
// payment booked from it) can carry too: the entry's AcctSvcrRef, every
// transaction's AcctSvcrRef and EndToEndId; a CSV row's reference column.
export function entryReferences(entry: Pick<StatementEntryView, "details" | "reference">): string[] {
  const refs = new Set<string>();
  if (entry.details.acctSvcrRef) refs.add(entry.details.acctSvcrRef);
  for (const tx of entry.details.transactions ?? []) {
    if (tx.acctSvcrRef) refs.add(tx.acctSvcrRef);
    if (tx.endToEndId) refs.add(tx.endToEndId);
  }
  if ((entry.details.transactions ?? []).length === 0 && entry.reference) refs.add(entry.reference);
  return [...refs];
}

const forProposals = (entries: StatementEntryView[]) => entries.map((e) => ({ id: e.id, bookingDate: e.bookingDate, amount: e.amount, references: entryReferences(e), reversal: e.reversal }));

// The currencies among a statement's entries (Amt@Ccy) other than the
// account's — a statement in SEK may still carry an EUR entry.
const foreignEntryCurrencies = (statement: ParsedStatement, accountCurrency: string): string[] => [
  ...new Set(statement.entries.map((e) => e.currency).filter((c) => c !== accountCurrency)),
];

const toRowOut = (row: LedgerRowView): LedgerRowOut => ({
  id: row.id,
  verificationId: row.verificationId,
  verificationDisplayNumber: row.verificationDisplayNumber,
  date: row.date,
  description: row.description,
  amount: row.amount,
});

export function createBankReconciliationService(deps: BankReconciliationServiceDeps) {
  const { db, repo } = deps;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((msg: string, extra?: Record<string, unknown>) => console.error(msg, extra));

  // The error envelope for a failure reported inside a 2xx answer (import
  // warnings, book-by-rule failures): known domain errors as they are,
  // anything else logged and replaced by the generic text.
  function reportableError(err: unknown, context: string): { error: string; code?: string } {
    return reportError(err, log, `Bankavstämning: ${context}`);
  }

  async function audit(executor: Db | Tx, entityType: string, entityId: string, action: string, detail: unknown, userId: string | null) {
    await executor.insert(auditLog).values({ entityType, entityId, action, detail, userId });
  }

  async function requireAccount(executor: Db | Tx, id: string): Promise<BankAccountRow> {
    const account = await repo.findAccount(executor, id);
    if (!account) throw new BankAccountNotFoundError(id);
    return account;
  }

  // The ledger account behind a bank account — must exist and be active for
  // anything to be matched or booked against it.
  async function requireLedgerAccount(executor: Db | Tx, number: string) {
    const account = await repo.findLedgerAccountByNumber(executor, number);
    if (!account || !account.active) throw new BankAccountLedgerMissingError(number);
    return account;
  }

  async function accountView(row: Awaited<ReturnType<BankReconciliationRepository["listAccounts"]>>[number]): Promise<BankAccountView> {
    return {
      id: row.account.id,
      name: row.account.name,
      identifier: row.account.identifier,
      ledgerAccount: row.account.ledgerAccount,
      ledgerAccountName: row.ledgerAccountName,
      currency: row.account.currency,
      active: row.account.active,
      csvMapping: row.account.csvMapping ?? null,
      reconciledThrough: row.reconciledThrough,
      lastStatementDate: row.lastStatementDate,
      unmatchedCount: Number(row.unmatchedCount),
      hasActivity: row.hasActivity === true,
    };
  }

  async function loadAccountView(id: string): Promise<BankAccountView> {
    const rows = await repo.listAccounts(true);
    const row = rows.find((r) => r.account.id === id);
    if (!row) throw new BankAccountNotFoundError(id);
    return accountView(row);
  }

  // The first bank account, prefilled from Företagsuppgifter's IBAN and the
  // standard account Bank/betalkonto — only when the IBAN is set and the
  // ledger account exists (spec §1). INSERT … ON CONFLICT DO NOTHING on the
  // identifier: a concurrent first GET simply reads what the winner made.
  async function ensureFirstAccount(): Promise<void> {
    if ((await repo.countAccounts()) > 0) return;
    const company = await deps.company.readCompany();
    if (!company.iban) return;
    const identifier = normalizeBankIdentifier(company.iban);
    if (!/^[A-Z0-9]{1,40}$/.test(identifier)) return;
    const settings = await deps.settings.read(db);
    const ledger = await repo.findLedgerAccountByNumber(db, settings.postingBank);
    if (!ledger || !ledger.active) return;
    await repo.insertAccountIfAbsent({ name: "Företagskonto", identifier, ledgerAccount: settings.postingBank, currency: "SEK" });
  }

  // The suggested rules, once per installation: the flag is claimed with
  // INSERT … ON CONFLICT DO NOTHING RETURNING inside the transaction that
  // inserts the rules, so two concurrent first GETs give ONE set — and a
  // user who emptied the table never gets the seed back.
  async function seedRulesOnce(): Promise<void> {
    if ((await repo.getSetting(RULES_SEEDED_KEY)) !== null) return;
    await db.transaction(async (tx) => {
      if (!(await repo.claimSetting(tx, RULES_SEEDED_KEY, now().toISOString()))) return;
      if ((await repo.countRules(tx)) > 0) return;
      await repo.insertRules(tx, DEFAULT_BANK_RULES.map((r) => ({ ...r, sortOrder: r.sortOrder ?? 0 })));
    });
  }

  async function rulesList(): Promise<BankRuleRow[]> {
    return repo.listRules();
  }

  function suggestionFor(rules: readonly BankRuleRow[], entry: { text: string; counterparty: string | null; amount: number }): RuleSuggestion | null {
    const hits = matchingRules(rules, entry);
    if (hits.length !== 1) return null;
    const rule = hits[0]!;
    return {
      ruleId: rule.id,
      accountNumber: rule.accountNumber,
      description: rule.description,
      vatCode: rule.vatCode,
      costCenterId: rule.costCenterId,
      projectId: rule.projectId,
    };
  }

  async function matchViews(executor: Db | Tx, matches: BankMatchRow[]): Promise<MatchView[]> {
    const links = await repo.matchLinks(executor, matches.map((m) => m.id));
    return matches.map((m) => ({
      id: m.id,
      kind: m.kind,
      createdAt: m.createdAt,
      createdBy: m.createdBy,
      undoneAt: m.undoneAt,
      entries: links.entries.get(m.id) ?? [],
      rows: (links.rows.get(m.id) ?? []).map(toRowOut),
    }));
  }

  async function loadMatch(executor: Db | Tx, id: string): Promise<MatchView> {
    const match = await repo.findMatch(executor, id);
    if (!match) throw new BankMatchNotFoundError(id);
    return (await matchViews(executor, [match]))[0]!;
  }

  // Same checks as economy's resolveVerificationRow: the account exists and
  // is active, amounts round2:ed.
  async function resolveRows(executor: Db | Tx, rows: VerificationRowInput[]): Promise<VerificationRowWrite[]> {
    const out: VerificationRowWrite[] = [];
    for (const row of rows) {
      const account = await repo.findLedgerAccountById(executor, row.accountId);
      if (!account) throw new AccountNotFoundError(row.accountId);
      if (!account.active) throw new InactiveAccountError(row.accountId);
      // Kostnadsställen och projekt: the row's objects, held to the rule.
      const dimensions = await resolveDimensions(executor, { costCenterId: row.costCenterId, projectId: row.projectId });
      out.push({ accountId: row.accountId, debit: round2(row.debit), credit: round2(row.credit), description: row.description ?? null, ...dimensions });
    }
    return out;
  }

  // The verification + the match in ONE transaction, under the account's
  // lock, the entry re-read FOR UPDATE and re-checked unmatched. Returns
  // the verification and the match id.
  async function bookEntryInTx(
    tx: Tx,
    entry: StatementEntryView,
    account: BankAccountRow,
    ledgerAccountId: string,
    input: { seriesId: string | null; date: string; description: string; rows: VerificationRowWrite[] },
    userId: string
  ): Promise<{ verificationId: string; matchId: string }> {
    await lockBankAccount(tx, account.id);
    const locked = await repo.lockEntry(tx, entry.id);
    if (!locked) throw new BankStatementEntryNotFoundError(entry.id);
    if (await repo.isEntryMatched(tx, entry.id)) throw new BankMatchAlreadyMatchedError();
    const onBank = round2(input.rows.filter((r) => r.accountId === ledgerAccountId).reduce((acc, r) => acc + r.debit - r.credit, 0));
    if (onBank !== locked.amount) throw new BankEntryBookMismatchError(locked.amount, onBank);
    const series = input.seriesId ? await repo.findSeriesById(tx, input.seriesId) : await repo.ensureSeries(tx, BANK_SERIES);
    if (!series) throw new VerificationSeriesNotFoundError(input.seriesId!);
    const { id: verificationId } = await deps.economy.createVerificationInTx(
      tx,
      { seriesId: series.id, date: input.date, description: input.description.slice(0, 255), rows: input.rows },
      userId,
      { book: true }
    );
    const rowIds = await repo.verificationRowsOnAccount(tx, verificationId, ledgerAccountId);
    const matchId = await repo.insertMatch(tx, { bankAccountId: account.id, kind: "created", createdBy: userId }, [entry.id], rowIds);
    await audit(tx, "bank_match", matchId, "created", { entryId: entry.id, verificationId, amount: locked.amount }, userId);
    return { verificationId, matchId };
  }

  // The rows a rule makes of an entry: the bank account on the entry's side,
  // the rule's account for the net and — with a momskod — the VAT on the
  // code's input (money out) or output (money in) VAT account.
  async function rowsFromRule(executor: Db | Tx, rule: BankRuleRow, entry: StatementEntryView, ledgerAccountId: string): Promise<VerificationRowWrite[]> {
    const counter = await repo.findLedgerAccountByNumber(executor, rule.accountNumber);
    if (!counter || !counter.active) throw new BankRuleAccountMissingError(rule.accountNumber);
    const gross = Math.abs(entry.amount);
    const incoming = entry.amount > 0;
    let net = gross;
    let vat = 0;
    let vatAccountId: string | null = null;
    if (rule.vatCode) {
      const catalog = vatCodeEntry(rule.vatCode as Parameters<typeof vatCodeEntry>[0]);
      const stored = await repo.findVatCode(executor, rule.vatCode);
      const number = incoming ? (stored?.outputVatAccount ?? catalog.slots.outputVat?.account) : (stored?.inputVatAccount ?? catalog.slots.inputVat?.account);
      if (catalog.rate > 0) {
        if (!number) throw new BankRuleAccountMissingError(rule.vatCode);
        const vatAccount = await repo.findLedgerAccountByNumber(executor, number);
        if (!vatAccount || !vatAccount.active) throw new BankRuleAccountMissingError(number);
        net = round2(gross / (1 + catalog.rate / 100));
        vat = round2(gross - net);
        vatAccountId = vat > 0 ? vatAccount.id : null;
      }
    }
    const rows: VerificationRowWrite[] = [{ accountId: ledgerAccountId, debit: incoming ? gross : 0, credit: incoming ? 0 : gross, description: null }];
    // Kostnadsställen och projekt: the rule's objects on the counter row only
    // (never the bank or the VAT row). A closed/inactive object on the rule is
    // dropped like any default — the booking must not fail on the register.
    const dimensions = await resolveDimensions(executor, {}, { fallback: { costCenterId: rule.costCenterId, projectId: rule.projectId } });
    rows.push({ accountId: counter.id, debit: incoming ? 0 : net, credit: incoming ? net : 0, description: null, ...dimensions });
    if (vatAccountId && vat > 0) rows.push({ accountId: vatAccountId, debit: incoming ? 0 : vat, credit: incoming ? vat : 0, description: null });
    return rows;
  }

  async function bookOneByRule(entryId: string, userId: string, rules: readonly BankRuleRow[]): Promise<{ entryId: string; verificationId: string; displayNumber: string }> {
    const entry = await repo.findEntry(db, entryId);
    if (!entry) throw new BankStatementEntryNotFoundError(entryId);
    if (await repo.isEntryMatched(db, entryId)) throw new BankMatchAlreadyMatchedError();
    const hits = matchingRules(rules, entry);
    if (hits.length === 0) throw new BankRuleMissingError();
    if (hits.length > 1) throw new BankRuleAmbiguousError(hits.map((r) => r.id));
    const rule = hits[0]!;
    const account = await requireAccount(db, entry.bankAccountId);
    const ledger = await requireLedgerAccount(db, account.ledgerAccount);
    const rows = await rowsFromRule(db, rule, entry, ledger.id);
    const { verificationId } = await db.transaction((tx) =>
      bookEntryInTx(tx, entry, account, ledger.id, { seriesId: null, date: entry.bookingDate, description: rule.description ?? entry.text, rows }, userId)
    );
    const display = await repo.verificationDisplay(db, verificationId);
    return { entryId, verificationId, displayNumber: display?.displayNumber ?? "Utkast" };
  }

  // One automatic matching pass over an account: every unambiguous proposal
  // becomes a match in its own transaction (a lost race on the unique index
  // is simply skipped).
  async function autoMatchAccount(account: BankAccountRow, range: { from?: string; to?: string }, userId: string | null): Promise<{ matched: number; ambiguous: number }> {
    const ledger = await repo.findLedgerAccountByNumber(db, account.ledgerAccount);
    if (!ledger) return { matched: 0, ambiguous: 0 };
    const [entries, rows] = await Promise.all([repo.unmatchedEntries(db, account.id, range), repo.unmatchedRows(db, ledger.id, {})]);
    const proposals = proposeMatches(forProposals(entries), rows);
    let matched = 0;
    let ambiguous = 0;
    for (const proposal of proposals) {
      if (proposal.ambiguous) {
        ambiguous++;
        continue;
      }
      try {
        await db.transaction(async (tx) => {
          await lockBankAccount(tx, account.id);
          if (await repo.anyMatched(tx, proposal.entryIds, proposal.rowIds)) return;
          const id = await repo.insertMatch(tx, { bankAccountId: account.id, kind: "auto", createdBy: userId }, proposal.entryIds, proposal.rowIds);
          await audit(tx, "bank_match", id, "auto_matched", { basis: proposal.basis, entryIds: proposal.entryIds, rowIds: proposal.rowIds }, userId);
          matched++;
        });
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
      }
    }
    return { matched, ambiguous };
  }

  // --- Parsing shared by preview and import ---
  interface ParsedUpload {
    sha256: string;
    format: "camt.053" | "csv";
    messageId: string | null;
    statements: ParsedStatement[];
    warnings: string[];
    csvHeaders: string[] | null;
    needsMapping: boolean;
    mappingUsed: BankCsvMappingInput | null;
  }

  async function parseUpload(data: Buffer, fields: BankStatementPreviewFields, lenient: boolean): Promise<ParsedUpload> {
    if (data.length > MAX_FILE_BYTES) throw new BankFileParseError("Filen är större än 20 MB");
    const sha256 = createHash("sha256").update(data).digest("hex");
    if (isXml(data)) {
      const parsed = parseCamt053(data.toString("utf8"));
      return { sha256, format: "camt.053", messageId: parsed.messageId, statements: parsed.statements, warnings: parsed.warnings, csvHeaders: null, needsMapping: false, mappingUsed: null };
    }
    // CSV: the account decides the mapping (given, else saved on it). A given
    // mapping without the three required columns is the dialog's Läs om
    // rubriker — the header row is read with ITS delimiter/skipRows and the
    // columns are asked for; the account's saved mapping is deliberately not
    // used then (the user is choosing anew).
    const account = fields.bankAccountId ? await repo.findAccount(db, fields.bankAccountId) : null;
    if (fields.bankAccountId && !account) throw new BankAccountNotFoundError(fields.bankAccountId);
    const given = fields.csvMapping ?? null;
    const mapping: BankCsvMappingInput | null = given ? (isCompleteCsvMapping(given) ? given : null) : (account?.csvMapping ?? null);
    const headerOptions = given ?? mapping;
    const headers = (() => {
      try {
        return readBankCsvHeaders(data, { delimiter: headerOptions?.delimiter, skipRows: headerOptions?.skipRows });
      } catch {
        return [];
      }
    })();
    if (!account) {
      if (!lenient) throw new BankAccountRequiredError("CSV-import kräver att du väljer bankkonto");
      return { sha256, format: "csv", messageId: null, statements: [], warnings: [], csvHeaders: headers, needsMapping: mapping === null, mappingUsed: mapping };
    }
    if (!mapping) {
      if (!lenient) throw new BankStatementCsvMappingError("Kolumnmappning saknas — ange vilka kolumner som är bokföringsdag, belopp och text");
      return { sha256, format: "csv", messageId: null, statements: [], warnings: [], csvHeaders: headers, needsMapping: true, mappingUsed: null };
    }
    try {
      // The dedupe key is scoped on the account's id (stable), not its
      // identifier (correctable), so a renamed account never re-imports.
      const parsed = parseBankStatementCsv(data, mapping, account.identifier, account.currency, account.id);
      return { sha256, format: "csv", messageId: null, statements: [parsed.statement], warnings: parsed.warnings, csvHeaders: parsed.headers, needsMapping: false, mappingUsed: mapping };
    } catch (err) {
      if (lenient && err instanceof BankStatementCsvMappingError) {
        return { sha256, format: "csv", messageId: null, statements: [], warnings: [err.message], csvHeaders: headers, needsMapping: true, mappingUsed: mapping };
      }
      throw err;
    }
  }

  // Which bank account each statement belongs to: the register by the
  // file's Acct/Id; an unknown one takes `bankAccountId` when exactly one
  // statement is unknown (the import then saves the identifier) — but only
  // onto an account without entries: one that already has statements under
  // its identifier is not taken over by a file for another account.
  async function resolveAccounts(executor: Db | Tx, statements: ParsedStatement[], bankAccountId: string | undefined, format: "camt.053" | "csv") {
    const resolved: { statement: ParsedStatement; account: BankAccountRow | null; learnIdentifier: boolean }[] = [];
    const unknown: string[] = [];
    const chosen = bankAccountId ? await repo.findAccount(executor, bankAccountId) : null;
    if (bankAccountId && !chosen) throw new BankAccountNotFoundError(bankAccountId);
    for (const statement of statements) {
      if (format === "csv") {
        resolved.push({ statement, account: chosen, learnIdentifier: false });
        continue;
      }
      const byIdentifier = statement.accountIdentifier ? await repo.findAccountByIdentifier(executor, statement.accountIdentifier) : null;
      if (byIdentifier) resolved.push({ statement, account: byIdentifier, learnIdentifier: false });
      else {
        unknown.push(statement.accountIdentifier ?? "okänt konto");
        resolved.push({ statement, account: null, learnIdentifier: true });
      }
    }
    const unknownCount = resolved.filter((r) => r.account === null).length;
    if (chosen && format === "camt.053") {
      if (unknownCount === 1) {
        const locked = (await repo.countEntries(executor, chosen.id)) > 0;
        for (const r of resolved) {
          if (r.account !== null) continue;
          if (locked && r.statement.accountIdentifier) throw new BankAccountIdentifierLockedError(chosen.name, chosen.identifier, r.statement.accountIdentifier);
          r.account = chosen;
        }
      } else if (unknownCount === 0) {
        // Every statement resolved on its own; the chosen account must be one of them.
        if (!resolved.some((r) => r.account?.id === chosen.id)) throw new BankStatementAccountMismatchError(resolved[0]?.statement.accountIdentifier ?? "?");
      }
    }
    return { resolved, unknown, chosen };
  }

  const service = {
    // --- Bankkonton ---
    // `seed` (default true) lets the first GET create the company account;
    // the route passes false for an Endast läsning user, who writes nothing.
    async listAccounts(includeInactive: boolean, opts: { seed?: boolean } = {}): Promise<{ rows: BankAccountView[]; total: number }> {
      if (opts.seed !== false) await ensureFirstAccount();
      const rows = await repo.listAccounts(includeInactive);
      const views = await Promise.all(rows.map(accountView));
      return { rows: views, total: views.length };
    },

    async getAccount(id: string): Promise<BankAccountView> {
      return loadAccountView(id);
    },

    async createAccount(input: CreateBankAccountInput, userId: string): Promise<BankAccountView> {
      await requireLedgerAccount(db, input.ledgerAccount);
      let row: BankAccountRow;
      try {
        row = await repo.insertAccount({
          name: input.name,
          identifier: normalizeBankIdentifier(input.identifier),
          ledgerAccount: input.ledgerAccount,
          currency: input.currency,
          csvMapping: input.csvMapping ?? null,
        });
      } catch (err) {
        if (isUniqueViolation(err)) throw new BankAccountIdentifierTakenError(input.identifier);
        throw err;
      }
      await audit(db, "bank_account", row.id, "created", { name: row.name, identifier: row.identifier, ledgerAccount: row.ledgerAccount }, userId);
      return loadAccountView(row.id);
    },

    async updateAccount(id: string, input: UpdateBankAccountInput, userId: string): Promise<BankAccountView> {
      const existing = await requireAccount(db, id);
      if (input.ledgerAccount !== undefined) await requireLedgerAccount(db, input.ledgerAccount);
      // The ledger account and the currency are what the entries and the
      // matchings were made against — locked once any exist.
      const changesLedger = input.ledgerAccount !== undefined && input.ledgerAccount !== existing.ledgerAccount;
      const changesCurrency = input.currency !== undefined && input.currency !== existing.currency;
      if ((changesLedger || changesCurrency) && (await repo.accountHasActivity(db, id))) throw new BankAccountInUseError(changesLedger ? "ledgerAccount" : "currency");
      const values: Partial<typeof existing> = {};
      if (input.name !== undefined) values.name = input.name;
      if (input.identifier !== undefined) values.identifier = normalizeBankIdentifier(input.identifier);
      if (input.ledgerAccount !== undefined) values.ledgerAccount = input.ledgerAccount;
      if (input.currency !== undefined) values.currency = input.currency;
      if (input.csvMapping !== undefined) values.csvMapping = input.csvMapping;
      if (input.active !== undefined) values.active = input.active;
      try {
        await repo.updateAccount(db, id, values);
      } catch (err) {
        if (isUniqueViolation(err)) throw new BankAccountIdentifierTakenError(input.identifier ?? existing.identifier);
        throw err;
      }
      await audit(db, "bank_account", id, "updated", { before: existing, after: values }, userId);
      return loadAccountView(id);
    },

    // --- Import ---
    async preview(upload: { data: Buffer }, fields: BankStatementPreviewFields): Promise<BankStatementPreviewResult> {
      const parsed = await parseUpload(upload.data, fields, true);
      const blockers: string[] = [];
      const warnings = [...parsed.warnings];
      if (parsed.format === "csv" && !fields.bankAccountId) blockers.push("Välj vilket bankkonto filen gäller");
      if (parsed.needsMapping) blockers.push("Kolumnmappningen saknas eller stämmer inte — ange kolumnerna för bokföringsdag, belopp och text");
      let unknown: string[] = [];
      let resolved: Awaited<ReturnType<typeof resolveAccounts>>["resolved"] = [];
      let identifierLocked = false;
      try {
        const r = await resolveAccounts(db, parsed.statements, fields.bankAccountId, parsed.format);
        unknown = r.unknown;
        resolved = r.resolved;
      } catch (err) {
        if (err instanceof BankStatementAccountMismatchError) {
          blockers.push("Filens konto hör till ett annat bankkonto än det valda");
          resolved = parsed.statements.map((statement) => ({ statement, account: null, learnIdentifier: false }));
        } else if (err instanceof BankAccountIdentifierLockedError) {
          identifierLocked = true;
          unknown = [err.fileIdentifier];
          blockers.push(`Bankkontot ${err.accountName} har redan identifieraren ${err.identifier} och importerade poster — filens konto ${err.fileIdentifier} kan inte tas över. Lägg upp ett eget bankkonto för det, eller välj ett annat.`);
          resolved = parsed.statements.map((statement) => ({ statement, account: null, learnIdentifier: false }));
        } else throw err;
      }
      if (!identifierLocked && resolved.some((r) => r.account === null && parsed.format === "camt.053")) {
        blockers.push(unknown.length > 1 ? `Filen gäller ${unknown.length} okända konton — lägg upp dem under Bankkonton först` : "Kontoutdragets konto är okänt — välj vilket bankkonto det är");
      }
      const rules = await rulesList();
      const keys = parsed.statements.flatMap((s) => s.entries.map((e) => e.dedupeKey));
      const existing = await repo.existingEntryKeys(db, keys);
      const statements: StatementPreview[] = resolved.map(({ statement, account }) => {
        if (account && statement.currency && statement.currency !== account.currency) {
          blockers.push(`Kontoutdraget är i ${statement.currency} men bankkontot ${account.name} är i ${account.currency}`);
        } else if (account) {
          // The statement's currency agrees (or is unstated): every entry's
          // Amt@Ccy must too.
          for (const currency of foreignEntryCurrencies(statement, account.currency)) {
            blockers.push(`Kontoutdraget har poster i ${currency} men bankkontot ${account.name} är i ${account.currency}`);
          }
        }
        const entries: PreviewEntry[] = statement.entries.map((e) => ({
          bookingDate: e.bookingDate,
          valueDate: e.valueDate,
          amount: e.amount,
          text: e.text,
          reference: e.reference,
          counterparty: e.counterparty,
          duplicate: existing.has(e.dedupeKey),
          ruleId: suggestionFor(rules, e)?.ruleId ?? null,
        }));
        const duplicateCount = entries.filter((e) => e.duplicate).length;
        return {
          accountIdentifier: statement.accountIdentifier,
          bankAccountId: account?.id ?? null,
          from: statement.fromDate,
          to: statement.toDate,
          openingBalance: statement.openingBalance,
          closingBalance: statement.closingBalance,
          entryCount: entries.length,
          newEntryCount: entries.length - duplicateCount,
          duplicateCount,
          entries,
        };
      });
      if (statements.length > 0 && statements.every((s) => s.entryCount > 0 && s.newEntryCount === 0)) warnings.push("Alla poster i filen är redan inlästa");
      return {
        sha256: parsed.sha256,
        format: parsed.format,
        statements,
        csvHeaders: parsed.csvHeaders,
        needsMapping: parsed.needsMapping,
        unknownAccounts: unknown,
        warnings,
        blockers: [...new Set(blockers)],
      };
    },

    // `autoMatch` defaults to true (the zod field does the same for the form).
    async import(upload: { filename: string; contentType: string; data: Buffer }, fields: Omit<BankStatementImportFields, "autoMatch"> & Partial<Pick<BankStatementImportFields, "autoMatch">>, userId: string) {
      const parsed = await parseUpload(upload.data, fields, false);
      const warnings = [...parsed.warnings];
      const result = await db.transaction(async (tx) => {
        const { resolved, unknown } = await resolveAccounts(tx, parsed.statements, fields.bankAccountId, parsed.format);
        const unresolved = resolved.filter((r) => r.account === null);
        if (unresolved.length > 0) {
          if (!fields.bankAccountId) throw new BankAccountRequiredError(`Kontoutdragets konto är okänt (${unknown.join(", ")}) — välj bankkonto`);
          throw new BankStatementAccountUnknownError(unknown);
        }
        for (const r of resolved) {
          if (r.statement.currency && r.account!.currency !== r.statement.currency) throw new BankStatementCurrencyError(r.statement.currency, r.account!.currency);
          const [foreign] = foreignEntryCurrencies(r.statement, r.account!.currency);
          if (foreign) throw new BankStatementCurrencyError(foreign, r.account!.currency);
        }
        // The file: insert-only bank_files, reused when the same bytes were
        // uploaded before — or are being uploaded concurrently (get-or-create
        // on the sha256; the entries then dedupe themselves).
        const file = await repo.ensureIncomingFile(tx, {
          direction: "incoming",
          messageType: parsed.format === "camt.053" ? "camt.053.001.02" : "csv",
          filename: upload.filename.slice(0, 255),
          contentType: (upload.contentType || (parsed.format === "csv" ? "text/csv" : "application/xml")).slice(0, 100),
          sizeBytes: upload.data.length,
          sha256: parsed.sha256,
          data: upload.data,
          bankMessageId: parsed.messageId?.slice(0, 35) ?? null,
          entryCount: parsed.statements.reduce((acc, s) => acc + s.entries.length, 0),
          warnings: parsed.warnings,
          uploadedBy: userId,
        });
        let imported = 0;
        let duplicates = 0;
        const statements: { id: string; bankAccountId: string; from: string | null; to: string | null }[] = [];
        const newEntryIds: string[] = [];
        const touched = new Map<string, BankAccountRow>();
        for (const { statement, account, learnIdentifier } of resolved) {
          const existing = await repo.existingEntryKeys(tx, statement.entries.map((e) => e.dedupeKey));
          const fresh = statement.entries.filter((e) => !existing.has(e.dedupeKey));
          const row = await repo.insertStatement(tx, {
            bankAccountId: account!.id,
            bankFileId: file.id,
            statementId: statement.statementId?.slice(0, 100) ?? null,
            fromDate: statement.fromDate,
            toDate: statement.toDate,
            openingBalance: statement.openingBalance === null ? null : String(statement.openingBalance),
            closingBalance: statement.closingBalance === null || statement.closingBalanceDate === null ? null : String(statement.closingBalance),
            closingBalanceDate: statement.closingBalance === null ? null : statement.closingBalanceDate,
            entryCount: fresh.length,
            duplicateCount: statement.entries.length - fresh.length,
          });
          const ids = await repo.insertEntries(
            tx,
            fresh.map((e) => ({
              bankAccountId: account!.id,
              bankStatementId: row.id,
              bankFileId: file.id,
              dedupeKey: e.dedupeKey,
              bookingDate: e.bookingDate,
              valueDate: e.valueDate,
              amount: String(e.amount),
              currency: e.currency,
              text: e.text,
              reference: e.reference,
              counterparty: e.counterparty,
              details: e.details,
              reversal: e.reversal,
              position: e.position,
            }))
          );
          imported += ids.length;
          duplicates += statement.entries.length - ids.length;
          newEntryIds.push(...ids);
          statements.push({ id: row.id, bankAccountId: account!.id, from: statement.fromDate, to: statement.toDate });
          touched.set(account!.id, account!);
          if (learnIdentifier && statement.accountIdentifier && statement.accountIdentifier !== account!.identifier) {
            try {
              await repo.updateAccount(tx, account!.id, { identifier: statement.accountIdentifier });
            } catch (err) {
              if (isUniqueViolation(err)) throw new BankAccountIdentifierTakenError(statement.accountIdentifier);
              throw err;
            }
            warnings.push(`Bankkontot ${account!.name} fick identifieraren ${statement.accountIdentifier} från filen`);
          }
          if (parsed.format === "csv" && fields.csvMapping) await repo.updateAccount(tx, account!.id, { csvMapping: fields.csvMapping });
          await audit(tx, "bank_statement", row.id, "imported", { bankFileId: file.id, filename: file.filename, imported: ids.length, duplicates: statement.entries.length - ids.length }, userId);
        }
        return { bankFileId: file.id, statements, imported, duplicates, newEntryIds, touched: [...touched.values()] };
      });

      // After the commit: the automatic matching per account, then the
      // Bokför direkt rules on what is still unmatched — each in its own
      // transaction. The import stands whatever happens here: a failure
      // becomes a warning in the answer (and a log line), never a 500.
      let autoMatched = 0;
      let autoBooked = 0;
      if (fields.autoMatch !== false) {
        for (const account of result.touched) {
          try {
            autoMatched += (await autoMatchAccount(account, {}, userId)).matched;
          } catch (err) {
            warnings.push(`Den automatiska matchningen av ${account.name} misslyckades: ${reportableError(err, "automatic matching after import").error}`);
          }
        }
      }
      try {
        const rules = await rulesList();
        if (rules.some((r) => r.autoBook && r.active) && result.newEntryIds.length > 0) {
          const entries = await repo.entriesByIds(db, result.newEntryIds);
          for (const entry of entries) {
            const hits = matchingRules(rules, entry);
            if (hits.length !== 1 || !hits[0]!.autoBook) continue;
            if (await repo.isEntryMatched(db, entry.id)) continue;
            try {
              await bookOneByRule(entry.id, userId, rules);
              autoBooked++;
            } catch (err) {
              if (err instanceof BankMatchAlreadyMatchedError) continue;
              warnings.push(`Posten ${entry.bookingDate} ${entry.text} kunde inte bokföras direkt: ${reportableError(err, "Bokför direkt after import").error}`);
            }
          }
        }
      } catch (err) {
        warnings.push(`Bankreglerna kunde inte köras efter importen: ${reportableError(err, "rules after import").error}`);
      }
      return { bankFileId: result.bankFileId, statements: result.statements, imported: result.imported, duplicates: result.duplicates, autoMatched, autoBooked, warnings };
    },

    // --- Avstämningsvyn ---
    async reconciliationView(query: BankReconciliationQuery) {
      const bankAccount = await loadAccountView(query.bankAccountId);
      const ledger = await repo.findLedgerAccountByNumber(db, bankAccount.ledgerAccount);
      const rules = await rulesList();
      const entries = await repo.unmatchedEntries(db, bankAccount.id, { from: query.from, to: query.to });
      const rows = ledger ? await repo.unmatchedRows(db, ledger.id, { from: query.from, to: query.to }) : [];
      const matches = await matchViews(db, await repo.matchesInRange(db, bankAccount.id, query.from, query.to));
      const statementBalance = await repo.latestStatementBalance(db, bankAccount.id, query.to);
      const balanceDate = statementBalance?.date ?? query.to;
      const summary: ReconciliationSummary = reconciliationSummary({
        statementBalance: statementBalance?.balance ?? null,
        statementBalanceDate: statementBalance?.date ?? null,
        ledgerBalance: ledger ? await repo.ledgerBalanceThrough(db, ledger.id, balanceDate) : 0,
        unmatchedEntriesSum: await repo.unmatchedEntriesSum(db, bankAccount.id, balanceDate),
        unmatchedRowsSum: ledger ? await repo.unmatchedRowsSum(db, ledger.id, balanceDate) : 0,
        inTransit: await repo.inTransitSum(db, bankAccount.id, balanceDate),
      });
      const reconciliations = (await repo.listReconciliations(db, bankAccount.id)).map(reconciliationView);
      const latest = await repo.latestReconciliation(db, bankAccount.id);
      const changed = latest && ledger ? await repo.changedSinceReconciliation(db, bankAccount.id, ledger.id, latest.throughDate, latest.createdAt) : null;
      const proposals: MatchProposal[] = proposeMatches(forProposals(entries), rows);
      return {
        bankAccount,
        from: query.from,
        to: query.to,
        statementEntries: entries.map((e): EntryView => ({ ...e, ruleSuggestion: suggestionFor(rules, e) })),
        ledgerRows: rows.map(toRowOut),
        matches,
        summary,
        reconciliations,
        changedAfterReconciliation:
          latest && changed && (changed.rows > 0 || changed.entries > 0) ? { through: latest.throughDate, rows: changed.rows, entries: changed.entries } : null,
        proposals,
      };
    },

    // --- Matchning ---
    async createMatch(input: CreateBankMatchInput, userId: string): Promise<MatchView> {
      const account = await requireAccount(db, input.bankAccountId);
      const ledger = await requireLedgerAccount(db, account.ledgerAccount);
      const entries = await repo.entriesByIds(db, input.entryIds);
      for (const id of input.entryIds) {
        const entry = entries.find((e) => e.id === id);
        if (!entry) throw new BankStatementEntryNotFoundError(id);
        if (entry.bankAccountId !== account.id) throw new BankMatchWrongAccountError(`Entry ${id} belongs to another bank account`);
      }
      const rows = await repo.rowsByIds(db, input.verificationRowIds);
      for (const id of input.verificationRowIds) {
        const row = rows.find((r) => r.id === id);
        if (!row) throw new BankMatchWrongAccountError(`Verification row ${id} not found`);
        if (row.accountId !== ledger.id) throw new BankMatchWrongAccountError(`Verification row ${id} is not on account ${account.ledgerAccount}`);
        if (row.verificationStatus !== "booked") throw new BankMatchWrongAccountError(`Verification row ${id} belongs to an unbooked verification`);
      }
      const entriesSum = round2(entries.reduce((acc, e) => acc + e.amount, 0));
      const rowsSum = round2(rows.reduce((acc, r) => acc + r.amount, 0));
      if (entriesSum !== rowsSum) throw new BankMatchSumMismatchError(entriesSum, rowsSum);
      const entryIds = [...new Set(input.entryIds)];
      const rowIds = [...new Set(input.verificationRowIds)];
      let matchId: string;
      try {
        matchId = await db.transaction(async (tx) => {
          await lockBankAccount(tx, account.id);
          if (await repo.anyMatched(tx, entryIds, rowIds)) throw new BankMatchAlreadyMatchedError();
          const id = await repo.insertMatch(tx, { bankAccountId: account.id, kind: "manual", createdBy: userId }, entryIds, rowIds);
          await audit(tx, "bank_match", id, "matched", { entryIds, rowIds, sum: entriesSum }, userId);
          return id;
        });
      } catch (err) {
        if (isUniqueViolation(err)) throw new BankMatchAlreadyMatchedError();
        throw err;
      }
      return loadMatch(db, matchId);
    },

    // Undo frees the entries and rows again. The Startpunkt's matching also
    // withdraws its reconciliation mark — allowed only while no later mark
    // rests on it.
    async undoMatch(id: string, userId: string): Promise<MatchView> {
      await db.transaction(async (tx) => {
        const match = await repo.lockMatch(tx, id);
        if (!match) throw new BankMatchNotFoundError(id);
        if (match.undoneAt) throw new BankMatchAlreadyUndoneError(id);
        await lockBankAccount(tx, match.bankAccountId);
        if (match.kind === "opening") {
          const mark = await repo.findReconciliationByOpeningMatch(tx, id);
          if (mark) {
            if ((await repo.countLiveReconciliations(tx, match.bankAccountId, mark.id)) > 0) throw new BankOpeningNotAllowedError("later-mark");
            await repo.undoReconciliation(tx, mark.id, userId);
            await audit(tx, "bank_reconciliation", mark.id, "opening_undone", { bankAccountId: match.bankAccountId, throughDate: mark.throughDate }, userId);
          }
        }
        await repo.undoMatch(tx, id, userId);
        await audit(tx, "bank_match", id, "undone", { kind: match.kind }, userId);
      });
      return loadMatch(db, id);
    },

    // --- Startpunkt för avstämningen ---
    // The day the reconciliation starts: everything on the account up to it
    // (statement entries and ledger rows alike — the IB, what was booked
    // before the first statement) is linked by ONE opening matching without
    // the sum rule, and the mark records the statement balance the user read
    // off the bank. It must equal the ledger balance per the day; otherwise
    // the difference is booked first. Allowed only as the account's first
    // live mark — a later mark already rests on everything before it.
    async createOpening(bankAccountId: string, input: CreateBankOpeningInput, userId: string): Promise<{ reconciliation: ReconciliationView; match: MatchView }> {
      const account = await requireAccount(db, bankAccountId);
      const ledger = await requireLedgerAccount(db, account.ledgerAccount);
      const statementBalance = round2(input.statementBalance);
      const { mark, matchId } = await db.transaction(async (tx) => {
        await lockBankAccount(tx, account.id);
        if ((await repo.countLiveReconciliations(tx, account.id)) > 0) throw new BankOpeningNotAllowedError("mark-exists");
        const ledgerBalance = await repo.ledgerBalanceThrough(tx, ledger.id, input.date);
        if (round2(ledgerBalance) !== statementBalance) throw new BankOpeningBalanceMismatchError(statementBalance, ledgerBalance);
        const entries = await repo.unmatchedEntries(tx, account.id, { to: input.date });
        const rows = await repo.unmatchedRows(tx, ledger.id, { to: input.date });
        const matchId = await repo.insertMatch(
          tx,
          { bankAccountId: account.id, kind: "opening", createdBy: userId },
          entries.map((e) => e.id),
          rows.map((r) => r.id)
        );
        const mark = await repo.insertReconciliation(tx, {
          bankAccountId: account.id,
          throughDate: input.date,
          statementBalance: String(statementBalance),
          ledgerBalance: String(round2(ledgerBalance)),
          openingMatchId: matchId,
          createdBy: userId,
        });
        await audit(tx, "bank_reconciliation", mark.id, "opening_created", { bankAccountId: account.id, date: input.date, statementBalance, entries: entries.length, rows: rows.length, matchId }, userId);
        return { mark, matchId };
      });
      return { reconciliation: reconciliationView(mark), match: await loadMatch(db, matchId) };
    },

    async autoMatch(input: AutoMatchInput, userId: string): Promise<{ matched: number; ambiguous: number }> {
      const account = await requireAccount(db, input.bankAccountId);
      return autoMatchAccount(account, { from: input.from, to: input.to }, userId);
    },

    // --- Bokföra en post ---
    async bookEntry(entryId: string, input: BookBankEntryInput, userId: string) {
      const entry = await repo.findEntry(db, entryId);
      if (!entry) throw new BankStatementEntryNotFoundError(entryId);
      const account = await requireAccount(db, entry.bankAccountId);
      const ledger = await requireLedgerAccount(db, account.ledgerAccount);
      const rows = await resolveRows(db, input.rows);
      const onBank = round2(rows.filter((r) => r.accountId === ledger.id).reduce((acc, r) => acc + r.debit - r.credit, 0));
      if (onBank !== entry.amount) throw new BankEntryBookMismatchError(entry.amount, onBank);
      const { verificationId, matchId } = await db.transaction((tx) =>
        bookEntryInTx(tx, entry, account, ledger.id, { seriesId: input.seriesId ?? null, date: input.date ?? entry.bookingDate, description: input.description, rows }, userId)
      );
      const display = await repo.verificationDisplay(db, verificationId);
      return { verification: { id: verificationId, displayNumber: display?.displayNumber ?? "Utkast" }, match: await loadMatch(db, matchId) };
    },

    // One verification per entry, each in its own transaction; failures
    // reported per entry (the collective-invoicing pattern).
    async bookByRule(input: BookBankEntriesByRuleInput, userId: string) {
      const rules = await rulesList();
      const booked: { entryId: string; verificationId: string; displayNumber: string }[] = [];
      const failed: { entryId: string; error: { error: string; code?: string } }[] = [];
      for (const entryId of [...new Set(input.entryIds)]) {
        try {
          booked.push(await bookOneByRule(entryId, userId, rules));
        } catch (err) {
          failed.push({ entryId, error: reportableError(err, `Bokför enligt regel of entry ${entryId}`) });
        }
      }
      return { booked, failed };
    },

    // --- Bankregler ---
    async listRules(opts: { seed?: boolean } = {}): Promise<{ rows: BankRuleView[]; total: number }> {
      if (opts.seed !== false) await seedRulesOnce();
      const rows = await repo.listRules();
      const views = await Promise.all(rows.map((r) => ruleView(r)));
      return { rows: views, total: views.length };
    },

    async createRule(input: CreateBankRuleInput, userId: string): Promise<BankRuleView> {
      await requireRuleAccount(input.accountNumber);
      // Kostnadsställen och projekt: must exist and be pickable.
      const dimensions = await resolveDimensions(db, { costCenterId: input.costCenterId, projectId: input.projectId });
      const sortOrder = input.sortOrder ?? (await repo.maxRuleSortOrder()) + 10;
      const [row] = await repo.insertRules(db, [{ ...input, ...dimensions, vatCode: input.vatCode ?? null, description: input.description ?? null, sortOrder }]);
      await audit(db, "bank_rule", row!.id, "created", { textContains: row!.textContains, accountNumber: row!.accountNumber }, userId);
      return ruleView(row!);
    },

    async updateRule(id: string, input: UpdateBankRuleInput, userId: string): Promise<BankRuleView> {
      const existing = await repo.findRule(id);
      if (!existing) throw new BankRuleNotFoundError(id);
      if (input.accountNumber !== undefined) await requireRuleAccount(input.accountNumber);
      const values: Partial<BankRuleRow> = {};
      for (const key of ["textContains", "direction", "accountNumber", "vatCode", "description", "autoBook", "active", "sortOrder"] as const) {
        if (input[key] !== undefined) (values as Record<string, unknown>)[key] = input[key];
      }
      // Kostnadsställen och projekt: a new choice must be pickable, the kept one may stay.
      if (input.costCenterId !== undefined || input.projectId !== undefined) {
        const dimensions = await resolveDimensions(
          db,
          { costCenterId: input.costCenterId, projectId: input.projectId },
          { existing: { costCenterId: existing.costCenterId, projectId: existing.projectId } }
        );
        values.costCenterId = dimensions.costCenterId;
        values.projectId = dimensions.projectId;
      }
      const row = await repo.updateRule(id, values);
      if (!row) throw new BankRuleNotFoundError(id);
      await audit(db, "bank_rule", id, "updated", { before: existing, after: values }, userId);
      return ruleView(row);
    },

    async deleteRule(id: string, userId: string): Promise<void> {
      const existing = await repo.findRule(id);
      if (!existing) throw new BankRuleNotFoundError(id);
      await repo.deleteRule(id);
      await audit(db, "bank_rule", id, "deleted", { textContains: existing.textContains, accountNumber: existing.accountNumber }, userId);
    },

    // --- Avstämd t.o.m. ---
    async createReconciliation(input: CreateBankReconciliationInput, userId: string): Promise<ReconciliationView> {
      const account = await requireAccount(db, input.bankAccountId);
      const ledger = await requireLedgerAccount(db, account.ledgerAccount);
      const row = await db.transaction(async (tx) => {
        await lockBankAccount(tx, account.id);
        const unmatchedEntries = await repo.unmatchedEntriesCount(tx, account.id, input.throughDate);
        if (unmatchedEntries > 0) throw new BankReconciliationIncompleteError("unmatched-entries", { count: unmatchedEntries });
        const unmatchedRows = await repo.unmatchedRowsCount(tx, ledger.id, input.throughDate);
        if (unmatchedRows > 0) throw new BankReconciliationIncompleteError("unmatched-rows", { count: unmatchedRows });
        // The statement balance per the day: a balance dated on it, else the
        // latest earlier one when the bank reported nothing in between.
        const balance = await repo.latestStatementBalance(tx, account.id, input.throughDate);
        if (!balance || (balance.date < input.throughDate && (await repo.entriesBetween(tx, account.id, balance.date, input.throughDate)) > 0)) {
          throw new BankReconciliationIncompleteError("no-statement-balance");
        }
        // The summary's equation with nothing unmatched left: saldo bank −
        // saldo bok must be exactly what the matchings crossing the day
        // contribute (I transit) — a payment the bank booked on the 30th
        // and the ledger on the 1st is not a mismatch.
        const ledgerBalance = await repo.ledgerBalanceThrough(tx, ledger.id, input.throughDate);
        const inTransit = await repo.inTransitSum(tx, account.id, input.throughDate);
        if (round2(balance.balance - ledgerBalance) !== inTransit) {
          throw new BankReconciliationIncompleteError("balance-mismatch", { statementBalance: balance.balance, ledgerBalance, inTransit });
        }
        const inserted = await repo.insertReconciliation(tx, {
          bankAccountId: account.id,
          throughDate: input.throughDate,
          statementBalance: String(balance.balance),
          ledgerBalance: String(ledgerBalance),
          createdBy: userId,
        });
        await audit(tx, "bank_reconciliation", inserted.id, "created", { bankAccountId: account.id, throughDate: input.throughDate, balance: balance.balance }, userId);
        return inserted;
      });
      return reconciliationView(row);
    },
  };

  async function requireRuleAccount(number: string) {
    const account = await repo.findLedgerAccountByNumber(db, number);
    if (!account || !account.active) throw new BankRuleAccountMissingError(number);
  }

  async function ruleView(row: BankRuleRow): Promise<BankRuleView> {
    const [account, refs] = await Promise.all([
      repo.findLedgerAccountByNumber(db, row.accountNumber),
      loadDimensionRefs(db, { costCenterIds: [row.costCenterId], projectIds: [row.projectId] }),
    ]);
    return {
      id: row.id,
      textContains: row.textContains,
      direction: row.direction,
      accountNumber: row.accountNumber,
      accountName: account?.name ?? null,
      vatCode: row.vatCode,
      description: row.description,
      autoBook: row.autoBook,
      active: row.active,
      sortOrder: row.sortOrder,
      costCenterId: row.costCenterId,
      projectId: row.projectId,
      costCenter: dimensionRef(refs.costCenters, row.costCenterId),
      project: dimensionRef(refs.projects, row.projectId),
    };
  }

  function reconciliationView(row: BankReconciliationRow): ReconciliationView {
    return {
      id: row.id,
      throughDate: row.throughDate,
      statementBalance: round2(Number(row.statementBalance)),
      ledgerBalance: round2(Number(row.ledgerBalance)),
      opening: row.openingMatchId !== null,
      matchId: row.openingMatchId,
      createdAt: row.createdAt,
      createdBy: row.createdBy,
    };
  }

  return service;
}

export type BankReconciliationService = ReturnType<typeof createBankReconciliationService>;

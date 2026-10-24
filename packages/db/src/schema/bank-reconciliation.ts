import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { users } from "./auth";
import { bankFiles } from "./banking";
import { verificationRows } from "./economy";

// Bankavstämning (bokföringsgranskningen etapp 4, spec
// private/superpowers/specs/2026-10-24-bankavstamning-design.md). The
// statement side of the bank account (camt.053 / CSV) and its matching
// against the verification rows on the account's ledger account. The files
// themselves live in bank_files (insert-only, NV001); everything here is
// derived from them except the matches and the reconciliation marks, which
// are append-only in their own way (a match is undone by a stamp, never
// deleted; a reconciliation is never changed).

export const bankMatchKindEnum = pgEnum("bank_match_kind", ["auto", "manual", "created"]);
export const bankRuleDirectionEnum = pgEnum("bank_rule_direction", ["in", "out", "both"]);

// How a CSV export from the internet bank maps onto a statement entry
// (column = header name). Saved per bank account.
export interface BankCsvMapping {
  delimiter?: ";" | "," | "\t";
  dateColumn: string;
  amountColumn: string;
  textColumn: string;
  balanceColumn?: string;
  valueDateColumn?: string;
  referenceColumn?: string;
  decimalComma?: boolean;
  skipRows?: number;
}

// What the file said beyond the columns — kept for display and for the
// reference matching (the camt.054 side carries the same AcctSvcrRef /
// EndToEndId in its TxDtls).
export interface BankStatementEntryDetails {
  ntryRef?: string | null;
  acctSvcrRef?: string | null;
  bankTransactionCode?: string | null;
  additionalInfo?: string | null;
  transactions: {
    acctSvcrRef: string | null;
    endToEndId: string | null;
    amount: number | null;
    counterparty: string | null;
    references: { type: string; value: string }[];
    additionalInfo: string | null;
  }[];
  // CSV: the balance column's value on the row, when mapped.
  balance?: number | null;
}

// Bankkonton (register under Ekonomi). identifier = IBAN or BBAN as the
// statement's Acct/Id writes it, normalised (upper case, no spaces/hyphens);
// ledger_account is an account NUMBER (as the posting_* settings), never an
// FK, so the chart of accounts can be re-seeded freely.
export const bankAccounts = pgTable(
  "bank_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: varchar("name", { length: 100 }).notNull(),
    identifier: varchar("identifier", { length: 40 }).notNull().unique(),
    ledgerAccount: varchar("ledger_account", { length: 4 }).notNull(),
    currency: varchar("currency", { length: 3 }).notNull().default("SEK"),
    csvMapping: jsonb("csv_mapping").$type<BankCsvMapping>(),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [check("bank_accounts_ledger_account_four_digits", sql`${table.ledgerAccount} ~ '^[0-9]{4}$'`)]
);

// One Stmt of a camt.053 file (or one CSV file) for one bank account: the
// period and the balances the bank reported. Balances are null for a CSV
// without a balance column.
export const bankStatements = pgTable(
  "bank_statements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    bankAccountId: uuid("bank_account_id")
      .notNull()
      .references(() => bankAccounts.id, { onDelete: "restrict" }),
    bankFileId: uuid("bank_file_id")
      .notNull()
      .references(() => bankFiles.id, { onDelete: "restrict" }),
    statementId: varchar("statement_id", { length: 100 }),
    fromDate: date("from_date"),
    toDate: date("to_date"),
    openingBalance: numeric("opening_balance", { precision: 14, scale: 2 }),
    closingBalance: numeric("closing_balance", { precision: 14, scale: 2 }),
    // The day the closing balance is per (Bal/Dt) — the summary and the
    // reconciliation mark read the statement balance by this date.
    closingBalanceDate: date("closing_balance_date"),
    entryCount: integer("entry_count").notNull().default(0),
    duplicateCount: integer("duplicate_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_bank_statements_account").on(table.bankAccountId),
    index("idx_bank_statements_file").on(table.bankFileId),
    check("bank_statements_closing_balance_date", sql`(${table.closingBalance} IS NULL) OR (${table.closingBalanceDate} IS NOT NULL)`),
  ]
);

// One row per Ntry of the statement (a collective entry with several TxDtls
// stays ONE row with the details listed) or per CSV row. amount is SIGNED in
// the account's currency: + = money in. dedupe_key is unique, so the same
// file — or an overlapping export — skips what is already read, never fails.
export const bankStatementEntries = pgTable(
  "bank_statement_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    bankAccountId: uuid("bank_account_id")
      .notNull()
      .references(() => bankAccounts.id, { onDelete: "restrict" }),
    bankStatementId: uuid("bank_statement_id")
      .notNull()
      .references(() => bankStatements.id, { onDelete: "restrict" }),
    bankFileId: uuid("bank_file_id")
      .notNull()
      .references(() => bankFiles.id, { onDelete: "restrict" }),
    dedupeKey: varchar("dedupe_key", { length: 160 }).notNull().unique(),
    bookingDate: date("booking_date").notNull(),
    valueDate: date("value_date"),
    amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
    currency: varchar("currency", { length: 3 }).notNull(),
    text: varchar("text", { length: 255 }).notNull(),
    reference: varchar("reference", { length: 140 }),
    counterparty: varchar("counterparty", { length: 140 }),
    details: jsonb("details").$type<BankStatementEntryDetails>().notNull(),
    reversal: boolean("reversal").notNull().default(false),
    position: integer("position").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("bank_statement_entries_amount_nonzero", sql`${table.amount} <> 0`),
    index("idx_bank_statement_entries_account_date").on(table.bankAccountId, table.bookingDate),
    index("idx_bank_statement_entries_statement").on(table.bankStatementId),
  ]
);

// A matching: Σ statement entries = Σ verification rows (debit − credit) on
// the account's ledger account. Undone by a stamp; the link rows go
// inactive in the same transaction, and the partial unique indexes on them
// are THE "one live matching per entry/row" guard (the service checks first,
// the index decides under concurrency).
export const bankMatches = pgTable(
  "bank_matches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    bankAccountId: uuid("bank_account_id")
      .notNull()
      .references(() => bankAccounts.id, { onDelete: "restrict" }),
    kind: bankMatchKindEnum("kind").notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    undoneAt: timestamp("undone_at", { withTimezone: true }),
    undoneBy: uuid("undone_by").references(() => users.id, { onDelete: "set null" }),
  },
  (table) => [index("idx_bank_matches_account").on(table.bankAccountId)]
);

export const bankMatchEntries = pgTable(
  "bank_match_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    matchId: uuid("match_id")
      .notNull()
      .references(() => bankMatches.id, { onDelete: "restrict" }),
    entryId: uuid("entry_id")
      .notNull()
      .references(() => bankStatementEntries.id, { onDelete: "restrict" }),
    // Mirrors the match's undone_at: false once the match is undone.
    active: boolean("active").notNull().default(true),
  },
  (table) => [
    uniqueIndex("bank_match_entries_entry_live").on(table.entryId).where(sql`${table.active}`),
    index("idx_bank_match_entries_match").on(table.matchId),
  ]
);

export const bankMatchRows = pgTable(
  "bank_match_rows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    matchId: uuid("match_id")
      .notNull()
      .references(() => bankMatches.id, { onDelete: "restrict" }),
    verificationRowId: uuid("verification_row_id")
      .notNull()
      .references(() => verificationRows.id, { onDelete: "restrict" }),
    active: boolean("active").notNull().default(true),
  },
  (table) => [
    uniqueIndex("bank_match_rows_row_live").on(table.verificationRowId).where(sql`${table.active}`),
    index("idx_bank_match_rows_match").on(table.matchId),
  ]
);

// Bankregler: "the text contains X" → counter account (+ optional domestic
// momskod), for Bokför and — when auto_book — booked at import when the rule
// is the only one that matches. Account numbers, not FKs (as the templates).
export const bankRules = pgTable(
  "bank_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    textContains: varchar("text_contains", { length: 100 }).notNull(),
    direction: bankRuleDirectionEnum("direction").notNull().default("both"),
    accountNumber: varchar("account_number", { length: 4 }).notNull(),
    vatCode: varchar("vat_code", { length: 10 }),
    description: varchar("description", { length: 255 }),
    autoBook: boolean("auto_book").notNull().default(false),
    active: boolean("active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [check("bank_rules_account_number_four_digits", sql`${table.accountNumber} ~ '^[0-9]{4}$'`)]
);

// Avstämd t.o.m. — append-only: a later mark is a new row, and a change to
// the books on or before a marked day is a WARNING on the page, never a
// rewrite of the mark.
export const bankReconciliations = pgTable(
  "bank_reconciliations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    bankAccountId: uuid("bank_account_id")
      .notNull()
      .references(() => bankAccounts.id, { onDelete: "restrict" }),
    throughDate: date("through_date").notNull(),
    statementBalance: numeric("statement_balance", { precision: 14, scale: 2 }).notNull(),
    ledgerBalance: numeric("ledger_balance", { precision: 14, scale: 2 }).notNull(),
    note: text("note"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("idx_bank_reconciliations_account_date").on(table.bankAccountId, table.throughDate)]
);

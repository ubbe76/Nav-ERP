import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  customType,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { users } from "./auth";
import { suppliers, supplierInvoices } from "./purchase";

// No built-in bytea helper in drizzle-orm/pg-core (same helper as purchase.ts).
const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });

// Bankfiler (ISO 20022). Spec: docs/superpowers/specs/2026-10-09-bankfiler-design.md §1.

export const paymentBatchStatusEnum = pgEnum("payment_batch_status", ["draft", "exported", "confirmed", "cancelled"]);
export const paymentBatchItemStatusEnum = pgEnum("payment_batch_item_status", [
  "pending",
  "exported",
  "confirmed",
  "rejected",
  "returned",
  "cancelled",
]);
export const bankFileDirectionEnum = pgEnum("bank_file_direction", ["outgoing", "incoming"]);
export const bankEntryDirectionEnum = pgEnum("bank_entry_direction", ["credit", "debit"]);
export const bankEntryDedupeSourceEnum = pgEnum("bank_entry_dedupe_source", [
  "tx_acct_svcr_ref",
  "clr_sys_ref",
  "entry_ref",
  "content_hash",
]);

// What the exported file actually said about the creditor (sanitized values),
// written at export — the draft reads the supplier/invoice live instead.
// Valuta steg 2 adds the payment's kind and currency (every export since
// 0144) and, for a payment abroad, what the file said about the payee's
// address and bank and whether it was reported to Skatteverket (KU81).
export interface CreditorSnapshot {
  method: "bankgiro" | "plusgiro" | "bank_account" | "iban" | "foreign_account";
  account: string;
  clearing: string | null;
  bic: string | null;
  name: string;
  postalCode: string | null;
  city: string | null;
  referenceKind: "ocr" | "message";
  reference: string;
  kind?: "domestic" | "sepa" | "international";
  currency?: string;
  street?: string | null;
  country?: string;
  clearingSystem?: string | null;
  bankName?: string | null;
  chargeBearer?: "SLEV" | "SHAR" | "DEBT";
  // KU81: the code sent, and the SEK value the threshold was judged on (null
  // = no rate could be found, so the payment was reported to be safe).
  regulatoryReporting?: { code: string; amountSek: number | null; rate: number | null; rateDate: string | null } | null;
}

// camt.054 TxDtls/AmtDtls/TxAmt/CcyXchg as the bank wrote it (display only —
// the booking takes the amounts, never the rate).
export interface BankEntryCurrencyExchange {
  sourceCurrency: string;
  targetCurrency: string | null;
  unitCurrency: string | null;
  rate: string;
}

export interface BankEntryReference {
  type: "SCOR" | "CINV" | "CREN" | "USTRD" | "ADDTL";
  value: string;
  amount: number | null;
}

// Betalningsomgång. Never deleted — a mistaken one is cancelled.
export const paymentBatches = pgTable(
  "payment_batches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // BO-7 — number series "payment_batch"; also the pain.001 MsgId.
    batchNumber: varchar("batch_number", { length: 20 }).notNull().unique(),
    status: paymentBatchStatusEnum("status").notNull().default("draft"),
    // posting_bank snapshotted at creation: every UTB from the batch books
    // against it.
    bankAccountNumber: varchar("bank_account_number", { length: 4 }).notNull(),
    bankProfile: varchar("bank_profile", { length: 20 }),
    note: text("note"),
    exportedAt: timestamp("exported_at", { withTimezone: true }),
    exportedBy: uuid("exported_by").references(() => users.id, { onDelete: "set null" }),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelledBy: uuid("cancelled_by").references(() => users.id, { onDelete: "set null" }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("idx_payment_batches_status").on(table.status)]
);

export const paymentBatchItems = pgTable(
  "payment_batch_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => paymentBatches.id, { onDelete: "restrict" }),
    seq: integer("seq").notNull(),
    // `${batch_number}-${seq}` — also the InstrId. Unique forever, so the
    // bank's 90-day duplicate control never stops a new batch.
    endToEndId: varchar("end_to_end_id", { length: 35 }).notNull().unique(),
    supplierInvoiceId: uuid("supplier_invoice_id")
      .notNull()
      .references(() => supplierInvoices.id, { onDelete: "restrict" }),
    supplierId: uuid("supplier_id")
      .notNull()
      .references(() => suppliers.id, { onDelete: "restrict" }),
    amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
    // The invoice's currency (valuta steg 2) — the amount is in it, and it is
    // the file's InstdAmt Ccy.
    currency: varchar("currency", { length: 3 }).notNull().default("SEK"),
    executionDate: date("execution_date").notNull(),
    status: paymentBatchItemStatusEnum("status").notNull().default("pending"),
    creditorSnapshot: jsonb("creditor_snapshot").$type<CreditorSnapshot>(),
    rejectedReason: varchar("rejected_reason", { length: 255 }),
    // The bank's return (CRDT + RvslInd) that reversed this item's UTB.
    returnBankFileEntryId: uuid("return_bank_file_entry_id").references((): AnyPgColumn => bankFileEntries.id, {
      onDelete: "restrict",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("payment_batch_items_seq_unique").on(table.batchId, table.seq),
    // THE reservation: one live (pending/exported) batch row per invoice.
    uniqueIndex("payment_batch_items_invoice_live")
      .on(table.supplierInvoiceId)
      .where(sql`${table.status} in ('pending', 'exported')`),
    uniqueIndex("payment_batch_items_return_entry_unique").on(table.returnBankFileEntryId),
    check("payment_batch_items_amount_positive", sql`${table.amount} > 0`),
    index("idx_payment_batch_items_batch").on(table.batchId),
    index("idx_payment_batch_items_invoice").on(table.supplierInvoiceId),
  ]
);

// Räkenskapsinformation (BFL 7 kap): our pain.001 and the bank's camt.054,
// insert-only — the trigger in 0107 refuses UPDATE/DELETE (NV001) except the
// FK null-out of uploaded_by. Listings never select `data`.
export const bankFiles = pgTable(
  "bank_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    direction: bankFileDirectionEnum("direction").notNull(),
    messageType: varchar("message_type", { length: 30 }).notNull(),
    paymentBatchId: uuid("payment_batch_id").references(() => paymentBatches.id, { onDelete: "restrict" }),
    filename: varchar("filename", { length: 255 }).notNull(),
    contentType: varchar("content_type", { length: 100 }).notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: varchar("sha256", { length: 64 }).notNull(),
    data: bytea("data").notNull(),
    bankMessageId: varchar("bank_message_id", { length: 35 }),
    bankCreatedAt: timestamp("bank_created_at", { withTimezone: true }),
    entryCount: integer("entry_count").notNull().default(0),
    skippedDuplicates: integer("skipped_duplicates").notNull().default(0),
    warnings: jsonb("warnings").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    uploadedBy: uuid("uploaded_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("bank_files_batch_direction", sql`(${table.direction} = 'outgoing') = (${table.paymentBatchId} is not null)`),
    uniqueIndex("bank_files_one_per_batch").on(table.paymentBatchId).where(sql`${table.direction} = 'outgoing'`),
    uniqueIndex("bank_files_incoming_sha256").on(table.sha256).where(sql`${table.direction} = 'incoming'`),
  ]
);

// One row per underlying transaction (TxDtls). dedupe_key (§3.5) is unique,
// so an overlapping file skips the entries already read. Whether an entry is
// booked is derived from the payment side (customer/supplier_payments link),
// never stored here; only `ignored_*` may change after insert.
export const bankFileEntries = pgTable(
  "bank_file_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    bankFileId: uuid("bank_file_id")
      .notNull()
      .references(() => bankFiles.id, { onDelete: "restrict" }),
    dedupeKey: varchar("dedupe_key", { length: 120 }).notNull().unique(),
    dedupeSource: bankEntryDedupeSourceEnum("dedupe_source").notNull(),
    direction: bankEntryDirectionEnum("direction").notNull(),
    reversal: boolean("reversal").notNull().default(false),
    account: varchar("account", { length: 40 }).notNull(),
    amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
    currency: varchar("currency", { length: 3 }).notNull(),
    bookingDate: date("booking_date").notNull(),
    valueDate: date("value_date"),
    endToEndId: varchar("end_to_end_id", { length: 35 }),
    msgId: varchar("msg_id", { length: 35 }),
    pmtInfId: varchar("pmt_inf_id", { length: 35 }),
    counterpartyName: varchar("counterparty_name", { length: 140 }),
    // "references" is a reserved word in SQL, hence the name.
    remittance: jsonb("remittance").$type<BankEntryReference[]>().notNull(),
    returnReason: varchar("return_reason", { length: 10 }),
    // Valuta steg 2: the instructed amount when it is in another currency
    // than the entry (InstdAmt — a payment in EUR debited to the SEK
    // account), the bank's exchange details, and the charges the bank says
    // are INCLUDED in the entry amount (account currency).
    instructedAmount: numeric("instructed_amount", { precision: 14, scale: 2 }),
    instructedCurrency: varchar("instructed_currency", { length: 3 }),
    currencyExchange: jsonb("currency_exchange").$type<BankEntryCurrencyExchange>(),
    chargesAmount: numeric("charges_amount", { precision: 14, scale: 2 }),
    position: integer("position").notNull(),
    ignoredAt: timestamp("ignored_at", { withTimezone: true }),
    ignoredBy: uuid("ignored_by").references(() => users.id, { onDelete: "set null" }),
    ignoreReason: varchar("ignore_reason", { length: 255 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("bank_file_entries_amount_positive", sql`${table.amount} > 0`),
    check("bank_file_entries_instructed_pair", sql`(${table.instructedAmount} is null) = (${table.instructedCurrency} is null)`),
    check("bank_file_entries_charges_non_negative", sql`${table.chargesAmount} is null or ${table.chargesAmount} >= 0`),
    index("idx_bank_file_entries_file").on(table.bankFileId),
    index("idx_bank_file_entries_e2e").on(table.endToEndId),
    index("idx_bank_file_entries_booking_date").on(table.bookingDate),
  ]
);

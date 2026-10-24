import { and, asc, count, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  bankFileEntries,
  bankFiles,
  customerPayments,
  paymentBatches,
  paymentBatchItems,
  supplierInvoices,
  type Db,
  type Tx,
} from "@navet/db";
import { ilikePattern, type ListBankFilesQuery } from "@navet/shared";

// Everything but the bytes: listings never select `data`.
const fileMeta = {
  id: bankFiles.id,
  direction: bankFiles.direction,
  messageType: bankFiles.messageType,
  filename: bankFiles.filename,
  sizeBytes: bankFiles.sizeBytes,
  sha256: bankFiles.sha256,
  bankMessageId: bankFiles.bankMessageId,
  bankCreatedAt: bankFiles.bankCreatedAt,
  entryCount: bankFiles.entryCount,
  skippedDuplicates: bankFiles.skippedDuplicates,
  warnings: bankFiles.warnings,
  createdAt: bankFiles.createdAt,
};

// The fragments below name their table explicitly ("bank_file_entries"."id"),
// never through an interpolated drizzle column: drizzle renders a column of a
// single-table select UNQUALIFIED in the select list, and an unqualified "id"
// inside a correlated subquery binds to the subquery's own table — the
// "booked" check would silently compare a payment's id with itself.
const E = sql.raw(`"bank_file_entries"`);

// Outgoing entries: debits, and credits with RvslInd (returns of our payments).
const outgoingEntry = sql`(${E}."direction" = 'debit' OR (${E}."direction" = 'credit' AND ${E}."reversal"))`;
const incomingEntry = sql`(${E}."direction" = 'credit' AND NOT ${E}."reversal")`;

// An outgoing entry is handled (spec §1.7) once a supplier payment carries it
// (live, or cancelled by a return), or a batch row records it as its return.
// A debit is also handled when its row was settled by a return without ever
// being confirmed from it (spec §4.5: the row is rejected — or the manual UTB
// cancelled — and the money came back, so the net on the bank is zero);
// otherwise it would look bookable for ever.
const outgoingHandledSql = sql<boolean>`(
  EXISTS (SELECT 1 FROM supplier_payments sp WHERE sp.bank_file_entry_id = ${E}."id")
  OR EXISTS (SELECT 1 FROM payment_batch_items i WHERE i.return_bank_file_entry_id = ${E}."id")
  OR (${E}."direction" = 'debit' AND NOT ${E}."reversal" AND EXISTS (
    SELECT 1 FROM payment_batch_items i
    WHERE i.end_to_end_id = ${E}."end_to_end_id" AND i.return_bank_file_entry_id IS NOT NULL
  ))
)`;
// An incoming entry is booked while a LIVE customer payment carries it; a
// cancelled BET frees it again (spec §1.7, "raderna är facit").
const incomingBookedSql = sql<boolean>`EXISTS (
  SELECT 1 FROM customer_payments cp WHERE cp.bank_file_entry_id = ${E}."id" AND cp.cancelled_at IS NULL
)`;

export function createBankFileRepository(db: Db) {
  return {
    async findIncomingBySha(sha256: string) {
      const [row] = await db.select(fileMeta).from(bankFiles).where(and(eq(bankFiles.sha256, sha256), eq(bankFiles.direction, "incoming")));
      return row ?? null;
    },

    // Incoming files only: the outgoing pain.001 lives under its batch.
    async findFile(id: string) {
      const [row] = await db.select(fileMeta).from(bankFiles).where(and(eq(bankFiles.id, id), eq(bankFiles.direction, "incoming")));
      return row ?? null;
    },

    async findFileData(id: string) {
      const [row] = await db
        .select({ filename: bankFiles.filename, contentType: bankFiles.contentType, data: bankFiles.data })
        .from(bankFiles)
        .where(and(eq(bankFiles.id, id), eq(bankFiles.direction, "incoming")));
      return row ?? null;
    },

    // The entries of `keys` some earlier file already brought in, with the
    // file each one was first read from (spec §6.1's "fil camt054_…xml").
    async existingEntries(tx: Tx, keys: string[]) {
      if (keys.length === 0) return [];
      return tx
        .select({ key: bankFileEntries.dedupeKey, bankFileId: bankFileEntries.bankFileId, filename: bankFiles.filename })
        .from(bankFileEntries)
        .innerJoin(bankFiles, eq(bankFiles.id, bankFileEntries.bankFileId))
        .where(inArray(bankFileEntries.dedupeKey, keys))
        .orderBy(asc(bankFiles.createdAt), asc(bankFileEntries.position));
    },

    // The notification accounts (Ntfctn/Acct) the file's entries were read from.
    async fileAccounts(fileId: string): Promise<string[]> {
      const rows = await db
        .selectDistinct({ account: bankFileEntries.account })
        .from(bankFileEntries)
        .where(eq(bankFileEntries.bankFileId, fileId))
        .orderBy(asc(bankFileEntries.account));
      return rows.map((r) => r.account);
    },

    async insertFile(tx: Tx, values: typeof bankFiles.$inferInsert) {
      const [row] = await tx.insert(bankFiles).values(values).returning(fileMeta);
      return row!;
    },

    // ON CONFLICT DO NOTHING: an entry a concurrent upload just wrote is
    // skipped, never duplicated (spec §6.1).
    async insertEntries(tx: Tx, rows: (typeof bankFileEntries.$inferInsert)[]) {
      if (rows.length === 0) return 0;
      const inserted = await tx.insert(bankFileEntries).values(rows).onConflictDoNothing({ target: bankFileEntries.dedupeKey }).returning({ id: bankFileEntries.id });
      return inserted.length;
    },

    async list(query: ListBankFilesQuery) {
      const conditions: SQL[] = [eq(bankFiles.direction, "incoming")];
      if (query.search) conditions.push(sql`${bankFiles.filename} ILIKE ${ilikePattern(query.search)}`);
      if (query.direction) {
        conditions.push(
          sql`EXISTS (SELECT 1 FROM bank_file_entries e WHERE e.bank_file_id = "bank_files"."id" AND ${
            query.direction === "credit" ? sql`e.direction = 'credit' AND NOT e.reversal` : sql`(e.direction = 'debit' OR e.reversal)`
          })`
        );
      }
      const where = and(...conditions);
      const which = query.direction === "debit" ? outgoingEntry : query.direction === "credit" ? incomingEntry : sql`true`;
      const handled =
        query.direction === "debit" ? outgoingHandledSql : query.direction === "credit" ? incomingBookedSql : sql`(${incomingBookedSql} OR ${outgoingHandledSql})`;
      const [rows, totals] = await Promise.all([
        db
          .select({
            ...fileMeta,
            entries: sql<number>`(SELECT COUNT(*) FROM bank_file_entries WHERE bank_file_entries.bank_file_id = "bank_files"."id" AND ${which})`,
            booked: sql<number>`(SELECT COUNT(*) FROM bank_file_entries WHERE bank_file_entries.bank_file_id = "bank_files"."id" AND ${which} AND ${handled})`,
            ignored: sql<number>`(SELECT COUNT(*) FROM bank_file_entries WHERE bank_file_entries.bank_file_id = "bank_files"."id" AND ${which} AND bank_file_entries.ignored_at IS NOT NULL AND NOT ${handled})`,
          })
          .from(bankFiles)
          .where(where)
          .orderBy(desc(bankFiles.createdAt))
          .limit(query.limit)
          .offset(query.offset),
        db.select({ total: count() }).from(bankFiles).where(where),
      ]);
      return {
        rows: rows.map((r) => {
          const entries = Number(r.entries);
          const booked = Number(r.booked);
          const ignored = Number(r.ignored);
          return { ...r, entries, booked, ignored, unhandled: entries - booked - ignored };
        }),
        total: totals[0]!.total,
      };
    },

    async incomingEntries(fileId: string) {
      return db
        .select({ entry: bankFileEntries, paymentId: customerPayments.id, paymentNumber: customerPayments.paymentNumber })
        .from(bankFileEntries)
        .leftJoin(customerPayments, and(eq(customerPayments.bankFileEntryId, bankFileEntries.id), isNull(customerPayments.cancelledAt)))
        .where(and(eq(bankFileEntries.bankFileId, fileId), incomingEntry))
        .orderBy(asc(bankFileEntries.position));
    },

    async outgoingEntries(fileId: string) {
      const item = alias(paymentBatchItems, "matched_item");
      return db
        .select({
          entry: bankFileEntries,
          handled: outgoingHandledSql,
          item: { id: item.id, batchId: item.batchId, endToEndId: item.endToEndId, status: item.status, amount: item.amount, currency: item.currency },
          // The matched row's live UTB, however it was booked (by hand, from
          // another file) — "Redan bekräftad … visas med UTB-länk" (§6.2).
          // Explicitly qualified: see the note on E above.
          itemPaymentId: sql<string | null>`(SELECT sp.id FROM supplier_payments sp WHERE sp.payment_batch_item_id = "matched_item"."id" AND sp.cancelled_at IS NULL)`,
          itemPaymentNumber: sql<string | null>`(SELECT sp.payment_number FROM supplier_payments sp WHERE sp.payment_batch_item_id = "matched_item"."id" AND sp.cancelled_at IS NULL)`,
          batchNumber: paymentBatches.batchNumber,
          registrationNumber: supplierInvoices.registrationNumber,
          // The UTB this entry confirmed. At most one: a handled entry is
          // never booked again, even after a return cancelled its UTB — the
          // ORDER BY/LIMIT only keep the subquery scalar.
          paymentId: sql<string | null>`(SELECT sp.id FROM supplier_payments sp WHERE sp.bank_file_entry_id = ${E}."id" ORDER BY sp.created_at DESC LIMIT 1)`,
          paymentNumber: sql<string | null>`(SELECT sp.payment_number FROM supplier_payments sp WHERE sp.bank_file_entry_id = ${E}."id" ORDER BY sp.created_at DESC LIMIT 1)`,
        })
        .from(bankFileEntries)
        .leftJoin(item, eq(item.endToEndId, bankFileEntries.endToEndId))
        .leftJoin(paymentBatches, eq(paymentBatches.id, item.batchId))
        .leftJoin(supplierInvoices, eq(supplierInvoices.id, item.supplierInvoiceId))
        .where(and(eq(bankFileEntries.bankFileId, fileId), outgoingEntry))
        .orderBy(asc(bankFileEntries.position));
    },

    // First in every booking's lock order: entry → batch → row → invoices.
    async lockEntry(tx: Tx, id: string) {
      const [row] = await tx.select().from(bankFileEntries).where(eq(bankFileEntries.id, id)).for("update");
      return row ?? null;
    },

    async incomingBooked(tx: Tx, entryId: string): Promise<boolean> {
      const [row] = await tx.select({ booked: incomingBookedSql }).from(bankFileEntries).where(eq(bankFileEntries.id, entryId));
      return Boolean(row?.booked);
    },

    async outgoingHandled(tx: Tx, entryId: string): Promise<boolean> {
      const [row] = await tx.select({ handled: outgoingHandledSql }).from(bankFileEntries).where(eq(bankFileEntries.id, entryId));
      return Boolean(row?.handled);
    },

    async setIgnored(tx: Tx, entryId: string, values: { ignoredAt: Date | null; ignoredBy: string | null; ignoreReason: string | null }) {
      await tx.update(bankFileEntries).set(values).where(eq(bankFileEntries.id, entryId));
    },
  };
}

export type BankFileRepository = ReturnType<typeof createBankFileRepository>;

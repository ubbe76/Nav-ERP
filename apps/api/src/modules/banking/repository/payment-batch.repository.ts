import { and, asc, count, desc, eq, ilike, inArray, isNull, min, or, sql, type SQL } from "drizzle-orm";
import {
  bankFiles,
  paymentBatchItems,
  paymentBatches,
  suppliers,
  supplierInvoices,
  supplierPayments,
  type Db,
  type Tx,
} from "@navet/db";
import { ilikePattern, type ListPaymentBatchesQuery } from "@navet/shared";

export type Executor = Db | Tx;

// Row view for the card: the item, the live invoice/supplier fields (the
// draft shows them live; the export snapshots them) and the live payment.
export async function listItems(executor: Executor, batchId: string) {
  return executor
    .select({
      item: paymentBatchItems,
      registrationNumber: supplierInvoices.registrationNumber,
      invoiceNumber: supplierInvoices.invoiceNumber,
      invoiceStatus: supplierInvoices.status,
      dueDate: supplierInvoices.dueDate,
      paymentReferenceKind: supplierInvoices.paymentReferenceKind,
      paymentReference: supplierInvoices.paymentReference,
      supplier: {
        name: suppliers.name,
        postalCode: suppliers.postalCode,
        city: suppliers.city,
        paymentMethod: suppliers.paymentMethod,
        bankgiro: suppliers.bankgiro,
        plusgiro: suppliers.plusgiro,
        bankClearing: suppliers.bankClearing,
        bankAccountNumber: suppliers.bankAccountNumber,
        iban: suppliers.iban,
        bic: suppliers.bic,
      },
      paymentId: supplierPayments.id,
      paymentNumber: supplierPayments.paymentNumber,
      paymentCancelledAt: supplierPayments.cancelledAt,
    })
    .from(paymentBatchItems)
    .innerJoin(supplierInvoices, eq(supplierInvoices.id, paymentBatchItems.supplierInvoiceId))
    .innerJoin(suppliers, eq(suppliers.id, paymentBatchItems.supplierId))
    // The batch's own payment — the live one, else the latest cancelled one
    // (a returned row still shows which UTB it was).
    .leftJoin(
      supplierPayments,
      and(
        eq(supplierPayments.paymentBatchItemId, paymentBatchItems.id),
        sql`${supplierPayments.id} = (SELECT sp.id FROM supplier_payments sp WHERE sp.payment_batch_item_id = ${paymentBatchItems.id} ORDER BY (sp.cancelled_at IS NULL) DESC, sp.created_at DESC LIMIT 1)`
      )
    )
    .where(eq(paymentBatchItems.batchId, batchId))
    .orderBy(asc(paymentBatchItems.seq));
}
export type BatchItemRow = Awaited<ReturnType<typeof listItems>>[number];

// The invoices a batch is created from / exported for, row-locked in sorted
// order (the payment registration's deadlock-free order), with what decides
// whether they can be paid.
export async function lockInvoices(tx: Tx, invoiceIds: string[], strength: "update" | "share") {
  const ids = [...new Set(invoiceIds)].sort();
  if (ids.length === 0) return [];
  return tx
    .select({
      id: supplierInvoices.id,
      registrationNumber: supplierInvoices.registrationNumber,
      invoiceNumber: supplierInvoices.invoiceNumber,
      status: supplierInvoices.status,
      currency: supplierInvoices.currency,
      dueDate: supplierInvoices.dueDate,
      supplierId: supplierInvoices.supplierId,
      paymentMethod: suppliers.paymentMethod,
      iban: suppliers.iban,
    })
    .from(supplierInvoices)
    .innerJoin(suppliers, eq(suppliers.id, supplierInvoices.supplierId))
    .where(inArray(supplierInvoices.id, ids))
    .orderBy(asc(supplierInvoices.id))
    .for(strength, { of: supplierInvoices });
}

export async function liveReservations(tx: Tx, invoiceIds: string[]) {
  if (invoiceIds.length === 0) return new Map<string, string>();
  const rows = await tx
    .select({ invoiceId: paymentBatchItems.supplierInvoiceId, batchNumber: paymentBatches.batchNumber })
    .from(paymentBatchItems)
    .innerJoin(paymentBatches, eq(paymentBatches.id, paymentBatchItems.batchId))
    .where(and(inArray(paymentBatchItems.supplierInvoiceId, invoiceIds), inArray(paymentBatchItems.status, ["pending", "exported"])));
  return new Map(rows.map((row) => [row.invoiceId, row.batchNumber]));
}

export async function lockBatch(tx: Tx, id: string) {
  const [row] = await tx.select().from(paymentBatches).where(eq(paymentBatches.id, id)).for("update");
  return row ?? null;
}

export async function lockItem(tx: Tx, id: string) {
  const [row] = await tx.select().from(paymentBatchItems).where(eq(paymentBatchItems.id, id)).for("update");
  return row ?? null;
}

export async function findItem(executor: Executor, id: string) {
  const [row] = await executor.select().from(paymentBatchItems).where(eq(paymentBatchItems.id, id));
  return row ?? null;
}

export async function findItemByEndToEndId(executor: Executor, endToEndId: string) {
  const [row] = await executor.select().from(paymentBatchItems).where(eq(paymentBatchItems.endToEndId, endToEndId));
  return row ?? null;
}

export async function livePaymentForItem(tx: Tx, itemId: string) {
  const [row] = await tx
    .select({ id: supplierPayments.id, paymentDate: supplierPayments.paymentDate })
    .from(supplierPayments)
    .where(and(eq(supplierPayments.paymentBatchItemId, itemId), isNull(supplierPayments.cancelledAt)));
  return row ?? null;
}

export async function nextSeq(tx: Tx, batchId: string): Promise<number> {
  const [row] = await tx.select({ max: sql<number>`COALESCE(MAX(${paymentBatchItems.seq}), 0)` }).from(paymentBatchItems).where(eq(paymentBatchItems.batchId, batchId));
  return Number(row!.max) + 1;
}

// exported → confirmed once no row waits for the bank. True when this call
// flipped it (the caller logs `confirmed` in the same transaction).
export async function recomputeBatchStatus(tx: Tx, batchId: string, now: Date): Promise<boolean> {
  const flipped = await tx
    .update(paymentBatches)
    .set({ status: "confirmed", confirmedAt: now, updatedAt: now })
    .where(
      and(
        eq(paymentBatches.id, batchId),
        eq(paymentBatches.status, "exported"),
        sql`NOT EXISTS (SELECT 1 FROM payment_batch_items i WHERE i.batch_id = ${batchId} AND i.status IN ('pending', 'exported'))`
      )
    )
    .returning({ id: paymentBatches.id });
  return flipped.length > 0;
}

export function createPaymentBatchRepository(db: Db) {
  return {
    listItems,
    lockInvoices,
    liveReservations,
    lockBatch,
    lockItem,
    findItem,
    findItemByEndToEndId,
    livePaymentForItem,
    nextSeq,
    recomputeBatchStatus,

    async findBatch(executor: Executor, id: string) {
      const [row] = await executor.select().from(paymentBatches).where(eq(paymentBatches.id, id));
      return row ?? null;
    },

    async findFileMeta(executor: Executor, batchId: string) {
      const [row] = await executor
        .select({ id: bankFiles.id, filename: bankFiles.filename, sha256: bankFiles.sha256, createdAt: bankFiles.createdAt })
        .from(bankFiles)
        .where(and(eq(bankFiles.paymentBatchId, batchId), eq(bankFiles.direction, "outgoing")));
      return row ?? null;
    },

    async findFile(batchId: string) {
      const [row] = await db
        .select({ filename: bankFiles.filename, contentType: bankFiles.contentType, data: bankFiles.data })
        .from(bankFiles)
        .where(and(eq(bankFiles.paymentBatchId, batchId), eq(bankFiles.direction, "outgoing")));
      return row ?? null;
    },

    async list(query: ListPaymentBatchesQuery) {
      const conditions: SQL[] = [];
      if (query.status) conditions.push(eq(paymentBatches.status, query.status));
      if (query.search) conditions.push(or(ilike(paymentBatches.batchNumber, ilikePattern(query.search)))!);
      const where = conditions.length > 0 ? and(...conditions) : undefined;
      const [rows, totals] = await Promise.all([
        db
          .select({
            id: paymentBatches.id,
            batchNumber: paymentBatches.batchNumber,
            status: paymentBatches.status,
            createdAt: paymentBatches.createdAt,
            exportedAt: paymentBatches.exportedAt,
            itemCount: sql<number>`COUNT(${paymentBatchItems.id}) FILTER (WHERE ${paymentBatchItems.status} <> 'cancelled')`,
            confirmedCount: sql<number>`COUNT(${paymentBatchItems.id}) FILTER (WHERE ${paymentBatchItems.status} = 'confirmed')`,
            totalAmount: sql<string>`COALESCE(SUM(${paymentBatchItems.amount}) FILTER (WHERE ${paymentBatchItems.status} <> 'cancelled'), 0)`,
            earliestExecutionDate: min(paymentBatchItems.executionDate),
          })
          .from(paymentBatches)
          .leftJoin(paymentBatchItems, eq(paymentBatchItems.batchId, paymentBatches.id))
          .where(where)
          .groupBy(paymentBatches.id)
          .orderBy(desc(paymentBatches.createdAt))
          .limit(query.limit)
          .offset(query.offset),
        db.select({ total: count() }).from(paymentBatches).where(where),
      ]);
      return {
        rows: rows.map((r) => ({ ...r, itemCount: Number(r.itemCount), confirmedCount: Number(r.confirmedCount), totalAmount: Number(r.totalAmount) })),
        total: totals[0]!.total,
      };
    },
  };
}

export type PaymentBatchRepository = ReturnType<typeof createPaymentBatchRepository>;

import { and, asc, count, desc, eq, getTableColumns, ilike, inArray, like, ne, notInArray, or, sql } from "drizzle-orm";
import {
  articles,
  articleSuppliers,
  invoiceScanHints,
  invoiceScans,
  numberSeries,
  purchaseOrderRows,
  purchaseOrders,
  supplierInvoiceFiles,
  supplierInvoiceRows,
  supplierInvoices,
  suppliers,
  systemSettings,
  users,
  type Db,
  type Tx,
} from "@navet/db";
import { ilikePattern, type InvoiceScanHintField, type InvoiceScanSource, type InvoiceScanStatus, type ListInvoiceScansQuery } from "@navet/shared";
import { getNextOrderNumber, NumberSeriesNotConfiguredError } from "../../system/service/number-series.js";
import { isUniqueViolation } from "../../system/service/db-errors.js";

// Fakturaskanning — the inbox's repository (spec §1). Listings never select
// `data`; the file is read on its own (readFile) or under the conversion's
// FOR UPDATE.

export const INVOICE_SCAN_SERIES = { key: "invoice_scan", prefix: "FI-" } as const;
const SHA256_INDEX = "invoice_scans_sha256_live";
// At most this many learned labels per supplier and field.
export const MAX_HINTS_PER_FIELD = 5;

const PENDING: InvoiceScanStatus[] = ["new", "interpreted"];
const LIST_STATUSES: Record<ListInvoiceScansQuery["status"], InvoiceScanStatus[] | null> = {
  pending: PENDING,
  converted: ["converted"],
  rejected: ["rejected"],
  all: null,
};

// Every column except the file itself.
const { data: _data, ...scanColumns } = getTableColumns(invoiceScans);

// The matched supplier and the read invoice number/amount out of the result
// jsonb, for the list and its search.
const matchedSupplierIdSql = sql`NULLIF(${invoiceScans.result} #>> '{supplier,matchedSupplierId}', '')::uuid`;
const interpretedInvoiceNumberSql = sql<string | null>`${invoiceScans.result} #>> '{invoiceNumber,value}'`;

export type InvoiceScanRow = Omit<typeof invoiceScans.$inferSelect, "data">;

export interface ExistingScan {
  id: string;
  scanNumber: string;
  status: InvoiceScanStatus;
}

// FI- number: getNextOrderNumber on the transaction, the series created on
// first use when it is missing (self-healing, like the SIE import's LÖ).
async function nextScanNumber(tx: Tx): Promise<string> {
  try {
    return await getNextOrderNumber(tx, INVOICE_SCAN_SERIES.key);
  } catch (err) {
    if (!(err instanceof NumberSeriesNotConfiguredError)) throw err;
    await tx
      .insert(numberSeries)
      .values({ key: INVOICE_SCAN_SERIES.key, prefix: INVOICE_SCAN_SERIES.prefix, nextNumber: 1, digits: 0 })
      .onConflictDoNothing();
    return getNextOrderNumber(tx, INVOICE_SCAN_SERIES.key);
  }
}

async function findLiveBySha(db: Db | Tx, sha256: string): Promise<ExistingScan | null> {
  const [row] = await db
    .select({ id: invoiceScans.id, scanNumber: invoiceScans.scanNumber, status: invoiceScans.status })
    .from(invoiceScans)
    .where(and(eq(invoiceScans.sha256, sha256), ne(invoiceScans.status, "rejected")));
  return row ?? null;
}

export function createInvoiceScanRepository(db: Db) {
  // The list's columns: the scan without its file, the matched supplier's
  // name and the created supplier invoice's LF- number.
  const listSelect = () =>
    db
      .select({
        ...scanColumns,
        supplierName: suppliers.name,
        supplierInvoiceRegistrationNumber: supplierInvoices.registrationNumber,
      })
      .from(invoiceScans)
      .leftJoin(suppliers, sql`${suppliers.id} = ${matchedSupplierIdSql}`)
      .leftJoin(supplierInvoices, eq(supplierInvoices.id, invoiceScans.supplierInvoiceId));

  return {
    async transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
      return db.transaction(fn);
    },

    // A new scan (status new) with its FI- number, in one transaction so a
    // duplicate does not burn a number. The dubblettspärr is the partial
    // unique index on sha256 — its violation answers with the live scan.
    async insert(input: {
      source: InvoiceScanSource;
      filename: string;
      contentType: string;
      sizeBytes: number;
      sha256: string;
      data: Buffer;
      uploadedBy: string | null;
    }): Promise<{ ok: true; scan: InvoiceScanRow } | { ok: false; existing: ExistingScan }> {
      try {
        const scan = await db.transaction(async (tx) => {
          const scanNumber = await nextScanNumber(tx);
          const [row] = await tx
            .insert(invoiceScans)
            .values({ ...input, scanNumber, status: "new" })
            .returning(scanColumns);
          return row!;
        });
        return { ok: true, scan };
      } catch (err) {
        if (!isUniqueViolation(err, SHA256_INDEX)) throw err;
        const existing = await findLiveBySha(db, input.sha256);
        // The live scan was rejected or deleted in between: report it as a
        // duplicate of nothing rather than retrying blindly.
        if (!existing) throw err;
        return { ok: false, existing };
      }
    },

    async list(query: ListInvoiceScansQuery) {
      const conditions = [];
      const statuses = LIST_STATUSES[query.status];
      if (statuses) conditions.push(inArray(invoiceScans.status, statuses));
      if (query.source) conditions.push(eq(invoiceScans.source, query.source));
      if (query.search) {
        const pattern = ilikePattern(query.search);
        conditions.push(
          or(
            ilike(invoiceScans.filename, pattern),
            ilike(invoiceScans.scanNumber, pattern),
            ilike(invoiceScans.emailFrom, pattern),
            ilike(invoiceScans.emailSubject, pattern),
            ilike(suppliers.name, pattern),
            sql`${interpretedInvoiceNumberSql} ILIKE ${pattern}`
          )
        );
      }
      const where = conditions.length > 0 ? and(...conditions) : undefined;
      const [rows, totals] = await Promise.all([
        listSelect()
          .where(where)
          .orderBy(desc(invoiceScans.createdAt), desc(invoiceScans.scanNumber))
          .limit(query.limit)
          .offset(query.offset),
        db
          .select({ total: count() })
          .from(invoiceScans)
          .leftJoin(suppliers, sql`${suppliers.id} = ${matchedSupplierIdSql}`)
          .where(where),
      ]);
      return { rows, total: totals[0]!.total };
    },

    // One scan as a list row (the upload's answer).
    async listRow(id: string) {
      const [row] = await listSelect().where(eq(invoiceScans.id, id));
      return row ?? null;
    },

    async findById(id: string) {
      const rejectedByUsers = users;
      const [row] = await db
        .select({
          ...scanColumns,
          supplierName: suppliers.name,
          supplierInvoiceRegistrationNumber: supplierInvoices.registrationNumber,
          rejectedByName: rejectedByUsers.name,
        })
        .from(invoiceScans)
        .leftJoin(suppliers, sql`${suppliers.id} = ${matchedSupplierIdSql}`)
        .leftJoin(supplierInvoices, eq(supplierInvoices.id, invoiceScans.supplierInvoiceId))
        .leftJoin(rejectedByUsers, eq(rejectedByUsers.id, invoiceScans.rejectedBy))
        .where(eq(invoiceScans.id, id));
      return row ?? null;
    },

    // The scan with its file (only while it is not converted).
    async findWithData(id: string) {
      const [row] = await db.select().from(invoiceScans).where(eq(invoiceScans.id, id));
      return row ?? null;
    },

    // The file: from the scan, or from supplier_invoice_files once the
    // conversion moved it there.
    async readFile(id: string): Promise<{ filename: string; contentType: string; data: Buffer } | null> {
      const [row] = await db
        .select({
          filename: invoiceScans.filename,
          contentType: invoiceScans.contentType,
          data: invoiceScans.data,
          movedData: supplierInvoiceFiles.data,
        })
        .from(invoiceScans)
        .leftJoin(supplierInvoiceFiles, eq(supplierInvoiceFiles.id, invoiceScans.supplierInvoiceFileId))
        .where(eq(invoiceScans.id, id));
      if (!row) return null;
      const data = row.data ?? row.movedData;
      return data ? { filename: row.filename, contentType: row.contentType, data } : null;
    },

    // A new result, only while the scan is pending (a concurrent Avvisa or
    // Skapa wins). `status` = interpreted, or the current status when the
    // extraction crashed (the result then only carries the check).
    async writeResult(
      id: string,
      write: {
        result: unknown;
        interpretedBy: "rules" | "ai" | null;
        hasTextLayer: boolean | null;
        pageCount: number | null;
        interpreted: boolean;
      }
    ): Promise<InvoiceScanRow | null> {
      const [row] = await db
        .update(invoiceScans)
        .set({
          result: write.result,
          hasTextLayer: write.hasTextLayer,
          pageCount: write.pageCount,
          ...(write.interpreted
            ? { status: "interpreted" as const, interpretedBy: write.interpretedBy, interpretedAt: new Date() }
            : {}),
          updatedAt: new Date(),
        })
        .where(and(eq(invoiceScans.id, id), inArray(invoiceScans.status, PENDING)))
        .returning(scanColumns);
      return row ?? null;
    },

    async reject(id: string, reason: string, userId: string | null): Promise<InvoiceScanRow | null> {
      const [row] = await db
        .update(invoiceScans)
        .set({ status: "rejected", rejectedReason: reason, rejectedAt: new Date(), rejectedBy: userId, aiStartedAt: null, updatedAt: new Date() })
        .where(and(eq(invoiceScans.id, id), inArray(invoiceScans.status, PENDING)))
        .returning(scanColumns);
      return row ?? null;
    },

    // Återställ: back to new, or interpreted when an interpretation
    // succeeded on it. The dubblettspärr applies again — the same file
    // uploaded after the rejection makes this a duplicate.
    async restore(id: string): Promise<{ ok: true; scan: InvoiceScanRow } | { ok: false; reason: "status" } | { ok: false; reason: "duplicate"; existing: ExistingScan }> {
      const [current] = await db.select({ sha256: invoiceScans.sha256 }).from(invoiceScans).where(eq(invoiceScans.id, id));
      try {
        const [row] = await db
          .update(invoiceScans)
          .set({
            status: sql`CASE WHEN ${invoiceScans.interpretedBy} IS NULL THEN 'new' ELSE 'interpreted' END::invoice_scan_status`,
            rejectedReason: null,
            rejectedAt: null,
            rejectedBy: null,
            updatedAt: new Date(),
          })
          .where(and(eq(invoiceScans.id, id), eq(invoiceScans.status, "rejected")))
          .returning(scanColumns);
        return row ? { ok: true, scan: row } : { ok: false, reason: "status" };
      } catch (err) {
        if (!isUniqueViolation(err, SHA256_INDEX) || !current) throw err;
        const existing = await findLiveBySha(db, current.sha256);
        if (!existing) throw err;
        return { ok: false, reason: "duplicate", existing };
      }
    },

    // Only a rejected scan is deleted (the service's räkenskapsinformation
    // rule); the conditional DELETE closes the race with Återställ.
    async deleteRejected(id: string) {
      const [row] = await db
        .delete(invoiceScans)
        .where(and(eq(invoiceScans.id, id), eq(invoiceScans.status, "rejected")))
        .returning({
          scanNumber: invoiceScans.scanNumber,
          filename: invoiceScans.filename,
          sha256: invoiceScans.sha256,
          rejectedReason: invoiceScans.rejectedReason,
        });
      return row ?? null;
    },

    // --- The conversion (inside the caller's transaction) ---

    async lockInTx(tx: Tx, id: string) {
      const [row] = await tx.select().from(invoiceScans).where(eq(invoiceScans.id, id)).for("update");
      return row ?? null;
    },

    async insertInvoiceFileInTx(
      tx: Tx,
      input: { supplierInvoiceId: string; filename: string; contentType: string; sizeBytes: number; sha256: string; data: Buffer; uploadedBy: string | null }
    ) {
      const { data: _fileData, ...columns } = getTableColumns(supplierInvoiceFiles);
      const [row] = await tx.insert(supplierInvoiceFiles).values(input).returning(columns);
      return row!;
    },

    async markConvertedInTx(tx: Tx, id: string, link: { supplierInvoiceId: string; supplierInvoiceFileId: string }) {
      const [row] = await tx
        .update(invoiceScans)
        .set({
          status: "converted",
          supplierInvoiceId: link.supplierInvoiceId,
          supplierInvoiceFileId: link.supplierInvoiceFileId,
          data: null,
          aiStartedAt: null,
          updatedAt: new Date(),
        })
        .where(and(eq(invoiceScans.id, id), inArray(invoiceScans.status, PENDING)))
        .returning(scanColumns);
      return row ?? null;
    },

    // Leverantörsinlärningen: hits + 1 on a known label, then keep the
    // MAX_HINTS_PER_FIELD most recently used per field.
    async upsertHintsInTx(tx: Tx, supplierId: string, hints: { field: InvoiceScanHintField; label: string }[]) {
      if (hints.length === 0) return;
      const now = new Date();
      for (const hint of hints) {
        await tx
          .insert(invoiceScanHints)
          .values({ supplierId, field: hint.field, label: hint.label, hits: 1, lastUsedAt: now })
          .onConflictDoUpdate({
            target: [invoiceScanHints.supplierId, invoiceScanHints.field, invoiceScanHints.label],
            set: { hits: sql`${invoiceScanHints.hits} + 1`, lastUsedAt: now },
          });
      }
      const fields = [...new Set(hints.map((h) => h.field))];
      for (const fieldName of fields) {
        const keep = tx
          .select({ id: invoiceScanHints.id })
          .from(invoiceScanHints)
          .where(and(eq(invoiceScanHints.supplierId, supplierId), eq(invoiceScanHints.field, fieldName)))
          .orderBy(desc(invoiceScanHints.lastUsedAt), desc(invoiceScanHints.hits), asc(invoiceScanHints.label))
          .limit(MAX_HINTS_PER_FIELD);
        await tx
          .delete(invoiceScanHints)
          .where(and(eq(invoiceScanHints.supplierId, supplierId), eq(invoiceScanHints.field, fieldName), notInArray(invoiceScanHints.id, keep)));
      }
    },

    async hintsFor(supplierId: string) {
      return db
        .select({ field: invoiceScanHints.field, label: invoiceScanHints.label, hits: invoiceScanHints.hits })
        .from(invoiceScanHints)
        .where(eq(invoiceScanHints.supplierId, supplierId))
        .orderBy(desc(invoiceScanHints.hits), desc(invoiceScanHints.lastUsedAt));
    },

    // --- What the rules read ---

    // The five identifier columns (+ name, currency, country) of the active
    // suppliers — never the whole register.
    async supplierIdentities() {
      return db
        .select({
          id: suppliers.id,
          name: suppliers.name,
          orgNumber: suppliers.orgNumber,
          vatNumber: suppliers.vatNumber,
          bankgiro: suppliers.bankgiro,
          plusgiro: suppliers.plusgiro,
          iban: suppliers.iban,
          currency: suppliers.currency,
          country: suppliers.country,
        })
        .from(suppliers)
        .where(eq(suppliers.active, true));
    },

    // Dubblett: the supplier already has a (non-cancelled) supplier invoice
    // with this number. A cancelled one still holds the unique key, so it
    // counts too.
    async findSupplierInvoiceByNumber(supplierId: string, invoiceNumber: string) {
      const [row] = await db
        .select({ id: supplierInvoices.id, registrationNumber: supplierInvoices.registrationNumber })
        .from(supplierInvoices)
        .where(and(eq(supplierInvoices.supplierId, supplierId), eq(supplierInvoices.invoiceNumber, invoiceNumber)));
      return row ?? null;
    },

    async purchaseOrderNumber(id: string): Promise<string | null> {
      const [row] = await db.select({ orderNumber: purchaseOrders.orderNumber }).from(purchaseOrders).where(eq(purchaseOrders.id, id));
      return row?.orderNumber ?? null;
    },

    async purchaseOrderPrefix(): Promise<string> {
      const [row] = await db.select({ prefix: numberSeries.prefix }).from(numberSeries).where(eq(numberSeries.key, "purchase_order"));
      return row?.prefix ?? "";
    },

    // The supplier's orders with goods received (the Skapa dialog's Hämta
    // från inköpsorder), each with whether every received quantity is
    // already invoiced by live supplier invoices.
    async receivedPurchaseOrders(supplierId: string) {
      const rows = await db
        .select({
          id: purchaseOrders.id,
          orderNumber: purchaseOrders.orderNumber,
          createdAt: purchaseOrders.createdAt,
          // Qualified by hand: drizzle renders a column without its table in
          // a single-table select, which the subquery would capture.
          fullyInvoiced: sql<boolean>`NOT EXISTS (
            SELECT 1 FROM ${purchaseOrderRows} por
            WHERE por.purchase_order_id = purchase_orders.id
              AND por.quantity_received > COALESCE((
                SELECT SUM(sir.quantity) FROM ${supplierInvoiceRows} sir
                JOIN ${supplierInvoices} si ON si.id = sir.supplier_invoice_id
                WHERE sir.purchase_order_row_id = por.id AND si.status <> 'cancelled'
              ), 0)
          )`,
        })
        .from(purchaseOrders)
        .where(
          and(
            eq(purchaseOrders.supplierId, supplierId),
            inArray(purchaseOrders.status, ["partially_received", "received", "closed"])
          )
        );
      return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
    },

    // The order's rows for the row matching: our and the supplier's article
    // number, the price and what is received but not yet invoiced.
    async purchaseOrderRowsForMatch(purchaseOrderId: string, supplierId: string) {
      const rows = await db
        .select({
          id: purchaseOrderRows.id,
          articleId: purchaseOrderRows.articleId,
          articleNumber: articles.articleNumber,
          supplierArticleNumber: articleSuppliers.supplierArticleNumber,
          unitPrice: purchaseOrderRows.unitPrice,
          quantityReceived: purchaseOrderRows.quantityReceived,
          invoiced: sql<string>`COALESCE((
            SELECT SUM(sir.quantity) FROM ${supplierInvoiceRows} sir
            JOIN ${supplierInvoices} si ON si.id = sir.supplier_invoice_id
            WHERE sir.purchase_order_row_id = purchase_order_rows.id AND si.status <> 'cancelled'
          ), 0)`,
        })
        .from(purchaseOrderRows)
        .innerJoin(articles, eq(articles.id, purchaseOrderRows.articleId))
        .leftJoin(
          articleSuppliers,
          and(eq(articleSuppliers.articleId, purchaseOrderRows.articleId), eq(articleSuppliers.supplierId, supplierId))
        )
        .where(eq(purchaseOrderRows.purchaseOrderId, purchaseOrderId))
        .orderBy(asc(purchaseOrderRows.createdAt));
      return rows.map((r) => ({
        id: r.id,
        articleId: r.articleId,
        articleNumber: r.articleNumber,
        supplierArticleNumber: r.supplierArticleNumber,
        unitPrice: Number(r.unitPrice),
        openQuantity: Math.max(0, Number(r.quantityReceived) - Number(r.invoiced)),
      }));
    },

    // --- Settings (invoice_scan_* in system_settings) ---

    async readSettings(): Promise<Map<string, string>> {
      const rows = await db.select().from(systemSettings).where(like(systemSettings.key, "invoice\\_scan\\_%"));
      return new Map(rows.map((r) => [r.key, r.value]));
    },

    async setSetting(key: string, value: string) {
      await db.insert(systemSettings).values({ key, value }).onConflictDoUpdate({ target: systemSettings.key, set: { value } });
    },

    async deleteSetting(key: string) {
      await db.delete(systemSettings).where(eq(systemSettings.key, key));
    },
  };
}

export type InvoiceScanRepository = ReturnType<typeof createInvoiceScanRepository>;

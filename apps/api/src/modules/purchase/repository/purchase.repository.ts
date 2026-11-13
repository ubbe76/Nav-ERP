import { and, asc, count, desc, eq, exists, getTableColumns, ilike, inArray, isNotNull, isNull, lt, not, notInArray, or, sql } from "drizzle-orm";
import { legoOneOffSql } from "../../manufacturing/repository/lego-one-off.js";
import { alias } from "drizzle-orm/pg-core";
import { loadPriceBreaks, replacePriceBreaks } from "./price-breaks.js";
import { dispatchedQuantitySql } from "./dispatched-quantity.js";
import { loadSupplierOrderDefaults, resolveOrderDefaults } from "./supplier-order-defaults.js";
import { loadDeliveryContext } from "../../system/repository/delivery-context.js";
import {
  articleSupplierPriceHistory,
  articleSuppliers,
  articles,
  carriers,
  customerDeliveryAddresses,
  customers,
  projects,
  deliveryTerms,
  inquiries,
  inquiryRows,
  manufacturingOrders,
  moOperations,
  paymentTerms,
  purchaseOrderDispatchRows,
  purchaseOrderDispatches,
  purchaseOrderRows,
  purchaseOrders,
  purchaseReceipts,
  routingOperationFiles,
  routingOperations,
  salesOrderRows,
  salesOrders,
  stockLocations,
  stockBatches,
  stockTransactions,
  supplierContacts,
  supplierDeliveryAddresses,
  supplierInvoices,
  suppliers,
  units,
  users,
  workCenters,
  type Db,
} from "@navet/db";
import {
  ilikePattern,
  type CreateArticleSupplierInput,
  type CreateContactInput,
  type CreateDeliveryAddressInput,
  type CreateInquiryInput,
  type CreateInquiryRowInput,
  type CreatePurchaseDispatchInput,
  type CreatePurchaseOrderInput,
  type CreatePurchaseOrderRowInput,
  type CreateSupplierInput,
  type InquiryStatus,
  type ListGoodsReceiptsQuery,
  type ListInquiriesQuery,
  type ListPriceHistoryQuery,
  type ListPurchaseInvoiceBasisQuery,
  type ListPurchaseOrdersQuery,
  splitLateFilter,
  type ListQuery,
  type PurchaseOrderStatus,
  type UpdateArticleSupplierInput,
  type UpdateContactInput,
  type UpdateDeliveryAddressInput,
  type UpdateInquiryHeaderInput,
  type UpdateInquiryRowInput,
  type UpdatePurchaseOrderHeaderInput,
  type UpdatePurchaseOrderRowInput,
  type UpdateSupplierInput,
  round4,
} from "@navet/shared";
import { purchaseOrderLate } from "../../planning/repository/late-orders.js";
import { getNextOrderNumber, insertWithSeriesNumber } from "../../system/service/number-series.js";
import { pluginEvents } from "../../system/service/plugin-events.js";
import { resolveStockLocation } from "../../stock/service/location-resolver.js";
import { assertLocationNotUnderCount } from "../../stock/service/count-guard.js";
import { deactivateEmptyLocation } from "../../stock/service/location-lifecycle.js";
import { lockArticlesForOutflow } from "../../stock/service/outflow-locations.js";
import { isStockedArticle } from "../../stock/service/stocked-article.js";
import {
  ArticleNotSerialTrackedError,
  BatchNotTrackedError,
  SerialCountMismatchError,
  SerialNumbersRequiredError,
  SerialQuantityNotIntegerError,
} from "../../stock/service/batch.errors.js";
import { assertSerialsOutOfStock, getOrCreateSerials, lockSerials } from "../../stock/service/serial-numbers.js";
import { getOrCreateDatedBatch } from "../../stock/service/batches.js";
import { isTrackedArticle, batchTrackedSql, trackingOf } from "../../stock/service/batch-tracking.js";
import { batchCellQuantity } from "../../stock/repository/batch-balances.js";
import { loadVatCodeBook } from "../../economy/repository/vat-codes.js";
import { resolveDimensions, type DimensionInput, type ResolveDimensionsOptions } from "../../economy/service/dimension-check.js";
import { purchaseRowArrivalDate } from "../../planning/repository/effective-dates.js";

export type ReceiveGoodsResult =
  // batchNumber (#8): the batch the goods were booked in — null for an
  // article that is not batchstyrd and for a row without a stock movement.
  | { ok: true; row: typeof purchaseOrderRows.$inferSelect; orderStatus: PurchaseOrderStatus; receiptId: string;
      // Serienummer: one kvitto per styck (receiptId is the first); else [receiptId].
      receiptIds: string[];
      batchNumber: string | null;
      expiresOn: string | null;
      // The serial numbers booked, in the request's order ([] otherwise).
      serialNumbers: string[];
    }
  | { ok: false; reason: "order_not_found" | "row_not_found" | "invalid_status" }
  | { ok: false; reason: "over_receipt"; maxQuantity: number };

// Row-level unit snapshot resolved by the service (null = the article's base
// unit). Quantities/prices on the same input arrive already converted to the
// base unit.
export type UnitSnapshot = { unitId: string | null; unitFactor: number | null };

// Lego link + ställpris on an inquiry row, resolved by the service before
// the row is written (routingOperationId is derived for TO rows).
export type LegoSnapshot = {
  moOperationId: string | null;
  routingOperationId: string | null;
  setupPrice: number | null;
};

// An inquiry row as the service hands it over: unit-converted, with the lego
// link resolved (the zod input's optional ids give way to the snapshot).
export type LegoInquiryRowInput = Omit<CreateInquiryRowInput, keyof LegoSnapshot> & UnitSnapshot & LegoSnapshot;

// What the service needs to validate a lego link: the operation's article
// (must match the row's), its resource type (must be subcontract) and the
// defaults it lends the row.
export interface LegoOperationRef {
  moOperationId: string | null;
  routingOperationId: string | null;
  articleId: string;
  workCenterType: string;
  setupPrice: string | null;
  supplierId: string | null;
  // Only populated for the mo branch (a TO operation link) — the service
  // uses these to refuse linking into a done operation or a no-longer-open
  // MO. Absent (undefined) for the routing-operation-only branch, which has
  // no MO to be open/closed.
  moOperationStatus?: string;
  manufacturingOrderStatus?: string;
}

export type PurchaseRowMutationResult =
  | { ok: true; row: typeof purchaseOrderRows.$inferSelect | null; orderStatus: PurchaseOrderStatus }
  | { ok: false; reason: "row_not_found" | "quantity_below_received" | "row_has_receipts" | "row_has_dispatches" }
  // The order left the editable statuses between the service's read and the
  // row lock (received, closed or cancelled meanwhile).
  | { ok: false; reason: "invalid_status"; status: PurchaseOrderStatus };

// Rows are editable in these statuses only — re-checked under the order lock
// by every row write (the service's own check reads unlocked).
const ROW_EDITABLE_STATUSES: readonly PurchaseOrderStatus[] = ["draft", "confirmed", "partially_received"];

// Locks the order header (after the row, the row → order order of the
// receipt) and returns its status, null when the order is gone.
async function lockOrderStatus(tx: Tx, orderId: string): Promise<PurchaseOrderStatus | null> {
  const [order] = await tx
    .select({ status: purchaseOrders.status })
    .from(purchaseOrders)
    .where(eq(purchaseOrders.id, orderId))
    .for("update");
  return order?.status ?? null;
}

// addRow under the order lock: the order is no longer in a row-editable
// status. Thrown (not returned) so addRow keeps returning the row; the
// service turns it into its InvalidStatusTransitionError.
// Lego-inleveransen, inside the TO report's transaction (the
// manufacturing module's PurchaseReceiptLink): the receipt is locked FIRST —
// before the operation, as Ångra inleverans takes receipt → … → operation —
// so an undo and the report never wait on each other crosswise, and a
// receipt undone between its own commit and the report gets no report at all.
export class PurchaseReceiptUndoneError extends Error {
  constructor() {
    super("Inleveransen ångrades innan operationen hann rapporteras");
    this.name = "PurchaseReceiptUndoneError";
  }
}

export async function claimReceiptForReportInTx(tx: Tx, receiptId: string): Promise<void> {
  const [receipt] = await tx
    .select({ undoneAt: purchaseReceipts.undoneAt })
    .from(purchaseReceipts)
    .where(eq(purchaseReceipts.id, receiptId))
    .for("update");
  if (!receipt || receipt.undoneAt !== null) throw new PurchaseReceiptUndoneError();
}

// Stamped in the same commit as the report, so Ångra inleverans always finds it.
export async function linkReceiptReportInTx(tx: Tx, receiptId: string, moReportId: string): Promise<void> {
  await tx.update(purchaseReceipts).set({ moReportId }).where(eq(purchaseReceipts.id, receiptId));
}

export class PurchaseOrderNotEditableError extends Error {
  constructor(readonly status: PurchaseOrderStatus | null) {
    super(`Purchase order is not editable in status "${status ?? "unknown"}"`);
    this.name = "PurchaseOrderNotEditableError";
  }
}

export type ConvertInquiryResult =
  | { ok: true; order: typeof purchaseOrders.$inferSelect }
  | { ok: false; reason: "inquiry_not_found" }
  | { ok: false; reason: "invalid_status"; status: InquiryStatus };

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

// Content changes (header/terms/rows) bump the order's revision by 1 inside
// the same transaction — status transitions and receipts never do. Callers
// can opt out per save via the bumpRevision flag (the UI asks on every save).
async function bumpRevision(tx: Tx, orderId: string) {
  await tx
    .update(purchaseOrders)
    .set({ revision: sql`${purchaseOrders.revision} + 1`, updatedAt: new Date() })
    .where(eq(purchaseOrders.id, orderId));
}

// A row edit/delete on a partially received order can make every remaining
// row fully covered — mirror receiveGoods' status recomputation. Other
// statuses are left untouched (the service guards which ones are editable).
async function recomputePartiallyReceived(tx: Tx, orderId: string): Promise<PurchaseOrderStatus> {
  // Locked: a receipt on another row holds this lock while it recomputes the
  // status, so the two never write a status from a stale set of rows (and a
  // concurrent Stäng/Makulera waits instead of being overwritten).
  const [order] = await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, orderId)).for("update");
  if (!order || order.status !== "partially_received") return order?.status ?? "partially_received";
  const allRows = await tx.select().from(purchaseOrderRows).where(eq(purchaseOrderRows.purchaseOrderId, orderId));
  const allReceived =
    allRows.length > 0 && allRows.every((r) => Number(r.quantityReceived) >= Number(r.quantityOrdered));
  if (!allReceived) return "partially_received";
  await tx.update(purchaseOrders).set({ status: "received", updatedAt: new Date() }).where(eq(purchaseOrders.id, orderId));
  return "received";
}

// Receipt (and its undo): the order status follows what the rows hold —
// everything received ⇒ received, something ⇒ partially received, nothing
// (every receipt undone) ⇒ back to confirmed.
async function recomputeReceiptStatus(tx: Tx, orderId: string): Promise<PurchaseOrderStatus> {
  const allRows = await tx.select().from(purchaseOrderRows).where(eq(purchaseOrderRows.purchaseOrderId, orderId));
  const allReceived =
    allRows.length > 0 && allRows.every((r) => Number(r.quantityReceived) >= Number(r.quantityOrdered));
  const anyReceived = allRows.some((r) => Number(r.quantityReceived) > 0);
  const status: PurchaseOrderStatus = allReceived ? "received" : anyReceived ? "partially_received" : "confirmed";
  await tx.update(purchaseOrders).set({ status, updatedAt: new Date() }).where(eq(purchaseOrders.id, orderId));
  return status;
}

export type UndoReceiptResult =
  | {
      ok: true;
      receipt: typeof purchaseReceipts.$inferSelect;
      row: typeof purchaseOrderRows.$inferSelect;
      statusBefore: PurchaseOrderStatus;
      orderStatus: PurchaseOrderStatus;
    }
  | { ok: false; reason: "receipt_not_found" | "already_undone" | "invalid_status" }
  | { ok: false; reason: "insufficient_stock"; available: number; required: number };

export function createPurchaseRepository(db: Db) {
  // The dispatch rows of one order, joined with their IO row, article, unit
  // and lego reference — listDispatches and the pallet card share it.
  async function dispatchRowsByOrder(orderId: string) {
    const rowUnits = alias(units, "row_units");
    const moArticles = alias(articles, "mo_articles");
    return db
      .select({
        id: purchaseOrderDispatchRows.id,
        dispatchId: purchaseOrderDispatchRows.dispatchId,
        purchaseOrderRowId: purchaseOrderDispatchRows.purchaseOrderRowId,
        quantity: purchaseOrderDispatchRows.quantity,
        parcels: purchaseOrderDispatchRows.parcels,
        unitFactor: purchaseOrderRows.unitFactor,
        unitCode: sql<string>`coalesce(${rowUnits.code}, ${units.code})`,
        unitCodeEn: sql<string | null>`case when ${rowUnits.id} is null then ${units.codeEn} else ${rowUnits.codeEn} end`,
        articleId: articles.id,
        articleNumber: articles.articleNumber,
        articleName: articles.name,
        articleNameEn: articles.nameEn,
        articleSurfaceTreatment: articles.surfaceTreatment,
        articleColour: articles.colour,
        moOrderNumber: manufacturingOrders.orderNumber,
        moOperationSequenceNo: moOperations.sequenceNo,
        moOperationDescription: moOperations.description,
        // Batch (#8): the TO's own article — its finished goods get the TO
        // number as their batch, printed on the lego pallet card.
        moArticleBatchTracked: batchTrackedSql(moArticles),
        rowCreatedAt: purchaseOrderRows.createdAt,
      })
      .from(purchaseOrderDispatchRows)
      .innerJoin(purchaseOrderDispatches, eq(purchaseOrderDispatches.id, purchaseOrderDispatchRows.dispatchId))
      .innerJoin(purchaseOrderRows, eq(purchaseOrderRows.id, purchaseOrderDispatchRows.purchaseOrderRowId))
      .innerJoin(articles, eq(articles.id, purchaseOrderRows.articleId))
      .innerJoin(units, eq(units.id, articles.unitId))
      .leftJoin(rowUnits, eq(rowUnits.id, purchaseOrderRows.unitId))
      .leftJoin(moOperations, eq(moOperations.id, purchaseOrderRows.moOperationId))
      .leftJoin(manufacturingOrders, eq(manufacturingOrders.id, moOperations.manufacturingOrderId))
      .leftJoin(moArticles, eq(moArticles.id, manufacturingOrders.articleId))
      .where(eq(purchaseOrderDispatches.purchaseOrderId, orderId))
      // The IO's row order (entry order), as the card lists the rows.
      .orderBy(asc(purchaseOrderRows.createdAt), asc(purchaseOrderRows.id), asc(purchaseOrderDispatchRows.id));
  }

  return {
    // The supplier number comes from the "supplier" number series unless the
    // caller supplied one, in which case it's inserted as-is and never
    // retried — a collision there is the caller's error and surfaces as a
    // 409. Otherwise, self-healing allocation that steps past a manually
    // taken number instead of failing — see number-series.ts's
    // insertWithSeriesNumber for why and how.
    async createSupplier(input: CreateSupplierInput) {
      // Tillägg: supplier.created commits with the supplier.
      const insert = (supplierNumber: string) =>
        db.transaction(async (tx) => {
          const [row] = await tx
            .insert(suppliers)
            .values({ ...input, supplierNumber })
            .returning();
          await pluginEvents.emit(tx, { type: "supplier.created", entityId: row!.id, entityNumber: row!.supplierNumber });
          return row!;
        });
      return input.supplierNumber !== undefined
        ? insert(input.supplierNumber)
        : insertWithSeriesNumber(db, "supplier", insert);
    },

    async updateSupplier(id: string, input: UpdateSupplierInput) {
      return db.transaction(async (tx) => {
        const [row] = await tx.update(suppliers).set(input).where(eq(suppliers.id, id)).returning();
        if (row) await pluginEvents.emit(tx, { type: "supplier.updated", entityId: row.id, entityNumber: row.supplierNumber });
        return row ?? null;
      });
    },

    // Momskoder: the company's codes — the supplier's Momskod (förval) is
    // validated against them and its derived default resolved from them.
    async vatCodeBook() {
      return loadVatCodeBook(db);
    },

    // Leverantörens förval for a new order / the purchase order's recipient.
    async supplierOrderDefaults(supplierId: string) {
      return loadSupplierOrderDefaults(db, supplierId);
    },

    async findSupplierById(id: string) {
      const [row] = await db
        .select({
          ...getTableColumns(suppliers),
          deliveryTermCode: deliveryTerms.code,
          deliveryTermName: deliveryTerms.name,
          paymentTermCode: paymentTerms.code,
          paymentTermName: paymentTerms.name,
          carrierCode: carriers.code,
          carrierName: carriers.name,
        })
        .from(suppliers)
        .leftJoin(deliveryTerms, eq(deliveryTerms.id, suppliers.deliveryTermId))
        .leftJoin(paymentTerms, eq(paymentTerms.id, suppliers.paymentTermId))
        .leftJoin(carriers, eq(carriers.id, suppliers.carrierId))
        .where(eq(suppliers.id, id));
      return row ?? null;
    },

    async listSuppliers(query: ListQuery) {
      const pattern = query.search ? ilikePattern(query.search) : null;
      const where = pattern
        ? or(
            ilike(suppliers.supplierNumber, pattern),
            ilike(suppliers.name, pattern),
            ilike(suppliers.contactName, pattern)
          )
        : undefined;
      const [rows, totalRows] = await Promise.all([
        db.select().from(suppliers).where(where).orderBy(asc(suppliers.name)).limit(query.limit).offset(query.offset),
        db.select({ total: count() }).from(suppliers).where(where),
      ]);
      return { rows, total: totalRows[0]!.total };
    },

    async listSupplierContacts(supplierId: string) {
      return db
        .select()
        .from(supplierContacts)
        .where(eq(supplierContacts.supplierId, supplierId))
        .orderBy(desc(supplierContacts.isPrimary), asc(supplierContacts.name));
    },

    // Making a contact primary demotes the previous primary in the same
    // transaction — otherwise the partial unique index rejects the write.
    async createSupplierContact(supplierId: string, input: CreateContactInput) {
      return db.transaction(async (tx) => {
        if (input.isPrimary) {
          await tx
            .update(supplierContacts)
            .set({ isPrimary: false })
            .where(and(eq(supplierContacts.supplierId, supplierId), eq(supplierContacts.isPrimary, true)));
        }
        const [row] = await tx.insert(supplierContacts).values({ ...input, supplierId }).returning();
        return row!;
      });
    },

    // Scoped to the supplier so a contact id from another supplier 404s.
    async updateSupplierContact(supplierId: string, contactId: string, input: UpdateContactInput) {
      return db.transaction(async (tx) => {
        if (input.isPrimary === true) {
          // The target is locked first: an unknown (or another supplier's)
          // contact id must not demote the current primary on its way to 404.
          const [target] = await tx
            .select({ id: supplierContacts.id })
            .from(supplierContacts)
            .where(and(eq(supplierContacts.id, contactId), eq(supplierContacts.supplierId, supplierId)))
            .for("update");
          if (!target) return null;
          await tx
            .update(supplierContacts)
            .set({ isPrimary: false })
            .where(and(eq(supplierContacts.supplierId, supplierId), eq(supplierContacts.isPrimary, true)));
        }
        const [row] = await tx
          .update(supplierContacts)
          .set(input)
          .where(and(eq(supplierContacts.id, contactId), eq(supplierContacts.supplierId, supplierId)))
          .returning();
        return row ?? null;
      });
    },

    async deleteSupplierContact(supplierId: string, contactId: string) {
      const [row] = await db
        .delete(supplierContacts)
        .where(and(eq(supplierContacts.id, contactId), eq(supplierContacts.supplierId, supplierId)))
        .returning();
      return row ?? null;
    },

    // --- Delivery addresses (leveransadresser) — contact-pattern CRUD,
    // mirrors sales.repository.ts's customer delivery addresses ---

    async listSupplierDeliveryAddresses(supplierId: string) {
      return db
        .select()
        .from(supplierDeliveryAddresses)
        .where(eq(supplierDeliveryAddresses.supplierId, supplierId))
        .orderBy(desc(supplierDeliveryAddresses.isDefault), asc(supplierDeliveryAddresses.label));
    },

    async findSupplierDeliveryAddress(supplierId: string, addressId: string) {
      const [row] = await db
        .select()
        .from(supplierDeliveryAddresses)
        .where(and(eq(supplierDeliveryAddresses.id, addressId), eq(supplierDeliveryAddresses.supplierId, supplierId)));
      return row ?? null;
    },

    // Making an address default demotes the previous default in the same
    // transaction — otherwise the partial unique index rejects the write.
    async createSupplierDeliveryAddress(supplierId: string, input: CreateDeliveryAddressInput) {
      return db.transaction(async (tx) => {
        if (input.isDefault) {
          await tx
            .update(supplierDeliveryAddresses)
            .set({ isDefault: false })
            .where(
              and(
                eq(supplierDeliveryAddresses.supplierId, supplierId),
                eq(supplierDeliveryAddresses.isDefault, true)
              )
            );
        }
        const [row] = await tx.insert(supplierDeliveryAddresses).values({ ...input, supplierId }).returning();
        return row!;
      });
    },

    async updateSupplierDeliveryAddress(supplierId: string, addressId: string, input: UpdateDeliveryAddressInput) {
      return db.transaction(async (tx) => {
        if (input.isDefault === true) {
          // Target first — an unknown address id must not demote the default.
          const [target] = await tx
            .select({ id: supplierDeliveryAddresses.id })
            .from(supplierDeliveryAddresses)
            .where(and(eq(supplierDeliveryAddresses.id, addressId), eq(supplierDeliveryAddresses.supplierId, supplierId)))
            .for("update");
          if (!target) return null;
          await tx
            .update(supplierDeliveryAddresses)
            .set({ isDefault: false })
            .where(
              and(
                eq(supplierDeliveryAddresses.supplierId, supplierId),
                eq(supplierDeliveryAddresses.isDefault, true)
              )
            );
        }
        const [row] = await tx
          .update(supplierDeliveryAddresses)
          .set(input)
          .where(and(eq(supplierDeliveryAddresses.id, addressId), eq(supplierDeliveryAddresses.supplierId, supplierId)))
          .returning();
        return row ?? null;
      });
    },

    async deleteSupplierDeliveryAddress(supplierId: string, addressId: string) {
      const [row] = await db
        .delete(supplierDeliveryAddresses)
        .where(and(eq(supplierDeliveryAddresses.id, addressId), eq(supplierDeliveryAddresses.supplierId, supplierId)))
        .returning();
      return row ?? null;
    },

    // `currency` is passed in by the service, snapshotted from the supplier.
    // --- Inquiries (förfrågningar) ---

    async createInquiry(
      input: Omit<CreateInquiryInput, "rows"> & { rows: LegoInquiryRowInput[] },
      createdBy: string
    ) {
      return db.transaction(async (tx) => {
        // Terms are snapshotted from the supplier at creation (like the PO's
        // currency) — later changes on the supplier card don't touch documents.
        const [supplier] = await tx.select().from(suppliers).where(eq(suppliers.id, input.supplierId));
        // Frakt på vårt konto: the supplier's förval unless the call says.
        const defaults = resolveOrderDefaults(await loadSupplierOrderDefaults(tx, input.supplierId), {
          freightPaidByUs: input.freightPaidByUs,
        });
        const inquiryNumber = await getNextOrderNumber(tx, "inquiry");
        const [inquiry] = await tx
          .insert(inquiries)
          .values({
            inquiryNumber,
            supplierId: input.supplierId,
            expectedDeliveryDate: input.expectedDeliveryDate,
            note: input.note,
            deliveryTermId: supplier?.deliveryTermId ?? null,
            paymentTermId: supplier?.paymentTermId ?? null,
            carrierId: supplier?.carrierId ?? null,
            freightPaidByUs: defaults.freightPaidByUs,
            createdBy,
          })
          .returning();

        // One INSERT gives every row the same now(): stamp them a millisecond
        // apart so entry order survives (same article on several rows, 0177).
        const now = Date.now();
        const rows = await tx
          .insert(inquiryRows)
          .values(
            input.rows.map((r, i) => ({
              createdAt: new Date(now + i),
              inquiryId: inquiry!.id,
              articleId: r.articleId,
              quantity: String(r.quantity),
              unitPrice: r.unitPrice !== undefined ? String(r.unitPrice) : null,
              unitId: r.unitId,
              unitFactor: r.unitFactor !== null ? String(r.unitFactor) : null,
              moOperationId: r.moOperationId,
              routingOperationId: r.routingOperationId,
              setupPrice: r.setupPrice !== null ? String(r.setupPrice) : null,
            }))
          )
          .returning();
        return { inquiry: inquiry!, rows };
      });
    },

    async listInquiries(query: ListInquiriesQuery) {
      const conditions = [];
      if (query.search) {
        const pattern = ilikePattern(query.search);
        conditions.push(or(ilike(inquiries.inquiryNumber, pattern), ilike(suppliers.name, pattern)));
      }
      if (query.status) conditions.push(inArray(inquiries.status, query.status));
      const where = conditions.length > 0 ? and(...conditions) : undefined;

      const [rows, totalRows] = await Promise.all([
        db
          .select({ ...getTableColumns(inquiries), supplierName: suppliers.name })
          .from(inquiries)
          .innerJoin(suppliers, eq(suppliers.id, inquiries.supplierId))
          .where(where)
          .orderBy(desc(inquiries.inquiryNumber))
          .limit(query.limit)
          .offset(query.offset),
        db
          .select({ total: count() })
          .from(inquiries)
          .innerJoin(suppliers, eq(suppliers.id, inquiries.supplierId))
          .where(where),
      ]);
      return { rows, total: totalRows[0]!.total };
    },

    async findInquiryById(id: string) {
      const [row] = await db
        .select({
          ...getTableColumns(inquiries),
          supplierName: suppliers.name,
          // Språk (#7): the language the inquiry PDF is printed in (live).
          supplierLanguage: suppliers.language,
          // The inquiry has no currency of its own — the supplier's, live
          // (as Gör till inköpsorder reads it); the row form needs it for the
          // lego ställpris default, which is kronor on the operation.
          supplierCurrency: suppliers.currency,
          purchaseOrderNumber: purchaseOrders.orderNumber,
          deliveryTermCode: deliveryTerms.code,
          deliveryTermName: deliveryTerms.name,
          deliveryTermNameEn: deliveryTerms.nameEn,
          paymentTermCode: paymentTerms.code,
          paymentTermName: paymentTerms.name,
          paymentTermNameEn: paymentTerms.nameEn,
          carrierCode: carriers.code,
          carrierName: carriers.name,
        })
        .from(inquiries)
        .innerJoin(suppliers, eq(suppliers.id, inquiries.supplierId))
        .leftJoin(purchaseOrders, eq(purchaseOrders.id, inquiries.purchaseOrderId))
        .leftJoin(deliveryTerms, eq(deliveryTerms.id, inquiries.deliveryTermId))
        .leftJoin(paymentTerms, eq(paymentTerms.id, inquiries.paymentTermId))
        .leftJoin(carriers, eq(carriers.id, inquiries.carrierId))
        .where(eq(inquiries.id, id));
      return row ?? null;
    },

    async updateInquiryHeader(id: string, input: UpdateInquiryHeaderInput) {
      const [row] = await db
        .update(inquiries)
        .set({ ...input, updatedAt: new Date() })
        .where(eq(inquiries.id, id))
        .returning();
      return row ?? null;
    },

    async listInquiryRows(inquiryId: string) {
      const rowUnits = alias(units, "row_units");
      return db
        .select({
          ...getTableColumns(inquiryRows),
          articleNumber: articles.articleNumber,
          articleName: articles.name,
          // The unit the row displays in: the entered unit, falling back to
          // the article's base unit.
          unitCode: sql<string>`coalesce(${rowUnits.code}, ${units.code})`,
          // Dokument på engelska (#7): the display unit's English code — the
          // row's own unit when it has one (NOT a coalesce across the two
          // units: a row unit without code_en must not borrow the base unit's).
          unitCodeEn: sql<string | null>`case when ${rowUnits.id} is null then ${units.codeEn} else ${rowUnits.codeEn} end`,
          // Printed under the row on the RFQ (lego rows only).
          articleWeight: articles.weight,
          articleSurfaceTreatment: articles.surfaceTreatment,
          articleColour: articles.colour,
          articleExtraDescription: articles.extraDescription,
          articleNameEn: articles.nameEn,
          articleExtraDescriptionEn: articles.extraDescriptionEn,
          // Lego row context — the operation heading comes from the MO
          // snapshot when the row was raised for a TO, else live from the
          // article's routing (TO-less price inquiry).
          moOrderNumber: manufacturingOrders.orderNumber,
          legoSequenceNo: sql<number | null>`coalesce(${moOperations.sequenceNo}, ${routingOperations.sequenceNo})`,
          legoDescription: sql<string | null>`coalesce(${moOperations.description}, ${routingOperations.description})`,
          legoShowNetWeight: sql<boolean | null>`coalesce(${moOperations.showNetWeight}, ${routingOperations.showNetWeight})`,
          useArticleDrawing: routingOperations.useArticleDrawing,
        })
        .from(inquiryRows)
        .innerJoin(articles, eq(articles.id, inquiryRows.articleId))
        .innerJoin(units, eq(units.id, articles.unitId))
        .leftJoin(rowUnits, eq(rowUnits.id, inquiryRows.unitId))
        .leftJoin(moOperations, eq(moOperations.id, inquiryRows.moOperationId))
        .leftJoin(manufacturingOrders, eq(manufacturingOrders.id, moOperations.manufacturingOrderId))
        .leftJoin(routingOperations, eq(routingOperations.id, inquiryRows.routingOperationId))
        .where(eq(inquiryRows.inquiryId, inquiryId))
        // Same article on several rows (0177): entry order within an article.
        .orderBy(asc(articles.articleNumber), asc(inquiryRows.createdAt), asc(inquiryRows.id));
    },

    // Validates a lego link before a row is written (service: article must
    // match, resource must be subcontract) and lends the row its defaults.
    async resolveLegoOperationRef(ref: {
      moOperationId?: string;
      routingOperationId?: string;
    }): Promise<LegoOperationRef | null> {
      if (ref.moOperationId) {
        const [row] = await db
          .select({
            moOperationId: moOperations.id,
            routingOperationId: moOperations.routingOperationId,
            articleId: manufacturingOrders.articleId,
            workCenterType: workCenters.type,
            // Ställpris + Transportkostnad — the IO row's one-off.
            setupPrice: legoOneOffSql(moOperations),
            supplierId: moOperations.subcontractSupplierId,
            moOperationStatus: moOperations.status,
            manufacturingOrderStatus: manufacturingOrders.status,
          })
          .from(moOperations)
          .innerJoin(manufacturingOrders, eq(manufacturingOrders.id, moOperations.manufacturingOrderId))
          .innerJoin(workCenters, eq(workCenters.id, moOperations.workCenterId))
          .where(eq(moOperations.id, ref.moOperationId));
        return row ?? null;
      }
      if (ref.routingOperationId) {
        const [row] = await db
          .select({
            routingOperationId: routingOperations.id,
            articleId: routingOperations.articleId,
            workCenterType: workCenters.type,
            setupPrice: legoOneOffSql(routingOperations),
            supplierId: routingOperations.subcontractSupplierId,
          })
          .from(routingOperations)
          .innerJoin(workCenters, eq(workCenters.id, routingOperations.workCenterId))
          .where(eq(routingOperations.id, ref.routingOperationId));
        return row ? { moOperationId: null, ...row } : null;
      }
      return null;
    },

    async addInquiryRow(inquiryId: string, input: LegoInquiryRowInput) {
      const [row] = await db
        .insert(inquiryRows)
        .values({
          inquiryId,
          articleId: input.articleId,
          quantity: String(input.quantity),
          unitPrice: input.unitPrice !== undefined ? String(input.unitPrice) : null,
          unitId: input.unitId,
          unitFactor: input.unitFactor !== null ? String(input.unitFactor) : null,
          moOperationId: input.moOperationId,
          routingOperationId: input.routingOperationId,
          setupPrice: input.setupPrice !== null ? String(input.setupPrice) : null,
        })
        .returning();
      return row!;
    },

    async findInquiryRow(inquiryId: string, rowId: string) {
      const [row] = await db
        .select()
        .from(inquiryRows)
        .where(and(eq(inquiryRows.id, rowId), eq(inquiryRows.inquiryId, inquiryId)));
      return row ?? null;
    },

    // Scoped to the inquiry so a row id from another inquiry 404s.
    async updateInquiryRow(
      inquiryId: string,
      rowId: string,
      input: Omit<UpdateInquiryRowInput, "unitId"> & Partial<UnitSnapshot>
    ) {
      const patch: {
        quantity?: string;
        unitPrice?: string | null;
        unitId?: string | null;
        unitFactor?: string | null;
        setupPrice?: string | null;
      } = {};
      if (input.quantity !== undefined) patch.quantity = String(input.quantity);
      if (input.unitPrice !== undefined) patch.unitPrice = input.unitPrice === null ? null : String(input.unitPrice);
      if (input.setupPrice !== undefined) patch.setupPrice = input.setupPrice === null ? null : String(input.setupPrice);
      if (input.unitId !== undefined) patch.unitId = input.unitId;
      if (input.unitFactor !== undefined) patch.unitFactor = input.unitFactor !== null ? String(input.unitFactor) : null;
      const [row] = await db
        .update(inquiryRows)
        .set(patch)
        .where(and(eq(inquiryRows.id, rowId), eq(inquiryRows.inquiryId, inquiryId)))
        .returning();
      return row ?? null;
    },

    async deleteInquiryRow(inquiryId: string, rowId: string) {
      const [row] = await db
        .delete(inquiryRows)
        .where(and(eq(inquiryRows.id, rowId), eq(inquiryRows.inquiryId, inquiryId)))
        .returning();
      return row ?? null;
    },

    // fromStatuses: only from one of those — null when the inquiry has moved
    // on since the service read it (the same rule as updateStatus).
    async updateInquiryStatus(id: string, status: InquiryStatus, fromStatuses?: readonly InquiryStatus[]) {
      const [row] = await db
        .update(inquiries)
        .set({ status, updatedAt: new Date() })
        .where(
          fromStatuses ? and(eq(inquiries.id, id), inArray(inquiries.status, [...fromStatuses])) : eq(inquiries.id, id)
        )
        .returning();
      return row ?? null;
    },

    // Converts the inquiry into a fresh purchase order in one transaction:
    // new IO number, currency snapshotted from the supplier, rows copied
    // (unanswered prices become 0), inquiry marked ordered + linked.
    // The inquiry is locked and its status checked under the lock — two
    // concurrent conversions would otherwise both pass the service's unlocked
    // read and create an order each. `money` is the currency and its rate,
    // resolved by the service before the transaction (the rate lookup may
    // call Riksbanken).
    async convertInquiryToOrder(
      inquiryId: string,
      createdBy: string,
      money: { currency: string; exchangeRate: number }
    ): Promise<ConvertInquiryResult> {
      return db.transaction(async (tx): Promise<ConvertInquiryResult> => {
        const [inquiry] = await tx.select().from(inquiries).where(eq(inquiries.id, inquiryId)).for("update");
        if (!inquiry) return { ok: false, reason: "inquiry_not_found" };
        if (inquiry.status !== "sent" && inquiry.status !== "answered") {
          return { ok: false, reason: "invalid_status", status: inquiry.status };
        }

        // Leverantörens förval: the inquiry's own Frakt på vårt konto wins
        // (it started from the förval and may have been changed there); Er
        // referens is the huvudkontakt — an inquiry has no reference.
        const defaults = resolveOrderDefaults(await loadSupplierOrderDefaults(tx, inquiry.supplierId), {
          freightPaidByUs: inquiry.freightPaidByUs,
        });
        const orderNumber = await getNextOrderNumber(tx, "purchase_order");
        const [order] = await tx
          .insert(purchaseOrders)
          .values({
            orderNumber,
            supplierId: inquiry.supplierId,
            expectedDeliveryDate: inquiry.expectedDeliveryDate,
            note: inquiry.note,
            yourReference: defaults.yourReference,
            currency: money.currency,
            exchangeRate: String(money.exchangeRate),
            deliveryTermId: inquiry.deliveryTermId,
            paymentTermId: inquiry.paymentTermId,
            carrierId: inquiry.carrierId,
            freightPaidByUs: defaults.freightPaidByUs,
            createdBy,
          })
          .returning();

        // The inquiry's entry order carries over to the order, a millisecond
        // apart like createInquiry (one INSERT shares now()).
        const rows = await tx
          .select()
          .from(inquiryRows)
          .where(eq(inquiryRows.inquiryId, inquiryId))
          .orderBy(asc(inquiryRows.createdAt), asc(inquiryRows.id));
        if (rows.length > 0) {
          const now = Date.now();
          await tx.insert(purchaseOrderRows).values(
            rows.map((r, i) => ({
              createdAt: new Date(now + i),
              purchaseOrderId: order!.id,
              articleId: r.articleId,
              quantityOrdered: r.quantity,
              unitPrice: r.unitPrice ?? "0",
              unitId: r.unitId,
              unitFactor: r.unitFactor,
              // Lego: the TO operation follows the row so goods receipt
              // auto-reports it. A TO-less lego row (routing operation only)
              // becomes a plain PO row with its ställpris — PO rows carry no
              // routing link, so nothing is reported at receipt.
              moOperationId: r.moOperationId,
              setupPrice: r.setupPrice,
            }))
          );
        }

        await tx
          .update(inquiries)
          .set({ status: "ordered", purchaseOrderId: order!.id, updatedAt: new Date() })
          .where(eq(inquiries.id, inquiryId));

        // Tillägg: a purchase order made from an inquiry is created too.
        await pluginEvents.emit(tx, { type: "purchase_order.created", entityId: order!.id, entityNumber: order!.orderNumber });
        return { ok: true, order: order! };
      });
    },

    // `inTx` runs last inside the create transaction (Avvikelser: the case
    // link of Skapa inköpsorder).
    async createPurchaseOrder(
      input: CreatePurchaseOrderInput,
      createdBy: string,
      currency: string,
      inTx?: (tx: Tx, orderId: string) => Promise<unknown>
    ) {
      return db.transaction(async (tx) => {
        // Terms snapshotted from the supplier at creation, like currency.
        const [supplier] = await tx.select().from(suppliers).where(eq(suppliers.id, input.supplierId));
        // Leverantörens förval (Frakt på vårt konto, Er referens = the
        // huvudkontakt) — an explicit value in the call wins. Every way of
        // creating an order from scratch ends here.
        const defaults = resolveOrderDefaults(await loadSupplierOrderDefaults(tx, input.supplierId), input);
        const orderNumber = await getNextOrderNumber(tx, "purchase_order");
        const [row] = await tx
          .insert(purchaseOrders)
          .values({
            orderNumber,
            supplierId: input.supplierId,
            expectedDeliveryDate: input.expectedDeliveryDate,
            note: input.note,
            yourReference: defaults.yourReference,
            freightPaidByUs: defaults.freightPaidByUs,
            ourReference: input.ourReference,
            // Projekt (kostnadsställen och projekt) — validated by the service.
            projectId: input.projectId ?? null,
            currency,
            exchangeRate: String(input.exchangeRate ?? 1),
            deliveryTermId: supplier?.deliveryTermId ?? null,
            paymentTermId: supplier?.paymentTermId ?? null,
            carrierId: supplier?.carrierId ?? null,
            createdBy,
          })
          .returning();
        // Tillägg: purchase_order.created, with the order.
        await pluginEvents.emit(tx, { type: "purchase_order.created", entityId: row!.id, entityNumber: row!.orderNumber });
        if (inTx) await inTx(tx, row!.id);
        return row!;
      });
    },

    async findPurchaseOrderById(id: string) {
      const [row] = await db
        .select({
          ...getTableColumns(purchaseOrders),
          supplierName: suppliers.name,
          // Språk (#7): the language the purchase order PDF is printed in (live).
          supplierLanguage: suppliers.language,
          deliveryTermCode: deliveryTerms.code,
          deliveryTermName: deliveryTerms.name,
          deliveryTermNameEn: deliveryTerms.nameEn,
          paymentTermCode: paymentTerms.code,
          paymentTermName: paymentTerms.name,
          paymentTermNameEn: paymentTerms.nameEn,
          carrierCode: carriers.code,
          carrierName: carriers.name,
          // Projekt (kostnadsställen och projekt) for the card.
          project: { id: projects.id, code: projects.code, name: projects.name },
        })
        .from(purchaseOrders)
        .innerJoin(suppliers, eq(suppliers.id, purchaseOrders.supplierId))
        .leftJoin(deliveryTerms, eq(deliveryTerms.id, purchaseOrders.deliveryTermId))
        .leftJoin(paymentTerms, eq(paymentTerms.id, purchaseOrders.paymentTermId))
        .leftJoin(carriers, eq(carriers.id, purchaseOrders.carrierId))
        .leftJoin(projects, eq(projects.id, purchaseOrders.projectId))
        .where(eq(purchaseOrders.id, id));
      return row ?? null;
    },

    // Kostnadsställen och projekt: the one dimension rule (dimension-check.ts)
    // through this repository's connection.
    async resolveDimensions(input: DimensionInput, opts: ResolveDimensionsOptions = {}) {
      return resolveDimensions(db, input, opts);
    },

    async updatePurchaseOrderHeader(id: string, input: UpdatePurchaseOrderHeaderInput) {
      // bumpRevision is a directive, not a column — strip it before the spread.
      const { bumpRevision, deliveryAddress, ...fields } = input;
      // Leveransadress: an object writes the five snapshot columns, null
      // clears them all (the company's address again), omitted keeps them.
      const addressColumns =
        deliveryAddress === undefined
          ? {}
          : {
              deliveryName: deliveryAddress?.name ?? null,
              deliveryAddress: deliveryAddress?.address ?? null,
              deliveryPostalCode: deliveryAddress?.postalCode ?? null,
              deliveryCity: deliveryAddress?.city ?? null,
              deliveryCountry: deliveryAddress?.country ?? null,
            };
      const [row] = await db
        .update(purchaseOrders)
        .set({
          ...fields,
          ...addressColumns,
          // The numeric column wants a string; undefined keeps the current value.
          exchangeRate: fields.exchangeRate === undefined ? undefined : String(fields.exchangeRate),
          revision: bumpRevision !== false ? sql`${purchaseOrders.revision} + 1` : undefined,
          updatedAt: new Date(),
        })
        .where(eq(purchaseOrders.id, id))
        .returning();
      return row ?? null;
    },

    // `today` (Stockholm) dates the status filter Sen (late-orders.ts).
    async listPurchaseOrders(query: ListPurchaseOrdersQuery, today: string) {
      // Nästa leveransdatum: the earliest effective arrival date among rows
      // not fully received (a confirmation always wins over a requested
      // date), else the order's own — so one early row shows the order late.
      // Also the deliveryTo filter's and sort=delivery's date.
      const nextDeliveryDateSql = sql<string | null>`coalesce((select min(coalesce(r.confirmed_delivery_date, ${purchaseOrders.confirmedDeliveryDate}, r.expected_delivery_date, ${purchaseOrders.expectedDeliveryDate})) from ${purchaseOrderRows} r where r.purchase_order_id = ${purchaseOrders}.id and r.quantity_received < r.quantity_ordered), ${purchaseOrders.confirmedDeliveryDate}, ${purchaseOrders.expectedDeliveryDate})`;
      const conditions = [];
      if (query.search) {
        const pattern = ilikePattern(query.search);
        // Also matches on the order's own rows — an article number/name, not
        // just the order number/supplier — since a delivery note usually
        // shows the supplier's articles, not our IO number.
        conditions.push(
          or(
            ilike(purchaseOrders.orderNumber, pattern),
            ilike(suppliers.name, pattern),
            exists(
              db
                .select({ one: sql`1` })
                .from(purchaseOrderRows)
                .innerJoin(articles, eq(articles.id, purchaseOrderRows.articleId))
                .where(
                  and(
                    eq(purchaseOrderRows.purchaseOrderId, purchaseOrders.id),
                    or(ilike(articles.articleNumber, pattern), ilike(articles.name, pattern))
                  )
                )
            )
          )
        );
      }
      const { statuses, late } = splitLateFilter(query.status);
      if (statuses) conditions.push(inArray(purchaseOrders.status, statuses));
      if (late) conditions.push(purchaseOrderLate(today));
      if (query.supplierId) conditions.push(eq(purchaseOrders.supplierId, query.supplierId));
      if (query.kind) {
        const hasLegoRow = exists(
          db
            .select({ one: sql`1` })
            .from(purchaseOrderRows)
            .where(and(eq(purchaseOrderRows.purchaseOrderId, purchaseOrders.id), isNotNull(purchaseOrderRows.moOperationId)))
        );
        conditions.push(query.kind === "lego" ? hasLegoRow : not(hasLegoRow));
      }
      if (query.openArticleId) {
        conditions.push(
          exists(
            db
              .select({ one: sql`1` })
              .from(purchaseOrderRows)
              .where(
                and(
                  eq(purchaseOrderRows.purchaseOrderId, purchaseOrders.id),
                  eq(purchaseOrderRows.articleId, query.openArticleId),
                  lt(purchaseOrderRows.quantityReceived, purchaseOrderRows.quantityOrdered)
                )
              )
          )
        );
      }
      if (query.deliveryTo) conditions.push(sql`${nextDeliveryDateSql} <= ${query.deliveryTo}::date`);
      const where = conditions.length > 0 ? and(...conditions) : undefined;

      // Correlated-subquery shape as listPriceLists' rowCount — opt-in
      // (withOpenRows) so the plain register list doesn't pay for it.
      const openRowCountSql = sql<number>`(select count(*)::int from ${purchaseOrderRows} r where r.purchase_order_id = ${purchaseOrders}.id and r.quantity_received < r.quantity_ordered)`;

      const [rows, totalRows] = await Promise.all([
        db
          .select({
            ...getTableColumns(purchaseOrders),
            supplierName: suppliers.name,
            nextDeliveryDate: nextDeliveryDateSql,
            ...(query.withOpenRows ? { openRowCount: openRowCountSql } : {}),
          })
          .from(purchaseOrders)
          .innerJoin(suppliers, eq(suppliers.id, purchaseOrders.supplierId))
          .where(where)
          .orderBy(
            ...(query.sort === "delivery"
              ? [sql`${nextDeliveryDateSql} asc nulls last`, asc(purchaseOrders.orderNumber)]
              : [desc(purchaseOrders.orderNumber)])
          )
          .limit(query.limit)
          .offset(query.offset),
        db
          .select({ total: count() })
          .from(purchaseOrders)
          .innerJoin(suppliers, eq(suppliers.id, purchaseOrders.supplierId))
          .where(where),
      ]);
      return { rows, total: totalRows[0]!.total };
    },

    // fromStatuses: only from one of those (null when the order has moved
    // on) — Makulera, which must not overwrite a receipt that committed
    // between its check and this UPDATE (the UPDATE waits for the receipt's
    // order lock and then re-checks the WHERE).
    async updateStatus(id: string, status: PurchaseOrderStatus, fromStatuses?: readonly PurchaseOrderStatus[]) {
      const [row] = await db
        .update(purchaseOrders)
        .set({ status, updatedAt: new Date() })
        .where(
          fromStatuses
            ? and(eq(purchaseOrders.id, id), inArray(purchaseOrders.status, [...fromStatuses]))
            : eq(purchaseOrders.id, id)
        )
        .returning();
      return row ?? null;
    },

    // Throws PurchaseOrderNotEditableError when the order is no longer in a
    // row-editable status (checked under its lock: a receipt that completed
    // the order, or a Stäng/Makulera, may have committed since the service
    // read it).
    async addRow(purchaseOrderId: string, input: CreatePurchaseOrderRowInput & UnitSnapshot) {
      return db.transaction(async (tx) => {
        const status = await lockOrderStatus(tx, purchaseOrderId);
        if (status === null || !ROW_EDITABLE_STATUSES.includes(status)) throw new PurchaseOrderNotEditableError(status);
        const [row] = await tx
          .insert(purchaseOrderRows)
          .values({
            purchaseOrderId,
            articleId: input.articleId,
            quantityOrdered: String(input.quantity),
            unitPrice: String(input.unitPrice),
            unitId: input.unitId,
            unitFactor: input.unitFactor !== null ? String(input.unitFactor) : null,
            // Lego (subcontract) row: the MO operation this row buys, plus a
            // one-off ställpris added once to the row amount.
            moOperationId: input.moOperationId ?? null,
            setupPrice: input.setupPrice != null ? String(input.setupPrice) : null,
            // null = the row follows the order's Önskat leveransdatum.
            expectedDeliveryDate: input.expectedDeliveryDate ?? null,
            // null = the row follows the order's Bekräftat leveransdatum.
            confirmedDeliveryDate: input.confirmedDeliveryDate ?? null,
          })
          .returning();
        if (input.bumpRevision !== false) await bumpRevision(tx, purchaseOrderId);
        return row!;
      });
    },

    async findRowById(rowId: string) {
      const [row] = await db.select().from(purchaseOrderRows).where(eq(purchaseOrderRows.id, rowId));
      return row ?? null;
    },

    // Atomic like receiveGoods: locks the row so a concurrent receipt can't
    // slip past the quantity-vs-received guard, then recomputes the order
    // status — lowering a quantity to exactly what's received can complete
    // a partially received order.
    async updateRow(
      orderId: string,
      rowId: string,
      patch: Omit<UpdatePurchaseOrderRowInput, "unitId" | "bumpRevision"> & Partial<UnitSnapshot>,
      bump = true
    ): Promise<PurchaseRowMutationResult> {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(purchaseOrderRows)
          .where(and(eq(purchaseOrderRows.id, rowId), eq(purchaseOrderRows.purchaseOrderId, orderId)))
          .for("update");
        if (!row) return { ok: false, reason: "row_not_found" };
        // The status again, under the order lock (row → order).
        const status = await lockOrderStatus(tx, orderId);
        if (status === null || !ROW_EDITABLE_STATUSES.includes(status)) {
          return { ok: false, reason: "invalid_status", status: status ?? "cancelled" };
        }
        if (patch.quantity !== undefined && patch.quantity < Number(row.quantityReceived)) {
          return { ok: false, reason: "quantity_below_received" };
        }

        const set: {
          quantityOrdered?: string;
          unitPrice?: string;
          unitId?: string | null;
          unitFactor?: string | null;
          setupPrice?: string | null;
          expectedDeliveryDate?: string | null;
          confirmedDeliveryDate?: string | null;
        } = {};
        if (patch.quantity !== undefined) set.quantityOrdered = String(patch.quantity);
        if (patch.unitPrice !== undefined) set.unitPrice = String(patch.unitPrice);
        if (patch.unitId !== undefined) set.unitId = patch.unitId;
        if (patch.unitFactor !== undefined) set.unitFactor = patch.unitFactor !== null ? String(patch.unitFactor) : null;
        if (patch.setupPrice !== undefined) set.setupPrice = patch.setupPrice !== null ? String(patch.setupPrice) : null;
        if (patch.expectedDeliveryDate !== undefined) set.expectedDeliveryDate = patch.expectedDeliveryDate;
        if (patch.confirmedDeliveryDate !== undefined) set.confirmedDeliveryDate = patch.confirmedDeliveryDate;
        const [updated] = await tx.update(purchaseOrderRows).set(set).where(eq(purchaseOrderRows.id, rowId)).returning();

        if (bump) await bumpRevision(tx, orderId);
        const orderStatus = await recomputePartiallyReceived(tx, orderId);
        return { ok: true, row: updated!, orderStatus };
      });
    },

    async deleteRow(orderId: string, rowId: string, bump = true): Promise<PurchaseRowMutationResult> {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(purchaseOrderRows)
          .where(and(eq(purchaseOrderRows.id, rowId), eq(purchaseOrderRows.purchaseOrderId, orderId)))
          .for("update");
        if (!row) return { ok: false, reason: "row_not_found" };
        // The status again, under the order lock (row → order).
        const status = await lockOrderStatus(tx, orderId);
        if (status === null || !ROW_EDITABLE_STATUSES.includes(status)) {
          return { ok: false, reason: "invalid_status", status: status ?? "cancelled" };
        }
        if (Number(row.quantityReceived) > 0) return { ok: false, reason: "row_has_receipts" };
        // Avsändning lego: a row with a live dispatch stays (undo the
        // dispatch first). Undone dispatches are history only — their rows
        // go with the IO row, and a dispatch left without rows goes too (the
        // FK is restrict as a safety net).
        const dispatchRows = await tx
          .select({ id: purchaseOrderDispatchRows.id, dispatchId: purchaseOrderDispatchRows.dispatchId, undoneAt: purchaseOrderDispatches.undoneAt })
          .from(purchaseOrderDispatchRows)
          .innerJoin(purchaseOrderDispatches, eq(purchaseOrderDispatches.id, purchaseOrderDispatchRows.dispatchId))
          .where(eq(purchaseOrderDispatchRows.purchaseOrderRowId, rowId));
        if (dispatchRows.some((d) => d.undoneAt === null)) return { ok: false, reason: "row_has_dispatches" };
        if (dispatchRows.length > 0) {
          await tx.delete(purchaseOrderDispatchRows).where(eq(purchaseOrderDispatchRows.purchaseOrderRowId, rowId));
          const dispatchIds = [...new Set(dispatchRows.map((d) => d.dispatchId))];
          await tx.delete(purchaseOrderDispatches).where(
            and(
              inArray(purchaseOrderDispatches.id, dispatchIds),
              not(exists(tx.select({ one: sql`1` }).from(purchaseOrderDispatchRows).where(eq(purchaseOrderDispatchRows.dispatchId, purchaseOrderDispatches.id))))
            )
          );
        }

        await tx.delete(purchaseOrderRows).where(eq(purchaseOrderRows.id, rowId));

        if (bump) await bumpRevision(tx, orderId);
        const orderStatus = await recomputePartiallyReceived(tx, orderId);
        return { ok: true, row: null, orderStatus };
      });
    },

    async listRowsByOrder(purchaseOrderId: string) {
      const rowUnits = alias(units, "row_units");
      return db
        .select({
          ...getTableColumns(purchaseOrderRows),
          articleNumber: articles.articleNumber,
          articleName: articles.name,
          // A tjänst has nothing to scan — Inleverans leaves it out of the
          // counting (skanning, #4).
          articleType: articles.type,
          // Batch (#8): Inleverans shows the Batch field for a batchstyrd article.
          articleBatchTracked: batchTrackedSql(),
          articleTracking: articles.tracking,
          // Skickat (avsändning lego): derived, base unit like quantityReceived.
          quantityDispatched: dispatchedQuantitySql(),
          // The unit the row displays in: the entered unit, falling back to
          // the article's base unit.
          unitCode: sql<string>`coalesce(${rowUnits.code}, ${units.code})`,
          // Dokument på engelska (#7): the display unit's English code — the
          // row's own unit when it has one (NOT a coalesce across the two
          // units: a row unit without code_en must not borrow the base unit's).
          unitCodeEn: sql<string | null>`case when ${rowUnits.id} is null then ${units.codeEn} else ${rowUnits.codeEn} end`,
          // Lego row context: the TO the operation belongs to (printed as
          // the row's reference), the operation's own heading, whether the
          // PDF shows net weight (weight × qty) and where the drawing comes
          // from (live routing values — same read path as the TO printout).
          articleWeight: articles.weight,
          articleSurfaceTreatment: articles.surfaceTreatment,
          articleColour: articles.colour,
          articleExtraDescription: articles.extraDescription,
          articleNameEn: articles.nameEn,
          articleExtraDescriptionEn: articles.extraDescriptionEn,
          moOrderNumber: manufacturingOrders.orderNumber,
          moOperationDescription: moOperations.description,
          moOperationSequenceNo: moOperations.sequenceNo,
          moShowNetWeight: moOperations.showNetWeight,
          moRoutingOperationId: moOperations.routingOperationId,
          useArticleDrawing: routingOperations.useArticleDrawing,
        })
        .from(purchaseOrderRows)
        .innerJoin(articles, eq(articles.id, purchaseOrderRows.articleId))
        .innerJoin(units, eq(units.id, articles.unitId))
        .leftJoin(rowUnits, eq(rowUnits.id, purchaseOrderRows.unitId))
        .leftJoin(moOperations, eq(moOperations.id, purchaseOrderRows.moOperationId))
        .leftJoin(manufacturingOrders, eq(manufacturingOrders.id, moOperations.manufacturingOrderId))
        .leftJoin(routingOperations, eq(routingOperations.id, moOperations.routingOperationId))
        .where(eq(purchaseOrderRows.purchaseOrderId, purchaseOrderId))
        // Entry order: the card, the PDF and Inleverans's scan tie-break
        // (same article on several rows, 0177) all read it.
        .orderBy(asc(purchaseOrderRows.createdAt), asc(purchaseOrderRows.id));
    },

    // The lego rows' drawings for the order email: one entry per lego row —
    // either "use the article's drawings" (resolved by the service through
    // ArticleFileReader) or the single file uploaded on the routing
    // operation, fetched with data here (an explicit fetch like
    // filesWithData, not a list query).
    // Works for a purchase order (lego rows reach the routing operation via
    // the MO snapshot) and for an inquiry (lego rows carry the routing
    // operation directly, TO or not).
    async subcontractDrawingSources(ref: { purchaseOrderId: string } | { inquiryId: string }) {
      const drawingColumns = {
        useArticleDrawing: routingOperations.useArticleDrawing,
        fileFilename: routingOperationFiles.filename,
        // Only rows that actually use the operation file get its bytes —
        // never ship a 20 MB blob just to discard it in the service.
        fileData: sql<Buffer | null>`case when ${routingOperations.useArticleDrawing} = false then ${routingOperationFiles.data} end`,
      };
      // moId + routingOperationId: which drawings and revisions the
      // "article's drawings" are (drawing-files.ts) — the TO's snapshot and
      // the operation's chosen drawings.
      if ("inquiryId" in ref) {
        return db
          .select({
            rowId: inquiryRows.id,
            articleId: inquiryRows.articleId,
            moId: moOperations.manufacturingOrderId,
            routingOperationId: inquiryRows.routingOperationId,
            ...drawingColumns,
          })
          .from(inquiryRows)
          .leftJoin(moOperations, eq(moOperations.id, inquiryRows.moOperationId))
          .leftJoin(routingOperations, eq(routingOperations.id, inquiryRows.routingOperationId))
          .leftJoin(routingOperationFiles, eq(routingOperationFiles.routingOperationId, routingOperations.id))
          .where(
            and(
              eq(inquiryRows.inquiryId, ref.inquiryId),
              or(isNotNull(inquiryRows.moOperationId), isNotNull(inquiryRows.routingOperationId))
            )
          );
      }
      return db
        .select({
          rowId: purchaseOrderRows.id,
          articleId: purchaseOrderRows.articleId,
          moId: moOperations.manufacturingOrderId,
          routingOperationId: moOperations.routingOperationId,
          ...drawingColumns,
        })
        .from(purchaseOrderRows)
        .innerJoin(moOperations, eq(moOperations.id, purchaseOrderRows.moOperationId))
        .leftJoin(routingOperations, eq(routingOperations.id, moOperations.routingOperationId))
        .leftJoin(routingOperationFiles, eq(routingOperationFiles.routingOperationId, routingOperations.id))
        .where(eq(purchaseOrderRows.purchaseOrderId, ref.purchaseOrderId));
    },

    // Atomic: locks the row, validates order status + remaining quantity,
    // records the stock movement, and recomputes the order's status — all
    // inside one transaction so concurrent receipts can't over-receive.
    // overReceiptPercent is the system setting Tillåten överleverans: the row
    // may be received up to ordered × (1 + percent/100); null = no limit.
    async receiveGoods(
      orderId: string,
      rowId: string,
      input: { locationId?: string; quantity: number; createdBy: string; overReceiptPercent: number | null; batchNumber?: string; expiresOn?: string; serialNumbers?: string[] }
    ): Promise<ReceiveGoodsResult> {
      return db.transaction(async (tx) => {
        const [order] = await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, orderId));
        if (!order) return { ok: false, reason: "order_not_found" };
        if (order.status !== "confirmed" && order.status !== "partially_received") {
          return { ok: false, reason: "invalid_status" };
        }

        const [row] = await tx
          .select()
          .from(purchaseOrderRows)
          .where(and(eq(purchaseOrderRows.id, rowId), eq(purchaseOrderRows.purchaseOrderId, orderId)))
          .for("update");
        if (!row) return { ok: false, reason: "row_not_found" };
        // The order lock (after the row, the order updateRow takes them in)
        // serialises receipts and undos on different rows of one order, so
        // the status recomputed below always sees every row's final quantity.
        // The status again, under the lock: the read above was unlocked, and a
        // Makulera (conditional on draft/confirmed) that committed meanwhile
        // must not get goods on a cancelled order.
        const [locked] = await tx
          .select({ status: purchaseOrders.status })
          .from(purchaseOrders)
          .where(eq(purchaseOrders.id, orderId))
          .for("update");
        if (!locked || (locked.status !== "confirmed" && locked.status !== "partially_received")) {
          return { ok: false, reason: "invalid_status" };
        }

        // Compared at the column's 4 decimals so float noise (0.1 + 0.2, or
        // 10 × 1.1) never rejects a receipt that lands exactly on the limit.
        const newReceived = round4(Number(row.quantityReceived) + input.quantity);
        if (input.overReceiptPercent !== null) {
          const maxQuantity = round4(Number(row.quantityOrdered) * (1 + input.overReceiptPercent / 100));
          if (newReceived > maxQuantity) return { ok: false, reason: "over_receipt", maxQuantity };
        }

        const [updatedRow] = await tx
          .update(purchaseOrderRows)
          .set({ quantityReceived: String(newReceived) })
          .where(eq(purchaseOrderRows.id, rowId))
          .returning();

        // Lego (subcontract) rows buy an OPERATION, not goods: the row's
        // article is the TO's own manufactured article, and the physical
        // units come home through the MO's final report (mo_receipt) — a
        // purchase_receipt here would double-book the same units into stock
        // (and pollute the D0 moving average with the lego price). Only the
        // PO-row bookkeeping below and the operation auto-report in the
        // service layer happen for such rows.
        // A service row (tjänst) is work, not goods: no stock movement either
        // (stocked-article.ts) — the receipt row below still records it.
        let stock: { locationId: string; stockTransactionId: string } | null = null;
        const stocked = row.moOperationId === null && (await isStockedArticle(tx, row.articleId));
        // Batch (#8): a batchstyrd article's goods are booked in the batch
        // the receipt names — the supplier's number, or the IO number when
        // none is given — created on its first inflow. A batch sent for
        // anything else (not batchstyrd, a lego or service row) is refused,
        // so an integration notices. One receipt = one batch: a row split
        // over several batches is several receipts, each undone on its own.
        // Serienummer (etapp 2, beslut 5 and 14): a serienummerstyrd article
        // whose numbers are created vid inleverans needs ONE number per styck
        // — the receipt is not booked without all of them — and each styck
        // becomes its own stock row (+1) and its own kvitto (quantity 1), so
        // a mis-scanned number is undone on its own. Created vid utleverans:
        // the article is not lagerspårad and is received as before.
        const sort = stocked ? await trackingOf(tx, row.articleId) : null;
        const batchTracked = sort !== null;
        const articleNumberOf = async () =>
          (await tx.select({ articleNumber: articles.articleNumber }).from(articles).where(eq(articles.id, row.articleId)))[0]?.articleNumber ?? row.articleId;
        if ((input.batchNumber !== undefined || input.expiresOn !== undefined) && !batchTracked) {
          throw new BatchNotTrackedError(await articleNumberOf());
        }
        if (input.serialNumbers !== undefined && sort !== "serial") throw new ArticleNotSerialTrackedError(await articleNumberOf());
        if (sort === "serial") {
          if (input.serialNumbers === undefined || input.batchNumber !== undefined) throw new SerialNumbersRequiredError(await articleNumberOf());
          if (!Number.isInteger(input.quantity)) throw new SerialQuantityNotIntegerError(await articleNumberOf(), input.quantity);
          if (input.serialNumbers.length !== input.quantity) throw new SerialCountMismatchError(input.quantity, input.serialNumbers.length);
        }
        let batch: { id: string; batchNumber: string; expiresOn: string | null } | null = null;
        let serials: { id: string; batchNumber: string }[] = [];
        // One per kvitto: the stock row it booked (none for lego/tjänst).
        let stockRows: { locationId: string; stockTransactionId: string }[] = [];
        if (stocked) {
          // unit_cost is the SEK cost per unit at receipt time: the row's
          // purchase price (already in the article's base unit) converted at
          // the order's exchange rate ("rate against SEK", defaults to "1").
          const unitCost = (Number(row.unitPrice) * Number(order.exchangeRate)).toFixed(4);

          const locationId = await resolveStockLocation(tx, row.articleId, input.locationId);
          // Once per place, not per number.
          await assertLocationNotUnderCount(tx, locationId);
          if (sort === "batch") {
            batch = await getOrCreateDatedBatch(tx, {
              articleId: row.articleId,
              batchNumber: input.batchNumber ?? order.orderNumber,
              origin: "purchase_receipt",
              purchaseOrderId: orderId,
              createdBy: input.createdBy,
              // Etapp 2: the supplier's utgångsdatum — set on a new batch,
              // filled in on one without, refused when it differs.
              expiresOn: input.expiresOn,
            });
          } else if (sort === "serial") {
            // The numbers (created when new; a number that is a batch on the
            // article, or twice in the list, is refused), then their rows
            // locked sorted on id — after the place, last in the lock order —
            // and every one proven out of stock before anything is booked.
            serials = await getOrCreateSerials(tx, {
              articleId: row.articleId,
              serialNumbers: input.serialNumbers!,
              origin: "purchase_receipt",
              purchaseOrderId: orderId,
              createdBy: input.createdBy,
              expiresOn: input.expiresOn,
            });
            await lockSerials(tx, serials.map((serial) => serial.id));
            await assertSerialsOutOfStock(tx, serials.map((serial) => serial.id));
          }

          const movements = await tx
            .insert(stockTransactions)
            .values(
              (sort === "serial" ? serials.map((serial) => ({ quantity: 1, batchId: serial.id as string | null })) : [{ quantity: input.quantity, batchId: batch?.id ?? null }]).map(
                (part) => ({
                  articleId: row.articleId,
                  locationId,
                  quantityDelta: String(part.quantity),
                  transactionType: "purchase_receipt" as const,
                  referenceId: orderId,
                  createdBy: input.createdBy,
                  unitCost,
                  batchId: part.batchId,
                })
              )
            )
            .returning({ id: stockTransactions.id, batchId: stockTransactions.batchId });
          // In the numbers' order (RETURNING is matched on the batch, never
          // trusted to keep the VALUES order).
          const movementBySerial = new Map(movements.map((movement) => [movement.batchId, movement.id]));
          stockRows =
            sort === "serial"
              ? serials.map((serial) => ({ locationId, stockTransactionId: movementBySerial.get(serial.id)! }))
              : [{ locationId, stockTransactionId: movements[0]!.id }];
        }

        // The receipt log rows Ångra inleverans reverses — one per stock row
        // (a serial number each, quantity 1), else one for the whole
        // quantity. A lego row's TO report is linked by the service once it
        // has been made.
        const receipts = await tx
          .insert(purchaseReceipts)
          .values(
            (stockRows.length > 0 ? stockRows : [null]).map((stock) => ({
              purchaseOrderId: orderId,
              purchaseOrderRowId: rowId,
              quantity: sort === "serial" ? "1" : String(input.quantity),
              locationId: stock?.locationId ?? null,
              stockTransactionId: stock?.stockTransactionId ?? null,
              createdBy: input.createdBy,
            }))
          )
          .returning({ id: purchaseReceipts.id, stockTransactionId: purchaseReceipts.stockTransactionId });
        const receiptByStockRow = new Map(receipts.map((r) => [r.stockTransactionId, r.id]));
        const receiptIds = stockRows.length > 0 ? stockRows.map((stock) => receiptByStockRow.get(stock.stockTransactionId)!) : [receipts[0]!.id];
        const receipt = { id: receiptIds[0]! };

        const orderStatus = await recomputeReceiptStatus(tx, orderId);
        // Tillägg: one event per received row, on the order — once for the
        // whole quantity, whatever the number of kvitton.
        await pluginEvents.emit(tx, {
          type: "purchase_order.received",
          entityId: orderId,
          entityNumber: order.orderNumber,
          data: { receiptId: receipt.id, rowId },
        });
        return {
          ok: true,
          row: updatedRow!,
          orderStatus,
          receiptId: receipt.id,
          receiptIds,
          batchNumber: batch?.batchNumber ?? null,
          expiresOn: batch?.expiresOn ?? null,
          serialNumbers: serials.map((serial) => serial.batchNumber),
        };
      });
    },

    // Inleveranser on the IO card, newest first — undone ones included.
    async listReceipts(orderId: string) {
      const undoer = alias(users, "undoer");
      return db
        .select({
          id: purchaseReceipts.id,
          purchaseOrderRowId: purchaseReceipts.purchaseOrderRowId,
          quantity: purchaseReceipts.quantity,
          locationName: stockLocations.name,
          moReportId: purchaseReceipts.moReportId,
          createdAt: purchaseReceipts.createdAt,
          createdByName: users.name,
          undoneAt: purchaseReceipts.undoneAt,
          undoneByName: undoer.name,
          // Batch (#8): read through the receipt's own stock row — the log is
          // append-only, so the link never drifts (null = Okänd / no stock row).
          batchNumber: stockBatches.batchNumber,
          // batch | serial (0215): a serial number's kvitto is one styck.
          batchKind: stockBatches.kind,
          // Etapp 2: the batch's utgångsdatum now (null = none).
          expiresOn: stockBatches.expiresOn,
        })
        .from(purchaseReceipts)
        .leftJoin(stockTransactions, eq(stockTransactions.id, purchaseReceipts.stockTransactionId))
        .leftJoin(stockBatches, eq(stockBatches.id, stockTransactions.batchId))
        .leftJoin(stockLocations, eq(stockLocations.id, purchaseReceipts.locationId))
        .leftJoin(users, eq(users.id, purchaseReceipts.createdBy))
        .leftJoin(undoer, eq(undoer.id, purchaseReceipts.undoneBy))
        .where(eq(purchaseReceipts.purchaseOrderId, orderId))
        .orderBy(desc(purchaseReceipts.createdAt), desc(purchaseReceipts.id));
    },

    // Ångra inleverans: reverses exactly what one receipt booked, in one
    // transaction — the goods go back out of the location they were received
    // to (refused when they are no longer there), the row's received quantity
    // drops and the order status is re-derived from what remains. A lego
    // receipt's TO report is undone inside the SAME transaction by
    // `undoLinkedReport` (the manufacturing side, which throws its own domain
    // errors and so rolls the whole undo back). Lock order: receipt → row →
    // order, the row → order order receiveGoods and updateRow take; the TO
    // report's own locks follow (receiveGoods reports the operation only after its own
    // transaction has committed, so the two never wait on each other).
    async undoReceipt(
      orderId: string,
      receiptId: string,
      input: { undoneBy: string; undoLinkedReport: (tx: Tx, moReportId: string) => Promise<void> }
    ): Promise<UndoReceiptResult> {
      return db.transaction(async (tx) => {
        const [receipt] = await tx
          .select()
          .from(purchaseReceipts)
          .where(and(eq(purchaseReceipts.id, receiptId), eq(purchaseReceipts.purchaseOrderId, orderId)))
          .for("update");
        if (!receipt) return { ok: false, reason: "receipt_not_found" };
        if (receipt.undoneAt) return { ok: false, reason: "already_undone" };
        // Only an undone receipt outlives its row (migration 0208), so a live
        // one always has it.
        if (!receipt.purchaseOrderRowId) return { ok: false, reason: "receipt_not_found" };

        const [row] = await tx
          .select()
          .from(purchaseOrderRows)
          .where(eq(purchaseOrderRows.id, receipt.purchaseOrderRowId))
          .for("update");
        if (!row) return { ok: false, reason: "receipt_not_found" };

        const [order] = await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, orderId)).for("update");
        // A closed order is finished business — and a received/partially
        // received one is the only kind a live receipt can sit on.
        if (!order || (order.status !== "partially_received" && order.status !== "received")) {
          return { ok: false, reason: "invalid_status" };
        }

        const quantity = Number(receipt.quantity);
        if (receipt.stockTransactionId && receipt.locationId) {
          // An outflow: the article lock every draw takes, before the
          // "still in stock" check — a delivery drawing the same goods
          // waits, instead of both passing and the place going negative.
          await lockArticlesForOutflow(tx, [row.articleId]);
          const [balance] = await tx
            .select({ quantity: sql<string>`coalesce(sum(${stockTransactions.quantityDelta}), 0)` })
            .from(stockTransactions)
            .where(and(eq(stockTransactions.articleId, row.articleId), eq(stockTransactions.locationId, receipt.locationId)));
          // Batch (#8): the goods go back out of the SAME batch the receipt
          // booked them in — read from its stock row, whatever the article's
          // flag says now (null = Okänd). With a batch on the row, or on an
          // article that is batchstyrd now, they must still be in that CELL
          // too: the place may hold enough in total while this batch is gone.
          const [booked] = await tx
            .select({ batchId: stockTransactions.batchId })
            .from(stockTransactions)
            .where(eq(stockTransactions.id, receipt.stockTransactionId));
          const batchId = booked?.batchId ?? null;
          let available = Number(balance?.quantity ?? 0);
          if (batchId !== null || (await isTrackedArticle(tx, row.articleId))) {
            available = Math.min(available, await batchCellQuantity(tx, row.articleId, receipt.locationId, batchId));
          }
          if (available < quantity) return { ok: false, reason: "insufficient_stock", available, required: quantity };
          await assertLocationNotUnderCount(tx, receipt.locationId);
          // An outflow: no unit_cost (D0) — it leaves at the moving average.
          await tx.insert(stockTransactions).values({
            articleId: row.articleId,
            locationId: receipt.locationId,
            quantityDelta: String(-quantity),
            transactionType: "purchase_receipt",
            referenceId: orderId,
            createdBy: input.undoneBy,
            batchId,
          });
          await deactivateEmptyLocation(tx, receipt.locationId);
        }

        if (receipt.moReportId) await input.undoLinkedReport(tx, receipt.moReportId);

        const [updatedRow] = await tx
          .update(purchaseOrderRows)
          .set({ quantityReceived: String(Math.max(round4(Number(row.quantityReceived) - quantity), 0)) })
          .where(eq(purchaseOrderRows.id, row.id))
          .returning();
        const [undone] = await tx
          .update(purchaseReceipts)
          .set({ undoneAt: new Date(), undoneBy: input.undoneBy })
          .where(eq(purchaseReceipts.id, receipt.id))
          .returning();
        const orderStatus = await recomputeReceiptStatus(tx, orderId);

        return { ok: true, receipt: undone!, row: updatedRow!, statusBefore: order.status, orderStatus };
      });
    },

    // --- Avsändning till legoleverantör (dispatches) ---

    // The sales orders the order's lego rows belong to (through the TO's
    // sales_order_row_id), each with the customer and the order's chosen
    // delivery address — the IO card's "Hämta från kundorder" choices.
    async linkedSalesOrders(orderId: string) {
      const rows = await db
        .selectDistinctOn([salesOrders.id], {
          salesOrderId: salesOrders.id,
          orderNumber: salesOrders.orderNumber,
          customerId: customers.id,
          customerName: customers.name,
          deliveryAddressLabel: customerDeliveryAddresses.label,
          deliveryAddress: customerDeliveryAddresses.address,
          deliveryPostalCode: customerDeliveryAddresses.postalCode,
          deliveryCity: customerDeliveryAddresses.city,
          deliveryCountry: customerDeliveryAddresses.country,
        })
        .from(purchaseOrderRows)
        .innerJoin(moOperations, eq(moOperations.id, purchaseOrderRows.moOperationId))
        .innerJoin(manufacturingOrders, eq(manufacturingOrders.id, moOperations.manufacturingOrderId))
        .innerJoin(salesOrderRows, eq(salesOrderRows.id, manufacturingOrders.salesOrderRowId))
        .innerJoin(salesOrders, eq(salesOrders.id, salesOrderRows.salesOrderId))
        .innerJoin(customers, eq(customers.id, salesOrders.customerId))
        .leftJoin(customerDeliveryAddresses, eq(customerDeliveryAddresses.id, salesOrders.deliveryAddressId))
        .where(eq(purchaseOrderRows.purchaseOrderId, orderId))
        .orderBy(asc(salesOrders.id));
      return rows
        .sort((a, b) => a.orderNumber.localeCompare(b.orderNumber, "sv", { numeric: true }))
        .map((r) => ({
          salesOrderId: r.salesOrderId,
          orderNumber: r.orderNumber,
          customerId: r.customerId,
          customerName: r.customerName,
          // The order's chosen delivery address (null = none chosen; the
          // card then offers the customer's own addresses instead).
          deliveryAddress: r.deliveryAddress
            ? {
                label: r.deliveryAddressLabel!,
                address: r.deliveryAddress,
                postalCode: r.deliveryPostalCode,
                city: r.deliveryCity,
                country: r.deliveryCountry,
              }
            : null,
        }));
    },

    // Rapportera avsändning: one dispatch with its rows in one transaction.
    // Quantities arrive in the base unit (the web converts, as for a goods
    // receipt). Lock order row → order like receiveGoods; the rows are
    // locked in id order so two dispatches of the same rows never deadlock.
    // No stock effect and no status change — only the log row.
    async createDispatch(
      orderId: string,
      input: CreatePurchaseDispatchInput,
      createdBy: string
    ): Promise<
      | { ok: true; dispatch: typeof purchaseOrderDispatches.$inferSelect; rows: (typeof purchaseOrderDispatchRows.$inferSelect)[] }
      | { ok: false; reason: "order_not_found" | "invalid_status" }
      | { ok: false; reason: "row_not_found" | "row_not_lego"; rowId: string }
    > {
      return db.transaction(async (tx) => {
        // Existence first, WITHOUT a lock (the lock order stays row → order
        // below) — otherwise an unknown order reads as "row not found".
        const [exists_] = await tx.select({ id: purchaseOrders.id }).from(purchaseOrders).where(eq(purchaseOrders.id, orderId));
        if (!exists_) return { ok: false, reason: "order_not_found" };
        const rowIds = [...new Set(input.rows.map((r) => r.rowId))].sort();
        const rows = await tx
          .select()
          .from(purchaseOrderRows)
          .where(and(inArray(purchaseOrderRows.id, rowIds), eq(purchaseOrderRows.purchaseOrderId, orderId)))
          .orderBy(asc(purchaseOrderRows.id))
          .for("update");
        const byId = new Map(rows.map((r) => [r.id, r]));
        for (const rowId of rowIds) {
          const row = byId.get(rowId);
          if (!row) return { ok: false, reason: "row_not_found", rowId };
          if (row.moOperationId === null) return { ok: false, reason: "row_not_lego", rowId };
        }
        const [order] = await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, orderId)).for("update");
        if (!order) return { ok: false, reason: "order_not_found" };
        if (order.status !== "draft" && order.status !== "confirmed" && order.status !== "partially_received") {
          return { ok: false, reason: "invalid_status" };
        }
        const [dispatch] = await tx
          .insert(purchaseOrderDispatches)
          .values({ purchaseOrderId: orderId, dispatchedBy: createdBy, note: input.note ?? null })
          .returning();
        const dispatchRows = await tx
          .insert(purchaseOrderDispatchRows)
          .values(
            input.rows.map((r) => ({
              dispatchId: dispatch!.id,
              purchaseOrderRowId: r.rowId,
              quantity: String(round4(r.quantity)),
              parcels: r.parcels,
            }))
          )
          .returning();
        return { ok: true, dispatch: dispatch!, rows: dispatchRows };
      });
    },

    // Ångra avsändning: stamps the dispatch; nothing else to reverse. The
    // UPDATE is conditioned on undone_at IS NULL so two concurrent undos
    // cannot both succeed.
    async undoDispatch(
      orderId: string,
      dispatchId: string,
      undoneBy: string
    ): Promise<{ ok: true; dispatch: typeof purchaseOrderDispatches.$inferSelect } | { ok: false; reason: "not_found" | "already_undone" }> {
      return db.transaction(async (tx) => {
        const [dispatch] = await tx
          .select()
          .from(purchaseOrderDispatches)
          .where(and(eq(purchaseOrderDispatches.id, dispatchId), eq(purchaseOrderDispatches.purchaseOrderId, orderId)))
          .for("update");
        if (!dispatch) return { ok: false, reason: "not_found" };
        if (dispatch.undoneAt) return { ok: false, reason: "already_undone" };
        const [undone] = await tx
          .update(purchaseOrderDispatches)
          .set({ undoneAt: new Date(), undoneBy })
          .where(and(eq(purchaseOrderDispatches.id, dispatchId), isNull(purchaseOrderDispatches.undoneAt)))
          .returning();
        if (!undone) return { ok: false, reason: "already_undone" };
        return { ok: true, dispatch: undone };
      });
    },

    // Avsändningar on the IO card and in the routine, newest first — undone
    // ones included — each with its rows: the article, the lego reference
    // (TO · op · description), the quantity (base unit, with the row's
    // unit snapshot so the reader can show the row's unit) and parcels.
    async listDispatches(orderId: string) {
      const undoer = alias(users, "undoer");
      const [dispatches, rows] = await Promise.all([
        db
          .select({
            id: purchaseOrderDispatches.id,
            dispatchedAt: purchaseOrderDispatches.dispatchedAt,
            dispatchedByName: users.name,
            note: purchaseOrderDispatches.note,
            undoneAt: purchaseOrderDispatches.undoneAt,
            undoneByName: undoer.name,
          })
          .from(purchaseOrderDispatches)
          .leftJoin(users, eq(users.id, purchaseOrderDispatches.dispatchedBy))
          .leftJoin(undoer, eq(undoer.id, purchaseOrderDispatches.undoneBy))
          .where(eq(purchaseOrderDispatches.purchaseOrderId, orderId))
          .orderBy(desc(purchaseOrderDispatches.dispatchedAt), desc(purchaseOrderDispatches.id)),
        dispatchRowsByOrder(orderId),
      ]);
      return dispatches.map((d) => ({ ...d, rows: rows.filter((r) => r.dispatchId === d.id) }));
    },

    // One dispatch for the pallet card: the order (number, delivery address
    // snapshot), the supplier (name, language, its default delivery address
    // else its own address) and the rows as listDispatches gives them.
    async findDispatchForPalletCard(orderId: string, dispatchId: string) {
      const [head] = await db
        .select({
          id: purchaseOrderDispatches.id,
          dispatchedAt: purchaseOrderDispatches.dispatchedAt,
          dispatchedByName: users.name,
          undoneAt: purchaseOrderDispatches.undoneAt,
          orderNumber: purchaseOrders.orderNumber,
          deliveryName: purchaseOrders.deliveryName,
          deliveryAddress: purchaseOrders.deliveryAddress,
          deliveryPostalCode: purchaseOrders.deliveryPostalCode,
          deliveryCity: purchaseOrders.deliveryCity,
          deliveryCountry: purchaseOrders.deliveryCountry,
          supplierName: suppliers.name,
          supplierLanguage: suppliers.language,
          supplierAddress: suppliers.address,
          supplierPostalCode: suppliers.postalCode,
          supplierCity: suppliers.city,
          supplierCountry: suppliers.country,
          supplierDeliveryAddress: supplierDeliveryAddresses.address,
          supplierDeliveryPostalCode: supplierDeliveryAddresses.postalCode,
          supplierDeliveryCity: supplierDeliveryAddresses.city,
        })
        .from(purchaseOrderDispatches)
        .innerJoin(purchaseOrders, eq(purchaseOrders.id, purchaseOrderDispatches.purchaseOrderId))
        .innerJoin(suppliers, eq(suppliers.id, purchaseOrders.supplierId))
        .leftJoin(users, eq(users.id, purchaseOrderDispatches.dispatchedBy))
        .leftJoin(
          supplierDeliveryAddresses,
          and(eq(supplierDeliveryAddresses.supplierId, suppliers.id), eq(supplierDeliveryAddresses.isDefault, true))
        )
        .where(and(eq(purchaseOrderDispatches.id, dispatchId), eq(purchaseOrderDispatches.purchaseOrderId, orderId)));
      if (!head) return null;
      const rows = (await dispatchRowsByOrder(orderId)).filter((r) => r.dispatchId === dispatchId);
      return { ...head, rows };
    },

    // --- Article supplier catalog (leverantörskatalog per artikel) ---

    async listArticleSuppliers(articleId: string) {
      const rows = await db
        .select({ ...getTableColumns(articleSuppliers), supplierName: suppliers.name })
        .from(articleSuppliers)
        .innerJoin(suppliers, eq(suppliers.id, articleSuppliers.supplierId))
        .where(eq(articleSuppliers.articleId, articleId))
        .orderBy(desc(articleSuppliers.isPrimary), asc(suppliers.name));
      const breaks = await loadPriceBreaks(db, rows.map((r) => r.id));
      return rows.map((r) => ({ ...r, priceBreaks: breaks.get(r.id) ?? [] }));
    },

    // Prishistorik for the catalog: every snapshot the triggers wrote
    // (migration 0169), newest first, with the supplier's name — null when
    // the supplier has since been merged away.
    async listArticleSupplierPriceHistory(articleId: string) {
      return db
        .select({
          id: articleSupplierPriceHistory.id,
          supplierId: articleSupplierPriceHistory.supplierId,
          supplierName: suppliers.name,
          price: articleSupplierPriceHistory.price,
          currency: articleSupplierPriceHistory.currency,
          priceBreaks: articleSupplierPriceHistory.priceBreaks,
          isPrimary: articleSupplierPriceHistory.isPrimary,
          removed: articleSupplierPriceHistory.removed,
          validFrom: articleSupplierPriceHistory.validFrom,
        })
        .from(articleSupplierPriceHistory)
        .leftJoin(suppliers, eq(suppliers.id, articleSupplierPriceHistory.supplierId))
        .where(eq(articleSupplierPriceHistory.articleId, articleId))
        .orderBy(desc(articleSupplierPriceHistory.validFrom), asc(suppliers.name));
    },

    async findArticleSupplier(articleId: string, rowId: string) {
      const [row] = await db
        .select()
        .from(articleSuppliers)
        .where(and(eq(articleSuppliers.id, rowId), eq(articleSuppliers.articleId, articleId)));
      return row ?? null;
    },

    // The catalog row ONE supplier has for an article (+ its staffel) — the
    // basis for the purchase order card's à-pris prefill.
    // Fasta leveransdagar: the system defaults + full-day holidays in the
    // window, for the date suggestions (delivery-context.ts).
    async deliveryContext(window: { from: string; to: string }) {
      return loadDeliveryContext(db, window);
    },

    async findArticleSupplierBySupplier(articleId: string, supplierId: string) {
      const [row] = await db
        .select()
        .from(articleSuppliers)
        .where(and(eq(articleSuppliers.articleId, articleId), eq(articleSuppliers.supplierId, supplierId)));
      if (!row) return null;
      const breaks = await loadPriceBreaks(db, [row.id]);
      return { ...row, priceBreaks: breaks.get(row.id) ?? [] };
    },

    // Marking a catalog row primary demotes the previous huvudleverantör in
    // the same transaction — otherwise the partial unique index rejects it.
    async createArticleSupplier(articleId: string, input: CreateArticleSupplierInput) {
      return db.transaction(async (tx) => {
        if (input.isPrimary) {
          await tx
            .update(articleSuppliers)
            .set({ isPrimary: false })
            .where(and(eq(articleSuppliers.articleId, articleId), eq(articleSuppliers.isPrimary, true)));
        }
        const [row] = await tx
          .insert(articleSuppliers)
          .values({
            articleId,
            supplierId: input.supplierId,
            supplierArticleNumber: input.supplierArticleNumber ?? null,
            price: input.price !== undefined ? String(input.price) : null,
            currency: input.currency,
            leadTimeDays: input.leadTimeDays ?? null,
            isPrimary: input.isPrimary,
          })
          .returning();
        const priceBreaks = input.priceBreaks ?? [];
        if (priceBreaks.length > 0) await replacePriceBreaks(tx, row!.id, priceBreaks);
        return { ...row!, priceBreaks: (await loadPriceBreaks(tx, [row!.id])).get(row!.id) ?? [] };
      });
    },

    // Scoped to the article so a row id from another article 404s.
    async updateArticleSupplier(articleId: string, rowId: string, input: UpdateArticleSupplierInput) {
      return db.transaction(async (tx) => {
        if (input.isPrimary === true) {
          // Target first — an unknown row id (or another article's) must not
          // demote the article's huvudleverantör on its way to 404.
          const [target] = await tx
            .select({ id: articleSuppliers.id })
            .from(articleSuppliers)
            .where(and(eq(articleSuppliers.id, rowId), eq(articleSuppliers.articleId, articleId)))
            .for("update");
          if (!target) return null;
          await tx
            .update(articleSuppliers)
            .set({ isPrimary: false })
            .where(and(eq(articleSuppliers.articleId, articleId), eq(articleSuppliers.isPrimary, true)));
        }
        const set: {
          supplierArticleNumber?: string | null;
          price?: string | null;
          currency?: string;
          leadTimeDays?: number | null;
          isPrimary?: boolean;
        } = {};
        if (input.supplierArticleNumber !== undefined) set.supplierArticleNumber = input.supplierArticleNumber;
        if (input.price !== undefined) set.price = input.price === null ? null : String(input.price);
        if (input.currency !== undefined) set.currency = input.currency;
        if (input.leadTimeDays !== undefined) set.leadTimeDays = input.leadTimeDays;
        if (input.isPrimary !== undefined) set.isPrimary = input.isPrimary;
        const scope = and(eq(articleSuppliers.id, rowId), eq(articleSuppliers.articleId, articleId));
        // A PATCH carrying only `priceBreaks` leaves `set` empty, and Drizzle
        // refuses an UPDATE with no values — read the row instead.
        const [row] =
          Object.keys(set).length > 0
            ? await tx.update(articleSuppliers).set(set).where(scope).returning()
            : await tx.select().from(articleSuppliers).where(scope);
        if (!row) return null;
        if (input.priceBreaks !== undefined) await replacePriceBreaks(tx, row.id, input.priceBreaks);
        return { ...row, priceBreaks: (await loadPriceBreaks(tx, [row.id])).get(row.id) ?? [] };
      });
    },

    async deleteArticleSupplier(articleId: string, rowId: string) {
      const [row] = await db
        .delete(articleSuppliers)
        .where(and(eq(articleSuppliers.id, rowId), eq(articleSuppliers.articleId, articleId)))
        .returning();
      return row ?? null;
    },

    // --- Per-article purchase logs (read-only) ---

    // Inleveranslogg: purchase_receipt stock movements for the article,
    // joined back to the PO/supplier and the row's unit price. The row is
    // reached through the receipt log (purchase_receipts.stock_transaction_id
    // → purchase_order_row_id) — the same article may sit on several rows of
    // an order, so (order, article) would duplicate the lines and mix up the
    // prices. Migration 0118 backfilled every earlier receipt into
    // purchase_receipts; a movement without a receipt row (should not exist)
    // falls back to the order's first row of the article so no history is
    // lost.
    async listGoodsReceiptsByArticle(articleId: string, query: ListGoodsReceiptsQuery) {
      // Live receipts only: Ångra inleverans books a negative purchase_receipt
      // and stamps the receipt undone — neither is something that came in.
      const where = and(
        eq(stockTransactions.transactionType, "purchase_receipt"),
        eq(stockTransactions.articleId, articleId),
        sql`${stockTransactions.quantityDelta} > 0`,
        isNull(purchaseReceipts.undoneAt)
      );
      const rowJoin = eq(
        purchaseOrderRows.id,
        sql`coalesce(${purchaseReceipts.purchaseOrderRowId}, (SELECT r.id FROM purchase_order_rows r WHERE r.purchase_order_id = ${purchaseOrders.id} AND r.article_id = ${stockTransactions.articleId} ORDER BY r.created_at, r.id LIMIT 1))`
      );
      const [rows, totalRows] = await Promise.all([
        db
          .select({
            id: stockTransactions.id,
            date: stockTransactions.createdAt,
            quantity: stockTransactions.quantityDelta,
            orderNumber: purchaseOrders.orderNumber,
            supplierName: suppliers.name,
            currency: purchaseOrders.currency,
            unitPrice: purchaseOrderRows.unitPrice,
            locationName: stockLocations.name,
          })
          .from(stockTransactions)
          .innerJoin(purchaseOrders, eq(purchaseOrders.id, stockTransactions.referenceId))
          .innerJoin(suppliers, eq(suppliers.id, purchaseOrders.supplierId))
          .leftJoin(purchaseReceipts, eq(purchaseReceipts.stockTransactionId, stockTransactions.id))
          .innerJoin(purchaseOrderRows, rowJoin)
          .leftJoin(stockLocations, eq(stockLocations.id, stockTransactions.locationId))
          .where(where)
          .orderBy(desc(stockTransactions.createdAt))
          .limit(query.limit)
          .offset(query.offset),
        db
          .select({ total: count() })
          .from(stockTransactions)
          .innerJoin(purchaseOrders, eq(purchaseOrders.id, stockTransactions.referenceId))
          .leftJoin(purchaseReceipts, eq(purchaseReceipts.stockTransactionId, stockTransactions.id))
          .innerJoin(purchaseOrderRows, rowJoin)
          .where(where),
      ]);
      return { rows, total: totalRows[0]!.total };
    },

    // Prislogg: the article's purchase-order rows across all live orders
    // (draft/cancelled excluded), newest first.
    async listPriceHistoryByArticle(articleId: string, query: ListPriceHistoryQuery) {
      const where = and(
        eq(purchaseOrderRows.articleId, articleId),
        notInArray(purchaseOrders.status, ["draft", "cancelled"])
      );
      const [rows, totalRows] = await Promise.all([
        db
          .select({
            id: purchaseOrderRows.id,
            date: purchaseOrders.createdAt,
            orderNumber: purchaseOrders.orderNumber,
            supplierName: suppliers.name,
            unitPrice: purchaseOrderRows.unitPrice,
            currency: purchaseOrders.currency,
            quantity: purchaseOrderRows.quantityOrdered,
            // The row's effective arrival date — tells two rows of the same
            // article on one order apart (Koppla till inköpsorderrad, 0177).
            deliveryDate: purchaseRowArrivalDate,
          })
          .from(purchaseOrderRows)
          .innerJoin(purchaseOrders, eq(purchaseOrders.id, purchaseOrderRows.purchaseOrderId))
          .innerJoin(suppliers, eq(suppliers.id, purchaseOrders.supplierId))
          .where(where)
          .orderBy(desc(purchaseOrders.createdAt))
          .limit(query.limit)
          .offset(query.offset),
        db
          .select({ total: count() })
          .from(purchaseOrderRows)
          .innerJoin(purchaseOrders, eq(purchaseOrders.id, purchaseOrderRows.purchaseOrderId))
          .where(where),
      ]);
      return { rows, total: totalRows[0]!.total };
    },

    // Fakturaunderlag: inlevererade order (mottaget värde + fakturastatus)
    // som väntar på en leverantörsfaktura.
    async listInvoiceBasis(query: ListPurchaseInvoiceBasisQuery) {
      // A linked, non-cancelled supplier invoice makes the order "invoiced".
      const invoicedExists = sql`EXISTS (SELECT 1 FROM ${supplierInvoices} si WHERE si.purchase_order_id = ${purchaseOrders.id} AND si.status <> 'cancelled')`;
      const conditions = [];
      conditions.push(inArray(purchaseOrders.status, ["received", "partially_received", "closed"]));
      if (query.search) {
        const pattern = ilikePattern(query.search);
        conditions.push(or(ilike(purchaseOrders.orderNumber, pattern), ilike(suppliers.name, pattern)));
      }
      if (query.supplierId) conditions.push(eq(purchaseOrders.supplierId, query.supplierId));
      // Absent filter defaults to the worklist (uninvoiced).
      const mode = query.invoiced ?? "uninvoiced";
      if (mode === "uninvoiced") conditions.push(sql`NOT ${invoicedExists}`);
      else if (mode === "invoiced") conditions.push(invoicedExists);
      const where = and(...conditions);

      // A lego row's ställpris counts once, as soon as anything is received
      // (the setup charge is not per unit).
      const receivedValue = sql<string>`COALESCE((SELECT SUM(por.quantity_received * por.unit_price + CASE WHEN por.quantity_received > 0 THEN COALESCE(por.setup_price, 0) ELSE 0 END) FROM ${purchaseOrderRows} por WHERE por.purchase_order_id = ${purchaseOrders.id}), 0)`;
      // A pure lego order books no purchase_receipt (the units never touch
      // stock — see arkitekturprincip 3), so the subquery comes back null for
      // it even though the order is received. Fall back to the order's
      // updated_at, which the receiving transaction's status recompute
      // stamps at the same moment — a good approximation, though it can
      // drift if the order is edited afterwards. Acceptable for a worklist.
      // Live receipts only — an undone one (and its negative reversal) is
      // not when the goods arrived.
      const receivedAt = sql<string | null>`COALESCE((SELECT MAX(st.created_at) FROM ${stockTransactions} st WHERE st.reference_id = ${purchaseOrders.id} AND st.transaction_type = 'purchase_receipt' AND st.quantity_delta > 0 AND NOT EXISTS (SELECT 1 FROM ${purchaseReceipts} pr WHERE pr.stock_transaction_id = st.id AND pr.undone_at IS NOT NULL)), ${purchaseOrders.updatedAt})`;
      const invoiceId = sql<string | null>`(SELECT si.id FROM ${supplierInvoices} si WHERE si.purchase_order_id = ${purchaseOrders.id} AND si.status <> 'cancelled' ORDER BY si.created_at DESC LIMIT 1)`;
      const invoiceRegistrationNumber = sql<string | null>`(SELECT si.registration_number FROM ${supplierInvoices} si WHERE si.purchase_order_id = ${purchaseOrders.id} AND si.status <> 'cancelled' ORDER BY si.created_at DESC LIMIT 1)`;

      const [rows, totalRows] = await Promise.all([
        db
          .select({
            id: purchaseOrders.id,
            orderNumber: purchaseOrders.orderNumber,
            supplierId: purchaseOrders.supplierId,
            supplierName: suppliers.name,
            currency: purchaseOrders.currency,
            status: purchaseOrders.status,
            receivedAt,
            receivedValue,
            invoiceId,
            invoiceRegistrationNumber,
          })
          .from(purchaseOrders)
          .innerJoin(suppliers, eq(suppliers.id, purchaseOrders.supplierId))
          .where(where)
          .orderBy(sql`${receivedAt} DESC NULLS LAST`)
          .limit(query.limit)
          .offset(query.offset),
        db
          .select({ total: count() })
          .from(purchaseOrders)
          .innerJoin(suppliers, eq(suppliers.id, purchaseOrders.supplierId))
          .where(where),
      ]);
      return { rows, total: totalRows[0]!.total };
    },
  };
}

export type PurchaseRepository = ReturnType<typeof createPurchaseRepository>;

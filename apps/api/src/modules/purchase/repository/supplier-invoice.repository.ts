import { and, asc, count, desc, eq, exists, getTableColumns, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  articles,
  fiscalYears,
  paymentBatches,
  paymentBatchItems,
  paymentTerms,
  purchaseOrderRows,
  purchaseOrders,
  suppliers,
  supplierInvoiceFiles,
  supplierInvoiceRows,
  supplierInvoices,
  supplierPaymentRows,
  supplierPayments,
  vatCodes,
  verifications,
  verificationSeries,
  type Db,
  type Tx,
} from "@navet/db";
import { ilikePattern, type ListSupplierInvoicesQuery, type PaymentReferenceKind } from "@navet/shared";
import { getNextOrderNumber } from "../../system/service/number-series.js";
import { domesticVatCodeIdSql, loadPostingVatCodes, loadVatCodeBook } from "../../economy/repository/vat-codes.js";
// Type-only (erased at compile time), so declaring the poster interface at
// the consuming service does not create a runtime import cycle — same seam
// as sales' invoice.repository.ts and its CustomerInvoicePoster.
import type { SupplierInvoicePoster } from "../service/supplier-invoice.service.js";
import { computeOpenAmounts } from "./open-amounts.js";

// Internal control-flow signal only — never leaves approve/cancelApproved
// below. Thrown INSIDE the transaction when the row-locked re-read (or the
// conditional UPDATE) shows the invoice is no longer in the status the
// service checked before the transaction opened, so everything the
// transaction did — the verification and its verifikatnummer included —
// rolls back instead of being burned by a lost race. Caught immediately
// outside and turned into a discriminated `{ ok: false, reason: "race" }`
// result, the same "no matching row" convention every other conditional
// update in this repository reports. Same idiom as IssueRaceError in
// sales/repository/invoice.repository.ts.
class TransitionRaceError extends Error {}

// Leverantörsreskontra (B4): the same internal-signal idiom for the one guard
// in cancelApproved that is NOT a race — an approved invoice somebody has
// already registered a (non-cancelled) payment against. Cancelling it would
// leave those payment rows pointing at a makulerad invoice while their money
// stays booked, so the cancellation is refused until the payments are.
// Thrown inside the transaction like the race signal so the omföring the
// poster may already have written rolls back with it.
class HasPaymentsError extends Error {}

// Bankfiler: the same idiom for an invoice reserved in a live payment batch
// row — makulering is refused until the row leaves the batch (or is marked
// rejected), else the bank would pay a cancelled invoice.
class InPaymentBatchError extends Error {
  constructor(public batchNumber: string) {
    super("in_payment_batch");
  }
}

// Bankfiler: the live batch row reserving this invoice, if any — read under
// the invoice's FOR UPDATE lock (the batch creation locks invoices too).
async function liveBatchNumber(tx: Tx, invoiceId: string): Promise<string | null> {
  const [row] = await tx
    .select({ batchNumber: paymentBatches.batchNumber })
    .from(paymentBatchItems)
    .innerJoin(paymentBatches, eq(paymentBatches.id, paymentBatchItems.batchId))
    .where(
      and(eq(paymentBatchItems.supplierInvoiceId, invoiceId), inArray(paymentBatchItems.status, ["pending", "exported"]))
    )
    .limit(1);
  return row?.batchNumber ?? null;
}

// What approve/cancelApproved report back: either the written row, or why the
// transition did not happen. The SERVICE decides what error each reason
// becomes — "race" is a lost race, "has_payments" and "in_payment_batch" are
// real business guards.
export type SupplierInvoiceTransitionResult =
  | { ok: true; invoice: typeof supplierInvoices.$inferSelect }
  | { ok: false; reason: "race" | "has_payments" }
  | { ok: false; reason: "in_payment_batch"; batchNumber: string };

// The booked verification's display number (L-2026-1), assembled from the
// joined series/fiscal year/number exactly the way economy.repository.ts
// formats it. `||` propagates NULL, so an invoice with no verification — any
// draft, plus everything approved before B2 — simply comes back null without
// a CASE.
const verificationDisplayNumberSql = sql<
  string | null
>`${verificationSeries.code} || '-' || ${fiscalYears.label} || '-' || ${verifications.verificationNumber}`;

// A row ready to write — line/vat amounts are computed by the service so the
// stored numbers can never contradict quantity × unitPrice.
export type SupplierInvoiceRowWrite = {
  articleId: string | null;
  purchaseOrderRowId: string | null;
  description: string;
  quantity: number;
  unitPrice: number;
  lineAmount: number;
  vatAmount: number;
  vatRate: number | null;
  // Momskod for this row; null = the invoice's own code.
  vatCodeId: string | null;
};

export type SupplierInvoiceHeaderWrite = {
  supplierId: string;
  invoiceNumber: string;
  purchaseOrderId: string | null;
  invoiceDate: string;
  dueDate: string | null;
  currency: string;
  netAmount: number;
  vatAmount: number;
  grossAmount: number;
  note: string | null;
  paymentReferenceKind: PaymentReferenceKind | null;
  paymentReference: string | null;
  // Momskod (migration 0142). Omitted = MP25 (svensk moms 25 %, which posts
  // a 0 kr VAT invoice exactly like before the momskoder).
  vatCodeId?: string;
};

// Header patch (draft only) — amounts already stringified for the numeric
// columns by the service.
type HeaderPatch = {
  supplierId?: string;
  currency?: string;
  invoiceNumber?: string;
  purchaseOrderId?: string | null;
  invoiceDate?: string;
  dueDate?: string | null;
  netAmount?: string;
  vatAmount?: string;
  grossAmount?: string;
  note?: string | null;
  paymentReferenceKind?: PaymentReferenceKind | null;
  paymentReference?: string | null;
  vatCodeId?: string;
};

// The row's own momskod, joined under its own alias (the header's code is
// joined as vat_codes itself in findById).
const rowVatCodes = alias(vatCodes, "row_vat_codes");

export function createSupplierInvoiceRepository(db: Db) {
  return {
    // Momskoder: the company's codes, once per operation.
    async vatCodeBook() {
      return loadVatCodeBook(db);
    },

    async findSupplierById(id: string) {
      const [row] = await db.select().from(suppliers).where(eq(suppliers.id, id));
      return row ?? null;
    },

    // A PO row plus its order's supplier — for PO-match validation and the
    // computed price/quantity deviation on read.
    async findPurchaseOrderRowForMatch(rowId: string) {
      const [row] = await db
        .select({
          id: purchaseOrderRows.id,
          articleId: purchaseOrderRows.articleId,
          quantityOrdered: purchaseOrderRows.quantityOrdered,
          quantityReceived: purchaseOrderRows.quantityReceived,
          unitPrice: purchaseOrderRows.unitPrice,
          orderNumber: purchaseOrders.orderNumber,
          supplierId: purchaseOrders.supplierId,
        })
        .from(purchaseOrderRows)
        .innerJoin(purchaseOrders, eq(purchaseOrders.id, purchaseOrderRows.purchaseOrderId))
        .where(eq(purchaseOrderRows.id, rowId));
      return row ?? null;
    },

    // Header + rows in one transaction: issue the internal LF- number, then
    // insert. A duplicate (supplierId, invoiceNumber) aborts the tx so the
    // number isn't burned.
    async create(header: SupplierInvoiceHeaderWrite, rows: SupplierInvoiceRowWrite[], createdBy: string) {
      return db.transaction(async (tx) => {
        const registrationNumber = await getNextOrderNumber(tx, "supplier_invoice");
        const [invoice] = await tx
          .insert(supplierInvoices)
          .values({
            registrationNumber,
            invoiceNumber: header.invoiceNumber,
            supplierId: header.supplierId,
            purchaseOrderId: header.purchaseOrderId,
            invoiceDate: header.invoiceDate,
            dueDate: header.dueDate,
            currency: header.currency,
            netAmount: String(header.netAmount),
            vatAmount: String(header.vatAmount),
            grossAmount: String(header.grossAmount),
            note: header.note,
            paymentReferenceKind: header.paymentReferenceKind,
            paymentReference: header.paymentReference,
            vatCodeId: header.vatCodeId ?? domesticVatCodeIdSql("MP25"),
            createdBy,
          })
          .returning();
        if (rows.length > 0) {
          // createdAt is stamped explicitly, one tick per row, instead of
          // relying on the column's now()-default: Postgres evaluates now()
          // once per transaction, so every row in this single multi-row
          // INSERT would otherwise share the exact same timestamp — leaving
          // the `ORDER BY createdAt` reads (listRows, and the automatkontering
          // posting's row order) with nothing to break the tie, so ties
          // resolve however the planner's access path happens to visit them
          // (occasionally NOT insertion order). Same idiom as sales'
          // invoice.repository create.
          const now = Date.now();
          await tx.insert(supplierInvoiceRows).values(
            rows.map((r, i) => ({
              supplierInvoiceId: invoice!.id,
              articleId: r.articleId,
              purchaseOrderRowId: r.purchaseOrderRowId,
              description: r.description,
              quantity: String(r.quantity),
              unitPrice: String(r.unitPrice),
              lineAmount: String(r.lineAmount),
              vatAmount: String(r.vatAmount),
              vatRate: r.vatRate === null ? null : String(r.vatRate),
              vatCodeId: r.vatCodeId,
              createdAt: new Date(now + i),
            }))
          );
        }
        return invoice!;
      });
    },

    async list(query: ListSupplierInvoicesQuery) {
      const conditions = [];
      if (query.search) {
        const pattern = ilikePattern(query.search);
        conditions.push(
          or(
            ilike(supplierInvoices.registrationNumber, pattern),
            ilike(supplierInvoices.invoiceNumber, pattern),
            ilike(suppliers.name, pattern)
          )
        );
      }
      if (query.status) conditions.push(inArray(supplierInvoices.status, query.status));
      if (query.supplierId) conditions.push(eq(supplierInvoices.supplierId, query.supplierId));
      if (query.articleId) {
        conditions.push(
          exists(
            db
              .select({ one: sql`1` })
              .from(supplierInvoiceRows)
              .where(
                and(
                  eq(supplierInvoiceRows.supplierInvoiceId, supplierInvoices.id),
                  eq(supplierInvoiceRows.articleId, query.articleId)
                )
              )
          )
        );
      }
      const where = conditions.length > 0 ? and(...conditions) : undefined;

      const [rows, totalRows] = await Promise.all([
        db
          .select({
            ...getTableColumns(supplierInvoices),
            supplierName: suppliers.name,
            verificationDisplayNumber: verificationDisplayNumberSql,
          })
          .from(supplierInvoices)
          .innerJoin(suppliers, eq(suppliers.id, supplierInvoices.supplierId))
          // Automatkontering (B2) — three left joins so the list can link
          // straight to the verification each invoice booked. Not needed by
          // the count query below, which only needs the same `where`.
          .leftJoin(verifications, eq(verifications.id, supplierInvoices.verificationId))
          .leftJoin(verificationSeries, eq(verificationSeries.id, verifications.seriesId))
          .leftJoin(fiscalYears, eq(fiscalYears.id, verifications.fiscalYearId))
          .where(where)
          .orderBy(desc(supplierInvoices.createdAt))
          .limit(query.limit)
          .offset(query.offset),
        db
          .select({ total: count() })
          .from(supplierInvoices)
          .innerJoin(suppliers, eq(suppliers.id, supplierInvoices.supplierId))
          .where(where),
      ]);
      return { rows, total: totalRows[0]!.total };
    },

    // Joined header for the detail GET (supplier + optional PO number).
    async findById(id: string) {
      const [row] = await db
        .select({
          ...getTableColumns(supplierInvoices),
          supplierName: suppliers.name,
          // Momskoder: the supplier's live country and currency for the
          // card's warnings (supplierInvoiceWarnings).
          supplierCountry: suppliers.country,
          supplierCurrency: suppliers.currency,
          purchaseOrderNumber: purchaseOrders.orderNumber,
          verificationDisplayNumber: verificationDisplayNumberSql,
          // Momskoder: the header's code (NOT NULL).
          vatCodeCode: vatCodes.code,
          vatCodeName: vatCodes.name,
        })
        .from(supplierInvoices)
        .innerJoin(suppliers, eq(suppliers.id, supplierInvoices.supplierId))
        .innerJoin(vatCodes, eq(vatCodes.id, supplierInvoices.vatCodeId))
        .leftJoin(purchaseOrders, eq(purchaseOrders.id, supplierInvoices.purchaseOrderId))
        .leftJoin(verifications, eq(verifications.id, supplierInvoices.verificationId))
        .leftJoin(verificationSeries, eq(verificationSeries.id, verifications.seriesId))
        .leftJoin(fiscalYears, eq(fiscalYears.id, verifications.fiscalYearId))
        .where(eq(supplierInvoices.id, id));
      return row ?? null;
    },

    // Raw row for status/transition checks (no joins).
    async findRawById(id: string) {
      const [row] = await db.select().from(supplierInvoices).where(eq(supplierInvoices.id, id));
      return row ?? null;
    },

    async listRows(invoiceId: string) {
      return db
        .select({
          ...getTableColumns(supplierInvoiceRows),
          articleNumber: articles.articleNumber,
          articleName: articles.name,
          poOrderNumber: purchaseOrders.orderNumber,
          poQuantityOrdered: purchaseOrderRows.quantityOrdered,
          poQuantityReceived: purchaseOrderRows.quantityReceived,
          poUnitPrice: purchaseOrderRows.unitPrice,
          // Momskoder: the row's own code (null = the invoice's).
          vatCodeCode: rowVatCodes.code,
          vatCodeName: rowVatCodes.name,
        })
        .from(supplierInvoiceRows)
        .leftJoin(rowVatCodes, eq(rowVatCodes.id, supplierInvoiceRows.vatCodeId))
        .leftJoin(articles, eq(articles.id, supplierInvoiceRows.articleId))
        .leftJoin(purchaseOrderRows, eq(purchaseOrderRows.id, supplierInvoiceRows.purchaseOrderRowId))
        .leftJoin(purchaseOrders, eq(purchaseOrders.id, purchaseOrderRows.purchaseOrderId))
        .where(eq(supplierInvoiceRows.supplierInvoiceId, invoiceId))
        .orderBy(asc(supplierInvoiceRows.createdAt));
    },

    // Only a draft is changed: the status guard sits in the UPDATE itself, so
    // an attest that commits between the service's check and this write (it
    // books the L verification from the header it read under FOR UPDATE)
    // leaves the header alone instead of having its amounts or supplier
    // changed after the posting. null = not found or no longer a draft.
    async updateHeader(id: string, patch: HeaderPatch) {
      const [row] = await db
        .update(supplierInvoices)
        .set({ ...patch, updatedAt: new Date() })
        .where(and(eq(supplierInvoices.id, id), eq(supplierInvoices.status, "draft")))
        .returning();
      return row ?? null;
    },

    // Bankfiler: the payment reference may change in draft AND approved — it
    // is not bookkeeping data — but not while a live batch row reserves the
    // invoice (the exported file already carries the old reference). Checked
    // under the same FOR UPDATE lock.
    async setPaymentReference(id: string, ref: { kind: PaymentReferenceKind; value: string } | null) {
      return db.transaction(async (tx) => {
        const [invoice] = await tx.select().from(supplierInvoices).where(eq(supplierInvoices.id, id)).for("update");
        if (!invoice) return { ok: false as const, reason: "not_found" as const };
        if (invoice.status !== "draft" && invoice.status !== "approved") {
          return { ok: false as const, reason: "status" as const, status: invoice.status };
        }
        const reservedIn = await liveBatchNumber(tx, id);
        if (reservedIn !== null) return { ok: false as const, reason: "in_payment_batch" as const, batchNumber: reservedIn };
        const [row] = await tx
          .update(supplierInvoices)
          .set({ paymentReferenceKind: ref?.kind ?? null, paymentReference: ref?.value ?? null, updatedAt: new Date() })
          .where(eq(supplierInvoices.id, id))
          .returning();
        return { ok: true as const, invoice: row! };
      });
    },

    // --- Status transitions (B2: attest and makulering also book) ---

    // draft -> approved. Books the L verification in the SAME transaction as
    // the status flip, so the verification, its verifikatnummer and the
    // approval either all commit or all roll back (BFL: obruten
    // verifikatserie). The row is locked FOR UPDATE first: a concurrent
    // approve() blocks there, then re-reads status = "approved" and gives up
    // BEFORE the poster runs — so the loser never books anything at all.
    // The UPDATE is conditional on status = "draft" anyway, as the belt to
    // that braces.
    //
    // The poster's own errors — locked/absent accounting period, missing or
    // inactive posting account, header amounts that don't add up, non-SEK,
    // zero amount — are DELIBERATELY not caught here: the catch below only
    // normalizes this file's internal race signal, so a posting failure
    // propagates to the service/routes as a 409 and takes the whole
    // transition with it.
    async approve(
      id: string,
      userId: string,
      poster: SupplierInvoicePoster
    ): Promise<SupplierInvoiceTransitionResult> {
      try {
        return await db.transaction(async (tx) => {
          const [invoice] = await tx
            .select()
            .from(supplierInvoices)
            .where(eq(supplierInvoices.id, id))
            .for("update");
          if (!invoice || invoice.status !== "draft") throw new TransitionRaceError();

          // Read in-tx so the posting sees the same snapshot the status flip
          // is written against.
          const [supplier] = await tx
            .select({ name: suppliers.name })
            .from(suppliers)
            .where(eq(suppliers.id, invoice.supplierId));
          // The article's group decides which konteringsregel applies; a
          // freight/fee row (no article) and an article without a group both
          // come back null and fall through to the settings default cost
          // account.
          const postingRows = await tx
            .select({
              articleGroupId: articles.groupId,
              vatCodeId: supplierInvoiceRows.vatCodeId,
              lineAmount: supplierInvoiceRows.lineAmount,
            })
            .from(supplierInvoiceRows)
            .leftJoin(articles, eq(articles.id, supplierInvoiceRows.articleId))
            .where(eq(supplierInvoiceRows.supplierInvoiceId, id))
            .orderBy(asc(supplierInvoiceRows.createdAt));
          // The header's and the rows' momskoder, through this transaction.
          const vatCodesById = await loadPostingVatCodes(tx, [
            invoice.vatCodeId,
            ...postingRows.flatMap((row) => (row.vatCodeId ? [row.vatCodeId] : [])),
          ]);

          // The HEADER amounts are what gets posted (they are typed in from
          // the paper invoice and are authoritative); the rows only steer
          // which cost accounts the net is split over.
          const { verificationId } = await poster.postSupplierInvoice(
            tx,
            {
              registrationNumber: invoice.registrationNumber,
              invoiceNumber: invoice.invoiceNumber,
              supplierName: supplier!.name,
              invoiceDate: invoice.invoiceDate,
              currency: invoice.currency,
              netAmount: Number(invoice.netAmount),
              vatAmount: Number(invoice.vatAmount),
              grossAmount: Number(invoice.grossAmount),
              vatCode: vatCodesById.get(invoice.vatCodeId)!,
            },
            postingRows.map((row) => ({
              articleGroupId: row.articleGroupId,
              lineAmount: Number(row.lineAmount),
              vatCode: row.vatCodeId ? vatCodesById.get(row.vatCodeId)! : null,
            })),
            userId
          );

          const [updated] = await tx
            .update(supplierInvoices)
            .set({ status: "approved", verificationId, updatedAt: new Date() })
            .where(and(eq(supplierInvoices.id, id), eq(supplierInvoices.status, "draft")))
            .returning();
          if (!updated) throw new TransitionRaceError();
          return { ok: true as const, invoice: updated };
        });
      } catch (err) {
        if (err instanceof TransitionRaceError) return { ok: false, reason: "race" };
        throw err;
      }
    },

    // draft -> cancelled. Nothing was ever booked, so this is a plain
    // conditional UPDATE — status = "draft" closes the race against a
    // concurrent approve() between the service's own guard and this write.
    async cancelDraft(id: string) {
      const [row] = await db
        .update(supplierInvoices)
        .set({ status: "cancelled", updatedAt: new Date() })
        .where(and(eq(supplierInvoices.id, id), eq(supplierInvoices.status, "draft")))
        .returning();
      return row ?? null;
    },

    // approved -> cancelled. Verifications are append-only, so the booked
    // verification is corrected with an omföring (dated today, hence today's
    // period must be open) in the same transaction as the status flip.
    // Three shapes, all legal:
    //   * verificationId = null — approved before B2 existed: plain cancel,
    //     nothing to reverse.
    //   * a reversal is booked and linked back to the source.
    //   * the source was ALREADY reversed by a BOOKED omföring (a manual
    //     Omför under Ekonomi → Verifikat that was booked): the poster
    //     reports alreadyReversed and the cancellation goes through without
    //     a second omföring — the correction already stands in the books.
    // A 23505 from the partial unique index verifications_reverses_unique is
    // deliberately left to propagate — the service turns it into a 409. That
    // covers both a manual Omför committing between the poster's check and
    // its insert, and an UNBOOKED manual omföring draft on the source (which
    // is no correction at all, so the cancellation must not commit).
    async cancelApproved(
      id: string,
      userId: string,
      poster: SupplierInvoicePoster
    ): Promise<SupplierInvoiceTransitionResult> {
      try {
        return await db.transaction(async (tx) => {
          const [invoice] = await tx
            .select()
            .from(supplierInvoices)
            .where(eq(supplierInvoices.id, id))
            .for("update");
          if (!invoice || invoice.status !== "approved") throw new TransitionRaceError();

          // Leverantörsreskontra (B4): refuse while live payments point here.
          // A payment that FULLY settled the invoice already moved it to
          // "paid" and is caught by the status guard above; this covers the
          // partial one, which leaves the invoice approved with money already
          // booked against it. Checked under the same FOR UPDATE lock the
          // registration takes on the invoice (supplier-payment.repository.ts
          // step 2), so a concurrent registration is serialized against this
          // read rather than slipping in behind it. Cancelled payments do not
          // count — they settle nothing, exactly as open-amounts.ts sees it.
          const [livePayment] = await tx
            .select({ one: sql`1` })
            .from(supplierPaymentRows)
            .innerJoin(supplierPayments, eq(supplierPayments.id, supplierPaymentRows.paymentId))
            .where(and(eq(supplierPaymentRows.supplierInvoiceId, id), isNull(supplierPayments.cancelledAt)))
            .limit(1);
          if (livePayment) throw new HasPaymentsError();

          // Bankfiler: a live batch row reserving the invoice — same lock.
          const reservedIn = await liveBatchNumber(tx, id);
          if (reservedIn !== null) throw new InPaymentBatchError(reservedIn);

          if (invoice.verificationId !== null) {
            const [supplier] = await tx
              .select({ name: suppliers.name })
              .from(suppliers)
              .where(eq(suppliers.id, invoice.supplierId));
            await poster.reverseBookedVerification(
              tx,
              invoice.verificationId,
              {
                // Same today-in-sv-SE idiom as economy.service's reverse()
                // and the invoice issue stamps.
                date: new Date().toLocaleDateString("sv-SE"),
                description: `Makulering ${invoice.registrationNumber} (${invoice.invoiceNumber}) — ${supplier!.name}`,
              },
              userId
            );
          }

          const [updated] = await tx
            .update(supplierInvoices)
            .set({ status: "cancelled", updatedAt: new Date() })
            .where(and(eq(supplierInvoices.id, id), eq(supplierInvoices.status, "approved")))
            .returning();
          if (!updated) throw new TransitionRaceError();
          return { ok: true as const, invoice: updated };
        });
      } catch (err) {
        if (err instanceof TransitionRaceError) return { ok: false, reason: "race" };
        if (err instanceof HasPaymentsError) return { ok: false, reason: "has_payments" };
        if (err instanceof InPaymentBatchError) return { ok: false, reason: "in_payment_batch", batchNumber: err.batchNumber };
        throw err;
      }
    },

    // Leverantörsreskontra (B4): what is still open on this invoice, and which
    // payments have touched it. Both are reads for the invoice CARD — the
    // approved -> paid transition itself belongs to the payment registration's
    // transaction (supplier-payment.repository.ts), which is why there is no
    // markPaid here any more.
    async getOpenAmount(id: string) {
      return (await computeOpenAmounts(db, [id])).get(id) ?? 0;
    },

    // Bankfiler: every batch row this invoice has been in, newest first.
    async listPaymentBatchesForInvoice(invoiceId: string) {
      return db
        .select({
          batchId: paymentBatchItems.batchId,
          batchNumber: paymentBatches.batchNumber,
          endToEndId: paymentBatchItems.endToEndId,
          itemStatus: paymentBatchItems.status,
        })
        .from(paymentBatchItems)
        .innerJoin(paymentBatches, eq(paymentBatches.id, paymentBatchItems.batchId))
        .where(eq(paymentBatchItems.supplierInvoiceId, invoiceId))
        .orderBy(desc(paymentBatchItems.createdAt));
    },

    // Cancelled payments stay visible (append-only) and are marked as such
    // rather than filtered away — they no longer settle anything, which is
    // exactly what the open amount above already reflects.
    async listPaymentsForInvoice(invoiceId: string) {
      return db
        .select({
          paymentId: supplierPayments.id,
          paymentNumber: supplierPayments.paymentNumber,
          paymentDate: supplierPayments.paymentDate,
          appliedAmount: supplierPaymentRows.appliedAmount,
          writeOffAmount: supplierPaymentRows.writeOffAmount,
          cancelledAt: supplierPayments.cancelledAt,
          verificationId: supplierPayments.verificationId,
          verificationDisplayNumber: verificationDisplayNumberSql,
        })
        .from(supplierPaymentRows)
        .innerJoin(supplierPayments, eq(supplierPayments.id, supplierPaymentRows.paymentId))
        .leftJoin(verifications, eq(verifications.id, supplierPayments.verificationId))
        .leftJoin(verificationSeries, eq(verificationSeries.id, verifications.seriesId))
        .leftJoin(fiscalYears, eq(fiscalYears.id, verifications.fiscalYearId))
        .where(eq(supplierPaymentRows.supplierInvoiceId, invoiceId))
        .orderBy(asc(supplierPaymentRows.createdAt));
    },

    // The supplier's payment term CODE ("30", "KONTANT") — the only field the
    // due-date derivation in the service needs. Guarded at the callsite for a
    // supplier without a term, the same way sales' issue() guards
    // findPaymentTermById.
    async findPaymentTermCode(paymentTermId: string): Promise<string | null> {
      const [row] = await db
        .select({ code: paymentTerms.code })
        .from(paymentTerms)
        .where(eq(paymentTerms.id, paymentTermId));
      return row?.code ?? null;
    },

    async addRow(invoiceId: string, row: SupplierInvoiceRowWrite) {
      const [inserted] = await db
        .insert(supplierInvoiceRows)
        .values({
          supplierInvoiceId: invoiceId,
          articleId: row.articleId,
          purchaseOrderRowId: row.purchaseOrderRowId,
          description: row.description,
          quantity: String(row.quantity),
          unitPrice: String(row.unitPrice),
          lineAmount: String(row.lineAmount),
          vatAmount: String(row.vatAmount),
          vatRate: row.vatRate === null ? null : String(row.vatRate),
          vatCodeId: row.vatCodeId,
        })
        .returning();
      return inserted!;
    },

    // Scoped to the invoice so a row id from another invoice 404s.
    async findRow(invoiceId: string, rowId: string) {
      const [row] = await db
        .select()
        .from(supplierInvoiceRows)
        .where(and(eq(supplierInvoiceRows.id, rowId), eq(supplierInvoiceRows.supplierInvoiceId, invoiceId)));
      return row ?? null;
    },

    async updateRow(invoiceId: string, rowId: string, row: SupplierInvoiceRowWrite) {
      const [updated] = await db
        .update(supplierInvoiceRows)
        .set({
          articleId: row.articleId,
          purchaseOrderRowId: row.purchaseOrderRowId,
          description: row.description,
          quantity: String(row.quantity),
          unitPrice: String(row.unitPrice),
          lineAmount: String(row.lineAmount),
          vatAmount: String(row.vatAmount),
          vatRate: row.vatRate === null ? null : String(row.vatRate),
          vatCodeId: row.vatCodeId,
        })
        .where(and(eq(supplierInvoiceRows.id, rowId), eq(supplierInvoiceRows.supplierInvoiceId, invoiceId)))
        .returning();
      return updated ?? null;
    },

    async deleteRow(invoiceId: string, rowId: string) {
      const [row] = await db
        .delete(supplierInvoiceRows)
        .where(and(eq(supplierInvoiceRows.id, rowId), eq(supplierInvoiceRows.supplierInvoiceId, invoiceId)))
        .returning();
      return row ?? null;
    },

    // --- Underlag (the supplier's invoice file). Listing never selects data. ---

    async listFiles(invoiceId: string) {
      const { data: _data, ...columns } = getTableColumns(supplierInvoiceFiles);
      return db
        .select(columns)
        .from(supplierInvoiceFiles)
        .where(eq(supplierInvoiceFiles.supplierInvoiceId, invoiceId))
        .orderBy(asc(supplierInvoiceFiles.createdAt));
    },

    async addFile(input: {
      supplierInvoiceId: string;
      filename: string;
      contentType: string;
      sizeBytes: number;
      sha256: string;
      data: Buffer;
      uploadedBy: string | null;
    }) {
      const { data: _data, ...columns } = getTableColumns(supplierInvoiceFiles);
      const [row] = await db.insert(supplierInvoiceFiles).values(input).returning(columns);
      return row!;
    },

    async findFile(invoiceId: string, fileId: string) {
      const [row] = await db
        .select()
        .from(supplierInvoiceFiles)
        .where(and(eq(supplierInvoiceFiles.id, fileId), eq(supplierInvoiceFiles.supplierInvoiceId, invoiceId)));
      return row ?? null;
    },

    // Only while the invoice is a draft. The invoice row is locked first, so
    // an attest racing this delete either sees the file still there or
    // waits — the underlag can never vanish from an attested invoice.
    async deleteFileIfDraft(
      invoiceId: string,
      fileId: string
    ): Promise<{ ok: true; filename: string; sha256: string } | { ok: false; reason: "not_found" | "locked" }> {
      return db.transaction(async (tx) => {
        const [invoice] = await tx
          .select({ status: supplierInvoices.status })
          .from(supplierInvoices)
          .where(eq(supplierInvoices.id, invoiceId))
          .for("update");
        if (!invoice) return { ok: false, reason: "not_found" };
        if (invoice.status !== "draft") return { ok: false, reason: "locked" };
        const [row] = await tx
          .delete(supplierInvoiceFiles)
          .where(and(eq(supplierInvoiceFiles.id, fileId), eq(supplierInvoiceFiles.supplierInvoiceId, invoiceId)))
          .returning({ filename: supplierInvoiceFiles.filename, sha256: supplierInvoiceFiles.sha256 });
        return row ? { ok: true, ...row } : { ok: false, reason: "not_found" };
      });
    },
  };
}

export type SupplierInvoiceRepository = ReturnType<typeof createSupplierInvoiceRepository>;

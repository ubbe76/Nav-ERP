// Byt leverantör på en inköpsorder — the DB leaf. `loadSupplierChangeFacts`
// reads everything the pure plan (service/supplier-change.ts) needs, on Db
// for the preview and on Tx under the locks for the change;
// `changeOrderSupplier` is the one transaction that writes.
//
// LOCK ORDER: the order's rows (sorted by id, FOR UPDATE) → the order (FOR
// UPDATE) — rows before the order like updateRow/deleteRow, the receipt, its
// undo and the dispatch (which also sorts its rows), so none of them can wait
// on us crosswise. addRow takes only the order: a row it committed between
// our row locks and our order lock is one we do not hold, so the rows are
// re-read under the order lock and another set than the locked one is
// `stale` (nothing written). FOR UPDATE on the rows (not NO KEY UPDATE) also
// makes a supplier invoice row being linked to one of them (the FK's KEY
// SHARE) wait for us, and us for it.
import { and, asc, eq, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  articleSuppliers,
  articles,
  carriers,
  deliveryTerms,
  deviationLinks,
  deviations,
  moOperations,
  paymentTerms,
  purchaseOrderDispatches,
  purchaseOrderRows,
  purchaseOrders,
  purchaseReceipts,
  supplierInvoiceRows,
  supplierInvoices,
  suppliers,
  units,
  type Db,
  type Tx,
} from "@navet/db";
import type { ChangePurchaseOrderSupplierInput, PurchaseOrderStatus, SupplierChangePreview } from "@navet/shared";
import { loadPriceBreaks } from "./price-breaks.js";
import { loadSupplierOrderDefaults, resolveOrderDefaults } from "./supplier-order-defaults.js";
import {
  matchesExpectedSupplierChange,
  planSupplierChange,
  type SupplierChangeFacts,
} from "../service/supplier-change.js";

function label(code: string | null, name: string | null) {
  if (!code && !name) return null;
  return [code, name].filter(Boolean).join(" · ");
}

export type SupplierChangeFactsResult =
  | { ok: true; facts: SupplierChangeFacts; supplierActive: boolean }
  | { ok: false; reason: "order_not_found" | "supplier_not_found" };

export async function loadSupplierChangeFacts(dbc: Db | Tx, orderId: string, supplierId: string): Promise<SupplierChangeFactsResult> {
  const [order] = await dbc
    .select({
      id: purchaseOrders.id,
      orderNumber: purchaseOrders.orderNumber,
      status: purchaseOrders.status,
      supplierId: purchaseOrders.supplierId,
      supplierName: suppliers.name,
      currency: purchaseOrders.currency,
      exchangeRate: purchaseOrders.exchangeRate,
      confirmedDeliveryDate: purchaseOrders.confirmedDeliveryDate,
    })
    .from(purchaseOrders)
    .innerJoin(suppliers, eq(suppliers.id, purchaseOrders.supplierId))
    .where(eq(purchaseOrders.id, orderId));
  if (!order) return { ok: false, reason: "order_not_found" };

  const [supplier] = await dbc
    .select({
      id: suppliers.id,
      name: suppliers.name,
      currency: suppliers.currency,
      active: suppliers.active,
      deliveryTermId: suppliers.deliveryTermId,
      paymentTermId: suppliers.paymentTermId,
      carrierId: suppliers.carrierId,
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
    .where(eq(suppliers.id, supplierId));
  if (!supplier) return { ok: false, reason: "supplier_not_found" };

  const rowUnits = alias(units, "row_units");
  const rows = await dbc
    .select({
      rowId: purchaseOrderRows.id,
      articleId: purchaseOrderRows.articleId,
      articleNumber: articles.articleNumber,
      articleName: articles.name,
      quantity: purchaseOrderRows.quantityOrdered,
      quantityReceived: purchaseOrderRows.quantityReceived,
      unitPrice: purchaseOrderRows.unitPrice,
      setupPrice: purchaseOrderRows.setupPrice,
      unitCode: sql<string>`coalesce(${rowUnits.code}, ${units.code})`,
      unitFactor: purchaseOrderRows.unitFactor,
      moOperationId: purchaseOrderRows.moOperationId,
      confirmedDeliveryDate: purchaseOrderRows.confirmedDeliveryDate,
      operationSupplierId: moOperations.subcontractSupplierId,
    })
    .from(purchaseOrderRows)
    .innerJoin(articles, eq(articles.id, purchaseOrderRows.articleId))
    .innerJoin(units, eq(units.id, articles.unitId))
    .leftJoin(rowUnits, eq(rowUnits.id, purchaseOrderRows.unitId))
    .leftJoin(moOperations, eq(moOperations.id, purchaseOrderRows.moOperationId))
    .where(eq(purchaseOrderRows.purchaseOrderId, orderId))
    // The card's order (entry order).
    .orderBy(asc(purchaseOrderRows.createdAt), asc(purchaseOrderRows.id));
  const rowIds = rows.map((r) => r.rowId);

  // The new supplier's catalog rows for the order's articles, with staffel.
  const articleIds = [...new Set(rows.map((r) => r.articleId))];
  const catalogRows =
    articleIds.length === 0
      ? []
      : await dbc
          .select({ id: articleSuppliers.id, articleId: articleSuppliers.articleId, price: articleSuppliers.price, currency: articleSuppliers.currency })
          .from(articleSuppliers)
          .where(and(eq(articleSuppliers.supplierId, supplierId), inArray(articleSuppliers.articleId, articleIds)));
  const breaks = await loadPriceBreaks(dbc, catalogRows.map((c) => c.id));
  const catalogByArticle = new Map(
    catalogRows.map((c) => [
      c.articleId,
      { price: c.price === null ? null : Number(c.price), currency: c.currency, priceBreaks: breaks.get(c.id) ?? [] },
    ])
  );

  const [receipts] = await dbc
    .select({ n: sql<number>`count(*)::int` })
    .from(purchaseReceipts)
    .where(and(eq(purchaseReceipts.purchaseOrderId, orderId), isNull(purchaseReceipts.undoneAt)));
  const [dispatches] = await dbc
    .select({ n: sql<number>`count(*)::int` })
    .from(purchaseOrderDispatches)
    .where(and(eq(purchaseOrderDispatches.purchaseOrderId, orderId), isNull(purchaseOrderDispatches.undoneAt)));

  // Leverantörsfakturor: the invoice's own IO reference or a row matched
  // against one of the order's rows. Every status but cancelled counts — a
  // draft is already the old supplier's invoice being registered against
  // this order; an avbruten faktura is history.
  const invoiceIds = new Map<string, string>();
  const headerInvoices = await dbc
    .select({ id: supplierInvoices.id, number: supplierInvoices.registrationNumber })
    .from(supplierInvoices)
    .where(and(eq(supplierInvoices.purchaseOrderId, orderId), ne(supplierInvoices.status, "cancelled")));
  for (const inv of headerInvoices) invoiceIds.set(inv.id, inv.number);
  if (rowIds.length > 0) {
    const rowInvoices = await dbc
      .selectDistinct({ id: supplierInvoices.id, number: supplierInvoices.registrationNumber })
      .from(supplierInvoiceRows)
      .innerJoin(supplierInvoices, eq(supplierInvoices.id, supplierInvoiceRows.supplierInvoiceId))
      .where(and(inArray(supplierInvoiceRows.purchaseOrderRowId, rowIds), ne(supplierInvoices.status, "cancelled")));
    for (const inv of rowInvoices) invoiceIds.set(inv.id, inv.number);
  }

  // Avvikelser: a case names its supplier and may only point at that
  // supplier's orders (deviation-link-check.ts, deviation-link-tx.ts) — the
  // column, the row column and Koppla dokument all count, cancelled cases not.
  const deviationRows = await dbc
    .selectDistinct({ id: deviations.id, number: deviations.deviationNumber })
    .from(deviations)
    .leftJoin(
      deviationLinks,
      and(eq(deviationLinks.deviationId, deviations.id), eq(deviationLinks.documentType, "purchase_order"), eq(deviationLinks.documentId, orderId))
    )
    .where(
      and(
        ne(deviations.status, "cancelled"),
        or(
          eq(deviations.purchaseOrderId, orderId),
          rowIds.length > 0 ? inArray(deviations.purchaseOrderRowId, rowIds) : sql`false`,
          sql`${deviationLinks.id} is not null`
        )
      )
    );

  const defaults = resolveOrderDefaults(await loadSupplierOrderDefaults(dbc, supplierId), {});
  return {
    ok: true,
    supplierActive: supplier.active,
    facts: {
      order: { ...order, exchangeRate: Number(order.exchangeRate) },
      supplier: {
        id: supplier.id,
        name: supplier.name,
        currency: supplier.currency,
        deliveryTermId: supplier.deliveryTermId,
        paymentTermId: supplier.paymentTermId,
        carrierId: supplier.carrierId,
        deliveryTerm: label(supplier.deliveryTermCode, supplier.deliveryTermName),
        paymentTerm: label(supplier.paymentTermCode, supplier.paymentTermName),
        carrier: label(supplier.carrierCode, supplier.carrierName),
      },
      defaults,
      rows: rows.map((r) => ({
        rowId: r.rowId,
        articleId: r.articleId,
        articleNumber: r.articleNumber,
        articleName: r.articleName,
        quantity: Number(r.quantity),
        quantityReceived: Number(r.quantityReceived),
        unitPrice: Number(r.unitPrice),
        setupPrice: r.setupPrice === null ? null : Number(r.setupPrice),
        unitCode: r.unitCode,
        unitFactor: r.unitFactor === null ? null : Number(r.unitFactor),
        moOperationId: r.moOperationId,
        confirmedDeliveryDate: r.confirmedDeliveryDate,
        operationSupplierId: r.operationSupplierId,
        catalog: catalogByArticle.get(r.articleId) ?? null,
      })),
      liveReceipts: receipts?.n ?? 0,
      liveDispatches: dispatches?.n ?? 0,
      supplierInvoices: [...invoiceIds.values()].sort(),
      deviations: deviationRows.map((d) => d.number).sort(),
    },
  };
}

export type ChangeOrderSupplierResult =
  | { ok: true; plan: SupplierChangePreview; statusBefore: PurchaseOrderStatus; revision: number }
  | { ok: false; reason: "order_not_found" | "supplier_not_found" | "same_supplier" }
  // The plan under the locks has blockers (status included).
  | { ok: false; reason: "blocked"; plan: SupplierChangePreview }
  // The plan under the locks is not what the user confirmed — nothing written.
  | { ok: false; reason: "stale" };

// `rate`: the rate the service looked up BEFORE the transaction for the
// currency pair it read unlocked (`from` → `to`). Another pair under the
// locks (the order or the supplier changed currency meanwhile) is `stale`.
export async function changeOrderSupplier(
  db: Db,
  orderId: string,
  input: ChangePurchaseOrderSupplierInput,
  rate: { from: string; to: string; rate: number }
): Promise<ChangeOrderSupplierResult> {
  return db.transaction(async (tx): Promise<ChangeOrderSupplierResult> => {
    const locked = await tx
      .select({ id: purchaseOrderRows.id })
      .from(purchaseOrderRows)
      .where(eq(purchaseOrderRows.purchaseOrderId, orderId))
      .orderBy(asc(purchaseOrderRows.id))
      .for("update");
    const [order] = await tx.select({ id: purchaseOrders.id }).from(purchaseOrders).where(eq(purchaseOrders.id, orderId)).for("update");
    if (!order) return { ok: false, reason: "order_not_found" };

    // Everything again, under the locks.
    const loaded = await loadSupplierChangeFacts(tx, orderId, input.supplierId);
    if (!loaded.ok) return loaded;
    const { facts } = loaded;
    if (facts.order.supplierId === input.supplierId) return { ok: false, reason: "same_supplier" };
    const lockedIds = new Set(locked.map((r) => r.id));
    if (facts.rows.length !== lockedIds.size || facts.rows.some((r) => !lockedIds.has(r.rowId))) return { ok: false, reason: "stale" };
    if (facts.order.currency !== rate.from || facts.supplier.currency !== rate.to) return { ok: false, reason: "stale" };

    const plan = planSupplierChange(facts, facts.order.currency === facts.supplier.currency ? facts.order.exchangeRate : rate.rate);
    if (plan.blockers.length > 0) return { ok: false, reason: "blocked", plan };
    if (!matchesExpectedSupplierChange(plan, input.expected)) return { ok: false, reason: "stale" };

    for (const row of plan.rows) {
      if (row.after.unitPrice === row.before.unitPrice && row.after.setupPrice === row.before.setupPrice) continue;
      await tx
        .update(purchaseOrderRows)
        .set({
          unitPrice: String(row.after.unitPrice),
          setupPrice: row.after.setupPrice === null ? null : String(row.after.setupPrice),
        })
        .where(eq(purchaseOrderRows.id, row.rowId));
    }
    // Bekräftat leveransdatum was the old supplier's promise — cleared on
    // the rows and the header (Önskat stays); the effective arrival date lets
    // a confirmed date win (order-dates.md).
    await tx
      .update(purchaseOrderRows)
      .set({ confirmedDeliveryDate: null })
      .where(and(eq(purchaseOrderRows.purchaseOrderId, orderId), isNotNull(purchaseOrderRows.confirmedDeliveryDate)));
    // As a new order to this supplier: currency, terms and the förval. A
    // confirmed order goes back to draft; the revision is bumped once.
    const [updated] = await tx
      .update(purchaseOrders)
      .set({
        supplierId: facts.supplier.id,
        currency: plan.to.currency,
        exchangeRate: String(plan.to.exchangeRate),
        deliveryTermId: facts.supplier.deliveryTermId,
        paymentTermId: facts.supplier.paymentTermId,
        carrierId: facts.supplier.carrierId,
        freightPaidByUs: facts.defaults.freightPaidByUs,
        yourReference: facts.defaults.yourReference,
        confirmedDeliveryDate: null,
        status: "draft",
        revision: sql`${purchaseOrders.revision} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(purchaseOrders.id, orderId))
      .returning({ revision: purchaseOrders.revision });
    return { ok: true, plan, statusBefore: facts.order.status, revision: updated!.revision };
  });
}

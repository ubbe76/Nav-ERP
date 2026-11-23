// Byt leverantör på en inköpsorder — the pure plan. No DB imports: the
// repository leaf (repository/supplier-change.ts) loads the facts, unlocked
// for the preview and under the row and order locks for the change itself,
// and BOTH go through planSupplierChange, so the preview the user saw and
// what the transaction writes can never be two different rules.
//
// Prices: a row the NEW supplier has a catalog price for (staffel included,
// resolveSupplierPrice for the row's base quantity, and only when the catalog
// row's currency is the order's new currency — the same condition as the IO
// card's prefill and Skapa ordrar) gets that price. Every other row keeps its
// value in kronor: converted with old rate / new rate when the currency
// changes, untouched otherwise — and is marked for review. A lego row never
// reads the catalog: the catalog prices the ARTICLE, the row buys an
// operation; its ställpris is converted with two decimals.
import {
  round4,
  roundToDecimals,
  type ChangePurchaseOrderSupplierInput,
  type PurchaseOrderStatus,
  type SupplierChangeBlockerCode,
  type SupplierChangePreview,
} from "@navet/shared";
import { resolveSupplierPrice, type PriceBreak } from "./supplier-price.js";

// Skickad (2026-11-23) like Bekräftad: the old supplier has the order.
export const SUPPLIER_CHANGE_STATUSES: readonly PurchaseOrderStatus[] = ["draft", "sent", "confirmed"];

export interface SupplierChangeFacts {
  order: {
    id: string;
    orderNumber: string;
    status: PurchaseOrderStatus;
    supplierId: string;
    supplierName: string;
    currency: string;
    exchangeRate: number;
    confirmedDeliveryDate: string | null;
  };
  supplier: {
    id: string;
    name: string;
    currency: string;
    deliveryTermId: string | null;
    paymentTermId: string | null;
    carrierId: string | null;
    deliveryTerm: string | null;
    paymentTerm: string | null;
    carrier: string | null;
  };
  // resolveOrderDefaults(loadSupplierOrderDefaults(new supplier), {}).
  defaults: { freightPaidByUs: boolean; yourReference: string | null };
  rows: {
    rowId: string;
    articleId: string;
    articleNumber: string;
    articleName: string;
    quantity: number;
    quantityReceived: number;
    unitPrice: number;
    setupPrice: number | null;
    unitCode: string;
    unitFactor: number | null;
    moOperationId: string | null;
    confirmedDeliveryDate: string | null;
    // The TO operation's own Leverantör (null without one / not a lego row).
    operationSupplierId: string | null;
    // The new supplier's catalog row for the article, null without one.
    catalog: { price: number | null; currency: string; priceBreaks: PriceBreak[] } | null;
  }[];
  // What has happened with the order at the current supplier.
  liveReceipts: number;
  liveDispatches: number;
  // Registration numbers (LF-…) of the invoices that are not cancelled.
  supplierInvoices: string[];
  // Numbers of the deviations that are not cancelled.
  deviations: string[];
}

function blockersOf(facts: SupplierChangeFacts): SupplierChangePreview["blockers"] {
  const blockers: { code: SupplierChangeBlockerCode; message: string }[] = [];
  if (!SUPPLIER_CHANGE_STATUSES.includes(facts.order.status)) {
    blockers.push({
      code: "invalid-status-transition",
      message: "Leverantören kan bara bytas på en inköpsorder i Utkast eller Bekräftad.",
    });
  }
  if (facts.liveReceipts > 0 || facts.rows.some((r) => r.quantityReceived > 0)) {
    blockers.push({
      code: "purchase-order-has-receipts",
      message: "Ordern har en inleverans — ångra inleveransen innan leverantören byts.",
    });
  }
  if (facts.liveDispatches > 0) {
    blockers.push({
      code: "purchase-order-has-dispatches",
      message: "Ordern har en avsändning till legoleverantören — ångra avsändningen innan leverantören byts.",
    });
  }
  if (facts.supplierInvoices.length > 0) {
    blockers.push({
      code: "purchase-order-has-supplier-invoices",
      message: `Ordern är kopplad till leverantörsfaktura ${facts.supplierInvoices.join(", ")} — ta bort kopplingen eller avbryt fakturan innan leverantören byts.`,
    });
  }
  if (facts.deviations.length > 0) {
    blockers.push({
      code: "purchase-order-has-deviations",
      message: `Ordern hör till avvikelse ${facts.deviations.join(", ")} hos den nuvarande leverantören — leverantören kan inte bytas.`,
    });
  }
  return blockers;
}

// Whether the change needs a rate looked up: only when the currency changes
// (the same currency keeps the order's own rate, SEK is always 1).
export function supplierChangeCurrencies(facts: SupplierChangeFacts): { from: string; to: string; changes: boolean } {
  return { from: facts.order.currency, to: facts.supplier.currency, changes: facts.order.currency !== facts.supplier.currency };
}

// `newRate`: SEK per 1 unit of the new supplier's currency — the caller
// passes the order's own rate when the currency stays.
export function planSupplierChange(facts: SupplierChangeFacts, newRate: number): SupplierChangePreview {
  const { order, supplier } = facts;
  const currencyChanges = order.currency !== supplier.currency;
  const convert = (price: number, decimals: number) =>
    currencyChanges ? roundToDecimals((price * order.exchangeRate) / newRate, decimals) : price;

  const rows = facts.rows.map((row): SupplierChangePreview["rows"][number] => {
    const lego = row.moOperationId !== null;
    const catalogPrice =
      !lego && row.catalog && row.catalog.currency === supplier.currency
        ? resolveSupplierPrice({ price: row.catalog.price, priceBreaks: row.catalog.priceBreaks }, row.quantity).price
        : null;
    const unitPrice = catalogPrice !== null ? round4(catalogPrice) : convert(row.unitPrice, 4);
    const setupPrice = row.setupPrice === null ? null : convert(row.setupPrice, 2);
    return {
      rowId: row.rowId,
      articleId: row.articleId,
      articleNumber: row.articleNumber,
      articleName: row.articleName,
      quantity: row.quantity,
      unitCode: row.unitCode,
      unitFactor: row.unitFactor,
      lego,
      confirmedDeliveryDate: row.confirmedDeliveryDate,
      before: { unitPrice: row.unitPrice, setupPrice: row.setupPrice },
      after: { unitPrice, setupPrice },
      origin: catalogPrice !== null ? "catalog" : currencyChanges ? "converted" : "unchanged",
      review: catalogPrice === null,
      operationSupplierDiffers: lego && row.operationSupplierId !== null && row.operationSupplierId !== supplier.id,
    };
  });

  return {
    orderId: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
    revertsToDraft: order.status === "sent" || order.status === "confirmed",
    // Not part of what `expected` is compared with: every confirmed date is
    // cleared under the locks whatever it is by then (the audit row has them).
    clearsConfirmedDates: order.confirmedDeliveryDate !== null || facts.rows.some((r) => r.confirmedDeliveryDate !== null),
    confirmedDeliveryDate: order.confirmedDeliveryDate,
    from: { supplierId: order.supplierId, supplierName: order.supplierName, currency: order.currency, exchangeRate: order.exchangeRate },
    to: { supplierId: supplier.id, supplierName: supplier.name, currency: supplier.currency, exchangeRate: newRate },
    terms: {
      deliveryTerm: supplier.deliveryTerm,
      paymentTerm: supplier.paymentTerm,
      carrier: supplier.carrier,
      freightPaidByUs: facts.defaults.freightPaidByUs,
      yourReference: facts.defaults.yourReference,
    },
    blockers: blockersOf(facts),
    rows,
  };
}

// Does the plan still say what the user confirmed? Compared at the columns'
// scales (rate 6, price 4, ställpris 2 decimals); the rows as a set.
export function matchesExpectedSupplierChange(plan: SupplierChangePreview, expected: ChangePurchaseOrderSupplierInput["expected"]): boolean {
  if (plan.from.supplierId !== expected.supplierId) return false;
  if (plan.to.currency !== expected.currency) return false;
  if (roundToDecimals(plan.to.exchangeRate, 6) !== roundToDecimals(expected.exchangeRate, 6)) return false;
  if (plan.rows.length !== expected.rows.length) return false;
  const byId = new Map(expected.rows.map((r) => [r.rowId, r]));
  if (byId.size !== expected.rows.length) return false;
  return plan.rows.every((row) => {
    const seen = byId.get(row.rowId);
    if (!seen) return false;
    if (round4(seen.unitPrice) !== round4(row.after.unitPrice)) return false;
    if ((seen.setupPrice === null) !== (row.after.setupPrice === null)) return false;
    return seen.setupPrice === null || roundToDecimals(seen.setupPrice, 2) === roundToDecimals(row.after.setupPrice!, 2);
  });
}

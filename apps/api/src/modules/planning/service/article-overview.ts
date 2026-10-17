// Artikelöversikt — Monitor G5's "planeringsbild" for ONE article: every
// open demand and supply as its own row, in date order, with a running
// projected balance. Pure like requirements-calc.ts: the repository loads
// flat rows, this module owns the rules. It deliberately shares the status
// sets and the phantom-dissolving explosion with the behovsberäkning so the
// two can never disagree about what counts — closingBalance equals the MRP
// row's projected minus demandDerived (derived demand comes from order
// PROPOSALS, which are not orders yet and therefore have no row here).
import {
  DEMAND_SALES_STATUSES,
  MATERIAL_MO_STATUSES,
  SUPPLY_MO_STATUSES,
  SUPPLY_PO_STATUSES,
  buildBomIndex,
  explodeFromIndex,
  type BomEdge,
  type ManufacturingOrderStatus,
  type PurchaseOrderStatus,
  type SalesOrderStatus,
} from "./requirements-calc.js";
import type { PartnerDeliveryFields } from "../../system/service/delivery-days.js";

export interface OverviewArticle {
  articleId: string;
  articleNumber: string;
  name: string;
  type: "manufactured" | "purchased" | "service";
  isPhantom: boolean;
  active: boolean;
  unitCode: string | null;
  reorderPoint: number | null;
  orderQuantity: number | null;
  // Same article shape as RequirementsArticle so the two readers never drift;
  // the overview itself rounds nothing.
  rounding: number | null;
}

export interface OverviewSalesRow {
  rowId: string;
  salesOrderId: string;
  orderNumber: string;
  orderStatus: SalesOrderStatus;
  customerName: string;
  // The date the row is planned by. The repository loads the order's
  // delivery date (the day the customer gets the goods); the planning
  // service moves it to the ship date (fasta leveransdagar) before the
  // builder runs. The builder itself never looks at customerDelivery.
  expectedDeliveryDate: string | null;
  customerDelivery?: PartnerDeliveryFields;
  quantityOrdered: number;
  quantityDelivered: number;
}

// Only rows without mo_operation_id — lego rows are operation demand, never
// article supply (see loadRequirementsInput).
export interface OverviewPurchaseRow {
  rowId: string;
  purchaseOrderId: string;
  orderNumber: string;
  orderStatus: PurchaseOrderStatus;
  supplierName: string;
  expectedDeliveryDate: string | null;
  quantityOrdered: number;
  quantityReceived: number;
}

// MOs FOR the article (supply).
export interface OverviewManufacturingOrder {
  moId: string;
  orderNumber: string;
  status: ManufacturingOrderStatus;
  dueDate: string | null;
  quantity: number;
}

// Material snapshot rows where the article is the component.
export interface OverviewMaterialRow {
  rowId: string;
  moId: string;
  orderNumber: string;
  orderStatus: ManufacturingOrderStatus;
  dueDate: string | null;
  parentArticleNumber: string;
  parentArticleName: string;
  quantityPlanned: number;
  quantityConsumed: number;
}

// Every status = planned MO, regardless of article — a planned MO has no
// snapshot yet, so which ones need this article is decided by exploding
// the parent's BOM (one level, phantoms dissolved), exactly as the MRP does.
export interface OverviewPlannedMo {
  moId: string;
  orderNumber: string;
  dueDate: string | null;
  parentArticleId: string;
  parentArticleNumber: string;
  parentArticleName: string;
  quantity: number;
}

export interface ArticleOverviewInput {
  article: OverviewArticle;
  onHand: number;
  salesRows: OverviewSalesRow[];
  purchaseRows: OverviewPurchaseRow[];
  manufacturingOrders: OverviewManufacturingOrder[];
  materialRows: OverviewMaterialRow[];
  plannedMos: OverviewPlannedMo[];
  bomEdges: BomEdge[];
  phantomIds: string[];
  primarySupplier: { supplierId: string; supplierName: string; leadTimeDays: number | null } | null;
}

export type OverviewRowKind =
  | "sales_order"
  | "mo_material"
  | "mo_planned_material"
  | "manufacturing_order"
  | "purchase_order";

export interface ArticleOverviewRow {
  // Kind-prefixed source id — unique across kinds, stable between reloads.
  id: string;
  kind: OverviewRowKind;
  direction: "demand" | "supply";
  date: string | null; // YYYY-MM-DD; null = the order has no date yet
  documentType: "sales_order" | "purchase_order" | "manufacturing_order";
  documentId: string;
  documentNumber: string;
  status: string;
  // Customer / supplier name; for MO material the parent article.
  partner: string | null;
  quantity: number; // SIGNED: demand < 0, supply > 0
  balance: number; // onHand + Σ quantity up to and including this row
  isDraft: boolean; // draft IO — counted (like supplyPoDraft), but marked
}

export interface ArticleOverview {
  article: OverviewArticle;
  primarySupplier: ArticleOverviewInput["primarySupplier"];
  onHand: number;
  rows: ArticleOverviewRow[];
  closingBalance: number;
}

// Same day: receipts before withdrawals, then a fixed kind order, then the
// document number — so two loads of the same data render identically.
const KIND_ORDER: Record<OverviewRowKind, number> = {
  purchase_order: 0,
  manufacturing_order: 1,
  sales_order: 2,
  mo_material: 3,
  mo_planned_material: 4,
};

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareOverviewRows(a: ArticleOverviewRow, b: ArticleOverviewRow): number {
  if (a.date !== b.date) {
    if (a.date === null) return 1;
    if (b.date === null) return -1;
    return compareStrings(a.date, b.date);
  }
  if (a.direction !== b.direction) return a.direction === "supply" ? -1 : 1;
  if (KIND_ORDER[a.kind] !== KIND_ORDER[b.kind]) return KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
  if (a.documentNumber !== b.documentNumber) return compareStrings(a.documentNumber, b.documentNumber);
  return compareStrings(a.id, b.id);
}

// Quantities are numeric(14,4); summing floats in JS leaves noise like
// 0.30000000000000004 that would render as such. Same scale as the units
// helpers (QUANTITY_SCALE = 4).
function round4(n: number): number {
  return Math.round((n + Number.EPSILON) * 1e4) / 1e4;
}

export function buildArticleOverview(input: ArticleOverviewInput): ArticleOverview {
  const articleId = input.article.articleId;
  const rows: ArticleOverviewRow[] = [];

  for (const row of input.salesRows) {
    if (!DEMAND_SALES_STATUSES.has(row.orderStatus)) continue;
    const rest = Math.max(row.quantityOrdered - row.quantityDelivered, 0);
    if (rest <= 0) continue;
    rows.push({
      id: `so:${row.rowId}`,
      kind: "sales_order",
      direction: "demand",
      date: row.expectedDeliveryDate,
      documentType: "sales_order",
      documentId: row.salesOrderId,
      documentNumber: row.orderNumber,
      status: row.orderStatus,
      partner: row.customerName,
      quantity: -rest,
      balance: 0,
      isDraft: false,
    });
  }

  for (const row of input.purchaseRows) {
    const isDraft = row.orderStatus === "draft";
    if (!isDraft && !SUPPLY_PO_STATUSES.has(row.orderStatus)) continue;
    const rest = Math.max(row.quantityOrdered - row.quantityReceived, 0);
    if (rest <= 0) continue;
    rows.push({
      id: `po:${row.rowId}`,
      kind: "purchase_order",
      direction: "supply",
      date: row.expectedDeliveryDate,
      documentType: "purchase_order",
      documentId: row.purchaseOrderId,
      documentNumber: row.orderNumber,
      status: row.orderStatus,
      partner: row.supplierName,
      quantity: rest,
      balance: 0,
      isDraft,
    });
  }

  for (const order of input.manufacturingOrders) {
    if (!SUPPLY_MO_STATUSES.has(order.status)) continue;
    if (order.quantity <= 0) continue;
    rows.push({
      id: `mo:${order.moId}`,
      kind: "manufacturing_order",
      direction: "supply",
      date: order.dueDate,
      documentType: "manufacturing_order",
      documentId: order.moId,
      documentNumber: order.orderNumber,
      status: order.status,
      partner: null,
      quantity: order.quantity,
      balance: 0,
      isDraft: false,
    });
  }

  for (const row of input.materialRows) {
    if (!MATERIAL_MO_STATUSES.has(row.orderStatus)) continue;
    const rest = Math.max(row.quantityPlanned - row.quantityConsumed, 0);
    if (rest <= 0) continue;
    rows.push({
      id: `mat:${row.rowId}`,
      kind: "mo_material",
      direction: "demand",
      date: row.dueDate,
      documentType: "manufacturing_order",
      documentId: row.moId,
      documentNumber: row.orderNumber,
      status: row.orderStatus,
      partner: `${row.parentArticleNumber} — ${row.parentArticleName}`,
      quantity: -rest,
      balance: 0,
      isDraft: false,
    });
  }

  // Exploding per MO (rather than the MRP's summed-per-parent shortcut)
  // gives one row per order; explosion is linear, so the totals agree.
  // The BOM index is built once per request, not once per planned MO.
  const phantomIds = new Set(input.phantomIds);
  const bomIndex = buildBomIndex(input.bomEdges);
  for (const mo of input.plannedMos) {
    const need = explodeFromIndex(bomIndex, phantomIds, mo.parentArticleId, mo.quantity).get(articleId) ?? 0;
    if (need <= 0) continue;
    rows.push({
      id: `pmat:${mo.moId}`,
      kind: "mo_planned_material",
      direction: "demand",
      date: mo.dueDate,
      documentType: "manufacturing_order",
      documentId: mo.moId,
      documentNumber: mo.orderNumber,
      status: "planned",
      partner: `${mo.parentArticleNumber} — ${mo.parentArticleName}`,
      quantity: -need,
      balance: 0,
      isDraft: false,
    });
  }

  rows.sort(compareOverviewRows);

  let balance = input.onHand;
  for (const row of rows) {
    balance = round4(balance + row.quantity);
    row.balance = balance;
  }

  return {
    article: input.article,
    primarySupplier: input.primarySupplier,
    onHand: input.onHand,
    rows,
    closingBalance: balance,
  };
}

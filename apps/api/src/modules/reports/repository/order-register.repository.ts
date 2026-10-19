import { and, asc, eq, gt, gte, inArray, lte, sql, type SQL } from "drizzle-orm";
import {
  articles,
  customers,
  purchaseOrderRows,
  purchaseOrders,
  salesOrderRows,
  salesOrders,
  suppliers,
  units,
  type Db,
} from "@navet/db";
import {
  PURCHASE_ORDER_OPEN_STATUSES,
  SALES_ORDER_OPEN_STATUSES,
  type PurchaseOrderRegisterQuery,
  type SalesOrderRegisterQuery,
} from "@navet/shared";
import { purchaseRowArrivalDate, salesRowDeliveryDate } from "../../planning/repository/effective-dates.js";

// Orderförteckning — one flat row per matching ORDER ROW, ordered by order
// number then row creation (the cards' row order). The pure builder in
// order-register.ts groups them into orders. Quantities and prices stay in
// the base unit here; the builder converts to the row's unit.
export interface OrderRegisterSourceRow {
  orderId: string;
  orderNumber: string;
  status: string;
  orderDate: string; // YYYY-MM-DD, Stockholm
  partnerNumber: string;
  partnerName: string;
  currency: string;
  exchangeRate: number;
  articleNumber: string;
  articleName: string;
  unitCode: string | null; // the row's unit, else the article's base unit
  unitFactor: string | null;
  quantity: number; // base unit
  done: number; // delivered / received, base unit
  unitPrice: number; // per base unit, order currency
  discountPercent: number;
  setupPrice: number | null; // purchase only (ställpris)
  deliveryDate: string | null; // effective date
}

// Hard ceiling, same figure as the list exports — the register refuses
// (OrderRegisterTooLargeError) instead of printing a silently cut list.
export const ORDER_REGISTER_MAX_ROWS = 10_000;

// Order date = the order's creation day in Stockholm (orders have no
// separate order date column).
const salesOrderDate = sql<string>`to_char(${salesOrders.createdAt} at time zone 'Europe/Stockholm', 'YYYY-MM-DD')`;
const purchaseOrderDate = sql<string>`to_char(${purchaseOrders.createdAt} at time zone 'Europe/Stockholm', 'YYYY-MM-DD')`;

function dateConditions(
  query: { dateBasis: "order" | "delivery"; from?: string; to?: string },
  orderDate: SQL,
  deliveryDate: SQL
): SQL[] {
  const column = query.dateBasis === "order" ? orderDate : deliveryDate;
  const conditions: SQL[] = [];
  if (query.from) conditions.push(gte(column, query.from));
  if (query.to) conditions.push(lte(column, query.to));
  return conditions;
}

export function createOrderRegisterRepository(db: Db) {
  return {
    // limit = ORDER_REGISTER_MAX_ROWS + 1 so the caller can tell "exactly at
    // the ceiling" from "over it" without a second count query.
    async loadSalesRows(query: SalesOrderRegisterQuery, limit: number): Promise<OrderRegisterSourceRow[]> {
      const conditions: SQL[] = dateConditions(query, salesOrderDate, salesRowDeliveryDate);
      if (query.partnerId) conditions.push(eq(salesOrders.customerId, query.partnerId));
      if (query.status === "open") conditions.push(inArray(salesOrders.status, [...SALES_ORDER_OPEN_STATUSES]));
      else if (query.status) conditions.push(inArray(salesOrders.status, query.status));
      if (query.openOnly) conditions.push(gt(salesOrderRows.quantityOrdered, salesOrderRows.quantityDelivered));
      if (query.articleId) conditions.push(eq(salesOrderRows.articleId, query.articleId));
      if (query.articleGroupId) conditions.push(eq(articles.groupId, query.articleGroupId));

      const rows = await db
        .select({
          orderId: salesOrders.id,
          orderNumber: salesOrders.orderNumber,
          status: salesOrders.status,
          orderDate: salesOrderDate,
          partnerNumber: customers.customerNumber,
          partnerName: customers.name,
          articleNumber: articles.articleNumber,
          articleName: articles.name,
          unitCode: sql<string | null>`coalesce(${units.code}, (select u.code from ${units} u where u.id = ${articles.unitId}))`,
          unitFactor: salesOrderRows.unitFactor,
          quantity: salesOrderRows.quantityOrdered,
          done: salesOrderRows.quantityDelivered,
          unitPrice: salesOrderRows.unitPrice,
          discountPercent: salesOrderRows.discountPercent,
          deliveryDate: salesRowDeliveryDate,
        })
        .from(salesOrderRows)
        .innerJoin(salesOrders, eq(salesOrders.id, salesOrderRows.salesOrderId))
        .innerJoin(customers, eq(customers.id, salesOrders.customerId))
        .innerJoin(articles, eq(articles.id, salesOrderRows.articleId))
        .leftJoin(units, eq(units.id, salesOrderRows.unitId))
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(asc(salesOrders.orderNumber), asc(salesOrderRows.createdAt), asc(salesOrderRows.id))
        .limit(limit);

      return rows.map((r) => ({
        ...r,
        currency: "SEK",
        exchangeRate: 1,
        quantity: Number(r.quantity),
        done: Number(r.done),
        unitPrice: Number(r.unitPrice),
        discountPercent: Number(r.discountPercent),
        setupPrice: null,
      }));
    },

    async loadPurchaseRows(query: PurchaseOrderRegisterQuery, limit: number): Promise<OrderRegisterSourceRow[]> {
      const conditions: SQL[] = dateConditions(query, purchaseOrderDate, purchaseRowArrivalDate);
      if (query.partnerId) conditions.push(eq(purchaseOrders.supplierId, query.partnerId));
      if (query.status === "open") conditions.push(inArray(purchaseOrders.status, [...PURCHASE_ORDER_OPEN_STATUSES]));
      else if (query.status) conditions.push(inArray(purchaseOrders.status, query.status));
      if (query.openOnly) conditions.push(gt(purchaseOrderRows.quantityOrdered, purchaseOrderRows.quantityReceived));
      if (query.articleId) conditions.push(eq(purchaseOrderRows.articleId, query.articleId));
      if (query.articleGroupId) conditions.push(eq(articles.groupId, query.articleGroupId));

      const rows = await db
        .select({
          orderId: purchaseOrders.id,
          orderNumber: purchaseOrders.orderNumber,
          status: purchaseOrders.status,
          orderDate: purchaseOrderDate,
          partnerNumber: suppliers.supplierNumber,
          partnerName: suppliers.name,
          currency: purchaseOrders.currency,
          exchangeRate: purchaseOrders.exchangeRate,
          articleNumber: articles.articleNumber,
          articleName: articles.name,
          unitCode: sql<string | null>`coalesce(${units.code}, (select u.code from ${units} u where u.id = ${articles.unitId}))`,
          unitFactor: purchaseOrderRows.unitFactor,
          quantity: purchaseOrderRows.quantityOrdered,
          done: purchaseOrderRows.quantityReceived,
          unitPrice: purchaseOrderRows.unitPrice,
          setupPrice: purchaseOrderRows.setupPrice,
          deliveryDate: purchaseRowArrivalDate,
        })
        .from(purchaseOrderRows)
        .innerJoin(purchaseOrders, eq(purchaseOrders.id, purchaseOrderRows.purchaseOrderId))
        .innerJoin(suppliers, eq(suppliers.id, purchaseOrders.supplierId))
        .innerJoin(articles, eq(articles.id, purchaseOrderRows.articleId))
        .leftJoin(units, eq(units.id, purchaseOrderRows.unitId))
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(asc(purchaseOrders.orderNumber), asc(purchaseOrderRows.createdAt), asc(purchaseOrderRows.id))
        .limit(limit);

      return rows.map((r) => ({
        ...r,
        exchangeRate: Number(r.exchangeRate),
        quantity: Number(r.quantity),
        done: Number(r.done),
        unitPrice: Number(r.unitPrice),
        discountPercent: 0,
        setupPrice: r.setupPrice !== null ? Number(r.setupPrice) : null,
      }));
    },
  };
}

export type OrderRegisterRepository = ReturnType<typeof createOrderRegisterRepository>;

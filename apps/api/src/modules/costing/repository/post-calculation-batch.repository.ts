import { and, asc, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { articles, costCalculations, manufacturingOrders, type Db, type Tx } from "@navet/db";
import type { ManufacturingOrderStatus, PostCalculationBatchSelection } from "@navet/shared";
import { lastReceiptDaySql, lastReceivedOnSql } from "../../manufacturing/repository/last-receipt.js";

// Efterkalkylera flera (#34): which manufacturing orders a batch runs over.
// A Db | Tx leaf like pre-calculation-batch.repository.ts. The selection is
// ONE where; "senaste inleverans" — the date filter, the row's
// lastReceivedOn and the sort — is the one rule in
// manufacturing/repository/last-receipt.ts.

export interface BatchOrder {
  id: string;
  orderNumber: string;
  status: ManufacturingOrderStatus;
  // The order's received quantity — N of a final efterkalkyl.
  quantityReceived: string;
  articleId: string;
  articleNumber: string;
  articleName: string;
  // Stockholm day of the latest live receipt; null without one.
  lastReceivedOn: string | null;
}

const columns = {
  id: manufacturingOrders.id,
  orderNumber: manufacturingOrders.orderNumber,
  status: manufacturingOrders.status,
  quantityReceived: manufacturingOrders.quantityReceived,
  articleId: articles.id,
  articleNumber: articles.articleNumber,
  articleName: articles.name,
  lastReceivedOn: lastReceivedOnSql,
};

// Oldest receipt first, orders without a receipt last, then TO number (id
// as the final tiebreaker so the order is total).
export async function selectBatchOrders(dbc: Db | Tx, selection: PostCalculationBatchSelection): Promise<BatchOrder[]> {
  const where: SQL[] = [inArray(manufacturingOrders.status, selection.statuses)];
  // A comparison with null is not true, so an order without a live receipt
  // falls outside any date selection (the user's decision 1).
  if (selection.receivedFrom !== undefined) where.push(sql`${lastReceiptDaySql} >= ${selection.receivedFrom}::date`);
  if (selection.receivedTo !== undefined) where.push(sql`${lastReceiptDaySql} <= ${selection.receivedTo}::date`);
  if (selection.articleNumberFrom !== undefined) where.push(sql`${articles.articleNumber} collate "C" >= ${selection.articleNumberFrom}`);
  if (selection.articleNumberTo !== undefined) where.push(sql`${articles.articleNumber} collate "C" <= ${selection.articleNumberTo}`);
  if (selection.articleId !== undefined) where.push(eq(manufacturingOrders.articleId, selection.articleId));
  if (selection.groupId !== undefined) where.push(eq(articles.groupId, selection.groupId));
  return dbc
    .select(columns)
    .from(manufacturingOrders)
    .innerJoin(articles, eq(articles.id, manufacturingOrders.articleId))
    .where(and(...where))
    .orderBy(sql`${lastReceiptDaySql} asc nulls last`, asc(manufacturingOrders.orderNumber), asc(manufacturingOrders.id));
}

// The save's labels: the given ids' TO numbers. Unknown ids are simply absent.
export async function labelBatchOrders(dbc: Db | Tx, orderIds: readonly string[]): Promise<Map<string, string>> {
  if (orderIds.length === 0) return new Map();
  const rows = await dbc
    .select({ id: manufacturingOrders.id, orderNumber: manufacturingOrders.orderNumber })
    .from(manufacturingOrders)
    .where(inArray(manufacturingOrders.id, [...new Set(orderIds)]));
  return new Map(rows.map((row) => [row.id, row.orderNumber]));
}

// Each order's latest SAVED efterkalkyl: type "post", newest calculated_at,
// id as the tiebreaker — the same pick as Kalkylutfall's DISTINCT ON
// (reports.repository.ts). Orders without one are absent.
export async function latestPostCalculations(
  dbc: Db | Tx,
  orderIds: readonly string[]
): Promise<Map<string, { calculationId: string; calculatedAt: Date }>> {
  if (orderIds.length === 0) return new Map();
  const rows = await dbc
    .selectDistinctOn([costCalculations.manufacturingOrderId], {
      manufacturingOrderId: costCalculations.manufacturingOrderId,
      calculationId: costCalculations.id,
      calculatedAt: costCalculations.calculatedAt,
    })
    .from(costCalculations)
    .where(and(eq(costCalculations.type, "post"), inArray(costCalculations.manufacturingOrderId, [...orderIds])))
    .orderBy(asc(costCalculations.manufacturingOrderId), desc(costCalculations.calculatedAt), desc(costCalculations.id));
  return new Map(rows.map((row) => [row.manufacturingOrderId!, { calculationId: row.calculationId, calculatedAt: row.calculatedAt }]));
}

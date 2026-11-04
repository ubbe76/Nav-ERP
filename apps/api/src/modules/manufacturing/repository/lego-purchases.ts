// Legoinköp på TO-kortet: for every lego operation of one TO, what is already
// bought (legoOrderedQuantitySql — the same figure the behovsberäkning
// deducts) and the documents behind it: the IO rows pointing at the
// operation on orders that are not cancelled, and the förfrågningar still
// open (draft/sent/answered — an ordered one is superseded by its IO, as on
// the behovsberäkning's lego row). Read straight from the purchase tables
// like order-edit.ts's resource-switch guard does.
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import {
  inquiries,
  inquiryRows,
  moOperations,
  purchaseOrderRows,
  purchaseOrders,
  workCenters,
  type Db,
} from "@navet/db";
import { legoOrderedQuantitySql } from "./lego-one-off.js";

const OPEN_INQUIRY = ["draft", "sent", "answered"] as const;

export interface LegoPurchaseOperation {
  moOperationId: string;
  orderedQuantity: number;
  purchaseOrders: {
    purchaseOrderId: string;
    orderNumber: string;
    status: string;
    quantityOrdered: number;
    quantityReceived: number;
    // The row's own Önskat leveransdatum, else the order's.
    expectedDeliveryDate: string | null;
  }[];
  inquiries: { inquiryId: string; inquiryNumber: string; status: string }[];
}

export async function listLegoPurchases(db: Db, manufacturingOrderId: string): Promise<LegoPurchaseOperation[]> {
  const operations = await db
    .select({ moOperationId: moOperations.id, orderedQuantity: legoOrderedQuantitySql() })
    .from(moOperations)
    .innerJoin(workCenters, eq(workCenters.id, moOperations.workCenterId))
    .where(and(eq(moOperations.manufacturingOrderId, manufacturingOrderId), eq(workCenters.type, "subcontract")))
    .orderBy(asc(moOperations.sequenceNo));
  if (operations.length === 0) return [];
  const ids = operations.map((op) => op.moOperationId);

  const [orderRows, inquiryRowsForOps] = await Promise.all([
    db
      .select({
        moOperationId: purchaseOrderRows.moOperationId,
        purchaseOrderId: purchaseOrders.id,
        orderNumber: purchaseOrders.orderNumber,
        status: purchaseOrders.status,
        quantityOrdered: purchaseOrderRows.quantityOrdered,
        quantityReceived: purchaseOrderRows.quantityReceived,
        expectedDeliveryDate: sql<string | null>`coalesce(${purchaseOrderRows.expectedDeliveryDate}, ${purchaseOrders.expectedDeliveryDate})`,
      })
      .from(purchaseOrderRows)
      .innerJoin(purchaseOrders, eq(purchaseOrders.id, purchaseOrderRows.purchaseOrderId))
      .where(and(inArray(purchaseOrderRows.moOperationId, ids), ne(purchaseOrders.status, "cancelled")))
      .orderBy(asc(purchaseOrders.orderNumber), asc(purchaseOrderRows.createdAt), asc(purchaseOrderRows.id)),
    db
      .selectDistinct({
        moOperationId: inquiryRows.moOperationId,
        inquiryId: inquiries.id,
        inquiryNumber: inquiries.inquiryNumber,
        status: inquiries.status,
      })
      .from(inquiryRows)
      .innerJoin(inquiries, eq(inquiries.id, inquiryRows.inquiryId))
      .where(and(inArray(inquiryRows.moOperationId, ids), inArray(inquiries.status, [...OPEN_INQUIRY])))
      .orderBy(asc(inquiries.inquiryNumber)),
  ]);

  return operations.map((op) => ({
    moOperationId: op.moOperationId,
    orderedQuantity: Number(op.orderedQuantity),
    purchaseOrders: orderRows
      .filter((r) => r.moOperationId === op.moOperationId)
      .map((r) => ({
        purchaseOrderId: r.purchaseOrderId,
        orderNumber: r.orderNumber,
        status: r.status,
        quantityOrdered: Number(r.quantityOrdered),
        quantityReceived: Number(r.quantityReceived),
        expectedDeliveryDate: r.expectedDeliveryDate,
      })),
    inquiries: inquiryRowsForOps
      .filter((r) => r.moOperationId === op.moOperationId)
      .map((r) => ({ inquiryId: r.inquiryId, inquiryNumber: r.inquiryNumber, status: r.status })),
  }));
}

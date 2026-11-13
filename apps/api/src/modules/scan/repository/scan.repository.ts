import { and, eq, inArray, or, sql } from "drizzle-orm";
import {
  articles,
  customers,
  manufacturingOrders,
  purchaseOrders,
  salesOrders,
  stockBatches,
  stockLocations,
  stockTransactions,
  suppliers,
  units,
  warehouses,
  type Db,
} from "@navet/db";

// Skanning (#4): read-only lookups of what a scanned code can be. Reads the
// tables directly like the reports module does — the scan module owns no
// data, it only answers "what is this?".
export function createScanRepository(db: Db) {
  return {
    async locationByLabelNumber(labelNumber: number) {
      const [row] = await db
        .select({
          id: stockLocations.id,
          name: stockLocations.name,
          active: stockLocations.active,
          // Spärrad lagerplats (0185): Utleverans does not pick it.
          blocked: stockLocations.blocked,
          labelNumber: stockLocations.labelNumber,
          warehouseName: warehouses.name,
        })
        .from(stockLocations)
        .innerJoin(warehouses, eq(warehouses.id, stockLocations.warehouseId))
        .where(eq(stockLocations.labelNumber, labelNumber));
      return row ?? null;
    },

    // EAN and article number in one query; the service says which matched.
    // `barcodeForms`: every stored form of the scanned GTIN (gtinForms — a
    // UPC-A scan finds the EAN-13 with a leading 0 and back), indexed.
    async articlesByCode(code: string, barcodeForms: string[]) {
      return db
        .select({
          id: articles.id,
          articleNumber: articles.articleNumber,
          name: articles.name,
          type: articles.type,
          barcode: articles.barcode,
          unitCode: units.code,
          active: articles.active,
          tracking: articles.tracking,
          serialAssignedAt: articles.serialAssignedAt,
        })
        .from(articles)
        .innerJoin(units, eq(units.id, articles.unitId))
        .where(
          barcodeForms.length > 0
            ? or(eq(articles.articleNumber, code), inArray(articles.barcode, barcodeForms))
            : eq(articles.articleNumber, code)
        );
    },

    // Batches and serienummer named `numbers` (compared with lower(), as the
    // unique index does), on `articleIds` only when given — a GS1 code names
    // its article. At most 20, oldest first.
    async batchesByNumber(numbers: string[], articleIds: string[] | null) {
      const wanted = [...new Set(numbers.map((n) => n.toLowerCase()))];
      if (wanted.length === 0 || (articleIds !== null && articleIds.length === 0)) return [];
      return db
        .select({
          id: stockBatches.id,
          batchNumber: stockBatches.batchNumber,
          batchKind: stockBatches.kind,
          articleId: stockBatches.articleId,
          articleNumber: articles.articleNumber,
          articleName: articles.name,
          expiresOn: stockBatches.expiresOn,
        })
        .from(stockBatches)
        .innerJoin(articles, eq(articles.id, stockBatches.articleId))
        .where(
          and(
            inArray(sql`lower(${stockBatches.batchNumber})`, wanted),
            articleIds === null ? undefined : inArray(stockBatches.articleId, articleIds)
          )
        )
        .orderBy(stockBatches.createdAt, stockBatches.id)
        .limit(20);
    },

    // Where the batches stand: the physical balance per place (spärrade
    // platser included, flagged), places with nothing left out.
    async batchBalances(batchIds: string[]) {
      if (batchIds.length === 0) return [];
      const quantity = sql<string>`sum(${stockTransactions.quantityDelta})`;
      return db
        .select({
          batchId: sql<string>`${stockTransactions.batchId}`,
          locationId: stockTransactions.locationId,
          locationName: stockLocations.name,
          warehouseName: warehouses.name,
          blocked: stockLocations.blocked,
          quantity,
        })
        .from(stockTransactions)
        .innerJoin(stockLocations, eq(stockLocations.id, stockTransactions.locationId))
        .innerJoin(warehouses, eq(warehouses.id, stockLocations.warehouseId))
        .where(inArray(stockTransactions.batchId, batchIds))
        .groupBy(stockTransactions.batchId, stockTransactions.locationId, stockLocations.name, warehouses.name, stockLocations.blocked)
        .having(sql`${quantity} <> 0`)
        .orderBy(warehouses.name, stockLocations.name);
    },

    async purchaseOrderByNumber(orderNumber: string) {
      const [row] = await db
        .select({ id: purchaseOrders.id, orderNumber: purchaseOrders.orderNumber, status: purchaseOrders.status, partyName: suppliers.name })
        .from(purchaseOrders)
        .innerJoin(suppliers, eq(suppliers.id, purchaseOrders.supplierId))
        .where(eq(purchaseOrders.orderNumber, orderNumber));
      return row ?? null;
    },

    // A quote's OF number stays on the order it became, so it finds it too.
    async salesOrderByNumber(orderNumber: string) {
      const [row] = await db
        .select({ id: salesOrders.id, orderNumber: salesOrders.orderNumber, status: salesOrders.status, partyName: customers.name })
        .from(salesOrders)
        .innerJoin(customers, eq(customers.id, salesOrders.customerId))
        .where(or(eq(salesOrders.orderNumber, orderNumber), eq(salesOrders.quoteNumber, orderNumber)));
      return row ?? null;
    },

    async manufacturingOrderByNumber(orderNumber: string) {
      const [row] = await db
        .select({
          id: manufacturingOrders.id,
          orderNumber: manufacturingOrders.orderNumber,
          status: manufacturingOrders.status,
          articleNumber: articles.articleNumber,
          articleName: articles.name,
        })
        .from(manufacturingOrders)
        .innerJoin(articles, eq(articles.id, manufacturingOrders.articleId))
        .where(eq(manufacturingOrders.orderNumber, orderNumber));
      return row ?? null;
    },
  };
}

export type ScanRepository = ReturnType<typeof createScanRepository>;

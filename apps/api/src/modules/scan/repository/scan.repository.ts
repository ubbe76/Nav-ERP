import { eq, or } from "drizzle-orm";
import {
  articles,
  customers,
  manufacturingOrders,
  purchaseOrders,
  salesOrders,
  stockLocations,
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
          labelNumber: stockLocations.labelNumber,
          warehouseName: warehouses.name,
        })
        .from(stockLocations)
        .innerJoin(warehouses, eq(warehouses.id, stockLocations.warehouseId))
        .where(eq(stockLocations.labelNumber, labelNumber));
      return row ?? null;
    },

    // EAN and article number in one query; the service says which matched.
    async articlesByCode(code: string) {
      return db
        .select({
          id: articles.id,
          articleNumber: articles.articleNumber,
          name: articles.name,
          type: articles.type,
          barcode: articles.barcode,
          unitCode: units.code,
          active: articles.active,
        })
        .from(articles)
        .innerJoin(units, eq(units.id, articles.unitId))
        .where(or(eq(articles.articleNumber, code), eq(articles.barcode, code)));
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

import { and, eq, inArray, sql } from "drizzle-orm";
import { articles, stockCountSessions, stockLocations, stockTransactions, warehouses, type Db } from "@navet/db";
import { FALLBACK_LOCATION_NAME, resolveStockLocation } from "../../stock/service/location-resolver.js";
import { assertLocationNotUnderCount } from "../../stock/service/count-guard.js";
import { deactivateEmptyLocation } from "../../stock/service/location-lifecycle.js";
import { STOCK_IMPORT_NOTE, type StockBalanceImportPlan } from "../service/stock-balances.js";

// Lagersaldon (#3) — the import repository's stock half: the planner's
// lookups (StockBalanceImportDeps, structurally) and the commit. Kept in its
// own leaf so import.repository.ts does not grow a stock module of its own;
// every write goes through the stock module's leaves (resolveStockLocation,
// assertLocationNotUnderCount, deactivateEmptyLocation) like any other
// stock_transactions writer.

const CHUNK = 500;
const chunks = <T>(items: T[]) => Array.from({ length: Math.ceil(items.length / CHUNK) }, (_, i) => items.slice(i * CHUNK, (i + 1) * CHUNK));

export function createStockBalanceImportRepository(db: Db) {
  return {
    async stockPlaces() {
      const [warehouseRows, locationRows] = await Promise.all([
        db.select({ id: warehouses.id, name: warehouses.name, active: warehouses.active }).from(warehouses),
        db.select({ id: stockLocations.id, warehouseId: stockLocations.warehouseId, name: stockLocations.name }).from(stockLocations),
      ]);
      return { warehouses: warehouseRows, locations: locationRows };
    },

    // Only an ACTIVE default counts — resolveStockLocation skips a retired one.
    async articleDefaultLocations(articleIds: string[]) {
      const map = new Map<string, string>();
      for (const part of chunks([...new Set(articleIds)])) {
        if (part.length === 0) continue;
        const rows = await db
          .select({ articleId: articles.id, locationId: stockLocations.id })
          .from(articles)
          .innerJoin(stockLocations, and(eq(stockLocations.id, articles.defaultLocationId), eq(stockLocations.active, true)))
          .where(inArray(articles.id, part));
        for (const row of rows) map.set(row.articleId, row.locationId);
      }
      return map;
    },

    async fallbackLocationId() {
      const [row] = await db
        .select({ id: stockLocations.id })
        .from(stockLocations)
        .where(eq(stockLocations.name, FALLBACK_LOCATION_NAME))
        .limit(1);
      return row?.id ?? null;
    },

    async stockBalances(articleIds: string[]) {
      const map = new Map<string, number>();
      for (const part of chunks([...new Set(articleIds)])) {
        if (part.length === 0) continue;
        const rows = await db
          .select({
            articleId: stockTransactions.articleId,
            locationId: stockTransactions.locationId,
            quantity: sql<string>`sum(${stockTransactions.quantityDelta})`,
          })
          .from(stockTransactions)
          .where(inArray(stockTransactions.articleId, part))
          .groupBy(stockTransactions.articleId, stockTransactions.locationId);
        for (const row of rows) map.set(`${row.articleId}|${row.locationId}`, Number(row.quantity));
      }
      return map;
    },

    async locationsUnderCount() {
      const rows = await db
        .select({ locationId: stockCountSessions.locationId })
        .from(stockCountSessions)
        .where(and(eq(stockCountSessions.status, "open"), eq(stockCountSessions.blocksTransactions, true)));
      return new Set(rows.map((row) => row.locationId));
    },

    // One transaction: the missing warehouses and locations first, then per
    // row the place resolved, the frysvakt checked, the balance read AGAIN
    // inside the transaction and the difference booked — the plan's numbers
    // are the preview's, not the truth at commit time.
    async executeStockBalancePlan(plan: StockBalanceImportPlan) {
      return db.transaction(async (tx) => {
        const createdWarehouses: string[] = [];
        const createdLocations: string[] = [];
        const warehouseIds = new Map(
          (await tx.select({ id: warehouses.id, name: warehouses.name }).from(warehouses)).map((w) => [w.name.toLowerCase(), w.id])
        );
        for (const name of plan.willCreate.warehouses) {
          if (warehouseIds.has(name.toLowerCase())) continue;
          const [row] = await tx.insert(warehouses).values({ name, active: true }).returning({ id: warehouses.id });
          warehouseIds.set(name.toLowerCase(), row!.id);
          createdWarehouses.push(name);
        }
        const newLocationIds = new Map<string, string>();
        async function locationFor(warehouseName: string, locationName: string) {
          const key = `${warehouseName.toLowerCase()}/${locationName.toLowerCase()}`;
          const known = newLocationIds.get(key);
          if (known) return known;
          const warehouseId = warehouseIds.get(warehouseName.toLowerCase())!;
          const [existing] = await tx
            .select({ id: stockLocations.id })
            .from(stockLocations)
            .where(and(eq(stockLocations.warehouseId, warehouseId), sql`lower(${stockLocations.name}) = ${locationName.toLowerCase()}`));
          const id =
            existing?.id ??
            (await tx.insert(stockLocations).values({ warehouseId, name: locationName, active: true }).returning({ id: stockLocations.id }))[0]!.id;
          if (!existing) createdLocations.push(`${warehouseName} / ${locationName}`);
          newLocationIds.set(key, id);
          return id;
        }

        let created = 0;
        let updated = 0;
        for (const row of plan.balances) {
          const explicit =
            row.target.kind === "location"
              ? row.target.locationId
              : row.target.kind === "new"
                ? await locationFor(row.target.warehouseName, row.target.locationName)
                : null;
          const locationId = await resolveStockLocation(tx, row.articleId, explicit);
          await assertLocationNotUnderCount(tx, locationId);
          const [balance] = await tx
            .select({ quantity: sql<string>`coalesce(sum(${stockTransactions.quantityDelta}), 0)` })
            .from(stockTransactions)
            .where(and(eq(stockTransactions.articleId, row.articleId), eq(stockTransactions.locationId, locationId)));
          const current = Number(balance!.quantity);
          const delta = Math.round((row.quantity - current) * 10_000) / 10_000;
          if (delta === 0) continue;
          await tx.insert(stockTransactions).values({
            articleId: row.articleId,
            locationId,
            quantityDelta: String(delta),
            transactionType: "inventory_adjustment",
            // Inflows only carry a cost (D0); an outflow is worth what the stock was.
            unitCost: delta > 0 && row.unitCost !== null ? String(row.unitCost) : null,
            note: STOCK_IMPORT_NOTE,
          });
          if (delta < 0) await deactivateEmptyLocation(tx, locationId);
          if (current === 0) created++;
          else updated++;
        }
        return {
          created,
          updated,
          registersCreated: { units: [], articleGroups: [], warehouses: createdWarehouses, stockLocations: createdLocations },
        };
      });
    },
  };
}

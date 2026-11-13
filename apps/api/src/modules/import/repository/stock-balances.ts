import { and, eq, inArray, sql } from "drizzle-orm";
import { articles, stockCountSessions, stockLocations, stockTransactions, warehouses, type Db, type Tx } from "@navet/db";
import { FALLBACK_LOCATION_NAME, getOrCreateFallbackLocation, resolveStockLocation, usableArticleLocations } from "../../stock/service/location-resolver.js";
import { assertLocationNotUnderCount } from "../../stock/service/count-guard.js";
import { deactivateEmptyLocation } from "../../stock/service/location-lifecycle.js";
import { lockArticlesForOutflow } from "../../stock/service/outflow-locations.js";
import { allocateBatchOutflow, withBatchRemainder } from "../../stock/service/outflow-allocation.js";
import { batchTrackedArticleIds } from "../../stock/service/batch-tracking.js";
import { getOrCreateBatch } from "../../stock/service/batches.js";
import { BatchNotTrackedError } from "../../stock/service/batch.errors.js";
import { batchCellQuantity, batchCellsForArticles } from "../../stock/repository/batch-balances.js";
import { STOCK_IMPORT_NOTE, stockBatchCellKey, type StockBalanceImportPlan } from "../service/stock-balances.js";
import { round4 } from "@navet/shared";

// Lagersaldon (#3) — the import repository's stock half: the planner's
// lookups (StockBalanceImportDeps, structurally) and the commit. Kept in its
// own leaf so import.repository.ts does not grow a stock module of its own;
// every write goes through the stock module's leaves (resolveStockLocation,
// assertLocationNotUnderCount, deactivateEmptyLocation) like any other
// stock_transactions writer.

const CHUNK = 500;
const chunks = <T>(items: T[]) => Array.from({ length: Math.ceil(items.length / CHUNK) }, (_, i) => items.slice(i * CHUNK, (i + 1) * CHUNK));

// A decrease of `quantity` on the place, split over its batches (#8).
async function decreaseParts(tx: Tx, articleId: string, locationId: string, quantity: number) {
  const cells = await batchCellsForArticles(tx, [articleId], { locationIds: [locationId] });
  const allocation = allocateBatchOutflow(quantity, [], cells, { locationId });
  return withBatchRemainder(allocation.parts, allocation.remainder, locationId).map((part) => ({
    quantity: -part.quantity,
    batchId: part.batchId ?? null,
  }));
}

export function createStockBalanceImportRepository(db: Db | Tx) {
  return {
    async stockPlaces() {
      const [warehouseRows, locationRows] = await Promise.all([
        db.select({ id: warehouses.id, name: warehouses.name, active: warehouses.active }).from(warehouses),
        db.select({ id: stockLocations.id, warehouseId: stockLocations.warehouseId, name: stockLocations.name }).from(stockLocations),
      ]);
      return { warehouses: warehouseRows, locations: locationRows };
    },

    // The resolver's own rule (0186): the huvudplats when it is active and
    // not blocked, else the first such alternative place — the same function
    // resolveStockLocation calls, so the preview never says one place where
    // the commit writes another.
    async usableArticleLocations(articleIds: string[]) {
      return usableArticleLocations(db, articleIds);
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

    // Batch (#8): today's balance per cell for the batchstyrda articles the
    // file names a batch for (the planner's key, stockBatchCellKey).
    async stockBatchBalances(articleIds: string[]) {
      const map = new Map<string, number>();
      for (const cell of await batchCellsForArticles(db, articleIds)) {
        map.set(stockBatchCellKey(cell.articleId, cell.locationId, cell.batchId === null ? null : cell.batchNumber), cell.quantity);
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

        // Batch (#8). The flag is read FOR KEY SHARE (a flag change in
        // progress is waited out), and every batchstyrd article of the plan
        // takes the article lock the draws take — sorted, in one go, BEFORE
        // any place is resolved (article → place): a decrease is an outflow
        // from the article's cells. Then the batches the plan names are
        // created in (article, number) order, so two imports never wait on
        // each other crosswise in the unique index (the sort is stable and
        // ignores case, so the file's first spelling is the one kept); they all get this
        // transaction's time, and the number decides their order (beslut 16).
        const trackedIds = await batchTrackedArticleIds(tx, plan.balances.map((row) => row.articleId));
        await lockArticlesForOutflow(tx, [...trackedIds]);
        const batchIds = new Map<string, string>();
        const named = plan.balances.flatMap((row) =>
          row.batch?.kind === "named" ? [{ articleId: row.articleId, batchNumber: row.batch.batchNumber }] : []
        );
        named.sort((a, b) => (a.articleId < b.articleId ? -1 : a.articleId > b.articleId ? 1 : a.batchNumber.toLocaleLowerCase("sv").localeCompare(b.batchNumber.toLocaleLowerCase("sv"), "sv", { numeric: true })));
        for (const row of plan.balances) {
          // The article stopped being batchstyrd between the plan and here.
          if (row.batch !== null && !trackedIds.has(row.articleId)) {
            const [article] = await tx.select({ articleNumber: articles.articleNumber }).from(articles).where(eq(articles.id, row.articleId));
            throw new BatchNotTrackedError(article?.articleNumber ?? row.articleId);
          }
        }
        for (const item of named) {
          const key = `${item.articleId}|${item.batchNumber.toLocaleLowerCase("sv")}`;
          if (batchIds.has(key)) continue;
          batchIds.set(key, (await getOrCreateBatch(tx, { articleId: item.articleId, batchNumber: item.batchNumber, origin: "import" })).id);
        }

        let created = 0;
        let updated = 0;
        for (const row of plan.balances) {
          const explicit =
            row.target.kind === "location"
              ? row.target.locationId
              : row.target.kind === "new"
                ? await locationFor(row.target.warehouseName, row.target.locationName)
                : row.target.kind === "fallback"
                  ? // Lagerplats "***": the one reservplats, whatever Lager
                    // the file names — never a second place by that name
                    // (StockLocationNameReservedError).
                    await getOrCreateFallbackLocation(tx)
                  : null;
          const locationId = await resolveStockLocation(tx, row.articleId, explicit);
          await assertLocationNotUnderCount(tx, locationId);
          // Antal is the balance of the whole place — or, with Batch, of
          // that cell (null = the Okänd cell); the difference is booked there.
          const batchId =
            row.batch?.kind === "named" ? batchIds.get(`${row.articleId}|${row.batch.batchNumber.toLocaleLowerCase("sv")}`)! : null;
          let current: number;
          if (row.batch === null) {
            const [balance] = await tx
              .select({ quantity: sql<string>`coalesce(sum(${stockTransactions.quantityDelta}), 0)` })
              .from(stockTransactions)
              .where(and(eq(stockTransactions.articleId, row.articleId), eq(stockTransactions.locationId, locationId)));
            current = Number(balance!.quantity);
          } else {
            current = await batchCellQuantity(tx, row.articleId, locationId, batchId);
          }
          const delta = round4(row.quantity - current);
          if (delta === 0) continue;
          // Without Batch an increase is Okänd. A decrease of a batchstyrd
          // article's whole place is taken from the place's batches oldest
          // first (Okänd first, what they do not cover as Okänd) — the pure
          // rule with the place chosen, as a negative justering; one row per
          // batch.
          const parts: { quantity: number; batchId: string | null }[] =
            row.batch === null && delta < 0 && trackedIds.has(row.articleId)
              ? await decreaseParts(tx, row.articleId, locationId, -delta)
              : [{ quantity: delta, batchId }];
          await tx.insert(stockTransactions).values(
            parts.map((part) => ({
              articleId: row.articleId,
              locationId,
              quantityDelta: String(part.quantity),
              transactionType: "inventory_adjustment" as const,
              // Inflows only carry a cost (D0); an outflow is worth what the stock was.
              unitCost: delta > 0 && row.unitCost !== null ? String(row.unitCost) : null,
              note: STOCK_IMPORT_NOTE,
              batchId: part.batchId,
            }))
          );
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

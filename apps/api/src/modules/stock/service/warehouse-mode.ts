// Flera lager (system setting, off by default): with it off Nav has ONE
// warehouse that the user never sees — the lagerplatser are created in it,
// the web hides every Lager column, filter and picker and prints a place
// without its warehouse. The data model is unchanged (every location still
// belongs to a warehouse), so switching it on later is only the setting.
//
// The rule with it off: at most one warehouse IN USE — not the reserve
// warehouse "***" (it holds only the reserve place and always exists), and
// in use = active or holding an active location (a place with stock is
// always active, stock.md). Every writer that can add one (POST/PATCH
// /stock/warehouses, POST/PATCH /stock/locations, the saldoimport, the
// exempeldata) runs beginWarehouseWrite FIRST in its transaction and
// assertWarehouseLimit after its write. The setting's ROW orders the two
// sides like Använd batch- och serienummer (batch-tracking.ts): a writer
// reads the row FOR SHARE and holds it to its commit; PATCH /settings
// writes the row first (its upsert waits for those share locks) and only
// then counts. Two writers with the setting off also take one advisory
// lock, so the first warehouse of an empty installation is created once.
import { and, asc, eq, ne, sql } from "drizzle-orm";
import { stockLocations, systemSettings, warehouses, type Db, type Tx } from "@navet/db";
import { FALLBACK_LOCATION_NAME } from "./outflow-allocation.js";

export const MULTIPLE_WAREHOUSES_KEY = "multiple_warehouses";
// The warehouse that is created when a place needs one and none exists —
// the name the exempeldata has always used.
export const DEFAULT_WAREHOUSE_NAME = "Huvudlager";

export function decodeMultipleWarehouses(value: string | null | undefined): boolean {
  return value === "true";
}

// For readers (the PDFs, GET /settings/stock): no lock.
export async function readMultipleWarehouses(db: Db | Tx): Promise<boolean> {
  const [row] = await db.select({ value: systemSettings.value }).from(systemSettings).where(eq(systemSettings.key, MULTIPLE_WAREHOUSES_KEY));
  return decodeMultipleWarehouses(row?.value);
}

// In use: active, or holding an active location.
const inUse = sql`(${warehouses.active} or exists (select 1 from ${stockLocations} where ${stockLocations.warehouseId} = ${warehouses.id} and ${stockLocations.active}))`;

// Warehouses in use, the reserve warehouse not counted.
export async function countWarehousesInUse(db: Db | Tx): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(warehouses)
    .where(
      and(
        ne(warehouses.name, FALLBACK_LOCATION_NAME),
        inUse
      )
    );
  return row?.count ?? 0;
}

// PATCH /settings switching Flera lager off: more than one warehouse in use.
export class MultipleWarehousesInUseError extends Error {
  constructor(readonly warehouseCount: number) {
    super(`${warehouseCount} lager används — inaktivera alla utom ett, och töm deras lagerplatser, innan Flera lager stängs av`);
    this.name = "MultipleWarehousesInUseError";
  }
}

// A write that would give a second warehouse in use while Flera lager is off.
export class MultipleWarehousesDisabledError extends Error {
  constructor() {
    super("Flera lager är avstängt — slå på det under System → Inställningar för att lägga till ett lager");
    this.name = "MultipleWarehousesDisabledError";
  }
}

// FIRST in a transaction that may add a warehouse in use. Returns true when
// the one-warehouse rule applies — then the caller runs assertWarehouseLimit
// after its write.
export async function beginWarehouseWrite(tx: Tx): Promise<boolean> {
  const [row] = await tx
    .select({ value: systemSettings.value })
    .from(systemSettings)
    .where(eq(systemSettings.key, MULTIPLE_WAREHOUSES_KEY))
    .for("share");
  if (decodeMultipleWarehouses(row?.value)) return false;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('stock_warehouses'), 0)`);
  return true;
}

export async function assertWarehouseLimit(tx: Tx): Promise<void> {
  if ((await countWarehousesInUse(tx)) > 1) throw new MultipleWarehousesDisabledError();
}

// The warehouse a place goes into when none is named (a new lagerplats
// without warehouseId, the exempeldata): the first warehouse in use that is
// not the reserve warehouse — an active one before one that is only in use
// through its places — else a new Huvudlager. Takes the advisory lock
// itself (re-entrant after beginWarehouseWrite), so two first creations
// never make two.
export async function defaultWarehouseId(tx: Tx): Promise<string> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('stock_warehouses'), 0)`);
  const warehouse = await findDefaultWarehouse(tx);
  if (warehouse) return warehouse.id;
  const [created] = await tx.insert(warehouses).values({ name: DEFAULT_WAREHOUSE_NAME }).returning({ id: warehouses.id });
  return created!.id;
}

// The same choice without creating anything (the saldoimport's preview):
// null when no warehouse is in use yet.
export async function findDefaultWarehouse(db: Db | Tx): Promise<{ id: string; name: string } | null> {
  const [warehouse] = await db
    .select({ id: warehouses.id, name: warehouses.name })
    .from(warehouses)
    .where(and(ne(warehouses.name, FALLBACK_LOCATION_NAME), inUse))
    .orderBy(sql`${warehouses.active} desc`, asc(warehouses.name), asc(warehouses.id))
    .limit(1);
  return warehouse ?? null;
}

// The HTTP status of a Flera lager error, null for anything else (mapped
// once in app.ts — the writers live in stock, import, demo and system).
export function warehouseModeErrorStatus(err: unknown): 409 | null {
  if (err instanceof MultipleWarehousesInUseError || err instanceof MultipleWarehousesDisabledError) return 409;
  return null;
}

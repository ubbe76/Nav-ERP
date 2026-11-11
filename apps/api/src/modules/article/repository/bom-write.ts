import { sql, type SQL } from "drizzle-orm";
import { bomComponents, type Tx } from "@navet/db";

// Tx-only BOM writer — the article module owns bom_components, so callers
// that write a structure inside a larger transaction (Kopiera från's
// Beredning, the configurator's variant creation) compose this instead of
// inserting into the table themselves. Tx only, like
// manufacturing/repository/routing-write.ts: a structure is never written
// outside the transaction that owns its parent article.

// One row without id/parentArticleId/createdAt. quantity is in the
// component's base unit; unitId/unitFactor are the display unit and its
// snapshotted factor (null = base unit); routingOperationId links the material
// to one of the parent's own operations (null = drawn at final reporting).
export type BomRowInsert = {
  componentArticleId: string;
  quantity: number;
  unitId: string | null;
  unitFactor: string | null;
  routingOperationId: string | null;
  // "Pos." — optional so callers without one (the configurator) need not say so.
  position?: string | null;
  // "Kalkyl" — optional, false when omitted.
  costingOnly?: boolean;
};

// THE rule for a structure's row order. bom_components has no sort column:
// the card (getBomComponents) and the import's row matching (allBomEdges)
// order by created_at, id — and created_at defaults to now(), which is the
// TRANSACTION's start time. Rows written in one transaction would all carry
// the same instant and fall back to the uuid, i.e. a random order. Every
// writer of several rows in one transaction therefore stamps row number
// `index` (0-based, in writing order, running across all statements of the
// transaction for one parent) one microsecond after the previous one.
// timestamptz holds microseconds, so the order survives exactly. A single
// row added later (addBomComponent) is its own transaction and sorts last
// on plain now().
export function bomRowCreatedAt(index: number): SQL<Date> {
  return sql<Date>`now() + (${index}::int * interval '1 microsecond')`;
}

// No-op on [] — drizzle's insert refuses an empty values list. The rows keep
// the order they are given in (bomRowCreatedAt); `firstIndex` is for a caller
// that writes the same parent's rows in more than one call in a transaction.
export async function insertBomRows(
  tx: Tx,
  parentArticleId: string,
  rows: BomRowInsert[],
  firstIndex = 0
): Promise<void> {
  if (rows.length === 0) return;
  await tx.insert(bomComponents).values(
    rows.map((row, index) => ({
      createdAt: bomRowCreatedAt(firstIndex + index),
      parentArticleId,
      componentArticleId: row.componentArticleId,
      quantity: String(row.quantity),
      unitId: row.unitId,
      unitFactor: row.unitFactor,
      routingOperationId: row.routingOperationId,
      position: row.position ?? null,
      costingOnly: row.costingOnly ?? false,
    }))
  );
}

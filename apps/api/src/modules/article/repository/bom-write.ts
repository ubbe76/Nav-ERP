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
};

// No-op on [] — drizzle's insert refuses an empty values list.
export async function insertBomRows(tx: Tx, parentArticleId: string, rows: BomRowInsert[]): Promise<void> {
  if (rows.length === 0) return;
  await tx.insert(bomComponents).values(
    rows.map((row) => ({
      parentArticleId,
      componentArticleId: row.componentArticleId,
      quantity: String(row.quantity),
      unitId: row.unitId,
      unitFactor: row.unitFactor,
      routingOperationId: row.routingOperationId,
      position: row.position ?? null,
    }))
  );
}

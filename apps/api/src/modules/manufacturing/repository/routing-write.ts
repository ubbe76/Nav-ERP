import { asc, eq, sql } from "drizzle-orm";
import { routingOperations, type Tx } from "@navet/db";

// Tx-only routing writers — the manufacturing module owns routing_operations,
// so every caller that writes a routing inside a larger transaction (Kopiera
// från's Beredning in article-copy.ts, the configurator's variant creation)
// composes these instead of inserting into the table itself. Same composable
// pattern as stock/service/location-resolver.ts, but Tx only: a routing is
// never written outside the transaction that owns its article.

// One operation without id/articleId — the caller supplies the article.
export type RoutingOperationInsert = Omit<typeof routingOperations.$inferInsert, "id" | "articleId">;

// Inserts the rows for one article and returns sequenceNo → new id, so BOM
// rows written afterwards can link their material to the operation. No-op on [].
export async function insertRoutingOperations(
  tx: Tx,
  articleId: string,
  rows: RoutingOperationInsert[]
): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  if (rows.length === 0) return map;
  const inserted = await tx
    .insert(routingOperations)
    .values(rows.map((row) => ({ ...row, articleId })))
    .returning({ id: routingOperations.id, sequenceNo: routingOperations.sequenceNo });
  for (const row of inserted) map.set(row.sequenceNo, row.id);
  return map;
}

// Copies a routing (operations + each lego operation's own
// routing_operation_files row) from one article to another and returns old id
// → new id, so the caller can remap bom_components.routing_operation_id. The
// bytes are copied with INSERT … SELECT and never leave the database. The
// caller's transaction decides the snapshot (Kopiera från uses repeatable read).
export async function copyRouting(tx: Tx, sourceArticleId: string, targetArticleId: string): Promise<Map<string, string>> {
  const operations = await tx
    .select()
    .from(routingOperations)
    .where(eq(routingOperations.articleId, sourceArticleId))
    .orderBy(asc(routingOperations.sequenceNo));
  const operationMap = new Map<string, string>();
  for (const { id: oldId, articleId: _articleId, ...rest } of operations) {
    const [inserted] = await tx
      .insert(routingOperations)
      .values({ ...rest, articleId: targetArticleId })
      .returning({ id: routingOperations.id });
    operationMap.set(oldId, inserted!.id);
    await tx.execute(sql`
      INSERT INTO routing_operation_files (routing_operation_id, filename, content_type, size_bytes, data)
      SELECT ${inserted!.id}, filename, content_type, size_bytes, data
      FROM routing_operation_files WHERE routing_operation_id = ${oldId}`);
  }
  return operationMap;
}

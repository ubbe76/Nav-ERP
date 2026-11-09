import { asc, eq, sql } from "drizzle-orm";
import { routingOperationAlternatives, routingOperationArticleFiles, routingOperationDrawings, routingOperations, type Tx } from "@navet/db";

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
  const pairs = [...operationMap].map(([from, to]) => ({ from, to }));
  await copyRoutingAlternatives(tx, pairs);
  await copyRoutingDrawingLinks(tx, pairs, targetArticleId);
  await copyRoutingFileLinks(tx, pairs, targetArticleId);
  return operationMap;
}

// Ritningar per operation (0200): the operation's chosen drawings as a set.
// Only the article's own drawings are written (the service has refused
// others; one deleted meanwhile just drops out).
export async function replaceRoutingDrawings(
  tx: Tx,
  routingOperationId: string,
  articleId: string,
  drawingIds: string[]
): Promise<void> {
  await tx.delete(routingOperationDrawings).where(eq(routingOperationDrawings.routingOperationId, routingOperationId));
  if (drawingIds.length === 0) return;
  const ids = sql.join(
    drawingIds.map((id) => sql`${id}::uuid`),
    sql`, `
  );
  await tx.execute(sql`
    INSERT INTO routing_operation_drawings (routing_operation_id, drawing_id)
    SELECT ${routingOperationId}, d.id FROM article_drawings d
    WHERE d.article_id = ${articleId} AND d.id IN (${ids})`);
}

// Filer per operation (0201): the operation's chosen loose files as a set —
// only the article's own loose files are written.
export async function replaceRoutingFiles(
  tx: Tx,
  routingOperationId: string,
  articleId: string,
  fileIds: string[]
): Promise<void> {
  await tx.delete(routingOperationArticleFiles).where(eq(routingOperationArticleFiles.routingOperationId, routingOperationId));
  if (fileIds.length === 0) return;
  const ids = sql.join(
    fileIds.map((id) => sql`${id}::uuid`),
    sql`, `
  );
  await tx.execute(sql`
    INSERT INTO routing_operation_article_files (routing_operation_id, article_file_id)
    SELECT ${routingOperationId}, f.id FROM article_files f
    WHERE f.article_id = ${articleId} AND f.drawing_revision_id IS NULL AND f.id IN (${ids})`);
}

// Ritningar per operation (0200): an operation's chosen drawings follow to
// the copy where the target article has a drawing with the same number
// (Kopiera från copies the drawing numbers first); otherwise the link is
// dropped. The configurator's variants have no drawings, so none follow.
export async function copyRoutingDrawingLinks(
  tx: Tx,
  pairs: { from: string; to: string }[],
  targetArticleId: string
): Promise<void> {
  if (pairs.length === 0) return;
  const values = sql.join(
    pairs.map((p) => sql`(${p.from}::uuid, ${p.to}::uuid)`),
    sql`, `
  );
  await tx.execute(sql`
    INSERT INTO routing_operation_drawings (routing_operation_id, drawing_id)
    SELECT v.to_id, td.id
    FROM (VALUES ${values}) AS v(from_id, to_id)
    JOIN routing_operation_drawings l ON l.routing_operation_id = v.from_id
    JOIN article_drawings sd ON sd.id = l.drawing_id
    JOIN article_drawings td ON td.article_id = ${targetArticleId} AND td.drawing_number = sd.drawing_number
    ON CONFLICT DO NOTHING`);
}

// Filer per operation (0201): a chosen loose file follows to the copy where
// the target article has a loose file with the same name (Kopiera från
// copies the files first); otherwise the link is dropped.
export async function copyRoutingFileLinks(
  tx: Tx,
  pairs: { from: string; to: string }[],
  targetArticleId: string
): Promise<void> {
  if (pairs.length === 0) return;
  const values = sql.join(
    pairs.map((p) => sql`(${p.from}::uuid, ${p.to}::uuid)`),
    sql`, `
  );
  await tx.execute(sql`
    INSERT INTO routing_operation_article_files (routing_operation_id, article_file_id)
    SELECT v.to_id, tf.id
    FROM (VALUES ${values}) AS v(from_id, to_id)
    JOIN routing_operation_article_files l ON l.routing_operation_id = v.from_id
    JOIN article_files sf ON sf.id = l.article_file_id AND sf.drawing_revision_id IS NULL
    JOIN article_files tf ON tf.article_id = ${targetArticleId} AND tf.drawing_revision_id IS NULL AND tf.filename = sf.filename
    ON CONFLICT DO NOTHING`);
}

// --- Alternativa resurser (#15) ---

// The alternatives of one operation as a set, in rank order (1..n): DELETE +
// INSERT, so a reordering never meets the (operation, rank) unique index
// halfway. The caller holds the operation's row lock and has run the rules
// (routing-alternatives.ts). Times null = som ordinarie.
export async function replaceRoutingAlternatives(
  tx: Tx,
  routingOperationId: string,
  alternatives: { workCenterId: string; setupTime?: number | null; runTimePerUnit?: number | null }[]
): Promise<void> {
  await tx.delete(routingOperationAlternatives).where(eq(routingOperationAlternatives.routingOperationId, routingOperationId));
  if (alternatives.length === 0) return;
  await tx.insert(routingOperationAlternatives).values(
    alternatives.map((a, i) => ({
      routingOperationId,
      workCenterId: a.workCenterId,
      rank: i + 1,
      setupTime: a.setupTime == null ? null : String(a.setupTime),
      runTimePerUnit: a.runTimePerUnit == null ? null : String(a.runTimePerUnit),
    }))
  );
}

// The companion of copyRouting and insertRoutingOperations: copies the
// alternatives of each `from` operation onto its `to` operation with ranks
// and times (null stays null — som ordinarie of the copy). ONE rule for
// Kopiera beredning and the configurator's variants: only when `to` is an
// own, non-Kalkyl operation on the same ordinarie as `from` — a variant
// whose derived base operation landed on another resource or became Kalkyl
// gets none (the alternatives were chosen for the template's ordinarie), and
// an alternative that is `to`'s ordinarie is never copied. One statement.
export async function copyRoutingAlternatives(tx: Tx, pairs: { from: string; to: string }[]): Promise<void> {
  if (pairs.length === 0) return;
  const values = sql.join(
    pairs.map((p) => sql`(${p.from}::uuid, ${p.to}::uuid)`),
    sql`, `
  );
  await tx.execute(sql`
    INSERT INTO routing_operation_alternatives (routing_operation_id, work_center_id, rank, setup_time, run_time_per_unit)
    SELECT t.id, a.work_center_id, a.rank, a.setup_time, a.run_time_per_unit
    FROM (VALUES ${values}) AS v(from_id, to_id)
    JOIN routing_operations f ON f.id = v.from_id
    JOIN routing_operations t ON t.id = v.to_id
    JOIN work_centers twc ON twc.id = t.work_center_id
    JOIN routing_operation_alternatives a ON a.routing_operation_id = f.id
    WHERE t.work_center_id = f.work_center_id
      AND NOT t.costing_only
      AND twc.type <> 'subcontract'
      AND a.work_center_id <> t.work_center_id`);
}

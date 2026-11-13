import { asc, eq, sql } from "drizzle-orm";
import { articleSuppliers, articles, bomComponents, type Tx } from "@navet/db";
import type { ArticleCopyPart, CreateArticleInput } from "@navet/shared";
import { copyRouting } from "../../manufacturing/repository/routing-write.js";
import { insertBomRows } from "./bom-write.js";
import { currentArticleFileSql } from "./drawing-files.js";

// "Kopiera från befintlig artikel" — the DB leaf behind POST /articles'
// copyFrom. Everything here runs inside the create transaction (see
// article.repository.ts's create), so a failure anywhere leaves nothing
// behind. Byte columns (article_files.data, routing_operation_files.data) are
// copied with INSERT … SELECT so the bytes never leave the database.

// Information: the Allmänt/planning columns the new-article form does NOT
// carry. Each is taken from the source unless the request sent it — the
// request always wins. The form's own fields (type, isPhantom, unitId,
// standardCost, groupId, articleCodeId, defaultLocationId) are pre-filled client-side and
// never read from the source here; articleNumber/name/active never are.
export const COPIED_INFORMATION_FIELDS = [
  "salesPrice",
  "weight",
  "length",
  "width",
  "height",
  "quantityPerPackage",
  "packageTypeId",
  "parcelKind",
  "stackable",
  "palletSpaces",
  "loadingMeters",
  "surfaceTreatment",
  "colour",
  "extraDescription",
  "nameEn",
  "extraDescriptionEn",
  "reorderPoint",
  "safetyStock",
  "stockControlled",
  "forecastControlled",
  // Spårning (#8) follows: a copy is the same kind of goods, and a
  // variant inherits its template's. insertArticle drops it again when the
  // new article cannot be spårad (a Tjänst, a phantom, the setting off).
  "tracking",
  "shelfLifeDays",
  "serialAssignedAt",
  "orderQuantity",
  "rounding",
  "manufacturingLeadTimeDays",
] as const satisfies readonly (keyof CreateArticleInput & keyof typeof articles.$inferSelect)[];

// Default purchase/sales units and the alternative units only make sense
// relative to the base unit, so they follow only when the new article has
// the source's base unit (a factor "1 st = 5 kg" means nothing on a kg article).
export const COPIED_UNIT_FIELDS = ["purchaseUnitId", "salesUnitId"] as const;

export type SourceArticleRow = typeof articles.$inferSelect;

export async function readCopySource(tx: Tx, sourceId: string): Promise<SourceArticleRow | null> {
  const [row] = await tx.select().from(articles).where(eq(articles.id, sourceId));
  return row ?? null;
}

// Overlays the source's Information columns onto the insert values for every
// field the request left out. `values` is the insert object the repository
// built from the request (numerics already strings).
export function applyInformation(
  values: Record<string, unknown>,
  input: CreateArticleInput,
  source: SourceArticleRow,
  copyUnits: boolean
): void {
  for (const field of COPIED_INFORMATION_FIELDS) {
    if (input[field] === undefined) values[field] = source[field];
  }
  if (!copyUnits) return;
  for (const field of COPIED_UNIT_FIELDS) {
    if (input[field] === undefined) values[field] = source[field];
  }
}

// Copies the chosen parts after the new article row exists. Order matters
// for the remapping: files and drawings before the routing (an operation's
// chosen drawings follow by drawing number and its files by the copied
// file's id, copyRouting), routing before BOM, catalog rows before their
// price breaks.
export async function copyArticleParts(
  tx: Tx,
  sourceId: string,
  targetId: string,
  parts: readonly ArticleCopyPart[],
  opts: { copyUnits: boolean }
): Promise<void> {
  if (parts.includes("information") && opts.copyUnits) {
    await tx.execute(sql`
      INSERT INTO article_units (article_id, unit_id, quantity_per_base)
      SELECT ${targetId}, unit_id, quantity_per_base FROM article_units WHERE article_id = ${sourceId}`);
  }
  // Source file id → the copy's id, for the operations' file links.
  let copiedFiles = new Map<string, string>();
  if (parts.includes("filer")) {
    copiedFiles = await copyCurrentFiles(tx, sourceId, targetId);
    // Drawing numbers only — their revision registers are revisions, which
    // are never copied.
    await tx.execute(sql`
      INSERT INTO article_drawings (article_id, drawing_number)
      SELECT ${targetId}, drawing_number FROM article_drawings WHERE article_id = ${sourceId} ORDER BY created_at, id`);
  }
  if (parts.includes("beredning")) await copyBeredning(tx, sourceId, targetId, copiedFiles);
  if (parts.includes("inkop")) await copySupplierCatalog(tx, sourceId, targetId);
}

// The files in force — loose ones and the drawings' active revisions' — as
// loose files: revisions are never copied, so an active revision's file has
// no revision to sit on, and an older revision's is left behind
// (drawing-files.ts). Returns source file id → the copy's id: the new ids are
// drawn up front in a materialized CTE, so ONE statement copies the bytes
// (they never leave the database) and still says which copy is whose — the
// operations' file links follow by id, not by file name (two files in force
// may share a name).
async function copyCurrentFiles(tx: Tx, sourceId: string, targetId: string): Promise<Map<string, string>> {
  const result = await tx.execute(sql`
    WITH pairs AS MATERIALIZED (
      SELECT f.id AS from_id, gen_random_uuid() AS to_id, f.created_at, f.id AS sort_id
      FROM article_files f WHERE f.article_id = ${sourceId} AND ${currentArticleFileSql}
    ), copied AS (
      INSERT INTO article_files (id, article_id, filename, content_type, size_bytes, data)
      SELECT p.to_id, ${targetId}, f.filename, f.content_type, f.size_bytes, f.data
      FROM pairs p JOIN article_files f ON f.id = p.from_id
      ORDER BY p.created_at, p.sort_id
      RETURNING id
    )
    SELECT p.from_id, p.to_id FROM pairs p JOIN copied c ON c.id = p.to_id`);
  return new Map(([...result] as { from_id: string; to_id: string }[]).map((row) => [row.from_id, row.to_id]));
}

// Beredning: the routing (with the lego operation's own file) first via the
// manufacturing module's copyRouting, then BOM rows whose material→operation
// link is remapped to the NEW operation via the old→new id map. `copiedFiles`
// (source file → copy, empty without Ritningar och filer) carries the
// operations' chosen files over.
async function copyBeredning(tx: Tx, sourceId: string, targetId: string, copiedFiles: ReadonlyMap<string, string>) {
  const operationMap = await copyRouting(tx, sourceId, targetId, copiedFiles);

  const bomRows = await tx
    .select()
    .from(bomComponents)
    .where(eq(bomComponents.parentArticleId, sourceId))
    .orderBy(asc(bomComponents.createdAt), asc(bomComponents.id));
  await insertBomRows(
    tx,
    targetId,
    bomRows.map((row) => ({
      componentArticleId: row.componentArticleId,
      quantity: Number(row.quantity),
      unitId: row.unitId,
      unitFactor: row.unitFactor,
      // The transaction reads the source from one snapshot (repeatable
      // read), so every link points at an operation copied above.
      routingOperationId: row.routingOperationId ? operationMap.get(row.routingOperationId)! : null,
      position: row.position,
      costingOnly: row.costingOnly,
    }))
  );
}

// Inköp: the supplier catalog (huvudleverantör flag included) with each
// row's stafflade priser.
async function copySupplierCatalog(tx: Tx, sourceId: string, targetId: string) {
  const rows = await tx
    .select()
    .from(articleSuppliers)
    .where(eq(articleSuppliers.articleId, sourceId))
    .orderBy(asc(articleSuppliers.createdAt), asc(articleSuppliers.id));
  for (const { id: oldId, createdAt: _createdAt, articleId: _articleId, ...rest } of rows) {
    const [inserted] = await tx
      .insert(articleSuppliers)
      .values({ ...rest, articleId: targetId })
      .returning({ id: articleSuppliers.id });
    await tx.execute(sql`
      INSERT INTO article_supplier_price_breaks (article_supplier_id, from_quantity, price)
      SELECT ${inserted!.id}, from_quantity, price
      FROM article_supplier_price_breaks WHERE article_supplier_id = ${oldId}`);
  }
}

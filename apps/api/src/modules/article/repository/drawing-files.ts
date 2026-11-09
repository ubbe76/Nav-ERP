import { sql, type SQL } from "drizzle-orm";
import { articleFiles, type Db, type Tx } from "@navet/db";

// Ritningsfilerna (spec private/superpowers/specs/2026-11-09-ritningar-revisioner-filer-design.md):
// the ONE rule for which of an article's files ride along on their own — the
// TO printout, the lego mail, the terminal and the order mails all read it
// here. A file is either loose (article_files.drawing_revision_id null, the
// Filer tab) or a drawing revision's. Loose files always count; a drawing
// revision's file counts when the revision is the one in force:
//   - for an order with a revision snapshot (mo_drawing_revisions): the
//     snapshot's revision of each drawing;
//   - otherwise (no order, or an order without a snapshot): the drawing's
//     active revision.
// An operation with chosen documents — drawings (routing_operation_drawings)
// and/or loose files (routing_operation_article_files) — gets exactly those;
// with none chosen, all. Files on other revisions are never sent or printed
// by themselves — the Revisioner tab opens them.

type Conn = Db | Tx;

export interface DrawingFileRef {
  articleId: string;
  // The order whose snapshot decides the revisions; null = the current ones.
  moId?: string | null;
  // The operation whose chosen drawings and files narrow the set; null = all.
  routingOperationId?: string | null;
}

export interface DrawingFileMeta {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  // null for a loose file.
  drawingNumber: string | null;
  revision: string | null;
}

export interface DrawingFileWithData extends DrawingFileMeta {
  data: Buffer;
}

// The file is loose or its revision is active (no order in play): the
// order mails' attachments, Kopiera från's files. For drizzle queries over
// article_files, and as raw SQL over article_files aliased `f`.
export const currentArticleFileCondition = sql`(${articleFiles.drawingRevisionId} IS NULL OR EXISTS (
  SELECT 1 FROM article_drawing_revisions cr WHERE cr.id = ${articleFiles.drawingRevisionId} AND cr.is_active))`;
export const currentArticleFileSql = sql`(f.drawing_revision_id IS NULL OR EXISTS (
  SELECT 1 FROM article_drawing_revisions cr WHERE cr.id = f.drawing_revision_id AND cr.is_active))`;

// The revisions in force for the reference: drawing → revision (null when
// the drawing has none), in drawing-number order.
function revisionsInForceSql(ref: DrawingFileRef): SQL {
  const snapshot = ref.moId
    ? sql`SELECT s.drawing_id, s.drawing_revision_id
          FROM mo_drawing_revisions s
          JOIN manufacturing_orders mo ON mo.id = s.manufacturing_order_id
          WHERE s.manufacturing_order_id = ${ref.moId} AND mo.revisions_snapshot_at IS NOT NULL AND s.drawing_id IS NOT NULL`
    : null;
  const current = sql`SELECT d.id AS drawing_id, r.id AS drawing_revision_id
          FROM article_drawings d
          LEFT JOIN article_drawing_revisions r ON r.drawing_id = d.id AND r.is_active
          WHERE d.article_id = ${ref.articleId}`;
  if (!snapshot) return current;
  // The snapshot when the order has one, otherwise the current revisions.
  return sql`${snapshot}
          UNION ALL
          ${current} AND NOT EXISTS (
            SELECT 1 FROM manufacturing_orders mo2 WHERE mo2.id = ${ref.moId} AND mo2.revisions_snapshot_at IS NOT NULL)`;
}

async function selectFiles<T>(db: Conn, ref: DrawingFileRef, withData: boolean): Promise<T[]> {
  const data = withData ? sql`, f.data` : sql``;
  // An operation's chosen documents: drawings (routing_operation_drawings)
  // and loose files (routing_operation_article_files — only while the file is
  // still loose). With any chosen, the operation gets exactly them; with none,
  // everything.
  let narrowed = sql``;
  let loose = sql``;
  if (ref.routingOperationId) {
    const chosenDrawings = sql`(SELECT cd.drawing_id FROM routing_operation_drawings cd WHERE cd.routing_operation_id = ${ref.routingOperationId})`;
    const chosenFiles = sql`(SELECT cf.article_file_id FROM routing_operation_article_files cf
      JOIN article_files lf ON lf.id = cf.article_file_id AND lf.drawing_revision_id IS NULL
      WHERE cf.routing_operation_id = ${ref.routingOperationId})`;
    const anyChosen = sql`(EXISTS ${chosenDrawings} OR EXISTS ${chosenFiles})`;
    narrowed = sql`AND (NOT ${anyChosen} OR rf.drawing_id IN ${chosenDrawings})`;
    loose = sql`AND (NOT ${anyChosen} OR f.id IN ${chosenFiles})`;
  }
  const result = await db.execute(sql`
    WITH rf AS (${revisionsInForceSql(ref)})
    SELECT f.id, f.filename, f.content_type AS "contentType", f.size_bytes AS "sizeBytes",
           d.drawing_number AS "drawingNumber", r.revision ${data}
    FROM rf
    JOIN article_files f ON f.drawing_revision_id = rf.drawing_revision_id AND f.article_id = ${ref.articleId}
    JOIN article_drawing_revisions r ON r.id = f.drawing_revision_id
    JOIN article_drawings d ON d.id = r.drawing_id
    WHERE TRUE ${narrowed}
    UNION ALL
    SELECT f.id, f.filename, f.content_type, f.size_bytes, NULL, NULL ${data}
    FROM article_files f
    WHERE f.article_id = ${ref.articleId} AND f.drawing_revision_id IS NULL ${loose}
    ORDER BY 5 NULLS LAST, 2, 1`);
  // postgres-js: the result is the row array (bytea as Buffer).
  return [...result] as unknown as T[];
}

// Names and sizes only — the terminal's list, the TO card.
export function drawingFiles(db: Conn, ref: DrawingFileRef): Promise<DrawingFileMeta[]> {
  return selectFiles<DrawingFileMeta>(db, ref, false);
}

// With the bytes — the TO printout and the lego mail.
export function drawingFilesWithData(db: Conn, ref: DrawingFileRef): Promise<DrawingFileWithData[]> {
  return selectFiles<DrawingFileWithData>(db, ref, true);
}

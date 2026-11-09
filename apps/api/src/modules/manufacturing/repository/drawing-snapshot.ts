import { sql } from "drizzle-orm";
import type { Db, Tx } from "@navet/db";

// Revisionerna TO:n byggs efter (0200, spec
// private/superpowers/specs/2026-11-09-ritningar-revisioner-filer-design.md):
// the article's active revision (text) and each drawing's active revision,
// snapshotted at release (releaseInTx) and again by Uppdatera. What differs
// from today's revisions is derived at read time (orderRevisions), never
// stored. Which FILES go with an order is article/repository/drawing-files.ts.

type Conn = Db | Tx;

// Replaces the order's snapshot with the current revisions. The caller holds
// the order (release, or Uppdatera's FOR NO KEY UPDATE).
export async function snapshotOrderRevisionsInTx(tx: Tx, moId: string): Promise<void> {
  await tx.execute(sql`DELETE FROM mo_drawing_revisions WHERE manufacturing_order_id = ${moId}`);
  await tx.execute(sql`
    INSERT INTO mo_drawing_revisions (manufacturing_order_id, drawing_id, drawing_number, drawing_revision_id, revision)
    SELECT mo.id, d.id, d.drawing_number, r.id, r.revision
    FROM manufacturing_orders mo
    JOIN article_drawings d ON d.article_id = mo.article_id
    LEFT JOIN article_drawing_revisions r ON r.drawing_id = d.id AND r.is_active
    WHERE mo.id = ${moId}`);
  await tx.execute(sql`
    UPDATE manufacturing_orders mo SET
      article_revision = (
        SELECT ar.revision FROM article_revisions ar WHERE ar.article_id = mo.article_id AND ar.is_active
      ),
      revisions_snapshot_at = now()
    WHERE mo.id = ${moId}`);
}

export interface RevisionFile {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
}

export interface OrderDrawingRevision {
  // null when the drawing has been deleted since (the text stays).
  drawingId: string | null;
  drawingNumber: string;
  // The revision the order is built from; null = none (the drawing had no
  // active revision, or — with `added` — it came after the snapshot).
  revision: string | null;
  file: RevisionFile | null;
  // Today's active revision of the drawing; null when the drawing is gone.
  current: { revision: string | null; file: RevisionFile | null } | null;
  changed: boolean;
  // The drawing came after the snapshot.
  added: boolean;
}

export interface OrderRevisions {
  snapshotAt: string | null;
  articleRevision: string | null;
  currentArticleRevision: string | null;
  drawings: OrderDrawingRevision[];
  looseFiles: RevisionFile[];
  // Anything differs from today's revisions (Ny revision sedan frisläpp).
  changed: boolean;
}

interface DrawingRow {
  drawing_id: string | null;
  drawing_number: string;
  revision_id: string | null;
  revision: string | null;
  file_id: string | null;
  filename: string | null;
  content_type: string | null;
  size_bytes: number | null;
}

const fileOf = (row: DrawingRow): RevisionFile | null =>
  row.file_id
    ? { id: row.file_id, filename: row.filename!, contentType: row.content_type!, sizeBytes: row.size_bytes! }
    : null;

// The TO card's Ritningar: what the order is built from beside today's
// revisions. null when there is no such order. An order without a snapshot
// (from before 0200 and not open then) shows today's revisions, unchanged.
export async function orderRevisions(db: Conn, moId: string): Promise<OrderRevisions | null> {
  const [order] = (await db.execute(sql`
    SELECT mo.article_id, mo.article_revision, mo.revisions_snapshot_at,
           (SELECT ar.revision FROM article_revisions ar WHERE ar.article_id = mo.article_id AND ar.is_active) AS current_revision
    FROM manufacturing_orders mo WHERE mo.id = ${moId}`)) as unknown as {
    article_id: string;
    article_revision: string | null;
    revisions_snapshot_at: Date | string | null;
    current_revision: string | null;
  }[];
  if (!order) return null;

  const current = [
    ...(await db.execute(sql`
      SELECT d.id AS drawing_id, d.drawing_number, r.id AS revision_id, r.revision,
             f.id AS file_id, f.filename, f.content_type, f.size_bytes
      FROM article_drawings d
      LEFT JOIN article_drawing_revisions r ON r.drawing_id = d.id AND r.is_active
      LEFT JOIN article_files f ON f.drawing_revision_id = r.id
      WHERE d.article_id = ${order.article_id}
      ORDER BY d.drawing_number`)),
  ] as unknown as DrawingRow[];
  const looseFiles = [
    ...(await db.execute(sql`
      SELECT f.id, f.filename, f.content_type AS "contentType", f.size_bytes AS "sizeBytes"
      FROM article_files f WHERE f.article_id = ${order.article_id} AND f.drawing_revision_id IS NULL
      ORDER BY f.filename, f.id`)),
  ] as unknown as RevisionFile[];

  const currentView = (row: DrawingRow) => ({ revision: row.revision, file: fileOf(row) });
  if (order.revisions_snapshot_at === null) {
    return {
      snapshotAt: null,
      articleRevision: order.current_revision,
      currentArticleRevision: order.current_revision,
      drawings: current.map((row) => ({
        drawingId: row.drawing_id,
        drawingNumber: row.drawing_number,
        revision: row.revision,
        file: fileOf(row),
        current: currentView(row),
        changed: false,
        added: false,
      })),
      looseFiles,
      changed: false,
    };
  }

  const snapshot = [
    ...(await db.execute(sql`
      SELECT s.drawing_id, s.drawing_number, s.drawing_revision_id AS revision_id, s.revision,
             f.id AS file_id, f.filename, f.content_type, f.size_bytes
      FROM mo_drawing_revisions s
      LEFT JOIN article_files f ON f.drawing_revision_id = s.drawing_revision_id
      WHERE s.manufacturing_order_id = ${moId}
      ORDER BY s.drawing_number`)),
  ] as unknown as DrawingRow[];
  const currentById = new Map(current.map((row) => [row.drawing_id!, row]));
  const drawings: OrderDrawingRevision[] = snapshot.map((row) => {
    const now = row.drawing_id ? currentById.get(row.drawing_id) : undefined;
    return {
      drawingId: row.drawing_id,
      drawingNumber: row.drawing_number,
      revision: row.revision,
      file: fileOf(row),
      current: now ? currentView(now) : null,
      changed: !now || now.revision_id !== row.revision_id,
      added: false,
    };
  });
  const inSnapshot = new Set(snapshot.map((row) => row.drawing_id));
  for (const row of current) {
    if (inSnapshot.has(row.drawing_id)) continue;
    drawings.push({
      drawingId: row.drawing_id,
      drawingNumber: row.drawing_number,
      revision: null,
      file: null,
      current: currentView(row),
      changed: true,
      added: true,
    });
  }
  drawings.sort((a, b) => a.drawingNumber.localeCompare(b.drawingNumber, "sv", { numeric: true }));
  const snapshotAt = order.revisions_snapshot_at;
  return {
    snapshotAt: snapshotAt instanceof Date ? snapshotAt.toISOString() : new Date(snapshotAt).toISOString(),
    articleRevision: order.article_revision,
    currentArticleRevision: order.current_revision,
    drawings,
    looseFiles,
    changed: order.article_revision !== order.current_revision || drawings.some((d) => d.changed),
  };
}

// The printout's header line: "Revision B · Ritningar: R-1001 rev 2,
// R-1002 rev A" — what the order is built from (added drawings are not).
export function revisionLine(view: OrderRevisions): string | null {
  const drawings = view.drawings
    .filter((d) => !d.added)
    .map((d) => (d.revision ? `${d.drawingNumber} rev ${d.revision}` : d.drawingNumber));
  const parts = [
    view.articleRevision ? `Revision ${view.articleRevision}` : null,
    drawings.length > 0 ? `Ritningar: ${drawings.join(", ")}` : null,
  ].filter((p): p is string => p !== null);
  return parts.length > 0 ? parts.join(" · ") : null;
}

// The order's operations' chosen drawings (routing_operation_drawings, read
// live through mo_operations.routing_operation_id) with the revision the
// order is built from: moOperationId → "R-1002 rev A", in drawing order.
export async function operationDrawingLabels(db: Conn, moId: string, view: OrderRevisions): Promise<Map<string, string[]>> {
  const rows = [
    ...(await db.execute(sql`
      SELECT o.id AS mo_operation_id, l.drawing_id, d.drawing_number
      FROM mo_operations o
      JOIN routing_operation_drawings l ON l.routing_operation_id = o.routing_operation_id
      JOIN article_drawings d ON d.id = l.drawing_id
      WHERE o.manufacturing_order_id = ${moId}
      ORDER BY d.drawing_number`)),
  ] as unknown as { mo_operation_id: string; drawing_id: string; drawing_number: string }[];
  const byDrawing = new Map(view.drawings.filter((d) => d.drawingId).map((d) => [d.drawingId!, d]));
  const map = new Map<string, string[]>();
  for (const row of rows) {
    const d = byDrawing.get(row.drawing_id);
    // A drawing added after the snapshot is printed as today's number only.
    const revision = d && !d.added ? d.revision : null;
    const list = map.get(row.mo_operation_id) ?? [];
    list.push(revision ? `${row.drawing_number} rev ${revision}` : row.drawing_number);
    map.set(row.mo_operation_id, list);
  }
  return map;
}

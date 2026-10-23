// The article import's Revisioner step (Artikelrevision, Ritningsnummer,
// Ritningsrevision), run inside executeArticlePlan's transaction after the
// articles exist. Idempotent and additive: a missing revision or drawing
// number is added, the named revision becomes the active one, and nothing
// is ever removed — the card's own Ta bort is the only way out.
import { and, inArray } from "drizzle-orm";
import { articleDrawingRevisions, articleDrawings, articleRevisions, type Tx } from "@navet/db";
import type { ArticleRevisionPlan } from "../service/articles.js";

const CHUNK_SIZE = 500;

function chunk<T>(items: T[]): T[][] {
  const parts: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK_SIZE) parts.push(items.slice(i, i + CHUNK_SIZE));
  return parts;
}

export interface ImportedRevisions extends ArticleRevisionPlan {
  articleId: string;
}

interface RevisionRow {
  id: string;
  ownerId: string;
  revision: string;
  isActive: boolean;
}

export interface RevisionChanges {
  deactivate: string[];
  activate: string[];
  insert: { ownerId: string; revision: string }[];
}

// Pure: what makes `targets` (owner -> revision) the active revisions, given
// the owners' current rows. Same rule as the card's Aktivera: at most one
// active per owner, so the old active row is switched off first.
export function revisionChanges(existing: RevisionRow[], targets: Map<string, string>): RevisionChanges {
  const changes: RevisionChanges = { deactivate: [], activate: [], insert: [] };
  const byOwner = new Map<string, RevisionRow[]>();
  for (const row of existing) byOwner.set(row.ownerId, [...(byOwner.get(row.ownerId) ?? []), row]);
  for (const [ownerId, revision] of targets) {
    const rows = byOwner.get(ownerId) ?? [];
    const target = rows.find((r) => r.revision === revision);
    if (target?.isActive) continue;
    changes.deactivate.push(...rows.filter((r) => r.isActive).map((r) => r.id));
    if (target) changes.activate.push(target.id);
    else changes.insert.push({ ownerId, revision });
  }
  return changes;
}

async function setArticleRevisions(tx: Tx, targets: Map<string, string>) {
  if (targets.size === 0) return;
  const existing: RevisionRow[] = [];
  for (const part of chunk([...targets.keys()])) {
    existing.push(
      ...(await tx
        .select({
          id: articleRevisions.id,
          ownerId: articleRevisions.articleId,
          revision: articleRevisions.revision,
          isActive: articleRevisions.isActive,
        })
        .from(articleRevisions)
        .where(inArray(articleRevisions.articleId, part)))
    );
  }
  const changes = revisionChanges(existing, targets);
  // Off before on: the partial unique index allows one active per article.
  for (const part of chunk(changes.deactivate)) {
    await tx.update(articleRevisions).set({ isActive: false }).where(inArray(articleRevisions.id, part));
  }
  for (const part of chunk(changes.activate)) {
    await tx.update(articleRevisions).set({ isActive: true }).where(inArray(articleRevisions.id, part));
  }
  for (const part of chunk(changes.insert)) {
    await tx
      .insert(articleRevisions)
      .values(part.map((row) => ({ articleId: row.ownerId, revision: row.revision, isActive: true })));
  }
}

async function setDrawingRevisions(tx: Tx, targets: Map<string, string>) {
  if (targets.size === 0) return;
  const existing: RevisionRow[] = [];
  for (const part of chunk([...targets.keys()])) {
    existing.push(
      ...(await tx
        .select({
          id: articleDrawingRevisions.id,
          ownerId: articleDrawingRevisions.drawingId,
          revision: articleDrawingRevisions.revision,
          isActive: articleDrawingRevisions.isActive,
        })
        .from(articleDrawingRevisions)
        .where(inArray(articleDrawingRevisions.drawingId, part)))
    );
  }
  const changes = revisionChanges(existing, targets);
  for (const part of chunk(changes.deactivate)) {
    await tx.update(articleDrawingRevisions).set({ isActive: false }).where(inArray(articleDrawingRevisions.id, part));
  }
  for (const part of chunk(changes.activate)) {
    await tx.update(articleDrawingRevisions).set({ isActive: true }).where(inArray(articleDrawingRevisions.id, part));
  }
  for (const part of chunk(changes.insert)) {
    await tx
      .insert(articleDrawingRevisions)
      .values(part.map((row) => ({ drawingId: row.ownerId, revision: row.revision, isActive: true })));
  }
}

// One row per article (the planner refuses an article number twice).
export async function applyImportedRevisions(tx: Tx, rows: ImportedRevisions[]): Promise<void> {
  const articleTargets = new Map<string, string>();
  for (const row of rows) if (row.articleRevision !== null) articleTargets.set(row.articleId, row.articleRevision);
  await setArticleRevisions(tx, articleTargets);

  const drawingRows = rows.filter((row) => row.drawingNumber !== null);
  if (drawingRows.length === 0) return;
  for (const part of chunk(drawingRows)) {
    await tx
      .insert(articleDrawings)
      .values(part.map((row) => ({ articleId: row.articleId, drawingNumber: row.drawingNumber! })))
      .onConflictDoNothing({ target: [articleDrawings.articleId, articleDrawings.drawingNumber] });
  }

  const revisionRows = drawingRows.filter((row) => row.drawingRevision !== null);
  if (revisionRows.length === 0) return;
  const drawingIds = new Map<string, string>();
  for (const part of chunk(revisionRows)) {
    const found = await tx
      .select({ id: articleDrawings.id, articleId: articleDrawings.articleId, drawingNumber: articleDrawings.drawingNumber })
      .from(articleDrawings)
      .where(
        and(
          inArray(
            articleDrawings.articleId,
            part.map((row) => row.articleId)
          ),
          inArray(
            articleDrawings.drawingNumber,
            part.map((row) => row.drawingNumber!)
          )
        )
      );
    for (const drawing of found) drawingIds.set(`${drawing.articleId}\u0000${drawing.drawingNumber}`, drawing.id);
  }
  const drawingTargets = new Map<string, string>();
  for (const row of revisionRows) {
    drawingTargets.set(drawingIds.get(`${row.articleId}\u0000${row.drawingNumber}`)!, row.drawingRevision!);
  }
  await setDrawingRevisions(tx, drawingTargets);
}

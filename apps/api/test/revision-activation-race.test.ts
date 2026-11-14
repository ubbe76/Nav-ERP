import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { articleDrawingRevisions, articleRevisions, db } from "@navet/db";
import {
  createArticleDrawingSchema,
  createArticleRevisionSchema,
  createArticleSchema,
  updateArticleRevisionSchema,
} from "@navet/shared";
import { parsed } from "./helpers/parsed.js";
import { testArticleService as articles } from "./helpers/services.js";

// Två samtidiga Aktivera på olika revisioner (artikelgranskningen
// 2026-11-11): both switched the old active revision off and the second then
// hit the one-active index — a 409 "Revision already exists". The article
// (or drawing) row is now locked first, so they run in turn.
//
// Deterministic: a held transaction locks the active revision, both
// Aktivera are started and the test waits until both sessions wait on a
// lock — without the fix both had already taken their snapshot for the
// switch-off — then lets the held transaction go.

const TRUNCATE = sql`TRUNCATE article_drawing_revisions, article_drawings, article_revisions, articles CASCADE`;
beforeEach(async () => {
  await db.execute(TRUNCATE);
});
afterAll(async () => {
  await db.execute(TRUNCATE);
});

async function article() {
  const number = `REV-${crypto.randomUUID().slice(0, 8)}`;
  return articles.createArticle(parsed(createArticleSchema, { articleNumber: number, name: number, type: "manufactured", active: true }));
}

// Waits until `count` sessions of this database wait on a lock.
async function sessionsWaitingOnLocks(count: number) {
  for (let i = 0; i < 200; i++) {
    const [row] = await db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`
    );
    if (row!.n >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`fewer than ${count} sessions waited on a lock`);
}

// Holds a lock on the row with `id` in `table` while `during` runs.
async function holdingRowLock(table: "article_revisions" | "article_drawing_revisions", id: string, during: () => Promise<void>) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let locked!: () => void;
  const isLocked = new Promise<void>((resolve) => (locked = resolve));
  const holder = db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM ${sql.identifier(table)} WHERE id = ${id} FOR UPDATE`);
    locked();
    await released;
  });
  await isLocked;
  try {
    await during();
  } finally {
    release();
  }
  await holder;
}

// Starts both activations while the old active revision is locked, waits
// until both sessions wait on a lock, then lets go and collects the answers.
async function activateBothAtOnce(
  table: "article_revisions" | "article_drawing_revisions",
  oldActiveId: string,
  activate: () => Promise<unknown>[]
) {
  let both!: Promise<PromiseSettledResult<unknown>[]>;
  await holdingRowLock(table, oldActiveId, async () => {
    both = Promise.allSettled(activate());
    await sessionsWaitingOnLocks(2);
  });
  return (await both).map((r) => (r.status === "rejected" ? String(r.reason) : "ok"));
}

describe("two Aktivera on different revisions at once", () => {
  it("article revisions: both go through, one after the other, and one revision is active", async () => {
    const a = await article();
    const old = await articles.createRevision(a.id, parsed(createArticleRevisionSchema, { revision: "A", isActive: true }));
    const b = await articles.createRevision(a.id, parsed(createArticleRevisionSchema, { revision: "B" }));
    const c = await articles.createRevision(a.id, parsed(createArticleRevisionSchema, { revision: "C" }));

    const results = await activateBothAtOnce("article_revisions", old.id, () => [
      articles.updateRevision(a.id, b.id, parsed(updateArticleRevisionSchema, { isActive: true })),
      articles.updateRevision(a.id, c.id, parsed(updateArticleRevisionSchema, { isActive: true })),
    ]);
    expect(results).toEqual(["ok", "ok"]);
    const active = await db.select().from(articleRevisions).where(eq(articleRevisions.isActive, true));
    expect(active).toHaveLength(1);
    expect(["B", "C"]).toContain(active[0]!.revision);
  });

  it("drawing revisions: the same, per drawing", async () => {
    const a = await article();
    const drawing = await articles.createDrawing(a.id, parsed(createArticleDrawingSchema, { drawingNumber: "R-100" }));
    const old = await articles.createDrawingRevision(a.id, drawing.id, parsed(createArticleRevisionSchema, { revision: "A", isActive: true }));
    const b = await articles.createDrawingRevision(a.id, drawing.id, parsed(createArticleRevisionSchema, { revision: "B" }));
    const c = await articles.createDrawingRevision(a.id, drawing.id, parsed(createArticleRevisionSchema, { revision: "C" }));

    const results = await activateBothAtOnce("article_drawing_revisions", old.id, () => [
      articles.updateDrawingRevision(a.id, drawing.id, b.id, parsed(updateArticleRevisionSchema, { isActive: true })),
      articles.updateDrawingRevision(a.id, drawing.id, c.id, parsed(updateArticleRevisionSchema, { isActive: true })),
    ]);
    expect(results).toEqual(["ok", "ok"]);
    const active = await db
      .select()
      .from(articleDrawingRevisions)
      .where(eq(articleDrawingRevisions.isActive, true));
    expect(active).toHaveLength(1);
    expect(["B", "C"]).toContain(active[0]!.revision);
  });
});

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { articles, userCopiedArticles, type Db, type Tx } from "@navet/db";
import { COPIED_ARTICLES_MAX } from "@navet/shared";

// Kopierat (#28, migration 0199): the user's own working list of articles.
// Db | Tx leaf like article-number.ts — the article repository delegates
// here, and setCopiedArticles opens its own transaction.

// Thrown when the write would leave the list with more than
// COPIED_ARTICLES_MAX articles. `count` is what the list WOULD have held;
// nothing is written (the transaction rolls back, including a replace's
// delete). Lives here rather than in the service so the repository's
// transaction can throw it; the service re-exports it for the routes.
export class CopiedArticlesTooManyError extends Error {
  readonly count: number;
  readonly max = COPIED_ARTICLES_MAX;
  constructor(count: number) {
    super(`Kopierat skulle få ${count} artiklar — högst ${COPIED_ARTICLES_MAX} ryms`);
    this.name = "CopiedArticlesTooManyError";
    this.count = count;
  }
}

// The list in the order the articles were copied.
export async function listCopiedArticleIds(ex: Db | Tx, userId: string): Promise<string[]> {
  const rows = await ex
    .select({ articleId: userCopiedArticles.articleId })
    .from(userCopiedArticles)
    .where(eq(userCopiedArticles.userId, userId))
    .orderBy(asc(userCopiedArticles.position), asc(userCopiedArticles.articleId));
  return rows.map((row) => row.articleId);
}

export async function countCopiedArticles(ex: Db | Tx, userId: string): Promise<number> {
  const [row] = await ex
    .select({ n: sql<number>`count(*)::int` })
    .from(userCopiedArticles)
    .where(eq(userCopiedArticles.userId, userId));
  return row?.n ?? 0;
}

// `add`: the ids not yet in the list are appended, in the given order, after
// the user's current max position; the ones already there keep their place.
// `replace`: the list is emptied first, in the same transaction. Duplicates
// in the input count once (first occurrence wins), ids that are not articles
// are ignored. Returns the list's count afterwards and how many were added.
//
// Race safety for the cap: the check is "current rows + new rows <=
// COPIED_ARTICLES_MAX", and two concurrent adds for the same user must not
// both pass it. Row locks cannot do that — an INSERT of new (user, article)
// keys conflicts with nothing another INSERT holds, and an empty list has
// no rows to lock at all — so the whole write runs under a transaction-
// scoped advisory lock keyed on the user id (released at commit/rollback,
// hence it cannot leak on a thrown error). It serializes only that user's
// own writes to this list; other users, the users row and the articles
// rows are untouched, so it never queues behind an FK's FOR KEY SHARE the
// way a FOR UPDATE on `users` could (compare the routing lock in article.md).
// Test: copied-articles.test.ts ("two concurrent adds").
export async function setCopiedArticles(
  db: Db,
  userId: string,
  articleIds: readonly string[],
  mode: "add" | "replace"
): Promise<{ count: number; added: number }> {
  const wanted = [...new Set(articleIds)];
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('user_copied_articles'), hashtext(${userId}))`);
    if (mode === "replace") await tx.delete(userCopiedArticles).where(eq(userCopiedArticles.userId, userId));

    // Only real articles (unknown or deleted ids are ignored), in the order
    // given — the SQL answers in any order, so the order is restored here.
    const known =
      wanted.length === 0
        ? new Set<string>()
        : new Set((await tx.select({ id: articles.id }).from(articles).where(inArray(articles.id, wanted))).map((row) => row.id));
    const existing = new Set(await listCopiedArticleIds(tx, userId));
    const toAdd = wanted.filter((id) => known.has(id) && !existing.has(id));

    const count = existing.size + toAdd.length;
    if (count > COPIED_ARTICLES_MAX) throw new CopiedArticlesTooManyError(count);
    if (toAdd.length === 0) return { count, added: 0 };

    const [maxRow] = await tx
      .select({ max: sql<number | null>`max(${userCopiedArticles.position})` })
      .from(userCopiedArticles)
      .where(eq(userCopiedArticles.userId, userId));
    const start = (maxRow?.max ?? 0) + 1;
    // on conflict do nothing is belt and braces: the lock above already
    // keeps a concurrent add of the same article out of this transaction.
    await tx
      .insert(userCopiedArticles)
      .values(toAdd.map((articleId, i) => ({ userId, articleId, position: start + i })))
      .onConflictDoNothing();
    return { count, added: toAdd.length };
  });
}

// Takes the given ids out of the list; the others keep their positions (the
// order stays, gaps are fine — readers order by position, never by index).
export async function removeCopiedArticles(db: Db, userId: string, articleIds: readonly string[]): Promise<{ count: number }> {
  const ids = [...new Set(articleIds)];
  if (ids.length > 0) {
    await db.delete(userCopiedArticles).where(and(eq(userCopiedArticles.userId, userId), inArray(userCopiedArticles.articleId, ids)));
  }
  return { count: await countCopiedArticles(db, userId) };
}

export async function clearCopiedArticles(db: Db, userId: string): Promise<{ count: 0 }> {
  await db.delete(userCopiedArticles).where(eq(userCopiedArticles.userId, userId));
  return { count: 0 };
}

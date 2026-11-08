import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { articles, db, userCopiedArticles, users } from "@navet/db";
import { COPIED_ARTICLES_MAX, copiedArticlesSetSchema, createArticleSchema, listArticlesQuerySchema, type AbcClass } from "@navet/shared";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService, CopiedArticlesTooManyError } from "../src/modules/article/service/article.service.js";
import { parsed } from "./helpers/parsed.js";

// Kopierat (#28, migration 0199): the user's own working list of articles —
// the repository leaf (copied-articles.ts) and the service: the order, add
// versus replace, unknown ids, the 5 000 cap (nothing written, race-safe),
// `query` as the register's hits, the register's copied=true filter with
// total and paging (alone and intersected with search/abcClass), remove and
// clear, the cascades and per-user isolation.

const repo = createArticleRepository(db);
// The ABC reader is a fixed map the tests fill — the classification itself
// is the planning module's (abc.integration.test.ts).
const abcByArticle = new Map<string, AbcClass>();
const service = createArticleService(repo, undefined, { abc: { abcClassByArticle: async () => abcByArticle } });

const TRUNCATE = sql`TRUNCATE user_copied_articles, bom_components, stock_transactions, articles, article_groups, user_settings, users CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
  abcByArticle.clear();
});

afterAll(async () => {
  await db.execute(TRUNCATE);
});

async function makeUser(label = "u") {
  const [user] = await db
    .insert(users)
    .values({ email: `${label}-${crypto.randomUUID()}@example.com`, passwordHash: "x", name: label, role: "user" })
    .returning();
  return user!;
}

async function makeArticle(articleNumber: string, extra: { type?: "manufactured" | "purchased"; name?: string } = {}) {
  return service.createArticle(
    parsed(createArticleSchema, { articleNumber, name: extra.name ?? articleNumber, type: extra.type ?? "purchased", active: true })
  );
}

// A register of n articles in one statement — the cap tests need more than
// 5 000 and createArticle one by one would take minutes.
async function bulkArticles(n: number, prefix = "BULK"): Promise<string[]> {
  const unitId = await repo.getOrCreateDefaultUnitId();
  const ids: string[] = [];
  for (let from = 0; from < n; from += 2000) {
    const batch = Array.from({ length: Math.min(2000, n - from) }, (_, i) => ({
      articleNumber: `${prefix}-${String(from + i).padStart(5, "0")}`,
      name: `${prefix} ${from + i}`,
      type: "purchased" as const,
      unitId,
    }));
    const rows = await db.insert(articles).values(batch).returning({ id: articles.id });
    ids.push(...rows.map((r) => r.id));
  }
  return ids;
}

const list = (q: Record<string, string>, userId?: string) => service.listArticles(listArticlesQuerySchema.parse(q), userId);
const set = (userId: string, body: unknown) => service.setCopiedArticles(userId, copiedArticlesSetSchema.parse(body));
const ids = async (userId: string) => (await service.listCopiedArticles(userId)).articleIds;

describe("Kopierat — add, replace and the order", () => {
  it("keeps the order the articles were copied in, appends new ones last and leaves copied ones where they were", async () => {
    const user = await makeUser();
    const [a, b, c, d] = await Promise.all([makeArticle("A-1"), makeArticle("B-1"), makeArticle("C-1"), makeArticle("D-1")]);

    expect(await set(user.id, { mode: "add", articleIds: [c!.id, a!.id] })).toEqual({ count: 2, added: 2 });
    expect(await ids(user.id)).toEqual([c!.id, a!.id]);

    // a is already there: it keeps position 2, d and b go after.
    expect(await set(user.id, { mode: "add", articleIds: [d!.id, a!.id, b!.id] })).toEqual({ count: 4, added: 2 });
    expect(await ids(user.id)).toEqual([c!.id, a!.id, d!.id, b!.id]);
    expect(await service.listCopiedArticles(user.id)).toEqual({ count: 4, articleIds: [c!.id, a!.id, d!.id, b!.id] });
  });

  it("replace empties the list first, in the same transaction, and takes the new order", async () => {
    const user = await makeUser();
    const [a, b, c] = await Promise.all([makeArticle("A-2"), makeArticle("B-2"), makeArticle("C-2")]);
    await set(user.id, { mode: "add", articleIds: [a!.id, b!.id] });

    expect(await set(user.id, { mode: "replace", articleIds: [c!.id, a!.id] })).toEqual({ count: 2, added: 2 });
    expect(await ids(user.id)).toEqual([c!.id, a!.id]);
  });

  it("counts a duplicate in the input once and ignores ids that are not articles", async () => {
    const user = await makeUser();
    const a = await makeArticle("A-3");
    const ghost = crypto.randomUUID();

    expect(await set(user.id, { mode: "add", articleIds: [ghost, a.id, a.id] })).toEqual({ count: 1, added: 1 });
    expect(await ids(user.id)).toEqual([a.id]);
    // Nothing new: count stays, added is 0.
    expect(await set(user.id, { mode: "add", articleIds: [a.id, ghost] })).toEqual({ count: 1, added: 0 });
  });

  it("positions survive a removal in the middle: later additions still go last", async () => {
    const user = await makeUser();
    const [a, b, c] = await Promise.all([makeArticle("A-4"), makeArticle("B-4"), makeArticle("C-4")]);
    await set(user.id, { mode: "add", articleIds: [a!.id, b!.id] });
    expect(await service.removeCopiedArticles(user.id, { articleIds: [a!.id] })).toEqual({ count: 1 });
    await set(user.id, { mode: "add", articleIds: [c!.id] });
    expect(await ids(user.id)).toEqual([b!.id, c!.id]);
  });
});

describe("Kopierat — the cap", () => {
  it("refuses a list that would exceed COPIED_ARTICLES_MAX with the resulting count and writes nothing — not even a replace's delete", async () => {
    const user = await makeUser();
    const bulk = await bulkArticles(COPIED_ARTICLES_MAX + 1);
    const [a, b] = await Promise.all([makeArticle("KEEP-1"), makeArticle("KEEP-2")]);
    await set(user.id, { mode: "add", articleIds: [a!.id, b!.id] });

    // add: 2 + 5 001
    await expect(set(user.id, { mode: "add", articleIds: bulk })).rejects.toMatchObject({
      name: "CopiedArticlesTooManyError",
      count: COPIED_ARTICLES_MAX + 3,
      max: COPIED_ARTICLES_MAX,
    });
    expect(await ids(user.id)).toEqual([a!.id, b!.id]);

    // replace: the delete is rolled back with the refused insert.
    const tooMany = set(user.id, { mode: "replace", articleIds: bulk });
    await expect(tooMany).rejects.toBeInstanceOf(CopiedArticlesTooManyError);
    await expect(tooMany).rejects.toMatchObject({ count: COPIED_ARTICLES_MAX + 1 });
    expect(await ids(user.id)).toEqual([a!.id, b!.id]);

    // Exactly the cap is fine.
    expect(await set(user.id, { mode: "replace", articleIds: bulk.slice(0, COPIED_ARTICLES_MAX) })).toEqual({
      count: COPIED_ARTICLES_MAX,
      added: COPIED_ARTICLES_MAX,
    });
    expect((await service.listCopiedArticles(user.id)).count).toBe(COPIED_ARTICLES_MAX);
  });

  it("two concurrent adds cannot together exceed the cap (the per-user advisory lock)", async () => {
    const user = await makeUser();
    const bulk = await bulkArticles(COPIED_ARTICLES_MAX + 2);
    await set(user.id, { mode: "add", articleIds: bulk.slice(0, COPIED_ARTICLES_MAX - 1) });

    // Each add alone would pass (4 999 + 1); together they would not.
    const results = await Promise.allSettled([
      set(user.id, { mode: "add", articleIds: [bulk[COPIED_ARTICLES_MAX - 1]!, bulk[COPIED_ARTICLES_MAX]!] }),
      set(user.id, { mode: "add", articleIds: [bulk[COPIED_ARTICLES_MAX + 1]!] }),
    ]);
    // Whichever took the lock first: the two-id add first ⇒ 5 001 refused,
    // then 4 999 + 1 fits; the one-id add first ⇒ 5 000, then 5 000 + 2 is
    // refused. Exactly one is refused and the list ends at the cap — never
    // 5 001 or 5 002, which two unserialized count checks would allow.
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(CopiedArticlesTooManyError);
    expect((await service.listCopiedArticles(user.id)).count).toBe(COPIED_ARTICLES_MAX);
  });
});

describe("Kopierat — query is the register's hits", () => {
  it("copies exactly what the list answers for the same search and filters, in the list's order", async () => {
    const user = await makeUser();
    await Promise.all([
      makeArticle("SKRUV-1", { name: "Skruv M6" }),
      makeArticle("SKRUV-2", { name: "Skruv M8", type: "manufactured" }),
      makeArticle("MUTTER-1", { name: "Mutter M6" }),
      makeArticle("BRICKA-1", { name: "Bricka skruv" }),
    ]);

    const hits = await list({ search: "skruv", type: "purchased", limit: "1000" });
    expect(hits.total).toBe(2);
    expect(await set(user.id, { mode: "replace", query: { search: "skruv", type: "purchased" } })).toEqual({ count: 2, added: 2 });
    expect(await ids(user.id)).toEqual(hits.rows.map((r) => r.id));

    // Without filters: the whole register, paging never applies.
    expect(await set(user.id, { mode: "replace", query: {} })).toEqual({ count: 4, added: 4 });
    expect(await ids(user.id)).toEqual((await list({ limit: "1000" })).rows.map((r) => r.id));
  });

  it("resolves abcClass in the query through the same classification as the list, and no hits copies nothing", async () => {
    const user = await makeUser();
    const [a, b, c] = await Promise.all([makeArticle("ABC-A"), makeArticle("ABC-B"), makeArticle("ABC-C")]);
    abcByArticle.set(a!.id, "A").set(b!.id, "B").set(c!.id, "C");

    expect(await set(user.id, { mode: "replace", query: { abcClass: "A,C" } })).toEqual({ count: 2, added: 2 });
    expect(await ids(user.id)).toEqual([a!.id, c!.id]);

    expect(await set(user.id, { mode: "add", query: { abcClass: "B", search: "nothing-like-this" } })).toEqual({ count: 2, added: 0 });
    expect(await ids(user.id)).toEqual([a!.id, c!.id]);
  });
});

describe("Kopierat — the register's copied=true filter", () => {
  it("lists only the user's copied articles with total following, pages, and combines with search and abcClass", async () => {
    const user = await makeUser();
    const other = await makeUser("other");
    const made = await Promise.all([
      makeArticle("K-1", { name: "Kopierad ett" }),
      makeArticle("K-2", { name: "Kopierad två" }),
      makeArticle("K-3", { name: "Annan tre" }),
      makeArticle("K-4", { name: "Aldrig kopierad" }),
    ]);
    const [k1, k2, k3, k4] = made;
    await set(user.id, { mode: "add", articleIds: [k3!.id, k1!.id, k2!.id] });
    await set(other.id, { mode: "add", articleIds: [k4!.id] });

    const copied = await list({ copied: "true", limit: "50" }, user.id);
    expect(copied.total).toBe(3);
    // The register's order (article number), not the list's.
    expect(copied.rows.map((r) => r.articleNumber)).toEqual(["K-1", "K-2", "K-3"]);

    const page2 = await list({ copied: "true", limit: "2", offset: "2" }, user.id);
    expect([page2.total, page2.rows.map((r) => r.articleNumber)]).toEqual([3, ["K-3"]]);

    const searched = await list({ copied: "true", search: "kopierad", limit: "50" }, user.id);
    expect([searched.total, searched.rows.map((r) => r.articleNumber)]).toEqual([2, ["K-1", "K-2"]]);

    // abcClass ∩ copied: K-3 is an A and copied, K-4 is an A but not copied,
    // K-1 is copied but a B — only K-3 is both.
    abcByArticle.set(k3!.id, "A").set(k4!.id, "A").set(k1!.id, "B");
    const both = await list({ copied: "true", abcClass: "A", limit: "50" }, user.id);
    expect([both.total, both.rows.map((r) => [r.articleNumber, r.abcClass])]).toEqual([1, [["K-3", "A"]]]);
    const none = await list({ copied: "true", abcClass: "C", limit: "50" }, user.id);
    expect(none).toEqual({ rows: [], total: 0 });

    // copied=false and no parameter: the whole register.
    expect((await list({ copied: "false", limit: "50" }, user.id)).total).toBe(4);
    expect((await list({ limit: "50" }, user.id)).total).toBe(4);
  });

  it("answers an empty list — and copied=true without a user — with no rows", async () => {
    const user = await makeUser();
    await makeArticle("E-1");
    expect(await list({ copied: "true" }, user.id)).toEqual({ rows: [], total: 0 });
    expect(await list({ copied: "true" })).toEqual({ rows: [], total: 0 });
  });
});

describe("Kopierat — remove, clear, cascades and isolation", () => {
  it("removes the given ids (unknown ones ignored) and clears the whole list", async () => {
    const user = await makeUser();
    const [a, b, c] = await Promise.all([makeArticle("R-1"), makeArticle("R-2"), makeArticle("R-3")]);
    await set(user.id, { mode: "add", articleIds: [a!.id, b!.id, c!.id] });

    expect(await service.removeCopiedArticles(user.id, { articleIds: [b!.id, crypto.randomUUID()] })).toEqual({ count: 2 });
    expect(await ids(user.id)).toEqual([a!.id, c!.id]);

    expect(await service.clearCopiedArticles(user.id)).toEqual({ count: 0 });
    expect(await service.listCopiedArticles(user.id)).toEqual({ count: 0, articleIds: [] });
  });

  it("is per user: one user's list never shows or changes another's", async () => {
    const [u1, u2] = await Promise.all([makeUser("u1"), makeUser("u2")]);
    const [a, b] = await Promise.all([makeArticle("I-1"), makeArticle("I-2")]);
    await set(u1.id, { mode: "add", articleIds: [a!.id, b!.id] });
    await set(u2.id, { mode: "add", articleIds: [b!.id] });

    await service.clearCopiedArticles(u2.id);
    expect(await ids(u1.id)).toEqual([a!.id, b!.id]);
    await service.removeCopiedArticles(u2.id, { articleIds: [a!.id] });
    expect(await ids(u1.id)).toEqual([a!.id, b!.id]);
    expect((await list({ copied: "true" }, u2.id)).total).toBe(0);
  });

  it("cascades: a deleted article leaves the list, a deleted user takes the list with it", async () => {
    const user = await makeUser();
    const [a, b] = await Promise.all([makeArticle("C-1"), makeArticle("C-2")]);
    await set(user.id, { mode: "add", articleIds: [a!.id, b!.id] });

    await db.delete(articles).where(eq(articles.id, a!.id));
    expect(await ids(user.id)).toEqual([b!.id]);

    await db.delete(users).where(eq(users.id, user.id));
    const left = await db.select().from(userCopiedArticles).where(eq(userCopiedArticles.userId, user.id));
    expect(left).toEqual([]);
  });
});

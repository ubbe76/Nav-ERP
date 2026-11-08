import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { articles, db, permissionGroups } from "@navet/db";
import { COPIED_ARTICLES_MAX } from "@navet/shared";
import { buildApp } from "../src/app.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createAuthService } from "../src/modules/auth/service/auth.service.js";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";

// Kopierat (#28) through the real app: the four routes and their shapes,
// GET /articles/copied beside GET /articles/:id (rejectMalformedIds), the
// register's ?copied=true, the access rule (any menu, not the workshop
// profile), a read-only account writing its own list, the cap's HTTP
// envelope and the zod 400s.

const authService = createAuthService(createAuthRepository(db), "unused", createAuditRepository(db));
const repo = createArticleRepository(db);
const PASSWORD = "correcthorsebattery";
const TRUNCATE = sql`TRUNCATE user_copied_articles, bom_components, stock_transactions, articles, audit_log, user_settings, users CASCADE`;
// Only this file's groups — never TRUNCATE permission_groups (the seeded ones).
const DELETE_GROUPS = sql`DELETE FROM permission_groups WHERE code LIKE 'KOP%'`;

let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  app = buildApp();
  await app.ready();
});

beforeEach(async () => {
  await db.execute(TRUNCATE);
  await db.execute(DELETE_GROUPS);
});

afterAll(async () => {
  await app.close();
  await db.execute(TRUNCATE);
  await db.execute(DELETE_GROUPS);
});

async function login(email: string) {
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PASSWORD } });
  expect(res.statusCode).toBe(200);
  return `session=${res.cookies.find((c) => c.name === "session")!.value}`;
}

async function adminCookie() {
  const email = `admin-${crypto.randomUUID()}@example.com`;
  await authService.createUser({ email, password: PASSWORD, name: "Admin", role: "admin" });
  return login(email);
}

async function userCookie(permissions: string[], opts: { readOnly?: boolean; adminCookie?: string } = {}) {
  const [group] = await db
    .insert(permissionGroups)
    .values({ code: `KOP${crypto.randomUUID().slice(0, 6)}`, name: "Kopierat", permissions })
    .returning();
  const email = `kop-${crypto.randomUUID()}@example.com`;
  if (opts.readOnly) {
    // Endast läsning is set through the admin route, as System → Användare does.
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/users",
      headers: { cookie: opts.adminCookie! },
      payload: { email, password: PASSWORD, name: "Demo", role: "user", permissionGroupId: group!.id, readOnly: true },
    });
    expect(res.statusCode).toBe(201);
  } else {
    await authService.createUser({ email, password: PASSWORD, name: "Användare", role: "user", permissionGroupId: group!.id });
  }
  return login(email);
}

const call = (cookie: string, method: "GET" | "POST" | "DELETE", url: string, payload?: unknown) =>
  app.inject({ method, url: `/api/v1${url}`, headers: { cookie }, ...(payload === undefined ? {} : { payload: payload as never }) });

async function makeArticles(cookie: string, numbers: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const articleNumber of numbers) {
    const res = await call(cookie, "POST", "/articles", { articleNumber, name: `Artikel ${articleNumber}`, type: "purchased" });
    expect(res.statusCode).toBe(201);
    out.push(res.json().id as string);
  }
  return out;
}

async function bulkArticles(n: number): Promise<string[]> {
  const unitId = await repo.getOrCreateDefaultUnitId();
  const ids: string[] = [];
  for (let from = 0; from < n; from += 2000) {
    const batch = Array.from({ length: Math.min(2000, n - from) }, (_, i) => ({
      articleNumber: `BULK-${String(from + i).padStart(5, "0")}`,
      name: `Bulk ${from + i}`,
      type: "purchased" as const,
      unitId,
    }));
    const rows = await db.insert(articles).values(batch).returning({ id: articles.id });
    ids.push(...rows.map((r) => r.id));
  }
  return ids;
}

describe("Kopierat — the routes", () => {
  it("GET /articles/copied is its own route (not /articles/:id), and the four routes answer their shapes", async () => {
    const admin = await adminCookie();
    const cookie = await userCookie(["artiklar"]);
    const [a, b, c] = await makeArticles(admin, ["R-1", "R-2", "R-3"]);

    const empty = await call(cookie, "GET", "/articles/copied");
    expect([empty.statusCode, empty.json()]).toEqual([200, { count: 0, articleIds: [] }]);

    const added = await call(cookie, "POST", "/articles/copied", { mode: "add", articleIds: [c, a] });
    expect([added.statusCode, added.json()]).toEqual([200, { count: 2, added: 2 }]);

    const again = await call(cookie, "POST", "/articles/copied", { mode: "add", articleIds: [a, b] });
    expect([again.statusCode, again.json()]).toEqual([200, { count: 3, added: 1 }]);
    expect((await call(cookie, "GET", "/articles/copied")).json()).toEqual({ count: 3, articleIds: [c, a, b] });

    const byQuery = await call(cookie, "POST", "/articles/copied", { mode: "replace", query: { search: "R-" } });
    expect([byQuery.statusCode, byQuery.json()]).toEqual([200, { count: 3, added: 3 }]);
    expect((await call(cookie, "GET", "/articles/copied")).json().articleIds).toEqual([a, b, c]);

    const removed = await call(cookie, "POST", "/articles/copied/remove", { articleIds: [b] });
    expect([removed.statusCode, removed.json()]).toEqual([200, { count: 2 }]);

    const cleared = await call(cookie, "DELETE", "/articles/copied");
    expect([cleared.statusCode, cleared.json()]).toEqual([200, { count: 0 }]);
    expect((await call(cookie, "GET", "/articles/copied")).json()).toEqual({ count: 0, articleIds: [] });

    // A real id still reaches the card, and a malformed one is still the id guard's 400.
    expect((await call(cookie, "GET", `/articles/${a}`)).statusCode).toBe(200);
    expect((await call(cookie, "GET", "/articles/not-a-uuid")).statusCode).toBe(400);
  });

  it("GET /articles?copied=true lists the session user's list with total, and only theirs", async () => {
    const admin = await adminCookie();
    const one = await userCookie(["artiklar"]);
    const two = await userCookie(["inkop"]);
    const [a, b, c] = await makeArticles(admin, ["L-1", "L-2", "L-3"]);
    await call(one, "POST", "/articles/copied", { mode: "add", articleIds: [c, a] });
    await call(two, "POST", "/articles/copied", { mode: "add", articleIds: [b] });

    const mine = await call(one, "GET", "/articles?copied=true&limit=50");
    expect(mine.statusCode).toBe(200);
    expect([mine.json().total, mine.json().rows.map((r: { articleNumber: string }) => r.articleNumber)]).toEqual([2, ["L-1", "L-3"]]);
    const theirs = await call(two, "GET", "/articles?copied=true&limit=50");
    expect([theirs.json().total, theirs.json().rows.map((r: { articleNumber: string }) => r.articleNumber)]).toEqual([1, ["L-2"]]);
    const paged = await call(one, "GET", "/articles?copied=true&limit=1&offset=1");
    expect([paged.json().total, paged.json().rows.map((r: { articleNumber: string }) => r.articleNumber)]).toEqual([2, ["L-3"]]);
    expect((await call(one, "GET", "/articles?limit=50")).json().total).toBe(3);
  });

  it("refuses more than COPIED_ARTICLES_MAX with 400 copied-articles-too-many, the count and the max", async () => {
    const cookie = await userCookie(["tillverkning"]);
    const bulk = await bulkArticles(COPIED_ARTICLES_MAX + 1);

    const res = await call(cookie, "POST", "/articles/copied", { mode: "replace", articleIds: bulk });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "copied-articles-too-many", count: COPIED_ARTICLES_MAX + 1, max: COPIED_ARTICLES_MAX });
    expect(res.json().error).toContain(String(COPIED_ARTICLES_MAX + 1));
    expect((await call(cookie, "GET", "/articles/copied")).json()).toEqual({ count: 0, articleIds: [] });
  });
});

describe("Kopierat — access", () => {
  it("lets a Tillverkning-only user (no Artiklar menu) read and write the list", async () => {
    const admin = await adminCookie();
    const cookie = await userCookie(["tillverkning"]);
    const [a] = await makeArticles(admin, ["T-1"]);

    expect((await call(cookie, "POST", "/articles/copied", { mode: "add", articleIds: [a] })).statusCode).toBe(200);
    expect((await call(cookie, "GET", "/articles/copied")).json()).toEqual({ count: 1, articleIds: [a] });
    expect((await call(cookie, "POST", "/articles/copied/remove", { articleIds: [a!] })).statusCode).toBe(200);
    expect((await call(cookie, "DELETE", "/articles/copied")).statusCode).toBe(200);
    // Not the Artiklar menu's other writes, though.
    expect((await call(cookie, "POST", "/articles", { articleNumber: "T-2", name: "x", type: "purchased" })).statusCode).toBe(403);
  });

  it("keeps the workshop profile (terminal only) out of all four routes", async () => {
    const admin = await adminCookie();
    const cookie = await userCookie(["terminal"]);
    const [a] = await makeArticles(admin, ["W-1"]);

    for (const [method, url, payload] of [
      ["GET", "/articles/copied", undefined],
      ["POST", "/articles/copied", { mode: "add", articleIds: [a] }],
      ["POST", "/articles/copied/remove", { articleIds: [a] }],
      ["DELETE", "/articles/copied", undefined],
    ] as const) {
      const res = await call(cookie, method, url, payload);
      expect([method, url, res.statusCode, res.json().code]).toEqual([method, url, 403, "forbidden"]);
    }
  });

  it("lets a read-only account keep its own list (readOnlySafe) while every other write stays refused", async () => {
    const admin = await adminCookie();
    const cookie = await userCookie(["artiklar", "tillverkning"], { readOnly: true, adminCookie: admin });
    const [a, b] = await makeArticles(admin, ["RO-1", "RO-2"]);

    const added = await call(cookie, "POST", "/articles/copied", { mode: "add", articleIds: [a, b] });
    expect([added.statusCode, added.json()]).toEqual([200, { count: 2, added: 2 }]);
    expect((await call(cookie, "GET", "/articles?copied=true&limit=50")).json().total).toBe(2);
    expect((await call(cookie, "POST", "/articles/copied/remove", { articleIds: [a] })).json()).toEqual({ count: 1 });
    expect((await call(cookie, "DELETE", "/articles/copied")).json()).toEqual({ count: 0 });

    const refused = await call(cookie, "POST", "/articles", { articleNumber: "RO-3", name: "x", type: "purchased" });
    expect([refused.statusCode, refused.json().code]).toEqual([403, "read-only-account"]);
  });
});

describe("Kopierat — validation", () => {
  it("400s a body with both or neither of articleIds and query, a bad mode, a non-uuid, an empty list and an empty remove", async () => {
    const cookie = await userCookie(["artiklar"]);
    const id = crypto.randomUUID();
    const bad: unknown[] = [
      { mode: "add", articleIds: [id], query: {} },
      { mode: "add" },
      { mode: "append", articleIds: [id] },
      { mode: "add", articleIds: ["not-a-uuid"] },
      { mode: "add", articleIds: [] },
      { mode: "add", query: { type: "unknown" } },
    ];
    for (const payload of bad) {
      const res = await call(cookie, "POST", "/articles/copied", payload);
      expect([JSON.stringify(payload), res.statusCode, res.json().code]).toEqual([JSON.stringify(payload), 400, "validation-failed"]);
    }
    for (const payload of [{}, { articleIds: [] }, { articleIds: ["x"] }]) {
      const res = await call(cookie, "POST", "/articles/copied/remove", payload);
      expect([JSON.stringify(payload), res.statusCode, res.json().code]).toEqual([JSON.stringify(payload), 400, "validation-failed"]);
    }
    expect((await call(cookie, "GET", "/articles?copied=maybe")).statusCode).toBe(400);
  });
});

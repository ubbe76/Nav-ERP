import { createArticleSchema } from "@navet/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { auditLog, costCalculations, db, permissionGroups } from "@navet/db";
import { buildApp } from "../src/app.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createAuthService } from "../src/modules/auth/service/auth.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { testArticleService } from "./helpers/services.js";
import { parsed } from "./helpers/parsed.js";

// Påslag per varugrupp (#16, etapp 1) through the real app: the group's two
// price markups on /article-groups (read office, write Artiklar — the
// register's own rule), the audit entry, the database's range CHECK, and
// Pröva påslag on pre-calculate.

const authService = createAuthService(createAuthRepository(db), "unused", createAuditRepository(db));
const PASSWORD = "correcthorsebattery";
const TRUNCATE = sql`TRUNCATE cost_calculations, bom_components, articles, article_groups, audit_log, user_settings, users CASCADE`;
// Only this file's groups — never TRUNCATE permission_groups (the seeded ones).
const DELETE_GROUPS = sql`DELETE FROM permission_groups WHERE code LIKE 'PAV%'`;

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
  const admin = await authService.createUser({ email, password: PASSWORD, name: "Admin", role: "admin" });
  return { admin, cookie: await login(email) };
}

async function userCookie(permissions: string[]) {
  const [group] = await db
    .insert(permissionGroups)
    .values({ code: `PAV${crypto.randomUUID().slice(0, 6)}`, name: "Påslag", permissions })
    .returning();
  const email = `pav-${crypto.randomUUID()}@example.com`;
  await authService.createUser({ email, password: PASSWORD, name: "Användare", role: "user", permissionGroupId: group!.id });
  return login(email);
}

const call = (cookie: string, method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) =>
  app.inject({ method, url: `/api/v1${url}`, headers: { cookie }, ...(payload === undefined ? {} : { payload: payload as never }) });

describe("varugruppens påslag — /article-groups", () => {
  it("creates, updates and lists the two fields: null inherits, 0 is 0 %, omitted leaves them", async () => {
    const { admin, cookie } = await adminCookie();

    const created = await call(cookie, "POST", "/article-groups", { code: "3", name: "Diskbänkar", generalMarkupPercent: 40 });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ generalMarkupPercent: "40.00", materialMarkupPercent: null });
    const id = created.json().id as string;

    const zeroed = await call(cookie, "PATCH", `/article-groups/${id}`, { code: "3", name: "Diskbänkar", materialMarkupPercent: 0 });
    expect(zeroed.statusCode).toBe(200);
    expect(zeroed.json()).toMatchObject({ generalMarkupPercent: "40.00", materialMarkupPercent: "0.00" });

    // The dialog always sends both: the same values write no audit entry.
    const same = await call(cookie, "PATCH", `/article-groups/${id}`, { code: "3", name: "Diskbänkar", generalMarkupPercent: 40, materialMarkupPercent: 0 });
    expect(same.statusCode).toBe(200);
    // Omitted = unchanged.
    const renamed = await call(cookie, "PATCH", `/article-groups/${id}`, { code: "3", name: "Diskbänkar rostfria" });
    expect(renamed.json()).toMatchObject({ generalMarkupPercent: "40.00", materialMarkupPercent: "0.00" });
    // null = inherit the company's again.
    const cleared = await call(cookie, "PATCH", `/article-groups/${id}`, { code: "3", name: "Diskbänkar rostfria", generalMarkupPercent: null });
    expect(cleared.json()).toMatchObject({ generalMarkupPercent: null, materialMarkupPercent: "0.00" });

    const listed = await call(cookie, "GET", "/article-groups");
    expect(listed.json()).toEqual([expect.objectContaining({ id, generalMarkupPercent: null, materialMarkupPercent: "0.00" })]);

    const entries = await db
      .select({ detail: auditLog.detail, userId: auditLog.userId })
      .from(auditLog)
      .where(and(eq(auditLog.entityType, "article_group"), eq(auditLog.entityId, id), eq(auditLog.action, "markups_changed")))
      .orderBy(auditLog.createdAt, auditLog.id);
    expect(entries).toEqual([
      {
        userId: admin.id,
        detail: { before: { generalMarkupPercent: null, materialMarkupPercent: null }, after: { generalMarkupPercent: 40, materialMarkupPercent: null } },
      },
      {
        userId: admin.id,
        detail: { before: { generalMarkupPercent: 40, materialMarkupPercent: null }, after: { generalMarkupPercent: 40, materialMarkupPercent: 0 } },
      },
      {
        userId: admin.id,
        detail: { before: { generalMarkupPercent: 40, materialMarkupPercent: 0 }, after: { generalMarkupPercent: null, materialMarkupPercent: 0 } },
      },
    ]);
  });

  it("refuses a percentage outside 0–1000 in the API and in the database", async () => {
    const { cookie } = await adminCookie();
    for (const generalMarkupPercent of [-1, 1000.01, "40"]) {
      const res = await call(cookie, "POST", "/article-groups", { code: "4", name: "Bänkar", generalMarkupPercent });
      expect([generalMarkupPercent, res.statusCode, res.json().code]).toEqual([generalMarkupPercent, 400, "validation-failed"]);
    }
    const ok = await call(cookie, "POST", "/article-groups", { code: "4", name: "Bänkar", materialMarkupPercent: 1000 });
    expect(ok.statusCode).toBe(201);
    await expect(db.execute(sql`update article_groups set general_markup_percent = 1000.01`)).rejects.toThrow();
    await expect(db.execute(sql`update article_groups set material_markup_percent = -0.01`)).rejects.toThrow();
  });

  it("reads with office and writes with Artiklar, like the rest of the register", async () => {
    const { cookie } = await adminCookie();
    const id = (await call(cookie, "POST", "/article-groups", { code: "5", name: "Underreden" })).json().id as string;
    const body = { code: "5", name: "Underreden", generalMarkupPercent: 30 };

    const seller = await userCookie(["forsaljning"]);
    expect((await call(seller, "GET", "/article-groups")).statusCode).toBe(200);
    expect((await call(seller, "PATCH", `/article-groups/${id}`, body)).statusCode).toBe(403);

    const articles = await userCookie(["artiklar"]);
    const res = await call(articles, "PATCH", `/article-groups/${id}`, body);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ generalMarkupPercent: "30.00" });
  });
});

describe("Pröva påslag — POST /articles/:id/cost-calculations/pre-calculate", () => {
  it("answers with each price markup's level, saves only on save, and refuses a cost markup with 400", async () => {
    const { cookie } = await adminCookie();
    const group = (await call(cookie, "POST", "/article-groups", { code: "6", name: "Diskar", generalMarkupPercent: 40 })).json();
    const article = await testArticleService.createArticle(parsed(createArticleSchema, {
      articleNumber: `P-${crypto.randomUUID().slice(0, 8)}`,
      name: "Diskbänk",
      type: "manufactured",
      groupId: group.id,
      active: true,
    }));
    const url = `/articles/${article.id}/cost-calculations/pre-calculate`;

    const grouped = await call(cookie, "POST", url, { quantity: 1 });
    expect(grouped.statusCode).toBe(200);
    expect(grouped.json().calculation).toMatchObject({ id: null, generalMarkupPercent: "40.00", generalMarkupLevel: "group", materialMarkupLevel: "company" });

    const tried = await call(cookie, "POST", url, { quantity: 1, markups: { generalMarkupPercent: 35, materialMarkupPercent: 0 } });
    expect(tried.statusCode).toBe(200);
    expect(tried.json().calculation).toMatchObject({
      id: null,
      generalMarkupPercent: "35.00",
      generalMarkupLevel: "trial",
      materialMarkupPercent: "0.00",
      materialMarkupLevel: "trial",
    });
    expect(await db.select().from(costCalculations)).toHaveLength(0);

    const saved = await call(cookie, "POST", url, { quantity: 1, save: true, markups: { generalMarkupPercent: 35 } });
    expect(saved.statusCode).toBe(201);
    expect(saved.json().calculation).toMatchObject({ generalMarkupLevel: "trial", materialMarkupLevel: "company" });
    const detail = await call(cookie, "GET", `/cost-calculations/${saved.json().calculation.id}`);
    expect(detail.json()).toMatchObject({ generalMarkupLevel: "trial", materialMarkupLevel: "company", materialMarkupBase: "0.0000" });

    for (const markups of [{ moPercent: 10 }, { affoPercent: 5 }, { generalMarkupPercent: 1001 }]) {
      const refused = await call(cookie, "POST", url, { quantity: 1, markups });
      expect([markups, refused.statusCode, refused.json().code]).toEqual([markups, 400, "validation-failed"]);
    }
  });
});

// The review of etapp 1: pre-calculate (with save) and apply-sales-price are
// open to Artiklar OR Tillverkning, but setting the article's försäljningspris
// directly needs Artiklar. A tried calculation carries whatever markup its
// author typed, so writing ITS price back takes Artiklar too.
describe("Sätt försäljningspris från en prövad kalkyl — POST /cost-calculations/:id/apply-sales-price", () => {
  it("needs Artiklar for a tried calculation; Tillverkning still applies an ordinary one and the standard cost", async () => {
    const article = await testArticleService.createArticle(parsed(createArticleSchema, {
      articleNumber: `P-${crypto.randomUUID().slice(0, 8)}`,
      name: "Diskbänk",
      type: "manufactured",
      active: true,
    }));
    const url = `/articles/${article.id}/cost-calculations/pre-calculate`;
    const workshop = await userCookie(["tillverkning"]);

    // Tillverkning may still save a trial (harmless: TVK and SVK as usual)…
    const trial = await call(workshop, "POST", url, { quantity: 1, save: true, markups: { generalMarkupPercent: 900 } });
    expect(trial.statusCode).toBe(201);
    const trialId = trial.json().calculation.id as string;
    // …and apply its standard cost, but not its price.
    expect((await call(workshop, "POST", `/cost-calculations/${trialId}/apply-standard-cost`)).statusCode).toBe(200);
    const refused = await call(workshop, "POST", `/cost-calculations/${trialId}/apply-sales-price`);
    expect([refused.statusCode, refused.json().code]).toEqual([403, "forbidden"]);
    // A material-only trial is a trial too.
    const materialTrial = await call(workshop, "POST", url, { quantity: 1, save: true, markups: { materialMarkupPercent: 50 } });
    expect((await call(workshop, "POST", `/cost-calculations/${materialTrial.json().calculation.id}/apply-sales-price`)).statusCode).toBe(403);
    const [unchanged] = await db.execute<{ sales_price: string | null }>(sql`select sales_price from articles where id = ${article.id}`);
    expect(unchanged!.sales_price).toBeNull();

    // An ordinary calculation (the group's and the company's markups) stays open to Tillverkning.
    const ordinary = await call(workshop, "POST", url, { quantity: 1, save: true });
    expect((await call(workshop, "POST", `/cost-calculations/${ordinary.json().calculation.id}/apply-sales-price`)).statusCode).toBe(200);

    // Artiklar (and admin) apply the tried price.
    const articles = await userCookie(["artiklar"]);
    expect((await call(articles, "POST", `/cost-calculations/${trialId}/apply-sales-price`)).statusCode).toBe(200);
    const { cookie: admin } = await adminCookie();
    expect((await call(admin, "POST", `/cost-calculations/${materialTrial.json().calculation.id}/apply-sales-price`)).statusCode).toBe(200);
  });
});

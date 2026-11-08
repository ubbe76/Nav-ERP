import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { articles, costCalculations, db, permissionGroups } from "@navet/db";
import { createArticleSchema, PRE_CALCULATION_BATCH_MAX } from "@navet/shared";
import { buildApp } from "../src/app.js";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createAuthService } from "../src/modules/auth/service/auth.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { testArticleService } from "./helpers/services.js";
import { parsed } from "./helpers/parsed.js";

// Förkalkylera flera (#27) through the real app: the two routes' shapes, the
// zod 400s, the cap's 400 envelope, the access rule (Artiklar or
// Tillverkning, never the workshop profile) and a read-only account —
// allowed the preview, refused the save. The arithmetic is
// pre-calculation-batch.db.test.ts's.

const authService = createAuthService(createAuthRepository(db), "unused", createAuditRepository(db));
const articleRepo = createArticleRepository(db);
const PASSWORD = "correcthorsebattery";
const TRUNCATE = sql`TRUNCATE user_copied_articles, cost_calculations, article_standard_cost_history, article_sales_price_history, bom_components, stock_transactions, articles, audit_log, user_settings, users CASCADE`;
const DELETE_GROUPS = sql`DELETE FROM permission_groups WHERE code LIKE 'FKF%'`;

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
    .values({ code: `FKF${crypto.randomUUID().slice(0, 6)}`, name: "Förkalkylera flera", permissions })
    .returning();
  const email = `fkf-${crypto.randomUUID()}@example.com`;
  if (opts.readOnly) {
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

const post = (cookie: string, url: string, payload: unknown) =>
  app.inject({ method: "POST", url: `/api/v1${url}`, headers: { cookie }, payload: payload as never });

// A manufactured product with 3 × a 100 kr component: TVK/st 300.
async function makeProduct(articleNumber: string) {
  const parent = await testArticleService.createArticle(parsed(createArticleSchema, { articleNumber, name: `Produkt ${articleNumber}`, type: "manufactured" }));
  const component = await testArticleService.createArticle(
    parsed(createArticleSchema, { articleNumber: `${articleNumber}-K`, name: "Komponent", type: "purchased", standardCost: 100 })
  );
  await testArticleService.addBomComponent(parent.id, { componentArticleId: component.id, quantity: 3 });
  return parent;
}

const preview = { selection: { activeOnly: true, type: "manufactured" }, fallbackQuantity: 2 };

describe("Förkalkylera flera — the routes", () => {
  it("answers the preview's and the save's shapes", async () => {
    const cookie = await adminCookie();
    const product = await makeProduct("R-1");

    const res = await post(cookie, "/costing/pre-calculations/batch", preview);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      rows: [
        {
          articleId: product.id,
          articleNumber: "R-1",
          name: "Produkt R-1",
          type: "manufactured",
          quantity: 2,
          quantitySource: "fallback",
          manufacturingCostPerUnit: 300,
          selfCostPerUnit: expect.any(Number),
          salesPricePerUnit: expect.any(Number),
          previous: null,
          change: null,
          currentStandardCost: null,
          currentSalesPrice: null,
          warnings: [],
          error: null,
        },
      ],
    });
    expect(await db.select().from(costCalculations)).toEqual([]);

    const saved = await post(cookie, "/costing/pre-calculations/batch/save", {
      items: [{ articleId: product.id, quantity: 2 }],
      setStandardCost: true,
      setSalesPrice: false,
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({
      saved: [{ articleId: product.id, articleNumber: "R-1", calculationId: expect.any(String), standardCostSet: true, salesPriceSet: false }],
      errors: [],
    });
    const [row] = await db.select().from(articles).where(eq(articles.id, product.id));
    expect(row!.standardCost).toBe("300.0000");
    expect(row!.salesPrice).toBeNull();

    // Now the previous is that calculation and the quantity its own.
    const again = await post(cookie, "/costing/pre-calculations/batch", { ...preview, fallbackQuantity: 9 });
    expect(again.json().rows[0]).toMatchObject({
      quantity: 2,
      quantitySource: "latest",
      previous: { calculationId: saved.json().saved[0].calculationId, quantity: 2, manufacturingCostPerUnit: 300 },
      change: { amount: 0, percent: 0 },
      currentStandardCost: 300,
    });
  });

  it("gives 400 validation-failed on a body that does not parse", async () => {
    const cookie = await adminCookie();
    const bad = [
      { url: "/costing/pre-calculations/batch", payload: { selection: { activeOnly: true } } }, // no fallbackQuantity
      { url: "/costing/pre-calculations/batch", payload: { selection: { activeOnly: true }, fallbackQuantity: 0 } },
      { url: "/costing/pre-calculations/batch", payload: { selection: { copied: true, type: "manufactured" }, fallbackQuantity: 1 } },
      { url: "/costing/pre-calculations/batch", payload: { selection: { activeOnly: true, type: "phantom" }, fallbackQuantity: 1 } },
      { url: "/costing/pre-calculations/batch", payload: { selection: { activeOnly: true }, fallbackQuantity: 1, multiLevel: "true" } },
      { url: "/costing/pre-calculations/batch/save", payload: { items: [] } },
      { url: "/costing/pre-calculations/batch/save", payload: { items: [{ articleId: "not-a-uuid", quantity: 1 }] } },
      { url: "/costing/pre-calculations/batch/save", payload: { items: [{ articleId: crypto.randomUUID(), quantity: 0 }] } },
      {
        url: "/costing/pre-calculations/batch/save",
        payload: { items: Array.from({ length: PRE_CALCULATION_BATCH_MAX + 1 }, () => ({ articleId: crypto.randomUUID(), quantity: 1 })) },
      },
    ];
    for (const attempt of bad) {
      const res = await post(cookie, attempt.url, attempt.payload);
      expect([attempt.url, JSON.stringify(attempt.payload).slice(0, 60), res.statusCode, res.json().code]).toEqual([
        attempt.url,
        JSON.stringify(attempt.payload).slice(0, 60),
        400,
        "validation-failed",
      ]);
    }
  });

  it("answers the cap as 400 pre-calculation-batch-too-large with count and max", async () => {
    const cookie = await adminCookie();
    const unitId = await articleRepo.getOrCreateDefaultUnitId();
    await db.insert(articles).values(
      Array.from({ length: PRE_CALCULATION_BATCH_MAX + 1 }, (_, i) => ({
        articleNumber: `BULK-${String(i).padStart(4, "0")}`,
        name: `Bulk ${i}`,
        type: "purchased" as const,
        unitId,
      }))
    );
    const res = await post(cookie, "/costing/pre-calculations/batch", { selection: { activeOnly: true }, fallbackQuantity: 1 });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      code: "pre-calculation-batch-too-large",
      count: PRE_CALCULATION_BATCH_MAX + 1,
      max: PRE_CALCULATION_BATCH_MAX,
    });
    expect(res.json().error).toContain(`${PRE_CALCULATION_BATCH_MAX + 1} artiklar`);
    // The empty selection is just empty.
    const none = await post(cookie, "/costing/pre-calculations/batch", { selection: { activeOnly: true, type: "service" }, fallbackQuantity: 1 });
    expect(none.json()).toEqual({ rows: [] });
  });

  it("is open to Artiklar and to Tillverkning, closed to the workshop profile and to other menus", async () => {
    const product = await makeProduct("A-1");
    const save = { items: [{ articleId: product.id, quantity: 1 }] };
    for (const permissions of [["artiklar"], ["tillverkning"]]) {
      const cookie = await userCookie(permissions);
      expect((await post(cookie, "/costing/pre-calculations/batch", preview)).statusCode).toBe(200);
      expect((await post(cookie, "/costing/pre-calculations/batch/save", save)).statusCode).toBe(200);
    }
    for (const permissions of [["terminal", "tillverkningsorder_las", "artikeloversikt"], ["inkop"], ["forsaljning", "lager"]]) {
      const cookie = await userCookie(permissions);
      const res = await post(cookie, "/costing/pre-calculations/batch", preview);
      expect([permissions.join(","), res.statusCode]).toEqual([permissions.join(","), 403]);
      const saved = await post(cookie, "/costing/pre-calculations/batch/save", save);
      expect([permissions.join(","), saved.statusCode]).toEqual([permissions.join(","), 403]);
    }
  });

  it("lets a read-only account preview but not save", async () => {
    const admin = await adminCookie();
    const cookie = await userCookie(["artiklar"], { readOnly: true, adminCookie: admin });
    const product = await makeProduct("L-1");
    const res = await post(cookie, "/costing/pre-calculations/batch", { selection: { copied: true }, fallbackQuantity: 1 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ rows: [] });
    const saved = await post(cookie, "/costing/pre-calculations/batch/save", { items: [{ articleId: product.id, quantity: 1 }] });
    expect(saved.statusCode).toBe(403);
    expect(saved.json().code).toBe("read-only-account");
    expect(await db.select().from(costCalculations)).toEqual([]);
  });
});

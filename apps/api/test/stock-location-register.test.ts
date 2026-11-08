import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { sql } from "drizzle-orm";
import { db, permissionGroups, units } from "@navet/db";
import { formatLocationLabelCode, listStockLocationRegisterQuerySchema, type StockLocationRegisterRow } from "@navet/shared";
import { buildApp as buildRealApp } from "../src/app.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createAuthService } from "../src/modules/auth/service/auth.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { stockRoutes } from "../src/modules/stock/routes/stock.routes.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { createStockService } from "../src/modules/stock/service/stock.service.js";

// Lagerplatsregistret (spec 2026-11-06 del 2): GET /stock/locations/register
// and its CSV — search on place, warehouse and etikettkod, the filters, the
// pages and total, and each place's article count and balance per unit
// (one aggregation for the page). Plus the Visa saldon link's
// /stock/balances?locationId=.

const articleService = createArticleService(createArticleRepository(db));
const stockService = createStockService(createStockRepository(db));

const TRUNCATE = sql`TRUNCATE stock_transactions, stock_locations, warehouses, bom_components, articles, audit_log, user_settings, users CASCADE`;
// Only this file's groups — the seeded ones belong to other files.
const DELETE_GROUPS = sql`DELETE FROM permission_groups WHERE code LIKE 'LPR%'`;

let stId: string;
let kgId: string;

beforeEach(async () => {
  await db.execute(TRUNCATE);
  await db.execute(DELETE_GROUPS);
  // Another file may have emptied the units register.
  await db.insert(units).values([{ code: "st", name: "Styck" }, { code: "kg", name: "Kilogram" }]).onConflictDoNothing();
  const rows = await db.select().from(units);
  stId = rows.find((r) => r.code === "st")!.id;
  kgId = rows.find((r) => r.code === "kg")!.id;
});

afterAll(async () => {
  await db.execute(TRUNCATE);
  await db.execute(DELETE_GROUPS);
});

function buildApp() {
  const app = Fastify();
  app.addHook("preHandler", async (req) => {
    (req as unknown as { user: unknown }).user = { id: crypto.randomUUID(), role: "admin", permissions: [] };
  });
  app.register(stockRoutes, { service: stockService, valuation: {} as never, counts: {} as never });
  return app;
}

type Page = { rows: StockLocationRegisterRow[]; total: number };

async function register(app: ReturnType<typeof buildApp>, query = ""): Promise<Page> {
  const res = await app.inject({ method: "GET", url: `/stock/locations/register${query}` });
  expect(res.statusCode).toBe(200);
  return res.json();
}
const names = (page: Page) => page.rows.map((r) => `${r.warehouseName}/${r.name}`);

// Huvudlager: A1, A2 (spärrad), B1 (inaktiv, tillfällig); Reservlager: R1.
// Articles live on A1 as Lagerplats, so no *** is created.
async function fixture() {
  const main = await stockService.createWarehouse({ name: "Huvudlager", active: true });
  const reserve = await stockService.createWarehouse({ name: "Reservlager", active: true });
  const a1 = await stockService.createLocation({ warehouseId: main!.id, name: "A1", active: true });
  const a2 = await stockService.createLocation({ warehouseId: main!.id, name: "A2", active: true, blocked: true, blockedNote: "Karantän" });
  const b1 = await stockService.createLocation({ warehouseId: main!.id, name: "B1", active: false, fixed: false });
  const r1 = await stockService.createLocation({ warehouseId: reserve!.id, name: "R1", active: true });
  const article = (articleNumber: string, unitId: string) =>
    articleService.createArticle({ articleNumber, name: articleNumber, type: "purchased", unitId, active: true, defaultLocationId: a1.id } as never);
  const stock = (articleId: string, locationId: string, quantityDelta: number) =>
    stockService.recordTransaction({ articleId, locationId, quantityDelta, transactionType: "inventory_adjustment" });
  return { main, reserve, a1, a2, b1, r1, article, stock };
}

describe("GET /stock/locations/register — search, filters, pages", () => {
  it("lists the active places by default, sorted on warehouse, place and id, with the place's fields", async () => {
    const app = buildApp();
    const { a2 } = await fixture();

    const page = await register(app);
    expect(names(page)).toEqual(["Huvudlager/A1", "Huvudlager/A2", "Reservlager/R1"]);
    expect(page.total).toBe(3);
    expect(page.rows.find((r) => r.id === a2.id)).toEqual({
      id: a2.id,
      warehouseId: a2.warehouseId,
      warehouseName: "Huvudlager",
      name: "A2",
      labelCode: formatLocationLabelCode(a2.labelNumber),
      active: true,
      fixed: true,
      blocked: true,
      blockedAt: expect.any(String),
      blockedNote: "Karantän",
      articleCount: 0,
      balances: [],
    });
  });

  it("searches the place's name, the warehouse's name and the etikettkod (LP0042)", async () => {
    const app = buildApp();
    const { r1, b1 } = await fixture();

    expect(names(await register(app, "?search=a1"))).toEqual(["Huvudlager/A1"]);
    expect(names(await register(app, "?search=reserv"))).toEqual(["Reservlager/R1"]);
    const code = formatLocationLabelCode(r1.labelNumber);
    expect(names(await register(app, `?search=${code}`))).toEqual(["Reservlager/R1"]);
    // A scanner may send it in lower case.
    expect(names(await register(app, `?search=${code.toLowerCase()}`))).toEqual(["Reservlager/R1"]);
    // The status filter still applies to a code: B1 is inactive.
    const inactiveCode = formatLocationLabelCode(b1.labelNumber);
    expect((await register(app, `?search=${inactiveCode}`)).total).toBe(0);
    expect(names(await register(app, `?search=${inactiveCode}&status=all`))).toEqual(["Huvudlager/B1"]);
    // ILIKE wildcards are literal.
    expect((await register(app, "?search=%25")).total).toBe(0);
  });

  it("filters on warehouse, status and spärr, and total follows the filter", async () => {
    const app = buildApp();
    const { reserve } = await fixture();

    expect(names(await register(app, `?warehouseId=${reserve!.id}`))).toEqual(["Reservlager/R1"]);
    expect(names(await register(app, "?status=inactive"))).toEqual(["Huvudlager/B1"]);
    const all = await register(app, "?status=all");
    expect([names(all), all.total]).toEqual([["Huvudlager/A1", "Huvudlager/A2", "Huvudlager/B1", "Reservlager/R1"], 4]);
    const blocked = await register(app, "?blocked=true");
    expect([names(blocked), blocked.total]).toEqual([["Huvudlager/A2"], 1]);
    const open = await register(app, "?blocked=false&status=all");
    expect([names(open), open.total]).toEqual([["Huvudlager/A1", "Huvudlager/B1", "Reservlager/R1"], 3]);
  });

  it("pages with limit/offset while total counts every match", async () => {
    const app = buildApp();
    await fixture();

    const first = await register(app, "?status=all&limit=3&offset=0");
    const second = await register(app, "?status=all&limit=3&offset=3");
    expect([names(first), first.total]).toEqual([["Huvudlager/A1", "Huvudlager/A2", "Huvudlager/B1"], 4]);
    expect([names(second), second.total]).toEqual([["Reservlager/R1"], 4]);
    expect((await register(app, "?status=all&offset=10")).rows).toEqual([]);
  });

  it("validates the query: status defaults to active, blocked is a \"true\"/\"false\" string", () => {
    const parsed = listStockLocationRegisterQuerySchema.parse({});
    expect([parsed.status, parsed.blocked, parsed.limit, parsed.offset]).toEqual(["active", undefined, 50, 0]);
    expect(listStockLocationRegisterQuerySchema.parse({ blocked: "false" }).blocked).toBe(false);
    expect(listStockLocationRegisterQuerySchema.parse({ blocked: "true" }).blocked).toBe(true);
    expect(listStockLocationRegisterQuerySchema.safeParse({ blocked: "yes" }).success).toBe(false);
    expect(listStockLocationRegisterQuerySchema.safeParse({ status: "deleted" }).success).toBe(false);
    expect(listStockLocationRegisterQuerySchema.safeParse({ warehouseId: "x" }).success).toBe(false);
  });
});

describe("GET /stock/locations/register — articles and balance per place", () => {
  it("sums per unit, counts articles not netting to 0, includes a negative balance", async () => {
    const app = buildApp();
    const { a1, a2, r1, article, stock } = await fixture();
    const [p1, p2, p3, k1, k2] = [
      await article("P-1", stId),
      await article("P-2", stId),
      await article("P-3", stId),
      await article("K-1", kgId),
      await article("K-2", kgId),
    ];
    // A1: 100 + 20 st, 30 + 5.5 kg; P-3 nets to 0 (not counted).
    await stock(p1.id, a1.id, 100);
    await stock(p2.id, a1.id, 20);
    await stock(p3.id, a1.id, 4);
    await stock(p3.id, a1.id, -4);
    await stock(k1.id, a1.id, 30);
    await stock(k2.id, a1.id, 5.5);
    // A2 (spärrad): physical, like Saldon — 7 st.
    await stock(p1.id, a2.id, 7);
    // R1: a negative balance counts and sums: 10 − 3 = 7 st over two articles.
    await stock(p1.id, r1.id, 10);
    await stock(p2.id, r1.id, -3);

    const page = await register(app);
    const byName = new Map(page.rows.map((r) => [r.name, r]));
    expect(byName.get("A1")).toMatchObject({
      articleCount: 4,
      balances: [
        { unitCode: "kg", quantity: "35.5000" },
        { unitCode: "st", quantity: "120.0000" },
      ],
    });
    expect(byName.get("A2")).toMatchObject({ articleCount: 1, balances: [{ unitCode: "st", quantity: "7.0000" }] });
    expect(byName.get("R1")).toMatchObject({ articleCount: 2, balances: [{ unitCode: "st", quantity: "7.0000" }] });

    // An emptied place lists with nothing.
    await stock(p1.id, a2.id, -7);
    const after = await register(app, "?blocked=true");
    expect(after.rows[0]).toMatchObject({ name: "A2", articleCount: 0, balances: [] });
  });

  it("only aggregates the page's places", async () => {
    const app = buildApp();
    const { a1, r1, article, stock } = await fixture();
    const p1 = await article("P-1", stId);
    await stock(p1.id, a1.id, 2);
    await stock(p1.id, r1.id, 9);

    const page = await register(app, "?limit=1&offset=2");
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]).toMatchObject({ name: "R1", articleCount: 1, balances: [{ unitCode: "st", quantity: "9.0000" }] });
  });
});

describe("GET /stock/locations/register/csv", () => {
  it("exports the filtered places with the register's columns, numbers in the Swedish format", async () => {
    const app = buildApp();
    const { a1, a2, r1, article, stock } = await fixture();
    const [p1, k1] = [await article("P-1", stId), await article("K-1", kgId)];
    await stock(p1.id, a1.id, 120);
    await stock(k1.id, a1.id, 35.5);
    await stock(p1.id, r1.id, -3);

    const res = await app.inject({ method: "GET", url: "/stock/locations/register/csv?limit=1&offset=1" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toMatch(/lagerplatser-\d{4}-\d{2}-\d{2}\.csv/);
    const lines = res.body.replace(/^﻿/, "").trimEnd().split("\r\n");
    expect(lines[0]).toBe("Lager;Lagerplats;Etikettkod;Fast;Spärrad;Spärrad sedan;Anteckning;Artiklar;Saldo;Status");
    // Pagination is stripped — the export covers every active place.
    expect(lines).toHaveLength(4);
    expect(lines[1]).toBe(`Huvudlager;A1;${formatLocationLabelCode(a1.labelNumber)};Ja;Nej;;;2;35,5 kg · 120 st;Aktiv`);
    expect(lines[2]).toMatch(
      new RegExp(`^Huvudlager;A2;${formatLocationLabelCode(a2.labelNumber)};Ja;Ja;\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2};Karantän;0;;Aktiv$`)
    );
    // A negative balance leads the text cell — the CSV-injection guard quotes it as text.
    expect(lines[3]).toBe(`Reservlager;R1;${formatLocationLabelCode(r1.labelNumber)};Ja;Nej;;;1;'-3 st;Aktiv`);

    const inactive = await app.inject({ method: "GET", url: "/stock/locations/register/csv?status=inactive" });
    const inactiveLines = inactive.body.replace(/^﻿/, "").trimEnd().split("\r\n");
    expect(inactiveLines.slice(1)).toEqual([expect.stringMatching(/^Huvudlager;B1;LP\d{4,};Nej;Nej;;;0;;Inaktiv$/)]);
  });
});

describe("GET /stock/balances?locationId= — the register's Visa saldon", () => {
  it("lists only that place's balances", async () => {
    const app = buildApp();
    const { a1, r1, article, stock } = await fixture();
    const [p1, p2] = [await article("P-1", stId), await article("P-2", stId)];
    await stock(p1.id, a1.id, 5);
    await stock(p2.id, a1.id, 2);
    await stock(p1.id, r1.id, 9);

    const res = await app.inject({ method: "GET", url: `/stock/balances?locationId=${r1.id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(1);
    expect(res.json().rows.map((r: { articleNumber: string; locationId: string; quantityOnHand: string }) => [r.articleNumber, r.locationId, r.quantityOnHand])).toEqual([
      ["P-1", r1.id, "9.0000"],
    ]);
  });
});

// Through the real app: the module's read rule (office) — no write route is new.
describe("Lagerplatsregistret — access", () => {
  const authService = createAuthService(createAuthRepository(db), "unused", createAuditRepository(db));
  const PASSWORD = "correcthorsebattery";
  let app: ReturnType<typeof buildRealApp>;

  beforeAll(async () => {
    app = buildRealApp();
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  async function userCookie(permissions: string[], readOnly = false) {
    const [group] = await db
      .insert(permissionGroups)
      .values({ code: `LPR${crypto.randomUUID().slice(0, 6)}`, name: "Register", permissions })
      .returning();
    const email = `register-${crypto.randomUUID()}@example.com`;
    await authService.createUser({ email, password: PASSWORD, name: "Användare", role: "user", permissionGroupId: group!.id, readOnly });
    const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PASSWORD } });
    expect(res.statusCode).toBe(200);
    return `session=${res.cookies.find((c) => c.name === "session")!.value}`;
  }
  const get = (cookie: string, url: string) => app.inject({ method: "GET", url: `/api/v1${url}`, headers: { cookie } });

  it("reads with office (also without lager and for a read-only account), refuses the terminal alone", async () => {
    await fixture();

    const buyer = await userCookie(["inkop"]);
    const listed = await get(buyer, "/stock/locations/register");
    expect([listed.statusCode, listed.json().total]).toEqual([200, 3]);
    expect((await get(buyer, "/stock/locations/register/csv")).statusCode).toBe(200);

    const readOnly = await userCookie(["lager"], true);
    expect((await get(readOnly, "/stock/locations/register?status=all")).json().total).toBe(4);

    const terminal = await userCookie(["terminal"]);
    expect((await get(terminal, "/stock/locations/register")).statusCode).toBe(403);
    expect((await get(terminal, "/stock/locations/register/csv")).statusCode).toBe(403);

    // A bad filter is a 400, not a 500.
    const bad = await get(buyer, "/stock/locations/register?blocked=yes");
    expect(bad.statusCode).toBe(400);
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type InjectOptions } from "fastify";
import { sql } from "drizzle-orm";
import { db, permissionGroups } from "@navet/db";
import { buildApp as buildRealApp } from "../src/app.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createAuthService } from "../src/modules/auth/service/auth.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { deliverBatchSchema, listStockBalancesQuerySchema, createArticleSchema, createStockLocationSchema } from "@navet/shared";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { stockRoutes } from "../src/modules/stock/routes/stock.routes.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { createStockService } from "../src/modules/stock/service/stock.service.js";
import { parsed } from "./helpers/parsed.js";

// Fasta lagerplatser (0179) on the location routes, and the balances read
// the Utleverans page uses for its per-row location pickers.

const articleService = createArticleService(createArticleRepository(db));
const stockService = createStockService(createStockRepository(db));

const TRUNCATE = sql`TRUNCATE stock_transactions, stock_locations, warehouses, bom_components, articles, audit_log, user_settings, users CASCADE`;
// Only this file's groups — the seeded ones belong to other files.
const DELETE_GROUPS = sql`DELETE FROM permission_groups WHERE code LIKE 'SPR%'`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
  await db.execute(DELETE_GROUPS);
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

describe("/stock/locations — fixed", () => {
  it("creates a fixed location by default, honours fixed: false, lists and patches the flag", async () => {
    const app = buildApp();
    const warehouse = await stockService.createWarehouse({ name: "Huvudlager", active: true });

    const fixed = await app.inject({ method: "POST", url: "/stock/locations", payload: { warehouseId: warehouse!.id, name: "A1" } });
    expect(fixed.statusCode).toBe(201);
    expect(fixed.json()).toMatchObject({ name: "A1", active: true, fixed: true });

    const temporary = await app.inject({
      method: "POST",
      url: "/stock/locations",
      payload: { warehouseId: warehouse!.id, name: "TMP", fixed: false },
    });
    expect(temporary.json()).toMatchObject({ name: "TMP", fixed: false });

    const list = await app.inject({ method: "GET", url: "/stock/locations" });
    expect(list.json().map((l: { name: string; fixed: boolean }) => [l.name, l.fixed])).toEqual([
      ["A1", true],
      ["TMP", false],
    ]);

    const patched = await app.inject({ method: "PATCH", url: `/stock/locations/${fixed.json().id}`, payload: { fixed: false } });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ id: fixed.json().id, fixed: false, active: true });
  });
});

describe("GET /stock/balances?articleIds=", () => {
  it("answers with every listed article's locations and balances in one call", async () => {
    const app = buildApp();
    const warehouse = await stockService.createWarehouse({ name: "Huvudlager", active: true });
    const a1 = await stockService.createLocation(parsed(createStockLocationSchema, { warehouseId: warehouse!.id, name: "A1", active: true }));
    const b2 = await stockService.createLocation(parsed(createStockLocationSchema, { warehouseId: warehouse!.id, name: "B2", active: true }));
    const make = (n: string) => articleService.createArticle(parsed(createArticleSchema, { articleNumber: n, name: n, type: "purchased", active: true }));
    const [x, y, z] = [await make("X-1"), await make("Y-1"), await make("Z-1")];
    const stock = (articleId: string, locationId: string, quantityDelta: number) =>
      stockService.recordTransaction({ articleId, locationId, quantityDelta, transactionType: "inventory_adjustment" });
    await stock(x.id, a1.id, 5);
    await stock(x.id, b2.id, 7);
    await stock(y.id, b2.id, 3);
    await stock(z.id, a1.id, 9);

    const res = await app.inject({ method: "GET", url: `/stock/balances?articleIds=${x.id},${y.id}&limit=1000` });
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(3);
    expect(
      res.json().rows.map((r: { articleNumber: string; locationId: string; warehouseName: string; locationName: string; quantityOnHand: string }) => [
        r.articleNumber,
        r.locationId,
        r.warehouseName,
        r.locationName,
        r.quantityOnHand,
      ])
    ).toEqual([
      ["X-1", a1.id, "Huvudlager", "A1", "5.0000"],
      ["X-1", b2.id, "Huvudlager", "B2", "7.0000"],
      ["Y-1", b2.id, "Huvudlager", "B2", "3.0000"],
    ]);
    // The balance is in the base unit, so Utleverans can print it.
    expect(res.json().rows.every((r: { unitCode: string }) => r.unitCode === "st")).toBe(true);
  });

  it("validates the list: uuids only, at most 200, empty = no filter", () => {
    expect(listStockBalancesQuerySchema.safeParse({ articleIds: "nope" }).success).toBe(false);
    expect(listStockBalancesQuerySchema.parse({}).articleIds).toBeUndefined();
    const id = "11111111-1111-4111-8111-111111111111";
    expect(listStockBalancesQuerySchema.parse({ articleIds: `${id}, ${id}` }).articleIds).toEqual([id, id]);
    expect(listStockBalancesQuerySchema.safeParse({ articleIds: Array(201).fill(id).join(",") }).success).toBe(false);
  });
});

describe("deliverBatchSchema — rows[].locationId", () => {
  it("keeps a row's own location and leaves it out when not sent", () => {
    const rowId = "22222222-2222-4222-8222-222222222222";
    const locationId = "33333333-3333-4333-8333-333333333333";
    const parsed = deliverBatchSchema.parse({ rows: [{ rowId, quantity: "2", locationId }, { rowId, quantity: 1 }] });
    expect(parsed).toEqual({ rows: [{ rowId, quantity: 2, locationId }, { rowId, quantity: 1 }] });
    expect(deliverBatchSchema.safeParse({ rows: [{ rowId, quantity: 1, locationId: "x" }] }).success).toBe(false);
  });
});

// Spärrade lagerplatser (0185) through the real app: the routes' shapes and
// codes, the module's write rule (lager), Endast läsning, and the readers'
// new fields (GET /stock/locations, /stock/balances?blocked=, the CSV).
describe("Spärra / Släpp spärr — routes", () => {
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

  async function login(email: string) {
    const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PASSWORD } });
    expect(res.statusCode).toBe(200);
    return `session=${res.cookies.find((c) => c.name === "session")!.value}`;
  }
  async function userCookie(permissions: string[], readOnly = false) {
    const [group] = await db
      .insert(permissionGroups)
      .values({ code: `SPR${crypto.randomUUID().slice(0, 6)}`, name: "Spärr", permissions })
      .returning();
    const email = `sparr-${crypto.randomUUID()}@example.com`;
    await authService.createUser({ email, password: PASSWORD, name: "Användare", role: "user", permissionGroupId: group!.id, readOnly });
    return login(email);
  }
  const post = (cookie: string, url: string, payload?: InjectOptions["payload"]) =>
    app.inject({ method: "POST", url: `/api/v1${url}`, headers: { cookie }, ...(payload === undefined ? {} : { payload }) });
  const get = (cookie: string, url: string) => app.inject({ method: "GET", url: `/api/v1${url}`, headers: { cookie } });

  it("blocks and unblocks with lager, answers 404/409 with codes, and lists the flags", async () => {
    const cookie = await userCookie(["lager"]);
    const warehouse = await stockService.createWarehouse({ name: "Huvudlager", active: true });
    const k = await stockService.createLocation(parsed(createStockLocationSchema, { warehouseId: warehouse!.id, name: "K1", active: true }));
    const x = await articleService.createArticle(parsed(createArticleSchema, { articleNumber: "X-1", name: "X-1", type: "purchased", active: true, defaultLocationId: k.id }));
    await stockService.recordTransaction({ articleId: x.id, locationId: k.id, quantityDelta: 3, transactionType: "inventory_adjustment" });

    const blocked = await post(cookie, `/stock/locations/${k.id}/block`, { note: "  Karantän  " });
    expect(blocked.statusCode).toBe(200);
    expect(blocked.json()).toMatchObject({
      location: { id: k.id, name: "K1", warehouseName: "Huvudlager", blocked: true, blockedNote: "Karantän", labelCode: expect.any(String) },
      articlesWithStock: 1,
      defaultForArticles: 1,
    });
    const again = await post(cookie, `/stock/locations/${k.id}/block`, {});
    expect([again.statusCode, again.json().code]).toEqual([409, "stock-location-already-blocked"]);
    const unknown = await post(cookie, `/stock/locations/${crypto.randomUUID()}/block`);
    expect([unknown.statusCode, unknown.json().code]).toEqual([404, "stock-location-not-found"]);

    const listed = (await get(cookie, "/stock/locations")).json().find((l: { id: string }) => l.id === k.id);
    expect(listed).toMatchObject({ blocked: true, blockedNote: "Karantän", blockedAt: expect.any(String) });

    const onlyBlocked = (await get(cookie, "/stock/balances?blocked=true")).json();
    expect([onlyBlocked.total, onlyBlocked.rows[0].locationBlocked]).toEqual([1, true]);
    expect((await get(cookie, "/stock/balances?blocked=false")).json().total).toBe(0);
    const csv = (await get(cookie, "/stock/balances/csv")).body;
    expect(csv).toContain("Spärrad");
    expect(csv).toContain("Ja");

    const note = await app.inject({ method: "PATCH", url: `/api/v1/stock/locations/${k.id}`, headers: { cookie }, payload: { blockedNote: "" } });
    expect([note.statusCode, note.json().blockedNote]).toEqual([200, null]);

    const released = await post(cookie, `/stock/locations/${k.id}/unblock`);
    expect([released.statusCode, released.json().location.blocked]).toEqual([200, false]);
    const notBlocked = await post(cookie, `/stock/locations/${k.id}/unblock`);
    expect([notBlocked.statusCode, notBlocked.json().code]).toEqual([409, "stock-location-not-blocked"]);
    const noteOnOpen = await app.inject({ method: "PATCH", url: `/api/v1/stock/locations/${k.id}`, headers: { cookie }, payload: { blockedNote: "x" } });
    expect([noteOnOpen.statusCode, noteOnOpen.json().code]).toEqual([409, "stock-location-not-blocked"]);

    // *** can never be blocked; a Karantän can be created blocked.
    const created = await post(cookie, "/stock/locations", { warehouseId: warehouse!.id, name: "Karantän", blocked: true, blockedNote: "Inkommande" });
    expect([created.statusCode, created.json().blocked, created.json().blockedNote]).toEqual([201, true, "Inkommande"]);
    const noteWithoutBlock = await post(cookie, "/stock/locations", { warehouseId: warehouse!.id, name: "B2", blockedNote: "x" });
    expect(noteWithoutBlock.statusCode).toBe(400);
    const star = await post(cookie, "/stock/locations", { warehouseId: warehouse!.id, name: "***", blocked: true });
    expect([star.statusCode, star.json().code]).toEqual([409, "stock-location-name-reserved"]);
  });

  it("refuses without lager (403) and for a read-only account (403 read-only-account)", async () => {
    const warehouse = await stockService.createWarehouse({ name: "Huvudlager", active: true });
    const k = await stockService.createLocation(parsed(createStockLocationSchema, { warehouseId: warehouse!.id, name: "K1", active: true }));

    const buyer = await userCookie(["inkop"]);
    expect((await post(buyer, `/stock/locations/${k.id}/block`)).statusCode).toBe(403);
    expect((await post(buyer, `/stock/locations/${k.id}/unblock`)).statusCode).toBe(403);
    // Reading is office.
    expect((await get(buyer, "/stock/locations")).statusCode).toBe(200);

    const readOnly = await userCookie(["lager"], true);
    const refused = await post(readOnly, `/stock/locations/${k.id}/block`);
    expect([refused.statusCode, refused.json().code]).toEqual([403, "read-only-account"]);
    expect((await stockService.listLocations()).find((l) => l.id === k.id)!.blocked).toBe(false);
  });
});

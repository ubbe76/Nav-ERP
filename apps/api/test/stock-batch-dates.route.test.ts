import { createArticleSchema, createStockLocationSchema, updateStockBatchSchema, updateSystemSettingsSchema } from "@navet/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { auditLog, db, permissionGroups, stockBatches, stockTransactions, systemSettings } from "@navet/db";
import { buildApp } from "../src/app.js";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createAuthService } from "../src/modules/auth/service/auth.service.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { BATCH_TRACKING_ENABLED_KEY } from "../src/modules/stock/service/batch-tracking.js";
import { createStockService } from "../src/modules/stock/service/stock.service.js";
import { ALERT_BATCH_EXPIRY_DAYS_KEY } from "../src/modules/system/service/alert-settings.js";
import { addDays, stockholmToday } from "../src/modules/system/service/delivery-days.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { parsed } from "./helpers/parsed.js";
import { testSystemService } from "./helpers/services.js";

// Spårbarhet etapp 2, steg 2 through the real app: PATCH /stock/batches/:id
// (the batch's utgångsdatum, Batchdatum and number — the module's write
// rule, logged), the register's dates and filter, the batch choices' dates,
// the inleverans field and the setting Batcher som går ut inom (dagar).

const articleService = createArticleService(createArticleRepository(db));
const stockService = createStockService(createStockRepository(db));
const authService = createAuthService(createAuthRepository(db), "unused", createAuditRepository(db));

const TRUNCATE = sql`TRUNCATE stock_transactions, stock_locations, warehouses, bom_components, articles, audit_log, user_settings, users CASCADE`;
const DELETE_GROUPS = sql`DELETE FROM permission_groups WHERE code LIKE 'BDT%'`;
const resetSettings = async () => {
  await db.delete(systemSettings).where(eq(systemSettings.key, BATCH_TRACKING_ENABLED_KEY));
  await db.delete(systemSettings).where(eq(systemSettings.key, ALERT_BATCH_EXPIRY_DAYS_KEY));
};

const PASSWORD = "ett-tillräckligt-långt-lösenord";
let app: ReturnType<typeof buildApp>;
let admin: string;
let locationId: string;

const call = (cookie: string, method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: { cookie }, ...(payload === undefined ? {} : { payload: payload as never }) });
const asAdmin = (method: string, url: string, payload?: unknown) => call(admin, method, url, payload);

async function login(email: string) {
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PASSWORD } });
  expect(res.statusCode).toBe(200);
  return res.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}
async function userCookie(permissions: string[], readOnly = false) {
  const [group] = await db.insert(permissionGroups).values({ code: `BDT${crypto.randomUUID().slice(0, 6)}`, name: "Batchdatum", permissions }).returning();
  const email = `bdt-${crypto.randomUUID()}@example.com`;
  await authService.createUser({ email, password: PASSWORD, name: "Användare", role: "user", permissionGroupId: group!.id, readOnly });
  return login(email);
}

beforeAll(async () => {
  app = buildApp();
  await app.ready();
});
beforeEach(async () => {
  await db.execute(TRUNCATE);
  await db.execute(DELETE_GROUPS);
  await resetSettings();
  await testSystemService.updateSettings(parsed(updateSystemSettingsSchema, { batchTrackingEnabled: true }));
  await app.inject({ method: "POST", url: "/api/v1/auth/register", payload: { email: "admin@example.com", password: PASSWORD, name: "Admin", setupCode: app.setup.code.code } });
  admin = await login("admin@example.com");
  const warehouse = await stockService.createWarehouse({ name: "Huvudlager", active: true });
  locationId = (await stockService.createLocation(parsed(createStockLocationSchema, { warehouseId: warehouse!.id, name: "A1", active: true })))!.id;
});
afterAll(async () => {
  await app.close();
  await db.execute(TRUNCATE);
  await db.execute(DELETE_GROUPS);
  await resetSettings();
});

let n = 0;
async function makeBatch(batchNumber: string, quantity = 5, articleId?: string) {
  const id =
    articleId ??
    (await articleService.createArticle(parsed(createArticleSchema, { articleNumber: `BD-${++n}-${crypto.randomUUID().slice(0, 6)}`, name: "Plåt", type: "purchased", active: true, tracking: "batch" }))).id;
  await stockService.recordTransaction({ articleId: id, locationId, quantityDelta: quantity, transactionType: "inventory_adjustment", batchNumber });
  const [row] = await db.select().from(stockBatches).where(eq(stockBatches.batchNumber, batchNumber));
  return { articleId: id, batchId: row!.id };
}

describe("PATCH /stock/batches/:id", () => {
  it("sets, changes and clears the dates; answers the batch; logs what changed — and only then", async () => {
    const { articleId, batchId } = await makeBatch("L-1");
    const set = await asAdmin("PATCH", `/stock/batches/${batchId}`, { expiresOn: "2027-03-01", batchDate: "2026-01-15" });
    expect(set.statusCode).toBe(200);
    expect(set.json()).toEqual({ id: batchId, articleId, batchNumber: "L-1", expiresOn: "2027-03-01", batchDate: "2026-01-15" });
    // Only one field: the other stays. null clears.
    expect((await asAdmin("PATCH", `/stock/batches/${batchId}`, { expiresOn: "2027-04-01" })).json()).toMatchObject({ expiresOn: "2027-04-01", batchDate: "2026-01-15" });
    expect((await asAdmin("PATCH", `/stock/batches/${batchId}`, { batchDate: null })).json()).toMatchObject({ expiresOn: "2027-04-01", batchDate: null });
    // The same values again: 200, nothing logged.
    expect((await asAdmin("PATCH", `/stock/batches/${batchId}`, { expiresOn: "2027-04-01" })).statusCode).toBe(200);

    const log = await db.select().from(auditLog).where(eq(auditLog.entityId, batchId)).orderBy(auditLog.createdAt);
    expect(log.map((l) => [l.entityType, l.action, l.detail])).toEqual([
      ["stock_batch", "updated", { articleId, before: { batchNumber: "L-1", expiresOn: null, batchDate: null }, after: { batchNumber: "L-1", expiresOn: "2027-03-01", batchDate: "2026-01-15" } }],
      ["stock_batch", "updated", { articleId, before: { batchNumber: "L-1", expiresOn: "2027-03-01", batchDate: "2026-01-15" }, after: { batchNumber: "L-1", expiresOn: "2027-04-01", batchDate: "2026-01-15" } }],
      ["stock_batch", "updated", { articleId, before: { batchNumber: "L-1", expiresOn: "2027-04-01", batchDate: "2026-01-15" }, after: { batchNumber: "L-1", expiresOn: "2027-04-01", batchDate: null } }],
    ]);
    expect(log.every((l) => l.userId !== null)).toBe(true);
    // The stock log is untouched: the batch row is not part of it.
    expect(await db.select().from(stockTransactions)).toHaveLength(1);
  });

  it("corrects a mistyped number: trimmed, unique per article whatever the case, never the reserved name", async () => {
    const { articleId, batchId } = await makeBatch("L-1");
    await makeBatch("L-2", 1, articleId);
    const other = await makeBatch("ANNAN");

    expect((await asAdmin("PATCH", `/stock/batches/${batchId}`, { batchNumber: "  L-1A " })).json().batchNumber).toBe("L-1A");
    // Only the case: the same batch, allowed.
    expect((await asAdmin("PATCH", `/stock/batches/${batchId}`, { batchNumber: "l-1a" })).json().batchNumber).toBe("l-1a");
    const taken = await asAdmin("PATCH", `/stock/batches/${batchId}`, { batchNumber: "l-2" });
    expect([taken.statusCode, taken.json().code]).toEqual([409, "duplicate-batch-number"]);
    const reserved = await asAdmin("PATCH", `/stock/batches/${batchId}`, { batchNumber: "OKÄND" });
    expect([reserved.statusCode, reserved.json().code]).toEqual([400, "batch-number-reserved"]);
    // The number is unique per ARTICLE: another article's number is free here.
    expect((await asAdmin("PATCH", `/stock/batches/${other.batchId}`, { batchNumber: "L-2" })).statusCode).toBe(200);
    expect((await db.select().from(stockBatches).where(eq(stockBatches.id, batchId)))[0]!.batchNumber).toBe("l-1a");
  });

  it("400 for a bad body, 404 for an unknown batch, 403 without lager and for a read-only account", async () => {
    const { batchId } = await makeBatch("L-1");
    for (const body of [{}, { expiresOn: "2027-13-01" }, { expiresOn: "" }, { batchNumber: "" }, { batchNumber: "x".repeat(51) }, { kind: "serial" }]) {
      const res = await asAdmin("PATCH", `/stock/batches/${batchId}`, body);
      expect([res.statusCode, res.json().code], JSON.stringify(body)).toEqual([400, "validation-failed"]);
    }
    expect(updateStockBatchSchema.safeParse({ expiresOn: null }).success).toBe(true);
    const missing = await asAdmin("PATCH", `/stock/batches/${crypto.randomUUID()}`, { expiresOn: "2027-01-01" });
    expect([missing.statusCode, missing.json().code]).toEqual([404, "stock-batch-not-found"]);

    const buyer = await userCookie(["inkop"]);
    expect((await call(buyer, "PATCH", `/stock/batches/${batchId}`, { expiresOn: "2027-01-01" })).statusCode).toBe(403);
    const readOnly = await userCookie(["lager"], true);
    const refused = await call(readOnly, "PATCH", `/stock/batches/${batchId}`, { expiresOn: "2027-01-01" });
    expect([refused.statusCode, refused.json().code]).toEqual([403, "read-only-account"]);
    const stock = await userCookie(["lager"]);
    expect((await call(stock, "PATCH", `/stock/batches/${batchId}`, { expiresOn: "2027-01-01" })).statusCode).toBe(200);
    // Reading the register stays the module's read rule.
    expect((await call(buyer, "GET", "/stock/batches")).statusCode).toBe(200);
  });
});

describe("the dates in the readers", () => {
  it("GET /stock/batches carries the dates and filters on expiry; the trace and the batch choices carry them too", async () => {
    const today = stockholmToday();
    const expired = await makeBatch("UTGÅNGEN");
    const soon = await makeBatch("SNART", 5, expired.articleId);
    const later = await makeBatch("SENARE", 5, expired.articleId);
    await makeBatch("ODATERAD", 5, expired.articleId);
    await asAdmin("PATCH", `/stock/batches/${expired.batchId}`, { expiresOn: addDays(today, -1) });
    await asAdmin("PATCH", `/stock/batches/${soon.batchId}`, { expiresOn: addDays(today, 30) });
    await asAdmin("PATCH", `/stock/batches/${later.batchId}`, { expiresOn: addDays(today, 31), batchDate: "2026-01-01" });

    const all = (await asAdmin("GET", "/stock/batches")).json();
    expect(all.total).toBe(4);
    expect(all.rows.find((r: { id: string }) => r.id === later.batchId)).toMatchObject({ expiresOn: addDays(today, 31), batchDate: "2026-01-01", expired: false });
    // The default window is 30 days: SENARE is one day outside.
    const due = (await asAdmin("GET", "/stock/batches?expiry=due")).json();
    expect(due.rows.map((r: { batchNumber: string; expired: boolean }) => [r.batchNumber, r.expired])).toEqual([
      ["UTGÅNGEN", true],
      ["SNART", false],
    ]);
    expect((await asAdmin("GET", "/stock/batches?expiry=expired")).json().rows.map((r: { batchNumber: string }) => r.batchNumber)).toEqual(["UTGÅNGEN"]);
    expect((await asAdmin("GET", "/stock/batches?expiry=nej")).statusCode).toBe(400);

    // The setting widens it — and is what the avisering reads.
    const settings = await asAdmin("PATCH", "/settings", { alertBatchExpiryDays: 31 });
    expect(settings.json().alertBatchExpiryDays).toBe(31);
    expect((await asAdmin("GET", "/stock/batches?expiry=due")).json().total).toBe(3);
    const alerts = (await asAdmin("GET", "/alerts?kinds=batch_expiry")).json();
    expect(alerts.groups[0]).toMatchObject({ kind: "batch_expiry", count: 3, listHref: "/lager/sparbarhet?expiry=due" });
    expect(alerts.groups[0].items.map((i: { severity: string }) => i.severity)).toEqual(["red", "yellow", "yellow"]);
    for (const bad of [-1, 366, 1.5]) expect((await asAdmin("PATCH", "/settings", { alertBatchExpiryDays: bad })).statusCode).toBe(400);
    expect((await asAdmin("GET", "/settings")).json().alertBatchExpiryDays).toBe(31);

    const trace = (await asAdmin("GET", `/stock/batches/${soon.batchId}/trace`)).json();
    expect(trace.batch).toMatchObject({ batchNumber: "SNART", expiresOn: addDays(today, 30), tracking: "batch", batchTracked: true });

    // The batch choices: FEFO, the expired cell last and flagged.
    const cells = (await asAdmin("GET", `/stock/batch-balances?articleIds=${expired.articleId}`)).json().rows;
    expect(cells.map((c: { batchNumber: string; expired: boolean }) => [c.batchNumber, c.expired])).toEqual([
      ["SNART", false],
      ["SENARE", false],
      ["ODATERAD", false],
      ["UTGÅNGEN", true],
    ]);
    const card = (await asAdmin("GET", `/articles/${expired.articleId}/batch-balances`)).json();
    expect(card.batches.map((b: { batchNumber: string; expiresOn: string | null; expired: boolean }) => [b.batchNumber, b.expired])).toEqual([
      ["UTGÅNGEN", true],
      ["SNART", false],
      ["SENARE", false],
      ["ODATERAD", false],
    ]);
  });

  it("the default of the setting is 30 days", async () => {
    expect((await asAdmin("GET", "/settings")).json().alertBatchExpiryDays).toBe(30);
  });
});

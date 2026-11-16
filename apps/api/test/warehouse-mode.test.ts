import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db, stockLocations, systemSettings, warehouses } from "@navet/db";
import { buildApp } from "../src/app.js";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createImportRepository } from "../src/modules/import/repository/import.repository.js";
import { createImportService } from "../src/modules/import/service/import.service.js";
import { getOrCreateFallbackLocation } from "../src/modules/stock/service/location-resolver.js";
import {
  beginWarehouseWrite,
  countWarehousesInUse,
  MULTIPLE_WAREHOUSES_KEY,
  MultipleWarehousesDisabledError,
  MultipleWarehousesInUseError,
  warehouseModeErrorStatus,
} from "../src/modules/stock/service/warehouse-mode.js";
import { pickListCellLines } from "../src/modules/sales/service/sales.service.js";
import { pdfText } from "./helpers/pdf.js";
import { waitForLockWaiter } from "./helpers/year-end.js";

// Flera lager (stock/service/warehouse-mode.ts): off by default — one
// warehouse the user never sees; switched off only while at most one is in
// use; every writer that could add a second refuses while it is off.

const TRUNCATE = sql`TRUNCATE stock_count_sessions, stock_transactions, stock_locations, warehouses, articles, audit_log, user_settings, users CASCADE`;
const clearSetting = () => db.delete(systemSettings).where(eq(systemSettings.key, MULTIPLE_WAREHOUSES_KEY));
const setSetting = (on: boolean) =>
  db
    .insert(systemSettings)
    .values({ key: MULTIPLE_WAREHOUSES_KEY, value: String(on) })
    .onConflictDoUpdate({ target: systemSettings.key, set: { value: String(on) } });

const articleService = createArticleService(createArticleRepository(db));
const imports = createImportService(createImportRepository(db));

const PASSWORD = "ett-tillräckligt-långt-lösenord";
let app: ReturnType<typeof buildApp>;
let admin: string;
const cookieOf = (res: { cookies: { name: string; value: string }[] }) => res.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
const asAdmin = (method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: { cookie: admin }, ...(payload === undefined ? {} : { payload: payload as never }) });

beforeAll(async () => {
  app = buildApp();
  await app.ready();
});

beforeEach(async () => {
  await db.execute(TRUNCATE);
  await clearSetting();
  await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: { email: "admin@example.com", password: PASSWORD, name: "Admin", setupCode: app.setup.code.code },
  });
  admin = cookieOf(await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "admin@example.com", password: PASSWORD } }));
});

afterAll(async () => {
  await db.execute(TRUNCATE);
  await clearSetting();
  await app.close();
});

const warehouseNames = async () => (await db.select({ name: warehouses.name }).from(warehouses).orderBy(warehouses.name)).map((w) => w.name);

describe("the setting", () => {
  it("is off by default, in GET /settings and the frame's GET /settings/stock", async () => {
    expect((await asAdmin("GET", "/settings")).json().multipleWarehouses).toBe(false);
    expect((await asAdmin("GET", "/settings/stock")).json()).toEqual({ multipleWarehouses: false });
    expect((await asAdmin("PATCH", "/settings", { multipleWarehouses: true })).json().multipleWarehouses).toBe(true);
    expect((await asAdmin("GET", "/settings/stock")).json()).toEqual({ multipleWarehouses: true });
  });

  it("switches off only while at most one warehouse is in use — the reserve warehouse not counted", async () => {
    await asAdmin("PATCH", "/settings", { multipleWarehouses: true });
    const main = (await asAdmin("POST", "/stock/warehouses", { name: "Huvudlager" })).json();
    const second = (await asAdmin("POST", "/stock/warehouses", { name: "Ytterlager" })).json();
    await getOrCreateFallbackLocation(db);

    const refused = await asAdmin("PATCH", "/settings", { multipleWarehouses: false });
    expect([refused.statusCode, refused.json().code]).toEqual([409, "multiple-warehouses-in-use"]);
    expect(refused.json().error).toContain("2 lager används");
    // The whole PATCH rolled back.
    expect((await asAdmin("GET", "/settings")).json().multipleWarehouses).toBe(true);

    // An inactive warehouse with an active place is still in use.
    await asAdmin("POST", "/stock/locations", { warehouseId: second.id, name: "Y1" });
    await asAdmin("PATCH", `/stock/warehouses/${second.id}`, { active: false });
    expect(await countWarehousesInUse(db)).toBe(2);
    expect((await asAdmin("PATCH", "/settings", { multipleWarehouses: false })).statusCode).toBe(409);

    // Emptied of active places it is not; "***" never is.
    await db.update(stockLocations).set({ active: false }).where(eq(stockLocations.warehouseId, second.id));
    expect(await countWarehousesInUse(db)).toBe(1);
    const off = await asAdmin("PATCH", "/settings", { multipleWarehouses: false });
    expect([off.statusCode, off.json().multipleWarehouses]).toEqual([200, false]);
    expect(main.name).toBe("Huvudlager");
  });

  it("maps both errors to 409 once for every route", () => {
    expect(warehouseModeErrorStatus(new MultipleWarehousesInUseError(2))).toBe(409);
    expect(warehouseModeErrorStatus(new MultipleWarehousesDisabledError())).toBe(409);
    expect(warehouseModeErrorStatus(new Error("annat"))).toBeNull();
  });
});

describe("with Flera lager off", () => {
  it("puts a new place without warehouseId in Huvudlager, created once", async () => {
    const a1 = await asAdmin("POST", "/stock/locations", { name: "A1" });
    const a2 = await asAdmin("POST", "/stock/locations", { name: "A2" });
    expect([a1.statusCode, a2.statusCode]).toEqual([201, 201]);
    expect(a1.json().warehouseId).toBe(a2.json().warehouseId);
    expect(await warehouseNames()).toEqual(["Huvudlager"]);
  });

  it("puts it in the warehouse in use when there is one, never in the reserve warehouse", async () => {
    await getOrCreateFallbackLocation(db);
    const own = (await asAdmin("POST", "/stock/warehouses", { name: "Centrallager" })).json();
    const a1 = await asAdmin("POST", "/stock/locations", { name: "A1" });
    expect(a1.json().warehouseId).toBe(own.id);
    expect(await warehouseNames()).toEqual(["***", "Centrallager"]);
  });

  it("refuses a second warehouse in use — created, reactivated or reached by moving a place", async () => {
    const main = (await asAdmin("POST", "/stock/warehouses", { name: "Huvudlager" })).json();
    const refused = await asAdmin("POST", "/stock/warehouses", { name: "Ytterlager" });
    expect([refused.statusCode, refused.json().code]).toEqual([409, "multiple-warehouses-disabled"]);
    expect(await warehouseNames()).toEqual(["Huvudlager"]);

    // An inactive warehouse is not in use, so it may be created …
    const spare = await asAdmin("POST", "/stock/warehouses", { name: "Reserv", active: false });
    expect(spare.statusCode).toBe(201);
    // … but not reactivated, and no place may move into it.
    const reactivated = await asAdmin("PATCH", `/stock/warehouses/${spare.json().id}`, { active: true });
    expect([reactivated.statusCode, reactivated.json().code]).toEqual([409, "multiple-warehouses-disabled"]);
    const place = (await asAdmin("POST", "/stock/locations", { warehouseId: main.id, name: "A1" })).json();
    const moved = await asAdmin("PATCH", `/stock/locations/${place.id}`, { warehouseId: spare.json().id });
    expect([moved.statusCode, moved.json().code]).toEqual([409, "multiple-warehouses-disabled"]);
    const placed = await asAdmin("POST", "/stock/locations", { warehouseId: spare.json().id, name: "R1" });
    expect([placed.statusCode, placed.json().code]).toEqual([409, "multiple-warehouses-disabled"]);
    expect(await countWarehousesInUse(db)).toBe(1);
  });

  it("two first warehouses at once: one is created, the other refused", async () => {
    const [a, b] = await Promise.all([
      asAdmin("POST", "/stock/warehouses", { name: "Lager A" }),
      asAdmin("POST", "/stock/warehouses", { name: "Lager B" }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
    expect(await countWarehousesInUse(db)).toBe(1);
  });

  it("two first places without warehouseId at once share one Huvudlager", async () => {
    const [a, b] = await Promise.all([asAdmin("POST", "/stock/locations", { name: "A1" }), asAdmin("POST", "/stock/locations", { name: "A2" })]);
    expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
    expect(await warehouseNames()).toEqual(["Huvudlager"]);
  });
});

describe("the lock order", () => {
  it("switching off waits for a warehouse write in progress and then sees it", async () => {
    await setSetting(true);
    await asAdmin("POST", "/stock/warehouses", { name: "Huvudlager" });
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const writer = db.transaction(async (tx) => {
      expect(await beginWarehouseWrite(tx)).toBe(false);
      await tx.insert(warehouses).values({ name: "Ytterlager" });
      await held;
    });
    const patch = asAdmin("PATCH", "/settings", { multipleWarehouses: false });
    await waitForLockWaiter();
    release();
    await writer;
    const res = await patch;
    expect([res.statusCode, res.json().code]).toEqual([409, "multiple-warehouses-in-use"]);
  });
});

describe("the saldoimport", () => {
  const MAPPING = { Artikelnummer: "articleNumber", Lager: "warehouseName", Lagerplats: "locationName", Antal: "quantity" };
  const input = (rows: string[][]) => ({ mapping: MAPPING, rows });
  const makeArticle = (articleNumber: string) =>
    articleService.createArticle({ articleNumber, name: articleNumber, type: "purchased", unit: "st", active: true } as never);

  it("keeps the file to the one warehouse: a new Lagerplats without Lager goes there, another Lager is a row error", async () => {
    await makeArticle("PL-1");
    await makeArticle("PL-2");
    await makeArticle("PL-3");
    await asAdmin("POST", "/stock/warehouses", { name: "Huvudlager" });

    const preview = await imports.preview(
      "stockBalances",
      input([
        ["PL-1", "", "B9", "5"],
        ["PL-2", "huvudlager", "B8", "3"],
        ["PL-3", "Ytterlager", "Y1", "2"],
      ])
    );
    expect(preview.rows.map((r) => r.errors.length)).toEqual([0, 0, 1]);
    expect(preview.rows[2]!.errors.join(" ")).toContain("Flera lager är avstängt");
    expect(preview.willCreate).toMatchObject({ warehouses: [], stockLocations: ["Huvudlager / B9", "Huvudlager / B8"] });

    const result = await imports.commit("stockBalances", { ...input([["PL-1", "", "B9", "5"], ["PL-2", "huvudlager", "B8", "3"]]) });
    expect(result).toMatchObject({ created: 2 });
    expect((await warehouseNames()).filter((name) => name !== "***")).toEqual(["Huvudlager"]);
  });

  it("with no warehouse in use: the first Lager the file names becomes the one, a second is a row error", async () => {
    await makeArticle("PL-1");
    await makeArticle("PL-2");
    await makeArticle("PL-3");
    const preview = await imports.preview(
      "stockBalances",
      input([
        ["PL-1", "Centrallager", "C1", "5"],
        ["PL-2", "", "C2", "5"],
        ["PL-3", "Lager 2", "L1", "5"],
      ])
    );
    expect(preview.rows.map((r) => r.errors.length)).toEqual([0, 0, 1]);
    expect(preview.willCreate).toMatchObject({ warehouses: ["Centrallager"], stockLocations: ["Centrallager / C1", "Centrallager / C2"] });
  });

  it("a file with no Lager and no warehouse in use creates Huvudlager", async () => {
    await makeArticle("PL-1");
    const result = await imports.commit("stockBalances", input([["PL-1", "", "A1", "4"]]));
    expect(result).toMatchObject({ created: 1, registersCreated: { warehouses: ["Huvudlager"], stockLocations: ["Huvudlager / A1"] } });
  });

  it("with Flera lager on the file may name several, and a missing place without Lager is still an error", async () => {
    await setSetting(true);
    await makeArticle("PL-1");
    await makeArticle("PL-2");
    await makeArticle("PL-3");
    const preview = await imports.preview(
      "stockBalances",
      input([
        ["PL-1", "Huvudlager", "A1", "5"],
        ["PL-2", "Ytterlager", "Y1", "5"],
        ["PL-3", "", "Z9", "5"],
      ])
    );
    expect(preview.rows.map((r) => r.errors.length)).toEqual([0, 0, 1]);
    expect(preview.willCreate).toMatchObject({ warehouses: ["Huvudlager", "Ytterlager"] });
  });
});

describe("the papers", () => {
  it("the räknelista and the place's label leave the warehouse out while Flera lager is off", async () => {
    const place = (await asAdmin("POST", "/stock/locations", { name: "A1" })).json();
    const count = await asAdmin("POST", "/stock-counts", { locationId: place.id, blocksTransactions: false });
    expect(count.statusCode).toBe(201);
    const sheet = async () => pdfText((await asAdmin("GET", `/stock-counts/${count.json().id}/pdf`)).rawPayload);
    const label = async () =>
      pdfText((await asAdmin("POST", "/stock/locations/labels", { locationIds: [place.id], format: "single", copies: 1 })).rawPayload);

    expect(await sheet()).toContain("Lagerplats: A1");
    expect(await sheet()).not.toContain("Huvudlager");
    expect(await label()).not.toContain("Huvudlager");

    await setSetting(true);
    expect(await sheet()).toContain("Lagerplats: Huvudlager — A1");
    expect(await label()).toContain("Huvudlager");
  });
});

describe("the plocklista's places", () => {
  it("are written without the warehouse while Flera lager is off", () => {
    const cells = [
      { warehouseName: "Huvudlager", locationName: "A1", batchNumber: "L-1", batchKind: "batch" as const, expiresOn: null, expired: false, quantity: "3" },
    ];
    expect(pickListCellLines(cells, false).join(" ")).toContain("A1");
    expect(pickListCellLines(cells, false).join(" ")).not.toContain("Huvudlager");
    expect(pickListCellLines(cells).join(" ")).toContain("Huvudlager — A1");
  });
});

describe("migration 0228", () => {
  const migration = readFileSync(
    fileURLToPath(new URL("../../../packages/db/drizzle/0228_multiple_warehouses_setting.sql", import.meta.url)),
    "utf8"
  );
  const run = () => db.execute(sql.raw(migration));
  const stored = async () => (await db.select().from(systemSettings).where(eq(systemSettings.key, MULTIPLE_WAREHOUSES_KEY)))[0]?.value ?? null;

  it("switches Flera lager on only for an installation with more than one warehouse in use", async () => {
    await db.insert(warehouses).values([{ name: "***" }, { name: "Huvudlager" }]);
    await run();
    expect(await stored()).toBeNull();

    await db.insert(warehouses).values({ name: "Ytterlager" });
    await run();
    expect(await stored()).toBe("true");
  });

  it("leaves a value that is already set", async () => {
    await db.insert(warehouses).values([{ name: "Huvudlager" }, { name: "Ytterlager" }]);
    await setSetting(false);
    await run();
    expect(await stored()).toBe("false");
  });
});

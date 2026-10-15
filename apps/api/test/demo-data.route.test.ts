import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import { db, articleGroups, customers, numberSeries, paymentTerms, stockLocations, stockTransactions, units, users } from "@navet/db";
import bcrypt from "bcryptjs";
import { buildApp } from "../src/app.js";
import { DEMO_DATA, DEMO_LOCATIONS } from "../src/modules/demo/service/demo-data.js";

// System → Exempeldata through the real app: the empty-register guard, the
// one-transaction write and the admin-only access.

const TRUNCATE = sql`TRUNCATE articles, customers, suppliers, work_centers, production_groups, article_groups, payment_terms, audit_log, user_settings, users CASCADE`;
const PASSWORD = "ett-tillräckligt-långt-lösenord";

let app: ReturnType<typeof buildApp>;
let cookie: string;

async function cleanLocations() {
  await db.delete(stockLocations).where(inArray(stockLocations.name, Object.values(DEMO_LOCATIONS)));
}

async function loginAdmin() {
  await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: { email: "admin@example.com", password: PASSWORD, name: "Admin", setupCode: app.setup.code.code },
  });
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "admin@example.com", password: PASSWORD } });
  cookie = res.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

const post = () => app.inject({ method: "POST", url: "/api/v1/demo-data", headers: { cookie } });
const get = () => app.inject({ method: "GET", url: "/api/v1/demo-data", headers: { cookie } });

beforeEach(async () => {
  await db.execute(TRUNCATE);
  await cleanLocations();
  app = buildApp();
  await loginAdmin();
});

afterEach(async () => {
  await app.close();
});

afterAll(async () => {
  await db.execute(TRUNCATE);
  await cleanLocations();
});

describe("exempeldata — rutterna", () => {
  it("is available on empty registers and creates the whole company in one go", async () => {
    expect((await get()).json()).toEqual({ available: true, blockers: [] });
    const [before] = await db.select().from(numberSeries).where(eq(numberSeries.key, "customer"));

    const res = await post();
    expect(res.statusCode).toBe(201);
    expect(res.json().created).toEqual({
      articles: DEMO_DATA.articles.length,
      workCenters: DEMO_DATA.workCenters.length,
      customers: DEMO_DATA.customers.length,
      suppliers: DEMO_DATA.suppliers.length,
      stockTransactions: DEMO_DATA.articles.filter((a) => a.openingStock).length,
    });

    const [after] = await db.select().from(numberSeries).where(eq(numberSeries.key, "customer"));
    expect(after!.nextNumber).toBe(before!.nextNumber + DEMO_DATA.customers.length);

    const rows = await db.select().from(stockTransactions);
    const plate = DEMO_DATA.articles.find((a) => a.articleNumber === "1001")!;
    const plateRow = rows.find((r) => r.note?.includes("Exempeldata") && Number(r.quantityDelta) === plate.openingStock);
    expect(plateRow?.transactionType).toBe("inventory_adjustment");
    expect(Number(plateRow?.unitCost)).toBe(780);
    expect((await get()).json()).toEqual({ available: false, blockers: ["articles", "customers", "suppliers", "workCenters"] });
  });

  it("refuses a second run with 409 and the blockers", async () => {
    await post();
    const res = await post();
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "demo-data-not-available", blockers: ["articles", "customers", "suppliers", "workCenters"] });
  });

  it("refuses an installation with a single customer and writes nothing", async () => {
    await db.insert(customers).values({ customerNumber: "K-1", name: "Befintlig kund" });
    const res = await post();
    expect(res.statusCode).toBe(409);
    expect(res.json().blockers).toEqual(["customers"]);
    expect(await db.select().from(stockTransactions)).toHaveLength(0);
  });

  it("reuses base data that already exists instead of failing on it", async () => {
    await db.insert(paymentTerms).values({ code: "30", name: "30 dagar netto" });
    await db.insert(articleGroups).values({ code: "100", name: "Råvaror" });
    expect((await post()).statusCode).toBe(201);
    expect(await db.select().from(paymentTerms)).toHaveLength(1);
    expect(await db.select().from(articleGroups)).toHaveLength(DEMO_DATA.articleGroups.length);
  });

  it("creates the unit m when it is missing", async () => {
    await db.delete(units).where(eq(units.code, "m"));
    expect((await post()).statusCode).toBe(201);
    expect(await db.select().from(units).where(eq(units.code, "m"))).toHaveLength(1);
  });

  it("lets exactly one of two simultaneous runs through", async () => {
    const results = await Promise.all([post(), post()]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
  });

  it("is admin only", async () => {
    const hash = await bcrypt.hash(PASSWORD, 4);
    await db.insert(users).values({ email: "user@example.com", passwordHash: hash, name: "Användare", role: "user" });
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "user@example.com", password: PASSWORD } });
    const userCookie = login.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const res = await app.inject({ method: "POST", url: "/api/v1/demo-data", headers: { cookie: userCookie } });
    expect(res.statusCode).toBe(403);
    expect(await db.select().from(stockTransactions)).toHaveLength(0);
  });
});

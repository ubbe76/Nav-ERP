import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, accounts, auditLog, companyInfo, fiscalYears, stockLocations, systemSettings } from "@navet/db";
import { buildApp } from "../src/app.js";
import { DEMO_LOCATIONS } from "../src/modules/demo/service/demo-data.js";

// System → Kom igång through the real app: each step is derived from the
// data, the number-series review is the one stored flag, admin only.

const TRUNCATE = sql`TRUNCATE articles, customers, suppliers, work_centers, production_groups, article_groups, payment_terms, delivery_terms, fiscal_years, accounts, audit_log, user_settings, users CASCADE`;
const PASSWORD = "ett-tillräckligt-långt-lösenord";

let app: ReturnType<typeof buildApp>;
let cookie: string;

const cookieOf = (res: { cookies: { name: string; value: string }[] }) =>
  res.cookies.map((c) => `${c.name}=${c.value}`).join("; ");

async function reset() {
  await db.execute(TRUNCATE);
  await db.delete(stockLocations).where(inArray(stockLocations.name, Object.values(DEMO_LOCATIONS)));
  await db.update(companyInfo).set({ name: "", orgNumber: null });
  await db.delete(systemSettings).where(inArray(systemSettings.key, ["smtp_host", "onboarding_number_series_reviewed"]));
}

const view = async () => (await app.inject({ method: "GET", url: "/api/v1/onboarding", headers: { cookie } })).json();
const doneKeys = async () =>
  (await view()).groups.flatMap((g: { steps: { key: string; done: boolean }[] }) => g.steps).filter((s: { done: boolean }) => s.done).map((s: { key: string }) => s.key);

beforeEach(async () => {
  await reset();
  app = buildApp();
  await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: { email: "admin@example.com", password: PASSWORD, name: "Admin", setupCode: app.setup.code.code },
  });
  cookie = cookieOf(await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "admin@example.com", password: PASSWORD } }));
});

afterEach(async () => {
  await app.close();
});

afterAll(async () => {
  await reset();
});

async function addUser(email: string, role: "admin" | "user", active = true) {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/users",
    headers: { cookie },
    payload: { email, password: PASSWORD, name: email, role },
  });
  expect(res.statusCode).toBe(201);
  if (!active) {
    await app.inject({ method: "PATCH", url: `/api/v1/auth/users/${res.json().id}`, headers: { cookie }, payload: { active: false } });
  }
}

describe("Kom igång — rutterna", () => {
  it("starts at 0 of 9 on an empty installation", async () => {
    expect(await view()).toMatchObject({ done: 0, total: 9, complete: false });
  });

  it("ticks the register steps after Skapa exempeldata, but not the terms", async () => {
    expect((await app.inject({ method: "POST", url: "/api/v1/demo-data", headers: { cookie } })).statusCode).toBe(201);
    // The demo company has a payment term but no delivery term.
    expect(await doneKeys()).toEqual(["articles", "partners", "workCenters"]);
  });

  it("ticks company, terms, accounting and e-mail from their data", async () => {
    await db.update(companyInfo).set({ name: "Exempel AB", orgNumber: "556677-8899" });
    await app.inject({ method: "POST", url: "/api/v1/demo-data", headers: { cookie } });
    await app.inject({ method: "POST", url: "/api/v1/delivery-terms/generate-combiterms", headers: { cookie } });
    await db.insert(fiscalYears).values({ label: "2026", startDate: "2026-01-01", endDate: "2026-12-31" });
    await db.insert(accounts).values({ number: "1930", name: "Företagskonto" });
    await db.insert(systemSettings).values({ key: "smtp_host", value: "smtp.example.com" });
    expect(await doneKeys()).toEqual(["company", "articles", "partners", "workCenters", "terms", "accounting", "email"]);
  });

  it("counts only active users as the second user", async () => {
    await addUser("inaktiv@example.com", "user", false);
    expect(await doneKeys()).toEqual([]);
    await addUser("aktiv@example.com", "user");
    expect(await doneKeys()).toEqual(["users"]);
  });

  it("stores the number-series review and logs it", async () => {
    const res = await app.inject({ method: "POST", url: "/api/v1/onboarding/number-series-reviewed", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().groups.flatMap((g: { steps: { key: string; done: boolean }[] }) => g.steps).find((s: { key: string }) => s.key === "numberSeries").done).toBe(true);
    const rows = await db.select().from(auditLog).where(and(eq(auditLog.entityType, "system_settings"), eq(auditLog.action, "onboarding_number_series_reviewed")));
    expect(rows).toHaveLength(1);
  });

  it("is admin only", async () => {
    await addUser("user@example.com", "user");
    const userCookie = cookieOf(await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "user@example.com", password: PASSWORD } }));
    expect((await app.inject({ method: "GET", url: "/api/v1/onboarding", headers: { cookie: userCookie } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/v1/onboarding/number-series-reviewed", headers: { cookie: userCookie } })).statusCode).toBe(403);
  });
});

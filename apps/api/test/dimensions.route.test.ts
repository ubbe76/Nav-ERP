import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db, permissionGroups } from "@navet/db";
import { buildApp } from "../src/app.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createAuthService } from "../src/modules/auth/service/auth.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { testEconomyService } from "./helpers/services.js";

// Kostnadsställen och projekt through the real app: the registers' routes
// and permissions (office reads, ekonomi writes), the error codes the web is
// built against (cost-center-code-taken, project-closed, cost-center-required
// with accounts), the report parameters and the projektrapport's rule.

const authService = createAuthService(createAuthRepository(db), "unused", createAuditRepository(db));
const PASSWORD = "correcthorsebattery";
const TRUNCATE = sql`TRUNCATE verification_rows, verifications, verification_counters, verification_series, accounting_periods, fiscal_years, accounts, cost_centers, projects, user_settings, audit_log, users CASCADE`;
const DELETE_GROUPS = sql`DELETE FROM permission_groups WHERE code LIKE 'DIM%'`;

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

const YEAR = new Date().getFullYear();
const DATE = `${YEAR}-03-15`;

async function login(email: string) {
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PASSWORD } });
  expect(res.statusCode).toBe(200);
  return `session=${res.cookies.find((c) => c.name === "session")!.value}`;
}

async function cookieWith(permissions: string[], name: string) {
  const [group] = await db
    .insert(permissionGroups)
    .values({ code: `DIM${crypto.randomUUID().slice(0, 6)}`, name, permissions })
    .returning();
  const email = `${name.toLowerCase()}-${crypto.randomUUID()}@example.com`;
  await authService.createUser({ email, password: PASSWORD, name, role: "user", permissionGroupId: group!.id });
  return login(email);
}

function api(cookie: string) {
  return {
    get: (url: string) => app.inject({ method: "GET", url: `/api/v1${url}`, headers: { cookie } }),
    post: (url: string, payload?: unknown) => app.inject({ method: "POST", url: `/api/v1${url}`, headers: { cookie }, payload }),
    patch: (url: string, payload?: unknown) => app.inject({ method: "PATCH", url: `/api/v1${url}`, headers: { cookie }, payload }),
    delete: (url: string, payload?: unknown) => app.inject({ method: "DELETE", url: `/api/v1${url}`, headers: { cookie }, payload }),
  };
}

async function setupEconomy() {
  await testEconomyService.createFiscalYear({ label: String(YEAR), startDate: `${YEAR}-01-01`, endDate: `${YEAR}-12-31` });
  const series = await testEconomyService.createSeries({ code: "A", name: "Manuella verifikat" });
  const bank = await testEconomyService.createAccount({ number: "1930", name: "Företagskonto" });
  const rent = await testEconomyService.createAccount({ number: "5010", name: "Lokalhyra" });
  return { series, bank, rent };
}

describe("the registers", () => {
  it("office users read the lists, only Ekonomi writes; the code is unique (409 cost-center-code-taken / project-code-taken)", async () => {
    const ekonomi = api(await cookieWith(["ekonomi"], "Ekonom"));
    const office = api(await cookieWith(["inkop"], "Inkopare"));

    const created = await ekonomi.post("/cost-centers", { code: "100", name: "Verkstad" });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toEqual({ id: expect.any(String), code: "100", name: "Verkstad", active: true });
    const dup = await ekonomi.post("/cost-centers", { code: "100", name: "Igen" });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().code).toBe("cost-center-code-taken");

    const list = await office.get("/cost-centers?includeInactive=true");
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual({ rows: [expect.objectContaining({ code: "100" })], total: 1 });
    expect((await office.post("/cost-centers", { code: "200", name: "Nej" })).statusCode).toBe(403);
    expect((await office.get("/projects")).statusCode).toBe(200);

    const project = await ekonomi.post("/projects", { code: "P1", name: "Storköket", startDate: `${YEAR}-01-01` });
    expect(project.statusCode).toBe(201);
    expect(project.json()).toMatchObject({ code: "P1", status: "open", customerId: null, customerName: null, endDate: null });
    const projectDup = await ekonomi.post("/projects", { code: "P1", name: "Igen" });
    expect(projectDup.statusCode).toBe(409);
    expect(projectDup.json().code).toBe("project-code-taken");
    expect((await ekonomi.post("/projects", { code: "P2", name: "Fel datum", startDate: `${YEAR}-02-01`, endDate: `${YEAR}-01-01` })).statusCode).toBe(400);

    const patched = await ekonomi.patch(`/cost-centers/${created.json().id}`, { name: "Verkstaden", active: false });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ name: "Verkstaden", active: false });
    expect((await office.get("/cost-centers")).json().total).toBe(0);
    expect((await ekonomi.get(`/cost-centers/${crypto.randomUUID()}`)).statusCode).toBe(404);
  });

  it("usage and delete with the replacement in the query string or the body", async () => {
    const ekonomi = api(await cookieWith(["ekonomi"], "Ekonom"));
    const { series, bank, rent } = await setupEconomy();
    const a = (await ekonomi.post("/cost-centers", { code: "100", name: "Verkstad" })).json();
    const b = (await ekonomi.post("/cost-centers", { code: "110", name: "Verkstad 2" })).json();
    const draft = await ekonomi.post("/verifications", {
      seriesId: series.id,
      date: DATE,
      description: "Hyra",
      rows: [
        { accountId: rent.id, debit: 100, credit: 0, costCenterId: a.id },
        { accountId: bank.id, debit: 0, credit: 100 },
      ],
    });
    expect(draft.statusCode).toBe(201);
    expect(draft.json().rows[0].costCenter).toEqual({ id: a.id, code: "100", name: "Verkstad" });

    const usage = await ekonomi.get(`/cost-centers/${a.id}/usage`);
    expect(usage.json()).toEqual({ total: 1, references: [{ table: "verification_rows", label: "verifikatrader (utkast)", labelOne: "verifikatrad (utkast)", count: 1 }] });
    const inUse = await ekonomi.delete(`/cost-centers/${a.id}`);
    expect(inUse.statusCode).toBe(409);
    expect(inUse.json()).toMatchObject({ code: "register-entry-in-use", usage: { total: 1 } });
    expect((await ekonomi.delete(`/cost-centers/${a.id}?replacementId=${a.id}`)).statusCode).toBe(400);
    expect((await ekonomi.delete(`/cost-centers/${a.id}?replacementId=${b.id}`, { replacementId: b.id })).statusCode).toBe(204);
    expect((await ekonomi.get(`/verifications/${draft.json().id}`)).json().rows[0].costCenter.id).toBe(b.id);
    // Now booked: the cost center can no longer be deleted at all.
    expect((await ekonomi.post(`/verifications/${draft.json().id}/book`)).statusCode).toBe(200);
    const booked = await ekonomi.delete(`/cost-centers/${b.id}`);
    expect(booked.statusCode).toBe(409);
    expect(booked.json().code).toBe("dimension-booked");
  });
});

describe("the rules on rows", () => {
  it("refuses a closed project on a new row (400 project-closed) and Kräver kostnadsställe at Bokför (409 cost-center-required with accounts)", async () => {
    const ekonomi = api(await cookieWith(["ekonomi"], "Ekonom"));
    const { series, bank, rent } = await setupEconomy();
    const closed = (await ekonomi.post("/projects", { code: "P9", name: "Klart", status: "closed" })).json();
    const refused = await ekonomi.post("/verifications", {
      seriesId: series.id,
      date: DATE,
      description: "Hyra",
      rows: [
        { accountId: rent.id, debit: 100, credit: 0, projectId: closed.id },
        { accountId: bank.id, debit: 0, credit: 100 },
      ],
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().code).toBe("project-closed");

    const flagged = await ekonomi.patch(`/accounts/${rent.id}`, { costCenterRequired: true });
    expect(flagged.statusCode).toBe(200);
    expect(flagged.json().costCenterRequired).toBe(true);
    const draft = await ekonomi.post("/verifications", {
      seriesId: series.id,
      date: DATE,
      description: "Hyra",
      rows: [
        { accountId: rent.id, debit: 100, credit: 0 },
        { accountId: bank.id, debit: 0, credit: 100 },
      ],
    });
    expect(draft.statusCode).toBe(201);
    const book = await ekonomi.post(`/verifications/${draft.json().id}/book`);
    expect(book.statusCode).toBe(409);
    expect(book.json()).toMatchObject({ code: "cost-center-required", accounts: ["5010"] });
    const direct = await ekonomi.post("/verifications", {
      seriesId: series.id,
      date: DATE,
      description: "Hyra",
      rows: [
        { accountId: rent.id, debit: 100, credit: 0 },
        { accountId: bank.id, debit: 0, credit: 100 },
      ],
      book: true,
    });
    expect(direct.statusCode).toBe(409);
    expect(direct.json().code).toBe("cost-center-required");
    expect((await ekonomi.get(`/accounts`)).json().rows.find((a: { number: string }) => a.number === "5010").costCenterRequired).toBe(true);
  });
});

describe("the reports", () => {
  it("takes the object filter and groupBy on the income statement, the ledgers and the verification list, and the projektrapport needs Rapporter", async () => {
    const ekonomi = api(await cookieWith(["ekonomi"], "Ekonom"));
    const rapporter = api(await cookieWith(["rapporter"], "Chef"));
    const { series, bank, rent } = await setupEconomy();
    const cc = (await ekonomi.post("/cost-centers", { code: "100", name: "Verkstad" })).json();
    const project = (await ekonomi.post("/projects", { code: "P1", name: "Storköket" })).json();
    const booked = await ekonomi.post("/verifications", {
      seriesId: series.id,
      date: DATE,
      description: "Hyra",
      rows: [
        { accountId: rent.id, debit: 100, credit: 0, costCenterId: cc.id, projectId: project.id },
        { accountId: bank.id, debit: 0, credit: 100 },
      ],
      book: true,
    });
    expect(booked.statusCode).toBe(201);

    const grouped = await ekonomi.get(`/income-statement?from=${YEAR}-01-01&to=${YEAR}-12-31&groupBy=costCenter`);
    expect(grouped.statusCode).toBe(200);
    expect(grouped.json().columns).toEqual([{ id: cc.id, code: "100", name: "Verkstad" }]);
    expect(grouped.json().result).toBe(-100);
    const filtered = await ekonomi.get(`/income-statement?from=${YEAR}-01-01&to=${YEAR}-12-31&projectId=${project.id}`);
    expect(filtered.json().columns).toBeUndefined();
    expect(filtered.json().result).toBe(-100);
    expect((await ekonomi.get(`/income-statement?from=${YEAR}-01-01&to=${YEAR}-12-31&groupBy=nope`)).statusCode).toBe(400);
    expect((await ekonomi.get(`/income-statement/csv?from=${YEAR}-01-01&to=${YEAR}-12-31&groupBy=project`)).statusCode).toBe(200);

    const ledger = await ekonomi.get(`/ledger?accountId=${rent.id}&costCenterId=${cc.id}`);
    expect(ledger.statusCode).toBe(200);
    expect(ledger.json().rows[0].costCenter).toEqual({ id: cc.id, code: "100", name: "Verkstad" });
    expect((await ekonomi.get(`/ledger?accountId=${rent.id}&costCenterId=${crypto.randomUUID()}`)).json().rows).toEqual([]);
    const general = await ekonomi.get(`/general-ledger?from=${YEAR}-01-01&to=${YEAR}-12-31&projectId=${project.id}`);
    expect(general.json().accounts.map((a: { accountNumber: string }) => a.accountNumber)).toEqual(["5010"]);
    expect((await ekonomi.get(`/general-ledger/csv?from=${YEAR}-01-01&to=${YEAR}-12-31&costCenterId=${cc.id}`)).statusCode).toBe(200);
    const list = await ekonomi.get(`/verification-list?costCenterId=${cc.id}`);
    expect(list.json().verifications).toHaveLength(1);
    expect(list.json().verifications[0].rows[0].costCenter.code).toBe("100");
    expect((await ekonomi.get(`/verification-list?costCenterId=${crypto.randomUUID()}`)).json().verifications).toEqual([]);

    const report = await rapporter.get(`/reports/project-report?projectId=${project.id}&from=${YEAR}-01-01&to=${YEAR}-12-31`);
    expect(report.statusCode).toBe(200);
    expect(report.json()).toMatchObject({ project: { code: "P1" }, from: `${YEAR}-01-01`, revenue: 0, costs: 100, result: -100, salesOrders: [] });
    expect((await rapporter.get(`/reports/project-report/csv?projectId=${project.id}`)).statusCode).toBe(200);
    expect((await rapporter.get(`/reports/project-report?projectId=${crypto.randomUUID()}`)).statusCode).toBe(404);
    expect((await ekonomi.get(`/reports/project-report?projectId=${project.id}`)).statusCode).toBe(403);
  });
});

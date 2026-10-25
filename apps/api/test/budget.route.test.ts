import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { costCenters, db, permissionGroups } from "@navet/db";
import { buildApp } from "../src/app.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createAuthService } from "../src/modules/auth/service/auth.service.js";
import { BAS_STANDARD_ACCOUNTS } from "../src/modules/economy/service/bas-accounts.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { multipartFile } from "./helpers/banking.js";
import { pdfText } from "./helpers/pdf.js";
import { testEconomyRepository, testEconomyService } from "./helpers/services.js";

// Budget (etapp 5 del B) through the real app: the routes, the Ekonomi
// permission on reads and writes, the error codes the web is built against,
// the CSV export/parse and resultaträkningen with budgetId (JSON, PDF, CSV).

const authService = createAuthService(createAuthRepository(db), "unused", createAuditRepository(db));
const PASSWORD = "correcthorsebattery";
const TRUNCATE = sql`TRUNCATE budget_lines, budgets, verification_rows, verifications, verification_counters, verification_series, accounting_periods, fiscal_years, accounts, cost_centers, projects, user_settings, audit_log, users CASCADE`;
const DELETE_GROUPS = sql`DELETE FROM permission_groups WHERE code LIKE 'BUD%'`;

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

const YEAR = 2027;

async function login(email: string) {
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PASSWORD } });
  expect(res.statusCode).toBe(200);
  return `session=${res.cookies.find((c) => c.name === "session")!.value}`;
}

async function cookieWith(permissions: string[], name: string) {
  const [group] = await db
    .insert(permissionGroups)
    .values({ code: `BUD${crypto.randomUUID().slice(0, 6)}`, name, permissions })
    .returning();
  const email = `${name.toLowerCase()}-${crypto.randomUUID()}@example.com`;
  await authService.createUser({ email, password: PASSWORD, name, role: "user", permissionGroupId: group!.id });
  return login(email);
}

function api(cookie: string) {
  return {
    get: (url: string) => app.inject({ method: "GET", url: `/api/v1${url}`, headers: { cookie } }),
    post: (url: string, payload?: unknown, headers: Record<string, string> = {}) => app.inject({ method: "POST", url: `/api/v1${url}`, headers: { cookie, ...headers }, payload }),
    put: (url: string, payload?: unknown) => app.inject({ method: "PUT", url: `/api/v1${url}`, headers: { cookie }, payload }),
    patch: (url: string, payload?: unknown) => app.inject({ method: "PATCH", url: `/api/v1${url}`, headers: { cookie }, payload }),
    delete: (url: string) => app.inject({ method: "DELETE", url: `/api/v1${url}`, headers: { cookie } }),
  };
}

async function setupEconomy() {
  const year = await testEconomyService.createFiscalYear({ label: String(YEAR), startDate: `${YEAR}-01-01`, endDate: `${YEAR}-12-31` });
  await testEconomyRepository.seedAccounts(BAS_STANDARD_ACCOUNTS);
  const [workshop] = await db.insert(costCenters).values({ code: "100", name: "Verkstad" }).returning();
  return { year, workshop: workshop! };
}

const months = (fill: number, overrides: Record<number, number> = {}) => Array.from({ length: 12 }, (_, i) => overrides[i + 1] ?? fill);

describe("budget routes", () => {
  it("Ekonomi reads and writes, another office menu gets 403 even on reads", async () => {
    const { year } = await setupEconomy();
    const ekonomi = api(await cookieWith(["ekonomi"], "Ekonom"));
    const office = api(await cookieWith(["inkop"], "Inkopare"));

    const created = await ekonomi.post("/budgets", { fiscalYearId: year.id, name: "Budget 2027" });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ name: "Budget 2027", isDefault: true, fiscalYearLabel: "2027", lines: [] });
    expect(created.json().months).toHaveLength(12);
    const id = created.json().id as string;

    expect((await office.get("/budgets")).statusCode).toBe(403);
    expect((await office.get(`/budgets/${id}`)).statusCode).toBe(403);
    expect((await office.post("/budgets", { fiscalYearId: year.id, name: "Nej" })).statusCode).toBe(403);

    const list = await ekonomi.get(`/budgets?fiscalYearId=${year.id}`);
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual({ rows: [expect.objectContaining({ id, name: "Budget 2027", isDefault: true, revenue: 0, costs: 0, result: 0, updatedAt: expect.any(String) })], total: 1 });

    const dup = await ekonomi.post("/budgets", { fiscalYearId: year.id, name: "Budget 2027" });
    expect([dup.statusCode, dup.json().code]).toEqual([409, "budget-name-taken"]);
    const unknownYear = await ekonomi.post("/budgets", { fiscalYearId: crypto.randomUUID(), name: "X" });
    expect([unknownYear.statusCode, unknownYear.json().code]).toEqual([404, "fiscal-year-not-found"]);

    const renamed = await ekonomi.patch(`/budgets/${id}`, { name: "Huvudbudget", isDefault: false });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({ name: "Huvudbudget", isDefault: false });
    expect((await ekonomi.patch(`/budgets/${id}`, {})).statusCode).toBe(400);

    const missing = await ekonomi.get(`/budgets/${crypto.randomUUID()}`);
    expect([missing.statusCode, missing.json().code]).toEqual([404, "budget-not-found"]);
    expect((await ekonomi.get("/budgets/not-a-uuid")).statusCode).toBe(400);

    expect((await ekonomi.delete(`/budgets/${id}`)).statusCode).toBe(204);
    expect((await ekonomi.delete(`/budgets/${id}`)).statusCode).toBe(404);
  });

  it("PUT /lines validates with the contract's codes and replaces one cost center's set", async () => {
    const { year, workshop } = await setupEconomy();
    const ekonomi = api(await cookieWith(["ekonomi"], "Ekonom"));
    const id = (await ekonomi.post("/budgets", { fiscalYearId: year.id, name: "B" })).json().id as string;

    const wrongLength = await ekonomi.put(`/budgets/${id}/lines`, { costCenterId: null, lines: [{ accountNumber: "3001", amounts: [1, 2, 3] }] });
    expect([wrongLength.statusCode, wrongLength.json().code]).toEqual([400, "budget-month-invalid"]);
    const duplicate = await ekonomi.put(`/budgets/${id}/lines`, { costCenterId: null, lines: [{ accountNumber: "3001", amounts: months(1) }, { accountNumber: "3001", amounts: months(1) }] });
    expect([duplicate.statusCode, duplicate.json().code]).toEqual([400, "budget-duplicate-account"]);
    const invalid = await ekonomi.put(`/budgets/${id}/lines`, { costCenterId: null, lines: [{ accountNumber: "1930", amounts: months(1) }, { accountNumber: "4711", amounts: months(1) }] });
    expect([invalid.statusCode, invalid.json().code, invalid.json().accounts]).toEqual([400, "budget-account-invalid", ["1930", "4711"]]);
    const unknownCc = await ekonomi.put(`/budgets/${id}/lines`, { costCenterId: crypto.randomUUID(), lines: [] });
    expect([unknownCc.statusCode, unknownCc.json().code]).toEqual([404, "cost-center-not-found"]);
    expect((await ekonomi.put(`/budgets/${id}/lines`, { costCenterId: null, lines: [{ accountNumber: "3001", amounts: months(1e13) }] })).statusCode).toBe(400);
    expect((await ekonomi.put(`/budgets/${id}/lines`, { costCenterId: null, lines: [{ accountNumber: "3001", amounts: months("1" as never) }] })).statusCode).toBe(400);

    const saved = await ekonomi.put(`/budgets/${id}/lines`, { costCenterId: null, lines: [{ accountNumber: "3001", amounts: months(1000) }, { accountNumber: "5010", amounts: months(0, { 1: 250.126 }) }] });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().lines).toEqual([
      { accountNumber: "3001", accountName: "Försäljning inom Sverige 25 %", costCenterId: null, amounts: months(1000) },
      { accountNumber: "5010", accountName: "Lokalhyra", costCenterId: null, amounts: months(0, { 1: 250.13 }) },
    ]);
    const onWorkshop = await ekonomi.put(`/budgets/${id}/lines`, { costCenterId: workshop.id, lines: [{ accountNumber: "3001", amounts: months(10) }] });
    expect(onWorkshop.json().lines.map((l: { accountNumber: string; costCenterId: string | null }) => [l.accountNumber, l.costCenterId])).toEqual([["3001", null], ["3001", workshop.id], ["5010", null]]);
    const summary = (await ekonomi.get("/budgets")).json().rows[0];
    expect(summary).toMatchObject({ revenue: 12120, costs: 250.13, result: 11869.87 });
  });

  it("copies, reads actuals, exports and parses CSV", async () => {
    const { year, workshop } = await setupEconomy();
    const ekonomi = api(await cookieWith(["ekonomi"], "Ekonom"));
    const id = (await ekonomi.post("/budgets", { fiscalYearId: year.id, name: "B" })).json().id as string;
    await ekonomi.put(`/budgets/${id}/lines`, { costCenterId: null, lines: [{ accountNumber: "3001", amounts: months(1000) }] });
    await ekonomi.put(`/budgets/${id}/lines`, { costCenterId: workshop.id, lines: [{ accountNumber: "5010", amounts: months(0, { 12: 12 }) }] });

    const short = await testEconomyService.createFiscalYear({ label: "2028H1", startDate: "2028-01-01", endDate: "2028-06-30" });
    const copied = await ekonomi.post(`/budgets/${id}/copy`, { fiscalYearId: short.id, name: "Halvår" });
    expect(copied.statusCode).toBe(201);
    expect(copied.json()).toMatchObject({ name: "Halvår", droppedMonths: 6, isDefault: true });
    expect(copied.json().lines).toEqual([{ accountNumber: "3001", accountName: expect.any(String), costCenterId: null, amounts: [1000, 1000, 1000, 1000, 1000, 1000] }]);

    const noPrevious = await ekonomi.get(`/budgets/${id}/actuals`);
    expect([noPrevious.statusCode, noPrevious.json().code]).toEqual([400, "budget-no-previous-year"]);
    expect((await ekonomi.get(`/budgets/${id}/actuals?percent=5000`)).statusCode).toBe(400);
    const actuals = await ekonomi.get(`/budgets/${copied.json().id}/actuals?percent=10&costCenterId=none`);
    expect(actuals.statusCode).toBe(200);
    expect(actuals.json()).toEqual({ lines: [] });

    const all = await ekonomi.get(`/budgets/${id}/csv`);
    expect(all.statusCode).toBe(200);
    expect(all.headers["content-type"]).toContain("text/csv");
    expect(all.headers["content-disposition"]).toContain("budget-2027-b.csv");
    const lines = all.body.replace(/^﻿/, "").split("\r\n");
    expect(lines[0]).toBe(`Konto;Kontonamn;Kostnadsställe;${Array.from({ length: 12 }, (_, i) => `${YEAR}-${String(i + 1).padStart(2, "0")}`).join(";")};Summa`);
    expect(lines[1]).toBe(`3001;Försäljning inom Sverige 25 %;;${months(1000).map(() => "1000,00").join(";")};12000,00`);
    expect(lines[2]).toBe(`5010;Lokalhyra;100;${months(0, { 12: 12 }).map((n) => `${n},00`).join(";")};12,00`);
    const only = await ekonomi.get(`/budgets/${id}/csv?costCenterId=none`);
    expect(only.body.replace(/^﻿/, "").split("\r\n").filter(Boolean)).toHaveLength(2);
    expect((await ekonomi.get(`/budgets/${id}/csv?costCenterId=${workshop.id}`)).body).toContain("5010;Lokalhyra;100;");

    // Parse the export back, plus a bad row: nothing is saved.
    const text = all.body + "9999;;;1;2;3;4;5;6;7;8;9;10;11;12;78\r\n";
    const { payload, headers } = multipartFile("budget.csv", text);
    const parsed = await ekonomi.post(`/budgets/${id}/csv/parse`, payload, headers);
    expect(parsed.statusCode).toBe(200);
    expect(parsed.json()).toEqual({
      lines: [
        { accountNumber: "3001", accountName: "Försäljning inom Sverige 25 %", costCenterId: null, amounts: months(1000) },
        { accountNumber: "5010", accountName: "Lokalhyra", costCenterId: workshop.id, amounts: months(0, { 12: 12 }) },
      ],
      errors: [{ row: 4, message: expect.stringContaining("9999") }],
    });
    expect((await ekonomi.get(`/budgets/${id}`)).json().lines).toHaveLength(2);
    const empty = multipartFile("tom.csv", "");
    expect((await ekonomi.post(`/budgets/${id}/csv/parse`, empty.payload, empty.headers)).statusCode).toBe(400);
    expect((await ekonomi.post(`/budgets/${id}/csv/parse`, { not: "multipart" })).statusCode).toBe(406);
  });

  it("resultaträkningen takes budgetId on JSON, PDF and CSV and refuses the forbidden combinations", async () => {
    const { year, workshop } = await setupEconomy();
    const ekonomi = api(await cookieWith(["ekonomi"], "Ekonom"));
    const id = (await ekonomi.post("/budgets", { fiscalYearId: year.id, name: "B" })).json().id as string;
    await ekonomi.put(`/budgets/${id}/lines`, { costCenterId: null, lines: [{ accountNumber: "3001", amounts: months(1000) }, { accountNumber: "5010", amounts: months(200) }] });
    const series = await testEconomyService.createSeries({ code: "A", name: "Manuella verifikat" });
    const account = async (number: string) => (await testEconomyRepository.findAccountByNumber(number))!.id;
    const booked = await ekonomi.post("/verifications", {
      seriesId: series.id,
      date: `${YEAR}-01-15`,
      description: "Försäljning",
      rows: [
        { accountId: await account("1930"), debit: 800, credit: 0 },
        { accountId: await account("3001"), debit: 0, credit: 800, costCenterId: workshop.id },
      ],
      book: true,
    });
    expect(booked.statusCode).toBe(201);

    const json = await ekonomi.get(`/income-statement?from=${YEAR}-02-01&to=${YEAR}-02-28&budgetId=${id}`);
    expect(json.statusCode).toBe(200);
    expect(json.json()).toMatchObject({
      budget: { id, name: "B", fiscalYearId: year.id },
      accumulatedFrom: `${YEAR}-01-01`,
      result: 0,
      resultBudget: 800,
      resultVariance: -800,
      resultVariancePercent: -100,
      resultAccumulated: 800,
      resultAccumulatedBudget: 1600,
      resultAccumulatedVariance: -800,
      resultAccumulatedVariancePercent: -50,
    });
    expect(json.json().entries.find((e: { key: string }) => e.key === "netSales")).toMatchObject({ amount: 0, budget: 1000, variance: -1000, variancePercent: -100, accumulated: 800, accumulatedBudget: 2000 });

    const filtered = await ekonomi.get(`/income-statement?from=${YEAR}-01-01&to=${YEAR}-01-31&budgetId=${id}&costCenterId=${workshop.id}`);
    expect(filtered.json()).toMatchObject({ result: 800, resultBudget: 0, resultVariancePercent: null });

    const grouped = await ekonomi.get(`/income-statement?from=${YEAR}-02-01&to=${YEAR}-02-28&budgetId=${id}&groupBy=costCenter`);
    expect([grouped.statusCode, grouped.json().code]).toEqual([400, "budget-not-combinable"]);
    const outside = await ekonomi.get(`/income-statement?from=${YEAR - 1}-12-01&to=${YEAR}-02-28&budgetId=${id}`);
    expect([outside.statusCode, outside.json().code]).toEqual([400, "budget-range-outside-year"]);
    const unknown = await ekonomi.get(`/income-statement/csv?from=${YEAR}-02-01&to=${YEAR}-02-28&budgetId=${crypto.randomUUID()}`);
    expect([unknown.statusCode, unknown.json().code]).toEqual([404, "budget-not-found"]);

    const pdf = await ekonomi.get(`/income-statement/pdf?from=${YEAR}-02-01&to=${YEAR}-02-28&budgetId=${id}`);
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers["content-type"]).toBe("application/pdf");
    const text = pdfText(pdf.rawPayload);
    for (const heading of ["Utfall", "Budget", "Avvikelse", "Avvikelse %", "Utfall ack.", "Budget ack.", "Avvikelse ack.", "Budget B", "3001"]) expect(text).toContain(heading);
    const januaryPdf = await ekonomi.get(`/income-statement/pdf?from=${YEAR}-01-01&to=${YEAR}-01-31&budgetId=${id}`);
    expect(pdfText(januaryPdf.rawPayload)).not.toContain("Utfall ack.");

    const csv = await ekonomi.get(`/income-statement/csv?from=${YEAR}-02-01&to=${YEAR}-02-28&budgetId=${id}`);
    expect(csv.statusCode).toBe(200);
    expect(csv.body.replace(/^﻿/, "").split("\r\n")[0]).toBe("Konto;Benämning;Utfall;Budget;Avvikelse;Avvikelse %;Utfall ack.;Budget ack.;Avvikelse ack.;Avvikelse ack. %");

    // Without budgetId the report is what it always was.
    const plain = await ekonomi.get(`/income-statement?from=${YEAR}-01-01&to=${YEAR}-01-31`);
    expect(plain.json()).not.toHaveProperty("budget");
    expect(plain.json()).not.toHaveProperty("resultBudget");
  });
});

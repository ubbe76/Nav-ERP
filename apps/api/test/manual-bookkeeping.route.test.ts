import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db, permissionGroups } from "@navet/db";
import { buildApp } from "../src/app.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createAuthService } from "../src/modules/auth/service/auth.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { encodeCp437 } from "../src/modules/economy/service/sie-encoding.js";
import { testEconomyRepository, testEconomyService } from "./helpers/services.js";

// The etapp 3 contract through the real app: status codes, response shapes
// and error codes the web is built against — PUT rows, POST with book,
// Kopiera, Spara som mall, verifikatmallar, återkommande verifikat with
// fördelning, and the SIE verification import (multipart with fields).

const authService = createAuthService(createAuthRepository(db), "unused", createAuditRepository(db));
const PASSWORD = "correcthorsebattery";
const TRUNCATE = sql`TRUNCATE sie_verification_imports, recurring_verification_runs, recurring_verifications, verification_template_rows, verification_templates, verification_files, verification_rows, verifications, verification_counters, verification_series, accounting_periods, fiscal_years, accounts, user_settings, audit_log, users CASCADE`;
const DELETE_GROUPS = sql`DELETE FROM permission_groups WHERE code LIKE 'MBK%'`;

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

async function login(email: string) {
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PASSWORD } });
  expect(res.statusCode).toBe(200);
  return `session=${res.cookies.find((c) => c.name === "session")!.value}`;
}

async function ekonomiCookie() {
  const [group] = await db
    .insert(permissionGroups)
    .values({ code: `MBK${crypto.randomUUID().slice(0, 6)}`, name: "Ekonomi", permissions: ["ekonomi"] })
    .returning();
  const email = `ekonomi-${crypto.randomUUID()}@example.com`;
  await authService.createUser({ email, password: PASSWORD, name: "Ekonom", role: "user", permissionGroupId: group!.id });
  return login(email);
}

async function officeCookie() {
  const [group] = await db
    .insert(permissionGroups)
    .values({ code: `MBK${crypto.randomUUID().slice(0, 6)}`, name: "Inköp", permissions: ["inkop"] })
    .returning();
  const email = `inkop-${crypto.randomUUID()}@example.com`;
  await authService.createUser({ email, password: PASSWORD, name: "Inköpare", role: "user", permissionGroupId: group!.id });
  return login(email);
}

async function setupEconomy() {
  await testEconomyService.createFiscalYear({ label: String(YEAR), startDate: `${YEAR}-01-01`, endDate: `${YEAR}-12-31` });
  const series = await testEconomyService.createSeries({ code: "A", name: "Manuella verifikat" });
  const bank = await testEconomyService.createAccount({ number: "1930", name: "Företagskonto" });
  const revenue = await testEconomyService.createAccount({ number: "3001", name: "Försäljning" });
  await testEconomyService.createAccount({ number: "1790", name: "Förutbetalda kostnader" });
  await testEconomyService.createAccount({ number: "5010", name: "Lokalhyra" });
  return { series, bank, revenue };
}

function api(cookie: string) {
  return {
    get: (url: string) => app.inject({ method: "GET", url: `/api/v1${url}`, headers: { cookie } }),
    post: (url: string, payload?: unknown) => app.inject({ method: "POST", url: `/api/v1${url}`, headers: { cookie }, payload }),
    put: (url: string, payload?: unknown) => app.inject({ method: "PUT", url: `/api/v1${url}`, headers: { cookie }, payload }),
    patch: (url: string, payload?: unknown) => app.inject({ method: "PATCH", url: `/api/v1${url}`, headers: { cookie }, payload }),
    delete: (url: string) => app.inject({ method: "DELETE", url: `/api/v1${url}`, headers: { cookie } }),
  };
}

// A hand-built multipart body: text fields first, then the file.
function multipart(fields: Record<string, string>, file: { name: string; data: Buffer }) {
  const boundary = `----nav${crypto.randomUUID().replace(/-/g, "")}`;
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  parts.push(
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    file.data,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  );
  return { payload: Buffer.concat(parts), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

describe("verifications: PUT rows, book, copy, template", () => {
  it("POST /verifications with book: true answers the booked detail; PUT rows replaces; copy and template answer 201", async () => {
    const { series, bank, revenue } = await setupEconomy();
    const c = api(await ekonomiCookie());

    const draft = await c.post("/verifications", {
      seriesId: series.id,
      date: `${YEAR}-03-10`,
      description: "Utkast",
      rows: [{ accountId: bank.id, debit: 10, credit: 0 }],
    });
    expect(draft.statusCode).toBe(201);
    expect(draft.json().status).toBe("draft");

    const put = await c.put(`/verifications/${draft.json().id}/rows`, {
      rows: [
        { accountId: bank.id, debit: 100, credit: 0, description: "In" },
        { accountId: revenue.id, debit: 0, credit: 100 },
      ],
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().rows.map((r: { accountNumber: string; debit: string }) => [r.accountNumber, Number(r.debit)])).toEqual([
      ["1930", 100],
      ["3001", 0],
    ]);
    expect(put.json().displayNumber).toBe("Utkast");

    const booked = await c.post("/verifications", {
      seriesId: series.id,
      date: `${YEAR}-03-11`,
      description: "Direkt",
      rows: [
        { accountId: bank.id, debit: 50, credit: 0 },
        { accountId: revenue.id, debit: 0, credit: 50 },
      ],
      book: true,
    });
    expect(booked.statusCode).toBe(201);
    expect(booked.json()).toMatchObject({ status: "booked", displayNumber: `A-${YEAR}-1` });

    const unbalanced = await c.post("/verifications", {
      seriesId: series.id,
      date: `${YEAR}-03-11`,
      description: "Fel",
      rows: [
        { accountId: bank.id, debit: 50, credit: 0 },
        { accountId: revenue.id, debit: 0, credit: 40 },
      ],
      book: true,
    });
    expect(unbalanced.statusCode).toBe(409);
    expect(unbalanced.json().code).toBe("unbalanced-verification");

    const lockedRows = await c.put(`/verifications/${booked.json().id}/rows`, { rows: [] });
    expect(lockedRows.statusCode).toBe(409);
    expect(lockedRows.json().code).toBe("invalid-verification-state");

    const copy = await c.post(`/verifications/${booked.json().id}/copy`);
    expect(copy.statusCode).toBe(201);
    expect(copy.json().warnings).toEqual([]);
    expect(copy.json().verification).toMatchObject({ status: "draft", description: "Direkt", seriesId: series.id });
    expect(copy.json().verification.rows).toHaveLength(2);

    const template = await c.post(`/verifications/${booked.json().id}/template`, { name: "Direktmall" });
    expect(template.statusCode).toBe(201);
    expect(template.json()).toMatchObject({ name: "Direktmall", seriesCode: "A", description: "Direkt", active: true });
    expect(template.json().rows.map((r: { accountNumber: string; debit: number | null; credit: number | null }) => [r.accountNumber, r.debit, r.credit])).toEqual([
      ["1930", 50, null],
      ["3001", null, 50],
    ]);
    const taken = await c.post(`/verifications/${booked.json().id}/template`, { name: "Direktmall" });
    expect(taken.statusCode).toBe(409);
    expect(taken.json().code).toBe("verification-template-name-taken");

    expect((await c.put(`/verifications/${crypto.randomUUID()}/rows`, { rows: [] })).statusCode).toBe(404);
    expect((await c.post(`/verifications/${crypto.randomUUID()}/copy`)).statusCode).toBe(404);
  });

  it("keeps the routes behind Ekonomi", async () => {
    await setupEconomy();
    const other = api(await officeCookie());
    expect((await other.get("/verification-templates")).statusCode).toBe(403);
    expect((await other.get("/recurring-verifications")).statusCode).toBe(403);
    expect((await other.put(`/verifications/${crypto.randomUUID()}/rows`, { rows: [] })).statusCode).toBe(403);
  });
});

describe("verification templates", () => {
  it("CRUD with the contract's shapes and codes", async () => {
    const { series } = await setupEconomy();
    const c = api(await ekonomiCookie());

    const created = await c.post("/verification-templates", {
      name: "Hyra",
      seriesId: series.id,
      description: "Lokalhyra",
      rows: [
        { accountNumber: "5010", debit: 8000, description: "Hyra" },
        { accountNumber: "1930", credit: 8000 },
        { accountNumber: "1790" },
      ],
    });
    expect(created.statusCode).toBe(201);
    const template = created.json();
    expect(template).toMatchObject({ name: "Hyra", seriesId: series.id, seriesCode: "A", description: "Lokalhyra", active: true });
    expect(typeof template.createdAt).toBe("string");
    expect(template.rows[0]).toEqual({ id: expect.any(String), accountNumber: "5010", accountName: "Lokalhyra", description: "Hyra", debit: 8000, credit: null, sortOrder: 0 });
    expect(template.rows[2]).toMatchObject({ accountNumber: "1790", debit: null, credit: null });

    const list = await c.get("/verification-templates");
    expect(list.json()).toMatchObject({ total: 1 });
    expect(list.json().rows[0].rows).toHaveLength(3);
    expect((await c.get(`/verification-templates/${template.id}`)).json().id).toBe(template.id);

    const dup = await c.post("/verification-templates", { name: "Hyra", seriesId: series.id, description: "x", rows: [] });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().code).toBe("verification-template-name-taken");

    const missing = await c.post("/verification-templates", { name: "Y", seriesId: series.id, description: "x", rows: [{ accountNumber: "9999", debit: 1 }] });
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject({ code: "verification-template-account-missing", accounts: ["9999"] });

    const both = await c.post("/verification-templates", { name: "Z", seriesId: series.id, description: "x", rows: [{ accountNumber: "1930", debit: 1, credit: 1 }] });
    expect(both.statusCode).toBe(400);

    const patched = await c.patch(`/verification-templates/${template.id}`, { active: false, rows: [{ accountNumber: "1930", debit: 1 }] });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().active).toBe(false);
    expect(patched.json().rows).toHaveLength(1);
    expect((await c.get("/verification-templates")).json().total).toBe(0);
    expect((await c.get("/verification-templates?includeInactive=true")).json().total).toBe(1);

    expect((await c.delete(`/verification-templates/${template.id}`)).statusCode).toBe(204);
    expect((await c.get(`/verification-templates/${template.id}`)).statusCode).toBe(404);
  });
});

describe("recurring verifications", () => {
  it("create, list, detail, patch, run, delete — and the in-use guard on the template", async () => {
    const { series } = await setupEconomy();
    const c = api(await ekonomiCookie());
    const template = (
      await c.post("/verification-templates", {
        name: "Hyra",
        seriesId: series.id,
        description: "Lokalhyra",
        rows: [
          { accountNumber: "5010", debit: 8000 },
          { accountNumber: "1930", credit: 8000 },
        ],
      })
    ).json();

    // Starts last month, so exactly one month is due at once (day 1).
    const lastMonth = new Date(Date.UTC(YEAR, new Date().getMonth() - 1, 1)).toISOString().slice(0, 7);
    const created = await c.post("/recurring-verifications", { templateId: template.id, dayOfMonth: 1, startMonth: lastMonth, mode: "draft" });
    expect(created.statusCode).toBe(201);
    const post = created.json();
    expect(post).toMatchObject({
      templateId: template.id,
      templateName: "Hyra",
      description: "Lokalhyra",
      dayOfMonth: 1,
      startMonth: lastMonth,
      endMonth: null,
      mode: "draft",
      active: true,
      kind: "template",
      allocation: null,
    });
    expect(post.runs.length).toBeGreaterThanOrEqual(1);
    expect(post.runs[post.runs.length - 1]).toMatchObject({ month: lastMonth, status: "created", error: null, verificationDisplayNumber: null });
    expect(typeof post.runs[0].verificationId).toBe("string");
    expect(post.lastRun).toMatchObject({ status: "created" });
    expect(post.failedCount).toBe(0);
    expect(typeof post.nextRunMonth).toBe("string");
    expect(post.nextRunDate).toMatch(/^\d{4}-\d{2}-01$/);

    const list = await c.get("/recurring-verifications");
    expect(list.json().total).toBe(1);
    expect(list.json().rows[0].id).toBe(post.id);
    expect(list.json().rows[0].runs).toBeUndefined();

    const inUse = await c.delete(`/verification-templates/${template.id}`);
    expect(inUse.statusCode).toBe(409);
    expect(inUse.json().code).toBe("verification-template-in-use");

    const patched = await c.patch(`/recurring-verifications/${post.id}`, { active: false, dayOfMonth: "last", mode: "book", endMonth: null });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ active: false, dayOfMonth: "last", mode: "book", nextRunMonth: null });

    const run = await c.post(`/recurring-verifications/${post.id}/run`);
    expect(run.statusCode).toBe(200);
    expect(run.json()).toEqual({ created: expect.any(Array), failed: expect.any(Array) });

    const incomplete = await c.post("/recurring-verifications", {
      templateId: (await c.post("/verification-templates", { name: "Tom", seriesId: series.id, description: "x", rows: [{ accountNumber: "1930" }, { accountNumber: "5010", debit: 1 }] })).json().id,
      dayOfMonth: 1,
      startMonth: lastMonth,
    });
    expect(incomplete.statusCode).toBe(400);
    expect(incomplete.json()).toMatchObject({ code: "recurring-template-incomplete", reason: expect.stringContaining("saknar belopp") });

    expect((await c.post("/recurring-verifications", { templateId: template.id, dayOfMonth: 29, startMonth: lastMonth })).statusCode).toBe(400);
    expect((await c.post("/recurring-verifications", { templateId: crypto.randomUUID(), dayOfMonth: 1, startMonth: lastMonth })).statusCode).toBe(404);

    expect((await c.delete(`/recurring-verifications/${post.id}`)).statusCode).toBe(204);
    expect((await c.get(`/recurring-verifications/${post.id}`)).statusCode).toBe(404);
    expect((await c.get(`/recurring-verifications/${post.id}`)).json().code).toBe("recurring-verification-not-found");
  });

  it("POST /recurring-verifications/allocation answers the Recurring with its schedule", async () => {
    const { series } = await setupEconomy();
    const c = api(await ekonomiCookie());
    const res = await c.post("/recurring-verifications/allocation", {
      amount: 1000,
      kind: "cost",
      balanceAccount: "1790",
      resultAccount: "5010",
      firstMonth: `${YEAR + 1}-01`,
      months: 3,
      description: "Försäkring",
      seriesId: series.id,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      kind: "allocation",
      mode: "book",
      dayOfMonth: "last",
      startMonth: `${YEAR + 1}-01`,
      endMonth: `${YEAR + 1}-03`,
      description: "Försäkring",
      allocation: { amount: 1000, kind: "cost", balanceAccount: "1790", resultAccount: "5010", months: 3, scheduleAmounts: [333.33, 333.33, 333.34] },
      failedCount: 0,
    });
    // Nothing due yet (next year) — no runs.
    expect(res.json().runs).toEqual([]);

    const bad = await c.post("/recurring-verifications/allocation", {
      amount: 1000,
      kind: "cost",
      balanceAccount: "1799",
      resultAccount: "5010",
      firstMonth: `${YEAR + 1}-01`,
      months: 3,
      description: "x",
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ code: "verification-template-account-missing", accounts: ["1799"] });
    expect((await c.post("/recurring-verifications/allocation", { amount: 0, kind: "cost", balanceAccount: "1790", resultAccount: "5010", firstMonth: `${YEAR + 1}-01`, months: 3, description: "x" })).statusCode).toBe(400);
  });
});

describe("SIE verification import", () => {
  const file = () =>
    encodeCp437(
      [
        "#FLAGGA 0",
        '#PROGRAM "Lönesystemet" 2.4',
        `#RAR 0 ${YEAR}0101 ${YEAR}1231`,
        '#KONTO 7210 "Löner tjänstemän"',
        `#VER "LÖ" "1" ${YEAR}0325 "Lön mars"`,
        "{",
        "#TRANS 7210 {} 100.00",
        "#TRANS 1930 {} -100.00",
        "}",
        "",
      ].join("\r\n")
    );

  it("preview and import with multipart fields, the duplicate and the blocked answer", async () => {
    await setupEconomy();
    const cookie = await ekonomiCookie();

    const previewBody = multipart({}, { name: "lon.se", data: file() });
    const preview = await app.inject({ method: "POST", url: "/api/v1/sie/verifications/preview", headers: { cookie, ...previewBody.headers }, payload: previewBody.payload });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({
      fileName: "lon.se",
      program: "Lönesystemet 2.4",
      alreadyImported: null,
      missingAccounts: [{ number: "7210", name: "Löner tjänstemän" }],
      blockers: [],
    });
    expect(preview.json().sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(preview.json().verifications[0]).toMatchObject({ index: 0, series: "LÖ", number: "1", date: `${YEAR}-03-25`, text: "Lön mars", debit: 100, credit: 100, balanced: true });
    expect(preview.json().verifications[0].rows[1]).toEqual({ accountNumber: "1930", accountName: "Företagskonto", amount: -100, description: null, transDate: null });

    const blocked = multipart({ mode: "draft", createMissingAccounts: "false" }, { name: "lon.se", data: file() });
    const blockedRes = await app.inject({ method: "POST", url: "/api/v1/sie/verifications/import", headers: { cookie, ...blocked.headers }, payload: blocked.payload });
    expect(blockedRes.statusCode).toBe(409);
    expect(blockedRes.json()).toMatchObject({ code: "sie-verification-import-blocked", blockers: [expect.stringContaining("7210")] });

    const ok = multipart({ mode: "book", createMissingAccounts: "true" }, { name: "lon.se", data: file() });
    const okRes = await app.inject({ method: "POST", url: "/api/v1/sie/verifications/import", headers: { cookie, ...ok.headers }, payload: ok.payload });
    expect(okRes.statusCode).toBe(201);
    expect(okRes.json()).toEqual({
      imported: 1,
      verifications: [{ id: expect.any(String), displayNumber: `LÖ-${YEAR}-1`, date: `${YEAR}-03-25`, description: "Lön mars (SIE-import ver LÖ 1)" }],
    });

    const again = multipart({ mode: "draft", createMissingAccounts: "true" }, { name: "lon.se", data: file() });
    const againRes = await app.inject({ method: "POST", url: "/api/v1/sie/verifications/import", headers: { cookie, ...again.headers }, payload: again.payload });
    expect(againRes.statusCode).toBe(409);
    expect(againRes.json()).toMatchObject({ code: "sie-file-already-imported", importedBy: "Ekonom" });
    expect(typeof againRes.json().importedAt).toBe("string");

    const previewAgain = await app.inject({ method: "POST", url: "/api/v1/sie/verifications/preview", headers: { cookie, ...again.headers }, payload: again.payload });
    expect(previewAgain.json().alreadyImported).toMatchObject({ importedBy: "Ekonom" });

    const noFile = await app.inject({ method: "POST", url: "/api/v1/sie/verifications/preview", headers: { cookie, "content-type": "multipart/form-data; boundary=x" }, payload: "--x--\r\n" });
    expect(noFile.statusCode).toBe(400);
  });
});

void testEconomyRepository;

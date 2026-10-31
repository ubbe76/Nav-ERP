import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { accountingPeriods, accounts, db, fiscalYears, permissionGroups, yearEndClosings } from "@navet/db";
import { buildApp } from "../src/app.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createAuthService } from "../src/modules/auth/service/auth.service.js";
import { DEFAULT_POSTING_SETTINGS, testEconomyService } from "./helpers/services.js";
import {
  YEAR,
  accountId,
  buildYearEndApp,
  buildYearEndService,
  countVerifications,
  prepareClosableYear,
  resetYearEnd,
  setupUserAndAccounts,
  setupYearEnd,
  waitForLockWaiter,
} from "./helpers/year-end.js";

// Never TRUNCATE permission_groups: the migration's seed rows (ALLA, VERKSTAD)
// must survive for every later test file.
async function reset() {
  await resetYearEnd();
  await db.execute(sql`DELETE FROM permission_groups WHERE code NOT IN ('ALLA', 'VERKSTAD')`);
}

beforeEach(reset);
afterAll(reset);

describe("year-end-closings routes", () => {
  it("201s a closing, 409s a duplicate, 404s an unknown id, 400s a bad date and a bad body", async () => {
    const { user, yearId } = await setupYearEnd();
    const app = buildYearEndApp(user.id);
    const created = await app.inject({ method: "POST", url: "/year-end-closings", payload: { fiscalYearId: yearId } });
    expect(created.statusCode).toBe(201);
    expect(created.json().closingDate).toBe(`${YEAR}-12-31`);

    const duplicate = await app.inject({ method: "POST", url: "/year-end-closings", payload: { fiscalYearId: yearId } });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().code).toBe("year-end-closing-exists");

    const missing = await app.inject({ url: `/year-end-closings/${crypto.randomUUID()}` });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().code).toBe("year-end-closing-not-found");

    const badDate = await app.inject({
      method: "PATCH",
      url: `/year-end-closings/${created.json().id}`,
      payload: { closingDate: `${YEAR}-06-30` },
    });
    expect(badDate.statusCode).toBe(400);
    expect(badDate.json().code).toBe("invalid-closing-date");

    const empty = await app.inject({ method: "POST", url: "/year-end-closings", payload: {} });
    expect(empty.statusCode).toBe(400);
    expect(empty.json().code).toBe("validation-failed");

    const list = await app.inject({ url: `/year-end-closings?fiscalYearId=${yearId}` });
    expect(list.json()).toMatchObject({ total: 1, rows: [{ fiscalYearLabel: String(YEAR), status: "in_progress" }] });
    await app.close();
  });

  it("409s fiscal-year-last-period-missing for a year without a period for its last day", async () => {
    const { user, yearId } = await setupYearEnd();
    const app = buildYearEndApp(user.id);
    const created = await app.inject({ method: "POST", url: "/year-end-closings", payload: { fiscalYearId: yearId } });
    await db.delete(accountingPeriods).where(and(eq(accountingPeriods.fiscalYearId, yearId), eq(accountingPeriods.startDate, `${YEAR}-12-01`)));
    const response = await app.inject({ url: `/year-end-closings/${created.json().id}` });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("fiscal-year-last-period-missing");
    await app.close();
  });

  it("400s a malformed :id with validation-failed (id guard)", async () => {
    const { user } = await setupYearEnd();
    const app = buildYearEndApp(user.id);
    for (const res of [
      await app.inject({ url: "/year-end-closings/not-a-uuid" }),
      await app.inject({ method: "PATCH", url: "/year-end-closings/not-a-uuid", payload: { closingDate: `${YEAR}-12-31` } }),
      await app.inject({ method: "POST", url: "/year-end-closings/not-a-uuid/depreciation" }),
      await app.inject({ method: "PUT", url: "/year-end-closings/not-a-uuid/accruals", payload: { rows: [] } }),
      await app.inject({ url: "/year-end-closings/not-a-uuid/result-transfer-preview" }),
      await app.inject({ method: "POST", url: "/year-end-closings/not-a-uuid/result-transfer" }),
      await app.inject({ method: "POST", url: "/year-end-closings/not-a-uuid/close" }),
      await app.inject({ method: "POST", url: "/year-end-closings/not-a-uuid/reopen", payload: { reason: "Rättelse behövs" } }),
    ]) {
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe("validation-failed");
    }
    await app.close();
  });

  it("403s every route for a profile without Ekonomi and writes nothing", async () => {
    const { user, yearId } = await setupYearEnd();
    const app = buildYearEndApp(user.id, { profile: { role: "user", permissions: ["inkop", "forsaljning"] } });
    const id = crypto.randomUUID();
    for (const res of [
      await app.inject({ url: "/year-end-closings" }),
      await app.inject({ method: "POST", url: "/year-end-closings", payload: { fiscalYearId: yearId } }),
      await app.inject({ url: `/year-end-closings/${id}` }),
      await app.inject({ method: "PATCH", url: `/year-end-closings/${id}`, payload: { closingDate: `${YEAR}-12-31` } }),
      await app.inject({ url: `/year-end-closings/${id}/inventory-preview` }),
      await app.inject({ method: "POST", url: `/year-end-closings/${id}/inventory`, payload: { method: "standard" } }),
      await app.inject({ method: "POST", url: `/year-end-closings/${id}/depreciation` }),
      await app.inject({ method: "PUT", url: `/year-end-closings/${id}/accruals`, payload: { rows: [] } }),
      await app.inject({ url: `/year-end-closings/${id}/result-transfer-preview` }),
      await app.inject({ method: "POST", url: `/year-end-closings/${id}/result-transfer` }),
      await app.inject({ method: "POST", url: `/year-end-closings/${id}/close` }),
      await app.inject({ method: "POST", url: `/year-end-closings/${id}/reopen`, payload: { reason: "Rättelse behövs" } }),
    ]) {
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe("forbidden");
    }
    expect(await db.select().from(yearEndClosings)).toEqual([]);
    await app.close();
  });

  it("409s year-end-blocked when a draft lies in the year", async () => {
    const { user, yearId } = await setupYearEnd();
    const app = buildYearEndApp(user.id);
    const created = await app.inject({ method: "POST", url: "/year-end-closings", payload: { fiscalYearId: yearId } });
    const series = await testEconomyService.createSeries({ code: "A", name: "Manuella" });
    await testEconomyService.createVerification({ seriesId: series.id, date: `${YEAR}-04-01`, description: "Utkast", rows: [] }, user.id);
    const res = await app.inject({ method: "POST", url: `/year-end-closings/${created.json().id}/inventory`, payload: { method: "standard" } });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("year-end-blocked");
    const bad = await app.inject({ method: "POST", url: `/year-end-closings/${created.json().id}/inventory`, payload: { method: "fifo" } });
    expect(bad.statusCode).toBe(400);
    await app.close();
  });

  it("serves the inventory preview and 409s inventory-account-conflict", async () => {
    const { user, yearId } = await setupYearEnd();
    const app = buildYearEndApp(user.id);
    const created = await app.inject({ method: "POST", url: "/year-end-closings", payload: { fiscalYearId: yearId } });
    const preview = await app.inject({ url: `/year-end-closings/${created.json().id}/inventory-preview?method=standard` });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({ asOf: `${YEAR}-12-31`, method: "standard", value: 0, difference: 0, rows: [] });
    const badMethod = await app.inject({ url: `/year-end-closings/${created.json().id}/inventory-preview?method=fifo` });
    expect(badMethod.statusCode).toBe(400);

    const conflicting = buildYearEndApp(user.id, {
      // Something to value: a zero valuation on an empty 1460 completes the
      // step without touching the accounts (a company without stock).
      service: buildYearEndService({
        settings: { read: async () => ({ ...DEFAULT_POSTING_SETTINGS, postingInventoryChange: "1460" }) },
        inventory: { getValuation: async () => ({ totalValue: 1000, unvaluedCount: 0, groups: [] }) },
      }),
    });
    const res = await conflicting.inject({ method: "POST", url: `/year-end-closings/${created.json().id}/inventory`, payload: { method: "standard" } });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("inventory-account-conflict");
    await app.close();
    await conflicting.close();
  });

  it("POST /depreciation 200s unchanged with nothing in the register", async () => {
    const { user, yearId } = await setupYearEnd();
    const app = buildYearEndApp(user.id);
    const created = await app.inject({ method: "POST", url: "/year-end-closings", payload: { fiscalYearId: yearId } });
    const res = await app.inject({ method: "POST", url: `/year-end-closings/${created.json().id}/depreciation` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ unchanged: true, run: null });
    await app.close();
  });

  it("PUT /accruals 400s a wrong account class and 200s an empty set", async () => {
    const { user, yearId } = await setupYearEnd();
    const app = buildYearEndApp(user.id);
    const created = await app.inject({ method: "POST", url: "/year-end-closings", payload: { fiscalYearId: yearId } });
    const url = `/year-end-closings/${created.json().id}/accruals`;
    const wrong = await app.inject({
      method: "PUT",
      url,
      payload: { rows: [{ kind: "prepaid_expense", balanceAccountId: await accountId("2990"), resultAccountId: await accountId("5010"), amount: 100, description: "Fel sida" }] },
    });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().code).toBe("invalid-accrual-account");
    const empty = await app.inject({ method: "PUT", url, payload: { rows: [] } });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toMatchObject({ unchanged: false, verification: null });
    await app.close();
  });

  it("PUT /accruals 400s an amount that rounds to 0,00", async () => {
    const { user, yearId } = await setupYearEnd();
    const app = buildYearEndApp(user.id);
    const created = await app.inject({ method: "POST", url: "/year-end-closings", payload: { fiscalYearId: yearId } });
    const res = await app.inject({
      method: "PUT",
      url: `/year-end-closings/${created.json().id}/accruals`,
      payload: { rows: [{ kind: "prepaid_expense", balanceAccountId: await accountId("1710"), resultAccountId: await accountId("5010"), amount: 0.001, description: "Avrundas bort" }] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("validation-failed");
    expect(await countVerifications("BS")).toBe(0);
    await app.close();
  });

  it("close 409s year-end-blocked; reopen 400s a short reason and 409s an open closing", async () => {
    const { user, yearId } = await setupYearEnd();
    const app = buildYearEndApp(user.id);
    const created = await app.inject({ method: "POST", url: "/year-end-closings", payload: { fiscalYearId: yearId } });
    const id = created.json().id;
    const close = await app.inject({ method: "POST", url: `/year-end-closings/${id}/close` });
    expect(close.statusCode).toBe(409);
    expect(close.json().code).toBe("year-end-blocked");
    const short = await app.inject({ method: "POST", url: `/year-end-closings/${id}/reopen`, payload: { reason: "kort" } });
    expect(short.statusCode).toBe(400);
    const notClosed = await app.inject({ method: "POST", url: `/year-end-closings/${id}/reopen`, payload: { reason: "Rättelse behövs" } });
    expect(notClosed.statusCode).toBe(409);
    expect(notClosed.json().code).toBe("year-end-closing-not-closed");
    await app.close();
  });

  // The Bokslut page renders on this contract: a missing/inactive 8999 or
  // 2099 is a 409 missing-posting-account, which the page turns into a hint.
  it("409s the result-transfer preview with missing-posting-account when 8999 is inactive", async () => {
    const { user } = await setupUserAndAccounts();
    const service = buildYearEndService();
    const app = buildYearEndApp(user.id, { service });
    const { closingId } = await prepareClosableYear(service, user.id, { revenue: 100000, cost: 40000 });
    await db.update(accounts).set({ active: false }).where(eq(accounts.number, "8999"));

    const preview = await app.inject({ url: `/year-end-closings/${closingId}/result-transfer-preview` });
    expect(preview.statusCode).toBe(409);
    expect(preview.json().code).toBe("missing-posting-account");
    await app.close();
  });

  it("serves the result-transfer preview, then transfers, closes and reopens", async () => {
    const { user } = await setupUserAndAccounts();
    const service = buildYearEndService();
    const app = buildYearEndApp(user.id, { service });
    const { closingId } = await prepareClosableYear(service, user.id, { revenue: 100000, cost: 40000 });

    const preview = await app.inject({ url: `/year-end-closings/${closingId}/result-transfer-preview` });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({
      status: "not_done",
      yearResult: 60000,
      rows: [
        { accountNumber: "8999", debit: 60000, credit: 0 },
        { accountNumber: "2099", debit: 0, credit: 60000 },
      ],
    });

    const transfer = await app.inject({ method: "POST", url: `/year-end-closings/${closingId}/result-transfer` });
    expect(transfer.statusCode).toBe(200);
    expect(transfer.json()).toMatchObject({ unchanged: false, net: 60000, verification: { displayNumber: `BS-${YEAR}-1` } });
    const closed = await app.inject({ method: "POST", url: `/year-end-closings/${closingId}/close` });
    expect(closed.statusCode).toBe(200);
    expect(closed.json()).toMatchObject({ status: "closed", fiscalYear: { status: "closed" } });
    const again = await app.inject({ method: "POST", url: `/year-end-closings/${closingId}/close` });
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe("year-end-closing-closed");
    const reopened = await app.inject({ method: "POST", url: `/year-end-closings/${closingId}/reopen`, payload: { reason: "Rättelse behövs" } });
    expect(reopened.statusCode).toBe(200);
    expect(reopened.json()).toMatchObject({ status: "in_progress", steps: { resultTransfer: { status: "not_done" } } });
    await app.close();
  });

  it("POST /result-transfer 409s year-end-step-order before steps 2–4", async () => {
    const { user, yearId } = await setupYearEnd();
    const app = buildYearEndApp(user.id);
    const created = await app.inject({ method: "POST", url: "/year-end-closings", payload: { fiscalYearId: yearId } });
    const early = await app.inject({ method: "POST", url: `/year-end-closings/${created.json().id}/result-transfer` });
    expect(early.statusCode).toBe(409);
    expect(early.json().code).toBe("year-end-step-order");
    await app.close();
  });

  // Review Focus 4 at the HTTP layer: 400 inactive-account, not the poster's 409.
  it("PUT /accruals 400s inactive-account on a re-run with a since-deactivated account", async () => {
    const { user, yearId } = await setupYearEnd();
    const app = buildYearEndApp(user.id);
    const created = await app.inject({ method: "POST", url: "/year-end-closings", payload: { fiscalYearId: yearId } });
    const url = `/year-end-closings/${created.json().id}/accruals`;
    const row = { kind: "accrued_expense", balanceAccountId: await accountId("2990"), resultAccountId: await accountId("5020"), amount: 8400, description: "El december" };
    expect((await app.inject({ method: "PUT", url, payload: { rows: [row] } })).statusCode).toBe(200);
    await testEconomyService.updateAccount(await accountId("5020"), { active: false });
    const res = await app.inject({ method: "PUT", url, payload: { rows: [{ ...row, amount: 9100 }] } });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("inactive-account");
    await app.close();
  });

  it("PUT /accruals 409s next-fiscal-year-missing when the next year overlaps another", async () => {
    const { user, yearId } = await setupYearEnd();
    await testEconomyService.createFiscalYear({ label: "Senare", startDate: `${YEAR + 1}-03-01`, endDate: `${YEAR + 2}-02-28` });
    const app = buildYearEndApp(user.id);
    const created = await app.inject({ method: "POST", url: "/year-end-closings", payload: { fiscalYearId: yearId } });
    const res = await app.inject({
      method: "PUT",
      url: `/year-end-closings/${created.json().id}/accruals`,
      payload: { rows: [{ kind: "prepaid_expense", balanceAccountId: await accountId("1710"), resultAccountId: await accountId("5010"), amount: 100, description: "Hyra" }] },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("next-fiscal-year-missing");
    await app.close();
  });
});

// The real app: registerModule's Ekonomi rule (enforceAccess) and the global
// id guard both reach the new routes.
describe("year-end-closings in the real app", () => {
  const authService = createAuthService(createAuthRepository(db), "unused", createAuditRepository(db));

  async function sessionFor(app: ReturnType<typeof buildApp>, role: "admin" | "user", permissions: string[]) {
    const [group] = await db
      .insert(permissionGroups)
      .values({ code: `T-${crypto.randomUUID().slice(0, 8)}`, name: "T", permissions })
      .returning();
    const email = `p-${crypto.randomUUID()}@example.com`;
    await authService.createUser({ email, password: "correcthorse", name: "P", role, permissionGroupId: group!.id });
    const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: "correcthorse" } });
    return `session=${res.cookies.find((c) => c.name === "session")!.value}`;
  }

  it("serves Ekonomi, 403s other profiles and 400s a malformed id", async () => {
    const app = buildApp();
    await app.ready();
    try {
      const ekonomi = await sessionFor(app, "user", ["ekonomi"]);
      const inkop = await sessionFor(app, "user", ["inkop"]);

      const allowed = await app.inject({ url: "/api/v1/year-end-closings", headers: { cookie: ekonomi } });
      expect(allowed.statusCode).toBe(200);
      expect(allowed.json()).toEqual({ rows: [], total: 0 });

      const denied = await app.inject({ url: "/api/v1/year-end-closings", headers: { cookie: inkop } });
      expect(denied.statusCode).toBe(403);
      expect(denied.json().code).toBe("forbidden");

      const malformed = await app.inject({ url: "/api/v1/year-end-closings/not-a-uuid", headers: { cookie: ekonomi } });
      expect(malformed.statusCode).toBe(400);
      expect(malformed.json().code).toBe("validation-failed");

      const id = crypto.randomUUID();
      for (const res of [
        await app.inject({ url: `/api/v1/year-end-closings/${id}/result-transfer-preview`, headers: { cookie: inkop } }),
        await app.inject({ method: "POST", url: `/api/v1/year-end-closings/${id}/result-transfer`, headers: { cookie: inkop } }),
        await app.inject({ method: "POST", url: `/api/v1/year-end-closings/${id}/close`, headers: { cookie: inkop } }),
        await app.inject({
          method: "POST",
          url: `/api/v1/year-end-closings/${id}/reopen`,
          headers: { cookie: inkop },
          payload: { reason: "Rättelse behövs" },
        }),
      ]) {
        expect(res.statusCode).toBe(403);
        expect(res.json().code).toBe("forbidden");
      }
    } finally {
      await app.close();
    }
  });

  // Spec 3/§12: the closed-year trigger is the last line. A result transfer
  // whose app guard read the year as open, while another transaction is
  // closing it, waits on the trigger's FOR SHARE and is then refused with
  // SQLSTATE NV001 — which the app's error handler turns into 409
  // fiscal-year-closed (the trigger's message says which NV001 it is).
  it("409s fiscal-year-closed when the closed-year trigger refuses a booking", async () => {
    const app = buildApp();
    await app.ready();
    try {
      const { user } = await setupUserAndAccounts();
      const { closingId, yearId } = await prepareClosableYear(buildYearEndService(), user.id, { revenue: 100000, cost: 40000 });
      const ekonomi = await sessionFor(app, "user", ["ekonomi"]);

      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let updated!: () => void;
      const updatedSignal = new Promise<void>((resolve) => (updated = resolve));
      const closer = db.transaction(async (tx) => {
        await tx.update(fiscalYears).set({ status: "closed", closedAt: new Date() }).where(eq(fiscalYears.id, yearId));
        updated();
        await gate;
      });
      await updatedSignal;
      const request = app.inject({ method: "POST", url: `/api/v1/year-end-closings/${closingId}/result-transfer`, headers: { cookie: ekonomi } });
      try {
        await waitForLockWaiter(); // the booking's trigger waits on the year row
      } finally {
        release(); // never leave the closer's row lock behind a failed wait
        await closer;
      }
      const res = await request;
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: "fiscal-year-closed", error: "Räkenskapsåret är stängt — öppna det igen under Bokslut" });
      expect(await countVerifications("BS")).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("profit-disposition 409s on an open closing and undo 404s without a disposition", async () => {
    const { user, yearId } = await setupYearEnd();
    const app = buildYearEndApp(user.id);
    const created = await app.inject({ method: "POST", url: "/year-end-closings", payload: { fiscalYearId: yearId } });
    const id = created.json().id;
    const open = await app.inject({ method: "POST", url: `/year-end-closings/${id}/profit-disposition`, payload: { agmDate: "2025-05-20" } });
    expect(open.statusCode).toBe(409);
    expect(open.json().code).toBe("year-end-closing-not-closed");
    const undo = await app.inject({ method: "POST", url: `/year-end-closings/${id}/profit-disposition/undo` });
    expect(undo.statusCode).toBe(404);
    expect(undo.json().code).toBe("profit-disposition-not-found");
    const badDate = await app.inject({ method: "POST", url: `/year-end-closings/${id}/profit-disposition`, payload: { agmDate: "nope" } });
    expect(badDate.statusCode).toBe(400);
    await app.close();
  });
});

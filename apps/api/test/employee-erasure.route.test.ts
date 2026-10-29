import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, like, sql } from "drizzle-orm";
import { atfTransactions, attendanceSessions, auditLog, db, employees, payrollPeriods, permissionGroups } from "@navet/db";
import { buildApp } from "../src/app.js";
import { erasurePlan } from "../src/modules/timereport/service/employee-erasure-plan.js";
import { withoutFreeText } from "../src/modules/timereport/repository/employee-erasure.js";

// Radera eller anonymisera en anställd (GDPR, #2) through the real app:
// delete without history, anonymize with history once every month with it is
// locked, the blockers, the frozen row (guard triggers, NV002 → 409) and the
// admin-only access.

// permission_groups is NOT truncated (migration seeds) — only the group this
// file creates (code GD…) is removed.
const TRUNCATE = sql`TRUNCATE atf_transactions, attendance_sessions, stamp_sessions, time_reports, absences,
  overtime_dispositions, payroll_attestations, payroll_periods, employees, audit_log, users CASCADE`;
const PASSWORD = "ett-tillräckligt-långt-lösenord";

let app: ReturnType<typeof buildApp>;
let admin: string;

const cookieOf = (res: { cookies: { name: string; value: string }[] }) => res.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
const call = (method: string, url: string, payload?: unknown, cookie = admin) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: { cookie }, ...(payload === undefined ? {} : { payload: payload as never }) });

async function reset() {
  await db.execute(TRUNCATE);
  await db.delete(permissionGroups).where(like(permissionGroups.code, "GD%"));
}

beforeEach(async () => {
  await reset();
  app = buildApp();
  await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: { email: "admin@example.com", password: PASSWORD, name: "Admin", setupCode: app.setup.code.code },
  });
  admin = cookieOf(
    await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "admin@example.com", password: PASSWORD } })
  );
});

afterAll(async () => {
  await reset();
});

async function makeEmployee(employeeNumber: string, active = false) {
  const res = await call("POST", "/employees", {
    employeeNumber,
    name: "Anna Andersson",
    phone: "070-123 45 67",
    email: "anna@example.com",
    address: "Storgatan 1",
    postalCode: "123 45",
    city: "Småstad",
    personalIdentityNumber: "19800101-1234",
    wage: 180,
  });
  expect(res.statusCode).toBe(201);
  const id = res.json().id as string;
  if (!active) expect((await call("PATCH", `/employees/${id}`, { active: false })).statusCode).toBe(200);
  return id;
}

async function lockFebruary(employeeId: string, others: { employeeId: string; name: string }[] = []) {
  const entry = (id: string, number: string, name: string) => ({ employeeId: id, employeeNumber: number, name, employmentType: "hourly", days: [] });
  await db.insert(payrollPeriods).values({
    year: 2026,
    month: 2,
    status: "locked",
    lockedAt: new Date(),
    summary: { year: 2026, month: 2, employees: [entry(employeeId, "502", "Anna Andersson"), ...others.map((o) => entry(o.employeeId, "503", o.name))] },
  });
}

describe("erasurePlan (pure)", () => {
  const facts = { hasHistory: true, openSession: true, openMonths: ["2026-02"] };
  it("deletes without history and anonymizes with it, listing every blocker", () => {
    expect(erasurePlan({ active: false, anonymizedAt: null }, { hasHistory: false, openSession: false, openMonths: [] })).toEqual({
      action: "delete",
      blockers: [],
    });
    expect(erasurePlan({ active: true, anonymizedAt: null }, facts)).toEqual({
      action: "anonymize",
      blockers: [{ code: "active" }, { code: "open-session" }, { code: "open-period", months: ["2026-02"] }],
    });
    expect(erasurePlan({ active: false, anonymizedAt: new Date() }, facts)).toEqual({ action: "anonymized", blockers: [] });
  });

  it("drops free text at every level of an audit detail", () => {
    expect(withoutFreeText({ employeeId: "e", stopNote: "Läkarbesök", before: { note: "x", hours: 1 }, list: [{ startNote: "y" }] })).toEqual({
      employeeId: "e",
      before: { hours: 1 },
      list: [{}],
    });
  });
});

describe("Radera — an employee without history", () => {
  it("deletes an inactive employee and logs only the employee number", async () => {
    const id = await makeEmployee("501");
    expect((await call("GET", `/employees/${id}/erasure`)).json()).toEqual({ action: "delete", blockers: [] });

    const res = await call("DELETE", `/employees/${id}`);
    expect(res.statusCode).toBe(204);
    expect((await call("GET", `/employees/${id}`)).statusCode).toBe(404);

    const [entry] = await db.select().from(auditLog).where(eq(auditLog.entityId, id));
    expect(entry).toMatchObject({ entityType: "employee", action: "deleted", detail: { employeeNumber: "501" } });
    expect(JSON.stringify(entry!.detail)).not.toContain("Anna");
  });

  it("refuses while the employee is active", async () => {
    const id = await makeEmployee("501", true);
    const res = await call("DELETE", `/employees/${id}`);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "employee-erasure-blocked", blockers: [{ code: "active" }] });
  });

  it("refuses an employee with history — that one is anonymized", async () => {
    const id = await makeEmployee("501");
    await db.insert(atfTransactions).values({ employeeId: id, date: "2026-02-10", type: "adjustment", minutes: 60 });
    await lockFebruary(id);
    const res = await call("DELETE", `/employees/${id}`);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("employee-has-history");
  });
});

describe("Anonymisera — an employee with history", () => {
  async function employeeWithHistory() {
    const id = await makeEmployee("502");
    const [session] = await db
      .insert(attendanceSessions)
      .values({
        employeeId: id,
        startedAt: new Date("2026-02-09T06:00:00Z"),
        stoppedAt: new Date("2026-02-09T12:00:00Z"),
        stopNote: "Läkarbesök",
      })
      .returning();
    await db.insert(atfTransactions).values({ employeeId: id, date: "2026-02-10", type: "withdrawal", minutes: 60, note: "Egen anteckning" });
    await db.insert(auditLog).values({
      entityType: "attendance_session",
      entityId: session!.id,
      action: "attendance_stopped",
      detail: { employeeId: id, stopNote: "Läkarbesök", stopReasonId: null },
    });
    return id;
  }

  it("is blocked until every month with history is locked", async () => {
    const id = await employeeWithHistory();
    expect((await call("GET", `/employees/${id}/erasure`)).json()).toEqual({
      action: "anonymize",
      blockers: [{ code: "open-period", months: ["2026-02"] }],
    });
    const res = await call("POST", `/employees/${id}/anonymize`);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "employee-erasure-blocked", blockers: [{ code: "open-period", months: ["2026-02"] }] });
  });

  it("is blocked by an open session", async () => {
    const id = await employeeWithHistory();
    await lockFebruary(id);
    await db.insert(attendanceSessions).values({ employeeId: id, startedAt: new Date("2026-02-20T06:00:00Z") });
    const plan = (await call("GET", `/employees/${id}/erasure`)).json();
    expect(plan.blockers).toContainEqual({ code: "open-session" });
  });

  it("removes the personal data and free text, keeps the history under the number", async () => {
    const id = await employeeWithHistory();
    const other = await call("POST", "/employees", { employeeNumber: "503", name: "Bo Berg" });
    await lockFebruary(id, [{ employeeId: other.json().id, name: "Bo Berg" }]);

    const res = await call("POST", `/employees/${id}/anonymize`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ action: "anonymize" });

    const [row] = await db.select().from(employees).where(eq(employees.id, id));
    expect(row).toMatchObject({
      employeeNumber: "502",
      name: "Anonymiserad anställd",
      active: false,
      phone: null,
      email: null,
      address: null,
      postalCode: null,
      city: null,
      personalIdentityNumber: null,
      wage: null,
    });
    expect(row!.anonymizedAt).not.toBeNull();

    // The history stays, without its free text.
    const sessions = await db.select().from(attendanceSessions).where(eq(attendanceSessions.employeeId, id));
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.stopNote).toBeNull();
    const atf = await db.select().from(atfTransactions).where(eq(atfTransactions.employeeId, id));
    expect(atf).toHaveLength(1);
    expect(atf[0]!).toMatchObject({ minutes: 60, note: null });

    // The frozen payroll basis keeps the number, not the name — and only for this employee.
    const [period] = await db.select().from(payrollPeriods);
    const frozen = (period!.summary as { employees: { employeeNumber: string; name: string }[] }).employees;
    expect(frozen.map((e) => [e.employeeNumber, e.name])).toEqual([
      ["502", "Anonymiserad anställd"],
      ["503", "Bo Berg"],
    ]);

    // The audit trail keeps what happened, not the free text, and logs the anonymization by number.
    const entries = await db.select().from(auditLog).where(sql`${auditLog.detail}->>'employeeId' = ${id} or ${auditLog.entityId} = ${id}`);
    const dump = JSON.stringify(entries);
    expect(dump).not.toContain("Läkarbesök");
    expect(dump).not.toContain("Anna");
    expect(dump).not.toContain("19800101");
    expect(entries.find((e) => e.action === "anonymized")).toMatchObject({ entityType: "employee", detail: { employeeNumber: "502" } });
  });

  it("freezes the employee afterwards", async () => {
    const id = await employeeWithHistory();
    await lockFebruary(id);
    expect((await call("POST", `/employees/${id}/anonymize`)).statusCode).toBe(200);

    const patch = await call("PATCH", `/employees/${id}`, { name: "Anna igen", active: true });
    expect(patch.statusCode).toBe(409);
    expect(patch.json().code).toBe("employee-anonymized");

    // A writer that does not ask first meets the guard trigger.
    const atf = await call("POST", `/employees/${id}/atf-transactions`, { date: "2026-11-02", type: "adjustment", minutes: 30 });
    expect(atf.statusCode).toBe(409);
    expect(atf.json().code).toBe("employee-anonymized");

    expect((await call("POST", `/employees/${id}/anonymize`)).json().code).toBe("employee-anonymized");
    expect((await call("DELETE", `/employees/${id}`)).json().code).toBe("employee-anonymized");
    expect((await call("GET", `/employees/${id}/erasure`)).json()).toEqual({ action: "anonymized", blockers: [] });
  });
});

describe("only admin", () => {
  it("refuses a supervisor with Personal & lön", async () => {
    const id = await makeEmployee("504");
    const [group] = await db
      .insert(permissionGroups)
      .values({ code: `GD${crypto.randomUUID().slice(0, 6)}`, name: "Personal", permissions: ["personal"] })
      .returning();
    const created = await call("POST", "/auth/users", {
      email: "chef@example.com",
      password: PASSWORD,
      name: "Chef",
      role: "supervisor",
      permissionGroupId: group!.id,
    });
    expect(created.statusCode).toBe(201);
    const supervisor = cookieOf(
      await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "chef@example.com", password: PASSWORD } })
    );
    // Personal & lön lets the supervisor read the card…
    expect((await call("GET", `/employees/${id}`, undefined, supervisor)).statusCode).toBe(200);
    // …but never erase.
    expect((await call("GET", `/employees/${id}/erasure`, undefined, supervisor)).statusCode).toBe(403);
    expect((await call("DELETE", `/employees/${id}`, undefined, supervisor)).statusCode).toBe(403);
    expect((await call("POST", `/employees/${id}/anonymize`, undefined, supervisor)).statusCode).toBe(403);
  });
});

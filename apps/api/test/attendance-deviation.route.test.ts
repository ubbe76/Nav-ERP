import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { inArray, sql } from "drizzle-orm";
import { attendanceDeviationReasons, db, permissionGroups, systemSettings } from "@navet/db";
import { buildApp } from "../src/app.js";
import { createAuthService } from "../src/modules/auth/service/auth.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { createScheduleRepository } from "../src/modules/timereport/repository/schedule.repository.js";
import { createTimeReportRepository } from "../src/modules/timereport/repository/timereport.repository.js";
import { createScheduleService } from "../src/modules/timereport/service/schedule.service.js";

// Närvaroavvikelser at the route: the 409 attendance-input-required body the
// terminal turns into its questions, the resend with the answer, and the
// 400s for a bad reason / ATF id. The app runs on the wall clock, so the
// clock (Date only — timers stay real) is pinned to a Wednesday in the
// future: the login session must not have expired against the database's
// own clock.
const DAY = "2030-06-12"; // Wednesday, summer time (UTC+2)
const at = (clock: string) => new Date(`${DAY}T${clock}+02:00`);

const SETTING_KEYS = ["attendance_reason_required", "attendance_reason_tolerance_minutes", "terminal_overtime_choice"];
const TRUNCATE = sql`TRUNCATE attendance_deviation_reasons, attendance_sessions, atf_transactions, overtime_dispositions, employee_day_overrides, day_schedules, stamp_sessions, time_reports, employees, payroll_periods, audit_log, user_settings, users CASCADE`;
const DELETE_GROUPS = sql`DELETE FROM permission_groups WHERE code LIKE 'NAV%'`;

const timeReportRepository = createTimeReportRepository(db);
const scheduleService = createScheduleService(createScheduleRepository(db), timeReportRepository, {
  isDateLocked: async () => false,
});

let savedTz: string | undefined;
beforeAll(() => {
  // The payroll day engine reads schedule clocks in the server's zone — the
  // API container's is Europe/Stockholm.
  savedTz = process.env.TZ;
  process.env.TZ = "Europe/Stockholm";
});

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(at("06:30:00"));
  await db.execute(TRUNCATE);
  await db.execute(DELETE_GROUPS);
  await db.delete(systemSettings).where(inArray(systemSettings.key, SETTING_KEYS));
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  await db.execute(TRUNCATE);
  await db.execute(DELETE_GROUPS);
  await db.delete(systemSettings).where(inArray(systemSettings.key, SETTING_KEYS));
  if (savedTz === undefined) delete process.env.TZ;
  else process.env.TZ = savedTz;
});

describe("närvaroavvikelser at the route", () => {
  const app = buildApp();
  const authService = createAuthService(createAuthRepository(db), "unused", createAuditRepository(db));

  afterAll(async () => {
    await app.close();
  });

  async function terminalCookie() {
    const [group] = await db
      .insert(permissionGroups)
      .values({ code: `NAV${crypto.randomUUID().slice(0, 8)}`, name: "Terminal", permissions: ["terminal"] })
      .returning();
    const email = `t-${crypto.randomUUID()}@example.com`;
    await authService.createUser({ email, password: "correcthorse", name: "T", role: "user", permissionGroupId: group!.id });
    const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: "correcthorse" } });
    return `session=${res.cookies.find((c) => c.name === "session")!.value}`;
  }

  async function setup() {
    await db.insert(systemSettings).values([
      { key: "attendance_reason_required", value: "true" },
      { key: "attendance_reason_tolerance_minutes", value: "0" },
    ]);
    const employee = await timeReportRepository.createEmployee({ employeeNumber: "107", name: "Urban", active: true });
    const daySchedule = await scheduleService.createDaySchedule({
      code: "DAG",
      name: "Dag 07-16",
      startTime: "07:00",
      endTime: "16:00",
      breaks: [],
      active: true,
    });
    await scheduleService.setDayOverride(employee.id, { date: DAY, dayScheduleId: daySchedule.id });
    const [reason] = await db.insert(attendanceDeviationReasons).values({ code: "TRAFIK", name: "Trafik/resa" }).returning();
    return { employee, reason: reason!, cookie: await terminalCookie() };
  }

  it("answers 409 attendance-input-required for a late arrival, then accepts the answer", async () => {
    const { employee, reason, cookie } = await setup();
    const headers = { cookie };
    vi.setSystemTime(at("10:00:00"));

    const asked = await app.inject({ method: "POST", url: "/api/v1/attendance-sessions", headers, payload: { employeeId: employee.id } });
    expect(asked.statusCode).toBe(409);
    expect(asked.json()).toEqual({
      error: expect.any(String),
      code: "attendance-input-required",
      reason: { kind: "late", minutes: 180, scheduledTime: "07:00" },
      overtime: null,
    });

    const ok = await app.inject({
      method: "POST",
      url: "/api/v1/attendance-sessions",
      headers,
      payload: { employeeId: employee.id, reason: { reasonId: reason.id, note: "kö" } },
    });
    expect(ok.statusCode).toBe(201);
    expect([ok.json().startReasonId, ok.json().startNote]).toEqual([reason.id, "kö"]);
  });

  it("asks at Gå hem for an early departure — also an older terminal sending no body", async () => {
    const { employee, reason, cookie } = await setup();
    const headers = { cookie };
    vi.setSystemTime(at("07:00:00"));
    const opened = await app.inject({ method: "POST", url: "/api/v1/attendance-sessions", headers, payload: { employeeId: employee.id } });
    expect(opened.statusCode).toBe(201);
    const url = `/api/v1/attendance-sessions/${opened.json().id}/stop`;

    vi.setSystemTime(at("14:00:00"));
    const asked = await app.inject({ method: "POST", url, headers });
    expect(asked.statusCode).toBe(409);
    expect(asked.json()).toMatchObject({
      code: "attendance-input-required",
      reason: { kind: "early", minutes: 120, scheduledTime: "16:00" },
      overtime: null,
    });

    const ok = await app.inject({ method: "POST", url, headers, payload: { reason: { reasonId: reason.id } } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().session.stopReasonId).toBe(reason.id);
  });

  it("refuses an unknown reason and a foreign ATF id with 400", async () => {
    const { employee, cookie } = await setup();
    const headers = { cookie };
    const badReason = await app.inject({
      method: "POST",
      url: "/api/v1/attendance-sessions",
      headers,
      payload: { employeeId: employee.id, reason: { reasonId: crypto.randomUUID() } },
    });
    expect([badReason.statusCode, badReason.json().code]).toEqual([400, "attendance-reason-invalid"]);

    await db.update(systemSettings).set({ value: "false" }).where(inArray(systemSettings.key, ["attendance_reason_required"]));
    const opened = await app.inject({ method: "POST", url: "/api/v1/attendance-sessions", headers, payload: { employeeId: employee.id } });
    expect(opened.statusCode).toBe(201);
    const badAtf = await app.inject({
      method: "POST",
      url: `/api/v1/attendance-sessions/${opened.json().id}/stop`,
      headers,
      payload: { atfTransactionId: crypto.randomUUID() },
    });
    expect([badAtf.statusCode, badAtf.json().code]).toEqual([400, "atf-transaction-mismatch"]);
  });
});

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, like, sql } from "drizzle-orm";
import { absenceTypes, absences, db, permissionGroups, systemSettings } from "@navet/db";
import { buildApp } from "../src/app.js";

// Utjämning through the real app: the system setting (Tillåt ATF-uttag via
// schemat) in GET/PATCH /settings, the 400 codes on save, and the
// förhandsvisning route.

// permission_groups is NOT truncated: ALLA/VERKSTAD are migration seeds other
// files rely on — only the group this file creates (code TV…) is removed.
const TRUNCATE = sql`TRUNCATE absences, absence_types, employees, week_schedule_days, week_schedules,
  day_schedule_breaks, day_schedules, audit_log, users CASCADE`;
const PASSWORD = "ett-tillräckligt-långt-lösenord";

let app: ReturnType<typeof buildApp>;
let admin: string;

const cookieOf = (res: { cookies: { name: string; value: string }[] }) => res.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
const call = (method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: { cookie: admin }, ...(payload === undefined ? {} : { payload: payload as never }) });

async function reset() {
  await db.execute(TRUNCATE);
  await db.delete(permissionGroups).where(like(permissionGroups.code, "TV%"));
  await db.delete(systemSettings).where(eq(systemSettings.key, "schedule_balancing"));
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

async function weekDays() {
  const day = async (code: string, endTime: string, breaks: unknown[]) => {
    const res = await call("POST", "/day-schedules", { code, name: code, startTime: "07:00", endTime, breaks });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  };
  const monThu = await day("MAN-TOR", "16:15", [
    { type: "unpaid", startTime: "09:00", endTime: "09:20" },
    { type: "unpaid", startTime: "12:00", endTime: "12:40" },
  ]);
  const friday = await day("FREDAG", "12:58", [{ type: "unpaid", startTime: "09:00", endTime: "09:20" }]);
  return [1, 2, 3, 4].map((weekday) => ({ weekday, dayScheduleId: monThu })).concat([{ weekday: 5, dayScheduleId: friday }]);
}

describe("Tillåt ATF-uttag via schemat", () => {
  it("is off by default and set by PATCH /settings", async () => {
    expect((await call("GET", "/settings")).json().scheduleBalancing).toBe(false);
    const patched = await call("PATCH", "/settings", { scheduleBalancing: true });
    expect(patched.statusCode).toBe(200);
    expect((await call("GET", "/settings")).json().scheduleBalancing).toBe(true);
  });

  it("off: saving ordinary time on a week schedule is 400 schedule-balancing-off", async () => {
    const days = await weekDays();
    const res = await call("POST", "/week-schedules", { code: "DAG-ATF", name: "Dag", days, ordinaryMinutesPerWeek: 2400, atfMinutesPerWeek: 82 });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("schedule-balancing-off");
  });

  it("on: saves, and refuses a week that does not add up with a Swedish message", async () => {
    await call("PATCH", "/settings", { scheduleBalancing: true });
    const days = await weekDays();
    const created = await call("POST", "/week-schedules", { code: "DAG-ATF", name: "Dag", days, ordinaryMinutesPerWeek: 2400, atfMinutesPerWeek: 82 });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ ordinaryMinutesPerWeek: 2400, atfMinutesPerWeek: 82 });

    const broken = await call("PATCH", `/week-schedules/${created.json().id}`, { ordinaryMinutesPerWeek: 2000 });
    expect(broken.statusCode).toBe(400);
    expect(broken.json().code).toBe("schedule-balancing-invalid");
    expect(broken.json().error).toContain("en hel vecka skulle fredagen bli");
  });
});

describe("POST /week-schedules/preview", () => {
  it("answers the whole week and the week with a red last day", async () => {
    const days = await weekDays();
    const res = await call("POST", "/week-schedules/preview", { days, ordinaryMinutesPerWeek: 2400, atfMinutesPerWeek: 82 });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.fullWeek.days.find((d: { last: boolean }) => d.last)).toMatchObject({ weekday: 5, endTime: "12:58" });
    expect(body.lastDayHoliday.days.find((d: { last: boolean }) => d.last)).toMatchObject({ weekday: 4, endTime: "14:09" });
  });

  it("is 400 for a week that does not add up", async () => {
    const days = await weekDays();
    const res = await call("POST", "/week-schedules/preview", { days, ordinaryMinutesPerWeek: 2000, atfMinutesPerWeek: 82 });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("schedule-balancing-invalid");
  });
});

describe("GET /employees/:id/schedule-calendar — frånvaro is health data", () => {
  it("only admin/supervisor get a calendar that reflects absence", async () => {
    await call("PATCH", "/settings", { scheduleBalancing: true });
    const days = await weekDays();
    const week = await call("POST", "/week-schedules", { code: "DAG-ATF", name: "Dag", days, ordinaryMinutesPerWeek: 2400, atfMinutesPerWeek: 82 });
    const employee = await call("POST", "/employees", { employeeNumber: "401", name: "Sjuk onsdag" });
    expect(employee.statusCode).toBe(201);
    await call("PATCH", `/employees/${employee.json().id}`, { defaultWeekScheduleId: week.json().id });
    const [sjk] = await db.insert(absenceTypes).values({ code: "SJK", name: "Sjukfrånvaro", paxmlCode: "SJK", earnsAtf: false }).returning();
    await db.insert(absences).values({ employeeId: employee.json().id, absenceTypeId: sjk!.id, date: "2026-11-04", minutes: 495 });
    const url = `/employees/${employee.json().id}/schedule-calendar?from=2026-11-06&to=2026-11-06`;

    const asAdmin = (await call("GET", url)).json()[0];
    expect(asAdmin.daySchedule).toMatchObject({ endTime: "13:14", netMinutes: 354 });
    expect(asAdmin.balance.lostAtfMinutes).toBe(16);

    // An office user with the Tillverkning menu — may read the calendar, not the absence.
    const [group] = await db
      .insert(permissionGroups)
      .values({ code: `TV${crypto.randomUUID().slice(0, 6)}`, name: "Tillverkning", permissions: ["tillverkning"] })
      .returning();
    const created = await call("POST", "/auth/users", {
      email: "verkstad@example.com",
      password: PASSWORD,
      name: "Verkstad",
      role: "user",
      permissionGroupId: group!.id,
    });
    expect(created.statusCode).toBe(201);
    const userCookie = cookieOf(
      await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "verkstad@example.com", password: PASSWORD } })
    );
    const asUser = await app.inject({ method: "GET", url: `/api/v1${url}`, headers: { cookie: userCookie } });
    expect(asUser.statusCode).toBe(200);
    expect(asUser.json()[0].daySchedule).toMatchObject({ endTime: "12:58", netMinutes: 338 });
    expect(asUser.json()[0].balance.lostAtfMinutes).toBe(0);
  });
});

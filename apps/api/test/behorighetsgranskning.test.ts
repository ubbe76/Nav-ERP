import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { attendanceSessions, db, employees, permissionGroups } from "@navet/db";
import { buildApp } from "../src/app.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createAuthService } from "../src/modules/auth/service/auth.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";

// Behörighetsgranskningen 2026-11-10: three places where the gate admitted
// the shop floor (or a plain Tillverkning user) to something that belongs to
// the personnel card.
//  1. ATF: the terminal withdraws (Ta ut ATF), only Personal & lön as
//     admin/supervisor adjusts the balance.
//  2. Närvaro: the terminal reads who is present now, never the history and
//     never the reasons for coming late or leaving early.
//  3. The personnel card's writes (schedule overrides, removing an ATF
//     transaction) take the card's own role, admin/supervisor.

const TRUNCATE = sql`TRUNCATE atf_transactions, attendance_sessions, employee_day_overrides, employee_week_overrides, week_schedule_days, week_schedules, stamp_sessions, time_reports, employees, payroll_periods, audit_log, user_settings, users CASCADE`;
// Only this file's groups — the migration's seeded ALLA and VERKSTAD stay.
const DELETE_GROUPS = sql`DELETE FROM permission_groups WHERE code LIKE 'BG%'`;

const app = buildApp();
const authService = createAuthService(createAuthRepository(db), "unused", createAuditRepository(db));
const FORBIDDEN = { error: "Insufficient permissions", code: "forbidden" };

beforeEach(async () => {
  await db.execute(TRUNCATE);
  await db.execute(DELETE_GROUPS);
});

afterAll(async () => {
  await db.execute(TRUNCATE);
  await db.execute(DELETE_GROUPS);
  await app.close();
});

type Role = "user" | "supervisor" | "admin";

// A real login through the real app, in a group with exactly these permissions.
async function session(role: Role, permissions: string[]) {
  const [group] = await db
    .insert(permissionGroups)
    .values({ code: `BG${crypto.randomUUID().slice(0, 8)}`, name: "Granskning", permissions })
    .returning();
  const email = `bg-${crypto.randomUUID()}@example.com`;
  await authService.createUser({ email, password: "correcthorse", name: "B", role, permissionGroupId: role === "admin" ? null : group!.id });
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: "correcthorse" } });
  return `session=${res.cookies.find((c) => c.name === "session")!.value}`;
}

async function call(cookie: string, method: "GET" | "POST" | "DELETE", url: string, payload?: Record<string, unknown>) {
  const res = await app.inject({ method, url: `/api/v1${url}`, headers: { cookie }, ...(payload ? { payload } : {}) });
  return { status: res.statusCode, body: res.body ? res.json() : null };
}

async function employee() {
  const [row] = await db
    .insert(employees)
    .values({ employeeNumber: `E${crypto.randomUUID().slice(0, 8)}`, name: "Påhittad Person" })
    .returning();
  return row!;
}

const ADJUSTMENT = { date: "2026-11-02", type: "adjustment", minutes: 600 };
const WITHDRAWAL = { date: "2026-11-02", type: "withdrawal", minutes: 60 };

describe("ATF: withdrawal from the terminal, adjustment from the personnel card", () => {
  it("refuses an adjustment from the terminal, from Tillverkning and from Personal & lön without the role", async () => {
    const e = await employee();
    const url = `/employees/${e.id}/atf-transactions`;

    for (const [role, permissions] of [
      ["user", ["terminal"]],
      ["user", ["tillverkning"]],
      // The role alone is not Personal & lön...
      ["supervisor", ["tillverkning"]],
      // ...and Personal & lön alone is not the role.
      ["user", ["personal"]],
    ] as const) {
      const refused = await call(await session(role, [...permissions]), "POST", url, ADJUSTMENT);
      expect([role, permissions, refused.status, refused.body]).toEqual([role, permissions, 403, FORBIDDEN]);
    }
    const written = await db.execute(sql`SELECT 1 FROM atf_transactions`);
    expect(written).toHaveLength(0);
  });

  it("still lets the terminal withdraw (Ta ut ATF)", async () => {
    const e = await employee();
    const made = await call(await session("user", ["terminal"]), "POST", `/employees/${e.id}/atf-transactions`, WITHDRAWAL);
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ type: "withdrawal", minutes: 60 });
  });

  it("lets a supervisor with Personal & lön, and the admin, adjust", async () => {
    const e = await employee();
    const url = `/employees/${e.id}/atf-transactions`;
    const supervisor = await call(await session("supervisor", ["personal"]), "POST", url, ADJUSTMENT);
    expect(supervisor.status).toBe(201);
    expect(supervisor.body).toMatchObject({ type: "adjustment", minutes: 600 });
    const admin = await call(await session("admin", []), "POST", url, { ...ADJUSTMENT, minutes: -30 });
    expect(admin.status).toBe(201);
  });

  it("validates the body before the type check: an empty body is 400 for everyone the gate admits", async () => {
    const e = await employee();
    const res = await call(await session("user", ["terminal"]), "POST", `/employees/${e.id}/atf-transactions`, {});
    expect(res.status).toBe(400);
  });
});

describe("GET /attendance-sessions: present now for the shop floor, history and reasons for Personal & lön", () => {
  const REASON_FIELDS = ["startReasonId", "startNote", "stopReasonId", "stopNote"];

  // One closed attendance (history) and one open, both with a comment.
  async function attendance() {
    const closed = await employee();
    const open = await employee();
    await db.insert(attendanceSessions).values([
      {
        employeeId: closed.id,
        startedAt: new Date("2026-11-02T07:10:00Z"),
        stoppedAt: new Date("2026-11-02T14:00:00Z"),
        startNote: "Bilen startade inte",
        stopNote: "Läkarbesök",
      },
      { employeeId: open.id, startedAt: new Date(Date.now() - 3_600_000), startNote: "Försovning" },
    ]);
    return { closed, open };
  }

  it("refuses the history without Personal & lön", async () => {
    await attendance();
    for (const [role, permissions] of [
      ["user", ["terminal"]],
      ["user", ["tillverkning"]],
      ["supervisor", ["tillverkning"]],
      ["user", ["forsaljning"]],
    ] as const) {
      const cookie = await session(role, [...permissions]);
      for (const url of ["/attendance-sessions", "/attendance-sessions?open=false", "/attendance-sessions?open=1"]) {
        const refused = await call(cookie, "GET", url);
        expect([role, permissions, url, refused.status, refused.body]).toEqual([role, permissions, url, 403, FORBIDDEN]);
      }
    }
  });

  it("gives the terminal the open list without the reason fields", async () => {
    const { open } = await attendance();
    for (const permissions of [["terminal"], ["tillverkning"]]) {
      const res = await call(await session("user", permissions), "GET", "/attendance-sessions?open=true");
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      const [row] = res.body;
      expect(row).toMatchObject({ employeeId: open.id, employeeName: "Påhittad Person", stoppedAt: null });
      for (const field of REASON_FIELDS) expect(row).not.toHaveProperty(field);
    }
  });

  it("gives Personal & lön and the admin the reasons, and the history", async () => {
    await attendance();
    for (const cookie of [await session("user", ["personal"]), await session("supervisor", ["personal"]), await session("admin", [])]) {
      const open = await call(cookie, "GET", "/attendance-sessions?open=true");
      expect(open.status).toBe(200);
      expect(open.body).toHaveLength(1);
      expect(open.body[0]).toMatchObject({ startNote: "Försovning", startReasonId: null, stopReasonId: null, stopNote: null });

      // The history is in the list pattern (tidgranskningen).
      const all = await call(cookie, "GET", "/attendance-sessions");
      expect(all.status).toBe(200);
      expect(all.body.total).toBe(2);
      expect(all.body.rows.map((r: { stopNote: string | null }) => r.stopNote).sort()).toEqual(["Läkarbesök", null].sort());
    }
  });
});

describe("the personnel card's writes take admin/supervisor", () => {
  const NO_ID = "00000000-0000-0000-0000-000000000000";

  it("refuses a plain Tillverkning or Personal & lön user all five", async () => {
    const e = await employee();
    for (const permissions of [["tillverkning"], ["personal"], ["personal", "tillverkning"]]) {
      const cookie = await session("user", permissions);
      const answers = [
        await call(cookie, "POST", `/employees/${e.id}/week-overrides`, { isoYear: 2026, isoWeek: 46, weekScheduleId: NO_ID }),
        await call(cookie, "DELETE", `/employees/${e.id}/week-overrides/${NO_ID}`),
        await call(cookie, "POST", `/employees/${e.id}/day-overrides`, { date: "2026-11-12", dayScheduleId: null }),
        await call(cookie, "DELETE", `/employees/${e.id}/day-overrides/${NO_ID}`),
        await call(cookie, "DELETE", `/employees/${e.id}/atf-transactions/${NO_ID}`),
      ];
      expect([permissions, ...answers.map((a) => a.status)]).toEqual([permissions, 403, 403, 403, 403, 403]);
      for (const a of answers) expect(a.body).toEqual(FORBIDDEN);
    }
    const written = await db.execute(sql`SELECT 1 FROM employee_day_overrides`);
    expect(written).toHaveLength(0);
  });

  it("keeps the terminal out at the gate, whatever the role", async () => {
    const e = await employee();
    const cookie = await session("supervisor", ["terminal"]);
    expect((await call(cookie, "POST", `/employees/${e.id}/day-overrides`, { date: "2026-11-12", dayScheduleId: null })).status).toBe(403);
    expect((await call(cookie, "DELETE", `/employees/${e.id}/atf-transactions/${NO_ID}`)).status).toBe(403);
  });

  it("lets a supervisor write all five from either menu", async () => {
    for (const permissions of [["tillverkning"], ["personal"]]) {
      const e = await employee();
      const cookie = await session("supervisor", permissions);
      // The week schedule register is Tillverkning's — the admin makes it.
      const admin = await session("admin", []);
      const schedule = await call(admin, "POST", "/week-schedules", { code: `V${crypto.randomUUID().slice(0, 6)}`, name: `Vecka ${crypto.randomUUID().slice(0, 6)}` });
      expect(schedule.status).toBe(201);

      const week = await call(cookie, "POST", `/employees/${e.id}/week-overrides`, { isoYear: 2026, isoWeek: 46, weekScheduleId: schedule.body.id });
      expect([permissions, week.status]).toEqual([permissions, 201]);
      expect((await call(cookie, "DELETE", `/employees/${e.id}/week-overrides/${week.body.id}`)).status).toBe(204);

      const day = await call(cookie, "POST", `/employees/${e.id}/day-overrides`, { date: "2026-11-12", dayScheduleId: null });
      expect([permissions, day.status]).toEqual([permissions, 201]);
      expect((await call(cookie, "DELETE", `/employees/${e.id}/day-overrides/${day.body.id}`)).status).toBe(204);

      // A withdrawal is anyone's who may stamp or has Personal & lön;
      // removing it is the card's.
      const withdrawal = await call(cookie, "POST", `/employees/${e.id}/atf-transactions`, WITHDRAWAL);
      expect([permissions, withdrawal.status]).toEqual([permissions, 201]);
      expect((await call(cookie, "DELETE", `/employees/${e.id}/atf-transactions/${withdrawal.body.id}`)).status).toBe(204);
    }
  });
});

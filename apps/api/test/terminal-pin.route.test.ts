import { createArticleSchema, createWorkCenterSchema, TERMINAL_PIN_HEADER } from "@navet/shared";
import type { RouteOptions } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { attendanceSessions, db, employeeTerminalPins, employees, payrollPeriods, permissionGroups } from "@navet/db";
import { buildApp } from "../src/app.js";
import { createAuthService } from "../src/modules/auth/service/auth.service.js";
import { testArticleService, testDocumentPdfService } from "./helpers/services.js";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import { createManufacturingService } from "../src/modules/manufacturing/service/manufacturing.service.js";
import { createTimeReportRepository } from "../src/modules/timereport/repository/timereport.repository.js";
import { createTimeReportService } from "../src/modules/timereport/service/timereport.service.js";
import {
  TERMINAL_PIN_LOCK_MINUTES,
  TERMINAL_PIN_MAX_ATTEMPTS,
  TERMINAL_PIN_PROOF_SECONDS,
} from "../src/modules/timereport/service/terminal-pin.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { isEmployeeAnonymizedViolation } from "../src/modules/system/service/db-errors.js";
import { stockholmToday } from "../src/modules/system/service/delivery-days.js";
import { parsed } from "./helpers/parsed.js";
import { unwiredSalesOrderLinks } from "./helpers/unwired";

// Terminalkod — Kräv kod i stämpelterminalen (migration 0233) through the
// real app: the employee's own code, the spärr, Nollställ terminalkoden and
// the bevistoken the API asks a terminal account for. Every name is made up.

const articleService = createArticleService(createArticleRepository(db));
const authRepo = createAuthRepository(db);
const authService = createAuthService(authRepo, "unused", createAuditRepository(db));
const mfgService = createManufacturingService(createManufacturingRepository(db), testDocumentPdfService, testArticleService, unwiredSalesOrderLinks);
const timeReportService = createTimeReportService(
  createTimeReportRepository(db),
  mfgService,
  { isDateLocked: async () => false },
  { log: async () => {} }
);

const PASSWORD = "correcthorsebattery";
const TRUNCATE = sql`TRUNCATE message_event_targets, messages, conversation_participants, conversations, atf_transactions,
  absences, absence_types, mo_reports, mo_report_materials, attendance_sessions, stamp_sessions, time_reports,
  employee_terminal_pins, employees, mo_material_consumptions, mo_operations, manufacturing_orders, routing_operations,
  work_centers, production_groups, bom_components, articles, payroll_periods, audit_log, user_settings, users CASCADE`;
// Only this file's groups — never TRUNCATE permission_groups (the seeded ones).
const DELETE_GROUPS = sql`DELETE FROM permission_groups WHERE code LIKE 'TPIN%'`;
const SETTING_OFF = sql`DELETE FROM system_settings WHERE key = 'terminal_pin_required'`;

let app: ReturnType<typeof buildApp>;
const routes: RouteOptions[] = [];

beforeAll(async () => {
  app = buildApp();
  app.addHook("onRoute", (route) => {
    routes.push(route);
  });
  await app.ready();
});

beforeEach(async () => {
  await db.execute(TRUNCATE);
  await db.execute(DELETE_GROUPS);
  await db.execute(SETTING_OFF);
});

afterAll(async () => {
  await app.close();
  await db.execute(TRUNCATE);
  await db.execute(DELETE_GROUPS);
  await db.execute(SETTING_OFF);
});

interface Account {
  id: string;
  cookie: string;
}
type Res = Awaited<ReturnType<typeof app.inject>>;

// Every answer this file gets — the leak check at the end reads them all.
const answers: string[] = [];

async function login(email: string) {
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PASSWORD } });
  expect(res.statusCode).toBe(200);
  return `session=${res.cookies.find((c) => c.name === "session")!.value}`;
}

async function makeUser(permissions: string[], opts: { role?: "user" | "supervisor"; readOnly?: boolean } = {}): Promise<Account> {
  const [group] = await db
    .insert(permissionGroups)
    .values({ code: `TPIN${crypto.randomUUID().slice(0, 6)}`, name: "Terminalkod", permissions })
    .returning();
  const email = `tpin-${crypto.randomUUID()}@example.com`;
  const user = await authService.createUser({
    email,
    password: PASSWORD,
    name: "Konto",
    role: opts.role ?? "user",
    permissionGroupId: group!.id,
    readOnly: opts.readOnly ?? false,
  });
  return { id: user.id, cookie: await login(email) };
}

async function makeAdmin(): Promise<Account> {
  const email = `tpin-admin-${crypto.randomUUID()}@example.com`;
  const user = await authService.createUser({ email, password: PASSWORD, name: "Asta Admin", role: "admin" });
  return { id: user.id, cookie: await login(email) };
}

async function makeEmployee(employeeNumber: string, name: string) {
  const [row] = await db.insert(employees).values({ employeeNumber, name, active: true }).returning();
  return row!.id;
}

async function call(account: Account, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown, token?: string): Promise<Res> {
  const res = await app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { cookie: account.cookie, ...(token ? { [TERMINAL_PIN_HEADER]: token } : {}) },
    ...(payload === undefined ? {} : { payload: payload as never }),
  });
  answers.push(res.body);
  return res;
}

const codeOf = (res: Res) => [res.statusCode, (res.json() as { code?: string }).code];
// The guard let the request through: whatever the route then answered, it
// was not the code's refusal (and not a crash).
const pastTheGuard = (res: Res) => res.statusCode < 500 && !/"code":"terminal-pin/.test(res.body);
const settingOn = (admin: Account) => call(admin, "PATCH", "/settings", { terminalPinRequired: true });
const choose = (account: Account, employeeId: string, pin: string) => call(account, "POST", `/employees/${employeeId}/terminal-pin`, { pin });
const verify = (account: Account, employeeId: string, pin: string) => call(account, "POST", `/employees/${employeeId}/terminal-pin/verify`, { pin });
const statusOf = async (account: Account, employeeId: string) =>
  (await call(account, "GET", `/employees/${employeeId}/terminal-pin`)).json() as { pinSet: boolean; lockedUntil: string | null };
const pinRow = async (employeeId: string) => (await db.select().from(employeeTerminalPins).where(eq(employeeTerminalPins.employeeId, employeeId)))[0] ?? null;

async function tokenFor(account: Account, employeeId: string, pin: string) {
  const res = await choose(account, employeeId, pin);
  expect(codeOf(res)).toEqual([201, undefined]);
  return (res.json() as { token: string }).token;
}

// An employee who is present and stamped in on a released TO's operation —
// one request of every kind the terminal makes for an employee. The order
// matters only for the last test, which lets them all through: reads first,
// then the stops, then the stamps that open again.
async function world() {
  const planner = await authRepo.create({ email: `tpin-${crypto.randomUUID()}@example.com`, passwordHash: "x", name: "Planerare", role: "supervisor" });
  const article = await articleService.createArticle(
    parsed(createArticleSchema, { articleNumber: `TP-${crypto.randomUUID()}`, name: "Fäste", type: "manufactured", active: true })
  );
  const workCenter = await mfgService.createWorkCenter(parsed(createWorkCenterSchema, { code: "100", name: "Svets", active: true }));
  await mfgService.createRoutingOperation(article.id, { sequenceNo: 10, workCenterId: workCenter.id, setupTime: 10, runTimePerUnit: 2 });
  const order = await mfgService.createManufacturingOrder({ articleId: article.id, quantity: 5 }, planner.id);
  const [operation] = await mfgService.listOperations(order.id);
  const employee = await makeEmployee("107", "Bo Berg");
  const other = await makeEmployee("208", "Cia Ceder");
  const stamp = await timeReportService.stampIn({ employeeId: employee, moOperationId: operation!.id }, planner.id);
  const [attendance] = await db.select().from(attendanceSessions).where(eq(attendanceSessions.employeeId, employee));
  const today = stockholmToday();
  const requests: [method: "GET" | "POST", url: string, payload?: unknown][] = [
    ["GET", `/messages/employees/${employee}/unread`],
    ["GET", `/employees/${employee}/atf`],
    ["GET", `/employees/${employee}/schedule-calendar?from=${today}&to=${today}`],
    ["POST", `/messages/employees/${employee}/read`, { messageIds: [crypto.randomUUID()] }],
    ["POST", `/messages/employees/${employee}/conversations/${crypto.randomUUID()}/messages`, { body: "Jag kommer." }],
    ["POST", `/employees/${employee}/atf-transactions`, { date: today, type: "withdrawal", minutes: 60 }],
    ["POST", `/stamp-sessions/${stamp.id}/stop`, { quantityOk: 0, quantityScrapped: 0 }],
    ["POST", `/attendance-sessions/${attendance!.id}/stop`, {}],
    ["POST", "/attendance-sessions", { employeeId: employee }],
    ["POST", "/stamp-sessions", { employeeId: employee, moOperationId: operation!.id }],
  ];
  return { employee, other, requests };
}

const GUARDED = [
  "GET /api/v1/employees/:id/atf",
  "GET /api/v1/employees/:id/schedule-calendar",
  "GET /api/v1/messages/employees/:employeeId/unread",
  "POST /api/v1/attendance-sessions",
  "POST /api/v1/attendance-sessions/:id/stop",
  "POST /api/v1/employees/:id/atf-transactions",
  "POST /api/v1/messages/employees/:employeeId/conversations/:conversationId/messages",
  "POST /api/v1/messages/employees/:employeeId/read",
  "POST /api/v1/stamp-sessions",
  "POST /api/v1/stamp-sessions/:id/stop",
];

describe("Kräv kod i stämpelterminalen — the guarded routes", () => {
  // Pinned: a new route the terminal calls for an employee must be added
  // here AND get config.terminalPinEmployee — and world() a request for it.
  it("are exactly the routes the terminal calls for an employee", async () => {
    const marked = routes
      .filter((r) => (r.config as { terminalPinEmployee?: unknown } | undefined)?.terminalPinEmployee !== undefined)
      .flatMap((r) => (Array.isArray(r.method) ? r.method : [r.method]).filter((m) => m !== "HEAD").map((m) => `${m} ${r.url}`))
      .sort();
    expect(marked).toEqual(GUARDED);
    expect((await world()).requests).toHaveLength(GUARDED.length);
  });

  it("changes nothing while the setting is off", async () => {
    const terminal = await makeUser(["terminal"]);
    const slice = await call(terminal, "GET", "/settings/terminal");
    expect([slice.statusCode, slice.json().terminalPinRequired]).toEqual([200, false]);
    const { requests } = await world();
    for (const [method, url, payload] of requests) {
      const res = await call(terminal, method, url, payload);
      expect([`${method} ${url}`, pastTheGuard(res)]).toEqual([`${method} ${url}`, true]);
    }
    // The stamps really went through: stopped and opened again.
    const open = (await call(terminal, "GET", "/stamp-sessions?open=true")).json() as unknown[];
    expect(open).toHaveLength(1);
  });

  it("is saved by an administrator only and read by the terminal", async () => {
    const admin = await makeAdmin();
    const terminal = await makeUser(["terminal"]);
    expect((await call(terminal, "PATCH", "/settings", { terminalPinRequired: true })).statusCode).toBe(403);
    const saved = await settingOn(admin);
    expect([saved.statusCode, saved.json().terminalPinRequired]).toEqual([200, true]);
    expect((await call(terminal, "GET", "/settings/terminal")).json().terminalPinRequired).toBe(true);
    expect((await call(admin, "PATCH", "/settings", { terminalPinRequired: "yes" })).statusCode).toBe(400);
  });

  it("never asks an office user for a proof", async () => {
    await settingOn(await makeAdmin());
    // Tillverkning implies the terminal permission: Pågående arbete and the
    // terminal page under an office login go on as before.
    const office = await makeUser(["tillverkning"]);
    const { requests } = await world();
    for (const [method, url, payload] of requests) {
      const res = await call(office, method, url, payload);
      // The employee's messages are the terminal permission's — an office
      // user is refused or let in by that rule, never by the code.
      expect([`${method} ${url}`, pastTheGuard(res)]).toEqual([`${method} ${url}`, true]);
    }
  });

  it("refuses a terminal account without the proof for exactly that employee, and lets the right one through", async () => {
    await settingOn(await makeAdmin());
    const terminal = await makeUser(["terminal"]);
    const otherTerminal = await makeUser(["terminal"]);
    const { employee, other, requests } = await world();
    const right = await tokenFor(terminal, employee, "4711");
    const forOther = await tokenFor(terminal, other, "4711");
    // The same employee's proof, but shown at another terminal account.
    const elsewhere = (await verify(otherTerminal, employee, "4711")).json().token as string;
    const sessionToken = terminal.cookie.slice("session=".length);
    const tampered = `${right.slice(0, -3)}${right.endsWith("AAA") ? "BBB" : "AAA"}`;

    for (const [method, url, payload] of requests) {
      for (const [label, token] of [
        ["no token", undefined],
        ["garbage", "not-a-token"],
        ["tampered", tampered],
        ["another employee's", forOther],
        ["another account's", elsewhere],
        ["the session token", sessionToken],
      ] as const) {
        const res = await call(terminal, method, url, payload, token);
        expect([`${method} ${url}`, label, ...codeOf(res)]).toEqual([`${method} ${url}`, label, 403, "terminal-pin-required"]);
      }
    }
    // Nothing was written by the refused requests.
    expect((await call(terminal, "GET", "/stamp-sessions?open=true")).json()).toHaveLength(1);
    expect((await call(terminal, "GET", "/attendance-sessions?open=true")).json()).toHaveLength(1);

    const statuses: number[] = [];
    for (const [method, url, payload] of requests) {
      const res = await call(terminal, method, url, payload, right);
      expect([`${method} ${url}`, pastTheGuard(res)]).toEqual([`${method} ${url}`, true]);
      statuses.push(res.statusCode);
    }
    // unread, atf, calendar, read, reply (no such conversation), withdrawal,
    // stamp out, Gå hem, Kom, stamp in.
    expect(statuses).toEqual([200, 200, 200, 200, 404, 201, 200, 200, 201, 201]);

    // A stop names its employee through the session: one that does not
    // exist, and a body without an employee, are refused the same way.
    expect(codeOf(await call(terminal, "POST", `/stamp-sessions/${crypto.randomUUID()}/stop`, {}, right))).toEqual([403, "terminal-pin-required"]);
    expect(codeOf(await call(terminal, "POST", "/attendance-sessions", { employeeId: "107" }, right))).toEqual([403, "terminal-pin-required"]);
    // The proof is no session: without the cookie it opens nothing.
    const bare = await app.inject({ method: "GET", url: `/api/v1/employees/${employee}/atf`, headers: { cookie: `session=${right}`, [TERMINAL_PIN_HEADER]: right } });
    expect(bare.statusCode).toBe(401);
    // What the terminal reads without an employee stays open.
    for (const url of ["/employees/directory", "/stamp-sessions?open=true", "/attendance-sessions?open=true", "/messages/terminal-board", "/terminal/stations"]) {
      expect([url, (await call(terminal, "GET", url)).statusCode]).toEqual([url, 200]);
    }
  });
});

describe("Välj en kod and Ange din kod", () => {
  it("lets the employee choose a code once, as four digits", async () => {
    const terminal = await makeUser(["terminal"]);
    const employee = await makeEmployee("107", "Bo Berg");
    expect(await statusOf(terminal, employee)).toEqual({ pinSet: false, lockedUntil: null });
    for (const pin of ["123", "12345", "12a4", " 1234", "", 1234, null]) {
      expect([pin, ...codeOf(await choose(terminal, employee, pin as string))]).toEqual([pin, 400, "validation-failed"]);
      expect([pin, ...codeOf(await verify(terminal, employee, pin as string))]).toEqual([pin, 400, "validation-failed"]);
    }
    expect(codeOf(await verify(terminal, employee, "0000"))).toEqual([409, "terminal-pin-not-set"]);

    // No rule against simple codes.
    const before = Date.now();
    const chosen = await choose(terminal, employee, "0000");
    expect(chosen.statusCode).toBe(201);
    const proof = chosen.json() as { token: string; expiresAt: string };
    expect(Object.keys(proof).sort()).toEqual(["expiresAt", "token"]);
    const lifetime = new Date(proof.expiresAt).getTime() - before;
    expect(lifetime).toBeGreaterThan((TERMINAL_PIN_PROOF_SECONDS - 5) * 1000);
    expect(lifetime).toBeLessThan((TERMINAL_PIN_PROOF_SECONDS + 5) * 1000);
    expect(await statusOf(terminal, employee)).toEqual({ pinSet: true, lockedUntil: null });

    // Only an administrator's reset opens for a new code — the old one stays.
    expect(codeOf(await choose(terminal, employee, "9999"))).toEqual([409, "terminal-pin-already-set"]);
    expect((await verify(terminal, employee, "0000")).statusCode).toBe(200);
    expect(codeOf(await verify(terminal, employee, "9999"))).toEqual([403, "terminal-pin-wrong"]);

    // Stored as a bcrypt hash, never the digits.
    const row = await pinRow(employee);
    expect(row!.pinHash).toMatch(/^\$2[aby]\$/);
    expect(row!.pinHash).not.toContain("0000");
  });

  it("decides two simultaneous choices by the database: one code, one refusal", async () => {
    const terminal = await makeUser(["terminal"]);
    const employee = await makeEmployee("107", "Bo Berg");
    const results = await Promise.all([choose(terminal, employee, "1111"), choose(terminal, employee, "2222")]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    const winner = results[0]!.statusCode === 201 ? "1111" : "2222";
    expect((await verify(terminal, employee, winner)).statusCode).toBe(200);
  });

  it("refuses an unknown, an inactive and an anonymized employee, and an account without the terminal", async () => {
    const terminal = await makeUser(["terminal"]);
    const office = await makeUser(["forsaljning"]);
    const employee = await makeEmployee("107", "Bo Berg");
    const unknown = crypto.randomUUID();
    expect(codeOf(await call(terminal, "GET", `/employees/${unknown}/terminal-pin`))).toEqual([404, "employee-not-found"]);
    expect(codeOf(await choose(terminal, unknown, "1234"))).toEqual([404, "employee-not-found"]);
    expect(codeOf(await verify(terminal, unknown, "1234"))).toEqual([404, "employee-not-found"]);
    expect((await call(terminal, "GET", "/employees/107/terminal-pin")).statusCode).toBe(400);

    await choose(terminal, employee, "1234");
    await db.update(employees).set({ active: false }).where(eq(employees.id, employee));
    expect(codeOf(await verify(terminal, employee, "1234"))).toEqual([409, "inactive-employee"]);
    const inactive = await makeEmployee("300", "Dan Dahl");
    await db.update(employees).set({ active: false }).where(eq(employees.id, inactive));
    expect(codeOf(await choose(terminal, inactive, "1234"))).toEqual([409, "inactive-employee"]);

    for (const res of [
      await call(office, "GET", `/employees/${employee}/terminal-pin`),
      await choose(office, employee, "1234"),
      await verify(office, employee, "1234"),
      await call(office, "DELETE", `/employees/${employee}/terminal-pin`),
    ]) {
      expect(codeOf(res)).toEqual([403, "forbidden"]);
    }
  });

  it("counts wrong codes, locks after five in a row and opens again when the time has passed", async () => {
    const terminal = await makeUser(["terminal"]);
    const employee = await makeEmployee("107", "Bo Berg");
    await choose(terminal, employee, "4711");

    // A right code starts the count over.
    expect((await verify(terminal, employee, "0001")).json()).toMatchObject({ code: "terminal-pin-wrong", attemptsLeft: 4, error: "Fel kod. 4 försök kvar." });
    expect((await verify(terminal, employee, "0002")).json().attemptsLeft).toBe(3);
    expect((await verify(terminal, employee, "4711")).statusCode).toBe(200);
    expect((await pinRow(employee))!.failedAttempts).toBe(0);

    for (let left = TERMINAL_PIN_MAX_ATTEMPTS - 1; left >= 1; left--) {
      const res = await verify(terminal, employee, "0000");
      expect([res.statusCode, res.json().attemptsLeft]).toEqual([403, left]);
    }
    expect((await pinRow(employee))!.failedAttempts).toBe(TERMINAL_PIN_MAX_ATTEMPTS - 1);
    const before = Date.now();
    const locked = await verify(terminal, employee, "0000");
    expect(codeOf(locked)).toEqual([429, "terminal-pin-locked"]);
    const until = new Date((locked.json() as { lockedUntil: string }).lockedUntil).getTime();
    expect(until - before).toBeGreaterThan((TERMINAL_PIN_LOCK_MINUTES * 60 - 5) * 1000);
    expect(until - before).toBeLessThan((TERMINAL_PIN_LOCK_MINUTES * 60 + 5) * 1000);
    // Swedish, and it says when.
    expect(locked.json().error).toMatch(/^För många felaktiga försök — koden är spärrad till kl\. \d{2}:\d{2}\./);
    expect((await statusOf(terminal, employee)).lockedUntil).toBe(new Date(until).toISOString());

    // Locked: the right code is refused too, and nothing is counted.
    expect(codeOf(await verify(terminal, employee, "4711"))).toEqual([429, "terminal-pin-locked"]);
    expect(codeOf(await verify(terminal, employee, "0000"))).toEqual([429, "terminal-pin-locked"]);
    expect((await pinRow(employee))!.failedAttempts).toBe(0);

    // The spärr runs out (backdated — never a sleep): five new attempts.
    await db.update(employeeTerminalPins).set({ lockedUntil: new Date(Date.now() - 1000) }).where(eq(employeeTerminalPins.employeeId, employee));
    expect((await statusOf(terminal, employee)).lockedUntil).toBeNull();
    expect((await verify(terminal, employee, "0000")).json().attemptsLeft).toBe(TERMINAL_PIN_MAX_ATTEMPTS - 1);
    expect((await verify(terminal, employee, "4711")).statusCode).toBe(200);
    expect(await pinRow(employee)).toMatchObject({ failedAttempts: 0, lockedUntil: null });
  });

  it("counts simultaneous wrong codes one after the other", async () => {
    const terminal = await makeUser(["terminal"]);
    const employee = await makeEmployee("107", "Bo Berg");
    await choose(terminal, employee, "4711");
    // Seven at once: four are wrong, the fifth locks, the rest meet the spärr.
    const results = await Promise.all(["0001", "0002", "0003", "0004", "0005", "0006", "0007"].map((pin) => verify(terminal, employee, pin)));
    const wrong = results.filter((r) => r.statusCode === 403).map((r) => r.json().attemptsLeft as number);
    expect(wrong.sort()).toEqual([1, 2, 3, 4]);
    expect(results.filter((r) => r.statusCode === 429)).toHaveLength(3);
    expect((await pinRow(employee))!.lockedUntil).not.toBeNull();
  });

  it("lets a read-only terminal account show a code but not choose one", async () => {
    const terminal = await makeUser(["terminal"]);
    const readOnly = await makeUser(["terminal"], { readOnly: true });
    const employee = await makeEmployee("107", "Bo Berg");
    expect(codeOf(await choose(readOnly, employee, "4711"))).toEqual([403, "read-only-account"]);
    await choose(terminal, employee, "4711");
    expect((await verify(readOnly, employee, "4711")).statusCode).toBe(200);
  });
});

describe("Nollställ terminalkoden", () => {
  it("is Personal & lön's with admin or arbetsledare, removes the code and the spärr and ends the proof", async () => {
    const admin = await makeAdmin();
    await settingOn(admin);
    const terminal = await makeUser(["terminal"]);
    const { employee } = await world();
    const proof = await tokenFor(terminal, employee, "4711");
    expect((await call(terminal, "GET", `/employees/${employee}/atf`, undefined, proof)).statusCode).toBe(200);
    for (let i = 0; i < TERMINAL_PIN_MAX_ATTEMPTS; i++) await verify(terminal, employee, "0000");
    expect((await statusOf(terminal, employee)).lockedUntil).not.toBeNull();

    const url = `/employees/${employee}/terminal-pin`;
    // The terminal itself, Tillverkning without Personal, and Personal
    // without the role: all refused.
    for (const account of [terminal, await makeUser(["tillverkning"], { role: "supervisor" }), await makeUser(["personal"])]) {
      expect(codeOf(await call(account, "DELETE", url))).toEqual([403, "forbidden"]);
    }
    expect((await pinRow(employee))).not.toBeNull();

    const supervisor = await makeUser(["personal"], { role: "supervisor" });
    // The personnel card reads the status — never a code.
    expect(await statusOf(supervisor, employee)).toMatchObject({ pinSet: true });
    const reset = await call(supervisor, "DELETE", url);
    expect([reset.statusCode, reset.json()]).toEqual([200, { pinSet: false, lockedUntil: null }]);
    expect(await pinRow(employee)).toBeNull();
    // Idempotent, and an unknown employee is a 404.
    expect((await call(admin, "DELETE", url)).statusCode).toBe(200);
    expect(codeOf(await call(admin, "DELETE", `/employees/${crypto.randomUUID()}/terminal-pin`))).toEqual([404, "employee-not-found"]);

    // The old proof is dead at once, and stays dead when the SAME code is chosen again.
    expect(codeOf(await call(terminal, "GET", `/employees/${employee}/atf`, undefined, proof))).toEqual([403, "terminal-pin-required"]);
    expect(codeOf(await verify(terminal, employee, "4711"))).toEqual([409, "terminal-pin-not-set"]);
    const again = await tokenFor(terminal, employee, "4711");
    expect(codeOf(await call(terminal, "GET", `/employees/${employee}/atf`, undefined, proof))).toEqual([403, "terminal-pin-required"]);
    expect((await call(terminal, "GET", `/employees/${employee}/atf`, undefined, again)).statusCode).toBe(200);

    // The händelselogg says what happened — never the code.
    const log = (await db.execute(sql`select action, detail from audit_log where entity_id = ${employee} and action like 'terminal_pin%' order by created_at`)) as unknown as {
      action: string;
      detail: Record<string, unknown>;
    }[];
    expect(log.map((l) => l.action)).toEqual(["terminal_pin_set", "terminal_pin_locked", "terminal_pin_reset", "terminal_pin_set"]);
    expect(JSON.stringify(log)).not.toContain("4711");
  });
});

describe("Radera och anonymisera", () => {
  it("takes the code and the spärr away with the employee's personal data", async () => {
    const admin = await makeAdmin();
    const terminal = await makeUser(["terminal"]);
    // Never stamped: Radera — the row goes with the employee.
    const erased = await makeEmployee("107", "Bo Berg");
    await choose(terminal, erased, "4711");
    await db.update(employees).set({ active: false }).where(eq(employees.id, erased));
    expect((await call(admin, "DELETE", `/employees/${erased}`)).statusCode).toBeLessThan(300);
    expect(await pinRow(erased)).toBeNull();

    // With history in a locked month: Anonymisera — a locked code too.
    const kept = await makeEmployee("208", "Cia Ceder");
    await choose(terminal, kept, "4711");
    for (let i = 0; i < TERMINAL_PIN_MAX_ATTEMPTS; i++) await verify(terminal, kept, "0000");
    expect((await pinRow(kept))!.lockedUntil).not.toBeNull();
    await db.update(employees).set({ active: false }).where(eq(employees.id, kept));
    await db.insert(attendanceSessions).values({ employeeId: kept, startedAt: new Date("2026-02-09T06:00:00Z"), stoppedAt: new Date("2026-02-09T12:00:00Z") });
    await db.insert(payrollPeriods).values({ year: 2026, month: 2, status: "locked", lockedAt: new Date() }).onConflictDoNothing();
    const res = await call(admin, "POST", `/employees/${kept}/anonymize`);
    expect([res.statusCode, res.json()]).toEqual([200, { action: "anonymize" }]);
    expect(await pinRow(kept)).toBeNull();
    // …and can never get a new one: the service and the database both refuse.
    expect(codeOf(await choose(terminal, kept, "4711"))).toEqual([404, "employee-not-found"]);
    expect(codeOf(await verify(terminal, kept, "4711"))).toEqual([404, "employee-not-found"]);
    const raw = await db.insert(employeeTerminalPins).values({ employeeId: kept, pinHash: "x" }).then(() => null, (err: unknown) => err);
    expect(isEmployeeAnonymizedViolation(raw)).toBe(true);
  });
});

describe("The code never leaves the server", () => {
  it("shows no hash in any answer — the registers, the directory, the status, the händelselogg", async () => {
    const admin = await makeAdmin();
    const terminal = await makeUser(["terminal"]);
    const employee = await makeEmployee("107", "Bo Berg");
    await choose(terminal, employee, "4711");
    await verify(terminal, employee, "0000");
    const hash = (await pinRow(employee))!.pinHash;
    for (const url of [
      "/employees",
      `/employees/${employee}`,
      "/employees/directory",
      `/employees/${employee}/terminal-pin`,
      `/employees/${employee}/erasure`,
      "/audit-log?limit=100",
    ]) {
      expect([url, (await call(admin, "GET", url)).statusCode]).toEqual([url, 200]);
    }
    const patched = await call(admin, "PATCH", `/employees/${employee}`, { name: "Bo Bergman" });
    expect(patched.statusCode).toBe(200);
    expect(answers.length).toBeGreaterThan(5);
    for (const body of answers) {
      expect(body).not.toContain(hash);
      expect(body).not.toMatch(/pin_?hash/i);
      expect(body).not.toMatch(/\$2[aby]\$\d\d\$/);
    }
  });
});

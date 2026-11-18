import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { attendanceSessions, db, employees, messageEventTargets, messages, payrollPeriods, permissionGroups, users } from "@navet/db";
import { BOARD_DEFAULT_DAYS, BOARD_MAX_DAYS } from "@navet/shared";
import { buildApp } from "../src/app.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createAuthService } from "../src/modules/auth/service/auth.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { isEmployeeAnonymizedViolation } from "../src/modules/system/service/db-errors.js";
import { addDays, stockholmToday } from "../src/modules/system/service/delivery-days.js";

// Meddelanden, etapp 2 (migration 0232) through the real app: Lägg till
// deltagare / Ta bort / Lämna konversationen with their händelserader,
// Radera on one's own messages, and the employee's reply from the
// stämpelterminal. Every name here is made up.

const authService = createAuthService(createAuthRepository(db), "unused", createAuditRepository(db));
const PASSWORD = "correcthorsebattery";
const TRUNCATE = sql`TRUNCATE message_event_targets, messages, conversation_participants, conversations, attendance_sessions,
  payroll_periods, employees, audit_log, user_settings, users CASCADE`;
// Only this file's groups — never TRUNCATE permission_groups (the seeded ones).
const DELETE_GROUPS = sql`DELETE FROM permission_groups WHERE code LIKE 'MDP%'`;

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

interface Account {
  id: string;
  name: string;
  cookie: string;
}
interface Participant {
  participantId: string;
  kind: string;
  id: string;
  name: string;
  read: boolean | null;
  lastReadAt: string | null;
  boardUntil: string | null;
}
interface ThreadRow {
  id: string;
  kind: "message" | "event";
  senderId: string | null;
  senderEmployeeId: string | null;
  senderName: string;
  viaTerminal: boolean;
  body: string | null;
  deleted: boolean;
  createdAt: string;
  event: { type: string; targets: { kind: string | null; name: string | null }[] } | null;
}
interface Detail {
  id: string;
  archived: boolean;
  unreadCount: number;
  participants: Participant[];
  messages: ThreadRow[];
}

async function login(email: string) {
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PASSWORD } });
  expect(res.statusCode).toBe(200);
  return `session=${res.cookies.find((c) => c.name === "session")!.value}`;
}

async function makeUser(name: string, permissions: string[], opts: { readOnly?: boolean } = {}): Promise<Account> {
  const [group] = await db
    .insert(permissionGroups)
    .values({ code: `MDP${crypto.randomUUID().slice(0, 6)}`, name: "Meddelanden", permissions })
    .returning();
  const email = `mdp-${crypto.randomUUID()}@example.com`;
  const user = await authService.createUser({
    email,
    password: PASSWORD,
    name,
    role: "user",
    permissionGroupId: group!.id,
    readOnly: opts.readOnly ?? false,
  });
  return { id: user.id, name, cookie: await login(email) };
}

async function makeAdmin(name: string): Promise<Account> {
  const email = `mdp-admin-${crypto.randomUUID()}@example.com`;
  const user = await authService.createUser({ email, password: PASSWORD, name, role: "admin" });
  return { id: user.id, name, cookie: await login(email) };
}

async function makeEmployee(employeeNumber: string, name: string) {
  const [row] = await db.insert(employees).values({ employeeNumber, name, active: true }).returning();
  return row!.id;
}

const call = (account: Account, method: "GET" | "POST" | "DELETE", url: string, payload?: unknown) =>
  app.inject({ method, url: `/api/v1${url}`, headers: { cookie: account.cookie }, ...(payload === undefined ? {} : { payload: payload as never }) });

async function start(from: Account, body: Record<string, unknown>) {
  const res = await call(from, "POST", "/conversations", { subject: "Truckladdaren", body: "Den blinkar rött igen.", ...body });
  expect([res.statusCode, res.json().code]).toEqual([201, undefined]);
  return res.json() as Detail;
}

const detailOf = async (account: Account, id: string) => (await call(account, "GET", `/conversations/${id}`)).json() as Detail;
const unreadOf = async (account: Account) => (await call(account, "GET", "/messages/unread")).json() as { count: number; latest: { senderName: string } | null };
const codeOf = (res: { statusCode: number; json: () => { code?: string } }) => [res.statusCode, res.json().code];
const events = (detail: Detail) => detail.messages.filter((m) => m.kind === "event").map((m) => [m.senderName, m.event!.type, m.event!.targets.map((t) => t.name)]);
const participantOf = (detail: Detail, id: string) => detail.participants.find((p) => p.id === id)!;

// Makes the employee one with history in a locked month, then anonymizes.
async function anonymize(admin: Account, employeeId: string) {
  await db.update(employees).set({ active: false }).where(eq(employees.id, employeeId));
  await db.insert(attendanceSessions).values({
    employeeId,
    startedAt: new Date("2026-02-09T06:00:00Z"),
    stoppedAt: new Date("2026-02-09T12:00:00Z"),
  });
  await db.insert(payrollPeriods).values({ year: 2026, month: 2, status: "locked", lockedAt: new Date() }).onConflictDoNothing();
  const res = await call(admin, "POST", `/employees/${employeeId}/anonymize`);
  expect([res.statusCode, res.json()]).toEqual([200, { action: "anonymize" }]);
}

describe("Lägg till deltagare", () => {
  it("lets any participant add users, terminals and employees — who then see the whole thread as unread", async () => {
    const stina = await makeUser("Stina Säljare", ["forsaljning"]);
    const ivar = await makeUser("Ivar Inköpare", ["inkop"]);
    const lena = await makeUser("Lena Lager", ["lager"]);
    const terminal = await makeUser("Terminal Verkstad", ["terminal"]);
    const bo = await makeEmployee("201", "Bo Berg");
    const created = await start(stina, { recipientUserIds: [ivar.id] });
    await call(ivar, "POST", `/conversations/${created.id}/messages`, { body: "Jag ringer leverantören." });

    // Not the creator — any participant adds.
    const added = await call(ivar, "POST", `/conversations/${created.id}/participants`, {
      recipientUserIds: [lena.id, terminal.id],
      recipientEmployeeIds: [bo],
    });
    expect(codeOf(added)).toEqual([200, undefined]);
    const detail = added.json() as Detail;
    expect(detail.participants.map((p) => [p.kind, p.name])).toEqual([
      ["user", "Ivar Inköpare"],
      ["user", "Lena Lager"],
      ["user", "Stina Säljare"],
      ["terminal", "Terminal Verkstad"],
      ["employee", "Bo Berg"],
    ]);
    // The terminal gets the slutdatum with the same default as at the start.
    expect(participantOf(detail, terminal.id).boardUntil).toBe(addDays(stockholmToday(), BOARD_DEFAULT_DAYS));
    expect(events(detail)).toEqual([["Ivar Inköpare", "added", ["Bo Berg", "Lena Lager", "Terminal Verkstad"]]]);

    // The whole thread, all of it unread — the händelserad not counted.
    const lenaSees = await detailOf(lena, created.id);
    expect(lenaSees.messages.filter((m) => m.kind === "message").map((m) => m.body)).toEqual(["Den blinkar rött igen.", "Jag ringer leverantören."]);
    expect(lenaSees.unreadCount).toBe(2);
    expect((await unreadOf(lena)).count).toBe(2);
    // The employee gets the thread at the number; the board shows it.
    const atTerminal = (await call(terminal, "GET", `/messages/employees/${bo}/unread`)).json();
    expect(atTerminal[0].messages.map((m: { body: string }) => m.body)).toEqual(["Den blinkar rött igen.", "Jag ringer leverantören."]);
    expect((await call(terminal, "GET", "/messages/terminal-board")).json()).toHaveLength(1);
    expect(participantOf(detail, bo).read).toBe(false);
  });

  it("refuses a duplicate, an outsider, a plugin account, an anonymized employee and a date out of range", async () => {
    const admin = await makeAdmin("Asta Admin");
    const stina = await makeUser("Stina Säljare", ["forsaljning"]);
    const ivar = await makeUser("Ivar Inköpare", ["inkop"]);
    const outsider = await makeUser("Olle Okänd", ["lager"]);
    const terminal = await makeUser("Terminal Verkstad", ["terminal"]);
    const [plugin] = await db.insert(users).values({ email: "tillagg-mdp@example.com", passwordHash: "x", name: "Ett tillägg", kind: "plugin" }).returning();
    const bo = await makeEmployee("201", "Bo Berg");
    const gone = await makeEmployee("202", "Anonym Andersson");
    await anonymize(admin, gone);
    const created = await start(stina, { recipientUserIds: [ivar.id], recipientEmployeeIds: [bo] });
    const add = (who: Account, body: Record<string, unknown>) => call(who, "POST", `/conversations/${created.id}/participants`, body);

    expect(codeOf(await add(stina, { recipientUserIds: [ivar.id] }))).toEqual([409, "participant-already-added"]);
    expect(codeOf(await add(stina, { recipientEmployeeIds: [bo] }))).toEqual([409, "participant-already-added"]);
    // One duplicate among several adds nobody.
    expect(codeOf(await add(stina, { recipientUserIds: [outsider.id, ivar.id] }))).toEqual([409, "participant-already-added"]);
    expect(codeOf(await add(outsider, { recipientUserIds: [terminal.id] }))).toEqual([404, "conversation-not-found"]);
    expect(codeOf(await add(stina, { recipientUserIds: [plugin!.id] }))).toEqual([400, "recipient-not-available"]);
    expect(codeOf(await add(stina, { recipientEmployeeIds: [gone] }))).toEqual([400, "recipient-not-available"]);
    expect(codeOf(await add(stina, { recipientUserIds: [stina.id] }))).toEqual([400, "recipient-not-available"]);
    expect((await add(stina, {})).statusCode).toBe(400);
    expect(codeOf(await add(stina, { recipientUserIds: [terminal.id], boardUntil: addDays(stockholmToday(), BOARD_MAX_DAYS + 1) }))).toEqual([
      400,
      "board-date-out-of-range",
    ]);
    expect((await call(stina, "POST", "/conversations/inte-ett-id/participants", { recipientUserIds: [terminal.id] })).statusCode).toBe(400);

    const after = await detailOf(stina, created.id);
    expect(after.participants).toHaveLength(3);
    expect(events(after)).toEqual([]);
  });
});

describe("Ta bort och Lämna konversationen", () => {
  it("lets only the one who started it remove — the removed one loses access, their messages stay", async () => {
    const stina = await makeUser("Stina Säljare", ["forsaljning"]);
    const ivar = await makeUser("Ivar Inköpare", ["inkop"]);
    const lena = await makeUser("Lena Lager", ["lager"]);
    const terminal = await makeUser("Terminal Verkstad", ["terminal"]);
    const created = await start(stina, { recipientUserIds: [ivar.id, lena.id, terminal.id] });
    await call(ivar, "POST", `/conversations/${created.id}/messages`, { body: "Ivars rad." });
    const row = (id: string) => participantOf(created, id).participantId;
    const remove = (who: Account, participantId: string) => call(who, "DELETE", `/conversations/${created.id}/participants/${participantId}`);

    expect(codeOf(await remove(ivar, row(lena.id)))).toEqual([403, "conversation-not-owner"]);
    // Not even oneself — that is Lämna konversationen.
    expect(codeOf(await remove(ivar, row(ivar.id)))).toEqual([403, "conversation-not-owner"]);
    expect(codeOf(await remove(stina, row(stina.id)))).toEqual([409, "conversation-creator-cannot-leave"]);
    expect(codeOf(await remove(stina, crypto.randomUUID()))).toEqual([404, "participant-not-found"]);
    expect((await remove(stina, "inte-ett-id")).statusCode).toBe(400);
    const outsider = await makeUser("Olle Okänd", ["lager"]);
    expect(codeOf(await remove(outsider, row(lena.id)))).toEqual([404, "conversation-not-found"]);

    expect((await call(terminal, "GET", "/messages/terminal-board")).json()).toHaveLength(1);
    expect(codeOf(await remove(stina, row(ivar.id)))).toEqual([200, undefined]);
    const after = (await remove(stina, row(terminal.id))).json() as Detail;
    expect(after.participants.map((p) => p.name)).toEqual(["Lena Lager", "Stina Säljare"]);
    expect(events(after)).toEqual([
      ["Stina Säljare", "removed", ["Ivar Inköpare"]],
      ["Stina Säljare", "removed", ["Terminal Verkstad"]],
    ]);
    // Removed: a 404 like anyone outside, everywhere …
    expect(codeOf(await call(ivar, "GET", `/conversations/${created.id}`))).toEqual([404, "conversation-not-found"]);
    expect(codeOf(await call(ivar, "POST", `/conversations/${created.id}/messages`, { body: "Hallå?" }))).toEqual([404, "conversation-not-found"]);
    expect((await call(ivar, "GET", "/conversations")).json().total).toBe(0);
    expect((await unreadOf(ivar)).count).toBe(0);
    // … the terminal's board is empty, and Ivar's message stands under his name.
    expect((await call(terminal, "GET", "/messages/terminal-board")).json()).toEqual([]);
    expect(after.messages.find((m) => m.body === "Ivars rad.")).toMatchObject({ senderId: ivar.id, senderName: "Ivar Inköpare", deleted: false });
    // Already removed.
    expect(codeOf(await remove(stina, row(ivar.id)))).toEqual([404, "participant-not-found"]);
  });

  it("lets everyone but the one who started it leave", async () => {
    const stina = await makeUser("Stina Säljare", ["forsaljning"]);
    const ivar = await makeUser("Ivar Inköpare", ["inkop"]);
    const created = await start(stina, { recipientUserIds: [ivar.id] });

    expect(codeOf(await call(stina, "POST", `/conversations/${created.id}/leave`))).toEqual([409, "conversation-creator-cannot-leave"]);
    const left = await call(ivar, "POST", `/conversations/${created.id}/leave`);
    // Answers the envelope's summary: the unread message went with the conversation.
    expect([left.statusCode, left.json().count]).toEqual([200, 0]);
    expect(codeOf(await call(ivar, "GET", `/conversations/${created.id}`))).toEqual([404, "conversation-not-found"]);
    expect(codeOf(await call(ivar, "POST", `/conversations/${created.id}/leave`))).toEqual([404, "conversation-not-found"]);
    const after = await detailOf(stina, created.id);
    expect(after.participants.map((p) => p.name)).toEqual(["Stina Säljare"]);
    expect(events(after)).toEqual([["Ivar Inköpare", "left", []]]);

    // Added again: back with everything unread.
    await call(stina, "POST", `/conversations/${created.id}/participants`, { recipientUserIds: [ivar.id] });
    expect((await detailOf(ivar, created.id)).unreadCount).toBe(1);
  });
});

describe("Händelserader", () => {
  it("are never unread, never bring an archived conversation back and never reach the terminal", async () => {
    const stina = await makeUser("Stina Säljare", ["forsaljning"]);
    const ivar = await makeUser("Ivar Inköpare", ["inkop"]);
    const lena = await makeUser("Lena Lager", ["lager"]);
    const terminal = await makeUser("Terminal Verkstad", ["terminal"]);
    const bo = await makeEmployee("201", "Bo Berg");
    const created = await start(stina, { recipientUserIds: [ivar.id, terminal.id], recipientEmployeeIds: [bo] });
    await call(terminal, "POST", `/messages/employees/${bo}/read`, { messageIds: [created.messages[0]!.id] });
    expect((await call(ivar, "POST", `/conversations/${created.id}/archive`)).json().archived).toBe(true);
    expect((await unreadOf(ivar)).count).toBe(0);

    const added = (await call(stina, "POST", `/conversations/${created.id}/participants`, { recipientUserIds: [lena.id] })).json() as Detail;
    await call(lena, "POST", `/conversations/${created.id}/leave`);

    // Ivar: still archived, nothing unread, the inbox row unchanged.
    const ivarSees = await detailOf(ivar, created.id);
    expect([ivarSees.archived, ivarSees.unreadCount]).toEqual([true, 0]);
    expect((await unreadOf(ivar)).count).toBe(0);
    expect((await call(ivar, "GET", "/conversations")).json().total).toBe(0);
    const inbox = (await call(stina, "GET", "/conversations")).json().rows[0];
    expect(inbox.lastMessage.preview).toBe("Den blinkar rött igen.");
    expect(inbox.lastMessageAt).toBe(created.messages[0]!.createdAt);
    // The employee stays read; neither terminal view shows the rows.
    expect(participantOf(ivarSees, bo).read).toBe(true);
    expect((await call(terminal, "GET", `/messages/employees/${bo}/unread`)).json()).toEqual([]);
    const board = (await call(terminal, "GET", "/messages/terminal-board")).json();
    expect(board[0].messages.map((m: { body: string }) => m.body)).toEqual(["Den blinkar rött igen."]);

    // In the office thread they stand in order, after the message; a
    // händelserad can be the reader's newest row on screen.
    const thread = ivarSees.messages;
    expect(thread.map((m) => m.kind)).toEqual(["message", "event", "event"]);
    expect(thread.map((m) => Date.parse(m.createdAt))).toEqual([...thread.map((m) => Date.parse(m.createdAt))].sort((a, b) => a - b));
    expect(new Set(thread.map((m) => m.createdAt)).size).toBe(3);
    expect((await call(ivar, "POST", `/conversations/${created.id}/read`, { messageId: thread.at(-1)!.id })).statusCode).toBe(200);
    expect(added.messages.at(-1)!.kind).toBe("event");

    // A message after the händelserader is stamped after them, and it is
    // what brings the conversation back.
    const reply = (await call(stina, "POST", `/conversations/${created.id}/messages`, { body: "Ny laddare beställd." })).json() as Detail;
    expect(Date.parse(reply.messages.at(-1)!.createdAt)).toBeGreaterThan(Date.parse(thread.at(-1)!.createdAt));
    expect(reply.messages.at(-1)!.kind).toBe("message");
    expect([(await detailOf(ivar, created.id)).archived, (await unreadOf(ivar)).count]).toEqual([false, 1]);
  });

  it("store references and name the persons when they are read", async () => {
    const admin = await makeAdmin("Asta Admin");
    const lena = await makeUser("Lena Lager", ["lager"]);
    const bo = await makeEmployee("201", "Bo Berg");
    const curt = await makeEmployee("202", "Curt Carlsson");
    const created = await start(admin, { recipientUserIds: [lena.id] });
    const added = (await call(admin, "POST", `/conversations/${created.id}/participants`, { recipientEmployeeIds: [bo, curt] })).json() as Detail;
    expect(events(added)).toEqual([["Asta Admin", "added", ["Bo Berg", "Curt Carlsson"]]]);
    expect(added.messages.at(-1)!.event!.targets.map((t) => t.kind)).toEqual(["employee", "employee"]);

    // Nothing but ids is stored for a händelserad.
    const [eventRow] = await db.select().from(messages).where(eq(messages.kind, "event"));
    expect([eventRow!.body, eventRow!.senderId, eventRow!.eventType]).toEqual([null, admin.id, "added"]);
    const targets = await db.select().from(messageEventTargets);
    expect(targets.map((t) => Object.keys(t).sort())).toEqual([
      ["employeeId", "id", "messageId", "userId"],
      ["employeeId", "id", "messageId", "userId"],
    ]);

    // A new name shows at once; an anonymized employee neutrally; an erased
    // one without a name at all.
    await db.update(users).set({ name: "Lena Lagerchef" }).where(eq(users.id, lena.id));
    await call(admin, "DELETE", `/conversations/${created.id}/participants/${participantOf(added, lena.id).participantId}`);
    await anonymize(admin, bo);
    await db.update(employees).set({ active: false }).where(eq(employees.id, curt));
    expect((await call(admin, "DELETE", `/employees/${curt}`)).statusCode).toBe(204);

    const after = await detailOf(admin, created.id);
    expect(events(after)).toEqual([
      ["Asta Admin", "added", ["Anonymiserad anställd", null]],
      ["Asta Admin", "removed", ["Lena Lagerchef"]],
    ]);
    expect(after.messages[1]!.event!.targets.map((t) => t.kind)).toEqual(["employee", null]);
    expect(JSON.stringify(after)).not.toMatch(/Bo Berg|Curt Carlsson/);
  });
});

describe("Radera meddelanden", () => {
  it("removes the text of one's own message and keeps the row", async () => {
    const stina = await makeUser("Stina Säljare", ["forsaljning"]);
    const ivar = await makeUser("Ivar Inköpare", ["inkop"]);
    const outsider = await makeUser("Olle Okänd", ["lager"]);
    const terminal = await makeUser("Terminal Verkstad", ["terminal"]);
    const bo = await makeEmployee("201", "Bo Berg");
    const created = await start(stina, { recipientUserIds: [ivar.id, terminal.id], recipientEmployeeIds: [bo] });
    const second = (await call(stina, "POST", `/conversations/${created.id}/messages`, { body: "Hemligt: koden är 4711." })).json() as Detail;
    const secret = second.messages.at(-1)!;
    const reply = (await call(terminal, "POST", `/messages/employees/${bo}/conversations/${created.id}/messages`, { body: "Uppfattat." })).json() as { id: string };
    const withEvent = (await call(stina, "POST", `/conversations/${created.id}/participants`, { recipientUserIds: [outsider.id] })).json() as Detail;
    const eventId = withEvent.messages.at(-1)!.id;
    await call(stina, "DELETE", `/conversations/${created.id}/participants/${participantOf(withEvent, outsider.id).participantId}`);
    const del = (who: Account, messageId: string) => call(who, "DELETE", `/conversations/${created.id}/messages/${messageId}`);

    expect((await unreadOf(ivar)).count).toBe(3);
    // Someone else's, an employee's reply and a händelserad (also one's own) are refused.
    expect(codeOf(await del(ivar, secret.id))).toEqual([403, "message-not-own"]);
    expect(codeOf(await del(stina, reply.id))).toEqual([403, "message-not-own"]);
    expect(codeOf(await del(stina, eventId))).toEqual([403, "message-not-own"]);
    expect(codeOf(await del(stina, crypto.randomUUID()))).toEqual([404, "message-not-found"]);
    expect(codeOf(await del(outsider, secret.id))).toEqual([404, "conversation-not-found"]);
    expect((await del(stina, "inte-ett-id")).statusCode).toBe(400);

    const deleted = await del(stina, secret.id);
    expect(codeOf(deleted)).toEqual([200, undefined]);
    const row = (deleted.json() as Detail).messages.find((m) => m.id === secret.id)!;
    expect(row).toMatchObject({ kind: "message", senderId: stina.id, senderName: "Stina Säljare", body: null, deleted: true, createdAt: secret.createdAt });
    // The text is gone from the database, not just hidden.
    const [stored] = await db.select().from(messages).where(eq(messages.id, secret.id));
    expect([stored!.body, stored!.deletedAt instanceof Date]).toEqual([null, true]);
    expect(JSON.stringify((await call(ivar, "GET", `/conversations/${created.id}`)).json())).not.toContain("4711");
    expect((await call(ivar, "GET", "/conversations?search=4711")).json().total).toBe(0);
    // Deleting it again changes nothing.
    expect(codeOf(await del(stina, secret.id))).toEqual([200, undefined]);

    // Not unread, not on the board, not for the employee.
    expect((await unreadOf(ivar)).count).toBe(2);
    const board = (await call(terminal, "GET", "/messages/terminal-board")).json();
    expect(board[0].messages.map((m: { body: string }) => m.body)).toEqual(["Den blinkar rött igen.", "Uppfattat."]);
    const lena = await makeEmployee("203", "Lena Lind");
    await call(stina, "POST", `/conversations/${created.id}/participants`, { recipientEmployeeIds: [lena] });
    const lenaSees = (await call(terminal, "GET", `/messages/employees/${lena}/unread`)).json();
    expect(lenaSees[0].messages.map((m: { body: string }) => m.body)).toEqual(["Den blinkar rött igen.", "Uppfattat."]);
  });

  it("says so in the inbox when the newest message is deleted, and an unread deleted message leaves nobody unread", async () => {
    const stina = await makeUser("Stina Säljare", ["forsaljning"]);
    const terminal = await makeUser("Terminal Verkstad", ["terminal"]);
    const bo = await makeEmployee("201", "Bo Berg");
    const created = await start(stina, { recipientEmployeeIds: [bo] });
    await call(terminal, "POST", `/messages/employees/${bo}/read`, { messageIds: [created.messages[0]!.id] });
    const second = (await call(stina, "POST", `/conversations/${created.id}/messages`, { body: "Fel tråd, förlåt." })).json() as Detail;
    expect(participantOf(second, bo).read).toBe(false);

    const after = (await call(stina, "DELETE", `/conversations/${created.id}/messages/${second.messages.at(-1)!.id}`)).json() as Detail;
    expect(participantOf(after, bo).read).toBe(true);
    expect((await call(terminal, "GET", `/messages/employees/${bo}/unread`)).json()).toEqual([]);
    expect((await call(stina, "GET", "/conversations")).json().rows[0].lastMessage).toMatchObject({ preview: "", deleted: true, senderId: stina.id });
  });

  it("lets a read-only account add, delete its own message and leave", async () => {
    const stina = await makeUser("Stina Säljare", ["forsaljning"]);
    const demo = await makeUser("Demo Läsare", ["forsaljning"], { readOnly: true });
    const lena = await makeUser("Lena Lager", ["lager"]);
    const created = await start(stina, { recipientUserIds: [demo.id] });
    const own = await start(demo, { recipientUserIds: [stina.id, lena.id] });

    const said = (await call(demo, "POST", `/conversations/${created.id}/messages`, { body: "Skrev fel." })).json() as Detail;
    expect(codeOf(await call(demo, "DELETE", `/conversations/${created.id}/messages/${said.messages.at(-1)!.id}`))).toEqual([200, undefined]);
    expect(codeOf(await call(demo, "POST", `/conversations/${created.id}/participants`, { recipientUserIds: [lena.id] }))).toEqual([200, undefined]);
    expect(codeOf(await call(demo, "DELETE", `/conversations/${own.id}/participants/${participantOf(own, lena.id).participantId}`))).toEqual([200, undefined]);
    expect(codeOf(await call(demo, "POST", `/conversations/${created.id}/leave`))).toEqual([200, undefined]);
  });
});

describe("Svar från terminalen", () => {
  it("lets the employee reply in their own conversation — in their own name, read by the reply, unread for the office", async () => {
    const stina = await makeUser("Stina Säljare", ["forsaljning"]);
    const ivar = await makeUser("Ivar Inköpare", ["inkop"]);
    const terminal = await makeUser("Terminal Verkstad", ["terminal"]);
    const bo = await makeEmployee("201", "Bo Berg");
    const curt = await makeEmployee("202", "Curt Carlsson");
    const created = await start(stina, { recipientUserIds: [ivar.id, terminal.id], recipientEmployeeIds: [bo] });
    await call(ivar, "POST", `/conversations/${created.id}/read`, {});
    const replyAs = (who: Account, employeeId: string, body: unknown, conversationId = created.id) =>
      call(who, "POST", `/messages/employees/${employeeId}/conversations/${conversationId}/messages`, body);

    const sent = await replyAs(terminal, bo, { body: "  Jag kommer  ", messageIds: [created.messages[0]!.id] });
    expect(sent.statusCode).toBe(201);
    const thread = await detailOf(stina, created.id);
    expect(thread.messages.at(-1)).toMatchObject({
      id: sent.json().id,
      kind: "message",
      senderId: null,
      senderEmployeeId: bo,
      senderName: "Bo Berg",
      viaTerminal: true,
      body: "Jag kommer",
    });
    expect(thread.messages[0]!.viaTerminal).toBe(false);
    // Unread for the office like any message, and it moves the conversation.
    expect([thread.unreadCount, (await unreadOf(ivar)).count, (await unreadOf(ivar)).latest!.senderName]).toEqual([1, 1, "Bo Berg"]);
    expect((await call(stina, "GET", "/conversations")).json().rows[0].lastMessage).toMatchObject({ senderId: null, senderName: "Bo Berg", preview: "Jag kommer" });
    // The reply read the conversation; the employee's own reply is never shown back.
    expect(participantOf(thread, bo).read).toBe(true);
    expect(participantOf(thread, bo).lastReadAt).toBe(created.messages[0]!.createdAt);
    expect((await call(terminal, "GET", `/messages/employees/${bo}/unread`)).json()).toEqual([]);
    // The board shows the whole thread, the reply under the employee's name.
    const board = (await call(terminal, "GET", "/messages/terminal-board")).json();
    expect(board[0].messages.map((m: { senderName: string; body: string }) => [m.senderName, m.body])).toEqual([
      ["Stina Säljare", "Den blinkar rött igen."],
      ["Bo Berg", "Jag kommer"],
    ]);

    // A message that arrived while the employee was writing stays unread:
    // the reply reads up to what was on screen, not past it.
    const unseen = (await call(stina, "POST", `/conversations/${created.id}/messages`, { body: "Ta med nyckeln." })).json() as Detail;
    expect((await replyAs(terminal, bo, { body: "OK", messageIds: [created.messages[0]!.id] })).statusCode).toBe(201);
    const still = (await call(terminal, "GET", `/messages/employees/${bo}/unread`)).json();
    expect(still[0].messages.map((m: { id: string }) => m.id)).toEqual([unseen.messages.at(-1)!.id]);
    // Without the list the reply reads everything up to itself.
    expect((await replyAs(terminal, bo, { body: "Tack!" })).statusCode).toBe(201);
    expect((await call(terminal, "GET", `/messages/employees/${bo}/unread`)).json()).toEqual([]);
    const done = await detailOf(stina, created.id);
    expect(participantOf(done, bo).lastReadAt).toBe(done.messages.at(-1)!.createdAt);
    expect(done.messages.map((m) => Date.parse(m.createdAt))).toEqual([...done.messages.map((m) => Date.parse(m.createdAt))].sort((a, b) => a - b));

    // Only in the employee's own conversations, only with the terminal permission.
    expect(codeOf(await replyAs(terminal, curt, { body: "Jag med." }))).toEqual([404, "conversation-not-found"]);
    expect(codeOf(await replyAs(terminal, bo, { body: "Hej" }, crypto.randomUUID()))).toEqual([404, "conversation-not-found"]);
    const boardOnly = await start(stina, { recipientUserIds: [terminal.id] });
    expect(codeOf(await replyAs(terminal, bo, { body: "Tavlan svarar inte." }, boardOnly.id))).toEqual([404, "conversation-not-found"]);
    expect((await replyAs(stina, bo, { body: "Som Bo." })).statusCode).toBe(403);
    const readOnlyTerminal = await makeUser("Terminal Demo", ["terminal"], { readOnly: true });
    expect(codeOf(await replyAs(readOnlyTerminal, bo, { body: "Hej" }))).toEqual([403, "read-only-account"]);
    expect((await replyAs(terminal, bo, { body: "   " })).statusCode).toBe(400);
    expect((await replyAs(terminal, bo, { body: "Hej", messageIds: [] })).statusCode).toBe(400);
    expect((await call(terminal, "POST", `/messages/employees/201/conversations/${created.id}/messages`, { body: "Hej" })).statusCode).toBe(400);
    // The terminal account itself has no reply route into the conversation.
    expect((await call(terminal, "POST", `/conversations/${created.id}/messages`, { body: "Från tavlan." })).statusCode).toBe(403);
  });

  it("refuses an anonymized employee, and erasing an employee takes the text of their replies", async () => {
    const admin = await makeAdmin("Asta Admin");
    const terminal = await makeUser("Terminal Verkstad", ["terminal"]);
    const bo = await makeEmployee("201", "Bo Berg");
    const curt = await makeEmployee("202", "Curt Carlsson");
    const created = await start(admin, { recipientEmployeeIds: [bo, curt] });
    const replyAs = (employeeId: string, body: string) =>
      call(terminal, "POST", `/messages/employees/${employeeId}/conversations/${created.id}/messages`, { body });
    expect((await replyAs(bo, "Jag är hemma med feber.")).statusCode).toBe(201);
    expect((await replyAs(curt, "Jag tar Bos pass.")).statusCode).toBe(201);

    await anonymize(admin, bo);
    expect(codeOf(await replyAs(bo, "En rad till."))).toEqual([409, "employee-anonymized"]);
    // … and by the database itself (NV002).
    await expect(db.insert(messages).values({ conversationId: created.id, senderEmployeeId: bo, body: "Förbi tjänsten." })).rejects.toSatisfy(
      isEmployeeAnonymizedViolation
    );
    // An employee with only messages is deleted — the reply's text goes first.
    await db.update(employees).set({ active: false }).where(eq(employees.id, curt));
    expect((await call(admin, "GET", `/employees/${curt}/erasure`)).json()).toEqual({ action: "delete", blockers: [] });
    expect((await call(admin, "DELETE", `/employees/${curt}`)).statusCode).toBe(204);

    const after = await detailOf(admin, created.id);
    expect(after.messages.map((m) => [m.senderName, m.viaTerminal, m.body, m.deleted])).toEqual([
      ["Asta Admin", false, "Den blinkar rött igen.", false],
      ["Anonymiserad anställd", true, null, true],
      ["Borttagen anställd", true, null, true],
    ]);
    expect(JSON.stringify(after)).not.toMatch(/feber|Bos pass|Bo Berg|Curt/);
    expect(after.unreadCount).toBe(0);
  });
});

describe("messages — the database's own rules (0232)", () => {
  it("takes a message with exactly one sender and its text, and a händelserad without text", async () => {
    const stina = await makeUser("Stina Säljare", ["forsaljning"]);
    const bo = await makeEmployee("201", "Bo Berg");
    const created = await start(stina, { recipientEmployeeIds: [bo] });
    const row = (values: Record<string, unknown>) =>
      db.insert(messages).values({ conversationId: created.id, ...values } as typeof messages.$inferInsert);

    await expect(row({ body: "Ingen avsändare." })).rejects.toThrow();
    await expect(row({ senderId: stina.id, senderEmployeeId: bo, body: "Två avsändare." })).rejects.toThrow();
    await expect(row({ senderId: stina.id })).rejects.toThrow(); // no text, not deleted
    await expect(row({ senderId: stina.id, body: "Text", deletedAt: new Date() })).rejects.toThrow();
    await expect(row({ senderId: stina.id, body: "Text", eventType: "added" })).rejects.toThrow();
    await expect(row({ senderId: stina.id, kind: "event", eventType: "added", body: "Anna lade till Bo" })).rejects.toThrow();
    await expect(row({ senderId: stina.id, kind: "event", eventType: "döpt om" })).rejects.toThrow();
    await expect(row({ senderEmployeeId: bo, kind: "event", eventType: "left" })).rejects.toThrow();
    await expect(row({ senderId: stina.id, kind: "notis", body: "Text" })).rejects.toThrow();
    // A plain delete of an employee who has written can not leave a
    // senderless text behind — the erasure removes the text first.
    await row({ senderEmployeeId: bo, body: "Ett svar." });
    await expect(db.delete(employees).where(eq(employees.id, bo))).rejects.toThrow();
  });
});

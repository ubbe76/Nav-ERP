import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { attendanceSessions, conversationParticipants, db, employees, payrollPeriods, permissionGroups, users } from "@navet/db";
import { BOARD_DEFAULT_DAYS, BOARD_MAX_DAYS, MESSAGE_BODY_MAX } from "@navet/shared";
import { buildApp } from "../src/app.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createAuthService } from "../src/modules/auth/service/auth.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { isEmployeeAnonymizedViolation } from "../src/modules/system/service/db-errors.js";
import { addDays, stockholmToday } from "../src/modules/system/service/delivery-days.js";
import { recipientKindOf } from "../src/modules/messages/service/messages.service.js";

// Meddelanden through the real app: participants only (404 otherwise), the
// derived unread count, Arkivera, the recipient selection, the link rule,
// the list pattern, a read-only account writing its own messages, the
// terminal's anslagstavla with its slutdatum, an employee's messages and
// OK, läst, and what Radera/Anonymisera does to an employee's messages.
// Every name here is made up.

const authService = createAuthService(createAuthRepository(db), "unused", createAuditRepository(db));
const PASSWORD = "correcthorsebattery";
const TRUNCATE = sql`TRUNCATE messages, conversation_participants, conversations, attendance_sessions, payroll_periods, employees,
  audit_log, user_settings, users CASCADE`;
// Only this file's groups — never TRUNCATE permission_groups (the seeded ones).
const DELETE_GROUPS = sql`DELETE FROM permission_groups WHERE code LIKE 'MED%'`;

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

async function login(email: string) {
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PASSWORD } });
  expect(res.statusCode).toBe(200);
  return `session=${res.cookies.find((c) => c.name === "session")!.value}`;
}

async function makeAdmin(name = "Admin"): Promise<Account> {
  const email = `admin-${crypto.randomUUID()}@example.com`;
  const user = await authService.createUser({ email, password: PASSWORD, name, role: "admin" });
  return { id: user.id, name, cookie: await login(email) };
}

async function makeUser(name: string, permissions: string[], opts: { readOnly?: boolean } = {}): Promise<Account> {
  const [group] = await db
    .insert(permissionGroups)
    .values({ code: `MED${crypto.randomUUID().slice(0, 6)}`, name: "Meddelanden", permissions })
    .returning();
  const email = `med-${crypto.randomUUID()}@example.com`;
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

async function makeEmployee(employeeNumber: string, name: string, active = true) {
  const [row] = await db.insert(employees).values({ employeeNumber, name, active }).returning();
  return row!.id;
}

const call = (account: Account, method: "GET" | "POST" | "DELETE", url: string, payload?: unknown) =>
  app.inject({ method, url: `/api/v1${url}`, headers: { cookie: account.cookie }, ...(payload === undefined ? {} : { payload: payload as never }) });

async function start(from: Account, body: Record<string, unknown>) {
  const res = await call(from, "POST", "/conversations", { subject: "Leveransen på fredag", body: "Hinner vi?", ...body });
  expect([res.statusCode, res.json().code]).toEqual([201, undefined]);
  return res.json() as { id: string; messages: { id: string }[]; participants: Record<string, unknown>[] };
}

const unreadOf = async (account: Account) => (await call(account, "GET", "/messages/unread")).json();

describe("recipientKindOf (pure)", () => {
  it("is office with any menu, terminal for the pure workshop profile, nothing otherwise", () => {
    expect(recipientKindOf({ role: "admin", groupPermissions: null })).toBe("user");
    expect(recipientKindOf({ role: "user", groupPermissions: ["forsaljning"] })).toBe("user");
    // Tillverkning implies terminal — still an office user.
    expect(recipientKindOf({ role: "user", groupPermissions: ["tillverkning"] })).toBe("user");
    expect(recipientKindOf({ role: "user", groupPermissions: ["terminal", "artikeloversikt"] })).toBe("terminal");
    expect(recipientKindOf({ role: "user", groupPermissions: ["artikeloversikt", "tillverkningsorder_las"] })).toBeNull();
    expect(recipientKindOf({ role: "user", groupPermissions: null })).toBeNull();
  });
});

describe("Mottagarurvalet", () => {
  it("groups users, terminals and employees and leaves out everyone who can not read", async () => {
    const me = await makeUser("Stina Säljare", ["forsaljning"]);
    const colleague = await makeUser("Ivar Inköpare", ["inkop"]);
    const admin = await makeAdmin("Asta Admin");
    const terminal = await makeUser("Terminal Svets", ["terminal"]);
    await makeUser("Bara Översikt", ["artikeloversikt"]);
    const inactive = await makeUser("Inaktiv Användare", ["inkop"]);
    await db.update(users).set({ active: false }).where(eq(users.id, inactive.id));
    const removed = await makeUser("Borttagen Användare", ["inkop"]);
    await db.update(users).set({ deletedAt: new Date() }).where(eq(users.id, removed.id));
    await db.insert(users).values({ email: "tillagg@example.com", passwordHash: "x", name: "Ett tillägg", kind: "plugin" });
    const anna = await makeEmployee("107", "Anna Andersson");
    await makeEmployee("108", "Slutat Svensson", false);

    const res = await call(me, "GET", "/messages/recipients");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      users: [
        { id: admin.id, name: "Asta Admin" },
        { id: colleague.id, name: "Ivar Inköpare" },
      ],
      terminals: [{ id: terminal.id, name: "Terminal Svets" }],
      employees: [{ id: anna, employeeNumber: "107", name: "Anna Andersson" }],
    });
  });

  it("refuses a recipient outside the selection, and oneself", async () => {
    const me = await makeUser("Stina Säljare", ["forsaljning"]);
    const noAccess = await makeUser("Bara Översikt", ["artikeloversikt"]);
    const gone = await makeEmployee("108", "Slutat Svensson", false);
    const attempts = [
      { recipientUserIds: [me.id] },
      { recipientUserIds: [noAccess.id] },
      { recipientUserIds: [crypto.randomUUID()] },
      { recipientEmployeeIds: [gone] },
      { recipientEmployeeIds: [crypto.randomUUID()] },
    ];
    for (const attempt of attempts) {
      const res = await call(me, "POST", "/conversations", { subject: "Ämne", body: "Text", ...attempt });
      expect([res.statusCode, res.json().code]).toEqual([400, "recipient-not-available"]);
    }
    // No recipient at all, the same one twice, and unknown keys: zod.
    for (const body of [{}, { recipientUserIds: [noAccess.id, noAccess.id] }, { recipientUserIds: [noAccess.id], extra: 1 }]) {
      const res = await call(me, "POST", "/conversations", { subject: "Ämne", body: "Text", ...body });
      expect([res.statusCode, res.json().code]).toEqual([400, "validation-failed"]);
    }
    expect((await call(me, "GET", "/conversations")).json()).toEqual({ rows: [], total: 0 });
  });
});

describe("Konversationer — only the participants", () => {
  it("lets every participant read and reply, and answers 404 to everyone else", async () => {
    const stina = await makeUser("Stina Säljare", ["forsaljning"]);
    const ivar = await makeUser("Ivar Inköpare", ["inkop"]);
    const pia = await makeUser("Pia Planerare", ["tillverkning"]);
    const outsider = await makeAdmin("Utomstående Admin");

    const created = await start(stina, { recipientUserIds: [ivar.id, pia.id] });
    expect(created).toMatchObject({
      subject: "Leveransen på fredag",
      link: null,
      createdBy: stina.id,
      archived: false,
      unreadCount: 0,
      messages: [{ senderId: stina.id, senderName: "Stina Säljare", body: "Hinner vi?" }],
    });
    expect(created.participants.map((p) => [p.kind, p.name])).toEqual([
      ["user", "Ivar Inköpare"],
      ["user", "Pia Planerare"],
      ["user", "Stina Säljare"],
    ]);

    const reply = await call(ivar, "POST", `/conversations/${created.id}/messages`, { body: "Ja, godset kommer torsdag." });
    expect(reply.statusCode).toBe(201);
    const seenByPia = await call(pia, "GET", `/conversations/${created.id}`);
    expect(seenByPia.json().messages.map((m: { body: string }) => m.body)).toEqual(["Hinner vi?", "Ja, godset kommer torsdag."]);

    // An admin is no exception: not a participant, no conversation.
    for (const [method, url, payload] of [
      ["GET", `/conversations/${created.id}`, undefined],
      ["POST", `/conversations/${created.id}/messages`, { body: "Jag vill också vara med" }],
      ["POST", `/conversations/${created.id}/read`, {}],
      ["POST", `/conversations/${created.id}/archive`, undefined],
      ["POST", `/conversations/${created.id}/unarchive`, undefined],
      ["POST", `/conversations/${created.id}/remove-from-board`, undefined],
      // … and an id that does not exist answers exactly the same.
      ["GET", `/conversations/${crypto.randomUUID()}`, undefined],
      ["POST", `/conversations/${crypto.randomUUID()}/messages`, { body: "Hallå?" }],
    ] as const) {
      const res = await call(outsider, method, url, payload);
      expect([method, url, res.statusCode, res.json().code]).toEqual([method, url, 404, "conversation-not-found"]);
    }
    expect((await call(outsider, "GET", "/conversations")).json()).toEqual({ rows: [], total: 0 });
    expect(await unreadOf(outsider)).toEqual({ count: 0, conversations: 0, latest: null });
    expect((await call(pia, "GET", `/conversations/${created.id}`)).json().messages).toHaveLength(2);

    const malformed = await call(stina, "GET", "/conversations/inte-ett-id");
    expect([malformed.statusCode, malformed.json().code]).toEqual([400, "validation-failed"]);
  });

  it("refuses the workshop profile the inbox and a user without any access everything", async () => {
    const terminal = await makeUser("Terminal Svets", ["terminal"]);
    const overview = await makeUser("Bara Översikt", ["artikeloversikt"]);
    for (const url of ["/conversations", "/messages/unread", "/messages/recipients"]) {
      expect([url, (await call(terminal, "GET", url)).statusCode]).toEqual([url, 403]);
      expect([url, (await call(overview, "GET", url)).statusCode]).toEqual([url, 403]);
    }
    expect((await call(terminal, "GET", "/messages/terminal-board")).statusCode).toBe(200);
    expect((await call(overview, "GET", "/messages/terminal-board")).statusCode).toBe(403);
  });

  it("validates subject, body and the read marker", async () => {
    const stina = await makeUser("Stina Säljare", ["forsaljning"]);
    const ivar = await makeUser("Ivar Inköpare", ["inkop"]);
    for (const body of [
      { subject: "", body: "Text" },
      { subject: "x".repeat(201), body: "Text" },
      { subject: "Ämne", body: "   " },
      { subject: "Ämne", body: "x".repeat(MESSAGE_BODY_MAX + 1) },
    ]) {
      const res = await call(stina, "POST", "/conversations", { ...body, recipientUserIds: [ivar.id] });
      expect([res.statusCode, res.json().code]).toEqual([400, "validation-failed"]);
    }
    const first = await start(stina, { recipientUserIds: [ivar.id], body: "x".repeat(MESSAGE_BODY_MAX) });
    const second = await start(stina, { recipientUserIds: [ivar.id] });
    const empty = await call(ivar, "POST", `/conversations/${first.id}/messages`, { body: "" });
    expect(empty.statusCode).toBe(400);
    // A message of another conversation is not a place to read up to.
    const wrong = await call(ivar, "POST", `/conversations/${first.id}/read`, { messageId: second.messages[0]!.id });
    expect([wrong.statusCode, wrong.json().code]).toEqual([404, "message-not-found"]);
  });
});

describe("Olästa — derived from the messages", () => {
  it("counts others' messages after the reader's last read, never one's own", async () => {
    const stina = await makeUser("Stina Säljare", ["forsaljning"]);
    const ivar = await makeUser("Ivar Inköpare", ["inkop"]);

    const created = await start(stina, { recipientUserIds: [ivar.id] });
    expect(await unreadOf(stina)).toEqual({ count: 0, conversations: 0, latest: null });
    const forIvar = await unreadOf(ivar);
    expect(forIvar).toMatchObject({
      count: 1,
      conversations: 1,
      latest: { conversationId: created.id, subject: "Leveransen på fredag", senderName: "Stina Säljare", messageId: created.messages[0]!.id },
    });
    expect((await call(ivar, "GET", "/conversations")).json().rows[0]).toMatchObject({ id: created.id, unreadCount: 1 });
    // Opening the conversation does not mark it read — POST …/read does.
    expect((await call(ivar, "GET", `/conversations/${created.id}`)).json().unreadCount).toBe(1);
    expect((await unreadOf(ivar)).count).toBe(1);

    const read = await call(ivar, "POST", `/conversations/${created.id}/read`, { messageId: created.messages[0]!.id });
    expect([read.statusCode, read.json()]).toEqual([200, { count: 0, conversations: 0, latest: null }]);

    // Two more from Stina: both unread for Ivar, none for Stina.
    await call(stina, "POST", `/conversations/${created.id}/messages`, { body: "Kunden ringde igen." });
    const third = await call(stina, "POST", `/conversations/${created.id}/messages`, { body: "De vill ha besked i dag." });
    expect((await unreadOf(ivar)).count).toBe(2);
    expect((await unreadOf(stina)).count).toBe(0);

    // Read up to the second message only: the third is still unread, and
    // reading up to an older message afterwards never moves the mark back.
    const thread = third.json().messages as { id: string }[];
    await call(ivar, "POST", `/conversations/${created.id}/read`, { messageId: thread[1]!.id });
    expect((await unreadOf(ivar)).count).toBe(1);
    await call(ivar, "POST", `/conversations/${created.id}/read`, {});
    expect((await unreadOf(ivar)).count).toBe(0);
    await call(ivar, "POST", `/conversations/${created.id}/read`, { messageId: thread[0]!.id });
    expect((await unreadOf(ivar)).count).toBe(0);

    // Ivar's reply is unread for Stina and read for himself.
    const reply = await call(ivar, "POST", `/conversations/${created.id}/messages`, { body: "Torsdag förmiddag." });
    expect(reply.json().unreadCount).toBe(0);
    expect(await unreadOf(stina)).toMatchObject({ count: 1, latest: { senderName: "Ivar Inköpare" } });
    expect((await unreadOf(ivar)).count).toBe(0);
  });

  it("orders simultaneous replies strictly, so none can hide behind a read mark", async () => {
    const stina = await makeUser("Stina Säljare", ["forsaljning"]);
    const ivar = await makeUser("Ivar Inköpare", ["inkop"]);
    const pia = await makeUser("Pia Planerare", ["tillverkning"]);
    const created = await start(stina, { recipientUserIds: [ivar.id, pia.id] });

    const replies = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        call(i % 2 === 0 ? ivar : pia, "POST", `/conversations/${created.id}/messages`, { body: `Svar ${i + 1}` })
      )
    );
    expect(replies.map((r) => r.statusCode)).toEqual([201, 201, 201, 201, 201, 201]);

    const thread = (await call(stina, "GET", `/conversations/${created.id}`)).json();
    const times = thread.messages.map((m: { createdAt: string }) => m.createdAt);
    expect(times).toHaveLength(7);
    expect(new Set(times).size).toBe(7);
    expect([...times].sort()).toEqual(times);
    // last_message_at is the newest message's own timestamp.
    expect(thread.lastMessageAt).toBe(times.at(-1));
    expect((await unreadOf(stina)).count).toBe(6);
    // Reading up to the fourth leaves exactly the three after it.
    await call(stina, "POST", `/conversations/${created.id}/read`, { messageId: thread.messages[3].id });
    expect((await unreadOf(stina)).count).toBe(3);
  });

  it("hides an archived conversation until a new message arrives", async () => {
    const stina = await makeUser("Stina Säljare", ["forsaljning"]);
    const ivar = await makeUser("Ivar Inköpare", ["inkop"]);
    const created = await start(stina, { recipientUserIds: [ivar.id] });

    // Arkivera also reads it.
    const archived = await call(ivar, "POST", `/conversations/${created.id}/archive`);
    expect([archived.statusCode, archived.json().archived, archived.json().unreadCount]).toEqual([200, true, 0]);
    expect((await unreadOf(ivar)).count).toBe(0);
    expect((await call(ivar, "GET", "/conversations")).json()).toEqual({ rows: [], total: 0 });
    const inArchive = (await call(ivar, "GET", "/conversations?archived=true")).json();
    expect([inArchive.total, inArchive.rows[0].id, inArchive.rows[0].archived]).toEqual([1, created.id, true]);
    // Per participant: Stina still has it in her inbox.
    expect((await call(stina, "GET", "/conversations")).json().total).toBe(1);

    await call(stina, "POST", `/conversations/${created.id}/messages`, { body: "En sak till." });
    const back = (await call(ivar, "GET", "/conversations")).json();
    expect([back.total, back.rows[0].archived, back.rows[0].unreadCount]).toEqual([1, false, 1]);
    expect((await call(ivar, "GET", "/conversations?archived=true")).json().total).toBe(0);
    expect((await unreadOf(ivar)).count).toBe(1);

    // Återställ.
    await call(ivar, "POST", `/conversations/${created.id}/archive`);
    expect((await call(ivar, "GET", "/conversations")).json().total).toBe(0);
    const restored = await call(ivar, "POST", `/conversations/${created.id}/unarchive`);
    expect([restored.statusCode, restored.json().archived]).toEqual([200, false]);
    expect((await call(ivar, "GET", "/conversations")).json().total).toBe(1);
  });
});

describe("Bifogad länk", () => {
  it("takes a path inside Nav and nothing else", async () => {
    const stina = await makeUser("Stina Säljare", ["forsaljning"]);
    const ivar = await makeUser("Ivar Inköpare", ["inkop"]);
    const link = { href: "/forsaljning/ordrar/0b0f6f0e-3c58-4a39-9d0c-0d5a5f0e7a11?flik=rader", title: "Kundorder KO-1042" };
    const created = await start(stina, { recipientUserIds: [ivar.id], link });
    expect((await call(ivar, "GET", `/conversations/${created.id}`)).json().link).toEqual(link);
    expect((await call(ivar, "GET", "/conversations")).json().rows[0].hasLink).toBe(true);

    for (const bad of [
      { href: "https://example.com/", title: "Annan sajt" },
      { href: "//example.com/x", title: "Annan sajt" },
      { href: "/\\example.com", title: "Annan sajt" },
      { href: "forsaljning/ordrar", title: "Utan snedstreck" },
      { href: "/forsaljning/ordrar med blanksteg", title: "Blanksteg" },
      { href: "javascript:alert(1)", title: "Skript" },
      { href: "/forsaljning/ordrar", title: "" },
      { href: "/forsaljning/ordrar" },
      { href: "/forsaljning/ordrar", title: "Order", target: "_blank" },
    ]) {
      const res = await call(stina, "POST", "/conversations", { subject: "Ämne", body: "Text", recipientUserIds: [ivar.id], link: bad });
      expect([bad.href, res.statusCode, res.json().code]).toEqual([bad.href, 400, "validation-failed"]);
    }
    expect((await call(stina, "GET", "/conversations")).json().total).toBe(1);
  });
});

describe("Inkorgen — the list pattern", () => {
  it("answers { rows, total } newest first, with search, limit and offset", async () => {
    const stina = await makeUser("Stina Säljare", ["forsaljning"]);
    const ivar = await makeUser("Ivar Inköpare", ["inkop"]);
    const a = await start(stina, { recipientUserIds: [ivar.id], subject: "Offert till kund", body: "Kan du räkna på plåten?" });
    const b = await start(ivar, { recipientUserIds: [stina.id], subject: "Semesterlistan", body: "Fyll i senast fredag." });
    const c = await start(stina, { recipientUserIds: [ivar.id], subject: "Ny leverantör", body: "De har 100% rabatt_kod på plåt." });

    const all = (await call(ivar, "GET", "/conversations")).json();
    expect(all.total).toBe(3);
    expect(all.rows.map((r: { id: string }) => r.id)).toEqual([c.id, b.id, a.id]);
    expect(all.rows[0]).toMatchObject({
      subject: "Ny leverantör",
      hasLink: false,
      archived: false,
      unreadCount: 1,
      lastMessage: { senderId: stina.id, senderName: "Stina Säljare", preview: "De har 100% rabatt_kod på plåt." },
    });
    expect(all.rows[0].participants.map((p: { name: string }) => p.name)).toEqual(["Ivar Inköpare", "Stina Säljare"]);

    // A reply moves the conversation to the top.
    await call(ivar, "POST", `/conversations/${a.id}/messages`, { body: "Jag räknar i eftermiddag." });
    const after = (await call(ivar, "GET", "/conversations")).json();
    expect(after.rows.map((r: { id: string }) => r.id)).toEqual([a.id, c.id, b.id]);
    expect(after.rows[0].lastMessage.preview).toBe("Jag räknar i eftermiddag.");

    const page = (await call(ivar, "GET", "/conversations?limit=1&offset=1")).json();
    expect([page.total, page.rows.map((r: { id: string }) => r.id)]).toEqual([3, [c.id]]);

    // The subject and the messages' text, wildcards escaped.
    const bySubject = (await call(ivar, "GET", "/conversations?search=semester")).json();
    expect([bySubject.total, bySubject.rows[0].id]).toEqual([1, b.id]);
    const byBody = (await call(ivar, "GET", `/conversations?search=${encodeURIComponent("plåt")}`)).json();
    expect(byBody.rows.map((r: { id: string }) => r.id)).toEqual([a.id, c.id]);
    expect((await call(ivar, "GET", `/conversations?search=${encodeURIComponent("100%")}`)).json().total).toBe(1);
    expect((await call(ivar, "GET", `/conversations?search=${encodeURIComponent("rabatt_kod")}`)).json().total).toBe(1);
    expect((await call(ivar, "GET", `/conversations?search=${encodeURIComponent("rabattXkod")}`)).json().total).toBe(0);

    expect((await call(ivar, "GET", "/conversations?limit=0")).statusCode).toBe(400);
    expect((await call(ivar, "GET", "/conversations?archived=kanske")).statusCode).toBe(400);
  });
});

describe("Endast läsning", () => {
  it("lets a read-only account send, reply, read and archive — its own communication", async () => {
    const stina = await makeUser("Stina Säljare", ["forsaljning"]);
    const demo = await makeUser("Demo Läskonto", ["forsaljning", "inkop"], { readOnly: true });
    expect((await call(demo, "POST", "/customers", { name: "Kund AB" })).json().code).toBe("read-only-account");

    const created = await start(demo, { recipientUserIds: [stina.id] });
    await call(stina, "POST", `/conversations/${created.id}/messages`, { body: "Svar till demokontot." });
    expect((await unreadOf(demo)).count).toBe(1);
    expect((await call(demo, "POST", `/conversations/${created.id}/read`, {})).statusCode).toBe(200);
    expect((await call(demo, "POST", `/conversations/${created.id}/messages`, { body: "Tack!" })).statusCode).toBe(201);
    expect((await call(demo, "POST", `/conversations/${created.id}/archive`)).statusCode).toBe(200);
    expect((await call(demo, "POST", `/conversations/${created.id}/unarchive`)).statusCode).toBe(200);
    expect((await call(demo, "POST", `/conversations/${created.id}/remove-from-board`)).statusCode).toBe(200);
    expect((await call(stina, "GET", `/conversations/${created.id}`)).json().messages).toHaveLength(3);
  });
});

describe("Terminalens anslagstavla", () => {
  it("shows the conversation on the addressed terminal through its slutdatum", async () => {
    const pia = await makeUser("Pia Planerare", ["tillverkning"]);
    const stina = await makeUser("Stina Säljare", ["forsaljning"]);
    const svets = await makeUser("Terminal Svets", ["terminal"]);
    const montering = await makeUser("Terminal Montering", ["terminal", "artikeloversikt"]);
    const today = stockholmToday();

    const created = await start(pia, { recipientUserIds: [svets.id, stina.id], subject: "Brandövning", body: "Samling på gården 10.00." });
    const terminalRow = created.participants.find((p) => p.kind === "terminal");
    expect(terminalRow).toMatchObject({ id: svets.id, name: "Terminal Svets", boardUntil: addDays(today, BOARD_DEFAULT_DAYS), onBoard: true });
    expect(created.participants.find((p) => p.id === stina.id)).toMatchObject({ kind: "user", boardUntil: null, onBoard: null });

    const board = (await call(svets, "GET", "/messages/terminal-board")).json();
    expect(board).toHaveLength(1);
    expect(board[0]).toMatchObject({
      id: created.id,
      subject: "Brandövning",
      boardUntil: addDays(today, BOARD_DEFAULT_DAYS),
      messages: [{ senderName: "Pia Planerare", body: "Samling på gården 10.00." }],
    });
    // Only the addressed terminal — and an office user who opens the
    // terminal page has no board of their own.
    expect((await call(montering, "GET", "/messages/terminal-board")).json()).toEqual([]);
    expect((await call(pia, "GET", "/messages/terminal-board")).json()).toEqual([]);
    expect((await call(stina, "GET", "/messages/terminal-board")).json()).toEqual([]);

    // New messages from the office show while the board lasts.
    await call(stina, "POST", `/conversations/${created.id}/messages`, { body: "Ta med varselväst." });
    const updated = (await call(svets, "GET", "/messages/terminal-board")).json();
    expect(updated[0].messages.map((m: { body: string }) => m.body)).toEqual(["Samling på gården 10.00.", "Ta med varselväst."]);

    // Through the day itself, not after it.
    const setUntil = (day: string) =>
      db.update(conversationParticipants).set({ boardUntil: day }).where(eq(conversationParticipants.userId, svets.id));
    await setUntil(today);
    expect((await call(svets, "GET", "/messages/terminal-board")).json()).toHaveLength(1);
    await setUntil(addDays(today, -1));
    expect((await call(svets, "GET", "/messages/terminal-board")).json()).toEqual([]);
    const passed = (await call(pia, "GET", `/conversations/${created.id}`)).json();
    expect(passed.participants.find((p: { kind: string }) => p.kind === "terminal")).toMatchObject({ boardUntil: addDays(today, -1), onBoard: false });
  });

  it("takes the sender's slutdatum within a year, and only the sender removes it", async () => {
    const pia = await makeUser("Pia Planerare", ["tillverkning"]);
    const stina = await makeUser("Stina Säljare", ["forsaljning"]);
    const svets = await makeUser("Terminal Svets", ["terminal"]);
    const montering = await makeUser("Terminal Montering", ["terminal"]);
    const today = stockholmToday();

    for (const boardUntil of [addDays(today, -1), addDays(today, BOARD_MAX_DAYS + 1)]) {
      const res = await call(pia, "POST", "/conversations", { subject: "Ämne", body: "Text", recipientUserIds: [svets.id], boardUntil });
      expect([res.statusCode, res.json().code, res.json().min, res.json().max]).toEqual([
        400,
        "board-date-out-of-range",
        today,
        addDays(today, BOARD_MAX_DAYS),
      ]);
    }
    expect((await call(pia, "POST", "/conversations", { subject: "Ämne", body: "Text", recipientUserIds: [svets.id], boardUntil: "i morgon" })).statusCode).toBe(400);
    // Without a terminal among the recipients the date is not looked at.
    await start(pia, { recipientUserIds: [stina.id], boardUntil: addDays(today, -30) });

    const until = addDays(today, BOARD_MAX_DAYS);
    const created = await start(pia, { recipientUserIds: [svets.id, montering.id, stina.id], boardUntil: until });
    expect(created.participants.filter((p) => p.kind === "terminal").map((p) => p.boardUntil)).toEqual([until, until]);
    expect((await call(montering, "GET", "/messages/terminal-board")).json()).toHaveLength(1);

    const notMine = await call(stina, "POST", `/conversations/${created.id}/remove-from-board`);
    expect([notMine.statusCode, notMine.json().code]).toEqual([403, "conversation-not-owner"]);
    expect((await call(svets, "GET", "/messages/terminal-board")).json()).toHaveLength(1);

    const removed = await call(pia, "POST", `/conversations/${created.id}/remove-from-board`);
    expect(removed.statusCode).toBe(200);
    expect(removed.json().participants.filter((p: { kind: string }) => p.kind === "terminal")).toEqual([
      expect.objectContaining({ name: "Terminal Montering", boardUntil: null, onBoard: false }),
      expect.objectContaining({ name: "Terminal Svets", boardUntil: null, onBoard: false }),
    ]);
    expect((await call(svets, "GET", "/messages/terminal-board")).json()).toEqual([]);
    expect((await call(montering, "GET", "/messages/terminal-board")).json()).toEqual([]);
    // The conversation itself is untouched.
    expect((await call(stina, "GET", `/conversations/${created.id}`)).json().messages).toHaveLength(1);
  });
});

describe("Meddelanden till en anställd", () => {
  it("shows the unread messages after the anställningsnummer until OK, läst", async () => {
    const pia = await makeUser("Pia Planerare", ["tillverkning"]);
    const stina = await makeUser("Stina Säljare", ["forsaljning"]);
    const terminal = await makeUser("Terminal Svets", ["terminal"]);
    const anna = await makeEmployee("107", "Anna Andersson");
    const bertil = await makeEmployee("108", "Bertil Berg");

    const created = await start(pia, { recipientEmployeeIds: [anna], subject: "Skyddsskor", body: "Dina nya skor ligger på kontoret." });
    expect(created.participants.find((p) => p.kind === "employee")).toMatchObject({
      id: anna,
      name: "Anna Andersson",
      employeeNumber: "107",
      lastReadAt: null,
      read: false,
    });
    const other = await start(pia, { recipientEmployeeIds: [bertil], subject: "Till Bertil", body: "Bara för Bertil." });

    const unread = await call(terminal, "GET", `/messages/employees/${anna}/unread`);
    expect(unread.statusCode).toBe(200);
    expect(unread.json()).toEqual([
      {
        conversationId: created.id,
        subject: "Skyddsskor",
        messages: [expect.objectContaining({ id: created.messages[0]!.id, senderName: "Pia Planerare", body: "Dina nya skor ligger på kontoret." })],
      },
    ]);
    // Reading alone acknowledges nothing.
    expect((await call(terminal, "GET", `/messages/employees/${anna}/unread`)).json()).toHaveLength(1);

    // Someone else's message can not be acknowledged in Anna's name.
    const foreign = await call(terminal, "POST", `/messages/employees/${anna}/read`, { messageIds: [other.messages[0]!.id] });
    expect([foreign.statusCode, foreign.json()]).toEqual([200, { acknowledged: 0 }]);
    expect((await call(terminal, "GET", `/messages/employees/${anna}/unread`)).json()).toHaveLength(1);
    expect((await call(terminal, "GET", `/messages/employees/${bertil}/unread`)).json()).toHaveLength(1);

    const ack = await call(terminal, "POST", `/messages/employees/${anna}/read`, { messageIds: [created.messages[0]!.id] });
    expect([ack.statusCode, ack.json()]).toEqual([200, { acknowledged: 1 }]);
    expect((await call(terminal, "GET", `/messages/employees/${anna}/unread`)).json()).toEqual([]);
    expect((await call(terminal, "GET", `/messages/employees/${bertil}/unread`)).json()).toHaveLength(1);
    const read = (await call(pia, "GET", `/conversations/${created.id}`)).json().participants.find((p: { kind: string }) => p.kind === "employee");
    expect(read.read).toBe(true);
    expect(typeof read.lastReadAt).toBe("string");

    // A new message in the conversation makes it unread again — only the new one is shown.
    await call(pia, "POST", `/conversations/${created.id}/messages`, { body: "Storlek 43, stämmer det?" });
    const again = (await call(terminal, "GET", `/messages/employees/${anna}/unread`)).json();
    expect(again).toHaveLength(1);
    expect(again[0].messages.map((m: { body: string }) => m.body)).toEqual(["Storlek 43, stämmer det?"]);
    const unreadAgain = (await call(pia, "GET", `/conversations/${created.id}`)).json().participants.find((p: { kind: string }) => p.kind === "employee");
    expect([unreadAgain.read, unreadAgain.lastReadAt]).toEqual([false, read.lastReadAt]);

    // The terminal permission itself: not an office read, not for a
    // read-only account's acknowledgement, and ids are checked.
    expect((await call(stina, "GET", `/messages/employees/${anna}/unread`)).statusCode).toBe(403);
    expect((await call(stina, "POST", `/messages/employees/${anna}/read`, { messageIds: [created.messages[0]!.id] })).statusCode).toBe(403);
    expect((await call(pia, "GET", `/messages/employees/${anna}/unread`)).statusCode).toBe(200);
    const readOnlyTerminal = await makeUser("Terminal Demo", ["terminal"], { readOnly: true });
    const refused = await call(readOnlyTerminal, "POST", `/messages/employees/${anna}/read`, { messageIds: [again[0].messages[0].id] });
    expect([refused.statusCode, refused.json().code]).toEqual([403, "read-only-account"]);
    expect((await call(terminal, "GET", "/messages/employees/107/unread")).statusCode).toBe(400);
    expect((await call(terminal, "POST", `/messages/employees/${anna}/read`, { messageIds: [] })).statusCode).toBe(400);
    expect((await call(terminal, "GET", `/messages/employees/${crypto.randomUUID()}/unread`)).json()).toEqual([]);
  });

  it("mixes users, terminals and employees in one conversation", async () => {
    const pia = await makeUser("Pia Planerare", ["tillverkning"]);
    const stina = await makeUser("Stina Säljare", ["forsaljning"]);
    const terminal = await makeUser("Terminal Svets", ["terminal"]);
    const anna = await makeEmployee("107", "Anna Andersson");
    const created = await start(pia, { recipientUserIds: [stina.id, terminal.id], recipientEmployeeIds: [anna] });
    expect(created.participants.map((p) => [p.kind, p.name])).toEqual([
      ["user", "Pia Planerare"],
      ["user", "Stina Säljare"],
      ["terminal", "Terminal Svets"],
      ["employee", "Anna Andersson"],
    ]);
    expect((await unreadOf(stina)).count).toBe(1);
    expect((await call(terminal, "GET", "/messages/terminal-board")).json()).toHaveLength(1);
    expect((await call(terminal, "GET", `/messages/employees/${anna}/unread`)).json()).toHaveLength(1);
  });
});

describe("Radera och anonymisera en anställd med meddelanden", () => {
  it("deletes the employee: the participant row goes, the conversation stays", async () => {
    const admin = await makeAdmin("Asta Admin");
    const anna = await makeEmployee("107", "Anna Andersson");
    const created = await start(admin, { recipientEmployeeIds: [anna] });
    await db.update(employees).set({ active: false }).where(eq(employees.id, anna));

    // Messages are not history: the employee is deleted, not anonymized.
    expect((await call(admin, "GET", `/employees/${anna}/erasure`)).json()).toEqual({ action: "delete", blockers: [] });
    expect((await call(admin, "DELETE", `/employees/${anna}`)).statusCode).toBe(204);

    const after = (await call(admin, "GET", `/conversations/${created.id}`)).json();
    expect(after.participants.map((p: { kind: string; name: string }) => [p.kind, p.name])).toEqual([["user", "Asta Admin"]]);
    expect(after.messages).toHaveLength(1);
  });

  it("anonymizes the employee: the row stays without the name and takes no new conversation", async () => {
    const admin = await makeAdmin("Asta Admin");
    const terminal = await makeUser("Terminal Svets", ["terminal"]);
    const anna = await makeEmployee("107", "Anna Andersson");
    const created = await start(admin, { recipientEmployeeIds: [anna] });
    await call(terminal, "POST", `/messages/employees/${anna}/read`, { messageIds: [created.messages[0]!.id] });

    await db.update(employees).set({ active: false }).where(eq(employees.id, anna));
    await db.insert(attendanceSessions).values({
      employeeId: anna,
      startedAt: new Date("2026-02-09T06:00:00Z"),
      stoppedAt: new Date("2026-02-09T12:00:00Z"),
    });
    await db.insert(payrollPeriods).values({ year: 2026, month: 2, status: "locked", lockedAt: new Date() });
    const anonymized = await call(admin, "POST", `/employees/${anna}/anonymize`);
    expect([anonymized.statusCode, anonymized.json()]).toEqual([200, { action: "anonymize" }]);

    const after = (await call(admin, "GET", `/conversations/${created.id}`)).json();
    expect(after.participants.find((p: { kind: string }) => p.kind === "employee")).toMatchObject({
      id: anna,
      name: "Anonymiserad anställd",
      read: true,
    });
    expect(JSON.stringify(after.participants)).not.toContain("Anna");

    // No longer in the selection, refused by the service …
    expect((await call(admin, "GET", "/messages/recipients")).json().employees).toEqual([]);
    const again = await call(admin, "POST", "/conversations", { subject: "Ämne", body: "Text", recipientEmployeeIds: [anna] });
    expect([again.statusCode, again.json().code]).toEqual([400, "recipient-not-available"]);
    // … and by the database (0170's guard, NV002).
    const second = await start(admin, { recipientUserIds: [terminal.id] });
    await expect(
      db.insert(conversationParticipants).values({ conversationId: second.id, employeeId: anna, kind: "employee" })
    ).rejects.toSatisfy(isEmployeeAnonymizedViolation);
    // The sender can still write in the conversation.
    expect((await call(admin, "POST", `/conversations/${created.id}/messages`, { body: "En rad till." })).statusCode).toBe(201);
  });
});

describe("conversation_participants — the database's own rules", () => {
  it("takes exactly one party of the right kind, once per conversation", async () => {
    const stina = await makeUser("Stina Säljare", ["forsaljning"]);
    const ivar = await makeUser("Ivar Inköpare", ["inkop"]);
    const anna = await makeEmployee("107", "Anna Andersson");
    const created = await start(stina, { recipientUserIds: [ivar.id], recipientEmployeeIds: [anna] });
    const row = (values: Record<string, unknown>) =>
      db.insert(conversationParticipants).values({ conversationId: created.id, ...values } as typeof conversationParticipants.$inferInsert);

    await expect(row({ kind: "user" })).rejects.toThrow();
    await expect(row({ kind: "user", userId: ivar.id, employeeId: anna })).rejects.toThrow();
    await expect(row({ kind: "user", userId: ivar.id })).rejects.toThrow(); // already a participant
    await expect(row({ kind: "employee", employeeId: anna })).rejects.toThrow(); // already a participant
    const other = await makeUser("Olle Okänd", ["lager"]);
    await expect(row({ kind: "employee", userId: other.id })).rejects.toThrow();
    await expect(row({ kind: "gruppen", userId: other.id })).rejects.toThrow();
    await expect(row({ kind: "user", userId: other.id, boardUntil: "2030-01-01" })).rejects.toThrow();
  });
});

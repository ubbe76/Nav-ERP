import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { alertDigestRuns, daySchedules, db, emailLog, holidays, permissionGroups, userSettings, users } from "@navet/db";
import { ALERT_KINDS, type AlertGroup, type AlertKind, type AlertsResponse } from "@navet/shared";
import { createAlertDigestRepository } from "../src/modules/alerts/repository/alert-digest.repository.js";
import { createAlertDigestService } from "../src/modules/alerts/service/alert-digest.service.js";
import { ALERT_KIND_CATALOG } from "../src/modules/alerts/service/alert-kinds.js";
import { createMailRepository } from "../src/modules/mail/repository/mail.repository.js";
import { createMailService, type MailTransportFactory } from "../src/modules/mail/service/mail.service.js";
import { createSystemRepository } from "../src/modules/system/repository/system.repository.js";
import { createSystemService } from "../src/modules/system/service/system.service.js";

// Den dagliga sammanställningen against Postgres: when the job runs (clock,
// working day, SMTP), who gets a mail, the reservation (one row per user
// and day), the per-recipient kind filter and what a failed send leaves
// behind. The alerts themselves are a fake computeAlerts — the readers
// have alerts.integration.test.ts — that records which kinds it was asked
// for and answers with one row per kind, so the union and the filter are
// exact. Monday 2030-03-04 is "today" (CET: 07:00 Stockholm = 06:00Z).

const MONDAY = "2030-03-04";
const TUESDAY = "2030-03-05";
const SATURDAY = "2030-03-09";
const AT_0700 = new Date("2030-03-04T06:00:00Z");
const AT_0659 = new Date("2030-03-04T05:59:00Z");
const PASSWORD_HASH = "$2a$10$notarealhashbutgoodenoughforthistest";

const sentMails: { to: string; subject: string; text: string; html?: string }[] = [];
let failSends = false;
const fakeTransportFactory: MailTransportFactory = () => ({
  async sendMail(opts) {
    if (failSends) throw new Error("Connection refused");
    sentMails.push({ to: opts.to, subject: opts.subject, text: opts.text, html: opts.html });
  },
});

const systemService = createSystemService(createSystemRepository(db));
const mailService = createMailService(createMailRepository(db), systemService, fakeTransportFactory);

let computeCalls: AlertKind[][] = [];
let itemsPerKind = 1;
async function fakeComputeAlerts(kinds: readonly AlertKind[]): Promise<AlertsResponse> {
  computeCalls.push([...kinds]);
  const groups: AlertGroup[] = kinds.map((kind) => {
    const def = ALERT_KIND_CATALOG.find((d) => d.kind === kind)!;
    const items = Array.from({ length: itemsPerKind }, (_, i) => ({
      key: `${kind}-${i}`,
      severity: def.severity,
      href: `${def.listHref}/${i}`,
      primary: `${def.label} rad ${i + 1}`,
      secondary: null,
      date: null,
    }));
    return { kind, label: def.label, severity: def.severity, count: items.length, listHref: def.listHref, items, error: false, message: null };
  });
  return { computedAt: new Date().toISOString(), groups };
}

let now = AT_0700;
let digestTime = "07:00";
let publicBaseUrl = "https://erp.test";
const logged: string[] = [];
const digest = createAlertDigestService({
  repo: createAlertDigestRepository(db),
  alerts: { computeAlerts: fakeComputeAlerts },
  mail: mailService,
  settings: {
    smtpConfigured: async () => (await systemService.getSmtpConfig()) !== null,
    digestSettings: async () => ({ digestTime, publicBaseUrl }),
  },
  now: () => now,
  log: (msg) => logged.push(msg),
});

const TRUNCATE = sql`TRUNCATE alert_digest_runs, email_log, user_settings, users, holidays, day_schedules CASCADE`;
const DELETE_GROUPS = sql`DELETE FROM permission_groups WHERE code LIKE 'DIG%'`;

async function configureSmtp() {
  await systemService.updateSettings({ smtpHost: "smtp.test.local", smtpFromEmail: "nav@test.local" });
}

beforeEach(async () => {
  await db.execute(TRUNCATE);
  await db.execute(DELETE_GROUPS);
  await db.execute(sql`DELETE FROM system_settings WHERE key LIKE 'smtp_%'`);
  sentMails.length = 0;
  logged.length = 0;
  failSends = false;
  computeCalls = [];
  itemsPerKind = 1;
  now = AT_0700;
  digestTime = "07:00";
  publicBaseUrl = "https://erp.test";
  await configureSmtp();
});
afterAll(async () => {
  await db.execute(TRUNCATE);
  await db.execute(DELETE_GROUPS);
  await db.execute(sql`DELETE FROM system_settings WHERE key LIKE 'smtp_%'`);
});

async function makeUser(opts: {
  email?: string;
  role?: "admin" | "user";
  permissions?: string[];
  digest?: boolean;
  kinds?: AlertKind[] | null;
  active?: boolean;
  deleted?: boolean;
} = {}) {
  let permissionGroupId: string | null = null;
  if (opts.permissions) {
    const [group] = await db
      .insert(permissionGroups)
      .values({ code: `DIG${crypto.randomUUID().slice(0, 6)}`, name: "Digest", permissions: opts.permissions })
      .returning();
    permissionGroupId = group!.id;
  }
  const [user] = await db
    .insert(users)
    .values({
      email: opts.email ?? `u-${crypto.randomUUID().slice(0, 8)}@example.com`,
      passwordHash: PASSWORD_HASH,
      name: "Mottagare",
      role: opts.role ?? "user",
      permissionGroupId,
      active: opts.active ?? true,
      deletedAt: opts.deleted ? new Date() : null,
    })
    .returning();
  if (opts.digest !== false) await db.insert(userSettings).values({ userId: user!.id, key: "alert_digest", value: "true" });
  if (opts.kinds !== undefined) {
    await db.insert(userSettings).values({ userId: user!.id, key: "alert_digest_kinds", value: opts.kinds === null ? "null" : JSON.stringify(opts.kinds) });
  }
  return user!;
}

async function runs() {
  return db.select().from(alertDigestRuns).orderBy(alertDigestRuns.createdAt);
}

describe("alert digest job", () => {
  it("does nothing while SMTP is unconfigured", async () => {
    await db.execute(sql`DELETE FROM system_settings WHERE key LIKE 'smtp_%'`);
    await makeUser({ role: "admin" });
    const result = await digest.runDigestIfDue();
    expect(result.skipped).toBe("smtp");
    expect(await runs()).toHaveLength(0);
    expect(sentMails).toHaveLength(0);
  });

  it("waits for Skicka sammanställningen klockan, then sends once that day — a later tick is a no-op", async () => {
    const user = await makeUser({ role: "admin" });
    now = AT_0659;
    expect((await digest.runDigestIfDue()).skipped).toBe("before-time");
    expect(await runs()).toHaveLength(0);

    now = AT_0700;
    const result = await digest.runDigestIfDue();
    expect(result).toMatchObject({ date: MONDAY, skipped: null, outcomes: [{ userId: user.id, status: "sent", alertCount: ALERT_KINDS.length }] });
    expect(sentMails).toHaveLength(1);
    expect(sentMails[0]!.to).toBe(user.email);
    expect(sentMails[0]!.subject).toBe(`Nav: ${ALERT_KINDS.length} saker att bevaka — måndag 4 mars`);
    expect(sentMails[0]!.html).toContain("https://erp.test/aviseringar");
    expect(sentMails[0]!.text).toContain("https://erp.test/lager/saldon/0");

    const [run] = await runs();
    expect(run).toMatchObject({ userId: user.id, digestDate: MONDAY, status: "sent", alertCount: ALERT_KINDS.length });
    const [log] = await db.select().from(emailLog).where(eq(emailLog.id, run!.emailLogId!));
    expect(log).toMatchObject({ documentType: "alert_digest", documentId: null, status: "sent", recipient: user.email });

    // The same day again, an hour later: nothing more.
    now = new Date("2030-03-04T07:00:00Z");
    expect(await digest.runDigestIfDue()).toMatchObject({ skipped: null, outcomes: [] });
    expect(sentMails).toHaveLength(1);
    expect(await runs()).toHaveLength(1);
  });

  it("a server that starts after the time sends the same day", async () => {
    await makeUser({ role: "admin" });
    now = new Date("2030-03-04T09:00:00Z"); // 10:00 Stockholm
    expect((await digest.runDigestIfDue()).outcomes).toHaveLength(1);
    expect(sentMails).toHaveLength(1);
  });

  it("never on a weekend or a full-day holiday; a holiday with a day schedule is a working day", async () => {
    await makeUser({ role: "admin" });
    now = new Date("2030-03-09T06:00:00Z");
    expect((await digest.runDigestIfDue())).toMatchObject({ date: SATURDAY, skipped: "not-working-day" });

    await db.insert(holidays).values({ date: MONDAY, name: "Ledig dag" });
    now = AT_0700;
    expect((await digest.runDigestIfDue()).skipped).toBe("not-working-day");
    expect(await runs()).toHaveLength(0);

    const [schedule] = await db.insert(daySchedules).values({ code: "KORT", name: "Kortdag", startTime: "07:00", endTime: "12:00" }).returning();
    await db.update(holidays).set({ dayScheduleId: schedule!.id }).where(eq(holidays.date, MONDAY));
    expect((await digest.runDigestIfDue()).skipped).toBeNull();
    expect(sentMails).toHaveLength(1);
  });

  it("an empty list gives an empty run and no mail", async () => {
    const user = await makeUser({ role: "admin" });
    itemsPerKind = 0;
    const result = await digest.runDigestIfDue();
    expect(result.outcomes).toEqual([{ userId: user.id, status: "empty", alertCount: 0 }]);
    expect(sentMails).toHaveLength(0);
    expect((await runs())[0]).toMatchObject({ status: "empty", alertCount: 0, emailLogId: null });
    expect(await db.select().from(emailLog)).toHaveLength(0);
  });

  it("two simultaneous runs give one mail — the run row is the reservation", async () => {
    const user = await makeUser({ role: "admin" });
    const [a, b] = await Promise.all([digest.runDigestIfDue(), digest.runDigestIfDue()]);
    expect(a.outcomes.length + b.outcomes.length).toBe(1);
    expect(sentMails).toHaveLength(1);
    const all = await runs();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ userId: user.id, status: "sent" });
  });

  it("only opted-in, active, undeleted users with an e-mail address are recipients", async () => {
    const yes = await makeUser({ role: "admin" });
    await makeUser({ role: "admin", digest: false });
    await makeUser({ role: "admin", active: false });
    await makeUser({ role: "admin", deleted: true });
    await makeUser({ role: "admin", email: "" });
    const result = await digest.runDigestIfDue();
    expect(result.outcomes.map((o) => o.userId)).toEqual([yes.id]);
    expect(sentMails.map((m) => m.to)).toEqual([yes.email]);
  });

  it("computes the union once and filters per recipient — kinds the user may no longer see are dropped", async () => {
    // Inköp only, but the stored choice still names a sales kind and a
    // stock kind from when the group gave more.
    const inkop = await makeUser({ permissions: ["inkop"], kinds: ["purchase_order_late", "customer_invoice_overdue", "stock_negative"] });
    // Lager, every visible kind (null).
    const lager = await makeUser({ permissions: ["lager"], kinds: null });
    // Workshop profile only: nothing visible at all.
    const verkstad = await makeUser({ permissions: ["terminal"] });

    const result = await digest.runDigestIfDue();
    expect(computeCalls).toEqual([["stock_negative", "purchase_order_late"]]);
    expect(result.outcomes).toEqual(
      expect.arrayContaining([
        { userId: inkop.id, status: "sent", alertCount: 1 },
        { userId: lager.id, status: "sent", alertCount: 1 },
        { userId: verkstad.id, status: "empty", alertCount: 0 },
      ])
    );
    const toInkop = sentMails.find((m) => m.to === inkop.email)!;
    expect(toInkop.subject).toBe("Nav: 1 sak att bevaka — måndag 4 mars");
    expect(toInkop.text).toContain("Försenade inköpsordrar (1)");
    expect(toInkop.text).not.toContain("Negativt saldo");
    const toLager = sentMails.find((m) => m.to === lager.email)!;
    expect(toLager.text).toContain("Negativt saldo (1)");
    expect(toLager.text).not.toContain("Försenade inköpsordrar");
    expect(sentMails).toHaveLength(2);
    expect(await runs()).toHaveLength(3);
  });

  it("the admin's digest without a choice covers every kind, including Utskick som misslyckades", async () => {
    await makeUser({ role: "admin", kinds: null });
    await digest.runDigestIfDue();
    expect(computeCalls[0]).toHaveLength(ALERT_KINDS.length);
    expect(sentMails[0]!.text).toContain("Utskick som misslyckades (1)");
  });

  it("a transport failure gives a failed run pointing at the failed log row, and no retry that day", async () => {
    const user = await makeUser({ role: "admin" });
    failSends = true;
    const result = await digest.runDigestIfDue();
    expect(result.outcomes).toEqual([{ userId: user.id, status: "failed", alertCount: ALERT_KINDS.length }]);
    const [run] = await runs();
    expect(run!.status).toBe("failed");
    const [log] = await db.select().from(emailLog).where(eq(emailLog.id, run!.emailLogId!));
    expect(log).toMatchObject({ documentType: "alert_digest", status: "failed", error: "Connection refused", recipient: user.email });
    expect(logged.some((m) => m.includes("failed"))).toBe(true);

    failSends = false;
    now = new Date("2030-03-04T08:00:00Z");
    expect((await digest.runDigestIfDue()).outcomes).toEqual([]);
    expect(sentMails).toHaveLength(0);
    expect(await runs()).toHaveLength(1);
  });

  it("one recipient's failure does not stop the others", async () => {
    await makeUser({ role: "admin" });
    await makeUser({ role: "admin" });
    const realRepo = createAlertDigestRepository(db);
    let finishCalls = 0;
    const flaky = createAlertDigestService({
      repo: {
        ...realRepo,
        finishRun: async (...args: Parameters<typeof realRepo.finishRun>) => {
          if (++finishCalls <= 2) throw new Error("db hiccup");
          return realRepo.finishRun(...args);
        },
      },
      alerts: { computeAlerts: fakeComputeAlerts },
      mail: mailService,
      settings: {
        smtpConfigured: async () => true,
        digestSettings: async () => ({ digestTime, publicBaseUrl }),
      },
      now: () => now,
      log: (msg) => logged.push(msg),
    });
    const result = await flaky.runDigestIfDue();
    expect(sentMails).toHaveLength(2);
    expect(result.outcomes.filter((o) => o.status === "sent")).toHaveLength(1);
    expect(logged.some((m) => m.includes("aborted"))).toBe(true);
  });

  it("never catches up earlier days", async () => {
    await makeUser({ role: "admin" });
    now = new Date("2030-03-05T06:00:00Z");
    const result = await digest.runDigestIfDue();
    expect(result.date).toBe(TUESDAY);
    expect((await runs()).map((r) => r.digestDate)).toEqual([TUESDAY]);
    expect(sentMails).toHaveLength(1);
  });

  it("without Navs adress the mail carries no links", async () => {
    publicBaseUrl = "";
    await makeUser({ role: "admin" });
    await digest.runDigestIfDue();
    expect(sentMails[0]!.text).toContain("Öppna Nav för att se detaljerna");
    expect(sentMails[0]!.text).not.toContain("http");
    expect(sentMails[0]!.html).not.toContain("<a ");
  });
});

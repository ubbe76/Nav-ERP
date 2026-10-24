import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { accountingPeriods, db, recurringVerificationRuns, verificationRows, verifications } from "@navet/db";
import { round2 } from "@navet/shared";
import { createAlertsRepository } from "../src/modules/alerts/repository/alerts.repository.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createEconomyRepository } from "../src/modules/economy/repository/economy.repository.js";
import { createRecurringVerificationRepository } from "../src/modules/economy/repository/recurring-verification.repository.js";
import { createVerificationTemplateRepository } from "../src/modules/economy/repository/verification-template.repository.js";
import { createEconomyService } from "../src/modules/economy/service/economy.service.js";
import {
  createRecurringVerificationService,
  RecurringTemplateIncompleteError,
  RecurringVerificationNotFoundError,
} from "../src/modules/economy/service/recurring-verification.service.js";
import { createVerificationTemplateService } from "../src/modules/economy/service/verification-template.service.js";

// Återkommande verifikat against Postgres: the job, its reservation (two
// concurrent runs, no duplicates), draft/book, the end month, a locked
// period → failed (and no automatic retry), Kör nu as the retry, the
// fördelning's exact split, delete semantics and the alert reader.

const economyRepo = createEconomyRepository(db);
const economy = createEconomyService(economyRepo, { log: async () => {} });
const templateRepo = createVerificationTemplateRepository(db);
const templates = createVerificationTemplateService({ repo: templateRepo, economy: economyRepo, audit: { log: async () => {} } });
const recurringRepo = createRecurringVerificationRepository(db);
const authRepo = createAuthRepository(db);
const alerts = createAlertsRepository(db);

// "Today" is pinned: a year with twelve open months and a clock in the
// middle of it, independent of the real calendar.
const YEAR = 2031;
let today = `${YEAR}-03-20`;
const recurring = createRecurringVerificationService({
  repo: recurringRepo,
  templates: templateRepo,
  economy: economyRepo,
  economyService: economy,
  audit: { log: async () => {} },
  today: () => today,
  log: () => {},
});

const TRUNCATE = sql`TRUNCATE recurring_verification_runs, recurring_verifications, verification_template_rows, verification_templates, verification_rows, verifications, verification_counters, verification_series, accounting_periods, fiscal_years, accounts, audit_log, users CASCADE`;

beforeEach(async () => {
  today = `${YEAR}-03-20`;
  await db.execute(TRUNCATE);
});
afterAll(async () => {
  await db.execute(TRUNCATE);
});

async function setup() {
  const user = await authRepo.create({ email: `rec-${crypto.randomUUID()}@example.com`, passwordHash: "x", name: "Ekonom", role: "admin" });
  await economy.createFiscalYear({ label: String(YEAR), startDate: `${YEAR}-01-01`, endDate: `${YEAR}-12-31` });
  const series = await economy.createSeries({ code: "A", name: "Manuella verifikat" });
  await economy.createAccount({ number: "1930", name: "Företagskonto" });
  await economy.createAccount({ number: "5010", name: "Lokalhyra" });
  await economy.createAccount({ number: "1790", name: "Förutbetalda kostnader" });
  await economy.createAccount({ number: "2990", name: "Upplupna intäkter" });
  await economy.createAccount({ number: "3010", name: "Försäljning" });
  const template = await templates.create(
    {
      name: "Hyra",
      seriesId: series.id,
      description: "Lokalhyra",
      rows: [
        { accountNumber: "5010", debit: 8000, description: "Hyra" },
        { accountNumber: "1930", credit: 8000 },
      ],
    },
    user.id
  );
  return { user, series, template };
}

async function lockMonth(userId: string, month: string) {
  const [period] = await db.select().from(accountingPeriods).where(eq(accountingPeriods.startDate, `${month}-01`));
  await economy.lockPeriod(period!.id, userId);
}

async function allVerifications() {
  return db.select().from(verifications).orderBy(verifications.date);
}

describe("recurring verifications — create and the job", () => {
  it("creates the due months at once (draft), oldest first, and reports the next run", async () => {
    const { user, template } = await setup();
    const post = await recurring.create({ templateId: template.id, dayOfMonth: 25, startMonth: `${YEAR}-01`, endMonth: null, mode: "draft" }, user.id);
    expect(post).toMatchObject({
      templateName: "Hyra",
      description: "Lokalhyra",
      dayOfMonth: 25,
      mode: "draft",
      active: true,
      kind: "template",
      allocation: null,
      failedCount: 0,
      nextRunMonth: `${YEAR}-03`,
      nextRunDate: `${YEAR}-03-25`,
    });
    // January and February have passed their 25th; March has not.
    expect(post.runs.map((r) => [r.month, r.status])).toEqual([
      [`${YEAR}-02`, "created"],
      [`${YEAR}-01`, "created"],
    ]);
    const created = await allVerifications();
    expect(created.map((v) => [v.date, v.status, v.description])).toEqual([
      [`${YEAR}-01-25`, "draft", "Lokalhyra"],
      [`${YEAR}-02-25`, "draft", "Lokalhyra"],
    ]);
    const rows = await db.select().from(verificationRows).where(eq(verificationRows.verificationId, created[0]!.id));
    expect(rows.map((r) => [Number(r.debit), Number(r.credit), r.description]).sort()).toEqual([
      [0, 8000, null],
      [8000, 0, "Hyra"],
    ]);
  });

  it("books directly in mode book, on the month's last day for \"last\"", async () => {
    const { user, template } = await setup();
    today = `${YEAR}-02-28`;
    const post = await recurring.create({ templateId: template.id, dayOfMonth: "last", startMonth: `${YEAR}-01`, endMonth: null, mode: "book" }, user.id);
    expect(post.runs.map((r) => [r.month, r.status, r.verificationDisplayNumber])).toEqual([
      [`${YEAR}-02`, "created", `A-${YEAR}-2`],
      [`${YEAR}-01`, "created", `A-${YEAR}-1`],
    ]);
    expect(post.lastRun?.verificationDisplayNumber).toBe(`A-${YEAR}-2`);
    expect((await allVerifications()).map((v) => [v.date, v.status])).toEqual([
      [`${YEAR}-01-31`, "booked"],
      [`${YEAR}-02-28`, "booked"],
    ]);
  });

  it("refuses a template without amounts on every row, or one that does not balance", async () => {
    const { user, series } = await setup();
    const blank = await templates.create(
      { name: "Tom", seriesId: series.id, description: "x", rows: [{ accountNumber: "5010" }, { accountNumber: "1930", credit: 5 }] },
      user.id
    );
    await expect(
      recurring.create({ templateId: blank.id, dayOfMonth: 1, startMonth: `${YEAR}-01`, endMonth: null, mode: "draft" }, user.id)
    ).rejects.toThrow(RecurringTemplateIncompleteError);
    const skew = await templates.create(
      { name: "Skev", seriesId: series.id, description: "x", rows: [{ accountNumber: "5010", debit: 6 }, { accountNumber: "1930", credit: 5 }] },
      user.id
    );
    await expect(
      recurring.create({ templateId: skew.id, dayOfMonth: 1, startMonth: `${YEAR}-01`, endMonth: null, mode: "draft" }, user.id)
    ).rejects.toThrow(/balanserar inte/);
    expect((await recurring.list()).total).toBe(0);
  });

  it("the job creates only what is new, stops at the end month, and skips paused posts", async () => {
    const { user, template } = await setup();
    today = `${YEAR}-01-10`;
    const post = await recurring.create({ templateId: template.id, dayOfMonth: 5, startMonth: `${YEAR}-01`, endMonth: `${YEAR}-02`, mode: "draft" }, user.id);
    expect(post.runs).toHaveLength(1);

    today = `${YEAR}-06-01`;
    expect(await recurring.runDue()).toEqual({ posts: 1, created: 1, failed: 0 });
    expect(await recurring.runDue()).toEqual({ posts: 1, created: 0, failed: 0 });
    const detail = await recurring.findById(post.id);
    expect(detail.runs.map((r) => r.month)).toEqual([`${YEAR}-02`, `${YEAR}-01`]);
    expect(detail.nextRunMonth).toBeNull();
    expect(detail.nextRunDate).toBeNull();

    // A paused post is left alone by the job …
    const other = await templates.create({ name: "Annan", seriesId: template.seriesId, description: "y", rows: [{ accountNumber: "5010", debit: 1 }, { accountNumber: "1930", credit: 1 }] }, user.id);
    today = `${YEAR}-01-01`;
    const paused = await recurring.create({ templateId: other.id, dayOfMonth: 1, startMonth: `${YEAR}-02`, endMonth: null, mode: "draft" }, user.id);
    await recurring.update(paused.id, { active: false }, user.id);
    today = `${YEAR}-06-01`;
    expect(await recurring.runDue()).toEqual({ posts: 1, created: 0, failed: 0 });
    expect((await recurring.findById(paused.id)).runs).toEqual([]);
    expect((await recurring.findById(paused.id)).nextRunMonth).toBeNull();
    // … until it is activated again.
    await recurring.update(paused.id, { active: true }, user.id);
    expect(await recurring.runDue()).toEqual({ posts: 2, created: 5, failed: 0 });
  });

  it("two concurrent runs never create a month twice", async () => {
    const { user, template } = await setup();
    today = `${YEAR}-01-01`;
    const post = await recurring.create({ templateId: template.id, dayOfMonth: 1, startMonth: `${YEAR}-01`, endMonth: null, mode: "book" }, user.id);
    expect(post.runs).toHaveLength(1);
    today = `${YEAR}-12-31`;
    const results = await Promise.all([recurring.runDue(), recurring.runDue(), recurring.run(post.id, user.id)]);
    const created = results.reduce((sum, r) => sum + ("created" in r && Array.isArray(r.created) ? r.created.length : (r as { created: number }).created), 0);
    expect(created).toBe(11);
    const runs = await db.select().from(recurringVerificationRuns).where(eq(recurringVerificationRuns.recurringId, post.id));
    expect(runs).toHaveLength(12);
    expect(new Set(runs.map((r) => r.month)).size).toBe(12);
    expect(runs.every((r) => r.status === "created")).toBe(true);
    const booked = await allVerifications();
    expect(booked).toHaveLength(12);
    // The numbers are an unbroken 1..12: a loser's rollback gave its number back.
    expect(booked.map((v) => v.verificationNumber).sort((a, b) => a! - b!)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
  });
});

describe("recurring verifications — failures and Kör nu", () => {
  it("a locked period gives a failed run with a Swedish reason, no verification, and no automatic retry", async () => {
    const { user, template } = await setup();
    await lockMonth(user.id, `${YEAR}-01`);
    today = `${YEAR}-02-10`;
    const post = await recurring.create({ templateId: template.id, dayOfMonth: 1, startMonth: `${YEAR}-01`, endMonth: null, mode: "book" }, user.id);
    expect(post.runs.map((r) => [r.month, r.status])).toEqual([
      [`${YEAR}-02`, "created"],
      [`${YEAR}-01`, "failed"],
    ]);
    const failed = post.runs.find((r) => r.status === "failed")!;
    expect(failed.error).toMatch(/Perioden är låst/);
    expect(failed.verificationId).toBeNull();
    expect(post.failedCount).toBe(1);
    expect((await allVerifications()).map((v) => v.date)).toEqual([`${YEAR}-02-01`]);

    // The job does not try January again.
    expect(await recurring.runDue()).toEqual({ posts: 1, created: 0, failed: 0 });
    expect((await recurring.findById(post.id)).failedCount).toBe(1);

    // The alert shows it …
    expect((await alerts.failedRecurringRuns()).map((r) => [r.templateName, r.month])).toEqual([["Hyra", `${YEAR}-01`]]);

    // … and Kör nu is the retry: still locked → still failed (one row).
    const stillLocked = await recurring.run(post.id, user.id);
    expect(stillLocked.created).toEqual([]);
    expect(stillLocked.failed.map((r) => r.month)).toEqual([`${YEAR}-01`]);
    expect((await recurring.findById(post.id)).runs.filter((r) => r.month === `${YEAR}-01`)).toHaveLength(1);

    // Unlocked → Kör nu creates it, the failed row is gone, the alert too.
    const [period] = await db.select().from(accountingPeriods).where(eq(accountingPeriods.startDate, `${YEAR}-01-01`));
    await economy.unlockPeriod(period!.id, "test: open again", user.id);
    const retried = await recurring.run(post.id, user.id);
    expect(retried.created.map((r) => [r.month, r.status])).toEqual([[`${YEAR}-01`, "created"]]);
    expect(retried.created[0]!.verificationDisplayNumber).toBe(`A-${YEAR}-2`);
    const detail = await recurring.findById(post.id);
    expect(detail.failedCount).toBe(0);
    expect(detail.runs.map((r) => [r.month, r.status])).toEqual([
      [`${YEAR}-02`, "created"],
      [`${YEAR}-01`, "created"],
    ]);
    expect(await alerts.failedRecurringRuns()).toEqual([]);
  });

  it("an inactive account on the template fails the month, and the draft is rolled back with it", async () => {
    const { user, template } = await setup();
    const rent = await economyRepo.findAccountByNumber("5010");
    await economy.updateAccount(rent!.id, { active: false });
    today = `${YEAR}-01-02`;
    const post = await recurring.create({ templateId: template.id, dayOfMonth: 1, startMonth: `${YEAR}-01`, endMonth: null, mode: "draft" }, user.id);
    expect(post.runs.map((r) => [r.status, r.error])).toEqual([["failed", "Ett konto på mallen är inaktivt"]]);
    expect(await allVerifications()).toEqual([]);
  });

  it("deletes the post: failed rows go, rows with a verification stay unlinked, the verifications stay", async () => {
    const { user, template } = await setup();
    await lockMonth(user.id, `${YEAR}-01`);
    today = `${YEAR}-02-10`;
    const post = await recurring.create({ templateId: template.id, dayOfMonth: 1, startMonth: `${YEAR}-01`, endMonth: null, mode: "book" }, user.id);
    await recurring.delete(post.id, user.id);
    await expect(recurring.findById(post.id)).rejects.toThrow(RecurringVerificationNotFoundError);
    const runs = await db.select().from(recurringVerificationRuns);
    expect(runs.map((r) => [r.month, r.status, r.recurringId])).toEqual([[`${YEAR}-02`, "created", null]]);
    expect((await allVerifications()).map((v) => v.status)).toEqual(["booked"]);
    expect(await alerts.failedRecurringRuns()).toEqual([]);
    // The template is free again.
    await templates.delete(template.id, user.id);
  });

  it("patches day, end month and mode; refuses an end month before the start", async () => {
    const { user, template } = await setup();
    today = `${YEAR}-01-01`;
    const post = await recurring.create({ templateId: template.id, dayOfMonth: 5, startMonth: `${YEAR}-03`, endMonth: null, mode: "draft" }, user.id);
    const updated = await recurring.update(post.id, { dayOfMonth: "last", endMonth: `${YEAR}-04`, mode: "book" }, user.id);
    expect(updated).toMatchObject({ dayOfMonth: "last", endMonth: `${YEAR}-04`, mode: "book", nextRunMonth: `${YEAR}-03`, nextRunDate: `${YEAR}-03-31` });
    await expect(recurring.update(post.id, { endMonth: `${YEAR}-02` }, user.id)).rejects.toThrow(RecurringTemplateIncompleteError);
  });
});

describe("fördela över perioder", () => {
  it("creates its own template and a booked post whose months sum exactly to the amount", async () => {
    const { user } = await setup();
    today = `${YEAR}-12-31`;
    const post = await recurring.createAllocation(
      {
        amount: 10000,
        kind: "cost",
        balanceAccount: "1790",
        resultAccount: "5010",
        firstMonth: `${YEAR}-01`,
        months: 3,
        description: "Försäkring",
      },
      user.id
    );
    expect(post).toMatchObject({
      kind: "allocation",
      mode: "book",
      dayOfMonth: "last",
      startMonth: `${YEAR}-01`,
      endMonth: `${YEAR}-03`,
      description: "Försäkring",
      nextRunMonth: null,
      allocation: { amount: 10000, kind: "cost", balanceAccount: "1790", resultAccount: "5010", months: 3, scheduleAmounts: [3333.33, 3333.33, 3333.34] },
    });
    expect(post.templateName).toBe(`Fördelning: Försäkring ${YEAR}-01`);
    expect(post.runs.map((r) => r.status)).toEqual(["created", "created", "created"]);

    const booked = await allVerifications();
    expect(booked.map((v) => [v.date, v.description, v.status])).toEqual([
      [`${YEAR}-01-31`, "Försäkring (månad 1 av 3)", "booked"],
      [`${YEAR}-02-28`, "Försäkring (månad 2 av 3)", "booked"],
      [`${YEAR}-03-31`, "Försäkring (månad 3 av 3)", "booked"],
    ]);
    const rows = await db
      .select({ debit: verificationRows.debit, credit: verificationRows.credit, accountId: verificationRows.accountId })
      .from(verificationRows);
    const rent = await economyRepo.findAccountByNumber("5010");
    const debitOnRent = rows.filter((r) => r.accountId === rent!.id).map((r) => Number(r.debit));
    expect(debitOnRent.sort()).toEqual([3333.33, 3333.33, 3333.34]);
    expect(round2(debitOnRent.reduce((a, b) => a + b, 0))).toBe(10000);
    const totalDebit = round2(rows.reduce((a, r) => a + Number(r.debit), 0));
    const totalCredit = round2(rows.reduce((a, r) => a + Number(r.credit), 0));
    expect(totalDebit).toBe(10000);
    expect(totalCredit).toBe(10000);
  });

  it("revenue runs the other way, a second fördelning of the same text gets its own template name, and bad input is refused", async () => {
    const { user } = await setup();
    today = `${YEAR}-01-31`;
    const first = await recurring.createAllocation(
      { amount: 600, kind: "revenue", balanceAccount: "2990", resultAccount: "3010", firstMonth: `${YEAR}-01`, months: 2, description: "Serviceavtal" },
      user.id
    );
    const second = await recurring.createAllocation(
      { amount: 600, kind: "revenue", balanceAccount: "2990", resultAccount: "3010", firstMonth: `${YEAR}-01`, months: 2, description: "Serviceavtal" },
      user.id
    );
    expect(second.templateName).toBe(`${first.templateName} (2)`);
    const [verification] = await allVerifications();
    const rows = await db.select().from(verificationRows).where(eq(verificationRows.verificationId, verification!.id));
    const revenue = await economyRepo.findAccountByNumber("3010");
    const revenueRow = rows.find((r) => r.accountId === revenue!.id)!;
    expect([Number(revenueRow.debit), Number(revenueRow.credit)]).toEqual([0, 300]);

    await expect(
      recurring.createAllocation(
        { amount: 100, kind: "cost", balanceAccount: "1790", resultAccount: "1790", firstMonth: `${YEAR}-01`, months: 2, description: "x" },
        user.id
      )
    ).rejects.toThrow(RecurringTemplateIncompleteError);
    await expect(
      recurring.createAllocation(
        { amount: 100, kind: "cost", balanceAccount: "1799", resultAccount: "5010", firstMonth: `${YEAR}-01`, months: 2, description: "x" },
        user.id
      )
    ).rejects.toMatchObject({ name: "VerificationTemplateAccountMissingError", accounts: ["1799"] });
    await expect(
      recurring.createAllocation(
        { amount: 0.05, kind: "cost", balanceAccount: "1790", resultAccount: "5010", firstMonth: `${YEAR}-01`, months: 7, description: "x" },
        user.id
      )
    ).rejects.toThrow(RecurringTemplateIncompleteError);

    // Deleting a fördelning takes its own template with it; the bookings stay.
    await recurring.delete(second.id, user.id);
    expect((await templates.list(true)).rows.map((t) => t.name)).toEqual([first.templateName, "Hyra"]);
    expect(await allVerifications()).toHaveLength(2);
  });
});

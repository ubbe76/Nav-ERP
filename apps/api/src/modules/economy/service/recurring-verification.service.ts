import type { RecurringAllocation } from "@navet/db";
import {
  round2,
  type CreateAllocationInput,
  type CreateRecurringVerificationInput,
  type RecurringDayOfMonth,
  type UpdateRecurringVerificationInput,
} from "@navet/shared";
import type { AuditWriter } from "../../system/repository/audit.repository.js";
import { isBookkeepingLockViolation, isUniqueViolation } from "../../system/service/db-errors.js";
import { stockholmToday } from "../../system/service/delivery-days.js";
import type { EconomyRepository, VerificationRowWrite } from "../repository/economy.repository.js";
import type {
  RecurringPatch,
  RecurringRow,
  RecurringRunRow,
  RecurringRunStatus,
  RecurringVerificationRepository,
} from "../repository/recurring-verification.repository.js";
import type { TemplateRowWrite, VerificationTemplateRepository, VerificationTemplateView } from "../repository/verification-template.repository.js";
import { AccountingPeriodLockedError, FiscalYearClosedError } from "./accounting-period-lock.js";
import {
  InactiveAccountError,
  NoAccountingPeriodError,
  NoFiscalYearForDateError,
  TooFewVerificationRowsError,
  UnbalancedVerificationError,
  VerificationNotFoundError,
  VerificationSeriesNotFoundError,
  type EconomyService,
} from "./economy.service.js";
import {
  AllocationTooSmallError,
  addMonths,
  allocationAmounts,
  allocationDescription,
  monthsBetween,
  monthsDue,
  nextRunMonth,
  runDate,
} from "./recurring-schedule.js";
import { VerificationTemplateAccountMissingError, VerificationTemplateNotFoundError } from "./verification-template.service.js";

// Återkommande verifikat (snabbare manuell bokföring, etapp 3). A post =
// a template + a day of month + a month range + draft/book. The job
// (runDue, once an hour from server.ts) creates every month whose day has
// passed and that has no run yet; each month is ONE transaction — the
// verification (created, and booked for `book`) together with its run row,
// whose unique (post, month) is the reservation. A failure writes a `failed`
// row afterwards: the month is shown and alerted, and is NOT retried
// automatically — Kör nu is the retry, so a locked period or an inactive
// account does not produce an hourly stream of identical failures.
//
// A paused post skips: the months whose day passes while it is paused are
// written as `skipped` rows when it is activated again (same transaction),
// so neither the job nor Kör nu creates them afterwards — the alternative,
// a flood of back-dated verifications on Aktivera, is never what a pause
// meant. Kör nu on a paused post still creates every due month: that is an
// explicit request. The view's `skippedOnActivate` tells the web beforehand
// which months Aktivera would skip.
//
// Fördela över perioder is a post with its own template (the two accounts,
// no amounts) and a stored schedule (amount / months, the last month takes
// the rest), mode book, an end month — every month books exactly its share.

export class RecurringVerificationNotFoundError extends Error {
  constructor(id: string) {
    super(`Recurring verification ${id} not found`);
    this.name = "RecurringVerificationNotFoundError";
  }
}

// The template cannot be booked as it stands — a row without an amount, or
// the rows do not balance. The message says which.
export class RecurringTemplateIncompleteError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = "RecurringTemplateIncompleteError";
  }
}

// Internal: the (post, month) row was taken by a concurrent run — rolls the
// verification back; never leaves this module.
class RunClaimedError extends Error {}

export interface RecurringRunView {
  id: string;
  month: string;
  status: RecurringRunStatus;
  error: string | null;
  verificationId: string | null;
  verificationDisplayNumber: string | null;
  createdAt: string;
}

export interface RecurringView {
  id: string;
  templateId: string;
  templateName: string;
  description: string;
  dayOfMonth: RecurringDayOfMonth;
  startMonth: string;
  endMonth: string | null;
  mode: "draft" | "book";
  active: boolean;
  nextRunMonth: string | null;
  nextRunDate: string | null;
  kind: "template" | "allocation";
  allocation: (RecurringAllocation & { scheduleAmounts: number[] }) | null;
  lastRun: RecurringRunView | null;
  failedCount: number;
  // A paused post: the months whose day has passed without a run, which
  // Aktivera will mark `skipped`. Always [] for an active post.
  skippedOnActivate: string[];
}

export type RecurringDetailView = RecurringView & { runs: RecurringRunView[] };

// PATCH's answer: the detail plus the months the activation just skipped.
export type RecurringUpdateView = RecurringDetailView & { skippedMonths: string[] };

// What a failed month stores when the error is none of the known refusals:
// the real error goes to the server log, never to the card or the alert.
export const UNEXPECTED_RUN_ERROR = "Ett oväntat fel inträffade — se serverloggen";

export interface RecurringRunOutcome {
  created: RecurringRunView[];
  failed: RecurringRunView[];
}

// Why a month could not be created, in the user's language — shown on the
// card and in the alert. null for an error this module does not know: the
// caller stores UNEXPECTED_RUN_ERROR and logs the real one.
export function runErrorMessage(err: unknown): string | null {
  if (err instanceof FiscalYearClosedError) return "Räkenskapsåret är stängt";
  if (err instanceof AccountingPeriodLockedError) return `Perioden är låst (${err.message.replace(/^Accounting period for (\S+) is locked$/, "$1")})`;
  if (err instanceof NoFiscalYearForDateError) return "Inget räkenskapsår täcker datumet";
  if (err instanceof NoAccountingPeriodError) return "Ingen bokföringsperiod täcker datumet";
  if (err instanceof InactiveAccountError) return "Ett konto på mallen är inaktivt";
  if (err instanceof VerificationTemplateAccountMissingError) return `Kontot ${err.accounts.join(", ")} finns inte i kontoplanen`;
  if (err instanceof UnbalancedVerificationError) return "Verifikatet balanserar inte";
  if (err instanceof TooFewVerificationRowsError) return "Mallen har färre än två rader";
  if (err instanceof RecurringTemplateIncompleteError) return err.reason;
  if (isBookkeepingLockViolation(err)) return "Bokföringen är låst för datumet";
  return null;
}

function dayOf(row: RecurringRow): RecurringDayOfMonth {
  return row.dayOfMonth === null ? "last" : row.dayOfMonth;
}

function toRunView(run: RecurringRunRow): RecurringRunView {
  return {
    id: run.id,
    month: run.month,
    status: run.status,
    error: run.error,
    verificationId: run.verificationId,
    verificationDisplayNumber: run.verificationDisplayNumber,
    createdAt: run.createdAt.toISOString(),
  };
}

export function createRecurringVerificationService(deps: {
  repo: RecurringVerificationRepository;
  templates: VerificationTemplateRepository;
  economy: EconomyRepository;
  economyService: EconomyService;
  audit: AuditWriter;
  // Today's Stockholm date; the tests pin it.
  today?: () => string;
  log?: (msg: string, extra?: unknown) => void;
}) {
  const { repo, templates, economy, economyService, audit } = deps;
  const today = deps.today ?? stockholmToday;
  const log = deps.log ?? ((msg: string, extra?: unknown) => console.error(msg, extra));

  // The months a paused post would skip on Aktivera: exactly what the job
  // would create for it today — one rule, monthsDue.
  function skippedOnActivate(row: RecurringRow, doneMonths: ReadonlySet<string>): string[] {
    if (row.active) return [];
    return monthsDue({ startMonth: row.startMonth, endMonth: row.endMonth, dayOfMonth: dayOf(row), today: today(), doneMonths });
  }

  function toView(row: RecurringRow, runs: RecurringRunRow[]): RecurringView {
    const doneMonths = new Set(runs.map((r) => r.month));
    const next = row.active ? nextRunMonth({ startMonth: row.startMonth, endMonth: row.endMonth, dayOfMonth: dayOf(row), doneMonths }) : null;
    // runs are newest month first.
    const last = runs[0] ?? null;
    return {
      id: row.id,
      templateId: row.templateId,
      templateName: row.templateName,
      description: row.templateDescription,
      dayOfMonth: dayOf(row),
      startMonth: row.startMonth,
      endMonth: row.endMonth,
      mode: row.mode,
      active: row.active,
      nextRunMonth: next,
      nextRunDate: next ? runDate(next, dayOf(row)) : null,
      kind: row.allocation ? "allocation" : "template",
      allocation: row.allocation && row.scheduleAmounts ? { ...row.allocation, scheduleAmounts: row.scheduleAmounts } : null,
      lastRun: last ? toRunView(last) : null,
      failedCount: runs.filter((r) => r.status === "failed").length,
      skippedOnActivate: skippedOnActivate(row, doneMonths),
    };
  }

  async function detail(id: string): Promise<RecurringDetailView> {
    const row = await repo.findById(id);
    if (!row) throw new RecurringVerificationNotFoundError(id);
    const runs = (await repo.runsFor([id])).get(id) ?? [];
    return { ...toView(row, runs), runs: runs.map(toRunView) };
  }

  // The template's rows as the month's verification rows. A plain post takes
  // the template's amounts; a fördelning puts the month's schedule amount on
  // its two rows. Accounts are resolved by number through the tx so a chart
  // change is seen; missing or inactive stops the month.
  function buildRows(
    template: VerificationTemplateView,
    accountsByNumber: Map<string, { id: string; active: boolean }>,
    post: RecurringRow,
    month: string
  ): VerificationRowWrite[] {
    const missing = template.rows.map((r) => r.accountNumber).filter((n) => !accountsByNumber.has(n));
    if (missing.length > 0) throw new VerificationTemplateAccountMissingError([...new Set(missing)]);
    for (const row of template.rows) {
      const account = accountsByNumber.get(row.accountNumber)!;
      if (!account.active) throw new InactiveAccountError(account.id);
    }

    if (post.allocation && post.scheduleAmounts) {
      const index = monthsBetween(post.startMonth, month);
      const amount = post.scheduleAmounts[index];
      if (amount === undefined) throw new RecurringTemplateIncompleteError(`Fördelningen saknar belopp för ${month}`);
      const balance = accountsByNumber.get(post.allocation.balanceAccount);
      const result = accountsByNumber.get(post.allocation.resultAccount);
      if (!balance || !result) {
        throw new VerificationTemplateAccountMissingError([post.allocation.balanceAccount, post.allocation.resultAccount].filter((n) => !accountsByNumber.has(n)));
      }
      const debitAccount = post.allocation.kind === "cost" ? result : balance;
      const creditAccount = post.allocation.kind === "cost" ? balance : result;
      return [
        { accountId: debitAccount.id, debit: amount, credit: 0, description: null },
        { accountId: creditAccount.id, debit: 0, credit: amount, description: null },
      ];
    }

    return template.rows.map((row) => {
      const debit = row.debit ?? 0;
      const credit = row.credit ?? 0;
      if (debit <= 0 && credit <= 0) throw new RecurringTemplateIncompleteError(`Mallens rad för konto ${row.accountNumber} saknar belopp`);
      return { accountId: accountsByNumber.get(row.accountNumber)!.id, debit: round2(debit), credit: round2(credit), description: row.description };
    });
  }

  // One month, one transaction: template + accounts read through the tx,
  // the verification created (and booked), the run row inserted last. A
  // conflict on the run row = another writer committed this month first →
  // RunClaimedError rolls the verification back.
  async function createMonth(post: RecurringRow, month: string): Promise<RecurringRunRow> {
    const date = runDate(month, dayOf(post));
    return economy.transaction(async (tx) => {
      const template = await templates.findById(post.templateId, tx);
      if (!template) throw new VerificationTemplateNotFoundError(post.templateId);
      const numbers = [
        ...template.rows.map((r) => r.accountNumber),
        ...(post.allocation ? [post.allocation.balanceAccount, post.allocation.resultAccount] : []),
      ];
      const accountsByNumber = await economy.accountsByNumbers(tx, numbers);
      const rows = buildRows(template, accountsByNumber, post, month);
      const description = post.allocation
        ? allocationDescription(template.description, month, post.startMonth, post.allocation.months)
        : template.description;
      const { id } = await economyService.createVerificationInTx(
        tx,
        { seriesId: template.seriesId, date, description: description.slice(0, 255), rows },
        post.createdBy,
        { book: post.mode === "book" }
      );
      const runId = await repo.insertRunInTx(tx, post.id, month, id);
      if (!runId) throw new RunClaimedError();
      return { id: runId, recurringId: post.id, month, status: "created", error: null, verificationId: id, verificationDisplayNumber: null, createdAt: new Date() };
    });
  }

  // Every due month of one post, oldest first. Failures are recorded (and
  // stop nothing — the next month is tried too); a month another writer
  // took is skipped silently.
  async function runPost(post: RecurringRow, doneMonths: ReadonlySet<string>): Promise<RecurringRunOutcome> {
    const outcome: RecurringRunOutcome = { created: [], failed: [] };
    const months = monthsDue({ startMonth: post.startMonth, endMonth: post.endMonth, dayOfMonth: dayOf(post), today: today(), doneMonths });
    for (const month of months) {
      try {
        const run = await createMonth(post, month);
        outcome.created.push(toRunView(run));
      } catch (err) {
        if (err instanceof RunClaimedError) continue;
        const known = runErrorMessage(err);
        // An unknown error is logged in full (stack and all) and stored as
        // the generic text — its message may name internals.
        log(`Recurring verification ${post.templateName} ${month} failed`, known ? { error: known } : { error: err });
        const message = known ?? UNEXPECTED_RUN_ERROR;
        const runId = await repo.recordFailure(post.id, month, message);
        if (runId) outcome.failed.push({ id: runId, month, status: "failed", error: message, verificationId: null, verificationDisplayNumber: null, createdAt: new Date().toISOString() });
      }
    }
    // The display numbers of what was booked.
    if (outcome.created.length > 0) {
      const fresh = (await repo.runsFor([post.id])).get(post.id) ?? [];
      const byId = new Map(fresh.map((r) => [r.id, r] as const));
      outcome.created = outcome.created.map((run) => (byId.has(run.id) ? toRunView(byId.get(run.id)!) : run));
    }
    return outcome;
  }

  async function doneMonthsOf(postId: string): Promise<Set<string>> {
    return new Set(((await repo.runsFor([postId])).get(postId) ?? []).map((r) => r.month));
  }

  // The template a plain post books every month must be bookable as it
  // stands: an amount on every row, at least two rows, balanced.
  function assertTemplateComplete(template: VerificationTemplateView) {
    if (template.rows.length < 2) throw new RecurringTemplateIncompleteError("Mallen måste ha minst två rader");
    let debit = 0;
    let credit = 0;
    for (const row of template.rows) {
      if ((row.debit ?? 0) <= 0 && (row.credit ?? 0) <= 0) {
        throw new RecurringTemplateIncompleteError(`Mallens rad för konto ${row.accountNumber} saknar belopp`);
      }
      debit = round2(debit + (row.debit ?? 0));
      credit = round2(credit + (row.credit ?? 0));
    }
    if (debit !== credit) throw new RecurringTemplateIncompleteError(`Mallen balanserar inte (debet ${debit}, kredit ${credit})`);
  }

  const service = {
    async list() {
      const rows = await repo.list();
      const runs = await repo.runsFor(rows.map((r) => r.id));
      return { rows: rows.map((row) => toView(row, runs.get(row.id) ?? [])), total: rows.length };
    },

    findById: detail,

    // A new post catches up right away (the months already due), so a start
    // month this month shows its first verification at once instead of
    // after the next hourly tick.
    async create(input: CreateRecurringVerificationInput, userId: string) {
      const template = await templates.findById(input.templateId);
      if (!template) throw new VerificationTemplateNotFoundError(input.templateId);
      assertTemplateComplete(template);
      const id = await repo.create(
        {
          templateId: input.templateId,
          dayOfMonth: input.dayOfMonth === "last" ? null : input.dayOfMonth,
          startMonth: input.startMonth,
          endMonth: input.endMonth ?? null,
          mode: input.mode,
          scheduleAmounts: null,
          allocation: null,
        },
        userId
      );
      await audit.log({
        entityType: "recurring_verification",
        entityId: id,
        action: "created",
        detail: { template: template.name, startMonth: input.startMonth, endMonth: input.endMonth ?? null, mode: input.mode },
        userId,
      });
      const post = await repo.findById(id);
      await runPost(post!, new Set());
      return detail(id);
    },

    // Aktivera (active false → true) marks the months that fell due during
    // the pause as skipped, in the same transaction as the flag — a job tick
    // between the two would otherwise create them all. The response names
    // them (skippedMonths); the list's skippedOnActivate showed them before.
    async update(id: string, input: UpdateRecurringVerificationInput, userId: string): Promise<RecurringUpdateView> {
      const existing = await repo.findById(id);
      if (!existing) throw new RecurringVerificationNotFoundError(id);
      if (input.endMonth !== undefined && input.endMonth !== null && input.endMonth < existing.startMonth) {
        throw new RecurringTemplateIncompleteError("Slutmånaden kan inte ligga före startmånaden");
      }
      if (existing.allocation && input.endMonth !== undefined) {
        throw new RecurringTemplateIncompleteError("En fördelnings slutmånad följer antalet månader och kan inte ändras");
      }
      const patch: RecurringPatch = {};
      if (input.active !== undefined) patch.active = input.active;
      if (input.dayOfMonth !== undefined) patch.dayOfMonth = input.dayOfMonth === "last" ? null : input.dayOfMonth;
      if (input.endMonth !== undefined) patch.endMonth = input.endMonth;
      if (input.mode !== undefined) patch.mode = input.mode;
      const activating = input.active === true && !existing.active;
      const skippedMonths = await economy.transaction(async (tx) => {
        let skipped: string[] = [];
        if (activating) {
          const runs = (await repo.runsFor([id], tx)).get(id) ?? [];
          // The post as it is NOW (the day may be patched in the same call):
          // the schedule that applies after this update decides what is due.
          const after: RecurringRow = { ...existing, ...patch, active: false };
          const due = skippedOnActivate(after, new Set(runs.map((r) => r.month)));
          skipped = await repo.insertSkippedRunsInTx(tx, id, due);
        }
        if (!(await repo.update(id, patch, tx))) throw new RecurringVerificationNotFoundError(id);
        return skipped;
      });
      await audit.log({
        entityType: "recurring_verification",
        entityId: id,
        action: "updated",
        detail: { fields: Object.keys(input), ...(skippedMonths.length > 0 ? { skippedMonths } : {}) },
        userId,
      });
      return { ...(await detail(id)), skippedMonths };
    },

    // Deletes the post. The verifications it created stay (räkenskaps-
    // information); their run rows stay too, unlinked (ON DELETE SET NULL),
    // so a verification can always be traced back; failed and skipped rows go.
    async delete(id: string, userId: string) {
      const existing = await repo.findById(id);
      if (!existing) throw new RecurringVerificationNotFoundError(id);
      // A fördelning's template exists only for the post — it goes too.
      if (!(await repo.delete(id, existing.allocation !== null))) throw new RecurringVerificationNotFoundError(id);
      await audit.log({ entityType: "recurring_verification", entityId: id, action: "deleted", detail: { template: existing.templateName }, userId });
    },

    // Kör nu: the failed months are tried again and every due month
    // created — the one place a failed month is retried. Runs whether the
    // post is paused or not: the user asked for it. Skipped months stay
    // skipped (they have a row).
    async run(id: string, userId: string): Promise<RecurringRunOutcome> {
      const post = await repo.findById(id);
      if (!post) throw new RecurringVerificationNotFoundError(id);
      await repo.deleteFailedRuns(id);
      const outcome = await runPost(post, await doneMonthsOf(id));
      await audit.log({
        entityType: "recurring_verification",
        entityId: id,
        action: "run",
        detail: { created: outcome.created.map((r) => r.month), failed: outcome.failed.map((r) => r.month) },
        userId,
      });
      return outcome;
    },

    // The job: every active post, every due month without a run. Nothing is
    // retried here (a failed month has a row) — see the file comment.
    async runDue(): Promise<{ posts: number; created: number; failed: number }> {
      const posts = await repo.listActive();
      const runs = await repo.runsFor(posts.map((p) => p.id));
      let created = 0;
      let failed = 0;
      for (const post of posts) {
        const doneMonths = new Set((runs.get(post.id) ?? []).map((r) => r.month));
        try {
          const outcome = await runPost(post, doneMonths);
          created += outcome.created.length;
          failed += outcome.failed.length;
        } catch (err) {
          // One post's unexpected failure (e.g. recordFailure itself failing)
          // never stops the others.
          log(`Recurring verification ${post.templateName} aborted`, { error: err instanceof Error ? err.message : String(err) });
        }
      }
      return { posts: posts.length, created, failed };
    },

    // Fördela över perioder: its own template (the two accounts, no amounts)
    // + a post with the stored schedule, mode book, ending after `months`
    // months, booked on each month's last day. Created in one transaction
    // and caught up at once.
    async createAllocation(input: CreateAllocationInput, userId: string) {
      if (input.balanceAccount === input.resultAccount) {
        throw new RecurringTemplateIncompleteError("Balanskonto och resultatkonto måste vara olika konton");
      }
      const accountsByNumber = await economy.accountsByNumbers(null, [input.balanceAccount, input.resultAccount]);
      const missing = [input.balanceAccount, input.resultAccount].filter((n) => !accountsByNumber.has(n));
      if (missing.length > 0) throw new VerificationTemplateAccountMissingError(missing);
      for (const number of [input.balanceAccount, input.resultAccount]) {
        const account = accountsByNumber.get(number)!;
        if (!account.active) throw new InactiveAccountError(account.id);
      }

      const seriesId = await resolveAllocationSeries(input);
      let schedule: number[];
      try {
        schedule = allocationAmounts(input.amount, input.months);
      } catch (err) {
        if (err instanceof AllocationTooSmallError) throw new RecurringTemplateIncompleteError(err.message);
        throw err;
      }
      const endMonth = addMonths(input.firstMonth, input.months - 1);
      const allocation: RecurringAllocation = {
        amount: round2(input.amount),
        kind: input.kind,
        balanceAccount: input.balanceAccount,
        resultAccount: input.resultAccount,
        months: input.months,
      };
      const templateRows: TemplateRowWrite[] =
        input.kind === "cost"
          ? [
              { accountNumber: input.resultAccount, description: null, debit: null, credit: null },
              { accountNumber: input.balanceAccount, description: null, debit: null, credit: null },
            ]
          : [
              { accountNumber: input.balanceAccount, description: null, debit: null, credit: null },
              { accountNumber: input.resultAccount, description: null, debit: null, credit: null },
            ];

      // The template's name must be unique; a repeated fördelning of the
      // same text and month gets a counter.
      const baseName = `Fördelning: ${input.description} ${input.firstMonth}`.slice(0, 100);
      let id: string | null = null;
      for (let attempt = 1; attempt <= 20 && id === null; attempt++) {
        const name = attempt === 1 ? baseName : `${baseName.slice(0, 100 - ` (${attempt})`.length)} (${attempt})`;
        try {
          id = await economy.transaction(async (tx) => {
            const templateId = await templates.create({ name, seriesId, description: input.description }, templateRows, userId, tx);
            return repo.create(
              {
                templateId,
                dayOfMonth: null,
                startMonth: input.firstMonth,
                endMonth,
                mode: "book",
                scheduleAmounts: schedule,
                allocation,
              },
              userId,
              tx
            );
          });
        } catch (err) {
          if (!isUniqueViolation(err)) throw err;
        }
      }
      if (id === null) throw new RecurringTemplateIncompleteError("Kunde inte ge fördelningens mall ett unikt namn");

      await audit.log({
        entityType: "recurring_verification",
        entityId: id,
        action: "allocation_created",
        detail: {
          amount: allocation.amount,
          kind: input.kind,
          balanceAccount: input.balanceAccount,
          resultAccount: input.resultAccount,
          firstMonth: input.firstMonth,
          months: input.months,
          sourceVerificationId: input.sourceVerificationId ?? null,
        },
        userId,
      });
      const post = await repo.findById(id);
      await runPost(post!, new Set());
      return detail(id);
    },
  };

  // The fördelning's series: the one asked for, else the source
  // verification's, else A, else the first series there is.
  async function resolveAllocationSeries(input: CreateAllocationInput): Promise<string> {
    if (input.seriesId) {
      if (!(await economy.findSeriesById(input.seriesId))) throw new VerificationSeriesNotFoundError(input.seriesId);
      return input.seriesId;
    }
    if (input.sourceVerificationId) {
      const source = await economy.findRawById(input.sourceVerificationId);
      if (!source) throw new VerificationNotFoundError(input.sourceVerificationId);
      return source.seriesId;
    }
    const series = await economy.listSeries();
    const manual = series.find((s) => s.code === "A") ?? series[0];
    if (!manual) throw new VerificationSeriesNotFoundError("A");
    return manual.id;
  }

  return service;
}

export type RecurringVerificationService = ReturnType<typeof createRecurringVerificationService>;

declare module "fastify" {
  interface FastifyInstance {
    recurringVerifications: RecurringVerificationService;
  }
}

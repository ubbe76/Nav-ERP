import type { Db, Tx } from "@navet/db";
import { round2, SEK, type CreateLateInterestInvoicesInput, type LateInterestCandidatesQuery } from "@navet/shared";
import { AccountingPeriodLockedError, FiscalYearClosedError } from "../../economy/service/accounting-period-lock.js";
import { documentVatCode, InvalidVatCodeError } from "../../economy/service/document-vat-code.js";
import {
  MissingPostingAccountError,
  NoAccountingPeriodForPostingError,
  VatCodeAmountMismatchError,
  VatCodeNotApplicableError,
  ZeroAmountPostingError,
} from "../../economy/service/verification-poster.js";
import { isBookkeepingLockViolation } from "../../system/service/db-errors.js";
import type { AuditWriter } from "../../system/repository/audit.repository.js";
import { stockholmToday } from "../../system/service/delivery-days.js";
import type { ReferenceRateReader } from "../../system/service/exchange-rates.js";
import type { InvoiceRepository, InvoiceRowWrite } from "../repository/invoice.repository.js";
import {
  chargesByInvoice,
  insertCharges,
  listLateInterestSources,
  lockInvoices,
  paymentsByInvoice,
  reminderFeesByInvoice,
  type LateInterestChargeWrite,
  type LateInterestSource,
} from "../repository/late-interest.repository.js";
import {
  addDays,
  fullyPaidDate,
  halfYearStartsBetween,
  lateFeeAmount,
  lateFeeRowText,
  lateInterest,
  lateInterestRowText,
  type LateInterestSegment,
} from "./late-interest.js";

// Räntefakturering (Försäljning): the candidate list and Skapa
// räntefakturor. The arithmetic is late-interest.ts (pure), the reads the
// Db|Tx leaf late-interest.repository.ts — the list reads outside any
// transaction, the run re-reads the SAME way under the source invoices'
// FOR UPDATE and refuses when the result differs from what the client
// ticked (the dubbeldebiteringsspärr). Referensräntor are fetched BEFORE
// the transaction (Riksbanken may be called), never inside it.

export class LateInterestDisabledError extends Error {
  constructor() {
    super("Dröjsmålsränta är avstängd — slå på Debitera dröjsmålsränta under Ekonomi → Konteringsregler");
    this.name = "LateInterestDisabledError";
  }
}

// The period/fee the client sent no longer holds for these invoices (charged
// meanwhile by another run, a payment arrived, the customer changed) — 409
// late-interest-already-charged with the ids; the web reloads the list.
export class LateInterestAlreadyChargedError extends Error {
  constructor(public invoiceIds: string[]) {
    super(`Late interest or fee already charged (or no longer applicable) for ${invoiceIds.length} invoice(s)`);
    this.name = "LateInterestAlreadyChargedError";
  }
}

// Utfärda direkt failed for one räntefaktura: why, in the user's language —
// shown in the routine's Resultat. The error classes' own messages are
// English and may name internals, so an unknown error gets the generic text
// and goes to the server log in full (the recurring verifications' rule).
export const UNEXPECTED_ISSUE_ERROR = "Ett oväntat fel inträffade — se serverloggen";

export function issueErrorText(err: unknown): string | null {
  if (err instanceof FiscalYearClosedError) return "Räkenskapsåret är stängt — öppna det under Bokslut och utfärda fakturan";
  if (err instanceof AccountingPeriodLockedError) return "Bokföringsperioden för fakturadatumet är låst";
  if (err instanceof NoAccountingPeriodForPostingError) return "Ingen bokföringsperiod täcker fakturadatumet";
  if (err instanceof MissingPostingAccountError) return `Kontot ${err.accountNumber} saknas eller är inaktivt i kontoplanen`;
  if (err instanceof InvalidVatCodeError) return `Momskoden ${err.vatCode} saknas eller är inaktiv`;
  if (err instanceof VatCodeAmountMismatchError || err instanceof VatCodeNotApplicableError) {
    return `Momskoden ${err.code} stämmer inte med fakturans rader`;
  }
  if (err instanceof ZeroAmountPostingError) return "Fakturan har inget belopp att bokföra";
  if (isBookkeepingLockViolation(err)) return "Bokföringen är låst för datumet";
  return null;
}

// T.o.m. datum after today: interest for days that have not passed yet
// would be charged — 400 late-interest-future-date.
export class LateInterestFutureDateError extends Error {
  constructor(
    public asOf: string,
    public today: string
  ) {
    super(`T.o.m. datum ${asOf} ligger efter dagens datum ${today}`);
    this.name = "LateInterestFutureDateError";
  }
}

export type LateInterestCandidate = {
  invoiceId: string;
  invoiceNumber: string;
  customerId: string;
  customerName: string;
  privatePerson: boolean;
  dueDate: string;
  paidDate: string | null;
  principal: number;
  openAmount: number;
  fromDate: string;
  toDate: string;
  days: number;
  rate: number | null;
  rates: number[];
  interest: number | null;
  fee: number;
  belowMinimum: boolean;
  rateMissing: boolean;
  segments: LateInterestSegment[];
};

export type LateInterestRunResult = {
  created: { invoiceId: string; invoiceNumber: string | null; customerName: string; status: string; total: number }[];
  skipped: { customerName: string; reason: string }[];
  issueFailed: { invoiceId: string; error: string }[];
};

type LateInterestSettings = {
  lateInterestEnabled: boolean;
  lateInterestMargin: number;
  lateInterestMinAmount: number;
  lateFeeEnabled: boolean;
  postingLateInterest: string;
  postingLateFee: string;
};

// The slice of the invoice service the run uses: Utfärda direkt goes through
// the ordinary issue path, one transaction per invoice, after the run's own.
export interface LateInterestInvoiceIssuer {
  issue(id: string, userId: string): Promise<{ invoiceNumber: string | null; status: string } | null>;
}

export interface LateInterestServiceDeps {
  db: Db;
  invoiceRepo: InvoiceRepository;
  invoices: LateInterestInvoiceIssuer;
  referenceRates: ReferenceRateReader;
  audit?: AuditWriter;
  today?: () => string;
  // The server log for an Utfärda direkt failure this module does not know.
  log?: (msg: string, extra?: unknown) => void;
}

const sv = (n: number) => n.toLocaleString("sv-SE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/ /g, " ");

export function createLateInterestService(deps: LateInterestServiceDeps) {
  const { db, invoiceRepo, invoices } = deps;
  const audit: AuditWriter = deps.audit ?? { log: async () => {} };
  const today = deps.today ?? stockholmToday;
  const log = deps.log ?? ((msg: string, extra?: unknown) => console.error(msg, extra));

  async function readSettings(): Promise<LateInterestSettings> {
    const settings = await invoiceRepo.getLateInterestSettings();
    if (!settings.lateInterestEnabled) throw new LateInterestDisabledError();
    return settings;
  }

  // The half-years a set of sources can need: from the day after the
  // earliest due date through asOf (customers with an Avtalad räntesats
  // need none). Fetched from Riksbanken when missing — before any tx.
  async function ratesFor(sources: LateInterestSource[], asOf: string): Promise<Map<string, number>> {
    const dueDates = sources.filter((s) => s.agreedRate === null).map((s) => s.dueDate);
    if (dueDates.length === 0) return new Map();
    const earliest = dueDates.sort()[0]!;
    return deps.referenceRates.ensureReferenceRates(halfYearStartsBetween(addDays(earliest, 1), asOf));
  }

  // The candidates as of `asOf` — the one computation the list and the run
  // share, over the given executor (a Tx under the run's lock).
  async function computeCandidates(
    executor: Db | Tx,
    filter: { asOf: string; customerId?: string; invoiceIds?: string[]; includeUnpaid: boolean },
    settings: LateInterestSettings,
    rates: Map<string, number>
  ): Promise<{ rows: LateInterestCandidate[]; rateMissing: string[] }> {
    const sources = await listLateInterestSources(executor, filter);
    const ids = sources.map((s) => s.invoiceId);
    const [payments, charges, reminderFees] = await Promise.all([
      paymentsByInvoice(executor, ids),
      chargesByInvoice(executor, ids),
      reminderFeesByInvoice(executor, ids),
    ]);
    const rateList = [...rates].map(([validFrom, rate]) => ({ validFrom, rate }));
    const rateMissing = new Set<string>();
    const rows: LateInterestCandidate[] = [];
    for (const source of sources) {
      const paid = payments.get(source.invoiceId) ?? [];
      const active = (charges.get(source.invoiceId) ?? []).filter((charge) => charge.active);
      // The period starts the day after the due date, or after the last
      // active charged period.
      const lastChargedTo = active
        .map((charge) => charge.toDate)
        .filter((to): to is string => to !== null)
        .sort()
        .at(-1);
      const periodStartAfter = lastChargedTo && lastChargedTo > source.dueDate ? lastChargedTo : source.dueDate;
      const paidDate = fullyPaidDate(source.principal, paid, filter.asOf);
      if (paidDate === null && !filter.includeUnpaid) continue;
      const toDate = paidDate ?? filter.asOf;
      const openAmount = Math.max(
        0,
        round2(source.principal - paid.filter((p) => p.date <= filter.asOf).reduce((sum, p) => sum + p.amount, 0))
      );
      const result = lateInterest({
        principal: source.principal,
        dueDate: periodStartAfter,
        through: toDate,
        payments: paid,
        rates: rateList,
        margin: settings.lateInterestMargin,
        agreedRate: source.agreedRate,
      });
      for (const start of result.rateMissing) rateMissing.add(start);
      // Förseningsersättning: a business customer with Förseningsersättning,
      // paid after the due date or still open, not already charged (active).
      const late = paidDate === null || paidDate > source.dueDate;
      const feeCharged = active.some((charge) => charge.fee > 0);
      const fee =
        settings.lateFeeEnabled && source.customerLateFee && !source.privatePerson && late && !feeCharged
          ? lateFeeAmount(reminderFees.get(source.invoiceId) ?? 0)
          : 0;
      if (result.amount === 0 && fee === 0) continue;
      const distinctRates = [...new Set(result.segments.map((segment) => segment.rate))];
      rows.push({
        invoiceId: source.invoiceId,
        invoiceNumber: source.invoiceNumber,
        customerId: source.customerId,
        customerName: source.customerName,
        privatePerson: source.privatePerson,
        dueDate: source.dueDate,
        paidDate,
        principal: source.principal,
        openAmount,
        fromDate: addDays(periodStartAfter, 1),
        toDate,
        days: result.days,
        rate: distinctRates.length === 1 ? distinctRates[0]! : null,
        rates: distinctRates,
        interest: result.amount,
        fee,
        belowMinimum: result.amount !== null && result.amount > 0 && result.amount < settings.lateInterestMinAmount,
        rateMissing: result.amount === null,
        segments: result.segments,
      });
    }
    return { rows, rateMissing: [...rateMissing].sort() };
  }

  function assertNotFuture(asOf: string) {
    const now = today();
    if (asOf > now) throw new LateInterestFutureDateError(asOf, now);
  }

  const service = {
    // GET /late-interest/candidates. Reads — but fetches missing
    // referensräntor first (reference data, outside any transaction).
    async listCandidates(query: LateInterestCandidatesQuery) {
      const settings = await readSettings();
      const asOf = query.asOf ?? today();
      assertNotFuture(asOf);
      const filter = { asOf, customerId: query.customerId, includeUnpaid: query.includeUnpaid };
      const sources = await listLateInterestSources(db, filter);
      const rates = await ratesFor(sources, asOf);
      const { rows, rateMissing } = await computeCandidates(db, filter, settings, rates);
      return { asOf, rows, rateMissing };
    },

    // POST /late-interest/invoices — ONE transaction for every räntefaktura
    // of the call: lock the source invoices in id order, recompute each
    // ticked row and refuse when the period/fee the client sent no longer
    // holds, then one invoice per customer with its charge rows. Utfärda
    // direkt runs afterwards per invoice through the ordinary issue path.
    async createInvoices(input: CreateLateInterestInvoicesInput, userId: string): Promise<LateInterestRunResult> {
      assertNotFuture(input.asOf);
      const settings = await readSettings();
      const utm = documentVatCode(await invoiceRepo.vatCodeBook(), { code: "UTM" }, "sales");
      const ids = [...new Set(input.items.map((item) => item.invoiceId))].sort();
      // The rates, before the transaction (Riksbanken may be called).
      const rates = await ratesFor(await listLateInterestSources(db, { asOf: input.asOf, invoiceIds: ids }), input.asOf);

      const result: LateInterestRunResult = { created: [], skipped: [], issueFailed: [] };
      const createdIds: string[] = [];
      await db.transaction(async (tx) => {
        await lockInvoices(tx, ids);
        const { rows } = await computeCandidates(tx, { asOf: input.asOf, invoiceIds: ids, includeUnpaid: true }, settings, rates);
        const byInvoice = new Map(rows.map((row) => [row.invoiceId, row] as const));

        // The re-check: what the client ticked must still be exactly what
        // the list would show now.
        const conflicts: string[] = [];
        type Picked = { candidate: LateInterestCandidate; interest: boolean; fee: boolean };
        const picked: Picked[] = [];
        const seen = new Set<string>();
        for (const item of input.items) {
          const candidate = byInvoice.get(item.invoiceId);
          // A second item for the same invoice would charge it twice (the
          // route's schema refuses it already; the service never trusts that).
          const duplicate = seen.has(item.invoiceId);
          seen.add(item.invoiceId);
          if (!candidate || duplicate) {
            conflicts.push(item.invoiceId);
            continue;
          }
          const interestOk =
            !item.includeInterest || (candidate.interest !== null && candidate.interest > 0 && candidate.fromDate === item.fromDate);
          const feeOk = !item.includeFee || (candidate.fee > 0 && candidate.fee === item.fee);
          if (!interestOk || !feeOk) {
            conflicts.push(item.invoiceId);
            continue;
          }
          if (item.includeInterest || item.includeFee) picked.push({ candidate, interest: item.includeInterest, fee: item.includeFee });
        }
        if (conflicts.length > 0) throw new LateInterestAlreadyChargedError([...new Set(conflicts)].sort());

        // One räntefaktura per customer, customers in name order.
        const byCustomer = new Map<string, Picked[]>();
        for (const pick of picked) {
          const list = byCustomer.get(pick.candidate.customerId) ?? [];
          list.push(pick);
          byCustomer.set(pick.candidate.customerId, list);
        }
        const customerOrder = [...byCustomer.values()].sort((a, b) =>
          a[0]!.candidate.customerName.localeCompare(b[0]!.candidate.customerName, "sv")
        );
        for (const picks of customerOrder) {
          const customerName = picks[0]!.candidate.customerName;
          const customerId = picks[0]!.candidate.customerId;
          const customer = await invoiceRepo.findCustomerById(customerId);
          const interestPicks = picks.filter((pick) => pick.interest);
          const interestTotal = round2(interestPicks.reduce((sum, pick) => sum + (pick.candidate.interest ?? 0), 0));
          // Minsta räntebelopp applies to the ränta per räntefaktura: under
          // it the interest rows are dropped, the fee rows still go out.
          const withInterest = interestTotal >= settings.lateInterestMinAmount;
          const rows: InvoiceRowWrite[] = [];
          const charges: Omit<LateInterestChargeWrite, "chargeInvoiceId" | "chargeInvoiceRowId">[] = [];
          const baseRow = {
            articleId: null,
            salesOrderRowId: null,
            shipmentId: null,
            quantity: 1,
            discountPercent: 0,
            unitId: null,
            unitFactor: null,
            vatRate: 0,
            vatCodeId: utm.id,
            vatAmount: 0,
            deliveryDate: null,
            configuration: null,
          };
          for (const pick of picks) {
            const c = pick.candidate;
            if (pick.interest && withInterest) {
              rows.push({
                ...baseRow,
                description: lateInterestRowText({ invoiceNumber: c.invoiceNumber, from: c.fromDate, to: c.toDate, days: c.days, rates: c.rates }),
                unitPrice: c.interest!,
                lineAmount: c.interest!,
                revenueAccount: settings.postingLateInterest,
              });
              charges.push({ invoiceId: c.invoiceId, fromDate: c.fromDate, toDate: c.toDate, days: c.days, amount: c.interest!, fee: 0 });
            }
            if (pick.fee) {
              rows.push({
                ...baseRow,
                description: lateFeeRowText(c.invoiceNumber),
                unitPrice: c.fee,
                lineAmount: c.fee,
                revenueAccount: settings.postingLateFee,
              });
              charges.push({ invoiceId: c.invoiceId, fromDate: null, toDate: null, days: 0, amount: 0, fee: c.fee });
            }
          }
          if (rows.length === 0) {
            result.skipped.push({
              customerName,
              reason: `Räntan ${sv(interestTotal)} kr understiger minsta beloppet ${sv(settings.lateInterestMinAmount)} kr`,
            });
            continue;
          }
          const { invoice, rowIds } = await invoiceRepo.createInTx(
            tx,
            { customerId, paymentTermId: customer?.paymentTermId ?? null, note: "Räntefaktura", currency: SEK, exchangeRate: null, exchangeRateManual: false },
            rows,
            userId
          );
          await insertCharges(
            tx,
            charges.map((charge, index) => ({ ...charge, chargeInvoiceId: invoice.id, chargeInvoiceRowId: rowIds[index]! })),
            userId
          );
          const total = round2(rows.reduce((sum, row) => sum + row.lineAmount, 0));
          result.created.push({ invoiceId: invoice.id, invoiceNumber: null, customerName, status: "draft", total });
          createdIds.push(invoice.id);
        }
      });

      for (const created of result.created) {
        await audit.log({
          entityType: "invoice",
          entityId: created.invoiceId,
          action: "created",
          detail: { lateInterest: true, asOf: input.asOf, total: created.total },
          userId,
        });
      }

      // Utfärda direkt — the ordinary path, its own transaction per invoice;
      // a failure leaves that invoice as a draft and says why.
      if (input.issue) {
        for (const created of result.created) {
          try {
            const issued = await invoices.issue(created.invoiceId, userId);
            created.invoiceNumber = issued?.invoiceNumber ?? null;
            created.status = issued?.status ?? "issued";
          } catch (err) {
            const known = issueErrorText(err);
            if (!known) log(`Räntefakturering: issuing ${created.invoiceId} failed`, { error: err });
            result.issueFailed.push({ invoiceId: created.invoiceId, error: known ?? UNEXPECTED_ISSUE_ERROR });
          }
        }
      }
      return result;
    },
  };

  return service;
}

export type LateInterestService = ReturnType<typeof createLateInterestService>;

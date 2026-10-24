import { eq } from "drizzle-orm";
import { customerPayments, type Tx } from "@navet/db";
import type { CreatePaymentInput, ListOpenInvoicesQuery, ListPaymentsQuery } from "@navet/shared";
import { receiptExchangeDifference, round2, SEK } from "@navet/shared";
import { validateOcrNumber } from "../../system/service/ocr.js";
import { isUniqueViolation } from "../../system/service/db-errors.js";
import {
  PaymentGuardError,
  type CustomerPaymentSekReason,
  type PaymentGuardDetail,
  type PaymentGuardReason,
  type PaymentRepository,
  type PaymentRowInput,
} from "../repository/payment.repository.js";
import { InvoiceNotFoundError } from "./invoice.service.js";
// G1: append-only audit trail — optional with a no-op default (see
// sales.service.ts's identical comment).
import type { AuditWriter } from "../../system/repository/audit.repository.js";

// Kundreskontra (B3): the slice of the economy module's VerificationPoster
// this service uses — declared here, at the consumer, like every other
// cross-module reader in sales (CustomerInvoicePoster, StockBalanceReader).
// Both methods are Tx-composable by design: the posting happens inside the
// registration's (respectively the cancellation's) own transaction, so the
// verification, its verifikatnummer, the BET number and the invoice's paid
// flip either all commit or all roll back.
export interface CustomerPaymentPoster {
  // Returns null when the payment moves nothing in the ledger (a pure
  // kvittning between open items on the same receivable account) — that is
  // not a bokföringshändelse and gets no verification.
  postCustomerPayment(
    tx: Tx,
    doc: {
      paymentNumber: string;
      paymentDate: string;
      bankAccountNumber: string;
      // The BANK part only. The poster requires it to equal Σ appliedAmount —
      // that identity IS the balance condition of the verification.
      bankAmount: number;
      customerName: string;
      // Valuta: the payment's currency, the SEK the bank account got and the
      // bank's fee in SEK.
      currency: string;
      bankAmountSek: number;
      bankFeeSek: number;
    },
    // appliedAmountSek/writeOffAmountSek: the SEK each part releases from the
    // invoice's booked receivable (frigjort SEK).
    rows: { appliedAmount: number; writeOffAmount: number; appliedAmountSek: number; writeOffAmountSek: number }[],
    userId: string
  ): Promise<{ verificationId: string; displayNumber: string } | null>;

  reverseBookedVerification(
    tx: Tx,
    sourceVerificationId: string,
    opts: { date: string; description: string },
    userId: string
  ): Promise<{ verificationId: string } | { alreadyReversed: true }>;
}

export class PaymentNotFoundError extends Error {
  constructor(id: string) {
    super(`Payment ${id} not found`);
    this.name = "PaymentNotFoundError";
  }
}

// The invoice is not an open item: not issued (a draft has no open item yet,
// a paid/cancelled one has none left) or nothing left to settle on it.
export class InvoiceNotOpenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvoiceNotOpenError";
  }
}

// The payment's rows do not fit each other or the open items they name:
// amounts that do not add up to the bank amount, the same open item twice, a
// row that settles nothing, an invoice belonging to another customer, or an
// amount pointing the opposite way to what is open.
export class PaymentRowMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentRowMismatchError";
  }
}

// Settling more than is open, beyond what the tolerance setting allows to be
// written off. Overpayments are a bookkeeping decision (kundförlust/refund),
// never something the reskontra guesses at.
export class PaymentExceedsOpenAmountError extends Error {
  constructor(
    public invoiceNumber: string | null,
    public open: number,
    public applied: number
  ) {
    super(
      `Payment of ${applied} exceeds the open amount ${open} on invoice ${invoiceNumber ?? "?"} by more than the tolerance`
    );
    this.name = "PaymentExceedsOpenAmountError";
  }
}

export class PaymentAlreadyCancelledError extends Error {
  constructor(id: string) {
    super(`Payment ${id} is already cancelled`);
    this.name = "PaymentAlreadyCancelledError";
  }
}

// The OCR reference is not a well-formed reference at all (digits, length
// digit, Luhn) — a different answer from "no open invoice carries it", which
// is a 404.
export class InvalidOcrError extends Error {
  constructor(ocr: string) {
    super(`"${ocr}" is not a valid OCR reference`);
    this.name = "InvalidOcrError";
  }
}

// An unbooked manual omföring already exists on the payment's verification, so
// the cancellation's own omföring collided with the partial unique index. Same
// condition (and same name) as the supplier invoice's cancellation.
export class VerificationAlreadyReversedError extends Error {
  constructor() {
    super("The payment's verification already has an omföring — book or delete it first");
    this.name = "VerificationAlreadyReversedError";
  }
}

// Valuta: one payment never mixes currencies (and a bank entry's payment is in
// the entry's currency). 400 payment-mixed-currencies — the same class name,
// and so the same code, as the supplier side's.
export class PaymentMixedCurrenciesError extends Error {
  constructor(public currencies: string[]) {
    super(`En betalning kan inte reglera fakturor i flera valutor (${currencies.join(", ")})`);
    this.name = "PaymentMixedCurrenciesError";
  }
}

// Valuta: the SEK amount/fee does not fit the payment. 400
// customer-payment-amount-sek with `reason`:
//   required  — a payment in another currency needs Belopp i SEK,
//   sign      — the SEK amount is zero or points the other way,
//   fee       — the fee exceeds the SEK amount,
//   kvittning — a kvittning (amount 0) moves no SEK and has no fee,
//   sek       — a SEK payment's SEK amount is the amount itself, without fee.
export class CustomerPaymentAmountSekError extends Error {
  constructor(
    public reason: CustomerPaymentSekReason,
    public currency: string
  ) {
    const text: Record<CustomerPaymentSekReason, string> = {
      required: `En betalning i ${currency} behöver beloppet i SEK som kom in på kontot`,
      sign: "Beloppet i SEK måste vara skilt från 0 och ha samma tecken som betalningens belopp",
      fee: "Bankavgiften kan inte vara större än beloppet i SEK",
      kvittning: "En kvittning flyttar inga pengar — den har varken belopp i SEK eller bankavgift",
      sek: "En betalning i SEK har beloppet självt i SEK och ingen egen bankavgift",
    };
    super(text[reason]);
    this.name = "CustomerPaymentAmountSekError";
  }
}

// The checks that can be settled from the input alone — shared by create()
// and createInTx(). Every state-dependent one (status, customer, open amount,
// tolerance) belongs to the repository's transaction, after the invoices are
// row-locked.
function normalizedRows(input: CreatePaymentInput): PaymentRowInput[] {
  const rows: PaymentRowInput[] = input.rows.map((row) => ({
    invoiceId: row.invoiceId,
    appliedAmount: round2(row.appliedAmount),
  }));

  // A payment that settles nothing is not a payment. (The zod schema says
  // the same thing; this is what makes it true for every caller of the
  // service, and what lets the repository's transaction assume it has at
  // least one invoice — and therefore a real customer — to work with.)
  if (rows.length === 0) throw new PaymentRowMismatchError("A payment must settle at least one open item");
  // One row per open item: two rows against the same invoice would each be
  // measured against the same open amount and could jointly overpay it.
  if (new Set(rows.map((row) => row.invoiceId)).size !== rows.length) {
    throw new PaymentRowMismatchError("The same invoice appears on more than one payment row");
  }
  // A row that settles nothing is either a mistake or an attempt to write
  // off the whole open amount through the tolerance rule.
  if (rows.some((row) => row.appliedAmount === 0)) {
    throw new PaymentRowMismatchError("A payment row must settle a non-zero amount");
  }
  // THE balance invariant: the bank amount is what the rows apply in cash.
  // The poster states the same identity as its own precondition (it is
  // exactly the condition under which the verification balances) — this is
  // the friendly half of that pair, checked before anything is allocated.
  const appliedTotal = round2(rows.reduce((sum, row) => sum + row.appliedAmount, 0));
  const amount = round2(input.amount);
  if (appliedTotal !== amount) {
    throw new PaymentRowMismatchError(`The payment rows apply ${appliedTotal} but the payment amount is ${amount}`);
  }
  return rows;
}

// What each repository guard reason becomes — the same domain error whether
// it came back as a create() result or was thrown inside the caller's tx.
function guardError(reason: PaymentGuardReason, detail: PaymentGuardDetail): Error {
  const reference = detail.invoiceNumber ?? detail.invoiceId;
  switch (reason) {
    case "invoice_not_found":
      return new InvoiceNotFoundError(detail.invoiceId);
    case "wrong_customer":
      return new PaymentRowMismatchError(`Invoice ${reference} belongs to a different customer`);
    case "not_issued":
      return new InvoiceNotOpenError(`Invoice ${reference} is not an issued invoice`);
    case "not_open":
      return new InvoiceNotOpenError(`Invoice ${reference} has no open amount left`);
    case "sign_mismatch":
      return new PaymentRowMismatchError(
        `The amount applied to invoice ${reference} points the opposite way to its open amount`
      );
    case "exceeds_open":
      return new PaymentExceedsOpenAmountError(detail.invoiceNumber, detail.open!, detail.applied!);
    case "mixed_currencies":
      return new PaymentMixedCurrenciesError(detail.currencies ?? []);
    case "amount_sek":
      return new CustomerPaymentAmountSekError(detail.sekReason ?? "required", detail.currency ?? "");
  }
}

function headerWrite(input: CreatePaymentInput) {
  return {
    customerId: input.customerId,
    paymentDate: input.paymentDate,
    bankAccountNumber: input.bankAccountNumber,
    amount: round2(input.amount),
    currency: input.currency ?? null,
    amountSek: input.amountSek === undefined ? null : round2(input.amountSek),
    bankFeeSek: input.bankFeeSek === undefined ? null : round2(input.bankFeeSek),
    note: input.note ?? null,
  };
}

export function createPaymentService(
  repo: PaymentRepository,
  poster: CustomerPaymentPoster,
  // G1: optional, defaults to a no-op — see sales.service.ts's identical comment.
  audit: AuditWriter = { log: async () => {} }
) {
  const service = {
    // Förfallolistan/öppna poster.
    async listOpenInvoices(query: ListOpenInvoicesQuery) {
      return repo.listOpenInvoices(query);
    },

    // OCR lookup for the registration form. A malformed reference is a 400
    // (InvalidOcrError); a well-formed one that no open item carries returns
    // null, which the route turns into a 404.
    async findOpenByOcr(ocr: string) {
      const trimmed = ocr.trim();
      if (!validateOcrNumber(trimmed)) throw new InvalidOcrError(ocr);
      return repo.findOpenByOcr(trimmed);
    },

    async list(query: ListPaymentsQuery) {
      return repo.list(query);
    },

    // Valuta: exchangeRateDifferenceSek is the payment's kursdifferens —
    // positive = kursvinst, negative = kursförlust (0 for SEK).
    async getPayment(id: string) {
      const header = await repo.findById(id);
      if (!header) return null;
      const rows = await repo.listRows(id);
      const difference = receiptExchangeDifference({
        amountSek: Number(header.amountSek),
        bankFeeSek: Number(header.bankFeeSek),
        appliedAmountsSek: rows.map((row) => Number(row.appliedAmountSek)),
      });
      return { ...header, exchangeRateDifferenceSek: difference === 0 ? 0 : -difference, rows };
    },

    // Registers one received payment against one customer's open items. The
    // input-only checks are normalizedRows(); every state-dependent one
    // (status, customer, open amount, tolerance) belongs to the repository's
    // transaction, after the invoices are row-locked, and comes back as a
    // discriminated result normalized by guardError().
    async create(input: CreatePaymentInput, createdBy: string) {
      const rows = normalizedRows(input);
      const result = await repo.createPayment(headerWrite(input), rows, createdBy, poster);
      if (!result.ok) throw guardError(result.reason, result);
      const payment = (await service.getPayment(result.paymentId))!;
      await audit.log({
        entityType: "customer_payment",
        entityId: payment.paymentNumber,
        action: "created",
        detail: {
          amount: payment.amount,
          bankAccountNumber: payment.bankAccountNumber,
          ...(payment.currency === SEK ? {} : { currency: payment.currency, amountSek: payment.amountSek, bankFeeSek: payment.bankFeeSek }),
        },
        userId: createdBy,
      });
      return payment;
    },

    // Bankfiler: the same registration inside the CALLER's transaction, so
    // the bank entry and the payment commit or roll back together. Throws the
    // domain errors create() throws; the caller decides per entry. A second
    // live payment on the same entry fails with a unique violation
    // (customer_payments_entry_live). No audit entry here — the caller writes
    // it in its own tx.
    async createInTx(tx: Tx, input: CreatePaymentInput, createdBy: string, link: { bankFileEntryId: string }) {
      const rows = normalizedRows(input);
      let paymentId: string;
      try {
        ({ paymentId } = await repo.createPaymentInTx(tx, headerWrite(input), rows, createdBy, poster, link));
      } catch (err) {
        if (err instanceof PaymentGuardError) throw guardError(err.reason, err.detail);
        throw err;
      }
      const [row] = await tx
        .select({ paymentNumber: customerPayments.paymentNumber })
        .from(customerPayments)
        .where(eq(customerPayments.id, paymentId));
      return { paymentId, paymentNumber: row!.paymentNumber };
    },

    // Makulering: books the omföring, stamps the cancellation and reopens the
    // invoices it had settled — all in one transaction in the repository.
    // opts.date dates the omföring (default: today).
    async cancel(id: string, userId: string, opts: { date?: string } = {}) {
      const payment = await repo.findById(id);
      if (!payment) throw new PaymentNotFoundError(id);
      if (payment.cancelledAt !== null) throw new PaymentAlreadyCancelledError(id);

      let result;
      try {
        result = await repo.cancelPayment(id, userId, poster, opts);
      } catch (err) {
        // The partial unique index verifications_reverses_unique fired: an
        // unbooked manual Omför of the same verification is in the way (or one
        // committed while this cancellation was writing its own omföring).
        if (isUniqueViolation(err)) throw new VerificationAlreadyReversedError();
        throw err;
      }
      // Both reasons mean a concurrent call got there between the guard above
      // and the repository's row-locked re-read.
      if (!result.ok) {
        if (result.reason === "not_found") throw new PaymentNotFoundError(id);
        throw new PaymentAlreadyCancelledError(id);
      }
      await audit.log({
        entityType: "customer_payment",
        entityId: payment.paymentNumber,
        action: "cancelled",
        userId,
      });
      return (await service.getPayment(id))!;
    },
  };

  return service;
}

export type PaymentService = ReturnType<typeof createPaymentService>;

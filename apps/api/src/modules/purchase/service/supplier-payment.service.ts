import { eq } from "drizzle-orm";
import { supplierPayments, type Tx } from "@navet/db";
import type {
  ListOpenSupplierInvoicesQuery,
  ListSupplierPaymentsQuery,
  SupplierPaymentInput,
} from "@navet/shared";
import { paymentExchangeDifference, round2 } from "@navet/shared";
import { isUniqueViolation } from "../../system/service/db-errors.js";
import {
  CancelGuardError,
  SupplierPaymentGuardError,
  type SupplierPaymentGuardDetail,
  type SupplierPaymentGuardReason,
  type SupplierPaymentLink,
  type SupplierPaymentSekReason,
  type SupplierPaymentRepository,
  type SupplierPaymentRowInput,
} from "../repository/supplier-payment.repository.js";
import { SupplierInvoiceNotFoundError } from "./supplier-invoice.service.js";
// G1: append-only audit trail — optional with a no-op default (see
// sales.service.ts's identical comment).
import type { AuditWriter } from "../../system/repository/audit.repository.js";

// Leverantörsreskontra (B4): the slice of the economy module's
// VerificationPoster this service uses — declared here, at the consumer, like
// every other cross-module reader in purchase (SupplierInvoicePoster,
// ArticleFileReader, RegisterReferenceReader). Both methods are Tx-composable
// by design: the posting happens inside the registration's (respectively the
// cancellation's) own transaction, so the verification, its verifikatnummer,
// the UTB number and the invoice's paid flip either all commit or all roll
// back.
export interface SupplierPaymentPoster {
  // Returns null when the payment moves nothing in the ledger (a pure
  // kvittning between open items on the same payable account) — that is not a
  // bokföringshändelse and gets no verification.
  postSupplierPayment(
    tx: Tx,
    doc: {
      paymentNumber: string;
      paymentDate: string;
      bankAccountNumber: string;
      // The BANK part only. The poster requires it to equal Σ appliedAmount —
      // that identity IS the balance condition of the verification.
      bankAmount: number;
      supplierName: string;
      // Valuta: the payment's currency, the SEK that left the bank and the
      // bank's fee in SEK.
      currency: string;
      bankAmountSek: number;
      bankFeeSek: number;
    },
    // appliedAmountSek/writeOffAmountSek: the SEK each part releases from the
    // invoice's booked debt (frigjort SEK).
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

export class SupplierPaymentNotFoundError extends Error {
  constructor(id: string) {
    super(`Supplier payment ${id} not found`);
    this.name = "SupplierPaymentNotFoundError";
  }
}

// The invoice is not an open item: not approved (a draft is not an obligation
// yet, a paid/cancelled one has none left) or nothing left to settle on it.
export class SupplierInvoiceNotOpenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SupplierInvoiceNotOpenError";
  }
}

// The payment's rows do not fit each other or the open items they name:
// amounts that do not add up to the bank amount, the same open item twice, a
// row that settles nothing, an invoice belonging to another supplier, or an
// amount pointing the opposite way to what is open.
export class SupplierPaymentRowMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SupplierPaymentRowMismatchError";
  }
}

// Settling more than is open, beyond what the tolerance setting allows to be
// written off. Overpaying a supplier is a bookkeeping decision (a claim on the
// supplier, a credit note to come), never something the reskontra guesses at.
export class SupplierPaymentExceedsOpenAmountError extends Error {
  constructor(
    public registrationNumber: string | null,
    public open: number,
    public applied: number
  ) {
    super(
      `Payment of ${applied} exceeds the open amount ${open} on supplier invoice ${registrationNumber ?? "?"} by more than the tolerance`
    );
    this.name = "SupplierPaymentExceedsOpenAmountError";
  }
}

export class SupplierPaymentAlreadyCancelledError extends Error {
  constructor(id: string) {
    super(`Supplier payment ${id} is already cancelled`);
    this.name = "SupplierPaymentAlreadyCancelledError";
  }
}

// An unbooked manual omföring already exists on the payment's verification, so
// the cancellation's own omföring collided with the partial unique index. Same
// condition as the supplier invoice's and the customer payment's cancellation
// — each consumer keeps its OWN error class (B3's precedent) so the message
// can name what the user was actually cancelling.
export class VerificationAlreadyReversedError extends Error {
  constructor() {
    super("The payment's verification already has an omföring — book or delete it first");
    this.name = "VerificationAlreadyReversedError";
  }
}

// Valuta: one payment never mixes currencies. 400 payment-mixed-currencies.
export class PaymentMixedCurrenciesError extends Error {
  constructor(public currencies: string[]) {
    super(`A payment cannot settle invoices in more than one currency (${currencies.join(", ")})`);
    this.name = "PaymentMixedCurrenciesError";
  }
}

// Valuta: the SEK amount/fee does not fit the payment. 400
// supplier-payment-amount-sek with `reason`:
//   required  — a payment in another currency needs Belopp i SEK,
//   sign      — the SEK amount is zero or points the other way,
//   fee       — the fee exceeds the SEK amount,
//   kvittning — a kvittning (amount 0) moves no SEK and has no fee,
//   sek       — a SEK payment's SEK amount is the amount itself, without fee.
export class SupplierPaymentAmountSekError extends Error {
  constructor(
    public reason: SupplierPaymentSekReason,
    public currency: string
  ) {
    const text: Record<SupplierPaymentSekReason, string> = {
      required: `A payment in ${currency} needs the amount in SEK that left the bank account`,
      sign: "The SEK amount must be non-zero and point the same way as the payment amount",
      fee: "The bank fee cannot exceed the SEK amount",
      kvittning: "A kvittning moves no money — it has no SEK amount and no bank fee",
      sek: "A SEK payment's SEK amount is the amount itself, and it has no separate bank fee",
    };
    super(text[reason]);
    this.name = "SupplierPaymentAmountSekError";
  }
}

// Bankfiler: the invoice is reserved in a live payment batch — only that
// batch's confirmation may pay it.
export class SupplierInvoiceReservedError extends Error {
  constructor(public registrationNumber: string | null) {
    super(`Supplier invoice ${registrationNumber ?? "?"} is reserved in a payment batch`);
    this.name = "SupplierInvoiceReservedError";
  }
}

// The checks that can be settled from the input alone — shared by create()
// and createInTx(). Every state-dependent one (status, supplier, open amount,
// tolerance, batch reservation) belongs to the repository's transaction,
// after the invoices are row-locked.
function normalizedRows(input: SupplierPaymentInput): SupplierPaymentRowInput[] {
  const rows: SupplierPaymentRowInput[] = input.rows.map((row) => ({
    supplierInvoiceId: row.supplierInvoiceId,
    appliedAmount: round2(row.appliedAmount),
  }));

  // A payment that settles nothing is not a payment. (The zod schema says
  // the same thing; this is what makes it true for every caller of the
  // service, and what lets the repository's transaction assume it has at
  // least one invoice — and therefore a real supplier — to work with. The
  // poster would NOT catch this one: an empty row set with bankAmount 0
  // looks exactly like a pure kvittning to it and returns null.)
  if (rows.length === 0) {
    throw new SupplierPaymentRowMismatchError("A payment must settle at least one open item");
  }
  // One row per open item: two rows against the same invoice would each be
  // measured against the same open amount and could jointly overpay it.
  if (new Set(rows.map((row) => row.supplierInvoiceId)).size !== rows.length) {
    throw new SupplierPaymentRowMismatchError("The same supplier invoice appears on more than one payment row");
  }
  // A row that settles nothing is either a mistake or an attempt to write
  // off the whole open amount through the tolerance rule.
  if (rows.some((row) => row.appliedAmount === 0)) {
    throw new SupplierPaymentRowMismatchError("A payment row must settle a non-zero amount");
  }
  // THE balance invariant: the bank amount is what the rows apply in cash.
  // The poster states the same identity as its own precondition (it is
  // exactly the condition under which the verification balances) — this is
  // the friendly half of that pair, checked before anything is allocated.
  const appliedTotal = round2(rows.reduce((sum, row) => sum + row.appliedAmount, 0));
  const amount = round2(input.amount);
  if (appliedTotal !== amount) {
    throw new SupplierPaymentRowMismatchError(
      `The payment rows apply ${appliedTotal} but the payment amount is ${amount}`
    );
  }
  return rows;
}

// What each repository guard reason becomes — the same domain error whether
// it came back as a create() result or was thrown inside the caller's tx.
function guardError(reason: SupplierPaymentGuardReason, detail: SupplierPaymentGuardDetail): Error {
  const reference = detail.registrationNumber ?? detail.invoiceId;
  switch (reason) {
    case "invoice_not_found":
      return new SupplierInvoiceNotFoundError(detail.invoiceId);
    case "wrong_supplier":
      return new SupplierPaymentRowMismatchError(`Supplier invoice ${reference} belongs to a different supplier`);
    case "not_approved":
      return new SupplierInvoiceNotOpenError(`Supplier invoice ${reference} is not an approved invoice`);
    case "not_open":
      return new SupplierInvoiceNotOpenError(`Supplier invoice ${reference} has no open amount left`);
    case "sign_mismatch":
      return new SupplierPaymentRowMismatchError(
        `The amount applied to supplier invoice ${reference} points the opposite way to its open amount`
      );
    case "exceeds_open":
      return new SupplierPaymentExceedsOpenAmountError(detail.registrationNumber, detail.open!, detail.applied!);
    case "reserved":
      return new SupplierInvoiceReservedError(detail.registrationNumber);
    case "batch_link_mismatch":
      return new SupplierPaymentRowMismatchError(
        `The payment batch row is not an exported row of supplier invoice ${reference} — it cannot confirm this payment`
      );
    case "mixed_currencies":
      return new PaymentMixedCurrenciesError(detail.currencies ?? []);
    case "amount_sek":
      return new SupplierPaymentAmountSekError(detail.sekReason ?? "required", detail.currency ?? "");
  }
}

function headerWrite(input: SupplierPaymentInput) {
  return {
    supplierId: input.supplierId,
    paymentDate: input.paymentDate,
    bankAccountNumber: input.bankAccountNumber,
    amount: round2(input.amount),
    amountSek: input.amountSek === undefined ? null : round2(input.amountSek),
    bankFeeSek: input.bankFeeSek === undefined ? null : round2(input.bankFeeSek),
    note: input.note ?? null,
  };
}

export function createSupplierPaymentService(
  repo: SupplierPaymentRepository,
  poster: SupplierPaymentPoster,
  // G1: optional, defaults to a no-op — see sales.service.ts's identical comment.
  audit: AuditWriter = { log: async () => {} }
) {
  const service = {
    // Förfallolistan/öppna poster (the payables ledger's own list).
    async listOpenInvoices(query: ListOpenSupplierInvoicesQuery) {
      return repo.listOpenInvoices(query);
    },

    async list(query: ListSupplierPaymentsQuery) {
      return repo.list(query);
    },

    // Valuta: exchangeRateDifferenceSek is the payment's kursdifferens —
    // positive = kursvinst, negative = kursförlust (0 for SEK).
    async getPayment(id: string) {
      const header = await repo.findById(id);
      if (!header) return null;
      const rows = await repo.listRows(id);
      const difference = paymentExchangeDifference({
        amountSek: Number(header.amountSek),
        bankFeeSek: Number(header.bankFeeSek),
        appliedAmountsSek: rows.map((row) => Number(row.appliedAmountSek)),
      });
      return { ...header, exchangeRateDifferenceSek: difference === 0 ? 0 : -difference, rows };
    },

    // Registers one outgoing payment against one supplier's open items. The
    // input-only checks are normalizedRows(); every state-dependent one
    // (status, supplier, open amount, tolerance, batch reservation) belongs
    // to the repository's transaction, after the invoices are row-locked, and
    // comes back as a discriminated result normalized by guardError().
    async create(input: SupplierPaymentInput, createdBy: string) {
      const rows = normalizedRows(input);
      const result = await repo.createPayment(headerWrite(input), rows, createdBy, poster);
      if (!result.ok) throw guardError(result.reason, result);
      const payment = (await service.getPayment(result.paymentId))!;
      await audit.log({
        entityType: "supplier_payment",
        entityId: payment.paymentNumber,
        action: "created",
        detail: {
          amount: payment.amount,
          bankAccountNumber: payment.bankAccountNumber,
          ...(payment.currency === "SEK" ? {} : { currency: payment.currency, amountSek: payment.amountSek, bankFeeSek: payment.bankFeeSek }),
        },
        userId: createdBy,
      });
      return payment;
    },

    // Bankfiler: the same registration inside the CALLER's transaction, so
    // the batch row / bank entry and the payment commit or roll back together.
    // Throws the domain errors create() throws; the caller decides per row.
    // No audit entry here — the caller writes it in its own tx.
    async createInTx(tx: Tx, input: SupplierPaymentInput, createdBy: string, link: SupplierPaymentLink) {
      const rows = normalizedRows(input);
      let paymentId: string;
      try {
        ({ paymentId } = await repo.createPaymentInTx(tx, headerWrite(input), rows, createdBy, poster, link));
      } catch (err) {
        if (err instanceof SupplierPaymentGuardError) throw guardError(err.reason, err.detail);
        throw err;
      }
      const [row] = await tx
        .select({ paymentNumber: supplierPayments.paymentNumber })
        .from(supplierPayments)
        .where(eq(supplierPayments.id, paymentId));
      return { paymentId, paymentNumber: row!.paymentNumber };
    },

    // Bankfiler: makulering inside the CALLER's transaction (the bank's
    // return), the omföring dated as the caller says. A batch payment leaves
    // its row "returned"; the row id comes back for the caller's own writes.
    async cancelInTx(tx: Tx, id: string, userId: string, opts: { date: string }) {
      try {
        return await repo.cancelPaymentInTx(tx, id, userId, poster, opts);
      } catch (err) {
        if (err instanceof CancelGuardError) {
          if (err.reason === "not_found") throw new SupplierPaymentNotFoundError(id);
          throw new SupplierPaymentAlreadyCancelledError(id);
        }
        // Same partial unique index as cancel() below.
        if (isUniqueViolation(err)) throw new VerificationAlreadyReversedError();
        throw err;
      }
    },

    // Makulering: books the omföring, stamps the cancellation and reopens the
    // invoices it had settled — all in one transaction in the repository.
    // opts.date dates the omföring (default: today), as in sales' cancel().
    async cancel(id: string, userId: string, opts: { date?: string } = {}) {
      const payment = await repo.findById(id);
      if (!payment) throw new SupplierPaymentNotFoundError(id);
      if (payment.cancelledAt !== null) throw new SupplierPaymentAlreadyCancelledError(id);

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
        if (result.reason === "not_found") throw new SupplierPaymentNotFoundError(id);
        throw new SupplierPaymentAlreadyCancelledError(id);
      }
      await audit.log({
        entityType: "supplier_payment",
        entityId: payment.paymentNumber,
        action: "cancelled",
        userId,
      });
      // A batch payment cancelled by hand leaves its row "returned" (the
      // repository's write) — the batch's own history says so too, as the
      // bank's return does (returnItemInTx's item_returned).
      if (payment.paymentBatchItem) {
        await audit.log({
          entityType: "payment_batch",
          entityId: payment.paymentBatchItem.batchNumber,
          action: "item_returned",
          detail: { endToEndId: payment.paymentBatchItem.endToEndId, via: "manual", payment: payment.paymentNumber },
          userId,
        });
      }
      return (await service.getPayment(id))!;
    },
  };

  return service;
}

export type SupplierPaymentService = ReturnType<typeof createSupplierPaymentService>;

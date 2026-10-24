import type { NotPayableReason } from "@navet/shared";
import type { Pain001Violation } from "./iso20022/pain001-check.js";

// The payment file would not be what the bank needs (structural check,
// spec §3.4). 409: the batch's data must be fixed first; `violations` lists
// every problem with its EndToEndId and field.
export class PaymentFileInvalidError extends Error {
  constructor(public violations: Pain001Violation[]) {
    super(violations.map((v) => `${v.endToEndId ?? "Filen"}: ${v.message}`).join("; "));
    this.name = "PaymentFileInvalidError";
  }
}

// The uploaded file is not well-formed XML we accept (DTD/entities refused,
// mismatched tags, nothing parseable). 400; nothing is stored.
export class BankFileParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BankFileParseError";
  }
}

// Well-formed, but not a camt.054.001.02 (e.g. camt.053, or another version).
export class UnsupportedBankMessageError extends Error {
  constructor(public namespace: string | null) {
    // The namespace comes from the upload and is echoed in the 400: clipped.
    const shown = namespace && namespace.length > 60 ? `${namespace.slice(0, 60)}…` : namespace;
    super(`Only camt.054.001.02 is supported (the file is ${shown ?? "without namespace"})`);
    this.name = "UnsupportedBankMessageError";
  }
}

// The bank settings (or the company's own details) are not complete enough
// to build or confirm a payment file. 409 with the Swedish checklist.
export class BankSettingsIncompleteError extends Error {
  constructor(public missing: string[]) {
    super(missing.join("; "));
    this.name = "BankSettingsIncompleteError";
  }
}

// A bank setting that cannot be saved (format, or a debit account the
// chosen bank does not take). 400, Swedish message.
export class InvalidBankSettingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidBankSettingError";
  }
}

export class PaymentBatchNotFoundError extends Error {
  constructor(id: string) {
    super(`Payment batch ${id} not found`);
    this.name = "PaymentBatchNotFoundError";
  }
}

export class PaymentBatchItemNotFoundError extends Error {
  constructor(id: string) {
    super(`Payment batch item ${id} not found`);
    this.name = "PaymentBatchItemNotFoundError";
  }
}

export interface NotPayableDetail {
  invoiceId: string;
  registrationNumber: string | null;
  reason: NotPayableReason;
  batchNumber?: string;
}

const NOT_PAYABLE_TEXT: Record<NotPayableReason, string> = {
  not_found: "finns inte",
  not_approved: "är inte attesterad",
  not_open: "har inget öppet belopp",
  credit_note: "är en kreditfaktura — kvittas under Betalningar",
  no_payment_details: "leverantören saknar betalningsuppgifter",
  already_in_batch: "ingår redan i en betalfil",
};

// One error for every invoice that cannot go into a batch — 409 with
// `details`; the message is Swedish and names each invoice.
export class SupplierInvoicesNotPayableError extends Error {
  constructor(public details: NotPayableDetail[]) {
    super(
      details
        .map(
          (d) =>
            `${d.registrationNumber ?? d.invoiceId} ${
              d.reason === "already_in_batch" && d.batchNumber ? `ingår redan i betalfil ${d.batchNumber}` : NOT_PAYABLE_TEXT[d.reason]
            }`
        )
        .join("; ")
    );
    this.name = "SupplierInvoicesNotPayableError";
  }
}

// A draft row edit that cannot be: amount above the open amount, or a date
// outside [today, today + 365]. 400, Swedish message.
export class InvalidPaymentBatchItemError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPaymentBatchItemError";
  }
}

// The row is not waiting for the bank (already confirmed, rejected, …).
export class PaymentBatchItemNotConfirmableError extends Error {
  constructor(
    public endToEndId: string,
    public status: string
  ) {
    // "absent": a chosen id that is no row of this batch at all.
    super(status === "absent" ? `Payment row ${endToEndId} is not part of this batch` : `Payment ${endToEndId} is ${status}, not exported`);
    this.name = "PaymentBatchItemNotConfirmableError";
  }
}

// Bekräfta utförd dated in the future. 400, Swedish message.
export class InvalidPaymentDateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPaymentDateError";
  }
}

export class BankFileNotFoundError extends Error {
  constructor(id: string) {
    super(`Bank file ${id} not found`);
    this.name = "BankFileNotFoundError";
  }
}

export class BankEntryNotFoundError extends Error {
  constructor(id: string) {
    super(`Bank entry ${id} not found in this file`);
    this.name = "BankEntryNotFoundError";
  }
}

// The entry already has a live payment (or was handled as a return, or is
// marked handled outside Nav). 409.
export class BankEntryAlreadyBookedError extends Error {
  constructor() {
    super("The bank entry is already booked or handled");
    this.name = "BankEntryAlreadyBookedError";
  }
}

// The rows sent for an incoming entry do not add up to the entry. 400.
export class BankEntryAmountMismatchError extends Error {
  constructor(
    public entryAmount: number,
    public applied: number
  ) {
    super(`The rows apply ${applied.toFixed(2)} but the bank entry is ${entryAmount.toFixed(2)}`);
    this.name = "BankEntryAmountMismatchError";
  }
}

// The entry belongs to the other direction (or is not SEK). 409.
export class BankEntryDirectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BankEntryDirectionError";
  }
}

// A debit/return whose EndToEndId is not one of ours. 409.
export class BankEntryNotMatchedError extends Error {
  constructor() {
    super("The bank entry does not belong to any payment batch");
    this.name = "BankEntryNotMatchedError";
  }
}

// A debit or a return for one of our payments with another amount than we
// sent. 409 — check the internet bank and confirm or cancel by hand.
// A payment in another currency is matched on the instructed amount
// (InstdAmt) in the invoice's currency — `currency` says which (SEK for a
// domestic payment); `actual` is null when the bank reported no instructed
// amount in that currency.
export class BankEntryAmountDiffersError extends Error {
  constructor(
    public endToEndId: string,
    public expected: number,
    public actual: number | null,
    verb: "debited" | "returned" = "debited",
    public currency: string = "SEK"
  ) {
    super(
      actual === null
        ? `Payment ${endToEndId} was ${expected.toFixed(2)} ${currency} but the bank reported no instructed amount in ${currency}`
        : currency === "SEK"
          ? `Payment ${endToEndId} was ${expected.toFixed(2)} but the bank ${verb} ${actual.toFixed(2)}`
          : `Payment ${endToEndId} was ${expected.toFixed(2)} ${currency} but the bank ${verb} ${actual.toFixed(2)} ${currency}`
    );
    this.name = "BankEntryAmountDiffersError";
  }
}

// Valuta steg 2: the bank returned a payment in another currency with
// another SEK amount than the payment took from the account (the rate moved
// in between). Cancelling the UTB would reverse the original SEK amount and
// leave the difference unbooked — 409: cancel the payment and book the
// difference by hand instead.
export class BankReturnSekDiffersError extends Error {
  constructor(
    public endToEndId: string,
    public paidSek: number,
    public returnedSek: number
  ) {
    super(`The return of ${endToEndId} is ${returnedSek.toFixed(2)} SEK but the payment took ${paidSek.toFixed(2)} SEK — cancel the payment and book the exchange difference by hand`);
    this.name = "BankReturnSekDiffersError";
  }
}

// A return booked by the bank before the day our UTB says the payment left
// — the dates cannot both be right (a wrong Bekräfta utförd date, or the
// wrong return). 409: correct the UTB by hand instead of booking an omföring
// dated before the payment it reverses.
export class BankReturnBeforePaymentError extends Error {
  constructor(
    public endToEndId: string,
    public paymentDate: string,
    public returnDate: string
  ) {
    super(`The return of ${endToEndId} is booked ${returnDate}, before the payment date ${paymentDate}`);
    this.name = "BankReturnBeforePaymentError";
  }
}

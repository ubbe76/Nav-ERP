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
    super(`Payment ${endToEndId} is ${status}, not exported`);
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

// --- Bankavstämning (etapp 4) ---

export class BankAccountNotFoundError extends Error {
  constructor(id: string) {
    super(`Bank account ${id} not found`);
    this.name = "BankAccountNotFoundError";
  }
}

// Another bank account already carries this IBAN/BBAN. 409.
export class BankAccountIdentifierTakenError extends Error {
  constructor(public identifier: string) {
    super(`Bank account identifier ${identifier} is already in use`);
    this.name = "BankAccountIdentifierTakenError";
  }
}

// The ledger account number is not in the chart of accounts (or inactive). 400.
export class BankAccountLedgerMissingError extends Error {
  constructor(public accountNumber: string) {
    super(`Ledger account ${accountNumber} does not exist or is inactive`);
    this.name = "BankAccountLedgerMissingError";
  }
}

// A CSV import, or a statement for an account the register does not know,
// needs bankAccountId. 400.
export class BankAccountRequiredError extends Error {
  constructor(message = "bankAccountId is required for this file") {
    super(message);
    this.name = "BankAccountRequiredError";
  }
}

// Well-formed XML, but not a camt.053.001.02 (a camt.054 belongs under
// Bankfiler). 400.
export class BankStatementFormatError extends Error {
  constructor(public namespace: string | null) {
    const shown = namespace && namespace.length > 60 ? `${namespace.slice(0, 60)}…` : namespace;
    super(`Only camt.053.001.02 statements are supported (the file is ${shown ?? "without namespace"})`);
    this.name = "BankStatementFormatError";
  }
}

// The CSV cannot be read with the given mapping (missing column, a cell
// that is no date/amount). 400, Swedish message.
export class BankStatementCsvMappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BankStatementCsvMappingError";
  }
}

// The file reports accounts the register does not know and bankAccountId
// cannot settle it (none given, or more than one unknown). 400.
export class BankStatementAccountUnknownError extends Error {
  constructor(public identifiers: string[]) {
    super(`The statement is for an unknown bank account: ${identifiers.join(", ")}`);
    this.name = "BankStatementAccountUnknownError";
  }
}

// bankAccountId names another account than the file's Acct/Id resolves to. 400.
export class BankStatementAccountMismatchError extends Error {
  constructor(public identifier: string) {
    super(`The statement's account ${identifier} belongs to another bank account than the one chosen`);
    this.name = "BankStatementAccountMismatchError";
  }
}

// The statement is in another currency than the bank account. 400.
export class BankStatementCurrencyError extends Error {
  constructor(
    public statementCurrency: string,
    public accountCurrency: string
  ) {
    super(`The statement is in ${statementCurrency} but the bank account is in ${accountCurrency}`);
    this.name = "BankStatementCurrencyError";
  }
}

export class BankStatementEntryNotFoundError extends Error {
  constructor(id: string) {
    super(`Bank statement entry ${id} not found`);
    this.name = "BankStatementEntryNotFoundError";
  }
}

export class BankMatchNotFoundError extends Error {
  constructor(id: string) {
    super(`Bank match ${id} not found`);
    this.name = "BankMatchNotFoundError";
  }
}

// Σ entries ≠ Σ rows (debit − credit on the bank's ledger account). 409.
export class BankMatchSumMismatchError extends Error {
  constructor(
    public entriesSum: number,
    public rowsSum: number
  ) {
    super(`The entries sum to ${entriesSum.toFixed(2)} but the rows to ${rowsSum.toFixed(2)}`);
    this.name = "BankMatchSumMismatchError";
  }
}

// An entry or row is already part of a live matching. 409.
export class BankMatchAlreadyMatchedError extends Error {
  constructor() {
    super("An entry or row is already matched");
    this.name = "BankMatchAlreadyMatchedError";
  }
}

// An entry of another bank account, a row on another ledger account, or an
// unbooked verification. 400.
export class BankMatchWrongAccountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BankMatchWrongAccountError";
  }
}

export class BankMatchAlreadyUndoneError extends Error {
  constructor(id: string) {
    super(`Bank match ${id} is already undone`);
    this.name = "BankMatchAlreadyUndoneError";
  }
}

// Bokför: the rows do not carry the bank's ledger account with exactly the
// entry's amount on the right side. 400.
export class BankEntryBookMismatchError extends Error {
  constructor(
    public expected: number,
    public actual: number
  ) {
    super(`The rows put ${actual.toFixed(2)} on the bank account but the entry is ${expected.toFixed(2)}`);
    this.name = "BankEntryBookMismatchError";
  }
}

export class BankRuleNotFoundError extends Error {
  constructor(id: string) {
    super(`Bank rule ${id} not found`);
    this.name = "BankRuleNotFoundError";
  }
}

// Bokför enligt regel: no active rule matches the entry. 409.
export class BankRuleMissingError extends Error {
  constructor() {
    super("No bank rule matches the entry");
    this.name = "BankRuleMissingError";
  }
}

// More than one rule matches — the user picks. 409.
export class BankRuleAmbiguousError extends Error {
  constructor(public ruleIds: string[]) {
    super(`${ruleIds.length} bank rules match the entry`);
    this.name = "BankRuleAmbiguousError";
  }
}

// The rule's account (or its momskod's VAT account) is not in the chart of
// accounts or inactive. 400.
export class BankRuleAccountMissingError extends Error {
  constructor(public accountNumber: string) {
    super(`Account ${accountNumber} does not exist or is inactive`);
    this.name = "BankRuleAccountMissingError";
  }
}

// Avstämd t.o.m. refused: something before the date is unmatched or the
// balances disagree. 409 with `reason`.
export class BankReconciliationIncompleteError extends Error {
  constructor(
    public reason: "unmatched-entries" | "unmatched-rows" | "no-statement-balance" | "balance-mismatch",
    public detail: { count?: number; statementBalance?: number | null; ledgerBalance?: number; inTransit?: number } = {}
  ) {
    super(
      reason === "unmatched-entries"
        ? `${detail.count ?? 0} statement entries up to the date are unmatched`
        : reason === "unmatched-rows"
          ? `${detail.count ?? 0} ledger rows up to the date are unmatched`
          : reason === "no-statement-balance"
            ? "No statement balance is known for the date"
            : `The statement balance ${(detail.statementBalance ?? 0).toFixed(2)} differs from the ledger balance ${(detail.ledgerBalance ?? 0).toFixed(2)}`
    );
    this.name = "BankReconciliationIncompleteError";
  }
}

// Startpunkt: the statement balance typed in differs from the ledger
// balance per the day — book the difference first. 409 with both amounts.
export class BankOpeningBalanceMismatchError extends Error {
  constructor(
    public statementBalance: number,
    public ledgerBalance: number
  ) {
    super(`The statement balance ${statementBalance.toFixed(2)} differs from the ledger balance ${ledgerBalance.toFixed(2)} per the opening day`);
    this.name = "BankOpeningBalanceMismatchError";
  }
}

// Startpunkt refused: the account already has a live reconciliation mark
// (create), or a later mark rests on the opening (undo). 409 with `reason`.
export class BankOpeningNotAllowedError extends Error {
  constructor(public reason: "mark-exists" | "later-mark") {
    super(reason === "mark-exists" ? "The bank account already has a reconciliation mark — the opening must come first" : "A later reconciliation mark rests on the opening");
    this.name = "BankOpeningNotAllowedError";
  }
}

// PATCH /bank-accounts/:id: the ledger account and the currency are locked
// once the account carries statement entries or matchings. 409 with `field`.
export class BankAccountInUseError extends Error {
  constructor(public field: "ledgerAccount" | "currency") {
    super(`${field} cannot change on a bank account with statement entries or matchings`);
    this.name = "BankAccountInUseError";
  }
}

// Import: the chosen bank account already has entries under another
// identifier, so the file's identifier cannot be learned onto it. 409.
export class BankAccountIdentifierLockedError extends Error {
  constructor(
    public accountName: string,
    public identifier: string,
    public fileIdentifier: string
  ) {
    super(`Bank account ${accountName} already carries identifier ${identifier} and has entries — ${fileIdentifier} cannot replace it`);
    this.name = "BankAccountIdentifierLockedError";
  }
}

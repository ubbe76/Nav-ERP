import { errorBody } from "../../system/service/error-body.js";
import { AccountingPeriodLockedError } from "../../economy/service/accounting-period-lock.js";
import {
  CostCenterInactiveError,
  CostCenterNotFoundError,
  CostCenterRequiredError,
  ProjectClosedError,
  ProjectNotFoundError,
} from "../../economy/service/dimension-check.js";
import {
  AccountNotFoundError,
  InactiveAccountError,
  NoAccountingPeriodError,
  NoFiscalYearForDateError,
  TooFewVerificationRowsError,
  UnbalancedVerificationError,
  VerificationSeriesNotFoundError,
} from "../../economy/service/economy.service.js";
import { InvalidStatusTransitionError } from "../../purchase/service/purchase.service.js";
import { SupplierInvoiceInPaymentBatchError, SupplierInvoiceNotFoundError } from "../../purchase/service/supplier-invoice.service.js";
import {
  PaymentMixedCurrenciesError as SupplierPaymentMixedCurrenciesError,
  SupplierInvoiceNotOpenError,
  SupplierInvoiceReservedError,
  SupplierPaymentAlreadyCancelledError,
  SupplierPaymentAmountSekError,
  SupplierPaymentExceedsOpenAmountError,
  SupplierPaymentNotFoundError,
  SupplierPaymentRowMismatchError,
  VerificationAlreadyReversedError as SupplierVerificationAlreadyReversedError,
} from "../../purchase/service/supplier-payment.service.js";
import { InvoiceNotFoundError } from "../../sales/service/invoice.service.js";
import {
  CustomerPaymentAmountSekError,
  InvoiceNotOpenError,
  PaymentAlreadyCancelledError,
  PaymentExceedsOpenAmountError,
  PaymentMixedCurrenciesError,
  PaymentNotFoundError,
  PaymentRowMismatchError,
  VerificationAlreadyReversedError,
} from "../../sales/service/payment.service.js";
import { MissingPostingAccountError, ZeroAmountPostingError } from "../../economy/service/verification-poster.js";
import { ExchangeRateUnavailableError } from "../../system/service/exchange-rates.js";
import * as bankingErrors from "./banking.errors.js";

// The errors whose message may be shown to the user as is when a failure is
// reported inside a 2xx answer (the import's warnings, Bokför enligt regel's
// and the bank files' per-entry failures, Bekräfta utförd's per-row results):
// every banking domain error, economy's known refusals and the two ledgers'
// registration guards. Anything else is logged and replaced by a generic
// Swedish text — a driver or programming error never leaks.
type ErrorClass = abstract new (...args: never[]) => Error;
const KNOWN_ERROR_CLASSES: ErrorClass[] = [
  ...(Object.values(bankingErrors) as unknown[]).filter((v): v is ErrorClass => typeof v === "function"),
  AccountingPeriodLockedError,
  AccountNotFoundError,
  InactiveAccountError,
  NoAccountingPeriodError,
  NoFiscalYearForDateError,
  TooFewVerificationRowsError,
  UnbalancedVerificationError,
  VerificationSeriesNotFoundError,
  // Kostnadsställen och projekt: Kräver kostnadsställe and the object rule
  // on a rule's objects — Swedish messages meant for the user.
  CostCenterRequiredError,
  CostCenterInactiveError,
  CostCenterNotFoundError,
  ProjectClosedError,
  ProjectNotFoundError,
  // The posting itself: a standard account missing or inactive (bank, fee,
  // kursdifferens), a zero-amount verification, a rate the payment needs.
  MissingPostingAccountError,
  ZeroAmountPostingError,
  ExchangeRateUnavailableError,
  // The K and U registrations the bank files book through (createInTx /
  // cancelInTx) and the batch's own status guards.
  InvalidStatusTransitionError,
  SupplierInvoiceInPaymentBatchError,
  SupplierInvoiceNotFoundError,
  SupplierInvoiceNotOpenError,
  SupplierInvoiceReservedError,
  SupplierPaymentAlreadyCancelledError,
  SupplierPaymentAmountSekError,
  SupplierPaymentExceedsOpenAmountError,
  SupplierPaymentMixedCurrenciesError,
  SupplierPaymentNotFoundError,
  SupplierPaymentRowMismatchError,
  SupplierVerificationAlreadyReversedError,
  InvoiceNotFoundError,
  InvoiceNotOpenError,
  CustomerPaymentAmountSekError,
  PaymentAlreadyCancelledError,
  PaymentExceedsOpenAmountError,
  PaymentMixedCurrenciesError,
  PaymentNotFoundError,
  PaymentRowMismatchError,
  VerificationAlreadyReversedError,
];
export const UNEXPECTED_ERROR_TEXT = "Ett oväntat fel inträffade — se serverns logg.";
export function isKnownBankError(err: unknown): err is Error {
  return err instanceof Error && KNOWN_ERROR_CLASSES.some((cls) => err instanceof cls);
}

export type ErrorLog = (msg: string, extra?: Record<string, unknown>) => void;
export const consoleErrorLog: ErrorLog = (msg, extra) => console.error(msg, extra);

// The error envelope for a failure reported inside a 2xx answer: a known
// domain error as it is, anything else logged under `context` and replaced
// by the generic text.
export function reportableError(err: unknown, log: ErrorLog, context: string): { error: string; code?: string } {
  if (isKnownBankError(err)) return errorBody(err);
  log(`${context} failed unexpectedly`, { err });
  return { error: UNEXPECTED_ERROR_TEXT };
}

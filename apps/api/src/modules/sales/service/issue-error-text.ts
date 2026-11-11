import { AccountingPeriodLockedError, FiscalYearClosedError } from "../../economy/service/accounting-period-lock.js";
import { InvalidVatCodeError } from "../../economy/service/document-vat-code.js";
import {
  MissingPostingAccountError,
  NoAccountingPeriodForPostingError,
  VatCodeAmountMismatchError,
  VatCodeNotApplicableError,
  ZeroAmountPostingError,
} from "../../economy/service/verification-poster.js";
import { isBookkeepingLockViolation } from "../../system/service/db-errors.js";

// Pure leaf shared by Räntefakturering and Samlingsfakturering: why Utfärda
// direkt failed, in the user's language.
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


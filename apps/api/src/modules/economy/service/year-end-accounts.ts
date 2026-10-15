// Årsbokslut: BAS-fixed accounts for an aktiebolag (Nav only supports AB).
// Constants by decision (spec 1.7) — a missing/inactive one is a
// MissingPostingAccountError pointing at Förifyll BAS-urval.
export const YEAR_RESULT_ACCOUNT = "8999";
export const YEAR_RESULT_EQUITY_ACCOUNT = "2099";
export const RETAINED_EARNINGS_ACCOUNT = "2091";
export const DIVIDEND_PAYABLE_ACCOUNT = "2898";

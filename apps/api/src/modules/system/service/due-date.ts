import { addDays } from "./delivery-days.js";

// A payment term code that IS a number of days: one to four digits ("30"),
// optionally with the import's collision suffix ("30_2" — assignRegisterCodes
// in import/service/customers.ts gives a second "30 dagar netto" that code).
// Nothing else counts: "2/10", "-30", "30 dagar" or "1_MANAD_NETTO" are no
// day count, and more than four digits would put the date past what addDays
// can render (a RangeError, a 500 at Utfärda and in GET /alerts).
const TERM_DAYS = /^(\d{1,4})(?:_\d+)?$/;

// Förfallodag: the invoice date + the payment term's days when its code is a
// number of days (TERM_DAYS: "30" and "30_2" → 30 dagar netto), else null (a
// code like "KONTANT" just prints the term itself). Calendar-day arithmetic
// on the date string, never on instants, so a daylight-saving change in
// between cannot move it a day. The one rule for the kundfaktura (Utfärda),
// the leverantörsfaktura and Aviseringarna's derived due date.
export function dueDateFromTerm(invoiceDate: string, paymentTermCode: string | null): string | null {
  const match = TERM_DAYS.exec(paymentTermCode ?? "");
  if (!match) return null;
  return addDays(invoiceDate, Number(match[1]));
}

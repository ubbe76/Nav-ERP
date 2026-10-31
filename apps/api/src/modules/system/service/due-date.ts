import { addDays } from "./delivery-days.js";

// Förfallodag: the invoice date + the payment term's days when its code is a
// whole number of days ("30" → 30 dagar netto), else null (a code like
// "KONTANT" just prints the term itself). Calendar-day arithmetic on the date
// string, never on instants, so a daylight-saving change in between cannot
// move it a day. The one rule for the kundfaktura (Utfärda), the
// leverantörsfaktura and Aviseringarna's derived due date.
export function dueDateFromTerm(invoiceDate: string, paymentTermCode: string | null): string | null {
  const termDays = Number.parseInt(paymentTermCode ?? "", 10);
  if (!Number.isFinite(termDays)) return null;
  return addDays(invoiceDate, termDays);
}

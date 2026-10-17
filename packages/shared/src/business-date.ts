import { z } from "zod";

// A calendar date (YYYY-MM-DD) the system can reason about. z.string().date()
// accepts any four-digit year, but a date near 0001 or 9999 breaks the date
// arithmetic downstream (delivery-days.ts's addDays renders year 10000 as
// "+010000-08", which Postgres rejects with a 500). Every date field that
// feeds that arithmetic — delivery date suggestions, the sales order's
// expected delivery date — takes this schema instead. Same bounds as the
// API's BUSINESS_DATE_MIN/MAX clamp for stored data.
export const BUSINESS_DATE_MIN = "1900-01-01";
export const BUSINESS_DATE_MAX = "2999-12-31";

export const businessDateSchema = z
  .string()
  .date()
  .refine((d) => d >= BUSINESS_DATE_MIN && d <= BUSINESS_DATE_MAX, {
    message: `Date must be between ${BUSINESS_DATE_MIN} and ${BUSINESS_DATE_MAX}`,
  });

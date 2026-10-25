import { z } from "zod";
import { businessDateSchema } from "./business-date.js";

// Dröjsmålsränta och förseningsersättning (bokföringsgranskningen etapp 5
// del C): the request shapes of Försäljning → Räntefakturering and Ekonomi →
// Referensränta. The arithmetic itself (räntelagen 4 och 6 §§, inkasso-
// kostnadslagen 4 a och 5 §§) is the API's pure late-interest.ts.

// Förseningsersättning (inkassokostnadslagen 4 a §): a fixed amount in the
// law, so a constant here — never a setting.
export const LATE_FEE_AMOUNT = 450;

// Riksbankens referensränta is set for each calendar half-year (räntelagen
// 9 §): a row is valid from 1 January or 1 July.
export const halfYearStartSchema = businessDateSchema.refine(
  (value) => /^\d{4}-(01|07)-01$/.test(value),
  "Must be 1 January or 1 July"
);

// GET /late-interest/candidates. asOf = t.o.m.-datum (default today in
// Stockholm); includeUnpaid = Ta med obetalda fakturor (default on). NOT
// z.coerce.boolean() — it turns the string "false" into true.
export const lateInterestCandidatesQuerySchema = z.object({
  asOf: businessDateSchema.optional(),
  customerId: z.string().uuid().optional(),
  includeUnpaid: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => value !== "false"),
});
export type LateInterestCandidatesQuery = z.infer<typeof lateInterestCandidatesQuerySchema>;

// POST /late-interest/invoices — the rows the user ticked, each with the
// period start and fee the list showed (the server refuses the run when
// either no longer holds: 409 late-interest-already-charged).
export const lateInterestRunItemSchema = z.object({
  invoiceId: z.string().uuid(),
  fromDate: businessDateSchema,
  includeInterest: z.boolean(),
  includeFee: z.boolean(),
  fee: z.number().min(0).max(LATE_FEE_AMOUNT),
});
export type LateInterestRunItem = z.infer<typeof lateInterestRunItemSchema>;

export const createLateInterestInvoicesSchema = z.object({
  asOf: businessDateSchema,
  issue: z.boolean().default(false),
  items: z.array(lateInterestRunItemSchema).min(1).max(500),
});
export type CreateLateInterestInvoicesInput = z.infer<typeof createLateInterestInvoicesSchema>;

// POST /reference-rates — a manual rate for a half-year (upsert; it wins
// over Riksbanken's for the same half-year). The rate may be 0 or negative.
export const createReferenceRateSchema = z.object({
  validFrom: halfYearStartSchema,
  rate: z.number().min(-100).max(100),
});
export type CreateReferenceRateInput = z.infer<typeof createReferenceRateSchema>;

// POST /reference-rates/fetch — Hämta från Riksbanken for the half-years in
// [from, to] (default: the latest four half-years through today).
export const fetchReferenceRatesSchema = z
  .object({
    from: businessDateSchema.optional(),
    to: businessDateSchema.optional(),
  })
  .refine((value) => value.from === undefined || value.to === undefined || value.from <= value.to, {
    message: "from must not be after to",
    path: ["from"],
  });
export type FetchReferenceRatesInput = z.infer<typeof fetchReferenceRatesSchema>;

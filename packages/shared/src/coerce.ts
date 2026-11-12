import { z } from "zod";

// Blank-string guard for z.coerce.number() fields (uppföljningssvepet,
// Package 2.2). Number("") is 0 — a cleared form field or an empty CSV cell
// would silently coerce to zero and pass validation. Preprocessing blank
// strings to NaN makes them FAIL coercion instead, so the caller gets a 400
// rather than a phantom zero amount/quantity. First hardened in vat.ts (B5)
// and stock.ts (D2); this is the one shared authority.
//
// null is blank too: Number(null) is 0, so `"unitPrice": null` from an API
// client (the template's evaluate answers null when there is no base price)
// was stored as a 0 kr manual price (delatgranskningen 2026-11-11). Where
// null MEANS something, put .nullable() OUTSIDE — blankSafe(x).nullable()
// lets null through before this preprocess runs.
export const blankSafe = <T extends z.ZodTypeAny>(inner: T) =>
  z.preprocess(
    (value) => (value === null || (typeof value === "string" && value.trim() === "") ? Number.NaN : value),
    inner
  );

// Upper bounds after the column's type, so an oversized number is a 400 on
// the field instead of Postgres 22003 (the global error handler's
// number-out-of-range is only the net for the schemas without one).
// numericMax(10, 2) = 99999999.99 — the largest value a numeric(10,2) holds.
export const INT4_MAX = 2_147_483_647;
export const numericMax = (precision: number, scale: number): number =>
  Number(`${"9".repeat(precision - scale)}${scale > 0 ? `.${"9".repeat(scale)}` : ""}`);

// Optional free text. A blanked input arrives as "" and is normalized to
// null here rather than in each writer, so "not filled in" has exactly one
// representation. First used for routing-operation texts (manufacturing.ts),
// shared since the article's Ytbehandling/Färg fields needed the same rule.
export const optionalText = (max: number) =>
  z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? null : value),
    z.string().trim().max(max).nullable()
  );

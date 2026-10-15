import { z } from "zod";

// Blank-string guard for z.coerce.number() fields (uppföljningssvepet,
// Package 2.2). Number("") is 0 — a cleared form field or an empty CSV cell
// would silently coerce to zero and pass validation. Preprocessing blank
// strings to NaN makes them FAIL coercion instead, so the caller gets a 400
// rather than a phantom zero amount/quantity. First hardened in vat.ts (B5)
// and stock.ts (D2); this is the one shared authority.
export const blankSafe = <T extends z.ZodTypeAny>(inner: T) =>
  z.preprocess((value) => (typeof value === "string" && value.trim() === "" ? Number.NaN : value), inner);

// Optional free text. A blanked input arrives as "" and is normalized to
// null here rather than in each writer, so "not filled in" has exactly one
// representation. First used for routing-operation texts (manufacturing.ts),
// shared since the article's Ytbehandling/Färg fields needed the same rule.
export const optionalText = (max: number) =>
  z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? null : value),
    z.string().trim().max(max).nullable()
  );

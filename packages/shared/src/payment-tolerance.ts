import { round2 } from "./money.js";

// The tolerance rule of the payment registrations (B3/B4), extracted at its
// third consumer (bankfiler). Server-side it decides — inside the
// registration's row-locked transaction — what is written off; the web
// mirror (apps/web/lib/paymentTolerance.ts) only previews it.
//
//   * the applied amount must point the same way as the open one (an invoice
//     is settled by paying in, a credit note by paying out),
//   * |applied| may exceed |open| by at most the tolerance,
//   * within tolerance of the open amount the difference is written off and
//     the item CLOSES (applied + writeOff = open),
//   * otherwise it is a partial payment: nothing written off.
export type ToleranceResult =
  | { ok: true; writeOffAmount: number; settles: boolean; rest: number; kind: "closes" | "closes_with_writeoff" | "partial" }
  | { ok: false; reason: "zero" | "not_open" | "sign_mismatch" | "exceeds_open" };

export function applyPaymentTolerance(open: number, applied: number, tolerance: number): ToleranceResult {
  const o = round2(open);
  const a = round2(applied);
  const tol = round2(tolerance);
  if (o === 0) return { ok: false, reason: "not_open" };
  if (a === 0) return { ok: false, reason: "zero" };
  if (Math.sign(a) !== Math.sign(o)) return { ok: false, reason: "sign_mismatch" };
  if (Math.abs(a) > Math.abs(o) + tol) return { ok: false, reason: "exceeds_open" };
  const difference = round2(o - a);
  const writeOffAmount = Math.abs(difference) <= tol ? difference : 0;
  const rest = round2(o - a - writeOffAmount);
  const settles = rest === 0;
  return {
    ok: true,
    writeOffAmount,
    settles,
    rest,
    kind: !settles ? "partial" : writeOffAmount === 0 ? "closes" : "closes_with_writeoff",
  };
}

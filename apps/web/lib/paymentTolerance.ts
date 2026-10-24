// Mirror of packages/shared/src/payment-tolerance.ts — the web can't import
// @navet/shared. NO imports: apps/api/test/payment-tolerance.shared.test.ts
// loads this file directly and compares it case by case. Display only — the
// server re-derives everything inside its own row-locked transaction.

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

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

export type PreviewTone = "neutral" | "success" | "error";

export const PREVIEW_TONE_COLOR: Record<PreviewTone, string> = {
  neutral: "var(--color-text-secondary)",
  success: "var(--status-running-text)",
  error: "var(--status-stopped-text)",
};

function kr(value: number): string {
  return value.toLocaleString("sv-SE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// `unit` is the word after the amounts: "kr" for a SEK item (the default),
// the ISO code for an invoice in another currency.
export function paymentPreview(
  open: number,
  appliedRaw: string,
  tolerance: number,
  unit: string = "kr"
): { text: string; tone: PreviewTone } {
  const trimmed = appliedRaw.trim();
  if (trimmed === "") return { text: "Ange ett belopp", tone: "neutral" };
  const applied = round2(Number(trimmed));
  if (Number.isNaN(applied) || applied === 0) return { text: "Ange ett belopp skilt från 0", tone: "neutral" };
  const result = applyPaymentTolerance(open, applied, tolerance);
  if (!result.ok) {
    if (result.reason === "exceeds_open") return { text: "Beloppet överstiger öppet belopp", tone: "error" };
    return { text: "Beloppet måste ha samma tecken som öppet belopp", tone: "error" };
  }
  if (result.kind === "closes") return { text: "Stänger posten", tone: "success" };
  if (result.kind === "closes_with_writeoff") {
    return { text: `Stänger posten · avskrivning ${kr(Math.abs(result.writeOffAmount))} ${unit}`, tone: "success" };
  }
  return { text: `Delbetalning · rest ${kr(result.rest)} ${unit}`, tone: "neutral" };
}

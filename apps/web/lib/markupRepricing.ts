import type { MarkupRepricingKeptReason, MarkupRepricingPlan } from "./types";

// Påslag på offert och order (#16): the header form's two percent fields and
// the confirmation shown before a save that reprices Kalkylpris rows.

// The numeric value of a Generellt påslag / Materialpåslag field: null when
// empty (inherit), NaN when it is not a number from 0 to 1000. Rounded to the
// column's two decimals, as the API does.
export function parseMarkupField(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed.replace(",", "."));
  if (!Number.isFinite(n) || n < 0 || n > 1000) return Number.NaN;
  return Math.round(n * 100) / 100;
}

// What the PATCH carries: only a field that differs from the order's stored
// value (an omitted field stays as it is). `null` clears it again.
export function changedMarkups(
  current: { general: string | null | undefined; material: string | null | undefined },
  next: { general: number | null; material: number | null }
): { generalMarkupPercent?: number | null; materialMarkupPercent?: number | null } {
  const same = (stored: string | null | undefined, value: number | null) =>
    (stored == null ? null : Number(stored)) === value;
  return {
    ...(same(current.general, next.general) ? {} : { generalMarkupPercent: next.general }),
    ...(same(current.material, next.material) ? {} : { materialMarkupPercent: next.material }),
  };
}

const KEPT_REASONS: Record<MarkupRepricingKeptReason, string> = {
  manual: "handskrivet pris",
  delivered: "levererad",
  invoiced: "fakturerad",
  unchanged: "samma pris som förut",
  "no-price": "kalkylen ger inget pris",
};

export function keptReasonText(reason: MarkupRepricingKeptReason): string {
  return KEPT_REASONS[reason];
}

const KEPT_LIMIT = 10;

const money = (n: number) => n.toLocaleString("sv-SE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function percentText(n: number | null): string {
  return n === null ? "ärvs" : `${n.toLocaleString("sv-SE", { maximumFractionDigits: 2 })} %`;
}

// The limit that has to be said: rows priced before the order had a markup
// carry no Kalkylpris flag and are never repriced.
export const REPRICING_LIMIT_TEXT =
  "Rader som fick artikelpriset innan ordern fick ett påslag räknas aldrig om.";

// The confirmation text. `priceOf` turns a base-unit price into the price the
// row shows (its own unit); default is the base-unit price as it is.
export function repricingMessage(
  plan: MarkupRepricingPlan,
  options: { priceOf?: (rowId: string, basePrice: number) => number } = {}
): string {
  const priceOf = options.priceOf ?? ((_id, price) => price);
  const lines: string[] = [];
  lines.push(
    `Påslagen räknar om à-priset på ${plan.rows.length} ${plan.rows.length === 1 ? "rad" : "rader"} som prissatts ur kalkylen ` +
      `(generellt påslag ${percentText(plan.before.generalMarkupPercent)} → ${percentText(plan.after.generalMarkupPercent)}, ` +
      `materialpåslag ${percentText(plan.before.materialMarkupPercent)} → ${percentText(plan.after.materialMarkupPercent)}).`
  );
  lines.push("");
  for (const row of plan.rows) {
    const before = money(priceOf(row.rowId, row.before.unitPrice));
    const after = money(priceOf(row.rowId, row.after.unitPrice));
    // A row the chain now prices another way is said so; the flag is gone.
    const note =
      !row.calculatedPrice && row.after.source !== "calculated" ? " (inte längre Kalkylpris)" : "";
    lines.push(`${row.articleNumber}: ${before} → ${after} ${plan.currency}${note}`);
  }
  if (plan.kept.length > 0) {
    lines.push("", "Ändras inte:");
    for (const k of plan.kept.slice(0, KEPT_LIMIT)) lines.push(`${k.articleNumber}: ${keptReasonText(k.reason)}`);
    if (plan.kept.length > KEPT_LIMIT) lines.push(`… och ${plan.kept.length - KEPT_LIMIT} till`);
  }
  lines.push("", "Handskrivna priser och levererade eller fakturerade rader ändras inte. " + REPRICING_LIMIT_TEXT);
  return lines.join("\n");
}

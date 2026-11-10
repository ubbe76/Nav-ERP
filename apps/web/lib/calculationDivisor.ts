// What a SAVED calculation's totals are divided by to give a per-unit figure.
// A mirror of perUnitDivisor in the API's costing/service/cost-figures.ts (the
// web cannot import the API or @navet/shared) — the server decides what Sätt
// standardpris and Sätt försäljningspris write, this decides what the
// specification SHOWS they will write. apps/api/test/kalkylgranskning.test.ts
// runs the two against each other; change both together.
//
//   - förkalkyl                         → the calculated quantity
//   - efterkalkyl, final, N > 0         → N, the received quantity ("output")
//   - efterkalkyl, preliminary          → no figure (the order is still open)
//   - efterkalkyl, final, N = 0         → no figure (nothing was made)
//   - efterkalkyl saved before the analysis (both fields null) → the quantity
//
// No imports on purpose: the API suite loads this file directly.
export interface PerUnitDivisorSource {
  type: "pre" | "post";
  quantity: number | string;
  // The header's output_quantity/preliminary. The API sends them on every
  // calculation; null (or absent) = saved without an analysis.
  outputQuantity?: number | string | null;
  preliminary?: boolean | null;
}

export type PerUnitDivisor =
  | { divisor: number; basis: "quantity" | "output" }
  | { divisor: null; reason: "invalid-quantity" | "preliminary" | "no-output" };

export function perUnitDivisor(c: PerUnitDivisorSource): PerUnitDivisor {
  const analysed = c.type === "post" && c.outputQuantity !== null && c.outputQuantity !== undefined && typeof c.preliminary === "boolean";
  if (analysed) {
    if (c.preliminary) return { divisor: null, reason: "preliminary" };
    const n = Number(c.outputQuantity);
    if (!Number.isFinite(n) || n <= 0) return { divisor: null, reason: "no-output" };
    return { divisor: n, basis: "output" };
  }
  const q = Number(c.quantity);
  if (!Number.isFinite(q) || q <= 0) return { divisor: null, reason: "invalid-quantity" };
  return { divisor: q, basis: "quantity" };
}

// Why an efterkalkyl shows no Per st and no price buttons. null = it does (or
// the quantity itself is unusable, which the specification never explained).
export function noPerUnitNotice(resolved: PerUnitDivisor): string | null {
  if (resolved.divisor !== null) return null;
  if (resolved.reason === "preliminary") {
    return "Efterkalkylen är preliminär — tillverkningsordern är inte klar. Per st och knapparna Sätt standardpris och Sätt försäljningspris finns först på en efterkalkyl som görs när ordern är klar.";
  }
  if (resolved.reason === "no-output") {
    return "Inget är inlevererat på tillverkningsordern, så efterkalkylen ger inget pris per styck och kan inte sätta artikelns priser.";
  }
  return null;
}

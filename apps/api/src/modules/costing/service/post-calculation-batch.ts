import { roundToDecimals } from "@navet/shared";
import { manufacturingCost, perUnit, perUnitDivisor, type ManufacturingCostBuckets } from "./cost-figures.js";
import { calculatedPerUnit, type FinalAnalysisSource } from "./cost-variance.js";

// Efterkalkylera flera (#34) — the pure part of a row, no DB imports and no
// arithmetic of its own: every figure is another reader's rule.
//
//   Efterkalkyl/st = the efterkalkyl's TVK (manufacturingCost) ÷ the
//                    divisor of perUnitDivisor — N on a final efterkalkyl,
//                    none on a preliminary one or with N = 0. The TO card's
//                    efterkalkylpanel and Sätt standardpris divide the same.
//   Kalkylerat/st  = the avvikelseanalys's Kalkylerat ÷ N, final analyses
//                    only — calculatedPerUnit, the function Kalkylutfall's
//                    calculatedTvkPerUnit is.
//   Avvikelse      = Efterkalkyl/st − Kalkylerat/st, and in percent of
//                    Kalkylerat/st.
//
// Per-unit figures at the article's four decimals (as Förkalkylera flera),
// the percentage at two.

export interface PostCalculationSource extends ManufacturingCostBuckets {
  quantity: number | string;
  outputQuantity: number | string | null;
  preliminary: boolean | null;
}

export interface PostCalculationPerUnit {
  calculatedPerUnit: number | null;
  actualPerUnit: number | null;
  // null when either side is missing; percent null when Kalkylerat/st is 0.
  variance: { amount: number; percent: number | null } | null;
}

export function postCalculationPerUnit(calculation: PostCalculationSource, analysis: FinalAnalysisSource | null): PostCalculationPerUnit {
  const resolved = perUnitDivisor({ type: "post", quantity: calculation.quantity, outputQuantity: calculation.outputQuantity, preliminary: calculation.preliminary });
  const actualRaw = resolved.divisor === null ? null : perUnit(manufacturingCost(calculation), resolved.divisor);
  const calculatedRaw = calculatedPerUnit(analysis);
  const actual = actualRaw === null ? null : roundToDecimals(actualRaw, 4);
  const calculated = calculatedRaw === null ? null : roundToDecimals(calculatedRaw, 4);
  return { calculatedPerUnit: calculated, actualPerUnit: actual, variance: perUnitVariance(actual, calculated) };
}

// Of the two figures AS SHOWN, so the row's three columns always add up.
export function perUnitVariance(actual: number | null, calculated: number | null): PostCalculationPerUnit["variance"] {
  if (actual === null || calculated === null) return null;
  const amount = roundToDecimals(actual - calculated, 4);
  return { amount, percent: calculated === 0 ? null : roundToDecimals((amount / calculated) * 100, 2) };
}

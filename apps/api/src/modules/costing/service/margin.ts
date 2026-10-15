// Täckningsbidrag och täckningsgrad — what a sales line earns above what the
// article costs us. Pure and database-free: the caller supplies the price and
// the self cost, this decides what follows from them.
//
// The self cost is the LATEST saved pre-calculation's självkostnad per unit
// (SVK) — material, labor, TO, lego and Affo, but not the general markup,
// which is the margin we are measuring.
//
// The rule that matters most here: a missing self cost yields null, never 0.
// An article without a calculation has an UNKNOWN cost, and treating unknown
// as free would overstate the margin — the most damaging thing this file could
// do. sumMargins counts those lines separately instead, so a total can say
// "TB 12 340 kr (2 rader saknar kalkyl)" rather than quietly inflating itself.

export interface MarginLineInput {
  quantity: number;
  unitPrice: number;
  discountPercent: number;
  /** null = no saved pre-calculation for the article. */
  selfCostPerUnit: number | null;
}

export interface MarginLine {
  netRevenue: number;
  /** null when the self cost is unknown. */
  cost: number | null;
  /** TB — täckningsbidrag. null when the cost is unknown. */
  contribution: number | null;
  /** TG — täckningsgrad, TB / netto. null when unknown, or when there is no revenue to divide by. */
  marginPercent: number | null;
}

export function computeLineMargin(input: MarginLineInput): MarginLine {
  const netRevenue = input.quantity * input.unitPrice * (1 - input.discountPercent / 100);
  if (input.selfCostPerUnit === null) {
    return { netRevenue, cost: null, contribution: null, marginPercent: null };
  }
  const cost = input.quantity * input.selfCostPerUnit;
  const contribution = netRevenue - cost;
  return {
    netRevenue,
    cost,
    contribution,
    // A negative contribution is a real answer and is returned as-is — an
    // order sold below cost is exactly what this is for.
    marginPercent: netRevenue !== 0 ? (contribution / netRevenue) * 100 : null,
  };
}

export interface MarginTotal {
  /** Net revenue across ALL lines — the order's value. */
  netRevenue: number;
  /**
   * Net revenue across only the lines that had a self cost. Contribution and
   * margin are computed against THIS, never against netRevenue: subtracting a
   * partial cost from a full revenue is precisely the overstatement this file
   * exists to avoid.
   */
  costedNetRevenue: number;
  /** null when no line had a calculation. */
  cost: number | null;
  contribution: number | null;
  marginPercent: number | null;
  /** How many lines had no calculation, and are therefore absent from the above. */
  linesWithoutCost: number;
}

export function sumMargins(lines: MarginLine[]): MarginTotal {
  let netRevenue = 0;
  let costedNetRevenue = 0;
  let cost = 0;
  let linesWithoutCost = 0;
  let anyCost = false;

  for (const line of lines) {
    netRevenue += line.netRevenue;
    if (line.cost === null) {
      linesWithoutCost += 1;
      continue;
    }
    anyCost = true;
    costedNetRevenue += line.netRevenue;
    cost += line.cost;
  }

  const contribution = anyCost ? costedNetRevenue - cost : null;
  return {
    netRevenue,
    costedNetRevenue,
    cost: anyCost ? cost : null,
    contribution,
    marginPercent: contribution !== null && costedNetRevenue !== 0 ? (contribution / costedNetRevenue) * 100 : null,
    linesWithoutCost,
  };
}

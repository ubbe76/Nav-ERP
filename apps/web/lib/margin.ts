// Täckningsbidrag och täckningsgrad, mirrored from
// apps/api/src/modules/costing/service/margin.ts — the web app cannot import
// @navet/shared (Turbopack vs .js-suffix imports; see lib/listQuery.ts), so
// the two files are kept in sync by hand. The tests live on the API side.
//
// The rule worth restating here: a missing self cost is null, never 0. An
// article without a saved calculation has an unknown cost, and showing it as
// free would overstate every margin it appeared in.

export interface MarginLineInput {
  quantity: number;
  unitPrice: number;
  discountPercent: number;
  selfCostPerUnit: number | null;
}

export interface MarginLine {
  netRevenue: number;
  cost: number | null;
  contribution: number | null;
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
    marginPercent: netRevenue !== 0 ? (contribution / netRevenue) * 100 : null,
  };
}

export interface MarginTotal {
  netRevenue: number;
  costedNetRevenue: number;
  cost: number | null;
  contribution: number | null;
  marginPercent: number | null;
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

// "TB 1 234 kr · TG 32,1 %", or an honest dash when the article has no
// calculation to measure against.
export function formatMargin(line: { contribution: number | null; marginPercent: number | null }): string {
  if (line.contribution === null) return "TB — (ingen förkalkyl)";
  const tb = line.contribution.toLocaleString("sv-SE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (line.marginPercent === null) return `TB ${tb} kr`;
  return `TB ${tb} kr · TG ${line.marginPercent.toLocaleString("sv-SE", { maximumFractionDigits: 1 })} %`;
}

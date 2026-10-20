import type { CostChainLine } from "../components/ui/CostChain";
import { formatMoney } from "./format";

// Just the påläggskalkyl's money fields, as the API's strings. Narrower than
// CostCalculation on purpose: a preview draft has no id, no calculatedAt and no
// specification rows, and the chain reads none of those.
export interface CostChainSource {
  materialCost: string;
  materialOverhead: string;
  laborCost: string;
  overhead: string;
  subcontractCost: string;
  subcontractOverhead: string;
  semiFinishedCost: string;
  businessOverhead: string;
  generalMarkup: string;
  salesPrice: string;
}

// TVK and SVK are plain sums of the stored steps — the API never stores them.
// TO (`overhead`) is in neither: it is added last, towards the sales price,
// after the general markup (the API's cost-figures.ts is the sibling
// authority). A calculation saved under the earlier chain (TO inside TVK)
// still sums to its stored salesPrice — the same amounts, read in the new
// order.
function manufacturingCost(c: CostChainSource) {
  return (
    Number(c.materialCost) +
    Number(c.materialOverhead) +
    Number(c.laborCost) +
    Number(c.subcontractCost) +
    Number(c.subcontractOverhead) +
    Number(c.semiFinishedCost)
  );
}

// One line per step of the påläggskalkyl. Shared by the saved calculation's
// Summering and by the preview panels on the Kalkyl tab and the manufacturing
// order card. When `quantity` is given (and usable), every line also gets a
// `perUnit` figure — this division, and its formatting, live here and nowhere
// else, so CostChain and its callers never each compute their own styckpris.
export function chainLines(c: CostChainSource, quantity?: number): CostChainLine[] {
  const selfCost = manufacturingCost(c) + Number(c.businessOverhead);
  const withPerUnit = quantity !== undefined && Number.isFinite(quantity) && quantity !== 0;
  const perUnit = (amount: number) => (withPerUnit ? formatMoney(amount / quantity!) : undefined);
  const line = (
    label: string,
    amount: number,
    kind?: CostChainLine["kind"]
  ): CostChainLine => ({ label, amount, kind, perUnit: perUnit(amount) });

  const semiFinished = Number(c.semiFinishedCost);

  return [
    line("Direkt material (dM)", Number(c.materialCost)),
    line("MO-påslag", Number(c.materialOverhead), "markup"),
    line("Direkt lön (dL)", Number(c.laborCost)),
    line("Legokostnad", Number(c.subcontractCost)),
    line("LO-påslag", Number(c.subcontractOverhead), "markup"),
    // Only when there is something to show: every calculation saved before
    // multi-level existed has 0 here, and a permanent "0 kr" row in each of
    // their Summering would be noise. Unlike the steps above, this one is not
    // part of the chain everyone is taught — it appears when it applies.
    ...(semiFinished !== 0 ? [line("Halvfabrikat", semiFinished)] : []),
    line("Tillverkningskostnad (TVK)", manufacturingCost(c), "subtotal"),
    line("Affo-påslag", Number(c.businessOverhead), "markup"),
    line("Självkostnad (SVK)", selfCost, "subtotal"),
    line("Generellt påslag", Number(c.generalMarkup), "markup"),
    // TO last: outside TVK and SVK, no Affo or profit markup on it.
    line("TO-påslag", Number(c.overhead), "markup"),
    line("Försäljningspris", Number(c.salesPrice), "result"),
  ];
}

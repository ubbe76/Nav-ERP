// Produkter i arbete (PIA) per datum (#25) — the arithmetic, pure: no DB
// imports, ONE implementation that the report and the year-end step share
// through work-in-progress.service.ts. PIA per D for a TO = the efterkalkyl
// per D (material, lön, lego and — with Tillverkningskostnad — MO and LO)
// less what it has already received into stock, valued at the price it went
// into stock with (avräknat). Nothing is stored: the logs are the record.
import { round2, type WipBasis } from "@navet/shared";

// Quantities are numeric(14,4); same local helper as fifo.ts/moving-average.ts.
function round4(n: number): number {
  return Math.round((n + Number.EPSILON) * 10000) / 10000;
}

// One mo_receipt row of the order valued on or before D, in värderingsdatum
// order: a receipt (positive, unit_cost = the standard cost at the receipt or
// the configured TO's TVK/st; null = received without a price) or the undo of
// one (negative, never priced).
export interface WipReceipt {
  quantityDelta: number;
  unitCost: number | null;
}

// Avräknat: what the order has put into stock, at the price it went in with.
// An undo takes its quantity back from the newest earlier receipt that still
// has some (the same approximation as FIFO's reversal: when several receipts
// share the order, the newest is taken). value null = unknown: some quantity
// still counted was received without a price, or an undo found nothing to
// take back from — the row is then unvalued rather than guessed.
export function relievedValue(receipts: WipReceipt[]): { quantity: number; value: number | null } {
  let quantity = 0;
  let unmatched = false;
  const layers: { quantity: number; unitCost: number | null }[] = [];
  for (const receipt of receipts) {
    quantity = round4(quantity + receipt.quantityDelta);
    if (receipt.quantityDelta > 0) {
      layers.push({ quantity: receipt.quantityDelta, unitCost: receipt.unitCost });
      continue;
    }
    let remaining = -receipt.quantityDelta;
    for (let i = layers.length - 1; i >= 0 && remaining > 0; i--) {
      const layer = layers[i]!;
      if (layer.quantity <= 0) continue;
      const taken = Math.min(layer.quantity, remaining);
      layer.quantity = round4(layer.quantity - taken);
      remaining = round4(remaining - taken);
    }
    if (remaining > 0) unmatched = true;
  }
  if (unmatched) return { quantity, value: null };
  let value = 0;
  for (const layer of layers) {
    if (layer.quantity <= 0) continue;
    if (layer.unitCost === null) return { quantity, value: null };
    value += layer.quantity * layer.unitCost;
  }
  return { quantity, value };
}

// The cost buckets of the order per D, as applyMarkups (markup.ts) returns
// them. TO (`overhead` there) is deliberately not part of this: it lies
// outside TVK, and a finished good in stock does not carry it either.
export interface WipCosts {
  materialCost: number;
  laborCost: number;
  subcontractCost: number;
  materialOverhead: number;
  subcontractOverhead: number;
}

export interface WipRowAmounts {
  material: number;
  labor: number;
  subcontract: number;
  // MO + LO; 0 with Direkta kostnader.
  overhead: number;
  // Upparbetat = the four columns above.
  accumulated: number;
  // Avräknat; null = unknown (see relievedValue).
  relieved: number | null;
  // PIA = max(0, upparbetat − avräknat); null = unvalued.
  value: number | null;
  // Avräknat exceeds upparbetat (usually time not reported yet): the value
  // is held at 0 — a TO cannot carry a negative asset value.
  capped: boolean;
}

// Every column is rounded to öre, and upparbetat is the sum of the rounded
// columns, so a row always adds up on paper.
export function workInProgressRow(costs: WipCosts, relieved: number | null, basis: WipBasis): WipRowAmounts {
  const material = round2(costs.materialCost);
  const labor = round2(costs.laborCost);
  const subcontract = round2(costs.subcontractCost);
  const overhead = basis === "manufacturing_cost" ? round2(costs.materialOverhead + costs.subcontractOverhead) : 0;
  const accumulated = round2(material + labor + subcontract + overhead);
  if (relieved === null) return { material, labor, subcontract, overhead, accumulated, relieved: null, value: null, capped: false };
  const relievedRounded = round2(relieved);
  const difference = round2(accumulated - relievedRounded);
  return {
    material,
    labor,
    subcontract,
    overhead,
    accumulated,
    relieved: relievedRounded,
    value: Math.max(0, difference),
    capped: difference < 0,
  };
}

// A TO with nothing accumulated and nothing relieved per D (planned, or not
// touched yet by then) is not part of the report.
export function isEmptyWipRow(row: Pick<WipRowAmounts, "accumulated" | "relieved">): boolean {
  return row.accumulated === 0 && row.relieved === 0;
}

// A Slutför report (mo_reports.kind = completion: Slutför/Slutför order and
// 0117's backfill) as Stockholm days.
export interface CompletedReport {
  createdOn: string;
  undoneOn: string | null;
}

// Klar vid D: then nedlagt − avräknat is a variance in the result, not an
// asset. The domain's own rule per day — undoReportInTx's stillDone: (a) a
// Slutför report was alive on D (it may close the order short), or (b) the
// quantity received by D covers the order (delinleverans from the last
// operation or a lego receipt; also the orders done through operation
// reports before 0117, which the backfill gave no Slutför row). NOT
// completed_order: an operation report that completed the order stops
// counting once an earlier receipt is undone.
export function isDoneAt(input: {
  asOf: string;
  quantity: number;
  receivedQuantity: number;
  completedReports: CompletedReport[];
}): boolean {
  const alive = input.completedReports.some(
    (report) => report.createdOn <= input.asOf && (report.undoneOn === null || report.undoneOn > input.asOf)
  );
  return alive || round4(input.receivedQuantity) >= round4(input.quantity);
}

export interface WipTotals {
  material: number;
  labor: number;
  subcontract: number;
  overhead: number;
  accumulated: number;
  // Over the rows whose avräknat is known.
  relieved: number;
}

// The summary row: each column is the sum of the rounded rows (as the stock
// valuation's total), totalValue leaves the unvalued rows out.
export function workInProgressTotals(rows: WipRowAmounts[]): {
  totals: WipTotals;
  totalValue: number;
  unvaluedCount: number;
  cappedCount: number;
} {
  const totals: WipTotals = { material: 0, labor: 0, subcontract: 0, overhead: 0, accumulated: 0, relieved: 0 };
  let totalValue = 0;
  let unvaluedCount = 0;
  let cappedCount = 0;
  for (const row of rows) {
    totals.material = round2(totals.material + row.material);
    totals.labor = round2(totals.labor + row.labor);
    totals.subcontract = round2(totals.subcontract + row.subcontract);
    totals.overhead = round2(totals.overhead + row.overhead);
    totals.accumulated = round2(totals.accumulated + row.accumulated);
    if (row.relieved !== null) totals.relieved = round2(totals.relieved + row.relieved);
    if (row.value === null) unvaluedCount++;
    else totalValue = round2(totalValue + row.value);
    if (row.capped) cappedCount++;
  }
  return { totals, totalValue, unvaluedCount, cappedCount };
}

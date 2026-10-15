// Årsbokslut — steg 1 Kontroller and the close gate as pure functions over
// already-read facts (no DB imports), so every rule is unit-testable.
import { round2 } from "@navet/shared";
import { formatNumber } from "../../mail/service/document-pdf.js";

export type YearEndCheckCode =
  | "draft-verifications"
  | "previous-year-open"
  | "closing-period-locked"
  | "closing-date-not-passed"
  | "fiscal-year-not-ended"
  | "vat-unsettled"
  | "receivables-mismatch"
  | "payables-mismatch"
  | "fixed-assets-mismatch"
  | "revenue-without-vat-box"
  | "inventory-stale"
  | "inventory-not-done"
  | "depreciation-missing"
  | "accruals-not-done"
  | "result-not-transferred"
  | "next-year-opening-balance-import";

export interface YearEndCheck {
  code: YearEndCheckCode;
  message: string;
}

export interface StepGateInput {
  today: string;
  closingDate: string;
  draftCount: number;
  previousYear: { label: string; status: "open" | "closed" } | null;
  closingPeriodStatus: "open" | "locked";
}

// Gate for steps 2–5 (spec 4.2).
export function evaluateStepBlockers(gate: StepGateInput): YearEndCheck[] {
  const blockers: YearEndCheck[] = [];
  if (gate.draftCount > 0) {
    blockers.push({ code: "draft-verifications", message: `${gate.draftCount} verifikatutkast i räkenskapsåret måste bokföras eller tas bort` });
  }
  if (gate.previousYear?.status === "open") {
    blockers.push({ code: "previous-year-open", message: `Föregående räkenskapsår (${gate.previousYear.label}) är inte stängt` });
  }
  if (gate.closingPeriodStatus === "locked") {
    blockers.push({ code: "closing-period-locked", message: "Bokslutsmånaden är låst — lås upp den för att kunna bokföra bokslutet" });
  }
  if (gate.closingDate >= gate.today) {
    blockers.push({ code: "closing-date-not-passed", message: `Bokslutsdagen ${gate.closingDate} har inte passerat` });
  }
  return blockers;
}

export interface CloseGateInput extends StepGateInput {
  // The year's last day: steps may run once the closing date has passed,
  // but the year itself closes only after its last day.
  yearEndDate: string;
  inventoryDone: boolean;
  missingDepreciationAssets: number;
  accrualsDone: boolean;
  resultNet: number;
  // Unreversed series-I verifications in the next year (for the message).
  openingBalanceImports: string[];
  // Balance accounts where IB(N+1) ≠ UB(N) — what actually blocks.
  openingBalanceDifferences: number;
}

// Gate for steg 6 (spec 4.2/4.7). A locked closing month does not block:
// closing locks every period anyway.
export function evaluateCloseBlockers(input: CloseGateInput): YearEndCheck[] {
  const blockers = evaluateStepBlockers(input).filter((check) => check.code !== "closing-period-locked");
  if (input.yearEndDate >= input.today) {
    blockers.push({
      code: "fiscal-year-not-ended",
      message: `Räkenskapsåret slutar ${input.yearEndDate} — det kan stängas tidigast dagen efter`,
    });
  }
  if (!input.inventoryDone) blockers.push({ code: "inventory-not-done", message: "Steg 2 Lagerförändring är inte gjort" });
  if (input.missingDepreciationAssets > 0) {
    blockers.push({
      code: "depreciation-missing",
      message: `Avskrivningar saknas för ${input.missingDepreciationAssets} anläggningar t.o.m. bokslutsmånaden`,
    });
  }
  if (!input.accrualsDone) blockers.push({ code: "accruals-not-done", message: "Steg 4 Periodiseringar är inte gjort" });
  if (round2(input.resultNet) !== 0) {
    blockers.push({
      code: "result-not-transferred",
      message: `Årets resultat (${formatNumber(input.resultNet)}) är inte överfört — gör steg 5 Resultatöverföring`,
    });
  }
  if (input.openingBalanceDifferences > 0) {
    const list = input.openingBalanceImports.join(", ");
    blockers.push({
      code: "next-year-opening-balance-import",
      message:
        input.openingBalanceImports.length > 0
          ? `Nästa räkenskapsår har importerade ingående balanser (${list}) som dubblerar årets utgående balanser — omför ${list} innan året stängs`
          : `Nästa räkenskapsårs ingående balanser skiljer sig från årets utgående balanser på ${input.openingBalanceDifferences} konton — se IB-avstämningen innan året stängs`,
    });
  }
  return blockers;
}

export interface LedgerComparison {
  accountNumber: string;
  ledger: number;
  register: number;
}

export interface WarningInput {
  unsettledVatMonths: string[];
  receivables: LedgerComparison;
  payables: LedgerComparison;
  fixedAssetMismatches: string[];
  revenueWithoutVatBox: { accountNumber: string; accountName: string; net: number }[];
  // Steg 2 done but the inventory account no longer equals the booked value.
  inventoryStale: { ledger: number; value: number } | null;
}

const MONTHS = ["januari", "februari", "mars", "april", "maj", "juni", "juli", "augusti", "september", "oktober", "november", "december"];

function monthName(key: string): string {
  return `${MONTHS[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`;
}

function signed(value: number): string {
  return value > 0 ? `+${formatNumber(value)}` : formatNumber(value);
}

function ledgerMismatch(code: YearEndCheckCode, label: string, comparison: LedgerComparison): YearEndCheck | null {
  const difference = round2(comparison.ledger - comparison.register);
  if (difference === 0) return null;
  return {
    code,
    message: `${label} stämmer inte mot konto ${comparison.accountNumber}: huvudbok ${formatNumber(comparison.ledger)}, reskontra ${formatNumber(comparison.register)} (skillnad ${signed(difference)})`,
  };
}

// Non-blocking warnings (spec 4.2). Order is the UI's order.
export function evaluateWarnings(input: WarningInput): YearEndCheck[] {
  const warnings: YearEndCheck[] = [];
  if (input.unsettledVatMonths.length > 0) {
    warnings.push({
      code: "vat-unsettled",
      message: `Momsen är inte omförd för: ${input.unsettledVatMonths.map(monthName).join(", ")} — efter stängningen kan den inte bokföras i året`,
    });
  }
  const receivables = ledgerMismatch("receivables-mismatch", "Kundreskontran", input.receivables);
  if (receivables) warnings.push(receivables);
  const payables = ledgerMismatch("payables-mismatch", "Leverantörsreskontran", input.payables);
  if (payables) warnings.push(payables);
  for (const line of input.fixedAssetMismatches) {
    warnings.push({ code: "fixed-assets-mismatch", message: `Anläggningsregistret: ${line}` });
  }
  if (input.revenueWithoutVatBox.length > 0) {
    warnings.push({
      code: "revenue-without-vat-box",
      message: `Intäkter på konton utan momsruta: ${input.revenueWithoutVatBox.map((a) => `${a.accountNumber} ${a.accountName}`).join(", ")}`,
    });
  }
  if (input.inventoryStale) {
    warnings.push({
      code: "inventory-stale",
      message: `Lagerkontots saldo (${formatNumber(input.inventoryStale.ledger)}) stämmer inte med den bokförda lagervärderingen (${formatNumber(input.inventoryStale.value)}) — gör om steg 2`,
    });
  }
  return warnings;
}

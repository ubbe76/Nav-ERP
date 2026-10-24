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
  | "fx-revaluation-not-done"
  | "fx-revaluation-stale"
  | "result-not-transferred"
  | "next-year-opening-balance-import"
  | "bank-not-reconciled";

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
  // Valutaomvärdering: open invoices in another currency than SEK per the
  // closing date, and whether the step is done. Absent = no foreign items.
  fxRevaluation?: { openItems: number; done: boolean };
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
  // Like the accruals a blocker, but only when there is something to
  // revalue: K2 values monetary items at the balance day's rate, and the
  // revaluation moves the result, so it must stand before the transfer.
  if (input.fxRevaluation && input.fxRevaluation.openItems > 0 && !input.fxRevaluation.done) {
    blockers.push({
      code: "fx-revaluation-not-done",
      message: `Valutaomvärderingen är inte gjord — ${input.fxRevaluation.openItems} öppna fakturor i annan valuta än SEK per bokslutsdagen`,
    });
  }
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
  // Valutaomvärdering: what the live revaluation booked on the account (in
  // the reskontra's sign) — the ledger is expected to be register + this.
  revaluation?: number;
}

export interface WarningInput {
  unsettledVatMonths: string[];
  receivables: LedgerComparison;
  payables: LedgerComparison;
  fixedAssetMismatches: string[];
  revenueWithoutVatBox: { accountNumber: string; accountName: string; net: number }[];
  // Steg 2 done but the inventory account no longer equals the booked value.
  inventoryStale: { ledger: number; value: number } | null;
  // The valutaomvärdering is booked but the open foreign items (or their
  // currencies) changed since — a re-run would book something else.
  fxRevaluationStale?: boolean;
  // Bankavstämning: active bank accounts not marked Avstämd t.o.m. the
  // closing date (reconciledThrough = the latest mark, null = none).
  unreconciledBankAccounts?: { name: string; ledgerAccount: string; reconciledThrough: string | null }[];
}

const MONTHS = ["januari", "februari", "mars", "april", "maj", "juni", "juli", "augusti", "september", "oktober", "november", "december"];

function monthName(key: string): string {
  return `${MONTHS[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`;
}

function signed(value: number): string {
  return value > 0 ? `+${formatNumber(value)}` : formatNumber(value);
}

function ledgerMismatch(code: YearEndCheckCode, label: string, comparison: LedgerComparison): YearEndCheck | null {
  const revaluation = round2(comparison.revaluation ?? 0);
  const difference = round2(comparison.ledger - comparison.register - revaluation);
  if (difference === 0) return null;
  const expected =
    revaluation === 0
      ? `reskontra ${formatNumber(comparison.register)}`
      : `reskontra ${formatNumber(comparison.register)} ${revaluation > 0 ? "+" : "-"} valutaomvärdering ${formatNumber(Math.abs(revaluation))}`;
  return {
    code,
    message: `${label} stämmer inte mot konto ${comparison.accountNumber}: huvudbok ${formatNumber(comparison.ledger)}, ${expected} (skillnad ${signed(difference)})`,
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
  if (input.fxRevaluationStale) {
    warnings.push({
      code: "fx-revaluation-stale",
      message: "De öppna valutaposterna har ändrats sedan valutaomvärderingen bokfördes — gör om valutaomvärderingen",
    });
  }
  for (const account of input.unreconciledBankAccounts ?? []) {
    warnings.push({
      code: "bank-not-reconciled",
      message: `Bankkontot ${account.ledgerAccount} ${account.name} är inte avstämt t.o.m. bokslutsdagen${account.reconciledThrough ? ` (senast avstämt ${account.reconciledThrough})` : ""} — se Bankavstämning`,
    });
  }
  return warnings;
}

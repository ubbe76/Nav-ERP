import { applyPaymentTolerance, round2, type ToleranceResult } from "@navet/shared";
import type { BankEntryReference } from "@navet/db";
import { validateOcrNumber } from "../../system/service/ocr.js";
import { namesMatch } from "./name-match.js";

export interface OpenReceivable {
  invoiceId: string;
  invoiceNumber: string;
  ocrNumber: string | null;
  customerId: string;
  customerName: string;
  dueDate: string | null;
  openAmount: number;
}
export interface ClosedReceivable {
  invoiceNumber: string;
  ocrNumber: string;
  status: "paid" | "cancelled";
}
export interface IncomingEntryInput {
  id: string;
  amount: number;
  counterpartyName: string | null;
  remittance: BankEntryReference[];
}
export interface MatchingLookup {
  openByOcr: Map<string, OpenReceivable>;
  closedByOcr: Map<string, ClosedReceivable>;
  candidatesByAmount: OpenReceivable[];
  openByCustomer: Map<string, OpenReceivable[]>;
  customers: { id: string; name: string }[];
}
export type MatchState = "matched" | "suggested" | "unmatched";
export type MatchBasis = "ocr" | "amount_name" | "amount_only" | "name_allocation";
export interface ProposalRow {
  invoiceId: string;
  invoiceNumber: string;
  openAmount: number;
  appliedAmount: number;
  outcome: ToleranceResult;
}
export interface IncomingProposal {
  entryId: string;
  state: MatchState;
  basis: MatchBasis | null;
  reason: string | null;
  partial: boolean;
  customerId: string | null;
  customerName: string | null;
  rows: ProposalRow[];
  alternatives: OpenReceivable[];
}

const kr = (n: number) => n.toLocaleString("sv-SE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const byDue = (a: OpenReceivable, b: OpenReceivable) =>
  (a.dueDate ?? "9999-12-31").localeCompare(b.dueDate ?? "9999-12-31") || a.invoiceNumber.localeCompare(b.invoiceNumber);

// Structured references first (SCOR/CINV/CREN); free-text digit runs only
// when there are none. Only Nav's own OCR format (length + Luhn digit) is
// looked up — a CINV that is somebody's invoice number is not an OCR.
export function candidateOcrs(remittance: BankEntryReference[]): string[] {
  const structured = remittance.filter((r) => r.type === "SCOR" || r.type === "CINV" || r.type === "CREN").map((r) => r.value.replace(/\s/g, ""));
  const pool = structured.length > 0 ? structured : remittance.flatMap((r) => r.value.match(/\d{3,25}/g) ?? []);
  return [...new Set(pool.filter((v) => validateOcrNumber(v)))];
}

// Credits first (they add to what can be applied), then invoices oldest
// first capped at their open amount; the last invoice takes the remainder.
// null when it cannot add up to the payment (no invoice to take the rest).
function allocate(amount: number, invoices: OpenReceivable[]): { invoice: OpenReceivable; applied: number }[] | null {
  const credits = invoices.filter((i) => i.openAmount < 0);
  const debits = invoices.filter((i) => i.openAmount > 0).sort(byDue);
  let remaining = round2(amount - credits.reduce((sum, c) => sum + c.openAmount, 0));
  const out = credits.map((invoice) => ({ invoice, applied: invoice.openAmount }));
  debits.forEach((invoice, index) => {
    const applied = index === debits.length - 1 ? remaining : Math.min(invoice.openAmount, remaining);
    remaining = round2(remaining - applied);
    if (applied !== 0) out.push({ invoice, applied: round2(applied) });
  });
  if (debits.length === 0 || round2(out.reduce((sum, row) => sum + row.applied, 0)) !== round2(amount)) return null;
  return out;
}

function rowsOf(allocation: { invoice: OpenReceivable; applied: number }[], tolerance: number): ProposalRow[] {
  return allocation.map(({ invoice, applied }) => ({
    invoiceId: invoice.invoiceId,
    invoiceNumber: invoice.invoiceNumber,
    openAmount: invoice.openAmount,
    appliedAmount: applied,
    outcome: applyPaymentTolerance(invoice.openAmount, applied, tolerance),
  }));
}

function blankProposal(entryId: string): IncomingProposal {
  return { entryId, state: "unmatched", basis: null, reason: null, partial: false, customerId: null, customerName: null, rows: [], alternatives: [] };
}

export function matchIncomingEntry(entry: IncomingEntryInput, lookup: MatchingLookup, tolerance: number): IncomingProposal {
  const proposal = blankProposal(entry.id);
  const ocrs = candidateOcrs(entry.remittance);

  if (ocrs.length > 0) {
    const resolved = ocrs.map((ocr) => lookup.openByOcr.get(ocr)).filter((r): r is OpenReceivable => r !== undefined);
    const missing = ocrs.filter((ocr) => !lookup.openByOcr.has(ocr));
    const customers = new Set(resolved.map((r) => r.customerId));
    if (missing.length > 0) {
      // A possible double payment outranks an unknown reference. Either way
      // rule 4 still runs (spec §5.1 rule 3) and the reason stays visible.
      const ocr = missing.find((candidate) => lookup.closedByOcr.has(candidate)) ?? missing[0]!;
      const closed = lookup.closedByOcr.get(ocr);
      proposal.reason = closed
        ? `OCR ${ocr} tillhör ${closed.invoiceNumber} som redan är ${closed.status === "paid" ? "betald" : "makulerad"} — möjlig dubbelbetalning`
        : `OCR ${ocr} hittades inte bland öppna poster`;
    } else if (customers.size > 1) {
      // Not an OCR match, but rule 4 still runs (spec §5.1): amount + name
      // may well point at one of the customers. The reason stays visible.
      proposal.reason = "OCR-referenserna tillhör olika kunder";
    } else {
      const own = new Map<string, number>();
      for (const ref of entry.remittance) {
        const match = lookup.openByOcr.get(ref.value.replace(/\s/g, ""));
        if (match && ref.amount !== null) own.set(match.invoiceId, ref.type === "CREN" ? -ref.amount : ref.amount);
      }
      const exact =
        resolved.length === 1 ||
        (resolved.every((r) => own.has(r.invoiceId)) && round2([...own.values()].reduce((s, a) => s + a, 0)) === round2(entry.amount));
      const allocation =
        resolved.length === 1
          ? [{ invoice: resolved[0]!, applied: entry.amount }]
          : exact
            ? resolved.map((invoice) => ({ invoice, applied: own.get(invoice.invoiceId)! }))
            : allocate(entry.amount, resolved);
      if (!allocation) return { ...proposal, reason: "Fördelningen går inte ihop — välj fakturor manuellt" };
      const rows = rowsOf(allocation, tolerance);
      const customer = resolved[0]!;
      const failed = rows.find((row) => !row.outcome.ok);
      if (failed && !failed.outcome.ok) {
        proposal.reason =
          failed.outcome.reason === "exceeds_open"
            ? `Överbetalning ${kr(round2(failed.appliedAmount - failed.openAmount))} kr på ${failed.invoiceNumber} — registrera manuellt under Betalningar`
            : "Fördelningen går inte ihop — välj fakturor manuellt";
        return proposal;
      }
      return {
        ...proposal,
        state: exact ? "matched" : "suggested",
        basis: "ocr",
        reason: exact ? null : "Fördelningen behöver granskas",
        partial: rows.some((row) => row.outcome.ok && row.outcome.kind === "partial"),
        customerId: customer.customerId,
        customerName: customer.customerName,
        rows,
      };
    }
  }

  // Rule 4: suggestions on amount and name.
  const byAmount = lookup.candidatesByAmount
    .filter((r) => r.openAmount > 0 && Math.abs(r.openAmount - entry.amount) <= tolerance)
    .sort(byDue);
  const named = entry.counterpartyName ? byAmount.filter((r) => namesMatch(entry.counterpartyName!, r.customerName)) : [];
  const suggest = (basis: MatchBasis, invoices: { invoice: OpenReceivable; applied: number }[], alternatives: OpenReceivable[]): IncomingProposal => ({
    ...proposal,
    state: "suggested",
    basis,
    customerId: invoices[0]!.invoice.customerId,
    customerName: invoices[0]!.invoice.customerName,
    rows: rowsOf(invoices, tolerance),
    alternatives: alternatives.slice(0, 5),
  });
  if (named.length > 0) {
    return suggest("amount_name", [{ invoice: named[0]!, applied: entry.amount }], byAmount.filter((r) => r !== named[0]));
  }
  if (byAmount.length === 1) return suggest("amount_only", [{ invoice: byAmount[0]!, applied: entry.amount }], []);
  const namedCustomers = entry.counterpartyName ? lookup.customers.filter((c) => namesMatch(entry.counterpartyName!, c.name)) : [];
  if (namedCustomers.length === 1) {
    const open = (lookup.openByCustomer.get(namedCustomers[0]!.id) ?? []).filter((r) => r.openAmount !== 0);
    const total = round2(open.reduce((sum, r) => sum + r.openAmount, 0));
    const allocation = open.length > 0 && entry.amount <= total ? allocate(entry.amount, open.filter((r) => r.openAmount > 0)) : null;
    if (allocation) return suggest("name_allocation", allocation, []);
  }
  return { ...proposal, reason: proposal.reason ?? "Ingen faktura matchar referens, belopp eller namn", alternatives: byAmount.slice(0, 5) };
}

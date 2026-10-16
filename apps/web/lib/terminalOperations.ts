import type { TerminalOperation } from "./types";

// Pure sort / filter / search / label helpers for the stamp terminal's
// operation list (stämpelterminalens operationslista).

export type TerminalSort = "urgent" | "material";

const collator = new Intl.Collator("sv-SE", { numeric: true });

function byUrgency(a: TerminalOperation, b: TerminalOperation): number {
  // Due date ascending, undated last; ties by TO number, then sequence no.
  // Readiness is deliberately not considered.
  if (a.dueDate !== b.dueDate) {
    if (a.dueDate === null) return 1;
    if (b.dueDate === null) return -1;
    return a.dueDate < b.dueDate ? -1 : 1;
  }
  return collator.compare(a.orderNumber, b.orderNumber) || a.sequenceNo - b.sequenceNo;
}

function firstMaterialNumber(row: TerminalOperation): string | null {
  let first: string | null = null;
  for (const m of row.materials) {
    if (first === null || collator.compare(m.articleNumber, first) < 0) first = m.articleNumber;
  }
  return first;
}

export function sortTerminalOperations(rows: TerminalOperation[], sort: TerminalSort): TerminalOperation[] {
  const copy = [...rows];
  if (sort === "urgent") return copy.sort(byUrgency);
  return copy.sort((a, b) => {
    const ma = firstMaterialNumber(a);
    const mb = firstMaterialNumber(b);
    if (ma !== mb) {
      if (ma === null) return 1;
      if (mb === null) return -1;
      return collator.compare(ma, mb);
    }
    return byUrgency(a, b);
  });
}

// "Bara redo" hides not_ready only — partial rows stay.
// Search: every whitespace-separated term must match somewhere on the row.
export function filterTerminalOperations(
  rows: TerminalOperation[],
  opts: { onlyReady: boolean; search: string }
): TerminalOperation[] {
  const terms = opts.search.toLocaleLowerCase("sv-SE").split(/\s+/).filter(Boolean);
  return rows.filter((row) => {
    if (opts.onlyReady && row.readiness === "not_ready") return false;
    if (terms.length === 0) return true;
    const haystack = [
      row.orderNumber,
      row.articleNumber,
      row.articleName,
      row.workCenterCode,
      row.workCenterName,
      row.description,
      ...row.materials.flatMap((m) => [m.articleNumber, m.articleName]),
    ]
      .filter((part): part is string => Boolean(part))
      .join(" ")
      .toLocaleLowerCase("sv-SE");
    return terms.every((term) => haystack.includes(term));
  });
}

// sv-SE with at most 4 decimals — hides float noise from the API.
function formatNumber(value: number): string {
  return value.toLocaleString("sv-SE", { maximumFractionDigits: 4 });
}

export function readinessLabel(row: TerminalOperation): string {
  if (row.readiness === "ready") return "Redo";
  if (row.readiness === "not_ready") return "Inte redo";
  const remaining = Math.max(Number(row.orderQuantity) - Number(row.quantityCompleted ?? 0), 0);
  return `${formatNumber(Number(row.available))} av ${formatNumber(remaining)} redo`;
}

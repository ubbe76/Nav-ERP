import type { TerminalOperation } from "./types";

// Pure sort / filter / search / label helpers for the stamp terminal's
// operation list (stämpelterminalens operationslista).

export type TerminalSort = "planned" | "urgent" | "material";

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

// Produktionsplanering: the planner's order — planned start week ascending
// (Mondays, so a string compare is a date compare), unplanned last, then as
// urgent.
function byPlannedWeek(a: TerminalOperation, b: TerminalOperation): number {
  if (a.plannedStartWeek !== b.plannedStartWeek) {
    if (a.plannedStartWeek === null) return 1;
    if (b.plannedStartWeek === null) return -1;
    return a.plannedStartWeek < b.plannedStartWeek ? -1 : 1;
  }
  return byUrgency(a, b);
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
  if (sort === "planned") return copy.sort(byPlannedWeek);
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

// "Starta valda" acts on the rows the list shows. A row checked and then
// hidden by Sök/Bara redo stays checked (it comes back with the filter) but is
// not started; the count tells the operator how many are hidden.
export function splitSelection(
  visible: TerminalOperation[],
  selected: Set<string>
): { start: TerminalOperation[]; hiddenCount: number } {
  const start = visible.filter((row) => selected.has(row.operationId));
  return { start, hiddenCount: Math.max(selected.size - start.length, 0) };
}

// Glömd utstämpling: "Gå hem nu" (stop the attendance open since an earlier
// day right now) only makes sense for a shift that ran past midnight — the
// attendance started on the Stockholm day before today. Older than that, the
// operator must give the time they went home.
export function forgottenStopNowAllowed(startedAt: string, now: number): boolean {
  const day = (ms: number) => new Date(ms).toLocaleDateString("sv-SE", { timeZone: "Europe/Stockholm" });
  const started = Date.parse(startedAt);
  if (Number.isNaN(started)) return false;
  return day(started) === day(now - 24 * 60 * 60 * 1000);
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

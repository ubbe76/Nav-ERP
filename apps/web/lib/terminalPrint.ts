// Skriv ut arbetsorder och ritning vid instämpling (System → Inställningar):
// when the stamp terminal prints the work order — the TO printout with the
// drawings as extra pages, the same document as Skriv ut TO on the TO card —
// by itself after a stamp-in. The values mirror terminalPrintWorkOrderSchema
// in packages/shared/src/system.ts (the web cannot import @navet/shared);
// web-terminal-print.test.ts keeps them equal.
export const TERMINAL_PRINT_WORK_ORDER_MODES = ["manual", "first_operation", "every_operation"] as const;
export type TerminalPrintWorkOrder = (typeof TERMINAL_PRINT_WORK_ORDER_MODES)[number];

export const TERMINAL_PRINT_WORK_ORDER_LABELS: Record<TerminalPrintWorkOrder, string> = {
  first_operation: "Första operationen",
  every_operation: "Alla operationer",
  manual: "Manuellt",
};

// Anything else (an older API without the field) is Manuellt — the terminal
// as it was before the setting existed.
export function terminalPrintWorkOrderOf(raw: unknown): TerminalPrintWorkOrder {
  return raw === "first_operation" || raw === "every_operation" ? raw : "manual";
}

// What POST /stamp-sessions answers about the stamp it just made: the
// order's / the operation's first stamp-in (read in the insert's transaction).
export interface StampInFacts {
  firstStampOnOrder?: boolean;
  firstStampOnOperation?: boolean;
}

// Första operationen = the first time anyone stamps in on the order (usually
// its first operation — also when that one was reported some other way);
// Alla operationer = the first stamp-in on each operation. A second stamp on
// the same operation (another day, Ställ klart, a colleague) never prints.
export function printsAtStampIn(mode: TerminalPrintWorkOrder, facts: StampInFacts | null | undefined): boolean {
  if (mode === "first_operation") return facts?.firstStampOnOrder === true;
  if (mode === "every_operation") return facts?.firstStampOnOperation === true;
  return false;
}

// One print per Starta valda: each order once, in the order it was started,
// several orders as one PDF (one print dialog).
export function workOrderPrintHref(orderIds: readonly string[]): string | null {
  const unique = [...new Set(orderIds)];
  if (unique.length === 0) return null;
  if (unique.length === 1) return `/api/v1/manufacturing-orders/${unique[0]}/pdf`;
  return `/api/v1/manufacturing-orders/pdf?ids=${unique.join(",")}`;
}

import { round4 } from "./format";
import { formatDuration } from "./duration";
import { operationProgress } from "./stampSessions";
import type { TerminalOperation } from "./types";

// Rapportera (Tillverkning → Rapportera, 2026-11-24, the user: "en egen rutin
// som är lätt att använda för att manuellt rapportera tillverkningsorder").
// The pure rules of the page: one operation at a time, time and quantities
// together (POST /operation-reports), found in the list of open operations by
// search or scan. The list is the terminal's (GET /terminal/operations).

// Planned / OK / scrapped / remaining of a listed operation.
export function rowProgress(row: TerminalOperation) {
  return operationProgress(row.orderQuantity, row.quantityCompleted, row.quantityScrapped);
}

// Operationen är klar starts ticked when this report's OK brings the
// operation's OK up to the order quantity — the TO card's rule for when an
// operation is done. Ticking it with less is the explicit choice (the rest is
// not made); unticking it with enough keeps the operation open.
export function suggestsDone(row: TerminalOperation, quantityOk: string): boolean {
  const ok = Number(quantityOk);
  if (!Number.isFinite(ok) || ok <= 0) return false;
  const p = rowProgress(row);
  return round4(p.ok + ok) >= p.planned;
}

// Enter in the search field (a scanner ends with Enter): the one operation the
// search leaves, to open straight away — none when it leaves several or none.
export function singleMatch(rows: TerminalOperation[]): TerminalOperation | null {
  return rows.length === 1 ? rows[0]! : null;
}

function quantityText(value: number): string {
  return round4(value).toLocaleString("sv-SE", { maximumFractionDigits: 4 });
}

// What the dialog sent, for the notice.
export interface ReportSummary {
  employeeName: string;
  minutes: number;
  quantityOk: number;
  quantityScrapped: number;
  markedDone: boolean;
}

// The notice after a report: what was reported, and what it did beyond that
// (goods received from the last operation, their serial numbers, the order
// or operation done).
export function reportNotice(
  input: ReportSummary & {
    orderNumber: string;
    sequenceNo: number;
    received: number;
    orderCompleted: boolean;
    receivedSerialNumbers?: string[];
  }
): string {
  const parts = [`${formatDuration(input.minutes)} för ${input.employeeName}`];
  if (input.quantityOk > 0) parts.push(`${quantityText(input.quantityOk)} st OK`);
  if (input.quantityScrapped > 0) parts.push(`${quantityText(input.quantityScrapped)} st kasserat`);
  let text = `Rapporterat på ${input.orderNumber} op ${input.sequenceNo}: ${parts.join(", ")}.`;
  if (input.received > 0) text += ` ${quantityText(input.received)} st levererades in i lager.`;
  if (input.receivedSerialNumbers && input.receivedSerialNumbers.length > 0) {
    text += ` Serienummer: ${input.receivedSerialNumbers.join(", ")}.`;
  }
  if (input.orderCompleted) text += " Ordern är klar.";
  else if (input.markedDone) text += " Operationen är klar.";
  return text;
}

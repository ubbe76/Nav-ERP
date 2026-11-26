// Leveransläge on the kundorder card — the pure texts and tones
// (web-delivery-outlook.test.ts). The rules are the API's
// (planning/service/delivery-outlook.ts): nothing is decided here.
import type { OrderOutlook, OutlookAllocation, OutlookRow } from "./types";

// The StatusPill's colours: grey for on time, red for Sen / Saknar täckning,
// yellow for Tillgång utan datum (a question for inköp, not a delay).
export type OutlookTone = "draft" | "stopped" | "delayed";

// The order statuses whose rows are a demand — the only ones with an outlook.
export const OUTLOOK_ORDER_STATUSES: readonly string[] = ["confirmed", "in_production"];

export const OUTLOOK_DERIVED_NOTE = "Kopplingen är härledd och kan ändras när ett tidigare behov kommer in";
export const OUTLOOK_ERROR = "Leveransläget kunde inte räknas";
export const COMPONENT_LATE_LABEL = "Halvfabrikat sent";

const MONTHS = ["jan", "feb", "mar", "apr", "maj", "jun", "jul", "aug", "sep", "okt", "nov", "dec"];

// "8 dec" — with the year when it is another one than today's. Read from the
// ISO text, never through a Date (no time zone involved).
export function outlookDate(date: string, today: string): string {
  const [year, month, day] = date.split("-");
  const text = `${Number(day)} ${MONTHS[Number(month) - 1] ?? month}`;
  return year === today.slice(0, 4) ? text : `${text} ${year}`;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function outlookLabel(row: Pick<OutlookRow, "status" | "daysLate">): string {
  switch (row.status) {
    case "uncovered":
      return "Saknar täckning";
    case "late":
      // Ready on a weekend after a Friday need: late, but no working day.
      return row.daysLate > 0 ? `Sen ${plural(row.daysLate, "dag", "dagar")}` : "Sen";
    case "undated":
      return "Tillgång utan datum";
    default:
      return "I tid";
  }
}

export function outlookTone(row: Pick<OutlookRow, "status">): OutlookTone {
  return row.status === "uncovered" || row.status === "late" ? "stopped" : row.status === "undated" ? "delayed" : "draft";
}

// The order's line under the status row; null when the order has no outlook.
export function headLine(outlook: OrderOutlook, today: string): { text: string; tone: OutlookTone } | null {
  const promised = outlook.promisedDate ? `lovat ${outlookDate(outlook.promisedDate, today)}` : null;
  switch (outlook.status) {
    case "none":
      return null;
    case "uncovered":
      return { text: `Saknar täckning på ${plural(outlook.counts.uncovered, "rad", "rader")}`, tone: "stopped" };
    case "late": {
      const days = outlook.daysLate > 0 ? `${plural(outlook.daysLate, "arbetsdag", "arbetsdagar")} sen` : "sen";
      if (outlook.estimatedDeliveryDate === null) {
        return { text: `Leveransen är ${days}${promised ? ` (${promised})` : ""}`, tone: "stopped" };
      }
      return {
        text: `Beräknad leverans ${outlookDate(outlook.estimatedDeliveryDate, today)}${promised ? ` (${promised})` : ""} · ${days}`,
        tone: "stopped",
      };
    }
    case "undated":
      return { text: "Kan inte beräknas — tillgång utan datum", tone: "delayed" };
    default:
      return { text: `Leverans i tid${promised ? ` (${promised})` : ""}`, tone: "draft" };
  }
}

export function allocationHref(a: Pick<OutlookAllocation, "kind" | "documentId">): string | null {
  if (a.documentId === null || a.kind === "stock") return null;
  return a.kind === "purchase_order" ? `/inkop/ordrar/${a.documentId}` : `/tillverkning/ordrar/${a.documentId}`;
}

// One line of the row's list: the source (Lager or the document number — the
// component links it) and the rest as text. `quantity` is already in the
// row's unit ("6 st").
export function allocationText(a: OutlookAllocation, quantity: string, today: string): { label: string; detail: string; late: string | null } {
  if (a.kind === "stock") return { label: "Lager", detail: quantity, late: null };
  const date =
    a.undated || a.readyDate === null
      ? "saknar datum"
      : `${a.kind === "manufacturing_order" ? "klar " : ""}${outlookDate(a.readyDate, today)}`;
  const marks = `${a.isDraft ? " (utkast)" : ""}${a.componentLate ? ` · ${COMPONENT_LATE_LABEL.toLowerCase()}` : ""}`;
  return {
    label: a.documentNumber ?? "–",
    detail: `${quantity} · ${date}${marks}`,
    late: a.late ? (a.daysLate > 0 ? `${plural(a.daysLate, "dag", "dagar")} för sent` : "för sent") : null,
  };
}

export function uncoveredText(quantity: string): string {
  return `Saknas ${quantity}`;
}

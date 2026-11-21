// The lists' status filters, ONE definition per list that both the narrow
// list beside the card (splitLists.tsx, chips) and the table (Visa som
// tabell, ListMultiFilter) draw — a status, a group or Sen added here shows
// in both. Labels are the status pills' own words, as the rows show them.
import {
  ARTICLE_TYPE_LABELS,
  INQUIRY_STATUS_PILL,
  INVOICE_STATUS_PILL,
  MANUFACTURING_ORDER_STATUS_PILL,
  PURCHASE_ORDER_STATUS_PILL,
  SALES_ORDER_REGISTER_STATUSES,
  SALES_ORDER_STATUS_PILL,
  SUPPLIER_INVOICE_STATUS_PILL,
  type SalesOrderStatus,
} from "./types";
import type { FilterChoice, MultiFilter } from "./listFilter";

function pills(pill: Record<string, { label: string }>, values?: readonly string[]): FilterChoice[] {
  return (values ?? Object.keys(pill)).map((value) => ({ value, label: pill[value]!.label }));
}

// Sen (late) is derived when the list is read, never stored; the API takes
// it in the same param and applies it together with the chosen statuses.
const LATE: FilterChoice = { value: "late", label: "Sen" };

// The orders' finished statuses, hidden until Visa avslutade is ticked (the
// user, 2026-11-21): everything received or delivered counts — an IO is
// closed by its last receipt (Mottagen only on older ones), a TO is Klar
// (efterrapportering stays possible until Stäng order), a KO Levererad
// (Fakturera and Samlingsfakturering find it as before).
const FINISHED_LABEL = "Visa avslutade";

const QUOTE_STATUSES: readonly SalesOrderStatus[] = ["quote", "ordered", "lost", "cancelled"];

export const SALES_ORDER_FILTER: MultiFilter = {
  param: "status",
  options: pills(SALES_ORDER_STATUS_PILL, SALES_ORDER_REGISTER_STATUSES),
  groups: [{ label: "Öppna", values: ["confirmed", "in_production"] }],
  narrow: [LATE],
  finished: { values: ["delivered", "invoiced", "cancelled"], label: FINISHED_LABEL },
};

// Never Sen on quotes.
export const QUOTE_FILTER: MultiFilter = {
  param: "status",
  options: pills(SALES_ORDER_STATUS_PILL, QUOTE_STATUSES),
};

export const PURCHASE_ORDER_FILTER: MultiFilter = {
  param: "status",
  options: pills(PURCHASE_ORDER_STATUS_PILL),
  groups: [{ label: "Öppna", values: ["draft", "confirmed", "partially_received"] }],
  narrow: [LATE],
  finished: { values: ["received", "closed", "cancelled"], label: FINISHED_LABEL },
};

export const INQUIRY_FILTER: MultiFilter = {
  param: "status",
  options: pills(INQUIRY_STATUS_PILL),
  groups: [{ label: "Öppna", values: ["draft", "sent", "answered"] }],
};

export const MANUFACTURING_ORDER_FILTER: MultiFilter = {
  param: "status",
  options: pills(MANUFACTURING_ORDER_STATUS_PILL),
  groups: [{ label: "Öppna", values: ["planned", "released", "in_progress"] }],
  // Halvfabrikat sent (pegging #9): derived like Sen.
  narrow: [LATE, { value: "component_late", label: "Halvfabrikat sent" }],
  finished: { values: ["done", "closed", "cancelled"], label: FINISHED_LABEL },
};

export const INVOICE_FILTER: MultiFilter = {
  param: "status",
  options: pills(INVOICE_STATUS_PILL),
};

export const SUPPLIER_INVOICE_FILTER: MultiFilter = {
  param: "status",
  options: pills(SUPPLIER_INVOICE_STATUS_PILL),
};

export const ARTICLE_TYPE_FILTER: MultiFilter = {
  param: "type",
  options: Object.entries(ARTICLE_TYPE_LABELS).map(([value, label]) => ({ value, label })),
};

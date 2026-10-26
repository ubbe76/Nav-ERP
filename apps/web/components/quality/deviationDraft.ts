import type { ArticlePickerValue } from "../ui/ArticlePicker";
import { stockholmToday } from "../../lib/date";
import type { Deviation, DeviationDecision, DeviationType } from "../../lib/quality";

// The editable part of an avvikelse: the same fields on Ny avvikelse and on
// the card. All values are strings/refs (form state); draftPayload turns them
// into the POST/PATCH body.

// A picked record shown in a closed picker: only its id and the text.
export interface Ref {
  id: string;
  label: string;
}

export interface DeviationDraft {
  type: DeviationType;
  title: string;
  description: string;
  reportedDate: string;
  reasonId: string;
  responsibleUserId: string;
  dueDate: string;
  customer: Ref | null;
  supplier: Ref | null;
  counterpartyReference: string;
  salesOrder: Ref | null;
  salesOrderRowId: string;
  invoice: Ref | null;
  purchaseOrder: Ref | null;
  purchaseOrderRowId: string;
  manufacturingOrder: Ref | null;
  moOperationId: string;
  article: ArticlePickerValue | null;
  // The article's base unit code, for the Antal label (empty when unknown).
  articleUnit: string;
  quantity: string;
  causeAnalysis: string;
  correctiveAction: string;
  preventiveAction: string;
  decision: "" | DeviationDecision;
}

export function emptyDraft(type: DeviationType): DeviationDraft {
  return {
    type,
    title: "",
    description: "",
    reportedDate: stockholmToday(),
    reasonId: "",
    responsibleUserId: "",
    dueDate: "",
    customer: null,
    supplier: null,
    counterpartyReference: "",
    salesOrder: null,
    salesOrderRowId: "",
    invoice: null,
    purchaseOrder: null,
    purchaseOrderRowId: "",
    manufacturingOrder: null,
    moOperationId: "",
    article: null,
    articleUnit: "",
    quantity: "",
    causeAnalysis: "",
    correctiveAction: "",
    preventiveAction: "",
    decision: "",
  };
}

export function draftFromDeviation(d: Deviation): DeviationDraft {
  return {
    type: d.type,
    title: d.title,
    description: d.description ?? "",
    reportedDate: d.reportedDate,
    reasonId: d.reasonId ?? "",
    responsibleUserId: d.responsibleUserId ?? "",
    dueDate: d.dueDate ?? "",
    customer: d.customerId ? { id: d.customerId, label: `${d.customerNumber ?? ""} — ${d.customerName ?? ""}`.replace(/^ — /, "") } : null,
    supplier: d.supplierId ? { id: d.supplierId, label: `${d.supplierNumber ?? ""} — ${d.supplierName ?? ""}`.replace(/^ — /, "") } : null,
    counterpartyReference: d.counterpartyReference ?? "",
    salesOrder: d.salesOrderId ? { id: d.salesOrderId, label: d.salesOrderNumber ?? "Kundorder" } : null,
    salesOrderRowId: d.salesOrderRowId ?? "",
    invoice: d.invoiceId ? { id: d.invoiceId, label: d.invoiceNumber ?? "Utkast" } : null,
    purchaseOrder: d.purchaseOrderId ? { id: d.purchaseOrderId, label: d.purchaseOrderNumber ?? "Inköpsorder" } : null,
    purchaseOrderRowId: d.purchaseOrderRowId ?? "",
    manufacturingOrder: d.manufacturingOrderId
      ? { id: d.manufacturingOrderId, label: d.manufacturingOrderNumber ?? "Tillverkningsorder" }
      : null,
    moOperationId: d.moOperationId ?? "",
    article: d.articleId ? { id: d.articleId, articleNumber: d.articleNumber ?? "", name: d.articleName ?? "" } : null,
    articleUnit: d.unitCode ?? "",
    quantity: d.quantity === null ? "" : String(d.quantity),
    causeAnalysis: d.causeAnalysis ?? "",
    correctiveAction: d.correctiveAction ?? "",
    preventiveAction: d.preventiveAction ?? "",
    decision: d.decision ?? "",
  };
}

// POST body (mode "create": empty fields are left out) or PATCH body (mode
// "edit": emptied fields are sent as null, which clears them). Fields that do
// not belong to the case type are never sent.
export function draftPayload(draft: DeviationDraft, mode: "create" | "edit"): Record<string, unknown> {
  const edit = mode === "edit";
  const empty = edit ? null : undefined;
  const text = (value: string) => (value.trim() === "" ? empty : value.trim());
  const id = (value: string) => (value === "" ? empty : value);
  const body: Record<string, unknown> = {
    ...(edit ? {} : { type: draft.type }),
    title: draft.title.trim(),
    description: text(draft.description),
    reportedDate: draft.reportedDate || undefined,
    reasonId: id(draft.reasonId),
    responsibleUserId: id(draft.responsibleUserId),
    dueDate: draft.dueDate === "" ? empty : draft.dueDate,
    counterpartyReference: text(draft.counterpartyReference),
    manufacturingOrderId: draft.manufacturingOrder?.id ?? empty,
    moOperationId: id(draft.moOperationId),
    articleId: draft.article?.id ?? empty,
    quantity: draft.quantity.trim() === "" ? empty : Number(draft.quantity),
    causeAnalysis: text(draft.causeAnalysis),
    correctiveAction: text(draft.correctiveAction),
    preventiveAction: text(draft.preventiveAction),
  };
  if (draft.type === "customer") {
    body.customerId = draft.customer?.id ?? empty;
    body.salesOrderId = draft.salesOrder?.id ?? empty;
    body.salesOrderRowId = id(draft.salesOrderRowId);
    body.invoiceId = draft.invoice?.id ?? empty;
  }
  if (draft.type === "supplier") {
    body.supplierId = draft.supplier?.id ?? empty;
    body.purchaseOrderId = draft.purchaseOrder?.id ?? empty;
    body.purchaseOrderRowId = id(draft.purchaseOrderRowId);
  }
  if (edit && draft.type !== "internal") body.decision = draft.decision === "" ? null : draft.decision;
  return body;
}

// Client-side checks that save a round trip; the API validates again.
export function draftProblem(draft: DeviationDraft): string | null {
  if (draft.title.trim() === "") return "Ange en rubrik.";
  if (draft.type === "customer" && !draft.customer) return "Välj kund.";
  if (draft.type === "supplier" && !draft.supplier) return "Välj leverantör.";
  if (draft.quantity.trim() !== "" && !(Number(draft.quantity) > 0)) return "Antalet måste vara större än 0.";
  return null;
}


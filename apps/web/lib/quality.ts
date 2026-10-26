// Mirror of packages/shared/src/quality.ts and the /deviations response
// shapes (the web cannot import @navet/shared — see apps/web/lib/units.ts).
// Reklamationer och avvikelser (Kvalitet, migration 0153). NO imports other
// than types: the list/card/forms all read their labels from here.

import { apiGet, type SessionUser } from "./api";
import {
  INVOICE_STATUS_PILL,
  MANUFACTURING_ORDER_STATUS_PILL,
  PURCHASE_ORDER_STATUS_PILL,
  SALES_ORDER_STATUS_PILL,
  SUPPLIER_INVOICE_STATUS_PILL,
  type AdminUser,
} from "./types";
import type { Status } from "../components/ui/StatusPill";

export const DEVIATION_TYPES = ["customer", "supplier", "internal"] as const;
export type DeviationType = (typeof DEVIATION_TYPES)[number];
export const DEVIATION_TYPE_LABELS: Record<DeviationType, string> = {
  customer: "Kundreklamation",
  supplier: "Leverantörsavvikelse",
  internal: "Intern avvikelse",
};
// The button on a customer/invoice/order is "Ny reklamation"; elsewhere "Ny avvikelse".
export const DEVIATION_TYPE_SHORT_LABELS: Record<DeviationType, string> = {
  customer: "Kund",
  supplier: "Leverantör",
  internal: "Intern",
};

export const DEVIATION_STATUSES = ["registered", "investigating", "closed", "cancelled"] as const;
export type DeviationStatus = (typeof DEVIATION_STATUSES)[number];
export const DEVIATION_STATUS_LABELS: Record<DeviationStatus, string> = {
  registered: "Registrerad",
  investigating: "Utreds",
  closed: "Avslutad",
  cancelled: "Makulerad",
};
export const DEVIATION_STATUS_PILL: Record<DeviationStatus, { status: Status; label: string }> = {
  registered: { status: "draft", label: DEVIATION_STATUS_LABELS.registered },
  investigating: { status: "running", label: DEVIATION_STATUS_LABELS.investigating },
  closed: { status: "done", label: DEVIATION_STATUS_LABELS.closed },
  cancelled: { status: "stopped", label: DEVIATION_STATUS_LABELS.cancelled },
};

export const DEVIATION_DECISIONS = ["accepted", "rejected"] as const;
export type DeviationDecision = (typeof DEVIATION_DECISIONS)[number];
export const DEVIATION_DECISION_LABELS: Record<DeviationDecision, string> = {
  accepted: "Godkänd",
  rejected: "Avslagen",
};

export const DEVIATION_COST_KINDS = ["material", "labour", "freight", "credit", "other", "recovery"] as const;
export type DeviationCostKind = (typeof DEVIATION_COST_KINDS)[number];
export const DEVIATION_COST_KIND_LABELS: Record<DeviationCostKind, string> = {
  material: "Material",
  labour: "Arbete",
  freight: "Frakt",
  credit: "Kreditering",
  other: "Övrigt",
  recovery: "Ersättning",
};

export const DEVIATION_LINK_DOCUMENT_TYPES = [
  "credit_invoice",
  "sales_order",
  "purchase_order",
  "manufacturing_order",
  "supplier_invoice",
] as const;
export type DeviationLinkDocumentType = (typeof DEVIATION_LINK_DOCUMENT_TYPES)[number];
export const DEVIATION_LINK_DOCUMENT_LABELS: Record<DeviationLinkDocumentType, string> = {
  credit_invoice: "Kreditfaktura",
  sales_order: "Kundorder",
  purchase_order: "Inköpsorder",
  manufacturing_order: "Tillverkningsorder",
  supplier_invoice: "Leverantörsfaktura",
};
// Which follow-up documents fit which case type (mirrors LINK_DOCUMENT_CASE_TYPES in the API).
export const DEVIATION_LINK_DOCUMENT_TYPES_BY_CASE: Record<DeviationType, readonly DeviationLinkDocumentType[]> = {
  customer: ["credit_invoice", "sales_order", "manufacturing_order"],
  supplier: ["purchase_order", "supplier_invoice"],
  internal: ["manufacturing_order"],
};

// Where a linked document's card lives.
export function linkedDocumentHref(documentType: DeviationLinkDocumentType, documentId: string): string {
  switch (documentType) {
    case "credit_invoice":
      return `/forsaljning/fakturor/${documentId}`;
    case "sales_order":
      return `/forsaljning/ordrar/${documentId}`;
    case "purchase_order":
      return `/inkop/ordrar/${documentId}`;
    case "manufacturing_order":
      return `/tillverkning/ordrar/${documentId}`;
    case "supplier_invoice":
      return `/inkop/leverantorsfakturor/${documentId}`;
  }
}

// The linked document's status as its own card words it (the API sends the raw enum).
export function linkedDocumentStatusLabel(documentType: DeviationLinkDocumentType, status: string | null): string {
  if (!status) return "–";
  const maps: Record<DeviationLinkDocumentType, Record<string, { label: string }>> = {
    credit_invoice: INVOICE_STATUS_PILL,
    sales_order: SALES_ORDER_STATUS_PILL,
    purchase_order: PURCHASE_ORDER_STATUS_PILL,
    manufacturing_order: MANUFACTURING_ORDER_STATUS_PILL,
    supplier_invoice: SUPPLIER_INVOICE_STATUS_PILL,
  };
  return maps[documentType][status]?.label ?? status;
}

export type DeviationAction = "start" | "close" | "cancel" | "reopen";
export const DEVIATION_ACTION_LABELS: Record<DeviationAction, string> = {
  start: "Börja utreda",
  close: "Avsluta",
  cancel: "Makulera",
  reopen: "Öppna igen",
};

export const deviationHref = (id: string) => `/kvalitet/avvikelser/${id}`;

// "Ny reklamation" on the documents that belong to a customer, "Ny avvikelse" elsewhere.
export const NEW_DEVIATION_LABEL: Record<DeviationType, string> = {
  customer: "Ny reklamation",
  supplier: "Ny avvikelse",
  internal: "Ny avvikelse",
};

// The query parameters /kvalitet/avvikelser/ny prefills from.
export interface NewDeviationParams {
  type: DeviationType;
  customerId?: string;
  salesOrderId?: string;
  salesOrderRowId?: string;
  invoiceId?: string;
  supplierId?: string;
  purchaseOrderId?: string;
  purchaseOrderRowId?: string;
  manufacturingOrderId?: string;
  moOperationId?: string;
  articleId?: string;
  quantity?: number | string;
  reasonId?: string;
  title?: string;
}

export function newDeviationHref(params: NewDeviationParams): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") qs.set(key, String(value));
  }
  return `/kvalitet/avvikelser/ny?${qs.toString()}`;
}

// --- GET /deviations (list) ---

export interface DeviationListRow {
  id: string;
  deviationNumber: string;
  type: DeviationType;
  status: DeviationStatus;
  title: string;
  reportedDate: string;
  dueDate: string | null;
  customerId: string | null;
  customerName: string | null;
  supplierId: string | null;
  supplierName: string | null;
  counterpartyName: string | null;
  counterpartyReference: string | null;
  articleId: string | null;
  articleNumber: string | null;
  articleName: string | null;
  unitCode: string | null;
  quantity: number | null;
  reasonId: string | null;
  reasonCode: string | null;
  reasonName: string | null;
  responsibleUserId: string | null;
  responsibleUserName: string | null;
  salesOrderId: string | null;
  salesOrderNumber: string | null;
  invoiceId: string | null;
  invoiceNumber: string | null;
  purchaseOrderId: string | null;
  purchaseOrderNumber: string | null;
  manufacturingOrderId: string | null;
  manufacturingOrderNumber: string | null;
  createdAt: string;
  overdue: boolean;
  // null without canSeePrices.
  netCost: number | null;
}

// --- GET /deviations/:id (card) ---

export interface DeviationCostRow {
  id: string;
  kind: DeviationCostKind;
  kindLabel: string;
  description: string | null;
  amount: number;
  createdByName: string | null;
  createdAt: string;
}

export interface DeviationDerivedCost {
  kind: DeviationCostKind;
  kindLabel: string;
  amount: number;
  linkId: string;
  documentType: DeviationLinkDocumentType;
  documentId: string;
  documentNumber: string | null;
  label: string;
}

export interface DeviationCosts {
  rows: DeviationCostRow[];
  derived: DeviationDerivedCost[];
  totalCosts: number;
  totalRecovery: number;
  netCost: number;
}

export interface DeviationLink {
  id: string;
  documentType: DeviationLinkDocumentType;
  documentId: string;
  documentNumber: string | null;
  documentStatus: string | null;
  deleted: boolean;
  createdAt: string;
  createdByName: string | null;
}

export interface DeviationFile {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  uploadedBy?: string | null;
  createdAt: string;
}

export type DeviationEventKind =
  | "created"
  | "status_changed"
  | "updated"
  | "cost_added"
  | "cost_removed"
  | "link_added"
  | "link_removed"
  | "file_added"
  | "file_removed"
  | "email_sent";

export interface DeviationEvent {
  id: string;
  event: DeviationEventKind;
  detail: Record<string, unknown> | null;
  userName: string | null;
  createdAt: string;
}

export interface Deviation extends DeviationListRow {
  description: string | null;
  salesOrderRowId: string | null;
  purchaseOrderRowId: string | null;
  moOperationId: string | null;
  moOperationSequenceNo: number | null;
  moOperationWorkCenterName: string | null;
  causeAnalysis: string | null;
  correctiveAction: string | null;
  preventiveAction: string | null;
  decision: DeviationDecision | null;
  closedAt: string | null;
  closedByName: string | null;
  cancelledAt: string | null;
  cancelledByName: string | null;
  cancelReason: string | null;
  createdByName: string | null;
  updatedAt: string;
  customerNumber: string | null;
  supplierNumber: string | null;
  counterpartyEmail: string | null;
  counterpartyAddress: string | null;
  counterpartyPostalCode: string | null;
  counterpartyCity: string | null;
  counterpartyCountry: string | null;
  customerOrderNumber: string | null;
  editable: boolean;
  allowedTransitions: DeviationAction[];
  closeRequirementsMissing: ("correctiveAction" | "decision")[];
  // null without canSeePrices.
  costs: DeviationCosts | null;
  links: DeviationLink[];
  files: DeviationFile[];
  events: DeviationEvent[];
}

// --- Kvalitetsorsaker (GET /deviation-reasons) ---

export interface DeviationReason {
  id: string;
  code: string;
  name: string;
  appliesCustomer: boolean;
  appliesSupplier: boolean;
  appliesInternal: boolean;
  appliesScrap: boolean;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

// An active reason that applies to a case type (the card's Orsak list).
export function reasonAppliesToType(reason: DeviationReason, type: DeviationType): boolean {
  return type === "customer" ? reason.appliesCustomer : type === "supplier" ? reason.appliesSupplier : reason.appliesInternal;
}

// The reasons a kassation can choose from: active and flagged Kassation.
export function scrapReasonsOf(reasons: DeviationReason[]): DeviationReason[] {
  return reasons.filter((r) => r.active && r.appliesScrap);
}

// A person the Ansvarig lists offer. The API has no user directory for
// Kvalitet users, so a non-admin sees themselves (and the case's current
// responsible person) — admins get everyone.
export interface ResponsibleCandidate {
  id: string;
  name: string;
}

// --- shared money/quantity text ---

export function formatDeviationQuantity(quantity: number | null, unitCode: string | null): string {
  if (quantity === null) return "–";
  const text = quantity.toLocaleString("sv-SE", { maximumFractionDigits: 4 });
  return unitCode ? `${text} ${unitCode}` : text;
}

// Server-side: the people the Ansvarig select/filter offers. Admins read the
// user register; everyone else gets themselves plus whoever is already set on
// the case (so a saved value never disappears from the select).
export async function getResponsibleCandidates(
  cookieHeader: string | undefined,
  user: SessionUser | null,
  alsoInclude: ResponsibleCandidate[] = []
): Promise<ResponsibleCandidate[]> {
  const byId = new Map<string, ResponsibleCandidate>();
  if (user?.role === "admin") {
    const users = await apiGet<AdminUser[]>("/api/v1/auth/users", cookieHeader).catch(() => [] as AdminUser[]);
    for (const u of users) if (u.active) byId.set(u.id, { id: u.id, name: u.name });
  }
  if (user) byId.set(user.id, { id: user.id, name: user.name });
  for (const c of alsoInclude) byId.set(c.id, c);
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name, "sv"));
}

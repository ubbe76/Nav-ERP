import { ApiError } from "./api";
import { apiErrorMessage } from "./errorMessages";
import type { Status } from "../components/ui/StatusPill";

// E-faktura (Peppol via B2Brouter) — wire types and labels. Mirrors the API
// contract (the web cannot import @navet/shared).

export type EInvoiceEnvironment = "sandbox" | "production";
export type EInvoiceStatus = "sending" | "sent" | "delivered" | "rejected" | "failed";

export const EINVOICE_STATUS_LABELS: Record<EInvoiceStatus, string> = {
  sending: "Skickas",
  sent: "Skickad",
  delivered: "Mottagen",
  rejected: "Avvisad",
  failed: "Misslyckad",
};

export const EINVOICE_STATUS_PILL: Record<EInvoiceStatus, Status> = {
  sending: "running",
  sent: "running",
  delivered: "done",
  rejected: "stopped",
  failed: "stopped",
};

export const EINVOICE_ENVIRONMENT_LABELS: Record<EInvoiceEnvironment, string> = {
  sandbox: "Sandbox",
  production: "Produktion",
};

// A transmission that still may change state (the status job polls it).
export const isLiveEInvoiceStatus = (status: EInvoiceStatus): boolean =>
  status === "sending" || status === "sent" || status === "delivered";

export interface EInvoiceTransmission {
  id: string;
  status: EInvoiceStatus;
  statusLabel: string;
  environment: EInvoiceEnvironment;
  recipientId: string;
  providerInvoiceId: string | null;
  providerState: string | null;
  errorMessage: string | null;
  startedAt: string;
  sentAt: string | null;
  statusUpdatedAt: string | null;
  lastPolledAt: string | null;
  createdByName: string | null;
}

export interface InvoiceEInvoice {
  enabled: boolean;
  environment: EInvoiceEnvironment;
  invoiceDelivery: "email" | "peppol";
  recipient: { peppolId: string | null; source: "customer" | "org-number" | null };
  blockedReason: string | null;
  blockedMessage: string | null;
  transmissions: EInvoiceTransmission[];
}

export interface EInvoiceCompany {
  name: string | null;
  orgNumber: string | null;
  vatNumber: string | null;
  address: string | null;
  postalCode: string | null;
  city: string | null;
  bankgiro: string | null;
  plusgiro: string | null;
  iban: string | null;
  bic: string | null;
  problems: string[];
}

// Statusbesked direkt: the page's view of the access point's web hook
// (never its secret).
export interface EInvoiceWebhook {
  active: boolean;
  environment: EInvoiceEnvironment | null;
  url: string | null;
  lastReceivedAt: string | null;
  environmentMismatch: boolean;
  // The address a registration would use now; null without an https Navs adress.
  proposedUrl: string | null;
}

export interface EInvoiceSettings {
  enabled: boolean;
  environment: EInvoiceEnvironment;
  apiKeySet: boolean;
  accountId: string | null;
  accountName: string | null;
  statusIntervalMinutes: number;
  lastStatusRunAt: string | null;
  // Skicka e-faktura automatiskt vid Utfärda.
  autoSend: boolean;
  webhook: EInvoiceWebhook;
  company: EInvoiceCompany;
  reception: EInvoiceReception;
}

export type EInvoicePublishStatus = "not_published" | "processing" | "published";
export const EINVOICE_PUBLISH_LABELS: Record<EInvoicePublishStatus, string> = {
  not_published: "Inte publicerad",
  processing: "Pågår",
  published: "Publicerad",
};

// Mottagning: the company as a Peppol receiver and the reception job.
export interface EInvoiceReception {
  enabled: boolean;
  smlStatus: EInvoicePublishStatus | null;
  directoryStatus: EInvoicePublishStatus | null;
  migrationPending: boolean | null;
  documentTypes: string[];
  participantId: string | null;
  intervalMinutes: number;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
}

// dismissed: an unreadable document closed with Markera som hanterad.
// Peppol document types as B2Brouter lists them; an unknown code is shown raw.
export const EINVOICE_DOCUMENT_TYPE_LABELS: Record<string, string> = {
  invoice: "Faktura",
  credit_note: "Kreditfaktura",
  order: "Order",
  order_response: "Orderbekräftelse",
  despatch_advice: "Följesedel",
  application_response: "Svarsmeddelande",
  "xml.ubl.invoice.bis3": "Faktura (Peppol BIS 3)",
  "xml.ubl.creditnote.bis3": "Kreditfaktura (Peppol BIS 3)",
  "xml.ubl.credit_note.bis3": "Kreditfaktura (Peppol BIS 3)",
  "xml.ubl.order.bis3": "Order (Peppol BIS 3)",
  "xml.ubl.order_response.bis3": "Orderbekräftelse (Peppol BIS 3)",
  "xml.ubl.application_response.bis3": "Svarsmeddelande (Peppol BIS 3)",
  "xml.ubl.despatch_advice.bis3": "Följesedel (Peppol BIS 3)",
  // The codes B2Brouter's sandbox listed for a peppol transport with
  // reception on (2026-11-05).
  "xml.ubl.order.ehf": "Order (EHF)",
  "xml.ubl.order.v3": "Order (Peppol)",
  "xml.ubl.application_response.invoice.v3": "Fakturasvar (Peppol)",
  "xml.ubl.application_response.v3": "Svarsmeddelande (Peppol)",
};

export type EInvoiceReceiveOutcome = "imported" | "duplicate" | "unreadable" | "dismissed";
export const EINVOICE_RECEIVE_OUTCOME_LABELS: Record<EInvoiceReceiveOutcome, string> = {
  imported: "Inläst",
  duplicate: "Dubblett",
  unreadable: "Kunde inte läsas",
  dismissed: "Hanterad",
};

export interface EInvoiceReceptionLogRow {
  id: string;
  environment: EInvoiceEnvironment;
  receivedAt: string;
  documentType: "invoice" | "credit_note" | null;
  documentNumber: string | null;
  issueDate: string | null;
  senderEndpoint: string | null;
  senderName: string | null;
  currency: string | null;
  payableAmount: number | null;
  outcome: EInvoiceReceiveOutcome;
  detail: string | null;
  invoiceScanId: string | null;
  scanNumber: string | null;
}

export interface EInvoiceReceiveResult {
  imported: number;
  duplicates: number;
  unreadable: number;
}

// What Utfärda did with the e-invoice of a customer with Fakturaleverans
// E-faktura (null = nothing: off, not configured or an e-mail customer).
export interface EInvoiceAutoSendOutcome {
  status: EInvoiceStatus | "blocked" | "error";
  message: string;
  transmissionId: string | null;
  reason: string | null;
}

// A failed/blocked outcome is a warning; anything else went out.
export const isEInvoiceAutoSendProblem = (outcome: EInvoiceAutoSendOutcome): boolean =>
  outcome.status === "blocked" || outcome.status === "error" || outcome.status === "failed" || outcome.status === "rejected";

export interface PeppolLookupResult {
  peppolId: string | null;
  source: "customer" | "org-number" | null;
  environment: EInvoiceEnvironment;
  found: boolean | null;
  name: string | null;
  documentTypes: string[];
  message: string | null;
}

// einvoice-document-invalid carries `problems`, einvoice-provider-rejected
// `fieldErrors` — both Swedish sentences, appended to the mapped message.
export function einvoiceErrorText(err: unknown, fallback: string): string {
  const base = apiErrorMessage(err, fallback);
  const body = err instanceof ApiError ? (err.body as { problems?: unknown; fieldErrors?: unknown } | undefined) : undefined;
  const list = [body?.problems, body?.fieldErrors].find(Array.isArray) as string[] | undefined;
  // A field error the message already quotes (a rejected migration code) is not repeated.
  const extra = (list ?? []).filter((item) => !base.includes(item));
  return extra.length > 0 ? `${base}: ${extra.join(" · ")}` : base;
}

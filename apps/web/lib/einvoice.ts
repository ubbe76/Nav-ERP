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

export interface EInvoiceSettings {
  enabled: boolean;
  environment: EInvoiceEnvironment;
  apiKeySet: boolean;
  accountId: string | null;
  accountName: string | null;
  statusIntervalMinutes: number;
  lastStatusRunAt: string | null;
  company: EInvoiceCompany;
}

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
  return list && list.length > 0 ? `${base}: ${list.join(" · ")}` : base;
}

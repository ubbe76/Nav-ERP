import type { DocumentLanguage } from "./documentLanguage";
import type { MailTemplateKind } from "./mailTemplateCatalog";

// E-postmallar: what a send dialog asks POST /me/mail-text for — the
// document type, its language and the document's own values. The server
// adds the sender's name and the company's, picks the user's template (or
// the default) and fills it in. Mirrors mailTextRequestSchema in
// packages/shared/src/mail-templates.ts.
export interface MailTextValues {
  number: string;
  customer?: string | null;
  supplier?: string | null;
  contact?: string | null;
  amount?: { value: number; currency: string } | null;
  dueDate?: string | null;
  validUntil?: string | null;
  deliveryDate?: string | null;
  quoteNumber?: string | null;
}

export interface MailTextRequest {
  kind: MailTemplateKind;
  language: DocumentLanguage;
  values: MailTextValues;
}

// A complaint's three document types each have their own template.
export function deviationMailKind(type: "customer" | "supplier" | "internal"): MailTemplateKind {
  return type === "customer" ? "deviationCustomer" : type === "supplier" ? "deviationSupplier" : "deviationInternal";
}

// An amount the API sends as a string (numeric columns) as the request's
// number; null when there is none.
export function mailAmount(value: string | number | null | undefined, currency: string | null | undefined) {
  if (value === null || value === undefined || value === "" || !currency) return null;
  const n = Number(value);
  return Number.isFinite(n) ? { value: n, currency } : null;
}

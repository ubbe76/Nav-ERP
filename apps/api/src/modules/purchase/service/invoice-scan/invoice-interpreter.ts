import type { InvoiceScanAiModel } from "@navet/shared";
import type { AiInvoiceFields } from "./ai-fields.js";

// Fakturaskanning — the ONE seam between Nav and an AI interpretation
// (spec §3.5). The inbox service only ever speaks this format;
// claude-interpreter.ts is the only file that knows Anthropic, and tests
// inject a fake (test/helpers/fake-invoice-interpreter.ts). The factory is
// called per interpretation with the key and model read from the settings at
// that moment — a changed key needs no restart.
//
// What leaves the server: the file and the company's name + organisation
// number (so the model can tell the buyer from the seller). Never the
// supplier register or the purchase orders — matching is done locally on the
// answer.

export interface InvoiceInterpreterFile {
  contentType: "application/pdf" | "image/jpeg" | "image/png";
  data: Buffer;
}

export interface InvoiceInterpreterContext {
  companyName: string | null;
  companyOrgNumber: string | null;
  // Stockholm day — "today" for the model's reading of relative dates.
  today: string;
}

export interface AiInterpretation {
  fields: AiInvoiceFields;
  // The answer was cut off at max_tokens: only the head fields survived and
  // the rows are empty.
  truncated: boolean;
}

export interface InvoiceInterpreter {
  interpret(file: InvoiceInterpreterFile, context: InvoiceInterpreterContext): Promise<AiInterpretation>;
  // Testa anslutning: a minimal call with the key and model; throws
  // InvoiceInterpreterError on any failure.
  testConnection(): Promise<void>;
}

export interface InvoiceInterpreterConfig {
  apiKey: string;
  model: InvoiceScanAiModel;
}

export type InvoiceInterpreterFactory = (config: InvoiceInterpreterConfig) => InvoiceInterpreter;

// What went wrong, as the inbox needs it — never the provider's own text.
export type InvoiceInterpreterErrorKind =
  | "unauthorized" // the key was not accepted (401/403)
  | "model_unavailable" // the key cannot use the chosen model (404)
  | "rate_limited" // 429/529
  | "bad_request" // the provider refused the request or the file (400/413/422)
  | "unavailable" // no answer: connection, timeout, 5xx
  | "refusal" // the model (and its fallback) declined to interpret the file
  | "invalid_response" // an answer that is not the agreed structure
  | "truncated" // cut off at max_tokens before even the head fields were complete
  | "unexpected";

export class InvoiceInterpreterError extends Error {
  constructor(
    public readonly kind: InvoiceInterpreterErrorKind,
    // For the server log only: the SDK class name and HTTP status, never the
    // provider's message (it may echo the request).
    public readonly detail: string | null = null
  ) {
    super(`AI interpretation failed: ${kind}`);
    this.name = "InvoiceInterpreterError";
  }
}

// The Swedish texts stored in invoice_scans.ai_error (varchar 200) and shown
// on the review page / returned by Testa anslutning.
export const AI_ERROR_TEXTS: Record<InvoiceInterpreterErrorKind, string> = {
  unauthorized: "API-nyckeln godkändes inte",
  model_unavailable: "API-nyckeln har inte tillgång till den valda modellen",
  rate_limited: "AI-tjänsten är tillfälligt överbelastad — försök igen om en stund",
  bad_request: "Filen kunde inte tolkas av AI-tjänsten",
  unavailable: "AI-tjänsten svarade inte",
  refusal: "AI-tjänsten avböjde att tolka filen",
  invalid_response: "AI-tjänsten svarade i ett format som inte gick att läsa",
  truncated: "Svaret blev för långt — fyll i fälten för hand",
  unexpected: "AI-tolkningen misslyckades — försök igen eller fyll i fälten för hand",
};

export const AI_TEXTS = {
  truncated: "Svaret blev för långt — fyll i raderna för hand",
  imageTooLarge: "Bilden är för stor för AI-tolkning (max 7,5 MB) — fota med lägre upplösning",
  tooManyPages: "PDF:en har för många sidor för AI-tolkning (max 100)",
  testNoKey: "Ingen API-nyckel angiven",
};

export function aiErrorText(err: unknown): string {
  return err instanceof InvoiceInterpreterError ? AI_ERROR_TEXTS[err.kind] : AI_ERROR_TEXTS.unexpected;
}

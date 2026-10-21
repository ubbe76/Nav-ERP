// The ONE seam between Nav and a Peppol access point (B2Brouter today). The
// e-invoice service only ever speaks this format; b2brouter-provider.ts is the
// only file that knows B2Brouter, and tests inject a fake
// (test/helpers/fake-einvoice-provider.ts). Spec §3.2.

export interface EInvoiceDocument {
  xml: Buffer;
  filename: string; // "FA-1234.xml" — informational for the access point
}

export interface SubmitResult {
  providerInvoiceId: string;
  state: string; // the access point's raw state right after the send call
}

export interface ProviderStatus {
  state: string;
  errorMessage: string | null;
  updatedAt: string | null; // ISO 8601 when the access point reports one
}

// Peppol directory answer. found null = the directory could not tell
// (timeout, upstream unavailable) — message says so in Swedish.
export interface LookupResult {
  found: boolean | null;
  name: string | null;
  // Raw document type codes the participant accepts, as the access point
  // reports them (the service turns them into Swedish labels).
  documentTypes: string[];
  message: string | null;
}

export interface ValidationResult {
  status: "valid" | "valid_with_warnings" | "invalid";
  errors: string[];
  warnings: string[];
}

export interface EInvoiceProvider {
  readonly name: "b2brouter";
  // GET /accounts — "Testa anslutning". The first account the key reaches;
  // vatNumber is the account's own VAT id (B2Brouter refuses an import whose
  // seller is another company), null when the access point gives none.
  checkKey(): Promise<{ accountId: string; accountName: string; vatNumber: string | null }>;
  // import + send. Throws EInvoiceProviderError; when the import went through
  // but the send did not, the error carries providerInvoiceId so the row can
  // stay `sending` and the status job can read what became of it.
  submit(doc: EInvoiceDocument): Promise<SubmitResult>;
  getStatus(providerInvoiceId: string): Promise<ProviderStatus>;
  // Directory lookup, handles the access point's 202 polling itself.
  lookupParticipant(scheme: string, id: string): Promise<LookupResult>;
  // Optional: the access point's own XSD + schematron check without sending.
  validate?(xml: Buffer): Promise<ValidationResult>;
}

export interface EInvoiceProviderConfig {
  environment: "sandbox" | "production";
  apiKey: string;
  // The account the key operates on; null until Testa anslutning filled it
  // in (checkKey needs no account).
  accountId: string | null;
}

export type EInvoiceProviderFactory = (config: EInvoiceProviderConfig) => EInvoiceProvider;

// validation: the access point refused the document (422) → 400 with
// fieldErrors. unauthorized: it rejected our API key (401/403) → 409, points
// at the settings. unavailable: network/timeout/429/5xx → 502. unexpected: an
// answer we cannot read → 502.
export type EInvoiceProviderErrorKind = "validation" | "unauthorized" | "unavailable" | "unexpected";

export class EInvoiceProviderError extends Error {
  constructor(
    message: string,
    readonly kind: EInvoiceProviderErrorKind,
    readonly fieldErrors: string[] = [],
    readonly requestId: string | null = null,
    // Set when the import succeeded and only the send failed: the document
    // exists at the access point under this id.
    readonly providerInvoiceId: string | null = null
  ) {
    super(message);
    this.name = "EInvoiceProviderError";
  }
}

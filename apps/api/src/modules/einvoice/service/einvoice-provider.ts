// The ONE seam between Nav and a Peppol access point (B2Brouter today). The
// e-invoice service only ever speaks this format; b2brouter-provider.ts is the
// only file that knows B2Brouter, and tests inject a fake
// (test/helpers/fake-einvoice-provider.ts). Spec §3.2.

export interface EInvoiceDocument {
  xml: Buffer;
  filename: string; // "FA-1234.xml" — informational for the access point
}

export interface SubmitOptions {
  onImported?: (providerInvoiceId: string) => Promise<void>;
}

export interface SubmitResult {
  providerInvoiceId: string;
  state: string; // the access point's raw state right after the send call
  errorMessage: string | null; // its error text when that state is a failure
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

// A received document as the access point lists it (Mottagning, spec
// 2026-11-05-e-faktura-mottagning). Nothing else of the listing is trusted:
// Nav reads the UBL itself.
export interface ReceivedDocumentRef {
  providerInvoiceId: string;
  state: string | null;
}

// The account's Peppol transport as the access point reports it. null from
// getTransport = no Peppol transport is configured.
export interface PeppolTransport {
  enabled: boolean;
  reception: boolean;
  smlStatus: "not_published" | "processing" | "published" | null;
  directoryStatus: "not_published" | "processing" | "published" | null;
  migrationPending: boolean | null;
  // Document type codes the transport receives (xml.ubl.invoice.bis3 …).
  documentTypes: string[];
  // "scheme:value" as published (0007:5566778899), null when unknown.
  participantId: string | null;
}

export interface EInvoiceProvider {
  readonly name: "b2brouter";
  // GET /accounts — "Testa anslutning". The first account the key reaches;
  // vatNumber is the account's own VAT id (B2Brouter refuses an import whose
  // seller is another company), null when the access point gives none.
  checkKey(): Promise<{ accountId: string; accountName: string; vatNumber: string | null }>;
  // import + send. `onImported` is awaited between the two calls with the
  // access point's id for the draft, so the caller can persist it BEFORE the
  // send — a process that dies after the send then still knows the document
  // exists there. Throws EInvoiceProviderError; when the import went through
  // but the send did not, the error carries providerInvoiceId so the row can
  // stay `sending` and the status job can read what became of it.
  submit(doc: EInvoiceDocument, opts?: SubmitOptions): Promise<SubmitResult>;
  getStatus(providerInvoiceId: string): Promise<ProviderStatus>;
  // Directory lookup in the participant's country (ISO alpha-2, default
  // SE), handles the access point's 202 polling itself.
  lookupParticipant(scheme: string, id: string, country?: string): Promise<LookupResult>;
  // Statusbesked direkt (spec 2026-11-05): registers a web hook for the
  // given events and returns its id and signing secret (shown only once by
  // the access point); deleteWebhook throws kind "not-found" when it is gone.
  createWebhook(input: { url: string; events: string[]; description: string }): Promise<{ id: string; secret: string }>;
  deleteWebhook(id: string): Promise<void>;
  // Optional: the access point's own XSD + schematron check without sending.
  validate?(xml: Buffer): Promise<ValidationResult>;

  // --- Mottagning ---
  // The received documents not yet acknowledged, oldest first.
  listReceived(opts: { offset: number; limit: number }): Promise<{ documents: ReceivedDocumentRef[]; total: number }>;
  // The document exactly as it arrived (kind "not-found" when gone).
  getReceivedOriginal(providerInvoiceId: string): Promise<{ xml: Buffer; contentType: string }>;
  // The access point's UBL BIS3 rendering of a received document — the
  // reserve when the original is not UBL (CII …).
  getReceivedAsUbl(providerInvoiceId: string): Promise<Buffer>;
  // Marks the document fetched: it leaves the unacknowledged listing.
  acknowledgeReceived(providerInvoiceId: string): Promise<void>;
  getTransport(): Promise<PeppolTransport | null>;
  // Turns the transport's reception on/off; the migration code travels
  // only with enabled: true. A 409 from the access point (the identifier
  // is published by another provider, or — in the sandbox — migration
  // codes are unavailable) is kind "conflict" with the access point's text.
  setReception(input: { enabled: boolean; migrationCode?: string }): Promise<PeppolTransport>;
  // Changes a registered web hook's events (kind "not-found" when gone).
  updateWebhook(id: string, input: { events: string[] }): Promise<void>;
}

export interface EInvoiceProviderConfig {
  environment: "sandbox" | "production";
  apiKey: string;
  // The account the key operates on; null until Testa anslutning filled it
  // in (checkKey needs no account).
  accountId: string | null;
}

export type EInvoiceProviderFactory = (config: EInvoiceProviderConfig) => EInvoiceProvider;

// validation: the access point refused the document (400/422) → 400 with
// fieldErrors. unauthorized: it rejected our API key or does not know the
// configured account (401/403, 404 on import) → 409, points at the settings.
// not-found: the document no longer exists there (404 on a status read) —
// the status job marks the row failed. unavailable: network/timeout/429/5xx
// → 502. unexpected: an answer we cannot read, or another 4xx → 502.
// conflict: 409 on the reception switch (another access point publishes
// the identifier; migration codes refused in the sandbox) → 409.
export type EInvoiceProviderErrorKind = "validation" | "unauthorized" | "not-found" | "unavailable" | "unexpected" | "conflict";

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

import {
  EInvoiceProviderError,
  type EInvoiceDocument,
  type EInvoiceProvider,
  type EInvoiceProviderConfig,
  type LookupResult,
  type PeppolTransport,
  type ProviderStatus,
  type ValidationResult,
} from "../../src/modules/einvoice/service/einvoice-provider.js";

// A received document in the fake's reception box: what the access point
// serves as original, optionally its BIS3 rendering, and whether it has
// been acknowledged (acknowledged documents leave the listing, like
// B2Brouter's).
export interface FakeReceivedDocument {
  original: Buffer;
  contentType: string;
  ubl?: Buffer;
  acked: boolean;
  originalError?: Error;
  ublError?: Error;
  ackError?: Error;
}

// In-memory EInvoiceProvider for the e-invoice tests. `state` lets a test
// script what the access point answers: the state a submitted document gets,
// an error on import or on send, the status of any provider invoice id, and
// the directory answer. `calls` records every call in order.
export interface FakeEinvoice {
  provider: EInvoiceProvider;
  factory: (config: EInvoiceProviderConfig) => EInvoiceProvider;
  configs: EInvoiceProviderConfig[];
  calls: { method: string; args: unknown[] }[];
  state: {
    account: { accountId: string; accountName: string; vatNumber: string | null };
    checkKeyError: Error | null;
    // What submit answers with (and the state getStatus reports until
    // changed). "sent" by default: the state B2Brouter reports once the
    // send call has gone through. submitErrorMessage is the access point's
    // error text beside a failing state.
    submitState: string;
    submitErrorMessage: string | null;
    importError: Error | null;
    // Thrown by submit AFTER the import: the error gets providerInvoiceId.
    sendError: EInvoiceProviderError | null;
    submitted: EInvoiceDocument[];
    statuses: Record<string, ProviderStatus>;
    statusError: Error | null;
    lookup: LookupResult;
    lookupError: Error | null;
    validation: ValidationResult;
    // Web hooks registered at the fake access point, by id; createWebhook
    // answers with the next id and `webhookSecret`.
    webhooks: Map<string, { url: string; events: string[] }>;
    webhookSecret: string;
    createWebhookError: Error | null;
    deleteWebhookError: Error | null;
    // --- Mottagning ---
    received: Map<string, FakeReceivedDocument>;
    listReceivedError: Error | null;
    transport: PeppolTransport | null;
    setReceptionError: Error | null;
    updateWebhookError: Error | null;
  };
  // Puts a document in the reception box under the next id and returns it.
  receive(original: Buffer, extra?: Partial<FakeReceivedDocument>): string;
}

export function createFakeEinvoiceProvider(): FakeEinvoice {
  const calls: FakeEinvoice["calls"] = [];
  const configs: EInvoiceProviderConfig[] = [];
  const state: FakeEinvoice["state"] = {
    account: { accountId: "nav-test", accountName: "Nav Test AB", vatNumber: "SE556000000101" },
    checkKeyError: null,
    submitState: "sent",
    submitErrorMessage: null,
    importError: null,
    sendError: null,
    submitted: [],
    statuses: {},
    statusError: null,
    lookup: { found: true, name: "Kund AB", documentTypes: ["invoice", "credit_note"], message: null },
    lookupError: null,
    validation: { status: "valid", errors: [], warnings: [] },
    webhooks: new Map(),
    webhookSecret: "whsec_test_secret",
    createWebhookError: null,
    deleteWebhookError: null,
    received: new Map(),
    listReceivedError: null,
    transport: {
      enabled: true,
      reception: false,
      smlStatus: "not_published",
      directoryStatus: "not_published",
      migrationPending: false,
      documentTypes: [],
      participantId: "0007:5560000001",
    },
    setReceptionError: null,
    updateWebhookError: null,
  };
  let nextId = 1000;
  const record = (method: string, ...args: unknown[]) => calls.push({ method, args });

  const provider: EInvoiceProvider = {
    name: "b2brouter",
    async checkKey() {
      record("checkKey");
      if (state.checkKeyError) throw state.checkKeyError;
      return { ...state.account };
    },
    async submit(doc, opts = {}) {
      record("submit", doc);
      if (state.importError) throw state.importError;
      const providerInvoiceId = String(nextId++);
      state.submitted.push(doc);
      state.statuses[providerInvoiceId] = { state: state.submitState, errorMessage: state.submitErrorMessage, updatedAt: null };
      // Like the real adapter: the caller learns the id before the send.
      await opts.onImported?.(providerInvoiceId);
      if (state.sendError) {
        const e = state.sendError;
        throw new EInvoiceProviderError(e.message, e.kind, e.fieldErrors, e.requestId, providerInvoiceId);
      }
      return { providerInvoiceId, state: state.submitState, errorMessage: state.submitErrorMessage };
    },
    async getStatus(id) {
      record("getStatus", id);
      if (state.statusError) throw state.statusError;
      const s = state.statuses[id];
      if (!s) throw new EInvoiceProviderError("B2Brouter gav ett oväntat svar", "unexpected");
      if (s.state === "__gone__") throw new EInvoiceProviderError("Dokumentet finns inte längre hos B2Brouter", "not-found");
      return { ...s };
    },
    async lookupParticipant(scheme, id, country) {
      record("lookupParticipant", scheme, id, country);
      if (state.lookupError) throw state.lookupError;
      return { ...state.lookup, documentTypes: [...state.lookup.documentTypes] };
    },
    async validate(xml) {
      record("validate", xml);
      return { ...state.validation };
    },
    async createWebhook(input) {
      record("createWebhook", input);
      if (state.createWebhookError) throw state.createWebhookError;
      const id = String(nextId++);
      state.webhooks.set(id, { url: input.url, events: [...input.events] });
      return { id, secret: state.webhookSecret };
    },
    async deleteWebhook(id) {
      record("deleteWebhook", id);
      if (state.deleteWebhookError) throw state.deleteWebhookError;
      if (!state.webhooks.delete(id)) throw new EInvoiceProviderError("Webhooken finns inte längre hos B2Brouter", "not-found");
    },
    async updateWebhook(id, input) {
      record("updateWebhook", id, input);
      if (state.updateWebhookError) throw state.updateWebhookError;
      const hook = state.webhooks.get(id);
      if (!hook) throw new EInvoiceProviderError("Webhooken finns inte längre hos B2Brouter", "not-found");
      hook.events = [...input.events];
    },
    async listReceived({ offset, limit }) {
      record("listReceived", { offset, limit });
      if (state.listReceivedError) throw state.listReceivedError;
      const pending = [...state.received.entries()].filter(([, d]) => !d.acked);
      return {
        documents: pending.slice(offset, offset + limit).map(([id]) => ({ providerInvoiceId: id, state: "new" })),
        total: pending.length,
      };
    },
    async getReceivedOriginal(id) {
      record("getReceivedOriginal", id);
      const doc = state.received.get(id);
      if (!doc) throw new EInvoiceProviderError("Dokumentet finns inte längre hos B2Brouter", "not-found");
      if (doc.originalError) throw doc.originalError;
      return { xml: doc.original, contentType: doc.contentType };
    },
    async getReceivedAsUbl(id) {
      record("getReceivedAsUbl", id);
      const doc = state.received.get(id);
      if (!doc) throw new EInvoiceProviderError("Dokumentet finns inte längre hos B2Brouter", "not-found");
      if (doc.ublError) throw doc.ublError;
      if (!doc.ubl) throw new EInvoiceProviderError("B2Brouter gav ett oväntat svar", "unexpected");
      return doc.ubl;
    },
    async acknowledgeReceived(id) {
      record("acknowledgeReceived", id);
      const doc = state.received.get(id);
      if (!doc) throw new EInvoiceProviderError("Dokumentet finns inte längre hos B2Brouter", "not-found");
      if (doc.ackError) throw doc.ackError;
      doc.acked = true;
    },
    async getTransport() {
      record("getTransport");
      return state.transport ? { ...state.transport, documentTypes: [...state.transport.documentTypes] } : null;
    },
    async setReception(input) {
      record("setReception", input);
      if (state.setReceptionError) throw state.setReceptionError;
      if (!state.transport) throw new EInvoiceProviderError("B2Brouter hittar inte det valda kontot — kör Testa anslutning under System → E-faktura", "unauthorized");
      state.transport = {
        ...state.transport,
        reception: input.enabled,
        documentTypes: input.enabled ? ["xml.ubl.invoice.bis3", "xml.ubl.credit_note.bis3"] : [],
      };
      return { ...state.transport, documentTypes: [...state.transport.documentTypes] };
    },
  };
  return {
    provider,
    factory: (config) => {
      configs.push(config);
      return provider;
    },
    configs,
    calls,
    state,
    receive(original, extra = {}) {
      const id = String(nextId++);
      state.received.set(id, { original, contentType: "application/xml", acked: false, ...extra });
      return id;
    },
  };
}

export const conflict = (message: string) => new EInvoiceProviderError(message, "conflict");

export const unavailable = (message = "B2Brouter svarar inte, försök igen") => new EInvoiceProviderError(message, "unavailable");
export const refused = (message: string, fieldErrors: string[] = []) => new EInvoiceProviderError(message, "validation", fieldErrors);

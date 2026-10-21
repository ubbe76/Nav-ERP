import {
  EInvoiceProviderError,
  type EInvoiceDocument,
  type EInvoiceProvider,
  type EInvoiceProviderConfig,
  type LookupResult,
  type ProviderStatus,
  type ValidationResult,
} from "../../src/modules/einvoice/service/einvoice-provider.js";

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
    // What submit answers with (and the state getStatus reports until changed).
    submitState: string;
    importError: Error | null;
    // Thrown by submit AFTER the import: the error gets providerInvoiceId.
    sendError: EInvoiceProviderError | null;
    submitted: EInvoiceDocument[];
    statuses: Record<string, ProviderStatus>;
    statusError: Error | null;
    lookup: LookupResult;
    lookupError: Error | null;
    validation: ValidationResult;
  };
}

export function createFakeEinvoiceProvider(): FakeEinvoice {
  const calls: FakeEinvoice["calls"] = [];
  const configs: EInvoiceProviderConfig[] = [];
  const state: FakeEinvoice["state"] = {
    account: { accountId: "nav-test", accountName: "Nav Test AB", vatNumber: "SE556000000101" },
    checkKeyError: null,
    submitState: "sending",
    importError: null,
    sendError: null,
    submitted: [],
    statuses: {},
    statusError: null,
    lookup: { found: true, name: "Kund AB", documentTypes: ["invoice", "credit_note"], message: null },
    lookupError: null,
    validation: { status: "valid", errors: [], warnings: [] },
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
    async submit(doc) {
      record("submit", doc);
      if (state.importError) throw state.importError;
      const providerInvoiceId = String(nextId++);
      state.submitted.push(doc);
      state.statuses[providerInvoiceId] = { state: state.submitState, errorMessage: null, updatedAt: null };
      if (state.sendError) {
        const e = state.sendError;
        throw new EInvoiceProviderError(e.message, e.kind, e.fieldErrors, e.requestId, providerInvoiceId);
      }
      return { providerInvoiceId, state: state.submitState };
    },
    async getStatus(id) {
      record("getStatus", id);
      if (state.statusError) throw state.statusError;
      const s = state.statuses[id];
      if (!s) throw new EInvoiceProviderError("B2Brouter gav ett oväntat svar", "unexpected");
      return { ...s };
    },
    async lookupParticipant(scheme, id) {
      record("lookupParticipant", scheme, id);
      if (state.lookupError) throw state.lookupError;
      return { ...state.lookup, documentTypes: [...state.lookup.documentTypes] };
    },
    async validate(xml) {
      record("validate", xml);
      return { ...state.validation };
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
  };
}

export const unavailable = (message = "B2Brouter svarar inte, försök igen") => new EInvoiceProviderError(message, "unavailable");
export const refused = (message: string, fieldErrors: string[] = []) => new EInvoiceProviderError(message, "validation", fieldErrors);

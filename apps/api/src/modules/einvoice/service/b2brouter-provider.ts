import {
  EInvoiceProviderError,
  type EInvoiceProvider,
  type EInvoiceProviderConfig,
  type EInvoiceProviderFactory,
  type LookupResult,
  type ProviderStatus,
  type ValidationResult,
} from "./einvoice-provider.js";

// B2Brouter (https://developer.b2brouter.net) — the ONLY file that knows
// B2Brouter. The API key travels in the X-B2B-API-Key header only: it is
// never logged and never part of an error (see transportSummary). Verified
// facts from their OpenAPI 2026-06-26 are in the spec's "B2Brouters API i
// korthet"; what the sandbox still has to confirm is marked SANDBOX below.

// One base URL for both environments per the spec: a key that starts with
// "test_" is routed to the sandbox by B2Brouter. (Their developer portal
// also lists api-staging.b2brouter.net as a test server — SANDBOX: confirm
// which host the test_ key wants and change the sandbox entry if needed.)
export const B2BROUTER_BASE_URL = {
  sandbox: "https://api.b2brouter.net",
  production: "https://api.b2brouter.net",
} as const;

export const B2BROUTER_API_VERSION = "2026-06-26";

const TIMEOUT_MS = 30_000;
// Directory lookups are asynchronous: 202 until the directory answered.
export const LOOKUP_POLL_INTERVAL_MS = 1_000;
export const LOOKUP_MAX_WAIT_MS = 10_000;

export const B2BROUTER_MESSAGES = {
  unauthorized: "B2Brouter godkände inte API-nyckeln — kontrollera den under System → E-faktura",
  unavailable: "B2Brouter svarar inte, försök igen",
  unexpected: "B2Brouter gav ett oväntat svar",
  noAccount: "API-nyckeln når inget konto hos B2Brouter",
  rejected: "B2Brouter avvisade dokumentet",
  directoryUnavailable: "Katalogen svarade inte, försök igen",
  directoryInvalid: "Peppol-id:t är inte giltigt för schemat",
  directoryBroken: "Mottagarens accesspunkt publicerar inga giltiga dokumenttyper — kontakta mottagaren",
} as const;

// What we log about a transport failure: the error's name and the cause's
// code, nothing else. Node's fetch echoes the offending header VALUE — our
// API key — in the TypeError message when it contains a control character,
// so err.message is never logged and the error is never attached as cause.
function transportSummary(err: unknown): string {
  const e = (err ?? {}) as { name?: unknown; cause?: { code?: unknown } | null };
  return [e.name, e.cause?.code].filter((v): v is string => typeof v === "string" && v !== "").join(" ");
}

const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : null);
const obj = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

// B2Brouter's error envelopes: { error: { code, message, param, type } } on
// most endpoints, and — SANDBOX-verified 2026-10-21 on send_invoice —
// { errors: ["Cannot send invoice …"] } (plain strings, or objects with a
// message) on the Rails-style validation refusals.
export function parseErrorBody(text: string): { code: string | null; message: string | null; param: string | null } {
  const none = { code: null, message: null, param: null };
  try {
    const parsed = obj(JSON.parse(text));
    const error = obj(parsed?.error);
    if (error) return { code: str(error.code), message: str(error.message), param: str(error.param) };
    const errors = Array.isArray(parsed?.errors) ? parsed!.errors : null;
    if (errors) {
      const messages = errors
        .map((e) => str(e) ?? str(obj(e)?.message))
        .filter((m): m is string => m !== null);
      return messages.length > 0 ? { code: null, message: messages.join("; "), param: null } : none;
    }
    return none;
  } catch {
    return none;
  }
}

export interface B2BrouterDeps {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (entry: { method: string; path: string; status: number; requestId: string | null; body: string }) => void;
}

interface CallResult {
  status: number;
  requestId: string | null;
  data: unknown;
  text: string;
}

export function createB2BrouterProvider(config: EInvoiceProviderConfig, deps: B2BrouterDeps = {}): EInvoiceProvider {
  const doFetch = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? ((entry) => console.warn("B2Brouter request failed", entry));
  const baseUrl = B2BROUTER_BASE_URL[config.environment];

  // Raw HTTP: only the transport failure is turned into an error here; the
  // callers decide what each status means (the directory lookup reads 202/
  // 404/424 as answers, not failures).
  async function raw(method: string, path: string, body?: { xml: Buffer }): Promise<CallResult> {
    let res: Response;
    try {
      res = await doFetch(baseUrl + path, {
        method,
        headers: {
          "X-B2B-API-Key": config.apiKey,
          "X-B2B-API-Version": B2BROUTER_API_VERSION,
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/octet-stream" } : {}),
        },
        body: body ? new Uint8Array(body.xml) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      log({ method, path, status: 0, requestId: null, body: transportSummary(err) });
      throw new EInvoiceProviderError(B2BROUTER_MESSAGES.unavailable, "unavailable");
    }
    const requestId = res.headers.get("x-b2b-api-request-id");
    const text = await res.text().catch(() => "");
    let data: unknown = null;
    if (text !== "") {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }
    if (res.status >= 400) log({ method, path, status: res.status, requestId, body: text.slice(0, 2000) });
    return { status: res.status, requestId, data, text };
  }

  // The common status → error mapping for the ordinary endpoints.
  function failure(r: CallResult, validationMessage: string, providerInvoiceId: string | null = null): EInvoiceProviderError {
    if (r.status === 401 || r.status === 403) {
      return new EInvoiceProviderError(B2BROUTER_MESSAGES.unauthorized, "unauthorized", [], r.requestId, providerInvoiceId);
    }
    if (r.status === 429 || r.status >= 500) {
      return new EInvoiceProviderError(B2BROUTER_MESSAGES.unavailable, "unavailable", [], r.requestId, providerInvoiceId);
    }
    const body = parseErrorBody(r.text);
    const fieldErrors: string[] = [];
    if (body.message) fieldErrors.push(body.param ? `${body.param}: ${body.message}` : body.message);
    return new EInvoiceProviderError(
      body.message ? `${validationMessage}: ${body.message}` : `${validationMessage} (HTTP ${r.status})`,
      "validation",
      fieldErrors,
      r.requestId,
      providerInvoiceId
    );
  }

  async function call(method: string, path: string, body?: { xml: Buffer }): Promise<CallResult> {
    const r = await raw(method, path, body);
    if (r.status >= 400) throw failure(r, B2BROUTER_MESSAGES.rejected);
    return r;
  }

  function unexpected(requestId: string | null = null, providerInvoiceId: string | null = null) {
    return new EInvoiceProviderError(B2BROUTER_MESSAGES.unexpected, "unexpected", [], requestId, providerInvoiceId);
  }

  function invoiceOf(r: CallResult): Record<string, unknown> {
    const invoice = obj(obj(r.data)?.invoice);
    if (!invoice) throw unexpected(r.requestId);
    return invoice;
  }

  function idOf(invoice: Record<string, unknown>, requestId: string | null): string {
    const id = invoice.id;
    if (typeof id === "number" && Number.isFinite(id)) return String(id);
    const s = str(id);
    if (s) return s;
    throw unexpected(requestId);
  }

  async function readStatus(providerInvoiceId: string): Promise<ProviderStatus> {
    const r = await call("GET", `/invoices/${encodeURIComponent(providerInvoiceId)}`);
    const invoice = invoiceOf(r);
    const state = str(invoice.state);
    if (!state) throw unexpected(r.requestId, providerInvoiceId);
    return {
      state,
      errorMessage: str(invoice.error_message) ?? str(invoice.error),
      updatedAt: str(invoice.state_updated_at) ?? str(invoice.updated_at),
    };
  }

  return {
    name: "b2brouter",

    async checkKey() {
      const r = await call("GET", "/accounts");
      const list = obj(r.data)?.accounts;
      const first = Array.isArray(list) ? obj(list[0]) : null;
      if (!first) throw new EInvoiceProviderError(B2BROUTER_MESSAGES.noAccount, "unexpected", [], r.requestId);
      // SANDBOX-verified 2026-10-21: accounts carry a numeric `id` and no
      // `identifier`; the numeric id is what the /accounts/{…}/ paths take.
      // An identifier is still preferred should one ever appear.
      const accountId = str(first.identifier) ?? (typeof first.id === "number" ? String(first.id) : str(first.id));
      if (!accountId) throw unexpected(r.requestId);
      // SANDBOX-verified 2026-10-21: the import is refused (422) when the
      // seller's VAT id differs from the account's tin_value.
      return { accountId, accountName: str(first.name) ?? accountId, vatNumber: str(first.tin_value) };
    },

    async submit(doc) {
      if (!config.accountId) throw new EInvoiceProviderError(B2BROUTER_MESSAGES.noAccount, "unexpected");
      // Import as raw XML (application/octet-stream, string/binary) —
      // SANDBOX-verified 2026-10-21: the raw body is accepted as is.
      const importPath =
        `/accounts/${encodeURIComponent(config.accountId)}/invoices/import` +
        `?send_after_import=false&transport_type_code_for_contact=peppol`;
      const imported = await call("POST", importPath, { xml: doc.xml });
      const providerInvoiceId = idOf(invoiceOf(imported), imported.requestId);

      // The send is a separate call. A transient failure is retried once; a
      // failure after that carries providerInvoiceId so the row can stay
      // `sending` and the status job reads what became of the draft.
      const sendPath = `/invoices/send_invoice/${encodeURIComponent(providerInvoiceId)}`;
      let last: EInvoiceProviderError | null = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const r = await raw("POST", sendPath);
          if (r.status < 400) {
            last = null;
            break;
          }
          last = failure(r, B2BROUTER_MESSAGES.rejected, providerInvoiceId);
        } catch (err) {
          if (!(err instanceof EInvoiceProviderError)) throw err;
          last = new EInvoiceProviderError(err.message, err.kind, err.fieldErrors, err.requestId, providerInvoiceId);
        }
        // A refused document or a refused key will not change on a retry.
        if (last.kind === "validation" || last.kind === "unauthorized") break;
      }
      if (last) throw last;

      // Best effort: the state right after the send, for the row. A failed
      // read must not undo a successful send — "sending" is then assumed.
      let state = "sending";
      try {
        state = (await readStatus(providerInvoiceId)).state;
      } catch {
        // see above
      }
      return { providerInvoiceId, state };
    },

    getStatus: readStatus,

    async lookupParticipant(scheme, id) {
      // Etapp 1: Swedish recipients only — the country segment is "se".
      const path = `/directory/se/${encodeURIComponent(scheme)}/${encodeURIComponent(id)}`;
      const started = now();
      for (;;) {
        let r: CallResult;
        try {
          r = await raw("GET", path);
        } catch (err) {
          if (err instanceof EInvoiceProviderError && err.kind === "unavailable") {
            return { found: null, name: null, documentTypes: [], message: B2BROUTER_MESSAGES.directoryUnavailable };
          }
          throw err;
        }
        if (r.status === 202) {
          if (now() - started >= LOOKUP_MAX_WAIT_MS) {
            return { found: null, name: null, documentTypes: [], message: B2BROUTER_MESSAGES.directoryUnavailable };
          }
          await sleep(LOOKUP_POLL_INTERVAL_MS);
          continue;
        }
        if (r.status === 200) {
          const company = obj(r.data) ?? {};
          // The document types the participant accepts: keys present with a
          // transport (invoice, credit_note, order …).
          const documentTypes = ["invoice", "credit_note", "application_response", "order", "order_response", "despatch_advice"].filter(
            (key) => {
              const entry = obj(company[key]);
              return entry !== null && (str(entry.transport_type_code) !== null || str(entry.document_type_code) !== null);
            }
          );
          return { found: true, name: str(company.name), documentTypes, message: null };
        }
        if (r.status === 404) return { found: false, name: null, documentTypes: [], message: null };
        if (r.status === 422) return { found: null, name: null, documentTypes: [], message: B2BROUTER_MESSAGES.directoryInvalid };
        if (r.status === 424) {
          const body = parseErrorBody(r.text);
          const message = body.code === "upstream_unavailable" ? B2BROUTER_MESSAGES.directoryUnavailable : B2BROUTER_MESSAGES.directoryBroken;
          return { found: null, name: null, documentTypes: [], message };
        }
        if (r.status === 401 || r.status === 403) {
          throw new EInvoiceProviderError(B2BROUTER_MESSAGES.unauthorized, "unauthorized", [], r.requestId);
        }
        if (r.status === 429 || r.status >= 500) {
          return { found: null, name: null, documentTypes: [], message: B2BROUTER_MESSAGES.directoryUnavailable };
        }
        throw unexpected(r.requestId);
      }
    },

    async validate(xml) {
      const r = await call("POST", "/documents/validate", { xml });
      const result = obj(obj(r.data)?.validation_result);
      const status = str(result?.status);
      if (status !== "valid" && status !== "valid_with_warnings" && status !== "invalid") throw unexpected(r.requestId);
      const messages = (entries: unknown): string[] =>
        (Array.isArray(entries) ? entries : [])
          .map((e) => {
            const entry = obj(e);
            if (!entry) return null;
            const message = str(entry.message);
            if (!message) return null;
            const code = str(entry.code);
            const path = str(entry.property_path);
            return `${code ? `${code}: ` : ""}${message}${path ? ` (${path})` : ""}`;
          })
          .filter((m): m is string => m !== null);
      const xsd = obj(result?.xsd);
      const sch = obj(result?.sch);
      return {
        status,
        errors: [...messages(xsd?.errors), ...messages(sch?.errors)],
        warnings: messages(sch?.warnings),
      } satisfies ValidationResult;
    },
  } satisfies EInvoiceProvider & { lookupParticipant: (s: string, i: string) => Promise<LookupResult> };
}

export const b2brouterProviderFactory: EInvoiceProviderFactory = (config) => createB2BrouterProvider(config);

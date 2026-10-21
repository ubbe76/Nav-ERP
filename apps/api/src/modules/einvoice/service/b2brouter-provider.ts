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

// One base URL for both environments: B2Brouter routes by the KEY, not the
// host (docs.b2brouter.net/en/developers/testing/environments — sandbox keys
// start with "test_", production keys with "prod_" (older production keys
// have no prefix), and "stag_" keys belong to their staging host, which Nav
// does not use). Kept as a table so a per-environment host is one edit.
export const B2BROUTER_BASE_URL = {
  sandbox: "https://api.b2brouter.net",
  production: "https://api.b2brouter.net",
} as const;

export const B2BROUTER_API_VERSION = "2026-06-26";

const TIMEOUT_MS = 30_000;
// The import uploads the UBL with the base64 PDF inside it — a large
// invoice takes a while to transfer and to be parsed at the other end.
export const IMPORT_TIMEOUT_MS = 120_000;
// Directory lookups are asynchronous: 202 until the directory answered.
export const LOOKUP_POLL_INTERVAL_MS = 1_000;
export const LOOKUP_MAX_WAIT_MS = 10_000;

export const B2BROUTER_MESSAGES = {
  unauthorized: "B2Brouter godkände inte API-nyckeln — kontrollera den under System → E-faktura",
  unavailable: "B2Brouter svarar inte, försök igen",
  unexpected: "B2Brouter gav ett oväntat svar",
  noAccount: "API-nyckeln når inget konto hos B2Brouter",
  accountNotFound: "B2Brouter hittar inte det valda kontot — kör Testa anslutning under System → E-faktura",
  documentNotFound: "Dokumentet finns inte längre hos B2Brouter",
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
  // The ordinary call timeout (tests shorten it); the import uses IMPORT_TIMEOUT_MS.
  timeoutMs?: number;
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
  const timeoutMs = deps.timeoutMs ?? TIMEOUT_MS;
  const baseUrl = B2BROUTER_BASE_URL[config.environment];

  // Raw HTTP: only the transport failure is turned into an error here; the
  // callers decide what each status means (the directory lookup reads 202/
  // 404/424 as answers, not failures). ONE timeout covers the whole call,
  // the body read included — a response whose body never arrives is as much
  // a transport failure as a connect that hangs.
  async function raw(method: string, path: string, body?: { xml: Buffer }, timeout = timeoutMs): Promise<CallResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    let res: Response;
    let text: string;
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
        signal: controller.signal,
      });
      text = await res.text();
    } catch (err) {
      log({ method, path, status: 0, requestId: null, body: transportSummary(err) });
      throw new EInvoiceProviderError(B2BROUTER_MESSAGES.unavailable, "unavailable");
    } finally {
      clearTimeout(timer);
    }
    const requestId = res.headers.get("x-b2b-api-request-id");
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

  // What a 404 means depends on the call: on the import it is the account
  // path (a configuration problem, treated like a refused key), on a status
  // read it is the document itself (gone), elsewhere it is just odd.
  type NotFoundMeaning = "account" | "document" | "unexpected";

  // The common status → error mapping for the ordinary endpoints. Only 400/
  // 422 are the access point refusing what we sent; any other 4xx is an
  // answer we did not expect, never a "document refused".
  function failure(r: CallResult, notFound: NotFoundMeaning, providerInvoiceId: string | null = null): EInvoiceProviderError {
    if (r.status === 401 || r.status === 403) {
      return new EInvoiceProviderError(B2BROUTER_MESSAGES.unauthorized, "unauthorized", [], r.requestId, providerInvoiceId);
    }
    if (r.status === 429 || r.status >= 500) {
      return new EInvoiceProviderError(B2BROUTER_MESSAGES.unavailable, "unavailable", [], r.requestId, providerInvoiceId);
    }
    if (r.status === 404) {
      if (notFound === "account") return new EInvoiceProviderError(B2BROUTER_MESSAGES.accountNotFound, "unauthorized", [], r.requestId, providerInvoiceId);
      if (notFound === "document") return new EInvoiceProviderError(B2BROUTER_MESSAGES.documentNotFound, "not-found", [], r.requestId, providerInvoiceId);
      return unexpected(r.requestId, providerInvoiceId);
    }
    if (r.status !== 400 && r.status !== 422) return unexpected(r.requestId, providerInvoiceId);
    const body = parseErrorBody(r.text);
    const fieldErrors: string[] = [];
    if (body.message) fieldErrors.push(body.param ? `${body.param}: ${body.message}` : body.message);
    return new EInvoiceProviderError(
      body.message ? `${B2BROUTER_MESSAGES.rejected}: ${body.message}` : `${B2BROUTER_MESSAGES.rejected} (HTTP ${r.status})`,
      "validation",
      fieldErrors,
      r.requestId,
      providerInvoiceId
    );
  }

  async function call(method: string, path: string, body?: { xml: Buffer }, opts: { notFound?: NotFoundMeaning; timeoutMs?: number } = {}): Promise<CallResult> {
    const r = await raw(method, path, body, opts.timeoutMs);
    if (r.status >= 400) throw failure(r, opts.notFound ?? "unexpected");
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
    const r = await call("GET", `/invoices/${encodeURIComponent(providerInvoiceId)}`, undefined, { notFound: "document" });
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

    async submit(doc, opts = {}) {
      if (!config.accountId) throw new EInvoiceProviderError(B2BROUTER_MESSAGES.noAccount, "unexpected");
      // Import as raw XML (application/octet-stream, string/binary) —
      // SANDBOX-verified 2026-10-21: the raw body is accepted as is.
      const importPath =
        `/accounts/${encodeURIComponent(config.accountId)}/invoices/import` +
        `?send_after_import=false&transport_type_code_for_contact=peppol`;
      const imported = await call("POST", importPath, { xml: doc.xml }, { notFound: "account", timeoutMs: IMPORT_TIMEOUT_MS });
      const providerInvoiceId = idOf(invoiceOf(imported), imported.requestId);
      // The caller persists the id before anything is sent (see SubmitOptions).
      await opts.onImported?.(providerInvoiceId);

      // The send is a separate call. A transient failure is retried once —
      // but a timed-out send may well have gone through (B2Brouter queues it
      // and answers the retry with 422 "Cannot send invoice in state
      // sending"), so NO send failure after the import is taken at face
      // value: the draft's state decides. Still "new" ⇒ nothing was sent and
      // the failure stands; "error" ⇒ the access point itself failed it
      // (SANDBOX-verified 2026-10-21: a send refused with 422 leaves the
      // draft in state error) and the failure stands with the 422's text,
      // which explains more than error_message does — a failed row is safe
      // to resend either way, nothing reached the customer. Any other state
      // ⇒ the send happened, this is a success. State unreadable ⇒ unknown:
      // the error carries providerInvoiceId so the row stays `sending` and
      // the status job reads what became of the draft. A refused key is the
      // one exception — the state read would fail with the same key.
      const sendPath = `/invoices/send_invoice/${encodeURIComponent(providerInvoiceId)}`;
      let last: EInvoiceProviderError | null = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const r = await raw("POST", sendPath);
          if (r.status < 400) {
            last = null;
            break;
          }
          last = failure(r, "document", providerInvoiceId);
        } catch (err) {
          if (!(err instanceof EInvoiceProviderError)) throw err;
          last = new EInvoiceProviderError(err.message, err.kind, err.fieldErrors, err.requestId, providerInvoiceId);
        }
        if (last.kind === "unauthorized") throw last;
        if (last.kind === "unavailable" && attempt === 0) continue;
        break;
      }
      if (last) {
        let status: ProviderStatus;
        try {
          status = await readStatus(providerInvoiceId);
        } catch (err) {
          const requestId = err instanceof EInvoiceProviderError ? err.requestId : null;
          throw new EInvoiceProviderError(B2BROUTER_MESSAGES.unavailable, "unavailable", [], requestId, providerInvoiceId);
        }
        const state = status.state.trim().toLowerCase();
        if (state === "new" || state === "error") throw last;
        return { providerInvoiceId, state: status.state, errorMessage: status.errorMessage };
      }

      // Best effort: the state right after the send, for the row. A failed
      // read must not undo a successful send — "sending" is then assumed.
      let status: ProviderStatus = { state: "sending", errorMessage: null, updatedAt: null };
      try {
        status = await readStatus(providerInvoiceId);
      } catch {
        // see above
      }
      return { providerInvoiceId, state: status.state, errorMessage: status.errorMessage };
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
      const r = await call("POST", "/documents/validate", { xml }, { timeoutMs: IMPORT_TIMEOUT_MS });
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

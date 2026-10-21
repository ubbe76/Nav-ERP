import { describe, expect, it } from "vitest";
import {
  B2BROUTER_API_VERSION,
  B2BROUTER_MESSAGES,
  createB2BrouterProvider,
  parseErrorBody,
} from "../src/modules/einvoice/service/b2brouter-provider.js";
import { EInvoiceProviderError } from "../src/modules/einvoice/service/einvoice-provider.js";

// The B2Brouter adapter against a scripted fetch: request shapes, headers,
// the import+send pair with its one retry, the error kinds, and that the
// API key never leaks into an error or a log line.

const KEY = "test_s3cret-key";

interface Scripted {
  status: number;
  body?: unknown;
  text?: string;
  headers?: Record<string, string>;
}

function fakeFetch(script: Scripted[] | ((url: string, init: RequestInit) => Scripted | Error)) {
  const requests: { url: string; init: RequestInit }[] = [];
  const queue = Array.isArray(script) ? [...script] : null;
  const impl: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, init: init ?? {} });
    const next = queue ? queue.shift() : (script as (u: string, i: RequestInit) => Scripted | Error)(url, init ?? {});
    if (!next) throw new Error("no scripted response left");
    if (next instanceof Error) throw next;
    const text = next.text ?? (next.body === undefined ? "" : JSON.stringify(next.body));
    // Response refuses a body on 204/205/304 (null-body statuses).
    return new Response(text === "" ? null : text, { status: next.status, headers: next.headers ?? {} });
  };
  return { impl, requests };
}

function provider(fetchImpl: typeof fetch, logs: unknown[] = [], extra: Partial<Parameters<typeof createB2BrouterProvider>[1]> = {}) {
  return createB2BrouterProvider(
    { environment: "sandbox", apiKey: KEY, accountId: "nav-test" },
    { fetch: fetchImpl, log: (e) => logs.push(e), sleep: async () => {}, ...extra }
  );
}

const XML = Buffer.from("<Invoice/>");

describe("B2Brouter — requests", () => {
  it("imports as raw XML then sends, with the pinned headers and the account in the path", async () => {
    const { impl, requests } = fakeFetch([
      { status: 201, body: { invoice: { id: 4053100, state: "new" } } },
      { status: 204 },
      { status: 200, body: { invoice: { id: 4053100, state: "sending" } } },
    ]);
    const result = await provider(impl).submit({ xml: XML, filename: "FA-1.xml" });
    expect(result).toEqual({ providerInvoiceId: "4053100", state: "sending" });
    expect(requests.map((r) => `${r.init.method} ${r.url}`)).toEqual([
      "POST https://api.b2brouter.net/accounts/nav-test/invoices/import?send_after_import=false&transport_type_code_for_contact=peppol",
      "POST https://api.b2brouter.net/invoices/send_invoice/4053100",
      "GET https://api.b2brouter.net/invoices/4053100",
    ]);
    const headers = requests[0]!.init.headers as Record<string, string>;
    expect(headers["X-B2B-API-Key"]).toBe(KEY);
    expect(headers["X-B2B-API-Version"]).toBe(B2BROUTER_API_VERSION);
    expect(headers["Content-Type"]).toBe("application/octet-stream");
    expect(Buffer.from(requests[0]!.init.body as Uint8Array).toString()).toBe("<Invoice/>");
    expect((requests[1]!.init.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
    expect(requests[1]!.init.body).toBeUndefined();
  });

  it("answers 'sending' when the state read after the send fails", async () => {
    const { impl } = fakeFetch([
      { status: 201, body: { invoice: { id: "77", state: "new" } } },
      { status: 204 },
      { status: 500 },
    ]);
    expect(await provider(impl).submit({ xml: XML, filename: "x" })).toEqual({ providerInvoiceId: "77", state: "sending" });
  });

  it("retries the send once on a transient failure, then fails with the provider id", async () => {
    const { impl, requests } = fakeFetch([
      { status: 201, body: { invoice: { id: 5, state: "new" } } },
      { status: 503 },
      { status: 503, headers: { "x-b2b-api-request-id": "req-9" } },
    ]);
    const err = await provider(impl).submit({ xml: XML, filename: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(EInvoiceProviderError);
    expect(err).toMatchObject({ kind: "unavailable", providerInvoiceId: "5", requestId: "req-9", message: B2BROUTER_MESSAGES.unavailable });
    expect(requests.filter((r) => r.url.includes("send_invoice"))).toHaveLength(2);
  });

  it("a transient send failure followed by success is a success", async () => {
    const { impl } = fakeFetch([
      { status: 201, body: { invoice: { id: 5, state: "new" } } },
      new Error("socket hang up"),
      { status: 204 },
      { status: 200, body: { invoice: { id: 5, state: "sent" } } },
    ]);
    expect(await provider(impl).submit({ xml: XML, filename: "x" })).toEqual({ providerInvoiceId: "5", state: "sent" });
  });

  it("does not retry a refused send (422) and carries the field error and the provider id", async () => {
    const { impl, requests } = fakeFetch([
      { status: 201, body: { invoice: { id: 5, state: "new" } } },
      { status: 422, body: { error: { code: "invalid_document", message: "BuyerReference missing", param: "buyer_reference", type: "invalid_request_error" } } },
    ]);
    const err = await provider(impl).submit({ xml: XML, filename: "x" }).catch((e) => e);
    expect(err).toMatchObject({ kind: "validation", providerInvoiceId: "5", fieldErrors: ["buyer_reference: BuyerReference missing"] });
    expect(err.message).toContain("BuyerReference missing");
    expect(requests.filter((r) => r.url.includes("send_invoice"))).toHaveLength(1);
  });

  it("maps a refused import to validation (no provider id), 401/403 to unauthorized, 429/5xx to unavailable", async () => {
    const p = provider(fakeFetch([{ status: 422, text: "not json" }]).impl);
    await expect(p.submit({ xml: XML, filename: "x" })).rejects.toMatchObject({ kind: "validation", providerInvoiceId: null });
    await expect(provider(fakeFetch([{ status: 401 }]).impl).submit({ xml: XML, filename: "x" })).rejects.toMatchObject({ kind: "unauthorized" });
    await expect(provider(fakeFetch([{ status: 403 }]).impl).checkKey()).rejects.toMatchObject({ kind: "unauthorized", message: B2BROUTER_MESSAGES.unauthorized });
    await expect(provider(fakeFetch([{ status: 429 }]).impl).getStatus("1")).rejects.toMatchObject({ kind: "unavailable" });
    await expect(provider(fakeFetch([{ status: 502 }]).impl).getStatus("1")).rejects.toMatchObject({ kind: "unavailable" });
    await expect(provider(fakeFetch([{ status: 200, text: "<html>" }]).impl).getStatus("1")).rejects.toMatchObject({ kind: "unexpected" });
  });

  it("refuses to import without an account id", async () => {
    const p = createB2BrouterProvider({ environment: "sandbox", apiKey: KEY, accountId: null }, { fetch: fakeFetch([]).impl });
    await expect(p.submit({ xml: XML, filename: "x" })).rejects.toMatchObject({ kind: "unexpected", message: B2BROUTER_MESSAGES.noAccount });
  });

  it("never puts the key in an error or a log line, even when the transport echoes it", async () => {
    const logs: unknown[] = [];
    const boom = new TypeError(`Header value "${KEY}" is invalid`);
    (boom as { cause?: unknown }).cause = { code: "ERR_INVALID_HEADER" };
    const { impl } = fakeFetch(() => boom);
    const err = await provider(impl, logs).checkKey().catch((e) => e);
    expect(err).toMatchObject({ kind: "unavailable", message: B2BROUTER_MESSAGES.unavailable });
    expect(JSON.stringify(err)).not.toContain(KEY);
    expect(err.cause).toBeUndefined();
    expect(JSON.stringify(logs)).not.toContain(KEY);
    expect(logs[0]).toMatchObject({ method: "GET", path: "/accounts", status: 0, body: "TypeError ERR_INVALID_HEADER" });
  });
});

describe("B2Brouter — reads", () => {
  it("checkKey answers with the first account's identifier and name, id as fallback", async () => {
    const { impl, requests } = fakeFetch([{ status: 200, body: { accounts: [{ id: 12, identifier: "nav-ab", name: "Nav AB", tin_value: "SE556000000101" }], meta: {} } }]);
    expect(await provider(impl).checkKey()).toEqual({ accountId: "nav-ab", accountName: "Nav AB", vatNumber: "SE556000000101" });
    expect(requests[0]!.url).toBe("https://api.b2brouter.net/accounts");
    // What the sandbox actually answers: a numeric id, no identifier.
    expect(await provider(fakeFetch([{ status: 200, body: { accounts: [{ id: 100001, name: "Nav AB", tin_scheme: "9955" }], total_count: 1 } }]).impl).checkKey()).toEqual({ accountId: "100001", accountName: "Nav AB", vatNumber: null });
    await expect(provider(fakeFetch([{ status: 200, body: { accounts: [] } }]).impl).checkKey()).rejects.toMatchObject({ message: B2BROUTER_MESSAGES.noAccount });
  });

  it("getStatus reads state, error and time", async () => {
    const { impl } = fakeFetch([
      { status: 200, body: { invoice: { id: 1, state: "error", error_message: "PEPPOL_NO_RECEIVER", state_updated_at: "2030-01-01T10:00:00Z" } } },
      { status: 200, body: { invoice: { id: 1, state: "registered", updated_at: "2030-01-02T10:00:00Z" } } },
    ]);
    const p = provider(impl);
    expect(await p.getStatus("1")).toEqual({ state: "error", errorMessage: "PEPPOL_NO_RECEIVER", updatedAt: "2030-01-01T10:00:00Z" });
    expect(await p.getStatus("1")).toEqual({ state: "registered", errorMessage: null, updatedAt: "2030-01-02T10:00:00Z" });
  });

  it("validate maps the validation result to status + messages", async () => {
    const { impl, requests } = fakeFetch([
      {
        status: 200,
        body: {
          validation_result: {
            status: "invalid",
            xsd: { status: "invalid", errors: [{ message: "Element 'ProfileI' is not expected" }] },
            sch: {
              status: "valid_with_warnings",
              errors: [],
              warnings: [{ code: "SE-R-003", category: "PEPPOL-EN16931-UBL.sch", message: "Luhn", property_path: "Invoice/AccountingSupplierParty" }],
            },
          },
        },
      },
    ]);
    expect(await provider(impl).validate!(XML)).toEqual({
      status: "invalid",
      errors: ["Element 'ProfileI' is not expected"],
      warnings: ["SE-R-003: Luhn (Invoice/AccountingSupplierParty)"],
    });
    expect(requests[0]!.url).toBe("https://api.b2brouter.net/documents/validate");
    expect((requests[0]!.init.headers as Record<string, string>)["Content-Type"]).toBe("application/octet-stream");
  });

  it("parses the error envelope leniently", () => {
    expect(parseErrorBody('{"error":{"code":"x","message":"m","param":"p","type":"t"}}')).toEqual({ code: "x", message: "m", param: "p" });
    expect(parseErrorBody('{"errors":["Cannot send invoice FA-1: Validering misslyckades: To use Peppol Network you need to configure this connection"]}')).toEqual({
      code: null,
      message: "Cannot send invoice FA-1: Validering misslyckades: To use Peppol Network you need to configure this connection",
      param: null,
    });
    expect(parseErrorBody('{"errors":[{"message":"a"},{"message":"b"}]}')).toEqual({ code: null, message: "a; b", param: null });
    expect(parseErrorBody("{}")).toEqual({ code: null, message: null, param: null });
    expect(parseErrorBody("nope")).toEqual({ code: null, message: null, param: null });
  });
});

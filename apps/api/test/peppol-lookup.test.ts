import { describe, expect, it } from "vitest";
import { B2BROUTER_MESSAGES, createB2BrouterProvider, LOOKUP_MAX_WAIT_MS, LOOKUP_POLL_INTERVAL_MS } from "../src/modules/einvoice/service/b2brouter-provider.js";

// Kontrollera mottagaren at the provider level: the directory is
// asynchronous (202 until it answered), and every outcome the access point
// documents — 200, 404, 422, 424 — plus the 10-second give-up.

function script(responses: { status: number; body?: unknown; headers?: Record<string, string> }[]) {
  const requests: string[] = [];
  const queue = [...responses];
  let clock = 0;
  const sleeps: number[] = [];
  const impl: typeof fetch = async (input) => {
    requests.push(String(input));
    const next = queue.shift();
    if (!next) throw new Error("no scripted response left");
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), { status: next.status, headers: next.headers ?? {} });
  };
  const provider = createB2BrouterProvider(
    { environment: "sandbox", apiKey: "test_k", accountId: null },
    {
      fetch: impl,
      log: () => {},
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
    }
  );
  return { provider, requests, sleeps };
}

const PROCESSING = { status: 202, body: { status: "processing", message: "Querying directory. Please retry this request.", polling_url: "https://api.b2brouter.net/directory/se/0007/5560000000" } };

describe("Peppol directory lookup", () => {
  it("repeats the same request after 202 until 200, and reads name and document types", async () => {
    const { provider, requests, sleeps } = script([
      PROCESSING,
      PROCESSING,
      {
        status: 200,
        body: {
          name: "Kund AB",
          invoice: { transport_type_code: "peppol", document_type_code: "xml.ubl.invoice.bis3" },
          credit_note: { transport_type_code: "peppol", document_type_code: "xml.ubl.credit_note.bis3" },
          order: null,
        },
      },
    ]);
    expect(await provider.lookupParticipant("0007", "5560000000")).toEqual({
      found: true,
      name: "Kund AB",
      documentTypes: ["invoice", "credit_note"],
      message: null,
    });
    expect(requests).toEqual(Array(3).fill("https://api.b2brouter.net/directory/se/0007/5560000000"));
    expect(sleeps).toEqual([LOOKUP_POLL_INTERVAL_MS, LOOKUP_POLL_INTERVAL_MS]);
  });

  it("404 after 202 = not in Peppol", async () => {
    const { provider } = script([PROCESSING, { status: 404 }]);
    expect(await provider.lookupParticipant("0007", "5560000000")).toEqual({ found: false, name: null, documentTypes: [], message: null });
  });

  it("422 = invalid identifier, answered as 'could not tell' with the reason", async () => {
    const { provider } = script([{ status: 422, body: { error: { code: "parameter_invalid", message: "Identifier is not valid for the requested scheme", type: "invalid_request_error" } } }]);
    expect(await provider.lookupParticipant("0007", "abc")).toMatchObject({ found: null, message: B2BROUTER_MESSAGES.directoryInvalid });
  });

  it("424 upstream_unavailable = try again; another 424 = the recipient's SMP is broken", async () => {
    const { provider } = script([
      PROCESSING,
      { status: 424, body: { error: { code: "upstream_unavailable", message: "Peppol directory unavailable" } }, headers: { "Retry-After": "900" } },
    ]);
    expect(await provider.lookupParticipant("0007", "5560000000")).toMatchObject({ found: null, message: B2BROUTER_MESSAGES.directoryUnavailable });
    const broken = script([{ status: 424, body: { error: { code: "no_exportable_doctypes", message: "The SMP does not publish any exportable invoice document types." } } }]);
    expect(await broken.provider.lookupParticipant("0007", "5560000000")).toMatchObject({ found: null, message: B2BROUTER_MESSAGES.directoryBroken });
  });

  it("gives up after ten seconds of 202", async () => {
    const { provider, requests } = script(Array(20).fill(PROCESSING));
    expect(await provider.lookupParticipant("0007", "5560000000")).toMatchObject({ found: null, message: B2BROUTER_MESSAGES.directoryUnavailable });
    expect(requests.length).toBe(LOOKUP_MAX_WAIT_MS / LOOKUP_POLL_INTERVAL_MS + 1);
  });

  it("a network failure or 5xx is 'could not tell', a refused key is an error", async () => {
    const down = createB2BrouterProvider(
      { environment: "sandbox", apiKey: "test_k", accountId: null },
      {
        fetch: async () => {
          throw new Error("ECONNREFUSED");
        },
        log: () => {},
      }
    );
    expect(await down.lookupParticipant("0007", "5560000000")).toMatchObject({ found: null, message: B2BROUTER_MESSAGES.directoryUnavailable });
    expect(await script([{ status: 503 }]).provider.lookupParticipant("0007", "5560000000")).toMatchObject({ found: null });
    await expect(script([{ status: 401 }]).provider.lookupParticipant("0007", "5560000000")).rejects.toMatchObject({ kind: "unauthorized" });
  });
});

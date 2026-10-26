import { describe, expect, it } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { aiInvoiceFieldsSchema } from "../src/modules/purchase/service/invoice-scan/ai-fields.js";
import { interpretAiAnswer } from "../src/modules/purchase/service/invoice-scan/ai-postprocess.js";
import {
  createClaudeInterpreter,
  parseAnswer,
  salvageHead,
  toInterpreterError,
  WIRE_JSON_SCHEMA,
} from "../src/modules/purchase/service/invoice-scan/claude-interpreter.js";
import { InvoiceInterpreterError } from "../src/modules/purchase/service/invoice-scan/invoice-interpreter.js";
import type { CompanyIdentity, SupplierIdentity } from "../src/modules/purchase/service/invoice-scan/rules-interpreter.js";
import { emailAddress, senderAllowsAutomaticAi } from "../src/modules/purchase/service/invoice-scan/sender-rule.js";
import { sampleAiFields } from "./helpers/fake-invoice-interpreter.js";
import { FAKE_BUYER, FAKE_OCR, FAKE_SUPPLIER } from "./helpers/invoice-pdf.js";

// Fakturaskanning steg 2 — the pure parts of the AI interpretation: the
// local checks on the AI's answer (confidence only lowered), the Claude
// wire format and its request shape against a fake fetch (never the
// network), the SDK error mapping, and avsändarregeln. All data is made up.

const TODAY = "2026-10-15";
const company: CompanyIdentity = {
  name: FAKE_BUYER.name,
  orgNumber: FAKE_BUYER.orgNumber,
  vatNumber: FAKE_BUYER.vatNumber,
  bankgiro: FAKE_BUYER.bankgiro,
  plusgiro: null,
  iban: null,
  postalCode: FAKE_BUYER.postalCode,
};
const SUPPLIER_ID = "00000000-0000-4000-8000-000000000001";
const supplier: SupplierIdentity = {
  id: SUPPLIER_ID,
  name: FAKE_SUPPLIER.name,
  orgNumber: FAKE_SUPPLIER.orgNumber,
  vatNumber: null,
  bankgiro: null,
  plusgiro: null,
  iban: null,
  currency: "SEK",
  country: "SE",
};

function run(overrides: Parameters<typeof sampleAiFields>[0] = {}, suppliers: SupplierIdentity[] = [supplier]) {
  return interpretAiAnswer({
    fields: sampleAiFields({ invoiceDate: { value: TODAY, confidence: "high" }, ...overrides }),
    company,
    suppliers,
    today: TODAY,
    lines: [],
  });
}

describe("interpretAiAnswer — the AI's answer through the local checks", () => {
  it("keeps a consistent answer as the AI read it, matches the supplier locally and marks the source", () => {
    const result = run();
    expect(result.supplier).toMatchObject({ matchedSupplierId: SUPPLIER_ID, matchedBy: "org_number", confidence: "high" });
    expect(result.supplier.name).toEqual({ value: FAKE_SUPPLIER.name, confidence: "high", source: "supplier" });
    expect(result.invoiceNumber).toEqual({ value: "AI-4711", confidence: "high", source: "ai" });
    expect(result.grossAmount).toEqual({ value: 1250, confidence: "high", source: "ai" });
    expect(result.netAmount.confidence).toBe("high");
    expect(result.vatRate).toEqual({ value: 25, confidence: "high", source: "ai" });
    expect(result.paymentReference).toEqual({ value: { kind: "ocr", value: FAKE_OCR }, confidence: "high", source: "ai" });
    expect(result.currency).toEqual({ value: "SEK", confidence: "high", source: "ai" });
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({ description: "Plåt 2 mm", articleId: null, purchaseOrderRowId: null, confidence: "high" });
    expect(result.checks).toEqual([]);
  });

  it("never raises the AI's own low confidence", () => {
    const result = run({ invoiceNumber: { value: "AI-4711", confidence: "low" }, grossAmount: { value: 1250, confidence: "low" } });
    expect(result.invoiceNumber.confidence).toBe("low");
    expect(result.grossAmount.confidence).toBe("low");
    expect(result.netAmount.confidence).toBe("high");
  });

  it("lowers the three amounts when net + VAT is not the amount to pay", () => {
    const result = run({ grossAmount: { value: 1300, confidence: "high" } });
    expect([result.netAmount.confidence, result.vatAmount.confidence, result.grossAmount.confidence]).toEqual(["low", "low", "low"]);
    expect(result.checks).toContain("Netto + moms stämmer inte med att betala (diff 50,00)");
  });

  it("lowers an implausible invoice date and a due date before it", () => {
    const result = run({ invoiceDate: { value: "2024-01-10", confidence: "high" }, dueDate: { value: "2023-12-01", confidence: "high" } });
    expect(result.invoiceDate).toEqual({ value: "2024-01-10", confidence: "low", source: "ai" });
    expect(result.dueDate.confidence).toBe("low");
    expect(result.checks.some((c) => c.startsWith("Fakturadatumet 2024-01-10"))).toBe(true);
  });

  it("drops a date that is not a real date", () => {
    const result = run({ dueDate: { value: "2026-02-30", confidence: "high" } });
    expect(result.dueDate.value).toBeNull();
    expect(result.checks).toContain("Förfallodagen 2026-02-30 är inget giltigt datum — fyll i det för hand");
  });

  it("turns an OCR without a valid check digit into a low message", () => {
    const result = run({ paymentReference: { value: "471100017", kind: "ocr", confidence: "high" } });
    expect(result.paymentReference).toEqual({ value: { kind: "message", value: "471100017" }, confidence: "low", source: "ai" });
  });

  it("never matches on an identifier whose check digit fails, and says so", () => {
    const fields = sampleAiFields().supplier;
    const result = run({ supplier: { ...fields, orgNumber: { value: "559900-1237", confidence: "high" }, vatNumber: { value: null, confidence: "low" } } }, [
      { ...supplier, orgNumber: "559900-1237" },
    ]);
    expect(result.supplier.orgNumber).toEqual({ value: "559900-1237", confidence: "low", source: "ai" });
    // The name still finds it — as low, like the rules.
    expect(result.supplier).toMatchObject({ matchedSupplierId: SUPPLIER_ID, matchedBy: "name", confidence: "low" });
    expect(result.checks).toContain("Leverantörens organisationsnummer 559900-1237 är inte giltigt — kontrollera det mot fakturan");
  });

  it("drops the company's own identifiers the AI returned as the supplier's", () => {
    const fields = sampleAiFields().supplier;
    const result = run(
      {
        supplier: {
          ...fields,
          name: { value: "Okänd Säljare AB", confidence: "high" },
          orgNumber: { value: FAKE_BUYER.orgNumber, confidence: "high" },
          vatNumber: { value: FAKE_BUYER.vatNumber, confidence: "high" },
          bankgiro: { value: FAKE_BUYER.bankgiro, confidence: "high" },
        },
      },
      // A supplier that happens to carry the buyer's number must not match.
      [{ ...supplier, orgNumber: FAKE_BUYER.orgNumber, name: "Någon Annan AB" }]
    );
    expect(result.supplier.matchedSupplierId).toBeNull();
    expect(result.supplier.orgNumber.value).toBeNull();
    expect(result.checks).toContain("AI-tolkningen angav ert eget organisationsnummer som leverantörens — det används inte");
  });

  it("makes a credit note's amounts negative", () => {
    const result = run({ isCreditNote: { value: true, confidence: "high" } });
    expect([result.netAmount.value, result.vatAmount.value, result.grossAmount.value]).toEqual([-1000, -250, -1250]);
    expect(result.isCreditNote.value).toBe(true);
  });

  it("lowers a VAT rate that disagrees with the amounts", () => {
    const result = run({ vatRate: { value: 12, confidence: "high" } });
    expect(result.vatRate).toEqual({ value: 12, confidence: "low", source: "ai" });
  });

  it("gives the supplier's currency, low with a check when the invoice says another", () => {
    const result = run({ currency: { value: "EUR", confidence: "high" } });
    expect(result.currency).toEqual({ value: "SEK", confidence: "low", source: "supplier" });
  });

  it("lowers a row whose quantity × price is not its amount", () => {
    const rows = sampleAiFields().rows;
    const result = run({ rows: [{ ...rows[0]!, lineAmount: 650 }, rows[1]!] });
    expect(result.rows[0]!.confidence).toBe("low");
    expect(result.checks.some((c) => /^Radernas summa 1\s050,00 stämmer inte med nettot 1\s000,00$/u.test(c))).toBe(true);
  });

  it("produces a result the shared schema accepts", async () => {
    const { invoiceScanResultSchema } = await import("@navet/shared");
    expect(invoiceScanResultSchema.safeParse(run()).success).toBe(true);
    expect(invoiceScanResultSchema.safeParse(run({}, [])).success).toBe(true);
  });
});

describe("the Claude wire format", () => {
  const wire = (over: Record<string, unknown> = {}) => {
    const t = (value: unknown, confidence = "high") => ({ value, confidence });
    return {
      supplier: Object.fromEntries(
        ["name", "orgNumber", "vatNumber", "bankgiro", "plusgiro", "iban", "bic", "address", "postalCode", "city", "country"].map((k) => [
          k,
          k === "name" ? t(FAKE_SUPPLIER.name) : k === "orgNumber" ? t(FAKE_SUPPLIER.orgNumber) : t("", "missing"),
        ])
      ),
      invoiceNumber: t("AI-4711"),
      invoiceDate: t(TODAY),
      dueDate: t("", "missing"),
      currency: t("SEK"),
      netAmount: t(1000),
      vatAmount: t(250),
      grossAmount: t(1250),
      vatRate: t(0, "missing"),
      paymentReference: { value: FAKE_OCR, kind: "ocr", confidence: "high" },
      isCreditNote: t(false),
      purchaseOrderReference: t("", "missing"),
      rows: [{ description: "Plåt", quantity: 0, unitPrice: 0, lineAmount: 1000, vatRate: -1, supplierArticleNumber: "", confidence: "low" }],
      ...over,
    };
  };

  it("turns missing values into nulls and validates as the seam's fields", () => {
    const fields = parseAnswer(JSON.stringify(wire()));
    expect(fields).not.toBeNull();
    expect(aiInvoiceFieldsSchema.safeParse(fields).success).toBe(true);
    expect(fields!.dueDate).toEqual({ value: null, confidence: "low" });
    expect(fields!.vatRate.value).toBeNull();
    expect(fields!.rows[0]).toEqual({
      description: "Plåt",
      quantity: null,
      unitPrice: null,
      lineAmount: 1000,
      vatRate: null,
      supplierArticleNumber: null,
      confidence: "low",
    });
  });

  it("rejects an answer that is not the wire format", () => {
    expect(parseAnswer("not json")).toBeNull();
    expect(parseAnswer(JSON.stringify({ ...wire(), invoiceNumber: { value: 4711, confidence: "high" } }))).toBeNull();
  });

  it("salvages the head fields of an answer cut off inside the rows", () => {
    const text = JSON.stringify(wire());
    const cut = text.slice(0, text.indexOf('"description"') + 8);
    expect(parseAnswer(cut)).toBeNull();
    const head = salvageHead(cut);
    expect(head?.grossAmount).toEqual({ value: 1250, confidence: "high" });
    expect(head?.rows).toEqual([]);
    expect(salvageHead(text.slice(0, 40))).toBeNull();
  });

  it("has no nullable unions and no optional properties (structured-output limits)", () => {
    const json = JSON.stringify(WIRE_JSON_SCHEMA);
    expect(json).not.toContain("anyOf");
    expect(json).not.toContain('"null"');
    const walk = (node: unknown): void => {
      if (!node || typeof node !== "object") return;
      const obj = node as { type?: string; properties?: Record<string, unknown>; required?: string[]; additionalProperties?: boolean; items?: unknown };
      if (obj.type === "object") {
        expect(obj.additionalProperties).toBe(false);
        expect([...(obj.required ?? [])].sort()).toEqual(Object.keys(obj.properties ?? {}).sort());
      }
      Object.values(obj.properties ?? {}).forEach(walk);
      walk(obj.items);
    };
    walk(WIRE_JSON_SCHEMA);
    // rows last: an answer cut off at max_tokens keeps the head fields.
    expect(Object.keys(WIRE_JSON_SCHEMA.properties).at(-1)).toBe("rows");
  });

  function fakeFetch(answer: { status?: number; body: unknown }) {
    const requests: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      requests.push({ url, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body ?? "{}")) });
      return new Response(JSON.stringify(answer.body), {
        status: answer.status ?? 200,
        headers: { "content-type": "application/json", "request-id": "req_test" },
      });
    }) as typeof fetch;
    return { fetchImpl, requests };
  }

  const message = (text: string, stop_reason: string, content?: unknown[]) => ({
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: content ?? [{ type: "text", text }],
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10 },
  });

  const file = { contentType: "application/pdf" as const, data: Buffer.from("%PDF-1.7 test") };
  const context = { companyName: FAKE_BUYER.name, companyOrgNumber: FAKE_BUYER.orgNumber, today: TODAY };

  it("sends the PDF as a document block before the text, with structured output, medium effort and the refusal fallback", async () => {
    const { fetchImpl, requests } = fakeFetch({ body: message(JSON.stringify(wire()), "end_turn") });
    const interpreter = createClaudeInterpreter({ apiKey: "sk-test", model: "claude-opus-5-5" }, { fetch: fetchImpl });
    const answer = await interpreter.interpret(file, context);
    expect(answer.truncated).toBe(false);
    expect(answer.fields.invoiceNumber.value).toBe("AI-4711");
    const [req] = requests;
    expect(req!.url).toMatch(/\/v1\/messages(\?|$)/);
    expect(req!.headers.get("anthropic-beta")).toContain("server-side-fallback-2026-07-01");
    expect(req!.headers.get("x-api-key")).toBe("sk-test");
    expect(req!.body).toMatchObject({
      model: "claude-opus-5-5",
      max_tokens: 16000,
      fallbacks: "default",
      output_config: { effort: "medium", format: { type: "json_schema" } },
    });
    expect(req!.body).not.toHaveProperty("temperature");
    expect(req!.body).not.toHaveProperty("tools");
    const content = (req!.body.messages as { content: { type: string; source?: { media_type: string } }[] }[])[0]!.content;
    expect(content.map((b) => b.type)).toEqual(["document", "text"]);
    expect(content[0]!.source!.media_type).toBe("application/pdf");
    expect(JSON.stringify(content[1])).toContain(FAKE_BUYER.orgNumber);
  });

  it("sends a photo as an image block and no fallback for Haiku", async () => {
    const { fetchImpl, requests } = fakeFetch({ body: message(JSON.stringify(wire()), "end_turn") });
    const interpreter = createClaudeInterpreter({ apiKey: "sk-test", model: "claude-haiku-5-5" }, { fetch: fetchImpl });
    await interpreter.interpret({ contentType: "image/jpeg", data: Buffer.from([0xff, 0xd8, 0xff]) }, context);
    const content = (requests[0]!.body.messages as { content: { type: string }[] }[])[0]!.content;
    expect(content.map((b) => b.type)).toEqual(["image", "text"]);
    expect(requests[0]!.body).not.toHaveProperty("fallbacks");
    expect(requests[0]!.headers.get("anthropic-beta") ?? "").not.toContain("server-side-fallback");
  });

  it("reports a refusal", async () => {
    const { fetchImpl } = fakeFetch({ body: message("", "refusal", []) });
    const interpreter = createClaudeInterpreter({ apiKey: "sk-test", model: "claude-opus-5-5" }, { fetch: fetchImpl });
    await expect(interpreter.interpret(file, context)).rejects.toMatchObject({ kind: "refusal" });
  });

  it("returns the head fields of an answer cut off at max_tokens", async () => {
    const text = JSON.stringify(wire());
    const { fetchImpl } = fakeFetch({ body: message(text.slice(0, text.indexOf('"rows"') + 12), "max_tokens") });
    const interpreter = createClaudeInterpreter({ apiKey: "sk-test", model: "claude-opus-5-5" }, { fetch: fetchImpl });
    const answer = await interpreter.interpret(file, context);
    expect(answer).toMatchObject({ truncated: true, fields: { rows: [], grossAmount: { value: 1250 } } });
  });

  it("maps a rejected key to unauthorized without the provider's text", async () => {
    const { fetchImpl } = fakeFetch({ status: 401, body: { type: "error", error: { type: "authentication_error", message: "invalid x-api-key sk-secret" } } });
    const interpreter = createClaudeInterpreter({ apiKey: "sk-test", model: "claude-opus-5-5" }, { fetch: fetchImpl });
    const err = await interpreter.testConnection().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvoiceInterpreterError);
    expect(err).toMatchObject({ kind: "unauthorized" });
    expect(String((err as Error).message)).not.toContain("sk-secret");
  });

  it("maps the SDK's error classes most specific first", () => {
    const gen = (status: number) => Anthropic.APIError.generate(status, { type: "error" }, "provider text", new Headers());
    expect(toInterpreterError(gen(401)).kind).toBe("unauthorized");
    expect(toInterpreterError(gen(403)).kind).toBe("unauthorized");
    expect(toInterpreterError(gen(404)).kind).toBe("model_unavailable");
    expect(toInterpreterError(gen(429)).kind).toBe("rate_limited");
    expect(toInterpreterError(gen(529)).kind).toBe("rate_limited");
    expect(toInterpreterError(gen(400)).kind).toBe("bad_request");
    expect(toInterpreterError(gen(413)).kind).toBe("bad_request");
    expect(toInterpreterError(gen(500)).kind).toBe("unavailable");
    expect(toInterpreterError(new Anthropic.APIConnectionTimeoutError()).kind).toBe("unavailable");
    expect(toInterpreterError(new Anthropic.APIConnectionError({ message: "x" })).kind).toBe("unavailable");
    expect(toInterpreterError(new Error("boom")).kind).toBe("unexpected");
    expect(toInterpreterError(gen(401)).detail).toBe("AuthenticationError 401");
  });
});

describe("avsändarregeln", () => {
  const known = ["faktura@platgrossisten.example", "Inköp <inkop@navtest.example>", "kalle@gmail.com", null];

  it("reads the address out of a From header", () => {
    expect(emailAddress("Plåtgrossisten <Faktura@Platgrossisten.Example>")).toBe("faktura@platgrossisten.example");
    expect(emailAddress("not an address")).toBeNull();
  });

  it("lets a known domain through and nothing else", () => {
    expect(senderAllowsAutomaticAi("Ekonomi <ekonomi@platgrossisten.example>", known)).toBe(true);
    expect(senderAllowsAutomaticAi("bob@navtest.example", known)).toBe(true);
    expect(senderAllowsAutomaticAi("offers@reklam.example", known)).toBe(false);
    expect(senderAllowsAutomaticAi(null, known)).toBe(false);
  });

  it("needs the exact address on a public mail provider", () => {
    expect(senderAllowsAutomaticAi("Kalle <kalle@gmail.com>", known)).toBe(true);
    expect(senderAllowsAutomaticAi("spam@gmail.com", known)).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { INVOICE_SCAN_AI_MODELS, INVOICE_SCAN_AI_MODEL_DEFAULT, type InvoiceScanAiModel } from "@navet/shared";
import { createClaudeInterpreter } from "../src/modules/purchase/service/invoice-scan/claude-interpreter.js";
import { interpretAiAnswer } from "../src/modules/purchase/service/invoice-scan/ai-postprocess.js";
import { FAKE_BUYER, FAKE_OCR, FAKE_SUPPLIER, invoicePdf } from "./helpers/invoice-pdf.js";

// Röktest mot Anthropics API — körs bara när ANTHROPIC_SANDBOX_API_KEY
// finns i miljön (en egen nyckel, aldrig i repot); annars hoppas hela filen
// över och sviten gör inga riktiga anrop. Modellen är förvalet
// (claude-opus-5-5) om inte ANTHROPIC_SANDBOX_MODEL anger en annan ur
// listan. Fakturan är den påhittade pdfkit-fakturan i helpers/invoice-pdf.ts.
const KEY = process.env.ANTHROPIC_SANDBOX_API_KEY;
const requested = process.env.ANTHROPIC_SANDBOX_MODEL;
const MODEL: InvoiceScanAiModel = (INVOICE_SCAN_AI_MODELS as readonly string[]).includes(requested ?? "")
  ? (requested as InvoiceScanAiModel)
  : INVOICE_SCAN_AI_MODEL_DEFAULT;
const TODAY = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Stockholm" });

describe.skipIf(!KEY)(`Claude-tolkningen mot API:t (${MODEL})`, () => {
  it("godkänner nyckeln (Testa anslutning)", async () => {
    await createClaudeInterpreter({ apiKey: KEY!, model: MODEL }).testConnection();
  }, 60_000);

  it("avvisar en ogiltig nyckel som unauthorized", async () => {
    await expect(createClaudeInterpreter({ apiKey: "sk-ant-invalid", model: MODEL }).testConnection()).rejects.toMatchObject({ kind: "unauthorized" });
  }, 60_000);

  it("läser den påhittade fakturan och klarar de lokala kontrollerna", async () => {
    const pdf = await invoicePdf({ invoiceDate: TODAY });
    const answer = await createClaudeInterpreter({ apiKey: KEY!, model: MODEL }).interpret(
      { contentType: "application/pdf", data: pdf },
      { companyName: FAKE_BUYER.name, companyOrgNumber: FAKE_BUYER.orgNumber, today: TODAY }
    );
    expect(answer.truncated).toBe(false);
    expect(answer.fields.invoiceNumber.value).toBe("10045");
    expect(answer.fields.grossAmount.value).toBe(1250);
    expect(answer.fields.supplier.orgNumber.value?.replace(/\D/g, "")).toBe(FAKE_SUPPLIER.orgNumber.replace(/\D/g, ""));

    const result = interpretAiAnswer({
      fields: answer.fields,
      company: { name: FAKE_BUYER.name, orgNumber: FAKE_BUYER.orgNumber, vatNumber: FAKE_BUYER.vatNumber, bankgiro: FAKE_BUYER.bankgiro, plusgiro: null, iban: null, postalCode: FAKE_BUYER.postalCode },
      suppliers: [
        { id: "00000000-0000-4000-8000-000000000001", name: FAKE_SUPPLIER.name, orgNumber: FAKE_SUPPLIER.orgNumber, vatNumber: null, bankgiro: null, plusgiro: null, iban: null, currency: "SEK", country: "SE" },
      ],
      today: TODAY,
      lines: [],
    });
    expect(result.supplier.matchedBy).toBe("org_number");
    expect(result.grossAmount.value).toBe(1250);
    expect(result.paymentReference.value).toEqual({ kind: "ocr", value: FAKE_OCR });
  }, 180_000);
});

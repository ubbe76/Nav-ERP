import { describe, expect, it } from "vitest";
import { createB2BrouterProvider } from "../src/modules/einvoice/service/b2brouter-provider.js";
import { mapProviderState } from "../src/modules/einvoice/service/einvoice-status.js";
import { buildUblDocument } from "../src/modules/einvoice/service/ubl/ubl-invoice-builder.js";
import type { UblInvoiceInput } from "../src/modules/einvoice/service/ubl/ubl-types.js";
import { computeOcrNumber } from "../src/modules/system/service/ocr.js";

// Röktest mot B2Brouters sandlåda — körs bara när B2BROUTER_SANDBOX_API_KEY
// finns i miljön (en test_-nyckel från Developers i B2Brouter-kontot, aldrig
// i repot). Sandlådans utfall styrs av mottagaren (GLN, schema 0088):
// 9508397101047 ⇒ registered, 9506215594996 ⇒ refused, 9500047420799 ⇒
// error PEPPOL_NO_RECEIVER. Verifierar också att importen tar rå XML.
const KEY = process.env.B2BROUTER_SANDBOX_API_KEY;

const RECIPIENTS = [
  { gln: "9508397101047", expected: "delivered" },
  { gln: "9506215594996", expected: "rejected" },
  { gln: "9500047420799", expected: "failed" },
] as const;

// Invented, Luhn-valid identifiers (public repo: never the real account's) —
// except the seller's VAT/org number, which B2Brouter requires to be the
// account's own (422 "do not belong to your companies" otherwise); it is
// read from the account at run time and never written down here.
function sampleInvoice(gln: string, n: number, seller: { vatNumber: string; orgNumber: string }): UblInvoiceInput {
  const invoiceNumber = `FA-${String(Date.now()).slice(-7)}${n}`;
  return {
    type: "invoice",
    invoiceNumber,
    issueDate: new Date().toISOString().slice(0, 10),
    dueDate: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10),
    currency: "SEK",
    buyerReference: "Testköpare",
    orderReference: null,
    creditedInvoiceNumber: null,
    note: null,
    paymentTermsNote: "30 dagar netto",
    seller: {
      name: "Nav Test AB",
      orgNumber: seller.orgNumber,
      vatNumber: seller.vatNumber,
      address: { addressLines: ["Fabriksvägen 1"], postalCode: "41107", city: "Göteborg", country: "SE" },
      email: "faktura@navtest.example",
      phone: null,
      fSkatt: true,
    },
    buyer: {
      endpoint: { scheme: "0088", value: gln },
      name: "Testmottagare AB",
      address: { addressLines: ["Kundgatan 1"], postalCode: "11151", city: "Stockholm", country: "SE" },
      orgNumber: "5565555553",
      vatNumber: "SE556555555301",
      customerNumber: "1001",
    },
    payment: { account: { kind: "bankgiro", account: "50501055" }, ocrNumber: computeOcrNumber(invoiceNumber) },
    lines: [
      {
        lineNumber: 1,
        description: "Diskbänk",
        articleNumber: "DB-100",
        quantity: 2,
        unitCode: "st",
        unitPrice: 500,
        discountPercent: 0,
        lineAmount: 1000,
        vatAmount: 250,
        vatRate: 25,
        orderLineReference: null,
        properties: [],
      },
    ],
    attachment: null,
  };
}

describe.skipIf(!KEY)("B2Brouter-sandlådan", () => {
  it("checks the key, validates a built document, sends to the three test recipients and polls", async () => {
    const probe = createB2BrouterProvider({ environment: "sandbox", apiKey: KEY!, accountId: null });
    const account = await probe.checkKey();
    expect(account.accountId).toBeTruthy();
    expect(account.vatNumber, "kontot saknar momsregistreringsnummer (tin_value)").toMatch(/^SE\d{12}$/);
    const seller = { vatNumber: account.vatNumber!, orgNumber: account.vatNumber!.slice(2, 12) };
    const p = createB2BrouterProvider({ environment: "sandbox", apiKey: KEY!, accountId: account.accountId });

    const validation = await p.validate!(Buffer.from(buildUblDocument(sampleInvoice("9508397101047", 0, seller)), "utf8"));
    expect(["valid", "valid_with_warnings"], validation.errors.join("\n")).toContain(validation.status);
    if (validation.warnings.length > 0) console.log("B2Brouter validation warnings:", validation.warnings);

    const sent = await Promise.all(
      RECIPIENTS.map((r, i) => p.submit({ xml: Buffer.from(buildUblDocument(sampleInvoice(r.gln, i + 1, seller)), "utf8"), filename: `sandbox-${i}.xml` }))
    );
    for (const [i, r] of RECIPIENTS.entries()) {
      let status = mapProviderState(sent[i]!.state);
      for (let tries = 0; tries < 20 && (status === "sending" || status === "sent"); tries++) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        status = mapProviderState((await p.getStatus(sent[i]!.providerInvoiceId)).state);
      }
      expect(status, `mottagare ${r.gln}`).toBe(r.expected);
    }
  }, 180_000);
});

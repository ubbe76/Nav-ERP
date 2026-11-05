import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  DERIVED_PEPPOL_COUNTRIES,
  derivedPeppolId,
  identifierProblem,
  normalizedOrgNumber,
  orgNumberScheme,
} from "../src/modules/einvoice/service/peppol-schemes.js";
import { lineVatCategory, isOutOfScopeVatCode } from "../src/modules/einvoice/service/ubl/vat-categories.js";
import { buildUblInvoice, buildUblCreditNote } from "../src/modules/einvoice/service/ubl/ubl-invoice-builder.js";
import { checkUblInput } from "../src/modules/einvoice/service/ubl/ubl-check.js";
import { verifyWebhookSignature } from "../src/modules/einvoice/service/einvoice-webhook.service.js";
import { webhookUrlFor } from "../src/modules/einvoice/service/einvoice-settings.service.js";
import { creditNote, euGoodsEur, euServicesDkk, exportGoodsNok, invoiceTwoRatesDiscount, servicesOutsideEuUsd, swedishVatInEur } from "./helpers/ubl-fixtures.js";

// E-faktura etapp 2a (spec 2026-11-05-e-faktura-utland-automatik): the pure
// parts — Peppol schemes per country, the categories of the EU and export
// codes, what the builder writes for foreign customers and currencies, what
// ubl-check refuses, and the web hook's signature.

describe("Peppol schemes per country", () => {
  it("derives SE 0007, NO 0192, DK 0184 and BE 0208 from the organisation number, nothing elsewhere", () => {
    expect(derivedPeppolId("SE", "556677-8899")).toBe("0007:5566778899");
    expect(derivedPeppolId("NO", "987 654 325")).toBe("0192:987654325");
    expect(derivedPeppolId("DK", "DK 12 34 56 74")).toBe("0184:12345674");
    expect(derivedPeppolId("BE", "0412.345.614")).toBe("0208:0412345614");
    expect(derivedPeppolId("be", "412345614")).toBe("0208:0412345614");
    expect(derivedPeppolId("BE", "2412345614")).toBeNull();
    expect(derivedPeppolId("NO", "12345")).toBeNull();
    expect(derivedPeppolId("DE", "HRB 12345")).toBeNull();
    expect(derivedPeppolId("FI", "1234567-8")).toBeNull();
    expect(derivedPeppolId("SE", null)).toBeNull();
    expect(orgNumberScheme("DE")).toBeNull();
    expect(normalizedOrgNumber("SE", "16556677-8899")).toBe("5566778899");
  });

  it("the customer card's hint names the same countries and schemes as the rule", () => {
    // The web cannot import the API; its hint table is read as text.
    const web = readFileSync(new URL("../../web/components/partners/PeppolFields.tsx", import.meta.url), "utf8");
    const table = [...web.matchAll(/^\s+([A-Z]{2}): \{ scheme: "(\d{4})"/gm)].map((m) => [m[1], m[2]]);
    expect(table).toEqual(DERIVED_PEPPOL_COUNTRIES.map((c) => [c, orgNumberScheme(c)]));
  });

  it("checks format and check digit per scheme (PEPPOL-COMMON-R040..R049), unknown schemes pass", () => {
    expect(identifierProblem("0007", "5566778899")).toBeNull();
    expect(identifierProblem("0007", "5566778890")).not.toBeNull();
    expect(identifierProblem("0088", "0614141000012")).toBeNull();
    expect(identifierProblem("0088", "0614141000013")).not.toBeNull();
    expect(identifierProblem("0192", "987654325")).toBeNull();
    expect(identifierProblem("0192", "987654326")).not.toBeNull();
    expect(identifierProblem("0192", "000000000")).not.toBeNull();
    expect(identifierProblem("0208", "0412345614")).toBeNull();
    expect(identifierProblem("0208", "0412345613")).not.toBeNull();
    expect(identifierProblem("0184", "12345674")).toBeNull();
    expect(identifierProblem("0184", "DK12345674")).toBeNull();
    expect(identifierProblem("0184", "DK1234567")).not.toBeNull();
    expect(identifierProblem("9930", "anything")).toBeNull();
  });
});

describe("momskoder for foreign trade", () => {
  it("maps EUV ⇒ K, EUT ⇒ AE, EXV ⇒ G, EXT ⇒ O with their VATEX codes and the code's text, falling back per language", () => {
    expect(lineVatCategory({ vatRate: 0, vatCode: "EUV", vatExemptionText: "Unionsintern leverans" })).toEqual({
      id: "K",
      percent: 0,
      exemptionReasonCode: "VATEX-EU-IC",
      exemptionReason: "Unionsintern leverans",
    });
    expect(lineVatCategory({ vatRate: 0, vatCode: "EUT", vatExemptionText: null }, "en")).toMatchObject({ id: "AE", exemptionReasonCode: "VATEX-EU-AE", exemptionReason: "Reverse charge" });
    expect(lineVatCategory({ vatRate: 0, vatCode: "EXV", vatExemptionText: " " }, "en")).toMatchObject({ id: "G", exemptionReasonCode: "VATEX-EU-G", exemptionReason: "Export outside the EU" });
    expect(lineVatCategory({ vatRate: 0, vatCode: "EXT", vatExemptionText: null })).toMatchObject({ id: "O", exemptionReasonCode: "VATEX-EU-O" });
    expect(lineVatCategory({ vatRate: 0, vatCode: null }, "en")).toMatchObject({ id: "E", exemptionReason: "Exempt from VAT" });
    expect(() => lineVatCategory({ vatRate: 0, vatCode: "UTM" })).toThrow(/Unsupported VAT code UTM/);
    expect(() => lineVatCategory({ vatRate: 25, vatCode: "EUV" })).toThrow(/Unsupported VAT code EUV/);
    expect(isOutOfScopeVatCode("EXT")).toBe(true);
    expect(isOutOfScopeVatCode("EXV")).toBe(false);
  });
});

describe("UBL builder — foreign customers and currencies", () => {
  it("writes the invoice's currency on every amount, the buyer's country and its register number with the country's scheme", () => {
    const xml = buildUblInvoice(exportGoodsNok());
    expect(xml).toContain("<cbc:DocumentCurrencyCode>NOK</cbc:DocumentCurrencyCode>");
    expect(xml).not.toContain('currencyID="SEK"');
    expect(xml).not.toContain("TaxCurrencyCode");
    expect(xml).toContain('<cbc:EndpointID schemeID="0192">987654325</cbc:EndpointID>');
    expect(xml).toContain('<cbc:CompanyID schemeID="0192">987654325</cbc:CompanyID>');
    expect(xml).toContain("<cbc:IdentificationCode>NO</cbc:IdentificationCode>");
    expect(xml).toContain("<cbc:ID>G</cbc:ID><cbc:Percent>0</cbc:Percent><cbc:TaxExemptionReasonCode>VATEX-EU-G</cbc:TaxExemptionReasonCode>");
    // IBAN outside the euro ⇒ credit transfer 30; English attachment text.
    expect(xml).toContain("<cbc:PaymentMeansCode>30</cbc:PaymentMeansCode>");
    expect(xml).toContain("<cbc:DocumentDescription>Invoice (PDF)</cbc:DocumentDescription>");
    // F-skatt stays Swedish on an English invoice (SE-R-005).
    expect(xml).toContain("<cbc:CompanyID>Godkänd för F-skatt</cbc:CompanyID>");
  });

  it("an intra-community supply carries the delivery date and country (BR-IC-11/12), SEPA code 58 in EUR, and the discount reason in English", () => {
    const xml = buildUblInvoice(euGoodsEur());
    expect(xml).toContain(
      "<cac:Delivery><cbc:ActualDeliveryDate>2026-11-03</cbc:ActualDeliveryDate><cac:DeliveryLocation><cac:Address><cac:Country><cbc:IdentificationCode>DE</cbc:IdentificationCode></cac:Country></cac:Address></cac:DeliveryLocation></cac:Delivery>"
    );
    expect(xml).toContain("<cbc:ID>K</cbc:ID><cbc:Percent>0</cbc:Percent><cbc:TaxExemptionReasonCode>VATEX-EU-IC</cbc:TaxExemptionReasonCode>");
    expect(xml).toContain("<cbc:PaymentMeansCode>58</cbc:PaymentMeansCode>");
    expect(xml).toContain("<cbc:AllowanceChargeReason>Discount</cbc:AllowanceChargeReason>");
    // No scheme known for Germany: no registration number is written.
    expect(xml).not.toMatch(/<cac:PartyLegalEntity><cbc:RegistrationName>Beispiel Metall GmbH<\/cbc:RegistrationName><cbc:CompanyID/);
  });

  it("services to the EU are reverse charge (AE) with the buyer's VAT number and the 0184 registration number", () => {
    const xml = buildUblInvoice(euServicesDkk());
    expect(xml).toContain("<cbc:ID>AE</cbc:ID><cbc:Percent>0</cbc:Percent><cbc:TaxExemptionReasonCode>VATEX-EU-AE</cbc:TaxExemptionReasonCode><cbc:TaxExemptionReason>Reverse charge (Article 196 of the VAT Directive)</cbc:TaxExemptionReason>");
    expect(xml).toContain("<cac:PartyTaxScheme><cbc:CompanyID>DK12345674</cbc:CompanyID>");
    expect(xml).toContain('<cbc:CompanyID schemeID="0184">12345674</cbc:CompanyID>');
  });

  it("services outside the EU are O: no rate, and neither party's VAT number (BR-O-02)", () => {
    const xml = buildUblInvoice(servicesOutsideEuUsd());
    expect(xml).toContain("<cbc:ID>O</cbc:ID><cbc:TaxExemptionReasonCode>VATEX-EU-O</cbc:TaxExemptionReasonCode>");
    expect(xml).toContain("<cac:ClassifiedTaxCategory><cbc:ID>O</cbc:ID><cac:TaxScheme>");
    expect(xml).not.toContain("SE556677889901");
    expect(xml).not.toContain("US123456789");
    // The seller is still identified (BR-CO-26) and F-skatt still stated.
    expect(xml).toContain('<cbc:CompanyID schemeID="0007">5566778899</cbc:CompanyID>');
    expect(xml).toContain("Godkänd för F-skatt");
  });

  it("states Swedish VAT on a foreign-currency invoice in SEK too: TaxCurrencyCode and a second TaxTotal without subtotals", () => {
    const xml = buildUblInvoice(swedishVatInEur());
    expect(xml).toContain("<cbc:DocumentCurrencyCode>EUR</cbc:DocumentCurrencyCode><cbc:TaxCurrencyCode>SEK</cbc:TaxCurrencyCode>");
    expect(xml).toMatch(
      /<\/cac:TaxSubtotal><\/cac:TaxTotal><cac:TaxTotal><cbc:TaxAmount currencyID="SEK">2800\.00<\/cbc:TaxAmount><\/cac:TaxTotal><cac:LegalMonetaryTotal>/
    );
    // The credit note writes the same pair, positive like every amount on it.
    const credit = buildUblCreditNote({ ...creditNote(), currency: "EUR", taxCurrency: { currency: "SEK", vatAmount: 14112 } });
    expect(credit).toContain("<cbc:DocumentCurrencyCode>EUR</cbc:DocumentCurrencyCode><cbc:TaxCurrencyCode>SEK</cbc:TaxCurrencyCode>");
    expect(credit).toContain('<cac:TaxTotal><cbc:TaxAmount currencyID="SEK">14112.00</cbc:TaxAmount></cac:TaxTotal>');
  });
});

describe("ubl-check — foreign customers", () => {
  it("passes the foreign fixtures", () => {
    for (const input of [exportGoodsNok(), euGoodsEur(), euServicesDkk(), servicesOutsideEuUsd(), swedishVatInEur()]) {
      expect(checkUblInput(input)).toEqual([]);
    }
  });

  it("K needs the buyer's VAT number, the delivery date and the delivery country", () => {
    const input = euGoodsEur();
    expect(checkUblInput({ ...input, buyer: { ...input.buyer, vatNumber: null } })).toContain("Unionsintern leverans kräver kundens momsregistreringsnummer på fakturan.");
    expect(checkUblInput({ ...input, delivery: null })).toEqual([
      "Unionsintern leverans kräver leveransdatum på fakturan.",
      "Unionsintern leverans kräver leveranslandet på fakturan.",
    ]);
    expect(checkUblInput({ ...input, delivery: { date: "2026-02-30", country: "DE" } })).toEqual(["Unionsintern leverans kräver leveransdatum på fakturan."]);
  });

  it("AE from EUT needs the buyer's VAT number, and O stands alone on its invoice", () => {
    const dkk = euServicesDkk();
    expect(checkUblInput({ ...dkk, buyer: { ...dkk.buyer, vatNumber: null } })).toContain("Omvänd betalningsskyldighet kräver kundens momsregistreringsnummer på fakturan.");
    const usd = servicesOutsideEuUsd();
    const mixed = { ...usd, lines: [...usd.lines, { ...usd.lines[0]!, lineNumber: 2, vatCode: "EXV", vatExemptionText: null }] };
    expect(checkUblInput(mixed)).toContain("Export av tjänster (momskod EXT) kan inte stå på samma e-faktura som andra momskoder — fakturera tjänsterna för sig.");
  });

  it("refuses a Swedish VAT invoice in another currency without the VAT in SEK", () => {
    expect(checkUblInput({ ...invoiceTwoRatesDiscount(), currency: "NOK" })).toContain("Fakturan i NOK saknar momsen i SEK.");
    expect(checkUblInput({ ...swedishVatInEur(), taxCurrency: null })).toContain("Fakturan i EUR saknar momsen i SEK.");
  });
});

describe("web hook signature and address", () => {
  const secret = "whsec_test_secret";
  const body = Buffer.from('{"code":"issued_invoice.state_change","triggered_at":1732530076,"data":{"invoice_id":85373,"state":"sent"}}');
  const sign = (t: string, b: Buffer, key = secret) => createHmac("sha256", key).update(`${t}.`).update(b).digest("hex");

  it("accepts B2Brouter's t=…,s=… over '<t>.<raw body>' and nothing else", () => {
    expect(verifyWebhookSignature(`t=1732530076,s=${sign("1732530076", body)}`, body, secret)).toBe(true);
    expect(verifyWebhookSignature(`s=${sign("1732530076", body)}, t=1732530076`, body, secret)).toBe(true);
    expect(verifyWebhookSignature(`t=1732530077,s=${sign("1732530076", body)}`, body, secret)).toBe(false);
    expect(verifyWebhookSignature(`t=1732530076,s=${sign("1732530076", body, "other")}`, body, secret)).toBe(false);
    expect(verifyWebhookSignature(`t=1732530076,s=${sign("1732530076", body)}`, Buffer.from(body.toString().replace("sent", "paid")), secret)).toBe(false);
    expect(verifyWebhookSignature(`t=1732530076,s=abc`, body, secret)).toBe(false);
    expect(verifyWebhookSignature("garbage", body, secret)).toBe(false);
    expect(verifyWebhookSignature(undefined, body, secret)).toBe(false);
    expect(verifyWebhookSignature(`t=1732530076,s=${sign("1732530076", body)}`, body, "")).toBe(false);
  });

  it("builds the hook's address from a public https base only", () => {
    expect(webhookUrlFor("https://nav.example.se/")).toBe("https://nav.example.se/api/v1/einvoice/webhook");
    expect(webhookUrlFor("https://nav.example.se/erp")).toBe("https://nav.example.se/erp/api/v1/einvoice/webhook");
    expect(webhookUrlFor("http://nav.example.se")).toBeNull();
    expect(webhookUrlFor("")).toBeNull();
    expect(webhookUrlFor(null)).toBeNull();
  });
});

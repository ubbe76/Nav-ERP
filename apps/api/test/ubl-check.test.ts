import { describe, expect, it } from "vitest";
import { checkUblInput } from "../src/modules/einvoice/service/ubl/ubl-check.js";
import type { UblInvoiceInput } from "../src/modules/einvoice/service/ubl/ubl-types.js";
import { creditNote, invoiceTwoRatesDiscount, line } from "./helpers/ubl-fixtures.js";

const withSeller = (input: UblInvoiceInput, seller: Partial<UblInvoiceInput["seller"]>): UblInvoiceInput => ({ ...input, seller: { ...input.seller, ...seller } });
const withBuyer = (input: UblInvoiceInput, buyer: Partial<UblInvoiceInput["buyer"]>): UblInvoiceInput => ({ ...input, buyer: { ...input.buyer, ...buyer } });

describe("ubl-check", () => {
  it("accepts the golden inputs", () => {
    expect(checkUblInput(invoiceTwoRatesDiscount())).toEqual([]);
    expect(checkUblInput(creditNote())).toEqual([]);
  });

  it("document: number, dates, currency, R003 reference rule, credited invoice", () => {
    const input = invoiceTwoRatesDiscount();
    expect(checkUblInput({ ...input, invoiceNumber: " " })).toContain("Fakturan saknar fakturanummer.");
    expect(checkUblInput({ ...input, issueDate: "2026-02-30" })).toContain("Fakturan saknar giltigt fakturadatum.");
    expect(checkUblInput({ ...input, dueDate: "20261120" })).toContain("Fakturans förfallodatum är ogiltigt.");
    expect(checkUblInput({ ...input, currency: "EUR" as "SEK" })).toContain("Bara SEK stöds i e-faktura ännu.");
    expect(checkUblInput({ ...input, buyerReference: null, orderReference: " " })).toContain(
      "Peppol kräver er referens eller ert ordernummer på fakturan — ange minst ett av dem (kundnumret används annars som referens)."
    );
    expect(checkUblInput({ ...input, buyerReference: null })).toEqual([]);
    expect(checkUblInput({ ...creditNote(), creditedInvoiceNumber: null })).toContain("Kreditfakturan saknar hänvisning till den krediterade fakturan.");
    // BR-CO-25: due date or payment terms when money is due — not on a credit note.
    expect(checkUblInput({ ...input, dueDate: null, paymentTermsNote: null })).toContain("Fakturan saknar både förfallodatum och betalningsvillkor.");
    expect(checkUblInput({ ...input, dueDate: null })).toEqual([]);
    expect(checkUblInput({ ...creditNote(), paymentTermsNote: null })).toEqual([]);
  });

  it("seller: name, org number (10 digits, Luhn), VAT number format, country", () => {
    const input = invoiceTwoRatesDiscount();
    expect(checkUblInput(withSeller(input, { name: "" }))).toContain("Företagets namn saknas i Företagsuppgifter.");
    expect(checkUblInput(withSeller(input, { orgNumber: "55667788" }))).toContain("Företagets organisationsnummer måste vara tio siffror (Företagsuppgifter).");
    expect(checkUblInput(withSeller(input, { orgNumber: "5566778890" }))).toContain("Företagets organisationsnummer har fel kontrollsiffra (Företagsuppgifter).");
    expect(checkUblInput(withSeller(input, { orgNumber: "556677-8899" }))).toEqual([]);
    expect(checkUblInput(withSeller(input, { vatNumber: "SE5566778899" }))).toContain(
      "Företagets momsregistreringsnummer måste ha formen SE + 12 siffror, t.ex. SE556677889901 (Företagsuppgifter)."
    );
    expect(checkUblInput(withSeller(input, { vatNumber: "se 5566 7788 9901" }))).toEqual([]);
    expect(checkUblInput(withSeller(input, { address: { ...input.seller.address, country: "NO" } }))).toContain(
      "Företagets land måste vara SE — utländska mottagare stöds inte i e-faktura ännu."
    );
  });

  it("buyer: name, endpoint scheme/value per scheme, org number digits, country", () => {
    const input = invoiceTwoRatesDiscount();
    expect(checkUblInput(withBuyer(input, { name: " " }))).toContain("Kundens namn saknas på fakturan.");
    expect(checkUblInput(withBuyer(input, { endpoint: { scheme: "7", value: "5590001235" } }))).toContain("Kundens Peppol-id måste börja med ett fyrsiffrigt schema, t.ex. 0007:5566778899.");
    expect(checkUblInput(withBuyer(input, { endpoint: { scheme: "0007", value: "" } }))).toContain("Kundens Peppol-id saknas — ange Peppol-id eller organisationsnummer på kunden.");
    expect(checkUblInput(withBuyer(input, { endpoint: { scheme: "0007", value: "559000-12" } }))).toContain("Kundens Peppol-id med schema 0007 måste vara organisationsnumrets tio siffror.");
    expect(checkUblInput(withBuyer(input, { endpoint: { scheme: "0088", value: "73500000000" } }))).toContain("Kundens Peppol-id med schema 0088 måste vara ett GLN med 13 siffror.");
    expect(checkUblInput(withBuyer(input, { endpoint: { scheme: "0088", value: "7350000000009" } }))).toEqual([]);
    expect(checkUblInput(withBuyer(input, { orgNumber: "12345" }))).toContain("Kundens organisationsnummer måste vara tio siffror.");
    expect(checkUblInput(withBuyer(input, { orgNumber: null, vatNumber: null, customerNumber: null }))).toEqual([]);
    expect(checkUblInput(withBuyer(input, { address: { ...input.buyer.address, country: "DK" } }))).toContain(
      "Kundens land måste vara SE — utländska mottagare stöds inte i e-faktura ännu."
    );
  });

  it("payment: no account is allowed (PaymentMeans is optional), bankgiro/plusgiro/IBAN/BIC/OCR validity", () => {
    const input = invoiceTwoRatesDiscount();
    expect(checkUblInput({ ...input, payment: { account: null, ocrNumber: null } })).toEqual([]);
    expect(checkUblInput({ ...input, payment: { account: null, ocrNumber: "10012345673" } })).toEqual([]);
    expect(checkUblInput({ ...input, payment: { account: { kind: "bankgiro", account: "5512349" }, ocrNumber: null } })).toContain("Företagets bankgiro är ogiltigt (Företagsuppgifter).");
    expect(checkUblInput({ ...input, payment: { account: { kind: "plusgiro", account: "4892163" }, ocrNumber: null } })).toContain("Företagets plusgiro är ogiltigt (Företagsuppgifter).");
    expect(checkUblInput({ ...input, payment: { account: { kind: "iban", iban: "SE3550000000054910000004", bic: null }, ocrNumber: null } })).toContain("Företagets IBAN är ogiltigt (Företagsuppgifter).");
    expect(checkUblInput({ ...input, payment: { account: { kind: "iban", iban: "SE3550000000054910000003", bic: "ESS" }, ocrNumber: null } })).toContain("Företagets BIC är ogiltigt (Företagsuppgifter).");
    expect(checkUblInput({ ...input, payment: { account: { kind: "iban", iban: "SE35 5000 0000 0549 1000 0003", bic: null }, ocrNumber: null } })).toEqual([]);
    expect(checkUblInput({ ...input, payment: { ...input.payment, ocrNumber: "10012345674" } })).toContain("Fakturans OCR-nummer är ogiltigt.");
  });

  it("attachment: filename and content", () => {
    const input = invoiceTwoRatesDiscount();
    expect(checkUblInput({ ...input, attachment: { ...input.attachment!, filename: "" } })).toContain("PDF-bilagan saknar filnamn.");
    expect(checkUblInput({ ...input, attachment: { ...input.attachment!, content: Buffer.alloc(0) } })).toContain("PDF-bilagan är tom.");
    expect(checkUblInput({ ...input, attachment: null })).toEqual([]);
  });

  it("lines: at least one, unique numbers, description, quantity, price, discount, amounts, VAT rate, properties", () => {
    const input = invoiceTwoRatesDiscount();
    expect(checkUblInput({ ...input, lines: [] })).toEqual(["Fakturan har inga rader."]);
    const ok = input.lines[1]!;
    const problems = (overrides: Partial<typeof ok>) => checkUblInput({ ...input, lines: [{ ...ok, ...overrides }] });
    expect(checkUblInput({ ...input, lines: [ok, { ...ok }] })).toContain("Radnumret 2 är inte ett unikt positivt heltal.");
    expect(problems({ lineNumber: 0 })).toContain("Radnumret 0 är inte ett unikt positivt heltal.");
    expect(problems({ description: "  " })).toContain("Rad 2 saknar benämning.");
    expect(problems({ quantity: 0 })).toContain("Rad 2 måste ha ett antal större än 0.");
    expect(problems({ unitPrice: -1 })).toContain("Rad 2 har ett negativt à-pris.");
    expect(problems({ discountPercent: 120 })).toContain("Rad 2 har en rabatt utanför 0–100 %.");
    expect(problems({ lineAmount: 2550.005 })).toContain("Rad 2 har ett radbelopp som inte är ett belopp med två decimaler.");
    expect(problems({ vatAmount: -1 })).toContain("Rad 2 har ett momsbelopp som inte är ett belopp med två decimaler.");
    expect(problems({ vatRate: 19 })).toContain("Rad 2 har en momssats som inte stöds i e-faktura (19 %).");
    expect(problems({ vatRate: 0, vatAmount: 1 })).toContain("Rad 2 har 0 % moms men ändå ett momsbelopp.");
    expect(problems({ properties: [{ name: "Bredd", value: " " }] })).toContain("Rad 2 har en konfigurationsrad utan namn eller värde.");
    // Unknown units are not an error — they become C62.
    expect(problems({ unitCode: "hink" })).toEqual([]);
  });

  it("lines: the arithmetic the schematron checks — discount sign and R120 residual", () => {
    const input = invoiceTwoRatesDiscount();
    const only = (l: ReturnType<typeof line>) => checkUblInput({ ...input, lines: [l] });
    // Net larger than gross with a discount: below 100 % the gross is rebuilt
    // from the stored net (no error); at 100 % nothing can be rebuilt and the
    // negative allowance is reported.
    expect(only(line({ lineNumber: 1, description: "a", quantity: 1, unitPrice: 100, discountPercent: 10, lineAmount: 150, vatAmount: 37.5, vatRate: 25 }))).toEqual([]);
    expect(only(line({ lineNumber: 1, description: "a", quantity: 1, unitPrice: 100, discountPercent: 100, lineAmount: 150, vatAmount: 37.5, vatRate: 25 }))).toContain("Rad 1: rabatten stämmer inte med radbeloppet.");
    // A pathological quantity leaves a residual the derivation cannot remove.
    expect(only(line({ lineNumber: 1, description: "a", quantity: 1e13, unitPrice: 1, lineAmount: 10, vatAmount: 2.5, vatRate: 25 })).some((p) => p.startsWith("Rad 1: antal × à-pris − rabatt stämmer inte med radbeloppet"))).toBe(true);
    // Drift inside the slack is fine, drift outside is repaired by derivation — neither is an error.
    expect(only(line({ lineNumber: 1, description: "a", quantity: 1000, unitPrice: 0.3333, lineAmount: 333.33, vatAmount: 83.33, vatRate: 25 }))).toEqual([]);
  });

  it("VAT breakdown: category VAT must be within one krona of taxable × rate", () => {
    const input = invoiceTwoRatesDiscount();
    const lines = [line({ lineNumber: 1, description: "a", quantity: 1, unitPrice: 1000, lineAmount: 1000, vatAmount: 251, vatRate: 25 })];
    expect(checkUblInput({ ...input, lines })).toContain("Momsen för 25 % (251.00 kr) avviker mer än en krona från 25 % av underlaget 1000.00 kr.");
    expect(checkUblInput({ ...input, lines: [line({ ...lines[0]!, vatAmount: 250.99 })] })).toEqual([]);
  });

  it("reports every problem, not just the first", () => {
    const input = withSeller({ ...invoiceTwoRatesDiscount(), invoiceNumber: "", lines: [] }, { orgNumber: "1" });
    const problems = checkUblInput(input);
    expect(problems.length).toBeGreaterThanOrEqual(3);
    expect(problems.every((p) => p.endsWith("."))).toBe(true);
  });
});

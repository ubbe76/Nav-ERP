// Peppol BIS Billing 3 (UBL 2.1) invoice and credit note, built by hand in
// schema order — the same approach as pain001-builder.ts: the element ORDER
// lives here, the element builder (el/renderXml) knows nothing about it, and
// the UBL 2.1 XSD test (test/ubl-invoice-builder.test.ts) is what enforces
// the sequence. Pure: no DB imports, the service hands over a UblInvoiceInput.
//
// References checked while writing this (2026-10-21):
//   - OASIS UBL 2.1 XSD (test/fixtures/ubl/xsd) for the element sequences.
//   - PEPPOL-EN16931-UBL.sch 1.3.15 (2025-10-16) for the Peppol rules, in
//     particular u:slack 0.02 on R120/R040 and the Swedish SE-R-* rules.
//   - CEN-EN16931-UBL.sch (same bundle) for BR-CO-10/13/14/15/16 (exact) and
//     BR-CO-17 / BR-S-09 (within ±1).
//
// ROUNDING — why the numbers are what they are
//
// Nav's stored invoice_rows.line_amount / vat_amount are the authority: they
// are what the PDF shows and what the F-series verification booked. The UBL
// must carry exactly those figures, so:
//
//   * LineExtensionAmount (BT-131) = stored line_amount, never recomputed.
//   * TaxSubtotal/TaxableAmount (BT-116) = Σ line_amount per rate (BR-S-08 /
//     BR-E-08 want exactly that), TaxSubtotal/TaxAmount (BT-117) = Σ stored
//     vat_amount per rate. Nav rounds VAT per row (round2(line × rate)), so the
//     category total can differ from round2(taxable × rate) by up to 0.005 per
//     row — BR-CO-17 and BR-S-09 allow ±1 SEK (the schematron tests
//     |TaxAmount − round2(taxable × rate)| < 1), which Σ of per-row rounding
//     cannot exceed below ~200 rows at one rate. ubl-check re-verifies the
//     tolerance so an extreme document is refused here, not by the access
//     point, and the PDF, the ledger and the e-invoice always agree.
//   * TaxTotal/TaxAmount = Σ subtotals, LegalMonetaryTotal = Σ lines and
//     Σ lines + VAT, all in integer öre, so BR-CO-10/14/15/16 (exact) hold by
//     construction and match the PDF's sums (same round2 figures).
//
//   * The row discount is a LINE allowance (BG-27: ChargeIndicator false,
//     reason code 95 "Discount", MultiplierFactorNumeric = rabatt-%, Amount,
//     BaseAmount) and Price/PriceAmount (BT-146) is therefore the GROSS row
//     price — BT-146 is net of PRICE-level discounts (BT-147), which we do
//     not use; printing the discounted price together with a line allowance
//     would subtract the discount twice under R120. Per line, R120 demands
//     |quantity × price − allowance − LineExtensionAmount| ≤ 0.02 and R040
//     |allowance − base × percent/100| ≤ 0.02. With quantity and unit price
//     in the row's display unit (already round4:ed by the service, exactly
//     like the PDF):
//       1. base = round2(quantity × unitPrice), allowance = base − line_amount
//          (öre arithmetic) — R120 is then exact and R040 holds whenever the
//          stored figures came from the same quantity/price, which is the
//          normal case (unit factor 1 or a benign conversion).
//       2. If the display conversion drifted so far that R040 would fail
//          (|allowance − base × %| > 0.015), the gross is reconstructed from
//          the authority instead: base = round2(line_amount ÷ (1 − %/100)),
//          allowance = base − line_amount (R040 then holds by construction),
//          and the price is derived as base ÷ quantity with as many decimals
//          (4–10) as R120 needs — BT-146 has no decimal limit in EN 16931.
//       3. Without a discount the same fallback applies to the price alone:
//          unitPrice is printed when quantity × unitPrice is within 0.015 of
//          line_amount, otherwise line_amount ÷ quantity is derived.
//     The service's unit conversion is therefore never a reason for a refused
//     document; the residual is still reported by ubl-check if it cannot be
//     brought under 0.02 (quantity ≤ 0, pathological data).
import { el, renderXml, type XmlChild, type XmlElement } from "../../../banking/service/iso20022/xml-writer.js";
import { unitCodeFor } from "./unit-codes.js";
import type { UblBuyer, UblInvoiceInput, UblLine, UblPostalAddress, UblSeller } from "./ubl-types.js";
import { compareVatCategories, lineVatCategory, type VatCategory } from "./vat-categories.js";

export const UBL_CUSTOMIZATION_ID = "urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0";
export const UBL_PROFILE_ID = "urn:fdc:peppol.eu:2017:poacc:billing:01:1.0";
export const UBL_NAMESPACES = {
  invoice: "urn:oasis:names:specification:ubl:schema:xsd:Invoice-2",
  creditNote: "urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2",
  cac: "urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2",
  cbc: "urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2",
} as const;
// UNCL1001: 380 commercial invoice, 381 credit note.
export const INVOICE_TYPE_CODE = "380";
export const CREDIT_NOTE_TYPE_CODE = "381";
// UNCL7161 allowance reason: 95 = Discount.
const DISCOUNT_REASON_CODE = "95";
const SE_ORG_SCHEME = "0007";
const F_SKATT_TEXT = "Godkänd för F-skatt";
// Peppol slack on R120/R040 is 0.02; staying a bit inside it keeps float
// noise in the comparison from mattering.
const SLACK = 0.015;

// ---- amounts ---------------------------------------------------------------

// Same rounding as @navet/shared round2 (Math.round((n + EPSILON) × 100)),
// kept in integer öre so sums are exact. Exported for ubl-check and the tests.
export const toCents = (amount: number): number => Math.round((amount + Number.EPSILON) * 100);
export const formatAmount = (amount: number): string => (toCents(amount) / 100).toFixed(2);
const formatCents = (cents: number): string => (cents / 100).toFixed(2);

// Quantities, percentages and prices: up to `maxDecimals`, trailing zeros
// trimmed down to `minDecimals`, dot decimal, never an exponent.
export function formatDecimal(value: number, maxDecimals: number, minDecimals = 0): string {
  const [int = "0", frac = ""] = value.toFixed(maxDecimals).split(".");
  const trimmed = frac.replace(/0+$/, "").padEnd(minDecimals, "0");
  const text = trimmed ? `${int}.${trimmed}` : int;
  return text === "-0" ? "0" : text;
}

// ---- totals (shared with ubl-check) ----------------------------------------

export interface UblTaxSubtotal {
  category: VatCategory;
  taxableCents: number;
  taxCents: number;
}
export interface UblTotals {
  lineTotalCents: number; // BT-106 = BT-109
  taxTotalCents: number; // BT-110
  grossCents: number; // BT-112 = BT-115
  subtotals: UblTaxSubtotal[]; // one per category and rate, 25 → 12 → 6 → 0, S → E → AE
}

// Momskoder: one subtotal per VAT category and rate (the line's code decides
// the category — lineVatCategory), so a momsfri row (E) and an omvänd
// betalningsskyldighet row (AE) at 0 % are two subtotals.
export function computeTotals(lines: readonly UblLine[]): UblTotals {
  const byCategory = new Map<string, UblTaxSubtotal>();
  for (const line of lines) {
    const category = lineVatCategory(line);
    const key = `${category.id}:${category.percent}`;
    const bucket = byCategory.get(key) ?? { category, taxableCents: 0, taxCents: 0 };
    bucket.taxableCents += toCents(line.lineAmount);
    bucket.taxCents += toCents(line.vatAmount);
    byCategory.set(key, bucket);
  }
  const subtotals = [...byCategory.values()].sort((a, b) => compareVatCategories(a.category, b.category));
  const lineTotalCents = subtotals.reduce((sum, s) => sum + s.taxableCents, 0);
  const taxTotalCents = subtotals.reduce((sum, s) => sum + s.taxCents, 0);
  return { lineTotalCents, taxTotalCents, grossCents: lineTotalCents + taxTotalCents, subtotals };
}

// ---- line pricing (shared with ubl-check) ----------------------------------

export interface UblLineAllowance {
  percent: number;
  baseCents: number; // BT-137
  amountCents: number; // BT-136
}
export interface UblLinePricing {
  priceAmount: string; // BT-146 as printed
  allowance: UblLineAllowance | null;
  // R120 as the schematron computes it: quantity × price − allowance −
  // LineExtensionAmount, in SEK. |residual| must be ≤ 0.02.
  residual: number;
}

function derivePrice(targetCents: number, quantity: number): string {
  const target = targetCents / 100;
  let candidate = "";
  for (let decimals = 4; decimals <= 10; decimals++) {
    candidate = formatDecimal(target / quantity, decimals, 2);
    if (Math.abs(quantity * Number(candidate) - target) <= SLACK) break;
  }
  return candidate;
}

function priceFor(line: UblLine, targetCents: number): string {
  const printed = formatDecimal(line.unitPrice, 4, 2);
  if (!(line.quantity > 0)) return printed;
  return Math.abs(line.quantity * Number(printed) - targetCents / 100) <= SLACK ? printed : derivePrice(targetCents, line.quantity);
}

export function linePricing(line: UblLine): UblLinePricing {
  const lineCents = toCents(line.lineAmount);
  const percent = line.discountPercent;
  let allowance: UblLineAllowance | null = null;
  if (percent > 0) {
    // Rule 1: gross from the display quantity × price.
    let baseCents = toCents(line.quantity * line.unitPrice);
    let amountCents = baseCents - lineCents;
    const r040 = Math.abs(amountCents / 100 - (baseCents / 100) * (percent / 100));
    if ((r040 > SLACK || amountCents < 0) && percent < 100) {
      // Rule 2: gross reconstructed from the stored net.
      baseCents = Math.round(lineCents / (1 - percent / 100));
      amountCents = baseCents - lineCents;
    }
    allowance = { percent, baseCents, amountCents };
  }
  const targetCents = allowance ? allowance.baseCents : lineCents;
  const priceAmount = priceFor(line, targetCents);
  const residual = line.quantity * Number(priceAmount) - (allowance?.amountCents ?? 0) / 100 - lineCents / 100;
  return { priceAmount, allowance, residual };
}

// ---- element helpers -------------------------------------------------------

const trimmed = (value: string | null | undefined): string => (value ?? "").trim();
const has = (value: string | null | undefined): boolean => trimmed(value) !== "";

// Peppol R008: the document must not contain empty elements — an optional
// text element is written only when it has content.
function text(name: string, value: string | null | undefined, attrs: Record<string, string> = {}): XmlChild {
  const content = trimmed(value);
  return content ? el(name, content, attrs) : null;
}
const amount = (name: string, cents: number, currency: string): XmlElement => el(name, formatCents(cents), { currencyID: currency });
const digits = (value: string): string => value.replace(/\D/g, "");

function postalAddress(address: UblPostalAddress): XmlElement {
  const lines = address.addressLines.map(trimmed).filter(Boolean);
  return el("cac:PostalAddress", [
    text("cbc:StreetName", lines[0]),
    text("cbc:AdditionalStreetName", lines.slice(1).join(", ")),
    text("cbc:CityName", address.city),
    text("cbc:PostalZone", address.postalCode),
    el("cac:Country", [el("cbc:IdentificationCode", trimmed(address.country).toUpperCase())]),
  ]);
}

function taxScheme(id: string): XmlElement {
  return el("cac:TaxScheme", [el("cbc:ID", id)]);
}

function supplierParty(seller: UblSeller): XmlElement {
  const orgNumber = digits(seller.orgNumber);
  const contact = [text("cbc:Telephone", seller.phone), text("cbc:ElectronicMail", seller.email)].filter(Boolean);
  return el("cac:AccountingSupplierParty", [
    el("cac:Party", [
      el("cbc:EndpointID", orgNumber, { schemeID: SE_ORG_SCHEME }),
      el("cac:PartyIdentification", [el("cbc:ID", orgNumber, { schemeID: SE_ORG_SCHEME })]),
      el("cac:PartyName", [el("cbc:Name", trimmed(seller.name))]),
      postalAddress(seller.address),
      el("cac:PartyTaxScheme", [el("cbc:CompanyID", trimmed(seller.vatNumber).toUpperCase().replace(/\s/g, "")), taxScheme("VAT")]),
      // Swedish Peppol practice (SE-R-005): a second PartyTaxScheme whose
      // TaxScheme is not VAT must say exactly "Godkänd för F-skatt".
      seller.fSkatt ? el("cac:PartyTaxScheme", [el("cbc:CompanyID", F_SKATT_TEXT), taxScheme("TAX")]) : null,
      el("cac:PartyLegalEntity", [el("cbc:RegistrationName", trimmed(seller.name)), el("cbc:CompanyID", orgNumber, { schemeID: SE_ORG_SCHEME })]),
      contact.length > 0 ? el("cac:Contact", contact) : null,
    ]),
  ]);
}

// 0007 identifiers are written as their digits (the invoice snapshot may hold
// "556677-8899"); other schemes as given.
function identifierValue(scheme: string, value: string): string {
  const content = trimmed(value);
  return scheme === SE_ORG_SCHEME ? digits(content) : content;
}

function customerParty(buyer: UblBuyer): XmlElement {
  const scheme = trimmed(buyer.endpoint.scheme);
  const orgNumber = buyer.orgNumber ? digits(buyer.orgNumber) : "";
  const vatNumber = trimmed(buyer.vatNumber).toUpperCase().replace(/\s/g, "");
  return el("cac:AccountingCustomerParty", [
    el("cac:Party", [
      el("cbc:EndpointID", identifierValue(scheme, buyer.endpoint.value), { schemeID: scheme }),
      has(buyer.customerNumber) ? el("cac:PartyIdentification", [el("cbc:ID", trimmed(buyer.customerNumber))]) : null,
      el("cac:PartyName", [el("cbc:Name", trimmed(buyer.name))]),
      postalAddress(buyer.address),
      vatNumber ? el("cac:PartyTaxScheme", [el("cbc:CompanyID", vatNumber), taxScheme("VAT")]) : null,
      el("cac:PartyLegalEntity", [
        el("cbc:RegistrationName", trimmed(buyer.name)),
        orgNumber ? el("cbc:CompanyID", orgNumber, { schemeID: SE_ORG_SCHEME }) : null,
      ]),
    ]),
  ]);
}

// Optional in Peppol BIS: without a payment account the whole group is
// left out — the OCR number (PaymentID) has nowhere to go without it.
function paymentMeans(input: UblInvoiceInput): XmlChild {
  const account = input.payment.account;
  if (!account) return null;
  const payee =
    account.kind === "iban"
      ? el("cac:PayeeFinancialAccount", [
          el("cbc:ID", trimmed(account.iban).toUpperCase().replace(/\s/g, "")),
          account.bic ? el("cac:FinancialInstitutionBranch", [el("cbc:ID", trimmed(account.bic).toUpperCase())]) : null,
        ])
      : el("cac:PayeeFinancialAccount", [
          el("cbc:ID", digits(account.account)),
          el("cac:FinancialInstitutionBranch", [el("cbc:ID", account.kind === "bankgiro" ? "SE:BANKGIRO" : "SE:PLUSGIRO")]),
        ]);
  return el("cac:PaymentMeans", [
    // UNCL4461: 30 credit transfer (Swedish bankgiro/plusgiro practice,
    // SE-R-011/012), 58 SEPA credit transfer for an IBAN.
    el("cbc:PaymentMeansCode", account.kind === "iban" ? "58" : "30"),
    text("cbc:PaymentID", input.payment.ocrNumber),
    payee,
  ]);
}

function taxCategory(name: string, category: VatCategory, withReason: boolean): XmlElement {
  return el(name, [
    el("cbc:ID", category.id),
    el("cbc:Percent", formatDecimal(category.percent, 2)),
    withReason ? text("cbc:TaxExemptionReason", category.exemptionReason) : null,
    taxScheme("VAT"),
  ]);
}

function taxTotal(totals: UblTotals, currency: string): XmlElement {
  return el("cac:TaxTotal", [
    amount("cbc:TaxAmount", totals.taxTotalCents, currency),
    ...totals.subtotals.map((subtotal) =>
      el("cac:TaxSubtotal", [
        amount("cbc:TaxableAmount", subtotal.taxableCents, currency),
        amount("cbc:TaxAmount", subtotal.taxCents, currency),
        taxCategory("cac:TaxCategory", subtotal.category, true),
      ])
    ),
  ]);
}

function monetaryTotal(totals: UblTotals, currency: string): XmlElement {
  return el("cac:LegalMonetaryTotal", [
    amount("cbc:LineExtensionAmount", totals.lineTotalCents, currency),
    amount("cbc:TaxExclusiveAmount", totals.lineTotalCents, currency),
    amount("cbc:TaxInclusiveAmount", totals.grossCents, currency),
    amount("cbc:PayableAmount", totals.grossCents, currency),
  ]);
}

function documentLine(line: UblLine, credit: boolean, currency: string): XmlElement {
  const pricing = linePricing(line);
  const category = lineVatCategory(line);
  const unitCode = unitCodeFor(line.unitCode);
  // InvoiceLine and CreditNoteLine differ only in the quantity element's name
  // for the elements we write (CreditNoteLine puts TaxTotal before
  // AllowanceCharge, but no line TaxTotal is written).
  return el(credit ? "cac:CreditNoteLine" : "cac:InvoiceLine", [
    el("cbc:ID", String(line.lineNumber)),
    el(credit ? "cbc:CreditedQuantity" : "cbc:InvoicedQuantity", formatDecimal(line.quantity, 4), { unitCode }),
    amount("cbc:LineExtensionAmount", toCents(line.lineAmount), currency),
    has(line.orderLineReference) ? el("cac:OrderLineReference", [el("cbc:LineID", trimmed(line.orderLineReference))]) : null,
    pricing.allowance
      ? el("cac:AllowanceCharge", [
          el("cbc:ChargeIndicator", "false"),
          el("cbc:AllowanceChargeReasonCode", DISCOUNT_REASON_CODE),
          el("cbc:AllowanceChargeReason", "Rabatt"),
          el("cbc:MultiplierFactorNumeric", formatDecimal(pricing.allowance.percent, 4)),
          amount("cbc:Amount", pricing.allowance.amountCents, currency),
          amount("cbc:BaseAmount", pricing.allowance.baseCents, currency),
        ])
      : null,
    el("cac:Item", [
      el("cbc:Name", trimmed(line.description)),
      has(line.articleNumber) ? el("cac:SellersItemIdentification", [el("cbc:ID", trimmed(line.articleNumber))]) : null,
      taxCategory("cac:ClassifiedTaxCategory", category, false),
      ...line.properties
        .filter((property) => has(property.name) && has(property.value))
        .map((property) => el("cac:AdditionalItemProperty", [el("cbc:Name", trimmed(property.name)), el("cbc:Value", trimmed(property.value))])),
    ]),
    el("cac:Price", [el("cbc:PriceAmount", pricing.priceAmount, { currencyID: currency })]),
  ]);
}

function attachment(input: UblInvoiceInput): XmlChild {
  const file = input.attachment;
  if (!file) return null;
  return el("cac:AdditionalDocumentReference", [
    el("cbc:ID", trimmed(input.invoiceNumber)),
    text("cbc:DocumentDescription", file.description),
    el("cac:Attachment", [
      el("cbc:EmbeddedDocumentBinaryObject", file.content.toString("base64"), { mimeCode: file.mimeCode, filename: trimmed(file.filename) }),
    ]),
  ]);
}

// ---- documents -------------------------------------------------------------

function build(input: UblInvoiceInput, credit: boolean): string {
  const currency = input.currency;
  const totals = computeTotals(input.lines);
  const root = el(
    credit ? "CreditNote" : "Invoice",
    [
      el("cbc:CustomizationID", UBL_CUSTOMIZATION_ID),
      el("cbc:ProfileID", UBL_PROFILE_ID),
      el("cbc:ID", trimmed(input.invoiceNumber)),
      el("cbc:IssueDate", input.issueDate),
      // UBL 2.1 has no DueDate on CreditNote (Peppol maps BT-9 to
      // PaymentMeans/PaymentDueDate there); Nav's credit notes carry none.
      credit ? null : text("cbc:DueDate", input.dueDate),
      el(credit ? "cbc:CreditNoteTypeCode" : "cbc:InvoiceTypeCode", credit ? CREDIT_NOTE_TYPE_CODE : INVOICE_TYPE_CODE),
      text("cbc:Note", input.note),
      el("cbc:DocumentCurrencyCode", currency),
      text("cbc:BuyerReference", input.buyerReference),
      has(input.orderReference) ? el("cac:OrderReference", [el("cbc:ID", trimmed(input.orderReference))]) : null,
      credit && has(input.creditedInvoiceNumber)
        ? el("cac:BillingReference", [el("cac:InvoiceDocumentReference", [el("cbc:ID", trimmed(input.creditedInvoiceNumber))])])
        : null,
      attachment(input),
      supplierParty(input.seller),
      customerParty(input.buyer),
      paymentMeans(input),
      has(input.paymentTermsNote) ? el("cac:PaymentTerms", [el("cbc:Note", trimmed(input.paymentTermsNote))]) : null,
      taxTotal(totals, currency),
      monetaryTotal(totals, currency),
      ...input.lines.map((line) => documentLine(line, credit, currency)),
    ],
    {
      xmlns: credit ? UBL_NAMESPACES.creditNote : UBL_NAMESPACES.invoice,
      "xmlns:cac": UBL_NAMESPACES.cac,
      "xmlns:cbc": UBL_NAMESPACES.cbc,
    }
  );
  return renderXml(root);
}

export function buildUblInvoice(input: UblInvoiceInput): string {
  if (input.type !== "invoice") throw new Error("buildUblInvoice called with a credit note input");
  return build(input, false);
}

export function buildUblCreditNote(input: UblInvoiceInput): string {
  if (input.type !== "credit") throw new Error("buildUblCreditNote called with an invoice input");
  return build(input, true);
}

export function buildUblDocument(input: UblInvoiceInput): string {
  return input.type === "credit" ? buildUblCreditNote(input) : buildUblInvoice(input);
}

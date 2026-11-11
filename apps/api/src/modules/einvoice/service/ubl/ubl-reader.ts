import { child, children, parseXml, textAt, XmlParseError, type XmlNode } from "../../../system/service/xml-reader.js";
import type {
  ReceivedEInvoice,
  ReceivedEInvoiceAccount,
  ReceivedEInvoiceAddress,
  ReceivedEInvoiceAttachment,
  ReceivedEInvoiceIdentifier,
  ReceivedEInvoiceLine,
  ReceivedEInvoiceParty,
  ReceivedEInvoiceVatBreakdown,
} from "./received-einvoice.js";
import { round2 } from "@navet/shared";

// The pure UBL reader (spec 2026-11-05-e-faktura-mottagning): UBL 2.1
// Invoice and CreditNote — Peppol BIS Billing 3 and any other EN 16931
// CIUS in UBL syntax — into ReceivedEInvoice. Built on the shared XXE-safe
// xml-reader with its own limits: a UBL with an embedded PDF is larger than
// a bank file (60 MB), and far fewer elements. Every refusal is a
// UblReadError with Swedish text; echoed input is clipped so a hostile
// document cannot push its content into the reception log.

export class UblReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UblReadError";
  }
}

export const UBL_READ_LIMITS = { maxBytes: 60 * 1024 * 1024, maxNodes: 200_000 } as const;
// An amount at or beyond this cannot be stored (numeric(14,2)) nor printed
// sensibly; the document is refused instead of crashing the import.
export const UBL_MAX_AMOUNT = 1e12;

export const UBL_NAMESPACE = {
  invoice: "urn:oasis:names:specification:ubl:schema:xsd:Invoice-2",
  creditNote: "urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2",
} as const;

const ECHO_MAX = 40;
const clip = (value: string) => (value.length > ECHO_MAX ? `${value.slice(0, ECHO_MAX)}…` : value);

const trimmedOrNull = (value: string | null | undefined) => {
  const t = (value ?? "").trim();
  return t === "" ? null : t;
};

function requiredText(node: XmlNode | null, label: string, ...names: string[]): string {
  const value = textAt(node, ...names);
  if (value === null) throw new UblReadError(`E-fakturan saknar ${label}`);
  return value;
}

function amountOf(node: XmlNode | null, ...names: string[]): number | null {
  const text = textAt(node, ...names);
  if (text === null) return null;
  const value = Number(text);
  if (!Number.isFinite(value)) throw new UblReadError(`E-fakturan har ett belopp som inte går att läsa (${clip(text)})`);
  if (Math.abs(value) >= UBL_MAX_AMOUNT) throw new UblReadError(`E-fakturan har ett orimligt stort belopp (${clip(text)})`);
  return value;
}

function requiredAmount(node: XmlNode | null, label: string, ...names: string[]): number {
  const value = amountOf(node, ...names);
  if (value === null) throw new UblReadError(`E-fakturan saknar ${label}`);
  return value;
}

// A real calendar date (2026-02-30 is refused — Postgres would, with a
// SQLSTATE the import must never see).
function isoDate(text: string | null, label: string): string | null {
  if (text === null) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const date = new Date(Date.UTC(y, mo - 1, d));
    if (y >= 1900 && date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d) return `${m[1]}-${m[2]}-${m[3]}`;
  }
  throw new UblReadError(`E-fakturans ${label} är inget giltigt datum (${clip(text)})`);
}

function identifier(node: XmlNode | null): ReceivedEInvoiceIdentifier | null {
  const value = trimmedOrNull(node?.text);
  if (!node || value === null) return null;
  return { scheme: trimmedOrNull(node.attrs.schemeID), value };
}

function address(node: XmlNode | null): ReceivedEInvoiceAddress {
  const lines = [textAt(node, "StreetName"), textAt(node, "AdditionalStreetName")];
  for (const extra of children(node, "AddressLine")) lines.push(textAt(extra, "Line"));
  return {
    lines: lines.filter((l): l is string => l !== null),
    postalCode: textAt(node, "PostalZone"),
    city: textAt(node, "CityName"),
    country: textAt(node, "Country", "IdentificationCode")?.toUpperCase() ?? null,
  };
}

function party(wrapper: XmlNode | null, label: string): ReceivedEInvoiceParty {
  const p = child(wrapper, "Party");
  const name = textAt(p, "PartyLegalEntity", "RegistrationName") ?? textAt(p, "PartyName", "Name");
  if (name === null) throw new UblReadError(`E-fakturan saknar ${label}s namn`);
  // PartyTaxScheme with TaxScheme VAT is the VAT number; Swedish practice
  // adds a second one ("Godkänd för F-skatt", TaxScheme TAX) which is not.
  const vat = children(p, "PartyTaxScheme").find((s) => (textAt(s, "TaxScheme", "ID") ?? "VAT").toUpperCase() === "VAT");
  const contact = child(p, "Contact");
  return {
    name,
    endpoint: identifier(child(p, "EndpointID")),
    companyId: identifier(child(child(p, "PartyLegalEntity"), "CompanyID")),
    vatNumber: textAt(vat ?? null, "CompanyID")?.replace(/\s/g, "").toUpperCase() ?? null,
    address: address(child(p, "PostalAddress")),
    email: textAt(contact, "ElectronicMail"),
    phone: textAt(contact, "Telephone"),
  };
}

function account(means: XmlNode | null): ReceivedEInvoiceAccount | null {
  const payee = child(means, "PayeeFinancialAccount");
  const id = textAt(payee, "ID");
  if (id === null) return null;
  const branch = textAt(payee, "FinancialInstitutionBranch", "ID")?.toUpperCase() ?? null;
  const digits = id.replace(/\D/g, "");
  if (branch === "SE:BANKGIRO") return { kind: "bankgiro", account: digits };
  if (branch === "SE:PLUSGIRO") return { kind: "plusgiro", account: digits };
  const compact = id.replace(/\s/g, "").toUpperCase();
  if (/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(compact)) return { kind: "iban", iban: compact, bic: branch };
  return { kind: "other", account: id, bic: branch };
}

function vatBreakdown(taxTotals: XmlNode[], currency: string): ReceivedEInvoiceVatBreakdown[] {
  const out: ReceivedEInvoiceVatBreakdown[] = [];
  for (const total of taxTotals) {
    // A second TaxTotal in another currency (BT-111) has no subtotals and is
    // not part of the breakdown.
    const amountNode = child(total, "TaxAmount");
    if (amountNode && amountNode.attrs.currencyID && amountNode.attrs.currencyID !== currency) continue;
    for (const sub of children(total, "TaxSubtotal")) {
      const category = child(sub, "TaxCategory");
      const percentText = textAt(category, "Percent");
      const percent = percentText === null ? null : Number(percentText);
      if (percent !== null && !Number.isFinite(percent)) throw new UblReadError(`E-fakturan har en momssats som inte går att läsa (${clip(percentText!)})`);
      out.push({
        category: textAt(category, "ID") ?? "",
        percent,
        taxableAmount: requiredAmount(sub, "ett momsunderlag", "TaxableAmount"),
        taxAmount: requiredAmount(sub, "ett momsbelopp", "TaxAmount"),
        exemptionReason: textAt(category, "TaxExemptionReason"),
      });
    }
  }
  return out;
}

function sumAllowanceCharges(nodes: XmlNode[], charge: boolean): number {
  let sum = 0;
  for (const node of nodes) {
    const isCharge = (textAt(node, "ChargeIndicator") ?? "false").toLowerCase() === "true";
    if (isCharge !== charge) continue;
    sum += amountOf(node, "Amount") ?? 0;
  }
  return round2(sum);
}

function line(node: XmlNode, credit: boolean, index: number): ReceivedEInvoiceLine {
  const quantityText = textAt(node, credit ? "CreditedQuantity" : "InvoicedQuantity");
  const quantity = quantityText === null ? 1 : Number(quantityText);
  if (!Number.isFinite(quantity)) throw new UblReadError(`Rad ${index + 1} har ett antal som inte går att läsa (${clip(quantityText!)})`);
  const quantityNode = child(node, credit ? "CreditedQuantity" : "InvoicedQuantity");
  const item = child(node, "Item");
  const price = child(node, "Price");
  const priceAmount = amountOf(price, "PriceAmount");
  const baseText = textAt(price, "BaseQuantity");
  const base = baseText === null ? 1 : Number(baseText);
  const unitPrice = priceAmount === null ? null : Number.isFinite(base) && base > 0 ? priceAmount / base : priceAmount;
  const category = child(item, "ClassifiedTaxCategory");
  const rateText = textAt(category, "Percent");
  const rate = rateText === null ? null : Number(rateText);
  const allowanceCharges = children(node, "AllowanceCharge");
  return {
    id: textAt(node, "ID") ?? String(index + 1),
    description: textAt(item, "Name") ?? textAt(item, "Description") ?? "",
    quantity,
    unitCode: trimmedOrNull(quantityNode?.attrs.unitCode),
    unitPrice,
    allowanceAmount: sumAllowanceCharges(allowanceCharges, false),
    chargeAmount: sumAllowanceCharges(allowanceCharges, true),
    lineAmount: requiredAmount(node, `radbelopp på rad ${index + 1}`, "LineExtensionAmount"),
    vatCategory: textAt(category, "ID"),
    vatRate: rate !== null && Number.isFinite(rate) ? rate : null,
    sellerItemNumber: textAt(item, "SellersItemIdentification", "ID"),
    buyerItemNumber: textAt(item, "BuyersItemIdentification", "ID"),
    orderLineReference: textAt(node, "OrderLineReference", "LineID"),
    note: textAt(node, "Note"),
  };
}

// Decoded size from the base64 length without decoding: 3 bytes per 4
// characters, minus the padding.
export function base64DecodedLength(base64: string): number {
  const clean = base64.replace(/\s/g, "");
  if (clean.length === 0) return 0;
  const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  return Math.floor((clean.length * 3) / 4) - padding;
}

function attachments(root: XmlNode): ReceivedEInvoiceAttachment[] {
  const out: ReceivedEInvoiceAttachment[] = [];
  for (const ref of children(root, "AdditionalDocumentReference")) {
    const binary = child(child(ref, "Attachment"), "EmbeddedDocumentBinaryObject");
    const base64 = binary?.text.trim();
    if (!binary || !base64) continue;
    out.push({
      index: out.length,
      filename: trimmedOrNull(binary.attrs.filename),
      mimeCode: trimmedOrNull(binary.attrs.mimeCode)?.toLowerCase() ?? null,
      description: textAt(ref, "DocumentDescription"),
      sizeBytes: base64DecodedLength(base64),
      content: () => Buffer.from(base64, "base64"),
    });
  }
  return out;
}

// The bytes as received are stored untouched (räkenskapsinformation); only
// the parser decodes them: a UTF-8/UTF-16 BOM decides, else the XML
// declaration's encoding (ISO-8859-1/Latin-1/Windows-1252 as latin1), else
// UTF-8.
export function decodeXmlBytes(xml: Buffer): string {
  if (xml.length >= 3 && xml[0] === 0xef && xml[1] === 0xbb && xml[2] === 0xbf) return xml.subarray(3).toString("utf8");
  if (xml.length >= 2 && xml[0] === 0xff && xml[1] === 0xfe) return xml.subarray(2).toString("utf16le");
  const head = xml.subarray(0, 200).toString("latin1");
  const declared = /^\s*<\?xml[^>]*encoding\s*=\s*["']([A-Za-z0-9._-]+)["']/.exec(head)?.[1]?.toLowerCase() ?? null;
  if (declared && /^(iso-8859-1|iso8859-1|latin-?1|windows-1252|cp1252)$/.test(declared)) return xml.toString("latin1");
  return xml.toString("utf8");
}

// Reads one UBL document. Throws UblReadError (Swedish) for anything that
// is not a UBL 2.1 Invoice/CreditNote with the fields the inbox needs.
export function readUblInvoice(xml: Buffer | string): ReceivedEInvoice {
  const text = Buffer.isBuffer(xml) ? decodeXmlBytes(xml) : xml;
  let parsed: ReturnType<typeof parseXml>;
  try {
    parsed = parseXml(text, UBL_READ_LIMITS);
  } catch (err) {
    if (err instanceof XmlParseError) throw new UblReadError(`E-fakturan kunde inte läsas som XML: ${err.message}`);
    throw err;
  }
  const { root, namespace } = parsed;
  const credit = root.name === "CreditNote";
  if (root.name !== "Invoice" && !credit) throw new UblReadError(`Dokumentet är ingen UBL-faktura (rotelementet är ${clip(root.name)})`);
  const expectedNs = credit ? UBL_NAMESPACE.creditNote : UBL_NAMESPACE.invoice;
  if (namespace !== null && namespace !== expectedNs) throw new UblReadError(`Dokumentet är ingen UBL 2.1-faktura (namnrymden är ${clip(namespace)})`);

  const currency = requiredText(root, "valuta (DocumentCurrencyCode)", "DocumentCurrencyCode").toUpperCase();
  const totals = child(root, "LegalMonetaryTotal");
  const taxTotals = children(root, "TaxTotal");
  const documentTax = taxTotals.find((t) => {
    const node = child(t, "TaxAmount");
    return node !== null && (!node.attrs.currencyID || node.attrs.currencyID === currency);
  });
  // Every PaymentMeans counts (a document may name a bankgiro AND an IBAN);
  // the first one is what the copy prints.
  const allMeans = children(root, "PaymentMeans");
  const means = allMeans[0] ?? null;
  const accounts = allMeans.map(account).filter((a): a is ReceivedEInvoiceAccount => a !== null);
  const paymentId = allMeans.map((m) => textAt(m, "PaymentID")).find((id) => id !== null) ?? null;
  const lines = children(root, credit ? "CreditNoteLine" : "InvoiceLine").map((node, i) => line(node, credit, i));

  return {
    type: credit ? "credit_note" : "invoice",
    number: requiredText(root, "fakturanummer (ID)", "ID"),
    issueDate: isoDate(requiredText(root, "fakturadatum (IssueDate)", "IssueDate"), "fakturadatum")!,
    // A credit note has no DueDate in UBL 2.1; Peppol puts BT-9 in
    // PaymentMeans/PaymentDueDate.
    dueDate: isoDate(textAt(root, "DueDate") ?? allMeans.map((m) => textAt(m, "PaymentDueDate")).find((d) => d !== null) ?? null, "förfallodatum"),
    currency,
    buyerReference: textAt(root, "BuyerReference"),
    orderReference: textAt(root, "OrderReference", "ID"),
    creditedInvoiceNumber: textAt(root, "BillingReference", "InvoiceDocumentReference", "ID"),
    note: textAt(root, "Note"),
    seller: party(child(root, "AccountingSupplierParty"), "säljaren"),
    buyer: party(child(root, "AccountingCustomerParty"), "köparen"),
    payment: {
      meansCode: textAt(means, "PaymentMeansCode"),
      account: accounts[0] ?? null,
      accounts,
      paymentId,
      termsNote: textAt(root, "PaymentTerms", "Note"),
    },
    vat: vatBreakdown(taxTotals, currency),
    totals: {
      lineExtensionAmount: amountOf(totals, "LineExtensionAmount"),
      taxExclusiveAmount: amountOf(totals, "TaxExclusiveAmount"),
      taxInclusiveAmount: amountOf(totals, "TaxInclusiveAmount"),
      allowanceTotalAmount: amountOf(totals, "AllowanceTotalAmount"),
      chargeTotalAmount: amountOf(totals, "ChargeTotalAmount"),
      payableRoundingAmount: amountOf(totals, "PayableRoundingAmount"),
      prepaidAmount: amountOf(totals, "PrepaidAmount"),
      payableAmount: requiredAmount(totals, "att betala (PayableAmount)", "PayableAmount"),
      taxAmount: amountOf(documentTax ?? null, "TaxAmount"),
    },
    lines,
    attachments: attachments(root),
  };
}

// Whether the bytes look like a UBL 2.1 Invoice/CreditNote at all (the
// reception decides from this whether to ask the access point for its BIS3
// rendering instead). Cheap: a look at the first kilobyte.
export function looksLikeUblInvoice(xml: Buffer): boolean {
  const head = xml.subarray(0, 4096).toString("latin1");
  return /<(\w+:)?(Invoice|CreditNote)[\s>]/.test(head) && /urn:oasis:names:specification:ubl:schema:xsd:(Invoice|CreditNote)-2/.test(head);
}

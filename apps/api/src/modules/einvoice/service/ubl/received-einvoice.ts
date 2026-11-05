// A received e-invoice as the pure UBL reader (ubl-reader.ts) hands it over
// (spec 2026-11-05-e-faktura-mottagning, "UBL-läsaren"). Module-neutral: no
// Nav tables, no DB — the purchase module turns it into the inbox's
// InvoiceScanResult (einvoice-result.ts) and the mail module draws the
// visningskopia from it. Amounts are numbers in the document's currency, as
// the document states them — a credit note's amounts are positive in UBL and
// the type says `credit_note`. Dates are "YYYY-MM-DD".

export type ReceivedEInvoiceType = "invoice" | "credit_note";

export interface ReceivedEInvoiceIdentifier {
  // Peppol ICD scheme (0007 …) or null when the document wrote none.
  scheme: string | null;
  value: string;
}

export interface ReceivedEInvoiceAddress {
  lines: string[];
  postalCode: string | null;
  city: string | null;
  // ISO 3166-1 alpha-2, as written.
  country: string | null;
}

export interface ReceivedEInvoiceParty {
  name: string;
  endpoint: ReceivedEInvoiceIdentifier | null;
  // PartyLegalEntity/CompanyID (the organisationsnummer for a Swedish party).
  companyId: ReceivedEInvoiceIdentifier | null;
  // PartyTaxScheme/CompanyID with TaxScheme VAT.
  vatNumber: string | null;
  address: ReceivedEInvoiceAddress;
  email: string | null;
  phone: string | null;
}

// PaymentMeans: the account as the document identifies it. Bankgiro and
// plusgiro come with SE:BANKGIRO / SE:PLUSGIRO in the branch id (Swedish
// Peppol practice); an IBAN is recognised by its shape; anything else is
// kept as "other" with its raw id.
export type ReceivedEInvoiceAccount =
  | { kind: "bankgiro"; account: string }
  | { kind: "plusgiro"; account: string }
  | { kind: "iban"; iban: string; bic: string | null }
  | { kind: "other"; account: string; bic: string | null };

export interface ReceivedEInvoicePayment {
  // UNCL4461 code (30, 58 …) of the first PaymentMeans, null without one.
  meansCode: string | null;
  // The first PaymentMeans' account (what the copy prints) …
  account: ReceivedEInvoiceAccount | null;
  // … and every account the document names (all feed the supplier matching).
  accounts: ReceivedEInvoiceAccount[];
  // PaymentID (BT-83) of the first PaymentMeans that has one: the OCR
  // number or a free remittance reference.
  paymentId: string | null;
  termsNote: string | null;
}

export interface ReceivedEInvoiceVatBreakdown {
  // UNCL5305 category: S, E, AE, K, G, O, Z …
  category: string;
  // null for category O (no rate at all).
  percent: number | null;
  taxableAmount: number;
  taxAmount: number;
  exemptionReason: string | null;
}

export interface ReceivedEInvoiceTotals {
  lineExtensionAmount: number | null;
  taxExclusiveAmount: number | null;
  taxInclusiveAmount: number | null;
  allowanceTotalAmount: number | null;
  chargeTotalAmount: number | null;
  payableRoundingAmount: number | null;
  // BT-113: paid in advance; payable = tax inclusive − prepaid + rounding.
  prepaidAmount: number | null;
  payableAmount: number;
  // TaxTotal/TaxAmount in the document currency (null when absent).
  taxAmount: number | null;
}

export interface ReceivedEInvoiceLine {
  id: string;
  description: string;
  quantity: number;
  unitCode: string | null;
  // Price/PriceAmount per ONE unit (divided by BaseQuantity when the
  // document prices per several).
  unitPrice: number | null;
  // Line-level AllowanceCharge sums (document currency), 0 when none.
  allowanceAmount: number;
  chargeAmount: number;
  lineAmount: number;
  vatCategory: string | null;
  vatRate: number | null;
  sellerItemNumber: string | null;
  buyerItemNumber: string | null;
  orderLineReference: string | null;
  note: string | null;
}

export interface ReceivedEInvoiceAttachment {
  // Position among the document's embedded attachments (0-based).
  index: number;
  filename: string | null;
  mimeCode: string | null;
  description: string | null;
  // Decoded size, computed from the base64 length — the bytes are decoded
  // only through content().
  sizeBytes: number;
  content(): Buffer;
}

export interface ReceivedEInvoice {
  type: ReceivedEInvoiceType;
  number: string;
  issueDate: string;
  dueDate: string | null;
  currency: string;
  buyerReference: string | null;
  // OrderReference/ID (BT-13).
  orderReference: string | null;
  // A credit note's BillingReference/InvoiceDocumentReference/ID.
  creditedInvoiceNumber: string | null;
  note: string | null;
  seller: ReceivedEInvoiceParty;
  buyer: ReceivedEInvoiceParty;
  payment: ReceivedEInvoicePayment;
  vat: ReceivedEInvoiceVatBreakdown[];
  totals: ReceivedEInvoiceTotals;
  lines: ReceivedEInvoiceLine[];
  attachments: ReceivedEInvoiceAttachment[];
}

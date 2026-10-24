// The contract between the e-invoice service and the pure UBL builder
// (spec private/superpowers/specs/2026-10-21-e-faktura-peppol-design.md §2).
//
// The builder knows nothing about Nav's tables: einvoice.service.ts maps the
// invoice read model (salesService getInvoice + company_info + the customer)
// into this plain object, and buildUblInvoice/buildUblCreditNote turn it into
// Peppol BIS Billing 3 XML. Every amount here is the STORED figure from Nav
// (invoice_rows.line_amount / vat_amount, always positive — a credit note's
// sign is carried by the CreditNote root, never by negative amounts).
//
// Amounts and quantities are numbers; the builder formats them (dot decimal,
// two decimals for money, never sv-SE). Dates are "YYYY-MM-DD" strings.

export type UblDocumentType = "invoice" | "credit";

// A Peppol participant identifier, split: scheme is the four-digit ICD
// (0007 = Swedish organisationsnummer, 0088 = GLN …), value the identifier
// itself (for 0007: the ten digits, no dash).
export interface PeppolIdentifier {
  scheme: string;
  value: string;
}

export interface UblPostalAddress {
  // Free lines as entered in Nav (company_info.address / the invoice's
  // invoice_address snapshot may hold several lines separated by "\n").
  // The builder maps line 1 → StreetName, line 2 → AdditionalStreetName and
  // joins anything beyond that into line 2.
  addressLines: string[];
  postalCode: string | null;
  city: string | null;
  // ISO 3166-1 alpha-2. Etapp 1 only ever sends "SE" for both parties.
  country: string;
}

export interface UblSeller {
  name: string;
  // Swedish organisationsnummer, digits only (10). Used for EndpointID
  // (scheme 0007), PartyIdentification and PartyLegalEntity/CompanyID.
  orgNumber: string;
  // Momsregistreringsnummer, "SE" + 10 digits + "01".
  vatNumber: string;
  address: UblPostalAddress;
  email: string | null;
  phone: string | null;
  // "Godkänd för F-skatt" — PartyTaxScheme with TaxScheme/ID "TAX" when true.
  fSkatt: boolean;
}

export interface UblBuyer {
  endpoint: PeppolIdentifier;
  // The invoice's name snapshot (invoices.customer_name).
  name: string;
  address: UblPostalAddress;
  // Customer's own registration data from the invoice snapshot; null when
  // the customer has none.
  orgNumber: string | null;
  vatNumber: string | null;
  // Nav's customer number for the customer (invoices.customer_number) —
  // PartyIdentification/ID, and the BT-10 fallback.
  customerNumber: string | null;
}

// How the customer pays. Etapp 1 derives it from company_info:
// bankgiro ⇒ { kind: "bankgiro" }, else plusgiro, else IBAN ⇒ "iban".
// null = no payment account known (a credit note never carries one).
export type UblPaymentAccount =
  | { kind: "bankgiro"; account: string }
  | { kind: "plusgiro"; account: string }
  | { kind: "iban"; iban: string; bic: string | null };

export interface UblPayment {
  account: UblPaymentAccount | null;
  // OCR number — PaymentID (BT-83). Null on a credit note.
  ocrNumber: string | null;
}

export interface UblLine {
  // 1-based running number in Nav's row order.
  lineNumber: number;
  description: string;
  articleNumber: string | null;
  // Quantity and net unit price in the ROW'S display unit (the service
  // applies toUnitQuantity/toUnitPrice with the row's unit_factor, exactly
  // like the PDF). unitPrice is the GROSS price before the row discount.
  quantity: number;
  unitCode: string | null; // Nav unit code ("st", "kg" …) — builder maps to UN/ECE Rec 20
  unitPrice: number;
  discountPercent: number;
  // Stored invoice_rows.line_amount (net, after discount, round2) — the
  // monetary authority for the line.
  lineAmount: number;
  // Stored invoice_rows.vat_amount and the row's rate (25, 12, 6 or 0).
  vatAmount: number;
  vatRate: number;
  // The row's momskod (catalog code) — decides the VAT category: MP25/MP12/
  // MP6 ⇒ S, MF ⇒ E, OB ⇒ AE; anything else is refused by ubl-check.
  // Omitted/null ⇒ the rate alone decides (25/12/6 ⇒ S, 0 ⇒ E).
  vatCode?: string | null;
  // The code's invoice text — BT-120 on the AE subtotal (omvänd
  // betalningsskyldighet); ignored for S and E.
  vatExemptionText?: string | null;
  // The order row this line settles: OrderLineReference/LineID. Nav has no
  // order line numbers, so the service passes "<orderNumber>:<n>"-style text
  // or null for a free row — the builder only prints what it is given.
  orderLineReference: string | null;
  // "Grupp: Värde" lines from configurationLines() (no prices), each as
  // Item/AdditionalItemProperty Name/Value.
  properties: { name: string; value: string }[];
}

export interface UblAttachment {
  filename: string; // e.g. "Faktura-FA-1234.pdf"
  description: string; // "Faktura (PDF)" / "Kreditfaktura (PDF)"
  mimeCode: "application/pdf";
  content: Buffer;
}

export interface UblInvoiceInput {
  type: UblDocumentType;
  invoiceNumber: string; // BT-1
  issueDate: string; // BT-2, YYYY-MM-DD
  dueDate: string | null; // BT-9 (invoice only; omitted on a credit note)
  currency: "SEK"; // etapp 1
  // BT-10 and BT-13: Peppol requires at least one. The service resolves the
  // rule (first linked order's customer_reference / customer_order_number,
  // else the customer number as BT-10) — the builder prints what it gets and
  // ubl-check refuses a document with neither.
  buyerReference: string | null;
  orderReference: string | null;
  // Credit note only: the credited invoice's number (BT-25), null otherwise.
  creditedInvoiceNumber: string | null;
  // BT-22 free-text note (invoices.note), optional.
  note: string | null;
  paymentTermsNote: string | null; // payment term name snapshot
  seller: UblSeller;
  buyer: UblBuyer;
  payment: UblPayment;
  lines: UblLine[];
  attachment: UblAttachment | null;
}

// ubl-check.ts: structural problems found before anything leaves Nav, in
// Swedish, one sentence each. Empty = OK.
export type UblCheckResult = string[];

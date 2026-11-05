import type { Tx } from "@navet/db";
import type { ReceivedEInvoice, ReceivedEInvoiceAttachment } from "../../../einvoice/service/ubl/received-einvoice.js";
import type { InvoiceScanRow } from "../../repository/invoice-scan.repository.js";

// The contract between the Fakturainkorg and the e-invoice reception (spec
// 2026-11-05-e-faktura-mottagning). The purchase module DEFINES both sides:
// the reader it needs for an e-invoice post (einvoice implements it, bound
// late in app.ts like variantPriceRef) and the importer the reception calls
// inside its own transaction (invoiceScanService.importEInvoiceInTx).

export interface EInvoiceOriginalView {
  einvoice: ReceivedEInvoice;
  receptionId: string;
  environment: "sandbox" | "production";
  senderEndpoint: string | null;
  senderName: string | null;
  receivedAt: Date;
  attachments: ReceivedEInvoiceAttachment[];
}

// What the inbox shows about an e-invoice post without touching the XML:
// the reception row's columns and the attachment list stored at import.
export interface EInvoiceOriginalInfo {
  environment: "sandbox" | "production";
  senderEndpoint: string | null;
  senderName: string | null;
  receivedAt: Date;
  attachments: EInvoiceAttachmentMeta[];
}

export interface EInvoiceAttachmentMeta {
  index: number;
  filename: string | null;
  // Already whitelisted (safeAttachmentContentType).
  contentType: string;
  sizeBytes: number;
}

// The content types an embedded attachment is served with: what Peppol BIS
// allows (PDF, PNG, JPEG, CSV, the spreadsheet formats) plus XML/plain
// text; anything else — including a sender-controlled text/html or a
// value with stray characters — is application/octet-stream.
export const ATTACHMENT_CONTENT_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "application/xml",
  "text/xml",
  "text/csv",
  "text/plain",
  "application/octet-stream",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.oasis.opendocument.spreadsheet",
]);

export function safeAttachmentContentType(mimeCode: string | null | undefined): string {
  const type = (mimeCode ?? "").trim().toLowerCase();
  return ATTACHMENT_CONTENT_TYPES.has(type) ? type : "application/octet-stream";
}

export interface EInvoiceOriginalReader {
  // The row's data for the detail (no XML parsed); null when the scan did
  // not come as an e-invoice.
  infoForScan(scanId: string): Promise<EInvoiceOriginalInfo | null>;
  // The original read again (through the UBL reader, or the access point's
  // BIS3 rendering when the original is not UBL); null when the scan did
  // not come as an e-invoice.
  forScan(scanId: string): Promise<EInvoiceOriginalView | null>;
  // The XML exactly as received (räkenskapsinformation), with its content
  // type and a file name; null when not an e-invoice post.
  originalXml(scanId: string): Promise<{ xml: Buffer; contentType: string; filename: string } | null>;
  // One embedded attachment by its index; null when there is none.
  attachment(scanId: string, index: number): Promise<{ filename: string; contentType: string; data: Buffer } | null>;
}

export interface EInvoiceImportInput {
  // The scan's file: the embedded PDF or Nav's visningskopia.
  filename: string;
  pdf: Buffer;
  sha256: string;
}

export type EInvoiceImportOutcome =
  | { ok: true; scan: InvoiceScanRow }
  // The same PDF is live in the inbox (the dubblettspärr on sha256).
  | { ok: false; reason: "duplicate"; existing: { id: string; scanNumber: string } };

export interface InvoiceScanEInvoiceImporter {
  importEInvoiceInTx(tx: Tx, input: EInvoiceImportInput): Promise<EInvoiceImportOutcome>;
  // The interpretation of freshly imported e-invoice posts, after commit.
  interpretEInvoices(scanIds: string[]): Promise<void>;
  // The same, but only for a post still `new` without a result — a run that
  // died between commit and interpretation left it so.
  interpretEInvoicesIfNew(scanIds: string[]): Promise<void>;
}

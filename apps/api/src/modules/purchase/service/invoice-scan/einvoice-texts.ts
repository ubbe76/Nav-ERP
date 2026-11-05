import { INVOICE_SCAN_MAX_FILE_BYTES } from "@navet/shared";

// The ONE text for an embedded PDF the inbox cannot take as the post's
// file (larger than the upload cap): the reception prints it on the
// visningskopia and the interpretation adds it to the result's checks.
export const RECEIVE_ATTACHMENT_MAX_BYTES_TEXT = {
  limit: INVOICE_SCAN_MAX_FILE_BYTES,
  text: "Bilagan var för stor och finns kvar i e-fakturan",
} as const;

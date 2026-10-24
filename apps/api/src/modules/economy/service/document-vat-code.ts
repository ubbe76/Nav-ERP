import { isVatCode, supplierDefaultVatCode, vatCodeAllowedOn, vatCodeEntry, type VatCode } from "@navet/shared";

// Momskoder on the documents (spec 4.2 and 5): the choice of a code on a
// customer invoice row or a supplier invoice header/row. Pure leaf — the
// sales and purchase modules hold the company's vat_codes rows (loaded once
// per call through economy/repository/vat-codes.ts) and ask here whether a
// code may be used, without importing the economy service.

// One vat_codes row as the documents need it.
export type DocumentVatCodeRow = {
  id: string;
  code: VatCode;
  name: string;
  invoiceText: string | null;
  active: boolean;
};

// All codes of the company, by id and by catalog code — 20 rows, read once
// per document operation instead of once per row.
export type VatCodeBook = {
  byId: Map<string, DocumentVatCodeRow>;
  byCode: Map<VatCode, DocumentVatCodeRow>;
};

export function vatCodeBook(rows: { id: string; code: string; name: string; invoiceText: string | null; active: boolean }[]): VatCodeBook {
  const byId = new Map<string, DocumentVatCodeRow>();
  const byCode = new Map<VatCode, DocumentVatCodeRow>();
  for (const row of rows) {
    // vat_codes.code is CHECKed against the catalog; anything else is ignored.
    if (!isVatCode(row.code)) continue;
    const entry: DocumentVatCodeRow = { id: row.id, code: row.code, name: row.name, invoiceText: row.invoiceText, active: row.active };
    byId.set(row.id, entry);
    byCode.set(row.code, entry);
  }
  return { byId, byCode };
}

// A code that cannot be put on the document: unknown id, inactive, or a code
// of the wrong direction (a purchase code on a customer invoice, a sales code
// on a supplier invoice, an import code anywhere but the importmoms). The
// route answers 400 with `reason`.
export type InvalidVatCodeReason = "unknown" | "inactive" | "not_applicable";

export class InvalidVatCodeError extends Error {
  constructor(
    public readonly reason: InvalidVatCodeReason,
    public readonly vatCode: string,
    public readonly document: "sales" | "purchase"
  ) {
    super(
      reason === "unknown"
        ? `VAT code ${vatCode} not found`
        : reason === "inactive"
          ? `VAT code ${vatCode} is inactive`
          : `VAT code ${vatCode} cannot be used on a ${document} document`
    );
    this.name = "InvalidVatCodeError";
  }
}

// The code a document row/header may carry. `allowInactive` is for a code the
// document already carries (a PATCH that leaves it alone, a credit note that
// mirrors its source row) — deactivating a code must not lock existing drafts.
export function documentVatCode(
  book: VatCodeBook,
  ref: { id: string } | { code: VatCode },
  document: "sales" | "purchase",
  opts: { allowInactive?: boolean } = {}
): DocumentVatCodeRow {
  const row = "id" in ref ? book.byId.get(ref.id) : book.byCode.get(ref.code);
  const label = "id" in ref ? ref.id : ref.code;
  if (!row) throw new InvalidVatCodeError("unknown", label, document);
  if (!vatCodeAllowedOn(row.code, document)) throw new InvalidVatCodeError("not_applicable", row.code, document);
  if (!row.active && !opts.allowInactive) throw new InvalidVatCodeError("inactive", row.code, document);
  return row;
}

// The row's code as the detail GETs return it: the company's name, the
// catalog's rate.
export type VatCodeRef = { id: string; code: string; name: string; rate: number };

export function vatCodeRef(row: { id: string; code: string; name: string }): VatCodeRef {
  return { id: row.id, code: row.code, name: row.name, rate: isVatCode(row.code) ? vatCodeEntry(row.code).rate : 0 };
}

// Leverantörens Momskod (förval), spec 5: the supplier's own code, else the
// one derived from its country (supplierDefaultVatCode). `derived` tells the
// card which of the two it is.
export function supplierVatCode(
  book: VatCodeBook,
  supplier: { country: string; defaultVatCodeId: string | null }
): { row: DocumentVatCodeRow; derived: boolean } | null {
  if (supplier.defaultVatCodeId) {
    const own = book.byId.get(supplier.defaultVatCodeId);
    if (own) return { row: own, derived: false };
  }
  const derived = book.byCode.get(supplierDefaultVatCode(supplier.country));
  return derived ? { row: derived, derived: true } : null;
}

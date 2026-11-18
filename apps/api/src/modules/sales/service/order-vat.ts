import { round2, salesRowAmounts, vatCodeEntry, type VatCode } from "@navet/shared";
import { computePerRowVatGroups } from "../../mail/service/document-pdf.js";

// Moms på offert och kundorder. An order row stores no VAT — it is derived
// when read, by the SAME rules the invoice row will be written with: the
// momskod from salesVatCode (the caller), the amounts from salesRowAmounts
// (net with the discount baked in, VAT rounded per row) and the grouping per
// rate + code from computePerRowVatGroups (the invoice's summary). The
// quote/order confirmation PDF and GET /sales-orders/:id both go through
// here, so the document, the card and the invoice that follows agree to the
// öre. No DB access.

export type SalesOrderVatInputRow = {
  // Base unit, as stored on the order row.
  quantity: number;
  unitPrice: number;
  discountPercent: number;
  code: VatCode;
  // The code's name as it is to be shown (the company's, already localized).
  name: string;
};

export type SalesOrderRowVat = { code: VatCode; name: string; rate: number; lineAmount: number; vatAmount: number };

export function salesOrderRowVat(row: SalesOrderVatInputRow): SalesOrderRowVat {
  const rate = vatCodeEntry(row.code).rate;
  return {
    code: row.code,
    name: row.name,
    rate,
    ...salesRowAmounts({ quantity: row.quantity, unitPrice: row.unitPrice, discountPercent: row.discountPercent, vatRate: rate }),
  };
}

export type SalesOrderVatSummary = {
  // One line per rate + code, highest rate first, then in catalog order — a
  // 0 % code (EU sale, export, momsfritt) is a line too, with its own name.
  lines: { code: string; name: string; rate: number; net: number; vatAmount: number }[];
  totalExclVat: number;
  vatAmount: number;
  totalInclVat: number;
};

export function salesOrderVatSummary(rows: SalesOrderRowVat[]): SalesOrderVatSummary {
  const groups = computePerRowVatGroups(
    rows.map((row) => ({
      quantity: "0",
      unitPrice: "0",
      vatRate: row.rate,
      vatCode: { code: row.code, name: row.name },
      lineAmount: String(row.lineAmount),
      vatAmount: String(row.vatAmount),
    }))
  );
  const lines = groups.map((group) => ({
    code: group.code ?? "",
    name: group.name ?? "",
    rate: group.rate,
    net: round2(group.net),
    vatAmount: round2(group.vatAmount),
  }));
  const totalExclVat = round2(lines.reduce((sum, line) => sum + line.net, 0));
  const vatAmount = round2(lines.reduce((sum, line) => sum + line.vatAmount, 0));
  return { lines, totalExclVat, vatAmount, totalInclVat: round2(totalExclVat + vatAmount) };
}

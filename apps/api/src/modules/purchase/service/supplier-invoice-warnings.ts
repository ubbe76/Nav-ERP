import { VAT_CODE_CATALOG, isDomesticVatCode, type VatCode } from "@navet/shared";

// Leverantörsfakturans varningar (Momskoder, slutgranskningen) — pure leaf,
// read by the detail GET. Never a refusal: the attest posts what the invoice
// says; these only point at the two typical mistakes behind it.
//
//   * A domestic code with VAT (MP25/MP12/MP6) covers part of an invoice with
//     a non-zero net, but the invoice has no VAT amount — typically a foreign
//     purchase that should carry an omvänd code (IEUV25 …) instead, or a
//     forgotten momsbelopp.
//   * The supplier's currency is not SEK but its country is Sverige — the
//     country (which derives the förvald momskod) is probably wrong.
export type SupplierInvoiceWarningInput = {
  headerCode: VatCode;
  netAmount: number;
  vatAmount: number;
  // Each row's own code (null = the header's) and amount.
  rows: { code: VatCode | null; lineAmount: number }[];
  supplierCountry: string;
  supplierCurrency: string;
};

export function supplierInvoiceWarnings(input: SupplierInvoiceWarningInput): string[] {
  const warnings: string[] = [];

  if (input.netAmount !== 0 && input.vatAmount === 0) {
    // The base each code covers — the same split as reverseVatPreview: the
    // header's code takes the rows without a code and the remainder.
    const baseByCode = new Map<VatCode, number>();
    const add = (code: VatCode, amount: number) =>
      baseByCode.set(code, Math.round(((baseByCode.get(code) ?? 0) + amount) * 100) / 100);
    let rowTotal = 0;
    for (const row of input.rows) {
      add(row.code ?? input.headerCode, row.lineAmount);
      rowTotal += row.lineAmount;
    }
    const remainder = Math.round((input.netAmount - rowTotal) * 100) / 100;
    if (remainder !== 0) add(input.headerCode, remainder);

    // The header's code first, then the rows' in catalog order.
    const candidates = [input.headerCode, ...VAT_CODE_CATALOG.map((entry) => entry.code)];
    const withVat = candidates.find((code) => {
      const entry = VAT_CODE_CATALOG.find((candidate) => candidate.code === code)!;
      return isDomesticVatCode(code) && entry.rate > 0 && (baseByCode.get(code) ?? 0) !== 0;
    });
    if (withVat) {
      const rate = VAT_CODE_CATALOG.find((entry) => entry.code === withVat)!.rate;
      warnings.push(
        `Momskoden ${withVat} har ${rate} % moms men fakturan har inget momsbelopp — kontrollera momskoden (utlandsköp ska ha en omvänd kod)`
      );
    }
  }

  if (input.supplierCurrency.trim().toUpperCase() !== "SEK" && input.supplierCountry.trim().toUpperCase() === "SE") {
    warnings.push("Leverantören har annan valuta än SEK men land Sverige — kontrollera landet");
  }
  return warnings;
}

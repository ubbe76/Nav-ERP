import { formatLocationLabelCode, gtinForms, normalizeScanCode, parseLocationLabelCode, type ScanMatch } from "@navet/shared";
import type { ScanRepository } from "../repository/scan.repository.js";

// Skanning (#4; spec 2026-10-29-skanning-design.md): what a scanned code is.
// Every match is returned — an article number can equal an order number —
// in a fixed order: the lagerplats label, the article (by EAN, then by
// article number), then the orders. Each routine picks the kind it expects
// (inleverans an IO or an article, inventering a location or an article), so
// the order only matters for the Skanna page, which shows them all.
export function createScanService(repo: ScanRepository) {
  return {
    async resolve(raw: string): Promise<{ code: string; matches: ScanMatch[] }> {
      const code = normalizeScanCode(raw);
      const matches: ScanMatch[] = [];
      if (code === "") return { code, matches };

      const labelNumber = parseLocationLabelCode(code);
      if (labelNumber !== null) {
        const location = await repo.locationByLabelNumber(labelNumber);
        if (location) {
          matches.push({
            kind: "location",
            id: location.id,
            labelCode: formatLocationLabelCode(location.labelNumber),
            name: location.name,
            warehouseName: location.warehouseName,
            active: location.active,
            blocked: location.blocked,
          });
        }
      }

      // A GTIN in any of its forms (12-digit UPC-A = EAN-13 with a leading
      // 0, gtinKey): every stored form is asked for. A code that is no valid
      // GTIN matches no barcode (they are all valid — articleBarcodeSchema).
      const barcodeForms = gtinForms(code);
      const [articleRows, purchaseOrder, salesOrder, manufacturingOrder] = await Promise.all([
        repo.articlesByCode(code, barcodeForms),
        repo.purchaseOrderByNumber(code),
        repo.salesOrderByNumber(code),
        repo.manufacturingOrderByNumber(code),
      ]);
      // EAN first: a package's code is the more specific answer.
      // Two articles holding the same GTIN in two forms (saved before the
      // duplicate check compared keys) both come back — the Skanna page
      // shows them; the routines pick by kind.
      const byBarcode = articleRows.filter((a) => a.barcode !== null && barcodeForms.includes(a.barcode));
      const byNumber = articleRows.filter((a) => a.articleNumber === code && !byBarcode.includes(a));
      for (const [rows, matchedBy] of [
        [byBarcode, "barcode"],
        [byNumber, "articleNumber"],
      ] as const) {
        for (const a of rows) {
          matches.push({
            kind: "article",
            id: a.id,
            articleNumber: a.articleNumber,
            name: a.name,
            type: a.type,
            unitCode: a.unitCode,
            active: a.active,
            matchedBy,
          });
        }
      }
      if (purchaseOrder) matches.push({ kind: "purchaseOrder", ...purchaseOrder });
      if (salesOrder) matches.push({ kind: "salesOrder", ...salesOrder });
      if (manufacturingOrder) matches.push({ kind: "manufacturingOrder", ...manufacturingOrder });
      return { code, matches };
    },
  };
}

export type ScanService = ReturnType<typeof createScanService>;

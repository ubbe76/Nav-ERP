import { formatLocationLabelCode, normalizeScanCode, parseLocationLabelCode, type ScanMatch } from "@navet/shared";
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
          });
        }
      }

      const [articleRows, purchaseOrder, salesOrder, manufacturingOrder] = await Promise.all([
        repo.articlesByCode(code),
        repo.purchaseOrderByNumber(code),
        repo.salesOrderByNumber(code),
        repo.manufacturingOrderByNumber(code),
      ]);
      // EAN first: a package's code is the more specific answer.
      const byBarcode = articleRows.filter((a) => a.barcode === code);
      const byNumber = articleRows.filter((a) => a.articleNumber === code && a.barcode !== code);
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

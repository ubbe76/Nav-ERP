import {
  formatLocationLabelCode,
  gtinForms,
  normalizeScanCode,
  parseGs1,
  parseLocationLabelCode,
  type ScanMatch,
  type ScanResult,
} from "@navet/shared";
import type { ScanRepository } from "../repository/scan.repository.js";
import { stockTrackingOf } from "../../stock/service/article-tracking.js";
import { stockholmToday } from "../../system/service/delivery-days.js";

// Skanning (#4; spec 2026-10-29-skanning-design.md): what a scanned code is.
// Every match is returned — an article number can equal an order number —
// in a fixed order: the lagerplats label, the article (by EAN, then by
// article number), then the orders. Each routine picks the kind it expects
// (inleverans an IO or an article, inventering a location or an article), so
// the order only matters for the Skanna page, which shows them all.
//
// GS1 (#8 etapp 2 steg 6): the raw code is read with parseGs1 BEFORE it is
// cleaned (the cleaning drops the separator between the fields). A GS1 code
// finds its article on the GTIN inside it, and the answer carries what else
// the code said (`gs1`: batch, serienummer, utgångsdatum, antal). Last come
// the batches and serienummer that already exist under the scanned number —
// with where they stand. Nothing is ever created by a scan.
export function createScanService(repo: ScanRepository) {
  return {
    async resolve(raw: string): Promise<ScanResult> {
      const parsed = parseGs1(raw, { today: stockholmToday() });
      const gs1 = parsed && {
        gtin: parsed.gtin,
        batch: parsed.batch,
        serial: parsed.serial,
        expiresOn: parsed.expiresOn,
        quantity: parsed.quantity,
      };
      const code = normalizeScanCode(raw);
      const matches: ScanMatch[] = [];
      if (code === "") return { code, matches, gs1 };

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
      // The ordinary lookups on the whole code always run beside the GS1
      // reading — nothing is shadowed by it.
      const barcodeForms = [...new Set([...gtinForms(code), ...(gs1?.gtin ? gtinForms(gs1.gtin) : [])])];
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
            stockTracking: stockTrackingOf(a),
          });
        }
      }
      if (purchaseOrder) matches.push({ kind: "purchaseOrder", ...purchaseOrder });
      if (salesOrder) matches.push({ kind: "salesOrder", ...salesOrder });
      if (manufacturingOrder) matches.push({ kind: "manufacturingOrder", ...manufacturingOrder });

      // The number the code names: the GS1 fields (the serienummer first),
      // else the whole code. A GS1 code with a GTIN only finds numbers on
      // that article — the same number may exist on several.
      const numbers = gs1 ? [gs1.serial, gs1.batch].filter((n): n is string => n !== null) : [code];
      const batches = await repo.batchesByNumber(numbers, gs1?.gtin ? byBarcode.map((a) => a.id) : null);
      const balances = await repo.batchBalances(batches.map((b) => b.id));
      const rank = (b: { batchNumber: string }) => numbers.findIndex((n) => n.toLowerCase() === b.batchNumber.toLowerCase());
      for (const b of [...batches].sort((x, y) => rank(x) - rank(y))) {
        const locations = balances
          .filter((l) => l.batchId === b.id)
          .map((l) => ({
            locationId: l.locationId,
            locationName: l.locationName,
            warehouseName: l.warehouseName,
            blocked: l.blocked,
            quantity: Number(l.quantity),
          }));
        matches.push({
          kind: "batch",
          ...b,
          quantityOnHand: locations.reduce((sum, l) => sum + l.quantity, 0),
          locations,
        });
      }
      return { code, matches, gs1 };
    },
  };
}

export type ScanService = ReturnType<typeof createScanService>;

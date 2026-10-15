import { apiFetch } from "./api";
import type { CreatedInquiry, Inquiry, InquiryRow, LegoInquiryRowInput } from "./types";

// Creates one förfrågan per selected supplier, each carrying every selected
// lego row — a legoförfrågan is a request for competing quotes on the same
// operations, unlike "Skapa ordrar" which always books to the operation's own
// primary supplier. Mirrors the bucketing in
// apps/api/src/modules/planning/service/planning.service.ts:213-215 (kept in
// sync there): within one supplier, rows are packed into buckets so no
// bucket holds the same articleId twice — `inquiry_rows` has
// unique(inquiryId, articleId), so a second lego row on the same article
// opens a second draft förfrågan for that supplier. Each bucket is posted
// sequentially (no batch endpoint), mirroring the inleverans/utleverans
// routines' per-row-endpoint loops. Never throws — a failed bucket is
// reported in `errors` and the remaining buckets/suppliers still go out.
export async function createLegoInquiries({
  suppliers,
  rows,
  note,
}: {
  suppliers: { id: string; name: string }[];
  rows: LegoInquiryRowInput[];
  note?: string;
}): Promise<{
  created: CreatedInquiry[];
  errors: { supplierName: string; articleNumbers: string[]; message: string }[];
}> {
  const created: CreatedInquiry[] = [];
  const errors: { supplierName: string; articleNumbers: string[]; message: string }[] = [];

  for (const supplier of suppliers) {
    const buckets: LegoInquiryRowInput[][] = [];
    for (const row of rows) {
      const bucket = buckets.find((b) => !b.some((r) => r.articleId === row.articleId));
      if (bucket) bucket.push(row);
      else buckets.push([row]);
    }

    for (const bucket of buckets) {
      try {
        const res = await apiFetch<{ inquiry: Inquiry; rows: InquiryRow[] }>("/api/v1/inquiries", {
          method: "POST",
          body: JSON.stringify({
            supplierId: supplier.id,
            note,
            rows: bucket.map((r) => ({
              articleId: r.articleId,
              quantity: r.quantity,
              moOperationId: r.moOperationId,
              routingOperationId: r.routingOperationId,
              setupPrice: r.setupPrice,
            })),
          }),
        });
        created.push({
          id: res.inquiry.id,
          inquiryNumber: res.inquiry.inquiryNumber,
          supplierId: supplier.id,
          supplierName: supplier.name,
          rowCount: bucket.length,
        });
      } catch (err) {
        errors.push({
          supplierName: supplier.name,
          articleNumbers: bucket.map((r) => r.articleNumber),
          message: err instanceof Error ? err.message : "Förfrågan kunde inte skapas",
        });
      }
    }
  }

  return { created, errors };
}

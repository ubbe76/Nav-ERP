import { apiFetch } from "./api";
import type { CreatedInquiry, Inquiry, InquiryRow, LegoInquiryRowInput } from "./types";
import { apiErrorMessage } from "./errorMessages";

// Creates one förfrågan per selected supplier, each carrying every selected
// lego row — a legoförfrågan is a request for competing quotes on the same
// operations, unlike "Skapa ordrar" which always books to the operation's own
// primary supplier. Two lego rows on the same article go on the same
// förfrågan as two rows (the same article may sit on several rows), as
// "Skapa ordrar" does in planning.service.ts. The suppliers are posted
// sequentially (no batch endpoint), mirroring the inleverans/utleverans
// routines' per-row-endpoint loops. Never throws — a failed förfrågan is
// reported in `errors` and the remaining suppliers still go out.
// What createLegoInquiries answers — one förfrågan per supplier that got
// one, and the suppliers that failed with their rows' article numbers. The
// one shape the behovsberäkning, the lego dialog and the result panel share.
export type LegoInquiryResult = {
  created: CreatedInquiry[];
  errors: { supplierName: string; articleNumbers: string[]; message: string }[];
};

export async function createLegoInquiries({
  suppliers,
  rows,
  note,
}: {
  suppliers: { id: string; name: string }[];
  rows: LegoInquiryRowInput[];
  note?: string;
}): Promise<LegoInquiryResult> {
  const created: CreatedInquiry[] = [];
  const errors: { supplierName: string; articleNumbers: string[]; message: string }[] = [];

  for (const supplier of suppliers) {
    try {
      const res = await apiFetch<{ inquiry: Inquiry; rows: InquiryRow[] }>("/api/v1/inquiries", {
        method: "POST",
        body: JSON.stringify({
          supplierId: supplier.id,
          note,
          rows: rows.map((r) => ({
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
        rowCount: rows.length,
      });
    } catch (err) {
      errors.push({
        supplierName: supplier.name,
        articleNumbers: rows.map((r) => r.articleNumber),
        message: apiErrorMessage(err, "Förfrågan kunde inte skapas"),
      });
    }
  }

  return { created, errors };
}

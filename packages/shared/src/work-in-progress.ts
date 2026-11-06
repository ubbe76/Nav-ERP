import { z } from "zod";

// Produkter i arbete (PIA) per datum (#25): the efterkalkyl per a day for
// every TO open on that day, less what it has already received into stock.

// Underlag: what the accumulated cost consists of. "manufacturing_cost" =
// Tillverkningskostnad (TVK: material + MO + lön + lego + LO, the same make-up
// Sätt standardpris gives the finished goods); "direct" = material + lön +
// lego without MO and LO. TO (the work center's overhead) is never part of
// either — it lies outside TVK.
export const wipBasisSchema = z.enum(["manufacturing_cost", "direct"]);
export type WipBasis = z.infer<typeof wipBasisSchema>;

export const WIP_BASIS_LABELS: Record<WipBasis, string> = {
  manufacturing_cost: "Tillverkningskostnad",
  direct: "Direkta kostnader",
};

// GET /costing/work-in-progress(?/pdf): asOf omitted = today as a Stockholm day.
export const workInProgressQuerySchema = z.object({
  asOf: z.string().date().optional(),
  basis: wipBasisSchema.default("manufacturing_cost"),
});
export type WorkInProgressQuery = z.input<typeof workInProgressQuerySchema>;

// Årsbokslut, the step Produkter i arbete. The preview's basis omitted = the
// closing's default (the previous closed year's choice, else
// manufacturing_cost).
export const workInProgressPreviewQuerySchema = z.object({ basis: wipBasisSchema.optional() });
export const bookWorkInProgressSchema = z.object({ basis: wipBasisSchema });
export type BookWorkInProgressInput = z.infer<typeof bookWorkInProgressSchema>;

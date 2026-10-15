import { z } from "zod";

// F1 Rapporter — query schemas. All reports take an optional month range
// (YYYY-MM strings, lexicographically comparable); the service defaults a
// missing range to the last 12 months including the current one.

const monthParam = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Ange månad som ÅÅÅÅ-MM");

export const reportRangeSchema = z
  .object({
    from: monthParam.optional(),
    to: monthParam.optional(),
  })
  .refine((q) => !q.from || !q.to || q.from <= q.to, { message: "from måste vara före to" });
export type ReportRangeQuery = z.infer<typeof reportRangeSchema>;

export const salesStatisticsQuerySchema = z
  .object({
    from: monthParam.optional(),
    to: monthParam.optional(),
    groupBy: z.enum(["month", "customer", "article"]).default("month"),
  })
  .refine((q) => !q.from || !q.to || q.from <= q.to, { message: "from måste vara före to" });
export type SalesStatisticsQuery = z.infer<typeof salesStatisticsQuerySchema>;

// Marginalrapporten (täckningsbidrag) — same shape as the sales statistics it
// sits beside, so the two pages share their toolbar and read alike.
export const orderMarginQuerySchema = z
  .object({
    from: monthParam.optional(),
    to: monthParam.optional(),
    groupBy: z.enum(["month", "customer", "article"]).default("month"),
  })
  .refine((q) => !q.from || !q.to || q.from <= q.to, { message: "from måste vara före to" });
export type OrderMarginQuery = z.infer<typeof orderMarginQuerySchema>;

export const purchaseStatisticsQuerySchema = z
  .object({
    from: monthParam.optional(),
    to: monthParam.optional(),
    groupBy: z.enum(["month", "supplier", "article"]).default("month"),
  })
  .refine((q) => !q.from || !q.to || q.from <= q.to, { message: "from måste vara före to" });
export type PurchaseStatisticsQuery = z.infer<typeof purchaseStatisticsQuerySchema>;

export const scrapStatisticsQuerySchema = z
  .object({
    from: monthParam.optional(),
    to: monthParam.optional(),
    groupBy: z.enum(["month", "article", "workCenter", "reason"]).default("month"),
  })
  .refine((q) => !q.from || !q.to || q.from <= q.to, { message: "from måste vara före to" });
export type ScrapStatisticsQuery = z.infer<typeof scrapStatisticsQuerySchema>;

// CSV variant of delivery precision exports one side at a time.
export const deliveryPrecisionCsvQuerySchema = z
  .object({
    from: monthParam.optional(),
    to: monthParam.optional(),
    kind: z.enum(["sales", "purchase"]),
  })
  .refine((q) => !q.from || !q.to || q.from <= q.to, { message: "from måste vara före to" });
export type DeliveryPrecisionCsvQuery = z.infer<typeof deliveryPrecisionCsvQuerySchema>;

import { z } from "zod";
import { purchaseOrderStatusSchema } from "./purchase.js";
import { salesOrderStatusSchema } from "./sales.js";

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

// Leveransprecision: Gruppera Månad (default, the original view) or Motpart
// (Kvalitet: per supplier/customer with the quality columns).
export const DELIVERY_PRECISION_GROUPINGS = ["month", "counterparty"] as const;
export type DeliveryPrecisionGrouping = (typeof DELIVERY_PRECISION_GROUPINGS)[number];

export const deliveryPrecisionQuerySchema = z
  .object({
    from: monthParam.optional(),
    to: monthParam.optional(),
    groupBy: z.enum(DELIVERY_PRECISION_GROUPINGS).default("month"),
  })
  .refine((q) => !q.from || !q.to || q.from <= q.to, { message: "from måste vara före to" });
export type DeliveryPrecisionQuery = z.infer<typeof deliveryPrecisionQuerySchema>;

// CSV variant of delivery precision exports one side at a time.
export const deliveryPrecisionCsvQuerySchema = z
  .object({
    from: monthParam.optional(),
    to: monthParam.optional(),
    kind: z.enum(["sales", "purchase"]),
    groupBy: z.enum(DELIVERY_PRECISION_GROUPINGS).default("month"),
  })
  .refine((q) => !q.from || !q.to || q.from <= q.to, { message: "from måste vara före to" });
export type DeliveryPrecisionCsvQuery = z.infer<typeof deliveryPrecisionCsvQuerySchema>;

// Orderförteckning — one register per side (kundorder / inköpsorder). The
// selection works on ORDER ROWS: a date range on the order date or the row's
// effective delivery date, article/varugrupp/artikelkod and "rest kvar" pick rows,
// and an order is listed with the rows that matched (its values sum only
// those). Status and partner filter the order. Dates are YYYY-MM-DD.
const dayParam = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Ange datum som ÅÅÅÅ-MM-DD");
const flagParam = z
  .enum(["true", "false"])
  .transform((value) => value === "true")
  .optional();

function orderRegisterQuerySchema<T extends readonly [string, ...string[]]>(statuses: T) {
  return z
    .object({
      dateBasis: z.enum(["order", "delivery"]).default("order"),
      from: dayParam.optional(),
      to: dayParam.optional(),
      partnerId: z.string().uuid().optional(),
      // "open" = the side's not-yet-finished statuses; otherwise a comma list.
      status: z
        .string()
        .optional()
        .transform((raw, ctx) => {
          if (raw === undefined || raw.trim() === "") return undefined;
          if (raw === "open") return "open" as const;
          const parts = raw.split(",").map((p) => p.trim()).filter((p) => p !== "");
          const invalid = parts.filter((p) => !(statuses as readonly string[]).includes(p));
          if (invalid.length > 0) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Okänd status: ${invalid.join(", ")}` });
            return z.NEVER;
          }
          return parts as T[number][];
        }),
      openOnly: flagParam,
      articleId: z.string().uuid().optional(),
      articleGroupId: z.string().uuid().optional(),
      articleCodeId: z.string().uuid().optional(),
      withRows: flagParam,
    })
    .refine((q) => !q.from || !q.to || q.from <= q.to, { message: "from måste vara före to" });
}

export const SALES_ORDER_OPEN_STATUSES = ["quote", "confirmed", "in_production"] as const;
export const PURCHASE_ORDER_OPEN_STATUSES = ["draft", "confirmed", "partially_received"] as const;

export const salesOrderRegisterQuerySchema = orderRegisterQuerySchema(salesOrderStatusSchema.options);
export type SalesOrderRegisterQuery = z.infer<typeof salesOrderRegisterQuerySchema>;

export const purchaseOrderRegisterQuerySchema = orderRegisterQuerySchema(purchaseOrderStatusSchema.options);
export type PurchaseOrderRegisterQuery = z.infer<typeof purchaseOrderRegisterQuerySchema>;

// Offertuppföljning (quote follow-up) — the quotes (quoted = true) created
// in [from, to] (Stockholm days), optionally one customer's. The web's
// default is the current year, so both dates are required here.
// Projektrapport: one project's revenue, costs and result out of the booked
// verification rows that carry it, per month and per account, plus the
// customer orders pointing at the project. from/to optional = all time.
export const projectReportQuerySchema = z
  .object({
    projectId: z.string().uuid(),
    from: dayParam.optional(),
    to: dayParam.optional(),
  })
  .refine((q) => !q.from || !q.to || q.from <= q.to, { message: "from måste vara före to" });
export type ProjectReportQuery = z.infer<typeof projectReportQuerySchema>;

export interface ProjectReportMonth {
  month: string; // YYYY-MM
  revenue: number;
  costs: number;
  result: number;
}

// amount is the row's result contribution (credit − debit): revenue
// positive, a cost negative — so Σ amount = result.
export interface ProjectReportAccount {
  accountNumber: string;
  accountName: string;
  amount: number;
}

export interface ProjectReportSalesOrder {
  id: string;
  orderNumber: string;
  status: string;
  // Σ rows (antal × à-pris × (1 − rabatt)) in SEK, like the offertuppföljning.
  value: number;
}

export interface ProjectReport {
  project: { id: string; code: string; name: string; status: string; customerName: string | null };
  from: string | null;
  to: string | null;
  // revenue and costs are both positive; result = revenue − costs.
  revenue: number;
  costs: number;
  result: number;
  months: ProjectReportMonth[];
  accounts: ProjectReportAccount[];
  salesOrders: ProjectReportSalesOrder[];
}

export const quoteFollowupQuerySchema = z
  .object({
    from: dayParam,
    to: dayParam,
    customerId: z.string().uuid().optional(),
  })
  .refine((q) => q.from <= q.to, { message: "from måste vara före to" });
export type QuoteFollowupQuery = z.infer<typeof quoteFollowupQuerySchema>;

// The outcome of a quote: won (confirmed/in production/delivered/invoiced),
// lost, open (status quote; `expired` when Giltig t.o.m. has passed) or
// cancelled. Cancelled quotes are listed but never counted in the hit rate.
export type QuoteOutcome = "won" | "lost" | "open" | "cancelled";

export interface QuoteFollowupFigures {
  count: number;
  value: number;
  won: number;
  wonValue: number;
  lost: number;
  lostValue: number;
  open: number;
  openValue: number;
  // Of the open ones, those whose validity date has passed.
  expired: number;
  expiredValue: number;
  cancelled: number;
  cancelledValue: number;
  // won / (won + lost) by count and by value — null when the denominator is 0.
  hitRateCount: number | null;
  hitRateValue: number | null;
}

export interface QuoteFollowupCustomer extends QuoteFollowupFigures {
  customerId: string;
  customerNumber: string;
  customerName: string;
}

export interface QuoteFollowupMonth extends QuoteFollowupFigures {
  month: string; // YYYY-MM
}

export interface QuoteFollowupLossReason {
  // null = lost without a reason (the manual status override): the row
  // "Ingen orsak angiven".
  reasonId: string | null;
  code: string | null;
  name: string;
  count: number;
  value: number;
  // Share of the lost quotes by count; null when none are lost.
  share: number | null;
}

export interface QuoteFollowupQuote {
  id: string;
  // Offerter (0138): the Offert column — the quote's OF- number, or the
  // KO- number of a quote created before the OF- series (coalesce).
  quoteNumber: string;
  // The record's current number: equals quoteNumber until an OF- numbered
  // quote is won and takes a KO- number (the Order column when it differs).
  orderNumber: string;
  // Which card the row links to (Offerter or Kundorder).
  documentKind: "quote" | "order";
  customerId: string;
  customerNumber: string;
  customerName: string;
  createdDate: string; // YYYY-MM-DD, Stockholm
  quoteValidUntil: string | null;
  status: string;
  outcome: QuoteOutcome;
  expired: boolean;
  lostReason: { id: string; code: string; name: string } | null;
  lostNote: string | null;
  value: number; // SEK, the order's current rows (Valuta: converted with the order's rate)
  // Valuta: the order's currency and its value in it (= value for SEK).
  currency: string;
  currencyValue: number;
}

export interface QuoteFollowupReport {
  from: string;
  to: string;
  customerId: string | null;
  totals: QuoteFollowupFigures;
  customers: QuoteFollowupCustomer[];
  months: QuoteFollowupMonth[];
  lossReasons: QuoteFollowupLossReason[];
  quotes: QuoteFollowupQuote[];
}

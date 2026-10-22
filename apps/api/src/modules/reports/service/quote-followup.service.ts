import { buildCsv, type CsvColumn, type QuoteFollowupQuery, type QuoteFollowupQuote, type QuoteFollowupReport } from "@navet/shared";
import { stockholmToday } from "../../system/service/delivery-days.js";
import { SALES_ORDER_STATUS_LABELS } from "../../sales/service/export-columns.js";
import { QUOTE_FOLLOWUP_MAX_ROWS, type QuoteFollowupRepository } from "../repository/quote-followup.repository.js";
import { buildQuoteFollowup, NO_LOSS_REASON_LABEL } from "./quote-followup.js";

export class QuoteFollowupTooLargeError extends Error {
  constructor() {
    super(`The selection has more than ${QUOTE_FOLLOWUP_MAX_ROWS} quotes`);
    this.name = "QuoteFollowupTooLargeError";
  }
}

export const QUOTE_OUTCOME_LABELS = {
  won: "Vunnen",
  lost: "Förlorad",
  open: "Öppen",
  cancelled: "Makulerad",
} as const;

// CSV = the quote list, one line per quote.
const CSV_COLUMNS: CsvColumn<QuoteFollowupQuote>[] = [
  { label: "Offert", value: (q) => q.quoteNumber },
  // The KO- number a won OF- numbered quote got; empty while they agree.
  { label: "Order", value: (q) => (q.orderNumber !== q.quoteNumber ? q.orderNumber : null) },
  { label: "Kundnummer", value: (q) => q.customerNumber },
  { label: "Kund", value: (q) => q.customerName },
  { label: "Skapad", value: (q) => q.createdDate, format: "date" },
  { label: "Giltig t.o.m.", value: (q) => q.quoteValidUntil, format: "date" },
  { label: "Status", value: (q) => SALES_ORDER_STATUS_LABELS[q.status as keyof typeof SALES_ORDER_STATUS_LABELS] ?? q.status },
  { label: "Utfall", value: (q) => (q.outcome === "open" && q.expired ? "Utgången" : QUOTE_OUTCOME_LABELS[q.outcome]) },
  { label: "Förlustorsak", value: (q) => (q.outcome === "lost" ? (q.lostReason?.name ?? NO_LOSS_REASON_LABEL) : null) },
  { label: "Kommentar", value: (q) => q.lostNote },
  { label: "Värde", value: (q) => q.value, format: "money" },
];

export function createQuoteFollowupService(repo: QuoteFollowupRepository, deps: { today?: () => string } = {}) {
  const todayFn = deps.today ?? stockholmToday;
  const service = {
    async get(query: QuoteFollowupQuery): Promise<QuoteFollowupReport> {
      // One row past the ceiling tells "over" from "exactly at" without a count.
      const source = await repo.loadQuotes(query, QUOTE_FOLLOWUP_MAX_ROWS + 1);
      if (source.length > QUOTE_FOLLOWUP_MAX_ROWS) throw new QuoteFollowupTooLargeError();
      return {
        from: query.from,
        to: query.to,
        customerId: query.customerId ?? null,
        ...buildQuoteFollowup(source, todayFn()),
      };
    },

    async getCsv(query: QuoteFollowupQuery) {
      const result = await service.get(query);
      return {
        filename: `offertuppfoljning-${result.from}-${result.to}.csv`,
        content: buildCsv(CSV_COLUMNS, result.quotes),
      };
    },
  };
  return service;
}

export type QuoteFollowupService = ReturnType<typeof createQuoteFollowupService>;

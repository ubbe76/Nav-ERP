import { and, asc, eq, gte, lte, sql, type SQL } from "drizzle-orm";
import { customers, quoteLossReasons, salesOrderRows, salesOrders, type Db } from "@navet/db";
import type { QuoteFollowupQuery } from "@navet/shared";

// Offertuppföljning — one flat row per QUOTE (quoted = true) created in the
// range, whatever status it has reached since. The pure builder in
// quote-followup.ts decides the outcome and groups. The value is the sum of
// the order's CURRENT rows (antal × à-pris × (1 − rabatt)), in SEK — Valuta:
// an order in another currency is converted with its own rate (round2 of
// value × rate, the same as toSek), and carries its currency and own value.
export interface QuoteFollowupSourceRow {
  id: string;
  orderNumber: string;
  quoteNumber: string | null;
  customerId: string;
  customerNumber: string;
  customerName: string;
  createdDate: string; // YYYY-MM-DD, Stockholm
  quoteValidUntil: string | null;
  status: string;
  lostReasonId: string | null;
  lostReasonCode: string | null;
  lostReasonName: string | null;
  lostNote: string | null;
  // In SEK (converted with the order's rate).
  value: number;
  // Valuta: the order's currency and the value in it.
  currency: string;
  currencyValue: number;
}

// Same ceiling as the orderförteckning — the report refuses
// (QuoteFollowupTooLargeError) rather than printing a silently cut list.
export const QUOTE_FOLLOWUP_MAX_ROWS = 10_000;

// The quote's creation day in Stockholm (orders have no separate order date).
const createdDate = sql<string>`to_char(${salesOrders.createdAt} at time zone 'Europe/Stockholm', 'YYYY-MM-DD')`;

const rowValue = sql<string>`coalesce((
  select sum(r.quantity_ordered * r.unit_price * (1 - r.discount_percent / 100))
  from ${salesOrderRows} r where r.sales_order_id = ${salesOrders.id}
), 0)`;

export function createQuoteFollowupRepository(db: Db) {
  return {
    // limit = QUOTE_FOLLOWUP_MAX_ROWS + 1 so the caller can tell "exactly at
    // the ceiling" from "over it" without a second count query.
    async loadQuotes(query: QuoteFollowupQuery, limit: number): Promise<QuoteFollowupSourceRow[]> {
      const conditions: SQL[] = [eq(salesOrders.quoted, true), gte(createdDate, query.from), lte(createdDate, query.to)];
      if (query.customerId) conditions.push(eq(salesOrders.customerId, query.customerId));

      const rows = await db
        .select({
          id: salesOrders.id,
          orderNumber: salesOrders.orderNumber,
          quoteNumber: salesOrders.quoteNumber,
          customerId: salesOrders.customerId,
          customerNumber: customers.customerNumber,
          customerName: customers.name,
          createdDate,
          quoteValidUntil: salesOrders.quoteValidUntil,
          status: salesOrders.status,
          lostReasonId: salesOrders.lostReasonId,
          lostReasonCode: quoteLossReasons.code,
          lostReasonName: quoteLossReasons.name,
          lostNote: salesOrders.lostNote,
          value: sql<string>`round(${rowValue} * ${salesOrders.exchangeRate}, 2)`,
          currency: salesOrders.currency,
          currencyValue: rowValue,
        })
        .from(salesOrders)
        .innerJoin(customers, eq(customers.id, salesOrders.customerId))
        .leftJoin(quoteLossReasons, eq(quoteLossReasons.id, salesOrders.lostReasonId))
        .where(and(...conditions))
        .orderBy(asc(salesOrders.createdAt), asc(salesOrders.orderNumber))
        .limit(limit);

      return rows.map((r) => ({ ...r, value: Number(r.value), currencyValue: Number(r.currencyValue) }));
    },
  };
}

export type QuoteFollowupRepository = ReturnType<typeof createQuoteFollowupRepository>;

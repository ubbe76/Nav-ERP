// Offertuppföljning — pure: turns the repository's flat quote rows into the
// outcome per quote, the totals, the per-customer / per-month / per-loss-
// reason breakdowns and the quote list. No DB imports.
//
//   won        = confirmed, in production, delivered or invoiced
//   lost       = status lost
//   open       = status quote; `expired` when Giltig t.o.m. < today
//   cancelled  = status cancelled — listed, never in the hit rate
//   hit rate   = won / (won + lost), by count and by value; null when the
//                denominator is 0 (shown as –)
import {
  salesDocumentKind,
  type QuoteFollowupCustomer,
  type QuoteFollowupFigures,
  type QuoteFollowupLossReason,
  type QuoteFollowupMonth,
  type QuoteFollowupQuote,
  type QuoteOutcome,
  type SalesOrderStatus,
} from "@navet/shared";
import type { QuoteFollowupSourceRow } from "../repository/quote-followup.repository.js";

export const NO_LOSS_REASON_LABEL = "Ingen orsak angiven";

const WON_STATUSES: ReadonlySet<string> = new Set(["confirmed", "in_production", "delivered", "invoiced"]);

const round2 = (n: number) => Math.round(n * 100) / 100;
// Shares and hit rates as fractions with 4 decimals (0.6667).
const round4 = (n: number) => Math.round(n * 10000) / 10000;

export function quoteOutcome(status: string): QuoteOutcome {
  if (WON_STATUSES.has(status)) return "won";
  if (status === "lost") return "lost";
  if (status === "cancelled") return "cancelled";
  return "open";
}

function emptyFigures(): QuoteFollowupFigures {
  return {
    count: 0,
    value: 0,
    won: 0,
    wonValue: 0,
    lost: 0,
    lostValue: 0,
    open: 0,
    openValue: 0,
    expired: 0,
    expiredValue: 0,
    cancelled: 0,
    cancelledValue: 0,
    hitRateCount: null,
    hitRateValue: null,
  };
}

function add(figures: QuoteFollowupFigures, quote: QuoteFollowupQuote) {
  figures.count += 1;
  figures.value += quote.value;
  switch (quote.outcome) {
    case "won":
      figures.won += 1;
      figures.wonValue += quote.value;
      break;
    case "lost":
      figures.lost += 1;
      figures.lostValue += quote.value;
      break;
    case "open":
      figures.open += 1;
      figures.openValue += quote.value;
      if (quote.expired) {
        figures.expired += 1;
        figures.expiredValue += quote.value;
      }
      break;
    case "cancelled":
      figures.cancelled += 1;
      figures.cancelledValue += quote.value;
      break;
  }
}

function finish(figures: QuoteFollowupFigures): QuoteFollowupFigures {
  const decided = figures.won + figures.lost;
  const decidedValue = figures.wonValue + figures.lostValue;
  return {
    ...figures,
    value: round2(figures.value),
    wonValue: round2(figures.wonValue),
    lostValue: round2(figures.lostValue),
    openValue: round2(figures.openValue),
    expiredValue: round2(figures.expiredValue),
    cancelledValue: round2(figures.cancelledValue),
    hitRateCount: decided > 0 ? round4(figures.won / decided) : null,
    hitRateValue: decidedValue > 0 ? round4(figures.wonValue / decidedValue) : null,
  };
}

export function buildQuoteFollowup(
  source: QuoteFollowupSourceRow[],
  today: string
): {
  totals: QuoteFollowupFigures;
  customers: QuoteFollowupCustomer[];
  months: QuoteFollowupMonth[];
  lossReasons: QuoteFollowupLossReason[];
  quotes: QuoteFollowupQuote[];
} {
  const quotes: QuoteFollowupQuote[] = source.map((r) => {
    const outcome = quoteOutcome(r.status);
    return {
      id: r.id,
      quoteNumber: r.quoteNumber ?? r.orderNumber,
      orderNumber: r.orderNumber,
      documentKind: salesDocumentKind({
        status: r.status as SalesOrderStatus,
        orderNumber: r.orderNumber,
        quoteNumber: r.quoteNumber,
      }),
      customerId: r.customerId,
      customerNumber: r.customerNumber,
      customerName: r.customerName,
      createdDate: r.createdDate,
      quoteValidUntil: r.quoteValidUntil,
      status: r.status,
      outcome,
      expired: outcome === "open" && r.quoteValidUntil !== null && r.quoteValidUntil < today,
      lostReason:
        outcome === "lost" && r.lostReasonId && r.lostReasonCode && r.lostReasonName
          ? { id: r.lostReasonId, code: r.lostReasonCode, name: r.lostReasonName }
          : null,
      lostNote: outcome === "lost" ? r.lostNote : null,
      value: round2(r.value),
    };
  });

  const totals = emptyFigures();
  const byCustomer = new Map<string, QuoteFollowupCustomer>();
  const byMonth = new Map<string, QuoteFollowupMonth>();
  const byReason = new Map<string, QuoteFollowupLossReason>();

  for (const quote of quotes) {
    add(totals, quote);

    let customer = byCustomer.get(quote.customerId);
    if (!customer) {
      customer = {
        customerId: quote.customerId,
        customerNumber: quote.customerNumber,
        customerName: quote.customerName,
        ...emptyFigures(),
      };
      byCustomer.set(quote.customerId, customer);
    }
    add(customer, quote);

    const month = quote.createdDate.slice(0, 7);
    let monthRow = byMonth.get(month);
    if (!monthRow) {
      monthRow = { month, ...emptyFigures() };
      byMonth.set(month, monthRow);
    }
    add(monthRow, quote);

    if (quote.outcome === "lost") {
      const key = quote.lostReason?.id ?? "";
      let reason = byReason.get(key);
      if (!reason) {
        reason = {
          reasonId: quote.lostReason?.id ?? null,
          code: quote.lostReason?.code ?? null,
          name: quote.lostReason?.name ?? NO_LOSS_REASON_LABEL,
          count: 0,
          value: 0,
          share: null,
        };
        byReason.set(key, reason);
      }
      reason.count += 1;
      reason.value += quote.value;
    }
  }

  const customers = [...byCustomer.values()]
    .map((c) => ({ ...c, ...finish(c) }))
    .sort((a, b) => b.value - a.value || a.customerName.localeCompare(b.customerName, "sv"));
  const months = [...byMonth.values()]
    .map((m) => ({ ...m, ...finish(m) }))
    .sort((a, b) => a.month.localeCompare(b.month));
  const lostCount = totals.lost;
  const lossReasons = [...byReason.values()]
    .map((r) => ({ ...r, value: round2(r.value), share: lostCount > 0 ? round4(r.count / lostCount) : null }))
    // Most common first; "Ingen orsak angiven" last among equals.
    .sort((a, b) => b.count - a.count || b.value - a.value || (a.reasonId === null ? 1 : b.reasonId === null ? -1 : a.name.localeCompare(b.name, "sv")));

  return { totals: finish(totals), customers, months, lossReasons, quotes };
}

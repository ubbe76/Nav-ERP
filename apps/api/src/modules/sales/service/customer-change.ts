// Byt kund på en offert eller kundorder — the pure plan. No DB imports: the
// repository leaf (repository/customer-change.ts) loads the facts, unlocked
// for the preview and again under the row and order locks for the change,
// and the service asks the price chain (outside any transaction — it reads
// the settings and the configurator's variant step on its own connections).
// The plan is a pure function of (facts, rate, freight article, the chain's
// answers), so the preview the user saw and what the transaction writes can
// never be two different rules; `customerChangeBasis` is what the locked
// re-read is compared with.
//
// Prices: a row the price chain priced (price_origin chain or calculated)
// gets the NEW customer's chain price, discount and step. Every other row
// keeps its value in kronor — converted with old rate / new rate when the
// currency changes, untouched otherwise — and is marked for review: a
// handwritten price, a configured row / beställningsvara (the template's
// chain is not run again), the freight row (the freight choice is cleared
// with the address) and a row the new customer's chain has no price for. A
// ställkostnadsrad follows its article row: the new customer's ställpris
// when that row is repriced and the rule has one, else kept and marked.
import {
  round4,
  roundToDecimals,
  type ChangeSalesOrderCustomerInput,
  type CustomerChangeBlockerCode,
  type CustomerChangePreview,
  type CustomerChangeRowKind,
  type PriceSource,
  type SalesDocumentKind,
  type SalesOrderStatus,
  type SalesRowPriceOrigin,
} from "@navet/shared";

export const CUSTOMER_CHANGE_STATUSES: readonly SalesOrderStatus[] = ["quote", "confirmed", "in_production"];

export interface CustomerChangeFacts {
  order: {
    id: string;
    orderNumber: string;
    documentKind: SalesDocumentKind;
    status: SalesOrderStatus;
    customerId: string;
    customerNumber: string;
    customerName: string;
    currency: string;
    exchangeRate: number;
    // The order's own markups (they stay) — the chain prices with them.
    generalMarkupPercent: string | null;
    materialMarkupPercent: string | null;
    customerOrderNumber: string | null;
    customerInquiryNumber: string | null;
    deliveryAddressId: string | null;
    deliveryAddressOneOff: boolean;
    hasFreightChoice: boolean;
  };
  customer: {
    id: string;
    customerNumber: string;
    name: string;
    currency: string;
    deliveryTermId: string | null;
    // The PAYING customer's term (Fakturakund), else the customer's own.
    paymentTermId: string | null;
    carrierId: string | null;
    deliveryTerm: string | null;
    paymentTerm: string | null;
    carrier: string | null;
    // Huvudkontakten's name (else the card's Kontaktperson), ≤ 100 chars.
    customerReference: string | null;
    defaultDeliveryAddress: { id: string; text: string } | null;
    invoiceCustomer: { id: string; customerNumber: string; name: string } | null;
  };
  rows: {
    rowId: string;
    articleId: string;
    articleNumber: string;
    articleName: string;
    quantity: number;
    quantityDelivered: number;
    unitPrice: number;
    discountPercent: number;
    priceOrigin: SalesRowPriceOrigin;
    unitCode: string;
    unitFactor: number | null;
    configured: boolean;
    setupForRowId: string | null;
  }[];
  // What has happened with the order at the current customer.
  liveDeliveries: number;
  // FA numbers (or "utkast") of the invoices that are not cancelled.
  invoices: string[];
  // Numbers of the shipments that are not cancelled.
  shipments: string[];
  // Numbers of the deviations that are not cancelled.
  deviations: string[];
}

// The price chain's answer for one row at the new customer (null = no price).
export type CustomerChangeChainAnswer = { unitPrice: number; discountPercent: number; source: PriceSource; setupPrice?: number } | null;

export interface CustomerChangeInputs {
  // SEK per 1 unit of the new customer's currency — the order's own rate
  // when the currency stays.
  newRate: number;
  freightArticleId: string | null;
  chain: Map<string, CustomerChangeChainAnswer>;
}

export function customerChangeRowKind(row: CustomerChangeFacts["rows"][number], freightArticleId: string | null): CustomerChangeRowKind {
  if (row.setupForRowId !== null) return "setup";
  if (row.configured) return "configured";
  if (freightArticleId !== null && row.articleId === freightArticleId) return "freight";
  return "article";
}

// The rows the service asks the chain about: ordinary article rows the
// chain priced.
export function customerChangeChainRows(facts: CustomerChangeFacts, freightArticleId: string | null) {
  return facts.rows.filter((row) => customerChangeRowKind(row, freightArticleId) === "article" && row.priceOrigin !== "manual");
}

export function customerChangeBlockers(facts: CustomerChangeFacts): CustomerChangePreview["blockers"] {
  const blockers: { code: CustomerChangeBlockerCode; message: string }[] = [];
  if (!CUSTOMER_CHANGE_STATUSES.includes(facts.order.status)) {
    blockers.push({
      code: "invalid-status-transition",
      message: "Kunden kan bara bytas på en offert eller på en kundorder som är Bekräftad eller Under tillverkning.",
    });
  }
  if (facts.liveDeliveries > 0 || facts.rows.some((r) => r.quantityDelivered > 0)) {
    blockers.push({
      code: "sales-order-has-deliveries",
      message: "Ordern har en leverans — ångra utleveransen innan kunden byts.",
    });
  }
  if (facts.invoices.length > 0) {
    blockers.push({
      code: "sales-order-has-invoice-rows",
      message: `Ordern finns på faktura ${facts.invoices.join(", ")} — kunden kan inte bytas.`,
    });
  }
  if (facts.shipments.length > 0) {
    blockers.push({
      code: "sales-order-has-shipments",
      message: `Ordern har försändelse ${facts.shipments.join(", ")} — makulera eller avboka den innan kunden byts.`,
    });
  }
  if (facts.deviations.length > 0) {
    blockers.push({
      code: "sales-order-has-deviations",
      message: `Ordern hör till reklamation ${facts.deviations.join(", ")} hos den nuvarande kunden — kunden kan inte bytas.`,
    });
  }
  return blockers;
}

export function customerChangeCurrencies(facts: CustomerChangeFacts): { from: string; to: string; changes: boolean } {
  return { from: facts.order.currency, to: facts.customer.currency, changes: facts.order.currency !== facts.customer.currency };
}

export function planCustomerChange(facts: CustomerChangeFacts, inputs: CustomerChangeInputs): CustomerChangePreview {
  const { order, customer } = facts;
  const { newRate, freightArticleId, chain } = inputs;
  const currencyChanges = order.currency !== customer.currency;
  const convert = (price: number) => (currencyChanges ? roundToDecimals((price * order.exchangeRate) / newRate, 4) : price);
  const keptOrigin = currencyChanges ? ("converted" as const) : ("unchanged" as const);
  const byId = new Map(facts.rows.map((r) => [r.rowId, r]));
  // The chain's answer counts for an ordinary article row the chain priced.
  const chainFor = (row: CustomerChangeFacts["rows"][number]) =>
    customerChangeRowKind(row, freightArticleId) === "article" && row.priceOrigin !== "manual" ? (chain.get(row.rowId) ?? null) : null;

  const rows = facts.rows.map((row): CustomerChangePreview["rows"][number] => {
    const kind = customerChangeRowKind(row, freightArticleId);
    const before = { unitPrice: row.unitPrice, discountPercent: row.discountPercent, priceOrigin: row.priceOrigin };
    const base = {
      rowId: row.rowId,
      articleId: row.articleId,
      articleNumber: row.articleNumber,
      articleName: row.articleName,
      quantity: row.quantity,
      unitCode: row.unitCode,
      unitFactor: row.unitFactor,
      kind,
      before,
    };
    const kept = (review: NonNullable<CustomerChangePreview["rows"][number]["review"]>) => ({
      ...base,
      after: { unitPrice: convert(row.unitPrice), discountPercent: row.discountPercent, priceOrigin: row.priceOrigin, source: null },
      origin: keptOrigin,
      review,
    });
    if (kind === "configured") return kept("configured");
    if (kind === "freight") return kept("freight");
    if (kind === "setup") {
      const main = byId.get(row.setupForRowId!);
      const answer = main ? chainFor(main) : null;
      if (!answer || !(answer.setupPrice !== undefined && answer.setupPrice > 0)) return kept("setup");
      return {
        ...base,
        after: { unitPrice: round4(answer.setupPrice), discountPercent: row.discountPercent, priceOrigin: row.priceOrigin, source: answer.source },
        origin: "chain",
        review: null,
      };
    }
    if (row.priceOrigin === "manual") return kept("manual");
    const answer = chainFor(row);
    if (!answer) return kept("no-price");
    return {
      ...base,
      after: {
        unitPrice: round4(answer.unitPrice),
        discountPercent: roundToDecimals(answer.discountPercent, 2),
        priceOrigin: answer.source === "calculated" ? "calculated" : "chain",
        source: answer.source,
      },
      origin: "chain",
      review: null,
    };
  });

  return {
    orderId: order.id,
    orderNumber: order.orderNumber,
    documentKind: order.documentKind,
    status: order.status,
    from: {
      customerId: order.customerId,
      customerNumber: order.customerNumber,
      customerName: order.customerName,
      currency: order.currency,
      exchangeRate: order.exchangeRate,
    },
    to: { customerId: customer.id, customerNumber: customer.customerNumber, customerName: customer.name, currency: customer.currency, exchangeRate: newRate },
    header: {
      deliveryAddress: customer.defaultDeliveryAddress?.text ?? null,
      deliveryTerm: customer.deliveryTerm,
      paymentTerm: customer.paymentTerm,
      carrier: customer.carrier,
      customerReference: customer.customerReference,
      invoiceCustomer: customer.invoiceCustomer ? `${customer.invoiceCustomer.customerNumber} ${customer.invoiceCustomer.name}` : null,
    },
    clears: {
      customerOrderNumber: order.customerOrderNumber,
      customerInquiryNumber: order.customerInquiryNumber,
      freight: order.hasFreightChoice,
      oneOffDeliveryAddress: order.deliveryAddressOneOff,
    },
    blockers: customerChangeBlockers(facts),
    rows,
  };
}

// Does the plan still say what the user confirmed? Compared at the columns'
// scales (rate 6, price 4, discount 2 decimals); the rows as a set.
export function matchesExpectedCustomerChange(plan: CustomerChangePreview, expected: ChangeSalesOrderCustomerInput["expected"]): boolean {
  if (plan.from.customerId !== expected.customerId) return false;
  if (plan.to.currency !== expected.currency) return false;
  if (roundToDecimals(plan.to.exchangeRate, 6) !== roundToDecimals(expected.exchangeRate, 6)) return false;
  if (plan.rows.length !== expected.rows.length) return false;
  const byId = new Map(expected.rows.map((r) => [r.rowId, r]));
  if (byId.size !== expected.rows.length) return false;
  return plan.rows.every((row) => {
    const seen = byId.get(row.rowId);
    return (
      seen !== undefined &&
      round4(seen.unitPrice) === round4(row.after.unitPrice) &&
      roundToDecimals(seen.discountPercent, 2) === roundToDecimals(row.after.discountPercent, 2)
    );
  });
}

// Everything the plan was made from, as one comparable string: the facts
// are read again under the row and order locks, and anything else than this
// there is `stale` (nothing written). The blockers are not part of it — they
// are judged on the locked facts themselves — and neither is what is simply
// cleared (the old customer's order and inquiry numbers, the freight choice).
export function customerChangeBasis(facts: CustomerChangeFacts): string {
  const { order, customer } = facts;
  return JSON.stringify({
    order: [order.customerId, order.currency, roundToDecimals(order.exchangeRate, 6), order.generalMarkupPercent, order.materialMarkupPercent],
    customer: [
      customer.id,
      customer.currency,
      customer.deliveryTermId,
      customer.paymentTermId,
      customer.carrierId,
      customer.customerReference,
      customer.defaultDeliveryAddress?.id ?? null,
      customer.invoiceCustomer?.id ?? null,
    ],
    rows: [...facts.rows]
      .sort((a, b) => (a.rowId < b.rowId ? -1 : 1))
      .map((r) => [r.rowId, r.articleId, round4(r.quantity), round4(r.unitPrice), roundToDecimals(r.discountPercent, 2), r.priceOrigin, r.configured, r.setupForRowId]),
  });
}

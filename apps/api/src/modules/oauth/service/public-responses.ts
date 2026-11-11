import type { OrderRowConfiguration, PriceSource, SalesDocumentKind, SalesOrderStatus } from "@navet/shared";

// The external API's answers to a client token (req.apiClient) — pure, built
// field by field and never spread, so a column added to sales_orders or
// sales_order_rows later (as freight_quote/freight_carrier_price and the
// order's price markups were) can never reach a client by accident. Same
// rule as the configurator's toPublicTemplate. A session (the web, which
// posts to the same routes) keeps the full internal answer.
//
// What a client gets: identity, number and status, what it sent itself
// (customer, references, address, dates, note, currency, dimensions, the
// rows' article/quantity/unit/date/configuration), and the prices the
// customer pays. Never: our costs, the price markups, the freight probe and
// Sendify's price, the price origin, internal register and user ids, the
// lost/legacy-invoice bookkeeping.

// --- POST /quotes and POST /sales-orders/:id/confirm ---

export type PublicOrderSource = {
  id: string;
  orderNumber: string;
  quoteNumber: string | null;
  documentKind: SalesDocumentKind;
  status: SalesOrderStatus;
  customerId: string;
  customerOrderNumber: string | null;
  customerInquiryNumber: string | null;
  customerReference: string | null;
  deliveryAddressId: string | null;
  expectedDeliveryDate: string | null;
  quoteValidUntil: string | null;
  note: string | null;
  currency: string;
  exchangeRate: string;
  revision: number;
  costCenterId: string | null;
  projectId: string | null;
  createdAt: Date;
};

export type PublicOrder = PublicOrderSource;

export function toPublicOrder(order: PublicOrderSource): PublicOrder {
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    quoteNumber: order.quoteNumber,
    documentKind: order.documentKind,
    status: order.status,
    customerId: order.customerId,
    customerOrderNumber: order.customerOrderNumber,
    customerInquiryNumber: order.customerInquiryNumber,
    customerReference: order.customerReference,
    deliveryAddressId: order.deliveryAddressId,
    expectedDeliveryDate: order.expectedDeliveryDate,
    quoteValidUntil: order.quoteValidUntil,
    note: order.note,
    currency: order.currency,
    exchangeRate: order.exchangeRate,
    revision: order.revision,
    costCenterId: order.costCenterId,
    projectId: order.projectId,
    createdAt: order.createdAt,
  };
}

// A beställningsvara row's choices and price split (4b) — what the client
// configured and what it pays for it; the jsonb is copied field by field too.
function toPublicRowConfiguration(value: unknown): OrderRowConfiguration | null {
  if (!value || typeof value !== "object") return null;
  const c = value as OrderRowConfiguration;
  return {
    templateArticleId: c.templateArticleId,
    key: c.key,
    selection: (c.selection ?? []).map((e) => ({
      groupCode: e.groupCode,
      groupName: e.groupName,
      kind: e.kind,
      valueCode: e.valueCode,
      valueName: e.valueName,
      value: e.value,
      unit: e.unit,
    })),
    price: {
      base: c.price.base,
      additions: (c.price.additions ?? []).map((a) => ({ groupCode: a.groupCode, label: a.label, amount: a.amount })),
      unitPrice: c.price.unitPrice,
      discountPercent: c.price.discountPercent,
      source: c.price.source,
    },
  };
}

export type PublicOrderRowSource = {
  id: string;
  articleId: string;
  quantityOrdered: string;
  unitId: string | null;
  unitFactor: string | null;
  unitPrice: string;
  discountPercent: string;
  // Kalkylpris (#16): the price came from the customer's markup — the same
  // fact as GET /price-quote's source "calculated"; never its basis.
  calculatedPrice: boolean;
  expectedDeliveryDate: string | null;
  configuration: unknown;
  // Ställkostnad: this row is the setup charge of the row it points at.
  setupForRowId: string | null;
};

export type PublicOrderRow = Omit<PublicOrderRowSource, "configuration"> & { configuration: OrderRowConfiguration | null };

export function toPublicOrderRow(row: PublicOrderRowSource): PublicOrderRow {
  return {
    id: row.id,
    articleId: row.articleId,
    quantityOrdered: row.quantityOrdered,
    unitId: row.unitId,
    unitFactor: row.unitFactor,
    unitPrice: row.unitPrice,
    discountPercent: row.discountPercent,
    calculatedPrice: row.calculatedPrice,
    expectedDeliveryDate: row.expectedDeliveryDate,
    configuration: toPublicRowConfiguration(row.configuration),
    setupForRowId: row.setupForRowId,
  };
}

export function toPublicQuote(result: { order: PublicOrderSource; rows: PublicOrderRowSource[] }): { order: PublicOrder; rows: PublicOrderRow[] } {
  return { order: toPublicOrder(result.order), rows: result.rows.map(toPublicOrderRow) };
}

// --- GET /price-quote ---

export type PublicPriceQuoteSource = {
  articleNumber: string;
  price: { unitPrice: number; discountPercent: number; source: PriceSource; setupPrice?: number } | null;
  currency: string;
  exchangeRate: number;
};

// The price and where in the chain it came from; never the Kalkylpris's
// basis (`calculated`) or why the step could not be used
// (`calculatedPriceUnavailable`).
export function toPublicPriceQuote(quote: PublicPriceQuoteSource): PublicPriceQuoteSource {
  const price = quote.price;
  return {
    articleNumber: quote.articleNumber,
    price: price
      ? {
          unitPrice: price.unitPrice,
          discountPercent: price.discountPercent,
          source: price.source,
          ...(price.setupPrice !== undefined ? { setupPrice: price.setupPrice } : {}),
        }
      : null,
    currency: quote.currency,
    exchangeRate: quote.exchangeRate,
  };
}

// --- GET /articles/:id/bom (structure:read) ---

export type PublicBomRowSource = {
  id: string;
  parentArticleId: string;
  componentArticleId: string;
  componentArticleNumber: string;
  componentName: string;
  componentIsPhantom: boolean;
  quantity: string;
  unitId: string | null;
  unitFactor: string | null;
  unitCode: string;
  position: string | null;
  costingOnly: boolean;
  routingOperationSequenceNo: number | null;
  componentDrawings: { drawingNumber: string; revision: string | null }[];
};

export type PublicBomRow = PublicBomRowSource;

// The structure as the article card shows it: no internal operation id and
// no file ids/names (a client cannot fetch files), drawings by number and
// revision.
export function toPublicBomRow(row: PublicBomRowSource): PublicBomRow {
  return {
    id: row.id,
    parentArticleId: row.parentArticleId,
    componentArticleId: row.componentArticleId,
    componentArticleNumber: row.componentArticleNumber,
    componentName: row.componentName,
    componentIsPhantom: row.componentIsPhantom,
    quantity: row.quantity,
    unitId: row.unitId,
    unitFactor: row.unitFactor,
    unitCode: row.unitCode,
    position: row.position,
    costingOnly: row.costingOnly,
    routingOperationSequenceNo: row.routingOperationSequenceNo,
    componentDrawings: row.componentDrawings.map((d) => ({ drawingNumber: d.drawingNumber, revision: d.revision })),
  };
}

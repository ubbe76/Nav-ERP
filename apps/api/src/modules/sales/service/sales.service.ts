import type {
  ArticleCustomerPricesInput,
  ArticlePriceListRowsInput,
  ConfiguratorSelection,
  CreateContactInput,
  CreateCustomerInput,
  CreateDeliveryAddressInput,
  CreatePriceListInput,
  CreateQuoteInput,
  CreateSalesOrderRowInput,
  CustomerArticleNumberInput,
  CustomerPriceInput,
  DeliverBatchInput,
  DeliveryPalletCardRow,
  DeliverGoodsInput,
  ListPriceListsQuery,
  ListQuery,
  ListSalesOrdersQuery,
  LoseQuoteInput,
  OrderRowConfiguration,
  OrderRowConfigurationCost,
  OrderRowConfigurationInput,
  PriceListRowInput,
  PriceQuoteQuery,
  SalesOrderStatus,
  SendDocumentEmailInput,
  SendSalesOrderEmailInput,
  SetRowConfigurationInput,
  UpdateContactInput,
  UpdateCustomerInput,
  UpdateCustomerPriceInput,
  UpdateDeliveryAddressInput,
  UpdatePriceListInput,
  UpdatePriceListRowInput,
  UpdateSalesOrderHeaderInput,
  UpdateSalesOrderRowInput,
  MarkupRepricing,
  MarkupRepricingRow,
  SalesOrderMarkups,
  SalesOrderMarkupsPreviewInput,
  PriceSource,
  SalesRowPriceOrigin,
} from "@navet/shared";
import { linkDeviationInTx } from "../../quality/repository/deviation-link-tx.js";
import type { Tx } from "@navet/db";
import type {
  HeaderMarkupsGuard,
  PlannedRowReprice,
  RowConfigurationMutationResult,
  SalesRepository,
  SalesRowWrite,
} from "../repository/sales.repository.js";
import type { PriceChainQuery, PriceMarkups, PriceResolution } from "./price-resolver.js";
import type { RegisterReferenceReader } from "../../register/service/register.service.js";
import { RegisterEntryNotFoundError } from "../../register/service/register.service.js";
import type { MailService } from "../../mail/service/mail.service.js";
import { formatBatchInfo, formatQuantity, type DocumentPdfService, type PalletCardPdfInput } from "../../mail/service/document-pdf.js";
import { documentLanguageOf, localized, UNKNOWN_BATCH_LABEL, type DocumentLanguage } from "@navet/shared";
import { documentTexts } from "../../mail/service/document-texts.js";
import {
  customerVatNumberWarning,
  customerVatTreatment,
  effectiveOverDeliveryPercent,
  type SalesVatCustomer,
  roundUpToMultiple,
  salesRowIsGoods,
  salesVatCode,
  toBasePrice,
  toBaseQuantity,
  toUnitPrice,
  toUnitQuantity,
  VAT_CODE_CATALOG,
  vatCodeEntry,
  type VatCode,
  fromSek,
  SEK,
  isLiveQuoteStatus,
  isSalesOrderEditableStatus,
} from "@navet/shared";
import type { CustomerDeliveryDateQuery, CustomerDeliveryDateSuggestion } from "@navet/shared";
import {
  addDays,
  deliveryDateWarning,
  deliveryHolidayWindow,
  deliverySummary,
  earliestCustomerDelivery,
  effectiveDeliverySettings,
  stockholmToday,
} from "../../system/service/delivery-days.js";
import type { ArticleFileReader, ArticleRevisionReader, ArticleUnitReader } from "../../article/service/article.service.js";
import { ArticleGroupNotFoundError, ArticleNotFoundError, assertOrderableArticle } from "../../article/service/article.service.js";
import {
  extraDescriptionFor,
  formatArticleAttributes,
  formatRevisionInfo,
  type DocumentSettingsReader,
} from "../../mail/service/document-pdf.js";
import { isUniqueViolation } from "../../system/service/db-errors.js";
import { StaffelConflict } from "../repository/article-sales-prices.js";
// Konfigurator 4b: the configurator's pure pieces only — the stored-entries
// → selection mapper (variant-identity.ts has no DB imports) and the error
// class the row evaluation shares with Konfigurera (4a). The service itself
// is reached through the injected RowConfigurationReader, never imported.
import { selectionFromEntries } from "../../configurator/service/variant-identity.js";
import { rowConfigurationLines } from "../../configurator/service/configuration-lines.js";
import { ConfiguratorInvalidConfigurationError } from "../../configurator/service/configurator.errors.js";
// Påslag (#16): the costing module's pure rounding of a percentage to the
// header columns' two decimals — the same one effectiveMarkups uses.
import { roundPercent } from "../../costing/service/markup-levels.js";
import type { RowConfigurationEvaluation } from "../../configurator/service/configurator.service.js";
// G1: append-only audit trail (payroll/timereport precedent) — optional with
// a no-op default so the dozens of pre-existing test call sites that build
// this service without an audit writer keep compiling; app.ts wires the real
// one.
import type { AuditWriter } from "../../system/repository/audit.repository.js";
import {
  ConfigurationNotAllowedError,
  RowConfigurationOutdatedError,
  ConfigurationRequiredError,
  CustomerPriceNotFoundError,
  CustomerArticleNumberNotFoundError,
  DuplicateCustomerArticleNumberError,
  DuplicateCustomerPriceError,
  DuplicatePriceListError,
  DuplicatePriceListRowError,
  FreightAlreadyInvoicedError,
  FreightRowDeliveredError,
  InvalidFreightProductError,
  PriceListNotFoundError,
  PriceListRowNotFoundError,
  PriceNotFoundError,
  PriceListCurrencyLockedError,
  RowConfigurationLockedError,
  SalesOrderCurrencyLockedError,
  SalesOrderExchangeRateError,
  MarkupRepricingConflictError,
  MarkupRepricingNotConfirmedError,
  SalesOrderMarkupsChangedError,
  SalesOrderRowsLockedError,
} from "./sales.errors.js";
import { ExchangeRateUnavailableError, type ExchangeRateReader } from "../../system/service/exchange-rates.js";

// Narrow slice of the stock service — the pick list shows where each
// article can be picked from (same cross-module pattern as
// RegisterReferenceReader).
// Rows come in pick order — the article's own location first, then as the
// automatic outflow draws (compareOutflowLocations in the stock module).
// blocked: a Spärrad lagerplats — physical stock the pick list leaves out.
export interface StockBalanceReader {
  balancesForArticles(
    articleIds: string[]
  ): Promise<{ articleId: string; quantityOnHand: string; locationName: string | null; warehouseName: string | null; blocked: boolean }[]>;
  // Batch (#8): the cells (place, batch) of the BATCHSTYRDA among the
  // articles, per article in the order Automatiskt draws them — the pick
  // list prints these instead of the per-place balances.
  pickBatchCellsForArticles(
    articleIds: string[]
  ): Promise<
    { articleId: string; warehouseName: string; locationName: string; blocked: boolean; batchNumber: string | null; quantity: string }[]
  >;
}

// Batch (#8) on the customer documents (följesedel, pallkort till kund): the
// delivery row's NAMED batches, summed per batch in the row's unit — Okänd
// is never printed there (decision 14), and nothing at all once the article
// is no longer batchstyrd (decision 10). The quantities print as soon as the
// batches do not cover the whole row on their own.
function deliveryRowBatchInfo(
  row: { batchTracked: boolean; unitFactor: string | null; locations: { quantity: number; batchNumber: string | null }[] },
  language: DocumentLanguage
): string | null {
  if (!row.batchTracked) return null;
  const named = row.locations.flatMap((part) =>
    part.batchNumber === null ? [] : [{ batchNumber: part.batchNumber, quantity: toUnitQuantity(part.quantity, row.unitFactor) }]
  );
  return formatBatchInfo(named, { language, whole: named.length === row.locations.length });
}

// E3 (KO→TO-koppling): the narrow slice of the manufacturing service sales
// depends on for the per-row "I tillverkning" coverage (quantityInProduction
// + the linked, non-cancelled TO list) — same optional-cross-module-reader
// pattern as StockBalanceReader above. Matches manufacturing.service.ts's
// coverageForSalesOrderRows exactly (a thin pass-through to the repo method
// T3 built), so this interface and that one must be kept in sync by hand.
// Omitted (as most other test files construct createSalesService) ⇒
// listRows falls back to quantityInProduction: 0 / an empty list per row.
// Narrow slice of the costing service — the order card and its row forms show
// täckningsbidrag per row and for the order. Same optional-cross-module-reader
// pattern as StockBalanceReader / ManufacturingCoverageReader; sales never
// imports the costing module. An article missing from the map has no saved
// calculation, which is NOT a cost of zero — see costing/service/margin.ts.
export interface ArticleSelfCostReader {
  latestPreCalculationSelfCost(
    articleIds: string[]
  ): Promise<Map<string, { selfCostPerUnit: number; calculationId: string; calculatedAt: string; quantity: number }>>;
}

// Frakt: the live shipment of each delivery (shipping module, injected —
// same reader pattern as StockBalanceReader). Optional: omitted, deliveries
// simply carry shipment: null and the följesedel prints no carrier.
export interface DeliveryShipmentInfo {
  shipmentId: string;
  shipmentNumber: string;
  status: "draft" | "booked" | "delivered" | "cancelled";
  carrierName: string | null;
  trackingNumber: string | null;
}
export interface ShipmentReader {
  shipmentsForDeliveries(deliveryIds: string[]): Promise<Map<string, DeliveryShipmentInfo>>;
}

// Konfigurator 4b: the configurator's row-configuration side, injected like
// StockBalanceReader and bound late in app.ts (rowConfigurationRef) — the
// configurator service is built after sales and itself reads the sales chain.
export type RowConfigurationReader = {
  evaluate(
    templateArticleId: string,
    selection: ConfiguratorSelection,
    // Valuta: the order's currency and rate (omitted = SEK) — the evaluation's
    // prices come back in that currency.
    opts: { customerId: string; quantity: number; currency?: string; exchangeRate?: number }
  ): Promise<RowConfigurationEvaluation>;
  variantOf(articleId: string): Promise<{ templateArticleId: string; configKey: string } | null>;
  resolveVariant(
    templateArticleId: string,
    selection: ConfiguratorSelection,
    userId: string | null
  ): Promise<{ article: { id: string; articleNumber: string } }>;
};

// Tests that predate 4b build the service without the configurator; a
// configured row then fails loudly instead of silently storing nothing.
// Momskoder: which article is the freight article (shipping settings) — the
// quote/order confirmation counts it as goods when deriving a row's momskod.
// Same consumer-declared reader as the invoice module's InvoiceFreightReader;
// omitted ⇒ no freight article.
export interface SalesFreightReader {
  freightArticleId(): Promise<string | null>;
}

const ROW_CONFIGURATION_NOT_WIRED: RowConfigurationReader = {
  evaluate: async () => {
    throw new Error("RowConfigurationReader not wired");
  },
  variantOf: async () => null,
  resolveVariant: async () => {
    throw new Error("RowConfigurationReader not wired");
  },
};

export interface ManufacturingCoverageReader {
  coverageForSalesOrderRows(
    rowIds: string[]
  ): Promise<Map<string, { quantity: number; orders: { id: string; orderNumber: string; status: string; quantity: string; quantityReceived: string }[] }>>;
}

// The system settings the sales module reads: the document toggles plus
// Offertens giltighetstid (quote-settings.ts) — the same "extend the PDF
// reader" shape as PurchaseSettingsReader.
export interface SalesSettingsReader extends DocumentSettingsReader {
  getSettings(): Promise<
    Awaited<ReturnType<DocumentSettingsReader["getSettings"]>> & {
      quoteValidityDays: number;
      // Ställkostnadsartikel — optional so settings fakes need not carry it.
      setupChargeArticleId?: string | null;
      // Tillåten överleverans på kundorder (#24) — optional for the same
      // reason; absent = 0, never more than ordered.
      salesOverDeliveryPercent?: number | null;
    }
  >;
}

export class CustomerNotFoundError extends Error {
  constructor(id: string) {
    super(`Customer ${id} not found`);
    this.name = "CustomerNotFoundError";
  }
}

export class DuplicateCustomerNumberError extends Error {
  constructor(customerNumber: string) {
    super(`A customer with number "${customerNumber}" already exists`);
    this.name = "DuplicateCustomerNumberError";
  }
}

export class ContactNotFoundError extends Error {
  constructor(id: string) {
    super(`Contact ${id} not found`);
    this.name = "ContactNotFoundError";
  }
}

export class SalesOrderNotFoundError extends Error {
  constructor(id: string) {
    super(`Sales order ${id} not found`);
    this.name = "SalesOrderNotFoundError";
  }
}

export class SalesOrderRowNotFoundError extends Error {
  constructor(id: string) {
    super(`Sales order row ${id} not found`);
    this.name = "SalesOrderRowNotFoundError";
  }
}

// Förlorad with an unknown or inactive förlustorsak (400 — the dialog only
// offers active reasons, so this is a stale client or an integration).
export class QuoteLossReasonInvalidError extends Error {
  constructor(id: string) {
    super(`Quote loss reason ${id} does not exist or is inactive`);
    this.name = "QuoteLossReasonInvalidError";
  }
}

export class InvalidStatusTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidStatusTransitionError";
  }
}

// Skapa kundorder från offert: Order (`ordered`) is a quote's final status —
// Förlorad, Makulera, Öppna igen, Bekräfta, the order confirmation mail and
// the manual status all refuse it (the quote can only give more orders). A
// subclass, so every route that answers 409 for a refused transition does so
// for this one too; the code is its own (quote-already-ordered).
export class QuoteAlreadyOrderedError extends InvalidStatusTransitionError {
  constructor(public quoteNumber: string) {
    super(`Quote ${quoteNumber} has already given an order — its status cannot change`);
    this.name = "QuoteAlreadyOrderedError";
  }
}

// limit: a delivery past the order's Tillåten överleverans (#24) — the
// percentage for the order's customer and the most the row may hold
// delivered, in the base unit; the route puts both on the error body so the
// web can name the percentage. Without it: a row edit below the delivered
// quantity.
export class OverDeliveryError extends Error {
  constructor(readonly limit?: { allowedPercent: number; maxQuantity: number }) {
    super(
      limit && limit.allowedPercent > 0
        ? `Delivered quantity would exceed the ordered quantity plus the allowed ${limit.allowedPercent} % over-delivery for this row`
        : "Delivered quantity would exceed the ordered quantity for this row"
    );
    this.name = "OverDeliveryError";
  }
}

export class DeliveryAddressNotFoundError extends Error {
  constructor(id: string) {
    super(`Delivery address ${id} not found`);
    this.name = "DeliveryAddressNotFoundError";
  }
}

export class RowHasDeliveriesError extends Error {
  constructor() {
    super("Cannot delete a row that has delivered goods");
    this.name = "RowHasDeliveriesError";
  }
}

// A row on an invoice row — a cancelled draft or a credited invoice included
// — keeps its history: the invoice row's restrict FK.
export class RowHasInvoiceRowsError extends Error {
  constructor() {
    super("Cannot delete a row that is on an invoice");
    this.name = "RowHasInvoiceRowsError";
  }
}

export class DeliveryNotFoundError extends Error {
  constructor(id: string) {
    super(`Delivery ${id} not found`);
    this.name = "DeliveryNotFoundError";
  }
}

// Pallkort on a delivery: a `row=` selection names a delivery row that does
// not belong to this delivery (→ 400).
export class DeliveryRowNotInDeliveryError extends Error {
  constructor(deliveryRowId: string) {
    super(`Delivery row ${deliveryRowId} does not belong to this delivery`);
    this.name = "DeliveryRowNotInDeliveryError";
  }
}

// --- Ångra utleverans ---

export class DeliveryRowNotFoundError extends Error {
  constructor(deliveryRowId: string) {
    super(`Delivery row ${deliveryRowId} not found`);
    this.name = "DeliveryRowNotFoundError";
  }
}

export class DeliveryRowAlreadyUndoneError extends Error {
  constructor() {
    super("The delivery row has already been undone");
    this.name = "DeliveryRowAlreadyUndoneError";
  }
}

// A delivery the 0132 backfill could not pair with its stock movement — there
// is no record of where the goods were taken from.
export class DeliveryRowNotUndoableError extends Error {
  constructor() {
    super("The delivery predates the stock link and cannot be undone");
    this.name = "DeliveryRowNotUndoableError";
  }
}

// Swedish — the web shows it as is (names the shipment).
export class DeliveryOnShipmentError extends Error {
  constructor(deliveryNumber: string, shipmentNumber: string) {
    super(
      `Följesedel ${deliveryNumber} ligger på försändelse ${shipmentNumber} — ta bort den ur försändelsen, eller avboka försändelsen, först`
    );
    this.name = "DeliveryOnShipmentError";
  }
}

// Swedish — the web shows it as is. Quantities in the article's base unit.
export class DeliveryRowInvoicedError extends Error {
  constructor(
    readonly invoiced: number,
    readonly deliveredAfter: number
  ) {
    super(
      `Raden är fakturerad (${invoiced.toLocaleString("sv-SE")}) och levererat antal skulle bli ${deliveredAfter.toLocaleString("sv-SE")} — kreditera fakturan eller ta bort fakturautkastet först`
    );
    this.name = "DeliveryRowInvoicedError";
  }
}

// Pallkort for a följesedel whose rows are all undone — nothing left to ship.
export class DeliveryUndoneError extends Error {
  constructor(deliveryNumber: string) {
    super(`Delivery ${deliveryNumber} has been undone`);
    this.name = "DeliveryUndoneError";
  }
}


// "TERM01 · Fritt vårt lager"-strings for the PDF's terms lines.
// Konfigurator 4c: a configured row's stored förkalkyl
// (sales_order_rows.configuration_cost) is internal cost data that never
// leaves the service as such — listRows exposes only the derived
// selfCostPerUnit/selfCostCalculatedAt, and every other row this service
// returns (create, add, update, Ändra konfiguration, delivery) goes through
// here. The OAuth POST /quotes answer is therefore cost-free too.
// Påslag (#16, 0197): every returned row also carries `calculatedPrice`,
// derived from its price origin — the order card's Kalkylpris tag.
function withoutConfigurationCost<T extends { configurationCost?: unknown; priceOrigin: SalesRowPriceOrigin }>(
  row: T
): Omit<T, "configurationCost"> & { calculatedPrice: boolean } {
  const { configurationCost: _cost, ...rest } = row;
  return { ...rest, calculatedPrice: row.priceOrigin === "calculated" };
}

// Påslag (#16, 0197): the price origin of a row the price chain priced —
// its Kalkylpris step or any other.
function chainOrigin(source: PriceSource): SalesRowPriceOrigin {
  return source === "calculated" ? "calculated" : "chain";
}

// Ändra konfiguration (4b): one mapping from the repository's refusal
// reasons to errors, shared by the variant branch's unlocked pre-read and
// the locked re-check so both raise the identical RowConfigurationLockedError.
function throwRowConfigurationFailure(result: Extract<RowConfigurationMutationResult, { ok: false }>, rowId: string, orderNumber = ""): never {
  switch (result.reason) {
    // Påslag (#16 etapp 3): only the locked write re-reads the markups.
    case "markups_changed":
      throw new SalesOrderMarkupsChangedError(orderNumber);
    case "row_not_found":
      throw new SalesOrderRowNotFoundError(rowId);
    case "order_status":
      throw new RowConfigurationLockedError(`ordern är i status ${result.orderStatus}`);
    case "delivered":
      throw new RowConfigurationLockedError("raden har levererats");
    case "manufacturing_order":
      throw new RowConfigurationLockedError("raden har en tillverkningsorder");
    case "invoice_row":
      throw new RowConfigurationLockedError("raden är fakturerad");
  }
}

// Påslag på offert och order (#16 etapp 3): the order's own two price
// markups as numbers (null = inherits kund → varugrupp → företaget), and as
// the chain's `orderMarkups` — null when the order has none of its own.
function salesOrderMarkups(order: { generalMarkupPercent?: string | null; materialMarkupPercent?: string | null }): SalesOrderMarkups {
  return {
    generalMarkupPercent: order.generalMarkupPercent == null ? null : Number(order.generalMarkupPercent),
    materialMarkupPercent: order.materialMarkupPercent == null ? null : Number(order.materialMarkupPercent),
  };
}
function ownOrderMarkups(markups: SalesOrderMarkups): PriceMarkups | null {
  return markups.generalMarkupPercent === null && markups.materialMarkupPercent === null ? null : markups;
}
// A sent markup at the column's two decimals (what the header will store),
// omitted = the current one.
function nextOrderMarkups(current: SalesOrderMarkups, input: { generalMarkupPercent?: number | null; materialMarkupPercent?: number | null }): SalesOrderMarkups {
  const next = (sent: number | null | undefined, stored: number | null) =>
    sent === undefined ? stored : sent === null ? null : roundPercent(sent);
  return {
    generalMarkupPercent: next(input.generalMarkupPercent, current.generalMarkupPercent),
    materialMarkupPercent: next(input.materialMarkupPercent, current.materialMarkupPercent),
  };
}
// The header's planned repricing attempts before MarkupRepricingConflictError:
// a plan goes stale only when the order's rows change between the plan and
// the locks, so a second attempt nearly always goes through.
const REPRICING_ATTEMPTS = 3;

// Påslag per kund (#16): the customer's two price markups as the audit entry
// records them — numbers, null = inherits (varugrupp → företaget).
function customerMarkups(row: { generalMarkupPercent: string | null; materialMarkupPercent: string | null } | null) {
  return {
    generalMarkupPercent: row?.generalMarkupPercent == null ? null : Number(row.generalMarkupPercent),
    materialMarkupPercent: row?.materialMarkupPercent == null ? null : Number(row.materialMarkupPercent),
  };
}

function termLabel(code: string | null, name: string | null) {
  if (!code && !name) return null;
  return [code, name].filter(Boolean).join(" \u00b7 ");
}

// Dokument på engelska (#7): the term's name in the document's language
// (the English name only when filled in — localized()).
function localizedTermLabel(code: string | null, name: string | null, nameEn: string | null | undefined, language: DocumentLanguage) {
  return termLabel(code, name === null ? null : localized(name, nameEn, language));
}

export function createSalesService(
  repo: SalesRepository,
  registers: RegisterReferenceReader,
  mail: MailService,
  pdf: DocumentPdfService,
  stock: StockBalanceReader,
  articleFiles: ArticleFileReader &
    ArticleUnitReader &
    ArticleRevisionReader & {
      // C3: existence check for price-list rows / customer prices' articleId
      // target (→ 404 instead of a raw FK violation) — same inline extension
      // purchase.service.ts uses for the article-supplier catalog.
      // G1: articleNumber is also used to resolve a human-readable label for
      // order-row audit detail (row_added/row_updated/row_deleted).
      // rounding (Avrundning): the step row quantities are rounded up to —
      // see roundForArticle below.
      // configuratorMode: a template in mode variants is refused on new rows
      // (assertOrderableArticle in resolveRowInput).
      getArticle(
        id: string
      ): Promise<{ id: string; articleNumber: string; rounding: string | null; configuratorMode: "variants" | "to_order" | null } | null>;
    },
  settings: SalesSettingsReader,
  // C3: the price chain (price-resolver.ts's resolvePrice), already bound to
  // a db handle by the caller (app.ts) — same "inject a bound function"
  // shape as the other cross-module readers above, kept explicit rather than
  // constructing its own Db here.
  // Påslag (#16 etapp 3): the query carries the order's own markups when
  // the row is on an order that has one (chainQuery below).
  resolvePrice: (query: PriceChainQuery) => Promise<PriceResolution>,
  // G1: optional, defaults to a no-op — see the import comment above.
  audit: AuditWriter = { log: async () => {} },
  // E3: optional — see ManufacturingCoverageReader above. app.ts wires
  // manufacturingService.coverageForSalesOrderRows in; every test file that
  // predates E3 (and a few new ones that deliberately want the fallback)
  // simply omit the argument.
  manufacturingCoverage?: ManufacturingCoverageReader,
  // Optional for the same reason as manufacturingCoverage: omitted, every row
  // simply gets selfCostPerUnit null, which every consumer already has to
  // handle (an article without a calculation looks the same).
  selfCosts?: ArticleSelfCostReader,
  // Frakt: see ShipmentReader above.
  shipments?: ShipmentReader,
  // Konfigurator 4b: see RowConfigurationReader above.
  rowConfiguration: RowConfigurationReader = ROW_CONFIGURATION_NOT_WIRED,
  // Momskoder: see SalesFreightReader above.
  freight: SalesFreightReader = { freightArticleId: async () => null },
  // Valuta: today's rate for a new order (or a currency change) in another
  // currency than SEK. Optional so the fixtures that never sell in another
  // currency need not wire it; without it such an order needs an explicit
  // exchangeRate (else 409 exchange-rate-unavailable).
  rates: ExchangeRateReader | null = null
) {
  // Valuta: what a row on an order is priced in — the order's customer, its
  // currency and its rate (SEK at rate 1 for a SEK order). Påslag (#16 etapp
  // 3): and the order's own price markups (null = none, the customer's →
  // varugrupp → företaget apply).
  type RowPricing = { customerId: string; currency: string; exchangeRate: number; orderMarkups?: PriceMarkups | null };
  function orderPricing(order: {
    customerId: string;
    currency: string;
    exchangeRate: string | number;
    generalMarkupPercent?: string | null;
    materialMarkupPercent?: string | null;
  }): RowPricing {
    return {
      customerId: order.customerId,
      currency: order.currency,
      exchangeRate: Number(order.exchangeRate),
      orderMarkups: ownOrderMarkups(salesOrderMarkups(order)),
    };
  }
  // The pricing a chain read gets: SEK orders pass no currency at all, so the
  // chain (and every reader stub) sees exactly the call it saw before.
  function chainCurrency(pricing: RowPricing): { currency?: string; exchangeRate?: number } {
    return pricing.currency === SEK ? {} : { currency: pricing.currency, exchangeRate: pricing.exchangeRate };
  }
  // The price chain's own reads (resolvePrice): the currency, plus the
  // order's markups only when it has any — the configurator's template chain
  // (rowConfiguration.evaluate) never takes them (no Kalkylpris there).
  function chainQuery(pricing: RowPricing): { currency?: string; exchangeRate?: number; orderMarkups?: PriceMarkups } {
    return { ...chainCurrency(pricing), ...(pricing.orderMarkups ? { orderMarkups: pricing.orderMarkups } : {}) };
  }
  // Påslag på offert och order (#16 etapp 3, beslut 3; the price origin of
  // 0197): what new markups on the header do to the rows — the ONE plan
  // behind the preview, the confirmation's 409 and the save. A row is
  // repriced when the price chain priced it (price_origin chain or
  // calculated — a manual row, with an à-pris or a rabatt written by hand,
  // never moves), it has nothing delivered, is on no invoice row of a live
  // invoice (a draft and a credit note count), and is neither configured, a
  // ställkostnad nor the freight row. Its new price is the price chain's
  // answer for the row with the order's NEW markups, in the order's currency
  // at `exchangeRate` (the rate the header will have), per base unit at the
  // row's quantity: the Kalkylpris with the new markups (an article-price
  // row gets it too), or — when the step no longer applies or the
  // calculation cannot carry the new markups — whatever the chain prices it
  // with now; the row is then "chain" and follows the next change, so a
  // cleared markup can be set again. A chain row from a kundpris or a
  // prislista gets the chain's answer again (the same price unless the
  // agreement changed — the preview shows it). A chain without any price
  // leaves the row as it is. Without an actual change of a markup nothing is
  // repriced (a newer calculation alone never moves a price). Read outside
  // any transaction: the chain reads the settings and the configurator's
  // variant step on their own connections. `reprice` is the plan the
  // header's transaction re-checks under its locks (repository
  // updateSalesOrderHeaderWithAddress): every row the lock will select, with
  // its columns as read here.
  async function planMarkupRepricing(
    order: NonNullable<Awaited<ReturnType<SalesRepository["findSalesOrderById"]>>>,
    input: { generalMarkupPercent?: number | null; materialMarkupPercent?: number | null },
    exchangeRate: number = Number(order.exchangeRate)
  ): Promise<{ repricing: MarkupRepricing; reprice: Map<string, PlannedRowReprice> | null }> {
    const before = salesOrderMarkups(order);
    const after = nextOrderMarkups(before, input);
    const changed =
      before.generalMarkupPercent !== after.generalMarkupPercent || before.materialMarkupPercent !== after.materialMarkupPercent;
    const repricing: MarkupRepricing = { changed, before, after, currency: order.currency, exchangeRate, rows: [], kept: [] };
    if (!changed) return { repricing, reprice: null };

    const [rows, freightArticleId] = await Promise.all([repo.listRowsByOrder(order.id), freight.freightArticleId()]);
    // The rows the header's lock selects (repricingCandidateWhere).
    const lockable = rows.filter(
      (r) => r.priceOrigin !== "manual" && Number(r.quantityDelivered) === 0 && r.configuration === null && r.setupForRowId === null
    );
    const onInvoices = await repo.rowsOnInvoices(lockable.map((r) => r.id));
    const pricing: RowPricing = { customerId: order.customerId, currency: order.currency, exchangeRate, orderMarkups: ownOrderMarkups(after) };
    const reprice = new Map<string, PlannedRowReprice>();
    const lockableIds = new Set(lockable.map((r) => r.id));
    for (const row of rows) {
      const kept = (reason: MarkupRepricing["kept"][number]["reason"]) =>
        repricing.kept.push({ rowId: row.id, articleNumber: row.articleNumber, reason });
      const plan = (planned: PlannedRowReprice["after"]) =>
        reprice.set(row.id, {
          articleId: row.articleId,
          quantityOrdered: row.quantityOrdered,
          unitFactor: row.unitFactor,
          unitPrice: row.unitPrice,
          discountPercent: row.discountPercent,
          priceOrigin: row.priceOrigin,
          after: planned,
        });
      if (!lockableIds.has(row.id)) {
        // Manual first: a handwritten price is the reason whatever else holds.
        kept(row.priceOrigin !== "manual" && Number(row.quantityDelivered) > 0 ? "delivered" : "manual");
        continue;
      }
      if (row.articleId === freightArticleId) {
        plan(null);
        kept("manual");
        continue;
      }
      if (onInvoices.has(row.id)) {
        plan(null);
        kept("invoiced");
        continue;
      }
      const resolution = await resolvePrice({
        customerId: order.customerId,
        articleId: row.articleId,
        quantity: Number(row.quantityOrdered),
        ...chainQuery(pricing),
      });
      if (!resolution?.price) {
        plan(null);
        kept("no-price");
        continue;
      }
      const next = {
        unitPrice: resolution.price.unitPrice,
        discountPercent: resolution.price.discountPercent,
        priceOrigin: chainOrigin(resolution.price.source),
      };
      // Compared at the columns' scales: à-pris numeric(14,4), rabatt (5,2).
      const samePrice =
        Math.round(next.unitPrice * 10000) === Math.round(Number(row.unitPrice) * 10000) &&
        Math.round(next.discountPercent * 100) === Math.round(Number(row.discountPercent) * 100);
      if (samePrice) {
        // The price stands; a step that changed (the same figure out of the
        // Kalkylpris or the article's price) only moves the origin, which
        // needs no confirmation.
        plan(next.priceOrigin === row.priceOrigin ? null : next);
        kept("unchanged");
        continue;
      }
      plan(next);
      const repriced: MarkupRepricingRow = {
        rowId: row.id,
        articleId: row.articleId,
        articleNumber: row.articleNumber,
        quantity: Number(row.quantityOrdered),
        before: { unitPrice: Number(row.unitPrice), discountPercent: Number(row.discountPercent), priceOrigin: row.priceOrigin },
        after: {
          unitPrice: next.unitPrice,
          discountPercent: next.discountPercent,
          source: resolution.price.source,
          priceOrigin: next.priceOrigin,
        },
        calculatedPrice: next.priceOrigin === "calculated",
        ...(resolution.calculatedPriceUnavailable ? { calculatedPriceUnavailable: resolution.calculatedPriceUnavailable } : {}),
      };
      repricing.rows.push(repriced);
    }
    return { repricing, reprice };
  }

  // Valuta: a document's rate — SEK is always 1 (another explicit rate is a
  // 400), an explicit rate wins, else today's rate from Riksbanken /
  // Valutakurser. Looked up BEFORE any transaction (it may call Riksbanken);
  // no rate ⇒ ExchangeRateUnavailableError (409, "ange kursen själv").
  async function documentRate(currency: string, explicit: number | undefined): Promise<number> {
    if (currency === SEK) {
      if (explicit !== undefined && explicit !== 1) throw new SalesOrderExchangeRateError();
      return 1;
    }
    if (explicit !== undefined) return explicit;
    const today = stockholmToday();
    if (!rates) throw new ExchangeRateUnavailableError(currency, today);
    return (await rates.getRate(currency, today)).rate;
  }
  // Per-row revision line for document printing — null when the system
  // setting "show_revisions_on_documents" is off.
  async function revisionInfoMap(articleIds: string[]) {
    const { showRevisionsOnDocuments } = await settings.getSettings();
    if (!showRevisionsOnDocuments) return null;
    return articleFiles.activeRevisionInfo([...new Set(articleIds)]);
  }
  // Drawings for every distinct article on the order, as extra attachments.
  async function drawingAttachments(articleIds: string[]) {
    const files = await articleFiles.filesWithData([...new Set(articleIds)]);
    return files.map((f) => ({ filename: f.filename, content: f.data }));
  }
  // Order rows may be entered in one of the article's alternative units —
  // resolve the factor snapshot and store quantity/price in the base unit.
  // C3: unitPrice is now optional — omitted ⇒ the price chain resolves both
  // unitPrice AND discountPercent (against the BASE quantity, since the
  // resolved price is already in the article's base unit — no toBasePrice
  // needed for it). Sent (even 0) ⇒ used verbatim via toBasePrice as before,
  // with discountPercent defaulting to 0 rather than being looked up.
  // articles.rounding (Avrundning): the BASE quantity is rounded up to the
  // article's step here in the service, never in a route — the same
  // roundUpToMultiple behovsberäkningen applies to its proposals, so an order
  // and the proposal it came from agree. A row entered in an alternative
  // unit therefore displays a converted, non-round number afterwards; that
  // is the decided behaviour (the step is defined in the base unit).
  async function roundForArticle(articleId: string, baseQuantity: number) {
    const article = await articleFiles.getArticle(articleId);
    return roundUpToMultiple(baseQuantity, article?.rounding);
  }
  // The row_added audit entry shared by addRow and setFreightRow.
  async function logRowAdded(
    orderNumber: string,
    row: { articleId: string; quantityOrdered: string; unitPrice: string; discountPercent: string },
    userId?: string | null
  ) {
    const article = await articleFiles.getArticle(row.articleId);
    await audit.log({
      entityType: "sales_order_row",
      entityId: orderNumber,
      action: "row_added",
      detail: {
        articleNumber: article?.articleNumber ?? null,
        quantity: row.quantityOrdered,
        unitPrice: row.unitPrice,
        discountPercent: row.discountPercent,
      },
      userId: userId ?? null,
    });
  }
  async function resolveRowInput<
    T extends {
      articleId: string;
      quantity: number;
      unitPrice?: number;
      discountPercent?: number;
      unitId?: string | null;
      configuration?: OrderRowConfigurationInput;
    },
  >(
    pricing: RowPricing,
    input: T,
    userId?: string | null
  ): Promise<Omit<T, "configuration"> & SalesRowWrite & { chainPriced: boolean }> {
    const { customerId } = pricing;
    // Delprojekt 5: a configuration on a template in mode variants resolves
    // (fetches or creates) the variant — the same resolveVariant as Konfigurera,
    // under the template lock, BEFORE the order's own transaction — and the row
    // continues as an ordinary row on the variant (configuration null, priced
    // through resolvePrice's variant step, a handwritten unit price stands).
    // Checked before assertOrderableArticle, which refuses the template itself.
    if (input.configuration) {
      const template = await articleFiles.getArticle(input.articleId);
      if (template?.configuratorMode === "variants") {
        const { article: variant } = await rowConfiguration.resolveVariant(input.articleId, input.configuration.selection, userId ?? null);
        const { configuration: _resolved, ...rest } = input;
        // The variant is never a template, so the recursion takes the ordinary path.
        return resolveRowInput(pricing, { ...rest, articleId: variant.id } as T, userId);
      }
    }
    // Produktkonfigurator: a template in mode variants never goes on a new
    // row without a configuration (its variants are); a template in to_order
    // (beställningsvara) goes on the row WITH a configuration, and a
    // configuration is refused on anything else. An unknown article is a 404
    // (ArticleNotFoundError), not the row's FK failing as a 500. One read
    // serves the guards and the rounding step.
    const article = await articleFiles.getArticle(input.articleId);
    if (!article) throw new ArticleNotFoundError(input.articleId);
    assertOrderableArticle(article);
    if (article?.configuratorMode === "to_order" && !input.configuration) throw new ConfigurationRequiredError(article.articleNumber);
    if (input.configuration && article?.configuratorMode !== "to_order") {
      throw new ConfigurationNotAllowedError(article?.articleNumber ?? input.articleId);
    }
    const selection = await articleFiles.resolveUnitSelection(input.articleId, input.unitId);
    // Rounded BEFORE the price chain runs, so a staffel sees the quantity
    // that is actually ordered.
    const quantity = roundUpToMultiple(toBaseQuantity(input.quantity, selection.unitFactor), article?.rounding);

    // 4b: the evaluation IS the row's price source — the customer's chain on
    // the template plus the configuration's additions, at the ordered quantity.
    // 4c: the same evaluation carries the configuration's förkalkyl at that
    // quantity — the row's own cost basis (null = not derivable, never 0).
    let configuration: OrderRowConfiguration | null = null;
    let configurationCost: OrderRowConfigurationCost | null = null;
    if (input.configuration) {
      const evaluated = await rowConfiguration.evaluate(input.articleId, input.configuration.selection, {
        customerId,
        quantity,
        ...chainCurrency(pricing),
      });
      if (!evaluated.valid || !evaluated.configuration) throw new ConfiguratorInvalidConfigurationError(evaluated.errors);
      configuration = evaluated.configuration;
      configurationCost = evaluated.cost;
    }

    let unitPrice: number;
    let discountPercent = input.discountPercent ?? 0;
    // Ställpris of the matched customer rule — undefined until the chain ran.
    let chainSetupPrice: number | undefined;
    // Påslag (#16, 0197): the row's price origin. The chain's step only when
    // the chain priced the row with neither an à-pris nor a rabatt sent; an
    // explicit à-pris (even the chain's figure) or a rabatt is the seller's
    // (manual), and a beställningsvara is priced by its template (manual —
    // it never follows the order's markups). `chainPriced` = the chain
    // priced the row, so it read the order's markups (addRow re-checks
    // them under its lock).
    let priceOrigin: SalesRowPriceOrigin = "manual";
    let chainPriced = false;
    if (input.unitPrice !== undefined) {
      unitPrice = toBasePrice(input.unitPrice, selection.unitFactor);
    } else if (configuration) {
      // The template has no base price and the customer chain gave nothing —
      // the seller writes the row's own price (Avvikelse 1).
      if (configuration.price.unitPrice === null) throw new PriceNotFoundError(article?.articleNumber ?? input.articleId);
      unitPrice = configuration.price.unitPrice;
      if (input.discountPercent === undefined) discountPercent = configuration.price.discountPercent;
    } else {
      const resolution = await resolvePrice({ customerId, articleId: input.articleId, quantity, ...chainQuery(pricing) });
      if (!resolution?.price) throw new PriceNotFoundError(resolution?.articleNumber ?? input.articleId);
      unitPrice = resolution.price.unitPrice;
      if (input.discountPercent === undefined) discountPercent = resolution.price.discountPercent;
      chainSetupPrice = resolution.price.setupPrice ?? 0;
      chainPriced = true;
      // A discount sent with the à-pris omitted is the seller's: the row is
      // then partly handwritten and is never repriced (the review of etapp 2).
      priceOrigin = input.discountPercent === undefined ? chainOrigin(resolution.price.source) : "manual";
    }
    const setupCharge = configuration ? null : await setupChargeFor(pricing, input.articleId, quantity, chainSetupPrice);
    const { configuration: _raw, ...rest } = input;
    return {
      ...rest,
      quantity,
      unitPrice,
      discountPercent,
      unitId: selection.unitId,
      unitFactor: selection.unitFactor,
      configuration,
      configurationCost,
      setupCharge,
      priceOrigin,
      chainPriced,
    };
  }

  // Ställkostnad: the extra row a new ordinary row gets when the customer's
  // price rule carries a ställpris and a Ställkostnadsartikel is chosen —
  // even when the seller typed their own à-pris (the chain then runs once
  // more, for the ställpris alone). Never for the Ställkostnadsartikel itself.
  async function setupChargeFor(
    pricing: RowPricing,
    articleId: string,
    quantity: number,
    knownSetupPrice: number | undefined
  ): Promise<{ articleId: string; unitPrice: number } | null> {
    const { setupChargeArticleId } = await settings.getSettings();
    if (!setupChargeArticleId || setupChargeArticleId === articleId) return null;
    const setupPrice =
      knownSetupPrice ??
      (await resolvePrice({ customerId: pricing.customerId, articleId, quantity, ...chainQuery(pricing) }))?.price
        ?.setupPrice ??
      0;
    return setupPrice > 0 ? { articleId: setupChargeArticleId, unitPrice: setupPrice } : null;
  }
  // A row's own Leveransdatum is worth a document line only when it differs
  // from the order's (a row without one follows the order).
  function ownDeliveryDate(rowDate: string | null, orderDate: string | null) {
    return rowDate && rowDate !== orderDate ? rowDate : null;
  }

  // The quote and the order confirmation are the same document with a
  // different title — shared by the download endpoint and the email flow.
  // showConfigurationPrices (konfigurator 4b, "Visa tilläggspriser"): whether
  // a configured row's choice lines carry their price additions — already
  // resolved by the caller (explicit flag, else the customer's setting).
  // Giltig t.o.m. of a new quote: the caller's date (null = none), else
  // today (Stockholm) + Offertens giltighetstid, 0 days = none. A direct
  // order ("Ny kundorder", confirm: true) is not a quote and never gets one.
  async function resolveQuoteValidUntil(input: Pick<CreateQuoteInput, "confirm" | "quoteValidUntil">): Promise<string | null> {
    if (input.confirm) return null;
    if (input.quoteValidUntil !== undefined) return input.quoteValidUntil;
    const { quoteValidityDays } = await settings.getSettings();
    return quoteValidityDays > 0 ? addDays(stockholmToday(), quoteValidityDays) : null;
  }

  async function renderSalesOrderPdf(
    order: NonNullable<Awaited<ReturnType<SalesRepository["findSalesOrderById"]>>>,
    variant: "quote" | "confirmation",
    showConfigurationPrices: boolean
  ) {
    const [customer, rows, documentSettings, vatCodeTexts, freightArticleId] = await Promise.all([
      repo.findCustomerById(order.customerId),
      repo.listRowsByOrder(order.id),
      settings.getSettings(),
      repo.vatCodeInvoiceTexts(),
      freight.freightArticleId(),
    ]);
    const { showOrderRevisionOnDocuments } = documentSettings;
    const extraDescription = extraDescriptionFor(documentSettings, variant === "quote" ? "quote" : "orderConfirmation");
    // Dokument på engelska (#7): the customer's language, live — the quote
    // and the confirmation are re-rendered on every print.
    const language = documentLanguageOf(customer!.language);
    const texts = documentTexts(language);
    const customerArticleNumbers = await repo.customerArticleNumberMap(order.customerId, rows.map((r) => r.articleId));
    const articleNumberByRowId = new Map(rows.map((r) => [r.id, r.articleNumber]));
    const revisions = await revisionInfoMap(rows.map((r) => r.articleId));
    // Momskoder (spec 4.5): each row's VAT follows the momskod the invoice
    // row will get (salesVatCode) — an EU customer sees 0 % already on the
    // quote — and the codes' invoice texts are printed like on the invoice.
    const rowCodes = rows.map((r) =>
      salesVatCode({
        customer: customer!,
        isGoods: salesRowIsGoods({ articleId: r.articleId, articleType: r.articleType, freightArticleId }),
        articleRate: Number(r.articleVatRate),
      })
    );
    const usedCodes = new Set<VatCode>(rowCodes);
    const vatTexts = VAT_CODE_CATALOG.flatMap((entry) => {
      const code = usedCodes.has(entry.code) ? vatCodeTexts.get(entry.code) : undefined;
      const text = code ? localized(code.invoiceText ?? "", code.invoiceTextEn, language).trim() : undefined;
      return text ? [text] : [];
    });
    // Offerter (0138): the quote prints its OF- number even after the order
    // took a KO- one; the confirmation prints the order's number and, when
    // it came from an OF- numbered quote, "Vår offert:" as the reference.
    const documentNumber = variant === "quote" ? (order.quoteNumber ?? order.orderNumber) : order.orderNumber;
    // An order made with Skapa kundorder has no quote number of its own —
    // its reference is the quote it was copied from.
    const ownQuoteNumber = order.quoteNumber && order.quoteNumber !== order.orderNumber ? order.quoteNumber : null;
    const quoteReference = variant === "confirmation" ? (order.sourceQuoteNumber ?? ownQuoteNumber) : null;
    const content = await pdf.render({
      language,
      title: variant === "quote" ? texts.titles.quote : texts.titles.orderConfirmation,
      documentNumber,
      quoteReference,
      date: order.createdAt,
      partnerLabel: texts.partnerLabels.customer,
      partner: customer!,
      // Valuta: the order's own currency (its prices are in it).
      currency: order.currency,
      // Printed in the row's unit (the values are stored in the base unit).
      rows: rows.map((r, i) => ({
        articleNumber: r.articleNumber,
        articleName: localized(r.articleName, r.articleNameEn, language),
        quantity: String(toUnitQuantity(Number(r.quantityOrdered), r.unitFactor)),
        unit: localized(r.unitCode, r.unitCodeEn, language),
        unitPrice: String(toUnitPrice(Number(r.unitPrice), r.unitFactor)),
        discountPercent: r.discountPercent,
        // The row's momskod rate — only used when pricesIncludeVat
        // (privatperson) grosses up the cells.
        vatRate: vatCodeEntry(rowCodes[i]!).rate,
        revisionInfo: formatRevisionInfo(revisions?.get(r.articleId), language),
        articleInfo: formatArticleAttributes(
          {
            surfaceTreatment: r.articleSurfaceTreatment,
            colour: r.articleColour,
          },
          language
        ),
        extraDescription: extraDescription(
          r.articleExtraDescription ? localized(r.articleExtraDescription, r.articleExtraDescriptionEn, language) : null
        ),
        customerArticleNumber: customerArticleNumbers.get(r.articleId) ?? null,
        setupForArticleNumber: r.setupForRowId ? (articleNumberByRowId.get(r.setupForRowId) ?? null) : null,
        configurationLines: rowConfigurationLines(r.configuration, showConfigurationPrices, language),
        deliveryDate: ownDeliveryDate(r.expectedDeliveryDate, order.expectedDeliveryDate),
      })),
      showTotal: true,
      vatTexts,
      deliveryDate: order.expectedDeliveryDate,
      // Giltig t.o.m. is printed on the quote only — the confirmation is
      // the order, the validity has played out.
      validUntil: variant === "quote" ? order.quoteValidUntil : null,
      revision: showOrderRevisionOnDocuments ? order.revision : null,
      partnerNumber: customer!.customerNumber,
      ourSupplierNumberAtCustomer: customer!.ourSupplierNumber,
      pricesIncludeVat: customer!.privatePerson,
      // Both variants print whichever of the two the order carries: a quote
      // normally answers Kundens förfrågan (an older one may have an order
      // number), the confirmation has Ert ordernummer and, when set, the
      // inquiry it came from.
      customerOrderNumber: order.customerOrderNumber,
      customerInquiryNumber: order.customerInquiryNumber,
      yourReference: order.customerReference,
      deliveryAddress: order.deliveryAddress
        ? {
            label: order.deliveryAddressLabel ?? "",
            address: order.deliveryAddress,
            postalCode: order.deliveryPostalCode,
            city: order.deliveryCity,
            country: order.deliveryCountry,
          }
        : null,
      deliveryTerm: localizedTermLabel(order.deliveryTermCode, order.deliveryTermName, order.deliveryTermNameEn, language),
      paymentTerm: localizedTermLabel(order.paymentTermCode, order.paymentTermName, order.paymentTermNameEn, language),
      // A carrier's name is a company name — never translated.
      carrier: termLabel(order.carrierCode, order.carrierName),
    });
    const filename = variant === "quote" ? texts.filenames.quote(documentNumber) : texts.filenames.orderConfirmation(documentNumber);
    return { filename, content };
  }

  // The invoice: same document skeleton as the quote/confirmation but
  // addressed to the customer's INVOICE address (falling back to the
  // visiting address), with a due date from the payment term and a VAT
  // summary. Swedish v1: one rate, 25 %.
  async function renderInvoicePdf(
    order: NonNullable<Awaited<ReturnType<SalesRepository["findSalesOrderById"]>>>
  ) {
    const [customer, rows] = await Promise.all([repo.findCustomerById(order.customerId), repo.listRowsByOrder(order.id)]);
    const useInvoiceAddress = Boolean(customer!.invoiceAddress);
    const partner = useInvoiceAddress
      ? {
          name: customer!.invoiceName || customer!.name,
          address: customer!.invoiceAddress,
          postalCode: customer!.invoicePostalCode,
          city: customer!.invoiceCity,
          country: customer!.invoiceCountry ?? customer!.country,
        }
      : customer!;

    // Payment terms whose code is a number of days ("30" → 30 dagar netto)
    // produce a due date; other codes just print the term itself.
    const invoicedAt = order.invoicedAt ?? new Date();
    const termDays = Number.parseInt(order.paymentTermCode ?? "", 10);
    const dueDate = Number.isFinite(termDays)
      ? new Date(invoicedAt.getTime() + termDays * 24 * 60 * 60 * 1000)
      : null;

    // Dokument på engelska (#7): this legacy reprint has no stamped language
    // (it predates invoices.language) — the customer's live language.
    const language = documentLanguageOf(customer!.language);
    const texts = documentTexts(language);
    const content = await pdf.render({
      language,
      title: texts.titles.invoice,
      documentNumber: order.invoiceNumber!,
      date: invoicedAt,
      partnerLabel: useInvoiceAddress ? texts.partnerLabels.invoiceAddress : texts.partnerLabels.customer,
      partner: partner!,
      currency: "SEK",
      // Printed in the row's unit (the values are stored in the base unit).
      rows: rows.map((r) => ({
        articleNumber: r.articleNumber,
        articleName: localized(r.articleName, r.articleNameEn, language),
        quantity: String(toUnitQuantity(Number(r.quantityOrdered), r.unitFactor)),
        unit: localized(r.unitCode, r.unitCodeEn, language),
        unitPrice: String(toUnitPrice(Number(r.unitPrice), r.unitFactor)),
      })),
      showTotal: true,
      // Literal 25, NOT DEFAULT_VAT_RATE: this legacy renderer only serves
      // reprints of orders invoiced before C1, which were all issued at
      // 25 % — the historical documents must not change even if defaults do.
      vat: { rate: 25 },
      dueDate,
      orderReference: order.orderNumber,
      customerOrderNumber: order.customerOrderNumber,
      yourReference: order.customerReference,
      deliveryAddress: order.deliveryAddress
        ? {
            label: order.deliveryAddressLabel ?? "",
            address: order.deliveryAddress,
            postalCode: order.deliveryPostalCode,
            city: order.deliveryCity,
            country: order.deliveryCountry,
          }
        : null,
      deliveryTerm: localizedTermLabel(order.deliveryTermCode, order.deliveryTermName, order.deliveryTermNameEn, language),
      paymentTerm: localizedTermLabel(order.paymentTermCode, order.paymentTermName, order.paymentTermNameEn, language),
      carrier: termLabel(order.carrierCode, order.carrierName),
    });
    return { filename: texts.filenames.invoice(order.invoiceNumber!), content };
  }
  // Referenced base-data entries must exist — validated here so the API
  // answers 404 instead of surfacing an FK violation.
  async function validateRegisterRefs(input: {
    deliveryTermId?: string | null;
    paymentTermId?: string | null;
    carrierId?: string | null;
    // C3: priceListId isn't a register.service entry (price_lists lives in
    // this module), so it's checked straight against the repository — same
    // "exists via findById" idiom addPriceListRow already uses for listId.
    priceListId?: string | null;
    // Frakt etapp 2: freight_products lives in the shipping module; sales only
    // needs to know the id exists (an FK would otherwise surface as a 500).
    defaultFreightProductId?: string | null;
  }) {
    if (input.deliveryTermId && !(await registers.deliveryTerms.exists(input.deliveryTermId)))
      throw new RegisterEntryNotFoundError(input.deliveryTermId);
    if (input.paymentTermId && !(await registers.paymentTerms.exists(input.paymentTermId)))
      throw new RegisterEntryNotFoundError(input.paymentTermId);
    if (input.carrierId && !(await registers.carriers.exists(input.carrierId)))
      throw new RegisterEntryNotFoundError(input.carrierId);
    if (input.priceListId && !(await repo.findPriceListById(input.priceListId)))
      throw new PriceListNotFoundError(input.priceListId);
    if (input.defaultFreightProductId && !(await repo.freightProductExists(input.defaultFreightProductId)))
      throw new InvalidFreightProductError();
  }

  // G1: shared by deliverGoods/deliverBatch — both wrap repo.deliverBatch and
  // must log the same "delivery" event once it succeeds. entityId is the
  // FS-number (the delivery occasion's own document number); detail is kept
  // to what was actually shipped in THIS occasion (not the whole order).
  async function logDelivery(
    orderId: string,
    deliveryNumber: string,
    rows: { rowId: string; quantity: number }[],
    userId: string | null
  ) {
    const order = await repo.findSalesOrderById(orderId);
    await audit.log({
      entityType: "delivery",
      entityId: deliveryNumber,
      action: "delivered",
      detail: { orderNumber: order?.orderNumber ?? null, rows },
      userId,
    });
  }

  function withVatTreatment<T extends SalesVatCustomer>(customer: T) {
    return { ...customer, vatTreatment: customerVatTreatment(customer), vatNumberWarning: customerVatNumberWarning(customer) };
  }

  // Tillåten överleverans (#24) for a customer: the card's own choice, else
  // the system setting. Read outside the delivery's transaction, like the
  // purchase side's tolerance. null = no limit.
  async function overDeliveryPercentFor(customerId: string): Promise<number | null> {
    const [customer, { salesOverDeliveryPercent }] = await Promise.all([
      repo.findCustomerById(customerId),
      settings.getSettings(),
    ]);
    return effectiveOverDeliveryPercent(
      { overDelivery: customer?.overDelivery ?? null, overDeliveryPercent: customer?.overDeliveryPercent ?? null },
      // null is "no limit" — only a reader without the setting means 0.
      salesOverDeliveryPercent === undefined ? 0 : salesOverDeliveryPercent
    );
  }

  // An unknown order is left to the delivery's own transaction to report.
  async function overDeliveryPercentForOrder(orderId: string): Promise<number | null> {
    const order = await repo.findSalesOrderById(orderId);
    return order ? overDeliveryPercentFor(order.customerId) : 0;
  }

  // Påslag per kund (#16): customer / markups_changed with before/after —
  // only when a price markup actually changed (the card sends both fields on
  // every save), like the varugrupp's. Kundpriser and prislistor are logged
  // the same way: the markup is the same kind of agreement.
  async function logCustomerMarkups(
    customerId: string,
    before: ReturnType<typeof customerMarkups>,
    after: ReturnType<typeof customerMarkups>,
    userId: string | null
  ) {
    if (before.generalMarkupPercent === after.generalMarkupPercent && before.materialMarkupPercent === after.materialMarkupPercent) return;
    await audit.log({ entityType: "customer", entityId: customerId, action: "markups_changed", detail: { before, after }, userId });
  }

  return {
    async createCustomer(input: CreateCustomerInput, userId: string | null = null) {
      await validateRegisterRefs(input);
      let created;
      try {
        created = await repo.createCustomer(input);
      } catch (err) {
        // customers' only unique constraint is customer_number, so a 23505
        // here can mean nothing else.
        if (isUniqueViolation(err)) throw new DuplicateCustomerNumberError(input.customerNumber ?? "");
        throw err;
      }
      await logCustomerMarkups(created.id, customerMarkups(null), customerMarkups(created), userId);
      return withVatTreatment(created);
    },

    async updateCustomer(id: string, input: UpdateCustomerInput, userId: string | null = null) {
      await validateRegisterRefs(input);
      // Read only when a markup is sent — the audit's before.
      const markupsSent = input.generalMarkupPercent !== undefined || input.materialMarkupPercent !== undefined;
      const current = markupsSent ? await repo.findCustomerById(id) : null;
      let row;
      try {
        row = await repo.updateCustomer(id, input);
      } catch (err) {
        if (isUniqueViolation(err)) throw new DuplicateCustomerNumberError(input.customerNumber ?? "");
        throw err;
      }
      if (!row) throw new CustomerNotFoundError(id);
      if (markupsSent) await logCustomerMarkups(id, customerMarkups(current), customerMarkups(row), userId);
      return withVatTreatment(row);
    },

    // Momskoder: vatTreatment is the customer card's Momsbehandling — the
    // same rules as the rows' derived momskod (customerVatTreatment) — and
    // vatNumberWarning what the card says about the VAT number of an EU
    // company customer (customerVatNumberWarning, never a refusal).
    async getCustomer(id: string) {
      const customer = await repo.findCustomerById(id);
      return customer ? withVatTreatment(customer) : null;
    },

    // Fasta leveransdagar: the earliest Förväntat leveransdatum (the day the
    // customer gets the goods) — only when the customer has fixed days, the
    // same prefill rule as the IO header — and the warning for q.date. null
    // = unknown customer.
    async getCustomerDeliveryDateSuggestion(
      q: CustomerDeliveryDateQuery,
      today: string = stockholmToday()
    ): Promise<CustomerDeliveryDateSuggestion | null> {
      const customer = await repo.findCustomerById(q.customerId);
      if (!customer) return null;
      const { defaults, offDays } = await repo.deliveryContext(deliveryHolidayWindow([today, q.date ?? today], 60));
      const settings = effectiveDeliverySettings(customer, "customer", defaults);
      return {
        date: settings.weekdays.length > 0 ? earliestCustomerDelivery(today, settings, offDays) : null,
        settings,
        summary: deliverySummary("customer", settings),
        warning: q.date ? deliveryDateWarning("customer", q.date, settings, offDays) : null,
      };
    },

    async listCustomerContacts(customerId: string) {
      if (!(await repo.findCustomerById(customerId))) throw new CustomerNotFoundError(customerId);
      return repo.listCustomerContacts(customerId);
    },

    async createCustomerContact(customerId: string, input: CreateContactInput) {
      if (!(await repo.findCustomerById(customerId))) throw new CustomerNotFoundError(customerId);
      return repo.createCustomerContact(customerId, input);
    },

    async updateCustomerContact(customerId: string, contactId: string, input: UpdateContactInput) {
      const row = await repo.updateCustomerContact(customerId, contactId, input);
      if (!row) throw new ContactNotFoundError(contactId);
      return row;
    },

    async deleteCustomerContact(customerId: string, contactId: string) {
      const row = await repo.deleteCustomerContact(customerId, contactId);
      if (!row) throw new ContactNotFoundError(contactId);
    },

    async listCustomers(query: ListQuery) {
      return repo.listCustomers(query);
    },

    // --- Delivery addresses (leveransadresser) ---

    async listDeliveryAddresses(customerId: string) {
      if (!(await repo.findCustomerById(customerId))) throw new CustomerNotFoundError(customerId);
      return repo.listDeliveryAddresses(customerId);
    },

    async createDeliveryAddress(customerId: string, input: CreateDeliveryAddressInput) {
      if (!(await repo.findCustomerById(customerId))) throw new CustomerNotFoundError(customerId);
      return repo.createDeliveryAddress(customerId, input);
    },

    async updateDeliveryAddress(customerId: string, addressId: string, input: UpdateDeliveryAddressInput) {
      const row = await repo.updateDeliveryAddress(customerId, addressId, input);
      if (!row) throw new DeliveryAddressNotFoundError(addressId);
      return row;
    },

    async deleteDeliveryAddress(customerId: string, addressId: string) {
      const row = await repo.deleteDeliveryAddress(customerId, addressId);
      if (!row) throw new DeliveryAddressNotFoundError(addressId);
    },

    // Header fields (customer's PO number/reference/delivery address) are
    // editable while the order is quote/confirmed/in_production.
    async updateSalesOrderHeader(orderId: string, input: UpdateSalesOrderHeaderInput, userId?: string | null) {
      const order = await repo.findSalesOrderById(orderId);
      if (!order) throw new SalesOrderNotFoundError(orderId);
      if (!isSalesOrderEditableStatus(order.status)) {
        throw new InvalidStatusTransitionError(`Cannot change the header of an order in status "${order.status}"`);
      }
      // Giltig t.o.m. only while the order is a quote (re-checked under the
      // row lock in the repository).
      if (input.quoteValidUntil !== undefined && !isLiveQuoteStatus(order.status)) {
        throw new InvalidStatusTransitionError(`Cannot change the validity date of an order in status "${order.status}"`);
      }
      // Valuta: currency and rate only as a quote or a confirmed order (the
      // status is re-checked under the row lock). A new currency needs an
      // order without rows (re-checked there too) and takes today's rate
      // unless one is sent — looked up here, outside the transaction.
      const currencyFields: { currency?: string; exchangeRate?: number } = {};
      if (input.currency !== undefined || input.exchangeRate !== undefined) {
        if (!isLiveQuoteStatus(order.status) && order.status !== "confirmed") {
          throw new InvalidStatusTransitionError(`Cannot change the currency or rate of an order in status "${order.status}"`);
        }
        const currency = input.currency ?? order.currency;
        if (currency !== order.currency) {
          if ((await repo.listRowsByOrder(orderId)).length > 0) throw new SalesOrderCurrencyLockedError(order.orderNumber);
          currencyFields.currency = currency;
          currencyFields.exchangeRate = await documentRate(currency, input.exchangeRate);
        } else if (input.exchangeRate !== undefined) {
          currencyFields.exchangeRate = await documentRate(currency, input.exchangeRate);
        }
      }
      if (input.deliveryAddressId) {
        // Another order's engångsadress is not the customer's to pick; the
        // order's own may be sent back unchanged.
        const address = await repo.findDeliveryAddress(order.customerId, input.deliveryAddressId);
        if (!address || (address.oneOff && address.id !== order.deliveryAddressId)) {
          throw new DeliveryAddressNotFoundError(input.deliveryAddressId);
        }
      }
      await validateRegisterRefs(input);
      // Kostnadsställen och projekt: a new choice must be active/open, the
      // kept one may stay as it is.
      const dimensions = await repo.resolveDimensions(
        { costCenterId: input.costCenterId, projectId: input.projectId },
        { existing: { costCenterId: order.costCenterId, projectId: order.projectId } }
      );
      const { currency: _currency, exchangeRate: _exchangeRate, confirmRepricing, ...sentHeader } = input;
      // The markups as the header stores them — two decimals, rounded the
      // same way as the plan (roundPercent), never by Postgres on its own.
      const roundSent = (v: number | null | undefined) => (v === undefined || v === null ? v : roundPercent(v));
      const headerInput = {
        ...sentHeader,
        ...(input.generalMarkupPercent !== undefined ? { generalMarkupPercent: roundSent(input.generalMarkupPercent) } : {}),
        ...(input.materialMarkupPercent !== undefined ? { materialMarkupPercent: roundSent(input.materialMarkupPercent) } : {}),
      };
      // Påslag på offert och order (#16 etapp 3): a markup sent ⇒ the plan
      // (planMarkupRepricing) — at the rate the header will have — and, when
      // it reprices a row, the confirmation. The repository re-checks the
      // plan under its locks; a stale plan (the rows, the rate or the
      // markups changed in between) is made again, a few times.
      const markupsSent = input.generalMarkupPercent !== undefined || input.materialMarkupPercent !== undefined;
      let current = order;
      let planned: Awaited<ReturnType<typeof planMarkupRepricing>> | null = null;
      let result: Awaited<ReturnType<SalesRepository["updateSalesOrderHeaderWithAddress"]>> | undefined;
      for (let attempt = 1; attempt <= REPRICING_ATTEMPTS; attempt++) {
        let guard: HeaderMarkupsGuard | undefined;
        if (markupsSent) {
          planned = await planMarkupRepricing(current, input, currencyFields.exchangeRate ?? Number(current.exchangeRate));
          if (planned.repricing.rows.length > 0 && confirmRepricing !== true) {
            throw new MarkupRepricingNotConfirmedError(current.orderNumber, planned.repricing);
          }
          guard = {
            expected: {
              currency: current.currency,
              exchangeRate: current.exchangeRate,
              generalMarkupPercent: current.generalMarkupPercent,
              materialMarkupPercent: current.materialMarkupPercent,
            },
            reprice: planned.reprice,
          };
        }
        result = await repo.updateSalesOrderHeaderWithAddress(orderId, { ...headerInput, ...currencyFields, ...dimensions }, guard);
        if (result.ok || result.reason !== "stale") break;
        const reread = await repo.findSalesOrderById(orderId);
        if (!reread) throw new SalesOrderNotFoundError(orderId);
        current = reread;
      }
      if (!result!.ok) {
        if (result!.reason === "not_found") throw new SalesOrderNotFoundError(orderId);
        if (result!.reason === "currency_locked") throw new SalesOrderCurrencyLockedError(order.orderNumber);
        if (result!.reason === "stale") throw new MarkupRepricingConflictError(order.orderNumber);
        throw new InvalidStatusTransitionError(`Cannot change the header of an order in status "${result!.status}"`);
      }
      const saved = result!;
      // What the save actually repriced: a planned row that became invoiced
      // under the lock kept its price, and so did one the lock no longer
      // selected — deleted, delivered or given a handwritten price in
      // between; the repository says which.
      let repricing: MarkupRepricing | undefined;
      if (planned) {
        const repricedIds = new Set(saved.repriced);
        const keptUnderLock = new Map(saved.kept.map((k) => [k.rowId, k.reason]));
        repricing = {
          ...planned.repricing,
          rows: planned.repricing.rows.filter((r) => repricedIds.has(r.rowId)),
          kept: [
            ...planned.repricing.kept,
            ...planned.repricing.rows
              .filter((r) => !repricedIds.has(r.rowId))
              .map((r) => ({ rowId: r.rowId, articleNumber: r.articleNumber, reason: keptUnderLock.get(r.rowId) ?? ("manual" as const) })),
          ],
        };
        if (repricing.changed) {
          await audit.log({
            entityType: "sales_order",
            entityId: current.orderNumber,
            action: "markups_changed",
            detail: {
              before: repricing.before,
              after: repricing.after,
              rows: repricing.rows.map((r) => ({ rowId: r.rowId, articleNumber: r.articleNumber, before: r.before, after: r.after })),
              kept: repricing.kept.length,
            },
            userId: userId ?? null,
          });
        }
      }
      // Valuta: a new currency or rate is logged on the order (the rate
      // decides what every SEK price converts to from now on).
      if (
        (currencyFields.currency !== undefined && currencyFields.currency !== order.currency) ||
        (currencyFields.exchangeRate !== undefined && currencyFields.exchangeRate !== Number(order.exchangeRate))
      ) {
        await audit.log({
          entityType: "sales_order",
          entityId: order.orderNumber,
          action: "exchange_rate_changed",
          detail: {
            before: { currency: order.currency, exchangeRate: order.exchangeRate },
            after: { currency: saved.order.currency, exchangeRate: saved.order.exchangeRate },
          },
          userId: userId ?? null,
        });
      }
      const updated = await repo.findSalesOrderById(saved.order.id);
      // `repricing` only when a markup was sent: what the save did to the rows.
      return updated && repricing ? { ...updated, repricing } : updated;
    },

    // Påslag på offert och order (#16 etapp 3): POST
    // /sales-orders/:id/markups/preview — what saving these markups would do
    // to the rows (the same plan as the save), nothing written. The status
    // guard is the header's.
    // `exchangeRate`: the rate the same save gives the order, which the
    // PATCH plans with — under the header's own rules (quote or confirmed
    // only, SEK only 1); omitted = the order's current rate.
    async previewOrderMarkups(orderId: string, input: SalesOrderMarkupsPreviewInput): Promise<MarkupRepricing> {
      const order = await repo.findSalesOrderById(orderId);
      if (!order) throw new SalesOrderNotFoundError(orderId);
      if (!isSalesOrderEditableStatus(order.status)) {
        throw new InvalidStatusTransitionError(`Cannot change the header of an order in status "${order.status}"`);
      }
      const { exchangeRate: sentRate, ...markups } = input;
      if (sentRate !== undefined && !isLiveQuoteStatus(order.status) && order.status !== "confirmed") {
        throw new InvalidStatusTransitionError(`Cannot change the currency or rate of an order in status "${order.status}"`);
      }
      const rate = sentRate === undefined ? Number(order.exchangeRate) : await documentRate(order.currency, sentRate);
      return (await planMarkupRepricing(order, markups, rate)).repricing;
    },

    // Reservationen (Leveranstidskontroll → Skapa tillverkningsordrar): the
    // planning service sets Förväntat leveransdatum inside its own
    // transaction, after the TOs — the same status guard as the header
    // PATCH above, read under the order's row lock. The revision is not
    // bumped (the body has no bumpRevision — the rows and prices are
    // unchanged, the date is the planner's promise) and nothing is logged
    // here: the caller writes delivery_time_applied on the order. Returns
    // the order number for that log.
    async setExpectedDeliveryDateInTx(tx: Tx, orderId: string, date: string): Promise<{ orderNumber: string; previous: string | null }> {
      const order = await repo.lockSalesOrderForHeader(tx, orderId);
      if (!order) throw new SalesOrderNotFoundError(orderId);
      if (!isSalesOrderEditableStatus(order.status)) {
        throw new InvalidStatusTransitionError(`Cannot change the header of an order in status "${order.status}"`);
      }
      await repo.updateSalesOrderHeader(orderId, { expectedDeliveryDate: date, bumpRevision: false }, tx);
      return { orderNumber: order.orderNumber, previous: order.expectedDeliveryDate };
    },

    // Reservationen's lock order: every KO row that gets a TO is locked
    // FOR UPDATE — sorted by id, one at a time — BEFORE the first TO is
    // created, so the transaction's order is advisory → rows → order header
    // (markInProduction). A TO per row would otherwise lock row 1, then the
    // header, then row 2 — the reverse of updateRow/replaceRowConfiguration
    // (row → header) — and two orders' worth of rows could deadlock. A row
    // that no longer exists is left to the TO's own LinkedRowNotFoundError.
    async lockRowsInTx(tx: Tx, rowIds: string[]): Promise<void> {
      for (const rowId of [...new Set(rowIds)].sort()) {
        await repo.lockRowForManufacturing(tx, rowId);
      }
    },

    async createQuote(input: CreateQuoteInput, createdBy: string | null) {
      // An unknown customer is a 404 here, not the order's FK failing as a 500
      // (POST /quotes is the external API's entry point).
      const customer = await repo.findCustomerById(input.customerId);
      if (!customer) throw new CustomerNotFoundError(input.customerId);
      // The delivery address must belong to the ordering customer.
      if (input.deliveryAddressId) {
        const address = await repo.findDeliveryAddress(input.customerId, input.deliveryAddressId);
        if (!address || address.oneOff) throw new DeliveryAddressNotFoundError(input.deliveryAddressId);
      }
      // Valuta: the customer's currency unless the caller chose one, and
      // today's rate unless the caller sent one — looked up here, before the
      // transaction (it may call Riksbanken). Every row is priced in it.
      const currency = input.currency ?? customer.currency ?? SEK;
      const exchangeRate = await documentRate(currency, input.exchangeRate);
      const pricing: RowPricing = { customerId: input.customerId, currency, exchangeRate };
      // Variants resolved here (delprojekt 5) are created under the template
      // lock BEFORE the order's transaction, so they outlive a quote that
      // fails afterwards — by design (spec): a variant is an ordinary,
      // reusable article, and the next order for the same choices reuses it.
      // The same article may appear on several rows (two configurations
      // resolving to one variant included) — each stays its own row.
      const rows = await Promise.all(input.rows.map((r) => resolveRowInput(pricing, r, createdBy)));
      const quoteValidUntil = await resolveQuoteValidUntil(input);
      // Kostnadsställen och projekt on the header: must exist and be pickable.
      const dimensions = await repo.resolveDimensions({ costCenterId: input.costCenterId, projectId: input.projectId });
      // Avvikelser (Skapa ersättningsorder): the case link in the order's
      // own transaction.
      const deviationId = input.deviationId;
      const created = await repo.createQuote(
        { ...input, ...dimensions, rows, quoteValidUntil, currency, exchangeRate },
        createdBy,
        deviationId
          ? (tx, orderId) => linkDeviationInTx(tx, { deviationId, documentType: "sales_order", documentId: orderId, userId: createdBy })
          : undefined
      );
      const result = { order: created.order, rows: created.rows.map(withoutConfigurationCost) };
      if (!input.confirm) return result;
      // "Ny kundorder": run the normal quote → confirmed transition right
      // away. A freshly created order is always in status "quote", so the
      // transition guard in confirm() would trivially pass.
      const confirmed = await repo.updateStatus(result.order.id, "confirmed");
      return { ...result, order: confirmed ?? result.order };
    },

    // overDeliveryPercent: Tillåten överleverans for the order's customer
    // (#24) — Utleverans counts picked goods up to it.
    //
    // Påslag på offert och order (#16 etapp 3): customerMarkups = the
    // customer's own two price markups (numeric strings like the order's
    // generalMarkupPercent/materialMarkupPercent, null = inherits varugrupp →
    // företaget) — the header form's placeholders, so the card can say which
    // markup a row gets and from where: the order's field, else the
    // customer's, else the article's varugrupp or the company's.
    async getSalesOrder(id: string) {
      const found = await repo.findSalesOrderById(id);
      if (!found) return found;
      const { sourceQuoteNumber, ...order } = found;
      const [overDeliveryPercent, customer, ordersFromQuote] = await Promise.all([
        overDeliveryPercentFor(order.customerId),
        repo.findCustomerById(order.customerId),
        // Only a quote can have given orders (source_quote_id points at one).
        order.documentKind === "quote" ? repo.listOrdersFromQuote(order.id) : [],
      ]);
      return {
        ...order,
        // Skapa kundorder från offert: the quote this order was created from
        // (the card's Offertnummer) and, on the quote, the orders made from
        // it, oldest first.
        sourceQuote: order.sourceQuoteId && sourceQuoteNumber ? { id: order.sourceQuoteId, quoteNumber: sourceQuoteNumber } : null,
        ordersFromQuote,
        overDeliveryPercent,
        customerMarkups: {
          generalMarkupPercent: customer?.generalMarkupPercent ?? null,
          materialMarkupPercent: customer?.materialMarkupPercent ?? null,
        },
      };
    },

    async listSalesOrders(query: ListSalesOrdersQuery, today: string = stockholmToday()) {
      return repo.listSalesOrders(query, today);
    },

    // E3: enriches each row with its derived "I tillverkning" coverage —
    // quantityInProduction (the non-cancelled sum) and manufacturingOrders
    // (only the non-cancelled orders themselves, the same exclusion T3's
    // coverageForSalesOrderRows already applies — a cancelled TO frees the
    // quantity back up, so it has no business showing up as "in production"
    // here either). No manufacturingCoverage dependency ⇒ every row gets the
    // fallback (0 / []) rather than a lookup.
    async listRows(salesOrderId: string) {
      const rows = await repo.listRowsByOrder(salesOrderId);
      // Configured rows carry their own cost (below), so only the ordinary
      // rows' articles are looked up.
      const costedArticleIds = [...new Set(rows.filter((r) => !r.configuration).map((r) => r.articleId))];
      const [coverage, costs] = await Promise.all([
        manufacturingCoverage && rows.length > 0
          ? manufacturingCoverage.coverageForSalesOrderRows(rows.map((r) => r.id))
          : undefined,
        // One batched lookup for the whole order, not one per row.
        selfCosts && costedArticleIds.length > 0 ? selfCosts.latestPreCalculationSelfCost(costedArticleIds) : undefined,
      ]);
      // The stored förkalkyl itself never leaves this method — only the two
      // fields derived from it below.
      return rows.map(({ configurationCost, ...row }) => {
        const entry = coverage?.get(row.id);
        // Konfigurator 4c: a configured row is measured against ITS förkalkyl
        // (configuration_cost) — the template's own calculation describes no
        // real configuration. null = unknown, never zero.
        const own = row.configuration ? ((configurationCost as OrderRowConfigurationCost | null) ?? null) : undefined;
        const articleCost = costs?.get(row.articleId);
        return {
          ...row,
          // Påslag (#16, 0197): the Kalkylpris tag, from the price origin.
          calculatedPrice: row.priceOrigin === "calculated",
          quantityInProduction: entry?.quantity ?? 0,
          manufacturingOrders: entry?.orders ?? [],
          // null = no saved pre-calculation for the article (or no derivable
          // förkalkyl for the configuration). The web decides what to show;
          // it must never read this as zero.
          selfCostPerUnit: own !== undefined ? (own?.selfCostPerUnit ?? null) : (articleCost?.selfCostPerUnit ?? null),
          selfCostCalculatedAt: own !== undefined ? (own?.calculatedAt ?? null) : (articleCost?.calculatedAt ?? null),
        };
      });
    },

    // Rows are editable until the order is delivered/invoiced/cancelled.
    async addRow(salesOrderId: string, input: CreateSalesOrderRowInput, userId?: string | null) {
      const order = await repo.findSalesOrderById(salesOrderId);
      if (!order) throw new SalesOrderNotFoundError(salesOrderId);
      if (!isSalesOrderEditableStatus(order.status)) {
        throw new InvalidStatusTransitionError(`Cannot add rows to an order in status "${order.status}"`);
      }
      const pricing = orderPricing(order);
      const { chainPriced, ...write } = await resolveRowInput(pricing, input, userId ?? null);
      // Valuta: the repository re-reads the currency under the order's key
      // lock and refuses a row priced in a currency the order no longer has.
      // An article already on the order simply gets a second row. Påslag
      // (#16 etapp 3): likewise the order's markups, but only when the price
      // chain priced the row — a beställningsvara's template chain never
      // reads them, so a markup change cannot make its price stale.
      let row;
      try {
        row = await repo.addRow(salesOrderId, write, pricing.currency, chainPriced ? (pricing.orderMarkups ?? null) : undefined);
      } catch (err) {
        if (err instanceof SalesOrderRowsLockedError) throw new InvalidStatusTransitionError(err.message);
        throw err;
      }
      await logRowAdded(order.orderNumber, row, userId);
      return withoutConfigurationCost(row);
    },

    async updateRow(salesOrderId: string, rowId: string, input: UpdateSalesOrderRowInput, userId?: string | null) {
      const order = await repo.findSalesOrderById(salesOrderId);
      if (!order) throw new SalesOrderNotFoundError(salesOrderId);
      if (!isSalesOrderEditableStatus(order.status)) {
        throw new InvalidStatusTransitionError(`Cannot change rows on an order in status "${order.status}"`);
      }

      const existing = await repo.findRowById(rowId);
      if (!existing || existing.salesOrderId !== salesOrderId) throw new SalesOrderRowNotFoundError(rowId);
      // The incoming quantity/price are in the newly chosen unit when the
      // PATCH sets one, otherwise in the row's current unit.
      let unitPatch: { unitId?: string | null; unitFactor?: number | null } = {};
      let factor = existing.unitFactor !== null ? Number(existing.unitFactor) : null;
      if (input.unitId !== undefined) {
        const selection = await articleFiles.resolveUnitSelection(existing.articleId, input.unitId);
        unitPatch = selection;
        factor = selection.unitFactor;
      }

      const quantity =
        input.quantity !== undefined
          ? await roundForArticle(existing.articleId, toBaseQuantity(input.quantity, factor))
          : undefined;
      // C3: re-resolve the price chain ONLY when the quantity changes and no
      // unitPrice was sent (a staffelbyte — new base quantity may cross a
      // price break); otherwise the row's existing price/discount survive
      // untouched (a unit-only or note-only PATCH doesn't reprice).
      let unitPrice = input.unitPrice !== undefined ? toBasePrice(input.unitPrice, factor) : undefined;
      let discountPercent = input.discountPercent;
      // Påslag (#16, 0197): the price origin. Set here only when this method
      // prices the row itself — the chain at a new quantity (its step, or
      // manual with a rabatt sent along) or a configured row's template
      // (manual). Otherwise the repository decides under the row lock: a sent
      // à-pris or rabatt that differs from the stored one ⇒ manual, the same
      // values (the card always resends them) keep the origin.
      let priceOrigin: SalesRowPriceOrigin | undefined;
      let chainPriced = false;
      let configurationPatch: OrderRowConfiguration | undefined;
      // 4c: undefined = leave configuration_cost as stored.
      let configurationCostPatch: OrderRowConfigurationCost | null | undefined;
      const stored = existing.configuration as OrderRowConfiguration | null;
      // A PATCH that carries the row's current quantity is no quantity
      // change — the order card's row save always sends quantity + price.
      // Compared at the column's 4 decimals (numeric(14,4) string vs float).
      const quantityChanged =
        quantity !== undefined && Math.round(quantity * 10000) !== Math.round(Number(existing.quantityOrdered) * 10000);
      // 4c: a configured row's quantity CHANGE always re-evaluates — the
      // förkalkyl follows the quantity even when a hand-written price is
      // sent along and kept. So a stored selection the template no longer
      // accepts is a 400 on every quantity change, with or without a manual
      // price (4b's Avvikelse 4, now for quantity changes in general):
      // Ändra konfiguration is the way forward, never a stale cost or price.
      // An unchanged quantity evaluates nothing: price/discount edits on such
      // a row keep working and the stored cost stays as it is. One
      // evaluation serves both the cost and the reprice below.
      let evaluated: RowConfigurationEvaluation | undefined;
      if (stored && quantityChanged) {
        evaluated = await rowConfiguration.evaluate(stored.templateArticleId, selectionFromEntries(stored.selection), {
          customerId: order.customerId,
          quantity,
          ...chainCurrency(orderPricing(order)),
        });
        if (!evaluated.valid || !evaluated.configuration) throw new ConfiguratorInvalidConfigurationError(evaluated.errors);
        // The stored choices resolve to another configuration than the row
        // shows (a förval added to the template since): its price and cost
        // would include choices the row doesn't list.
        if (evaluated.configuration.key !== stored.key) {
          throw new RowConfigurationOutdatedError(
            (await articleFiles.getArticle(existing.articleId))?.articleNumber ?? existing.articleId
          );
        }
        configurationCostPatch = evaluated.cost;
      }
      // Only a quantity CHANGE re-prices (the review of etapp 2): the same
      // quantity with the à-pris omitted keeps the row's price, so a newer
      // calculation or price list never moves it behind the seller's back.
      if (input.unitPrice === undefined && quantityChanged) {
        if (stored) {
          // 4b: a configured row is repriced through the template's chain at
          // the new quantity; the choices stay. Same quantity ⇒ the row's
          // price stands (never the template's own chain, below).
          if (evaluated?.configuration) {
            if (evaluated.configuration.price.unitPrice === null) {
              throw new PriceNotFoundError((await articleFiles.getArticle(existing.articleId))?.articleNumber ?? existing.articleId);
            }
            unitPrice = evaluated.configuration.price.unitPrice;
            if (discountPercent === undefined) discountPercent = evaluated.configuration.price.discountPercent;
            configurationPatch = { ...stored, price: evaluated.configuration.price };
            priceOrigin = "manual";
          }
        } else {
          // An empty chain means there is no staffel the new quantity could
          // have crossed, so the row keeps the price it already has (it was
          // priced by hand). Only addRow/createQuote refuse an unpriced row.
          const resolution = await resolvePrice({
            customerId: order.customerId,
            articleId: existing.articleId,
            quantity: quantity!,
            ...chainQuery(orderPricing(order)),
          });
          if (resolution?.price) {
            unitPrice = resolution.price.unitPrice;
            if (discountPercent === undefined) discountPercent = resolution.price.discountPercent;
            chainPriced = true;
            // A discount sent along is the seller's — the row is then partly
            // handwritten and never repriced (the review of etapp 2).
            priceOrigin = input.discountPercent === undefined ? chainOrigin(resolution.price.source) : "manual";
          }
        }
      }

      const result = await repo.updateRow(
        salesOrderId,
        rowId,
        {
          ...unitPatch,
          quantity,
          unitPrice,
          discountPercent,
          configuration: configurationPatch,
          configurationCost: configurationCostPatch,
          expectedDeliveryDate: input.expectedDeliveryDate,
          priceOrigin,
          // Påslag (#16 etapp 3): a chain price was computed with the order's
          // markups as read above — re-checked under the row lock.
          ...(chainPriced ? { pricedWithMarkups: orderPricing(order).orderMarkups ?? null } : {}),
        },
        input.bumpRevision !== false
      );
      if (result.ok) {
        const article = await articleFiles.getArticle(existing.articleId);
        // The row's own date only when it changed (the card always sends it).
        const dateChanged = existing.expectedDeliveryDate !== result.row!.expectedDeliveryDate;
        const date = (r: typeof existing) => (dateChanged ? { expectedDeliveryDate: r.expectedDeliveryDate } : {});
        await audit.log({
          entityType: "sales_order_row",
          entityId: order.orderNumber,
          action: "row_updated",
          detail: {
            articleNumber: article?.articleNumber ?? null,
            before: {
              quantity: existing.quantityOrdered,
              unitPrice: existing.unitPrice,
              discountPercent: existing.discountPercent,
              ...date(existing),
            },
            after: {
              quantity: result.row!.quantityOrdered,
              unitPrice: result.row!.unitPrice,
              discountPercent: result.row!.discountPercent,
              ...date(result.row!),
            },
          },
          userId: userId ?? null,
        });
        return { row: withoutConfigurationCost(result.row!), orderStatus: result.orderStatus };
      }
      switch (result.reason) {
        case "row_not_found":
          throw new SalesOrderRowNotFoundError(rowId);
        case "quantity_below_delivered":
          throw new OverDeliveryError();
        case "row_has_deliveries":
          throw new RowHasDeliveriesError();
        // deleteRow only — never raised by updateRow.
        case "row_has_invoice_rows":
          throw new RowHasInvoiceRowsError();
        case "markups_changed":
          throw new SalesOrderMarkupsChangedError(order.orderNumber);
      }
    },

    // Ändra konfiguration (4b) — both modes. A beställningsvara row is
    // re-evaluated with the order's customer and the row's quantity; a variant
    // row resolves the new variant (fetch-or-create, 4a) and is repriced
    // through the chain. Either way the row's price is REPLACED — a
    // hand-written price does not survive (the dialog says so). The reads here
    // happen before the repository's locked transaction, which re-checks every
    // guard itself; a row that is neither configured nor a variant is a 400.
    async setRowConfiguration(salesOrderId: string, rowId: string, input: SetRowConfigurationInput, userId?: string | null) {
      const order = await repo.findSalesOrderById(salesOrderId);
      if (!order) throw new SalesOrderNotFoundError(salesOrderId);
      const existing = await repo.findRowById(rowId);
      if (!existing || existing.salesOrderId !== salesOrderId) throw new SalesOrderRowNotFoundError(rowId);
      const stored = existing.configuration as OrderRowConfiguration | null;
      const quantity = Number(existing.quantityOrdered);
      const before = await articleFiles.getArticle(existing.articleId);
      const beforeNumber = before?.articleNumber ?? existing.articleId;

      let next: {
        articleId: string;
        articleNumber: string;
        configuration: OrderRowConfiguration | null;
        configurationCost: OrderRowConfigurationCost | null;
        unitPrice: number;
        discountPercent: number;
        // Påslag (#16, 0197): the replaced price's origin.
        priceOrigin: SalesRowPriceOrigin;
        pricedWithMarkups?: PriceMarkups | null;
      };
      let beforeKey: string | null;
      let afterKey: string | null;
      if (stored) {
        const evaluated = await rowConfiguration.evaluate(stored.templateArticleId, input.selection, {
          customerId: order.customerId,
          quantity,
          ...chainCurrency(orderPricing(order)),
        });
        if (!evaluated.valid || !evaluated.configuration) throw new ConfiguratorInvalidConfigurationError(evaluated.errors);
        if (evaluated.configuration.price.unitPrice === null) throw new PriceNotFoundError(beforeNumber);
        next = {
          articleId: existing.articleId,
          articleNumber: beforeNumber,
          configuration: evaluated.configuration,
          // 4c: the new choices' förkalkyl at the row's quantity.
          configurationCost: evaluated.cost,
          unitPrice: evaluated.configuration.price.unitPrice,
          discountPercent: evaluated.configuration.price.discountPercent,
          // A beställningsvara is priced by its template (base + additions) —
          // never by the order's markups, so it is manual.
          priceOrigin: "manual",
        };
        beforeKey = stored.key;
        afterKey = evaluated.configuration.key;
      } else {
        const variantOf = await rowConfiguration.variantOf(existing.articleId);
        if (!variantOf) throw new ConfigurationNotAllowedError(beforeNumber);
        // resolveVariant may CREATE a stocked variant article, and that
        // write is not part of replaceRowConfiguration's transaction — so a
        // row the locked guards would refuse anyway (invoice row, delivery,
        // live TO, order status) is refused here first, before any variant
        // exists. Advisory: the locked re-check below remains the authority.
        const preRead = await repo.readRowConfigurationLock(salesOrderId, rowId);
        if (!preRead.ok) throwRowConfigurationFailure(preRead, rowId);
        const { article: variant } = await rowConfiguration.resolveVariant(variantOf.templateArticleId, input.selection, userId ?? null);
        const resolution = await resolvePrice({
          customerId: order.customerId,
          articleId: variant.id,
          quantity,
          ...chainQuery(orderPricing(order)),
        });
        if (!resolution?.price) throw new PriceNotFoundError(resolution?.articleNumber ?? variant.id);
        next = {
          articleId: variant.id,
          articleNumber: variant.articleNumber,
          configuration: null,
          // A variant row is an ordinary row — its cost is the variant's own
          // calculation, never a stored förkalkyl.
          configurationCost: null,
          unitPrice: resolution.price.unitPrice,
          discountPercent: resolution.price.discountPercent,
          // The variant's chain (the template's, or the variant's own when the
          // template's could not price it — which may end in the Kalkylpris,
          // like any article's).
          priceOrigin: chainOrigin(resolution.price.source),
          // Priced with the order's markups as read above (#16 etapp 3).
          pricedWithMarkups: orderPricing(order).orderMarkups ?? null,
        };
        beforeKey = variantOf.configKey;
        afterKey = variant.id === existing.articleId ? variantOf.configKey : ((await rowConfiguration.variantOf(variant.id))?.configKey ?? null);
      }

      const result = await repo.replaceRowConfiguration(salesOrderId, rowId, next, input.bumpRevision !== false);
      if (!result.ok) throwRowConfigurationFailure(result, rowId, order.orderNumber);
      await audit.log({
        entityType: "sales_order_row",
        entityId: order.orderNumber,
        action: "row_configuration_changed",
        detail: {
          articleNumber: next.articleNumber,
          before: {
            articleNumber: before?.articleNumber ?? null,
            key: beforeKey,
            unitPrice: existing.unitPrice,
            discountPercent: existing.discountPercent,
          },
          after: {
            articleNumber: next.articleNumber,
            key: afterKey,
            unitPrice: result.row.unitPrice,
            discountPercent: result.row.discountPercent,
          },
        },
        userId: userId ?? null,
      });
      return { row: withoutConfigurationCost(result.row), orderStatus: result.orderStatus };
    },

    // Frakt på offert: the order's freight row (the configured freight
    // article) gets this price — added with quantity 1, or repriced when the
    // order already has one. The same article may sit on several rows, so
    // the single freight row is found-or-added under the order's row lock
    // (repo.findOrAddArticleRow — ordinary rows only, never a
    // ställkostnadsrad); two concurrent "Lägg till frakt" thus give one row,
    // which the loser reprices. Status guard, revision and audit are those
    // of addRow/updateRow. Valuta: input.unitPrice is the kundpris in SEK
    // (Sendify's price plus the markup); an order in another currency gets
    // it converted with the order's rate (fromSek).
    async setFreightRow(salesOrderId: string, input: { articleId: string; unitPrice: number }, userId?: string | null) {
      const order = await repo.findSalesOrderById(salesOrderId);
      if (!order) throw new SalesOrderNotFoundError(salesOrderId);
      if (!isSalesOrderEditableStatus(order.status)) {
        throw new InvalidStatusTransitionError(`Cannot add rows to an order in status "${order.status}"`);
      }
      const unitPrice = order.currency === SEK ? input.unitPrice : fromSek(input.unitPrice, Number(order.exchangeRate));
      // Frakt etapp 2: the freight of this order's följesedel is already on
      // an invoice as a shipment row — neither a new order freight row nor a
      // repriced one may bill the same transport again.
      const invoiced = await repo.invoicedShipmentForOrder(salesOrderId);
      if (invoiced) throw new FreightAlreadyInvoicedError(invoiced.shipmentNumber);
      const pricing = orderPricing(order);
      const write = await resolveRowInput(pricing, { articleId: input.articleId, quantity: 1, unitPrice, discountPercent: 0 }, userId ?? null);
      const { row: existing, created } = await repo.findOrAddArticleRow(salesOrderId, write, pricing.currency);
      if (created) {
        await logRowAdded(order.orderNumber, existing, userId);
        return withoutConfigurationCost(existing);
      }
      if (Number(existing.quantityDelivered) > 0) throw new FreightRowDeliveredError();
      const { row } = await this.updateRow(salesOrderId, existing.id, { unitPrice, discountPercent: 0 }, userId);
      return row;
    },

    async deleteRow(salesOrderId: string, rowId: string, bumpRevision = true, userId?: string | null) {
      const order = await repo.findSalesOrderById(salesOrderId);
      if (!order) throw new SalesOrderNotFoundError(salesOrderId);
      if (!isSalesOrderEditableStatus(order.status)) {
        throw new InvalidStatusTransitionError(`Cannot change rows on an order in status "${order.status}"`);
      }
      const existing = await repo.findRowById(rowId);
      const result = await repo.deleteRow(salesOrderId, rowId, bumpRevision);
      if (result.ok) {
        const article = existing ? await articleFiles.getArticle(existing.articleId) : null;
        await audit.log({
          entityType: "sales_order_row",
          entityId: order.orderNumber,
          action: "row_deleted",
          detail: existing
            ? {
                articleNumber: article?.articleNumber ?? null,
                quantity: existing.quantityOrdered,
                unitPrice: existing.unitPrice,
                discountPercent: existing.discountPercent,
              }
            : null,
          userId: userId ?? null,
        });
        return { orderStatus: result.orderStatus };
      }
      switch (result.reason) {
        case "row_not_found":
          throw new SalesOrderRowNotFoundError(rowId);
        case "quantity_below_delivered":
          throw new OverDeliveryError();
        case "row_has_deliveries":
          throw new RowHasDeliveriesError();
        case "row_has_invoice_rows":
          throw new RowHasInvoiceRowsError();
      }
    },

    async confirm(orderId: string, userId?: string | null) {
      const order = await repo.findSalesOrderById(orderId);
      if (!order) throw new SalesOrderNotFoundError(orderId);
      if (order.status === "ordered") throw new QuoteAlreadyOrderedError(order.orderNumber);
      if (order.status !== "quote") {
        throw new InvalidStatusTransitionError(`Cannot confirm an order in status "${order.status}"`);
      }
      const updated = await repo.updateStatus(orderId, "confirmed", null, "quote");
      if (!updated) throw new InvalidStatusTransitionError("Cannot confirm — the quote changed status meanwhile");
      // Logged under the number the quote had; an OF- numbered quote's new
      // KO- number goes in the detail (the card reads both numbers).
      await audit.log({
        entityType: "sales_order",
        entityId: order.orderNumber,
        action: "confirmed",
        detail: updated.orderNumber !== order.orderNumber ? { orderNumber: updated.orderNumber } : undefined,
        userId: userId ?? null,
      });
      return updated;
    },

    // showConfigurationPrices omitted ⇒ the customer's Visa tilläggspriser.
    async getSalesOrderPdf(orderId: string, variant: "quote" | "confirmation", showConfigurationPrices?: boolean) {
      const order = await repo.findSalesOrderById(orderId);
      if (!order) throw new SalesOrderNotFoundError(orderId);
      // A lost quote is closed like a cancelled order: no documents (spec).
      if (order.status === "lost") {
        throw new InvalidStatusTransitionError(`Cannot print an order in status "${order.status}"`);
      }
      const customer = await repo.findCustomerById(order.customerId);
      return renderSalesOrderPdf(order, variant, showConfigurationPrices ?? customer!.showConfigurationPrices);
    },

    // Plocklista — remaining quantities per row plus where the stock is.
    async getPickListPdf(orderId: string) {
      const order = await repo.findSalesOrderById(orderId);
      if (!order) throw new SalesOrderNotFoundError(orderId);
      if (order.status === "cancelled" || order.status === "lost") {
        throw new InvalidStatusTransitionError(`Cannot print a pick list for an order in status "${order.status}"`);
      }
      const rows = await repo.listRowsByOrder(orderId);
      const openRows = rows.filter((r) => Number(r.quantityDelivered) < Number(r.quantityOrdered));
      const balances = await stock.balancesForArticles(openRows.map((r) => r.articleId));
      // Batch (#8): a batchstyrd article prints its cells (place · batch) in
      // the order Automatiskt draws them, Okänd included — internal document.
      const batchCells = await stock.pickBatchCellsForArticles(openRows.map((r) => r.articleId));
      const batchTrackedIds = new Set(openRows.filter((r) => r.articleBatchTracked).map((r) => r.articleId));
      const extraDescription = extraDescriptionFor(await settings.getSettings(), "pickList");
      const customerArticleNumbers = await repo.customerArticleNumberMap(order.customerId, openRows.map((r) => r.articleId));

      const content = await pdf.renderPickList({
        documentNumber: order.orderNumber,
        printedAt: new Date(),
        customerName: order.customerName,
        expectedDeliveryDate: order.expectedDeliveryDate,
        note: order.note,
        customerOrderNumber: order.customerOrderNumber,
        customerReference: order.customerReference,
        deliveryAddress: order.deliveryAddress
          ? {
              label: order.deliveryAddressLabel ?? "",
              address: order.deliveryAddress,
              postalCode: order.deliveryPostalCode,
              city: order.deliveryCity,
              country: order.deliveryCountry,
            }
          : null,
        // The pick quantity prints in the row's unit; the per-location
        // balances below stay in the base unit (stock is always base).
        rows: openRows.map((r) => ({
          articleNumber: r.articleNumber,
          articleName: r.articleName,
          quantityToPick: toUnitQuantity(Number(r.quantityOrdered) - Number(r.quantityDelivered), r.unitFactor),
          unit: r.unitCode,
          // Shop-floor document: the choices, never their prices.
          configurationLines: rowConfigurationLines(r.configuration, false),
          extraDescription: extraDescription(r.articleExtraDescription),
          customerArticleNumber: customerArticleNumbers.get(r.articleId) ?? null,
          deliveryDate: ownDeliveryDate(r.expectedDeliveryDate, order.expectedDeliveryDate),
          // Spärrade lagerplatser are left out — Automatiskt never draws
          // there, so the paper says the same as the booking.
          locations: batchTrackedIds.has(r.articleId)
            ? batchCells
                .filter((c) => c.articleId === r.articleId && !c.blocked)
                .map(
                  (c) =>
                    `${c.warehouseName} — ${c.locationName} · Batch ${c.batchNumber ?? UNKNOWN_BATCH_LABEL}: ${formatQuantity(c.quantity)}`
                )
            : balances
                .filter((b) => b.articleId === r.articleId && !b.blocked)
                .map((b) =>
                  b.locationName
                    ? `${b.warehouseName} — ${b.locationName}: ${formatQuantity(b.quantityOnHand)}`
                    : `Utan lagerplats: ${formatQuantity(b.quantityOnHand)}`
                ),
        })),
      });
      return { filename: `Plocklista-${order.orderNumber}.pdf`, content };
    },

    // Emails the quote or order confirmation as a PDF attachment. Sending
    // the confirmation is what confirms the quote (quote → confirmed) — but
    // only when SMTP succeeded (sendMail throws otherwise). Sending the
    // quote never changes status, and later statuses are plain resends.
    async sendSalesOrderEmail(orderId: string, input: SendSalesOrderEmailInput) {
      const order = await repo.findSalesOrderById(orderId);
      if (!order) throw new SalesOrderNotFoundError(orderId);
      if (order.status === "cancelled" || order.status === "lost") {
        throw new InvalidStatusTransitionError(`Cannot email an order in status "${order.status}"`);
      }
      // The order confirmation of a quote is what confirms it — a quote that
      // has given an order (Order) is never confirmed itself; the
      // confirmation is sent from the order. Nothing is sent.
      if (input.variant === "confirmation" && order.status === "ordered") {
        throw new QuoteAlreadyOrderedError(order.orderNumber);
      }
      // Visa tilläggspriser: the dialog's choice, else the customer's setting
      // — logged on the email so Skicka om renders the same attachment even
      // after the customer's setting changes.
      const customer = await repo.findCustomerById(order.customerId);
      const showPrices = input.showConfigurationPrices ?? customer!.showConfigurationPrices;
      // Offerter (0138): the confirmation that confirms an OF- numbered quote
      // is the order's first document — it carries the KO- number the
      // confirmation will keep, reserved before the send (the status still
      // changes only after SMTP succeeded). A failed send keeps the
      // reservation for the next try; Förlorad/Makulera give the quote its
      // OF- number back.
      const reserved =
        input.variant === "confirmation" && order.status === "quote" ? await repo.reserveOrderNumber(orderId) : null;
      const attachment = await renderSalesOrderPdf(
        reserved ? { ...order, orderNumber: reserved } : order,
        input.variant,
        showPrices
      );
      const drawings = input.attachDrawings
        ? await drawingAttachments((await repo.listRowsByOrder(orderId)).map((r) => r.articleId))
        : [];
      await mail.sendMail({
        documentType: input.variant === "quote" ? "quote" : "order_confirmation",
        documentId: orderId,
        to: input.to,
        subject: input.subject,
        message: input.message,
        attachments: [attachment, ...drawings],
        attachDrawings: input.attachDrawings,
        showConfigurationPrices: showPrices,
      });
      if (input.variant === "confirmation" && order.status === "quote") {
        // The mail is already sent; a quote that moved on meanwhile (e.g.
        // Förlorad) keeps its new status rather than being overwritten.
        const confirmed = await repo.updateStatus(orderId, "confirmed", null, "quote");
        return confirmed ?? repo.findSalesOrderById(orderId);
      }
      return order;
    },

    // Skapa kundorder från offert: the quote stays and a new order is made
    // as a copy of it (repo.createOrderFromQuote — one transaction, the
    // quote locked first). From quote or ordered only: a lost or cancelled
    // quote is reopened first, and an order is not a quote. The quote may
    // have passed its Giltig t.o.m. — that is the user's call.
    async createOrderFromQuote(quoteId: string, userId?: string | null) {
      const result = await repo.createOrderFromQuote(quoteId, userId ?? null);
      if (!result.ok) {
        if (result.reason === "not_found") throw new SalesOrderNotFoundError(quoteId);
        throw new InvalidStatusTransitionError(`Cannot create an order from a quote or order in status "${result.status}"`);
      }
      const { order, quote } = result;
      await audit.log({
        entityType: "sales_order",
        entityId: quote.number,
        action: "order_created",
        detail: { orderNumber: order.orderNumber, orderId: order.id },
        userId: userId ?? null,
      });
      await audit.log({
        entityType: "sales_order",
        entityId: order.orderNumber,
        action: "created_from_quote",
        detail: { quoteNumber: quote.number, quoteId: quote.id },
        userId: userId ?? null,
      });
      return { id: order.id, orderNumber: order.orderNumber };
    },

    // Manual placeholder until Fas 3's ManufacturingOrder can drive this transition.
    async startProduction(orderId: string, userId?: string | null) {
      const order = await repo.findSalesOrderById(orderId);
      if (!order) throw new SalesOrderNotFoundError(orderId);
      if (order.status !== "confirmed") {
        throw new InvalidStatusTransitionError(`Cannot start production for an order in status "${order.status}"`);
      }
      // Conditional on Bekräftad: a Makulera committing meanwhile is not
      // overwritten with Under tillverkning.
      const updated = await repo.updateStatus(orderId, "in_production", null, "confirmed");
      if (!updated) throw new InvalidStatusTransitionError("Cannot start production: the order is no longer confirmed");
      await audit.log({
        entityType: "sales_order",
        entityId: order.orderNumber,
        action: "production_started",
        userId: userId ?? null,
      });
      return updated;
    },

    async cancel(orderId: string, userId?: string | null) {
      const order = await repo.findSalesOrderById(orderId);
      if (!order) throw new SalesOrderNotFoundError(orderId);
      if (order.status === "ordered") throw new QuoteAlreadyOrderedError(order.orderNumber);
      if (order.status !== "quote" && order.status !== "confirmed") {
        throw new InvalidStatusTransitionError(
          `Cannot cancel an order in status "${order.status}" — production has already started`
        );
      }
      // Conditional on the status just checked: a TO created against the
      // order in between has moved it to in_production (under the same
      // header lock), a quote may have been confirmed or lost — either way
      // the cancellation no longer applies.
      const updated = await repo.updateStatus(orderId, "cancelled", null, order.status);
      if (!updated) throw new InvalidStatusTransitionError(`Cannot cancel an order whose status changed meanwhile`);
      await audit.log({
        entityType: "sales_order",
        entityId: order.orderNumber,
        action: "cancelled",
        userId: userId ?? null,
      });
      return updated;
    },

    // service.invoice / repo.invoiceOrder were removed in C1 — invoices are
    // now created in the invoice module (invoice.service.ts). This service
    // keeps getInvoicePdf/sendInvoiceEmail/renderInvoicePdf below for the
    // read-only history of orders that were stamped invoiced pre-cutover.

    // Manual status override (Monitor-style): any status, any direction —
    // deliberately no transition guard. Never books stock, never touches
    // invoiceNumber/invoicedAt (a manually set "invoiced" has no invoice),
    // and does not bump the revision (the order's content is unchanged).
    // Uppföljning av offerter: "lost" is allowed here without a reason (the
    // card shows "Ingen orsak angiven"); leaving "lost" clears the lost_*
    // columns exactly as Öppna igen does.
    async setStatus(orderId: string, status: SalesOrderStatus, userId?: string | null) {
      const order = await repo.findSalesOrderById(orderId);
      if (!order) throw new SalesOrderNotFoundError(orderId);
      // Order (ordered) is neither left nor entered by hand: only Skapa
      // kundorder sets it, and it is final. The repository refuses both
      // again under the row lock (null) — a Skapa kundorder committing
      // between the read above and the write is not overwritten.
      if (order.status === "ordered") throw new QuoteAlreadyOrderedError(order.orderNumber);
      if (status === "ordered") {
        throw new InvalidStatusTransitionError(`Status "ordered" is only set by creating an order from the quote`);
      }
      const updated = await repo.updateStatus(orderId, status, userId ?? null);
      if (!updated) throw new QuoteAlreadyOrderedError(order.orderNumber);
      await audit.log({
        entityType: "sales_order",
        entityId: order.orderNumber,
        action: "status_set",
        detail: { before: order.status, after: status },
        userId: userId ?? null,
      });
      return repo.findSalesOrderById(orderId);
    },

    // Förlorad: only from quote; the reason must be an active förlustorsak.
    // The conditional UPDATE is the guard against a concurrent confirm —
    // a null there means the order left status quote under our feet.
    async lose(orderId: string, input: LoseQuoteInput, userId?: string | null) {
      const order = await repo.findSalesOrderById(orderId);
      if (!order) throw new SalesOrderNotFoundError(orderId);
      if (order.status === "ordered") throw new QuoteAlreadyOrderedError(order.orderNumber);
      if (order.status !== "quote") {
        throw new InvalidStatusTransitionError(`Cannot mark an order in status "${order.status}" as lost`);
      }
      const reason = await registers.quoteLossReasons.findById(input.lossReasonId);
      if (!reason || !reason.active) throw new QuoteLossReasonInvalidError(input.lossReasonId);
      const note = input.lossNote?.trim() ? input.lossNote.trim() : null;
      const updated = await repo.markLost(orderId, { reasonId: reason.id, note, userId: userId ?? null });
      if (!updated) throw new InvalidStatusTransitionError(`Cannot mark an order that is no longer a quote as lost`);
      await audit.log({
        entityType: "sales_order",
        entityId: order.orderNumber,
        action: "lost",
        detail: { reasonCode: reason.code, reasonName: reason.name, note },
        userId: userId ?? null,
      });
      return repo.findSalesOrderById(orderId);
    },

    // Öppna igen: lost → quote, the old reason kept in the log. The validity
    // date is not touched — the user sees it on the card and may change it.
    async reopen(orderId: string, userId?: string | null) {
      const order = await repo.findSalesOrderById(orderId);
      if (!order) throw new SalesOrderNotFoundError(orderId);
      if (order.status === "ordered") throw new QuoteAlreadyOrderedError(order.orderNumber);
      if (order.status !== "lost") {
        throw new InvalidStatusTransitionError(`Cannot reopen an order in status "${order.status}"`);
      }
      const updated = await repo.reopenLost(orderId);
      if (!updated) throw new InvalidStatusTransitionError(`Cannot reopen an order that is no longer lost`);
      await audit.log({
        entityType: "sales_order",
        entityId: order.orderNumber,
        action: "reopened",
        detail: {
          previousReasonCode: order.lostReasonCode,
          previousReasonName: order.lostReasonName,
          previousNote: order.lostNote,
        },
        userId: userId ?? null,
      });
      return repo.findSalesOrderById(orderId);
    },

    // The invoice document exists once the order is invoiced (FA number
    // assigned) — reprints render the same number.
    async getInvoicePdf(orderId: string) {
      const order = await repo.findSalesOrderById(orderId);
      if (!order) throw new SalesOrderNotFoundError(orderId);
      if (order.status !== "invoiced" || !order.invoiceNumber) {
        throw new InvalidStatusTransitionError(`Cannot print an invoice for an order in status "${order.status}"`);
      }
      return renderInvoicePdf(order);
    },

    async sendInvoiceEmail(orderId: string, input: SendDocumentEmailInput) {
      const order = await repo.findSalesOrderById(orderId);
      if (!order) throw new SalesOrderNotFoundError(orderId);
      if (order.status !== "invoiced" || !order.invoiceNumber) {
        throw new InvalidStatusTransitionError(`Cannot email an invoice for an order in status "${order.status}"`);
      }
      const attachment = await renderInvoicePdf(order);
      const drawings = input.attachDrawings
        ? await drawingAttachments((await repo.listRowsByOrder(orderId)).map((r) => r.articleId))
        : [];
      await mail.sendMail({
        documentType: "invoice",
        documentId: orderId,
        to: input.to,
        subject: input.subject,
        message: input.message,
        attachments: [attachment, ...drawings],
        attachDrawings: input.attachDrawings,
      });
      return order;
    },

    // Backward-compatible single-row delivery: runs through deliverBatch as
    // a 1-row batch so it too creates a delivery occasion (deliveryId/
    // deliveryNumber), while keeping the original row/orderStatus response
    // shape callers already depend on.
    async deliverGoods(orderId: string, rowId: string, input: DeliverGoodsInput, createdBy: string | null) {
      const overDeliveryPercent = await overDeliveryPercentForOrder(orderId);
      const result = await repo.deliverBatch(orderId, {
        locationId: input.locationId,
        rows: [{ rowId, quantity: input.quantity, batchId: input.batchId }],
        createdBy,
        overDeliveryPercent,
      });
      if (result.ok) {
        await logDelivery(orderId, result.deliveryNumber, [{ rowId, quantity: input.quantity }], createdBy);
        return {
          row: withoutConfigurationCost(result.rows[0]!),
          orderStatus: result.orderStatus,
          deliveryId: result.deliveryId,
          deliveryNumber: result.deliveryNumber,
        };
      }

      switch (result.reason) {
        case "order_not_found":
          throw new SalesOrderNotFoundError(orderId);
        case "row_not_found":
          throw new SalesOrderRowNotFoundError(rowId);
        case "invalid_status":
          throw new InvalidStatusTransitionError("Goods can only be delivered once the order is in production");
        case "over_delivery":
          throw new OverDeliveryError({ allowedPercent: overDeliveryPercent ?? 0, maxQuantity: result.maxQuantity });
      }
    },

    // Leveranstillfälle (delivery occasion) — C2: delivers several rows in
    // one go, creating a single delivery record for them.
    async deliverBatch(orderId: string, input: DeliverBatchInput, createdBy: string | null) {
      const overDeliveryPercent = await overDeliveryPercentForOrder(orderId);
      const result = await repo.deliverBatch(orderId, { ...input, createdBy, overDeliveryPercent });
      if (result.ok) {
        await logDelivery(orderId, result.deliveryNumber, input.rows, createdBy);
        return { deliveryId: result.deliveryId, deliveryNumber: result.deliveryNumber, orderStatus: result.orderStatus };
      }

      switch (result.reason) {
        case "order_not_found":
          throw new SalesOrderNotFoundError(orderId);
        case "invalid_status":
          throw new InvalidStatusTransitionError("Goods can only be delivered once the order is in production");
        case "row_not_found":
          throw new SalesOrderRowNotFoundError(result.rowId);
        case "over_delivery":
          throw new OverDeliveryError({ allowedPercent: overDeliveryPercent ?? 0, maxQuantity: result.maxQuantity });
      }
    },

    // Ångra utleverans: reverses one delivery row — the goods back to the
    // location they were taken from, the order row's delivered quantity and
    // the order status. All in one transaction; see repo.undoDeliveryRow.
    async undoDeliveryRow(orderId: string, deliveryId: string, deliveryRowId: string, userId: string) {
      const result = await repo.undoDeliveryRow(orderId, deliveryId, deliveryRowId, { undoneBy: userId });
      if (!result.ok) {
        switch (result.reason) {
          case "delivery_not_found":
            throw new DeliveryNotFoundError(deliveryId);
          case "row_not_found":
            throw new DeliveryRowNotFoundError(deliveryRowId);
          case "already_undone":
            throw new DeliveryRowAlreadyUndoneError();
          case "not_undoable":
            throw new DeliveryRowNotUndoableError();
          case "invalid_status":
            throw new InvalidStatusTransitionError(
              `Deliveries can only be undone while the order is in production or delivered (it is ${result.status})`
            );
          case "on_shipment": {
            const delivery = await repo.getDeliveryForPdf(deliveryId);
            throw new DeliveryOnShipmentError(delivery?.deliveryNumber ?? "", result.shipmentNumber);
          }
          case "invoiced":
            throw new DeliveryRowInvoicedError(result.invoiced, result.deliveredAfter);
        }
      }

      const article = await articleFiles.getArticle(result.articleId);
      await audit.log({
        entityType: "delivery",
        entityId: result.deliveryNumber,
        action: "delivery_row_undone",
        detail: {
          orderNumber: result.orderNumber,
          articleNumber: article?.articleNumber ?? null,
          quantity: Number(result.deliveryRow.quantity),
          // One entry per location the goods went back to.
          locations: result.locations,
          ...(result.statusBefore !== result.orderStatus
            ? { statusBefore: result.statusBefore, statusAfter: result.orderStatus }
            : {}),
        },
        userId,
      });
      return {
        deliveryRowId: result.deliveryRow.id,
        undoneAt: result.deliveryRow.undoneAt,
        orderStatus: result.orderStatus,
      };
    },

    // Newest first — the delivery history section on the order card, with the
    // live shipment (Frakt) of each följesedel when the shipping module is wired.
    async listDeliveries(orderId: string) {
      const rows = await repo.listDeliveries(orderId);
      const byDelivery = shipments
        ? await shipments.shipmentsForDeliveries(rows.map((r) => r.id))
        : new Map<string, DeliveryShipmentInfo>();
      return rows.map((r) => ({ ...r, shipment: byDelivery.get(r.id) ?? null }));
    },

    // Följesedel PDF — mirrors getPickListPdf's shape but for goods that
    // have already shipped. Quantities come back from the repository in the
    // base unit; printed in the row's display unit like every other sales
    // document (see resolveRowInput's comment on the base/display split).
    async deliveryNotePdf(deliveryId: string) {
      const delivery = await repo.getDeliveryForPdf(deliveryId);
      if (!delivery) throw new DeliveryNotFoundError(deliveryId);
      const extraDescription = extraDescriptionFor(await settings.getSettings(), "deliveryNote");
      const customerArticleNumbers = await repo.customerArticleNumberMap(
        delivery.customerId,
        delivery.rows.map((r) => r.articleId)
      );

      // Frakt: carrier + fraktsedelsnummer only once the shipment is booked —
      // a draft has neither, and a cancelled one is no longer live.
      const shipment = shipments ? (await shipments.shipmentsForDeliveries([deliveryId])).get(deliveryId) : undefined;
      const carrier =
        shipment && (shipment.status === "booked" || shipment.status === "delivered")
          ? { carrierName: shipment.carrierName, trackingNumber: shipment.trackingNumber }
          : null;

      // Dokument på engelska (#7): the customer's language, live.
      const language = documentLanguageOf(delivery.customerLanguage);
      const content = await pdf.renderDeliveryNote({
        language,
        documentNumber: delivery.deliveryNumber,
        orderNumber: delivery.orderNumber,
        deliveredAt: delivery.deliveredAt,
        // Ångra utleverans: the note stays printable, marked.
        undoneAt: delivery.undoneAt,
        customerName: delivery.customerName,
        customerOrderNumber: delivery.customerOrderNumber,
        customerReference: delivery.customerReference,
        carrier,
        deliveryAddress: delivery.deliveryAddress
          ? {
              label: delivery.deliveryAddressLabel ?? "",
              address: delivery.deliveryAddress,
              postalCode: delivery.deliveryPostalCode,
              city: delivery.deliveryCity,
              country: delivery.deliveryCountry,
            }
          : null,
        rows: delivery.rows.map((r) => ({
          articleNumber: r.articleNumber,
          articleName: localized(r.articleName, r.articleNameEn, language),
          quantity: toUnitQuantity(Number(r.quantity), r.unitFactor),
          unit: localized(r.unitCode, r.unitCodeEn, language),
          priorDelivered: toUnitQuantity(r.priorDelivered, r.unitFactor),
          undoneAt: r.undoneAt,
          // The delivery note carries no prices at all — choices only.
          configurationLines: rowConfigurationLines(r.configuration, false, language),
          extraDescription: extraDescription(
            r.articleExtraDescription ? localized(r.articleExtraDescription, r.articleExtraDescriptionEn, language) : null
          ),
          customerArticleNumber: customerArticleNumbers.get(r.articleId) ?? null,
          batchInfo: deliveryRowBatchInfo(r, language),
        })),
      });
      return {
        pdf: content,
        filename: documentTexts(language).filenames.deliveryNote(delivery.deliveryNumber),
        deliveryNumber: delivery.deliveryNumber,
      };
    },

    // Pallkort (Etapp F) — one card PAGE per kolli, all in the "final"
    // (customer-facing) variant: the pallet leaves the building, so the card
    // names the customer, both order numbers and the delivery address.
    // Quantities in the row's display unit, same as the delivery note above.
    // `selection` (the dialog's row= parameters) picks rows and gives each
    // kolli its own quantity — an empty list skips the row; omitted ⇒ every
    // row as one kolli with the delivered quantity. A row id outside the
    // delivery is refused (400). The kolli are never checked against the
    // delivered total (the dialog warns). Datum is the delivery's
    // delivered_at, Rapporterad av the user who delivered.
    async deliveryPalletCardPdf(deliveryId: string, selection?: DeliveryPalletCardRow[]) {
      const delivery = await repo.getDeliveryForPdf(deliveryId);
      if (!delivery) throw new DeliveryNotFoundError(deliveryId);

      // Ångra utleverans: undone rows left the delivery — a picked one is "not
      // on the följesedel", and with every row undone there is no card.
      const liveRows = delivery.rows.filter((r) => r.undoneAt === null);
      if (liveRows.length === 0) throw new DeliveryUndoneError(delivery.deliveryNumber);
      const byId = new Map(liveRows.map((r) => [r.deliveryRowId, r]));
      const picks = selection
        ? selection.map((s) => {
            const row = byId.get(s.deliveryRowId);
            if (!row) throw new DeliveryRowNotInDeliveryError(s.deliveryRowId);
            return { row, quantities: s.quantities };
          })
        : liveRows.map((row) => ({ row, quantities: [toUnitQuantity(Number(row.quantity), row.unitFactor)] }));

      // Kod på pallkort: the customer's own choice, else the system setting.
      const code = delivery.customerPalletCardCode ?? (await settings.getSettings()).palletCardCode;
      // Dokument på engelska (#7): the card travels with the goods — the
      // customer's language, live.
      const language = documentLanguageOf(delivery.customerLanguage);
      const cards: PalletCardPdfInput[] = [];
      for (const pick of picks) {
        pick.quantities.forEach((quantity, i) => {
          cards.push({
            kind: "final",
            language,
            code,
            articleNumber: pick.row.articleNumber,
            articleName: localized(pick.row.articleName, pick.row.articleNameEn, language),
            customerName: delivery.customerName,
            customerOrderNumber: delivery.customerOrderNumber,
            orderNumber: delivery.orderNumber,
            quantity,
            unit: localized(pick.row.unitCode, pick.row.unitCodeEn, language),
            parcel: { index: i + 1, count: pick.quantities.length },
            printedAt: delivery.deliveredAt,
            // The delivery card deliberately names no reporter (user's
            // decision) — only the TO cards carry Rapporterad av.
            reference: delivery.deliveryNumber,
            // Batch (#8): the kolli does not know its own batch — every
            // card of the row carries the row's named batches.
            batch: deliveryRowBatchInfo(pick.row, language),
            deliveryAddress: delivery.deliveryAddress
              ? {
                  address: delivery.deliveryAddress,
                  postalCode: delivery.deliveryPostalCode,
                  city: delivery.deliveryCity,
                  country: delivery.deliveryCountry,
                }
              : null,
          });
        });
      }
      const content = await pdf.renderPalletCard(cards);
      return { pdf: content, filename: documentTexts(language).filenames.palletCard(delivery.deliveryNumber) };
    },

    // The delivery's rows for the pallet card dialog (GET /deliveries/:id/
    // rows): id + article + delivered quantity in the row's unit.
    async deliveryRows(deliveryId: string) {
      const delivery = await repo.getDeliveryForPdf(deliveryId);
      if (!delivery) throw new DeliveryNotFoundError(deliveryId);
      return {
        deliveryNumber: delivery.deliveryNumber,
        rows: delivery.rows.map((r) => ({
          id: r.deliveryRowId,
          articleNumber: r.articleNumber,
          articleName: r.articleName,
          quantity: toUnitQuantity(Number(r.quantity), r.unitFactor),
          unit: r.unitCode,
          // Ångra utleverans dialog; the pallet card dialog shows live rows.
          undoneAt: r.undoneAt,
          undoneByName: r.undoneByName,
          undoable: r.undoable,
          // Where the goods go back, per part (base unit).
          locations: r.locations,
          baseUnit: r.baseUnitCode,
        })),
      };
    },

    // --- C3 Kundpriser: prislistor ---

    async listPriceLists(query: ListPriceListsQuery) {
      return repo.listPriceLists(query);
    },

    async getPriceList(id: string) {
      const list = await repo.findPriceListById(id);
      if (!list) throw new PriceListNotFoundError(id);
      return list;
    },

    async createPriceList(input: CreatePriceListInput, userId?: string | null) {
      let list;
      try {
        list = await repo.createPriceList(input);
      } catch (err) {
        if (isUniqueViolation(err)) throw new DuplicatePriceListError(input.code, input.name);
        throw err;
      }
      await audit.log({
        entityType: "price_list",
        entityId: list.code,
        action: "created",
        detail: { name: list.name },
        userId: userId ?? null,
      });
      return list;
    },

    async updatePriceList(id: string, input: UpdatePriceListInput, userId?: string | null) {
      const existing = await repo.findPriceListById(id);
      if (!existing) throw new PriceListNotFoundError(id);
      // Valuta: the rows' prices are in the list's currency — it changes only
      // on a list without rows (re-checked in the repository's UPDATE).
      const currencyChange = input.currency !== undefined && input.currency !== existing.currency;
      if (currencyChange && existing.rows.length > 0) throw new PriceListCurrencyLockedError(existing.code);
      let row;
      try {
        row = await repo.updatePriceList(id, input, { requireNoRows: currencyChange });
      } catch (err) {
        if (isUniqueViolation(err)) throw new DuplicatePriceListError(input.code, input.name);
        throw err;
      }
      if (row === "has_rows") throw new PriceListCurrencyLockedError(existing.code);
      if (!row) throw new PriceListNotFoundError(id);
      await audit.log({
        entityType: "price_list",
        entityId: row.code,
        action: "updated",
        detail: {
          before: { code: existing.code, name: existing.name, description: existing.description, currency: existing.currency },
          after: { code: row.code, name: row.name, description: row.description, currency: row.currency },
        },
        userId: userId ?? null,
      });
      return row;
    },

    // PriceListInUseError propagates straight through from the repository
    // (thrown there, same as StockLocationNotEmptyError from stock's
    // repository) — this layer only maps the not-found case.
    async deletePriceList(id: string, userId?: string | null) {
      const existing = await repo.findPriceListById(id);
      if (!existing) throw new PriceListNotFoundError(id);
      const deleted = await repo.deletePriceList(id);
      if (!deleted) throw new PriceListNotFoundError(id);
      await audit.log({
        entityType: "price_list",
        entityId: existing.code,
        action: "deleted",
        detail: { name: existing.name },
        userId: userId ?? null,
      });
    },

    async addPriceListRow(listId: string, input: PriceListRowInput, userId?: string | null) {
      const list = await repo.findPriceListById(listId);
      if (!list) throw new PriceListNotFoundError(listId);
      // Unknown articleId would otherwise surface as a raw FK violation
      // (23503 → 500) from the insert below.
      const article = await articleFiles.getArticle(input.articleId);
      if (!article) throw new ArticleNotFoundError(input.articleId);
      let row;
      try {
        row = await repo.addPriceListRow(listId, input);
      } catch (err) {
        if (isUniqueViolation(err)) throw new DuplicatePriceListRowError(input.fromQuantity);
        throw err;
      }
      await audit.log({
        entityType: "price_list",
        entityId: list.code,
        action: "row_added",
        detail: { articleNumber: article.articleNumber, fromQuantity: row.fromQuantity, unitPrice: row.unitPrice },
        userId: userId ?? null,
      });
      return row;
    },

    async updatePriceListRow(listId: string, rowId: string, input: UpdatePriceListRowInput, userId?: string | null) {
      const list = await repo.findPriceListById(listId);
      if (!list) throw new PriceListNotFoundError(listId);
      const existing = list.rows.find((r) => r.id === rowId);
      let row;
      try {
        row = await repo.updatePriceListRow(listId, rowId, input);
      } catch (err) {
        if (isUniqueViolation(err)) throw new DuplicatePriceListRowError(input.fromQuantity ?? 0);
        throw err;
      }
      if (!row) throw new PriceListRowNotFoundError(rowId);
      await audit.log({
        entityType: "price_list",
        entityId: list.code,
        action: "row_updated",
        detail: {
          articleNumber: existing?.articleNumber ?? null,
          before: existing ? { fromQuantity: existing.fromQuantity, unitPrice: existing.unitPrice } : null,
          after: { fromQuantity: row.fromQuantity, unitPrice: row.unitPrice },
        },
        userId: userId ?? null,
      });
      return row;
    },

    async deletePriceListRow(listId: string, rowId: string, userId?: string | null) {
      const list = await repo.findPriceListById(listId);
      if (!list) throw new PriceListNotFoundError(listId);
      const existing = list.rows.find((r) => r.id === rowId);
      const deleted = await repo.deletePriceListRow(listId, rowId);
      if (!deleted) throw new PriceListRowNotFoundError(rowId);
      await audit.log({
        entityType: "price_list",
        entityId: list.code,
        action: "row_deleted",
        detail: existing
          ? { articleNumber: existing.articleNumber, fromQuantity: existing.fromQuantity, unitPrice: existing.unitPrice }
          : null,
        userId: userId ?? null,
      });
    },

    // --- C3 Kundpriser: kundpriser ---

    async listCustomerPrices(customerId: string) {
      if (!(await repo.findCustomerById(customerId))) throw new CustomerNotFoundError(customerId);
      return repo.listCustomerPrices(customerId);
    },

    async addCustomerPrice(customerId: string, input: CustomerPriceInput, userId?: string | null) {
      if (!(await repo.findCustomerById(customerId))) throw new CustomerNotFoundError(customerId);
      // Unknown article/group target would otherwise surface as a raw FK
      // violation (23503 → 500) from the insert below — the schema's refine
      // already guarantees exactly one of the two is set.
      if (input.articleId && !(await articleFiles.getArticle(input.articleId)))
        throw new ArticleNotFoundError(input.articleId);
      if (input.articleGroupId && !(await repo.articleGroupExists(input.articleGroupId)))
        throw new ArticleGroupNotFoundError(input.articleGroupId);
      let row;
      try {
        row = await repo.addCustomerPrice(customerId, input);
      } catch (err) {
        if (isUniqueViolation(err)) throw new DuplicateCustomerPriceError(input.fromQuantity);
        throw err;
      }
      await audit.log({
        entityType: "customer_price",
        entityId: row.id,
        action: "created",
        detail: {
          customerId,
          articleId: row.articleId,
          articleGroupId: row.articleGroupId,
          fromQuantity: row.fromQuantity,
          unitPrice: row.unitPrice,
          discountPercent: row.discountPercent,
        },
        userId: userId ?? null,
      });
      return row;
    },

    async updateCustomerPrice(customerId: string, priceId: string, input: UpdateCustomerPriceInput, userId?: string | null) {
      const existing = await repo.listCustomerPrices(customerId).then((rows) => rows.find((r) => r.id === priceId));
      let row;
      try {
        row = await repo.updateCustomerPrice(customerId, priceId, input);
      } catch (err) {
        if (isUniqueViolation(err)) throw new DuplicateCustomerPriceError(input.fromQuantity ?? 0);
        throw err;
      }
      if (!row) throw new CustomerPriceNotFoundError(priceId);
      await audit.log({
        entityType: "customer_price",
        entityId: row.id,
        action: "updated",
        detail: {
          before: existing
            ? { fromQuantity: existing.fromQuantity, unitPrice: existing.unitPrice, discountPercent: existing.discountPercent }
            : null,
          after: { fromQuantity: row.fromQuantity, unitPrice: row.unitPrice, discountPercent: row.discountPercent },
        },
        userId: userId ?? null,
      });
      return row;
    },

    async deleteCustomerPrice(customerId: string, priceId: string, userId?: string | null) {
      const existing = await repo.listCustomerPrices(customerId).then((rows) => rows.find((r) => r.id === priceId));
      const deleted = await repo.deleteCustomerPrice(customerId, priceId);
      if (!deleted) throw new CustomerPriceNotFoundError(priceId);
      await audit.log({
        entityType: "customer_price",
        entityId: priceId,
        action: "deleted",
        detail: existing
          ? { fromQuantity: existing.fromQuantity, unitPrice: existing.unitPrice, discountPercent: existing.discountPercent }
          : null,
        userId: userId ?? null,
      });
    },

    // --- Kundens artikelnummer (customer card) ---
    async listCustomerArticleNumbers(customerId: string) {
      if (!(await repo.findCustomerById(customerId))) throw new CustomerNotFoundError(customerId);
      return repo.listCustomerArticleNumbers(customerId);
    },

    async addCustomerArticleNumber(customerId: string, input: CustomerArticleNumberInput, userId?: string | null) {
      if (!(await repo.findCustomerById(customerId))) throw new CustomerNotFoundError(customerId);
      if (!(await articleFiles.getArticle(input.articleId))) throw new ArticleNotFoundError(input.articleId);
      let row;
      try {
        row = await repo.addCustomerArticleNumber(customerId, input.articleId, input.customerArticleNumber);
      } catch (err) {
        if (isUniqueViolation(err)) throw new DuplicateCustomerArticleNumberError();
        throw err;
      }
      await audit.log({
        entityType: "customer_article_number",
        entityId: row.id,
        action: "created",
        detail: { customerId, articleId: row.articleId, customerArticleNumber: row.customerArticleNumber },
        userId: userId ?? null,
      });
      return row;
    },

    async updateCustomerArticleNumber(customerId: string, id: string, customerArticleNumber: string, userId?: string | null) {
      const before = (await repo.listCustomerArticleNumbers(customerId)).find((r) => r.id === id);
      const row = await repo.updateCustomerArticleNumber(customerId, id, customerArticleNumber);
      if (!row) throw new CustomerArticleNumberNotFoundError(id);
      await audit.log({
        entityType: "customer_article_number",
        entityId: row.id,
        action: "updated",
        detail: { before: before?.customerArticleNumber ?? null, after: row.customerArticleNumber },
        userId: userId ?? null,
      });
      return row;
    },

    async deleteCustomerArticleNumber(customerId: string, id: string, userId?: string | null) {
      const row = await repo.deleteCustomerArticleNumber(customerId, id);
      if (!row) throw new CustomerArticleNumberNotFoundError(id);
      await audit.log({
        entityType: "customer_article_number",
        entityId: id,
        action: "deleted",
        detail: { customerId, articleId: row.articleId, customerArticleNumber: row.customerArticleNumber },
        userId: userId ?? null,
      });
    },

    // --- Artikelkortets flik Försäljning ---
    // The same rows as the customer card's Priser/Kundens artikelnummer and
    // the price list register, read and replaced per article. The diff, the
    // pair's advisory lock and the transaction live in
    // repository/article-sales-prices.ts; the audit entries below have the
    // customer card's and the register's detail shapes, one per changed row.

    async getArticleSalesPrices(articleId: string) {
      const result = await repo.articleSalesPrices(articleId);
      if (!result) throw new ArticleNotFoundError(articleId);
      return result;
    },

    async replaceArticleCustomerPrices(
      articleId: string,
      customerId: string,
      input: ArticleCustomerPricesInput,
      userId?: string | null
    ) {
      let result;
      try {
        result = await repo.replaceArticleCustomerPrices(articleId, customerId, input);
      } catch (err) {
        if (err instanceof StaffelConflict) throw new DuplicateCustomerPriceError(err.fromQuantity);
        throw err;
      }
      if (!result.ok) {
        if (result.reason === "article_not_found") throw new ArticleNotFoundError(articleId);
        throw new CustomerNotFoundError(customerId);
      }
      // setupPrice is in before/after here (the customer card's entry lacks
      // it): a save that only changes the ställpris would otherwise log two
      // identical halves.
      const values = (row: { fromQuantity: string; unitPrice: string | null; discountPercent: string | null }) => ({
        fromQuantity: row.fromQuantity,
        unitPrice: row.unitPrice,
        discountPercent: row.discountPercent,
      });
      for (const change of result.priceChanges) {
        await audit.log({
          entityType: "customer_price",
          entityId: change.row.id,
          action: change.kind,
          detail:
            change.kind === "created"
              ? { customerId, articleId, articleGroupId: null, ...values(change.row) }
              : change.kind === "updated"
                ? {
                    before: { ...values(change.before), setupPrice: change.before.setupPrice },
                    after: { ...values(change.row), setupPrice: change.row.setupPrice },
                  }
                : values(change.row),
          userId: userId ?? null,
        });
      }
      const number = result.numberChange;
      if (number) {
        await audit.log({
          entityType: "customer_article_number",
          entityId: number.id,
          action: number.kind,
          detail:
            number.kind === "updated"
              ? { before: number.before, after: number.after }
              : { customerId, articleId, customerArticleNumber: number.kind === "created" ? number.after : number.before },
          userId: userId ?? null,
        });
      }
      return result.entry;
    },

    async replaceArticlePriceListRows(
      articleId: string,
      priceListId: string,
      input: ArticlePriceListRowsInput,
      userId?: string | null
    ) {
      let result;
      try {
        result = await repo.replaceArticlePriceListRows(articleId, priceListId, input);
      } catch (err) {
        if (err instanceof StaffelConflict) throw new DuplicatePriceListRowError(err.fromQuantity);
        throw err;
      }
      if (!result.ok) {
        if (result.reason === "article_not_found") throw new ArticleNotFoundError(articleId);
        throw new PriceListNotFoundError(priceListId);
      }
      const { articleNumber } = result;
      const values = (row: { fromQuantity: string; unitPrice: string }) => ({
        fromQuantity: row.fromQuantity,
        unitPrice: row.unitPrice,
      });
      for (const change of result.changes) {
        await audit.log({
          entityType: "price_list",
          entityId: result.entry.code,
          action: change.kind === "created" ? "row_added" : change.kind === "updated" ? "row_updated" : "row_deleted",
          detail:
            change.kind === "updated"
              ? { articleNumber, before: values(change.before), after: values(change.row) }
              : { articleNumber, ...values(change.row) },
          userId: userId ?? null,
        });
      }
      return result.entry;
    },

    // Exposes the price chain directly — GET /price-quote, used both for
    // order-row pre-fill in the web UI and by the external configurator
    // (requireAuthOrClient scope, see configurator.routes.ts).
    // Valuta: in the order's currency and rate (salesOrderId), else in
    // query.currency (default the customer's) at query.exchangeRate (default
    // today's rate). The answer says which currency and rate it is in.
    async getPriceQuote(query: PriceQuoteQuery) {
      let currency: string;
      let exchangeRate: number;
      // Påslag (#16 etapp 3): a row on an order is priced with the order's
      // own markups too.
      let orderMarkups: PriceMarkups | null = null;
      if (query.salesOrderId) {
        // Another customer's order is no answer (an OAuth client bound to a
        // customer must not read someone else's order through its id).
        const order = await repo.findSalesOrderById(query.salesOrderId);
        if (!order || order.customerId !== query.customerId) throw new SalesOrderNotFoundError(query.salesOrderId);
        currency = order.currency;
        exchangeRate = Number(order.exchangeRate);
        orderMarkups = ownOrderMarkups(salesOrderMarkups(order));
      } else {
        const customer = await repo.findCustomerById(query.customerId);
        currency = query.currency ?? customer?.currency ?? SEK;
        exchangeRate = await documentRate(currency, query.exchangeRate);
      }
      const resolution = await resolvePrice({
        customerId: query.customerId,
        articleId: query.articleId,
        quantity: query.quantity,
        ...(currency === SEK ? {} : { currency, exchangeRate }),
        ...(orderMarkups ? { orderMarkups } : {}),
      });
      return resolution ? { ...resolution, currency, exchangeRate } : null;
    },
  };
}

export type SalesService = ReturnType<typeof createSalesService>;

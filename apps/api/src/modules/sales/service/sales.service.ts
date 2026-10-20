import type {
  ConfiguratorSelection,
  CreateContactInput,
  CreateCustomerInput,
  CreateDeliveryAddressInput,
  CreatePriceListInput,
  CreateQuoteInput,
  CreateSalesOrderRowInput,
  CustomerPriceInput,
  DeliverBatchInput,
  DeliveryPalletCardRow,
  DeliverGoodsInput,
  ListPriceListsQuery,
  ListQuery,
  ListSalesOrdersQuery,
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
} from "@navet/shared";
import type { Tx } from "@navet/db";
import type { RowConfigurationMutationResult, SalesRepository, SalesRowWrite } from "../repository/sales.repository.js";
import { ROW_ARTICLE_UNIQUE } from "../repository/sales.repository.js";
import type { PriceResolution } from "./price-resolver.js";
import type { RegisterReferenceReader } from "../../register/service/register.service.js";
import { RegisterEntryNotFoundError } from "../../register/service/register.service.js";
import type { MailService } from "../../mail/service/mail.service.js";
import type { DocumentPdfService, PalletCardPdfInput } from "../../mail/service/document-pdf.js";
import { roundUpToMultiple, toBasePrice, toBaseQuantity, toUnitPrice, toUnitQuantity } from "@navet/shared";
import type { CustomerDeliveryDateQuery, CustomerDeliveryDateSuggestion } from "@navet/shared";
import {
  deliveryDateWarning,
  deliveryHolidayWindow,
  deliverySummary,
  earliestCustomerDelivery,
  effectiveDeliverySettings,
  stockholmToday,
} from "../../system/service/delivery-days.js";
import type { ArticleFileReader, ArticleRevisionReader, ArticleUnitReader } from "../../article/service/article.service.js";
import { ArticleGroupNotFoundError, ArticleNotFoundError, assertOrderableArticle } from "../../article/service/article.service.js";
import { formatArticleAttributes, formatRevisionInfo, type DocumentSettingsReader } from "../../mail/service/document-pdf.js";
import { isUniqueViolation } from "../../system/service/db-errors.js";
// Konfigurator 4b: the configurator's pure pieces only — the stored-entries
// → selection mapper (variant-identity.ts has no DB imports) and the error
// class the row evaluation shares with Konfigurera (4a). The service itself
// is reached through the injected RowConfigurationReader, never imported.
import { selectionFromEntries } from "../../configurator/service/variant-identity.js";
import { rowConfigurationLines } from "../../configurator/service/configuration-lines.js";
import { ConfiguratorInvalidConfigurationError } from "../../configurator/service/configurator.errors.js";
import type { RowConfigurationEvaluation } from "../../configurator/service/configurator.service.js";
// G1: append-only audit trail (payroll/timereport precedent) — optional with
// a no-op default so the dozens of pre-existing test call sites that build
// this service without an audit writer keep compiling; app.ts wires the real
// one.
import type { AuditWriter } from "../../system/repository/audit.repository.js";
import {
  ConfigurationNotAllowedError,
  ConfigurationRequiredError,
  CustomerPriceNotFoundError,
  DuplicateCustomerPriceError,
  DuplicatePriceListError,
  DuplicatePriceListRowError,
  FreightAlreadyInvoicedError,
  FreightRowDeliveredError,
  InvalidFreightProductError,
  PriceListNotFoundError,
  PriceListRowNotFoundError,
  PriceNotFoundError,
  RowConfigurationLockedError,
  RowVariantExistsError,
} from "./sales.errors.js";

// Narrow slice of the stock service — the pick list shows where each
// article can be picked from (same cross-module pattern as
// RegisterReferenceReader).
export interface StockBalanceReader {
  balancesForArticles(
    articleIds: string[]
  ): Promise<{ articleId: string; quantityOnHand: string; locationName: string | null; warehouseName: string | null }[]>;
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
    opts: { customerId: string; quantity: number }
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

export class InvalidStatusTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidStatusTransitionError";
  }
}

export class OverDeliveryError extends Error {
  constructor() {
    super("Delivered quantity would exceed the ordered quantity for this row");
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
function withoutConfigurationCost<T extends { configurationCost?: unknown }>(row: T): Omit<T, "configurationCost"> {
  const { configurationCost: _cost, ...rest } = row;
  return rest;
}

// Ändra konfiguration (4b): one mapping from the repository's refusal
// reasons to errors, shared by the variant branch's unlocked pre-read and
// the locked re-check so both raise the identical RowConfigurationLockedError.
function throwRowConfigurationFailure(
  result: Extract<RowConfigurationMutationResult, { ok: false }>,
  rowId: string,
  articleNumber: string
): never {
  switch (result.reason) {
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
    case "variant_exists":
      throw new RowVariantExistsError(articleNumber);
  }
}

function termLabel(code: string | null, name: string | null) {
  if (!code && !name) return null;
  return [code, name].filter(Boolean).join(" \u00b7 ");
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
  settings: DocumentSettingsReader,
  // C3: the price chain (price-resolver.ts's resolvePrice), already bound to
  // a db handle by the caller (app.ts) — same "inject a bound function"
  // shape as the other cross-module readers above, kept explicit rather than
  // constructing its own Db here.
  resolvePrice: (query: PriceQuoteQuery) => Promise<PriceResolution>,
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
  rowConfiguration: RowConfigurationReader = ROW_CONFIGURATION_NOT_WIRED
) {
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
  async function articleNumberOf(articleId: string) {
    return (await articleFiles.getArticle(articleId))?.articleNumber ?? articleId;
  }
  // The first article that two ordinary rows (configuration null) share —
  // what the partial unique index sales_order_rows_order_article_unique refuses.
  function firstDuplicateArticleId(rows: SalesRowWrite[]): string | null {
    const seen = new Set<string>();
    for (const row of rows) {
      if (row.configuration) continue;
      if (seen.has(row.articleId)) return row.articleId;
      seen.add(row.articleId);
    }
    return null;
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
  >(customerId: string, input: T, userId?: string | null): Promise<Omit<T, "configuration"> & SalesRowWrite> {
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
        return resolveRowInput(customerId, { ...rest, articleId: variant.id } as T, userId);
      }
    }
    // Produktkonfigurator: a template in mode variants never goes on a new
    // row without a configuration (its variants are); a template in to_order
    // (beställningsvara) goes on the row WITH a configuration, and a
    // configuration is refused on anything else. An unknown article is left
    // to the FK as before. One read serves the guards and the rounding step.
    const article = await articleFiles.getArticle(input.articleId);
    if (article) assertOrderableArticle(article);
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
      const evaluated = await rowConfiguration.evaluate(input.articleId, input.configuration.selection, { customerId, quantity });
      if (!evaluated.valid || !evaluated.configuration) throw new ConfiguratorInvalidConfigurationError(evaluated.errors);
      configuration = evaluated.configuration;
      configurationCost = evaluated.cost;
    }

    let unitPrice: number;
    let discountPercent = input.discountPercent ?? 0;
    if (input.unitPrice !== undefined) {
      unitPrice = toBasePrice(input.unitPrice, selection.unitFactor);
    } else if (configuration) {
      // The template has no base price and the customer chain gave nothing —
      // the seller writes the row's own price (Avvikelse 1).
      if (configuration.price.unitPrice === null) throw new PriceNotFoundError(article?.articleNumber ?? input.articleId);
      unitPrice = configuration.price.unitPrice;
      if (input.discountPercent === undefined) discountPercent = configuration.price.discountPercent;
    } else {
      const resolution = await resolvePrice({ customerId, articleId: input.articleId, quantity });
      if (!resolution?.price) throw new PriceNotFoundError(resolution?.articleNumber ?? input.articleId);
      unitPrice = resolution.price.unitPrice;
      if (input.discountPercent === undefined) discountPercent = resolution.price.discountPercent;
    }
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
    };
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
  async function renderSalesOrderPdf(
    order: NonNullable<Awaited<ReturnType<SalesRepository["findSalesOrderById"]>>>,
    variant: "quote" | "confirmation",
    showConfigurationPrices: boolean
  ) {
    const [customer, rows, { showOrderRevisionOnDocuments }] = await Promise.all([
      repo.findCustomerById(order.customerId),
      repo.listRowsByOrder(order.id),
      settings.getSettings(),
    ]);
    const revisions = await revisionInfoMap(rows.map((r) => r.articleId));
    const content = await pdf.render({
      title: variant === "quote" ? "Offert" : "Orderbekräftelse",
      documentNumber: order.orderNumber,
      date: order.createdAt,
      partnerLabel: "Kund",
      partner: customer!,
      // Sales has no multi-currency support (v1 skips complex currency flows).
      currency: "SEK",
      // Printed in the row's unit (the values are stored in the base unit).
      rows: rows.map((r) => ({
        articleNumber: r.articleNumber,
        articleName: r.articleName,
        quantity: String(toUnitQuantity(Number(r.quantityOrdered), r.unitFactor)),
        unit: r.unitCode,
        unitPrice: String(toUnitPrice(Number(r.unitPrice), r.unitFactor)),
        discountPercent: r.discountPercent,
        // Only used when pricesIncludeVat (privatperson) grosses up the cells.
        vatRate: Number(r.articleVatRate),
        revisionInfo: formatRevisionInfo(revisions?.get(r.articleId)),
        articleInfo: formatArticleAttributes({
          surfaceTreatment: r.articleSurfaceTreatment,
          colour: r.articleColour,
        }),
        configurationLines: rowConfigurationLines(r.configuration, showConfigurationPrices),
        deliveryDate: ownDeliveryDate(r.expectedDeliveryDate, order.expectedDeliveryDate),
      })),
      showTotal: true,
      deliveryDate: order.expectedDeliveryDate,
      revision: showOrderRevisionOnDocuments ? order.revision : null,
      partnerNumber: customer!.customerNumber,
      ourSupplierNumberAtCustomer: customer!.ourSupplierNumber,
      pricesIncludeVat: customer!.privatePerson,
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
      deliveryTerm: termLabel(order.deliveryTermCode, order.deliveryTermName),
      paymentTerm: termLabel(order.paymentTermCode, order.paymentTermName),
      carrier: termLabel(order.carrierCode, order.carrierName),
    });
    const prefix = variant === "quote" ? "Offert" : "Orderbekraftelse";
    return { filename: `${prefix}-${order.orderNumber}.pdf`, content };
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

    const content = await pdf.render({
      title: "Faktura",
      documentNumber: order.invoiceNumber!,
      date: invoicedAt,
      partnerLabel: useInvoiceAddress ? "Fakturaadress" : "Kund",
      partner: partner!,
      currency: "SEK",
      // Printed in the row's unit (the values are stored in the base unit).
      rows: rows.map((r) => ({
        articleNumber: r.articleNumber,
        articleName: r.articleName,
        quantity: String(toUnitQuantity(Number(r.quantityOrdered), r.unitFactor)),
        unit: r.unitCode,
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
      deliveryTerm: termLabel(order.deliveryTermCode, order.deliveryTermName),
      paymentTerm: termLabel(order.paymentTermCode, order.paymentTermName),
      carrier: termLabel(order.carrierCode, order.carrierName),
    });
    return { filename: `Faktura-${order.invoiceNumber}.pdf`, content };
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

  return {
    async createCustomer(input: CreateCustomerInput) {
      await validateRegisterRefs(input);
      try {
        return await repo.createCustomer(input);
      } catch (err) {
        // customers' only unique constraint is customer_number, so a 23505
        // here can mean nothing else.
        if (isUniqueViolation(err)) throw new DuplicateCustomerNumberError(input.customerNumber ?? "");
        throw err;
      }
    },

    async updateCustomer(id: string, input: UpdateCustomerInput) {
      await validateRegisterRefs(input);
      let row;
      try {
        row = await repo.updateCustomer(id, input);
      } catch (err) {
        if (isUniqueViolation(err)) throw new DuplicateCustomerNumberError(input.customerNumber ?? "");
        throw err;
      }
      if (!row) throw new CustomerNotFoundError(id);
      return row;
    },

    async getCustomer(id: string) {
      return repo.findCustomerById(id);
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
    async updateSalesOrderHeader(orderId: string, input: UpdateSalesOrderHeaderInput) {
      const order = await repo.findSalesOrderById(orderId);
      if (!order) throw new SalesOrderNotFoundError(orderId);
      if (order.status !== "quote" && order.status !== "confirmed" && order.status !== "in_production") {
        throw new InvalidStatusTransitionError(`Cannot change the header of an order in status "${order.status}"`);
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
      const result = await repo.updateSalesOrderHeaderWithAddress(orderId, input);
      if (!result.ok) {
        if (result.reason === "not_found") throw new SalesOrderNotFoundError(orderId);
        throw new InvalidStatusTransitionError(`Cannot change the header of an order in status "${result.status}"`);
      }
      return repo.findSalesOrderById(result.order.id);
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
      if (order.status !== "quote" && order.status !== "confirmed" && order.status !== "in_production") {
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
      // The delivery address must belong to the ordering customer.
      if (input.deliveryAddressId) {
        const address = await repo.findDeliveryAddress(input.customerId, input.deliveryAddressId);
        if (!address || address.oneOff) throw new DeliveryAddressNotFoundError(input.deliveryAddressId);
      }
      // Variants resolved here (delprojekt 5) are created under the template
      // lock BEFORE the order's transaction, so they outlive a quote that
      // fails afterwards — by design (spec): a variant is an ordinary,
      // reusable article, and the next order for the same choices reuses it.
      const rows = await Promise.all(input.rows.map((r) => resolveRowInput(input.customerId, r, createdBy)));
      // Two ordinary rows (incl. resolved variant rows) on the same article
      // would hit the partial unique index sales_order_rows_order_article_unique;
      // refuse with the domain error up front. Configured beställningsvara
      // rows (configuration set) may repeat.
      const duplicate = firstDuplicateArticleId(rows);
      if (duplicate) throw new RowVariantExistsError(await articleNumberOf(duplicate));
      let created;
      try {
        created = await repo.createQuote({ ...input, rows }, createdBy);
      } catch (err) {
        // Backstop for the index, caught outside the repository's transaction
        // (which has already rolled back).
        if (isUniqueViolation(err, ROW_ARTICLE_UNIQUE)) {
          const id = firstDuplicateArticleId(rows);
          throw new RowVariantExistsError(id ? await articleNumberOf(id) : "(okänd)");
        }
        throw err;
      }
      const result = { order: created.order, rows: created.rows.map(withoutConfigurationCost) };
      if (!input.confirm) return result;
      // "Ny kundorder": run the normal quote → confirmed transition right
      // away. A freshly created order is always in status "quote", so the
      // transition guard in confirm() would trivially pass.
      const confirmed = await repo.updateStatus(result.order.id, "confirmed");
      return { ...result, order: confirmed ?? result.order };
    },

    async getSalesOrder(id: string) {
      return repo.findSalesOrderById(id);
    },

    async listSalesOrders(query: ListSalesOrdersQuery) {
      return repo.listSalesOrders(query);
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
      if (order.status !== "quote" && order.status !== "confirmed" && order.status !== "in_production") {
        throw new InvalidStatusTransitionError(`Cannot add rows to an order in status "${order.status}"`);
      }
      const write = await resolveRowInput(order.customerId, input, userId ?? null);
      let row;
      try {
        row = await repo.addRow(salesOrderId, write);
      } catch (err) {
        // The article (e.g. the variant a configuration resolved to) already
        // sits on the order as an ordinary row — the partial unique index,
        // caught outside the repository's (rolled back) transaction.
        if (isUniqueViolation(err, ROW_ARTICLE_UNIQUE)) throw new RowVariantExistsError(await articleNumberOf(write.articleId));
        throw err;
      }
      const article = await articleFiles.getArticle(row.articleId);
      await audit.log({
        entityType: "sales_order_row",
        entityId: order.orderNumber,
        action: "row_added",
        detail: {
          articleNumber: article?.articleNumber ?? null,
          quantity: row.quantityOrdered,
          unitPrice: row.unitPrice,
          discountPercent: row.discountPercent,
        },
        userId: userId ?? null,
      });
      return withoutConfigurationCost(row);
    },

    async updateRow(salesOrderId: string, rowId: string, input: UpdateSalesOrderRowInput, userId?: string | null) {
      const order = await repo.findSalesOrderById(salesOrderId);
      if (!order) throw new SalesOrderNotFoundError(salesOrderId);
      if (order.status !== "quote" && order.status !== "confirmed" && order.status !== "in_production") {
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
        });
        if (!evaluated.valid || !evaluated.configuration) throw new ConfiguratorInvalidConfigurationError(evaluated.errors);
        configurationCostPatch = evaluated.cost;
      }
      if (input.unitPrice === undefined && quantity !== undefined) {
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
          }
        } else {
          // An empty chain means there is no staffel the new quantity could
          // have crossed, so the row keeps the price it already has (it was
          // priced by hand). Only addRow/createQuote refuse an unpriced row.
          const resolution = await resolvePrice({ customerId: order.customerId, articleId: existing.articleId, quantity });
          if (resolution?.price) {
            unitPrice = resolution.price.unitPrice;
            if (discountPercent === undefined) discountPercent = resolution.price.discountPercent;
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
      };
      let beforeKey: string | null;
      let afterKey: string | null;
      if (stored) {
        const evaluated = await rowConfiguration.evaluate(stored.templateArticleId, input.selection, { customerId: order.customerId, quantity });
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
        if (!preRead.ok) throwRowConfigurationFailure(preRead, rowId, beforeNumber);
        const { article: variant } = await rowConfiguration.resolveVariant(variantOf.templateArticleId, input.selection, userId ?? null);
        const resolution = await resolvePrice({ customerId: order.customerId, articleId: variant.id, quantity });
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
        };
        beforeKey = variantOf.configKey;
        afterKey = variant.id === existing.articleId ? variantOf.configKey : ((await rowConfiguration.variantOf(variant.id))?.configKey ?? null);
      }

      const result = await repo.replaceRowConfiguration(salesOrderId, rowId, next, input.bumpRevision !== false);
      if (!result.ok) throwRowConfigurationFailure(result, rowId, next.articleNumber);
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
    // order already has one (one row per article per order). Goes through
    // addRow/updateRow so status guards, revision and audit stay identical.
    async setFreightRow(salesOrderId: string, input: { articleId: string; unitPrice: number }, userId?: string | null) {
      const order = await repo.findSalesOrderById(salesOrderId);
      if (!order) throw new SalesOrderNotFoundError(salesOrderId);
      // Frakt etapp 2: the freight of this order's följesedel is already on
      // an invoice as a shipment row — neither a new order freight row nor a
      // repriced one may bill the same transport again.
      const invoiced = await repo.invoicedShipmentForOrder(salesOrderId);
      if (invoiced) throw new FreightAlreadyInvoicedError(invoiced.shipmentNumber);
      const existing = (await repo.listRowsByOrder(salesOrderId)).find((r) => r.articleId === input.articleId);
      if (!existing) {
        return this.addRow(salesOrderId, { articleId: input.articleId, quantity: 1, unitPrice: input.unitPrice, discountPercent: 0 }, userId);
      }
      if (Number(existing.quantityDelivered) > 0) throw new FreightRowDeliveredError();
      const { row } = await this.updateRow(salesOrderId, existing.id, { unitPrice: input.unitPrice, discountPercent: 0 }, userId);
      return row;
    },

    async deleteRow(salesOrderId: string, rowId: string, bumpRevision = true, userId?: string | null) {
      const order = await repo.findSalesOrderById(salesOrderId);
      if (!order) throw new SalesOrderNotFoundError(salesOrderId);
      if (order.status !== "quote" && order.status !== "confirmed" && order.status !== "in_production") {
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
      }
    },

    async confirm(orderId: string, userId?: string | null) {
      const order = await repo.findSalesOrderById(orderId);
      if (!order) throw new SalesOrderNotFoundError(orderId);
      if (order.status !== "quote") {
        throw new InvalidStatusTransitionError(`Cannot confirm an order in status "${order.status}"`);
      }
      const updated = await repo.updateStatus(orderId, "confirmed");
      await audit.log({
        entityType: "sales_order",
        entityId: order.orderNumber,
        action: "confirmed",
        userId: userId ?? null,
      });
      return updated;
    },

    // showConfigurationPrices omitted ⇒ the customer's Visa tilläggspriser.
    async getSalesOrderPdf(orderId: string, variant: "quote" | "confirmation", showConfigurationPrices?: boolean) {
      const order = await repo.findSalesOrderById(orderId);
      if (!order) throw new SalesOrderNotFoundError(orderId);
      const customer = await repo.findCustomerById(order.customerId);
      return renderSalesOrderPdf(order, variant, showConfigurationPrices ?? customer!.showConfigurationPrices);
    },

    // Plocklista — remaining quantities per row plus where the stock is.
    async getPickListPdf(orderId: string) {
      const order = await repo.findSalesOrderById(orderId);
      if (!order) throw new SalesOrderNotFoundError(orderId);
      if (order.status === "cancelled") {
        throw new InvalidStatusTransitionError(`Cannot print a pick list for an order in status "${order.status}"`);
      }
      const rows = await repo.listRowsByOrder(orderId);
      const openRows = rows.filter((r) => Number(r.quantityDelivered) < Number(r.quantityOrdered));
      const balances = await stock.balancesForArticles(openRows.map((r) => r.articleId));

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
          deliveryDate: ownDeliveryDate(r.expectedDeliveryDate, order.expectedDeliveryDate),
          locations: balances
            .filter((b) => b.articleId === r.articleId)
            .map((b) =>
              b.locationName
                ? `${b.warehouseName} — ${b.locationName}: ${Number(b.quantityOnHand)}`
                : `Utan lagerplats: ${Number(b.quantityOnHand)}`
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
      if (order.status === "cancelled") {
        throw new InvalidStatusTransitionError(`Cannot email an order in status "${order.status}"`);
      }
      // Visa tilläggspriser: the dialog's choice, else the customer's setting
      // — logged on the email so Skicka om renders the same attachment even
      // after the customer's setting changes.
      const customer = await repo.findCustomerById(order.customerId);
      const showPrices = input.showConfigurationPrices ?? customer!.showConfigurationPrices;
      const attachment = await renderSalesOrderPdf(order, input.variant, showPrices);
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
        return repo.updateStatus(orderId, "confirmed");
      }
      return order;
    },

    // Manual placeholder until Fas 3's ManufacturingOrder can drive this transition.
    async startProduction(orderId: string, userId?: string | null) {
      const order = await repo.findSalesOrderById(orderId);
      if (!order) throw new SalesOrderNotFoundError(orderId);
      if (order.status !== "confirmed") {
        throw new InvalidStatusTransitionError(`Cannot start production for an order in status "${order.status}"`);
      }
      const updated = await repo.updateStatus(orderId, "in_production");
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
      if (order.status !== "quote" && order.status !== "confirmed") {
        throw new InvalidStatusTransitionError(
          `Cannot cancel an order in status "${order.status}" — production has already started`
        );
      }
      const updated = await repo.updateStatus(orderId, "cancelled");
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
    async setStatus(orderId: string, status: SalesOrderStatus, userId?: string | null) {
      const order = await repo.findSalesOrderById(orderId);
      if (!order) throw new SalesOrderNotFoundError(orderId);
      await repo.updateStatus(orderId, status);
      await audit.log({
        entityType: "sales_order",
        entityId: order.orderNumber,
        action: "status_set",
        detail: { before: order.status, after: status },
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
    async deliverGoods(orderId: string, rowId: string, input: DeliverGoodsInput, createdBy: string) {
      const result = await repo.deliverBatch(orderId, {
        locationId: input.locationId,
        rows: [{ rowId, quantity: input.quantity }],
        createdBy,
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
          throw new OverDeliveryError();
      }
    },

    // Leveranstillfälle (delivery occasion) — C2: delivers several rows in
    // one go, creating a single delivery record for them.
    async deliverBatch(orderId: string, input: DeliverBatchInput, createdBy: string) {
      const result = await repo.deliverBatch(orderId, { ...input, createdBy });
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
          throw new OverDeliveryError();
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
          locationId: result.locationId,
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

      // Frakt: carrier + fraktsedelsnummer only once the shipment is booked —
      // a draft has neither, and a cancelled one is no longer live.
      const shipment = shipments ? (await shipments.shipmentsForDeliveries([deliveryId])).get(deliveryId) : undefined;
      const carrier =
        shipment && (shipment.status === "booked" || shipment.status === "delivered")
          ? { carrierName: shipment.carrierName, trackingNumber: shipment.trackingNumber }
          : null;

      const content = await pdf.renderDeliveryNote({
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
          articleName: r.articleName,
          quantity: toUnitQuantity(Number(r.quantity), r.unitFactor),
          unit: r.unitCode,
          priorDelivered: toUnitQuantity(r.priorDelivered, r.unitFactor),
          undoneAt: r.undoneAt,
          // The delivery note carries no prices at all — choices only.
          configurationLines: rowConfigurationLines(r.configuration, false),
        })),
      });
      return { pdf: content, filename: `foljesedel-${delivery.deliveryNumber}.pdf`, deliveryNumber: delivery.deliveryNumber };
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
      const cards: PalletCardPdfInput[] = [];
      for (const pick of picks) {
        pick.quantities.forEach((quantity, i) => {
          cards.push({
            kind: "final",
            code,
            articleNumber: pick.row.articleNumber,
            articleName: pick.row.articleName,
            customerName: delivery.customerName,
            customerOrderNumber: delivery.customerOrderNumber,
            orderNumber: delivery.orderNumber,
            quantity,
            unit: pick.row.unitCode,
            parcel: { index: i + 1, count: pick.quantities.length },
            printedAt: delivery.deliveredAt,
            // The delivery card deliberately names no reporter (user's
            // decision) — only the TO cards carry Rapporterad av.
            reference: delivery.deliveryNumber,
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
      return { pdf: content, filename: `pallkort-${delivery.deliveryNumber}.pdf` };
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
      let row;
      try {
        row = await repo.updatePriceList(id, input);
      } catch (err) {
        if (isUniqueViolation(err)) throw new DuplicatePriceListError(input.code, input.name);
        throw err;
      }
      if (!row) throw new PriceListNotFoundError(id);
      await audit.log({
        entityType: "price_list",
        entityId: row.code,
        action: "updated",
        detail: {
          before: { code: existing.code, name: existing.name, description: existing.description },
          after: { code: row.code, name: row.name, description: row.description },
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

    // Exposes the price chain directly — GET /price-quote, used both for
    // order-row pre-fill in the web UI and by the external configurator
    // (requireAuthOrClient scope, see configurator.routes.ts).
    async getPriceQuote(query: PriceQuoteQuery) {
      return resolvePrice(query);
    },
  };
}

export type SalesService = ReturnType<typeof createSalesService>;

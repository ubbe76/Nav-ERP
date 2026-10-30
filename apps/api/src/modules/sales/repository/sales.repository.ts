import { randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, exists, getTableColumns, ilike, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { customerArticleNumberMap } from "./customer-article-numbers.js";
import {
  articleGroups,
  articles,
  carriers,
  configuratorVariants,
  costCenters,
  projects,
  customerContacts,
  customerDeliveryAddresses,
  customerArticleNumbers,
  customerPrices,
  customers,
  deliveries,
  deliveryRows,
  deliveryTerms,
  freightProducts,
  invoiceRows,
  manufacturingOrders,
  paymentTerms,
  priceListRows,
  priceLists,
  quoteLossReasons,
  salesOrderRows,
  salesOrders,
  shipmentDeliveries,
  shipments,
  stockTransactions,
  units,
  users,
  type Db,
} from "@navet/db";
import {
  ilikePattern,
  salesDocumentKind,
  type CreateContactInput,
  type CreateCustomerInput,
  type CreateDeliveryAddressInput,
  type CreatePriceListInput,
  type CreateQuoteInput,
  type CreateSalesOrderRowInput,
  type CustomerPriceInput,
  type ListPriceListsQuery,
  type ListQuery,
  type ListSalesOrdersQuery,
  type NewDeliveryAddressInput,
  type OrderRowConfiguration,
  type PalletCardCode,
  type OrderRowConfigurationCost,
  type PriceListRowInput,
  type SalesDocumentKind,
  type SalesOrderStatus,
  type UpdateContactInput,
  type UpdateCustomerInput,
  type UpdateCustomerPriceInput,
  type UpdateDeliveryAddressInput,
  type UpdatePriceListInput,
  type UpdatePriceListRowInput,
  type UpdateSalesOrderHeaderInput,
  type UpdateSalesOrderRowInput,
} from "@navet/shared";
import { documentKindSql } from "./document-kind.js";
import { getNextOrderNumber, insertWithSeriesNumber } from "../../system/service/number-series.js";
import { pluginEvents } from "../../system/service/plugin-events.js";
import { resolveDimensions, type DimensionInput, type ResolveDimensionsOptions } from "../../economy/service/dimension-check.js";
import { resolveStockLocation } from "../../stock/service/location-resolver.js";
import { deactivateEmptyLocation } from "../../stock/service/location-lifecycle.js";
import { assertLocationNotUnderCount } from "../../stock/service/count-guard.js";
import { PriceListInUseError, RowHasManufacturingOrdersError, SalesOrderCurrencyChangedError } from "../service/sales.errors.js";
import { isForeignKeyViolation, isUniqueViolation } from "../../system/service/db-errors.js";
import { loadDeliveryContext } from "../../system/repository/delivery-context.js";
import { getInvoicedQuantitiesWith } from "./invoice.repository.js";
import { loadVatCodeBook } from "../../economy/repository/vat-codes.js";
import { articleVatRateSql } from "../../article/repository/article-vat-rate.js";

// users joined a second time for "who marked the quote lost" (the order's
// created_by is not the same person).
const lostByUser = alias(users, "lost_by_user");
// Kostnadsställen och projekt: the order header's objects as { id, code, name }.
const orderCostCenters = alias(costCenters, "order_cost_centers");
const orderProjects = alias(projects, "order_projects");


// A plain sales_orders row (from insert/update … returning) with its derived
// document kind, so every write path answers in the same shape as the reads.
function withDocumentKind<T extends { status: SalesOrderStatus; orderNumber: string; quoteNumber: string | null }>(
  row: T
): T & { documentKind: SalesDocumentKind } {
  return { ...row, documentKind: salesDocumentKind(row) };
}

// Statuses that make a row an order: leaving a quote for one of these
// gives an OF- numbered quote its KO- number (updateStatus).
const ORDER_STATUSES: readonly SalesOrderStatus[] = ["confirmed", "in_production", "delivered", "invoiced"];

// Leveranstillfälle (delivery occasion) — C2. The whole batch is one
// transaction: every row goes through the exact per-row guard/lock/booking
// sequence deliverGoods used to run standalone (over-delivery guard, stock
// booking, location cleanup), and a "row_not_found"/"over_delivery" failure
// on ANY row rolls the entire batch back — no partial delivery, no orphaned
// delivery/delivery_rows/stock_transactions rows. The single-row deliver
// endpoint is now just a 1-row call into this same path (see
// sales.service.ts's deliverGoods).
// E3 (KO→TO-koppling): the row-level read manufacturing validates a link
// against before its own create-tx starts — reads committed data, no Tx
// param (mirrors findRowById plus the joins the manufacturing service needs
// for its own error messages/checks: order status, article type, customer).
export interface SalesOrderRowForManufacturing {
  id: string;
  salesOrderId: string;
  orderNumber: string;
  orderStatus: SalesOrderStatus;
  customerName: string;
  // Kundens ordernummer — printed on the pallet card (Etapp F); null when
  // the order carries none.
  customerOrderNumber: string | null;
  articleId: string;
  articleType: string;
  quantityOrdered: number;
  // Konfigurator 4c: the row's stored configuration — a beställningsvara's
  // TO is derived from its selection; null on a plain row.
  configuration: OrderRowConfiguration | null;
  // Pallkort: the customer's Kod på pallkort (null = the system setting) and
  // the order's chosen delivery address (null = none chosen), both printed
  // on the final card of the last operation.
  customerPalletCardCode: PalletCardCode | null;
  deliveryAddress: { address: string; postalCode: string | null; city: string | null; country: string | null } | null;
}

export type DeliverBatchResult =
  | {
      ok: true;
      deliveryId: string;
      deliveryNumber: string;
      orderStatus: SalesOrderStatus;
      rows: (typeof salesOrderRows.$inferSelect)[];
    }
  | { ok: false; reason: "order_not_found" | "invalid_status" }
  | { ok: false; reason: "row_not_found"; rowId: string }
  // maxQuantity: the most the row may hold delivered, in the base unit.
  | { ok: false; reason: "over_delivery"; rowId: string; maxQuantity: number };

// Ångra utleverans — one delivery row reversed (see undoDeliveryRow below).
// Every refusal is decided before anything is written, so returning it from
// inside the transaction commits nothing.
export type UndoDeliveryRowResult =
  | {
      ok: true;
      deliveryRow: typeof deliveryRows.$inferSelect;
      deliveryNumber: string;
      orderNumber: string;
      articleId: string;
      locationId: string;
      statusBefore: SalesOrderStatus;
      orderStatus: SalesOrderStatus;
    }
  | { ok: false; reason: "delivery_not_found" | "row_not_found" | "already_undone" | "not_undoable" }
  | { ok: false; reason: "invalid_status"; status: SalesOrderStatus }
  | { ok: false; reason: "on_shipment"; shipmentNumber: string }
  | { ok: false; reason: "invoiced"; invoiced: number; deliveredAfter: number };

// Internal control-flow signals only — never leave deliverBatch below.
// db.transaction() only rolls back on a THROWN error: a plain `{ ok: false }`
// return from inside the callback is a normal return value and COMMITS,
// which would leave an earlier row's already-booked stock/quantity_delivered
// writes in place if a later row in the same batch fails its guard. So every
// failure branch inside the transaction throws one of these instead, and the
// catch block below converts it back into the discriminated result — same
// "no matching row" convention as IssueRaceError in invoice.repository.ts.
class BatchOrderNotFoundError extends Error {}
class BatchInvalidStatusError extends Error {}
class BatchRowNotFoundError extends Error {
  constructor(public rowId: string) {
    super();
  }
}
class BatchOverDeliveryError extends Error {
  constructor(
    public rowId: string,
    public maxQuantity: number
  ) {
    super();
  }
}

// Row-level unit snapshot resolved by the service (null = the article's base
// unit). Quantities/prices on the same input arrive already converted to the
// base unit.
export type UnitSnapshot = { unitId: string | null; unitFactor: number | null };
// What the service hands the repository for a new row: the zod input with the
// unit snapshot resolved and (konfigurator 4b) the raw `configuration:
// { selection }` replaced by the evaluated one — null/omitted on an ordinary row.
// Konfigurator 4c: `configurationCost` is the configuration's förkalkyl at
// the row's quantity (null on an ordinary row, or when it is not derivable).
export type SalesRowWrite = Omit<CreateSalesOrderRowInput, "configuration"> &
  UnitSnapshot & {
    configuration?: OrderRowConfiguration | null;
    configurationCost?: OrderRowConfigurationCost | null;
    // Ställkostnad: written as its own row (quantity 1, the Ställkostnads-
    // artikel) right after this one, linked by setup_for_row_id.
    setupCharge?: { articleId: string; unitPrice: number } | null;
  };

// The linked Ställkostnad row of `mainRowId` — one shape for createQuote and
// addRow. Base unit, no discount, follows the order's Leveransdatum.
function setupChargeRowValues(
  salesOrderId: string,
  mainRowId: string,
  charge: { articleId: string; unitPrice: number },
  createdAt: Date
) {
  return {
    salesOrderId,
    articleId: charge.articleId,
    quantityOrdered: "1",
    unitPrice: String(charge.unitPrice),
    discountPercent: "0",
    unitId: null,
    unitFactor: null,
    setupForRowId: mainRowId,
    createdAt,
  };
}

export type SalesRowMutationResult =
  | { ok: true; row: typeof salesOrderRows.$inferSelect | null; orderStatus: SalesOrderStatus }
  | { ok: false; reason: "row_not_found" | "quantity_below_delivered" | "row_has_deliveries" };

// Ändra konfiguration (4b): the partial unique index on (sales_order_id,
// article_id) WHERE configuration IS NULL — the variant the row is moving to
// may already sit on the order as an ordinary row (migration 0113).
export const ROW_ARTICLE_UNIQUE = "sales_order_rows_order_article_unique";
export type RowConfigurationMutationResult =
  | { ok: true; row: typeof salesOrderRows.$inferSelect; previous: typeof salesOrderRows.$inferSelect; orderStatus: SalesOrderStatus }
  | {
      ok: false;
      reason: "row_not_found" | "order_status" | "delivered" | "manufacturing_order" | "invoice_row" | "variant_exists";
      orderStatus?: SalesOrderStatus;
    };

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

// Quantities live in numeric(14,4) — compare and store at that precision.
function round4(n: number): number {
  return Math.round((n + Number.EPSILON) * 10000) / 10000;
}

// Ny leveransadress on an order (create or header PATCH), inside the order's
// own transaction: an engångsadress unless Spara på kunden is ticked. Never
// the default — the customer card decides that.
async function insertNewDeliveryAddress(tx: Tx, customerId: string, input: NewDeliveryAddressInput) {
  const { saveToCustomer, ...address } = input;
  const [row] = await tx
    .insert(customerDeliveryAddresses)
    .values({ ...address, customerId, isDefault: false, oneOff: !saveToCustomer })
    .returning();
  return row!;
}

// bumpRevision is a directive, not a column — stripped before the spread.
// Valuta: the rate is numeric (a string column), resolved by the service.
async function writeSalesOrderHeader(dbc: Db | Tx, orderId: string, input: UpdateSalesOrderHeaderInput) {
  const { bumpRevision, newDeliveryAddress: _newDeliveryAddress, exchangeRate, ...fields } = input;
  const [row] = await dbc
    .update(salesOrders)
    .set({
      ...fields,
      ...(exchangeRate !== undefined ? { exchangeRate: String(exchangeRate) } : {}),
      revision: bumpRevision !== false ? sql`${salesOrders.revision} + 1` : undefined,
      updatedAt: new Date(),
    })
    .where(eq(salesOrders.id, orderId))
    .returning();
  return row ?? null;
}

// Content changes (header/terms/rows) bump the order's revision by 1 inside
// the same transaction — status transitions and deliveries never do. Callers
// can opt out per save via the bumpRevision flag (the UI asks on every save).
async function bumpRevision(tx: Tx, orderId: string) {
  await tx
    .update(salesOrders)
    .set({ revision: sql`${salesOrders.revision} + 1`, updatedAt: new Date() })
    .where(eq(salesOrders.id, orderId));
}

// A row edit/delete on an in-production order can make every remaining row
// fully delivered — mirror deliverGoods' status recomputation. Other
// statuses are left untouched (the service guards which ones are editable).
async function recomputeInProduction(tx: Tx, orderId: string): Promise<SalesOrderStatus> {
  const [order] = await tx.select().from(salesOrders).where(eq(salesOrders.id, orderId));
  if (!order || order.status !== "in_production") return order?.status ?? "in_production";
  const allRows = await tx.select().from(salesOrderRows).where(eq(salesOrderRows.salesOrderId, orderId));
  const allDelivered =
    allRows.length > 0 && allRows.every((r) => Number(r.quantityDelivered) >= Number(r.quantityOrdered));
  if (!allDelivered) return "in_production";
  await tx.update(salesOrders).set({ status: "delivered", updatedAt: new Date() }).where(eq(salesOrders.id, orderId));
  return "delivered";
}

// Ändra konfiguration (4b): the four guards that lock a row's configuration
// — order status, delivery, a live TO and an invoice row — shared by the
// locked re-check inside replaceRowConfiguration (`lock` = FOR UPDATE on the
// row, inside its transaction) and the service's unlocked pre-read
// (readRowConfigurationLock). One implementation so the two can never
// disagree about what counts as locked.
async function rowConfigurationGuards(
  exec: Db | Tx,
  orderId: string,
  rowId: string,
  lock: boolean
): Promise<
  | { ok: true; row: typeof salesOrderRows.$inferSelect; orderStatus: SalesOrderStatus }
  | Extract<RowConfigurationMutationResult, { ok: false }>
> {
  const query = exec
    .select({ row: salesOrderRows, orderStatus: salesOrders.status })
    .from(salesOrderRows)
    .innerJoin(salesOrders, eq(salesOrders.id, salesOrderRows.salesOrderId))
    .where(and(eq(salesOrderRows.id, rowId), eq(salesOrderRows.salesOrderId, orderId)));
  const [found] = lock ? await query.for("update", { of: salesOrderRows }) : await query;
  if (!found) return { ok: false, reason: "row_not_found" };
  if (found.orderStatus !== "quote" && found.orderStatus !== "confirmed" && found.orderStatus !== "in_production") {
    return { ok: false, reason: "order_status", orderStatus: found.orderStatus };
  }
  if (Number(found.row.quantityDelivered) > 0) return { ok: false, reason: "delivered" };
  // A cancelled TO is history, not a lock (E3's coverage reads the link the
  // same way).
  const [mo] = await exec
    .select({ id: manufacturingOrders.id })
    .from(manufacturingOrders)
    .where(and(eq(manufacturingOrders.salesOrderRowId, rowId), ne(manufacturingOrders.status, "cancelled")))
    .limit(1);
  if (mo) return { ok: false, reason: "manufacturing_order" };
  const [inv] = await exec.select({ id: invoiceRows.id }).from(invoiceRows).where(eq(invoiceRows.salesOrderRowId, rowId)).limit(1);
  if (inv) return { ok: false, reason: "invoice_row" };
  return { ok: true, row: found.row, orderStatus: found.orderStatus };
}

// Överleverans on a customer PATCH: the percentage belongs to Tillåt only
// (CHECK customers_over_delivery_percent). Another choice clears it; a
// percentage sent alone is kept only if the stored choice is Tillåt.
function overDeliveryUpdate(
  overDelivery: "allow" | "deny" | null | undefined,
  overDeliveryPercent: number | null | undefined
) {
  const percent = overDeliveryPercent == null ? null : String(overDeliveryPercent);
  if (overDelivery !== undefined) {
    if (overDelivery !== "allow") return { overDelivery, overDeliveryPercent: null };
    return overDeliveryPercent === undefined ? { overDelivery } : { overDelivery, overDeliveryPercent: percent };
  }
  if (overDeliveryPercent === undefined) return {};
  return {
    overDeliveryPercent: sql<string | null>`case when ${customers.overDelivery} = 'allow' then ${percent}::numeric end`,
  };
}

export function createSalesRepository(db: Db) {
  return {
    // The customer number comes from the "customer" number series unless the
    // caller supplied one, in which case it's inserted as-is and never
    // retried — a collision there is the caller's error and surfaces as a
    // 409. Otherwise, self-healing allocation that steps past a manually
    // taken number instead of failing — see number-series.ts's
    // insertWithSeriesNumber for why and how.
    async createCustomer(input: CreateCustomerInput) {
      // discountPercent is optional here — callers that bypass the zod
      // schema's .default(0) (every service-level test in this codebase,
      // and any other direct caller) never set it. String(undefined) would
      // insert the literal text "undefined" into the numeric column and
      // fail the query, so an omitted value is left out of the insert
      // entirely and falls through to the column's own DEFAULT 0 — same
      // guard updateCustomer already applies below.
      // Dröjsmålsränta: lateInterestRate is numeric(5,2) — the same
      // string/omit treatment as discountPercent (null clears).
      const { discountPercent, lateInterestRate, overDelivery, overDeliveryPercent, ...rest } = input;
      const values = {
        ...rest,
        ...(discountPercent === undefined ? {} : { discountPercent: String(discountPercent) }),
        ...(lateInterestRate === undefined ? {} : { lateInterestRate: lateInterestRate === null ? null : String(lateInterestRate) }),
        // Överleverans: the percentage belongs to Tillåt only (CHECK
        // customers_over_delivery_percent).
        overDelivery: overDelivery ?? null,
        overDeliveryPercent: overDelivery === "allow" && overDeliveryPercent != null ? String(overDeliveryPercent) : null,
      };
      // Tillägg: customer.created commits with the customer.
      const insert = (customerNumber: string) =>
        db.transaction(async (tx) => {
          const [row] = await tx
            .insert(customers)
            .values({ ...values, customerNumber })
            .returning();
          await pluginEvents.emit(tx, { type: "customer.created", entityId: row!.id, entityNumber: row!.customerNumber });
          return row!;
        });
      return input.customerNumber !== undefined
        ? insert(input.customerNumber)
        : insertWithSeriesNumber(db, "customer", insert);
    },

    async updateCustomer(id: string, input: UpdateCustomerInput) {
      const { discountPercent, lateInterestRate, overDelivery, overDeliveryPercent, ...rest } = input;
      const set = {
        ...rest,
        ...(discountPercent === undefined ? {} : { discountPercent: String(discountPercent) }),
        ...(lateInterestRate === undefined ? {} : { lateInterestRate: lateInterestRate === null ? null : String(lateInterestRate) }),
        ...overDeliveryUpdate(overDelivery, overDeliveryPercent),
      };
      return db.transaction(async (tx) => {
        const [row] = await tx.update(customers).set(set).where(eq(customers.id, id)).returning();
        if (row) await pluginEvents.emit(tx, { type: "customer.updated", entityId: row.id, entityNumber: row.customerNumber });
        return row ?? null;
      });
    },

    // Fasta leveransdagar: the system defaults + full-day holidays in the
    // window, for the delivery date suggestion (delivery-context.ts).
    async deliveryContext(window: { from: string; to: string }) {
      return loadDeliveryContext(db, window);
    },

    async findCustomerById(id: string) {
      const [row] = await db
        .select({
          ...getTableColumns(customers),
          deliveryTermCode: deliveryTerms.code,
          deliveryTermName: deliveryTerms.name,
          paymentTermCode: paymentTerms.code,
          paymentTermName: paymentTerms.name,
          carrierCode: carriers.code,
          carrierName: carriers.name,
          defaultFreightCarrierName: freightProducts.carrierName,
          defaultFreightProductName: freightProducts.productName,
        })
        .from(customers)
        .leftJoin(deliveryTerms, eq(deliveryTerms.id, customers.deliveryTermId))
        .leftJoin(paymentTerms, eq(paymentTerms.id, customers.paymentTermId))
        .leftJoin(carriers, eq(carriers.id, customers.carrierId))
        .leftJoin(freightProducts, eq(freightProducts.id, customers.defaultFreightProductId))
        .where(eq(customers.id, id));
      return row ?? null;
    },

    // Momskoder: the company's invoice text per code, for the quote/order
    // confirmation (renderSalesOrderPdf).
    async vatCodeInvoiceTexts() {
      const book = await loadVatCodeBook(db);
      return new Map([...book.byCode.values()].map((row) => [row.code, row.invoiceText] as const));
    },

    async freightProductExists(id: string) {
      const [row] = await db.select({ id: freightProducts.id }).from(freightProducts).where(eq(freightProducts.id, id));
      return row !== undefined;
    },

    async listCustomers(query: ListQuery) {
      const pattern = query.search ? ilikePattern(query.search) : null;
      const where = pattern
        ? or(
            ilike(customers.customerNumber, pattern),
            ilike(customers.name, pattern),
            ilike(customers.contactName, pattern)
          )
        : undefined;
      const [rows, totalRows] = await Promise.all([
        db.select().from(customers).where(where).orderBy(asc(customers.name)).limit(query.limit).offset(query.offset),
        db.select({ total: count() }).from(customers).where(where),
      ]);
      return { rows, total: totalRows[0]!.total };
    },

    async listCustomerContacts(customerId: string) {
      return db
        .select()
        .from(customerContacts)
        .where(eq(customerContacts.customerId, customerId))
        .orderBy(desc(customerContacts.isPrimary), asc(customerContacts.name));
    },

    // Making a contact primary demotes the previous primary in the same
    // transaction — otherwise the partial unique index rejects the write.
    async createCustomerContact(customerId: string, input: CreateContactInput) {
      return db.transaction(async (tx) => {
        if (input.isPrimary) {
          await tx
            .update(customerContacts)
            .set({ isPrimary: false })
            .where(and(eq(customerContacts.customerId, customerId), eq(customerContacts.isPrimary, true)));
        }
        const [row] = await tx.insert(customerContacts).values({ ...input, customerId }).returning();
        return row!;
      });
    },

    // Scoped to the customer so a contact id from another customer 404s.
    async updateCustomerContact(customerId: string, contactId: string, input: UpdateContactInput) {
      return db.transaction(async (tx) => {
        if (input.isPrimary === true) {
          await tx
            .update(customerContacts)
            .set({ isPrimary: false })
            .where(and(eq(customerContacts.customerId, customerId), eq(customerContacts.isPrimary, true)));
        }
        const [row] = await tx
          .update(customerContacts)
          .set(input)
          .where(and(eq(customerContacts.id, contactId), eq(customerContacts.customerId, customerId)))
          .returning();
        return row ?? null;
      });
    },

    async deleteCustomerContact(customerId: string, contactId: string) {
      const [row] = await db
        .delete(customerContacts)
        .where(and(eq(customerContacts.id, contactId), eq(customerContacts.customerId, customerId)))
        .returning();
      return row ?? null;
    },

    // --- Delivery addresses (leveransadresser) — contact-pattern CRUD ---
    // An order's engångsadress (one_off) is not part of the customer's
    // register: hidden from the list and untouchable through these routes.
    // findDeliveryAddress returns it, so the service can let an order keep
    // its own one.

    async listDeliveryAddresses(customerId: string) {
      return db
        .select()
        .from(customerDeliveryAddresses)
        .where(and(eq(customerDeliveryAddresses.customerId, customerId), eq(customerDeliveryAddresses.oneOff, false)))
        .orderBy(desc(customerDeliveryAddresses.isDefault), asc(customerDeliveryAddresses.label));
    },

    async findDeliveryAddress(customerId: string, addressId: string) {
      const [row] = await db
        .select()
        .from(customerDeliveryAddresses)
        .where(and(eq(customerDeliveryAddresses.id, addressId), eq(customerDeliveryAddresses.customerId, customerId)));
      return row ?? null;
    },

    // Making an address default demotes the previous default in the same
    // transaction — otherwise the partial unique index rejects the write.
    async createDeliveryAddress(customerId: string, input: CreateDeliveryAddressInput) {
      return db.transaction(async (tx) => {
        if (input.isDefault) {
          await tx
            .update(customerDeliveryAddresses)
            .set({ isDefault: false })
            .where(
              and(eq(customerDeliveryAddresses.customerId, customerId), eq(customerDeliveryAddresses.isDefault, true))
            );
        }
        const [row] = await tx.insert(customerDeliveryAddresses).values({ ...input, customerId }).returning();
        return row!;
      });
    },

    async updateDeliveryAddress(customerId: string, addressId: string, input: UpdateDeliveryAddressInput) {
      return db.transaction(async (tx) => {
        if (input.isDefault === true) {
          await tx
            .update(customerDeliveryAddresses)
            .set({ isDefault: false })
            .where(
              and(eq(customerDeliveryAddresses.customerId, customerId), eq(customerDeliveryAddresses.isDefault, true))
            );
        }
        const [row] = await tx
          .update(customerDeliveryAddresses)
          .set(input)
          .where(
            and(
              eq(customerDeliveryAddresses.id, addressId),
              eq(customerDeliveryAddresses.customerId, customerId),
              eq(customerDeliveryAddresses.oneOff, false)
            )
          )
          .returning();
        return row ?? null;
      });
    },

    async deleteDeliveryAddress(customerId: string, addressId: string) {
      const [row] = await db
        .delete(customerDeliveryAddresses)
        .where(
          and(
            eq(customerDeliveryAddresses.id, addressId),
            eq(customerDeliveryAddresses.customerId, customerId),
            eq(customerDeliveryAddresses.oneOff, false)
          )
        )
        .returning();
      return row ?? null;
    },

    // Header fields editable while quote/confirmed/in_production (service guard).
    // Reservationen (Leveranstidskontroll → Skapa tillverkningsordrar): the
    // order's status read under its row lock, inside the caller's
    // transaction — the guard and the date write cannot straddle a
    // concurrent status change. null = no such order.
    async lockSalesOrderForHeader(tx: Tx, orderId: string) {
      const [row] = await tx
        .select({
          id: salesOrders.id,
          orderNumber: salesOrders.orderNumber,
          status: salesOrders.status,
          expectedDeliveryDate: salesOrders.expectedDeliveryDate,
        })
        .from(salesOrders)
        .where(eq(salesOrders.id, orderId))
        .for("update");
      return row ?? null;
    },

    // `dbc`: the reservation writes the date inside its own transaction.
    async updateSalesOrderHeader(orderId: string, input: UpdateSalesOrderHeaderInput, dbc: Db | Tx = db) {
      return writeSalesOrderHeader(dbc, orderId, input);
    },

    // Kostnadsställen och projekt: the one dimension rule (dimension-check.ts)
    // through this repository's connection.
    async resolveDimensions(input: DimensionInput, opts: ResolveDimensionsOptions = {}) {
      return resolveDimensions(db, input, opts);
    },

    // Header PATCH: the status guard is re-read under the order's row lock
    // (the service's own check is an unlocked pre-read), a Ny leveransadress
    // is created in the same transaction, and an engångsadress the order no
    // longer uses is deleted — nothing else can reference it, but the
    // NOT EXISTS keeps a second order pointing at it (only possible through
    // a bug) from losing its address.
    async updateSalesOrderHeaderWithAddress(orderId: string, input: UpdateSalesOrderHeaderInput) {
      return db.transaction(async (tx) => {
        const [order] = await tx
          .select({
            id: salesOrders.id,
            status: salesOrders.status,
            customerId: salesOrders.customerId,
            deliveryAddressId: salesOrders.deliveryAddressId,
            currency: salesOrders.currency,
          })
          .from(salesOrders)
          .where(eq(salesOrders.id, orderId))
          .for("update");
        if (!order) return { ok: false as const, reason: "not_found" as const };
        if (order.status !== "quote" && order.status !== "confirmed" && order.status !== "in_production") {
          return { ok: false as const, reason: "status" as const, status: order.status };
        }
        // Giltig t.o.m. is a quote's field — once confirmed the date is history.
        if (input.quoteValidUntil !== undefined && order.status !== "quote") {
          return { ok: false as const, reason: "status" as const, status: order.status };
        }
        // Valuta: currency and rate as a quote or a confirmed order only, and
        // a new currency only on an order without rows — read under the
        // order's lock. addRow reads the currency FOR KEY SHARE before its
        // insert, so a concurrent first row either commits first (and is
        // seen here: currency_locked) or waits for this and is refused when
        // the currency it was priced in is gone (sales-order-currency-changed).
        if ((input.currency !== undefined || input.exchangeRate !== undefined) && order.status !== "quote" && order.status !== "confirmed") {
          return { ok: false as const, reason: "status" as const, status: order.status };
        }
        if (input.currency !== undefined && input.currency !== order.currency) {
          const [row] = await tx
            .select({ id: salesOrderRows.id })
            .from(salesOrderRows)
            .where(eq(salesOrderRows.salesOrderId, orderId))
            .limit(1);
          if (row) return { ok: false as const, reason: "currency_locked" as const };
        }
        const { newDeliveryAddress, ...fields } = input;
        if (newDeliveryAddress) {
          fields.deliveryAddressId = (await insertNewDeliveryAddress(tx, order.customerId, newDeliveryAddress)).id;
        }
        const updated = await writeSalesOrderHeader(tx, orderId, fields);
        const previous = order.deliveryAddressId;
        if (fields.deliveryAddressId !== undefined && previous && previous !== fields.deliveryAddressId) {
          await tx
            .delete(customerDeliveryAddresses)
            .where(
              and(
                eq(customerDeliveryAddresses.id, previous),
                eq(customerDeliveryAddresses.oneOff, true),
                sql`not exists (select 1 from ${salesOrders} where ${salesOrders.deliveryAddressId} = ${previous})`
              )
            );
        }
        return { ok: true as const, order: updated! };
      });
    },

    // Atomic: the order header and all its rows are created together, per
    // architecture.md §5's "skapa offert med rader" contract.
    // quoteValidUntil is RESOLVED by the service (today + the setting, or
    // the caller's date; null for a direct order) — the repository writes
    // what it gets. `quoted` = created as a quote, the hit-rate population.
    async createQuote(
      input: Omit<CreateQuoteInput, "rows" | "quoteValidUntil" | "currency" | "exchangeRate"> & {
        rows: SalesRowWrite[];
        quoteValidUntil: string | null;
        // Valuta: resolved by the service (the customer's currency, today's rate).
        currency?: string;
        exchangeRate?: number;
      },
      createdBy: string | null,
      // Runs last inside the create transaction (Avvikelser: the case link of
      // Skapa ersättningsorder).
      inTx?: (tx: Tx, orderId: string) => Promise<unknown>
    ) {
      return db.transaction(async (tx) => {
        // Terms are snapshotted from the customer at creation (like the PO's
        // currency) — later changes on the customer card don't touch orders.
        const [customer] = await tx.select().from(customers).where(eq(customers.id, input.customerId));
        // Offerter (0138): a quote is numbered from its own series (OF-) and
        // carries the number twice — order_number (what every reader shows)
        // and quote_number (the reference that survives the confirmation).
        // A direct order (Ny kundorder) takes a KO- number and burns no OF-.
        const orderNumber = await getNextOrderNumber(tx, input.confirm ? "sales_order" : "quote");
        const deliveryAddressId = input.newDeliveryAddress
          ? (await insertNewDeliveryAddress(tx, input.customerId, input.newDeliveryAddress)).id
          : input.deliveryAddressId;
        const [order] = await tx
          .insert(salesOrders)
          .values({
            orderNumber,
            quoteNumber: input.confirm ? null : orderNumber,
            customerId: input.customerId,
            customerOrderNumber: input.customerOrderNumber,
            customerInquiryNumber: input.customerInquiryNumber,
            customerReference: input.customerReference,
            deliveryAddressId,
            deliveryTermId: customer?.deliveryTermId ?? null,
            paymentTermId: customer?.paymentTermId ?? null,
            carrierId: customer?.carrierId ?? null,
            expectedDeliveryDate: input.expectedDeliveryDate,
            note: input.note,
            quoted: !input.confirm,
            quoteValidUntil: input.quoteValidUntil,
            currency: input.currency ?? "SEK",
            exchangeRate: String(input.exchangeRate ?? 1),
            // Kostnadsställen och projekt (header) — validated by the service.
            costCenterId: input.costCenterId ?? null,
            projectId: input.projectId ?? null,
            createdBy,
          })
          .returning();

        // One statement for all rows ⇒ one defaultNow() (the transaction
        // start) for every created_at, and listRowsByOrder sorts on it — so
        // the rows are stamped a millisecond apart in input order (the same
        // fix as invoice.repository's createInvoice rows). Two configured rows
        // of the same template are legal, so the article is no tiebreaker.
        const now = Date.now();
        // A row with a Ställkostnad gets its id up front, so the charge row
        // right after it can point at it in the same statement.
        let stamp = 0;
        const rows = await tx
          .insert(salesOrderRows)
          .values(
            input.rows.flatMap((r) => {
              const id = r.setupCharge ? randomUUID() : undefined;
              const main = {
                ...(id ? { id } : {}),
                salesOrderId: order!.id,
                articleId: r.articleId,
                quantityOrdered: String(r.quantity),
                unitPrice: String(r.unitPrice),
                // discountPercent is optional on the input type (the price
                // chain fills it in when the service calls resolveRowInput,
                // but direct repository callers — e.g. pre-C3 tests — may omit
                // it entirely). String(undefined) would send the literal text
                // "undefined" to a numeric column; default to the column's own
                // "0" instead.
                discountPercent: String(r.discountPercent ?? 0),
                unitId: r.unitId,
                unitFactor: r.unitFactor !== null ? String(r.unitFactor) : null,
                configuration: r.configuration ?? null,
                configurationCost: r.configurationCost ?? null,
                // null = the row follows the order's Leveransdatum.
                expectedDeliveryDate: r.expectedDeliveryDate ?? null,
                createdAt: new Date(now + stamp++),
              };
              return id && r.setupCharge
                ? [main, setupChargeRowValues(order!.id, id, r.setupCharge, new Date(now + stamp++))]
                : [main];
            })
          )
          .returning();

        // Tillägg: quote.created. Ny kundorder (confirm) is confirmed by the
        // service right after, through updateStatus, which sends
        // sales_order.confirmed.
        if (!input.confirm) {
          await pluginEvents.emit(tx, { type: "quote.created", entityId: order!.id, entityNumber: order!.orderNumber });
        }
        if (inTx) await inTx(tx, order!.id);

        return { order: withDocumentKind(order!), rows };
      });
    },

    async findSalesOrderById(id: string) {
      const [row] = await db
        .select({
          ...getTableColumns(salesOrders),
          documentKind: documentKindSql,
          customerName: customers.name,
          // The order card's "Fakturera" points at the samlingsfakturering
          // routine instead of the invoice dialog for flagged customers.
          customerCollectiveInvoicing: customers.collectiveInvoicing,
          deliveryAddressLabel: customerDeliveryAddresses.label,
          deliveryAddress: customerDeliveryAddresses.address,
          deliveryPostalCode: customerDeliveryAddresses.postalCode,
          deliveryCity: customerDeliveryAddresses.city,
          deliveryCountry: customerDeliveryAddresses.country,
          // The order card shows an engångsadress, which the customer's
          // address list (its picker) does not carry.
          deliveryAddressOneOff: customerDeliveryAddresses.oneOff,
          deliveryTermCode: deliveryTerms.code,
          deliveryTermName: deliveryTerms.name,
          paymentTermCode: paymentTerms.code,
          paymentTermName: paymentTerms.name,
          carrierCode: carriers.code,
          carrierName: carriers.name,
          // Förlorad: the reason's code/name and who marked it (null unless lost).
          lostReasonCode: quoteLossReasons.code,
          lostReasonName: quoteLossReasons.name,
          lostByName: lostByUser.name,
          // Kostnadsställen och projekt: the header's objects for the card.
          costCenter: { id: orderCostCenters.id, code: orderCostCenters.code, name: orderCostCenters.name },
          project: { id: orderProjects.id, code: orderProjects.code, name: orderProjects.name },
        })
        .from(salesOrders)
        .innerJoin(customers, eq(customers.id, salesOrders.customerId))
        .leftJoin(customerDeliveryAddresses, eq(customerDeliveryAddresses.id, salesOrders.deliveryAddressId))
        .leftJoin(deliveryTerms, eq(deliveryTerms.id, salesOrders.deliveryTermId))
        .leftJoin(paymentTerms, eq(paymentTerms.id, salesOrders.paymentTermId))
        .leftJoin(carriers, eq(carriers.id, salesOrders.carrierId))
        .leftJoin(quoteLossReasons, eq(quoteLossReasons.id, salesOrders.lostReasonId))
        .leftJoin(lostByUser, eq(lostByUser.id, salesOrders.lostBy))
        .leftJoin(orderCostCenters, eq(orderCostCenters.id, salesOrders.costCenterId))
        .leftJoin(orderProjects, eq(orderProjects.id, salesOrders.projectId))
        .where(eq(salesOrders.id, id));
      return row ?? null;
    },

    async listSalesOrders(query: ListSalesOrdersQuery) {
      const conditions = [];
      if (query.search) {
        const pattern = ilikePattern(query.search);
        // Also matches on the order's own rows — an article number/name, not
        // just the order number/customer — mirrors listPurchaseOrders' EXISTS
        // search.
        conditions.push(
          or(
            ilike(salesOrders.orderNumber, pattern),
            // A confirmed quote is still found on its OF- number.
            ilike(salesOrders.quoteNumber, pattern),
            ilike(customers.name, pattern),
            exists(
              db
                .select({ one: sql`1` })
                .from(salesOrderRows)
                .innerJoin(articles, eq(articles.id, salesOrderRows.articleId))
                .where(
                  and(
                    eq(salesOrderRows.salesOrderId, salesOrders.id),
                    or(ilike(articles.articleNumber, pattern), ilike(articles.name, pattern))
                  )
                )
            )
          )
        );
      }
      if (query.status) conditions.push(inArray(salesOrders.status, query.status));
      if (query.kind) conditions.push(sql`${documentKindSql} = ${query.kind}`);
      const where = conditions.length > 0 ? and(...conditions) : undefined;

      // Correlated-subquery shape as listPurchaseOrders' openRowCount —
      // opt-in (withOpenRows) so the plain register list doesn't pay for it.
      const openRowCountSql = sql<number>`(select count(*)::int from ${salesOrderRows} r where r.sales_order_id = ${salesOrders}.id and r.quantity_delivered < r.quantity_ordered)`;
      // Nästa leveransdatum: the earliest effective date among rows not
      // fully delivered, else the order's own — same rule as
      // listPurchaseOrders, so one early row shows the order late.
      const nextDeliveryDateSql = sql<string | null>`coalesce((select min(coalesce(r.expected_delivery_date, ${salesOrders.expectedDeliveryDate})) from ${salesOrderRows} r where r.sales_order_id = ${salesOrders}.id and r.quantity_delivered < r.quantity_ordered), ${salesOrders.expectedDeliveryDate})`;

      // The stored Sendify answer (freight_quote jsonb) is detail-only —
      // the register list would otherwise ship it on every row.
      const { freightQuote: _freightQuote, ...listColumns } = getTableColumns(salesOrders);

      const [rows, totalRows] = await Promise.all([
        db
          .select({
            ...listColumns,
            documentKind: documentKindSql,
            customerName: customers.name,
            nextDeliveryDate: nextDeliveryDateSql,
            lostReasonCode: quoteLossReasons.code,
            lostReasonName: quoteLossReasons.name,
            lostByName: lostByUser.name,
            ...(query.withOpenRows ? { openRowCount: openRowCountSql } : {}),
          })
          .from(salesOrders)
          .innerJoin(customers, eq(customers.id, salesOrders.customerId))
          .leftJoin(quoteLossReasons, eq(quoteLossReasons.id, salesOrders.lostReasonId))
          .leftJoin(lostByUser, eq(lostByUser.id, salesOrders.lostBy))
          .where(where)
          .orderBy(desc(salesOrders.orderNumber))
          .limit(query.limit)
          .offset(query.offset),
        db
          .select({ total: count() })
          .from(salesOrders)
          .innerJoin(customers, eq(customers.id, salesOrders.customerId))
          .where(where),
      ]);
      return { rows, total: totalRows[0]!.total };
    },

    // State-machine transitions and the manual override. Leaving `lost`
    // clears the lost_* columns (Öppna igen's rule applies to setStatus
    // too); entering it through the override stamps when/who without a
    // reason — "Ingen orsak angiven" — unless the order already is lost.
    // fromStatus makes the update conditional (null = the order had moved on),
    // so a confirm cannot overwrite a concurrent Förlorad and vice versa.
    //
    // Offerter (0138): the one writer of a quote → order transition (Bekräfta,
    // the order confirmation mail, setStatus and create-with-confirm all come
    // through here), so it also hands out the KO- number: an order status on
    // a row still numbered by its quote (order_number = quote_number) takes
    // the next sales_order number, quote_number stays as the reference. The
    // row is locked first and the number drawn only when the transition
    // really happens — a failed fromStatus burns nothing, and a concurrent
    // second transition sees the new number and draws none.
    async updateStatus(id: string, status: SalesOrderStatus, lostBy: string | null = null, fromStatus?: SalesOrderStatus) {
      return db.transaction(async (tx) => {
        const [current] = await tx
          .select({ status: salesOrders.status, orderNumber: salesOrders.orderNumber, quoteNumber: salesOrders.quoteNumber })
          .from(salesOrders)
          .where(eq(salesOrders.id, id))
          .for("update");
        if (!current || (fromStatus && current.status !== fromStatus)) return null;
        const numberedAsQuote = current.quoteNumber !== null && current.orderNumber === current.quoteNumber;
        // A quote that ends as Förlorad/Makulerad goes back to its OF- number
        // — it may hold a KO- number reserved by a confirmation send that
        // failed (reserveOrderNumber), which is then left unused.
        const endsAsQuote =
          (status === "lost" || status === "cancelled") &&
          (current.status === "quote" || current.status === "lost") &&
          current.quoteNumber !== null &&
          !numberedAsQuote;
        const orderNumber =
          ORDER_STATUSES.includes(status) && numberedAsQuote
            ? await getNextOrderNumber(tx, "sales_order")
            : endsAsQuote
              ? current.quoteNumber!
              : undefined;
        const [row] = await tx
          .update(salesOrders)
          .set(
            status === "lost"
              ? {
                  status,
                  orderNumber,
                  lostAt: sql`coalesce(${salesOrders.lostAt}, now())`,
                  lostBy: sql`coalesce(${salesOrders.lostBy}, ${lostBy}::uuid)`,
                  updatedAt: new Date(),
                }
              : { status, orderNumber, lostReasonId: null, lostNote: null, lostAt: null, lostBy: null, updatedAt: new Date() }
          )
          .where(eq(salesOrders.id, id))
          .returning();
        // Tillägg: every way from an offert to an order status runs through
        // here (Bekräfta, the order confirmation mail, a manual status — also
        // from Förlorad or a cancelled offert), and so does every
        // cancellation. The document kind before the change decides
        // (salesDocumentKind): an offert reaching an order status is
        // confirmed; only an ORDER being cancelled is a cancelled order —
        // a cancelled offert is not, and an order already cancelled sends
        // nothing again.
        const kindBefore = salesDocumentKind(current);
        if (row && kindBefore === "quote" && ORDER_STATUSES.includes(status)) {
          await pluginEvents.emit(tx, { type: "sales_order.confirmed", entityId: row.id, entityNumber: row.orderNumber });
        }
        if (row && status === "cancelled" && current.status !== "cancelled" && kindBefore === "order") {
          await pluginEvents.emit(tx, { type: "sales_order.cancelled", entityId: row.id, entityNumber: row.orderNumber });
        }
        return row ? withDocumentKind(row) : null;
      });
    },

    // The order confirmation mail confirms the quote only AFTER the send
    // succeeded, yet the attached confirmation must already carry the KO-
    // number. So the mail path reserves it first: a quote still numbered by
    // its OF- number gets the next sales_order number written to
    // order_number (status stays quote; updateStatus then draws none).
    // Returns the number the confirmation carries — reserved now, or earlier
    // by a send that failed or is still in flight (the reservation is kept so
    // a retry or a concurrent send prints the same number) — and null when
    // the order is no longer a quote.
    async reserveOrderNumber(id: string): Promise<string | null> {
      return db.transaction(async (tx) => {
        const [current] = await tx
          .select({ status: salesOrders.status, orderNumber: salesOrders.orderNumber, quoteNumber: salesOrders.quoteNumber })
          .from(salesOrders)
          .where(eq(salesOrders.id, id))
          .for("update");
        if (!current || current.status !== "quote") return null;
        if (current.quoteNumber === null || current.orderNumber !== current.quoteNumber) return current.orderNumber;
        const orderNumber = await getNextOrderNumber(tx, "sales_order");
        await tx.update(salesOrders).set({ orderNumber, updatedAt: new Date() }).where(eq(salesOrders.id, id));
        return orderNumber;
      });
    },

    // Förlorad: conditional on status quote so a concurrent confirm/cancel
    // cannot be overwritten — null = the order is no longer a quote (or gone).
    async markLost(id: string, input: { reasonId: string; note: string | null; userId: string | null }) {
      const [row] = await db
        .update(salesOrders)
        .set({
          status: "lost",
          orderNumber: sql`coalesce(${salesOrders.quoteNumber}, ${salesOrders.orderNumber})`,
          lostReasonId: input.reasonId,
          lostNote: input.note,
          lostAt: new Date(),
          lostBy: input.userId,
          updatedAt: new Date(),
        })
        .where(and(eq(salesOrders.id, id), eq(salesOrders.status, "quote")))
        .returning();
      return row ? withDocumentKind(row) : null;
    },

    // Öppna igen: back to quote with the lost_* columns cleared; the
    // validity date is left as it is (the user sees it on the card). null =
    // not lost any more (or gone).
    async reopenLost(id: string) {
      const [row] = await db
        .update(salesOrders)
        .set({ status: "quote", lostReasonId: null, lostNote: null, lostAt: null, lostBy: null, updatedAt: new Date() })
        .where(and(eq(salesOrders.id, id), eq(salesOrders.status, "lost")))
        .returning();
      return row ? withDocumentKind(row) : null;
    },

    // invoiceOrder was removed in C1 — the invoice module (invoice.repository.ts)
    // now assigns the FA number, on the invoices table rather than the order.

    // Valuta: `pricedIn` is the order currency the service priced the row
    // in (read before this transaction). The order is read FOR KEY SHARE
    // first — the header PATCH changes the currency under FOR UPDATE, which
    // this waits for (and vice versa: a PATCH waits for this row and then
    // sees it, sales-order-currency-locked) — so a row priced in the old
    // currency never lands on an order in a new one. KEY SHARE, not SHARE:
    // two concurrent addRows both bump the revision (an UPDATE of the order,
    // FOR NO KEY UPDATE), which a held FOR SHARE would deadlock. Only the
    // order is locked here (no row exists yet), so the rad → huvud order of
    // updateRow/replaceRowConfiguration is not crossed.
    async addRow(salesOrderId: string, input: SalesRowWrite, pricedIn?: string) {
      return db.transaction(async (tx) => {
        if (pricedIn !== undefined) {
          const [order] = await tx
            .select({ orderNumber: salesOrders.orderNumber, currency: salesOrders.currency })
            .from(salesOrders)
            .where(eq(salesOrders.id, salesOrderId))
            .for("key share");
          if (order && order.currency !== pricedIn) throw new SalesOrderCurrencyChangedError(order.orderNumber, pricedIn, order.currency);
        }
        const [row] = await tx
          .insert(salesOrderRows)
          .values({
            salesOrderId,
            articleId: input.articleId,
            quantityOrdered: String(input.quantity),
            unitPrice: String(input.unitPrice),
            // Same optional-input guard as createQuote above.
            discountPercent: String(input.discountPercent ?? 0),
            unitId: input.unitId,
            unitFactor: input.unitFactor !== null ? String(input.unitFactor) : null,
            configuration: input.configuration ?? null,
            configurationCost: input.configurationCost ?? null,
            expectedDeliveryDate: input.expectedDeliveryDate ?? null,
          })
          .returning();
        if (input.setupCharge) {
          await tx
            .insert(salesOrderRows)
            .values(setupChargeRowValues(salesOrderId, row!.id, input.setupCharge, new Date(row!.createdAt.getTime() + 1)));
        }
        if (input.bumpRevision !== false) await bumpRevision(tx, salesOrderId);
        return row!;
      });
    },

    async findRowById(rowId: string) {
      const [row] = await db.select().from(salesOrderRows).where(eq(salesOrderRows.id, rowId));
      return row ?? null;
    },

    // E3 (KO→TO-koppling): the manufacturing service's pre-tx read — joins
    // in exactly what it needs to validate a TO-against-KO-row link
    // (order status, article type) and to show the customer on the TO card.
    async findRowForManufacturing(rowId: string): Promise<SalesOrderRowForManufacturing | null> {
      const [row] = await db
        .select({
          id: salesOrderRows.id,
          salesOrderId: salesOrderRows.salesOrderId,
          orderNumber: salesOrders.orderNumber,
          orderStatus: salesOrders.status,
          customerName: customers.name,
          customerOrderNumber: salesOrders.customerOrderNumber,
          articleId: salesOrderRows.articleId,
          articleType: articles.type,
          quantityOrdered: salesOrderRows.quantityOrdered,
          configuration: salesOrderRows.configuration,
          customerPalletCardCode: customers.palletCardCode,
          deliveryAddress: customerDeliveryAddresses.address,
          deliveryPostalCode: customerDeliveryAddresses.postalCode,
          deliveryCity: customerDeliveryAddresses.city,
          deliveryCountry: customerDeliveryAddresses.country,
        })
        .from(salesOrderRows)
        .innerJoin(salesOrders, eq(salesOrders.id, salesOrderRows.salesOrderId))
        .innerJoin(customers, eq(customers.id, salesOrders.customerId))
        .innerJoin(articles, eq(articles.id, salesOrderRows.articleId))
        .leftJoin(customerDeliveryAddresses, eq(customerDeliveryAddresses.id, salesOrders.deliveryAddressId))
        .where(eq(salesOrderRows.id, rowId));
      if (!row) return null;
      const { deliveryAddress, deliveryPostalCode, deliveryCity, deliveryCountry, ...rest } = row;
      return {
        ...rest,
        quantityOrdered: Number(row.quantityOrdered),
        configuration: (row.configuration as OrderRowConfiguration | null) ?? null,
        deliveryAddress: deliveryAddress
          ? { address: deliveryAddress, postalCode: deliveryPostalCode, city: deliveryCity, country: deliveryCountry }
          : null,
      };
    },

    // Konfigurator 4c: the row a configured TO is created from, locked FOR
    // UPDATE inside the TO's own transaction — the same row lock Ändra
    // konfiguration takes first (rowConfigurationGuards), so the two
    // serialise: either the TO sees the new key and refuses, or Ändra
    // konfiguration sees the TO and refuses. Row before order, as there.
    async lockRowForManufacturing(
      tx: Tx,
      rowId: string
    ): Promise<{ configurationKey: string | null; quantityOrdered: number; quantityDelivered: number } | null> {
      const [row] = await tx
        .select({
          configuration: salesOrderRows.configuration,
          quantityOrdered: salesOrderRows.quantityOrdered,
          quantityDelivered: salesOrderRows.quantityDelivered,
        })
        .from(salesOrderRows)
        .where(eq(salesOrderRows.id, rowId))
        .for("update");
      if (!row) return null;
      return {
        configurationKey: (row.configuration as OrderRowConfiguration | null)?.key ?? null,
        quantityOrdered: Number(row.quantityOrdered),
        quantityDelivered: Number(row.quantityDelivered),
      };
    },

    // Atomic like deliverGoods: locks the row so a concurrent delivery can't
    // slip past the quantity-vs-delivered guard, then recomputes the order
    // status — lowering a quantity to exactly what's delivered can complete
    // an in-production order.
    async updateRow(
      orderId: string,
      rowId: string,
      // Konfigurator 4b: the service hands a re-evaluated configuration along
      // when a quantity change repriced a configured row; undefined leaves
      // the stored one as it is. 4c: likewise the förkalkyl at the new
      // quantity (configurationCost; undefined = untouched, null = unknown).
      patch: Omit<UpdateSalesOrderRowInput, "unitId" | "bumpRevision"> &
        Partial<UnitSnapshot> & { configuration?: OrderRowConfiguration; configurationCost?: OrderRowConfigurationCost | null },
      bump = true
    ): Promise<SalesRowMutationResult> {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(salesOrderRows)
          .where(and(eq(salesOrderRows.id, rowId), eq(salesOrderRows.salesOrderId, orderId)))
          .for("update");
        if (!row) return { ok: false, reason: "row_not_found" };
        // An over-delivered row (#24) holds more delivered than ordered: an
        // edit that resends the same quantity (the card always sends it) is
        // no reduction and must not be refused.
        if (
          patch.quantity !== undefined &&
          patch.quantity !== Number(row.quantityOrdered) &&
          patch.quantity < Number(row.quantityDelivered)
        ) {
          return { ok: false, reason: "quantity_below_delivered" };
        }

        const set: {
          quantityOrdered?: string;
          unitPrice?: string;
          discountPercent?: string;
          unitId?: string | null;
          unitFactor?: string | null;
          configuration?: OrderRowConfiguration;
          configurationCost?: OrderRowConfigurationCost | null;
          expectedDeliveryDate?: string | null;
        } = {};
        if (patch.quantity !== undefined) set.quantityOrdered = String(patch.quantity);
        if (patch.unitPrice !== undefined) set.unitPrice = String(patch.unitPrice);
        if (patch.discountPercent !== undefined) set.discountPercent = String(patch.discountPercent);
        if (patch.unitId !== undefined) set.unitId = patch.unitId;
        if (patch.unitFactor !== undefined) set.unitFactor = patch.unitFactor !== null ? String(patch.unitFactor) : null;
        if (patch.configuration !== undefined) set.configuration = patch.configuration;
        if (patch.configurationCost !== undefined) set.configurationCost = patch.configurationCost;
        if (patch.expectedDeliveryDate !== undefined) set.expectedDeliveryDate = patch.expectedDeliveryDate;
        const [updated] = await tx.update(salesOrderRows).set(set).where(eq(salesOrderRows.id, rowId)).returning();

        if (bump) await bumpRevision(tx, orderId);
        const orderStatus = await recomputeInProduction(tx, orderId);
        return { ok: true, row: updated!, orderStatus };
      });
    },

    // Ändra konfiguration (4b), the variant branch's pre-read: the same four
    // guards as replaceRowConfiguration, WITHOUT a lock and outside any
    // transaction. The service runs it before resolveVariant so a refusal
    // (invoice row, delivery, live TO, order status) is raised before a stray
    // variant article gets created; it is advisory only — the locked
    // re-check inside replaceRowConfiguration stays the authority.
    async readRowConfigurationLock(orderId: string, rowId: string): Promise<RowConfigurationMutationResult> {
      const found = await rowConfigurationGuards(db, orderId, rowId, false);
      if (!found.ok) return found;
      return { ok: true, row: found.row, previous: found.row, orderStatus: found.orderStatus };
    },

    // Ändra konfiguration (4b): every guard is re-checked INSIDE the
    // transaction with the row locked (the service's pre-reads are advisory),
    // then article/configuration/price are replaced in one UPDATE. The unique
    // index (a variant already on the order as an ordinary row) is caught
    // OUTSIDE db.transaction — a failed statement leaves the transaction
    // aborted, so the error must propagate out before being mapped.
    async replaceRowConfiguration(
      orderId: string,
      rowId: string,
      patch: {
        articleId: string;
        configuration: OrderRowConfiguration | null;
        // 4c: the new configuration's förkalkyl; null on a variant row.
        configurationCost: OrderRowConfigurationCost | null;
        unitPrice: number;
        discountPercent: number;
      },
      bump = true
    ): Promise<RowConfigurationMutationResult> {
      try {
        return await db.transaction(async (tx) => {
          const found = await rowConfigurationGuards(tx, orderId, rowId, true);
          if (!found.ok) return found;

          const [updated] = await tx
            .update(salesOrderRows)
            .set({
              articleId: patch.articleId,
              configuration: patch.configuration,
              configurationCost: patch.configurationCost,
              unitPrice: String(patch.unitPrice),
              discountPercent: String(patch.discountPercent),
            })
            .where(eq(salesOrderRows.id, rowId))
            .returning();
          if (bump) await bumpRevision(tx, orderId);
          const orderStatus = await recomputeInProduction(tx, orderId);
          return { ok: true, row: updated!, previous: found.row, orderStatus };
        });
      } catch (err) {
        if (isUniqueViolation(err, ROW_ARTICLE_UNIQUE)) return { ok: false, reason: "variant_exists" };
        throw err;
      }
    },

    async deleteRow(orderId: string, rowId: string, bump = true): Promise<SalesRowMutationResult> {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(salesOrderRows)
          .where(and(eq(salesOrderRows.id, rowId), eq(salesOrderRows.salesOrderId, orderId)))
          .for("update");
        if (!row) return { ok: false, reason: "row_not_found" };
        if (Number(row.quantityDelivered) > 0) return { ok: false, reason: "row_has_deliveries" };
        // The row's own Ställkostnad goes with it while undelivered; a
        // delivered one stays as a plain row (setup_for_row_id set null).
        await tx
          .delete(salesOrderRows)
          .where(and(eq(salesOrderRows.setupForRowId, rowId), eq(salesOrderRows.quantityDelivered, "0")));

        // E3: a linked (non-deleted) manufacturing_orders row blocks this
        // DELETE via its restrict FK — caught right here where it's thrown,
        // rather than left to bubble out of db.transaction uncaught. Three
        // restrict FKs can fire on this same DELETE (manufacturing_orders,
        // delivery_rows, invoice_rows) — the quantityDelivered guard above
        // already rules the other two out in practice, but that's an
        // undocumented coincidence, not a guarantee a future delivery/invoice
        // change couldn't break, so the constraint name is checked
        // explicitly rather than assuming any 23503 here means an MO link.
        try {
          await tx.delete(salesOrderRows).where(eq(salesOrderRows.id, rowId));
        } catch (err) {
          if (isForeignKeyViolation(err, "manufacturing_orders_sales_order_row_id_sales_order_rows_id_fk")) {
            throw new RowHasManufacturingOrdersError();
          }
          throw err;
        }

        if (bump) await bumpRevision(tx, orderId);
        const orderStatus = await recomputeInProduction(tx, orderId);
        return { ok: true, row: null, orderStatus };
      });
    },

    // Frakt etapp 2: the shipment (if any) that already bills this order's
    // freight through an invoice row — reached over a LIVE följesedel link
    // (shipment_deliveries.active; an avbokad shipment's link is inactive and
    // does not count). Cancelled drafts release their shipment link, so a hit
    // is always a draft/issued/paid invoice. Cross-module read of the shipping
    // and invoice tables, like invoice.repository's shipment reads.
    async invoicedShipmentForOrder(salesOrderId: string) {
      const [row] = await db
        .select({ shipmentId: shipments.id, shipmentNumber: shipments.shipmentNumber })
        .from(invoiceRows)
        .innerJoin(shipments, eq(shipments.id, invoiceRows.shipmentId))
        .innerJoin(
          shipmentDeliveries,
          and(eq(shipmentDeliveries.shipmentId, shipments.id), eq(shipmentDeliveries.active, true))
        )
        .innerJoin(deliveries, eq(deliveries.id, shipmentDeliveries.deliveryId))
        .where(eq(deliveries.salesOrderId, salesOrderId))
        .orderBy(asc(shipments.shipmentNumber))
        .limit(1);
      return row ?? null;
    },

    async listRowsByOrder(salesOrderId: string) {
      const rowUnits = alias(units, "row_units");
      return db
        .select({
          ...getTableColumns(salesOrderRows),
          articleNumber: articles.articleNumber,
          articleName: articles.name,
          // E3: the row's "Skapa tillverkningsorder" action is only offered
          // for manufactured articles — the web card needs the type to
          // decide that without a second round-trip.
          articleType: articles.type,
          // Printed as the articleInfo line on the quote/confirmation PDF
          // (renderSalesOrderPdf) via formatArticleAttributes — NOT on the
          // invoice PDF, which shares this same row query.
          articleSurfaceTreatment: articles.surfaceTreatment,
          articleColour: articles.colour,
          // Extra benämning — printed on the documents the setting lists.
          articleExtraDescription: articles.extraDescription,
          // Privatperson documents gross the printed prices up by this rate.
          articleVatRate: articleVatRateSql,
          // The unit the row displays in: the entered unit, falling back to
          // the article's base unit.
          unitCode: sql<string>`coalesce(${rowUnits.code}, ${units.code})`,
          // Konfigurator 4b (Avvikelse 7): the row's article is a stocked
          // variant of this template — the card offers Ändra konfiguration
          // on it without a second call. null = plain article (or a
          // beställningsvara row, whose template is in `configuration`).
          variantTemplateArticleId: configuratorVariants.templateArticleId,
        })
        .from(salesOrderRows)
        .innerJoin(articles, eq(articles.id, salesOrderRows.articleId))
        .innerJoin(units, eq(units.id, articles.unitId))
        .leftJoin(rowUnits, eq(rowUnits.id, salesOrderRows.unitId))
        .leftJoin(configuratorVariants, eq(configuratorVariants.articleId, salesOrderRows.articleId))
        .where(eq(salesOrderRows.salesOrderId, salesOrderId))
        // id as tiebreaker: rows written before the per-row createdAt stamp
        // in createQuote share a timestamp, and the card/PDF order must still
        // be stable between two reads.
        .orderBy(asc(salesOrderRows.createdAt), asc(salesOrderRows.id));
    },

    // Atomic across the whole batch: validates order status once, then runs
    // each row through the same lock/guard/booking sequence the old
    // single-row deliverGoods used (see the DeliverBatchResult comment
    // above), allocates ONE delivery number (document series — inside this
    // tx, like createQuote's order number: a failed insert must not burn a
    // number) and writes ONE deliveries row + one delivery_rows row per
    // delivered row, then recomputes the order status once at the end. Any
    // row failing aborts the whole transaction — no delivery, no
    // delivery_rows, no stock_transactions, no quantity_delivered changes.
    //
    // overDeliveryPercent: Tillåten överleverans for the order's customer
    // (effectiveOverDeliveryPercent, read by the service before the
    // transaction — a settings change racing a delivery may go either way,
    // as for purchase receipts). null = no limit; omitted = 0, never more
    // than ordered.
    async deliverBatch(
      orderId: string,
      input: {
        locationId?: string;
        rows: { rowId: string; quantity: number }[];
        createdBy: string;
        overDeliveryPercent?: number | null;
      }
    ): Promise<DeliverBatchResult> {
      const overDeliveryPercent = input.overDeliveryPercent === undefined ? 0 : input.overDeliveryPercent;
      try {
        return await db.transaction(async (tx) => {
          const [order] = await tx.select().from(salesOrders).where(eq(salesOrders.id, orderId));
          if (!order) throw new BatchOrderNotFoundError();
          if (order.status !== "in_production") {
            throw new BatchInvalidStatusError();
          }

          const updatedRows: (typeof salesOrderRows.$inferSelect)[] = [];
          // Ångra utleverans: where each row's goods were taken from and the
          // movement that took them, written on its delivery_rows row below.
          const links: { locationId: string; stockTransactionId: string }[] = [];
          for (const r of input.rows) {
            const [row] = await tx
              .select()
              .from(salesOrderRows)
              .where(and(eq(salesOrderRows.id, r.rowId), eq(salesOrderRows.salesOrderId, orderId)))
              .for("update");
            if (!row) throw new BatchRowNotFoundError(r.rowId);

            const newDelivered = Number(row.quantityDelivered) + r.quantity;
            if (overDeliveryPercent !== null) {
              const maxQuantity = round4(Number(row.quantityOrdered) * (1 + overDeliveryPercent / 100));
              if (newDelivered > maxQuantity + 0.00005) throw new BatchOverDeliveryError(r.rowId, maxQuantity);
            }

            const [updatedRow] = await tx
              .update(salesOrderRows)
              .set({ quantityDelivered: String(newDelivered) })
              .where(eq(salesOrderRows.id, r.rowId))
              .returning();

            const locationId = await resolveStockLocation(tx, row.articleId, input.locationId);
            await assertLocationNotUnderCount(tx, locationId);
            const [movement] = await tx
              .insert(stockTransactions)
              .values({
                articleId: row.articleId,
                locationId,
                quantityDelta: String(-r.quantity),
                transactionType: "sales_delivery",
                referenceId: orderId,
                createdBy: input.createdBy,
              })
              .returning({ id: stockTransactions.id });
            links.push({ locationId, stockTransactionId: movement!.id });
            // The delivery may have emptied the location.
            await deactivateEmptyLocation(tx, locationId);

            updatedRows.push(updatedRow!);
          }

          // Document series — allocated inside the tx so a rollback (e.g. a
          // later row's over-delivery) also rolls back the number, same
          // convention as createQuote's order number.
          const deliveryNumber = await getNextOrderNumber(tx, "delivery");
          const [delivery] = await tx
            .insert(deliveries)
            .values({ salesOrderId: orderId, deliveryNumber, createdBy: input.createdBy })
            .returning();
          await tx.insert(deliveryRows).values(
            input.rows.map((r, i) => ({
              deliveryId: delivery!.id,
              salesOrderRowId: r.rowId,
              quantity: String(r.quantity),
              locationId: links[i]!.locationId,
              stockTransactionId: links[i]!.stockTransactionId,
            }))
          );

          const allRows = await tx.select().from(salesOrderRows).where(eq(salesOrderRows.salesOrderId, orderId));
          const allDelivered = allRows.every((r) => Number(r.quantityDelivered) >= Number(r.quantityOrdered));
          const orderStatus: SalesOrderStatus = allDelivered ? "delivered" : order.status;

          if (allDelivered) {
            await tx
              .update(salesOrders)
              .set({ status: orderStatus, updatedAt: new Date() })
              .where(eq(salesOrders.id, orderId));
          }

          // Tillägg: one event per följesedel, on the order.
          await pluginEvents.emit(tx, {
            type: "sales_order.delivered",
            entityId: orderId,
            entityNumber: order.orderNumber,
            data: { deliveryId: delivery!.id, deliveryNumber },
          });

          return { ok: true, deliveryId: delivery!.id, deliveryNumber, orderStatus, rows: updatedRows };
        });
      } catch (err) {
        if (err instanceof BatchOrderNotFoundError) return { ok: false, reason: "order_not_found" };
        if (err instanceof BatchInvalidStatusError) return { ok: false, reason: "invalid_status" };
        if (err instanceof BatchRowNotFoundError) return { ok: false, reason: "row_not_found", rowId: err.rowId };
        if (err instanceof BatchOverDeliveryError) {
          return { ok: false, reason: "over_delivery", rowId: err.rowId, maxQuantity: err.maxQuantity };
        }
        throw err;
      }
    },

    // Ångra utleverans: reverses ONE delivery row in one transaction — the
    // goods back to the location they were taken from (a positive
    // sales_delivery movement without unit_cost, so the moving average only
    // sees the quantity), the order row's delivered quantity down, the order
    // status re-derived (Levererad → Under tillverkning) and the row stamped
    // undone. Refused while the följesedel is on a live shipment and when
    // the order row would end up delivered below what is invoiced — drafts
    // included (the user's decision: a draft must stay issuable). Lock order
    // följesedel → delivery row → order row → order: row → order is the
    // order deliverBatch, updateRow and invoice issue take; the följesedel
    // lock first serialises against a shipment being created for it (its
    // link insert takes FOR KEY SHARE, and insertShipment/addDeliveryLink
    // lock it FOR SHARE).
    async undoDeliveryRow(
      orderId: string,
      deliveryId: string,
      deliveryRowId: string,
      input: { undoneBy: string }
    ): Promise<UndoDeliveryRowResult> {
      return db.transaction(async (tx) => {
        const [delivery] = await tx
          .select()
          .from(deliveries)
          .where(and(eq(deliveries.id, deliveryId), eq(deliveries.salesOrderId, orderId)))
          .for("update");
        if (!delivery) return { ok: false, reason: "delivery_not_found" };

        const [deliveryRow] = await tx
          .select()
          .from(deliveryRows)
          .where(and(eq(deliveryRows.id, deliveryRowId), eq(deliveryRows.deliveryId, deliveryId)))
          .for("update");
        if (!deliveryRow) return { ok: false, reason: "row_not_found" };
        if (deliveryRow.undoneAt) return { ok: false, reason: "already_undone" };
        if (!deliveryRow.stockTransactionId || !deliveryRow.locationId) return { ok: false, reason: "not_undoable" };

        const [orderRow] = await tx
          .select()
          .from(salesOrderRows)
          .where(eq(salesOrderRows.id, deliveryRow.salesOrderRowId))
          .for("update");
        const [order] = await tx.select().from(salesOrders).where(eq(salesOrders.id, orderId)).for("update");
        if (!orderRow || !order) return { ok: false, reason: "row_not_found" };
        if (order.status !== "in_production" && order.status !== "delivered") {
          return { ok: false, reason: "invalid_status", status: order.status };
        }

        const [shipment] = await tx
          .select({ shipmentNumber: shipments.shipmentNumber })
          .from(shipmentDeliveries)
          .innerJoin(shipments, eq(shipments.id, shipmentDeliveries.shipmentId))
          .where(and(eq(shipmentDeliveries.deliveryId, deliveryId), eq(shipmentDeliveries.active, true)));
        if (shipment) return { ok: false, reason: "on_shipment", shipmentNumber: shipment.shipmentNumber };

        const quantity = Number(deliveryRow.quantity);
        const deliveredAfter = Math.max(round4(Number(orderRow.quantityDelivered) - quantity), 0);
        const invoiced = (await getInvoicedQuantitiesWith(tx, [orderRow.id], { includeDrafts: true })).get(orderRow.id) ?? 0;
        if (round4(invoiced) > deliveredAfter) return { ok: false, reason: "invoiced", invoiced, deliveredAfter };

        // An explicit location is reactivated if the delivery emptied it.
        const locationId = await resolveStockLocation(tx, orderRow.articleId, deliveryRow.locationId);
        await assertLocationNotUnderCount(tx, locationId);
        await tx.insert(stockTransactions).values({
          articleId: orderRow.articleId,
          locationId,
          quantityDelta: String(quantity),
          transactionType: "sales_delivery",
          referenceId: orderId,
          createdBy: input.undoneBy,
        });

        await tx
          .update(salesOrderRows)
          .set({ quantityDelivered: String(deliveredAfter) })
          .where(eq(salesOrderRows.id, orderRow.id));
        const [undone] = await tx
          .update(deliveryRows)
          .set({ undoneAt: new Date(), undoneBy: input.undoneBy })
          .where(eq(deliveryRows.id, deliveryRow.id))
          .returning();

        let orderStatus: SalesOrderStatus = order.status;
        if (order.status === "delivered") {
          const allRows = await tx.select().from(salesOrderRows).where(eq(salesOrderRows.salesOrderId, orderId));
          if (!allRows.every((r) => Number(r.quantityDelivered) >= Number(r.quantityOrdered))) {
            orderStatus = "in_production";
            await tx.update(salesOrders).set({ status: orderStatus, updatedAt: new Date() }).where(eq(salesOrders.id, orderId));
          }
        }

        return {
          ok: true,
          deliveryRow: undone!,
          deliveryNumber: delivery.deliveryNumber,
          orderNumber: order.orderNumber,
          articleId: orderRow.articleId,
          locationId,
          statusBefore: order.status,
          orderStatus,
        };
      });
    },

    // Newest first — the delivery history on the order card. rowCount comes
    // from a left join + count so a delivery is never silently dropped by an
    // inner join if a row is ever missing (defensive; delivery_rows are
    // always written together with their delivery).
    async listDeliveries(orderId: string) {
      return db
        .select({
          id: deliveries.id,
          deliveryNumber: deliveries.deliveryNumber,
          deliveredAt: deliveries.deliveredAt,
          rowCount: count(deliveryRows.id),
          // Ångra utleverans: count() skips nulls — the undone rows. All of
          // them undone = the följesedel is undone.
          undoneRowCount: count(deliveryRows.undoneAt),
        })
        .from(deliveries)
        .leftJoin(deliveryRows, eq(deliveryRows.deliveryId, deliveries.id))
        .where(eq(deliveries.salesOrderId, orderId))
        .groupBy(deliveries.id)
        .orderBy(desc(deliveries.deliveredAt));
    },

    // Följesedel (delivery note) PDF data — the delivery, its order/customer/
    // delivery-address blocks (same shape findSalesOrderById joins for the
    // other sales documents) and its rows joined to sales_order_rows/
    // articles/units (same join shape as listRowsByOrder). "Tidigare
    // levererat" per row is derived by SUBTRACTION rather than summed from
    // earlier delivery_rows, so it also covers delivery history predating
    // this table (C2): current salesOrderRows.quantityDelivered minus the
    // sum of THIS and every LATER occasion's delivery_rows quantity for that
    // row is exactly what was delivered before this occasion, regardless of
    // whether those earlier deliveries ever got a delivery_rows entry of
    // their own. Clamped at 0 — belt and braces against float drift.
    async getDeliveryForPdf(deliveryId: string) {
      const [delivery] = await db
        .select({
          id: deliveries.id,
          deliveryNumber: deliveries.deliveryNumber,
          deliveredAt: deliveries.deliveredAt,
          salesOrderId: deliveries.salesOrderId,
          orderNumber: salesOrders.orderNumber,
          customerId: salesOrders.customerId,
          customerName: customers.name,
          customerOrderNumber: salesOrders.customerOrderNumber,
          customerReference: salesOrders.customerReference,
          // Pallkort: the customer's Kod på pallkort.
          customerPalletCardCode: customers.palletCardCode,
          deliveryAddressLabel: customerDeliveryAddresses.label,
          deliveryAddress: customerDeliveryAddresses.address,
          deliveryPostalCode: customerDeliveryAddresses.postalCode,
          deliveryCity: customerDeliveryAddresses.city,
          deliveryCountry: customerDeliveryAddresses.country,
        })
        .from(deliveries)
        .innerJoin(salesOrders, eq(salesOrders.id, deliveries.salesOrderId))
        .innerJoin(customers, eq(customers.id, salesOrders.customerId))
        .leftJoin(customerDeliveryAddresses, eq(customerDeliveryAddresses.id, salesOrders.deliveryAddressId))
        .where(eq(deliveries.id, deliveryId));
      if (!delivery) return null;

      const rowUnits = alias(units, "row_units");
      const undoneByUser = alias(users, "undone_by_user");
      const [rows, occasions] = await Promise.all([
        db
          .select({
            deliveryRowId: deliveryRows.id,
            salesOrderRowId: deliveryRows.salesOrderRowId,
            quantity: deliveryRows.quantity,
            // Ångra utleverans: the row's undo stamp, and whether it can be
            // undone at all (a row the 0132 backfill could not pair has no
            // stock link).
            undoneAt: deliveryRows.undoneAt,
            undoneByName: undoneByUser.name,
            stockTransactionId: deliveryRows.stockTransactionId,
            articleNumber: articles.articleNumber,
            articleId: salesOrderRows.articleId,
            articleName: articles.name,
            articleExtraDescription: articles.extraDescription,
            unitCode: sql<string>`coalesce(${rowUnits.code}, ${units.code})`,
            unitFactor: salesOrderRows.unitFactor,
            quantityDelivered: salesOrderRows.quantityDelivered,
            // Konfigurator 4b: the configured row's choices print on the note.
            configuration: salesOrderRows.configuration,
          })
          .from(deliveryRows)
          .innerJoin(salesOrderRows, eq(salesOrderRows.id, deliveryRows.salesOrderRowId))
          .innerJoin(articles, eq(articles.id, salesOrderRows.articleId))
          .innerJoin(units, eq(units.id, articles.unitId))
          .leftJoin(rowUnits, eq(rowUnits.id, salesOrderRows.unitId))
          .leftJoin(undoneByUser, eq(undoneByUser.id, deliveryRows.undoneBy))
          .where(eq(deliveryRows.deliveryId, deliveryId))
          .orderBy(asc(salesOrderRows.createdAt), asc(salesOrderRows.id)),
        // Every occasion on the order, oldest first — pins down "this and
        // every later occasion" for the subtraction below without relying on
        // a timestamp tie-break (two batches booked in the same millisecond
        // would make a pure deliveredAt sort ambiguous).
        db
          .select({ id: deliveries.id })
          .from(deliveries)
          .where(eq(deliveries.salesOrderId, delivery.salesOrderId))
          .orderBy(asc(deliveries.deliveredAt), asc(deliveries.id)),
      ]);

      const currentIndex = occasions.findIndex((o) => o.id === deliveryId);
      const laterDeliveryIds = occasions.slice(currentIndex).map((o) => o.id);
      const laterSums = await db
        .select({ salesOrderRowId: deliveryRows.salesOrderRowId, total: sql<string>`sum(${deliveryRows.quantity})` })
        .from(deliveryRows)
        // Undone rows are already out of quantity_delivered — subtracting
        // them again would understate what went before.
        .where(and(inArray(deliveryRows.deliveryId, laterDeliveryIds), isNull(deliveryRows.undoneAt)))
        .groupBy(deliveryRows.salesOrderRowId);
      const laterMap = new Map(laterSums.map((s) => [s.salesOrderRowId, Number(s.total)]));

      // The följesedel counts as undone once every row is — stamped with the
      // last undo.
      const undoneStamps = rows.map((r) => r.undoneAt);
      const undoneAt =
        rows.length > 0 && undoneStamps.every((d) => d !== null)
          ? new Date(Math.max(...undoneStamps.map((d) => d!.getTime())))
          : null;

      return {
        ...delivery,
        undoneAt,
        rows: rows.map((r) => ({
          deliveryRowId: r.deliveryRowId,
          articleNumber: r.articleNumber,
          articleId: r.articleId,
          articleName: r.articleName,
          articleExtraDescription: r.articleExtraDescription,
          quantity: r.quantity,
          unitCode: r.unitCode,
          unitFactor: r.unitFactor,
          priorDelivered: Math.max(0, Number(r.quantityDelivered) - (laterMap.get(r.salesOrderRowId) ?? 0)),
          configuration: r.configuration,
          undoneAt: r.undoneAt,
          undoneByName: r.undoneByName,
          undoable: r.undoneAt === null && r.stockTransactionId !== null,
        })),
      };
    },

    // --- C3 Kundpriser: prislistor ---

    async createPriceList(input: CreatePriceListInput) {
      const [row] = await db
        .insert(priceLists)
        .values({ code: input.code, name: input.name, description: input.description ?? null, currency: input.currency ?? "SEK" })
        .returning();
      return row!;
    },

    // Valuta: requireNoRows makes the UPDATE conditional on a list without
    // rows (a currency change) — "has_rows" when a row is there.
    async updatePriceList(id: string, input: UpdatePriceListInput, opts: { requireNoRows?: boolean } = {}) {
      const where = opts.requireNoRows
        ? and(eq(priceLists.id, id), sql`not exists (select 1 from ${priceListRows} r where r.price_list_id = ${id})`)
        : eq(priceLists.id, id);
      const [row] = await db.update(priceLists).set(input).where(where).returning();
      if (!row && opts.requireNoRows) {
        const [exists] = await db.select({ id: priceLists.id }).from(priceLists).where(eq(priceLists.id, id));
        if (exists) return "has_rows" as const;
      }
      return row ?? null;
    },

    // Pre-checks customers.price_list_id for a friendly 409 in the common
    // case, but the pre-check alone is TOCTOU-racy — a customer can get
    // assigned to this list between the SELECT and the DELETE. The FK
    // (onDelete: "restrict") is the actual race-proof guarantee, so the
    // DELETE is also wrapped to catch its 23503 and map it to the same
    // friendly error (same pattern as deleteRow's RowHasManufacturingOrdersError).
    async deletePriceList(id: string) {
      const [list] = await db.select().from(priceLists).where(eq(priceLists.id, id));
      if (!list) return false;
      const [inUse] = await db
        .select({ id: customers.id })
        .from(customers)
        .where(eq(customers.priceListId, id))
        .limit(1);
      if (inUse) throw new PriceListInUseError(list.code);
      try {
        await db.delete(priceLists).where(eq(priceLists.id, id));
      } catch (err) {
        if (isForeignKeyViolation(err, "customers_price_list_id_price_lists_id_fk")) {
          throw new PriceListInUseError(list.code);
        }
        throw err;
      }
      return true;
    },

    async listPriceLists(query: ListPriceListsQuery) {
      const conditions = [];
      if (query.search) {
        const pattern = ilikePattern(query.search);
        conditions.push(or(ilike(priceLists.code, pattern), ilike(priceLists.name, pattern)));
      }
      const where = conditions.length > 0 ? and(...conditions) : undefined;

      const [rows, totalRows] = await Promise.all([
        db
          .select({
            ...getTableColumns(priceLists),
            // Same correlated-subquery shape as listProductionGroups'
            // workCenterCount — the table-qualified `.id` matters, an
            // unqualified one would resolve against the subquery's own table.
            rowCount: sql<number>`(select count(*)::int from ${priceListRows} r where r.price_list_id = ${priceLists}.id)`,
          })
          .from(priceLists)
          .where(where)
          .orderBy(asc(priceLists.code))
          .limit(query.limit)
          .offset(query.offset),
        db.select({ total: count() }).from(priceLists).where(where),
      ]);
      return { rows, total: totalRows[0]!.total };
    },

    async findPriceListById(id: string) {
      const [list] = await db.select().from(priceLists).where(eq(priceLists.id, id));
      if (!list) return null;
      const rows = await db
        .select({
          id: priceListRows.id,
          articleId: priceListRows.articleId,
          articleNumber: articles.articleNumber,
          articleName: articles.name,
          fromQuantity: priceListRows.fromQuantity,
          unitPrice: priceListRows.unitPrice,
        })
        .from(priceListRows)
        .innerJoin(articles, eq(articles.id, priceListRows.articleId))
        .where(eq(priceListRows.priceListId, id))
        .orderBy(asc(articles.articleNumber), asc(priceListRows.fromQuantity));
      return { ...list, rows };
    },

    async addPriceListRow(listId: string, input: PriceListRowInput) {
      const [row] = await db
        .insert(priceListRows)
        .values({
          priceListId: listId,
          articleId: input.articleId,
          fromQuantity: String(input.fromQuantity),
          unitPrice: String(input.unitPrice),
        })
        .returning();
      return row!;
    },

    async updatePriceListRow(listId: string, rowId: string, input: UpdatePriceListRowInput) {
      const values: { fromQuantity?: string; unitPrice?: string } = {};
      if (input.fromQuantity !== undefined) values.fromQuantity = String(input.fromQuantity);
      if (input.unitPrice !== undefined) values.unitPrice = String(input.unitPrice);
      const [row] = await db
        .update(priceListRows)
        .set(values)
        .where(and(eq(priceListRows.id, rowId), eq(priceListRows.priceListId, listId)))
        .returning();
      return row ?? null;
    },

    async deletePriceListRow(listId: string, rowId: string) {
      const result = await db
        .delete(priceListRows)
        .where(and(eq(priceListRows.id, rowId), eq(priceListRows.priceListId, listId)))
        .returning();
      return result.length > 0;
    },

    // --- C3 Kundpriser: kundpriser (per-customer article/group rules) ---

    // Article rules first, then group rules, then within each: article
    // number / group name, then fromQuantity — a plain ASC ordering on both
    // (nullable) join columns achieves this for free since Postgres sorts
    // NULLs last by default, and exactly one of the two is ever non-null per
    // row (the target CHECK).
    async listCustomerPrices(customerId: string) {
      return db
        .select({
          id: customerPrices.id,
          articleId: customerPrices.articleId,
          articleNumber: articles.articleNumber,
          articleName: articles.name,
          articleGroupId: customerPrices.articleGroupId,
          articleGroupName: articleGroups.name,
          fromQuantity: customerPrices.fromQuantity,
          unitPrice: customerPrices.unitPrice,
          discountPercent: customerPrices.discountPercent,
          setupPrice: customerPrices.setupPrice,
        })
        .from(customerPrices)
        .leftJoin(articles, eq(articles.id, customerPrices.articleId))
        .leftJoin(articleGroups, eq(articleGroups.id, customerPrices.articleGroupId))
        .where(eq(customerPrices.customerId, customerId))
        .orderBy(asc(articles.articleNumber), asc(articleGroups.name), asc(customerPrices.fromQuantity));
    },

    // --- Kundens artikelnummer ---
    async listCustomerArticleNumbers(customerId: string) {
      return db
        .select({
          id: customerArticleNumbers.id,
          articleId: customerArticleNumbers.articleId,
          articleNumber: articles.articleNumber,
          articleName: articles.name,
          customerArticleNumber: customerArticleNumbers.customerArticleNumber,
        })
        .from(customerArticleNumbers)
        .innerJoin(articles, eq(articles.id, customerArticleNumbers.articleId))
        .where(eq(customerArticleNumbers.customerId, customerId))
        .orderBy(asc(articles.articleNumber));
    },

    async addCustomerArticleNumber(customerId: string, articleId: string, customerArticleNumber: string) {
      const [row] = await db
        .insert(customerArticleNumbers)
        .values({ customerId, articleId, customerArticleNumber })
        .returning();
      return row!;
    },

    async updateCustomerArticleNumber(customerId: string, id: string, customerArticleNumber: string) {
      const [row] = await db
        .update(customerArticleNumbers)
        .set({ customerArticleNumber })
        .where(and(eq(customerArticleNumbers.id, id), eq(customerArticleNumbers.customerId, customerId)))
        .returning();
      return row ?? null;
    },

    async deleteCustomerArticleNumber(customerId: string, id: string) {
      const [row] = await db
        .delete(customerArticleNumbers)
        .where(and(eq(customerArticleNumbers.id, id), eq(customerArticleNumbers.customerId, customerId)))
        .returning();
      return row ?? null;
    },

    // articleId -> the customer's number for it, for the document rows.
    async customerArticleNumberMap(customerId: string, articleIds: (string | null)[]) {
      return customerArticleNumberMap(db, customerId, articleIds);
    },

    // Existence check for the customer-price rule's articleGroupId target —
    // article_groups lives in the article module's schema, but (like
    // articles/customers elsewhere in this repository) is queried straight
    // against the table rather than routed through a cross-module reader.
    async articleGroupExists(id: string) {
      const [row] = await db.select({ id: articleGroups.id }).from(articleGroups).where(eq(articleGroups.id, id));
      return row !== undefined;
    },

    async addCustomerPrice(customerId: string, input: CustomerPriceInput) {
      const [row] = await db
        .insert(customerPrices)
        .values({
          customerId,
          articleId: input.articleId ?? null,
          articleGroupId: input.articleGroupId ?? null,
          fromQuantity: String(input.fromQuantity),
          unitPrice: input.unitPrice != null ? String(input.unitPrice) : null,
          discountPercent: input.discountPercent != null ? String(input.discountPercent) : null,
          // 0 means none, like an empty field.
          setupPrice: input.setupPrice ? String(input.setupPrice) : null,
        })
        .returning();
      return row!;
    },

    async updateCustomerPrice(customerId: string, priceId: string, input: UpdateCustomerPriceInput) {
      const values: {
        fromQuantity?: string;
        unitPrice?: string | null;
        discountPercent?: string | null;
        setupPrice?: string | null;
      } = {};
      if (input.fromQuantity !== undefined) values.fromQuantity = String(input.fromQuantity);
      if (input.setupPrice !== undefined) values.setupPrice = input.setupPrice ? String(input.setupPrice) : null;
      // Whichever of unitPrice/discountPercent the caller sends replaces the
      // pair (the other is cleared) — the schema-level refine guarantees
      // they never arrive together, so this keeps the DB CHECK
      // ((unit_price IS NULL) <> (discount_percent IS NULL)) satisfied on
      // every update, not just at create.
      if (input.unitPrice !== undefined) {
        values.unitPrice = String(input.unitPrice);
        values.discountPercent = null;
      }
      if (input.discountPercent !== undefined) {
        values.discountPercent = String(input.discountPercent);
        values.unitPrice = null;
      }
      const [row] = await db
        .update(customerPrices)
        .set(values)
        .where(and(eq(customerPrices.id, priceId), eq(customerPrices.customerId, customerId)))
        .returning();
      return row ?? null;
    },

    async deleteCustomerPrice(customerId: string, priceId: string) {
      const result = await db
        .delete(customerPrices)
        .where(and(eq(customerPrices.id, priceId), eq(customerPrices.customerId, customerId)))
        .returning();
      return result.length > 0;
    },
  };
}

export type SalesRepository = ReturnType<typeof createSalesRepository>;

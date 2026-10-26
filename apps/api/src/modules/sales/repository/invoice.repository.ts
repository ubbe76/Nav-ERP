import { createHash } from "node:crypto";
import { and, asc, count, desc, eq, getTableColumns, ilike, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  articleGroups,
  articles,
  auditLog,
  costCenters,
  projects,
  customerPaymentRows,
  customerPayments,
  customers,
  deliveries,
  deliveryRows,
  fiscalYears,
  freightProducts,
  invoiceDocuments,
  invoiceReminders,
  invoiceRows,
  invoices,
  paymentTerms,
  salesOrderRows,
  salesOrders,
  shipments,
  units,
  vatCodes,
  verifications,
  verificationSeries,
  type Db,
  type Tx,
  einvoiceTransmissions,
} from "@navet/db";
import {
  buyerVatNumberProblem,
  domesticVatCodeForRate,
  invoiceSekAmounts,
  SEK,
  ilikePattern,
  isVatCode,
  isVatRate,
  round2,
  type EinvoiceStatus,
  type InvoiceStatus,
  type InvoiceType,
  type ListInvoicesQuery,
  type OrderRowConfiguration,
} from "@navet/shared";
import { getNextOrderNumber } from "../../system/service/number-series.js";
import { computeOcrNumber } from "../../system/service/ocr.js";
import { pluginEvents } from "../../system/service/plugin-events.js";
import { readPostingSettings } from "../../system/service/posting-settings.js";
import { domesticVatCodeIdSql, loadVatCodeBook, postingVatCodeColumns } from "../../economy/repository/vat-codes.js";
import { resolveDimensions, type DimensionInput, type ResolveDimensionsOptions } from "../../economy/service/dimension-check.js";
import { computeOpenAmounts, computeOpenAmountsSek } from "./open-amounts.js";
import { chargesByInvoice, isLateInterestInvoice, paymentsByInvoice } from "./late-interest.repository.js";
import { ShipmentNotBillableError, VatNumberRequiredError } from "../service/sales.errors.js";
import { articleVatFacts, articleVatRateSql } from "../../article/repository/article-vat-rate.js";
// Type-only (erased at compile time), so declaring the poster interface at
// the consuming service does not create a runtime import cycle.
import type { CustomerInvoicePoster, InvoiceReminderPoster } from "../service/invoice.service.js";

// The frozen values stamped onto the invoice at issue — computed by the
// service (customer + payment term lookups) and written verbatim by
// issueInvoice inside its transaction. Reprints must stay stable regardless
// of later customer/register edits (see invoices.customerName's comment).
export type IssueStamp = {
  invoiceDate: string;
  dueDate: string | null;
  customerName: string;
  // Frozen kundnummer — reprints must not follow a later renumbering.
  customerNumber: string;
  invoiceAddress: string | null;
  invoicePostalCode: string | null;
  invoiceCity: string | null;
  invoiceCountry: string | null;
  orgNumber: string | null;
  vatNumber: string | null;
  // Privatperson at issue — the PDF prints prices including VAT.
  privatePerson: boolean;
  paymentTermCode: string | null;
  paymentTermName: string | null;
  // Valuta: the rate the invoice is booked at (1 for SEK) — decided by the
  // service before the transaction (the invoice date's rate, a rate typed on
  // the draft, or a credit note's source rate). exchangeRateManual says which
  // case the service read: the issue UPDATE is conditional on the draft
  // still being in that state, so a rate typed in meanwhile loses the race
  // instead of being booked over. Omitted (a direct repository caller) = the
  // rate stored on the draft, unconditionally.
  exchangeRate?: number;
  exchangeRateManual?: boolean;
};

// Internal control-flow signal only — never leaves issueInvoice below. Thrown
// INSIDE the transaction when the conditional issue UPDATE matches no row
// (the invoice was no longer "draft" by the time the tx ran), so the number
// allocation earlier in that same tx rolls back instead of being burned by a
// lost race. Caught immediately outside and turned into a discriminated
// `{ ok: false, reason: "race" }` result — same "no matching row" convention
// as DeliverBatchResult in sales.repository.ts.
class IssueRaceError extends Error {}

// Same internal-signal pattern as IssueRaceError, thrown by
// validateCommittedQuantities below when issuing this invoice would commit
// an over-invoice/over-credit against one of its linked sales order rows.
// Two classes (rather than one with a reason field) so the catch block below
// can tell them apart with a plain instanceof, same idiom as IssueRaceError.
class CommitOverInvoicingError extends Error {}
class CommitOverCreditingError extends Error {}

// Shared invoiced-quantity aggregation, parameterized by executor so the
// order-status recompute (which must run inside issueInvoice's own tx) and
// the repository's plain-db getInvoicedQuantities share one implementation.
// Ångra utleverans (sales.repository.ts's undoDeliveryRow) reads it inside its
// own transaction too, drafts included.
// Credits count negative — the CASE expression is the ONLY place the sign
// convention lives on the aggregation side.
export async function getInvoicedQuantitiesWith(
  executor: Db | Tx,
  salesOrderRowIds: string[],
  opts: { includeDrafts: boolean }
) {
  if (salesOrderRowIds.length === 0) return new Map<string, number>();
  const statuses: InvoiceStatus[] = opts.includeDrafts ? ["draft", "issued", "paid"] : ["issued", "paid"];
  const rows = await executor
    .select({
      salesOrderRowId: invoiceRows.salesOrderRowId,
      invoiced: sql<string>`COALESCE(SUM(CASE WHEN ${invoices.type} = 'credit' THEN -${invoiceRows.quantity} ELSE ${invoiceRows.quantity} END), 0)`,
    })
    .from(invoiceRows)
    .innerJoin(invoices, eq(invoiceRows.invoiceId, invoices.id))
    .where(and(inArray(invoiceRows.salesOrderRowId, salesOrderRowIds), inArray(invoices.status, statuses)))
    .groupBy(invoiceRows.salesOrderRowId);
  return new Map(rows.filter((r) => r.salesOrderRowId !== null).map((r) => [r.salesOrderRowId!, Number(r.invoiced)]));
}

// Re-validates the ACTUAL committed state at the real commitment point —
// closes a gap the create-time guard (resolveRow in invoice.service.ts, an
// includeDrafts:true snapshot taken well before this transaction runs)
// cannot: a draft credit note "frees" quantity for a new draft invoice at
// CREATE time, but if that credit is later cancelled instead of issued, the
// combined committed total can still exceed what's delivered. It also closes
// the concurrent-drafts race: two draft invoices that each individually
// passed the create-time guard (e.g. both created before either was
// visible to the other's guard read) are only actually committed one at a
// time, at issue.
//
// MUST run inside issueInvoice's transaction, BEFORE the status UPDATE flips
// this invoice's own rows into the "issued" bucket — otherwise the
// committed-quantities aggregation below (includeDrafts:false) would see
// this invoice's own rows twice: once here (manually, signed by `type`) and
// once via the aggregation itself.
async function validateCommittedQuantities(tx: Tx, invoiceId: string, type: InvoiceType): Promise<void> {
  const rows = await tx
    .select({ salesOrderRowId: invoiceRows.salesOrderRowId, quantity: invoiceRows.quantity })
    .from(invoiceRows)
    .where(eq(invoiceRows.invoiceId, invoiceId));

  // This invoice's own rows, summed per linked sales order row — a single
  // invoice can carry several rows against the same order row (a batch
  // create), so they must be combined before comparing against what's
  // committed elsewhere, same accumulation resolveRow's batchAccumulated does
  // at create time.
  const ownByRow = new Map<string, number>();
  for (const r of rows) {
    if (r.salesOrderRowId === null) continue;
    ownByRow.set(r.salesOrderRowId, (ownByRow.get(r.salesOrderRowId) ?? 0) + Number(r.quantity));
  }
  if (ownByRow.size === 0) return;

  // Row-lock the linked order rows BEFORE aggregating committed quantities —
  // this is the actual serialization point. Without it, two genuinely
  // concurrent issueInvoice transactions targeting the same (or overlapping)
  // order rows both run the committed-quantities aggregation below against
  // the pre-commit state, both see room, and both commit — over-invoicing
  // the row once the dust settles. With the lock, the second transaction
  // blocks here until the first commits (or rolls back), then re-reads a
  // fresh snapshot that includes what the first just committed. Ids are
  // sorted going into the IN-list AND via the explicit ORDER BY, so every
  // concurrent caller acquires row locks in the same order regardless of
  // which rows overlap between the two sets — the standard fix for a
  // multi-row lock deadlock. Both the invoice and the credit branch below
  // take this lock (credit ignores quantityDelivered but still needs the
  // same serialization) — same isolation decision the B3 payment
  // registration takes on its matched invoices (Task 5: FOR UPDATE there
  // too).
  const rowIds = [...ownByRow.keys()].sort();
  const lockedRows = await tx
    .select({ id: salesOrderRows.id, quantityDelivered: salesOrderRows.quantityDelivered })
    .from(salesOrderRows)
    .where(inArray(salesOrderRows.id, rowIds))
    .orderBy(asc(salesOrderRows.id))
    .for("update");

  const committed = await getInvoicedQuantitiesWith(tx, rowIds, { includeDrafts: false });

  if (type === "credit") {
    for (const [rowId, ownQty] of ownByRow) {
      if ((committed.get(rowId) ?? 0) - ownQty < 0) throw new CommitOverCreditingError();
    }
    return;
  }

  // Reuses the locked read above for quantityDelivered — no second, unlocked
  // SELECT against the same rows.
  const deliveredMap = new Map(lockedRows.map((d) => [d.id, Number(d.quantityDelivered)]));
  for (const [rowId, ownQty] of ownByRow) {
    const net = (committed.get(rowId) ?? 0) + ownQty;
    if (net > (deliveredMap.get(rowId) ?? 0)) throw new CommitOverInvoicingError();
  }
}

// Recomputes the order-level invoice status for every sales order touched by
// this invoice's rows, run inside the SAME transaction as the issue/credit so
// a failed transition can't leave the order and the invoice out of sync.
// Only two flips are legal — delivered -> invoiced (every row on the order
// fully invoiced, issued+paid only; drafts never count) and, for the credit
// direction, invoiced -> delivered when a credit reopens a row — and BOTH are
// gated on the order's CURRENT status being exactly the expected starting
// point, so an order somebody manually repositioned via setStatus (which
// deliberately has no transition guard) is never moved. Mirrors invoiceOrder:
// never touches sales_orders.invoice_number/invoicedAt.
async function recomputeOrderInvoiceStatus(tx: Tx, invoiceId: string) {
  const linked = await tx
    .select({ salesOrderId: salesOrderRows.salesOrderId })
    .from(invoiceRows)
    .innerJoin(salesOrderRows, eq(salesOrderRows.id, invoiceRows.salesOrderRowId))
    .where(eq(invoiceRows.invoiceId, invoiceId));
  const orderIds = [...new Set(linked.map((r) => r.salesOrderId))];

  for (const orderId of orderIds) {
    const [order] = await tx.select({ status: salesOrders.status }).from(salesOrders).where(eq(salesOrders.id, orderId));
    if (!order || (order.status !== "delivered" && order.status !== "invoiced")) continue;

    const rows = await tx
      .select({ id: salesOrderRows.id, quantityOrdered: salesOrderRows.quantityOrdered })
      .from(salesOrderRows)
      .where(eq(salesOrderRows.salesOrderId, orderId));
    const invoiced = await getInvoicedQuantitiesWith(
      tx,
      rows.map((r) => r.id),
      { includeDrafts: false }
    );
    const allFullyInvoiced = rows.length > 0 && rows.every((r) => (invoiced.get(r.id) ?? 0) >= Number(r.quantityOrdered));

    if (order.status === "delivered" && allFullyInvoiced) {
      await tx.update(salesOrders).set({ status: "invoiced", updatedAt: new Date() }).where(eq(salesOrders.id, orderId));
    } else if (order.status === "invoiced" && !allFullyInvoiced) {
      await tx.update(salesOrders).set({ status: "delivered", updatedAt: new Date() }).where(eq(salesOrders.id, orderId));
    }
  }
}

// The booked verification's display number (F-2026-1), assembled from the
// joined series/fiscal year/number the same way economy.repository.ts
// formats it. `||` propagates NULL, so an invoice with no verification — any
// draft, plus everything issued before B2 — simply comes back null without a
// CASE. A posted verification is always booked, so the number is never null
// on its own ("Utkast" can't occur here).
const verificationDisplayNumberSql = sql<
  string | null
>`${verificationSeries.code} || '-' || ${fiscalYears.label} || '-' || ${verifications.verificationNumber}`;

// A row ready to write — line/vat amounts are computed by the service so the
// stored numbers can never contradict quantity × unitPrice. vatRate is
// always resolved to a concrete number by the service (never null), unlike
// the supplier-invoice mall where freight-only rows may have no VAT at all.
export type InvoiceRowWrite = {
  articleId: string | null;
  salesOrderRowId: string | null;
  // Frakt etapp 2: the booked shipment this freight row bills (validated by
  // the service's resolveRow). Written by create/addRow only — updateRow
  // never touches the column (the PATCH schema omits it).
  shipmentId: string | null;
  description: string;
  quantity: number;
  unitPrice: number;
  discountPercent: number;
  unitId: string | null;
  unitFactor: number | null;
  vatRate: number;
  // Momskod (migration 0142). The service always sets it (explicit choice,
  // a bare rate's domestic code, or salesVatCode's derivation); omitted =
  // the domestic code of vatRate, the fallback for direct repository use.
  vatCodeId?: string;
  lineAmount: number;
  vatAmount: number;
  // Leveransdatum (ML 17 kap. 24 § p. 7) — the order row's last non-undone
  // delivery day, a credit row's source row's, or the user's. Omitted = null.
  deliveryDate?: string | null;
  // Konfigurator 4b: copy of the order row's configuration (null for a
  // free/plain row). Written on the draft only; an issued invoice's rows are
  // never rewritten.
  configuration: OrderRowConfiguration | null;
  // Kostnadsställen och projekt: resolved by the service (the row's choice,
  // the order header's, the article group's default). Omitted = none.
  costCenterId?: string | null;
  projectId?: string | null;
  // Dröjsmålsränta: the row's own revenue account (räntefaktura rows —
  // posting_late_interest / posting_late_fee), copied by a credit note.
  // Omitted = none (the konteringsregel / momskod decides).
  revenueAccount?: string | null;
};

// The row's objects as { id, code, name } | null on every row read.
const rowCostCenters = alias(costCenters, "invoice_row_cost_centers");
const rowProjects = alias(projects, "invoice_row_projects");
const rowDimensionColumns = {
  costCenter: { id: rowCostCenters.id, code: rowCostCenters.code, name: rowCostCenters.name },
  project: { id: rowProjects.id, code: rowProjects.code, name: rowProjects.name },
};

// The row's momskod as an insert/update value: the explicit id, else the
// domestic code of its rate. A rate outside the Swedish set gets MP25 and
// keeps its rate, so issuing still refuses it (UnknownVatRateError).
function rowVatCodeId(row: InvoiceRowWrite) {
  if (row.vatCodeId) return row.vatCodeId;
  return domesticVatCodeIdSql(isVatRate(row.vatRate) ? domesticVatCodeForRate(row.vatRate) : "MP25");
}

// Internal control-flow signal only — never leaves createReminder below.
// Thrown INSIDE its transaction so the reminder row and the fee posting roll
// back together, and normalized outside into a discriminated result the
// SERVICE turns into an error (the IssueRaceError convention).
type ReminderGuardReason = "not_found" | "not_issued" | "not_open" | "fee_already_charged" | "late_fee_charged";

class ReminderGuardError extends Error {
  constructor(public reason: ReminderGuardReason) {
    super(reason);
  }
}

// What the service decided BEFORE the email went out: the level it printed on
// the PDF, the fee it told the customer about, and when it was sent. The
// transaction re-validates whether that reminder may still be persisted — it
// never recomputes these numbers, because the customer already has them.
export type ReminderWrite = {
  level: number;
  fee: number;
  sentAt: Date;
  // The fee posting's verification date (sv-SE, today) — the same instant as
  // sentAt, formatted the way every other posting date in the codebase is.
  reminderDate: string;
  // The PDF exactly as emailed — archived in the same transaction as the
  // reminder row (invoice_documents), so the two can never exist apart.
  document: { filename: string; content: Buffer };
};

// Arkiverat fakturadokument (invoice_documents): what was issued/sent.
export type ArchivedDocumentRef = { kind: "invoice" } | { kind: "reminder"; reminderId: string };

const sha256Hex = (data: Buffer) => createHash("sha256").update(data).digest("hex");

// Frakt etapp 2: a booked shipment that may still be billed — see
// listInvoiceableShipments below for the rule.
export type InvoiceableShipment = {
  shipmentId: string;
  shipmentNumber: string;
  customerId: string;
  carrierName: string | null;
  productName: string | null;
  // Kundpriset i SEK (Sendify's price plus the markup).
  customerPrice: string;
  bookedAt: Date | null;
  deliveryNumbers: string[];
  // Valuta: the currency and rate of the order the shipment's first live
  // följesedel belongs to (null when none can be found).
  orderCurrency: string | null;
  orderExchangeRate: string | null;
};

export type CreateReminderResult =
  | { ok: true; reminderId: string; feeVerificationId: string | null }
  | { ok: false; reason: ReminderGuardReason };

export type IssueInvoiceResult =
  | { ok: true; invoice: typeof invoices.$inferSelect }
  | { ok: false; reason: "race" | "over_invoicing" | "over_crediting" };

// Momskoder: what Utfärda checks the rows' codes against inside the issue
// transaction — the momsregistreringsnummer being stamped and the customer's
// own country (the EU prefix rule).
export type BuyerVatNumberCheck = { vatNumber: string | null; country: string };

export type InvoiceHeaderWrite = {
  customerId: string;
  paymentTermId: string | null;
  note: string | null;
  // Valuta: decided by the service. exchangeRate null = decided at Utfärda.
  currency?: string;
  exchangeRate?: number | null;
  exchangeRateManual?: boolean;
  // Credit notes only — omitted by the ordinary create() callsite, in which
  // case the DB defaults apply ("invoice" / null), same as before Task 5.
  type?: InvoiceType;
  creditedInvoiceId?: string | null;
};

// Header patch (draft only).
type HeaderPatch = {
  paymentTermId?: string | null;
  note?: string | null;
  // Valuta: a rate typed in (manual true) or back to automatic (null/false).
  exchangeRate?: number | null;
  exchangeRateManual?: boolean;
};

// Frakt-uppföljning: the shipments a write's freight rows bill, locked FOR
// SHARE for the rest of the transaction — the cancellation's claim takes the
// same rows FOR UPDATE, so the two serialize. resolveRow's unlocked pre-check
// can be stale; this is the check that counts. 2 minutes = CANCEL_STALE_MS.
async function assertShipmentsBillable(tx: Tx, rows: { shipmentId: string | null }[]) {
  const ids = [...new Set(rows.map((r) => r.shipmentId).filter((id): id is string => id !== null))];
  if (ids.length === 0) return;
  const locked = await tx
    .select({ shipmentNumber: shipments.shipmentNumber, status: shipments.status, cancelStartedAt: shipments.cancelStartedAt })
    .from(shipments)
    .where(inArray(shipments.id, ids))
    .for("share");
  const staleBefore = Date.now() - 2 * 60 * 1000;
  for (const s of locked) {
    const cancelling = s.cancelStartedAt !== null && s.cancelStartedAt.getTime() > staleBefore;
    if ((s.status !== "booked" && s.status !== "delivered") || cancelling) throw new ShipmentNotBillableError(s.shipmentNumber);
  }
}

export function createInvoiceRepository(db: Db) {
  // The single source of truth for "how much of this order row is invoiced".
  // Prefill/over-invoicing guards include drafts (a row already on a draft
  // must not be billable twice); the order-status recompute counts
  // issued+paid only (via the tx-scoped getInvoicedQuantitiesWith above).
  // Declared as a plain function so listInvoiceableOrders below can call it
  // directly.
  async function getInvoicedQuantities(salesOrderRowIds: string[], opts: { includeDrafts: boolean }) {
    return getInvoicedQuantitiesWith(db, salesOrderRowIds, opts);
  }

  // Frakt etapp 2: booked/delivered shipments with a customer price, not yet
  // on any invoice row, and none of whose live följesedlar belongs to an
  // order that already carries the freight article (Lägg till frakt on the
  // order, or typed by hand) — that freight is billed through the order row
  // instead. customerId null = every customer (the collective invoicing
  // candidates). A plain function, like getInvoicedQuantities, so
  // listCollectiveInvoicingCandidates below can call it directly.
  async function listInvoiceableShipments(
    customerId: string | null,
    freightArticleId: string
  ): Promise<InvoiceableShipment[]> {
    const rows = await db
      .select({
        shipmentId: shipments.id,
        shipmentNumber: shipments.shipmentNumber,
        customerId: shipments.customerId,
        carrierName: freightProducts.carrierName,
        productName: freightProducts.productName,
        customerPrice: shipments.customerPrice,
        bookedAt: shipments.bookedAt,
        deliveryNumbers: sql<string[]>`array(
          select d.delivery_number from shipment_deliveries sd
          join deliveries d on d.id = sd.delivery_id
          where sd.shipment_id = ${shipments.id} and sd.active
          order by d.delivery_number)`,
        orderCurrency: sql<string | null>`(
          select so.currency from shipment_deliveries sd
          join deliveries d on d.id = sd.delivery_id
          join sales_orders so on so.id = d.sales_order_id
          where sd.shipment_id = ${shipments.id} and sd.active
          order by d.delivery_number limit 1)`,
        orderExchangeRate: sql<string | null>`(
          select so.exchange_rate::text from shipment_deliveries sd
          join deliveries d on d.id = sd.delivery_id
          join sales_orders so on so.id = d.sales_order_id
          where sd.shipment_id = ${shipments.id} and sd.active
          order by d.delivery_number limit 1)`,
      })
      .from(shipments)
      .leftJoin(freightProducts, eq(freightProducts.id, shipments.freightProductId))
      .where(
        and(
          customerId ? eq(shipments.customerId, customerId) : undefined,
          inArray(shipments.status, ["booked", "delivered"]),
          isNotNull(shipments.customerPrice),
          sql`not exists (select 1 from ${invoiceRows} where ${invoiceRows.shipmentId} = ${shipments.id})`,
          sql`not exists (
            select 1 from shipment_deliveries sd
            join deliveries d on d.id = sd.delivery_id
            join sales_order_rows sor on sor.sales_order_id = d.sales_order_id
            where sd.shipment_id = ${shipments.id} and sd.active and sor.article_id = ${freightArticleId})`
        )
      )
      .orderBy(asc(shipments.bookedAt), asc(shipments.shipmentNumber));
    // customerPrice is filtered NOT NULL above; the select type can't see that.
    return rows.map((r) => ({ ...r, customerPrice: r.customerPrice! }));
  }

  const repository = {
    async findCustomerById(id: string) {
      const [row] = await db.select().from(customers).where(eq(customers.id, id));
      return row ?? null;
    },

    // The article's current VAT rate (its varugrupp's) — the fallback when
    // a row doesn't specify vatRate explicitly.
    async findArticleVatRate(articleId: string) {
      return (await articleVatFacts(db, articleId))?.vatRate ?? null;
    },

    // Momskoder: the article facts salesVatCode reads — its rate (the
    // domestic code) and its type (goods or service).
    async findArticleForVat(articleId: string) {
      return articleVatFacts(db, articleId);
    },

    // Momskoder: the company's codes (name, invoice text, active), once per
    // document operation.
    async vatCodeBook() {
      return loadVatCodeBook(db);
    },

    // Leveransdatum (spec 4.4): the last Stockholm day on which the order row
    // was delivered, undone delivery rows left out. null = not delivered.
    async latestDeliveryDate(salesOrderRowId: string): Promise<string | null> {
      const [row] = await db
        .select({
          day: sql<string | null>`to_char(max(${deliveries.deliveredAt}) at time zone 'Europe/Stockholm', 'YYYY-MM-DD')`,
        })
        .from(deliveryRows)
        .innerJoin(deliveries, eq(deliveries.id, deliveryRows.deliveryId))
        .where(and(eq(deliveryRows.salesOrderRowId, salesOrderRowId), isNull(deliveryRows.undoneAt)));
      return row?.day ?? null;
    },

    // A sales order row plus its order's customer/orderNumber — for the
    // delfakturering link validation and the over-invoicing guard.
    async findSalesOrderRowForInvoicing(rowId: string) {
      const [row] = await db
        .select({
          id: salesOrderRows.id,
          articleId: salesOrderRows.articleId,
          quantityOrdered: salesOrderRows.quantityOrdered,
          quantityDelivered: salesOrderRows.quantityDelivered,
          unitId: salesOrderRows.unitId,
          unitFactor: salesOrderRows.unitFactor,
          unitPrice: salesOrderRows.unitPrice,
          customerId: salesOrders.customerId,
          orderNumber: salesOrders.orderNumber,
          // Valuta: a row is billed in its order's currency only.
          currency: salesOrders.currency,
          // Konfigurator 4b: copied onto the invoice row.
          configuration: salesOrderRows.configuration,
          // Kostnadsställen och projekt: the order header's, the default for
          // the invoice row.
          orderCostCenterId: salesOrders.costCenterId,
          orderProjectId: salesOrders.projectId,
        })
        .from(salesOrderRows)
        .innerJoin(salesOrders, eq(salesOrders.id, salesOrderRows.salesOrderId))
        .where(eq(salesOrderRows.id, rowId));
      return row ?? null;
    },

    // Kostnadsställen och projekt: the article group's Kostnadsställe
    // (förval) — the default for a row without an order header's.
    async findArticleGroupDefaultCostCenter(articleId: string): Promise<string | null> {
      const [row] = await db
        .select({ defaultCostCenterId: articleGroups.defaultCostCenterId })
        .from(articles)
        .leftJoin(articleGroups, eq(articleGroups.id, articles.groupId))
        .where(eq(articles.id, articleId));
      return row?.defaultCostCenterId ?? null;
    },

    // The one dimension rule (dimension-check.ts), through this repository's
    // connection.
    async resolveDimensions(input: DimensionInput, opts: ResolveDimensionsOptions = {}) {
      return resolveDimensions(db, input, opts);
    },

    getInvoicedQuantities,

    // Samlingsfakturering: every customer flagged collective_invoicing that
    // has a delivered-but-uninvoiced rest on some order row, aggregated per
    // customer. Same row selection and invoiced-quantity rule (drafts count)
    // as listInvoiceableOrders below — the rest is computed in JS from the
    // shared getInvoicedQuantities aggregate so the two can never disagree.
    // netAmount (Σ rest × unitPrice × (1 − discount), excl. VAT) is
    // informational only; the invoice's own amounts are computed at create.
    //
    // Frakt etapp 2: a flagged customer's unbilled shipments count too —
    // shipmentCount on every candidate, the freight in netAmount, and a
    // customer with ONLY freight left becomes a candidate of its own
    // (rowCount/orderCount 0). Null freightArticleId = no freight billing.
    async listCollectiveInvoicingCandidates(freightArticleId: string | null = null) {
      const rows = await db
        .select({
          customerId: customers.id,
          customerNumber: customers.customerNumber,
          name: customers.name,
          orderId: salesOrders.id,
          salesOrderRowId: salesOrderRows.id,
          unitPrice: salesOrderRows.unitPrice,
          discountPercent: salesOrderRows.discountPercent,
          quantityDelivered: salesOrderRows.quantityDelivered,
          currency: salesOrders.currency,
          exchangeRate: salesOrders.exchangeRate,
        })
        .from(salesOrderRows)
        .innerJoin(salesOrders, eq(salesOrders.id, salesOrderRows.salesOrderId))
        .innerJoin(customers, eq(customers.id, salesOrders.customerId))
        .where(
          and(
            eq(customers.collectiveInvoicing, true),
            inArray(salesOrders.status, ["delivered", "in_production", "invoiced"]),
            sql`${salesOrderRows.quantityDelivered} > 0`
          )
        )
        .orderBy(asc(customers.customerNumber));

      const invoiced = await getInvoicedQuantities(
        rows.map((r) => r.salesOrderRowId),
        { includeDrafts: true }
      );

      const byCustomer = new Map<
        string,
        {
          customerId: string;
          customerNumber: string;
          name: string;
          orderIds: Set<string>;
          rowCount: number;
          shipmentCount: number;
          netAmount: number;
          currencies: Set<string>;
        }
      >();
      const candidateFor = (c: { customerId: string; customerNumber: string; name: string }) => {
        let candidate = byCustomer.get(c.customerId);
        if (!candidate) {
          candidate = {
            customerId: c.customerId,
            customerNumber: c.customerNumber,
            name: c.name,
            orderIds: new Set(),
            rowCount: 0,
            shipmentCount: 0,
            netAmount: 0,
            currencies: new Set(),
          };
          byCustomer.set(c.customerId, candidate);
        }
        return candidate;
      };
      for (const r of rows) {
        const rest = Number(r.quantityDelivered) - (invoiced.get(r.salesOrderRowId) ?? 0);
        if (rest <= 0) continue;
        const c = candidateFor(r);
        c.orderIds.add(r.orderId);
        c.rowCount += 1;
        // Valuta: in SEK at the order's rate (informational — one invoice is
        // made per currency, see runCollectiveInvoicing).
        c.netAmount += rest * Number(r.unitPrice) * (1 - Number(r.discountPercent ?? 0) / 100) * Number(r.exchangeRate);
        c.currencies.add(r.currency);
      }

      // The register's own order (Postgres collation), for the output below
      // and as the freight block's flagged-customer filter.
      const flagged = await db
        .select({ customerId: customers.id, customerNumber: customers.customerNumber, name: customers.name })
        .from(customers)
        .where(eq(customers.collectiveInvoicing, true))
        .orderBy(asc(customers.customerNumber));
      const flaggedById = new Map(flagged.map((c) => [c.customerId, c]));

      if (freightArticleId) {
        const shipmentRows = await listInvoiceableShipments(null, freightArticleId);
        if (shipmentRows.length > 0) {
          // The shipment list is customer-agnostic — keep flagged customers only.
          for (const s of shipmentRows) {
            const customer = flaggedById.get(s.customerId);
            if (!customer) continue;
            const c = candidateFor(customer);
            c.shipmentCount += 1;
            c.netAmount += Number(s.customerPrice);
            c.currencies.add(s.orderCurrency ?? SEK);
          }
        }
      }

      // Output order comes from the flagged-customer query above (the
      // register's own collation), not from a JS sort.
      return flagged
        .flatMap((c) => {
          const candidate = byCustomer.get(c.customerId);
          return candidate ? [candidate] : [];
        })
        .map(({ orderIds, netAmount, currencies, ...c }) => ({
          ...c,
          orderCount: orderIds.size,
          netAmount: round2(netAmount),
          // Valuta: the currencies the run will invoice in (one invoice each).
          currencies: [...currencies].sort(),
        }));
    },

    // Draft candidates for a customer: delivered/in_production/invoiced
    // orders with rows that still have an un-invoiced delivered quantity.
    async listInvoiceableOrders(customerId: string) {
      const rowUnits = alias(units, "row_units");
      const rows = await db
        .select({
          orderId: salesOrders.id,
          orderNumber: salesOrders.orderNumber,
          // Valuta: an invoice takes one currency — the dialog groups on it.
          currency: salesOrders.currency,
          exchangeRate: salesOrders.exchangeRate,
          salesOrderRowId: salesOrderRows.id,
          articleId: salesOrderRows.articleId,
          articleNumber: articles.articleNumber,
          articleName: articles.name,
          unitPrice: salesOrderRows.unitPrice,
          discountPercent: salesOrderRows.discountPercent,
          unitId: salesOrderRows.unitId,
          unitFactor: salesOrderRows.unitFactor,
          // The unit the row displays in — same coalesce-to-base-unit rule as
          // sales.repository's listRowsByOrder.
          unitCode: sql<string>`coalesce(${rowUnits.code}, ${units.code})`,
          vatRate: articleVatRateSql,
          // Momskoder: goods or service for the row's derived code.
          articleType: articles.type,
          quantityDelivered: salesOrderRows.quantityDelivered,
          // Konfigurator 4b: the dialog shows the configured row's choices.
          configuration: salesOrderRows.configuration,
        })
        .from(salesOrderRows)
        .innerJoin(salesOrders, eq(salesOrders.id, salesOrderRows.salesOrderId))
        .innerJoin(articles, eq(articles.id, salesOrderRows.articleId))
        .innerJoin(units, eq(units.id, articles.unitId))
        .leftJoin(rowUnits, eq(rowUnits.id, salesOrderRows.unitId))
        .where(
          and(
            eq(salesOrders.customerId, customerId),
            inArray(salesOrders.status, ["delivered", "in_production", "invoiced"]),
            sql`${salesOrderRows.quantityDelivered} > 0`
          )
        )
        .orderBy(asc(salesOrders.orderNumber));

      const invoiced = await getInvoicedQuantities(
        rows.map((r) => r.salesOrderRowId),
        { includeDrafts: true }
      );

      const orders = new Map<
        string,
        {
          orderId: string;
          orderNumber: string;
          currency: string;
          exchangeRate: string;
          rows: {
            salesOrderRowId: string;
            articleId: string;
            articleNumber: string;
            articleName: string;
            unitPrice: string;
            discountPercent: string;
            unitId: string | null;
            unitFactor: string | null;
            unitCode: string;
            vatRate: string;
            articleType: string;
            rest: number;
            configuration: OrderRowConfiguration | null;
          }[];
        }
      >();
      for (const r of rows) {
        const rest = Number(r.quantityDelivered) - (invoiced.get(r.salesOrderRowId) ?? 0);
        if (rest <= 0) continue;
        let order = orders.get(r.orderId);
        if (!order) {
          order = { orderId: r.orderId, orderNumber: r.orderNumber, currency: r.currency, exchangeRate: r.exchangeRate, rows: [] };
          orders.set(r.orderId, order);
        }
        order.rows.push({
          salesOrderRowId: r.salesOrderRowId,
          articleId: r.articleId,
          articleNumber: r.articleNumber,
          articleName: r.articleName,
          unitPrice: r.unitPrice,
          discountPercent: r.discountPercent,
          unitId: r.unitId,
          unitFactor: r.unitFactor,
          unitCode: r.unitCode,
          vatRate: r.vatRate,
          articleType: r.articleType,
          rest,
          configuration: r.configuration as OrderRowConfiguration | null,
        });
      }
      return [...orders.values()];
    },

    // Frakt etapp 2: the shipment a freight row wants to bill, plus whether
    // ANY invoice row already holds it (cancelled drafts release theirs, so
    // "exists" is exactly the unique index's view).
    async findShipmentForInvoicing(id: string) {
      const [row] = await db
        .select({
          id: shipments.id,
          shipmentNumber: shipments.shipmentNumber,
          customerId: shipments.customerId,
          status: shipments.status,
          // Written out by hand: in a SELECT list drizzle renders interpolated
          // columns unqualified, so `${shipments.id}` became a bare "id" that
          // resolved to invoice_rows.id inside the subquery — always false.
          invoiced: sql<boolean>`exists (select 1 from invoice_rows ir where ir.shipment_id = shipments.id)`,
          // Valuta: the currency of the order the first live följesedel
          // belongs to (written out by hand for the same reason as above).
          orderCurrency: sql<string | null>`(
            select so.currency from shipment_deliveries sd
            join deliveries d on d.id = sd.delivery_id
            join sales_orders so on so.id = d.sales_order_id
            where sd.shipment_id = shipments.id and sd.active
            order by d.delivery_number limit 1)`,
        })
        .from(shipments)
        .where(eq(shipments.id, id));
      return row ?? null;
    },

    listInvoiceableShipments,

    // Header + rows in one transaction — no number allocation here (the FA
    // number is assigned at issue, Task 4).
    // `inTx` runs last inside the create transaction (Avvikelser: the case
    // link of Skapa kreditfaktura).
    async create(
      header: InvoiceHeaderWrite,
      rows: InvoiceRowWrite[],
      createdBy: string,
      inTx?: (tx: Tx, invoiceId: string) => Promise<unknown>
    ) {
      return db.transaction(async (tx) => {
        const { invoice } = await repository.createInTx(tx, header, rows, createdBy);
        if (inTx) await inTx(tx, invoice.id);
        return invoice;
      });
    },

    // The insert itself, in the CALLER's transaction — Räntefakturering
    // writes its invoices and their late_interest_charges rows (which
    // reference the row ids returned here) in one transaction. Row ids come
    // back in input order.
    async createInTx(tx: Tx, header: InvoiceHeaderWrite, rows: InvoiceRowWrite[], createdBy: string) {
      const [invoice] = await tx
        .insert(invoices)
        .values({
          customerId: header.customerId,
          paymentTermId: header.paymentTermId,
          note: header.note,
          type: header.type ?? "invoice",
          creditedInvoiceId: header.creditedInvoiceId ?? null,
          // Valuta: SEK is always rate 1; another currency carries its
          // typed rate (or a credit note's source rate), else null until
          // Utfärda.
          currency: header.currency ?? SEK,
          exchangeRate:
            (header.currency ?? SEK) === SEK ? "1" : header.exchangeRate == null ? null : String(header.exchangeRate),
          exchangeRateManual: header.exchangeRateManual ?? false,
          createdBy,
        })
        .returning();
      await assertShipmentsBillable(tx, rows);
      if (rows.length === 0) return { invoice: invoice!, rowIds: [] as string[] };
      // createdAt is stamped explicitly, one tick per row, instead of
      // relying on the column's now()-default: Postgres evaluates now()
      // once per transaction, so every row in this single multi-row
      // INSERT would otherwise share the exact same timestamp — leaving
      // listRows' `ORDER BY createdAt` with nothing to break the tie,
      // so ties resolve however the planner's access path happens to
      // visit them (occasionally NOT insertion order). Explicit,
      // strictly-increasing timestamps make that order deterministic
      // and match input order (same fix as verificationRows below).
      const now = Date.now();
      const inserted = await tx
        .insert(invoiceRows)
        .values(
          rows.map((r, i) => ({
            invoiceId: invoice!.id,
            articleId: r.articleId,
            salesOrderRowId: r.salesOrderRowId,
            shipmentId: r.shipmentId,
            description: r.description,
            quantity: String(r.quantity),
            unitPrice: String(r.unitPrice),
            discountPercent: String(r.discountPercent),
            unitId: r.unitId,
            unitFactor: r.unitFactor !== null ? String(r.unitFactor) : null,
            vatRate: String(r.vatRate),
            vatCodeId: rowVatCodeId(r),
            lineAmount: String(r.lineAmount),
            vatAmount: String(r.vatAmount),
            deliveryDate: r.deliveryDate ?? null,
            configuration: r.configuration,
            costCenterId: r.costCenterId ?? null,
            projectId: r.projectId ?? null,
            revenueAccount: r.revenueAccount ?? null,
            createdAt: new Date(now + i),
          }))
        )
        .returning({ id: invoiceRows.id, createdAt: invoiceRows.createdAt });
      // Input order = createdAt order (stamped one tick apart above).
      inserted.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      return { invoice: invoice!, rowIds: inserted.map((row) => row.id) };
    },

    async list(query: ListInvoicesQuery) {
      const conditions = [];
      if (query.search) {
        const pattern = ilikePattern(query.search);
        conditions.push(or(ilike(invoices.invoiceNumber, pattern), ilike(customers.name, pattern)));
      }
      if (query.status) conditions.push(inArray(invoices.status, query.status));
      if (query.type) conditions.push(eq(invoices.type, query.type));
      if (query.customerId) conditions.push(eq(invoices.customerId, query.customerId));
      const where = conditions.length > 0 ? and(...conditions) : undefined;

      // Per-invoice SUM over its rows — stored amounts are always positive,
      // the `type` column communicates credit (never the amounts here).
      const netAmount = sql<string>`COALESCE((SELECT SUM(${invoiceRows.lineAmount}) FROM ${invoiceRows} WHERE ${invoiceRows.invoiceId} = ${invoices.id}), 0)`;
      const vatAmount = sql<string>`COALESCE((SELECT SUM(${invoiceRows.vatAmount}) FROM ${invoiceRows} WHERE ${invoiceRows.invoiceId} = ${invoices.id}), 0)`;

      // customerName prefers the invoice's own frozen snapshot (set at issue)
      // over the live join — a draft has no snapshot yet (null) so it falls
      // through to the customer's current name; an issued/paid invoice keeps
      // showing the name as it was at issue even after the customer is renamed.
      const customerName = sql<string>`COALESCE(${invoices.customerName}, ${customers.name})`;

      // E-faktura: the latest transmission's status and environment (null =
      // never sent as an e-invoice), for the list's E-faktura column. A
      // production transmission always wins over a sandbox trial, however
      // old — the column must never read "Mottagen" for a sandbox send
      // when a real one exists.
      const latestTransmission = sql`FROM ${einvoiceTransmissions} t WHERE t.invoice_id = ${invoices.id} ORDER BY (t.environment = 'production') DESC, t.started_at DESC, t.id DESC LIMIT 1`;
      const einvoiceStatus = sql<EinvoiceStatus | null>`(SELECT t.status ${latestTransmission})`;
      const einvoiceEnvironment = sql<"sandbox" | "production" | null>`(SELECT t.environment ${latestTransmission})`;

      const [rows, totalRows] = await Promise.all([
        db
          .select({
            ...getTableColumns(invoices),
            customerName,
            netAmount,
            vatAmount,
            verificationDisplayNumber: verificationDisplayNumberSql,
            einvoiceStatus,
            einvoiceEnvironment,
          })
          .from(invoices)
          .innerJoin(customers, eq(customers.id, invoices.customerId))
          // Automatkontering (B2) — three left joins so the list can link
          // straight to the verification each invoice booked. Not needed by
          // the count query below, which only needs the same `where`.
          .leftJoin(verifications, eq(verifications.id, invoices.verificationId))
          .leftJoin(verificationSeries, eq(verificationSeries.id, verifications.seriesId))
          .leftJoin(fiscalYears, eq(fiscalYears.id, verifications.fiscalYearId))
          .where(where)
          .orderBy(desc(invoices.createdAt))
          .limit(query.limit)
          .offset(query.offset),
        db
          .select({ total: count() })
          .from(invoices)
          .innerJoin(customers, eq(customers.id, invoices.customerId))
          .where(where),
      ]);
      return { rows, total: totalRows[0]!.total };
    },

    // Joined header for the detail GET (customer + payment term label). Same
    // COALESCE-the-snapshot-first rule as list() above: a draft (no snapshot
    // yet) shows the live customer/term, an issued/paid invoice shows the
    // values frozen at issue regardless of later edits.
    async findById(id: string) {
      const [row] = await db
        .select({
          ...getTableColumns(invoices),
          customerName: sql<string>`COALESCE(${invoices.customerName}, ${customers.name})`,
          paymentTermCode: sql<string | null>`COALESCE(${invoices.paymentTermCode}, ${paymentTerms.code})`,
          paymentTermName: sql<string | null>`COALESCE(${invoices.paymentTermName}, ${paymentTerms.name})`,
          verificationDisplayNumber: verificationDisplayNumberSql,
        })
        .from(invoices)
        .innerJoin(customers, eq(customers.id, invoices.customerId))
        .leftJoin(paymentTerms, eq(paymentTerms.id, invoices.paymentTermId))
        .leftJoin(verifications, eq(verifications.id, invoices.verificationId))
        .leftJoin(verificationSeries, eq(verificationSeries.id, verifications.seriesId))
        .leftJoin(fiscalYears, eq(fiscalYears.id, verifications.fiscalYearId))
        .where(eq(invoices.id, id));
      return row ?? null;
    },

    // Raw row for status/transition checks (no joins).
    async findRawById(id: string) {
      const [row] = await db.select().from(invoices).where(eq(invoices.id, id));
      return row ?? null;
    },

    // Reverse of creditedInvoiceId: every credit note that targets THIS
    // invoice, for the detail GET's "Krediterad av" links (mirrors the
    // forward "Krediterar faktura" lookup buildPdf already does). A
    // cancelled credit never happened (same status the open-amount reader
    // and every other "still counts" filter excludes), but a draft credit
    // is deliberately included — the web labels its null invoiceNumber
    // "Utkast" rather than hiding a credit that is already in progress.
    async listCreditedBy(id: string) {
      return db
        .select({ id: invoices.id, invoiceNumber: invoices.invoiceNumber })
        .from(invoices)
        .where(and(eq(invoices.creditedInvoiceId, id), ne(invoices.status, "cancelled")))
        .orderBy(asc(invoices.createdAt));
    },

    async listRows(invoiceId: string) {
      const rowUnits = alias(units, "row_units");
      return db
        .select({
          ...getTableColumns(invoiceRows),
          articleNumber: articles.articleNumber,
          articleName: articles.name,
          salesOrderNumber: salesOrders.orderNumber,
          // Printed with the order number under the row on the invoice PDF —
          // a samlingsfaktura mixes orders, so "Ert ordernummer" is per row.
          customerOrderNumber: salesOrders.customerOrderNumber,
          // The unit the row displays in: the row's own snapshot unit,
          // falling back to the article's base unit — null for a free row
          // (no article to derive a base unit from). Mirrors
          // sales.repository's listRowsByOrder.
          unitCode: sql<string | null>`coalesce(${rowUnits.code}, ${units.code})`,
          // Frakt etapp 2: the billed shipment's number, so the card can link
          // to the försändelse (null on every non-freight row).
          shipmentNumber: shipments.shipmentNumber,
          // Momskoder: the row's code as the company names it, with its
          // invoice text (the PDF prints it, the e-invoice's BT-120 for OB).
          vatCode: {
            id: vatCodes.id,
            code: vatCodes.code,
            name: vatCodes.name,
            invoiceText: vatCodes.invoiceText,
          },
          // Kostnadsställen och projekt on the revenue row.
          ...rowDimensionColumns,
        })
        .from(invoiceRows)
        .innerJoin(vatCodes, eq(vatCodes.id, invoiceRows.vatCodeId))
        .leftJoin(articles, eq(articles.id, invoiceRows.articleId))
        .leftJoin(units, eq(units.id, articles.unitId))
        .leftJoin(rowUnits, eq(rowUnits.id, invoiceRows.unitId))
        .leftJoin(salesOrderRows, eq(salesOrderRows.id, invoiceRows.salesOrderRowId))
        .leftJoin(salesOrders, eq(salesOrders.id, salesOrderRows.salesOrderId))
        .leftJoin(shipments, eq(shipments.id, invoiceRows.shipmentId))
        .leftJoin(rowCostCenters, eq(rowCostCenters.id, invoiceRows.costCenterId))
        .leftJoin(rowProjects, eq(rowProjects.id, invoiceRows.projectId))
        .where(eq(invoiceRows.invoiceId, invoiceId))
        .orderBy(asc(invoiceRows.createdAt));
    },

    // Row-locks the invoice and re-checks status = "draft" in the same
    // transaction — the service's own status guard reads the invoice BEFORE
    // this transaction opens, so a concurrent issue() between that read and
    // this write would otherwise land a header edit on a just-frozen
    // invoice. Returns null (no write performed) when the invoice is no
    // longer a draft, same "lost the race" convention as issueInvoice.
    async updateHeader(id: string, patch: HeaderPatch) {
      return db.transaction(async (tx) => {
        const [invoice] = await tx.select().from(invoices).where(eq(invoices.id, id)).for("update");
        if (!invoice || invoice.status !== "draft") return null;
        const { exchangeRate, ...rest } = patch;
        const [row] = await tx
          .update(invoices)
          .set({
            ...rest,
            ...(exchangeRate !== undefined ? { exchangeRate: exchangeRate === null ? null : String(exchangeRate) } : {}),
            updatedAt: new Date(),
          })
          .where(eq(invoices.id, id))
          .returning();
        return row ?? null;
      });
    },

    // Unconditional status write, kept as a TEST SEAM only: no production
    // path calls it (every real transition goes through issueInvoice /
    // cancelInvoice here or the payment registration's own conditional
    // paid-flip in payment.repository.ts, all conditional on the current
    // status). The service tests use it to force an invoice into a given
    // status without replaying the transitions — do not reach for it in src.
    async updateStatus(id: string, status: InvoiceStatus) {
      const [row] = await db
        .update(invoices)
        .set({ status, updatedAt: new Date() })
        .where(eq(invoices.id, id))
        .returning();
      return row ?? null;
    },

    // code/name for a specific payment term id — used to resolve the
    // invoice's own paymentTermId (or, when absent, the customer's) into the
    // text snapshotted onto the invoice at issue.
    async findPaymentTermById(id: string) {
      const [row] = await db
        .select({ code: paymentTerms.code, name: paymentTerms.name })
        .from(paymentTerms)
        .where(eq(paymentTerms.id, id));
      return row ?? null;
    },

    // draft -> issued: allocates the FA number + OCR and stamps the frozen
    // snapshot, all inside one transaction — a failed order-status recompute
    // rolls back the number allocation too, so a failed transition never
    // burns a number (same guarantee as invoiceOrder). The UPDATE is
    // conditional on status = "draft" (not just id) to close a race: the
    // service's own draft-status guard reads the invoice BEFORE this
    // transaction opens, so two concurrent issue() calls on the same draft
    // can both pass that guard and both reach here. Without the status
    // condition, the second UPDATE would silently overwrite the first's FA
    // number/OCR/snapshot — burning a number and breaking the unbroken-series
    // invariant. With it, the second call's UPDATE matches zero rows;
    // throwing IssueRaceError inside the tx forces a rollback that undoes
    // ITS number allocation (the first call's number, already committed by
    // then, is unaffected). The catch right below normalizes that internal
    // signal to `{ ok: false, reason: "race" }`, matching how every other
    // conditional update in this repo (updateHeader/updateRow/deleteRow/
    // cancelInvoice — NOT updateStatus, which is an unconditional test seam,
    // see its own comment) reports "no matching row" — the service decides
    // what error that becomes. validateCommittedQuantities
    // (see its own comment) runs first, inside the same transaction, and
    // closes the over-invoicing/over-crediting race the create-time guard
    // alone can't: it re-checks the committed (non-draft) state at the
    // actual commitment point, throwing CommitOverInvoicingError/
    // CommitOverCreditingError — normalized below the same way.
    //
    // Automatkontering (B2): the F verification is booked in this SAME
    // transaction, right after the conditional UPDATE has proved this call
    // won the race (so the loser never posts anything) and before the
    // order-status recompute. The poster's own errors — locked/absent
    // accounting period, missing or inactive posting account, unknown VAT
    // rate, zero amount — are DELIBERATELY not caught here: the catch below
    // only normalizes this file's internal control-flow signals, so a
    // posting failure propagates to the service/routes as a 409 and takes
    // the whole transition with it, FA number and order status included.
    async issueInvoice(
      id: string,
      stamp: IssueStamp,
      type: InvoiceType,
      userId: string,
      poster: CustomerInvoicePoster,
      vatNumberCheck?: BuyerVatNumberCheck
    ): Promise<IssueInvoiceResult> {
      try {
        return await db.transaction(async (tx) => {
          await validateCommittedQuantities(tx, id, type);

          const invoiceNumber = await getNextOrderNumber(tx, "invoice");
          const ocrNumber = computeOcrNumber(invoiceNumber);
          // Valuta: conditional on the rate state the service decided on —
          // a rate typed in (or cleared) since then is a lost race.
          const { exchangeRate, exchangeRateManual, ...frozen } = stamp;
          const [row] = await tx
            .update(invoices)
            .set({
              invoiceNumber,
              ocrNumber,
              status: "issued",
              issuedAt: new Date(),
              updatedAt: new Date(),
              ...frozen,
              ...(exchangeRate !== undefined ? { exchangeRate: String(exchangeRate) } : {}),
            })
            .where(
              and(
                eq(invoices.id, id),
                eq(invoices.status, "draft"),
                exchangeRateManual !== undefined ? eq(invoices.exchangeRateManual, exchangeRateManual) : undefined,
                exchangeRateManual && exchangeRate !== undefined ? eq(invoices.exchangeRate, String(exchangeRate)) : undefined
              )
            )
            .returning();
          if (!row) throw new IssueRaceError();
          // The rate the F verification books at — what the UPDATE just
          // stamped (SEK is always 1).
          const bookedRate = row.currency === SEK ? 1 : row.exchangeRate === null ? undefined : Number(row.exchangeRate);

          // G1 fix: while the invoice was a draft, its row/header audit
          // events (row_added/row_updated/row_deleted/updated) were logged
          // under the invoice's uuid — invoiceNumber didn't exist yet, per
          // the entityId convention's "annars uuid" fallback. The card's
          // Historik queries by invoiceNumber once issued, so those rows
          // would otherwise be orphaned and practically undiscoverable.
          // Re-key entity_id to the newly minted invoiceNumber here, in the
          // same atomic step as the number itself — this is IDENTITY
          // RESOLUTION (entity_id is a foreign-key-shaped pointer at "this
          // invoice", not a historical fact), never a rewrite of what
          // happened: action/detail/user_id/created_at are untouched.
          await tx
            .update(auditLog)
            .set({ entityId: invoiceNumber })
            .where(and(eq(auditLog.entityType, "invoice"), eq(auditLog.entityId, id)));

          // Leveransdatum (spec 4.4, ML 17 kap. 24 § p. 7): a row billed
          // against an order row carries the day of a delivery that still
          // stands. When the delivery its date came from was undone (Ångra
          // utleverans) after the draft row was made — the date is the day of
          // an undone delivery of the order row and no live one falls on it —
          // it moves to the last live delivery day up to the invoice date, or
          // null when there is none. A date set by hand (rad-PATCH, any day
          // that never was a delivery of the row) and a null are left alone.
          // Credit notes keep their source row's date (the supply they
          // reverse).
          if (type === "invoice") {
            await tx.execute(sql`
              WITH deliveries_of_rows AS (
                SELECT dr.sales_order_row_id,
                       (d.delivered_at AT TIME ZONE 'Europe/Stockholm')::date AS day,
                       dr.undone_at IS NULL AS live
                FROM delivery_rows dr
                JOIN deliveries d ON d.id = dr.delivery_id
                WHERE dr.sales_order_row_id IN (
                  SELECT sales_order_row_id FROM invoice_rows WHERE invoice_id = ${id} AND sales_order_row_id IS NOT NULL
                )
              ),
              target AS (
                SELECT ir.id,
                       (SELECT max(x.day) FROM deliveries_of_rows x
                        WHERE x.sales_order_row_id = ir.sales_order_row_id AND x.live AND x.day <= ${stamp.invoiceDate}::date) AS day
                FROM invoice_rows ir
                WHERE ir.invoice_id = ${id}
                  AND ir.sales_order_row_id IS NOT NULL
                  AND ir.delivery_date IS NOT NULL
                  AND EXISTS (
                    SELECT 1 FROM deliveries_of_rows x
                    WHERE x.sales_order_row_id = ir.sales_order_row_id AND NOT x.live AND x.day = ir.delivery_date
                  )
                  AND NOT EXISTS (
                    SELECT 1 FROM deliveries_of_rows x
                    WHERE x.sales_order_row_id = ir.sales_order_row_id AND x.live AND x.day = ir.delivery_date
                  )
              )
              UPDATE invoice_rows SET delivery_date = target.day
              FROM target
              WHERE invoice_rows.id = target.id`);
          }

          // The article's group decides which konteringsregel applies; a
          // free row (no article) and an article without a group both come
          // back null and fall through to the settings default. Amounts are
          // read straight off the stored columns — always positive, also on
          // a credit note, which the poster mirrors itself from `type`.
          // Each row's momskod (accounts included) is joined in the same
          // read, through this transaction.
          const postingRows = await tx
            .select({
              id: invoiceRows.id,
              articleGroupId: articles.groupId,
              lineAmount: invoiceRows.lineAmount,
              vatAmount: invoiceRows.vatAmount,
              vatRate: invoiceRows.vatRate,
              vatCode: postingVatCodeColumns,
              // Kostnadsställen och projekt: onto the revenue row only.
              costCenterId: invoiceRows.costCenterId,
              projectId: invoiceRows.projectId,
              // Dröjsmålsränta: the row's own revenue account (8313/3990).
              revenueAccount: invoiceRows.revenueAccount,
            })
            .from(invoiceRows)
            .innerJoin(vatCodes, eq(vatCodes.id, invoiceRows.vatCodeId))
            .leftJoin(articles, eq(articles.id, invoiceRows.articleId))
            .where(eq(invoiceRows.invoiceId, id))
            // id breaks a createdAt tie (rows inserted in one statement share
            // it), so the restmetod sees the rows in one fixed order.
            .orderBy(asc(invoiceRows.createdAt), asc(invoiceRows.id));

          // Momskoder (spec 4.2): a code requiring the buyer's
          // momsregistreringsnummer needs one, in the right form, on the
          // invoice being issued. Checked on the rows as they stand under this
          // transaction (a concurrent addRow waits for the invoice lock taken
          // by the UPDATE above), so the FA number rolls back with a refusal.
          if (vatNumberCheck) {
            const problem = buyerVatNumberProblem({
              codes: postingRows.flatMap((postingRow) => (isVatCode(postingRow.vatCode.code) ? [postingRow.vatCode.code] : [])),
              vatNumber: vatNumberCheck.vatNumber,
              country: vatNumberCheck.country,
            });
            if (problem) {
              throw new VatNumberRequiredError(problem.reason, problem.code, problem.reason === "eu_format" ? problem.prefix : null);
            }
          }

          const { verificationId } = await poster.postCustomerInvoice(
            tx,
            {
              invoiceNumber,
              type,
              invoiceDate: stamp.invoiceDate,
              customerName: stamp.customerName,
              currency: row.currency,
              exchangeRate: bookedRate,
            },
            postingRows.map((postingRow) => ({
              articleGroupId: postingRow.articleGroupId,
              lineAmount: Number(postingRow.lineAmount),
              vatAmount: Number(postingRow.vatAmount),
              vatRate: Number(postingRow.vatRate),
              vatCode: postingRow.vatCode,
              costCenterId: postingRow.costCenterId,
              projectId: postingRow.projectId,
              revenueAccount: postingRow.revenueAccount,
            })),
            userId
          );
          // Valuta: the receivable in SEK and each row's net in SEK, exactly
          // what the F verification booked — the same restmetod
          // (invoiceSekAmounts) over the same rows in the same order,
          // positive like the rows (the sign is invoices.type). The rows'
          // share is stored (line_amount_sek) so a later reader — the
          // periodisk sammanställning — sums the booked SEK instead of
          // recomputing it.
          const sek = invoiceSekAmounts({
            rate: bookedRate!,
            rows: postingRows.map((postingRow) => ({ lineAmount: Number(postingRow.lineAmount), vatAmount: Number(postingRow.vatAmount) })),
          });
          if (postingRows.length > 0) {
            const values = sql.join(
              postingRows.map((postingRow, index) => sql`(${postingRow.id}::uuid, ${String(sek.rows[index]!.lineAmount)}::numeric)`),
              sql`, `
            );
            await tx.execute(sql`
              UPDATE invoice_rows SET line_amount_sek = v.amount
              FROM (VALUES ${values}) AS v(id, amount)
              WHERE invoice_rows.id = v.id`);
          }
          const [posted] = await tx
            .update(invoices)
            .set({ verificationId, grossAmountSek: String(sek.grossAmount) })
            .where(eq(invoices.id, id))
            .returning();

          await recomputeOrderInvoiceStatus(tx, id);
          // Tillägg: invoice.issued (customer and credit invoices alike).
          await pluginEvents.emit(tx, { type: "invoice.issued", entityId: id, entityNumber: invoiceNumber });
          return { ok: true as const, invoice: posted! };
        });
      } catch (err) {
        if (err instanceof IssueRaceError) return { ok: false, reason: "race" };
        if (err instanceof CommitOverInvoicingError) return { ok: false, reason: "over_invoicing" };
        if (err instanceof CommitOverCreditingError) return { ok: false, reason: "over_crediting" };
        throw err;
      }
    },

    // Dröjsmålsränta: the charges made ON this source invoice (with the
    // derived `active`), and whether the invoice is itself a räntefaktura.
    async listLateInterestCharges(invoiceId: string) {
      return (await chargesByInvoice(db, [invoiceId])).get(invoiceId) ?? [];
    },

    async isLateInterestInvoice(invoiceId: string) {
      return isLateInterestInvoice(db, invoiceId);
    },

    // The live payment rows as the dröjsmålsränta reads them (day, amount).
    async listLateInterestPayments(invoiceId: string) {
      return (await paymentsByInvoice(db, [invoiceId])).get(invoiceId) ?? [];
    },

    // The dröjsmålsränta slice of the posting settings (the invoice text,
    // the reminder's accrued interest). Same leaf as getReminderFee.
    async getLateInterestSettings() {
      const settings = await readPostingSettings(db);
      return {
        lateInterestEnabled: settings.lateInterestEnabled,
        lateInterestMargin: settings.lateInterestMargin,
        lateInterestMinAmount: settings.lateInterestMinAmount,
        lateFeeEnabled: settings.lateFeeEnabled,
        postingLateInterest: settings.postingLateInterest,
        postingLateFee: settings.postingLateFee,
      };
    },

    // Kundreskontra (B3): what is still open on this invoice, and which
    // payments have touched it. Both are reads for the invoice CARD — the
    // issued -> paid transition itself belongs to the payment registration's
    // transaction (payment.repository.ts), which is why there is no markPaid
    // here any more.
    async getOpenAmount(id: string) {
      return (await computeOpenAmounts(db, [id])).get(id) ?? 0;
    },

    // Valuta: the same open item's booked SEK value (null until issued).
    async getOpenAmountSek(id: string) {
      return (await computeOpenAmountsSek(db, [id])).get(id) ?? null;
    },

    // Cancelled payments stay visible (append-only) and are marked as such
    // rather than filtered away — they no longer settle anything, which is
    // exactly what the open amount above already reflects.
    // Valuta: the payment's currency (= the invoice's) and the SEK each part
    // released from the invoice's booked receivable (frigjort SEK — equal to
    // the amounts on a SEK invoice), as numbers.
    async listPaymentsForInvoice(invoiceId: string) {
      const rows = await db
        .select({
          paymentId: customerPayments.id,
          paymentNumber: customerPayments.paymentNumber,
          paymentDate: customerPayments.paymentDate,
          appliedAmount: customerPaymentRows.appliedAmount,
          writeOffAmount: customerPaymentRows.writeOffAmount,
          currency: customerPayments.currency,
          appliedAmountSek: customerPaymentRows.appliedAmountSek,
          writeOffAmountSek: customerPaymentRows.writeOffAmountSek,
          cancelledAt: customerPayments.cancelledAt,
          verificationId: customerPayments.verificationId,
          verificationDisplayNumber: verificationDisplayNumberSql,
        })
        .from(customerPaymentRows)
        .innerJoin(customerPayments, eq(customerPayments.id, customerPaymentRows.paymentId))
        .leftJoin(verifications, eq(verifications.id, customerPayments.verificationId))
        .leftJoin(verificationSeries, eq(verificationSeries.id, verifications.seriesId))
        .leftJoin(fiscalYears, eq(fiscalYears.id, verifications.fiscalYearId))
        .where(eq(customerPaymentRows.invoiceId, invoiceId))
        .orderBy(asc(customerPaymentRows.createdAt));
      return rows.map((row) => ({ ...row, appliedAmountSek: Number(row.appliedAmountSek), writeOffAmountSek: Number(row.writeOffAmountSek) }));
    },

    // Betalningspåminnelser (B3): the invoice's own reminder history, newest
    // last (level order). The fee's K verification is joined for its display
    // number the same way the invoice's own F verification is.
    async listRemindersForInvoice(invoiceId: string) {
      return db
        .select({
          id: invoiceReminders.id,
          level: invoiceReminders.level,
          fee: invoiceReminders.fee,
          sentAt: invoiceReminders.sentAt,
          feeVerificationId: invoiceReminders.feeVerificationId,
          feeVerificationDisplayNumber: verificationDisplayNumberSql,
          // The archived PDF as sent (null for reminders sent before the
          // archive existed).
          documentId: invoiceDocuments.id,
        })
        .from(invoiceReminders)
        .leftJoin(invoiceDocuments, eq(invoiceDocuments.reminderId, invoiceReminders.id))
        .leftJoin(verifications, eq(verifications.id, invoiceReminders.feeVerificationId))
        .leftJoin(verificationSeries, eq(verificationSeries.id, verifications.seriesId))
        .leftJoin(fiscalYears, eq(fiscalYears.id, verifications.fiscalYearId))
        .where(eq(invoiceReminders.invoiceId, invoiceId))
        .orderBy(asc(invoiceReminders.level), asc(invoiceReminders.sentAt));
    },

    // Pre-flight for the fee posting, run OUTSIDE any transaction (this
    // repository owns the db handle the poster needs; the service has none).
    // Throws the same typed errors the in-tx posting would — see the poster's
    // assertReminderFeePostable and sendReminder's ordering comment.
    async assertFeePostable(poster: InvoiceReminderPoster, reminderDate: string) {
      return poster.assertReminderFeePostable(db, reminderDate);
    },

    // The påminnelseavgift as configured under Systeminställningar. Read
    // through the same posting-settings leaf the poster itself uses (a Db here,
    // the caller's Tx there), so the form, the PDF and the verification can
    // never disagree about the amount.
    async getReminderFee() {
      return round2((await readPostingSettings(db)).reminderFee);
    },

    // Persists a reminder whose email HAS ALREADY BEEN SENT — one transaction,
    // in this order and no other:
    //   1. row-lock the invoice (FOR UPDATE): the serialization point against
    //      a concurrent payment/reminder on the same invoice,
    //   2. re-check everything the service checked before the send — status,
    //      open amount, and (for a fee) that no fee row exists yet. The
    //      service's own guards ran BEFORE the SMTP round trip, so this is the
    //      only check that decides anything: a payment that closed the invoice
    //      meanwhile must not be answered with a fee,
    //   3. insert the reminder row,
    //   4. for a fee: book the K verification and stamp its id.
    //
    // Steps 3-4 commit together, so a fee can never exist without its
    // verification (or the other way round). The poster's own errors — locked
    // period, missing account — are DELIBERATELY not caught: only this file's
    // internal signal is normalized below, so a posting failure rolls the
    // whole reminder back.
    async createReminder(
      invoiceId: string,
      write: ReminderWrite,
      userId: string,
      poster: InvoiceReminderPoster
    ): Promise<CreateReminderResult> {
      try {
        return await db.transaction(async (tx) => {
          const [invoice] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId)).for("update");
          if (!invoice) throw new ReminderGuardError("not_found");
          if (invoice.status !== "issued") throw new ReminderGuardError("not_issued");

          const open = round2((await computeOpenAmounts(tx, [invoiceId])).get(invoiceId) ?? 0);
          if (open <= 0) throw new ReminderGuardError("not_open");

          const fee = round2(write.fee);
          if (fee > 0) {
            // The friendly half of the invoice_reminders_one_fee index: it
            // reports the collision as a 409 instead of a 23505. The index is
            // still what guarantees it (see the service's own 23505 mapping).
            const [charged] = await tx
              .select({ id: invoiceReminders.id })
              .from(invoiceReminders)
              .where(and(eq(invoiceReminders.invoiceId, invoiceId), sql`${invoiceReminders.fee} > 0`));
            if (charged) throw new ReminderGuardError("fee_already_charged");
            // Dröjsmålsränta: an active förseningsersättning covers the fee
            // (inkassokostnadslagen 5 §) — re-checked under the lock, since
            // Skapa räntefakturor takes the same lock.
            const charges = (await chargesByInvoice(tx, [invoiceId])).get(invoiceId) ?? [];
            if (charges.some((charge) => charge.active && charge.fee > 0)) throw new ReminderGuardError("late_fee_charged");
          }

          const [reminder] = await tx
            .insert(invoiceReminders)
            .values({
              invoiceId,
              level: write.level,
              fee: String(fee),
              sentAt: write.sentAt,
              createdBy: userId,
            })
            .returning();

          let feeVerificationId: string | null = null;
          if (fee > 0) {
            const posted = await poster.postReminderFee(
              tx,
              {
                invoiceNumber: invoice.invoiceNumber!,
                reminderDate: write.reminderDate,
                // The frozen snapshot — an issued invoice always has one.
                customerName: invoice.customerName ?? "",
                feeAmount: fee,
              },
              userId
            );
            feeVerificationId = posted.verificationId;
            await tx
              .update(invoiceReminders)
              .set({ feeVerificationId })
              .where(eq(invoiceReminders.id, reminder!.id));
          }

          await tx.insert(invoiceDocuments).values({
            invoiceId,
            kind: "reminder",
            reminderId: reminder!.id,
            filename: write.document.filename,
            sizeBytes: write.document.content.length,
            sha256: sha256Hex(write.document.content),
            data: write.document.content,
          });

          return { ok: true as const, reminderId: reminder!.id, feeVerificationId };
        });
      } catch (err) {
        if (err instanceof ReminderGuardError) return { ok: false, reason: err.reason };
        throw err;
      }
    },

    // draft -> cancelled only. Conditional on status = "draft" so a
    // concurrent issue() between the service's own guard and this UPDATE can
    // never leave a cancelled invoice holding a burned FA number/snapshot —
    // the same race issueInvoice's own conditional UPDATE closes.
    //
    // Frakt etapp 2: one transaction with the row-side release below — the
    // unique shipment index cannot see invoice status, so a cancelled draft
    // lets go of its freight (shipment_id := null on its rows) so the
    // shipment can be billed again. The rows themselves stay (the cancelled
    // draft still shows what it would have billed).
    async cancelInvoice(id: string) {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .update(invoices)
          .set({ status: "cancelled", updatedAt: new Date() })
          .where(and(eq(invoices.id, id), eq(invoices.status, "draft")))
          .returning();
        if (!row) return null;
        await tx
          .update(invoiceRows)
          .set({ shipmentId: null })
          .where(and(eq(invoiceRows.invoiceId, id), isNotNull(invoiceRows.shipmentId)));
        return row;
      });
    },

    // Row-locks the invoice and re-checks status = "draft" in the same
    // transaction — same race this closes for updateHeader above: a row
    // must never be added to an invoice a concurrent issue() just froze.
    async addRow(invoiceId: string, row: InvoiceRowWrite) {
      return db.transaction(async (tx) => {
        const [invoice] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId)).for("update");
        if (!invoice || invoice.status !== "draft") return null;
        await assertShipmentsBillable(tx, [row]);
        const [inserted] = await tx
          .insert(invoiceRows)
          .values({
            invoiceId,
            articleId: row.articleId,
            salesOrderRowId: row.salesOrderRowId,
            shipmentId: row.shipmentId,
            description: row.description,
            quantity: String(row.quantity),
            unitPrice: String(row.unitPrice),
            discountPercent: String(row.discountPercent),
            unitId: row.unitId,
            unitFactor: row.unitFactor !== null ? String(row.unitFactor) : null,
            vatRate: String(row.vatRate),
            vatCodeId: rowVatCodeId(row),
            lineAmount: String(row.lineAmount),
            vatAmount: String(row.vatAmount),
            deliveryDate: row.deliveryDate ?? null,
            configuration: row.configuration,
            costCenterId: row.costCenterId ?? null,
            projectId: row.projectId ?? null,
            revenueAccount: row.revenueAccount ?? null,
          })
          .returning();
        return inserted ?? null;
      });
    },

    // Scoped to the invoice so a row id from another invoice 404s.
    async findRow(invoiceId: string, rowId: string) {
      const [row] = await db
        .select()
        .from(invoiceRows)
        .where(and(eq(invoiceRows.id, rowId), eq(invoiceRows.invoiceId, invoiceId)));
      return row ?? null;
    },

    // Same draft-only row-lock guard as addRow above.
    async updateRow(invoiceId: string, rowId: string, row: InvoiceRowWrite) {
      return db.transaction(async (tx) => {
        const [invoice] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId)).for("update");
        if (!invoice || invoice.status !== "draft") return null;
        const [updated] = await tx
          .update(invoiceRows)
          .set({
            articleId: row.articleId,
            salesOrderRowId: row.salesOrderRowId,
            description: row.description,
            quantity: String(row.quantity),
            unitPrice: String(row.unitPrice),
            discountPercent: String(row.discountPercent),
            unitId: row.unitId,
            unitFactor: row.unitFactor !== null ? String(row.unitFactor) : null,
            vatRate: String(row.vatRate),
            vatCodeId: rowVatCodeId(row),
            lineAmount: String(row.lineAmount),
            vatAmount: String(row.vatAmount),
            deliveryDate: row.deliveryDate ?? null,
            configuration: row.configuration,
            costCenterId: row.costCenterId ?? null,
            projectId: row.projectId ?? null,
            revenueAccount: row.revenueAccount ?? null,
          })
          .where(and(eq(invoiceRows.id, rowId), eq(invoiceRows.invoiceId, invoiceId)))
          .returning();
        return updated ?? null;
      });
    },

    // Same draft-only row-lock guard as addRow above.
    async deleteRow(invoiceId: string, rowId: string) {
      return db.transaction(async (tx) => {
        const [invoice] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId)).for("update");
        if (!invoice || invoice.status !== "draft") return null;
        const [row] = await tx
          .delete(invoiceRows)
          .where(and(eq(invoiceRows.id, rowId), eq(invoiceRows.invoiceId, invoiceId)))
          .returning();
        return row ?? null;
      });
    },

    // --- Arkiverade fakturadokument (insert-only) ---

    async findDocument(invoiceId: string, ref: ArchivedDocumentRef) {
      const [row] = await db
        .select()
        .from(invoiceDocuments)
        .where(
          and(
            eq(invoiceDocuments.invoiceId, invoiceId),
            eq(invoiceDocuments.kind, ref.kind),
            ref.kind === "reminder"
              ? eq(invoiceDocuments.reminderId, ref.reminderId)
              : isNull(invoiceDocuments.reminderId)
          )
        );
      return row ?? null;
    },

    // First writer wins: ON CONFLICT DO NOTHING against the one-per-invoice
    // partial index, then read back whatever is archived — so two racing
    // first prints still serve one and the same document.
    async archiveInvoiceDocument(invoiceId: string, document: { filename: string; content: Buffer }) {
      await db
        .insert(invoiceDocuments)
        .values({
          invoiceId,
          kind: "invoice",
          filename: document.filename,
          sizeBytes: document.content.length,
          sha256: sha256Hex(document.content),
          data: document.content,
        })
        .onConflictDoNothing();
      const [row] = await db
        .select()
        .from(invoiceDocuments)
        .where(and(eq(invoiceDocuments.invoiceId, invoiceId), eq(invoiceDocuments.kind, "invoice")));
      return row!;
    },
  };
  return repository;
}

export type InvoiceRepository = ReturnType<typeof createInvoiceRepository>;

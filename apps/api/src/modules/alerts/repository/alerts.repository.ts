import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";
import {
  articles,
  customers,
  einvoiceTransmissions,
  emailLog,
  invoices,
  manufacturingOrders,
  paymentBatchItems,
  paymentTerms,
  purchaseOrderRows,
  purchaseOrders,
  salesOrderRows,
  salesOrders,
  stockTransactions,
  supplierInvoices,
  suppliers,
  type Db,
} from "@navet/db";
import { purchaseRowArrivalDate, salesRowDeliveryDate } from "../../planning/repository/effective-dates.js";
import { openAmountSql as invoiceOpenAmountSql } from "../../sales/repository/open-amounts.js";
import { openAmountSql as supplierInvoiceOpenAmountSql } from "../../purchase/repository/open-amounts.js";

// Aviseringar — one reader per kind, every one a question against the
// current state (nothing is stored). The readers reuse the expressions the
// rest of the system already answers with — the effective row dates of the
// planning reads, the ledgers' openAmountSql — so an alert can never
// disagree with the list it points at. `today` is the Stockholm day the
// service hands in (pinned by the tests). The behovsberäkning and the TO
// plan status are not read here: the service gets them through the
// planning service (AlertPlanningReader).

export interface NegativeStockRow {
  articleId: string;
  articleNumber: string;
  articleName: string;
  balance: number;
}

export interface LateOrderRow {
  orderId: string;
  orderNumber: string;
  partnerName: string;
  // The earliest late effective date among the order's open rows.
  earliestDate: string;
}

export interface OpenManufacturingOrderRow {
  orderId: string;
  orderNumber: string;
  articleNumber: string;
  articleName: string;
  dueDate: string | null;
}

export interface QuoteToFollowUpRow {
  orderId: string;
  orderNumber: string;
  customerName: string;
  validUntil: string;
}

export interface OverdueInvoiceRow {
  invoiceId: string;
  invoiceNumber: string | null;
  customerName: string | null;
  dueDate: string;
  openAmount: number;
}

export interface OpenSupplierInvoiceRow {
  invoiceId: string;
  registrationNumber: string;
  invoiceNumber: string;
  supplierName: string;
  invoiceDate: string;
  dueDate: string | null;
  // The supplier's payment term code ("30") for computeDueDate when the
  // invoice was saved without a due date.
  paymentTermCode: string | null;
  openAmount: number;
}

export interface FailedEinvoiceRow {
  invoiceId: string;
  invoiceNumber: string | null;
  customerName: string | null;
  status: "failed" | "rejected";
  errorMessage: string | null;
  startedAt: Date;
}

export interface FailedEmailRow {
  emailId: string;
  documentType: string;
  documentId: string | null;
  recipient: string;
  subject: string;
  error: string | null;
  createdAt: Date;
}

export function createAlertsRepository(db: Db) {
  return {
    // Negativt saldo: the article's total over every location < 0 — the
    // same sum the balance lists show, just the other sign.
    async negativeStock(): Promise<NegativeStockRow[]> {
      const balance = sql<string>`sum(${stockTransactions.quantityDelta})`;
      const rows = await db
        .select({
          articleId: articles.id,
          articleNumber: articles.articleNumber,
          articleName: articles.name,
          balance,
        })
        .from(stockTransactions)
        .innerJoin(articles, eq(articles.id, stockTransactions.articleId))
        .groupBy(articles.id, articles.articleNumber, articles.name)
        .having(sql`${balance} < 0`)
        .orderBy(sql`${balance} asc`, asc(articles.articleNumber));
      return rows.map((r) => ({ ...r, balance: Number(r.balance) }));
    },

    // Försenade kundordrar: confirmed/in production with a row that still
    // has quantity to deliver and whose effective delivery date (the row's,
    // else the order's) is before today. Quotes and delivered orders never
    // count — a delivered order falls out because no row has rest.
    async lateSalesOrders(today: string): Promise<LateOrderRow[]> {
      const earliest = sql<string>`min(${salesRowDeliveryDate})`;
      return db
        .select({
          orderId: salesOrders.id,
          orderNumber: salesOrders.orderNumber,
          partnerName: customers.name,
          earliestDate: earliest,
        })
        .from(salesOrderRows)
        .innerJoin(salesOrders, eq(salesOrders.id, salesOrderRows.salesOrderId))
        .innerJoin(customers, eq(customers.id, salesOrders.customerId))
        .where(
          and(
            inArray(salesOrders.status, ["confirmed", "in_production"]),
            gt(salesOrderRows.quantityOrdered, salesOrderRows.quantityDelivered),
            sql`${salesRowDeliveryDate} < ${today}::date`
          )
        )
        .groupBy(salesOrders.id, salesOrders.orderNumber, customers.name)
        .orderBy(sql`${earliest} asc`, asc(salesOrders.orderNumber));
    },

    // Offerter att följa upp: open quotes (status quote — a lost or
    // confirmed one is not open) whose Giltig t.o.m. is on or before the
    // horizon the service computes (today + N days); a quote without a
    // validity date never expires and is left out. Earliest date first.
    async quotesToFollowUp(horizon: string): Promise<QuoteToFollowUpRow[]> {
      const rows = await db
        .select({
          orderId: salesOrders.id,
          orderNumber: salesOrders.orderNumber,
          customerName: customers.name,
          validUntil: salesOrders.quoteValidUntil,
        })
        .from(salesOrders)
        .innerJoin(customers, eq(customers.id, salesOrders.customerId))
        .where(and(eq(salesOrders.status, "quote"), sql`${salesOrders.quoteValidUntil} <= ${horizon}::date`))
        .orderBy(asc(salesOrders.quoteValidUntil), asc(salesOrders.orderNumber));
      return rows.map((r) => ({ ...r, validUntil: r.validUntil! }));
    },

    // Försenade inköpsordrar: draft/confirmed/partially received with a row
    // that still has quantity to receive and whose effective arrival date
    // (confirmed before requested, row before order) is before today.
    async latePurchaseOrders(today: string): Promise<LateOrderRow[]> {
      const earliest = sql<string>`min(${purchaseRowArrivalDate})`;
      return db
        .select({
          orderId: purchaseOrders.id,
          orderNumber: purchaseOrders.orderNumber,
          partnerName: suppliers.name,
          earliestDate: earliest,
        })
        .from(purchaseOrderRows)
        .innerJoin(purchaseOrders, eq(purchaseOrders.id, purchaseOrderRows.purchaseOrderId))
        .innerJoin(suppliers, eq(suppliers.id, purchaseOrders.supplierId))
        .where(
          and(
            inArray(purchaseOrders.status, ["draft", "confirmed", "partially_received"]),
            gt(purchaseOrderRows.quantityOrdered, purchaseOrderRows.quantityReceived),
            sql`${purchaseRowArrivalDate} < ${today}::date`
          )
        )
        .groupBy(purchaseOrders.id, purchaseOrders.orderNumber, suppliers.name)
        .orderBy(sql`${earliest} asc`, asc(purchaseOrders.orderNumber));
    },

    // Sena tillverkningsordrar: the open (released/in progress) orders; the
    // service asks the planning service which of them are Sen.
    async openManufacturingOrders(): Promise<OpenManufacturingOrderRow[]> {
      return db
        .select({
          orderId: manufacturingOrders.id,
          orderNumber: manufacturingOrders.orderNumber,
          articleNumber: articles.articleNumber,
          articleName: articles.name,
          dueDate: manufacturingOrders.dueDate,
        })
        .from(manufacturingOrders)
        .innerJoin(articles, eq(articles.id, manufacturingOrders.articleId))
        .where(inArray(manufacturingOrders.status, ["released", "in_progress"]))
        .orderBy(sql`${manufacturingOrders.dueDate} asc nulls last`, asc(manufacturingOrders.orderNumber));
    },

    // Förfallna kundfakturor: issued with an open amount > 0 (the ledger's
    // own openAmountSql, which needs `invoices` unaliased) and a due date
    // before today.
    async overdueCustomerInvoices(today: string): Promise<OverdueInvoiceRow[]> {
      const rows = await db
        .select({
          invoiceId: invoices.id,
          invoiceNumber: invoices.invoiceNumber,
          customerName: invoices.customerName,
          dueDate: invoices.dueDate,
          openAmount: invoiceOpenAmountSql,
        })
        .from(invoices)
        .where(
          and(eq(invoices.status, "issued"), sql`${invoices.dueDate} < ${today}::date`, sql`${invoiceOpenAmountSql} > 0`)
        )
        .orderBy(asc(invoices.dueDate), asc(invoices.invoiceNumber));
      return rows.map((r) => ({ ...r, dueDate: r.dueDate!, openAmount: Number(r.openAmount) }));
    },

    // Leverantörsfakturor att betala: approved with an open amount > 0 and
    // NOT reserved in a live payment batch (the pending/exported rows the
    // partial unique index payment_batch_items_invoice_live guards) — those
    // are already on their way to the bank. The due-date window is applied
    // by the service, which derives a missing due date with computeDueDate.
    async openSupplierInvoices(): Promise<OpenSupplierInvoiceRow[]> {
      const rows = await db
        .select({
          invoiceId: supplierInvoices.id,
          registrationNumber: supplierInvoices.registrationNumber,
          invoiceNumber: supplierInvoices.invoiceNumber,
          supplierName: suppliers.name,
          invoiceDate: supplierInvoices.invoiceDate,
          dueDate: supplierInvoices.dueDate,
          paymentTermCode: paymentTerms.code,
          openAmount: supplierInvoiceOpenAmountSql,
        })
        .from(supplierInvoices)
        .innerJoin(suppliers, eq(suppliers.id, supplierInvoices.supplierId))
        .leftJoin(paymentTerms, eq(paymentTerms.id, suppliers.paymentTermId))
        .where(
          and(
            eq(supplierInvoices.status, "approved"),
            sql`${supplierInvoiceOpenAmountSql} > 0`,
            sql`NOT EXISTS (
              SELECT 1 FROM ${paymentBatchItems} pbi
              WHERE pbi.supplier_invoice_id = ${supplierInvoices.id}
                AND pbi.status IN ('pending', 'exported')
            )`
          )
        )
        .orderBy(sql`${supplierInvoices.dueDate} asc nulls last`, asc(supplierInvoices.invoiceDate), asc(supplierInvoices.createdAt));
      return rows.map((r) => ({ ...r, openAmount: Number(r.openAmount) }));
    },

    // E-fakturor som inte gick fram: the invoice's latest PRODUCTION
    // transmission is failed/rejected and no live (sending/sent/delivered)
    // production transmission exists. The sandbox never counts.
    async failedEinvoices(): Promise<FailedEinvoiceRow[]> {
      // "invoices"."id" spelled out: in a single-table query Drizzle renders
      // an interpolated column BARE, which inside the subquery would bind to
      // t.id (see sales/repository/open-amounts.ts).
      const latest = sql`FROM ${einvoiceTransmissions} t WHERE t.invoice_id = "invoices"."id" AND t.environment = 'production' ORDER BY t.started_at DESC, t.id DESC LIMIT 1`;
      const latestStatus = sql<FailedEinvoiceRow["status"]>`(SELECT t.status ${latest})`;
      const rows = await db
        .select({
          invoiceId: invoices.id,
          invoiceNumber: invoices.invoiceNumber,
          customerName: invoices.customerName,
          status: latestStatus,
          errorMessage: sql<string | null>`(SELECT t.error_message ${latest})`,
          startedAt: sql<string>`(SELECT t.started_at ${latest})`,
        })
        .from(invoices)
        .where(
          and(
            sql`${latestStatus} IN ('failed', 'rejected')`,
            sql`NOT EXISTS (
              SELECT 1 FROM ${einvoiceTransmissions} live
              WHERE live.invoice_id = "invoices"."id"
                AND live.environment = 'production'
                AND live.status IN ('sending', 'sent', 'delivered')
            )`
          )
        )
        .orderBy(sql`(SELECT t.started_at ${latest}) asc`, asc(invoices.invoiceNumber));
      return rows.map((r) => ({ ...r, startedAt: new Date(r.startedAt) }));
    },

    // Utskick som misslyckades: failed rows since `since`, without a later
    // SENT row for the same document (type + id). Test mails are not a
    // document and never count.
    async failedEmails(since: Date): Promise<FailedEmailRow[]> {
      return db
        .select({
          emailId: emailLog.id,
          documentType: emailLog.documentType,
          documentId: emailLog.documentId,
          recipient: emailLog.recipient,
          subject: emailLog.subject,
          error: emailLog.error,
          createdAt: emailLog.createdAt,
        })
        .from(emailLog)
        .where(
          and(
            eq(emailLog.status, "failed"),
            sql`${emailLog.documentType} <> 'test'`,
            sql`${emailLog.createdAt} >= ${since.toISOString()}::timestamptz`,
            // Outer columns spelled out — a single-table query renders an
            // interpolated column bare, which here would bind to `later`.
            // A row without a document (the alert digest) is "the same
            // document" only for the same recipient: user B's digest going
            // out must not resolve user A's failed one.
            sql`NOT EXISTS (
              SELECT 1 FROM ${emailLog} later
              WHERE later.status = 'sent'
                AND later.document_type = "email_log"."document_type"
                AND later.document_id IS NOT DISTINCT FROM "email_log"."document_id"
                AND ("email_log"."document_id" IS NOT NULL OR later.recipient = "email_log"."recipient")
                AND later.created_at > "email_log"."created_at"
            )`
          )
        )
        .orderBy(asc(emailLog.createdAt), desc(emailLog.id));
    },
  };
}

export type AlertsRepository = ReturnType<typeof createAlertsRepository>;

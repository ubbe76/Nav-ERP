import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  accounts,
  articles,
  customers,
  deviations,
  einvoiceTransmissions,
  emailLog,
  invoices,
  invoiceScans,
  manufacturingOrders,
  paymentBatchItems,
  paymentTerms,
  pluginDeliveries,
  pluginEvents,
  plugins,
  purchaseOrderRows,
  purchaseOrders,
  recurringVerificationRuns,
  recurringVerifications,
  salesOrderRows,
  salesOrders,
  stockTransactions,
  supplierInvoices,
  suppliers,
  systemSettings,
  verificationRows,
  verificationSeries,
  fiscalYears,
  verificationTemplates,
  verifications,
  type Db,
} from "@navet/db";
import { PLUGIN_TEST_EVENT_TYPE } from "@navet/shared";
import { purchaseRowArrivalDate, salesRowDeliveryDate } from "../../planning/repository/effective-dates.js";
import {
  LATE_PURCHASE_ORDER_STATUSES,
  LATE_SALES_ORDER_STATUSES,
  purchaseRowLate,
  salesRowLate,
} from "../../planning/repository/late-orders.js";
import { openAmountSql as invoiceOpenAmountSql } from "../../sales/repository/open-amounts.js";
import { openAmountSql as supplierInvoiceOpenAmountSql } from "../../purchase/repository/open-amounts.js";
import { PLUGIN_REFUSAL_ERRORS } from "../../system/service/plugin-webhook.js";
import { createBankReconciliationRepository } from "../../banking/repository/bank-reconciliation.repository.js";

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
  // In the invoice's own currency (Valuta) — the alert names it.
  openAmount: number;
  currency: string;
}

export interface OpenSupplierInvoiceRow {
  invoiceId: string;
  registrationNumber: string;
  invoiceNumber: string;
  supplierName: string;
  invoiceDate: string;
  dueDate: string | null;
  // The supplier's payment term code ("30") for dueDateFromTerm when the
  // invoice was saved without a due date.
  paymentTermCode: string | null;
  // In the invoice's own currency (Valuta) — the alert names it.
  openAmount: number;
  currency: string;
}

export interface FailedEinvoiceRow {
  invoiceId: string;
  invoiceNumber: string | null;
  customerName: string | null;
  status: "failed" | "rejected";
  errorMessage: string | null;
  startedAt: Date;
}

export interface FailedPluginRow {
  pluginId: string;
  pluginName: string;
  failed: number;
  lastFailedAt: Date;
  lastError: string | null;
}

export interface FailedRecurringRunRow {
  runId: string;
  recurringId: string;
  templateName: string;
  month: string;
  error: string | null;
  createdAt: Date;
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
  // Bankavstämning: the unmatched statement entries, through the banking
  // module's own reader so "unmatched" has one definition.
  const bankReconciliation = createBankReconciliationRepository(db);
  return {
    async unreconciledBankEntries(before: string) {
      return bankReconciliation.unreconciledEntriesBefore(before);
    },

    // Bokningar utan kostnadsställe: BOOKED verifications with a row on an
    // account that has Kräver kostnadsställe and no cost center — the same
    // rows the verification card's `warnings` names. Oldest first.
    async verificationsMissingCostCenter(): Promise<
      { verificationId: string; displayNumber: string; date: string; description: string; accountNumbers: string[] }[]
    > {
      const rows = await db
        .select({
          verificationId: verifications.id,
          seriesCode: verificationSeries.code,
          yearLabel: fiscalYears.label,
          verificationNumber: verifications.verificationNumber,
          date: verifications.date,
          description: verifications.description,
          accountNumber: accounts.number,
        })
        .from(verificationRows)
        .innerJoin(verifications, eq(verifications.id, verificationRows.verificationId))
        .innerJoin(verificationSeries, eq(verificationSeries.id, verifications.seriesId))
        .innerJoin(fiscalYears, eq(fiscalYears.id, verifications.fiscalYearId))
        .innerJoin(accounts, eq(accounts.id, verificationRows.accountId))
        .where(and(eq(verifications.status, "booked"), eq(accounts.costCenterRequired, true), sql`${verificationRows.costCenterId} is null`))
        .orderBy(asc(verifications.date), asc(verifications.verificationNumber), asc(accounts.number));
      const byVerification = new Map<string, { verificationId: string; displayNumber: string; date: string; description: string; accountNumbers: string[] }>();
      for (const row of rows) {
        const entry = byVerification.get(row.verificationId) ?? {
          verificationId: row.verificationId,
          displayNumber: `${row.seriesCode}-${row.yearLabel}-${row.verificationNumber}`,
          date: row.date,
          description: row.description,
          accountNumbers: [],
        };
        if (!entry.accountNumbers.includes(row.accountNumber)) entry.accountNumbers.push(row.accountNumber);
        byVerification.set(row.verificationId, entry);
      }
      return [...byVerification.values()];
    },

    // Åtgärd senast passerad: open cases (Registrerad/Utreds) whose due
    // date is before today — the list's own `overdue` filter.
    async overdueDeviations(today: string) {
      return db
        .select({
          id: deviations.id,
          deviationNumber: deviations.deviationNumber,
          title: deviations.title,
          dueDate: deviations.dueDate,
          counterpartyName: sql<string | null>`coalesce(${customers.name}, ${suppliers.name})`,
        })
        .from(deviations)
        .leftJoin(customers, eq(customers.id, deviations.customerId))
        .leftJoin(suppliers, eq(suppliers.id, deviations.supplierId))
        .where(and(inArray(deviations.status, ["registered", "investigating"]), sql`${deviations.dueDate} < ${today}::date`))
        .orderBy(asc(deviations.dueDate), asc(deviations.deviationNumber));
    },

    // Fakturor i inkorgen att granska: status new/interpreted (the derived
    // Att granska), with the interpreted supplier and invoice number.
    async pendingInvoiceScans() {
      return db
        .select({
          id: invoiceScans.id,
          scanNumber: invoiceScans.scanNumber,
          filename: invoiceScans.filename,
          source: invoiceScans.source,
          emailFrom: invoiceScans.emailFrom,
          createdAt: invoiceScans.createdAt,
          supplierName: suppliers.name,
          invoiceNumber: sql<string | null>`${invoiceScans.result} #>> '{invoiceNumber,value}'`,
        })
        .from(invoiceScans)
        .leftJoin(suppliers, sql`${suppliers.id} = NULLIF(${invoiceScans.result} #>> '{supplier,matchedSupplierId}', '')::uuid`)
        .where(inArray(invoiceScans.status, ["new", "interpreted"]))
        .orderBy(asc(invoiceScans.createdAt), asc(invoiceScans.scanNumber));
    },

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
    // else the order's) is before today — the rule in late-orders.ts, shared
    // with the order list's status filter Sen.
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
            inArray(salesOrders.status, [...LATE_SALES_ORDER_STATUSES]),
            salesRowLate(today)
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
    // (confirmed before requested, row before order) is before today — the
    // rule in late-orders.ts, shared with the order list's status filter Sen.
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
            inArray(purchaseOrders.status, [...LATE_PURCHASE_ORDER_STATUSES]),
            purchaseRowLate(today)
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
          currency: invoices.currency,
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
    // by the service, which derives a missing due date with dueDateFromTerm.
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
          currency: supplierInvoices.currency,
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

    // Återkommande verifikat som misslyckats: every failed run of a post
    // that still exists. Kör nu replaces a failed row with the retry's
    // outcome, so a month later created successfully has no failed row —
    // "not followed by a success" is the row's existence.
    async failedRecurringRuns(): Promise<FailedRecurringRunRow[]> {
      return db
        .select({
          runId: recurringVerificationRuns.id,
          recurringId: recurringVerifications.id,
          templateName: verificationTemplates.name,
          month: recurringVerificationRuns.month,
          error: recurringVerificationRuns.error,
          createdAt: recurringVerificationRuns.createdAt,
        })
        .from(recurringVerificationRuns)
        .innerJoin(recurringVerifications, eq(recurringVerifications.id, recurringVerificationRuns.recurringId))
        .innerJoin(verificationTemplates, eq(verificationTemplates.id, recurringVerifications.templateId))
        .where(eq(recurringVerificationRuns.status, "failed"))
        .orderBy(asc(recurringVerificationRuns.month), asc(verificationTemplates.name));
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

    // Tillägg som inte tar emot händelser: plugins with failed deliveries
    // since `since` that have had no successful delivery after the failure.
    // Refusals (the group or manifest no longer covers the event — nothing
    // was sent) and Skicka testhändelse's plugin.test don't count: the
    // first isn't the plugin failing to answer, the second the
    // administrator already saw.
    // Fakturaskanning: the e-mail job's own keys in system_settings.
    async invoiceScanMailState(): Promise<{ enabled: boolean; lastError: string | null; lastRunAt: Date | null; lastSuccessAt: Date | null }> {
      const rows = await db
        .select()
        .from(systemSettings)
        .where(
          inArray(systemSettings.key, [
            "invoice_scan_mail_enabled",
            "invoice_scan_mail_last_error",
            "invoice_scan_mail_last_run_at",
            "invoice_scan_mail_last_success_at",
          ])
        );
      const value = new Map(rows.map((r) => [r.key, r.value]));
      const instant = (key: string) => {
        const ms = Date.parse(value.get(key) ?? "");
        return Number.isFinite(ms) ? new Date(ms) : null;
      };
      const lastError = value.get("invoice_scan_mail_last_error")?.trim();
      return {
        enabled: value.get("invoice_scan_mail_enabled") === "true",
        lastError: lastError ? lastError : null,
        lastRunAt: instant("invoice_scan_mail_last_run_at"),
        lastSuccessAt: instant("invoice_scan_mail_last_success_at"),
      };
    },

    async failedPluginDeliveries(since: Date): Promise<FailedPluginRow[]> {
      const rows = await db.execute<{
        plugin_id: string;
        plugin_name: string;
        failed: number;
        last_failed_at: string;
        last_error: string | null;
      }>(sql`
        SELECT p.id AS plugin_id, p.name AS plugin_name, count(*)::int AS failed,
          max(d.last_attempt_at) AS last_failed_at,
          (array_agg(d.last_error ORDER BY d.last_attempt_at DESC))[1] AS last_error
        FROM ${pluginDeliveries} d
        JOIN ${plugins} p ON p.id = d.plugin_id
        JOIN ${pluginEvents} e ON e.id = d.event_id
        WHERE d.status = 'failed'
          AND d.last_attempt_at >= ${since.toISOString()}::timestamptz
          AND e.type <> ${PLUGIN_TEST_EVENT_TYPE}
          AND coalesce(d.last_error, '') NOT IN (${sql.join(
            PLUGIN_REFUSAL_ERRORS.map((error) => sql`${error}`),
            sql`, `
          )})
          AND NOT EXISTS (
            SELECT 1 FROM ${pluginDeliveries} ok
            WHERE ok.plugin_id = d.plugin_id AND ok.status = 'delivered' AND ok.delivered_at > d.last_attempt_at
          )
        GROUP BY p.id, p.name
        ORDER BY max(d.last_attempt_at), p.name`);
      return rows.map((r) => ({
        pluginId: r.plugin_id,
        pluginName: r.plugin_name,
        failed: r.failed,
        lastFailedAt: new Date(r.last_failed_at),
        lastError: r.last_error,
      }));
    },
  };
}

export type AlertsRepository = ReturnType<typeof createAlertsRepository>;

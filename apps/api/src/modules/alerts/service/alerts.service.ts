import { ALERT_ITEMS_LIMIT, BANK_UNRECONCILED_DAYS, type AlertGroup, type AlertItem, type AlertKind, type AlertSeverity, type AlertsResponse } from "@navet/shared";
import { addDays, stockholmToday } from "../../system/service/delivery-days.js";
import { stockholmNow } from "../../shipping/service/pickup.js";
import { dueDateFromTerm } from "../../system/service/due-date.js";
import type { AlertsRepository } from "../repository/alerts.repository.js";
import { alertKindDef, quoteFollowupSeverity, sortKinds, supplierInvoiceSeverity, visibleKinds, type AlertUser } from "./alert-kinds.js";

// Aviseringar — computeAlerts runs the readers of the requested kinds in
// parallel and builds one group per kind in catalog order. A reader that
// throws gives its group error = true and a text; the others are shown. The
// digest job (steg 2) calls computeAlerts ONCE with the union of its
// recipients' kinds and filters the groups per recipient — alertsForUser is
// the web's per-user call.

// What the behovsberäkning's rows must carry — RequirementRow satisfies it.
export interface AlertRequirementRow {
  articleId: string;
  articleNumber: string;
  articleName: string;
  unitCode: string | null;
  proposalQuantity: number;
  proposalKind: "purchase" | "manufacture" | "subcontract" | "configured" | null;
  projected: number;
  // Subcontract rows: the MO operation the proposal buys.
  moOrderNumber?: string;
  moOperationLabel?: string;
  // Configured rows: the KO row the proposal makes a TO for.
  salesOrderRowId?: string;
  salesOrderNumber?: string;
  customerName?: string;
  configurationSummary?: string;
}

// The planning service, narrowed (app.ts passes it as it is): the cached
// behovsberäkning and the TO list's Sen.
export interface AlertPlanningReader {
  requirementProposals(): Promise<AlertRequirementRow[]>;
  orderPlanSummaries(orderIds: string[]): Promise<Map<string, { late: boolean }>>;
}

export interface AlertSettingsReader {
  // Leverantörsfakturor att betala inom (dagar).
  supplierInvoiceDays(): Promise<number>;
  // Offerter att följa upp inom (dagar).
  quoteFollowupDays(): Promise<number>;
}

// Utskick som misslyckades looks this far back.
export const EMAIL_FAILED_DAYS = 14;
// Tillägg som inte tar emot händelser looks this far back.
export const PLUGIN_FAILED_DAYS = 7;

const DAY_MS = 86_400_000;

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

// sv-SE number text with a plain hyphen for the sign (sv-SE's U+2212 is
// not what users type in a search box).
function formatQuantity(value: number): string {
  return value.toLocaleString("sv-SE", { maximumFractionDigits: 4 }).replace("−", "-");
}
function formatAmount(value: number): string {
  return value.toLocaleString("sv-SE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace("−", "-");
}

function daysLateText(date: string, today: string): string {
  const days = daysBetween(date, today);
  return days === 1 ? "1 dag försenad" : `${days} dagar försenad`;
}

// "(i dag)" / "(om 1 dag)" / "(om 3 dagar)" for a date today or ahead.
function daysAheadText(date: string, today: string): string {
  const days = daysBetween(today, date);
  if (days === 0) return "i dag";
  return days === 1 ? "om 1 dag" : `om ${days} dagar`;
}

const EINVOICE_STATUS_TEXT = { failed: "Sändningen misslyckades", rejected: "Avvisad av mottagaren" } as const;

const EMAIL_DOCUMENT_TEXT: Record<string, string> = {
  inquiry: "Förfrågan",
  purchase_order: "Inköpsorder",
  quote: "Offert",
  order_confirmation: "Orderbekräftelse",
  invoice: "Faktura",
  payment_reminder: "Betalningspåminnelse",
  alert_digest: "Daglig sammanställning",
  deviation: "Avvikelse",
};

// The card the failed e-mail's document is fixed on; the log itself when
// the document has no card (a digest, an unknown type).
function emailDocumentHref(documentType: string, documentId: string | null): string {
  if (documentId) {
    switch (documentType) {
      case "inquiry":
        return `/inkop/forfragningar/${documentId}`;
      case "purchase_order":
        return `/inkop/ordrar/${documentId}`;
      // The web redirects a quote that has become an order to its order card.
      case "quote":
        return `/forsaljning/offerter/${documentId}`;
      case "order_confirmation":
        return `/forsaljning/ordrar/${documentId}`;
      case "invoice":
      case "payment_reminder":
        return `/forsaljning/fakturor/${documentId}`;
      case "deviation":
        return `/kvalitet/avvikelser/${documentId}`;
    }
  }
  return "/system/e-postlogg";
}

const articleHref = (articleId: string) => `/artiklar/oversikt?article=${articleId}`;

export function createAlertsService(deps: {
  repo: AlertsRepository;
  planning: AlertPlanningReader;
  settings: AlertSettingsReader;
  // Today as a Stockholm day and the current instant; the tests pin them.
  today?: () => string;
  now?: () => Date;
  log?: (msg: string, extra?: unknown) => void;
}) {
  const todayFn = deps.today ?? stockholmToday;
  const nowFn = deps.now ?? (() => new Date());
  const { repo, planning } = deps;
  const log = deps.log ?? ((msg: string, extra?: unknown) => console.error(msg, extra));

  // One reader per kind: the rows, already sorted oldest/most urgent first.
  const readers: Record<AlertKind, (today: string) => Promise<AlertItem[]>> = {
    async stock_negative() {
      const rows = await repo.negativeStock();
      return rows.map((r) => ({
        key: r.articleId,
        severity: "red",
        href: articleHref(r.articleId),
        primary: `${r.articleNumber} ${r.articleName}`,
        secondary: `Saldo ${formatQuantity(r.balance)}`,
        date: null,
      }));
    },

    async sales_order_late(today) {
      const rows = await repo.lateSalesOrders(today);
      return rows.map((r) => ({
        key: r.orderId,
        severity: "yellow",
        href: `/forsaljning/ordrar/${r.orderId}`,
        primary: `${r.orderNumber} ${r.partnerName}`,
        secondary: `${daysLateText(r.earliestDate, today)} · leveransdatum ${r.earliestDate}`,
        date: r.earliestDate,
      }));
    },

    async purchase_order_late(today) {
      const rows = await repo.latePurchaseOrders(today);
      return rows.map((r) => ({
        key: r.orderId,
        severity: "yellow",
        href: `/inkop/ordrar/${r.orderId}`,
        primary: `${r.orderNumber} ${r.partnerName}`,
        secondary: `${daysLateText(r.earliestDate, today)} · leveransdatum ${r.earliestDate}`,
        date: r.earliestDate,
      }));
    },

    // Sen exactly as the TO list and the TO card show it: the planning
    // service's orderPlanSummaries over the open orders.
    async manufacturing_order_late() {
      const open = await repo.openManufacturingOrders();
      if (open.length === 0) return [];
      const summaries = await planning.orderPlanSummaries(open.map((o) => o.orderId));
      return open
        .filter((o) => summaries.get(o.orderId)?.late === true)
        .map((o) => ({
          key: o.orderId,
          severity: "yellow" as const,
          href: `/tillverkning/ordrar/${o.orderId}`,
          primary: `${o.orderNumber} ${o.articleNumber} ${o.articleName}`,
          secondary: o.dueDate ? `Sen enligt planeringen · färdigdatum ${o.dueDate}` : "Sen enligt planeringen",
          date: o.dueDate,
        }));
    },

    async purchase_needed() {
      const rows = await planning.requirementProposals();
      return proposals(rows, ["purchase", "subcontract"]);
    },

    async manufacture_needed() {
      const rows = await planning.requirementProposals();
      return proposals(rows, ["manufacture", "configured"]);
    },

    async customer_invoice_overdue(today) {
      const rows = await repo.overdueCustomerInvoices(today);
      return rows.map((r) => ({
        key: r.invoiceId,
        severity: "red",
        href: `/forsaljning/fakturor/${r.invoiceId}`,
        primary: `${r.invoiceNumber ?? "Faktura"} ${r.customerName ?? ""}`.trim(),
        secondary: `Förföll ${r.dueDate} (${daysLateText(r.dueDate, today)}) · ${formatAmount(r.openAmount)} ${r.currency === "SEK" ? "kr" : r.currency} kvar`,
        date: r.dueDate,
      }));
    },

    // Due within N days (the system setting), the stored due date first and
    // dueDateFromTerm's derivation for an invoice saved without one; an
    // invoice with neither has no due date and is left out.
    async supplier_invoice_due(today) {
      const [rows, days] = await Promise.all([repo.openSupplierInvoices(), deps.settings.supplierInvoiceDays()]);
      const horizon = addDays(today, days);
      const items: AlertItem[] = [];
      for (const r of rows) {
        const dueDate = r.dueDate ?? dueDateFromTerm(r.invoiceDate, r.paymentTermCode);
        if (dueDate === null || dueDate > horizon) continue;
        const severity = supplierInvoiceSeverity(dueDate, today);
        items.push({
          key: r.invoiceId,
          severity,
          href: `/inkop/leverantorsfakturor/${r.invoiceId}`,
          primary: `${r.registrationNumber} ${r.supplierName} (${r.invoiceNumber})`,
          secondary: `${severity === "red" ? `Förföll ${dueDate} (${daysLateText(dueDate, today)})` : `Förfaller ${dueDate}`} · ${formatAmount(r.openAmount)} ${r.currency === "SEK" ? "kr" : r.currency}`,
          date: dueDate,
        });
      }
      return items.sort((a, b) => a.date!.localeCompare(b.date!) || a.primary.localeCompare(b.primary, "sv"));
    },

    // Open quotes expiring within N days (the system setting) — red once
    // Giltig t.o.m. has passed, yellow while it is today or ahead.
    async quote_followup(today) {
      const days = await deps.settings.quoteFollowupDays();
      const rows = await repo.quotesToFollowUp(addDays(today, days));
      return rows.map((r) => {
        const severity = quoteFollowupSeverity(r.validUntil, today);
        return {
          key: r.orderId,
          severity,
          href: `/forsaljning/offerter/${r.orderId}`,
          primary: `${r.orderNumber} ${r.customerName}`,
          secondary: severity === "red" ? `Gick ut ${r.validUntil}` : `Går ut ${r.validUntil} (${daysAheadText(r.validUntil, today)})`,
          date: r.validUntil,
        };
      });
    },

    async recurring_verification_failed() {
      const rows = await repo.failedRecurringRuns();
      return rows.map((r) => ({
        key: r.runId,
        severity: "red" as const,
        // No detail page: the list shows each post's runs.
        href: "/ekonomi/aterkommande-verifikat",
        primary: `${r.templateName} ${r.month}`,
        secondary: r.error ? `Kunde inte skapas: ${r.error}` : "Kunde inte skapas",
        date: `${r.month}-01`,
      }));
    },

    async einvoice_failed() {
      const rows = await repo.failedEinvoices();
      return rows.map((r) => ({
        key: r.invoiceId,
        severity: "red",
        href: `/forsaljning/fakturor/${r.invoiceId}`,
        primary: `${r.invoiceNumber ?? "Faktura"} ${r.customerName ?? ""}`.trim(),
        secondary: r.errorMessage ? `${EINVOICE_STATUS_TEXT[r.status]} · ${r.errorMessage}` : EINVOICE_STATUS_TEXT[r.status],
        date: stockholmNow(r.startedAt).date,
      }));
    },

    async email_failed() {
      const since = new Date(nowFn().getTime() - EMAIL_FAILED_DAYS * DAY_MS);
      const rows = await repo.failedEmails(since);
      return rows.map((r) => ({
        key: r.emailId,
        severity: "red",
        href: emailDocumentHref(r.documentType, r.documentId),
        primary: `${EMAIL_DOCUMENT_TEXT[r.documentType] ?? r.documentType}: ${r.subject}`,
        secondary: r.error ? `Till ${r.recipient} · ${r.error}` : `Till ${r.recipient}`,
        date: stockholmNow(r.createdAt).date,
      }));
    },

    // Omatchade bankposter: statement entries booked more than
    // BANK_UNRECONCILED_DAYS ago without a live matching, oldest first.
    async bank_unreconciled(today) {
      const rows = await repo.unreconciledBankEntries(addDays(today, -BANK_UNRECONCILED_DAYS));
      return rows.map((r) => ({
        key: r.id,
        severity: "yellow" as const,
        // The page's own query parameter (`?account=`, see
        // apps/web/app/ekonomi/bankavstamning/page.tsx).
        href: `/ekonomi/bankavstamning?account=${r.bankAccountId}`,
        primary: `${r.bookingDate} ${r.text}`,
        secondary: `${formatAmount(r.amount)} ${r.currency === "SEK" ? "kr" : r.currency} · ${r.accountName} · ${daysLateText(r.bookingDate, today)}`,
        date: r.bookingDate,
      }));
    },

    // Avvikelser som passerat Åtgärd senast: open cases, oldest due first.
    async deviations_overdue(today) {
      const rows = await repo.overdueDeviations(today);
      return rows.map((r) => ({
        key: r.id,
        severity: "yellow" as const,
        href: `/kvalitet/avvikelser/${r.id}`,
        primary: `${r.deviationNumber} ${r.title}`,
        secondary: [`Åtgärd senast ${r.dueDate} (${daysLateText(r.dueDate!, today)})`, r.counterpartyName]
          .filter((part): part is string => part !== null && part !== "")
          .join(" · "),
        date: r.dueDate,
      }));
    },

    // Fakturor i inkorgen att granska: every scan in new/interpreted, oldest
    // first — the inbox's own Att granska.
    async invoice_scans_pending() {
      const rows = await repo.pendingInvoiceScans();
      return rows.map((r) => ({
        key: r.id,
        severity: "yellow" as const,
        href: `/inkop/fakturainkorg/${r.id}`,
        primary: `${r.scanNumber} ${r.filename}`,
        secondary: [
          r.source === "email" ? (r.emailFrom ? `E-post från ${r.emailFrom}` : "E-post") : "Uppladdad",
          r.supplierName,
          r.invoiceNumber ? `fakturanr ${r.invoiceNumber}` : null,
        ]
          .filter((part): part is string => part !== null && part !== "")
          .join(" · "),
        date: stockholmNow(r.createdAt).date,
      }));
    },

    // Bokningar utan kostnadsställe: one row per booked verification.
    async cost_center_missing() {
      const rows = await repo.verificationsMissingCostCenter();
      return rows.map((r) => ({
        key: r.verificationId,
        severity: "yellow" as const,
        href: `/ekonomi/verifikat/${r.verificationId}`,
        primary: `${r.displayNumber} ${r.description}`,
        secondary: `Konto ${r.accountNumbers.join(", ")} kräver kostnadsställe`,
        date: r.date,
      }));
    },

    // E-postlådan för fakturor kunde inte läsas: the job's last run failed
    // while the box is turned on (derived from invoice_scan_mail_last_error,
    // which a successful run clears).
    async invoice_scan_mail_failed() {
      const state = await repo.invoiceScanMailState();
      if (!state.enabled || !state.lastError) return [];
      const since = state.lastSuccessAt ? stockholmNow(state.lastSuccessAt) : null;
      return [
        {
          key: "invoice_scan_mail",
          severity: "red" as const,
          href: "/system/fakturaskanning",
          primary: state.lastError,
          secondary: since ? `Senast lästes lådan ${since.date} ${since.time}` : "Lådan har inte lästs någon gång",
          date: state.lastRunAt ? stockholmNow(state.lastRunAt).date : null,
        },
      ];
    },

    async plugin_delivery_failed() {
      const since = new Date(nowFn().getTime() - PLUGIN_FAILED_DAYS * DAY_MS);
      const rows = await repo.failedPluginDeliveries(since);
      return rows.map((r) => ({
        key: r.pluginId,
        severity: "red",
        href: `/system/tillagg/${r.pluginId}`,
        primary: r.pluginName,
        secondary: `${r.failed === 1 ? "1 misslyckad leverans" : `${r.failed} misslyckade leveranser`}${r.lastError ? ` · ${r.lastError}` : ""}`,
        date: stockholmNow(r.lastFailedAt).date,
      }));
    },
  };

  // Behovsberäkningen's rows of the given kinds, lowest projected balance
  // first (a copy — the cached rows are never reordered).
  function proposals(rows: AlertRequirementRow[], kinds: readonly AlertRequirementRow["proposalKind"][]): AlertItem[] {
    return rows
      .filter((r) => kinds.includes(r.proposalKind))
      .sort((a, b) => a.projected - b.projected || a.articleNumber.localeCompare(b.articleNumber, "sv"))
      .map(requirementItem);
  }

  // A subcontract row names its TO operation and a configured row its KO row.
  function requirementItem(r: AlertRequirementRow): AlertItem {
    const unit = r.unitCode ? ` ${r.unitCode}` : "";
    const what =
      r.proposalKind === "subcontract" && r.moOrderNumber
        ? ` · lego ${r.moOrderNumber}${r.moOperationLabel ? ` ${r.moOperationLabel}` : ""}`
        : r.proposalKind === "configured" && r.salesOrderNumber
          ? ` · ${r.salesOrderNumber}${r.customerName ? ` ${r.customerName}` : ""}${r.configurationSummary ? ` (${r.configurationSummary})` : ""}`
          : "";
    return {
      // Per article for ordinary rows; a lego/configured row is keyed on
      // what makes it distinct, as the behovsberäkning itself is.
      key: r.proposalKind === "configured" && r.salesOrderRowId ? `row:${r.salesOrderRowId}` : r.proposalKind === "subcontract" && r.moOrderNumber ? `${r.articleId}:${r.moOrderNumber}:${r.moOperationLabel ?? ""}` : r.articleId,
      severity: "yellow",
      href: articleHref(r.articleId),
      primary: `${r.articleNumber} ${r.articleName}`,
      secondary: `Föreslaget antal ${formatQuantity(r.proposalQuantity)}${unit} · projekterat saldo ${formatQuantity(r.projected)}${unit}${what}`,
      date: null,
    };
  }

  function groupSeverity(kind: AlertKind, items: AlertItem[]): AlertSeverity {
    if (items.some((i) => i.severity === "red")) return "red";
    if (items.length > 0) return "yellow";
    return alertKindDef(kind).severity;
  }

  async function computeAlerts(kinds: readonly AlertKind[]): Promise<AlertsResponse> {
    const today = todayFn();
    const computedAt = nowFn().toISOString();
    const ordered = sortKinds(kinds);
    const groups = await Promise.all(
      ordered.map(async (kind): Promise<AlertGroup> => {
        const def = alertKindDef(kind);
        try {
          const items = await readers[kind](today);
          items.sort(compareItems);
          return {
            kind,
            label: def.label,
            severity: groupSeverity(kind, items),
            count: items.length,
            listHref: def.listHref,
            items: items.slice(0, ALERT_ITEMS_LIMIT),
            error: false,
            message: null,
          };
        } catch (err) {
          log(`Alerts: ${kind} could not be computed`, { error: err instanceof Error ? (err.stack ?? err.message) : String(err) });
          return {
            kind,
            label: def.label,
            severity: def.severity,
            count: 0,
            listHref: def.listHref,
            items: [],
            error: true,
            message: `Kunde inte räkna fram ${def.label.toLowerCase()} — se serverloggen.`,
          };
        }
      })
    );
    return { computedAt, groups };
  }

  return {
    computeAlerts,
    async alertsForUser(user: AlertUser): Promise<AlertsResponse> {
      return computeAlerts(visibleKinds(user));
    },
  };
}

// Within a kind: red before yellow (supplier invoices and quotes mix), then the
// reader's own order (date ascending, lowest balance first) — a stable sort
// keeps it.
function compareItems(a: AlertItem, b: AlertItem): number {
  if (a.severity !== b.severity) return a.severity === "red" ? -1 : 1;
  return 0;
}

export type AlertsService = ReturnType<typeof createAlertsService>;

// Decorated on the app (app.ts) so server.ts's digest job (steg 2) can run
// computeAlerts once per tick, like freightTracking/einvoiceStatus.
declare module "fastify" {
  interface FastifyInstance {
    alerts: AlertsService;
  }
}

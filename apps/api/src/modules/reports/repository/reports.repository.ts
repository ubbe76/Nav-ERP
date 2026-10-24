import { inArray, isNotNull, isNull, eq, and, or, gte, lte, sql } from "drizzle-orm";
import {
  articles,
  costCalculations,
  customers,
  deliveries,
  deliveryRows,
  invoiceRows,
  invoices,
  manufacturingOrders,
  moOperationScrap,
  moOperations,
  purchaseOrders,
  purchaseReceipts,
  salesOrderRows,
  salesOrders,
  stockTransactions,
  supplierInvoiceRows,
  supplierInvoices,
  suppliers,
  workCenters,
  type Db,
} from "@navet/db";
import type { PrecisionOrderInput } from "../service/delivery-precision-calc.js";
import type { CalcRowInput } from "../service/calc-outcome-calc.js";
import type { OrderRowConfigurationCost, SalesStatisticsQuery, PurchaseStatisticsQuery, ScrapStatisticsQuery } from "@navet/shared";

// Common statistics row shape all three loaders below return — the service
// layer adds `from`/`to`/`groupBy`/totals on top.
export interface StatisticsRow {
  key: string;
  label: string;
  netAmount: number;
  quantity: number | null;
  invoiceCount: number;
}

export interface ScrapStatisticsRow {
  key: string;
  label: string;
  scrappedQuantity: number;
  reportCount: number;
}

// `from`/`to` are YYYY-MM strings (month granularity, as validated by the
// shared query schemas). invoice_date/supplier_invoices.invoice_date are
// plain date columns with no time component — the range is expanded here to
// the first day of `from` and the LAST day of `to` (computed in JS, no DB
// date-math) so a month filter behaves as an inclusive whole-month range.
function monthRangeToDates(from: string, to: string): { start: string; end: string } {
  const [toYear, toMonth] = to.split("-").map(Number) as [number, number];
  // Day 0 of the following month === the last day of `to`'s month.
  const lastDay = new Date(Date.UTC(toYear, toMonth, 0)).getUTCDate();
  return { start: `${from}-01`, end: `${to}-${String(lastDay).padStart(2, "0")}` };
}

// F1 Rapporter — read-only aggregation sources. Everything derived, nothing
// stored (arkitekturprincip 1's reporting cousin). At SME scale the precision
// and calc-outcome loaders fetch all completed orders/calculations and let
// the pure calcs do the bucketing/filtering.

const toIso = (raw: string | Date | null) => (raw == null ? null : new Date(raw).toISOString());

export function createReportsRepository(db: Db) {
  return {
    // Completed sales orders with promise + last delivery timestamp (null =
    // delivered before C2's delivery occasions existed). A följesedel whose
    // rows are all undone (Ångra utleverans) is no delivery.
    async loadSalesPrecisionOrders(): Promise<PrecisionOrderInput[]> {
      // Correlated MAX subquery. NOTE: the outer id must be qualified by hand —
      // in a join-free select drizzle renders ${salesOrders.id} as a bare "id",
      // which inside the subquery binds to d.id and the correlation never
      // matches (found the hard way; purchase's listInvoiceBasis idiom only
      // survives because its query has joins that force full qualification).
      const lastDelivery = sql<
        string | null
      >`(SELECT MAX(d.delivered_at) FROM ${deliveries} d WHERE d.sales_order_id = ${sql.raw('"sales_orders"."id"')}
          AND EXISTS (SELECT 1 FROM ${deliveryRows} r WHERE r.delivery_id = d.id AND r.undone_at IS NULL))`;
      const rows = await db
        .select({
          expectedDeliveryDate: salesOrders.expectedDeliveryDate,
          completedAt: lastDelivery,
        })
        .from(salesOrders)
        .where(inArray(salesOrders.status, ["delivered", "invoiced"]));
      return rows.map((r) => ({
        expectedDeliveryDate: r.expectedDeliveryDate,
        completedAt: toIso(r.completedAt),
      }));
    },

    // Completed purchase orders with promise + last purchase_receipt time —
    // the same scalar-subquery idiom as purchase's listInvoiceBasis (live
    // receipts only: Ångra inleverans's reversal and the undone receipt are
    // not deliveries).
    async loadPurchasePrecisionOrders(): Promise<PrecisionOrderInput[]> {
      const lastReceipt = sql<
        string | null
      >`(SELECT MAX(st.created_at) FROM ${stockTransactions} st WHERE st.reference_id = ${sql.raw('"purchase_orders"."id"')} AND st.transaction_type = 'purchase_receipt' AND st.quantity_delta > 0 AND NOT EXISTS (SELECT 1 FROM ${purchaseReceipts} pr WHERE pr.stock_transaction_id = st.id AND pr.undone_at IS NOT NULL))`;
      const rows = await db
        .select({
          expectedDeliveryDate: purchaseOrders.expectedDeliveryDate,
          completedAt: lastReceipt,
        })
        .from(purchaseOrders)
        .where(inArray(purchaseOrders.status, ["received", "closed"]));
      return rows.map((r) => ({
        expectedDeliveryDate: r.expectedDeliveryDate,
        completedAt: toIso(r.completedAt),
      }));
    },

    // The calculations Kalkylutfall pairs: every MO-linked post-calculation
    // (with its order number, and whether the MO is a beställningsvara) and
    // every article-level pre-calculation (manufacturing_order_id null — the
    // only kind the costing module saves). The pure calc does the pairing.
    async loadCalculationRows(): Promise<CalcRowInput[]> {
      const rows = await db
        .select({
          articleId: costCalculations.articleId,
          manufacturingOrderId: costCalculations.manufacturingOrderId,
          orderNumber: manufacturingOrders.orderNumber,
          configured: sql<boolean>`(${manufacturingOrders.configuration} IS NOT NULL)`,
          articleNumber: articles.articleNumber,
          articleName: articles.name,
          type: costCalculations.type,
          quantity: costCalculations.quantity,
          calculatedAt: costCalculations.calculatedAt,
          materialCost: costCalculations.materialCost,
          materialOverhead: costCalculations.materialOverhead,
          laborCost: costCalculations.laborCost,
          subcontractCost: costCalculations.subcontractCost,
          subcontractOverhead: costCalculations.subcontractOverhead,
          semiFinishedCost: costCalculations.semiFinishedCost,
          multiLevel: costCalculations.multiLevel,
        })
        .from(costCalculations)
        .leftJoin(manufacturingOrders, eq(manufacturingOrders.id, costCalculations.manufacturingOrderId))
        .innerJoin(articles, eq(articles.id, costCalculations.articleId))
        .where(
          or(
            and(eq(costCalculations.type, "post"), isNotNull(costCalculations.manufacturingOrderId)),
            and(eq(costCalculations.type, "pre"), isNull(costCalculations.manufacturingOrderId))
          )
        );
      return rows.map((r) => ({
        articleId: r.articleId,
        manufacturingOrderId: r.manufacturingOrderId,
        orderNumber: r.orderNumber,
        configured: Boolean(r.configured),
        articleNumber: r.articleNumber,
        articleName: r.articleName,
        type: r.type,
        quantity: Number(r.quantity),
        calculatedAt: new Date(r.calculatedAt).toISOString(),
        materialCost: Number(r.materialCost),
        materialOverhead: Number(r.materialOverhead),
        laborCost: Number(r.laborCost),
        subcontractCost: Number(r.subcontractCost),
        subcontractOverhead: Number(r.subcontractOverhead),
        semiFinishedCost: Number(r.semiFinishedCost),
        multiLevel: r.multiLevel,
      }));
    },

    // F1 Rapporter — försäljningsstatistik. Sign flip on credit invoices
    // (invoices.type = 'credit') applies to both the amount and the
    // quantity; quantity is only meaningful (and only requested) for
    // groupBy=article, so month/customer leave it null rather than sum a
    // number nobody asked for across mixed articles/units.
    // Invoiced rows in the period, for the margin report. One row per invoice
    // row rather than a pre-grouped aggregate: the grouping and the margin
    // arithmetic live in the pure core (order-margin-calc.ts), and a credit
    // invoice's sign is flipped here so the core never has to know about
    // invoice types.
    async loadInvoiceMarginRows(query: { from: string; to: string }) {
      const { start, end } = monthRangeToDates(query.from, query.to);
      const sign = sql<number>`(CASE WHEN ${invoices.type} = 'credit' THEN -1 ELSE 1 END)`;
      const rows = await db
        .select({
          month: sql<string>`to_char(${invoices.invoiceDate}, 'YYYY-MM')`,
          customerId: customers.id,
          customerName: customers.name,
          articleId: invoiceRows.articleId,
          articleNumber: articles.articleNumber,
          articleName: articles.name,
          quantity: sql<string>`${sign} * ${invoiceRows.quantity}`,
          // Valuta: in SEK at the invoice's rate (the rate it was booked at;
          // 1 for SEK) — the margin is measured against SEK self costs.
          netAmount: sql<string>`${sign} * ROUND(${invoiceRows.lineAmount} * COALESCE(${invoices.exchangeRate}, 1), 2)`,
          // Konfigurator 4c: the linked order row's own förkalkyl when it is a
          // configured (beställningsvara) row — see rowSelfCostPerUnit below.
          orderRowConfiguration: salesOrderRows.configuration,
          orderRowConfigurationCost: salesOrderRows.configurationCost,
        })
        .from(invoiceRows)
        .innerJoin(invoices, eq(invoices.id, invoiceRows.invoiceId))
        .innerJoin(customers, eq(customers.id, invoices.customerId))
        // LEFT join: an invoice row's articleId is nullable (a free-text line
        // carries only a description). An inner join would silently drop that
        // revenue from the report — it belongs in the total, counted among the
        // rows there is no calculation for.
        .leftJoin(articles, eq(articles.id, invoiceRows.articleId))
        // LEFT join: free rows and rows invoiced without an order link have
        // no order row. A credit row carries its source row's link, so its
        // (sign-flipped) quantity is costed the same way.
        .leftJoin(salesOrderRows, eq(salesOrderRows.id, invoiceRows.salesOrderRowId))
        .where(
          and(inArray(invoices.status, ["issued", "paid"]), gte(invoices.invoiceDate, start), lte(invoices.invoiceDate, end))
        );
      return rows.map((r) => ({
        month: r.month,
        customerId: r.customerId,
        customerName: r.customerName,
        articleId: r.articleId,
        articleNumber: r.articleNumber ?? "",
        articleName: r.articleName ?? "",
        quantity: Number(r.quantity),
        netAmount: Number(r.netAmount),
        // A configured order row is measured against ITS förkalkyl (null =
        // unknown ⇒ "saknar kalkyl"), never the template's own calculation;
        // undefined = an ordinary row, costed by the article as before.
        rowSelfCostPerUnit: r.orderRowConfiguration
          ? ((r.orderRowConfigurationCost as OrderRowConfigurationCost | null)?.selfCostPerUnit ?? null)
          : undefined,
      }));
    },

    async loadSalesStatistics(query: Pick<SalesStatisticsQuery, "groupBy"> & { from: string; to: string }) {
      const { start, end } = monthRangeToDates(query.from, query.to);
      // Valuta: in SEK at each invoice's rate (1 for SEK), so EUR and SEK
      // revenue are never summed in their own currencies — the same per-row
      // conversion as the inköpsstatistik.
      const signedNet = sql<string>`SUM((CASE WHEN ${invoices.type} = 'credit' THEN -1 ELSE 1 END) * ROUND(${invoiceRows.lineAmount} * COALESCE(${invoices.exchangeRate}, 1), 2))`;
      const signedQty = sql<string>`SUM((CASE WHEN ${invoices.type} = 'credit' THEN -1 ELSE 1 END) * ${invoiceRows.quantity})`;
      const invoiceCount = sql<string>`COUNT(DISTINCT ${invoices.id})`;
      const dateFilter = and(
        inArray(invoices.status, ["issued", "paid"]),
        gte(invoices.invoiceDate, start),
        lte(invoices.invoiceDate, end)
      );

      if (query.groupBy === "month") {
        const month = sql<string>`to_char(${invoices.invoiceDate}, 'YYYY-MM')`;
        const rows = await db
          .select({ key: month, netAmount: signedNet, invoiceCount })
          .from(invoiceRows)
          .innerJoin(invoices, eq(invoices.id, invoiceRows.invoiceId))
          .where(dateFilter)
          .groupBy(month)
          .orderBy(month);
        return rows.map((r) => ({
          key: r.key,
          label: r.key,
          netAmount: Number(r.netAmount),
          quantity: null,
          invoiceCount: Number(r.invoiceCount),
        }));
      }

      if (query.groupBy === "customer") {
        const rows = await db
          .select({ key: customers.id, label: customers.name, netAmount: signedNet, invoiceCount })
          .from(invoiceRows)
          .innerJoin(invoices, eq(invoices.id, invoiceRows.invoiceId))
          .innerJoin(customers, eq(customers.id, invoices.customerId))
          .where(dateFilter)
          .groupBy(customers.id, customers.name)
          .orderBy(sql`${signedNet} DESC`);
        return rows.map((r) => ({
          key: r.key,
          label: r.label,
          netAmount: Number(r.netAmount),
          quantity: null,
          invoiceCount: Number(r.invoiceCount),
        }));
      }

      // groupBy === "article" — LEFT JOIN so free-text rows (no articleId)
      // still surface, bucketed together as "(Fritextrader)".
      const key = sql<string>`COALESCE(${articles.id}::text, 'null')`;
      const label = sql<string>`CASE WHEN ${invoiceRows.articleId} IS NULL THEN '(Fritextrader)' ELSE ${articles.articleNumber} || ' — ' || ${articles.name} END`;
      const rows = await db
        .select({ key, label, netAmount: signedNet, quantity: signedQty, invoiceCount })
        .from(invoiceRows)
        .innerJoin(invoices, eq(invoices.id, invoiceRows.invoiceId))
        .leftJoin(articles, eq(articles.id, invoiceRows.articleId))
        .where(dateFilter)
        .groupBy(sql`1`, sql`2`)
        .orderBy(sql`${signedNet} DESC`);
      return rows.map((r) => ({
        key: r.key,
        label: r.label,
        netAmount: Number(r.netAmount),
        quantity: Number(r.quantity),
        invoiceCount: Number(r.invoiceCount),
      }));
    },

    // F1 Rapporter — inköpsstatistik. month/supplier sum the HEADER
    // net_amount (the paper invoice's authoritative total, same reasoning as
    // B4's open-amounts basis) since there is no per-row breakdown needed;
    // article grouping necessarily sums the ROW line_amount instead — the
    // `basis` field on the response tells the caller which one it's looking
    // at, since the two are not always equal (freight/rounding on the header
    // has no article row).
    //
    // Valuta: every amount is converted to SEK at its invoice's rate before
    // it is summed (round(amount × rate, 2) — the same round-half-away
    // arithmetic as @navet/shared toSek), so an EUR and a SEK invoice never
    // add up in their own currencies. SEK invoices have rate 1.
    async loadPurchaseStatistics(query: Pick<PurchaseStatisticsQuery, "groupBy"> & { from: string; to: string }) {
      const { start, end } = monthRangeToDates(query.from, query.to);
      const statusFilter = inArray(supplierInvoices.status, ["approved", "paid"]);

      if (query.groupBy === "month" || query.groupBy === "supplier") {
        const dateFilter = and(statusFilter, gte(supplierInvoices.invoiceDate, start), lte(supplierInvoices.invoiceDate, end));
        const invoiceCount = sql<string>`COUNT(DISTINCT ${supplierInvoices.id})`;
        const netAmount = sql<string>`SUM(ROUND(${supplierInvoices.netAmount} * ${supplierInvoices.exchangeRate}, 2))`;

        if (query.groupBy === "month") {
          const month = sql<string>`to_char(${supplierInvoices.invoiceDate}, 'YYYY-MM')`;
          const rows = await db
            .select({ key: month, netAmount, invoiceCount })
            .from(supplierInvoices)
            .where(dateFilter)
            .groupBy(month)
            .orderBy(month);
          return {
            basis: "header" as const,
            rows: rows.map((r) => ({
              key: r.key,
              label: r.key,
              netAmount: Number(r.netAmount),
              quantity: null,
              invoiceCount: Number(r.invoiceCount),
            })),
          };
        }

        const rows = await db
          .select({ key: suppliers.id, label: suppliers.name, netAmount, invoiceCount })
          .from(supplierInvoices)
          .innerJoin(suppliers, eq(suppliers.id, supplierInvoices.supplierId))
          .where(dateFilter)
          .groupBy(suppliers.id, suppliers.name)
          .orderBy(sql`${netAmount} DESC`);
        return {
          basis: "header" as const,
          rows: rows.map((r) => ({
            key: r.key,
            label: r.label,
            netAmount: Number(r.netAmount),
            quantity: null,
            invoiceCount: Number(r.invoiceCount),
          })),
        };
      }

      // groupBy === "article"
      const dateFilter = and(statusFilter, gte(supplierInvoices.invoiceDate, start), lte(supplierInvoices.invoiceDate, end));
      const netAmount = sql<string>`SUM(ROUND(${supplierInvoiceRows.lineAmount} * ${supplierInvoices.exchangeRate}, 2))`;
      const quantity = sql<string>`SUM(${supplierInvoiceRows.quantity})`;
      const invoiceCount = sql<string>`COUNT(DISTINCT ${supplierInvoices.id})`;
      const key = sql<string>`COALESCE(${articles.id}::text, 'null')`;
      const label = sql<string>`CASE WHEN ${supplierInvoiceRows.articleId} IS NULL THEN '(Rader utan artikel)' ELSE ${articles.articleNumber} || ' — ' || ${articles.name} END`;
      const rows = await db
        .select({ key, label, netAmount, quantity, invoiceCount })
        .from(supplierInvoiceRows)
        .innerJoin(supplierInvoices, eq(supplierInvoices.id, supplierInvoiceRows.supplierInvoiceId))
        .leftJoin(articles, eq(articles.id, supplierInvoiceRows.articleId))
        .where(dateFilter)
        .groupBy(sql`1`, sql`2`)
        .orderBy(sql`${netAmount} DESC`);
      return {
        basis: "rows" as const,
        rows: rows.map((r) => ({
          key: r.key,
          label: r.label,
          netAmount: Number(r.netAmount),
          quantity: Number(r.quantity),
          invoiceCount: Number(r.invoiceCount),
        })),
      };
    },

    // F1 Rapporter — kassationsstatistik. Month bucketing uses Stockholm wall
    // clock (created_at AT TIME ZONE 'Europe/Stockholm') since scrap events
    // are timestamped, unlike the date-only invoice columns above; the same
    // TZ-converted expression is reused for the range filter so bucketing and
    // filtering never disagree. `reason` groups by the exact string as typed
    // in the terminal/MO card — "Spån" and "spån" are deliberately kept as
    // separate rows (no normalization) so the register mirrors what
    // operators actually typed.
    async loadScrapStatistics(query: Pick<ScrapStatisticsQuery, "groupBy"> & { from: string; to: string }) {
      const monthExpr = sql<string>`to_char(${moOperationScrap.createdAt} AT TIME ZONE 'Europe/Stockholm', 'YYYY-MM')`;
      const dateFilter = and(gte(monthExpr, query.from), lte(monthExpr, query.to));
      const scrappedQuantity = sql<string>`SUM(${moOperationScrap.quantity})`;
      const reportCount = sql<string>`COUNT(*)`;

      if (query.groupBy === "month") {
        const rows = await db
          .select({ key: monthExpr, scrappedQuantity, reportCount })
          .from(moOperationScrap)
          .innerJoin(moOperations, eq(moOperations.id, moOperationScrap.moOperationId))
          .where(dateFilter)
          .groupBy(monthExpr)
          .orderBy(monthExpr);
        return rows.map((r) => ({
          key: r.key,
          label: r.key,
          scrappedQuantity: Number(r.scrappedQuantity),
          reportCount: Number(r.reportCount),
        }));
      }

      if (query.groupBy === "article") {
        const rows = await db
          .select({
            key: articles.id,
            label: sql<string>`${articles.articleNumber} || ' — ' || ${articles.name}`,
            scrappedQuantity,
            reportCount,
          })
          .from(moOperationScrap)
          .innerJoin(moOperations, eq(moOperations.id, moOperationScrap.moOperationId))
          .innerJoin(manufacturingOrders, eq(manufacturingOrders.id, moOperations.manufacturingOrderId))
          .innerJoin(articles, eq(articles.id, manufacturingOrders.articleId))
          .where(dateFilter)
          .groupBy(articles.id, articles.articleNumber, articles.name)
          .orderBy(sql`${scrappedQuantity} DESC`);
        return rows.map((r) => ({
          key: r.key,
          label: r.label,
          scrappedQuantity: Number(r.scrappedQuantity),
          reportCount: Number(r.reportCount),
        }));
      }

      if (query.groupBy === "workCenter") {
        const key = sql<string>`COALESCE(${workCenters.id}::text, 'null')`;
        const label = sql<string>`COALESCE(${workCenters.name}, '(Okänt arbetscenter)')`;
        const rows = await db
          .select({ key, label, scrappedQuantity, reportCount })
          .from(moOperationScrap)
          .innerJoin(moOperations, eq(moOperations.id, moOperationScrap.moOperationId))
          .leftJoin(workCenters, eq(workCenters.id, moOperations.workCenterId))
          .where(dateFilter)
          .groupBy(sql`1`, sql`2`)
          .orderBy(sql`${scrappedQuantity} DESC`);
        return rows.map((r) => ({
          key: r.key,
          label: r.label,
          scrappedQuantity: Number(r.scrappedQuantity),
          reportCount: Number(r.reportCount),
        }));
      }

      // groupBy === "reason" — exact string, no normalization.
      const rows = await db
        .select({ key: moOperationScrap.reason, label: moOperationScrap.reason, scrappedQuantity, reportCount })
        .from(moOperationScrap)
        .innerJoin(moOperations, eq(moOperations.id, moOperationScrap.moOperationId))
        .where(dateFilter)
        .groupBy(moOperationScrap.reason)
        .orderBy(sql`${scrappedQuantity} DESC`);
      return rows.map((r) => ({
        key: r.key,
        label: r.label,
        scrappedQuantity: Number(r.scrappedQuantity),
        reportCount: Number(r.reportCount),
      }));
    },
  };
}

export type ReportsRepository = ReturnType<typeof createReportsRepository>;

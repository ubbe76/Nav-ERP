import { asc, inArray, isNull, eq, and, gte, lte, sql } from "drizzle-orm";
import {
  articles,
  costCalculationMaterialRows,
  costCalculationOperationRows,
  costCalculations,
  customers,
  deviationReasons,
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
  systemSettings,
  workCenters,
  type Db,
  type Tx,
} from "@navet/db";
import type { PrecisionOrderInput } from "../service/delivery-precision-calc.js";
import { decodePrecisionMargins, PRECISION_MARGIN_KEYS } from "../../system/service/precision-settings.js";
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

// Försäljningsstatistik and Marginal/TB measure sales: a räntefaktura (an
// invoice that bears late_interest_charges — dröjsmålsränta and
// förseningsersättning, booked as financial income/3990) and a credit note
// of one are left out. Same NOT EXISTS as the late-interest candidates
// (late-interest.repository.ts); credited_invoice_id is null on an invoice,
// so IN matches only its own id there.
const notLateInterestInvoice = sql`NOT EXISTS (SELECT 1 FROM late_interest_charges lic WHERE lic.charge_invoice_id IN (${invoices.id}, ${invoices.creditedInvoiceId}))`;

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

// Kalkylutfall's reads, on one executor (the caller's snapshot) and in
// sequence: the statements share the transaction's connection.
async function readCalculationOutcome(ex: Db | Tx, range: { from: string; to: string }, opts: { withPre: boolean }) {
  // Aliased by hand: inside these subqueries an unqualified column would
  // bind to whichever table is nearest, and the outer queries join others.
  const periodPostIds = sql`(
    select cc.id from ${costCalculations} cc
    where cc.id in (
      select distinct on (latest.manufacturing_order_id) latest.id
      from ${costCalculations} latest
      where latest.type = 'post' and latest.manufacturing_order_id is not null
      order by latest.manufacturing_order_id, latest.calculated_at desc, latest.id desc
    )
    and to_char(cc.calculated_at at time zone 'Europe/Stockholm', 'YYYY-MM') between ${range.from} and ${range.to}
  )`;

  const headers = await ex
    .select({
      id: costCalculations.id,
      articleId: costCalculations.articleId,
      manufacturingOrderId: costCalculations.manufacturingOrderId,
      orderNumber: manufacturingOrders.orderNumber,
      configuration: manufacturingOrders.configuration,
      articleNumber: articles.articleNumber,
      articleName: articles.name,
      quantity: costCalculations.quantity,
      calculatedAt: costCalculations.calculatedAt,
      materialCost: costCalculations.materialCost,
      materialOverhead: costCalculations.materialOverhead,
      laborCost: costCalculations.laborCost,
      subcontractCost: costCalculations.subcontractCost,
      subcontractOverhead: costCalculations.subcontractOverhead,
      semiFinishedCost: costCalculations.semiFinishedCost,
      moPercent: costCalculations.moPercent,
      loPercent: costCalculations.loPercent,
      outputQuantity: costCalculations.outputQuantity,
      preliminary: costCalculations.preliminary,
      basePricedAt: costCalculations.basePricedAt,
      baseMaterialSource: costCalculations.baseMaterialSource,
    })
    .from(costCalculations)
    .innerJoin(manufacturingOrders, eq(manufacturingOrders.id, costCalculations.manufacturingOrderId))
    .innerJoin(articles, eq(articles.id, costCalculations.articleId))
    .where(sql`${costCalculations.id} in ${periodPostIds}`);

  const materialRows = await ex
    .select({
      costCalculationId: costCalculationMaterialRows.costCalculationId,
      id: costCalculationMaterialRows.id,
      componentArticleId: costCalculationMaterialRows.componentArticleId,
      articleNumber: articles.articleNumber,
      articleName: articles.name,
      kind: costCalculationMaterialRows.kind,
      quantity: costCalculationMaterialRows.quantity,
      unitCost: costCalculationMaterialRows.unitCost,
      amount: costCalculationMaterialRows.amount,
      baseQuantity: costCalculationMaterialRows.baseQuantity,
      baseUnitCost: costCalculationMaterialRows.baseUnitCost,
      basePriceSource: costCalculationMaterialRows.basePriceSource,
      scrapQuantity: costCalculationMaterialRows.scrapQuantity,
    })
    .from(costCalculationMaterialRows)
    .innerJoin(articles, eq(articles.id, costCalculationMaterialRows.componentArticleId))
    .where(sql`${costCalculationMaterialRows.costCalculationId} in ${periodPostIds}`)
    .orderBy(asc(costCalculationMaterialRows.createdAt), asc(costCalculationMaterialRows.id));

  const operationRows = await ex
    .select({
      costCalculationId: costCalculationOperationRows.costCalculationId,
      id: costCalculationOperationRows.id,
      sequenceNo: costCalculationOperationRows.sequenceNo,
      workCenterId: costCalculationOperationRows.workCenterId,
      workCenterCode: workCenters.code,
      workCenterName: workCenters.name,
      hours: costCalculationOperationRows.hours,
      setupHours: costCalculationOperationRows.setupHours,
      runHours: costCalculationOperationRows.runHours,
      hourlyRate: costCalculationOperationRows.hourlyRate,
      laborAmount: costCalculationOperationRows.laborAmount,
      subcontractAmount: costCalculationOperationRows.subcontractAmount,
      baseSetupHours: costCalculationOperationRows.baseSetupHours,
      baseRunHours: costCalculationOperationRows.baseRunHours,
      baseHourlyRate: costCalculationOperationRows.baseHourlyRate,
      baseQuantity: costCalculationOperationRows.baseQuantity,
      subcontractQuantity: costCalculationOperationRows.subcontractQuantity,
      baseUnitPrice: costCalculationOperationRows.baseUnitPrice,
      baseOneOff: costCalculationOperationRows.baseOneOff,
    })
    .from(costCalculationOperationRows)
    .innerJoin(workCenters, eq(workCenters.id, costCalculationOperationRows.workCenterId))
    .where(sql`${costCalculationOperationRows.costCalculationId} in ${periodPostIds}`)
    .orderBy(asc(costCalculationOperationRows.sequenceNo), asc(costCalculationOperationRows.id));

  const preCalculations = opts.withPre
    ? await ex
        .select({
          articleId: costCalculations.articleId,
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
        .where(
          and(
            eq(costCalculations.type, "pre"),
            isNull(costCalculations.manufacturingOrderId),
            sql`${costCalculations.articleId} in (select period.article_id from ${costCalculations} period where period.id in ${periodPostIds})`
          )
        )
    : [];

  return { headers, materialRows, operationRows, preCalculations };
}

export function createReportsRepository(db: Db) {
  return {
    // Marginal i leveransprecisionen (#29): both sides' margins in ONE query;
    // precision-settings.ts owns the keys and the defaults.
    async loadPrecisionMargins() {
      const rows = await db
        .select({ key: systemSettings.key, value: systemSettings.value })
        .from(systemSettings)
        .where(inArray(systemSettings.key, Object.values(PRECISION_MARGIN_KEYS)));
      const byKey = new Map(rows.map((r) => [r.key, r.value]));
      return decodePrecisionMargins((key) => byKey.get(key));
    },

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
          orderId: salesOrders.id,
          counterpartyId: salesOrders.customerId,
          counterpartyName: customers.name,
          expectedDeliveryDate: salesOrders.expectedDeliveryDate,
          completedAt: lastDelivery,
        })
        .from(salesOrders)
        .innerJoin(customers, eq(customers.id, salesOrders.customerId))
        .where(inArray(salesOrders.status, ["delivered", "invoiced"]));
      return rows.map((r) => ({
        orderId: r.orderId,
        counterpartyId: r.counterpartyId,
        counterpartyName: r.counterpartyName,
        expectedDeliveryDate: r.expectedDeliveryDate,
        completedAt: toIso(r.completedAt),
      }));
    },

    // Completed purchase orders with promise + last inleverans time (live
    // receipts only: Ångra inleverans's reversal and the undone receipt are
    // not deliveries). The receipt log (purchase_receipts, 0118) has every
    // inleverans — also the lego and service rows, which book no stock
    // movement — and the stock log covers the receipts from before 0118
    // that have no log row; the later of the two counts (greatest skips a
    // null). Same scalar-subquery idiom as purchase's listInvoiceBasis.
    async loadPurchasePrecisionOrders(): Promise<PrecisionOrderInput[]> {
      const lastReceipt = sql<string | null>`greatest(
        (SELECT MAX(pr.created_at) FROM ${purchaseReceipts} pr WHERE pr.purchase_order_id = ${sql.raw('"purchase_orders"."id"')} AND pr.undone_at IS NULL),
        (SELECT MAX(st.created_at) FROM ${stockTransactions} st WHERE st.reference_id = ${sql.raw('"purchase_orders"."id"')} AND st.transaction_type = 'purchase_receipt' AND st.quantity_delta > 0 AND NOT EXISTS (SELECT 1 FROM ${purchaseReceipts} pr WHERE pr.stock_transaction_id = st.id AND pr.undone_at IS NOT NULL))
      )`;
      const rows = await db
        .select({
          orderId: purchaseOrders.id,
          counterpartyId: purchaseOrders.supplierId,
          counterpartyName: suppliers.name,
          expectedDeliveryDate: purchaseOrders.expectedDeliveryDate,
          completedAt: lastReceipt,
        })
        .from(purchaseOrders)
        .innerJoin(suppliers, eq(suppliers.id, purchaseOrders.supplierId))
        .where(inArray(purchaseOrders.status, ["received", "closed"]));
      return rows.map((r) => ({
        orderId: r.orderId,
        counterpartyId: r.counterpartyId,
        counterpartyName: r.counterpartyName,
        expectedDeliveryDate: r.expectedDeliveryDate,
        completedAt: toIso(r.completedAt),
      }));
    },

    // Kalkylutfall: every TO's LATEST efterkalkyl (DISTINCT ON the order,
    // newest calculated_at, then id) whose Stockholm month is in the period —
    // a TO counts in the period of its facit and nowhere else — with the
    // header, the order's configuration cost and the saved specification
    // rows the avvikelseanalys is derived from. The row tables are read with
    // one query each against the same subquery (never an id list: the
    // parameter cap), so nothing is per order. `withPre` adds the
    // article-level förkalkyler (manufacturing_order_id null — the only kind
    // the costing module saves) of the period's articles for Mot förkalkyl.
    async loadCalculationOutcome(range: { from: string; to: string }, opts: { withPre: boolean }) {
      // ONE snapshot (repeatable read, read only — PIA's readSources): every
      // statement evaluates the latest-efterkalkyl subquery again, and a Spara
      // committed between two of them would give a TO header A with the rows
      // of B — A without rows, its whole Utfall in Påslag. No HTTP inside.
      return db.transaction((tx) => readCalculationOutcome(tx, range, opts), {
        isolationLevel: "repeatable read",
        accessMode: "read only",
      });
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
          and(
            inArray(invoices.status, ["issued", "paid"]),
            gte(invoices.invoiceDate, start),
            lte(invoices.invoiceDate, end),
            notLateInterestInvoice
          )
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
        lte(invoices.invoiceDate, end),
        notLateInterestInvoice
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
    // operators actually typed; a reason from the register groups on it.
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

      // groupBy === "reason" — Kvalitet (0153): a row with an Avvikelseorsak
      // groups on the reason (its comment is ignored); an older free-text
      // row groups on the exact string, no normalization, labelled
      // "… (fritext)".
      const reasonKey = sql<string>`CASE WHEN ${moOperationScrap.reasonId} IS NOT NULL THEN ${moOperationScrap.reasonId}::text ELSE 'text:' || ${moOperationScrap.reason} END`;
      const reasonLabel = sql<string>`CASE WHEN ${moOperationScrap.reasonId} IS NOT NULL THEN ${deviationReasons.name} ELSE ${moOperationScrap.reason} || ' (fritext)' END`;
      const rows = await db
        .select({ key: reasonKey, label: reasonLabel, scrappedQuantity, reportCount })
        .from(moOperationScrap)
        .innerJoin(moOperations, eq(moOperations.id, moOperationScrap.moOperationId))
        .leftJoin(deviationReasons, eq(deviationReasons.id, moOperationScrap.reasonId))
        .where(dateFilter)
        .groupBy(sql`1`, sql`2`)
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

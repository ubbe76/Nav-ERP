import { buildCsv, type CsvColumn, type PurchaseOrderRegisterQuery, type SalesOrderRegisterQuery } from "@navet/shared";
import { formatNumber, type OrderRegisterPdfInput } from "../../mail/service/document-pdf.js";
import { PURCHASE_ORDER_STATUS_LABELS } from "../../purchase/service/export-columns.js";
import { SALES_ORDER_STATUS_LABELS } from "../../sales/service/export-columns.js";
import { ORDER_REGISTER_MAX_ROWS, type OrderRegisterRepository } from "../repository/order-register.repository.js";
import { buildOrderRegister, type OrderRegisterOrder, type OrderRegisterRow } from "./order-register.js";

export type OrderRegisterKind = "sales" | "purchase";
type RegisterQuery = SalesOrderRegisterQuery | PurchaseOrderRegisterQuery;

export class OrderRegisterTooLargeError extends Error {
  constructor() {
    super(`The selection has more than ${ORDER_REGISTER_MAX_ROWS} order rows`);
    this.name = "OrderRegisterTooLargeError";
  }
}

// Only the one renderer — reports never touches the rest of the PDF service.
export interface OrderRegisterPdfRenderer {
  renderOrderRegister(input: OrderRegisterPdfInput): Promise<Buffer>;
}

const SIDE = {
  sales: {
    title: "Orderförteckning kundorder",
    filename: "orderforteckning-kundorder",
    partnerLabel: "Kund",
    doneLabel: "Levererat",
    statusLabels: SALES_ORDER_STATUS_LABELS as Record<string, string>,
  },
  purchase: {
    title: "Orderförteckning inköp",
    filename: "orderforteckning-inkop",
    partnerLabel: "Leverantör",
    doneLabel: "Mottaget",
    statusLabels: PURCHASE_ORDER_STATUS_LABELS as Record<string, string>,
  },
} as const;

const stockholmToday = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Stockholm" }).format(new Date());

// The PDF subtitle states the selection in words, so a printed list says
// what it is a list of.
function describeSelection(kind: OrderRegisterKind, query: RegisterQuery): string {
  const side = SIDE[kind];
  const parts: string[] = [];
  const basis = query.dateBasis === "order" ? "Orderdatum" : "Leveransdatum";
  if (query.from && query.to) parts.push(`${basis} ${query.from} – ${query.to}`);
  else if (query.from) parts.push(`${basis} från ${query.from}`);
  else if (query.to) parts.push(`${basis} till och med ${query.to}`);
  if (query.status === "open") parts.push("Öppna ordrar");
  else if (query.status) parts.push(`Status: ${query.status.map((s) => side.statusLabels[s] ?? s).join(", ")}`);
  else parts.push("Alla statusar");
  if (query.openOnly) parts.push("Bara rader med rest");
  return parts.join(" · ");
}

interface CsvLine {
  order: OrderRegisterOrder;
  row?: OrderRegisterRow;
}

function csvColumns(kind: OrderRegisterKind, withRows: boolean): CsvColumn<CsvLine>[] {
  const side = SIDE[kind];
  const head: CsvColumn<CsvLine>[] = [
    { label: "Order", value: (l) => l.order.orderNumber },
    { label: "Orderdatum", value: (l) => l.order.orderDate, format: "date" },
    { label: `${side.partnerLabel}nummer`, value: (l) => l.order.partnerNumber },
    { label: side.partnerLabel, value: (l) => l.order.partnerName },
    { label: "Status", value: (l) => side.statusLabels[l.order.status] ?? l.order.status },
    { label: "Valuta", value: (l) => l.order.currency },
  ];
  if (!withRows) {
    return [
      ...head,
      { label: "Leveransdatum", value: (l) => l.order.deliveryDate, format: "date" },
      { label: "Antal rader", value: (l) => l.order.rowCount },
      { label: "Ordervärde", value: (l) => l.order.orderValue, format: "money" },
      { label: "Restvärde", value: (l) => l.order.restValue, format: "money" },
    ];
  }
  return [
    ...head,
    { label: "Artikel", value: (l) => l.row?.articleNumber },
    { label: "Benämning", value: (l) => l.row?.articleName },
    { label: "Antal", value: (l) => l.row?.quantity, format: "number" },
    { label: side.doneLabel, value: (l) => l.row?.done, format: "number" },
    { label: "Rest", value: (l) => l.row?.rest, format: "number" },
    { label: "Enhet", value: (l) => l.row?.unit },
    { label: "À-pris", value: (l) => l.row?.unitPrice, format: "number" },
    ...(kind === "sales"
      ? [{ label: "Rabatt %", value: (l: CsvLine) => l.row?.discountPercent, format: "number" as const }]
      : [{ label: "Ställpris", value: (l: CsvLine) => l.row?.setupPrice, format: "money" as const }]),
    { label: "Belopp", value: (l) => l.row?.amount, format: "money" },
    { label: "Restbelopp", value: (l) => l.row?.restAmount, format: "money" },
    { label: "Leveransdatum", value: (l) => l.row?.deliveryDate, format: "date" },
  ];
}

export function createOrderRegisterService(repo: OrderRegisterRepository, pdf?: OrderRegisterPdfRenderer) {
  const service = {
    async get(kind: OrderRegisterKind, query: RegisterQuery) {
      // One row past the ceiling tells "over" from "exactly at" without a count.
      const limit = ORDER_REGISTER_MAX_ROWS + 1;
      const source =
        kind === "sales"
          ? await repo.loadSalesRows(query as SalesOrderRegisterQuery, limit)
          : await repo.loadPurchaseRows(query as PurchaseOrderRegisterQuery, limit);
      if (source.length > ORDER_REGISTER_MAX_ROWS) throw new OrderRegisterTooLargeError();
      return buildOrderRegister(source, query.withRows ?? false);
    },

    async getCsv(kind: OrderRegisterKind, query: RegisterQuery) {
      const withRows = query.withRows ?? false;
      // The CSV always carries the rows when asked — one line per row with
      // the order columns repeated, so Excel can filter and pivot it.
      const result = await service.get(kind, query);
      const lines: CsvLine[] = withRows
        ? result.orders.flatMap((order) => (order.rows ?? []).map((row) => ({ order, row })))
        : result.orders.map((order) => ({ order }));
      return {
        filename: `${SIDE[kind].filename}-${stockholmToday()}.csv`,
        content: buildCsv(csvColumns(kind, withRows), lines),
      };
    },

    async getPdf(kind: OrderRegisterKind, query: RegisterQuery) {
      if (!pdf) throw new Error("order register service was created without a PDF renderer");
      const side = SIDE[kind];
      const withRows = query.withRows ?? false;
      const result = await service.get(kind, query);
      const qty = (n: number) => formatNumber(n, 4).replace(/,?0+$/, "");
      const content = await pdf.renderOrderRegister({
        title: side.title,
        subtitle: describeSelection(kind, query),
        partnerLabel: side.partnerLabel,
        doneLabel: side.doneLabel,
        withRows,
        orders: result.orders.map((order) => ({
          orderNumber: order.orderNumber,
          orderDate: order.orderDate,
          partner: `${order.partnerNumber} ${order.partnerName}`,
          status: side.statusLabels[order.status] ?? order.status,
          deliveryDate: order.deliveryDate ?? "",
          currency: order.currency,
          orderValue: formatNumber(order.orderValue),
          restValue: formatNumber(order.restValue),
          rows: (order.rows ?? []).map((row) => ({
            articleNumber: row.articleNumber,
            articleName: row.articleName,
            quantity: qty(row.quantity),
            done: qty(row.done),
            rest: qty(row.rest),
            unit: row.unit ?? "",
            unitPrice: formatNumber(row.unitPrice),
            amount: formatNumber(row.amount),
            restAmount: formatNumber(row.restAmount),
            deliveryDate: row.deliveryDate ?? "",
          })),
        })),
        totals: {
          label: `Summa${result.totals.converted ? " i SEK" : ""} · ${result.totals.orderCount} ordrar, ${result.totals.rowCount} rader`,
          orderValue: formatNumber(result.totals.orderValueSek),
          restValue: formatNumber(result.totals.restValueSek),
        },
        emptyText: "Inga ordrar matchar urvalet.",
      });
      return { filename: `${side.filename}-${stockholmToday()}.pdf`, content };
    },
  };
  return service;
}

export type OrderRegisterService = ReturnType<typeof createOrderRegisterService>;

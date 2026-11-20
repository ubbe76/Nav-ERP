// Lista och kort (Programramen, steg 2): the narrow list beside a card —
// for each function, where its rows come from (the list's own endpoint with
// search/limit/offset and the filter's query), the quick filters, and how a
// row reads on two lines (name and amount, number · date and status). Keyed
// by the list page's path, which is also the function (lib/navFunctions.ts).
import {
  ARTICLE_TYPE_LABELS,
  INQUIRY_STATUS_PILL,
  INVOICE_STATUS_PILL,
  MANUFACTURING_ORDER_STATUS_PILL,
  PURCHASE_ORDER_STATUS_PILL,
  SALES_ORDER_STATUS_PILL,
  SUPPLIER_INVOICE_STATUS_PILL,
  type Article,
  type Customer,
  type Inquiry,
  type Invoice,
  type ManufacturingOrder,
  type PurchaseOrder,
  type SalesOrder,
  type Supplier,
  type SupplierInvoice,
} from "../../lib/types";
import { formatMoney, formatQuantity } from "../../lib/format";

export type SplitTone = "running" | "delayed" | "stopped" | "done" | "draft";

export interface SplitRow {
  id: string;
  href: string;
  primary: string;
  amount?: string | null;
  secondary: string;
  status?: { label: string; tone: SplitTone } | null;
}

export interface SplitListConfig {
  path: string;
  title: string;
  // "Välj en kundorder i listan."
  noun: string;
  api: string;
  newHref?: string;
  newLabel: string;
  searchPlaceholder: string;
  // The first is Alla (no query).
  filters: { label: string; query: string }[];
  row: (raw: unknown) => SplitRow;
}

// "2026-11-27" → "11-27": the list is narrow, and the year is nearly always
// this one.
function shortDate(date: string | null | undefined): string {
  if (!date) return "–";
  return date.slice(5, 10);
}

function join(...parts: (string | null | undefined | false)[]): string {
  return parts.filter((p): p is string => typeof p === "string" && p.length > 0).join(" · ");
}

function money(value: string | number | null | undefined, currency?: string | null): string | null {
  if (value === null || value === undefined || value === "") return null;
  const text = formatMoney(value);
  return currency && currency !== "SEK" ? `${text} ${currency}` : text;
}

const salesOrder = (kind: "order" | "quote") => (raw: unknown): SplitRow => {
  const o = raw as SalesOrder;
  const number = kind === "quote" ? (o.quoteNumber ?? o.orderNumber) : o.orderNumber;
  const pill = SALES_ORDER_STATUS_PILL[o.status];
  return {
    id: o.id,
    href: `/forsaljning/${kind === "quote" ? "offerter" : "ordrar"}/${o.id}`,
    primary: o.customerName,
    secondary: kind === "quote" ? join(number, o.quoteValidUntil ? `giltig ${shortDate(o.quoteValidUntil)}` : null) : join(number, `lev ${shortDate(o.nextDeliveryDate ?? o.expectedDeliveryDate)}`),
    status: pill ? { label: pill.label, tone: pill.status } : null,
  };
};

export const SPLIT_LISTS: Record<string, SplitListConfig> = {
  "/forsaljning/ordrar": {
    path: "/forsaljning/ordrar",
    title: "Kundorder",
    noun: "en kundorder",
    api: "/api/v1/sales-orders?kind=order",
    newHref: "/forsaljning/ordrar?ny=1",
    newLabel: "Ny kundorder",
    searchPlaceholder: "Sök i kundorder",
    filters: [
      { label: "Alla", query: "" },
      { label: "Öppna", query: "status=confirmed,in_production" },
      { label: "Levererade", query: "status=delivered" },
      { label: "Fakturerade", query: "status=invoiced" },
    ],
    row: salesOrder("order"),
  },
  "/forsaljning/offerter": {
    path: "/forsaljning/offerter",
    title: "Offerter",
    noun: "en offert",
    api: "/api/v1/sales-orders?kind=quote",
    newHref: "/forsaljning/offerter?ny=1",
    newLabel: "Ny offert",
    searchPlaceholder: "Sök i offerter",
    filters: [
      { label: "Alla", query: "" },
      { label: "Öppna", query: "status=quote" },
      { label: "Order", query: "status=ordered" },
      { label: "Förlorade", query: "status=lost" },
    ],
    row: salesOrder("quote"),
  },
  "/inkop/ordrar": {
    path: "/inkop/ordrar",
    title: "Inköpsorder",
    noun: "en inköpsorder",
    api: "/api/v1/purchase-orders",
    newHref: "/inkop/ordrar?ny=1",
    newLabel: "Ny inköpsorder",
    searchPlaceholder: "Sök i inköpsorder",
    filters: [
      { label: "Alla", query: "" },
      { label: "Öppna", query: "status=draft,confirmed,partially_received" },
      { label: "Mottagna", query: "status=received" },
      { label: "Stängda", query: "status=closed" },
    ],
    row: (raw) => {
      const o = raw as PurchaseOrder;
      const pill = PURCHASE_ORDER_STATUS_PILL[o.status];
      return {
        id: o.id,
        href: `/inkop/ordrar/${o.id}`,
        primary: o.supplierName,
        secondary: join(o.orderNumber, `lev ${shortDate(o.nextDeliveryDate ?? o.expectedDeliveryDate)}`),
        status: pill ? { label: pill.label, tone: pill.status } : null,
      };
    },
  },
  "/inkop/forfragningar": {
    path: "/inkop/forfragningar",
    title: "Förfrågningar",
    noun: "en förfrågan",
    api: "/api/v1/inquiries",
    newHref: "/inkop/forfragningar?ny=1",
    newLabel: "Ny förfrågan",
    searchPlaceholder: "Sök i förfrågningar",
    filters: [
      { label: "Alla", query: "" },
      { label: "Utkast", query: "status=draft" },
      { label: "Skickade", query: "status=sent" },
      { label: "Besvarade", query: "status=answered" },
    ],
    row: (raw) => {
      const q = raw as Inquiry;
      const pill = INQUIRY_STATUS_PILL[q.status];
      return {
        id: q.id,
        href: `/inkop/forfragningar/${q.id}`,
        primary: q.supplierName,
        secondary: join(q.inquiryNumber, q.expectedDeliveryDate ? `önskat ${shortDate(q.expectedDeliveryDate)}` : null),
        status: pill ? { label: pill.label, tone: pill.status } : null,
      };
    },
  },
  "/tillverkning/ordrar": {
    path: "/tillverkning/ordrar",
    title: "Tillverkningsordrar",
    noun: "en tillverkningsorder",
    api: "/api/v1/manufacturing-orders",
    newHref: "/tillverkning/ordrar?ny=1",
    newLabel: "Ny tillverkningsorder",
    searchPlaceholder: "Sök i tillverkningsordrar",
    filters: [
      { label: "Alla", query: "" },
      { label: "Planerade", query: "status=planned" },
      { label: "Frisläppta", query: "status=released" },
      { label: "Pågår", query: "status=in_progress" },
    ],
    row: (raw) => {
      const m = raw as ManufacturingOrder;
      const pill = MANUFACTURING_ORDER_STATUS_PILL[m.status];
      return {
        id: m.id,
        href: `/tillverkning/ordrar/${m.id}`,
        primary: m.articleName,
        amount: `${formatQuantity(m.quantity)} ${m.articleUnitCode ?? ""}`.trim(),
        secondary: join(m.orderNumber, m.articleNumber, `klar ${shortDate(m.plannedEndDate ?? m.dueDate)}`),
        status: pill ? { label: pill.label, tone: m.late ? "delayed" : pill.status } : null,
      };
    },
  },
  "/forsaljning/fakturor": {
    path: "/forsaljning/fakturor",
    title: "Fakturor",
    noun: "en faktura",
    api: "/api/v1/invoices",
    newHref: "/forsaljning/fakturor?ny=1",
    newLabel: "Ny faktura",
    searchPlaceholder: "Sök i fakturor",
    filters: [
      { label: "Alla", query: "" },
      { label: "Utkast", query: "status=draft" },
      { label: "Utfärdade", query: "status=issued" },
      { label: "Betalda", query: "status=paid" },
    ],
    row: (raw) => {
      const f = raw as Invoice;
      const pill = INVOICE_STATUS_PILL[f.status];
      return {
        id: f.id,
        href: `/forsaljning/fakturor/${f.id}`,
        primary: f.customerName,
        amount: money(f.netAmount, f.currency),
        secondary: join(f.invoiceNumber ?? "Utkast", f.dueDate ? `förfaller ${shortDate(f.dueDate)}` : null),
        status: pill ? { label: pill.label, tone: pill.status } : null,
      };
    },
  },
  "/inkop/leverantorsfakturor": {
    path: "/inkop/leverantorsfakturor",
    title: "Leverantörsfakturor",
    noun: "en leverantörsfaktura",
    api: "/api/v1/supplier-invoices",
    newHref: "/inkop/leverantorsfakturor?ny=1",
    newLabel: "Ny leverantörsfaktura",
    searchPlaceholder: "Sök i leverantörsfakturor",
    filters: [
      { label: "Alla", query: "" },
      { label: "Utkast", query: "status=draft" },
      { label: "Godkända", query: "status=approved" },
      { label: "Betalda", query: "status=paid" },
    ],
    row: (raw) => {
      const f = raw as SupplierInvoice;
      const pill = SUPPLIER_INVOICE_STATUS_PILL[f.status];
      return {
        id: f.id,
        href: `/inkop/leverantorsfakturor/${f.id}`,
        primary: f.supplierName,
        amount: money(f.grossAmount, f.currency),
        secondary: join(f.registrationNumber, f.invoiceNumber, f.dueDate ? `förfaller ${shortDate(f.dueDate)}` : null),
        status: pill ? { label: pill.label, tone: pill.status } : null,
      };
    },
  },
  "/artiklar/register": {
    path: "/artiklar/register",
    title: "Artikelregister",
    noun: "en artikel",
    api: "/api/v1/articles",
    newHref: "/artiklar/register?ny=1",
    newLabel: "Ny artikel",
    searchPlaceholder: "Sök i artikelregister",
    filters: [
      { label: "Alla", query: "" },
      { label: "Köpta", query: "type=purchased" },
      { label: "Tillverkade", query: "type=manufactured" },
      { label: "Tjänster", query: "type=service" },
    ],
    row: (raw) => {
      const a = raw as Article;
      return {
        id: a.id,
        href: `/artiklar/${a.id}`,
        primary: a.name,
        secondary: join(a.articleNumber, ARTICLE_TYPE_LABELS[a.type]),
        status: a.active ? null : { label: "Inaktiv", tone: "draft" },
      };
    },
  },
  "/kunder": {
    path: "/kunder",
    title: "Kunder",
    noun: "en kund",
    api: "/api/v1/customers",
    newHref: "/kunder?ny=1",
    newLabel: "Ny kund",
    searchPlaceholder: "Sök i kunder",
    filters: [{ label: "Alla", query: "" }],
    row: (raw) => {
      const c = raw as Customer;
      return {
        id: c.id,
        href: `/kunder/${c.id}`,
        primary: c.name,
        secondary: join(c.customerNumber, c.city),
        status: c.active === false ? { label: "Inaktiv", tone: "draft" } : null,
      };
    },
  },
  "/leverantorer": {
    path: "/leverantorer",
    title: "Leverantörer",
    noun: "en leverantör",
    api: "/api/v1/suppliers",
    newHref: "/leverantorer?ny=1",
    newLabel: "Ny leverantör",
    searchPlaceholder: "Sök i leverantörer",
    filters: [{ label: "Alla", query: "" }],
    row: (raw) => {
      const s = raw as Supplier;
      return {
        id: s.id,
        href: `/leverantorer/${s.id}`,
        primary: s.name,
        secondary: join(s.supplierNumber, s.city),
        status: s.active === false ? { label: "Inaktiv", tone: "draft" } : null,
      };
    },
  },
};

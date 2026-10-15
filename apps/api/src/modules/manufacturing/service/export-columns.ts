// F2: CSV columns for GET /manufacturing-orders/csv — mirrors
// ManufacturingOrdersPageClient.tsx's Table column order/labels
// (apps/web/components/manufacturing/ManufacturingOrdersPageClient.tsx).
import type { ManufacturingOrderStatus } from "@navet/shared";
import { type CsvColumn } from "@navet/shared";

// Server-side mirror of the web's MANUFACTURING_ORDER_STATUS_PILL labels
// (apps/web/lib/types.ts) — duplicated rather than shared across the app boundary.
const MANUFACTURING_ORDER_STATUS_LABELS: Record<ManufacturingOrderStatus, string> = {
  planned: "Planerad",
  released: "Frisläppt",
  in_progress: "Pågår",
  done: "Klar",
  closed: "Stängd",
  cancelled: "Avbruten",
};

export interface ManufacturingOrderExportRow {
  orderNumber: string;
  articleNumber: string;
  articleName: string;
  quantity: string | number;
  dueDate: string | null;
  status: ManufacturingOrderStatus;
}

export const manufacturingOrderExportColumns: CsvColumn<ManufacturingOrderExportRow>[] = [
  { label: "Ordernummer", value: (r) => r.orderNumber },
  { label: "Artikel", value: (r) => `${r.articleNumber} — ${r.articleName}` },
  { label: "Antal", value: (r) => r.quantity, format: "number" },
  { label: "Färdigt", value: (r) => r.dueDate, format: "date" },
  { label: "Status", value: (r) => MANUFACTURING_ORDER_STATUS_LABELS[r.status] },
];

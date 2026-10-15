import { ApiError } from "./api";
import { apiErrorMessage } from "./errorMessages";
import type { Status } from "../components/ui/StatusPill";
import type { ParcelKind, ShipmentStatus } from "./types";

export const SHIPMENT_STATUS_LABELS: Record<ShipmentStatus, string> = {
  draft: "Utkast",
  booked: "Bokad",
  delivered: "Levererad",
  cancelled: "Avbruten",
};

export const SHIPMENT_STATUS_PILL: Record<ShipmentStatus, Status> = {
  draft: "draft",
  booked: "running",
  delivered: "done",
  cancelled: "stopped",
};

export const PARCEL_KIND_LABELS: Record<ParcelKind, string> = { package: "Paket", pallet: "Pall", other: "Övrigt" };

export const WEEKDAYS: { weekday: number; label: string }[] = [
  { weekday: 1, label: "Måndag" },
  { weekday: 2, label: "Tisdag" },
  { weekday: 3, label: "Onsdag" },
  { weekday: 4, label: "Torsdag" },
  { weekday: 5, label: "Fredag" },
  { weekday: 6, label: "Lördag" },
  { weekday: 7, label: "Söndag" },
];

export function formatSek(value: number | null): string {
  if (value === null) return "—";
  return `${value.toLocaleString("sv-SE", { minimumFractionDigits: 0, maximumFractionDigits: 2 })} kr`;
}

// Mirrors freightMode() in apps/api/src/modules/shipping/service/parcels.ts —
// the web cannot import the API, so the three-way rule is duplicated here.
export function freightModeText(a: {
  packageTypeId: string | null;
  quantityPerPackage: string | null;
  length: string | null;
  width: string | null;
  height: string | null;
}, packageTypeName: string | null): string {
  if (a.packageTypeId && Number(a.quantityPerPackage) > 0) {
    return `Förpackning: ${packageTypeName ?? "kollityp"} à ${Number(a.quantityPerPackage).toLocaleString("sv-SE")}`;
  }
  if (Number(a.length) > 0 || Number(a.width) > 0 || Number(a.height) > 0) return "Egna mått";
  return "Inget fraktsätt — vikten hamnar på en rad Övrigt";
}


// Shipping errors carry fieldErrors (our own pre-check and Sendify's field
// errors, already in Swedish) — appended to the message.
export function shippingErrorText(err: unknown, fallback: string): string {
  const base = apiErrorMessage(err, fallback);
  const body = err instanceof ApiError ? (err.body as { fieldErrors?: unknown } | undefined) : undefined;
  const fields = Array.isArray(body?.fieldErrors) ? (body!.fieldErrors as string[]) : [];
  return fields.length > 0 ? `${base}: ${fields.join(" · ")}` : base;
}

export function errorBody<T>(err: unknown): T | null {
  return err instanceof ApiError ? ((err.body as T | undefined) ?? null) : null;
}

export { formatStockholmDate as formatDate, formatStockholmDateTime as formatDateTime } from "./date";

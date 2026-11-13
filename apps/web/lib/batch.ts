import type { BatchBalanceRow } from "./types";

// Batch (#8) choice value of a <select>: "" = Automatiskt (oldest batch first,
// the default), "unknown" = Okänd, anything else = a batch id.
export const BATCH_AUTO = "";
export const BATCH_UNKNOWN = "unknown";

// The request fields for a choice: omitted = Automatiskt, null = Okänd.
export function batchIdField(choice: string): { batchId?: string | null } {
  if (choice === BATCH_AUTO) return {};
  if (choice === BATCH_UNKNOWN) return { batchId: null };
  return { batchId: choice };
}

export interface BatchOption {
  value: string;
  label: string;
  quantity: number;
  expiresOn: string | null;
  expired: boolean;
}

// "utgår 2026-12-01" / "utgången 2026-10-01" (YYYY-MM-DD is already the
// Swedish date format); "" for a batch without a date.
export function expiryText(expiresOn: string | null | undefined, expired: boolean | undefined): string {
  if (!expiresOn) return "";
  return `${expired ? "utgången" : "utgår"} ${expiresOn}`;
}

// Distinct choices (one per batch) for one article, filtered on a location
// when one is picked; quantities are summed over locations otherwise.
export function batchOptions(rows: BatchBalanceRow[], articleId: string, locationId?: string | null): BatchOption[] {
  const byBatch = new Map<string, BatchOption>();
  for (const r of rows) {
    if (r.articleId !== articleId) continue;
    if (locationId && r.locationId !== locationId) continue;
    // A serial number is chosen as a serienummer (SerialCellPicker), not as a batch.
    if (r.batchKind === "serial") continue;
    const value = r.batchId ?? BATCH_UNKNOWN;
    const prev = byBatch.get(value);
    if (prev) prev.quantity += Number(r.quantity);
    else
      byBatch.set(value, {
        value,
        label: r.batchNumber ?? "Okänd",
        quantity: Number(r.quantity),
        expiresOn: r.expiresOn ?? null,
        expired: Boolean(r.expired),
      });
  }
  return [...byBatch.values()].filter((o) => o.quantity > 0 || o.value === BATCH_UNKNOWN);
}

// A hand-picked utgången batch must name its place: without one the API
// resolves the place by the usual rule, which may not be where the expired
// stock lies (409 on the place cap). Returns the place of the first unblocked
// cell of the chosen batch when it is expired and no place is picked already.
export function expiredBatchLocationId(
  rows: BatchBalanceRow[],
  articleId: string,
  choice: string,
  pickedLocationId?: string | null
): string | undefined {
  if (pickedLocationId || choice === BATCH_AUTO || choice === BATCH_UNKNOWN) return undefined;
  const cells = rows.filter((r) => r.articleId === articleId && r.batchId === choice && r.expired && r.locationId);
  const cell = cells.find((r) => !r.blocked && Number(r.quantity) > 0) ?? cells[0];
  return cell?.locationId ?? undefined;
}

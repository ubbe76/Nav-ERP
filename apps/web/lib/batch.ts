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

// Distinct choices (one per batch) for one article, filtered on a location
// when one is picked; quantities are summed over locations otherwise.
export function batchOptions(
  rows: BatchBalanceRow[],
  articleId: string,
  locationId?: string | null
): { value: string; label: string; quantity: number }[] {
  const byBatch = new Map<string, { value: string; label: string; quantity: number }>();
  for (const r of rows) {
    if (r.articleId !== articleId) continue;
    if (locationId && r.locationId !== locationId) continue;
    const value = r.batchId ?? BATCH_UNKNOWN;
    const prev = byBatch.get(value);
    if (prev) prev.quantity += Number(r.quantity);
    else byBatch.set(value, { value, label: r.batchNumber ?? "Okänd", quantity: Number(r.quantity) });
  }
  return [...byBatch.values()].filter((o) => o.quantity > 0 || o.value === BATCH_UNKNOWN);
}

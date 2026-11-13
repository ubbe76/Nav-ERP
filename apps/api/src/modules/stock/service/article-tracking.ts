// Spårning (#8, etapp 2) — the article's tracking is none | batch | serial,
// "antingen eller". A PURE leaf (no DB imports): the ONE rule for how a
// request's `tracking` and its older alias `batchTracked` become the stored
// value, used by the article card and the article import.
import type { ArticleTracking } from "@navet/shared";

export type { ArticleTracking };

// The article's Spårning is something else than Ingen — what the system
// setting "Använd batch- och serienummer" counts.
export function isTracked(tracking: ArticleTracking): boolean {
  return tracking !== "none";
}

// LAGERSPÅRAD = the article's inflows carry a batch row (a batch, or one
// serial number per styck) and its outflows are drawn per cell. The
// MECHANICS (cells, locks, the count's seeding, the pick list, the inflows'
// fields) ask this; rules about texts ask for the sort. A serienummerstyrd
// article whose numbers are created VID UTLEVERANS (beslut 16–17) is NOT
// lagerspårad: its stock is untracked like Okänd — inleverans and
// tillverkning give no numbers, draws and counts ask for none — and the
// number is given at the delivery.
export type StockTracking = "batch" | "serial";
export function stockTrackingOf(article: { tracking: ArticleTracking; serialAssignedAt: "receipt" | "delivery" }): StockTracking | null {
  if (article.tracking === "batch") return "batch";
  if (article.tracking === "serial" && article.serialAssignedAt === "receipt") return "serial";
  return null;
}

// `tracking` wins when both are sent. `batchTracked: true` means batch — also
// from serial: a client that only knows batch and switches it on explicitly.
// `batchTracked: false` means none ONLY when the article is batch now: a
// client that read `batchTracked: false` on a serienummerstyrd article and
// sends it back must not switch the serial numbers off.
export function resolveTracking(
  current: ArticleTracking,
  input: { tracking?: ArticleTracking | undefined; batchTracked?: boolean | undefined }
): ArticleTracking {
  if (input.tracking !== undefined) return input.tracking;
  if (input.batchTracked === true) return "batch";
  if (input.batchTracked === false) return current === "batch" ? "none" : current;
  return current;
}

// Whether the request says anything about the tracking at all.
export function mentionsTracking(input: { tracking?: unknown; batchTracked?: unknown }): boolean {
  return input.tracking !== undefined || input.batchTracked !== undefined;
}

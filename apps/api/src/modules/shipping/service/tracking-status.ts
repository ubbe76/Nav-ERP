import type { TrackingInterval } from "@navet/shared";

// Frakt etapp 2 — pure tracking helpers (no DB imports). The broker's status
// vocabulary is not fully documented (the sandbox only ever says ORDERED), so
// anything unknown is "in transit" rather than an error.
export type TrackingClass = "delivered" | "exception" | "in_transit";

const EXCEPTION_STATUSES = new Set(["EXCEPTION", "RETURNED", "LOST", "DEVIATION"]);

export function classifyTrackingStatus(status: string | null): TrackingClass {
  const s = (status ?? "").trim().toUpperCase();
  if (s === "DELIVERED") return "delivered";
  if (EXCEPTION_STATUSES.has(s)) return "exception";
  return "in_transit";
}

// Latest by instant; on a tie the event later in the broker's list wins.
export function latestEvent<T extends { occurredAt: string }>(events: T[]): T | null {
  let best: T | null = null;
  for (const e of events) {
    if (best === null || Date.parse(e.occurredAt) >= Date.parse(best.occurredAt)) best = e;
  }
  return best;
}

// Sendify's vocabulary is only partly documented: known statuses in Swedish,
// anything else humanised ("SOMETHING_NEW" -> "Something new") rather than
// hidden. The raw status is still what is stored and classified.
const STATUS_LABELS: Record<string, string> = {
  ORDERED: "Beställd",
  BOOKED: "Bokad",
  PICKED_UP: "Upphämtad",
  IN_TRANSIT: "Under transport",
  OUT_FOR_DELIVERY: "Ute för utkörning",
  READY_FOR_PICKUP: "Klar att hämta",
  DELIVERED: "Levererad",
  EXCEPTION: "Avvikelse",
  DEVIATION: "Avvikelse",
  RETURNED: "Returnerad",
  LOST: "Förlorad",
  CANCELLED: "Avbokad",
  CANCELED: "Avbokad",
};

export function trackingStatusLabel(status: string | null): string | null {
  const s = (status ?? "").trim();
  if (!s) return null;
  const known = STATUS_LABELS[s.toUpperCase()];
  if (known) return known;
  const words = s.replace(/[_-]+/g, " ").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function trackingText(e: { status: string | null; description: string | null; location: string | null }): string | null {
  const base = e.description?.trim() || trackingStatusLabel(e.status);
  if (base === null) return null;
  const text = e.location?.trim() ? `${base} (${e.location.trim()})` : base;
  return text.slice(0, 500);
}

export const TRACKING_INTERVAL_MS: Record<TrackingInterval, number> = {
  hourly: 60 * 60_000,
  every_4h: 4 * 60 * 60_000,
  daily: 24 * 60 * 60_000,
};

// The scheduler ticks every 5 minutes; the margin keeps an hourly run from
// slipping one tick per round.
const DUE_MARGIN_MS = 5 * 60_000;

export function isTrackingDue(lastRunAt: Date | null, interval: TrackingInterval, now: Date): boolean {
  if (lastRunAt === null) return true;
  return now.getTime() - lastRunAt.getTime() >= TRACKING_INTERVAL_MS[interval] - DUE_MARGIN_MS;
}

// A shipment never delivered is not polled forever.
export const TRACKING_MAX_AGE_DAYS = 60;
// A run holds the lease at most this long; an API that dies mid-run lets the
// next tick take over once it expires.
export const TRACKING_LEASE_MS = 15 * 60_000;

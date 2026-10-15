import type { AuditWriter } from "../../system/repository/audit.repository.js";
import type { ShippingRepository } from "../repository/shipping.repository.js";
import type { FreightSettingsService } from "./freight-settings.service.js";
import { InvalidShipmentStatusError, ShipmentNotFoundError } from "./shipping.errors.js";
import {
  classifyTrackingStatus,
  isTrackingDue,
  latestEvent,
  TRACKING_LEASE_MS,
  TRACKING_MAX_AGE_DAYS,
  trackingText,
} from "./tracking-status.js";

// Frakt etapp 2 — spårning. trackShipment is shared by "Uppdatera spårning"
// and the scheduler; no DB lock is held over the broker call. The scheduler
// itself lives in scheduler.ts and is started from server.ts only.
export function createTrackingService(deps: {
  repo: ShippingRepository;
  settings: FreightSettingsService;
  audit: AuditWriter;
  now?: () => Date;
  log?: (msg: string, extra?: unknown) => void;
}) {
  const { repo, settings, audit } = deps;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((msg: string, extra?: unknown) => console.error(msg, extra));

  // Booked (or delivered — the button may refresh) with a broker id. The
  // latest event by time decides status/text/exception; DELIVERED moves
  // booked → delivered with the event's time, conditionally (see applyTracking).
  async function trackShipment(id: string): Promise<{ delivered: boolean }> {
    const s = await repo.findShipment(id);
    if (!s) throw new ShipmentNotFoundError(id);
    if ((s.status !== "booked" && s.status !== "delivered") || !s.providerShipmentId) {
      throw new InvalidShipmentStatusError("Bara bokade försändelser kan spåras");
    }
    const provider = await settings.provider({ requireEnabled: false });
    // An event without a parsable time can neither be ordered nor stored
    // (occurred_at is a timestamp) — dropped here so every provider is safe,
    // not only the one that already filters.
    const events = (await provider.getTracking(s.providerShipmentId)).filter((e) => Number.isFinite(Date.parse(e.occurredAt)));
    const latest = latestEvent(events);
    const cls = latest ? classifyTrackingStatus(latest.status) : null;
    const result = await repo.applyTracking(
      id,
      events,
      {
        trackingStatus: latest ? latest.status : s.trackingStatus,
        lastTrackingText: latest ? trackingText(latest) : s.lastTrackingText,
        trackingException: cls === "exception" ? true : cls === null ? s.trackingException : false,
        trackingUrl: latest?.url ?? null,
        trackingCheckedAt: now(),
      },
      cls === "delivered" ? new Date(latest!.occurredAt) : null
    );
    if (result.delivered) {
      await audit.log({
        entityType: "shipment",
        entityId: id,
        action: "delivered",
        detail: { shipmentNumber: s.shipmentNumber, deliveredAt: latest!.occurredAt },
        userId: null,
      });
    }
    return result;
  }

  // Sequential, one try/catch per shipment: a broker error on one never
  // stops the others. Counts are for the log.
  async function runTracking(): Promise<{ checked: number; delivered: number; failed: number }> {
    const since = new Date(now().getTime() - TRACKING_MAX_AGE_DAYS * 24 * 60 * 60_000);
    const ids = await repo.listTrackableShipments(since);
    let delivered = 0;
    let failed = 0;
    for (const id of ids) {
      try {
        if ((await trackShipment(id)).delivered) delivered++;
      } catch (err) {
        failed++;
        log("Tracking failed for shipment", { id, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return { checked: ids.length, delivered, failed };
  }

  // The scheduler's entry point. The run stamp is written AFTER the run: an
  // API that dies mid-run lets the lease expire and the next tick runs again
  // — never a skipped run.
  async function runTrackingIfDue(): Promise<"disabled" | "not-due" | "busy" | { checked: number; delivered: number; failed: number }> {
    const freight = await settings.read();
    if (!freight.enabled) return "disabled";
    const at = now();
    if (!isTrackingDue(freight.lastTrackingRunAt, freight.trackingInterval, at)) return "not-due";
    const lease = await repo.claimTrackingLease(at, TRACKING_LEASE_MS);
    if (!lease) return "busy";
    try {
      const result = await runTracking();
      await repo.stampTrackingRun(at);
      return result;
    } finally {
      // Owner-checked: releases only the lease this run claimed.
      await repo.releaseTrackingLease(lease);
    }
  }

  return { trackShipment, runTracking, runTrackingIfDue };
}

export type TrackingService = ReturnType<typeof createTrackingService>;

// app.ts decorates the Fastify instance so server.ts can hand the service to
// the scheduler without rebuilding the dependency graph.
declare module "fastify" {
  interface FastifyInstance {
    freightTracking: TrackingService;
  }
}

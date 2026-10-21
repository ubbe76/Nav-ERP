import type { AuditWriter } from "../../system/repository/audit.repository.js";
import type { EinvoiceRepository, TransmissionRow } from "../repository/einvoice.repository.js";
import type { EinvoiceSettingsService } from "./einvoice-settings.service.js";
import { isLiveStatus, isTerminalStatus, mapProviderState, providerErrorText } from "./einvoice-status.js";
import { EinvoiceTransmissionNotFoundError } from "./einvoice.errors.js";

// Statusjobbet (spec §3.5), the tracking service's counterpart: polls the
// live transmissions at the access point. pollTransmission is shared by
// "Uppdatera status" on the invoice card and the scheduled run; the
// scheduler itself lives in scheduler.ts and is started from server.ts only.

// A `sending` row without a provider id this old is a send whose process
// died between the insert and the answer.
export const STALE_SENDING_MS = 10 * 60_000;
export const STALE_SENDING_MESSAGE = "Sändningen avbröts";
// A transmission never registered is not polled forever.
export const STATUS_MAX_AGE_DAYS = 30;
// A run holds the lease at most this long; an API that dies mid-run lets the
// next tick take over once it expires.
export const STATUS_LEASE_MS = 15 * 60_000;

// The scheduler ticks every 5 minutes; a margin keeps a run from slipping
// one tick per round. Capped at half the interval so a 5-minute interval
// still waits.
export function isStatusDue(lastRunAt: Date | null, intervalMinutes: number, now: Date): boolean {
  if (lastRunAt === null) return true;
  const intervalMs = intervalMinutes * 60_000;
  const margin = Math.min(2.5 * 60_000, intervalMs / 2);
  return now.getTime() - lastRunAt.getTime() >= intervalMs - margin;
}

export function createEinvoiceStatusService(deps: {
  repo: EinvoiceRepository;
  settings: EinvoiceSettingsService;
  audit: AuditWriter;
  now?: () => Date;
  log?: (msg: string, extra?: unknown) => void;
}) {
  const { repo, settings, audit } = deps;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((msg: string, extra?: unknown) => console.error(msg, extra));

  async function logFailure(row: { id: string; invoiceId: string; providerState?: string | null }, reason: string | null, status: string) {
    await audit.log({
      entityType: "invoice",
      entityId: row.invoiceId,
      action: "einvoice_failed",
      detail: { transmissionId: row.id, status, providerState: row.providerState ?? null, reason },
      userId: null,
    });
  }

  // One poll: GET the access point's state, map it, store it. A terminal
  // row or one without a provider id is returned as it is — nothing to ask.
  async function pollTransmission(id: string): Promise<TransmissionRow> {
    const row = await repo.findTransmission(id);
    if (!row) throw new EinvoiceTransmissionNotFoundError(id);
    if (!row.providerInvoiceId || isTerminalStatus(row.status)) return row;
    const provider = await settings.provider({ requireEnabled: false });
    const at = now();
    const remote = await provider.getStatus(row.providerInvoiceId);
    const status = mapProviderState(remote.state);
    const changed = status !== row.status || remote.state !== row.providerState;
    const errorMessage =
      status === "rejected" || status === "failed"
        ? (providerErrorText(remote.errorMessage) ?? row.errorMessage ?? (status === "rejected" ? "Mottagaren avvisade fakturan" : "Sändningen misslyckades"))
        : row.errorMessage;
    await repo.updateTransmission(id, {
      status,
      providerState: remote.state.slice(0, 40),
      errorMessage,
      lastPolledAt: at,
      ...(changed ? { statusUpdatedAt: at } : {}),
      // sentAt: the first time the access point reports it past "sending".
      ...(row.sentAt === null && isLiveStatus(status) && status !== "sending" ? { sentAt: at } : {}),
    });
    if ((status === "rejected" || status === "failed") && status !== row.status) {
      await logFailure({ id, invoiceId: row.invoiceId, providerState: remote.state }, errorMessage, status);
    }
    return (await repo.findTransmission(id))!;
  }

  // Sequential, one try/catch per row: an access-point error on one never
  // stops the others. Counts are for the log.
  async function runStatus(): Promise<{ checked: number; changed: number; failed: number; stale: number }> {
    const at = now();
    const stale = await repo.failStaleSending(new Date(at.getTime() - STALE_SENDING_MS), STALE_SENDING_MESSAGE, at);
    for (const row of stale) await logFailure(row, STALE_SENDING_MESSAGE, "failed");
    const since = new Date(at.getTime() - STATUS_MAX_AGE_DAYS * 24 * 60 * 60_000);
    const ids = await repo.listPollable(since);
    let changed = 0;
    let failed = 0;
    for (const id of ids) {
      try {
        const before = await repo.findTransmission(id);
        const after = await pollTransmission(id);
        if (before && before.status !== after.status) changed++;
      } catch (err) {
        failed++;
        log("E-invoice status poll failed", { id, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return { checked: ids.length, changed, failed, stale: stale.length };
  }

  // The scheduler's entry point. The run stamp is written AFTER the run: an
  // API that dies mid-run lets the lease expire and the next tick runs again.
  async function runStatusIfDue(): Promise<"disabled" | "not-due" | "busy" | Awaited<ReturnType<typeof runStatus>>> {
    const s = await settings.read();
    if (!s.enabled || !s.apiKey) return "disabled";
    const at = now();
    if (!isStatusDue(s.lastStatusRunAt, s.statusIntervalMinutes, at)) return "not-due";
    const lease = await repo.claimStatusLease(at, STATUS_LEASE_MS);
    if (!lease) return "busy";
    try {
      const result = await runStatus();
      await repo.stampStatusRun(at);
      return result;
    } finally {
      // Owner-checked: releases only the lease this run claimed.
      await repo.releaseStatusLease(lease);
    }
  }

  return { pollTransmission, runStatus, runStatusIfDue };
}

export type EinvoiceStatusService = ReturnType<typeof createEinvoiceStatusService>;

// app.ts decorates the Fastify instance so server.ts can hand the service to
// the scheduler without rebuilding the dependency graph.
declare module "fastify" {
  interface FastifyInstance {
    einvoiceStatus: EinvoiceStatusService;
  }
}

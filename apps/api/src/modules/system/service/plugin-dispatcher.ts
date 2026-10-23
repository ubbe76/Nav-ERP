import { effectivePermissions, PLUGIN_TEST_EVENT_TYPE, pluginEventDef } from "@navet/shared";
import type { ClaimedDelivery, PluginsRepository } from "../repository/plugins.repository.js";
import { pluginEvents } from "./plugin-events.js";
import {
  buildWebhookBody,
  CLAIM_MS,
  failureText,
  MISSING_PERMISSION_ERROR,
  nextAttemptDelay,
  NO_WEBHOOK_ERROR,
  RETENTION_DAYS,
  signWebhook,
  WEBHOOK_TIMEOUT_MS,
  webhookUrl,
} from "./plugin-webhook.js";

// Tillägg — the webhook dispatcher (job plugin_webhooks). Started from
// server.ts only, on its own 15-second scheduler, never from buildApp; the
// tests drive run()/deliverNow() by hand with a fake fetch and clock.
//
// A run claims a few due deliveries at a time (a conditional UPDATE with
// FOR UPDATE SKIP LOCKED, the claim being the run's lease on each row),
// sends them side by side and writes each outcome owner-checked on the
// claim. No transaction is ever held over HTTP. One run at a time per
// process (run() is single-flight); across processes the claims keep two
// runs from sending the same delivery.

export type WebhookFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface AttemptResult {
  deliveryId: string;
  delivered: boolean;
  statusCode: number | null;
  error: string | null;
  // false when another run had taken the delivery over (nothing written).
  recorded: boolean;
}

const BATCH_SIZE = 5;
const MAX_BATCHES_PER_RUN = 40;
const CLEANUP_EVERY_MS = 60 * 60_000;

export function createPluginDispatcher(deps: {
  repo: PluginsRepository;
  fetch?: WebhookFetch;
  now?: () => Date;
  log?: (msg: string, extra?: unknown) => void;
}) {
  const { repo } = deps;
  const fetchFn: WebhookFetch = deps.fetch ?? ((url, init) => fetch(url, init));
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((msg: string, extra?: unknown) => console.error(msg, extra));
  let running: Promise<{ attempted: number }> | null = null;
  let lastCleanupAt = 0;

  // One HTTP attempt. Never throws: a transport error becomes a short text.
  async function send(d: ClaimedDelivery, path: string, at: Date): Promise<{ ok: boolean; statusCode: number | null; error: string | null }> {
    const body = buildWebhookBody({
      eventId: d.eventId,
      type: d.eventType,
      occurredAt: d.occurredAt,
      pluginKey: d.pluginKey,
      entityId: d.entityId,
      entityNumber: d.entityNumber,
      data: d.data,
    });
    try {
      const res = await fetchFn(webhookUrl(d.baseUrl, path), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Nav-Event-Id": d.eventId,
          "Nav-Event-Type": d.eventType,
          "Nav-Signature": signWebhook(d.webhookSecret, body, at),
        },
        body,
        // A redirect is an answer, never followed (it could point anywhere).
        redirect: "manual",
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      });
      // The body is never read — only the status counts.
      await res.body?.cancel().catch(() => {});
      if (res.status >= 200 && res.status < 300) return { ok: true, statusCode: res.status, error: null };
      const kind = res.status >= 300 && res.status < 400 ? "redirect" : "status";
      return { ok: false, statusCode: res.status, error: failureText({ statusCode: res.status, kind }) };
    } catch (err) {
      const name = err instanceof Error ? err.name : "";
      const kind = name === "TimeoutError" || name === "AbortError" ? "timeout" : "network";
      return { ok: false, statusCode: null, error: failureText({ statusCode: null, kind }) };
    }
  }

  async function attempt(d: ClaimedDelivery): Promise<AttemptResult> {
    const at = now();
    const isTest = d.eventType === PLUGIN_TEST_EVENT_TYPE;
    const refuse = async (error: string): Promise<AttemptResult> => {
      const recorded = await repo.recordAttempt(d.id, d.claimedUntil, { status: "failed", at, statusCode: null, error, countsAsAttempt: false });
      return { deliveryId: d.id, delivered: false, statusCode: null, error, recorded };
    };
    // The permission is checked at delivery, so a changed group applies at once.
    if (!isTest) {
      const def = pluginEventDef(d.eventType);
      if (!def || !effectivePermissions("user", d.groupPermissions).includes(def.permission)) return refuse(MISSING_PERMISSION_ERROR);
    }
    const webhook = d.manifest.webhook;
    if (!webhook || (!isTest && !(webhook.events as string[]).includes(d.eventType))) return refuse(NO_WEBHOOK_ERROR);

    const result = await send(d, webhook.path, at);
    if (result.ok) {
      const recorded = await repo.recordAttempt(d.id, d.claimedUntil, { status: "delivered", at, statusCode: result.statusCode! });
      return { deliveryId: d.id, delivered: true, statusCode: result.statusCode, error: null, recorded };
    }
    const attempts = d.attempts + 1;
    // A test event is answered once, never retried.
    const delay = isTest ? null : nextAttemptDelay(attempts);
    const recorded =
      delay === null
        ? await repo.recordAttempt(d.id, d.claimedUntil, { status: "failed", at, statusCode: result.statusCode, error: result.error!, countsAsAttempt: true })
        : await repo.recordAttempt(d.id, d.claimedUntil, {
            status: "pending",
            at,
            nextAttemptAt: new Date(at.getTime() + delay),
            statusCode: result.statusCode,
            error: result.error!,
          });
    return { deliveryId: d.id, delivered: false, statusCode: result.statusCode, error: result.error, recorded };
  }

  async function runBatches(): Promise<{ attempted: number }> {
    let attempted = 0;
    for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch++) {
      const at = now();
      const claimed = await repo.claimDue(at, new Date(at.getTime() + CLAIM_MS), BATCH_SIZE);
      if (claimed.length === 0) break;
      const rows = await repo.loadClaimed(claimed.map((c) => c.id));
      const results = await Promise.all(
        rows.map((d) =>
          attempt(d).catch((err) => {
            log("Plugin webhook delivery failed", { deliveryId: d.id, error: err instanceof Error ? err.message : String(err) });
            return null;
          })
        )
      );
      attempted += results.length;
      if (claimed.length < BATCH_SIZE) break;
    }
    const at = now();
    if (at.getTime() - lastCleanupAt >= CLEANUP_EVERY_MS) {
      lastCleanupAt = at.getTime();
      await repo.cleanup(new Date(at.getTime() - RETENTION_DAYS * 86_400_000));
    }
    return { attempted };
  }

  // Single-flight: a run that is going answers every caller (the 15-second
  // tick and the kicks after emits).
  function run(): Promise<{ attempted: number }> {
    if (!running) {
      running = runBatches().finally(() => {
        running = null;
      });
    }
    return running;
  }

  return {
    run,

    // Sends one delivery the caller has already claimed (Skicka testhändelse)
    // and answers with the outcome.
    async deliverNow(deliveryId: string): Promise<AttemptResult> {
      const [row] = await repo.loadClaimed([deliveryId]);
      if (!row) throw new Error(`Delivery ${deliveryId} vanished`);
      return attempt(row);
    },

    // The real server only: emits nudge a run shortly after their commit.
    enableKick() {
      pluginEvents.setKickHandler(() => {
        run().catch((err) => log("Plugin webhook run failed", { error: err instanceof Error ? err.message : String(err) }));
      });
    },

    disableKick() {
      pluginEvents.setKickHandler(null);
    },

    // Waits for a run in progress (server shutdown).
    async idle() {
      await running?.catch(() => {});
    },
  };
}

export type PluginDispatcher = ReturnType<typeof createPluginDispatcher>;

declare module "fastify" {
  interface FastifyInstance {
    pluginDispatcher: PluginDispatcher;
  }
}

import { createHmac, timingSafeEqual } from "node:crypto";
import type { EinvoiceRepository } from "../repository/einvoice.repository.js";
import { EInvoiceProviderError } from "./einvoice-provider.js";
import type { EinvoiceSettingsService } from "./einvoice-settings.service.js";
import type { EinvoiceStatusService } from "./einvoice-status.service.js";

// Statusbesked direkt (spec 2026-11-05-e-faktura-utland-automatik): the
// receiver behind the public POST /einvoice/webhook. B2Brouter signs each
// delivery with the hook's secret; a valid one only TELLS Nav that a
// transmission changed — the state is then read from the API by the same
// pollTransmission as Uppdatera status and the status job, never taken from
// the body. A replayed, duplicated or out-of-order delivery therefore does no
// harm, and the status job stays the reserve for deliveries that never come.

export const ISSUED_INVOICE_STATE_CHANGE = "issued_invoice.state_change";

// X-B2Brouter-Signature: "t=<unix seconds>,s=<hex HMAC-SHA256>" over
// "<t>.<raw body>" with the hook's signing secret (B2Brouter webhooks guide).
// Constant-time comparison; anything malformed is simply invalid. The
// timestamp's age is deliberately not checked: B2Brouter retries for a week
// and a replay can only trigger a harmless re-read.
export function verifyWebhookSignature(header: string | undefined, rawBody: Buffer, secret: string): boolean {
  if (!header || !secret) return false;
  const parts = new Map(
    header.split(",").map((part) => {
      const i = part.indexOf("=");
      return [part.slice(0, i).trim(), part.slice(i + 1).trim()] as const;
    })
  );
  const t = parts.get("t");
  const signature = parts.get("s");
  if (!t || !/^\d+$/.test(t) || !signature || !/^[0-9a-f]+$/i.test(signature)) return false;
  const expected = createHmac("sha256", secret).update(`${t}.`).update(rawBody).digest();
  const given = Buffer.from(signature, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

// 204 handled (or nothing to do), 400 a signed body that is not JSON, 401
// bad signature, 404 no hook registered here, 503 the access point could not
// be read — B2Brouter retries 5xx, every other 4xx is final for it.
export type WebhookAnswer = 204 | 400 | 401 | 404 | 503;

export function createEinvoiceWebhookService(deps: {
  repo: EinvoiceRepository;
  settings: EinvoiceSettingsService;
  status: Pick<EinvoiceStatusService, "pollTransmission">;
  now?: () => Date;
  log?: (msg: string, extra?: unknown) => void;
}) {
  const { repo, settings, status } = deps;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((msg: string, extra?: unknown) => console.error(msg, extra));

  return {
    async receive(rawBody: Buffer, signatureHeader: string | undefined): Promise<WebhookAnswer> {
      const s = await settings.read();
      if (!s.webhook.secret) return 404;
      if (!verifyWebhookSignature(signatureHeader, rawBody, s.webhook.secret)) return 401;
      await settings.recordWebhookReceived(now());

      let body: { code?: unknown; data?: { invoice_id?: unknown } | null } | null;
      try {
        body = JSON.parse(rawBody.toString("utf8"));
      } catch {
        return 400;
      }
      if (body?.code !== ISSUED_INVOICE_STATE_CHANGE) return 204;
      const raw = body.data?.invoice_id;
      const providerInvoiceId = typeof raw === "number" && Number.isFinite(raw) ? String(raw) : typeof raw === "string" ? raw.trim() : "";
      if (providerInvoiceId === "") return 204;
      // The key now saved belongs to one environment; a hook registered for
      // the other cannot be read back with it — the status job is left.
      if (s.webhook.environment !== s.environment) return 204;
      const transmissionId = await repo.findTransmissionIdByProvider(s.environment, providerInvoiceId);
      if (!transmissionId) return 204;
      try {
        await status.pollTransmission(transmissionId);
      } catch (err) {
        if (err instanceof EInvoiceProviderError && err.kind === "unavailable") return 503;
        log("E-invoice webhook could not refresh the transmission", {
          transmissionId,
          error: err instanceof Error ? err.name : String(err),
        });
      }
      return 204;
    },
  };
}

export type EinvoiceWebhookService = ReturnType<typeof createEinvoiceWebhookService>;

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { PLUGIN_API_KEY_PREFIX, type PluginWebhookBody } from "@navet/shared";

// Tillägg — the pure parts of a webhook delivery: the body, the signature
// (Stripe's pattern: HMAC-SHA256 over "<t>.<body>"), the retry schedule and
// the short error texts. No I/O, so the rules are tested without a server.

// After failed attempt n (1-based) the next one waits RETRY_DELAYS_MS[n-1];
// the 7th failure is final.
export const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 6 * 3_600_000, 12 * 3_600_000] as const;
export const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;
export const WEBHOOK_TIMEOUT_MS = 10_000;
// A claimed delivery is the dispatcher's for this long (several 10-second
// requests run side by side within it).
export const CLAIM_MS = 60_000;
// Delivered events older than this are cleaned up.
export const RETENTION_DAYS = 30;

export const MISSING_PERMISSION_ERROR = "Saknar rättighet";
export const NO_WEBHOOK_ERROR = "Tillägget tar inte emot händelsen";
// The refusals: failed without being sent, because of the plugin's own
// group or manifest — never a sign that the plugin doesn't answer, so they
// don't raise the alert Tillägg som inte tar emot händelser.
export const PLUGIN_REFUSAL_ERRORS: readonly string[] = [MISSING_PERMISSION_ERROR, NO_WEBHOOK_ERROR];

// The delay before the next attempt after `attempts` failed ones, or null
// when the delivery has failed for good.
export function nextAttemptDelay(attempts: number): number | null {
  if (attempts >= MAX_ATTEMPTS) return null;
  return RETRY_DELAYS_MS[attempts - 1] ?? null;
}

export function buildWebhookBody(input: {
  eventId: string;
  type: string;
  occurredAt: Date;
  pluginKey: string;
  entityId: string;
  entityNumber: string | null;
  data: Record<string, string | null> | null;
}): string {
  const body: PluginWebhookBody = {
    id: input.eventId,
    type: input.type,
    occurredAt: input.occurredAt.toISOString(),
    plugin: input.pluginKey,
    // id/number last so a stray reference key can never override them.
    data: { ...(input.data ?? {}), id: input.entityId, number: input.entityNumber },
  };
  return JSON.stringify(body);
}

export function signWebhook(secret: string, body: string, at: Date): string {
  const t = Math.floor(at.getTime() / 1000);
  const v1 = createHmac("sha256", secret).update(`${t}.${body}`, "utf8").digest("hex");
  return `t=${t},v1=${v1}`;
}

// The key the context token (POST /plugins/:id/context) is signed with —
// derived from the webhook secret so the two never share a key: a webhook
// signature can never pass as a context token or the other way round.
//
// Exactly: HMAC-SHA256 with the webhook secret as the key (its 64-character
// hex text taken as UTF-8 bytes, as for the webhook signature) over the
// UTF-8 message "nav-context", written as LOWERCASE HEX — and that
// 64-character hex text, as UTF-8 bytes, is the HS256 key. In Node:
//   const key = createHmac("sha256", secret).update("nav-context").digest("hex");
//   jwt.verify(token, key, { algorithms: ["HS256"], audience: "<plugin key>" });
// The webhook signature itself keeps using the secret directly.
export const PLUGIN_CONTEXT_KEY_LABEL = "nav-context";

export function pluginContextKey(webhookSecret: string): string {
  return createHmac("sha256", webhookSecret).update(PLUGIN_CONTEXT_KEY_LABEL, "utf8").digest("hex");
}

// What a plugin does with the header (documented for plugin authors and
// used by the tests): parse, recompute, compare in constant time, and refuse
// a timestamp older than toleranceSeconds.
export function verifyWebhookSignature(
  secret: string,
  body: string,
  header: string,
  now: Date,
  toleranceSeconds = 300
): boolean {
  const parts = Object.fromEntries(header.split(",").map((part) => part.split("=", 2) as [string, string]));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || !parts.v1) return false;
  if (Math.abs(now.getTime() / 1000 - t) > toleranceSeconds) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${body}`, "utf8").digest("hex");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(parts.v1, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

// The delivery URL: the plugin's base URL and the manifest's relative path.
export function webhookUrl(baseUrl: string, path: string): string {
  return `${baseUrl}${path}`;
}

// A short, safe description of a failed attempt — never the response body
// and never a transport error's own message (it can carry internal
// addresses).
export function failureText(outcome: { statusCode: number | null; kind: "status" | "timeout" | "network" | "redirect" }): string {
  switch (outcome.kind) {
    case "timeout":
      return "Tidsgränsen (10 s) överskreds";
    case "network":
      return "Kunde inte ansluta till tillägget";
    case "redirect":
      return `Omdirigering (${outcome.statusCode}) följs inte`;
    case "status":
      return `Svarade ${outcome.statusCode}`;
  }
}

// --- Secrets ---------------------------------------------------------------------

const ALPHANUMERIC = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function randomAlphanumeric(length: number): string {
  let out = "";
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      // 248 = 4 × 62: rejection sampling keeps the alphabet uniform.
      if (byte < 248 && out.length < length) out += ALPHANUMERIC[byte % 62];
    }
  }
  return out;
}

// nav_plg_<key>_<32 random characters>
export function newPluginApiKey(pluginKey: string): string {
  return `${PLUGIN_API_KEY_PREFIX}${pluginKey}_${randomAlphanumeric(32)}`;
}

// 32 random bytes as hex.
export function newWebhookSecret(): string {
  return randomBytes(32).toString("hex");
}

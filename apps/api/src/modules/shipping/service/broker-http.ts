import { FreightProviderError } from "./freight-provider.js";

// The JSON-over-HTTP call nShift and Shipmondo share (Sendify keeps its own,
// older copy in sendify-provider.ts). The same error kinds as Sendify's:
// 401/403 → unauthorized, network/429/5xx → unavailable, and on the BOOK
// call itself anything but a readable answer → booking-unknown, never
// "unexpected" (which reads as "nothing happened"). Credentials travel in
// the Authorization header only and are never logged.

export const BROKER_TIMEOUT_MS = 30_000;

export interface BrokerMessages {
  unauthorized: string;
  unavailable: string;
  bookingUnknown: string;
  unexpected: string;
}

export interface BrokerHttpDeps {
  fetch?: typeof fetch;
  log?: (entry: { broker: string; method: string; path: string; status: number; body: string }) => void;
}

export function transportSummary(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

export function basicAuth(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`, "utf8").toString("base64")}`;
}

// Drops null/undefined/""/[]/{} recursively — brokers validate fields that
// are present but empty.
export function stripEmpty(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripEmpty);
  if (value !== null && typeof value === "object" && !(value instanceof Buffer)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const cleaned = stripEmpty(v);
      const empty =
        cleaned === null ||
        cleaned === undefined ||
        cleaned === "" ||
        (Array.isArray(cleaned) && cleaned.length === 0) ||
        (typeof cleaned === "object" && !Array.isArray(cleaned) && Object.keys(cleaned as object).length === 0);
      if (!empty) out[k] = cleaned;
    }
    return out;
  }
  return value;
}

export const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : typeof v === "number" ? String(v) : null);
export const num = (v: unknown) => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};

export function createBrokerHttp(opts: {
  broker: string;
  baseUrl: string;
  authorization: string;
  messages: BrokerMessages;
  // A refused call (4xx other than 401/403) as the broker words it.
  refused: (text: string, status: number) => FreightProviderError;
  deps?: BrokerHttpDeps;
}) {
  const doFetch = opts.deps?.fetch ?? fetch;
  const log = opts.deps?.log ?? ((entry) => console.warn(`${opts.broker} request failed`, entry));
  const { messages } = opts;

  async function call(method: string, path: string, body?: unknown, booking = false): Promise<unknown> {
    let res: Response;
    try {
      res = await doFetch(opts.baseUrl + path, {
        method,
        headers: {
          Authorization: opts.authorization,
          Accept: "application/json",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(BROKER_TIMEOUT_MS),
      });
    } catch (err) {
      log({ broker: opts.broker, method, path, status: 0, body: transportSummary(err) });
      throw booking
        ? new FreightProviderError(messages.bookingUnknown, "booking-unknown")
        : new FreightProviderError(messages.unavailable, "unavailable");
    }
    if (res.status >= 400) {
      const text = await res.text().catch(() => "");
      log({ broker: opts.broker, method, path, status: res.status, body: text.slice(0, 2000) });
      if (res.status === 401 || res.status === 403) throw new FreightProviderError(messages.unauthorized, "unauthorized");
      if (res.status >= 500 && booking) throw new FreightProviderError(messages.bookingUnknown, "booking-unknown");
      if (res.status === 429 || res.status >= 500) throw new FreightProviderError(messages.unavailable, "unavailable");
      throw opts.refused(text, res.status);
    }
    const unreadableBooking = (detail: string) => {
      log({ broker: opts.broker, method, path, status: res.status, body: detail });
      return new FreightProviderError(messages.bookingUnknown, "booking-unknown");
    };
    let text: string;
    try {
      text = await res.text();
    } catch (err) {
      if (booking) throw unreadableBooking(`unreadable body: ${transportSummary(err)}`);
      text = "";
    }
    if (res.status === 204 || text === "") {
      if (booking) throw unreadableBooking("empty body");
      return null;
    }
    try {
      return JSON.parse(text);
    } catch {
      if (booking) throw unreadableBooking(text.slice(0, 2000));
      throw new FreightProviderError(messages.unexpected, "unexpected");
    }
  }

  return { call };
}

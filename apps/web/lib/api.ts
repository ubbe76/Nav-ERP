import type { Permission } from "./permissions";

// Empty by default: browser calls go to the page's own origin and are
// proxied to the API by the rewrite in next.config.js. Only set
// NEXT_PUBLIC_API_URL when the API is exposed on a separate public host.
export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "";

// Server-side fetches (Server Components) run *inside* the web container,
// not in the browser — they should talk to the api container over Docker's
// internal network, not the public NEXT_PUBLIC_API_URL. A container usually
// can't reach its own host's public IP/domain the way a browser can, which
// otherwise surfaces as a mysterious "fetch failed" on every page. Falls
// back to API_URL when unset (local dev: both are the same localhost).
const SERVER_API_URL = process.env.INTERNAL_API_URL ?? API_URL;

// Must match SESSION_COOKIE in apps/api/src/modules/auth/middleware/auth.middleware.ts
export const SESSION_COOKIE = "session";

// Thrown by every API call that fails — carries the HTTP status, the
// machine-readable `code` the API derives from the error class name (see
// apps/api/src/modules/system/service/error-body.ts), and the raw parsed
// body (e.g. UnattestedEmployeesError's extra `names` array) for callers
// that need more than the message. `message` stays the API's English
// `error` text so existing `err.message` fallbacks are unaffected.
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly body?: unknown
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: "admin" | "supervisor" | "user";
  permissions: Permission[];
  // Endast läsning: the API refuses every change (403 read-only-account).
  readOnly: boolean;
}

// Server Components / middleware don't auto-forward the incoming request's
// cookies to a separate-origin fetch, so it's passed through explicitly.
export async function getCurrentUser(cookieHeader: string | undefined): Promise<SessionUser | null> {
  if (!cookieHeader) return null;

  const res = await fetch(`${SERVER_API_URL}/api/v1/auth/me`, {
    headers: { cookie: cookieHeader },
    cache: "no-store",
  });
  if (!res.ok) return null;
  return res.json();
}

export async function login(email: string, password: string): Promise<SessionUser> {
  const res = await fetch(`${API_URL}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(body.error ?? "Inloggningen misslyckades", res.status, body.code, body);
  }
  return res.json();
}

// Bootstrap-only: the API refuses this once any user already exists.
export async function register(
  email: string,
  password: string,
  name: string,
  setupCode: string
): Promise<SessionUser> {
  const res = await fetch(`${API_URL}/api/v1/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ email, password, name, setupCode }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(body.error ?? "Registreringen misslyckades", res.status, body.code, body);
  }
  return res.json();
}

export async function logout(): Promise<void> {
  await fetch(`${API_URL}/api/v1/auth/logout`, {
    method: "POST",
    credentials: "include",
  });
}

async function parseOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(body.error ?? `Request failed (${res.status})`, res.status, body.code, body);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

// Client-side calls (form submissions, mutations) — the session cookie is
// sent automatically by the browser.
export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    credentials: "include",
    // Only set Content-Type when there's actually a body — Fastify rejects
    // "Content-Type: application/json" paired with an empty body (as sent by
    // body-less action calls like confirm/cancel/close) with a 500.
    headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}), ...init?.headers },
  });
  return parseOrThrow<T>(res);
}

// Server Components — the incoming request's cookies aren't auto-forwarded
// to a separate-origin fetch, so the cookie header is passed through explicitly
// (same reasoning as getCurrentUser above).
export async function apiGet<T>(path: string, cookieHeader: string | undefined): Promise<T> {
  const res = await fetch(`${SERVER_API_URL}${path}`, {
    headers: cookieHeader ? { cookie: cookieHeader } : {},
    cache: "no-store",
  });
  return parseOrThrow<T>(res);
}

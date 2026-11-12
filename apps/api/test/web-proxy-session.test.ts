import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "../../web/proxy.js";

// Auth-granskningen 2026-11-10 (A1): a session cookie the API no longer
// accepts (account deactivated or removed, new password, JWT_SECRET
// replaced) bounced /login → / → AppShell's redirect("/login") → … until
// the browser gave up. Only a valid session leaves /login now; a dead one
// opens the page and is cleared.

function request(path: string, cookie?: string) {
  return new NextRequest(new URL(path, "http://nav.test"), { headers: cookie ? { cookie } : {} });
}

function stubMe(response: Response | Error) {
  const fetchMock = vi.fn(async () => {
    if (response instanceof Error) throw response;
    return response.clone();
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const user = { id: "u1", email: "a@x.se", name: "A", role: "admin", permissions: [], readOnly: false };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("proxy: the session cookie on /login", () => {
  it("opens /login and clears a cookie the API refuses", async () => {
    stubMe(new Response("{}", { status: 401 }));
    const res = await proxy(request("/login", "session=dead"));
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("set-cookie")).toMatch(/^session=;.*Expires=Thu, 01 Jan 1970/i);
  });

  it("sends a valid session on to /", async () => {
    stubMe(new Response(JSON.stringify(user), { status: 200, headers: { "content-type": "application/json" } }));
    const res = await proxy(request("/login", "session=ok"));
    expect(new URL(res.headers.get("location")!).pathname).toBe("/");
  });

  it("opens /login without touching the cookie when the API cannot be reached", async () => {
    stubMe(new TypeError("fetch failed"));
    const res = await proxy(request("/login", "session=maybe"));
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("keeps the cookie when the API answers 5xx (a hiccup never logs anyone out)", async () => {
    stubMe(new Response("{}", { status: 503 }));
    const res = await proxy(request("/login", "session=ok-but-api-busy"));
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("a page without a cookie still goes to /login", async () => {
    const fetchMock = stubMe(new Response("{}", { status: 401 }));
    const res = await proxy(request("/kunder"));
    expect(new URL(res.headers.get("location")!).pathname).toBe("/login");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// Webbgranskningen 2026-11-12: a page with a cookie the API refuses rendered
// Next's error page — the page fetched its data (apiGet → 401) before AppShell
// could redirect. The proxy sends it to /login and clears the cookie.
describe("proxy: the session cookie on a page", () => {
  it("sends a cookie the API refuses to /login and clears it", async () => {
    stubMe(new Response("{}", { status: 401 }));
    const res = await proxy(request("/kunder", "session=dead"));
    expect(new URL(res.headers.get("location")!).pathname).toBe("/login");
    expect(res.headers.get("set-cookie")).toMatch(/^session=;.*Expires=Thu, 01 Jan 1970/i);
  });

  it("lets the page render when the API is down or busy", async () => {
    stubMe(new Response("{}", { status: 503 }));
    const busy = await proxy(request("/kunder", "session=ok"));
    expect(busy.headers.get("location")).toBeNull();
    expect(busy.headers.get("set-cookie")).toBeNull();
    stubMe(new TypeError("fetch failed"));
    const down = await proxy(request("/kunder", "session=ok"));
    expect(down.headers.get("location")).toBeNull();
  });

  it("lets a valid session through to a page it may open", async () => {
    stubMe(new Response(JSON.stringify(user), { status: 200, headers: { "content-type": "application/json" } }));
    const res = await proxy(request("/kunder", "session=ok"));
    expect(res.headers.get("location")).toBeNull();
  });
});

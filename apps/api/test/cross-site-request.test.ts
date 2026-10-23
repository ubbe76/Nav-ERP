import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@navet/db";
import { buildApp } from "../src/app.js";
import { crossSiteBlocks } from "../src/modules/auth/middleware/auth.middleware.js";

// The cross-site guard: a request authenticated with the session cookie that
// would change something (any method but GET/HEAD/OPTIONS) is refused with
// 403 cross-site-request when the browser says it comes from another site or
// another host of the same site (Sec-Fetch-Site same-site/cross-site) — a
// plugin on a sibling subdomain, or any other page. Nav's own web is
// same-origin (it proxies /api/v1), and requests without the header (server
// to server, old clients, these tests elsewhere) pass. Login, register and
// logout carry the same guard (login CSRF).

const TRUNCATE = sql`TRUNCATE audit_log, user_settings, users CASCADE`;
const PASSWORD = "ett-tillräckligt-långt-lösenord";
const WEB_ORIGIN = process.env.WEB_ORIGIN ?? "http://localhost:3000";

let app: ReturnType<typeof buildApp>;
let admin: string;

const cookieOf = (res: { cookies: { name: string; value: string }[] }) => res.cookies.map((c) => `${c.name}=${c.value}`).join("; ");

const call = (method: string, url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers, ...(payload === undefined ? {} : { payload: payload as never }) });

beforeAll(async () => {
  app = buildApp();
  await app.ready();
});

beforeEach(async () => {
  await db.execute(TRUNCATE);
  await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: { email: "admin@example.com", password: PASSWORD, name: "Admin", setupCode: app.setup.code.code },
  });
  admin = cookieOf(await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "admin@example.com", password: PASSWORD } }));
});

afterAll(async () => {
  await app.close();
  await db.execute(TRUNCATE);
});

describe("crossSiteBlocks", () => {
  const req = (method: string, headers: Record<string, string>) => ({ method, headers }) as never;

  it("blocks unsafe methods marked same-site or cross-site, unless they come from the web's own origin", () => {
    for (const site of ["same-site", "cross-site", "Cross-Site"]) {
      expect(crossSiteBlocks(req("POST", { "sec-fetch-site": site }))).toBe(true);
      expect(crossSiteBlocks(req("DELETE", { "sec-fetch-site": site, origin: "https://tillagg.example.se" }))).toBe(true);
      expect(crossSiteBlocks(req("PATCH", { "sec-fetch-site": site, origin: WEB_ORIGIN }))).toBe(false);
    }
  });

  it("lets reads, same-origin requests, direct navigations and requests without the header through", () => {
    expect(crossSiteBlocks(req("GET", { "sec-fetch-site": "cross-site" }))).toBe(false);
    expect(crossSiteBlocks(req("HEAD", { "sec-fetch-site": "same-site" }))).toBe(false);
    expect(crossSiteBlocks(req("OPTIONS", { "sec-fetch-site": "cross-site" }))).toBe(false);
    expect(crossSiteBlocks(req("POST", { "sec-fetch-site": "same-origin" }))).toBe(false);
    expect(crossSiteBlocks(req("POST", { "sec-fetch-site": "none" }))).toBe(false);
    expect(crossSiteBlocks(req("POST", {}))).toBe(false);
  });
});

describe("the cross-site guard on the real app", () => {
  it("refuses a cookie-authenticated write from another site (403 cross-site-request) and writes nothing", async () => {
    for (const site of ["same-site", "cross-site"]) {
      const res = await call("PATCH", "/me/settings", { cookie: admin, "sec-fetch-site": site, origin: "http://tillagg.example.se" }, { listPageSize: 250 });
      expect({ site, status: res.statusCode, code: res.json().code }).toEqual({ site, status: 403, code: "cross-site-request" });
    }
    expect((await call("GET", "/me/settings", { cookie: admin })).json().listPageSize).toBe(50);
    // A module route (protected scope) and the configurator scope's requireAuthOrClient.
    const group = await call("POST", "/permission-groups", { cookie: admin, "sec-fetch-site": "same-site" }, { code: "XS1", name: "X", permissions: [] });
    expect([group.statusCode, group.json().code]).toEqual([403, "cross-site-request"]);
    const quote = await call("POST", "/quotes", { cookie: admin, "sec-fetch-site": "cross-site" }, {});
    expect([quote.statusCode, quote.json().code]).toEqual([403, "cross-site-request"]);
  });

  it("lets Nav's own web (same-origin), reads and requests without Sec-Fetch-Site through", async () => {
    const same = await call("PATCH", "/me/settings", { cookie: admin, "sec-fetch-site": "same-origin", origin: WEB_ORIGIN }, { listPageSize: 100 });
    expect(same.statusCode).toBe(200);
    const plain = await call("PATCH", "/me/settings", { cookie: admin }, { listPageSize: 25 });
    expect(plain.statusCode).toBe(200);
    // The web on its own host calling the API directly (NEXT_PUBLIC_API_URL).
    const web = await call("PATCH", "/me/settings", { cookie: admin, "sec-fetch-site": "same-site", origin: WEB_ORIGIN }, { listPageSize: 250 });
    expect(web.statusCode).toBe(200);
    const read = await call("GET", "/me/settings", { cookie: admin, "sec-fetch-site": "cross-site" });
    expect(read.statusCode).toBe(200);
  });

  it("guards login, register and logout too, so no other site can sign someone in or out", async () => {
    const login = await call("POST", "/auth/login", { "sec-fetch-site": "cross-site" }, { email: "admin@example.com", password: PASSWORD });
    expect([login.statusCode, login.json().code]).toEqual([403, "cross-site-request"]);
    expect(login.cookies).toEqual([]);
    const register = await call("POST", "/auth/register", { "sec-fetch-site": "same-site" }, { email: "x@example.com", password: PASSWORD, name: "X", setupCode: "x" });
    expect([register.statusCode, register.json().code]).toEqual([403, "cross-site-request"]);
    const logout = await call("POST", "/auth/logout", { cookie: admin, "sec-fetch-site": "cross-site" });
    expect([logout.statusCode, logout.json().code]).toEqual([403, "cross-site-request"]);

    const ok = await call("POST", "/auth/login", { "sec-fetch-site": "same-origin" }, { email: "admin@example.com", password: PASSWORD });
    expect(ok.statusCode).toBe(200);
  });
});

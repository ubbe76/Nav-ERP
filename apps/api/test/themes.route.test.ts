import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { auditLog, db, systemSettings, themes, userSettings } from "@navet/db";
import { BUILTIN_THEME_VALUES, MAX_CUSTOM_THEMES, validateTheme } from "@navet/shared";
import { buildApp } from "../src/app.js";

// Egna teman through the real app: GET /theme-boot (public), the admin
// CRUD under System → Teman, the default/lock settings and the user's own
// choice, with the transactional rules (deleting the default is refused,
// deleting a theme resets its users) and the 50-theme cap.

const TRUNCATE = sql`TRUNCATE themes, audit_log, user_settings, users CASCADE`;
const THEME_SETTING_KEYS = ["default_theme", "theme_choice_locked"];
const PASSWORD = "ett-tillräckligt-långt-lösenord";

let app: ReturnType<typeof buildApp>;
let admin: string;

const cookieOf = (res: { cookies: { name: string; value: string }[] }) => res.cookies.map((c) => `${c.name}=${c.value}`).join("; ");

async function reset() {
  await db.execute(TRUNCATE);
  await db.delete(systemSettings).where(inArray(systemSettings.key, THEME_SETTING_KEYS));
}

async function login(email: string) {
  return cookieOf(await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PASSWORD } }));
}

async function addUser(email: string, extra: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/users",
    headers: { cookie: admin },
    payload: { email, password: PASSWORD, name: email, role: "user", ...extra },
  });
  expect(res.statusCode).toBe(201);
  return { id: res.json().id as string, cookie: await login(email) };
}

const call = (method: string, url: string, cookie: string | null, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: cookie ? { cookie } : {}, ...(payload === undefined ? {} : { payload: payload as never }) });

// The built-in dark theme's values under a new name — a valid custom theme.
const blue = (name = "Fabriksblå", extra: Record<string, unknown> = {}) => ({
  format: "nav-theme",
  version: 1,
  name,
  scheme: "dark",
  tokens: { ...BUILTIN_THEME_VALUES.dark, accent: "#2f5f9e", "accent-fg": "#8fb4ea" },
  source: null,
  ...extra,
});

async function createTheme(name = "Fabriksblå", extra: Record<string, unknown> = {}) {
  const res = await call("POST", "/themes", admin, blue(name, extra));
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; key: string; name: string };
}

beforeEach(async () => {
  await reset();
  app = buildApp();
  await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: { email: "admin@example.com", password: PASSWORD, name: "Admin", setupCode: app.setup.code.code },
  });
  admin = await login("admin@example.com");
});

afterEach(async () => {
  await app.close();
});

afterAll(async () => {
  await reset();
});

describe("GET /theme-boot", () => {
  it("answers without a session: the built-in themes, light default, no lock, no userTheme", async () => {
    const res = await call("GET", "/theme-boot", null);
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = res.json();
    expect(body).toEqual({
      css: "",
      themes: [
        { id: "light", label: "Ljust", scheme: "light", builtIn: true },
        { id: "dark", label: "Mörkt", scheme: "dark", builtIn: true },
        { id: "dracula", label: "Dracula", scheme: "dark", builtIn: true },
      ],
      defaultTheme: "light",
      locked: false,
    });
    expect(body).not.toHaveProperty("userTheme");
    // An invalid cookie is the same as none.
    expect(await call("GET", "/theme-boot", "session=nonsense").then((r) => r.json())).not.toHaveProperty("userTheme");
  });

  it("adds the session user's own choice (null = the company default)", async () => {
    expect((await call("GET", "/theme-boot", admin)).json().userTheme).toBeNull();
    expect((await call("PATCH", "/me/settings", admin, { theme: "dracula" })).statusCode).toBe(200);
    expect((await call("GET", "/theme-boot", admin)).json().userTheme).toBe("dracula");
  });

  it("carries the custom themes' CSS, rebuilt on every write", async () => {
    const theme = await createTheme();
    let boot = (await call("GET", "/theme-boot", null)).json();
    expect(boot.themes).toContainEqual({ id: theme.key, label: "Fabriksblå", scheme: "dark", builtIn: false });
    expect(boot.css).toContain(`:root[data-theme="${theme.key}"] {\n  color-scheme: dark;\n  --color-bg: #15171b;`);
    expect(boot.css).toContain("--accent: #2f5f9e;");

    await call("PATCH", `/themes/${theme.id}`, admin, { tokens: { ...blue().tokens, accent: "#2a5590" } });
    boot = (await call("GET", "/theme-boot", null)).json();
    expect(boot.css).toContain("--accent: #2a5590;");

    await call("DELETE", `/themes/${theme.id}`, admin);
    expect((await call("GET", "/theme-boot", null)).json().css).toBe("");
  });
});

describe("System → Teman (admin)", () => {
  it("is admin only", async () => {
    const user = await addUser("user@example.com");
    for (const [method, url] of [
      ["GET", "/themes"],
      ["POST", "/themes"],
      ["POST", "/themes/validate"],
      ["GET", "/themes/builtin/dark/export"],
    ] as const) {
      expect({ url, status: (await call(method, url, user.cookie, method === "GET" ? undefined : blue())).statusCode }).toEqual({ url, status: 403 });
    }
    expect((await call("GET", "/themes", null)).statusCode).toBe(401);
  });

  it("creates a theme with a generated key, logs it and lists it next to the built-in ones", async () => {
    const res = await call("POST", "/themes", admin, blue("  Fabriksblå  ", { key: "egen-deadbeef", extra: 1 }));
    expect(res.statusCode).toBe(201);
    const theme = res.json();
    expect(theme).toMatchObject({ name: "Fabriksblå", scheme: "dark", builtIn: false, origin: "uploaded", needsReview: false, usedBy: 0, isDefault: false });
    expect(theme.key).toMatch(/^egen-[0-9a-f]{8}$/);
    expect(theme.key).not.toBe("egen-deadbeef");
    expect(theme.tokens.accent).toBe("#2f5f9e");

    const list = (await call("GET", "/themes", admin)).json();
    expect(list.map((r: { name: string }) => r.name)).toEqual(["Ljust", "Mörkt", "Dracula", "Fabriksblå"]);
    expect(list[0]).toMatchObject({ id: "light", key: "light", builtIn: true, origin: "builtin", isDefault: true });

    const [log] = await db.select().from(auditLog).where(eq(auditLog.action, "theme_created"));
    expect(log).toMatchObject({ entityType: "theme", entityId: "Fabriksblå" });
  });

  it("marks an editor theme by its source", async () => {
    const source = { base: "dark", bg: "#15171b", surface: "#1b1e24", text: "#edeef1", accent: "#2f5f9e", heading: null, status: null, overrides: {} };
    const theme = (await call("POST", "/themes", admin, blue("Från redigeraren", { source }))).json();
    expect(theme).toMatchObject({ origin: "editor", source });
  });

  it("refuses an invalid theme with the findings (400 theme-invalid)", async () => {
    const bad = await call("POST", "/themes", admin, blue("Trasig", { tokens: { ...blue().tokens, "color-bg": "#000;} body{display:none" } }));
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ code: "theme-invalid", errors: [{ token: "color-bg" }], contrastFailures: [] });

    const dim = await call("POST", "/themes", admin, blue("Dunkel", { tokens: { ...blue().tokens, "color-text-muted": "#3a3d44" } }));
    expect(dim.statusCode).toBe(400);
    expect(dim.json()).toMatchObject({ code: "theme-invalid", errors: [] });
    expect(dim.json().contrastFailures[0]).toMatchObject({ fg: "color-text-muted" });

    expect((await call("POST", "/themes", admin, { name: "x" })).statusCode).toBe(400);
    expect(await db.select().from(themes)).toEqual([]);
  });

  it("refuses a taken name, a built-in label included (409 theme-name-taken)", async () => {
    await createTheme();
    for (const name of ["Fabriksblå", "mörkt"]) {
      const res = await call("POST", "/themes", admin, blue(name));
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe("theme-name-taken");
    }
    const other = await createTheme("Annat");
    const rename = await call("PATCH", `/themes/${other.id}`, admin, { name: "Fabriksblå" });
    expect(rename.statusCode).toBe(409);
  });

  it("validates without saving (the upload preview)", async () => {
    const res = await call("POST", "/themes/validate", admin, { ...blue(), tokens: { ...blue().tokens, sparkle: "#fff" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, name: "Fabriksblå", scheme: "dark", errors: [], contrastFailures: [] });
    expect(res.json().warnings).toHaveLength(1);
    expect((await call("POST", "/themes/validate", admin, { name: "x" })).json().ok).toBe(false);
    expect(await db.select().from(themes)).toEqual([]);
  });

  it("gets and updates one theme; PATCH validates the merged theme", async () => {
    const theme = await createTheme();
    const got = await call("GET", `/themes/${theme.id}`, admin);
    expect(got.statusCode).toBe(200);
    expect(got.json()).toMatchObject({ id: theme.id, name: "Fabriksblå", warnings: [], contrastFailures: [] });

    const renamed = await call("PATCH", `/themes/${theme.id}`, admin, { name: "Verkstadsblå", scheme: "light" });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({ name: "Verkstadsblå", scheme: "light", key: theme.key });
    const [log] = await db.select().from(auditLog).where(eq(auditLog.action, "theme_updated"));
    expect(log).toMatchObject({ entityId: "Verkstadsblå", detail: { before: { name: "Fabriksblå" }, after: { name: "Verkstadsblå" } } });

    const broken = await call("PATCH", `/themes/${theme.id}`, admin, { tokens: { ...blue().tokens, accent: "var(--nope)" } });
    expect(broken.statusCode).toBe(400);
    expect((await call("GET", `/themes/${crypto.randomUUID()}`, admin)).statusCode).toBe(404);
    expect((await call("PATCH", `/themes/${crypto.randomUUID()}`, admin, { name: "x" })).statusCode).toBe(404);
    expect((await call("GET", "/themes/light", admin)).statusCode).toBe(400);
  });

  it("marks a theme saved before a token existed as Behöver ses över, filling the gap from the fallback", async () => {
    const theme = await createTheme();
    const [row] = await db.select().from(themes).where(eq(themes.id, theme.id));
    const { "accent-fg": _gone, ...older } = row!.tokens;
    await db.update(themes).set({ tokens: older }).where(eq(themes.id, theme.id));
    const listed = (await call("GET", "/themes", admin)).json().find((r: { id: string }) => r.id === theme.id);
    expect(listed.needsReview).toBe(true);
    const detail = (await call("GET", `/themes/${theme.id}`, admin)).json();
    expect(detail.tokens["accent-fg"]).toBe("var(--accent)");
    expect(detail.warnings).toEqual([expect.objectContaining({ token: "accent-fg" })]);
    // The CSS still carries the token.
    expect((await call("GET", "/theme-boot", null)).json().css).toContain("--accent-fg: var(--accent);");
  });

  it("exports a custom and a built-in theme as a theme file", async () => {
    const theme = await createTheme();
    const res = await call("GET", `/themes/${theme.id}/export`, admin);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-disposition"]).toContain("tema-Fabriksbl");
    const file = JSON.parse(res.body);
    expect(file).toMatchObject({ format: "nav-theme", version: 1, name: "Fabriksblå", scheme: "dark", source: null });
    expect(validateTheme(file).ok).toBe(true);

    const builtIn = await call("GET", "/themes/builtin/dracula/export", admin);
    expect(builtIn.statusCode).toBe(200);
    expect(builtIn.headers["content-disposition"]).toContain("tema-Dracula.json");
    expect(JSON.parse(builtIn.body)).toMatchObject({ name: "Dracula", scheme: "dark", tokens: BUILTIN_THEME_VALUES.dracula });
    expect((await call("GET", "/themes/builtin/nope/export", admin)).statusCode).toBe(404);
    expect((await call("GET", `/themes/${crypto.randomUUID()}/export`, admin)).statusCode).toBe(404);
  });

  it(`stops at ${MAX_CUSTOM_THEMES} custom themes (409 theme-limit)`, async () => {
    const tokens = validateTheme(blue()).tokens;
    await db.insert(themes).values(
      Array.from({ length: MAX_CUSTOM_THEMES }, (_, i) => ({
        key: `egen-${i.toString(16).padStart(8, "0")}`,
        name: `Tema ${i}`,
        scheme: "dark" as const,
        tokens,
      }))
    );
    const res = await call("POST", "/themes", admin, blue("Ett för mycket"));
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("theme-limit");
    // All 50 in the CSS.
    expect((await call("GET", "/theme-boot", null)).json().themes).toHaveLength(MAX_CUSTOM_THEMES + 3);
  });
});

describe("the default theme, the lock and the user's choice", () => {
  it("PATCH /settings takes an existing default theme and the lock; GET /theme-boot follows", async () => {
    const theme = await createTheme();
    const unknown = await call("PATCH", "/settings", admin, { defaultTheme: "egen-00000000", themeChoiceLocked: true });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().code).toBe("unknown-theme");
    // Nothing written: the lock went with the refused request.
    expect((await call("GET", "/settings", admin)).json()).toMatchObject({ defaultTheme: "light", themeChoiceLocked: false });

    const ok = await call("PATCH", "/settings", admin, { defaultTheme: theme.key, themeChoiceLocked: true });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ defaultTheme: theme.key, themeChoiceLocked: true });
    expect((await call("GET", "/theme-boot", null)).json()).toMatchObject({ defaultTheme: theme.key, locked: true });
    expect((await call("PATCH", "/settings", admin, { defaultTheme: "dracula" })).statusCode).toBe(200);
    expect((await call("GET", "/themes", admin)).json().find((r: { id: string }) => r.id === "dracula").isDefault).toBe(true);
  });

  it("refuses to delete the company default (409 theme-is-default)", async () => {
    const theme = await createTheme();
    await call("PATCH", "/settings", admin, { defaultTheme: theme.key });
    const res = await call("DELETE", `/themes/${theme.id}`, admin);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("theme-is-default");
    expect(await db.select().from(themes)).toHaveLength(1);
  });

  it("deleting a theme resets the users who chose it, in the same transaction, and logs it", async () => {
    const theme = await createTheme();
    const user = await addUser("user@example.com");
    expect((await call("PATCH", "/me/settings", user.cookie, { theme: theme.key })).json().theme).toBe(theme.key);
    expect((await call("PATCH", "/me/settings", admin, { theme: "dark" })).statusCode).toBe(200);
    expect((await call("GET", "/themes", admin)).json().find((r: { id: string }) => r.id === theme.id).usedBy).toBe(1);

    expect((await call("DELETE", `/themes/${theme.id}`, admin)).statusCode).toBe(204);
    expect((await call("GET", "/me/settings", user.cookie)).json().theme).toBeNull();
    expect((await call("GET", "/theme-boot", user.cookie)).json().userTheme).toBeNull();
    // Another user's other choice is untouched.
    expect((await call("GET", "/me/settings", admin)).json().theme).toBe("dark");
    const rows = await db.select().from(userSettings).where(and(eq(userSettings.key, "theme"), eq(userSettings.userId, user.id)));
    expect(rows).toEqual([]);
    const [log] = await db.select().from(auditLog).where(eq(auditLog.action, "theme_deleted"));
    expect(log).toMatchObject({ entityId: "Fabriksblå", detail: { usersReset: 1 } });
    expect((await call("DELETE", `/themes/${theme.id}`, admin)).statusCode).toBe(404);
  });

  it("PATCH /me/settings takes an existing theme or null; an unknown one is a 400", async () => {
    const theme = await createTheme();
    expect((await call("PATCH", "/me/settings", admin, { theme: theme.key })).json().theme).toBe(theme.key);
    const unknown = await call("PATCH", "/me/settings", admin, { theme: "egen-00000000", listPageSize: 100 });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().code).toBe("unknown-theme");
    expect((await call("GET", "/me/settings", admin)).json()).toMatchObject({ theme: theme.key, listPageSize: 50 });
    expect((await call("PATCH", "/me/settings", admin, { theme: "Not a theme!" })).statusCode).toBe(400);
    expect((await call("PATCH", "/me/settings", admin, { theme: null })).json().theme).toBeNull();
  });

  it("a read-only account can't store a choice (403) but still reads the boot data", async () => {
    const reader = await addUser("reader@example.com", { readOnly: true });
    const res = await call("PATCH", "/me/settings", reader.cookie, { theme: "dark" });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("read-only-account");
    expect((await call("GET", "/theme-boot", reader.cookie)).json().userTheme).toBeNull();
  });
});

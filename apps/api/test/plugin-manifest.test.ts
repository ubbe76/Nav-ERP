import { describe, expect, it } from "vitest";
import {
  BUILTIN_THEMES,
  normalizePluginBaseUrl,
  PERMISSIONS,
  PLUGIN_EVENT_CATALOG,
  PLUGIN_EVENT_TYPES,
  PLUGIN_MAX_PAGES,
  PLUGIN_TAB_PERMISSION,
  validatePluginManifest,
} from "@navet/shared";
import {
  buildWebhookBody,
  MAX_ATTEMPTS,
  newPluginApiKey,
  newWebhookSecret,
  nextAttemptDelay,
  signWebhook,
  verifyWebhookSignature,
} from "../src/modules/system/service/plugin-webhook.js";
import { buildPluginKitCss } from "../src/modules/system/service/plugin-kit-css.js";
import { pluginRouteForbidden } from "../src/modules/auth/middleware/auth.middleware.js";

// Tillägg — the pure parts: the manifest's rules, the event catalogue, the
// webhook signature and retry schedule, the keys and the plugin kit's CSS.

const valid = (extra: Record<string, unknown> = {}) => ({
  format: "nav-plugin",
  version: 1,
  key: "lagerstatistik",
  name: "Lagerstatistik",
  description: "Omsättningshastighet och inkuranta artiklar.",
  author: "Exempel AB",
  homepage: "https://example.com",
  permissions: ["lager", "artiklar"],
  readOnly: true,
  webhook: { path: "/nav/webhook", events: ["article.created", "article.updated"] },
  pages: [{ key: "oversikt", title: "Lagerstatistik", description: "Omsättning per artikel.", module: "lager", path: "/nav/oversikt" }],
  tabs: [{ key: "omsattning", title: "Omsättning", on: "article", path: "/nav/artikel" }],
  ...extra,
});

const errorsOf = (input: unknown) => validatePluginManifest(input).errors;

describe("validatePluginManifest", () => {
  it("accepts the spec's example as it is", () => {
    const result = validatePluginManifest(valid());
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(result.manifest).toEqual({
      format: "nav-plugin",
      version: 1,
      key: "lagerstatistik",
      name: "Lagerstatistik",
      description: "Omsättningshastighet och inkuranta artiklar.",
      author: "Exempel AB",
      homepage: "https://example.com",
      permissions: ["lager", "artiklar"],
      readOnly: true,
      webhook: { path: "/nav/webhook", events: ["article.created", "article.updated"] },
      pages: [{ key: "oversikt", title: "Lagerstatistik", description: "Omsättning per artikel.", module: "lager", path: "/nav/oversikt" }],
      tabs: [{ key: "omsattning", title: "Omsättning", on: "article", path: "/nav/artikel" }],
    });
  });

  it("fills the optional parts: no webhook, pages, tabs, permissions or readOnly", () => {
    const result = validatePluginManifest({ format: "nav-plugin", version: 1, key: "ab", name: "AB" });
    expect(result.ok).toBe(true);
    expect(result.manifest).toMatchObject({ permissions: [], readOnly: false, webhook: null, pages: [], tabs: [], description: null });
  });

  it("refuses a newer manifest version with 'kräver en nyare Nav'", () => {
    expect(errorsOf(valid({ version: 2 }))).toEqual(["Tillägget kräver en nyare Nav (manifestversion 2)."]);
    expect(errorsOf(valid({ format: "other" }))[0]).toMatch(/format/);
    expect(errorsOf("not an object")).toEqual(["Manifestet måste vara ett JSON-objekt."]);
  });

  it("ignores unknown fields with a warning, also nested ones", () => {
    const result = validatePluginManifest(
      valid({
        extra: 1,
        webhook: { path: "/w", events: [], secret: "x" },
        pages: [{ key: "a", title: "A", module: "lager", path: "/a", icon: "x" }],
      })
    );
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual(["Okänt fält extra ignoreras.", "Okänt fält webhook.secret ignoreras.", "Okänt fält pages[0].icon ignoreras."]);
    expect(result.manifest).not.toHaveProperty("extra");
  });

  it("checks the key pattern", () => {
    for (const key of ["a", "Lager", "1abc", "lager_stat", "a".repeat(41)]) expect(errorsOf(valid({ key })).length).toBe(1);
    for (const key of ["ab", "lager-stat", "a".repeat(40)]) expect(errorsOf(valid({ key }))).toEqual([]);
  });

  it("takes permissions from the catalogue only — never admin, workshop permissions allowed — and drops duplicates", () => {
    expect(errorsOf(valid({ permissions: ["admin"] }))).toEqual(["Okänd rättighet: admin."]);
    expect(errorsOf(valid({ permissions: ["office"] }))).toEqual(["Okänd rättighet: office."]);
    const result = validatePluginManifest(valid({ permissions: ["terminal", "lager", "lager"] }));
    expect(result.manifest?.permissions).toEqual(["terminal", "lager"]);
  });

  it("takes webhook events from the catalogue and a relative path", () => {
    expect(errorsOf(valid({ webhook: { path: "/w", events: ["article.deleted"] } }))).toEqual(["Okänd händelse: article.deleted."]);
    expect(errorsOf(valid({ webhook: { path: "/w", events: ["plugin.test"] } }))).toEqual(["Okänd händelse: plugin.test."]);
    for (const path of ["https://evil.example/w", "//evil.example/w", "w", "/a b", "/a\\b", ""]) {
      expect(errorsOf(valid({ webhook: { path, events: [] } }))).toEqual(["webhook.path måste vara en relativ sökväg som börjar med /."]);
    }
  });

  it("checks pages: module with a hub, unique keys, title ≤ 40, relative path, at most 10", () => {
    const page = (extra: Record<string, unknown>) => ({ key: "a", title: "A", module: "lager", path: "/a", ...extra });
    expect(errorsOf(valid({ pages: [page({ module: "system" })] }))[0]).toMatch(/^Sida 1: modulen måste vara en av/);
    expect(errorsOf(valid({ pages: [page({}), page({})] }))).toEqual(["Sida 2: nyckeln a finns redan."]);
    expect(errorsOf(valid({ pages: [page({ title: "x".repeat(41) })] }))).toEqual(["Sida 1: titeln får vara högst 40 tecken."]);
    expect(errorsOf(valid({ pages: [page({ path: "https://x.example/a" })] }))).toEqual(["Sida 1: sökvägen måste vara relativ och börja med /."]);
    const many = Array.from({ length: PLUGIN_MAX_PAGES + 1 }, (_, i) => page({ key: `p${i}` }));
    expect(errorsOf(valid({ pages: many }))).toEqual(["Ett tillägg får ha högst 10 sidor."]);
  });

  it("checks tabs: the cards with tabs, unique keys", () => {
    const tab = (extra: Record<string, unknown>) => ({ key: "a", title: "A", on: "article", path: "/a", ...extra });
    expect(errorsOf(valid({ tabs: [tab({ on: "sales_order" })] }))[0]).toMatch(/^Flik 1: on måste vara en av article, customer, supplier/);
    expect(errorsOf(valid({ tabs: [tab({}), tab({})] }))).toEqual(["Flik 2: nyckeln a finns redan."]);
    expect(validatePluginManifest(valid({ tabs: [tab({ on: "customer" }), tab({ key: "b", on: "supplier" })] })).ok).toBe(true);
  });

  it("refuses a homepage that is not http(s)", () => {
    expect(errorsOf(valid({ homepage: "javascript:alert(1)" }))).toEqual(["Hemsidan måste vara en http- eller https-adress."]);
  });
});

describe("the event catalogue", () => {
  it("has every type once, a label each, and only catalogue permissions", () => {
    expect(PLUGIN_EVENT_CATALOG.map((d) => d.type)).toEqual([...PLUGIN_EVENT_TYPES]);
    for (const def of PLUGIN_EVENT_CATALOG) {
      expect(def.label.length).toBeGreaterThan(0);
      expect(PERMISSIONS).toContain(def.permission);
    }
    for (const permission of Object.values(PLUGIN_TAB_PERMISSION)) expect(PERMISSIONS).toContain(permission);
  });
});

describe("normalizePluginBaseUrl", () => {
  it("takes http(s) without credentials, query or fragment, and drops the trailing slash", () => {
    expect(normalizePluginBaseUrl("https://plugin.example/")).toBe("https://plugin.example");
    expect(normalizePluginBaseUrl(" http://10.0.0.5:8080/base/ ")).toBe("http://10.0.0.5:8080/base");
    for (const bad of ["ftp://x.example", "file:///etc/passwd", "https://u:p@x.example", "https://x.example/?a=1", "https://x.example/#a", "nonsense", ""]) {
      expect(normalizePluginBaseUrl(bad)).toBeNull();
    }
  });
});

describe("webhook signature and retries", () => {
  const at = new Date("2026-10-23T08:15:00.000Z");
  const body = buildWebhookBody({
    eventId: "11111111-1111-4111-8111-111111111111",
    type: "sales_order.confirmed",
    occurredAt: at,
    pluginKey: "lagerstatistik",
    entityId: "22222222-2222-4222-8222-222222222222",
    entityNumber: "KO-1043",
    data: { deliveryId: "x", id: "spoofed" },
  });

  it("sends the spec's body with id/number winning over stray data", () => {
    expect(JSON.parse(body)).toEqual({
      id: "11111111-1111-4111-8111-111111111111",
      type: "sales_order.confirmed",
      occurredAt: "2026-10-23T08:15:00.000Z",
      plugin: "lagerstatistik",
      data: { deliveryId: "x", id: "22222222-2222-4222-8222-222222222222", number: "KO-1043" },
    });
  });

  it("signs t.<body> with HMAC-SHA256 and verifies only the same secret, body and a fresh timestamp", () => {
    const secret = newWebhookSecret();
    const header = signWebhook(secret, body, at);
    expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(header.startsWith(`t=${Math.floor(at.getTime() / 1000)},`)).toBe(true);
    expect(verifyWebhookSignature(secret, body, header, at)).toBe(true);
    expect(verifyWebhookSignature(newWebhookSecret(), body, header, at)).toBe(false);
    expect(verifyWebhookSignature(secret, `${body} `, header, at)).toBe(false);
    expect(verifyWebhookSignature(secret, body, header, new Date(at.getTime() + 301_000))).toBe(false);
  });

  it("retries after 1 min, 5 min, 30 min, 2 h, 6 h, 12 h and gives up after 7 attempts", () => {
    const minutes = [1, 2, 3, 4, 5, 6].map((n) => nextAttemptDelay(n)! / 60_000);
    expect(minutes).toEqual([1, 5, 30, 120, 360, 720]);
    expect(MAX_ATTEMPTS).toBe(7);
    expect(nextAttemptDelay(7)).toBeNull();
  });

  it("makes keys nav_plg_<key>_<32 characters> and 64-hex secrets, all different", () => {
    const key = newPluginApiKey("lagerstatistik");
    expect(key).toMatch(/^nav_plg_lagerstatistik_[A-Za-z0-9]{32}$/);
    expect(newPluginApiKey("lagerstatistik")).not.toBe(key);
    expect(newWebhookSecret()).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("the plugin's forbidden routes", () => {
  it("covers /auth, /me, /oauth and /plugins — nothing else", () => {
    for (const url of ["/api/v1/auth/me", "/api/v1/auth/users/:id", "/api/v1/me/settings", "/api/v1/oauth/token", "/api/v1/plugins", "/api/v1/plugins/:id/context"]) {
      expect(pluginRouteForbidden(url)).toBe(true);
    }
    for (const url of ["/api/v1/articles", "/api/v1/plugin-ui", "/api/v1/authors", "/api/v1/meters"]) expect(pluginRouteForbidden(url)).toBe(false);
  });
});

describe("buildPluginKitCss", () => {
  it("has a block per built-in theme, the custom CSS, and a base style using tokens only", () => {
    const css = buildPluginKitCss(':root[data-theme="egen-0000abcd"] {\n  --color-bg: #000000;\n}');
    for (const theme of BUILTIN_THEMES) expect(css).toContain(`:root[data-theme="${theme.id}"]`);
    expect(css).toContain('data-theme="egen-0000abcd"');
    expect(css).toContain(".nav-button--primary");
    expect(css).toContain(".nav-table");
    expect(css).toContain(".nav-field");
    // The base style names no colour of its own.
    const base = css.slice(css.indexOf(":root {\n  --nav-radius-control"));
    expect(base).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
  });
});

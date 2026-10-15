import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  API_CLIENT_PRESETS,
  API_CLIENT_SCOPE_LABELS,
  API_CLIENT_SCOPES,
  createApiClientSchema,
  updateApiClientSchema,
} from "@navet/shared";

describe("API-klienternas rättigheter", () => {
  it("has exactly the five scopes, each with a Swedish label", () => {
    expect([...API_CLIENT_SCOPES]).toEqual(["configurator:read", "prices:read", "quotes:create", "orders:confirm", "structure:read"]);
    for (const scope of API_CLIENT_SCOPES) expect(API_CLIENT_SCOPE_LABELS[scope]).toMatch(/\S/);
  });

  it("has the three presets from the spec", () => {
    const byKey = Object.fromEntries(API_CLIENT_PRESETS.map((p) => [p.key, p]));
    expect(byKey.hemsida).toMatchObject({ scopes: ["configurator:read", "quotes:create"], needsCustomer: true });
    expect(byKey.aterforsaljare).toMatchObject({
      scopes: ["configurator:read", "prices:read", "quotes:create", "orders:confirm"],
      needsCustomer: true,
    });
    expect(byKey.intern).toMatchObject({ scopes: [...API_CLIENT_SCOPES], needsCustomer: false });
  });

  it("requires at least one known scope", () => {
    expect(createApiClientSchema.safeParse({ name: "X", scopes: [] }).success).toBe(false);
    expect(createApiClientSchema.safeParse({ name: "X", scopes: ["admin:all"] }).success).toBe(false);
    expect(createApiClientSchema.safeParse({ name: "X", scopes: ["configurator:read"] }).success).toBe(true);
    expect(updateApiClientSchema.safeParse({ scopes: [] }).success).toBe(false);
    expect(updateApiClientSchema.safeParse({ customerId: null }).success).toBe(true);
    expect(updateApiClientSchema.safeParse({}).success).toBe(false);
  });

  it("keeps the web mirror in sync", () => {
    const web = readFileSync(new URL("../../web/lib/apiClientScopes.ts", import.meta.url), "utf8");
    for (const scope of API_CLIENT_SCOPES) {
      expect(web).toContain(`"${scope}"`);
      expect(web).toContain(API_CLIENT_SCOPE_LABELS[scope]);
    }
    for (const preset of API_CLIENT_PRESETS) expect(web).toContain(`key: "${preset.key}"`);
  });

  it("gives existing clients every scope in the migration", () => {
    const dir = new URL("../../../packages/db/drizzle/", import.meta.url);
    const file = readdirSync(dir).find((f) => f.startsWith("0119_") && f.endsWith(".sql"))!;
    const sql = readFileSync(new URL(file, dir), "utf8");
    expect(sql).toMatch(/UPDATE "api_clients" SET "scopes"/);
    for (const scope of API_CLIENT_SCOPES) expect(sql).toContain(scope);
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@navet/db";
import { buildApp } from "../src/app.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createAuthService } from "../src/modules/auth/service/auth.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { makeArticle } from "./helpers/configurator.js";
import { buildVariants, configurator, resetConfiguredRows } from "./helpers/configured-rows.js";

// Variant av … on the article card: GET /articles/:id?withVariantOf=true
// carries the stocked variant's template and choices (the configurator's
// reader, bound late in app.ts) so the header and the Konfigurator tab need
// no GET …/variant-of of their own.

beforeEach(resetConfiguredRows);
afterAll(resetConfiguredRows);

describe("GET /articles/:id?withVariantOf=true", () => {
  const app = buildApp();
  const authService = createAuthService(createAuthRepository(db), "unused", createAuditRepository(db));

  beforeAll(async () => {
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  async function session() {
    const email = `variant-of-${crypto.randomUUID()}@example.com`;
    await authService.createUser({ email, password: "correcthorse", name: "Variant av", role: "admin", permissionGroupId: null });
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: "correcthorse" } });
    return { cookie: `session=${login.cookies.find((c) => c.name === "session")!.value}` };
  }

  it("a variant gets its template and choices, any other article null, and without the flag the field is absent", async () => {
    const headers = await session();
    const { template } = await buildVariants();
    const { article: variant } = await configurator.resolveVariant(template.id, { LOCK: "B", BREDD: 1200 }, null);
    const plain = await makeArticle();

    const of = await app.inject({ method: "GET", url: `/api/v1/articles/${variant.id}?withVariantOf=true`, headers });
    expect(of.statusCode).toBe(200);
    expect(of.json().variantOf).toMatchObject({
      templateArticleId: template.id,
      templateArticleNumber: template.articleNumber,
      templateName: template.name,
      selection: [
        expect.objectContaining({ groupCode: "LOCK", valueCode: "B", valueName: "Lås B" }),
        expect.objectContaining({ groupCode: "BREDD", value: 1200 }),
      ],
    });
    // The same answer as the configurator's own route (Ändra konfiguration still reads it).
    const own = await app.inject({ method: "GET", url: `/api/v1/articles/${variant.id}/variant-of`, headers });
    expect(of.json().variantOf).toEqual(own.json());

    for (const id of [plain.id, template.id]) {
      const none = await app.inject({ method: "GET", url: `/api/v1/articles/${id}?withVariantOf=true`, headers });
      expect([none.statusCode, none.json().variantOf]).toEqual([200, null]);
    }
    const without = await app.inject({ method: "GET", url: `/api/v1/articles/${variant.id}`, headers });
    expect(without.statusCode).toBe(200);
    expect("variantOf" in without.json()).toBe(false);

    // Both opt-ins together (the card asks for withAbc too).
    const both = await app.inject({ method: "GET", url: `/api/v1/articles/${variant.id}?withAbc=true&withVariantOf=true`, headers });
    expect(both.json()).toHaveProperty("abcClass");
    expect(both.json()).toMatchObject({ variantOf: { templateArticleId: template.id } });
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { articles, configuratorVariants, db, salesOrderRows, salesOrders, units } from "@navet/db";
import { buildApp } from "../src/app.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createAuthService } from "../src/modules/auth/service/auth.service.js";
import { ConfiguratorInvalidConfigurationError } from "../src/modules/configurator/service/configurator.errors.js";
import { createOAuthRepository } from "../src/modules/oauth/repository/oauth.repository.js";
import { createOAuthService } from "../src/modules/oauth/service/oauth.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { RowVariantExistsError } from "../src/modules/sales/service/sales.errors.js";
import { makeArticle } from "./helpers/configurator.js";
import { testArticleService } from "./helpers/services.js";
import { buildVariants, configurator, makeCustomer, makeUser, resetConfiguredRows, salesService } from "./helpers/configured-rows.js";

// Konfigurator delprojekt 5 — the row path's variant mode and the OAuth
// quote's publishing check. A row with `configuration` on a template in mode
// variants resolves (fetches or creates) the variant and continues as an
// ordinary row on it; an API client may only configure templates published
// for the API (Visa i API), a session is never held to that.

beforeEach(resetConfiguredRows);
afterAll(resetConfiguredRows);

const SEL = { LOCK: "B", BREDD: 1200 };
const variantRows = () => db.select().from(configuratorVariants);
const orderCount = async () => (await db.select({ id: salesOrders.id }).from(salesOrders)).length;
const rawRow = async (rowId: string) => (await db.select().from(salesOrderRows).where(eq(salesOrderRows.id, rowId)))[0]!;

describe("variant mode in the row path (service)", () => {
  it("createQuote: a configured row on a variants template becomes an ordinary row on the (new) variant, priced through the template's chain", async () => {
    const { template } = await buildVariants();
    const c = await makeCustomer();
    const user = await makeUser();
    const { rows } = await salesService.createQuote(
      { customerId: c.id, rows: [{ articleId: template.id, quantity: 2, configuration: { selection: SEL } }] } as never,
      user.id
    );
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.articleId).not.toBe(template.id);
    expect(row.configuration).toBeNull();
    expect("configurationCost" in row).toBe(false);
    // Base 1000 + LOCK B 50, no customer agreement.
    expect(Number(row.unitPrice)).toBe(1050);
    expect(Number(row.discountPercent)).toBe(0);
    expect(Number(row.quantityOrdered)).toBe(2);
    const stored = await rawRow(row.id);
    expect([stored.configuration, stored.configurationCost]).toEqual([null, null]);
    // The variant is linked to the template and created by the quote's user.
    const links = await variantRows();
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ articleId: row.articleId, templateArticleId: template.id, createdBy: user.id });
    const [variant] = await db.select().from(articles).where(eq(articles.id, row.articleId));
    expect(variant!.articleNumber).toBe(`${template.articleNumber}-B-1200`);
    // listRows shows the row as a variant of the template (Ändra konfiguration).
    const [listed] = await salesService.listRows(row.salesOrderId);
    expect(listed!.variantTemplateArticleId).toBe(template.id);
  });

  it("the same selection on a second quote reuses the variant; a handwritten unit price stands", async () => {
    const { template } = await buildVariants();
    const c = await makeCustomer();
    const first = await salesService.createQuote(
      { customerId: c.id, rows: [{ articleId: template.id, quantity: 1, configuration: { selection: SEL } }] } as never,
      null
    );
    const second = await salesService.createQuote(
      { customerId: c.id, rows: [{ articleId: template.id, quantity: 1, unitPrice: 777, configuration: { selection: SEL } }] } as never,
      null
    );
    expect(second.rows[0]!.articleId).toBe(first.rows[0]!.articleId);
    expect(Number(second.rows[0]!.unitPrice)).toBe(777);
    expect(second.rows[0]!.configuration).toBeNull();
    expect(await variantRows()).toHaveLength(1);
  });

  it("addRow with a configuration on the variants template is a variant row too", async () => {
    const { template } = await buildVariants();
    const plain = await makeArticle({ salesPrice: 100 });
    const c = await makeCustomer();
    const user = await makeUser();
    const { order } = await salesService.createQuote({ customerId: c.id, rows: [{ articleId: plain.id, quantity: 1 }] } as never, null);
    const row = await salesService.addRow(order.id, { articleId: template.id, quantity: 1, configuration: { selection: { LOCK: "A", BREDD: 800 } } } as never, user.id);
    expect(row.articleId).not.toBe(template.id);
    expect(row.configuration).toBeNull();
    expect("configurationCost" in row).toBe(false);
    expect(Number(row.unitPrice)).toBe(1000);
    const [link] = await variantRows();
    expect(link).toMatchObject({ articleId: row.articleId, templateArticleId: template.id, createdBy: user.id });
    expect(await salesService.listRows(order.id)).toHaveLength(2);
  });

  // Review Focus 3: the variant is created once (under the template lock);
  // the second row is the same ordinary row as the first — refused with the
  // domain error the unique index stands for, and no quote is left.
  it("two rows with the same new combination in one createQuote: one variant, no order, RowVariantExistsError", async () => {
    const { template } = await buildVariants();
    const c = await makeCustomer();
    const err = await salesService
      .createQuote(
        {
          customerId: c.id,
          rows: [
            { articleId: template.id, quantity: 1, configuration: { selection: SEL } },
            { articleId: template.id, quantity: 3, configuration: { selection: SEL } },
          ],
        } as never,
        null
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RowVariantExistsError);
    const [variant] = await db.select().from(articles).where(eq(articles.articleNumber, `${template.articleNumber}-B-1200`));
    expect((err as Error).message).toBe(`Varianten ${variant!.articleNumber} ligger redan som rad på ordern`);
    expect(await variantRows()).toHaveLength(1);
    expect(await orderCount()).toBe(0);
  });

  it("an invalid selection on the variants template is the configurator's 400 error and creates no quote", async () => {
    const { template } = await buildVariants();
    const c = await makeCustomer();
    await expect(
      salesService.createQuote(
        { customerId: c.id, rows: [{ articleId: template.id, quantity: 1, configuration: { selection: { LOCK: "B", BREDD: 9999 } } }] } as never,
        null
      )
    ).rejects.toBeInstanceOf(ConfiguratorInvalidConfigurationError);
    expect(await variantRows()).toHaveLength(0);
    expect(await orderCount()).toBe(0);
  });
});

describe("POST /quotes — the publishing check for API clients", () => {
  const app = buildApp();
  const authService = createAuthService(createAuthRepository(db), "unused", createAuditRepository(db));
  const oauthService = createOAuthService(createOAuthRepository(db), "unused");

  beforeAll(async () => {
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  async function actors() {
    const email = `quote-${crypto.randomUUID()}@example.com`;
    const user = await authService.createUser({ email, password: "correcthorse", name: "Offert", role: "admin", permissionGroupId: null });
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: "correcthorse" } });
    const session = { cookie: `session=${login.cookies.find((c) => c.name === "session")!.value}` };
    const { client, clientSecret } = await oauthService.createApiClient({ name: "Hemsidan" }, user.id);
    const token = await app.inject({ method: "POST", url: "/api/v1/oauth/token", payload: { clientId: client.id, clientSecret } });
    expect(token.statusCode).toBe(200);
    const clientHeaders = { authorization: `Bearer ${(token.json() as { accessToken: string }).accessToken}` };
    return { client: clientHeaders, session };
  }
  const postQuote = (headers: Record<string, string>, payload: unknown) =>
    app.inject({ method: "POST", url: "/api/v1/quotes", headers, payload: payload as never });

  it("a client's configured row on an unpublished template is 409 configurator-not-published and creates nothing; published is 201", async () => {
    const { client } = await actors();
    const { template } = await buildVariants();
    const c = await makeCustomer();
    const payload = { customerId: c.id, rows: [{ articleId: template.id, quantity: 1, configuration: { selection: SEL } }] };

    const refused = await postQuote(client, payload);
    expect([refused.statusCode, refused.json()]).toEqual([
      409,
      { error: `Mallen ${template.articleNumber} är inte publicerad för API:t`, code: "configurator-not-published" },
    ]);
    expect(await orderCount()).toBe(0);
    expect(await variantRows()).toHaveLength(0);

    await configurator.updateTemplate(template.id, { published: true });
    const ok = await postQuote(client, payload);
    expect(ok.statusCode).toBe(201);
    const row = ok.json().rows[0];
    expect(row.articleId).not.toBe(template.id);
    expect(row.configuration).toBeNull();
    expect(Number(row.unitPrice)).toBe(1050);
    expect(ok.body).not.toContain("configurationCost");
    expect(await variantRows()).toHaveLength(1);

    // Published but on an inactive article: hidden as well.
    await db.update(articles).set({ active: false }).where(eq(articles.id, template.id));
    const inactive = await postQuote(client, payload);
    expect([inactive.statusCode, inactive.json().code]).toEqual([409, "configurator-not-published"]);
  });

  it("an ordinary row on an ordinary article is 201 for a client as before, and a non-template with a configuration is still 400", async () => {
    const { client } = await actors();
    const plain = await makeArticle({ salesPrice: 100 });
    const c = await makeCustomer();
    const ok = await postQuote(client, { customerId: c.id, rows: [{ articleId: plain.id, quantity: 1 }] });
    expect(ok.statusCode).toBe(201);
    expect(Number(ok.json().rows[0].unitPrice)).toBe(100);
    const notAllowed = await postQuote(client, { customerId: c.id, rows: [{ articleId: plain.id, quantity: 1, configuration: { selection: {} } }] });
    expect([notAllowed.statusCode, notAllowed.json().code]).toEqual([400, "configuration-not-allowed"]);
  });

  it("a client's invalid selection on a published variants template is 400 configurator-invalid-configuration with details", async () => {
    const { client } = await actors();
    const { template } = await buildVariants();
    await configurator.updateTemplate(template.id, { published: true });
    const c = await makeCustomer();
    const res = await postQuote(client, { customerId: c.id, rows: [{ articleId: template.id, quantity: 1, configuration: { selection: { LOCK: "B", BREDD: 9999 } } }] });
    expect([res.statusCode, res.json().code, res.json().details.length > 0]).toEqual([400, "configurator-invalid-configuration", true]);
    expect(await orderCount()).toBe(0);
  });

  // Spec: the API never hands out structure or route. A combination the
  // engine accepts but whose structure cannot be derived (here: a structure
  // line taking its component from Lås, whose alternatives have no article)
  // is a generic 409 without details; the article card's preview still names
  // the structure line for Nav users.
  it("a valid selection whose structure is not derivable is 409 configurator-variant-not-derivable with no structure text; the preview keeps it", async () => {
    const { client, session } = await actors();
    const { template, lock } = await buildVariants();
    await configurator.createBomLine(template.id, { conditions: [], source: "group", componentGroupId: lock.id, quantity: 1, note: "Gångjärn" } as never);
    await configurator.updateTemplate(template.id, { published: true });
    const c = await makeCustomer();

    const evaluated = await app.inject({ method: "POST", url: `/api/v1/configurator/${template.id}/evaluate`, headers: client, payload: { selection: SEL } });
    expect([evaluated.statusCode, evaluated.json().valid]).toEqual([200, true]);

    const res = await postQuote(client, { customerId: c.id, rows: [{ articleId: template.id, quantity: 1, configuration: { selection: SEL } }] });
    expect([res.statusCode, res.json()]).toEqual([
      409,
      { error: "Kombinationen kan inte tillverkas — kontrollera mallens struktur i Nav", code: "configurator-variant-not-derivable" },
    ]);
    expect(res.body).not.toMatch(/Strukturrad|saknar artikel|Gångjärn|details/);
    expect(await orderCount()).toBe(0);
    expect(await variantRows()).toHaveLength(0);

    // The session's row route and Konfigurera's resolve route answer the same.
    const plain = await makeArticle({ salesPrice: 100 });
    const created = await postQuote(session, { customerId: c.id, rows: [{ articleId: plain.id, quantity: 1 }] });
    const rowRes = await app.inject({
      method: "POST", url: `/api/v1/sales-orders/${created.json().order.id}/rows`, headers: session,
      payload: { articleId: template.id, quantity: 1, configuration: { selection: SEL } },
    });
    expect([rowRes.statusCode, rowRes.json().code, rowRes.json().details]).toEqual([409, "configurator-variant-not-derivable", undefined]);
    const resolveRes = await app.inject({ method: "POST", url: `/api/v1/configurator/${template.id}/variant`, headers: session, payload: { selection: SEL } });
    expect([resolveRes.statusCode, resolveRes.json().code]).toEqual([409, "configurator-variant-not-derivable"]);

    const [preview] = await configurator.previewVariants(template.id, { sets: { LOCK: ["B"], BREDD: [1200] }, calcQuantity: 1 });
    expect(preview!.status).toBe("invalid");
    expect(preview!.errors.join(" ")).toContain("saknar artikel");
  });

  // A unit that is not the row article's: for a configured variants row the
  // resolved VARIANT's units count. The variant inherits the template's
  // alternative units (Information, like Kopiera från), so the template's kg
  // is fine; a unit on neither is 400 invalid-unit, never a 500.
  it("a configured variants row in a unit the variant does not have is 400 invalid-unit on POST /quotes and POST rows", async () => {
    const { client, session } = await actors();
    const { template } = await buildVariants();
    await configurator.updateTemplate(template.id, { published: true });
    // units is not truncated by the suite's reset — unique code and name per run.
    const tag = crypto.randomUUID().slice(0, 6);
    const [kg, m] = await db
      .insert(units)
      .values([{ code: `kg-${tag}`, name: `Kilogram ${tag}` }, { code: `m-${tag}`, name: `Meter ${tag}` }])
      .returning();
    await testArticleService.addArticleUnit(template.id, { unitId: kg!.id, quantityPerBase: 5 });
    const c = await makeCustomer();
    const quoteIn = (unitId: string) =>
      postQuote(client, { customerId: c.id, rows: [{ articleId: template.id, quantity: 1, unitId, configuration: { selection: SEL } }] });

    const refused = await quoteIn(m!.id);
    expect([refused.statusCode, refused.json()]).toEqual([400, { error: "The unit is not one of the article's units", code: "invalid-unit" }]);
    expect(await orderCount()).toBe(0);

    const ok = await quoteIn(kg!.id);
    expect(ok.statusCode).toBe(201);
    expect([ok.json().rows[0].unitId, Number(ok.json().rows[0].unitFactor)]).toEqual([kg!.id, 5]);

    const plain = await makeArticle({ salesPrice: 100 });
    const created = await postQuote(session, { customerId: c.id, rows: [{ articleId: plain.id, quantity: 1 }] });
    const rowRes = await app.inject({
      method: "POST", url: `/api/v1/sales-orders/${created.json().order.id}/rows`, headers: session,
      payload: { articleId: template.id, quantity: 1, unitId: m!.id, configuration: { selection: SEL } },
    });
    expect([rowRes.statusCode, rowRes.json().code]).toEqual([400, "invalid-unit"]);
  });

  // Review Focus 3 over HTTP: "samma 409 som i dag", never a 500.
  it("two identical configured rows in one client POST /quotes are 409 row-variant-exists: one variant, no order", async () => {
    const { client } = await actors();
    const { template } = await buildVariants();
    await configurator.updateTemplate(template.id, { published: true });
    const c = await makeCustomer();
    const res = await postQuote(client, {
      customerId: c.id,
      rows: [
        { articleId: template.id, quantity: 1, configuration: { selection: SEL } },
        { articleId: template.id, quantity: 2, configuration: { selection: SEL } },
      ],
    });
    expect([res.statusCode, res.json().code]).toEqual([409, "row-variant-exists"]);
    expect(await variantRows()).toHaveLength(1);
    expect(await orderCount()).toBe(0);
  });

  it("POST /sales-orders/:id/rows with a configuration whose variant is already on the order is 409 row-variant-exists", async () => {
    const { session } = await actors();
    const { template } = await buildVariants();
    const c = await makeCustomer();
    const created = await postQuote(session, { customerId: c.id, rows: [{ articleId: template.id, quantity: 1, configuration: { selection: SEL } }] });
    expect(created.statusCode).toBe(201);
    const orderId = created.json().order.id as string;
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/sales-orders/${orderId}/rows`,
      headers: session,
      payload: { articleId: template.id, quantity: 2, configuration: { selection: SEL } },
    });
    expect([res.statusCode, res.json().code]).toEqual([409, "row-variant-exists"]);
    expect(await variantRows()).toHaveLength(1);
    expect(await salesService.listRows(orderId)).toHaveLength(1);
  });

  // Review Focus 4: the web's Ny kundorder posts to the same route with a session.
  it("a session's configured row on the same unpublished template is 201", async () => {
    const { session } = await actors();
    const { template } = await buildVariants();
    const c = await makeCustomer();
    const res = await postQuote(session, { customerId: c.id, rows: [{ articleId: template.id, quantity: 1, configuration: { selection: SEL } }] });
    expect(res.statusCode).toBe(201);
    expect(res.json().rows[0].articleId).not.toBe(template.id);
    expect(res.json().rows[0].configuration).toBeNull();
    expect(await variantRows()).toHaveLength(1);
  });
});

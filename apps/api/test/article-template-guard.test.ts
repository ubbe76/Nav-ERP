import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@navet/db";
import { listArticlesQuerySchema } from "@navet/shared";
import { buildApp } from "../src/app.js";
import {
  ArticleIsTemplateError,
  assertOrderableArticle,
  createArticleService,
} from "../src/modules/article/service/article.service.js";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createAuthService } from "../src/modules/auth/service/auth.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { ConfiguratorModeNotAllowedError } from "../src/modules/configurator/service/configurator.errors.js";
import { createConfiguratorRepository } from "../src/modules/configurator/repository/configurator.repository.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import { createManufacturingService } from "../src/modules/manufacturing/service/manufacturing.service.js";
import { createOAuthRepository } from "../src/modules/oauth/repository/oauth.repository.js";
import { createOAuthService } from "../src/modules/oauth/service/oauth.service.js";
import { createPlanningRepository } from "../src/modules/planning/repository/planning.repository.js";
import { createPlanningService } from "../src/modules/planning/service/planning.service.js";
import { createPurchaseRepository } from "../src/modules/purchase/repository/purchase.repository.js";
import { createPurchaseService } from "../src/modules/purchase/service/purchase.service.js";
import { createRegisterRepository } from "../src/modules/register/repository/register.repository.js";
import { createRegisterService } from "../src/modules/register/service/register.service.js";
import { createMailRepository } from "../src/modules/mail/repository/mail.repository.js";
import { createMailService } from "../src/modules/mail/service/mail.service.js";
import { createDocumentPdfService } from "../src/modules/mail/service/document-pdf.js";
import { createSystemRepository } from "../src/modules/system/repository/system.repository.js";
import { createSystemService } from "../src/modules/system/service/system.service.js";
import { createSalesRepository } from "../src/modules/sales/repository/sales.repository.js";
import { createSalesService } from "../src/modules/sales/service/sales.service.js";
import { ConfigurationRequiredError } from "../src/modules/sales/service/sales.errors.js";
import { markSalesOrderInProduction } from "../src/modules/sales/service/production-transition.js";
import { resolvePrice } from "../src/modules/sales/service/price-resolver.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { createStockService } from "../src/modules/stock/service/stock.service.js";
import { makeArticle, makeVariantService } from "./helpers/configurator.js";
import { buildToOrder } from "./helpers/configured-rows.js";
import { testArticleService, testDocumentPdfService } from "./helpers/services.js";

// Delprojekt 3, Task 6: a template in mode `variants` is never put on a new
// order row — the variants are — and a type/phantom change on a template
// serialises with the template writers through the article row lock.

const articleService = createArticleService(createArticleRepository(db));
const authRepo = createAuthRepository(db);
const stockService = createStockService(createStockRepository(db));
const registerService = createRegisterService(createRegisterRepository(db));
const systemService = createSystemService(createSystemRepository(db));
const mailService = createMailService(createMailRepository(db), systemService, () => ({
  async sendMail() {
    /* no-op fake transport */
  },
}));
const documentPdfService = createDocumentPdfService(systemService);
const purchaseService = createPurchaseService(
  createPurchaseRepository(db),
  registerService,
  mailService,
  documentPdfService,
  articleService,
  systemService,
  {
    reportOperationQuantities: async () => { throw new Error("SubcontractOperationReporter not wired in this test"); },
    assertMaterialBeforeSubcontractReceipt: async () => {},
    undoPurchaseReceiptReportInTx: async () => { throw new Error("SubcontractOperationReporter not wired in this test"); },
    updateRoutingOperation: async () => { throw new Error("RoutingPriceWriter not wired in this test"); },
  }
);
const salesRepository = createSalesRepository(db);
// Built before salesService: konfigurator 4b's row-configuration reader is
// wired in so a to_order template can go on a row WITH a configuration.
const configuratorService = makeVariantService();
const salesService = createSalesService(
  salesRepository,
  registerService,
  mailService,
  documentPdfService,
  stockService,
  articleService,
  systemService,
  (query) => resolvePrice(db, query),
  undefined,
  undefined,
  undefined,
  undefined,
  {
    evaluate: (t, s, o) => configuratorService.evaluateRowConfiguration(t, s, o),
    variantOf: (id) => configuratorService.findVariantOf(id),
    resolveVariant: (t, s, u) => configuratorService.resolveVariant(t, s, u),
  }
);
// Konfigurator 4c: the row lock and the configurator's derivation are wired
// as in app.ts, so a configured row's Skapa TO succeeds here.
const mfgService = createManufacturingService(
  createManufacturingRepository(db),
  testDocumentPdfService,
  testArticleService,
  {
    findRowForManufacturing: salesRepository.findRowForManufacturing,
    lockRowForManufacturing: salesRepository.lockRowForManufacturing,
    markInProduction: markSalesOrderInProduction,
  },
  undefined,
  (t, s, q, o) => configuratorService.deriveForManufacturing(t, s, q, o)
);
const planningService = createPlanningService(createPlanningRepository(db), {
  purchase: purchaseService,
  manufacturing: mfgService,
  configuredStructure: (t, s, q, o) => configuratorService.deriveForManufacturing(t, s, q, o),
  requirementsCacheMs: 0,
});
const configuratorRepo = createConfiguratorRepository();

const TRUNCATE = sql`TRUNCATE configurator_variants, configurator_rules, configurator_values, configurator_groups, configurator_templates, holidays, inquiry_rows, inquiries, purchase_order_rows, purchase_orders, article_suppliers, suppliers, sales_order_rows, sales_orders, customers, mo_material_consumptions, mo_operations, manufacturing_orders, routing_operations, work_centers, stock_transactions, stock_locations, warehouses, bom_components, articles, article_groups, api_clients, users CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
});
afterAll(async () => {
  await db.execute(TRUNCATE);
});

async function makeUser() {
  return authRepo.create({
    email: `guard-${crypto.randomUUID()}@example.com`,
    passwordHash: "not-a-real-hash",
    name: "Guard",
    role: "admin",
  });
}
const makeCustomer = () => salesService.createCustomer({ name: "Kund AB", active: true });
const makeSupplier = () => purchaseService.createSupplier({ name: "Leverantör AB", active: true });

// A manufactured article that is a template in the given mode.
async function template(mode: "variants" | "to_order") {
  const article = await makeArticle({ salesPrice: 1000 });
  await configuratorService.createTemplate(article.id, { mode });
  return article;
}

describe("assertOrderableArticle", () => {
  it("refuses a variants template with the article number in the message", () => {
    expect(() => assertOrderableArticle({ articleNumber: "63000", configuratorMode: "variants" })).toThrow(
      new ArticleIsTemplateError("63000")
    );
    const err = new ArticleIsTemplateError("63000");
    expect(err.message).toBe("63000 är en mall — välj en variant");
    expect(err.name).toBe("ArticleIsTemplateError");
  });

  it("lets a to_order template and a plain article through", () => {
    expect(() => assertOrderableArticle({ articleNumber: "A", configuratorMode: "to_order" })).not.toThrow();
    expect(() => assertOrderableArticle({ articleNumber: "A", configuratorMode: null })).not.toThrow();
  });
});

describe("mallar i variantläge på nya orderrader", () => {
  it("refuses a quote row on the template but takes a configured to_order template and a plain article", async () => {
    const customer = await makeCustomer();
    const mall = await template("variants");
    const bestallningsvara = await template("to_order");
    const plain = await makeArticle({ salesPrice: 100 });

    const attempt = salesService.createQuote(
      { customerId: customer.id, confirm: false, rows: [{ articleId: mall.id, quantity: 1, unitPrice: 100 }] },
      null
    );
    const err = await attempt.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ArticleIsTemplateError);
    expect((err as Error).message).toBe(`${mall.articleNumber} är en mall — välj en variant`);

    // Konfigurator 4b: a beställningsvara is orderable, but only with a
    // configuration (an empty selection is valid on a template without groups).
    await expect(
      salesService.createQuote(
        { customerId: customer.id, confirm: false, rows: [{ articleId: bestallningsvara.id, quantity: 1, unitPrice: 100 }] },
        null
      )
    ).rejects.toBeInstanceOf(ConfigurationRequiredError);
    const ok = await salesService.createQuote(
      {
        customerId: customer.id,
        confirm: false,
        rows: [
          { articleId: bestallningsvara.id, quantity: 1, unitPrice: 100, configuration: { selection: {} } },
          { articleId: plain.id, quantity: 1, unitPrice: 100 },
        ],
      },
      null
    );
    expect(ok.rows).toHaveLength(2);
  });

  it("refuses the template on KO addRow", async () => {
    const customer = await makeCustomer();
    const mall = await template("variants");
    const plain = await makeArticle({ salesPrice: 100 });
    const { order } = await salesService.createQuote(
      { customerId: customer.id, confirm: false, rows: [{ articleId: plain.id, quantity: 1, unitPrice: 100 }] },
      null
    );
    await expect(salesService.addRow(order.id, { articleId: mall.id, quantity: 1, unitPrice: 100 }, null)).rejects.toBeInstanceOf(
      ArticleIsTemplateError
    );
  });

  it("refuses the template on IO addRow, createInquiry and addInquiryRow", async () => {
    const user = await makeUser();
    const supplier = await makeSupplier();
    const mall = await template("variants");
    const plain = await makeArticle();

    const po = await purchaseService.createPurchaseOrder({ supplierId: supplier.id, exchangeRate: 1 }, user.id);
    await expect(purchaseService.addRow(po.id, { articleId: mall.id, quantity: 1, unitPrice: 10 }, user.id)).rejects.toBeInstanceOf(
      ArticleIsTemplateError
    );
    await purchaseService.addRow(po.id, { articleId: plain.id, quantity: 1, unitPrice: 10 }, user.id);

    await expect(
      purchaseService.createInquiry({ supplierId: supplier.id, rows: [{ articleId: mall.id, quantity: 1 }] }, user.id)
    ).rejects.toBeInstanceOf(ArticleIsTemplateError);

    const { inquiry } = await purchaseService.createInquiry(
      { supplierId: supplier.id, rows: [{ articleId: plain.id, quantity: 1 }] },
      user.id
    );
    await expect(purchaseService.addInquiryRow(inquiry.id, { articleId: mall.id, quantity: 1 })).rejects.toBeInstanceOf(
      ArticleIsTemplateError
    );
  });

  it("refuses the template on createManufacturingOrder", async () => {
    const mall = await template("variants");
    await expect(mfgService.createManufacturingOrder({ articleId: mall.id, quantity: 1 }, null)).rejects.toBeInstanceOf(
      ArticleIsTemplateError
    );
    // Konfigurator 4c: a beställningsvara needs its choices (see the to_order describe below).
    const bestallningsvara = await template("to_order");
    await expect(mfgService.createManufacturingOrder({ articleId: bestallningsvara.id, quantity: 1 }, null)).rejects.toBeInstanceOf(
      ConfigurationRequiredError
    );
  });

  it("refuses Skapa TO on a KO row that predates the mode, but still lets the row's quantity change", async () => {
    const customer = await makeCustomer();
    const article = await makeArticle({ salesPrice: 100 });
    const { order, rows } = await salesService.createQuote(
      { customerId: customer.id, confirm: true, rows: [{ articleId: article.id, quantity: 5, unitPrice: 100 }] },
      null
    );
    await configuratorService.createTemplate(article.id, { mode: "variants" });

    await expect(mfgService.createFromSalesOrderRow(rows[0]!.id, {}, null)).rejects.toBeInstanceOf(ArticleIsTemplateError);

    const updated = await salesService.updateRow(order.id, rows[0]!.id, { quantity: 7, unitPrice: 100 }, null);
    expect(Number(updated.row.quantityOrdered)).toBe(7);
  });

  it("listArticles({ orderable: true }) hides templates in both modes", async () => {
    const mall = await template("variants");
    const bestallningsvara = await template("to_order");
    const plain = await makeArticle();

    const all = await articleService.listArticles(listArticlesQuerySchema.parse({}));
    expect(all.total).toBe(3);
    expect(all.rows.find((r) => r.id === mall.id)?.configuratorMode).toBe("variants");
    expect(all.rows.find((r) => r.id === plain.id)?.configuratorMode).toBeNull();

    const orderable = await articleService.listArticles(listArticlesQuerySchema.parse({ orderable: "true" }));
    expect(orderable.total).toBe(1);
    expect(orderable.rows.map((r) => r.id)).toEqual([plain.id]);
    expect(orderable.rows.some((r) => r.id === bestallningsvara.id)).toBe(false);

    const article = await articleService.getArticle(mall.id);
    expect(article?.configuratorMode).toBe("variants");
  });

  it("listArticles({ orderable: true, configurable: true }) lists the variants template again, with its mode", async () => {
    const mall = await template("variants");
    const bestallningsvara = await template("to_order");
    const plain = await makeArticle();
    const both = await articleService.listArticles(listArticlesQuerySchema.parse({ orderable: "true", configurable: "true" }));
    expect(both.rows.map((r) => r.id).sort()).toEqual([bestallningsvara.id, mall.id, plain.id].sort());
    expect(both.rows.find((r) => r.id === mall.id)!.configuratorMode).toBe("variants");
    // configurable alone changes nothing: the unfiltered list already has all three.
    const alone = await articleService.listArticles(listArticlesQuerySchema.parse({ configurable: "true" }));
    expect(alone.total).toBe(3);
    const hidden = await articleService.listArticles(listArticlesQuerySchema.parse({ orderable: "true" }));
    expect(hidden.rows.map((r) => r.id)).toEqual([plain.id]);
  });

  it("Skapa ordrar reports the template as an error row and creates nothing for it", async () => {
    const user = await makeUser();
    const mall = await template("variants");
    const plain = await makeArticle();

    const result = await planningService.createOrdersFromProposals(
      {
        proposals: [
          { articleId: mall.id, quantity: 3, kind: "manufacture" },
          { articleId: plain.id, quantity: 2, kind: "manufacture" },
        ],
      },
      user.id
    );

    expect(result.errors).toEqual([
      { articleId: mall.id, articleNumber: mall.articleNumber, message: `${mall.articleNumber} är en mall — välj en variant` },
    ]);
    expect(result.manufacturingOrders.map((o) => o.articleNumber)).toEqual([plain.articleNumber]);
    const orders = await mfgService.listManufacturingOrders({ limit: 50, offset: 0 } as never);
    expect(orders.rows.map((o) => o.articleId)).toEqual([plain.id]);
  });
});

describe("routes map ArticleIsTemplateError to 409 article-is-template", () => {
  const app = buildApp();
  const authService = createAuthService(createAuthRepository(db), "unused", createAuditRepository(db));
  const oauthService = createOAuthService(createOAuthRepository(db), "unused");

  afterAll(async () => {
    await app.close();
  });

  async function adminSession() {
    const email = `guard-${crypto.randomUUID()}@example.com`;
    const user = await authService.createUser({ email, password: "correcthorse", name: "G", role: "admin", permissionGroupId: null });
    const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: "correcthorse" } });
    const cookie = res.cookies.find((c) => c.name === "session")!;
    return { user, cookie: `session=${cookie.value}` };
  }

  function expectTemplateRefusal(res: { statusCode: number; json: () => unknown }, articleNumber: string) {
    expect({ status: res.statusCode, body: res.json() }).toEqual({
      status: 409,
      body: { error: `${articleNumber} är en mall — välj en variant`, code: "article-is-template" },
    });
  }

  it("POST /quotes refuses the template for a human session", async () => {
    const { cookie } = await adminSession();
    const customer = await makeCustomer();
    const mall = await template("variants");
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/quotes",
      headers: { cookie },
      payload: { customerId: customer.id, rows: [{ articleId: mall.id, quantity: 1, unitPrice: 100 }] },
    });
    expectTemplateRefusal(res, mall.articleNumber);
  });

  it("oauth POST /quotes refuses template", async () => {
    const user = await makeUser();
    const { client, clientSecret } = await oauthService.createApiClient({ name: "Konfigurator" }, user.id);
    const token = await app.inject({ method: "POST", url: "/api/v1/oauth/token", payload: { clientId: client.id, clientSecret } });
    expect(token.statusCode).toBe(200);
    const { accessToken } = token.json() as { accessToken: string };

    const customer = await makeCustomer();
    const mall = await template("variants");
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/quotes",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { customerId: customer.id, rows: [{ articleId: mall.id, quantity: 1, unitPrice: 100 }] },
    });
    expectTemplateRefusal(res, mall.articleNumber);
  });

  // Konfigurator 4b: a to_order template IS orderable — with a configuration.
  it("POST /quotes with a configuration on a to_order template works for session and OAuth; without one it is 409 configuration-required", async () => {
    const { cookie } = await adminSession();
    const customer = await makeCustomer();
    const bestallningsvara = await template("to_order");
    const lock = await configuratorService.createGroup(bestallningsvara.id, { code: "LOCK", name: "Lås", kind: "choice", required: true });
    await configuratorService.createValue(bestallningsvara.id, lock.id, { code: "A", name: "Lås A", priceAdd: 0, active: true });
    const ok = await app.inject({
      method: "POST",
      url: "/api/v1/quotes",
      headers: { cookie },
      payload: { customerId: customer.id, rows: [{ articleId: bestallningsvara.id, quantity: 1, configuration: { selection: { LOCK: "A" } } }] },
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().rows[0].configuration.key).toBeTruthy();
    const missing = await app.inject({
      method: "POST",
      url: "/api/v1/quotes",
      headers: { cookie },
      payload: { customerId: customer.id, rows: [{ articleId: bestallningsvara.id, quantity: 1 }] },
    });
    expect([missing.statusCode, missing.json().code]).toEqual([409, "configuration-required"]);
    const invalid = await app.inject({
      method: "POST",
      url: `/api/v1/sales-orders/${ok.json().order.id}/rows`,
      headers: { cookie },
      payload: { articleId: bestallningsvara.id, quantity: 1, configuration: { selection: {} } },
    });
    expect([invalid.statusCode, invalid.json().code, invalid.json().details.length > 0]).toEqual([400, "configurator-invalid-configuration", true]);
    const notAllowed = await app.inject({
      method: "POST",
      url: `/api/v1/sales-orders/${ok.json().order.id}/rows`,
      headers: { cookie },
      payload: { articleId: (await makeArticle()).id, quantity: 1, configuration: { selection: {} } },
    });
    expect([notAllowed.statusCode, notAllowed.json().code]).toEqual([400, "configuration-not-allowed"]);

    // OAuth (the external configurator) goes through the same route — but
    // only for a template published for the API (delprojekt 5).
    const user = await makeUser();
    const { client, clientSecret } = await oauthService.createApiClient({ name: "Konfigurator" }, user.id);
    const token = await app.inject({ method: "POST", url: "/api/v1/oauth/token", payload: { clientId: client.id, clientSecret } });
    const { accessToken } = token.json() as { accessToken: string };
    const unpublished = await app.inject({
      method: "POST",
      url: "/api/v1/quotes",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { customerId: customer.id, rows: [{ articleId: bestallningsvara.id, quantity: 1, configuration: { selection: { LOCK: "A" } } }] },
    });
    expect([unpublished.statusCode, unpublished.json().code]).toEqual([409, "configurator-not-published"]);
    await configuratorService.updateTemplate(bestallningsvara.id, { published: true });
    const viaOauth = await app.inject({
      method: "POST",
      url: "/api/v1/quotes",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { customerId: customer.id, rows: [{ articleId: bestallningsvara.id, quantity: 1, configuration: { selection: { LOCK: "A" } } }] },
    });
    expect(viaOauth.statusCode).toBe(201);
    expect(viaOauth.json().rows[0].configuration.key).toBe(ok.json().rows[0].configuration.key);
  });

  it("KO rows, IO rows, inquiries, TO and Skapa TO all answer 409", async () => {
    const { user, cookie } = await adminSession();
    const customer = await makeCustomer();
    const supplier = await makeSupplier();
    const mall = await template("variants");
    const plain = await makeArticle({ salesPrice: 100 });
    const post = (url: string, payload: unknown) =>
      app.inject({ method: "POST", url: `/api/v1${url}`, headers: { cookie }, payload: payload as never });

    const { order } = await salesService.createQuote(
      { customerId: customer.id, confirm: false, rows: [{ articleId: plain.id, quantity: 1, unitPrice: 100 }] },
      null
    );
    expectTemplateRefusal(await post(`/sales-orders/${order.id}/rows`, { articleId: mall.id, quantity: 1, unitPrice: 100 }), mall.articleNumber);

    const po = await purchaseService.createPurchaseOrder({ supplierId: supplier.id, exchangeRate: 1 }, user.id);
    expectTemplateRefusal(await post(`/purchase-orders/${po.id}/rows`, { articleId: mall.id, quantity: 1, unitPrice: 10 }), mall.articleNumber);

    expectTemplateRefusal(
      await post("/inquiries", { supplierId: supplier.id, rows: [{ articleId: mall.id, quantity: 1 }] }),
      mall.articleNumber
    );
    const { inquiry } = await purchaseService.createInquiry({ supplierId: supplier.id, rows: [{ articleId: plain.id, quantity: 1 }] }, user.id);
    expectTemplateRefusal(await post(`/inquiries/${inquiry.id}/rows`, { articleId: mall.id, quantity: 1 }), mall.articleNumber);

    expectTemplateRefusal(await post("/manufacturing-orders", { articleId: mall.id, quantity: 1 }), mall.articleNumber);

    // Skapa TO from a KO row that was created before the article became a template.
    const legacy = await makeArticle({ salesPrice: 100 });
    const confirmed = await salesService.createQuote(
      { customerId: customer.id, confirm: true, rows: [{ articleId: legacy.id, quantity: 2, unitPrice: 100 }] },
      null
    );
    await configuratorService.createTemplate(legacy.id, { mode: "variants" });
    expectTemplateRefusal(
      await post(`/sales-orders/${confirmed.order.id}/rows/${confirmed.rows[0]!.id}/manufacturing-order`, {}),
      legacy.articleNumber
    );
  });
});

describe("låset vid typbyte", () => {
  it("refuses a type change the mode does not allow, also through the batch", async () => {
    const mall = await template("variants");
    await expect(articleService.updateArticle(mall.id, { type: "purchased" })).rejects.toBeInstanceOf(ConfiguratorModeNotAllowedError);
    await expect(articleService.updateArticle(mall.id, { isPhantom: true })).rejects.toBeInstanceOf(ConfiguratorModeNotAllowedError);
    const batch = await articleService.updateArticlesBatch([{ id: mall.id, type: "service" }]);
    expect(batch.results).toEqual([
      { id: mall.id, ok: false, error: { code: "configurator-mode-not-allowed", message: "Variantartiklar kräver en tillverkad artikel" } },
    ]);
    // Unrelated fields still save, and the type is untouched.
    const saved = await articleService.updateArticle(mall.id, { name: "Ny benämning", type: "manufactured" });
    expect(saved?.name).toBe("Ny benämning");
    expect(saved?.type).toBe("manufactured");
  });

  it("waits for a template writer holding the article FOR SHARE, then refuses", async () => {
    const mall = await template("variants");

    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => (locked = resolve));
    // What createVariants does: template FOR UPDATE, then the article FOR SHARE, held for the whole transaction.
    const holder = db.transaction(async (tx) => {
      await configuratorRepo.lockTemplate(tx, mall.id);
      await configuratorRepo.templateArticleRow(tx, mall.id, "share");
      locked();
      await gate;
    });
    await lockTaken;

    let settled = false;
    const update = articleService
      .updateArticle(mall.id, { type: "purchased" })
      .then(() => "resolved" as const, (err: unknown) => err)
      .finally(() => (settled = true));
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(settled).toBe(false);
    } finally {
      // Always let the holder commit — a failed assertion must not leave the
      // locks behind for the next TRUNCATE to wait on.
      release();
      await holder;
    }
    expect(await update).toBeInstanceOf(ConfiguratorModeNotAllowedError);
    expect(settled).toBe(true);
  });
});

const SEL = { selection: { LOCK: "A", BREDD: 800 } };

describe("to_order template (4b/4c): a TO needs the choices, purchasing is refused", () => {
  const app = buildApp();
  const authService = createAuthService(createAuthRepository(db), "unused", createAuditRepository(db));
  afterAll(async () => {
    await app.close();
  });
  async function adminSession() {
    const email = `guard-${crypto.randomUUID()}@example.com`;
    const user = await authService.createUser({ email, password: "correcthorse", name: "G", role: "admin", permissionGroupId: null });
    const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: "correcthorse" } });
    return { user, cookie: `session=${res.cookies.find((c) => c.name === "session")!.value}` };
  }

  it("refuses createManufacturingOrder and Skapa ordrar without choices; Skapa TO from a configured row creates a configured TO", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    const { article } = await buildToOrder();
    const err = await mfgService.createManufacturingOrder({ articleId: article.id, quantity: 1 }, user.id).catch((e) => e);
    expect(err).toBeInstanceOf(ConfigurationRequiredError);
    expect((err as Error).message).toBe(`${article.articleNumber} är en beställningsvara — konfigurera den`);

    const { rows } = await salesService.createQuote(
      { customerId: customer.id, confirm: true, rows: [{ articleId: article.id, quantity: 2, configuration: SEL }] } as never,
      user.id
    );
    const mo = await mfgService.createFromSalesOrderRow(rows[0]!.id, {}, user.id);
    expect(mo.configuration).toMatchObject({ templateArticleId: article.id, key: (rows[0]!.configuration as { key: string }).key });

    // Planning's Skapa ordrar lands in the same createManufacturingOrder
    // without choices — Task 4 gives the configured rows their own path.
    const result = await planningService.createOrdersFromProposals(
      { proposals: [{ articleId: article.id, quantity: 3, kind: "manufacture" }] } as never,
      user.id
    );
    expect(result.errors).toEqual([
      { articleId: article.id, articleNumber: article.articleNumber, message: `${article.articleNumber} är en beställningsvara — konfigurera den` },
    ]);
    expect(result.manufacturingOrders).toEqual([]);
  });

  it("refuses IO addRow, createInquiry and addInquiryRow with the beställningsvara text", async () => {
    const user = await makeUser();
    const supplier = await makeSupplier();
    const { article } = await buildToOrder();
    const expectRefusal = async (p: Promise<unknown>) => {
      const err = await p.catch((e) => e);
      expect(err).toBeInstanceOf(ArticleIsTemplateError);
      expect((err as Error).message).toBe(`${article.articleNumber} är en beställningsvara och kan inte köpas`);
    };
    const po = await purchaseService.createPurchaseOrder({ supplierId: supplier.id, exchangeRate: 1 }, user.id);
    await expectRefusal(purchaseService.addRow(po.id, { articleId: article.id, quantity: 1, unitPrice: 10 }, user.id));
    await expectRefusal(purchaseService.createInquiry({ supplierId: supplier.id, rows: [{ articleId: article.id, quantity: 1 }] }, user.id));
    const plain = await makeArticle();
    const { inquiry } = await purchaseService.createInquiry({ supplierId: supplier.id, rows: [{ articleId: plain.id, quantity: 1 }] }, user.id);
    await expectRefusal(purchaseService.addInquiryRow(inquiry.id, { articleId: article.id, quantity: 1 }));
  });

  it("routes: TO without choices 409, Skapa TO on a configured row 201 with configuration, IO row and inquiry 409", async () => {
    const { user, cookie } = await adminSession();
    const customer = await makeCustomer();
    const supplier = await makeSupplier();
    const { article } = await buildToOrder();
    const to = await app.inject({ method: "POST", url: "/api/v1/manufacturing-orders", headers: { cookie }, payload: { articleId: article.id, quantity: 1 } });
    expect([to.statusCode, to.json().code]).toEqual([409, "configuration-required"]);
    const { order, rows } = await salesService.createQuote(
      { customerId: customer.id, confirm: true, rows: [{ articleId: article.id, quantity: 1, configuration: SEL }] } as never,
      user.id
    );
    const skapaTo = await app.inject({ method: "POST", url: `/api/v1/sales-orders/${order.id}/rows/${rows[0]!.id}/manufacturing-order`, headers: { cookie }, payload: {} });
    expect(skapaTo.statusCode).toBe(201);
    expect(skapaTo.json().configuration).toMatchObject({ templateArticleId: article.id });
    // The detail GET returns the column as it is.
    const detail = await app.inject({ method: "GET", url: `/api/v1/manufacturing-orders/${skapaTo.json().id}`, headers: { cookie } });
    expect(detail.json().configuration).toMatchObject({ templateArticleId: article.id, cost: { manufacturingCostPerUnit: null } });
    const po = await purchaseService.createPurchaseOrder({ supplierId: supplier.id, exchangeRate: 1 }, user.id);
    const ioRow = await app.inject({ method: "POST", url: `/api/v1/purchase-orders/${po.id}/rows`, headers: { cookie }, payload: { articleId: article.id, quantity: 1, unitPrice: 10 } });
    expect([ioRow.statusCode, ioRow.json().code, ioRow.json().error]).toEqual([409, "article-is-template", `${article.articleNumber} är en beställningsvara och kan inte köpas`]);
    const inquiry = await app.inject({ method: "POST", url: "/api/v1/inquiries", headers: { cookie }, payload: { supplierId: supplier.id, rows: [{ articleId: article.id, quantity: 1 }] } });
    expect([inquiry.statusCode, inquiry.json().code]).toEqual([409, "article-is-template"]);
  });

  // Konfigurator 4c: a configured row IS demand on the template in both
  // readers (the TO made for the row is the template's supply), but the
  // template is never proposed — the row gets its own "configured" proposal.
  it("a configured row is demand on the template in the MRP and the overview, never a proposal; the invariant holds", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    const { article } = await buildToOrder();
    const plain = await makeArticle({ salesPrice: 100 });
    const { rows } = await salesService.createQuote(
      {
        customerId: customer.id,
        confirm: true,
        rows: [
          { articleId: article.id, quantity: 4, configuration: SEL },
          { articleId: plain.id, quantity: 3, unitPrice: 100 },
        ],
      } as never,
      user.id
    );
    const mrp = await planningService.listRequirements({ limit: 1000, offset: 0, refresh: true, showAll: true } as never);
    const templateRow = mrp.rows.find((r) => r.articleId === article.id && r.proposalKind !== "configured")!;
    expect(templateRow).toMatchObject({ demandSales: 4, projected: -4, proposalQuantity: 0, proposalKind: null, configuredTemplate: true });
    expect(mrp.rows.find((r) => r.proposalKind === "configured")).toMatchObject({
      articleId: article.id,
      salesOrderRowId: rows[0]!.id,
      proposalQuantity: 4,
      configurationError: null,
    });
    expect(mrp.rows.find((r) => r.articleId === plain.id)!.demandSales).toBe(3);
    const overview = await planningService.getArticleOverview(article.id);
    expect(overview.rows.filter((r) => r.kind === "sales_order").map((r) => r.quantity)).toEqual([-4]);
    expect(overview.closingBalance).toBe(templateRow.projected - templateRow.demandDerived);
  });
});

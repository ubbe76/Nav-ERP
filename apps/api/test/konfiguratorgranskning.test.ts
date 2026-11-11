import { createSupplierSchema, type OrderRowConfiguration } from "@navet/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { articles, bomComponents, customerPrices, db } from "@navet/db";
import { buildApp } from "../src/app.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createAuthService } from "../src/modules/auth/service/auth.service.js";
import { createCostingRepository } from "../src/modules/costing/repository/costing.repository.js";
import { createCostingService } from "../src/modules/costing/service/costing.service.js";
import { ConfiguratorInvalidConfigurationError, InvalidConfiguratorLineError } from "../src/modules/configurator/service/configurator.errors.js";
import { COSTING_ONLY_OPERATION_LINK } from "../src/modules/configurator/service/configurator-rules.js";
import { selectionFromEntries } from "../src/modules/configurator/service/variant-identity.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import { createManufacturingService } from "../src/modules/manufacturing/service/manufacturing.service.js";
import { resolvePrice } from "../src/modules/sales/service/price-resolver.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { ExchangeRateUnavailableError, type ExchangeRateReader } from "../src/modules/system/service/exchange-rates.js";
import { makeArticle, makeVariantService, testCostingSettings } from "./helpers/configurator.js";
import {
  buildToOrder, buildVariants, configurator, makeCustomer, purchaseService, resetConfiguredRows, salesService,
} from "./helpers/configured-rows.js";
import { parsed } from "./helpers/parsed.js";
import { testArticleService, testDocumentPdfService } from "./helpers/services.js";
import { unwiredSalesOrderLinks } from "./helpers/unwired";

// Konfiguratorgranskningen 2026-11-11 — the six findings:
// 1. a malformed selection on a variants template is 400 configurator-invalid-configuration on every row path (was 500);
// 2. an empty stored entry whose group was renamed/deleted no longer makes the row/variant unusable;
// 3. variantPrice compares the key (a förval added since ⇒ the variant's own chain);
// 4. the variant costing inside the template transaction never calls getRate;
// 5. a structure line may not draw at a Kalkyl operation (and an old link reads as unlinked);
// 6. the preview's "exists" row shows the stored variant.

const mfgService = createManufacturingService(createManufacturingRepository(db), testDocumentPdfService, testArticleService, unwiredSalesOrderLinks);

async function reset() {
  await resetConfiguredRows();
  await db.execute(sql`TRUNCATE work_centers, suppliers CASCADE`);
  Object.assign(testCostingSettings, {
    costingMaterialSource: "standard", costingMoPercent: 0, costingLoPercent: 0, costingAffoPercent: 0, costingGeneralMarkupPercent: 0,
  });
}
beforeEach(reset);
afterAll(reset);

const SEL = { LOCK: "B", BREDD: 1200 };
const cfgOf = (row: { configuration: unknown }) => row.configuration as OrderRowConfiguration;

describe("1. a malformed selection on a variants template is 400, never 500", () => {
  const app = buildApp();
  const authService = createAuthService(createAuthRepository(db), "unused", createAuditRepository(db));

  beforeAll(async () => {
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  async function session() {
    const email = `granskning-${crypto.randomUUID()}@example.com`;
    await authService.createUser({ email, password: "correcthorse", name: "Granskning", role: "admin", permissionGroupId: null });
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: "correcthorse" } });
    return { cookie: `session=${login.cookies.find((c) => c.name === "session")!.value}` };
  }

  it("POST /quotes, POST rows and PUT …/configuration answer 400 configurator-invalid-configuration with the message as details", async () => {
    const headers = await session();
    const { template } = await buildVariants();
    const c = await makeCustomer();
    const quote = (selection: unknown) =>
      app.inject({
        method: "POST", url: "/api/v1/quotes", headers,
        payload: { customerId: c.id, rows: [{ articleId: template.id, quantity: 1, configuration: { selection } }] } as never,
      });

    const unknownGroup = await quote({ ...SEL, NOPE: "X" });
    expect([unknownGroup.statusCode, unknownGroup.json().code, unknownGroup.json().details]).toEqual([
      400, "configurator-invalid-configuration", ["Valgruppen NOPE finns inte"],
    ]);
    const wrongType = await quote({ LOCK: 5, BREDD: 1200 });
    expect([wrongType.statusCode, wrongType.json().code, wrongType.json().details]).toEqual([
      400, "configurator-invalid-configuration", ["Lås tar alternativkoder"],
    ]);
    const unknownAlternative = await quote({ LOCK: "Q", BREDD: 1200 });
    expect([unknownAlternative.statusCode, unknownAlternative.json().code]).toEqual([400, "configurator-invalid-configuration"]);

    // A valid quote, then the row routes with the same malformed selections.
    const ok = await quote(SEL);
    expect(ok.statusCode).toBe(201);
    const orderId = ok.json().order.id as string;
    const variantRow = ok.json().rows[0] as { id: string };
    const addRow = await app.inject({
      method: "POST", url: `/api/v1/sales-orders/${orderId}/rows`, headers,
      payload: { articleId: template.id, quantity: 1, configuration: { selection: { ...SEL, NOPE: "X" } } },
    });
    expect([addRow.statusCode, addRow.json().code, addRow.json().details]).toEqual([400, "configurator-invalid-configuration", ["Valgruppen NOPE finns inte"]]);
    const reconfigure = await app.inject({
      method: "PUT", url: `/api/v1/sales-orders/${orderId}/rows/${variantRow.id}/configuration`, headers,
      payload: { selection: { LOCK: true, BREDD: 1200 } },
    });
    expect([reconfigure.statusCode, reconfigure.json().code]).toEqual([400, "configurator-invalid-configuration"]);

    // Konfigurera's own route answers the same (it was invalid-configurator-variant-set without details).
    const resolve = await app.inject({ method: "POST", url: `/api/v1/configurator/${template.id}/variant`, headers, payload: { selection: { NOPE: "A" } } });
    expect([resolve.statusCode, resolve.json().code, resolve.json().details]).toEqual([400, "configurator-invalid-configuration", ["Valgruppen NOPE finns inte"]]);
  });

  it("an empty value in a group the template does not have is ignored in both modes; a filled one is still refused", async () => {
    const { template } = await buildVariants();
    const { article: toOrder } = await buildToOrder();
    const viaVariant = await configurator.resolveVariant(template.id, { ...SEL, GONE: null, OLD: false }, null);
    expect(viaVariant.article.articleNumber).toBe(`${template.articleNumber}-B-1200`);
    await expect(configurator.resolveVariant(template.id, { ...SEL, GONE: "X" }, null)).rejects.toBeInstanceOf(ConfiguratorInvalidConfigurationError);
    await expect(configurator.resolveVariant(template.id, { ...SEL, GONE: true }, null)).rejects.toBeInstanceOf(ConfiguratorInvalidConfigurationError);

    const lenient = await configurator.evaluate(toOrder.id, { selection: { ...SEL, GONE: null, OLD: false }, quantity: 1 });
    expect([lenient.valid, lenient.errors]).toEqual([true, []]);
    for (const value of ["X", true, 0]) {
      const strict = await configurator.evaluate(toOrder.id, { selection: { ...SEL, GONE: value }, quantity: 1 });
      expect([strict.valid, strict.errors]).toEqual([false, ["Okänd valgrupp: GONE"]]);
    }
  });
});

describe("2. empty stored entries survive a rename/delete of their group (the code lock lets it happen)", () => {
  it("beställningsvara: the quantity change, the derivation (Skapa TO, planning) and the web's evaluate keep working", async () => {
    const { article } = await buildToOrder();
    // An optional list group without a default — stored as null on the row.
    const farg = await configurator.createGroup(article.id, { code: "FARG", name: "Färg", kind: "choice", required: false });
    await configurator.createValue(article.id, farg.id, { code: "RD", name: "Röd", priceAdd: 0, active: true });
    const c = await makeCustomer();
    const { order, rows } = await salesService.createQuote(
      { customerId: c.id, rows: [{ articleId: article.id, quantity: 1, configuration: { selection: SEL } }] } as never,
      null
    );
    const stored = cfgOf(rows[0]!);
    expect(stored.selection.map((e) => [e.groupCode, e.value])).toEqual([
      ["LOCK", "B"], ["AVLOPP", false], ["BREDD", 1200], ["FARG", null],
    ]);

    // Neither group is in the key, so the code lock lets them go.
    const avlopp = (await configurator.getTemplate(article.id)).groups.find((g) => g.code === "AVLOPP")!;
    await configurator.updateGroup(article.id, avlopp.id, { code: "AVL" });
    await configurator.deleteGroup(article.id, farg.id);

    const updated = await salesService.updateRow(order.id, rows[0]!.id, { quantity: 3 } as never);
    expect(Number(updated.row.quantityOrdered)).toBe(3);
    expect(Number(updated.row.unitPrice)).toBe(1050);

    const selection = selectionFromEntries(stored.selection);
    const derived = await configurator.deriveForManufacturing(article.id, selection, 3, { withCost: false });
    expect([derived.valid, derived.errors, derived.key]).toEqual([true, [], stored.key]);
    const evaluated = await configurator.evaluate(article.id, { selection, quantity: 3 });
    expect([evaluated.valid, evaluated.key]).toEqual([true, stored.key]);
  });

  it("variant: variantPrice still prices through the template after the empty groups were renamed/deleted", async () => {
    const { template } = await buildVariants();
    const hjul = await configurator.createGroup(template.id, { code: "HJUL", name: "Hjul", kind: "boolean", priceAdd: 25 });
    const farg = await configurator.createGroup(template.id, { code: "FARG", name: "Färg", kind: "choice", required: false });
    await configurator.createValue(template.id, farg.id, { code: "RD", name: "Röd", priceAdd: 0, active: true });
    const { article: variant } = await configurator.resolveVariant(template.id, SEL, null);
    const c = await makeCustomer();
    await db.insert(customerPrices).values({ customerId: c.id, articleId: template.id, fromQuantity: "1", unitPrice: "900", discountPercent: null });
    const q = { customerId: c.id, variantArticleId: variant.id, quantity: 1 };
    expect(await configurator.variantPrice(q)).toEqual({ unitPrice: 950, discountPercent: 0, source: "customer_article" });

    await configurator.updateGroup(template.id, hjul.id, { code: "HJUL2" });
    await configurator.deleteGroup(template.id, farg.id);
    // The template's customer price (900) plus Lås B — not the variant's own 1050.
    expect(await configurator.variantPrice(q)).toEqual({ unitPrice: 950, discountPercent: 0, source: "customer_article" });
  });
});

describe("3. variantPrice compares the key", () => {
  it("a förval added to the template after the variant was made ⇒ null, and the chain takes the variant's own price", async () => {
    const { template } = await buildVariants();
    const { article: variant } = await configurator.resolveVariant(template.id, SEL, null);
    const c = await makeCustomer();
    const q = { customerId: c.id, variantArticleId: variant.id, quantity: 1 };
    expect(await configurator.variantPrice(q)).toEqual({ unitPrice: 1050, discountPercent: 0, source: "article" });

    // The engine would now resolve the stored choices to MONTAGE=JA (+300) — a choice the variant does not have.
    const montage = await configurator.createGroup(template.id, { code: "MONTAGE", name: "Montage", kind: "choice", required: false });
    const ja = await configurator.createValue(template.id, montage.id, { code: "JA", name: "Med montage", priceAdd: 300, active: true });
    await configurator.updateGroup(template.id, montage.id, { defaultValueId: ja.id });
    await db.update(articles).set({ salesPrice: "1111" }).where(eq(articles.id, variant.id));

    expect(await configurator.variantPrice(q)).toBeNull();
    const chained = await resolvePrice(db, { customerId: c.id, articleId: variant.id, quantity: 1 }, { variantPrice: (vq) => configurator.variantPrice(vq) });
    expect(chained?.price).toMatchObject({ unitPrice: 1111, source: "article" });
  });
});

describe("4. the variant costing never calls getRate inside the template transaction", () => {
  // The probe: is the template row locked (by an open write transaction) when
  // getRate is called? FOR UPDATE NOWAIT in autocommit takes and releases the
  // lock at once, or fails with 55P03 while another transaction holds it.
  function probe(templateId: () => string) {
    const calls: { currency: string; date: string; insideTransaction: boolean }[] = [];
    const rates: ExchangeRateReader = {
      async getRate(currency, date) {
        let insideTransaction = false;
        try {
          await db.execute(sql`select 1 from configurator_templates where article_id = ${templateId()} for update nowait`);
        } catch {
          insideTransaction = true;
        }
        calls.push({ currency, date, insideTransaction });
        if (currency !== "EUR") throw new ExchangeRateUnavailableError(currency, date);
        return { currency, requestedDate: date, date, rate: 11.5, source: "riksbank" };
      },
    };
    return { calls, rates };
  }

  async function setup(currency: string) {
    let templateId = "";
    const { calls, rates } = probe(() => templateId);
    const settings = { ...testCostingSettings, costingMaterialSource: "supplier" as const };
    const costing = createCostingService(createCostingRepository(db), { getSettings: async () => settings }, undefined, rates);
    const service = makeVariantService({ costing, rates, prices: (q) => resolvePrice(db, q) });

    const template = await makeArticle({ salesPrice: 1000 });
    templateId = template.id;
    await service.createTemplate(template.id, { mode: "variants" });
    const lock = await service.createGroup(template.id, { code: "LOCK", name: "Lås", kind: "choice", required: true });
    await service.createValue(template.id, lock.id, { code: "A", name: "Lås A", priceAdd: 0, active: true });
    await service.createValue(template.id, lock.id, { code: "B", name: "Lås B", priceAdd: 50, active: true });
    // 2 per unit of a part bought at 2.5 in the given currency (standard cost 7 = the fallback).
    const part = await testArticleService.createArticle({
      articleNumber: `DEL-${crypto.randomUUID().slice(0, 8)}`, name: "Beslag", type: "purchased", unit: "st", standardCost: 7,
    } as never);
    const supplier = await purchaseService.createSupplier(parsed(createSupplierSchema, { name: `Lev-${crypto.randomUUID()}`, active: true }));
    await purchaseService.addArticleSupplier(part.id, { supplierId: supplier.id, price: 2.5, currency, isPrimary: true });
    await testArticleService.addBomComponent(template.id, { componentArticleId: part.id, quantity: 2 } as never);
    return { service, template, calls };
  }
  const standardCostOf = async (id: string) => Number((await db.select().from(articles).where(eq(articles.id, id)))[0]!.standardCost);

  it("resolveVariant and createVariants fetch the rate before the transaction and cost with it inside", async () => {
    const { service, template, calls } = await setup("EUR");
    const { article, created } = await service.resolveVariant(template.id, { LOCK: "B" }, null);
    expect(created).toBe(true);
    // 2 × 2.5 EUR × 11.5 per unit.
    expect(await standardCostOf(article.id)).toBe(57.5);
    // Looked up once, outside the transaction; the costing in it only read the prefetched rate.
    expect(calls.map((c) => [c.currency, c.insideTransaction])).toEqual([["EUR", false]]);

    calls.length = 0;
    const [row] = await service.createVariants(template.id, { sets: { LOCK: ["A"] }, calcQuantity: 4 }, null);
    expect([row!.status, row!.standardCost]).toEqual(["created", 57.5]);
    expect(calls.map((c) => [c.currency, c.insideTransaction])).toEqual([["EUR", false]]);

    // An existing variant costs nothing: no lookup at all.
    calls.length = 0;
    expect((await service.resolveVariant(template.id, { LOCK: "B" }, null)).created).toBe(false);
    expect(calls).toEqual([]);
  });

  it("a currency without a rate falls back to the standard cost with a warning, still outside the transaction", async () => {
    const { service, template, calls } = await setup("USD");
    const [row] = await service.createVariants(template.id, { sets: { LOCK: ["A"] }, calcQuantity: 1 }, null);
    expect([row!.status, row!.standardCost]).toEqual(["created", 14]);
    expect(row!.warnings.join(" ")).toContain("USD");
    expect(calls.map((c) => [c.currency, c.insideTransaction])).toEqual([["USD", false]]);
  });
});

describe("5. a structure line may not draw at a Kalkyl operation", () => {
  it("the save refuses the link; a line linked before the operation became Kalkyl reads as unlinked with a warning", async () => {
    const { template } = await buildVariants();
    const wc = await mfgService.createWorkCenter({ code: "301", name: "Montering", type: "machine", hourlyRate: 0, overheadPercent: 0, capacityFactor: 1, active: true } as never);
    const op10 = await mfgService.createRoutingOperation(template.id, { sequenceNo: 10, workCenterId: wc.id, setupTime: 0, runTimePerUnit: 1 });
    const op20 = await mfgService.createRoutingOperation(template.id, { sequenceNo: 20, workCenterId: wc.id, setupTime: 0, runTimePerUnit: 1, costingOnly: true });
    const part = await makeArticle({ type: "purchased" });

    const refused = configurator.createBomLine(template.id, {
      conditions: [], source: "article", componentArticleId: part.id, quantity: 1, routingOperationId: op20.id,
    } as never);
    await expect(refused).rejects.toBeInstanceOf(InvalidConfiguratorLineError);
    await expect(refused).rejects.toThrow(COSTING_ONLY_OPERATION_LINK);

    // Linked to an ordinary operation, which is marked Kalkyl afterwards —
    // allowed, the manufacturing guard counts only bom_components.
    await configurator.createBomLine(template.id, {
      conditions: [], source: "article", componentArticleId: part.id, quantity: 1, routingOperationId: op10.id,
    } as never);
    await mfgService.updateRoutingOperation(template.id, op10.id, { costingOnly: true } as never);

    const [row] = await configurator.createVariants(template.id, { sets: { LOCK: ["B"], BREDD: [1200] }, calcQuantity: 1 }, null);
    expect(row!.status).toBe("created");
    expect(row!.warnings.join(" ")).toContain("kalkyloperation");
    const bom = await db.select().from(bomComponents).where(eq(bomComponents.parentArticleId, row!.articleId!));
    expect(bom.map((b) => [b.componentArticleId, b.routingOperationId, b.costingOnly])).toEqual([[part.id, null, false]]);

    // The test panel's derivation shows the same.
    const derived = await configurator.derive(template.id, { selection: SEL, quantity: 1 });
    const material = derived.structure.materials.find((m) => m.componentArticleId === part.id)!;
    expect(material.operation).toBeNull();
    expect(derived.structure.warnings.join(" ")).toContain("kalkyloperation");
  });
});

describe("6. the preview's existing row shows the stored variant", () => {
  it("number, name and prices are the variant's own, not what the template would spell today", async () => {
    const { template } = await buildVariants();
    const sets = { sets: { LOCK: ["B"], BREDD: [1200] }, calcQuantity: 1 };
    const [created] = await configurator.createVariants(template.id, sets, null);
    const ownNumber = `EGEN-${crypto.randomUUID().slice(0, 6)}`;
    await db
      .update(articles)
      .set({ articleNumber: ownNumber, name: "Papperskorg, egen benämning", salesPrice: "1234", standardCost: "99" })
      .where(eq(articles.id, created!.articleId!));

    const [row] = await configurator.previewVariants(template.id, sets);
    expect(row).toMatchObject({
      status: "exists", articleId: created!.articleId, articleNumber: ownNumber, name: "Papperskorg, egen benämning", salesPrice: 1234, standardCost: 99,
    });
  });
});

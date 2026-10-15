import { afterAll, beforeEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { ZodError } from "zod";
import { db } from "@navet/db";
import { configuratorRoutes } from "../src/modules/configurator/routes/configurator.routes.js";
import { publicConfiguratorRoutes } from "../src/modules/configurator/routes/public-configurator.routes.js";
import { createConfiguratorService } from "../src/modules/configurator/service/configurator.service.js";
import { rejectMalformedIds } from "../src/modules/system/middleware/reject-malformed-ids.js";
import { articleRoutes } from "../src/modules/article/routes/article.routes.js";
import { makeArticle, resetConfigurator, testCostingService, variantTestDeps } from "./helpers/configurator.js";
import { testArticleService, testDocumentPdfService } from "./helpers/services.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import { createManufacturingService } from "../src/modules/manufacturing/service/manufacturing.service.js";
import { sql } from "drizzle-orm";

const service = createConfiguratorService({
  db,
  prices: async () => ({ articleNumber: "X", price: { unitPrice: 900, discountPercent: 10, source: "customer_article" } }),
  customerExists: async (id) => id !== "00000000-0000-4000-8000-000000000000",
  articles: {
    exists: async (id) => (await testArticleService.getArticle(id)) != null,
    isDescendant: (articleId, ancestorId) => testArticleService.isDescendant(articleId, ancestorId),
    find: (id) => testArticleService.getArticle(id),
  },
  costing: testCostingService,
  ...variantTestDeps,
});

beforeEach(resetConfigurator);
afterAll(resetConfigurator);

function buildConfiguratorApp(opts: { user?: boolean } = {}) {
  const app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: "Validation failed", code: "validation-failed", issues: err.issues });
    }
    throw err;
  });
  app.addHook("preHandler", async (req) => {
    if (opts.user === false) return; // created_by is an FK, so variant creation tests run without a user row
    req.user = { id: crypto.randomUUID(), email: "test@example.com", name: "Testanvändare", role: "admin" } as never;
  });
  app.addHook("preHandler", rejectMalformedIds());
  app.register(configuratorRoutes, { service });
  // evaluate moved to the public routes (delprojekt 5); no req.apiClient here = a session.
  app.register(publicConfiguratorRoutes, { service });
  app.register(articleRoutes, { service: testArticleService } as never);
  return app;
}

async function templateWithChoice(opts: { user?: boolean } = {}) {
  const article = await makeArticle({ salesPrice: 1000 });
  const app = buildConfiguratorApp(opts);
  const base = `/articles/${article.id}/configurator`;
  await app.inject({ method: "POST", url: base, payload: { mode: "variants" } });
  const group = (await app.inject({ method: "POST", url: `${base}/groups`, payload: { code: "LOCK", name: "Lås", kind: "choice", required: true } })).json();
  const a = (await app.inject({ method: "POST", url: `${base}/groups/${group.id}/values`, payload: { code: "A", name: "Lås A" } })).json();
  const b = (await app.inject({ method: "POST", url: `${base}/groups/${group.id}/values`, payload: { code: "B", name: "Lås B", priceAdd: 200 } })).json();
  return { article, app, base, group, a, b };
}

describe("configurator routes", () => {
  it("GET 404s a plain article, POST 201s, second POST 409s with code", async () => {
    const article = await makeArticle({ salesPrice: 1000 });
    const app = buildConfiguratorApp();
    expect((await app.inject({ method: "GET", url: `/articles/${article.id}/configurator` })).json().code).toBe("configurator-template-not-found");
    const created = await app.inject({ method: "POST", url: `/articles/${article.id}/configurator`, payload: { mode: "variants" } });
    expect(created.statusCode).toBe(201);
    expect(created.json().mode).toBe("variants");
    const again = await app.inject({ method: "POST", url: `/articles/${article.id}/configurator`, payload: { mode: "variants" } });
    expect([again.statusCode, again.json().code]).toEqual([409, "configurator-template-exists"]);
    const patched = await app.inject({ method: "PATCH", url: `/articles/${article.id}/configurator`, payload: { mode: "to_order" } });
    expect([patched.statusCode, patched.json().mode]).toEqual([200, "to_order"]);
    expect((await app.inject({ method: "DELETE", url: `/articles/${article.id}/configurator` })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: `/articles/${article.id}/configurator` })).statusCode).toBe(404);
    await app.close();
  });

  it("404s an unknown article, and 400s a template on a phantom", async () => {
    const app = buildConfiguratorApp();
    const missing = await app.inject({ method: "POST", url: `/articles/${crypto.randomUUID()}/configurator`, payload: { mode: "variants" } });
    expect(missing.statusCode).toBe(404);
    const phantom = await makeArticle({ isPhantom: true });
    const res = await app.inject({ method: "POST", url: `/articles/${phantom.id}/configurator`, payload: { mode: "variants" } });
    expect([res.statusCode, res.json().code]).toEqual([400, "configurator-mode-not-allowed"]);
    await app.close();
  });

  it("400s a bad group body and a rule target of the wrong shape; 409s a referenced delete with the messages", async () => {
    const { app, base, group, a, b } = await templateWithChoice();
    const bad = await app.inject({ method: "POST", url: `${base}/groups`, payload: { code: "lock", name: "X", kind: "choice" } });
    expect([bad.statusCode, bad.json().code]).toEqual([400, "validation-failed"]);

    const badTarget = await app.inject({
      method: "POST",
      url: `${base}/rules`,
      payload: { effect: "limit", conditions: [], target: { groupId: group.id }, message: "Fel" },
    });
    expect([badTarget.statusCode, badTarget.json().code]).toEqual([400, "validation-failed"]);

    const farg = (await app.inject({ method: "POST", url: `${base}/groups`, payload: { code: "FARG", name: "Färg", kind: "boolean" } })).json();
    const rule = await app.inject({
      method: "POST",
      url: `${base}/rules`,
      payload: {
        effect: "exclude",
        conditions: [{ groupId: farg.id, op: "selected" }],
        target: { groupId: group.id, valueIds: [b.id] },
        message: "B går inte med färg",
      },
    });
    expect(rule.statusCode).toBe(201);
    const del = await app.inject({ method: "DELETE", url: `${base}/groups/${group.id}/values/${b.id}` });
    expect([del.statusCode, del.json().code]).toEqual([409, "configurator-reference-in-use"]);
    expect(del.json().error).toContain("B går inte med färg");
    await app.close();
  });

  it("updates and deletes groups, values and rules; 404s unknown ids", async () => {
    const { app, base, group, a } = await templateWithChoice();
    const up = await app.inject({ method: "PATCH", url: `${base}/groups/${group.id}`, payload: { name: "Lås nytt" } });
    expect([up.statusCode, up.json().name]).toEqual([200, "Lås nytt"]);
    const upV = await app.inject({ method: "PATCH", url: `${base}/groups/${group.id}/values/${a.id}`, payload: { priceAdd: 50 } });
    expect(upV.statusCode).toBe(200);
    expect((await app.inject({ method: "DELETE", url: `${base}/groups/${group.id}/values/${a.id}` })).statusCode).toBe(204);
    const unknown = crypto.randomUUID();
    expect((await app.inject({ method: "PATCH", url: `${base}/groups/${unknown}`, payload: { name: "X" } })).json().code).toBe("configurator-group-not-found");
    expect((await app.inject({ method: "DELETE", url: `${base}/rules/${unknown}` })).json().code).toBe("configurator-rule-not-found");
    expect((await app.inject({ method: "DELETE", url: `${base}/groups/${group.id}/values/${unknown}` })).json().code).toBe("configurator-value-not-found");
    expect((await app.inject({ method: "DELETE", url: `${base}/groups/${group.id}` })).statusCode).toBe(204);
    await app.close();
  });

  it("reorder: static segments win over :groupId/:ruleId, and a wrong set is 400 validation-failed", async () => {
    const { app, base, group, a, b } = await templateWithChoice();
    const g2 = (await app.inject({ method: "POST", url: `${base}/groups`, payload: { code: "FARG", name: "Färg", kind: "boolean" } })).json();

    expect((await app.inject({ method: "POST", url: `${base}/groups/reorder`, payload: { ids: [g2.id, group.id] } })).statusCode).toBe(204);
    expect((await app.inject({ url: base })).json().groups.map((g: { code: string }) => g.code)).toEqual(["FARG", "LOCK"]);

    expect((await app.inject({ method: "POST", url: `${base}/groups/${group.id}/values/reorder`, payload: { ids: [b.id, a.id] } })).statusCode).toBe(204);
    const detail = (await app.inject({ url: base })).json();
    expect(detail.groups.find((g: { code: string }) => g.code === "LOCK").values.map((v: { code: string }) => v.code)).toEqual(["B", "A"]);

    const r1 = (await app.inject({ method: "POST", url: `${base}/rules`, payload: { effect: "require", conditions: [], target: { groupId: group.id, op: "is", valueIds: [a.id] }, message: "R1" } })).json();
    const r2 = (await app.inject({ method: "POST", url: `${base}/rules`, payload: { effect: "require", conditions: [], target: { groupId: group.id, op: "is", valueIds: [b.id] }, message: "R2" } })).json();
    expect((await app.inject({ method: "POST", url: `${base}/rules/reorder`, payload: { ids: [r2.id, r1.id] } })).statusCode).toBe(204);

    for (const url of [`${base}/groups/reorder`, `${base}/groups/${group.id}/values/reorder`, `${base}/rules/reorder`]) {
      const wrong = await app.inject({ method: "POST", url, payload: { ids: [crypto.randomUUID()] } });
      expect([wrong.statusCode, wrong.json().code]).toEqual([400, "validation-failed"]);
    }
    await app.close();
  });

  it("evaluate: 200 with errors as data, 404 for a non-template, 400 for a bad body, 404 for an unknown customer", async () => {
    const { app, article, base, group, b } = await templateWithChoice();
    const url = `/configurator/${article.id}/evaluate`;
    const empty = await app.inject({ method: "POST", url, payload: { selection: {} } });
    expect(empty.statusCode).toBe(200);
    expect(empty.json().valid).toBe(false);
    const ok = await app.inject({ method: "POST", url, payload: { selection: { LOCK: "B" } } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().valid).toBe(true);
    // Delprojekt 5: null passes the body schema and clears the default (a missing key keeps it).
    await app.inject({ method: "PATCH", url: `${base}/groups/${group.id}`, payload: { defaultValueId: b.id } });
    const defaulted = await app.inject({ method: "POST", url, payload: { selection: {} } });
    expect(defaulted.json().groups[0]).toMatchObject({ code: "LOCK", value: "B", defaulted: true });
    const cleared = await app.inject({ method: "POST", url, payload: { selection: { LOCK: null } } });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().valid).toBe(false);
    expect(cleared.json().groups[0]).toMatchObject({ code: "LOCK", value: null, defaulted: false, errors: ["Välj Lås"] });

    const plain = await makeArticle();
    expect((await app.inject({ method: "POST", url: `/configurator/${plain.id}/evaluate`, payload: { selection: {} } })).statusCode).toBe(404);
    const badBody = await app.inject({ method: "POST", url, payload: { selection: "x" } });
    expect([badBody.statusCode, badBody.json().code]).toEqual([400, "validation-failed"]);
    const noCustomer = await app.inject({
      method: "POST",
      url,
      payload: { selection: { LOCK: "A" }, customerId: "00000000-0000-4000-8000-000000000000" },
    });
    expect(noCustomer.statusCode).toBe(404);
    await app.close();
  });

  it("PATCH /articles/:id with a type that breaks the template mode → 400 configurator-mode-not-allowed", async () => {
    const { app, article } = await templateWithChoice();
    const res = await app.inject({ method: "PATCH", url: `/articles/${article.id}`, payload: { isPhantom: true } });
    expect([res.statusCode, res.json().code]).toEqual([400, "configurator-mode-not-allowed"]);
    await app.close();
  });

  describe("structure lines, operations and derive", () => {
    const mfg = createManufacturingService(createManufacturingRepository(db), testDocumentPdfService, testArticleService);

    async function withWorkCenter() {
      await db.execute(sql`TRUNCATE work_centers CASCADE`);
      const t = await templateWithChoice();
      const wc = await mfg.createWorkCenter({ code: "301", name: "Svets", type: "machine", hourlyRate: 600, overheadPercent: 0, capacityFactor: 1, active: true });
      const part = await testArticleService.createArticle({ articleNumber: `P-${crypto.randomUUID().slice(0, 8)}`, name: "Plåt", type: "purchased", standardCost: 10 } as never);
      return { ...t, wc, part };
    }

    it("structure lines: 201, 200, static reorder 204, 204 delete, 404 afterwards, 400 for formula and line errors", async () => {
      const { app, base, article, part } = await withWorkCenter();
      const l1 = await app.inject({ method: "POST", url: `${base}/bom-lines`, payload: { conditions: [], source: "article", componentArticleId: part.id, quantity: 2 } });
      expect(l1.statusCode).toBe(201);
      const l2 = await app.inject({ method: "POST", url: `${base}/bom-lines`, payload: { conditions: [], source: "article", componentArticleId: part.id, quantityFormula: "2 * 3" } });
      expect(l2.statusCode).toBe(201);
      const id1 = l1.json().id as string;
      const id2 = l2.json().id as string;

      expect((await app.inject({ method: "PATCH", url: `${base}/bom-lines/${id1}`, payload: { note: "Fäste" } })).json().note).toBe("Fäste");
      const reorder = await app.inject({ method: "POST", url: `${base}/bom-lines/reorder`, payload: { ids: [id2, id1] } });
      expect(reorder.statusCode).toBe(204);
      expect((await app.inject({ method: "GET", url: base })).json().bomLines.map((l: { id: string }) => l.id)).toEqual([id2, id1]);

      const badFormula = await app.inject({ method: "POST", url: `${base}/bom-lines`, payload: { conditions: [], source: "article", componentArticleId: part.id, quantityFormula: "LANGD * 2" } });
      expect([badFormula.statusCode, badFormula.json().code, badFormula.json().error]).toEqual([400, "invalid-configurator-formula", "Antal: Okänd kod LANGD (tecken 1)"]);
      const badLine = await app.inject({ method: "POST", url: `${base}/bom-lines`, payload: { conditions: [], source: "article", componentArticleId: article.id, quantity: 1 } });
      expect([badLine.statusCode, badLine.json().code]).toEqual([400, "invalid-configurator-line"]);

      expect((await app.inject({ method: "DELETE", url: `${base}/bom-lines/${id1}` })).statusCode).toBe(204);
      const gone = await app.inject({ method: "DELETE", url: `${base}/bom-lines/${id1}` });
      expect([gone.statusCode, gone.json().code]).toEqual([404, "configurator-line-not-found"]);
      const noPatch = await app.inject({ method: "PATCH", url: `${base}/bom-lines/${crypto.randomUUID()}`, payload: { note: "x" } });
      expect([noPatch.statusCode, noPatch.json().code]).toEqual([404, "configurator-line-not-found"]);
      await app.close();
    });

    it("operations: 201, 200, 204; 409 sequence taken, 400 invalid, 404 operation and resource", async () => {
      const { app, base, wc } = await withWorkCenter();
      const op = await app.inject({ method: "POST", url: `${base}/operations`, payload: { conditions: [], sequenceNo: 40, workCenterId: wc.id, setupTime: 1, runTimePerUnit: 2 } });
      expect(op.statusCode).toBe(201);
      const taken = await app.inject({ method: "POST", url: `${base}/operations`, payload: { conditions: [], sequenceNo: 40, workCenterId: wc.id, setupTime: 1, runTimePerUnit: 2 } });
      expect([taken.statusCode, taken.json().code]).toEqual([409, "configurator-sequence-taken"]);
      const patched = await app.inject({ method: "PATCH", url: `${base}/operations/${op.json().id}`, payload: { description: "Svetsa" } });
      expect([patched.statusCode, patched.json().description]).toEqual([200, "Svetsa"]);
      const badFormula = await app.inject({ method: "PATCH", url: `${base}/operations/${op.json().id}`, payload: { runFormula: "BREDD +", runTimePerUnit: null } });
      expect([badFormula.statusCode, badFormula.json().code, badFormula.json().error]).toEqual([400, "invalid-configurator-formula", expect.stringMatching(/^Stycktid: .*tecken|^Stycktid: /)]);
      const bothTimes = await app.inject({ method: "POST", url: `${base}/operations`, payload: { conditions: [], sequenceNo: 50, workCenterId: wc.id } });
      expect(bothTimes.statusCode).toBe(400);
      await mfg.updateWorkCenter(wc.id, { active: false });
      const inactive = await app.inject({ method: "POST", url: `${base}/operations`, payload: { conditions: [], sequenceNo: 60, workCenterId: wc.id, setupTime: 1, runTimePerUnit: 2 } });
      expect([inactive.statusCode, inactive.json().code]).toEqual([400, "invalid-configurator-operation"]);
      const noWc = await app.inject({ method: "POST", url: `${base}/operations`, payload: { conditions: [], sequenceNo: 70, workCenterId: crypto.randomUUID(), setupTime: 1, runTimePerUnit: 2 } });
      expect([noWc.statusCode, noWc.json().code]).toEqual([404, "work-center-not-found"]);

      expect((await app.inject({ method: "DELETE", url: `${base}/operations/${op.json().id}` })).statusCode).toBe(204);
      const gone = await app.inject({ method: "DELETE", url: `${base}/operations/${op.json().id}` });
      expect([gone.statusCode, gone.json().code]).toEqual([404, "configurator-operation-not-found"]);
      await app.close();
    });

    it("derive: 200 with evaluation, structure and costing; invalid configuration gives costing null; 404 unknown template", async () => {
      const { app, article, part } = await withWorkCenter();
      const base = `/articles/${article.id}/configurator`;
      await app.inject({ method: "POST", url: `${base}/bom-lines`, payload: { conditions: [], source: "article", componentArticleId: part.id, quantity: 2 } });
      const url = `/configurator/${article.id}/derive`;
      const ok = await app.inject({ method: "POST", url, payload: { selection: { LOCK: "A" }, quantity: 5 } });
      expect(ok.statusCode).toBe(200);
      const body = ok.json();
      expect(body.evaluation.valid).toBe(true);
      expect(body.structure.derivable).toBe(true);
      expect(body.structure.materials[0]).toMatchObject({ source: "line", articleNumber: part.articleNumber, articleName: "Plåt", quantity: 2 });
      expect(body.costing).toMatchObject({ quantity: 5, materialCost: 100, manufacturingCost: 100 });
      const invalid = await app.inject({ method: "POST", url, payload: { selection: {} } });
      expect(invalid.statusCode).toBe(200);
      expect(invalid.json()).toMatchObject({ structure: { derivable: false }, costing: null });
      const plain = await makeArticle();
      expect((await app.inject({ method: "POST", url: `/configurator/${plain.id}/derive`, payload: {} })).statusCode).toBe(404);
      expect((await app.inject({ method: "POST", url, payload: { selection: "x" } })).statusCode).toBe(400);
      await app.close();
    });
  });

  describe("variants", () => {
    it("preview 200, create 201 with rows, template with variants locks mode (409), variant-of 404 on plain article", async () => {
      const { app, article, base } = await templateWithChoice({ user: false });
      const body = { sets: { LOCK: ["A", "B"] }, calcQuantity: 10 };
      const preview = await app.inject({ method: "POST", url: `${base}/variants/preview`, payload: body });
      expect(preview.statusCode).toBe(200);
      expect(preview.json()).toHaveLength(2);
      const created = await app.inject({ method: "POST", url: `${base}/variants`, payload: body });
      expect(created.statusCode).toBe(201);
      expect(created.json().map((r: { status: string }) => r.status)).toEqual(["created", "created"]);
      const list = await app.inject({ method: "GET", url: `${base}/variants` });
      expect(list.statusCode).toBe(200);
      expect(list.json()).toHaveLength(2);
      const variantId = created.json()[0].articleId;
      const of = await app.inject({ method: "GET", url: `/articles/${variantId}/variant-of` });
      expect(of.statusCode).toBe(200);
      const locked = await app.inject({ method: "PATCH", url: base, payload: { mode: "to_order" } });
      expect([locked.statusCode, locked.json().code]).toEqual([409, "configurator-template-has-variants"]);
      const plain = await makeArticle();
      const none = await app.inject({ method: "GET", url: `/articles/${plain.id}/variant-of` });
      expect([none.statusCode, none.json().code]).toEqual([404, "configurator-variant-not-found"]);
      expect(article.id).toBeTruthy();
      await app.close();
    });

    it("400 for too many combinations, unknown group and missing body; 409 outside variants mode", async () => {
      const article = await makeArticle({ salesPrice: 1000 });
      const app = buildConfiguratorApp();
      const base = `/articles/${article.id}/configurator`;
      await app.inject({ method: "POST", url: base, payload: { mode: "variants" } });
      for (const code of ["N1", "N2"]) {
        const g = await app.inject({ method: "POST", url: `${base}/groups`, payload: { code, name: code, kind: "number", required: true, minValue: 1, maxValue: 1000, step: 1 } });
        expect(g.statusCode).toBe(201);
      }
      const range = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
      const many = await app.inject({ method: "POST", url: `${base}/variants/preview`, payload: { sets: { N1: range(15), N2: range(14) }, calcQuantity: 1 } });
      expect([many.statusCode, many.json().code]).toEqual([400, "configurator-too-many-combinations"]);
      const unknown = await app.inject({ method: "POST", url: `${base}/variants/preview`, payload: { sets: { NOPE: ["A"] }, calcQuantity: 1 } });
      expect([unknown.statusCode, unknown.json().code]).toEqual([400, "invalid-configurator-variant-set"]);
      const noBody = await app.inject({ method: "POST", url: `${base}/variants/preview` });
      expect([noBody.statusCode, noBody.json().code]).toEqual([400, "validation-failed"]);
      await app.inject({ method: "PATCH", url: base, payload: { mode: "to_order" } });
      const wrong = await app.inject({ method: "POST", url: `${base}/variants/preview`, payload: { sets: {}, calcQuantity: 1 } });
      expect([wrong.statusCode, wrong.json().code]).toEqual([409, "configurator-not-variant-mode"]);
      await app.close();
    });
  });

  describe("POST /configurator/:articleId/variant", () => {
    it("200 created:true, then 200 created:false, invalid ⇒ 400 with details, to_order ⇒ 409, deleted template ⇒ 404", async () => {
      const { article, app } = await templateWithChoice({ user: false });
      const first = await app.inject({ method: "POST", url: `/configurator/${article.id}/variant`, payload: { selection: { LOCK: "B" } } });
      expect(first.statusCode).toBe(200);
      expect(first.json()).toMatchObject({ created: true, article: { articleNumber: `${article.articleNumber}-B`, salesPrice: "1200.0000" } });
      const again = await app.inject({ method: "POST", url: `/configurator/${article.id}/variant`, payload: { selection: { LOCK: "B" } } });
      expect(again.json()).toMatchObject({ created: false, article: { id: first.json().article.id } });

      const invalid = await app.inject({ method: "POST", url: `/configurator/${article.id}/variant`, payload: { selection: {} } });
      expect([invalid.statusCode, invalid.json().code]).toEqual([400, "configurator-invalid-configuration"]);
      expect(invalid.json().details.length).toBeGreaterThan(0);

      const unknownGroup = await app.inject({ method: "POST", url: `/configurator/${article.id}/variant`, payload: { selection: { NOPE: "A" } } });
      expect([unknownGroup.statusCode, unknownGroup.json().code]).toEqual([400, "invalid-configurator-variant-set"]);

      const other = await makeArticle({ salesPrice: 1000 });
      await app.inject({ method: "POST", url: `/articles/${other.id}/configurator`, payload: { mode: "to_order" } });
      const toOrder = await app.inject({ method: "POST", url: `/configurator/${other.id}/variant`, payload: { selection: {} } });
      expect([toOrder.statusCode, toOrder.json().code]).toEqual([409, "configurator-not-variant-mode"]);

      const plain = await makeArticle();
      const gone = await app.inject({ method: "POST", url: `/configurator/${plain.id}/variant`, payload: { selection: {} } });
      expect([gone.statusCode, gone.json().code]).toEqual([404, "configurator-template-not-found"]);
      await app.close();
    });
  });
});

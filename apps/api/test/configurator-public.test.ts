import { API_CLIENT_SCOPES } from "@navet/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { articles, db } from "@navet/db";
import type { ConfiguratorTemplateDetail } from "@navet/shared";
import { buildApp } from "../src/app.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createAuthService } from "../src/modules/auth/service/auth.service.js";
import { toPublicTemplate, toPublicTemplateSummary } from "../src/modules/configurator/service/public-template.js";
import { createOAuthRepository } from "../src/modules/oauth/repository/oauth.repository.js";
import { createOAuthService } from "../src/modules/oauth/service/oauth.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { buildToOrder, configurator, makeCustomer, resetConfiguredRows } from "./helpers/configured-rows.js";

// Konfigurator delprojekt 5 — the external API's read side. The pure mappers
// hand out only what a customer may see of a template: never rules,
// structure lines, operations, article links, article fields or internal ids.

const id = () => crypto.randomUUID();
const lockId = id();
const valueA = id();
const valueB = id();
const valueOld = id();
const breddId = id();
const avloppId = id();

// Groups and alternatives deliberately out of sortOrder in the arrays: the
// mapper orders them itself.
const detail: ConfiguratorTemplateDetail = {
  articleId: id(),
  mode: "to_order",
  published: true,
  basePrice: "1000.00",
  groups: [
    {
      id: avloppId, code: "AVLOPP", name: "Avlopp", kind: "boolean", required: false, sortOrder: 3, priceAdd: "100.00",
      defaultValueId: null, articleField: null, unit: null, minValue: null, maxValue: null, step: null, defaultNumber: null,
      pricePerUnit: "0.0000", priceBaseValue: "0.0000", values: [],
    },
    {
      id: lockId, code: "LOCK", name: "Lås", kind: "choice", required: true, sortOrder: 1, priceAdd: "0.00",
      defaultValueId: valueA, articleField: "colour", unit: null, minValue: null, maxValue: null, step: null, defaultNumber: null,
      pricePerUnit: "0.0000", priceBaseValue: "0.0000",
      values: [
        { id: valueB, code: "B", name: "Lås B", priceAdd: "50.00", sortOrder: 2, active: true, articleId: id(), articleNumber: "LAS-B", articleName: "Låscylinder B" },
        { id: valueOld, code: "C", name: "Lås C (utgått)", priceAdd: "75.00", sortOrder: 3, active: false, articleId: null, articleNumber: null, articleName: null },
        { id: valueA, code: "A", name: "Lås A", priceAdd: "0.00", sortOrder: 1, active: true, articleId: null, articleNumber: null, articleName: null },
      ],
    },
    {
      id: breddId, code: "BREDD", name: "Bredd", kind: "number", required: true, sortOrder: 2, priceAdd: "0.00",
      defaultValueId: null, articleField: null, unit: "mm", minValue: "500.0000", maxValue: "2000.0000", step: "10.0000", defaultNumber: "1200.0000",
      pricePerUnit: "0.5000", priceBaseValue: "1000.0000", values: [],
    },
  ],
  rules: [
    {
      id: id(), effect: "exclude", conditions: [{ groupId: avloppId, op: "selected" }], target: { groupId: lockId, valueIds: [valueB] },
      message: "Lås B går inte med avlopp", sortOrder: 1, active: true,
    },
  ],
  bomLines: [
    {
      id: id(), sortOrder: 1, conditions: [{ groupId: lockId, op: "is", valueIds: [valueB] }], source: "article",
      componentArticleId: id(), componentArticleNumber: "PLAT-1", componentArticleName: "Plåt", componentGroupId: null,
      componentGroupCode: null, componentGroupName: null, quantity: "2", quantityFormula: null, routingOperationId: null,
      configuratorOperationId: null, operationSequenceNo: null, note: "standardCost 12",
    },
  ],
  operations: [
    {
      id: id(), sequenceNo: 90, conditions: [], workCenterId: id(), workCenterCode: "100", workCenterName: "Svets",
      description: "Svetsa", setupTime: "10", setupFormula: null, runTimePerUnit: "2", runFormula: null, setupPrice: null, unitPrice: null,
    },
  ],
};

describe("public template mappers", () => {
  it("toPublicTemplate lämnar bara ut det publika", () => {
    const pub = toPublicTemplate(detail, { articleNumber: "63000", name: "Diskbänk" });
    expect(pub).toEqual({
      articleId: detail.articleId, articleNumber: "63000", name: "Diskbänk", mode: "to_order", basePrice: 1000,
      groups: [
        { code: "LOCK", name: "Lås", kind: "choice", required: true, unit: null, min: null, max: null, step: null,
          default: "A", priceAdd: 0, pricePerUnit: 0, priceBaseValue: 0,
          values: [{ code: "A", name: "Lås A", priceAdd: 0 }, { code: "B", name: "Lås B", priceAdd: 50 }] },
        { code: "BREDD", name: "Bredd", kind: "number", required: true, unit: "mm", min: 500, max: 2000, step: 10,
          default: 1200, priceAdd: 0, pricePerUnit: 0.5, priceBaseValue: 1000, values: [] },
        // ja/nej has no default in the data model: the engine treats a missing key as Nej.
        { code: "AVLOPP", name: "Avlopp", kind: "boolean", required: false, unit: null, min: null, max: null, step: null,
          default: false, priceAdd: 100, pricePerUnit: 0, priceBaseValue: 0, values: [] },
      ],
    });
    const json = JSON.stringify(pub);
    for (const forbidden of [
      "rules", "bomLines", "operations", "articleField", "defaultValueId", "standardCost", "LAS-B", "Låscylinder", "PLAT-1", "Svets",
      "sortOrder", "active", detail.groups[0]!.id, detail.groups[1]!.id, detail.groups[1]!.values[0]!.id, detail.groups[1]!.values[0]!.articleId!,
    ])
      expect(json).not.toContain(forbidden);
  });

  it("a choice default on an inactive alternative, a number without default and no base price become null", () => {
    const lock = detail.groups[1]!;
    const bredd = detail.groups[2]!;
    const pub = toPublicTemplate(
      {
        ...detail,
        basePrice: null,
        groups: [{ ...lock, defaultValueId: valueOld }, { ...bredd, defaultNumber: null, step: null }],
      },
      { articleNumber: "63000", name: "Diskbänk" }
    );
    expect(pub.basePrice).toBeNull();
    expect(pub.groups.map((g) => [g.code, g.default, g.step])).toEqual([["LOCK", null, null], ["BREDD", null, null]]);
  });

  it("toPublicTemplateSummary carries only code, name, kind and required per group", () => {
    const summary = toPublicTemplateSummary(detail, { articleNumber: "63000", name: "Diskbänk" });
    expect(summary).toEqual({
      articleId: detail.articleId, articleNumber: "63000", name: "Diskbänk", mode: "to_order", basePrice: 1000,
      groups: [
        { code: "LOCK", name: "Lås", kind: "choice", required: true },
        { code: "BREDD", name: "Bredd", kind: "number", required: true },
        { code: "AVLOPP", name: "Avlopp", kind: "boolean", required: false },
      ],
    });
  });
});

// --- the routes, through the real app (OAuth scope) ---

// What a public answer may never carry (global constraints).
const FORBIDDEN = [
  "rules", "bomLines", "operations", "standardCost", '"cost"', "configurationCost", "articleField", "defaultValueId",
  "articleName", "sortOrder", '"id"',
];

describe("public configurator routes", () => {
  const app = buildApp();
  const authService = createAuthService(createAuthRepository(db), "unused", createAuditRepository(db));
  const oauthService = createOAuthService(createOAuthRepository(db), "unused");

  beforeAll(async () => {
    await app.ready();
  });
  beforeEach(resetConfiguredRows);
  afterAll(async () => {
    await app.close();
    await resetConfiguredRows();
  });

  // A real client token (client credentials through POST /oauth/token) and a
  // real session cookie (POST /auth/login), both against the same app.
  async function actors() {
    const email = `pub-${crypto.randomUUID()}@example.com`;
    const user = await authService.createUser({ email, password: "correcthorse", name: "Publik", role: "admin", permissionGroupId: null });
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: "correcthorse" } });
    const session = { cookie: `session=${login.cookies.find((c) => c.name === "session")!.value}` };
    const { client, clientSecret } = await oauthService.createApiClient({ name: "Hemsidan", scopes: [...API_CLIENT_SCOPES] }, user.id);
    const token = await app.inject({ method: "POST", url: "/api/v1/oauth/token", payload: { clientId: client.id, clientSecret } });
    expect(token.statusCode).toBe(200);
    const clientHeaders = { authorization: `Bearer ${(token.json() as { accessToken: string }).accessToken}` };
    return { client: clientHeaders, session };
  }

  const get = (headers: Record<string, string>, url: string) => app.inject({ method: "GET", url: `/api/v1${url}`, headers });
  const post = (headers: Record<string, string>, url: string, payload: unknown) =>
    app.inject({ method: "POST", url: `/api/v1${url}`, headers, payload: payload as never });
  const lockOf = (res: { json(): { groups: { code: string }[] } }) => res.json().groups.find((g) => g.code === "LOCK");

  async function published() {
    const t = await buildToOrder();
    await configurator.updateTemplate(t.article.id, { published: true });
    return t;
  }

  it("GET /configurator/templates: only published templates on active articles, for client and session alike", async () => {
    const { client, session } = await actors();
    const visible = await published();
    const inactive = await published();
    await db.update(articles).set({ active: false }).where(eq(articles.id, inactive.article.id));
    await buildToOrder(); // not published

    const expected = {
      rows: [
        {
          articleId: visible.article.id, articleNumber: visible.article.articleNumber, name: visible.article.name, mode: "to_order",
          basePrice: 1000,
          groups: [
            { code: "LOCK", name: "Lås", kind: "choice", required: true },
            { code: "AVLOPP", name: "Avlopp", kind: "boolean", required: false },
            { code: "BREDD", name: "Bredd", kind: "number", required: true },
          ],
        },
      ],
      total: 1,
    };
    for (const headers of [client, session]) {
      const res = await get(headers, "/configurator/templates");
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(expected);
      for (const leak of FORBIDDEN) expect(res.body).not.toContain(leak);
    }
    const found = await get(client, `/configurator/templates?search=${visible.article.articleNumber.toLowerCase()}`);
    expect(found.json()).toEqual(expected);
    const none = await get(client, "/configurator/templates?search=finnsinte");
    expect(none.json()).toEqual({ rows: [], total: 0 });
    const page = await get(client, "/configurator/templates?limit=1");
    expect([page.json().total, page.json().rows.length]).toEqual([1, 1]);
    const past = await get(client, "/configurator/templates?limit=1&offset=1");
    expect([past.json().total, past.json().rows.length]).toEqual([1, 0]);
    expect((await get(client, "/configurator/templates?limit=0")).statusCode).toBe(400);
  });

  it("GET /configurator/:articleId: a hidden template is a 404 for a client but not for a session", async () => {
    const { client, session } = await actors();
    const hidden = await buildToOrder();
    const res = await get(client, `/configurator/${hidden.article.id}`);
    expect([res.statusCode, res.json().code]).toEqual([404, "configurator-template-not-found"]);
    expect((await get(session, `/configurator/${hidden.article.id}`)).statusCode).toBe(200);

    // Published but on an inactive article: hidden as well.
    const inactive = await published();
    await db.update(articles).set({ active: false }).where(eq(articles.id, inactive.article.id));
    expect((await get(client, `/configurator/${inactive.article.id}`)).statusCode).toBe(404);
    expect((await get(session, `/configurator/${inactive.article.id}`)).statusCode).toBe(200);

    // Unknown: the same 404 for both.
    for (const headers of [client, session]) {
      const unknown = await get(headers, `/configurator/${crypto.randomUUID()}`);
      expect([unknown.statusCode, unknown.json().code]).toEqual([404, "configurator-template-not-found"]);
    }
    // A malformed id is the id guard's 400.
    expect((await get(client, "/configurator/inte-ett-id")).statusCode).toBe(400);
  });

  it("GET /configurator/:articleId: a published template is the public shape, nothing internal", async () => {
    const { client } = await actors();
    const t = await published();
    await configurator.updateGroup(t.article.id, t.lock.id, { defaultValueId: t.a.id });
    const res = await get(client, `/configurator/${t.article.id}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      articleId: t.article.id, articleNumber: t.article.articleNumber, name: t.article.name, mode: "to_order", basePrice: 1000,
      groups: [
        { code: "LOCK", name: "Lås", kind: "choice", required: true, unit: null, min: null, max: null, step: null, default: "A",
          priceAdd: 0, pricePerUnit: 0, priceBaseValue: 0, values: [{ code: "A", name: "Lås A", priceAdd: 0 }, { code: "B", name: "Lås B", priceAdd: 50 }] },
        { code: "AVLOPP", name: "Avlopp", kind: "boolean", required: false, unit: null, min: null, max: null, step: null, default: false,
          priceAdd: 100, pricePerUnit: 0, priceBaseValue: 0, values: [] },
        { code: "BREDD", name: "Bredd", kind: "number", required: true, unit: "mm", min: 500, max: 2000, step: null, default: null,
          priceAdd: 0, pricePerUnit: 0, priceBaseValue: 0, values: [] },
      ],
    });
    for (const leak of [...FORBIDDEN, t.lock.id, t.a.id, t.b.id, t.avlopp.id, t.bredd.id]) expect(res.body).not.toContain(leak);
  });

  it("POST /configurator/:articleId/evaluate: the same answer for client and session; hidden is the client's 404", async () => {
    const { client, session } = await actors();
    const t = await published();
    const body = { selection: { LOCK: "B", AVLOPP: true, BREDD: 1200 }, quantity: 2 };
    const asClient = await post(client, `/configurator/${t.article.id}/evaluate`, body);
    const asSession = await post(session, `/configurator/${t.article.id}/evaluate`, body);
    expect(asClient.statusCode).toBe(200);
    expect(asClient.json()).toEqual(asSession.json());
    expect(asClient.json()).toMatchObject({ valid: true, price: { base: 1000, unitPrice: 1150 } });

    const hidden = await buildToOrder();
    const refused = await post(client, `/configurator/${hidden.article.id}/evaluate`, body);
    expect([refused.statusCode, refused.json().code]).toEqual([404, "configurator-template-not-found"]);
    expect((await post(session, `/configurator/${hidden.article.id}/evaluate`, body)).statusCode).toBe(200);

    // Review Focus 2: an unknown customer is the same 404 for a client as internally.
    for (const headers of [client, session]) {
      const noCustomer = await post(headers, `/configurator/${t.article.id}/evaluate`, { ...body, customerId: crypto.randomUUID() });
      expect([noCustomer.statusCode, noCustomer.json().code]).toEqual([404, "customer-not-found"]);
    }
    const customer = await makeCustomer();
    expect((await post(client, `/configurator/${t.article.id}/evaluate`, { ...body, customerId: customer.id })).statusCode).toBe(200);
    const badBody = await post(client, `/configurator/${t.article.id}/evaluate`, { selection: "x" });
    expect([badBody.statusCode, badBody.json().code]).toEqual([400, "validation-failed"]);
  });

  it("POST /configurator/:articleId/evaluate: null clears a default, a missing key keeps it", async () => {
    const { client } = await actors();
    const t = await published();
    await configurator.updateGroup(t.article.id, t.lock.id, { defaultValueId: t.a.id });
    const url = `/configurator/${t.article.id}/evaluate`;
    const kept = await post(client, url, { selection: { BREDD: 1200 } });
    expect(lockOf(kept)).toMatchObject({ value: "A", defaulted: true });
    expect(kept.json().valid).toBe(true);
    const cleared = await post(client, url, { selection: { LOCK: null, BREDD: 1200 } });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().valid).toBe(false);
    expect(lockOf(cleared)).toMatchObject({ value: null, defaulted: false, errors: ["Välj Lås"] });
  });

  it("PATCH /articles/:id/configurator sets Visa i API; an empty body is a 400; POST takes it too", async () => {
    const { session } = await actors();
    const t = await buildToOrder();
    expect((await get(session, `/articles/${t.article.id}/configurator`)).json().published).toBe(false);
    const patch = (payload: unknown) =>
      app.inject({ method: "PATCH", url: `/api/v1/articles/${t.article.id}/configurator`, headers: session, payload: payload as never });
    const patched = await patch({ published: true });
    expect([patched.statusCode, patched.json().published, patched.json().mode]).toEqual([200, true, "to_order"]);
    expect((await get(session, `/articles/${t.article.id}/configurator`)).json().published).toBe(true);
    // The mode alone still works and leaves the flag as it is.
    const mode = await patch({ mode: "to_order" });
    expect([mode.statusCode, mode.json().published]).toEqual([200, true]);
    const empty = await patch({});
    expect([empty.statusCode, empty.json().code]).toEqual([400, "validation-failed"]);

    const other = await buildToOrder();
    await configurator.deleteTemplate(other.article.id);
    const created = await app.inject({
      method: "POST", url: `/api/v1/articles/${other.article.id}/configurator`, headers: session, payload: { mode: "to_order", published: true },
    });
    expect([created.statusCode, created.json().published]).toEqual([201, true]);
  });
});

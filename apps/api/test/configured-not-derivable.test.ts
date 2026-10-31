import { API_CLIENT_SCOPES } from "@navet/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, salesOrderRows, salesOrders } from "@navet/db";
import { buildApp } from "../src/app.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createAuthService } from "../src/modules/auth/service/auth.service.js";
import {
  ConfigurationNotDerivableError,
  ConfiguratorInvalidConfigurationError,
} from "../src/modules/configurator/service/configurator.errors.js";
import { createOAuthRepository } from "../src/modules/oauth/repository/oauth.repository.js";
import { createOAuthService } from "../src/modules/oauth/service/oauth.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { makeArticle } from "./helpers/configurator.js";
import { buildToOrder, configurator, makeCustomer, resetConfiguredRows, salesService } from "./helpers/configured-rows.js";

// Konfigurerad tillverkning: a beställningsvara row whose selection the
// engine accepts but whose structure the derivation cannot build is refused
// AT THE SALE — new row (offert or kundorder, also POST /quotes), quantity
// change and Ändra konfiguration — as ConfigurationNotDerivableError (409
// configuration-not-derivable), instead of being stored with cost null and
// failing when the TO is created. A session gets the derivation's messages
// as `details` (what to fix in the template); an API client never sees
// structure text.

beforeEach(resetConfiguredRows);
afterAll(resetConfiguredRows);

const SEL = { LOCK: "B", BREDD: 1200 };
const NEW_SEL = { LOCK: "A", BREDD: 800 };
const orderCount = async () => (await db.select({ id: salesOrders.id }).from(salesOrders)).length;
const rawRow = async (rowId: string) => (await db.select().from(salesOrderRows).where(eq(salesOrderRows.id, rowId)))[0]!;

// A structure line taking its component from Lås, whose alternatives have no
// article: the engine accepts every selection, the derivation none
// ("Strukturrad …: alternativet Lås B i Lås saknar artikel").
async function breakStructure(t: Awaited<ReturnType<typeof buildToOrder>>) {
  await configurator.createBomLine(
    t.article.id,
    { conditions: [], source: "group", componentGroupId: t.lock.id, quantity: 1, note: "Gångjärn" } as never
  );
}

describe("configuration-not-derivable — service", () => {
  it("a new configured row is refused on an offert and on a kundorder, with the derivation's messages; nothing is created", async () => {
    const t = await buildToOrder();
    await breakStructure(t);
    const c = await makeCustomer();
    for (const confirm of [false, true]) {
      const err = await salesService
        .createQuote({ customerId: c.id, confirm, rows: [{ articleId: t.article.id, quantity: 1, configuration: { selection: SEL } }] } as never, null)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConfigurationNotDerivableError);
      expect((err as ConfigurationNotDerivableError).details.join(" ")).toContain("saknar artikel");
    }
    expect(await orderCount()).toBe(0);
    // An engine-invalid selection is still the other error (400, engine messages).
    await expect(
      salesService.createQuote(
        { customerId: c.id, rows: [{ articleId: t.article.id, quantity: 1, configuration: { selection: { LOCK: "B", BREDD: 9999 } } }] } as never,
        null
      )
    ).rejects.toBeInstanceOf(ConfiguratorInvalidConfigurationError);
  });

  it("a quantity change re-evaluates the stored row and is refused once the template's structure broke; the same quantity is not evaluated", async () => {
    const t = await buildToOrder();
    const c = await makeCustomer();
    const { order, rows } = await salesService.createQuote(
      { customerId: c.id, rows: [{ articleId: t.article.id, quantity: 2, configuration: { selection: SEL } }] } as never,
      null
    );
    const row = rows[0]!;
    await breakStructure(t);
    await expect(salesService.updateRow(order.id, row.id, { quantity: 3 } as never)).rejects.toBeInstanceOf(ConfigurationNotDerivableError);
    // Price and discount stay editable at the unchanged quantity (no evaluation).
    await salesService.updateRow(order.id, row.id, { quantity: 2, unitPrice: 777 } as never);
    // The stored row is untouched by the refused change, repriced by the accepted one.
    const stored = await rawRow(row.id);
    expect([Number(stored.quantityOrdered), Number(stored.unitPrice)]).toEqual([2, 777]);
  });

  it("Ändra konfiguration is refused the same way and leaves the row as it was", async () => {
    const t = await buildToOrder();
    const c = await makeCustomer();
    const { order, rows } = await salesService.createQuote(
      { customerId: c.id, rows: [{ articleId: t.article.id, quantity: 1, configuration: { selection: SEL } }] } as never,
      null
    );
    const row = rows[0]!;
    const before = await rawRow(row.id);
    await breakStructure(t);
    await expect(salesService.setRowConfiguration(order.id, row.id, { selection: NEW_SEL }, null)).rejects.toBeInstanceOf(
      ConfigurationNotDerivableError
    );
    expect(await rawRow(row.id)).toEqual(before);
  });
});

describe("configuration-not-derivable — routes: details for a session, never for an API client", () => {
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
    const email = `nd-${crypto.randomUUID()}@example.com`;
    const user = await authService.createUser({ email, password: "correcthorse", name: "Offert", role: "admin", permissionGroupId: null });
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: "correcthorse" } });
    const session = { cookie: `session=${login.cookies.find((c) => c.name === "session")!.value}` };
    const { client, clientSecret } = await oauthService.createApiClient({ name: "Hemsidan", scopes: [...API_CLIENT_SCOPES] }, user.id);
    const token = await app.inject({ method: "POST", url: "/api/v1/oauth/token", payload: { clientId: client.id, clientSecret } });
    expect(token.statusCode).toBe(200);
    const clientHeaders = { authorization: `Bearer ${(token.json() as { accessToken: string }).accessToken}` };
    return { client: clientHeaders, session };
  }
  const postQuote = (headers: Record<string, string>, payload: unknown) =>
    app.inject({ method: "POST", url: "/api/v1/quotes", headers, payload: payload as never });
  const STRUCTURE_TEXT = /Strukturrad|saknar artikel|Gångjärn|details/;

  it("POST /quotes: a session gets 409 with details, a client token 409 without; neither creates anything", async () => {
    const { client, session } = await actors();
    const t = await buildToOrder();
    await breakStructure(t);
    await configurator.updateTemplate(t.article.id, { published: true });
    const c = await makeCustomer();
    const payload = { customerId: c.id, rows: [{ articleId: t.article.id, quantity: 1, configuration: { selection: SEL } }] };

    const asSession = await postQuote(session, payload);
    expect([asSession.statusCode, asSession.json().code]).toEqual([409, "configuration-not-derivable"]);
    expect(asSession.json().error).toBe("Kombinationen kan inte tillverkas — åtgärda mallens struktur i Nav");
    expect(asSession.json().details.join(" ")).toContain("saknar artikel");

    const asClient = await postQuote(client, payload);
    expect([asClient.statusCode, asClient.json()]).toEqual([
      409,
      { error: "Kombinationen kan inte tillverkas — åtgärda mallens struktur i Nav", code: "configuration-not-derivable" },
    ]);
    expect(asClient.body).not.toMatch(STRUCTURE_TEXT);
    expect(await orderCount()).toBe(0);
  });

  it("POST rows, PATCH quantity and PUT configuration answer 409 configuration-not-derivable with details for a session", async () => {
    const { session } = await actors();
    const t = await buildToOrder();
    const c = await makeCustomer();
    // The order exists with one plain row and one configured row before the structure breaks.
    const plain = await makeArticle({ salesPrice: 100 });
    const created = await postQuote(session, {
      customerId: c.id,
      rows: [
        { articleId: plain.id, quantity: 1 },
        { articleId: t.article.id, quantity: 2, configuration: { selection: SEL } },
      ],
    });
    expect(created.statusCode).toBe(201);
    const orderId: string = created.json().order.id;
    const rowId: string = created.json().rows.find((r: { configuration: unknown }) => r.configuration).id;
    await breakStructure(t);

    const added = await app.inject({
      method: "POST", url: `/api/v1/sales-orders/${orderId}/rows`, headers: session,
      payload: { articleId: t.article.id, quantity: 1, configuration: { selection: NEW_SEL } },
    });
    expect([added.statusCode, added.json().code, added.json().details.length > 0]).toEqual([409, "configuration-not-derivable", true]);

    const patched = await app.inject({ method: "PATCH", url: `/api/v1/sales-orders/${orderId}/rows/${rowId}`, headers: session, payload: { quantity: 3 } });
    expect([patched.statusCode, patched.json().code, patched.json().details.length > 0]).toEqual([409, "configuration-not-derivable", true]);

    const reconfigured = await app.inject({
      method: "PUT", url: `/api/v1/sales-orders/${orderId}/rows/${rowId}/configuration`, headers: session, payload: { selection: NEW_SEL },
    });
    expect([reconfigured.statusCode, reconfigured.json().code, reconfigured.json().details.length > 0]).toEqual([
      409, "configuration-not-derivable", true,
    ]);
    // The stored row still has its original quantity and choices.
    const stored = await rawRow(rowId);
    expect([Number(stored.quantityOrdered), (stored.configuration as { key: string }).key]).toEqual([2, expect.stringContaining("LOCK=B")]);
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@navet/db";
import { createArticleSchema } from "@navet/shared";
import { buildApp } from "../src/app.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createAuthService } from "../src/modules/auth/service/auth.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { testArticleService } from "./helpers/services.js";
import { parsed } from "./helpers/parsed.js";
import { ApiError } from "../../web/lib/api.js";
import { apiErrorMessage } from "../../web/lib/errorMessages.js";

// Talfält (medelbugg 2026-11-10) through the real app: a number larger than
// its column is a 400 — on the field where the schema knows the bound
// (validation-failed), from the global error handler's net where it does not
// (Postgres 22003 → number-out-of-range) — and a blank or null number in a
// body is refused instead of stored as 0. Query schemas keep their coercion.

const authService = createAuthService(createAuthRepository(db), "unused", createAuditRepository(db));
const PASSWORD = "correcthorsebattery";
const TRUNCATE = sql`TRUNCATE cost_calculations, article_standard_cost_history, article_sales_price_history, routing_operations, work_centers, bom_components, stock_transactions, articles, audit_log, user_settings, users CASCADE`;

let app: ReturnType<typeof buildApp>;
let cookie: string;

beforeAll(async () => {
  app = buildApp();
  await app.ready();
});

beforeEach(async () => {
  await db.execute(TRUNCATE);
  const email = `admin-${crypto.randomUUID()}@example.com`;
  await authService.createUser({ email, password: PASSWORD, name: "Admin", role: "admin" });
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PASSWORD } });
  expect(res.statusCode).toBe(200);
  cookie = `session=${res.cookies.find((c) => c.name === "session")!.value}`;
});

afterAll(async () => {
  await app.close();
  await db.execute(TRUNCATE);
});

const post = (url: string, payload: unknown) =>
  app.inject({ method: "POST", url: `/api/v1${url}`, headers: { cookie }, payload: payload as never });
const get = (url: string) => app.inject({ method: "GET", url: `/api/v1${url}`, headers: { cookie } });

// A manufactured product with 3 × a 100 kr component and one resource.
async function makeProduct() {
  const parent = await testArticleService.createArticle(
    parsed(createArticleSchema, { articleNumber: "TF-1", name: "Produkt", type: "manufactured" })
  );
  const component = await testArticleService.createArticle(
    parsed(createArticleSchema, { articleNumber: "TF-1-K", name: "Komponent", type: "purchased", standardCost: 100 })
  );
  await testArticleService.addBomComponent(parent.id, { componentArticleId: component.id, quantity: 3 });
  const workCenter = await post("/work-centers", { code: "110", name: "Svets", hourlyRate: 500 });
  expect(workCenter.statusCode).toBe(201);
  return { parent, workCenterId: workCenter.json().id as string };
}

async function routingCount() {
  const rows = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM routing_operations`);
  return rows[0]!.n;
}

describe("number fields — bounds and blanks", () => {
  it("refuses a setup time and a sequence number larger than their columns with 400, not 500", async () => {
    const { parent, workCenterId } = await makeProduct();
    const operation = { sequenceNo: 10, workCenterId, setupTime: 5, runTimePerUnit: 1 };
    for (const override of [{ setupTime: 1e12 }, { sequenceNo: 3_000_000_000 }, { runTimePerUnit: 1e7 }, { unitPrice: 1e9 }]) {
      const res = await post(`/articles/${parent.id}/routing`, { ...operation, ...override });
      expect(res.statusCode, JSON.stringify(override)).toBe(400);
      expect(res.json().code).toBe("validation-failed");
    }
    expect(await routingCount()).toBe(0);
    // The column's largest value still passes.
    const ok = await post(`/articles/${parent.id}/routing`, { ...operation, setupTime: 99_999_999.99 });
    expect(ok.statusCode).toBe(201);
  });

  it("refuses a blank or null number in a body instead of storing 0", async () => {
    const { parent, workCenterId } = await makeProduct();
    const operation = { sequenceNo: 10, workCenterId, setupTime: 5, runTimePerUnit: 1 };
    for (const override of [{ setupTime: "" }, { setupTime: "  " }, { runTimePerUnit: null }]) {
      const res = await post(`/articles/${parent.id}/routing`, { ...operation, ...override });
      expect(res.statusCode, JSON.stringify(override)).toBe(400);
      expect(res.json().code).toBe("validation-failed");
    }
    expect(await routingCount()).toBe(0);
    const rate = await post("/work-centers", { code: "120", name: "Kant", hourlyRate: "" });
    expect(rate.statusCode).toBe(400);
    // A numeric string is still coerced, and null still clears a nullable field.
    const ok = await post(`/articles/${parent.id}/routing`, { ...operation, setupTime: "7.5", cycleTimePerUnit: null });
    expect(ok.statusCode).toBe(201);
    expect(Number(ok.json().setupTime)).toBe(7.5);
  });

  it("refuses a calculation quantity larger than the column, on the card and in Förkalkylera flera", async () => {
    const { parent } = await makeProduct();
    const card = await post(`/articles/${parent.id}/cost-calculations/pre-calculate`, { quantity: 1e10, save: true });
    expect(card.statusCode).toBe(400);
    expect(card.json().code).toBe("validation-failed");
    const selection = { activeOnly: true, type: "manufactured" };
    const batch = await post("/costing/pre-calculations/batch", { selection, fallbackQuantity: 1e10 });
    expect(batch.statusCode).toBe(400);
    const own = await post("/costing/pre-calculations/batch", {
      selection,
      fallbackQuantity: 1,
      quantities: [{ articleId: parent.id, quantity: 1e10 }],
    });
    expect(own.statusCode).toBe(400);
    const save = await post("/costing/pre-calculations/batch/save", { items: [{ articleId: parent.id, quantity: 1e10 }] });
    expect(save.statusCode).toBe(400);
    expect(save.json().code).toBe("validation-failed");
  });

  it("answers an amount that overflows its column (Postgres 22003) with 400 number-out-of-range", async () => {
    // A quantity the schema allows × 300 kr material is more than
    // numeric(14,4) holds — no schema bound can see the product.
    const { parent } = await makeProduct();
    const res = await post(`/articles/${parent.id}/cost-calculations/pre-calculate`, { quantity: 9e9, save: true });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("number-out-of-range");
    const rows = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM cost_calculations`);
    expect(rows[0]!.n).toBe(0);
  });

  // Gränser per fält i övriga register (2026-11-13): every shared schema's
  // number is bounded by its column (number-field-bounds.test.ts walks them
  // all); a few through the routes, with the web's text for them.
  const issuesOf = (res: Awaited<ReturnType<typeof post>>) =>
    (res.json().issues as { path: (string | number)[]; code: string }[]).map((i) => `${i.path.join(".")}:${i.code}`);

  it("refuses an article weight, a supplier invoice amount and a unit factor outside their columns on the field", async () => {
    const weight = await post("/articles", { articleNumber: "TF-2", name: "Vikt", type: "purchased", weight: 1e10 });
    expect(weight.statusCode).toBe(400);
    expect(weight.json().code).toBe("validation-failed");
    expect(issuesOf(weight)).toEqual(["weight:too_big"]);
    // numeric(12,3) holds 999 999 999,999 — the largest still passes.
    const largest = await post("/articles", { articleNumber: "TF-2", name: "Vikt", type: "purchased", weight: 999_999_999.999 });
    expect(largest.statusCode).toBe(201);

    // A signed amount (a credit is negative): both ends of numeric(14,2).
    const invoice = { supplierId: crypto.randomUUID(), invoiceNumber: "F-1", invoiceDate: "2026-11-13" };
    for (const netAmount of [-1e13, 1e13]) {
      const res = await post("/supplier-invoices", { ...invoice, netAmount });
      expect(res.statusCode, String(netAmount)).toBe(400);
      expect(issuesOf(res)).toEqual([`netAmount:${netAmount < 0 ? "too_small" : "too_big"}`]);
    }

    // A positive factor below the column's sixth decimal would be stored as 0.
    const unit = await post(`/articles/${largest.json().id}/units`, { unitId: crypto.randomUUID(), quantityPerBase: 0.0000001 });
    expect(unit.statusCode).toBe(400);
    expect(issuesOf(unit)).toEqual(["quantityPerBase:too_small"]);
  });

  it("refuses a calculation quantity that the column would round to 0", async () => {
    const { parent } = await makeProduct();
    const res = await post(`/articles/${parent.id}/cost-calculations/pre-calculate`, { quantity: 0.00004, save: true });
    expect(res.statusCode).toBe(400);
    expect(issuesOf(res)).toEqual(["quantity:too_small"]);
    const rows = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM cost_calculations`);
    expect(rows[0]!.n).toBe(0);
    const smallest = await post(`/articles/${parent.id}/cost-calculations/pre-calculate`, { quantity: 0.0001, save: false });
    expect(smallest.statusCode).toBe(200);
  });

  it("the web names the limit when a number is out of range, and keeps the general text otherwise", async () => {
    const asWeb = (res: Awaited<ReturnType<typeof post>>) =>
      apiErrorMessage(new ApiError(res.json().error, res.statusCode, res.json().code, res.json()), "reserv").replace(/\s/g, " ");
    const big = await post("/articles", { articleNumber: "TF-3", name: "Vikt", type: "purchased", weight: 1e10 });
    expect(asWeb(big)).toBe("Ett tal är för stort — högst 999 999 999,999.");
    const negative = await post("/articles", { articleNumber: "TF-3", name: "Vikt", type: "purchased", weight: -1 });
    expect(asWeb(negative)).toBe("Ett tal är för litet — minst 0.");
    const { parent } = await makeProduct();
    const tiny = await post(`/articles/${parent.id}/cost-calculations/pre-calculate`, { quantity: 0.00004 });
    expect(asWeb(tiny)).toBe("Ett tal är för litet — minst 0,0001.");
    const text = await post("/articles", { articleNumber: "TF-3", name: "", type: "purchased" });
    expect(asWeb(text)).toBe("Ogiltiga uppgifter — kontrollera fälten.");
  });

  it("leaves the query schemas' coercion alone: an empty ?offset= is 0 and an empty ?limit= is refused as before", async () => {
    await makeProduct();
    const offset = await get("/articles?offset=");
    expect(offset.statusCode).toBe(200);
    expect(offset.json().total).toBe(2);
    const limit = await get("/articles?limit=");
    expect(limit.statusCode).toBe(400);
    const plain = await get("/articles?limit=1&offset=1");
    expect(plain.statusCode).toBe(200);
    expect(plain.json().rows).toHaveLength(1);
  });
});

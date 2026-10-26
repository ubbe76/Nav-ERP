import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import { db, articles, customers, manufacturingOrders, moMaterialConsumptions, stockLocations } from "@navet/db";
import { buildApp } from "../src/app.js";
import { createCostingRepository } from "../src/modules/costing/repository/costing.repository.js";
import { createCostingService } from "../src/modules/costing/service/costing.service.js";
import { manufacturingCost } from "../src/modules/costing/service/cost-figures.js";
import { DEMO_DATA, DEMO_LOCATIONS } from "../src/modules/demo/service/demo-data.js";

// The demo company is only useful if the ordinary routines accept it: an
// order, a manufacturing order with the phantom dissolved, the costing and
// the requirements calculation. One company for the whole file.

const TRUNCATE = sql`TRUNCATE articles, customers, suppliers, work_centers, production_groups, article_groups, payment_terms, deviation_reasons, audit_log, user_settings, users CASCADE`;
const PASSWORD = "ett-tillräckligt-långt-lösenord";
const app = buildApp();
let cookie = "";
const ids = new Map<string, string>();

// Same stub as test/costing.service.test.ts: standard material costs, no markups.
const costing = createCostingService(createCostingRepository(db), {
  getSettings: async () => ({
    costingMaterialSource: "standard" as const,
    costingSupplierPriceTier: "base" as const,
    costingMoPercent: 0,
    costingLoPercent: 0,
    costingAffoPercent: 0,
    costingGeneralMarkupPercent: 0,
  }),
});

beforeAll(async () => {
  await db.execute(TRUNCATE);
  await db.delete(stockLocations).where(inArray(stockLocations.name, Object.values(DEMO_LOCATIONS)));
  await app.ready();
  await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: { email: "admin@example.com", password: PASSWORD, name: "Admin", setupCode: app.setup.code.code },
  });
  const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "admin@example.com", password: PASSWORD } });
  cookie = login.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  expect((await app.inject({ method: "POST", url: "/api/v1/demo-data", headers: { cookie } })).statusCode).toBe(201);
  for (const a of await db.select({ id: articles.id, n: articles.articleNumber }).from(articles)) ids.set(a.n, a.id);
});

afterAll(async () => {
  await app.close();
  await db.execute(TRUNCATE);
  await db.delete(stockLocations).where(inArray(stockLocations.name, Object.values(DEMO_LOCATIONS)));
});

describe("exempeldata i de vanliga flödena", () => {
  it("keeps every manufactured standard price equal to the costing's TVK per unit", async () => {
    // Sub-assemblies first: the products' costing reads their standard cost.
    for (const n of ["2001", "2002", "2003", "3001", "3002", "3003"]) {
      const { calculation } = await costing.preCalculate(ids.get(n)!, 1);
      const expected = DEMO_DATA.articles.find((a) => a.articleNumber === n)!.standardCost;
      expect(Math.round(manufacturingCost(calculation)), n).toBe(expected);
    }
  });

  it("takes a confirmed customer order on a product at its sales price", async () => {
    const [customer] = await db.select({ id: customers.id }).from(customers).limit(1);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/quotes",
      headers: { cookie },
      payload: { customerId: customer!.id, confirm: true, rows: [{ articleId: ids.get("3003"), quantity: 2 }] },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().order.status).toBe("confirmed");
  });

  it("sees the order's demand in the requirements calculation", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/planning/requirements?refresh=true&showAll=true&search=3003", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const row = res.json().rows.find((r: { articleNumber: string }) => r.articleNumber === "3003");
    expect(row.demandSales).toBe(2);
  });

  it("releases a manufacturing order with the phantom dissolved and material linked to operations", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/manufacturing-orders",
      headers: { cookie },
      payload: { articleId: ids.get("2002"), quantity: 2 },
    });
    expect(res.statusCode).toBe(201);
    const moId = res.json().id as string;
    const [mo] = await db.select().from(manufacturingOrders).where(eq(manufacturingOrders.id, moId));
    expect(mo!.status).toBe("released");

    const materials = await db.select().from(moMaterialConsumptions).where(eq(moMaterialConsumptions.manufacturingOrderId, moId));
    const components = new Set(materials.map((m) => m.componentArticleId));
    expect(components.has(ids.get("1010")!)).toBe(true);
    expect(components.has(ids.get("1020")!)).toBe(true);
    expect(components.has(ids.get("2100")!)).toBe(false);
    expect(materials.filter((m) => m.componentArticleId === ids.get("1010")).some((m) => m.moOperationId !== null)).toBe(true);
  });
});

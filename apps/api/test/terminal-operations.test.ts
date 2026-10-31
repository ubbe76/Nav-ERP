import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db, permissionGroups } from "@navet/db";
import { buildApp } from "../src/app.js";
import { createAuthService } from "../src/modules/auth/service/auth.service.js";
import { testArticleService, testDocumentPdfService } from "./helpers/services.js";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import { createManufacturingService } from "../src/modules/manufacturing/service/manufacturing.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";

// Stämpelterminalens operationslista: GET /terminal/operations lists every
// stampable operation (released/in-progress order, pending, never lego) with
// its readiness computed over ALL the order's operations, and the linked
// materials; GET /terminal/stations lists active non-lego work centers in
// natural number order.

const articleService = createArticleService(createArticleRepository(db));
const authRepo = createAuthRepository(db);
const mfgService = createManufacturingService(createManufacturingRepository(db), testDocumentPdfService, testArticleService);

const TABLES = sql`TRUNCATE stamp_sessions, time_reports, employees, mo_reports, mo_report_materials, mo_operation_scrap, mo_material_consumptions, mo_operations, manufacturing_orders, routing_operations, work_centers, production_groups, stock_transactions, stock_locations, warehouses, bom_components, articles, audit_log, user_settings, users CASCADE`;
// Only the groups this file creates — the migration's seeded groups belong
// to other test files.
const DELETE_GROUPS = sql`DELETE FROM permission_groups WHERE code LIKE 'TOPS%'`;

beforeEach(async () => {
  await db.execute(TABLES);
  await db.execute(DELETE_GROUPS);
});
afterAll(async () => {
  await db.execute(TABLES);
  await db.execute(DELETE_GROUPS);
});

async function makeArticle(articleNumber: string, name: string, type: "manufactured" | "purchased") {
  return articleService.createArticle({ articleNumber, name, type, unit: "st", active: true });
}

// Rutt 10 Kap(100) → 20 Lego(900) → 30 Svets(200); PLÅT-2 linked to op 10,
// RÖR-30 linked to op 30, plus an unlinked component.
async function setup() {
  const user = await authRepo.create({
    email: `tops-${crypto.randomUUID()}@example.com`,
    passwordHash: "x",
    name: "Ledare",
    role: "admin",
  });
  // Created out of order so the station sort is exercised. The database
  // holds codes to exactly three digits (work_center_code_three_digits), so
  // "090" stands in for the spec's "90".
  const svets = await mfgService.createWorkCenter({ code: "200", name: "Svets", active: true });
  const kap = await mfgService.createWorkCenter({ code: "100", name: "Kap", active: true });
  const gradning = await mfgService.createWorkCenter({ code: "090", name: "Gradning", active: true });
  const lego = await mfgService.createWorkCenter({ code: "900", name: "Ytbehandling AB", type: "subcontract", active: true });
  await mfgService.createWorkCenter({ code: "300", name: "Gammal", active: false });

  const parent = await makeArticle(`STOL-${crypto.randomUUID().slice(0, 8)}`, "Stol", "manufactured");
  const plat = await makeArticle("PLÅT-2", "Plåt 2 mm", "purchased");
  const ror = await makeArticle("RÖR-30", "Rör 30 mm", "purchased");
  const skruv = await makeArticle("SKRUV-6", "Skruv M6", "purchased");
  const r10 = await mfgService.createRoutingOperation(parent.id, { sequenceNo: 10, workCenterId: kap.id, setupTime: 0, runTimePerUnit: 1 });
  await mfgService.createRoutingOperation(parent.id, { sequenceNo: 20, workCenterId: lego.id, setupTime: 0, runTimePerUnit: 0 });
  const r30 = await mfgService.createRoutingOperation(parent.id, { sequenceNo: 30, workCenterId: svets.id, setupTime: 0, runTimePerUnit: 1 });
  await articleService.addBomComponent(parent.id, { componentArticleId: plat.id, quantity: 1, routingOperationId: r10.id });
  await articleService.addBomComponent(parent.id, { componentArticleId: ror.id, quantity: 2, routingOperationId: r30.id });
  await articleService.addBomComponent(parent.id, { componentArticleId: skruv.id, quantity: 4 });

  const order = await mfgService.createManufacturingOrder({ articleId: parent.id, quantity: 20 }, user.id);
  const ops = await mfgService.listOperations(order.id);
  const op = (seq: number) => ops.find((o) => o.sequenceNo === seq)!;
  return { user, kap, svets, gradning, lego, parent, plat, ror, skruv, order, op10: op(10), op20: op(20), op30: op(30) };
}

describe("listTerminalStations", () => {
  it("lists active non-lego work centers in natural number order", async () => {
    await setup();
    const stations = await mfgService.listTerminalStations();
    expect(stations.map((s) => s.code)).toEqual(["090", "100", "200"]);
    expect(Object.keys(stations[0]!).sort()).toEqual(["code", "id", "name"]);
  });
});

describe("listTerminalOperations", () => {
  it("lists stampable operations with readiness over the whole order, never lego", async () => {
    const f = await setup();
    await mfgService.reportOperationQuantities(f.op10.id, { quantityOk: 8, quantityScrapped: 0, markDone: false, createdBy: f.user.id });

    let { rows } = await mfgService.listTerminalOperations({});
    expect(rows.map((r) => r.sequenceNo).sort((a, b) => a - b)).toEqual([10, 30]);
    const row10 = rows.find((r) => r.sequenceNo === 10)!;
    expect([row10.readiness, row10.available]).toEqual(["ready", "12"]);
    expect(row10).toMatchObject({
      operationId: f.op10.id,
      manufacturingOrderId: f.order.id,
      orderNumber: f.order.orderNumber,
      articleNumber: f.parent.articleNumber,
      articleName: "Stol",
      workCenterId: f.kap.id,
      workCenterCode: "100",
      workCenterName: "Kap",
    });
    expect(Number(row10.orderQuantity)).toBe(20);
    expect(Number(row10.quantityCompleted)).toBe(8);
    // The lego operation (0 OK) is the previous one of op 30.
    const row30 = rows.find((r) => r.sequenceNo === 30)!;
    expect([row30.readiness, row30.available]).toEqual(["not_ready", "0"]);

    await db.execute(sql`UPDATE mo_operations SET quantity_completed = 5 WHERE id = ${f.op20.id}`);
    ({ rows } = await mfgService.listTerminalOperations({}));
    expect(rows.find((r) => r.sequenceNo === 30)).toMatchObject({ readiness: "partial", available: "5" });

    // The station filter does not hide the previous operation from the rule.
    ({ rows } = await mfgService.listTerminalOperations({ workCenterIds: [f.svets.id] }));
    expect(rows.map((r) => [r.sequenceNo, r.readiness, r.available])).toEqual([[30, "partial", "5"]]);
  });

  it("carries the linked materials and filters on them, keeping the picker list whole", async () => {
    const f = await setup();
    const all = await mfgService.listTerminalOperations({});
    const material = (seq: number) => all.rows.find((r) => r.sequenceNo === seq)!.materials;
    expect(material(10)).toEqual([{ articleId: f.plat.id, articleNumber: "PLÅT-2", articleName: "Plåt 2 mm" }]);
    expect(material(30)).toEqual([{ articleId: f.ror.id, articleNumber: "RÖR-30", articleName: "Rör 30 mm" }]);
    expect(JSON.stringify(all)).not.toContain(f.skruv.id);
    expect(all.materials.map((m) => m.articleNumber)).toEqual(["PLÅT-2", "RÖR-30"]);

    const filtered = await mfgService.listTerminalOperations({ materialArticleId: f.plat.id });
    expect(filtered.rows.map((r) => r.sequenceNo)).toEqual([10]);
    expect(filtered.materials.map((m) => m.articleNumber)).toEqual(["PLÅT-2", "RÖR-30"]);
  });

  it("sorts a row's materials and the picker in natural number order (2 before 10), as the web does", async () => {
    const f = await setup();
    const parent = await makeArticle(`BORD-${crypto.randomUUID().slice(0, 8)}`, "Bord", "manufactured");
    const m10 = await makeArticle("BEN-10", "Ben 10", "purchased");
    const m2 = await makeArticle("BEN-2", "Ben 2", "purchased");
    const r10 = await mfgService.createRoutingOperation(parent.id, { sequenceNo: 10, workCenterId: f.kap.id, setupTime: 0, runTimePerUnit: 1 });
    await articleService.addBomComponent(parent.id, { componentArticleId: m10.id, quantity: 1, routingOperationId: r10.id });
    await articleService.addBomComponent(parent.id, { componentArticleId: m2.id, quantity: 1, routingOperationId: r10.id });
    await mfgService.createManufacturingOrder({ articleId: parent.id, quantity: 1 }, f.user.id);
    const all = await mfgService.listTerminalOperations({});
    const row = all.rows.find((r) => r.articleNumber === parent.articleNumber)!;
    expect(row.materials.map((m) => m.articleNumber)).toEqual(["BEN-2", "BEN-10"]);
    expect(all.materials.map((m) => m.articleNumber)).toEqual(["BEN-2", "BEN-10", "PLÅT-2", "RÖR-30"]);
  });

  it("leaves out planned and done orders and done operations", async () => {
    const f = await setup();
    const planned = await mfgService.createManufacturingOrder({ articleId: f.parent.id, quantity: 3 }, f.user.id);
    const done = await mfgService.createManufacturingOrder({ articleId: f.parent.id, quantity: 3 }, f.user.id);
    await db.execute(sql`UPDATE manufacturing_orders SET status = 'planned' WHERE id = ${planned.id}`);
    await db.execute(sql`UPDATE manufacturing_orders SET status = 'done' WHERE id = ${done.id}`);
    await db.execute(sql`UPDATE mo_operations SET status = 'done' WHERE id = ${f.op10.id}`);

    const { rows } = await mfgService.listTerminalOperations({});
    expect(rows.map((r) => [r.orderNumber, r.sequenceNo])).toEqual([[f.order.orderNumber, 30]]);
  });
});

describe("GET /terminal/operations and /terminal/stations", () => {
  const app = buildApp();
  const authService = createAuthService(createAuthRepository(db), "unused", createAuditRepository(db));

  afterAll(async () => {
    await app.close();
  });

  async function session(permissions: string[]) {
    const [group] = await db
      .insert(permissionGroups)
      .values({ code: `TOPS${crypto.randomUUID().slice(0, 8)}`, name: "Terminal", permissions })
      .returning();
    const email = `r-${crypto.randomUUID()}@example.com`;
    await authService.createUser({ email, password: "correcthorse", name: "R", role: "user", permissionGroupId: group!.id });
    const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: "correcthorse" } });
    return `session=${res.cookies.find((c) => c.name === "session")!.value}`;
  }

  it("serves the terminal profile without prices and validates the query", async () => {
    const f = await setup();
    // The terminal profile: role user, no menus, only the terminal.
    const cookie = await session(["terminal"]);
    const get = (url: string) => app.inject({ method: "GET", url: `/api/v1${url}`, headers: { cookie } });

    const operations = await get(`/terminal/operations?workCenterIds=${f.kap.id},${f.svets.id}`);
    expect(operations.statusCode).toBe(200);
    const body = operations.json();
    expect(body.rows.map((r: { sequenceNo: number }) => r.sequenceNo).sort()).toEqual([10, 30]);
    expect(JSON.stringify(body)).not.toMatch(/price|cost/i);

    const byMaterial = await get(`/terminal/operations?materialArticleId=${f.ror.id}`);
    expect(byMaterial.json().rows.map((r: { sequenceNo: number }) => r.sequenceNo)).toEqual([30]);

    const stations = await get("/terminal/stations");
    expect(stations.statusCode).toBe(200);
    expect(stations.json().map((s: { code: string }) => s.code)).toEqual(["090", "100", "200"]);
    expect(JSON.stringify(stations.json())).not.toMatch(/price|cost|rate/i);

    expect((await get("/terminal/operations?workCenterIds=abc")).statusCode).toBe(400);
    expect((await get("/terminal/operations?materialArticleId=abc")).statusCode).toBe(400);
  });
});

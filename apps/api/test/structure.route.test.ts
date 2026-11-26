import { createArticleSchema, createManufacturingOrderSchema, createStockLocationSchema, createWorkCenterSchema } from "@navet/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { customers, db, manufacturingOrders, permissionGroups, purchaseOrderRows, purchaseOrders, salesOrderRows, salesOrders, suppliers } from "@navet/db";
import { buildApp } from "../src/app.js";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createAuthService } from "../src/modules/auth/service/auth.service.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import { createManufacturingService } from "../src/modules/manufacturing/service/manufacturing.service.js";
import { createPlanningRepository } from "../src/modules/planning/repository/planning.repository.js";
import type { CapacityResult } from "../src/modules/planning/service/capacity-calc.js";
import type { SalesOrderDeliveryOutlook } from "../src/modules/planning/service/delivery-outlook.js";
import { createPlanningService, type ManufacturingOrderCoverage } from "../src/modules/planning/service/planning.service.js";
import type { StructureNode, StructureOrderNode, StructureResult } from "../src/modules/planning/service/structure-tree.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { createStockService } from "../src/modules/stock/service/stock.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { stockholmToday } from "../src/modules/system/service/delivery-days.js";
import { parsed } from "./helpers/parsed.js";
import { testArticleService, testDocumentPdfService } from "./helpers/services.js";
import { unwiredSalesOrderLinks } from "./helpers/unwired";

// GET /planning/structure through the real app (spec 2026-11-26, etapp 4,
// step 4b): the tree says what the other views say about the same orders —
// the material rows are the TO card's coverage, Sen and the planned days the
// TO list's, an operation's days Beläggning's day view, a kundorder's rows
// Leveransläget's — and it is loaded with ONE pegging batch per TO level,
// however wide the level is. The drawing itself is tested in
// structure-tree.test.ts (pure). The plans are made by the app's own Planera
// (the real "today") and compared with the other routes' answers, so the
// file runs on any weekday.

const articleService = createArticleService(createArticleRepository(db));
const authRepo = createAuthRepository(db);
const authService = createAuthService(authRepo, "unused", createAuditRepository(db));
const stockService = createStockService(createStockRepository(db));
// No plan reader: the orders are created unplanned, the app's Planera plans.
const mfgService = createManufacturingService(createManufacturingRepository(db), testDocumentPdfService, testArticleService, unwiredSalesOrderLinks);
const PASSWORD = "correcthorsebattery";

const TABLES = sql`TRUNCATE mo_operation_plan_days, stamp_sessions, mo_reports, mo_report_materials, mo_operation_scrap, mo_material_consumptions, mo_operations, manufacturing_orders, sales_order_rows, sales_orders, customers, purchase_order_rows, purchase_orders, suppliers, routing_operations, work_centers, production_groups, holidays, stock_transactions, stock_locations, warehouses, bom_components, article_suppliers, articles, audit_log, user_settings, users CASCADE`;
const DELETE_GROUPS = sql`DELETE FROM permission_groups WHERE code LIKE 'STR%'`;

let app: ReturnType<typeof buildApp>;
beforeAll(async () => {
  app = buildApp();
  await app.ready();
});
beforeEach(async () => {
  await db.execute(TABLES);
  await db.execute(DELETE_GROUPS);
});
afterAll(async () => {
  await app.close();
  await db.execute(TABLES);
  await db.execute(DELETE_GROUPS);
});

const today = stockholmToday();
const addDays = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const suffix = () => crypto.randomUUID().slice(0, 8);

async function login(email: string) {
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PASSWORD } });
  expect(res.statusCode).toBe(200);
  return `session=${res.cookies.find((c) => c.name === "session")!.value}`;
}
async function adminCookie() {
  const email = `admin-${crypto.randomUUID()}@example.com`;
  await authService.createUser({ email, password: PASSWORD, name: "Admin", role: "admin" });
  return login(email);
}
async function userCookie(permissions: string[], readOnly = false) {
  const [group] = await db
    .insert(permissionGroups)
    .values({ code: `STR${crypto.randomUUID().slice(0, 6)}`, name: "Struktur", permissions })
    .returning();
  const email = `user-${crypto.randomUUID()}@example.com`;
  await authService.createUser({ email, password: PASSWORD, name: "Användare", role: "user", permissionGroupId: group!.id, readOnly });
  return login(email);
}
const get = (cookie: string, url: string) => app.inject({ url: `/api/v1${url}`, headers: { cookie } });
const structureOfOrder = (cookie: string, id: string) => get(cookie, `/planning/structure?manufacturingOrderId=${id}`);
const structureOfSalesOrder = (cookie: string, id: string) => get(cookie, `/planning/structure?salesOrderId=${id}`);

// P is made of B (purchased, on the shelf), G and H (halvfabrikat); H is made
// of S (halvfabrikat), S of R (purchased, on an inköpsorder). One TO each
// for P, G, H and S — a tree of three TO levels, the second two TOs wide.
async function world() {
  const user = await authRepo.create({ email: `str-${crypto.randomUUID()}@example.com`, passwordHash: "x", name: "Planerare", role: "admin" });
  const kap = await mfgService.createWorkCenter(parsed(createWorkCenterSchema, { code: "101", name: "Kap", hoursPerDay: 8, active: true }));
  const montering = await mfgService.createWorkCenter(parsed(createWorkCenterSchema, { code: "201", name: "Montering", hoursPerDay: 8, active: true }));
  const x = suffix();
  const article = (prefix: string, name: string, type: "manufactured" | "purchased") =>
    articleService.createArticle(parsed(createArticleSchema, { articleNumber: `${prefix}-${x}`, name, type, active: true, standardCost: 12.5 }));
  const beslag = await article("B", "Beslag", "purchased");
  const gavel = await article("G", "Gavel", "manufactured");
  const halv = await article("H", "Halvfabrikat", "manufactured");
  const product = await article("P", "Produkt", "manufactured");
  const raw = await article("R", "Råvara", "purchased");
  const stomme = await article("S", "Stomme", "manufactured");
  await mfgService.createRoutingOperation(gavel.id, { sequenceNo: 10, workCenterId: kap.id, setupTime: 0, runTimePerUnit: 30 });
  await mfgService.createRoutingOperation(stomme.id, { sequenceNo: 10, workCenterId: kap.id, setupTime: 0, runTimePerUnit: 30 });
  await mfgService.createRoutingOperation(halv.id, { sequenceNo: 10, workCenterId: kap.id, setupTime: 0, runTimePerUnit: 60 });
  await mfgService.createRoutingOperation(product.id, { sequenceNo: 10, workCenterId: kap.id, setupTime: 30, runTimePerUnit: 60, description: "Kapa" });
  await mfgService.createRoutingOperation(product.id, { sequenceNo: 20, workCenterId: montering.id, setupTime: 0, runTimePerUnit: 90 });
  await articleService.addBomComponent(stomme.id, { componentArticleId: raw.id, quantity: 1 });
  await articleService.addBomComponent(halv.id, { componentArticleId: stomme.id, quantity: 1 });
  await articleService.addBomComponent(product.id, { componentArticleId: beslag.id, quantity: 2 });
  await articleService.addBomComponent(product.id, { componentArticleId: gavel.id, quantity: 1 });
  await articleService.addBomComponent(product.id, { componentArticleId: halv.id, quantity: 1 });

  const order = (articleId: string, quantity: number, dueDate: string) =>
    mfgService.createManufacturingOrder(parsed(createManufacturingOrderSchema, { articleId, quantity, dueDate }), user.id);
  const warehouse = await stockService.createWarehouse({ name: "Huvudlager", active: true });
  const stock = async (articleId: string, quantity: number) => {
    const place = await stockService.createLocation(parsed(createStockLocationSchema, { warehouseId: warehouse!.id, name: `A-${suffix()}`, active: true }));
    await stockService.recordTransaction({ articleId, locationId: place.id, quantityDelta: quantity, transactionType: "inventory_adjustment" });
  };
  const purchaseOrder = async (articleId: string, quantity: number, date: string | null) => {
    const [supplier] = await db.insert(suppliers).values({ supplierNumber: `L${suffix()}`, name: "Leverantör AB" }).returning();
    const [po] = await db
      .insert(purchaseOrders)
      .values({ orderNumber: `IO-${suffix()}`, supplierId: supplier!.id, status: "confirmed", expectedDeliveryDate: date })
      .returning();
    await db.insert(purchaseOrderRows).values({ purchaseOrderId: po!.id, articleId, quantityOrdered: String(quantity), quantityReceived: "0", unitPrice: "10" });
    return po!;
  };
  // A kundorder written straight into the tables (the tree only reads).
  const salesOrder = async (status: "quote" | "confirmed", rows: { articleId: string; quantity: number }[]) => {
    const [customer] = await db.insert(customers).values({ customerNumber: `K${suffix()}`, name: "Kund AB" }).returning();
    const [head] = await db
      .insert(salesOrders)
      .values({ orderNumber: `KO-${suffix()}`, customerId: customer!.id, status, expectedDeliveryDate: addDays(today, 60) })
      .returning();
    const rowIds: string[] = [];
    for (const [i, row] of rows.entries()) {
      const [inserted] = await db
        .insert(salesOrderRows)
        .values({
          salesOrderId: head!.id,
          articleId: row.articleId,
          quantityOrdered: String(row.quantity),
          unitPrice: "777.25",
          discountPercent: "10",
          // The card's row order is created_at, then id.
          createdAt: new Date(Date.UTC(2030, 0, 1, 12, 0, i)),
        })
        .returning();
      rowIds.push(inserted!.id);
    }
    return { ...head!, rowIds };
  };

  await stock(beslag.id, 10);
  const io = await purchaseOrder(raw.id, 2, addDays(today, 10));
  const s = await order(stomme.id, 2, addDays(today, 20));
  const h = await order(halv.id, 2, addDays(today, 30));
  const g = await order(gavel.id, 2, addDays(today, 30));
  const p = await order(product.id, 2, addDays(today, 40));
  const cookie = await adminCookie();
  const plan = () => app.inject({ method: "POST", url: "/api/v1/planning/plan", headers: { cookie } });
  expect((await plan()).statusCode).toBe(200);
  return { user, cookie, beslag, gavel, halv, product, raw, stomme, io, s, h, g, p, order, stock, purchaseOrder, salesOrder, plan };
}

const orderNode = (tree: StructureResult, id: string) =>
  tree.nodes.find((n): n is StructureOrderNode => n.kind === "order" && n.manufacturingOrderId === id && n.repeatOf === null)!;
const childrenOf = (tree: StructureResult, id: string) => tree.nodes.filter((n) => n.parentId === id);
// What covers a need as the TO card's coverage says it: the fields the tree's
// order link and its supply leaves share with CoverageAllocation.
const coverOf = (node: StructureNode) =>
  node.kind === "order"
    ? { kind: "manufacturing_order", documentId: node.manufacturingOrderId, quantity: node.link!.quantity, late: node.link!.late, undated: node.link!.undated, daysLate: node.link!.daysLate }
    : node.kind === "supply"
      ? { kind: node.supply, documentId: node.documentId, quantity: node.quantity, late: node.late, undated: node.undated, daysLate: node.daysLate }
      : null;

describe("GET /planning/structure with a tillverkningsorder at the top", () => {
  it("draws the TO, its material rows and what covers them, level by level — the same data as the TO card's coverage", async () => {
    const w = await world();
    const res = await structureOfOrder(w.cookie, w.p.id);
    expect(res.statusCode, res.body).toBe(200);
    const tree: StructureResult = res.json();
    expect(tree.today).toBe(today);
    expect(tree.root).toEqual({ kind: "manufacturing_order", manufacturingOrderId: w.p.id, orderNumber: w.p.orderNumber });
    expect(tree.truncated).toEqual({ depth: false, nodes: false, cycle: [] });
    expect(tree.totals).toMatchObject({ orders: 4, missing: 0, lockedOperations: 0 });

    // Depth first, the material rows in article number order: B, G, H.
    expect(tree.nodes.map((n) => [n.kind, n.level])).toEqual([
      ["order", 0], // P
      ["material", 1], // B
      ["supply", 2], // the shelf
      ["material", 1], // G
      ["order", 2],
      ["material", 1], // H
      ["order", 2],
      ["material", 3], // S
      ["order", 4],
      ["material", 5], // R
      ["supply", 6], // the inköpsorder
    ]);
    const root = tree.nodes[0] as StructureOrderNode;
    expect(root).toMatchObject({
      id: `mo:${w.p.id}`,
      parentId: null,
      manufacturingOrderId: w.p.id,
      orderNumber: w.p.orderNumber,
      orderStatus: "released",
      articleId: w.product.id,
      articleNumber: w.product.articleNumber,
      articleName: "Produkt",
      remainingQuantity: 2,
      dueDate: addDays(today, 40),
      link: null,
      repeatOf: null,
    });
    expect(root.operations.map((op) => [op.sequenceNo, op.description, op.workCenterCode, op.status, op.subcontract, op.remainingHours])).toEqual([
      [10, "Kapa", "101", "pending", false, 2.5],
      [20, null, "201", "pending", false, 3],
    ]);
    expect(childrenOf(tree, root.id).map((n) => (n.kind === "material" ? [n.articleNumber, n.articleType, n.quantity, n.uncovered, n.fromStockOnly] : null))).toEqual([
      [w.beslag.articleNumber, "purchased", 4, 0, true],
      [w.gavel.articleNumber, "manufactured", 2, 0, false],
      [w.halv.articleNumber, "manufactured", 2, 0, false],
    ]);
    // The whole TO goes to its parent ⇒ exclusive (moveCandidates' rule).
    expect(orderNode(tree, w.h.id).link).toMatchObject({ quantity: 2, exclusive: true });
    expect(tree.nodes[tree.nodes.length - 1]).toMatchObject({ kind: "supply", supply: "purchase_order", documentId: w.io.id, documentNumber: w.io.orderNumber, quantity: 2 });

    // Every TO's material rows are the TO card's Täcks av for the same TO.
    for (const mo of [w.p, w.g, w.h, w.s]) {
      const coverage: ManufacturingOrderCoverage = (await get(w.cookie, `/manufacturing-orders/${mo.id}/coverage`)).json();
      const node = orderNode(tree, mo.id);
      const materials = childrenOf(tree, node.id);
      expect(materials.map((m) => m.id).sort()).toEqual(coverage.materials.map((m) => m.rowId).sort());
      for (const material of coverage.materials) {
        const drawn = materials.find((m) => m.id === material.rowId)!;
        expect(drawn).toMatchObject({
          kind: "material",
          articleId: material.articleId,
          articleNumber: material.articleNumber,
          articleName: material.articleName,
          articleType: material.articleType,
          needDate: material.needDate,
          quantity: material.quantity,
          uncovered: material.uncovered,
        });
        expect(childrenOf(tree, drawn.id).map(coverOf)).toEqual(
          material.allocations.map((a) => ({ kind: a.kind, documentId: a.documentId, quantity: a.quantity, late: a.late, undated: a.undated, daysLate: a.daysLate }))
        );
      }
      expect(node.componentLate).toBe(coverage.componentLate);
    }
  });

  it("says Sen and the planned days like the TO list, and an operation's days like Beläggning's day view", async () => {
    const w = await world();
    const tree: StructureResult = (await structureOfOrder(w.cookie, w.p.id)).json();
    const list: { rows: { id: string; late: boolean; plannedStartDate: string | null; plannedEndDate: string | null }[] } = (
      await get(w.cookie, "/manufacturing-orders?limit=100")
    ).json();
    expect(list.rows).toHaveLength(4);
    for (const row of list.rows) {
      const node = orderNode(tree, row.id);
      expect({ late: node.late, plannedStartDate: node.plannedStartDate, plannedEndDate: node.plannedEndDate }).toEqual({
        late: row.late,
        plannedStartDate: row.plannedStartDate,
        plannedEndDate: row.plannedEndDate,
      });
      expect(node.plannedStartDate).not.toBeNull();
      // Planned ⇒ the finish is the last planned day here (no lego).
      expect(node.plannedFinish).toBe(node.plannedEndDate);
    }

    const capacity: CapacityResult = (await get(w.cookie, "/planning/capacity?granularity=day&days=42")).json();
    const daysOf = new Map<string, { date: string; hours: number }[]>();
    for (const resource of capacity.groups.flatMap((g) => g.resources)) {
      resource.days.forEach((cell, i) => {
        for (const chip of cell.orders) daysOf.set(chip.moOperationId, [...(daysOf.get(chip.moOperationId) ?? []), { date: capacity.days[i]!.date, hours: chip.hoursInDay! }]);
      });
    }
    const operations = tree.nodes.flatMap((n) => (n.kind === "order" ? n.operations : []));
    expect(operations).toHaveLength(5);
    for (const op of operations) {
      expect(op.days.length).toBeGreaterThan(0);
      expect(op.days).toEqual(daysOf.get(op.moOperationId));
      expect([op.plannedStartDate, op.plannedEndDate]).toEqual([op.days[0]!.date, op.days[op.days.length - 1]!.date]);
    }
    // The axis holds every planned day and starts today.
    expect(tree.axis.from).toBe(today);
    expect(tree.axis.days[0]).toMatchObject({ date: today });
    expect(tree.axis.days.length).toBeGreaterThanOrEqual(14);
  });

  it("Går till is the TO card's, one level up", async () => {
    const w = await world();
    const ko = await w.salesOrder("confirmed", [{ articleId: w.product.id, quantity: 2 }]);
    const coverage: ManufacturingOrderCoverage = (await get(w.cookie, `/manufacturing-orders/${w.p.id}/coverage`)).json();
    expect(coverage.goesTo).toEqual([expect.objectContaining({ kind: "sales_order", documentId: ko.id, documentNumber: ko.orderNumber, partner: "Kund AB", quantity: 2 })]);
    expect(((await structureOfOrder(w.cookie, w.p.id)).json() as StructureResult).goesTo).toEqual(coverage.goesTo);

    // A halvfabrikat goes to its parent TO.
    const halv: StructureResult = (await structureOfOrder(w.cookie, w.h.id)).json();
    expect(halv.goesTo).toEqual(((await get(w.cookie, `/manufacturing-orders/${w.h.id}/coverage`)).json() as ManufacturingOrderCoverage).goesTo);
    expect(halv.goesTo).toEqual([expect.objectContaining({ kind: "mo_material", documentId: w.p.id, documentNumber: w.p.orderNumber })]);
    expect(halv.nodes.filter((n) => n.kind === "order").map((n) => n.kind === "order" && n.manufacturingOrderId)).toEqual([w.h.id, w.s.id]);
  });

  it("a closed TO is a root without children, like coverage", async () => {
    const w = await world();
    await db.update(manufacturingOrders).set({ status: "closed" }).where(eq(manufacturingOrders.id, w.p.id));
    const res = await structureOfOrder(w.cookie, w.p.id);
    expect(res.statusCode, res.body).toBe(200);
    const tree: StructureResult = res.json();
    expect(tree.root).toEqual({ kind: "manufacturing_order", manufacturingOrderId: w.p.id, orderNumber: w.p.orderNumber });
    expect(tree.nodes).toEqual([
      expect.objectContaining({ kind: "order", manufacturingOrderId: w.p.id, orderStatus: "closed", articleName: "Produkt", operations: [], componentLate: false, late: false }),
    ]);
    expect(tree.goesTo).toEqual([]);
    expect(tree.truncated).toEqual({ depth: false, nodes: false, cycle: [] });
    expect(tree.axis.days).toHaveLength(14);
  });
});

describe("GET /planning/structure with a kundorder at the top", () => {
  it("the rows are Leveransläget's: a TO with its two levels, the shelf, an inköpsorder and what is missing", async () => {
    const w = await world();
    const lock = await articleService.createArticle(parsed(createArticleSchema, { articleNumber: `L-${suffix()}`, name: "Lås", type: "purchased", active: true }));
    await w.stock(lock.id, 3);
    const lockIo = await w.purchaseOrder(lock.id, 1, addDays(today, 5));
    const ko = await w.salesOrder("confirmed", [
      { articleId: w.product.id, quantity: 2 },
      { articleId: lock.id, quantity: 5 },
    ]);
    const res = await structureOfSalesOrder(w.cookie, ko.id);
    expect(res.statusCode, res.body).toBe(200);
    const tree: StructureResult = res.json();
    const outlook: SalesOrderDeliveryOutlook = (await get(w.cookie, `/sales-orders/${ko.id}/delivery-outlook`)).json();
    expect(outlook.rows).toHaveLength(2);
    // The card's answer without its own head fields and the rows.
    const { salesOrderId: _id, orderNumber: _number, orderStatus: _status, today: _today, rows: _rows, ...orderOutlook } = outlook;

    expect(tree.root).toEqual({
      kind: "sales_order",
      salesOrderId: ko.id,
      orderNumber: ko.orderNumber,
      customerName: "Kund AB",
      outlook: orderOutlook,
    });
    expect(tree.goesTo).toEqual([]);
    const rows = tree.nodes.filter((n) => n.kind === "sales_row");
    expect(rows.map((n) => n.kind === "sales_row" && n.row)).toEqual(outlook.rows);
    expect(rows.map((n) => [n.id, n.level, n.parentId])).toEqual(ko.rowIds.map((id) => [`row:${id}`, 0, null]));

    // Row 1: the product's TO — the whole of it goes to the row — and its tree.
    const [productRow, lockRow] = rows;
    const underProduct = childrenOf(tree, productRow!.id);
    expect(underProduct).toEqual([expect.objectContaining({ kind: "order", manufacturingOrderId: w.p.id, level: 1, repeatOf: null })]);
    expect((underProduct[0] as StructureOrderNode).link).toMatchObject({ quantity: 2, needDate: outlook.rows[0]!.promisedShipDate, exclusive: true });
    expect(tree.nodes.filter((n) => n.kind === "order").map((n) => n.kind === "order" && [n.manufacturingOrderId, n.level])).toEqual([
      [w.p.id, 1],
      [w.g.id, 3],
      [w.h.id, 3],
      [w.s.id, 5],
    ]);
    // The same subtree as with the TO at the top, one level further in.
    const alone: StructureResult = (await structureOfOrder(w.cookie, w.p.id)).json();
    expect(tree.nodes.filter((n) => n.level > 1).map((n) => [n.id, n.level - 1])).toEqual(
      alone.nodes.slice(1).map((n) => [n.id, n.level])
    );

    // Row 2: 3 st on the shelf, 1 st on an inköpsorder, 1 st missing.
    expect(childrenOf(tree, lockRow!.id)).toEqual([
      expect.objectContaining({ kind: "supply", supply: "stock", quantity: 3, level: 1, late: false }),
      expect.objectContaining({ kind: "supply", supply: "purchase_order", documentId: lockIo.id, documentNumber: lockIo.orderNumber, quantity: 1, readyDate: addDays(today, 5) }),
      { kind: "missing", id: `${lockRow!.id}/missing`, parentId: lockRow!.id, level: 1, quantity: 1, manufacturable: false },
    ]);
    expect(tree.totals).toMatchObject({ orders: 4, missing: 1 });
  });

  it("a TO that covers two rows is drawn once — the second place points at the first", async () => {
    const w = await world();
    // One TO of 2 st for two rows of 1 st each.
    const ko = await w.salesOrder("confirmed", [
      { articleId: w.product.id, quantity: 1 },
      { articleId: w.product.id, quantity: 1 },
    ]);
    const tree: StructureResult = (await structureOfSalesOrder(w.cookie, ko.id)).json();
    const places = tree.nodes.filter((n): n is StructureOrderNode => n.kind === "order" && n.manufacturingOrderId === w.p.id);
    expect(places.map((n) => [n.id, n.parentId, n.repeatOf, n.link!.quantity, n.link!.exclusive, n.operations.length])).toEqual([
      [`mo:${w.p.id}`, `row:${ko.rowIds[0]}`, null, 1, false, 2],
      [`row:${ko.rowIds[1]}/mo:${w.p.id}`, `row:${ko.rowIds[1]}`, `mo:${w.p.id}`, 1, false, 0],
    ]);
    // Nothing is drawn below the second place, and the TOs are counted once.
    expect(childrenOf(tree, places[1]!.id)).toEqual([]);
    expect(tree.totals.orders).toBe(4);
    expect(new Set(tree.nodes.map((n) => n.id)).size).toBe(tree.nodes.length);
  });

  it("a quote is no demand: the head without rows", async () => {
    const w = await world();
    const quote = await w.salesOrder("quote", [{ articleId: w.product.id, quantity: 2 }]);
    const res = await structureOfSalesOrder(w.cookie, quote.id);
    expect(res.statusCode, res.body).toBe(200);
    const tree: StructureResult = res.json();
    expect(tree.root).toMatchObject({ kind: "sales_order", salesOrderId: quote.id, orderNumber: quote.orderNumber, outlook: { status: "none", atRisk: false } });
    expect(tree.nodes).toEqual([]);
    expect(tree.totals).toEqual({ orders: 0, lateOrders: 0, componentLate: 0, lockedOperations: 0, missing: 0 });
    expect(tree.axis.days).toHaveLength(14);
  });
});

describe("GET /planning/structure — the contract", () => {
  it("404 for an unknown TO and an unknown kundorder; 400 for neither, both and a malformed id", async () => {
    const cookie = await adminCookie();
    const missingOrder = await structureOfOrder(cookie, crypto.randomUUID());
    expect(missingOrder.statusCode).toBe(404);
    expect(missingOrder.json()).toMatchObject({ code: "manufacturing-order-not-found" });
    const missingSalesOrder = await structureOfSalesOrder(cookie, crypto.randomUUID());
    expect(missingSalesOrder.statusCode).toBe(404);
    expect(missingSalesOrder.json()).toMatchObject({ code: "sales-order-not-found" });

    for (const query of [
      "",
      `?manufacturingOrderId=${crypto.randomUUID()}&salesOrderId=${crypto.randomUUID()}`,
      "?manufacturingOrderId=TO-1001",
      "?salesOrderId=",
    ]) {
      const res = await get(cookie, `/planning/structure${query}`);
      expect(res.statusCode, query).toBe(400);
    }
  });

  it("is read like a TO (MO_READ) and by a read-only account — not with Artikelöversikt alone, not without a session", async () => {
    const w = await world();
    for (const permissions of [["tillverkning"], ["terminal"], ["tillverkningsorder_las"], ["forsaljning"], ["inkop"]]) {
      expect((await structureOfOrder(await userCookie(permissions), w.p.id)).statusCode, permissions.join()).toBe(200);
    }
    expect((await structureOfOrder(await userCookie(["tillverkningsorder_las"], true), w.p.id)).statusCode).toBe(200);
    const denied = await structureOfOrder(await userCookie(["artikeloversikt"]), w.p.id);
    expect(denied.statusCode).toBe(403);
    expect((await structureOfOrder(await userCookie([]), w.p.id)).statusCode).toBe(403);
    expect((await app.inject({ url: `/api/v1/planning/structure?manufacturingOrderId=${w.p.id}` })).statusCode).toBe(401);
  });

  it("carries no price field, with either root", async () => {
    const w = await world();
    const ko = await w.salesOrder("confirmed", [{ articleId: w.product.id, quantity: 2 }]);
    for (const res of [await structureOfOrder(w.cookie, w.p.id), await structureOfSalesOrder(w.cookie, ko.id)]) {
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toMatch(/price|cost|amount|discount|margin|777\.25/i);
    }
  });
});

describe("the loads behind the tree", () => {
  it("one pegging batch per TO level, however wide the level — under a kundorder the first one is Leveransläget's own", async () => {
    const w = await world();
    const repo = createPlanningRepository(db);
    const peggings: string[][] = [];
    const service = createPlanningService(
      {
        ...repo,
        coverageParents: (...args: Parameters<typeof repo.coverageParents>) => {
          peggings.push([...args[0]].sort());
          return repo.coverageParents(...args);
        },
      },
      {
        purchase: {
          createPurchaseOrder: async () => {
            throw new Error("not used");
          },
          addRow: async () => {},
          cancel: async () => {},
        },
        manufacturing: mfgService,
        requirementsCacheMs: 0,
      }
    );
    const viaApp: StructureResult = (await structureOfOrder(w.cookie, w.p.id)).json();
    expect(await service.getStructure({ manufacturingOrderId: w.p.id })).toEqual(viaApp);
    // P, then G and H in ONE batch, then S (whose material is bought).
    expect(peggings).toEqual([[w.p.id], [w.g.id, w.h.id].sort(), [w.s.id]]);

    // Two more TOs on the second level: the same three batches.
    const gavel2 = await w.order(w.gavel.id, 1, addDays(today, 31));
    const stomme2 = await w.order(w.stomme.id, 1, addDays(today, 21));
    await db.execute(sql`UPDATE mo_material_consumptions SET quantity_planned = quantity_planned + 1 WHERE manufacturing_order_id = ${w.p.id} AND component_article_id = ${w.gavel.id}`);
    await db.execute(sql`UPDATE mo_material_consumptions SET quantity_planned = quantity_planned + 1 WHERE manufacturing_order_id = ${w.h.id} AND component_article_id = ${w.stomme.id}`);
    peggings.length = 0;
    const wider = await service.getStructure({ manufacturingOrderId: w.p.id });
    expect(wider.totals.orders).toBe(6);
    expect(peggings).toEqual([[w.p.id], [w.g.id, gavel2.id, w.h.id].sort(), [w.s.id, stomme2.id].sort()]);

    // A kundorder at the top: the rows' TOs are the batch Leveransläget
    // pegs for Halvfabrikat sent — the tree draws them from it, then one
    // batch per level below.
    const ko = await w.salesOrder("confirmed", [{ articleId: w.product.id, quantity: 2 }]);
    peggings.length = 0;
    const under = await service.getStructure({ salesOrderId: ko.id });
    expect(under.totals.orders).toBe(6);
    expect(peggings).toEqual([[w.p.id], [w.g.id, gavel2.id, w.h.id].sort(), [w.s.id, stomme2.id].sort()]);
  });
});

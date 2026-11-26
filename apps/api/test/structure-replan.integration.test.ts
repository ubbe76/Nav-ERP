import { createArticleSchema, createManufacturingOrderSchema, createWorkCenterSchema } from "@navet/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asc, eq, inArray, sql } from "drizzle-orm";
import { auditLog, db, manufacturingOrders, moOperationPlanDays, moOperations, purchaseOrderRows, purchaseOrders, suppliers } from "@navet/db";
import { buildApp } from "../src/app.js";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createAuthService } from "../src/modules/auth/service/auth.service.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import { createManufacturingService } from "../src/modules/manufacturing/service/manufacturing.service.js";
import { lockProductionPlan } from "../src/modules/planning/repository/plan-lock.js";
import type { ReplanStructureResult } from "../src/modules/planning/service/structure-replan.js";
import type { StructureOrderNode, StructureResult } from "../src/modules/planning/service/structure-tree.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { stockholmToday } from "../src/modules/system/service/delivery-days.js";
import { parsed } from "./helpers/parsed.js";
import { testArticleService, testDocumentPdfService } from "./helpers/services.js";
import { unwiredSalesOrderLinks } from "./helpers/unwired";
import { waitForLockWaiter } from "./helpers/year-end.js";

// Planera om strukturen through the real app (spec 2026-11-26, etapp 5, step
// 5b): POST /manufacturing-orders/:id/replan-structure and its preview. The
// pure rules are tested in structure-replan.test.ts and the engine's golv in
// production-plan.test.ts; here: the written days are the preview's,
// children come before parents and a parent starts on the day its
// halvfabrikat is ready, the days are locked (Planera leaves them), locked
// operations are planned again, a shared halvfabrikat is only moved when
// chosen, the färdigdatum are only written when chosen, and the two 409s
// write nothing. The plans are made by the app's own Planera (the real
// "today"), so the file runs on any weekday.

const articleService = createArticleService(createArticleRepository(db));
const authRepo = createAuthRepository(db);
const authService = createAuthService(authRepo, "unused", createAuditRepository(db));
// No plan reader: the orders are created unplanned, the app's Planera plans.
const mfgService = createManufacturingService(createManufacturingRepository(db), testDocumentPdfService, testArticleService, unwiredSalesOrderLinks);
const PASSWORD = "correcthorsebattery";

const TABLES = sql`TRUNCATE mo_operation_plan_days, stamp_sessions, mo_reports, mo_report_materials, mo_operation_scrap, mo_material_consumptions, mo_operations, manufacturing_orders, purchase_order_rows, purchase_orders, suppliers, routing_operations, work_centers, production_groups, holidays, stock_transactions, stock_locations, warehouses, bom_components, article_suppliers, articles, audit_log, user_settings, users CASCADE`;

let app: ReturnType<typeof buildApp>;
beforeAll(async () => {
  app = buildApp();
  await app.ready();
});
beforeEach(async () => {
  await db.execute(TABLES);
});
afterAll(async () => {
  await app.close();
  await db.execute(TABLES);
});

const today = stockholmToday();
const addDays = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const isWeekday = (date: string) => ![0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay());
// The first Monday–Friday on or after / after `date` (no holidays in the fixture).
const weekdayOnOrAfter = (date: string) => {
  let day = date;
  while (!isWeekday(day)) day = addDays(day, 1);
  return day;
};
const nextWeekday = (date: string) => weekdayOnOrAfter(addDays(date, 1));
const suffix = () => crypto.randomUUID().slice(0, 8);

async function adminCookie() {
  const email = `admin-${crypto.randomUUID()}@example.com`;
  await authService.createUser({ email, password: PASSWORD, name: "Admin", role: "admin" });
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PASSWORD } });
  expect(res.statusCode).toBe(200);
  return `session=${res.cookies.find((c) => c.name === "session")!.value}`;
}
const get = (cookie: string, url: string) => app.inject({ url: `/api/v1${url}`, headers: { cookie } });
const post = (cookie: string, url: string, payload?: object) =>
  app.inject({ method: "POST", url: `/api/v1${url}`, headers: { cookie }, ...(payload ? { payload } : {}) });
type ReplanBody = { dueDate: string | null; moveComponentDueDates: boolean; includeOrderIds?: string[] };
const previewOf = async (cookie: string, id: string, body: ReplanBody = { dueDate: null, moveComponentDueDates: false }) => {
  const res = await post(cookie, `/manufacturing-orders/${id}/replan-structure/preview`, body);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as ReplanStructureResult;
};
// The write as the dialog sends it: the preview's choice and its `expected`.
const writeOf = (cookie: string, id: string, shown: ReplanStructureResult, body: Omit<ReplanBody, "includeOrderIds"> = { dueDate: null, moveComponentDueDates: false }) =>
  post(cookie, `/manufacturing-orders/${id}/replan-structure`, {
    ...body,
    includeOrderIds: shown.orders.filter((o) => o.included && o.level > 0).map((o) => o.manufacturingOrderId),
    expected: shown.expected,
  });

// Everything the replan may write, to compare before and after: the mirror
// columns and the lock of every operation, the stored days, the färdigdatum
// and the händelselogg.
async function snapshot() {
  const operations = await db
    .select({
      id: moOperations.id,
      start: moOperations.plannedStartDate,
      end: moOperations.plannedEndDate,
      locked: moOperations.planLocked,
      plannedAt: moOperations.plannedAt,
      runPosition: moOperations.runPosition,
      workCenterId: moOperations.workCenterId,
      resourceLocked: moOperations.resourceLocked,
    })
    .from(moOperations)
    .orderBy(asc(moOperations.id));
  const days = await db
    .select({ id: moOperationPlanDays.moOperationId, date: moOperationPlanDays.planDate, minutes: moOperationPlanDays.minutes })
    .from(moOperationPlanDays)
    .orderBy(asc(moOperationPlanDays.moOperationId), asc(moOperationPlanDays.planDate));
  const orders = await db
    .select({ id: manufacturingOrders.id, dueDate: manufacturingOrders.dueDate })
    .from(manufacturingOrders)
    .orderBy(asc(manufacturingOrders.id));
  const [{ n }] = [...(await db.execute(sql`SELECT count(*)::int AS n FROM audit_log WHERE action IN ('structure_replanned', 'updated')`))] as [{ n: number }];
  return { operations, days, orders, events: n };
}
async function opsOf(orderId: string) {
  return db
    .select({ id: moOperations.id, sequenceNo: moOperations.sequenceNo, start: moOperations.plannedStartDate, end: moOperations.plannedEndDate, locked: moOperations.planLocked })
    .from(moOperations)
    .where(eq(moOperations.manufacturingOrderId, orderId))
    .orderBy(asc(moOperations.sequenceNo));
}
async function dueDatesOf(ids: string[]) {
  const rows = await db.select({ id: manufacturingOrders.id, dueDate: manufacturingOrders.dueDate }).from(manufacturingOrders).where(inArray(manufacturingOrders.id, ids));
  return new Map(rows.map((r) => [r.id, r.dueDate]));
}
const events = (action: string) =>
  db
    .select({ entityType: auditLog.entityType, entityId: auditLog.entityId, action: auditLog.action, detail: auditLog.detail })
    .from(auditLog)
    .where(eq(auditLog.action, action))
    .orderBy(asc(auditLog.createdAt), asc(auditLog.entityId));

type Fixture = Awaited<ReturnType<typeof base>>;
async function base() {
  const user = await authRepo.create({ email: `rep-${crypto.randomUUID()}@example.com`, passwordHash: "x", name: "Planerare", role: "admin" });
  const kap = await mfgService.createWorkCenter(parsed(createWorkCenterSchema, { code: "101", name: "Kap", hoursPerDay: 8, active: true }));
  const montering = await mfgService.createWorkCenter(parsed(createWorkCenterSchema, { code: "201", name: "Montering", hoursPerDay: 8, active: true }));
  const x = suffix();
  const article = (prefix: string, name: string, type: "manufactured" | "purchased") =>
    articleService.createArticle(parsed(createArticleSchema, { articleNumber: `${prefix}-${x}`, name, type, active: true }));
  const order = (articleId: string, quantity: number, dueDate: string | null) =>
    mfgService.createManufacturingOrder(parsed(createManufacturingOrderSchema, { articleId, quantity, dueDate }), user.id);
  const purchaseOrder = async (articleId: string, quantity: number, date: string | null) => {
    const [supplier] = await db.insert(suppliers).values({ supplierNumber: `L${suffix()}`, name: "Leverantör AB" }).returning();
    const [po] = await db
      .insert(purchaseOrders)
      .values({ orderNumber: `IO-${suffix()}`, supplierId: supplier!.id, status: "confirmed", expectedDeliveryDate: date })
      .returning();
    await db.insert(purchaseOrderRows).values({ purchaseOrderId: po!.id, articleId, quantityOrdered: String(quantity), quantityReceived: "0", unitPrice: "10" });
    return po!;
  };
  const cookie = await adminCookie();
  const plan = async () => expect((await post(cookie, "/planning/plan")).statusCode).toBe(200);
  return { user, kap, montering, article, order, purchaseOrder, cookie, plan };
}

// P is made of G and H (halvfabrikat), H of S (halvfabrikat), S of R
// (purchased, on an inköpsorder ten days out). One TO each for P, H and S —
// each halvfabrikat-TO goes to its parent alone — and a TO for G of 4, of
// which P needs 2 and another order Q the other 2: a SHARED halvfabrikat.
// Everything is planned by Planera, which does not wait for halvfabrikat: it
// all lies at the front of the plan, long before the inköpsorder comes.
async function world() {
  const f = await base();
  const gavel = await f.article("G", "Gavel", "manufactured");
  const halv = await f.article("H", "Halvfabrikat", "manufactured");
  const product = await f.article("P", "Produkt", "manufactured");
  const other = await f.article("Q", "Annan produkt", "manufactured");
  const raw = await f.article("R", "Råvara", "purchased");
  const stomme = await f.article("S", "Stomme", "manufactured");
  const routing = (articleId: string, sequenceNo: number, workCenterId: string, runTimePerUnit: number) =>
    mfgService.createRoutingOperation(articleId, { sequenceNo, workCenterId, setupTime: 0, runTimePerUnit });
  await routing(gavel.id, 10, f.kap.id, 30);
  await routing(stomme.id, 10, f.kap.id, 30);
  await routing(halv.id, 10, f.kap.id, 60);
  await routing(product.id, 10, f.kap.id, 60);
  await routing(product.id, 20, f.montering.id, 30);
  await routing(other.id, 10, f.montering.id, 30);
  await articleService.addBomComponent(stomme.id, { componentArticleId: raw.id, quantity: 1 });
  await articleService.addBomComponent(halv.id, { componentArticleId: stomme.id, quantity: 1 });
  await articleService.addBomComponent(product.id, { componentArticleId: gavel.id, quantity: 1 });
  await articleService.addBomComponent(product.id, { componentArticleId: halv.id, quantity: 1 });
  await articleService.addBomComponent(other.id, { componentArticleId: gavel.id, quantity: 1 });

  const ioDate = addDays(today, 10);
  const io = await f.purchaseOrder(raw.id, 2, ioDate);
  const s = await f.order(stomme.id, 2, addDays(today, 20));
  const h = await f.order(halv.id, 2, addDays(today, 30));
  const g = await f.order(gavel.id, 4, addDays(today, 25));
  const p = await f.order(product.id, 2, addDays(today, 40));
  const q = await f.order(other.id, 2, addDays(today, 41));
  await f.plan();
  // The day the råvara is there: S may start then, H the same day (S is
  // ready), P's first operation the same day too — 101 has 8 h and the three
  // take 1 + 2 + 2 — and P's second the working day after.
  const ready = weekdayOnOrAfter(ioDate);
  return { ...f, gavel, halv, product, other, raw, stomme, io, ioDate, s, h, g, p, q, ready };
}
const orderOf = (result: ReplanStructureResult, id: string) => result.orders.find((o) => o.manufacturingOrderId === id)!;

describe("POST /manufacturing-orders/:id/replan-structure", () => {
  it("plans the children before the parents, each from the day its material is ready — and writes the preview's days, locked", async () => {
    const w = await world();
    // Planera put it all at the front, before the råvara has come.
    for (const id of [w.s.id, w.h.id, w.p.id]) expect((await opsOf(id))[0]!.start! < w.ready).toBe(true);

    const shown = await previewOf(w.cookie, w.p.id);
    expect(shown.today).toBe(today);
    expect(shown.top).toEqual({ manufacturingOrderId: w.p.id, orderNumber: w.p.orderNumber });
    // The tree's TOs depth first, the material rows in article number order
    // (G before H); the shared G is listed but not chosen.
    expect(shown.orders.map((o) => [o.orderNumber, o.level, o.parentOrderId, o.exclusive, o.selectable, o.included])).toEqual([
      [w.p.orderNumber, 0, null, true, false, true],
      [w.g.orderNumber, 1, w.p.id, false, true, false],
      [w.h.orderNumber, 1, w.p.id, true, true, true],
      [w.s.orderNumber, 2, w.h.id, true, true, true],
    ]);
    expect(shown.blocked).toEqual([]);
    // The golv and where it comes from.
    const [p, g, h, s] = [orderOf(shown, w.p.id), orderOf(shown, w.g.id), orderOf(shown, w.h.id), orderOf(shown, w.s.id)];
    expect(s.floor).toEqual({ date: w.ioDate, source: { kind: "purchase_order", documentNumber: w.io.orderNumber } });
    expect(h.floor).toEqual({ date: w.ready, source: { kind: "manufacturing_order", documentNumber: w.s.orderNumber } });
    expect(p.floor).toEqual({ date: w.ready, source: { kind: "manufacturing_order", documentNumber: w.h.orderNumber } });
    expect(g.floor).toBeNull();
    // S on the day the råvara comes, H the SAME day S is ready (S29), P's
    // first operation the same day H is ready — never before — its second
    // the working day after.
    expect(s.planned.after).toEqual({ start: w.ready, end: w.ready });
    expect(h.planned.after).toEqual({ start: w.ready, end: w.ready });
    expect(p.operations.map((op) => [op.sequenceNo, op.workCenterCode, op.after.start, op.after.end])).toEqual([
      [10, "101", w.ready, w.ready],
      [20, "201", nextWeekday(w.ready), nextWeekday(w.ready)],
    ]);
    expect([s.plannedFinish, h.plannedFinish, p.plannedFinish]).toEqual([w.ready, w.ready, nextWeekday(w.ready)]);
    expect(p.lateAfter).toBe(false);
    // What it was before is what the stored plan says.
    for (const [node, id] of [[p, w.p.id], [h, w.h.id], [s, w.s.id], [g, w.g.id]] as const) {
      const stored = await opsOf(id);
      expect(node.operations.map((op) => [op.moOperationId, op.before.start, op.before.end])).toEqual(stored.map((op) => [op.id, op.start, op.end]));
      expect(node.operations.every((op) => !op.wasLocked && !op.started && !op.subcontract)).toBe(true);
    }
    // The unchosen G keeps its days in the answer.
    expect(g.planned.after).toEqual(g.planned.before);
    expect(shown.expected).toEqual(
      shown.orders.map((o) => ({ manufacturingOrderId: o.manufacturingOrderId, dueDate: o.dueDate.before, plannedStartDate: o.planned.before.start, plannedEndDate: o.planned.before.end }))
    );

    // The preview wrote nothing.
    const before = await snapshot();
    expect(await snapshot()).toEqual(before);

    const res = await writeOf(w.cookie, w.p.id, shown);
    expect(res.statusCode, res.body).toBe(200);
    const written: ReplanStructureResult = res.json();
    // The write answers what the preview showed …
    expect(written.orders).toEqual(shown.orders);
    // … and the stored days are those days, every planned operation locked.
    for (const node of [p, h, s]) {
      const stored = await opsOf(node.manufacturingOrderId);
      expect(stored.map((op) => [op.id, op.start, op.end, op.locked])).toEqual(node.operations.map((op) => [op.moOperationId, op.after.start, op.after.end, true]));
    }
    // G and Q are untouched: the same days, no lock; nobody's resource moved.
    const after = await snapshot();
    const untouched = new Set([...(await opsOf(w.g.id)), ...(await opsOf(w.q.id))].map((op) => op.id));
    expect(after.operations.filter((op) => untouched.has(op.id))).toEqual(before.operations.filter((op) => untouched.has(op.id)));
    expect(after.operations.map((op) => [op.id, op.workCenterId, op.resourceLocked])).toEqual(before.operations.map((op) => [op.id, op.workCenterId, op.resourceLocked]));
    // No färdigdatum was asked for.
    expect(after.orders).toEqual(before.orders);

    // Strukturvyn reads the same days and the same finish.
    const tree: StructureResult = (await get(w.cookie, `/planning/structure?manufacturingOrderId=${w.p.id}`)).json();
    const node = (id: string) => tree.nodes.find((n): n is StructureOrderNode => n.kind === "order" && n.manufacturingOrderId === id)!;
    expect([node(w.s.id).plannedFinish, node(w.h.id).plannedFinish, node(w.p.id).plannedFinish]).toEqual([w.ready, w.ready, nextWeekday(w.ready)]);
    expect(tree.totals.lockedOperations).toBe(4);

    // Händelseloggen: one row per TO whose days changed, and one on the plan.
    const rows = await events("structure_replanned");
    const perOrder = rows.filter((r) => r.entityType === "manufacturing_order");
    expect(perOrder.map((r) => r.entityId).sort()).toEqual([w.p.orderNumber, w.h.orderNumber, w.s.orderNumber].sort());
    expect(perOrder.find((r) => r.entityId === w.p.orderNumber)!.detail).toEqual({
      forOrder: w.p.orderNumber,
      plannedStartDate: w.ready,
      plannedEndDate: nextWeekday(w.ready),
      before: { plannedStartDate: p.planned.before.start, plannedEndDate: p.planned.before.end },
      floorDate: w.ready,
      operations: `op 10 ${w.ready}, op 20 ${nextWeekday(w.ready)}`,
      unlocked: 0,
    });
    expect(rows.filter((r) => r.entityType === "production_plan")).toEqual([
      {
        entityType: "production_plan",
        entityId: null,
        action: "structure_replanned",
        detail: { top: w.p.orderNumber, orders: [w.p.orderNumber, w.h.orderNumber, w.s.orderNumber].join(", "), count: 3 },
      },
    ]);
    expect(await events("updated")).toEqual([]);
  });

  it("Planera afterwards leaves the tree where it is — until Lås upp hela ordern", async () => {
    const w = await world();
    expect((await writeOf(w.cookie, w.p.id, await previewOf(w.cookie, w.p.id))).statusCode).toBe(200);
    const tree = [w.p.id, w.h.id, w.s.id];
    const planned = async () => (await Promise.all(tree.map(opsOf))).flat().map((op) => [op.id, op.start, op.end, op.locked]);
    const before = await planned();
    await w.plan();
    expect(await planned()).toEqual(before);

    // The status flow: locked → Lås upp → Planera moves it to the front again.
    expect((await post(w.cookie, "/planning/unlock-orders", { manufacturingOrderIds: tree })).statusCode).toBe(200);
    expect((await planned()).map((op) => op.slice(0, 3))).toEqual(before.map((op) => op.slice(0, 3)));
    await w.plan();
    for (const id of tree) {
      const ops = await opsOf(id);
      expect(ops.every((op) => !op.locked)).toBe(true);
      expect(ops[0]!.start! < w.ready).toBe(true);
    }
  });

  it("plans locked operations again and lists them (S28) — a second run changes nothing", async () => {
    const w = await world();
    // P's first operation moved by hand far out: locked there.
    const [p10] = await opsOf(w.p.id);
    const far = weekdayOnOrAfter(addDays(today, 30));
    expect((await post(w.cookie, `/planning/operations/${p10!.id}/move`, { date: far, moveFollowing: true })).statusCode).toBe(200);
    expect((await opsOf(w.p.id)).map((op) => [op.start, op.locked])).toEqual([
      [far, true],
      [nextWeekday(far), false],
    ]);

    const shown = await previewOf(w.cookie, w.p.id);
    const p = orderOf(shown, w.p.id);
    expect(p.operations.map((op) => [op.sequenceNo, op.wasLocked, op.before.start, op.after.start])).toEqual([
      [10, true, far, w.ready],
      [20, false, nextWeekday(far), nextWeekday(w.ready)],
    ]);
    expect(shown.notes).toContain(`${w.p.orderNumber}: 1 operation var låst och planeras om`);
    expect((await writeOf(w.cookie, w.p.id, shown)).statusCode).toBe(200);
    expect((await opsOf(w.p.id)).map((op) => [op.start, op.locked])).toEqual([
      [w.ready, true],
      [nextWeekday(w.ready), true],
    ]);
    const logged = (await events("structure_replanned")).find((r) => r.entityId === w.p.orderNumber)!;
    expect(logged.detail).toMatchObject({ unlocked: 1 });

    // Again: everything is locked now, all of it is planned again and lands
    // on the same days (the tree's own load is released first) — nothing to log.
    const again = await previewOf(w.cookie, w.p.id);
    for (const id of [w.p.id, w.h.id, w.s.id]) {
      const node = orderOf(again, id);
      expect(node.operations.every((op) => op.wasLocked)).toBe(true);
      expect(node.planned.after).toEqual(node.planned.before);
    }
    const before = await snapshot();
    expect((await writeOf(w.cookie, w.p.id, again)).statusCode).toBe(200);
    const after = await snapshot();
    expect(after.operations.map(({ plannedAt, ...op }) => op)).toEqual(before.operations.map(({ plannedAt, ...op }) => op));
    expect((await events("structure_replanned")).filter((r) => r.entityType === "manufacturing_order")).toHaveLength(3);
    expect((await events("structure_replanned")).filter((r) => r.entityType === "production_plan")).toHaveLength(2);
  });

  it("a shared halvfabrikat is not preselected and is only moved when it is chosen (S31)", async () => {
    const w = await world();
    const shown = await previewOf(w.cookie, w.p.id);
    const g = orderOf(shown, w.g.id);
    expect(g).toMatchObject({ exclusive: false, selectable: true, included: false, sharedWith: [w.q.orderNumber] });
    expect(orderOf(shown, w.h.id).sharedWith).toEqual([]);
    const gBefore = await opsOf(w.g.id);
    expect((await writeOf(w.cookie, w.p.id, shown)).statusCode).toBe(200);
    expect(await opsOf(w.g.id)).toEqual(gBefore);
    expect(gBefore[0]!.locked).toBe(false);

    // Chosen: it is planned (alone on its day at the front — its own load is
    // released, the tree's days lie later) and locked.
    const chosen = await previewOf(w.cookie, w.p.id, { dueDate: null, moveComponentDueDates: false, includeOrderIds: [w.g.id, w.h.id, w.s.id] });
    expect(orderOf(chosen, w.g.id)).toMatchObject({ included: true, selectable: true });
    expect((await writeOf(w.cookie, w.p.id, chosen)).statusCode).toBe(200);
    const gAfter = await opsOf(w.g.id);
    expect(gAfter.map((op) => [op.start, op.locked])).toEqual([[orderOf(chosen, w.g.id).planned.after.start, true]]);

    // Only H unchosen: S lies under a TO that is not chosen and cannot be
    // chosen — and is not selectable in the answer.
    const without = await previewOf(w.cookie, w.p.id, { dueDate: null, moveComponentDueDates: false, includeOrderIds: [] });
    expect(without.orders.map((o) => [o.orderNumber, o.selectable, o.included])).toEqual([
      [w.p.orderNumber, false, true],
      [w.g.orderNumber, true, false],
      [w.h.orderNumber, true, false],
      [w.s.orderNumber, false, false],
    ]);
    // P alone: its golv is the unchosen H's stored ready day.
    expect(orderOf(without, w.p.id).floor).toEqual({ date: w.ready, source: { kind: "manufacturing_order", documentNumber: w.h.orderNumber } });
    const before = await snapshot();
    for (const includeOrderIds of [[w.s.id], [w.q.id], [crypto.randomUUID()]]) {
      const body = { dueDate: null, moveComponentDueDates: false, includeOrderIds };
      const refusedPreview = await post(w.cookie, `/manufacturing-orders/${w.p.id}/replan-structure/preview`, body);
      expect(refusedPreview.statusCode).toBe(409);
      expect(refusedPreview.json()).toMatchObject({ code: "replan-structure-changed" });
      const refused = await post(w.cookie, `/manufacturing-orders/${w.p.id}/replan-structure`, { ...body, expected: without.expected });
      expect(refused.statusCode).toBe(409);
      // The fresh preview is the answer for the part that may be chosen: P alone.
      const fresh: ReplanStructureResult = refused.json().result;
      expect(fresh.orders.filter((o) => o.included).map((o) => o.manufacturingOrderId)).toEqual([w.p.id]);
    }
    expect(await snapshot()).toEqual(before);
  });

  it("with the checkbox each chosen halvfabrikat is due the day it is ready after the run — the reservation's rule — and nothing is Sen", async () => {
    const w = await world();
    const ids = [w.p.id, w.h.id, w.s.id, w.g.id];
    const original = await dueDatesOf(ids);
    const newDue = weekdayOnOrAfter(addDays(today, 60));

    // The top's date alone: nobody else's date moves.
    const shownTop = await previewOf(w.cookie, w.p.id, { dueDate: newDue, moveComponentDueDates: false });
    expect(orderOf(shownTop, w.p.id).dueDate).toEqual({ before: original.get(w.p.id), after: newDue, late: false });
    for (const id of [w.h.id, w.s.id, w.g.id]) expect(orderOf(shownTop, id).dueDate).toEqual({ before: original.get(id), after: original.get(id), late: false });

    // With the checkbox: a chosen halvfabrikat's färdigdatum = its new
    // klar-dag, as a TO the reservation creates is due the day it is ready.
    const both = { dueDate: newDue, moveComponentDueDates: true };
    const shown = await previewOf(w.cookie, w.p.id, both);
    for (const id of [w.h.id, w.s.id]) {
      const node = orderOf(shown, id);
      expect(node.plannedFinish).toBe(w.ready);
      expect(node.dueDate).toEqual({ before: original.get(id), after: w.ready, late: false });
      // Ready ON the färdigdatum is in time.
      expect(node.lateAfter).toBe(false);
    }
    expect(orderOf(shown, w.p.id)).toMatchObject({ dueDate: { before: original.get(w.p.id), after: newDue, late: false }, lateAfter: false });
    // The unchosen (shared) G keeps its date.
    expect(orderOf(shown, w.g.id).dueDate).toEqual({ before: original.get(w.g.id), after: original.get(w.g.id), late: false });
    expect(shown.warnings.filter((warning) => warning.kind === "late")).toEqual([]);
    // The placing never depends on the dates.
    expect(shown.orders.map((o) => o.planned.after)).toEqual(shownTop.orders.map((o) => o.planned.after));
    // `expected` is what the tree has now, not what it will get.
    expect(shown.expected.map((e) => e.dueDate)).toEqual(shown.orders.map((o) => original.get(o.manufacturingOrderId)));

    expect((await writeOf(w.cookie, w.p.id, shown, both)).statusCode).toBe(200);
    const after = await dueDatesOf(ids);
    expect([after.get(w.p.id), after.get(w.h.id), after.get(w.s.id), after.get(w.g.id)]).toEqual([newDue, w.ready, w.ready, original.get(w.g.id)]);
    // Not Sen right after the run: the TO card says so, and so does the tree.
    for (const id of [w.p.id, w.h.id, w.s.id]) {
      const card = (await get(w.cookie, `/manufacturing-orders/${id}`)).json() as { late: boolean; dueDate: string };
      expect(card.late, id).toBe(false);
    }
    const tree: StructureResult = (await get(w.cookie, `/planning/structure?manufacturingOrderId=${w.p.id}`)).json();
    for (const n of tree.nodes) {
      if (n.kind !== "order" || n.manufacturingOrderId === w.g.id) continue;
      expect([n.late, n.componentLate, n.link?.late ?? false]).toEqual([false, false, false]);
    }
    // Logged like Flytta halvfabrikaten, with its own reason.
    const updated = await events("updated");
    expect(updated.map((r) => r.entityId).sort()).toEqual([w.p.orderNumber, w.h.orderNumber, w.s.orderNumber].sort());
    expect(updated.find((r) => r.entityId === w.h.orderNumber)!.detail).toEqual({
      before: { dueDate: original.get(w.h.id) },
      after: { dueDate: w.ready },
      reason: "structure_replan",
      forOrder: w.p.orderNumber,
    });

    // Again: every date is already the klar-dag — nothing to write, nothing logged.
    const again = await previewOf(w.cookie, w.p.id, both);
    expect(again.orders.every((o) => o.dueDate.before === o.dueDate.after)).toBe(true);
    expect((await writeOf(w.cookie, w.p.id, again, both)).statusCode).toBe(200);
    expect(await events("updated")).toHaveLength(3);
  });

  it("the checkbox without a new date for the top moves the halvfabrikat alone", async () => {
    const w = await world();
    const ids = [w.p.id, w.h.id, w.s.id, w.g.id];
    const original = await dueDatesOf(ids);
    const body = { dueDate: null, moveComponentDueDates: true };
    const shown = await previewOf(w.cookie, w.p.id, body);
    expect((await writeOf(w.cookie, w.p.id, shown, body)).statusCode).toBe(200);
    const after = await dueDatesOf(ids);
    expect([after.get(w.p.id), after.get(w.h.id), after.get(w.s.id), after.get(w.g.id)]).toEqual([original.get(w.p.id), w.ready, w.ready, original.get(w.g.id)]);
  });

  it("writes the top's new färdigdatum, and nothing else, without the checkbox", async () => {
    const w = await world();
    const ids = [w.p.id, w.h.id, w.s.id, w.g.id];
    const original = await dueDatesOf(ids);
    const newDue = weekdayOnOrAfter(addDays(today, 60));
    const body = { dueDate: newDue, moveComponentDueDates: false };
    const shown = await previewOf(w.cookie, w.p.id, body);
    expect((await writeOf(w.cookie, w.p.id, shown, body)).statusCode).toBe(200);
    const after = await dueDatesOf(ids);
    expect(after.get(w.p.id)).toBe(newDue);
    for (const id of [w.h.id, w.s.id, w.g.id]) expect(after.get(id)).toBe(original.get(id));
    expect((await events("updated")).map((r) => [r.entityId, r.detail])).toEqual([
      [w.p.orderNumber, { before: { dueDate: original.get(w.p.id) }, after: { dueDate: newDue }, reason: "structure_replan", forOrder: w.p.orderNumber }],
    ]);
  });

  it("409 replan-structure-changed with the new preview when the tree's dates are not the ones shown — nothing written", async () => {
    const w = await world();
    const shown = await previewOf(w.cookie, w.p.id);
    const body = { dueDate: weekdayOnOrAfter(addDays(today, 60)), moveComponentDueDates: true };

    // Another färdigdatum on a halvfabrikat than the preview showed.
    const moved = addDays(today, 31);
    await db.update(manufacturingOrders).set({ dueDate: moved }).where(eq(manufacturingOrders.id, w.h.id));
    let before = await snapshot();
    let res = await writeOf(w.cookie, w.p.id, shown, body);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "replan-structure-changed" });
    let fresh: ReplanStructureResult = res.json().result;
    expect(fresh.expected.find((e) => e.manufacturingOrderId === w.h.id)!.dueDate).toBe(moved);
    expect(await snapshot()).toEqual(before);

    // An operation of the tree moved meanwhile (Flytta).
    const [s10] = await opsOf(w.s.id);
    const far = weekdayOnOrAfter(addDays(today, 20));
    expect((await post(w.cookie, `/planning/operations/${s10!.id}/move`, { date: far, moveFollowing: true })).statusCode).toBe(200);
    before = await snapshot();
    res = await writeOf(w.cookie, w.p.id, fresh, body);
    expect(res.statusCode).toBe(409);
    fresh = res.json().result;
    expect(fresh.expected.find((e) => e.manufacturingOrderId === w.s.id)).toMatchObject({ plannedStartDate: far, plannedEndDate: far });
    expect(await snapshot()).toEqual(before);

    // A TO less in `expected` than the tree has.
    res = await post(w.cookie, `/manufacturing-orders/${w.p.id}/replan-structure`, {
      ...body,
      includeOrderIds: [w.h.id, w.s.id],
      expected: fresh.expected.filter((e) => e.manufacturingOrderId !== w.g.id),
    });
    expect(res.statusCode).toBe(409);
    expect(await snapshot()).toEqual(before);

    // The fresh preview is what the dialog confirms next.
    res = await writeOf(w.cookie, w.p.id, fresh, body);
    expect(res.statusCode, res.body).toBe(200);
    expect((await opsOf(w.s.id)).map((op) => [op.start, op.locked])).toEqual([[w.ready, true]]);
  });

  it("409 replan-structure-not-plannable when a chosen TO does not fit within the horizon — nothing written", async () => {
    const f = await base();
    const huge = await f.article("X", "Orimlig", "manufactured");
    const top = await f.article("Y", "Topp", "manufactured");
    // 100 × 9 999 minutes: more than two years on an 8-hour resource.
    await mfgService.createRoutingOperation(huge.id, { sequenceNo: 10, workCenterId: f.kap.id, setupTime: 0, runTimePerUnit: 9999 });
    await mfgService.createRoutingOperation(top.id, { sequenceNo: 10, workCenterId: f.montering.id, setupTime: 0, runTimePerUnit: 30 });
    await articleService.addBomComponent(top.id, { componentArticleId: huge.id, quantity: 100 });
    const x = await f.order(huge.id, 100, addDays(today, 20));
    const y = await f.order(top.id, 1, addDays(today, 30));
    await f.plan();

    const shown = await previewOf(f.cookie, y.id);
    expect(shown.orders.map((o) => [o.orderNumber, o.included])).toEqual([
      [y.orderNumber, true],
      [x.orderNumber, true],
    ]);
    expect(shown.blocked).toEqual([{ manufacturingOrderId: x.id, orderNumber: x.orderNumber }]);
    expect(shown.warnings.some((warning) => warning.kind === "horizon" && warning.manufacturingOrderId === x.id)).toBe(true);
    expect(orderOf(shown, x.id).plannedFinish).toBeNull();
    // The parent gets no golv from a child without a finish day.
    expect(orderOf(shown, y.id).floor).toBeNull();
    // No klar-dag, so no new färdigdatum for it either.
    const dated = await previewOf(f.cookie, y.id, { dueDate: null, moveComponentDueDates: true });
    expect(orderOf(dated, x.id).dueDate).toEqual({ before: addDays(today, 20), after: addDays(today, 20), late: false });

    const before = await snapshot();
    const res = await writeOf(f.cookie, y.id, shown);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "replan-structure-not-plannable", orderNumbers: [x.orderNumber] });
    expect(await snapshot()).toEqual(before);

    // Without the TO that does not fit, the top can be planned.
    const alone = await previewOf(f.cookie, y.id, { dueDate: null, moveComponentDueDates: false, includeOrderIds: [] });
    expect(alone.blocked).toEqual([]);
    expect((await writeOf(f.cookie, y.id, alone)).statusCode).toBe(200);
    expect((await opsOf(y.id)).every((op) => op.locked)).toBe(true);
  });

  it("a TO that starts with lego: the preview counts it from the day the material is ready and says what the other views show", async () => {
    const f = await base();
    const lego = await mfgService.createWorkCenter(parsed(createWorkCenterSchema, { code: "901", name: "Lackering", type: "subcontract", leadTimeDays: 5, active: true }));
    const raw = await f.article("R", "Råvara", "purchased");
    const part = await f.article("S", "Detalj", "manufactured");
    const painted = await f.article("L", "Lackerad", "manufactured");
    await mfgService.createRoutingOperation(part.id, { sequenceNo: 10, workCenterId: f.kap.id, setupTime: 0, runTimePerUnit: 30 });
    await mfgService.createRoutingOperation(painted.id, { sequenceNo: 10, workCenterId: lego.id, setupTime: 0, runTimePerUnit: 0 });
    await articleService.addBomComponent(part.id, { componentArticleId: raw.id, quantity: 1 });
    await articleService.addBomComponent(painted.id, { componentArticleId: part.id, quantity: 1 });
    const ioDate = addDays(today, 10);
    await f.purchaseOrder(raw.id, 2, ioDate);
    const s = await f.order(part.id, 2, addDays(today, 20));
    const l = await f.order(painted.id, 2, addDays(today, 40));
    await f.plan();
    const ready = weekdayOnOrAfter(ioDate);

    const shown = await previewOf(f.cookie, l.id);
    const top = orderOf(shown, l.id);
    expect(orderOf(shown, s.id).plannedFinish).toBe(ready);
    expect(top.floor).toMatchObject({ date: ready });
    expect(top.operations.map((op) => [op.subcontract, op.after.start])).toEqual([[true, null]]);
    // Five working days after the day the detail is ready.
    let finish = ready;
    for (let i = 0; i < 5; i++) finish = nextWeekday(finish);
    expect(top.plannedFinish).toBe(finish);
    const note = shown.notes.find((n) => n.startsWith(`${l.orderNumber}: klar ${finish}`));
    expect(note).toBeDefined();

    expect((await writeOf(f.cookie, l.id, shown)).statusCode).toBe(200);
    // Nothing stores the golv: the stored plan's finish is counted from
    // today — the day the note names.
    const tree: StructureResult = (await get(f.cookie, `/planning/structure?manufacturingOrderId=${l.id}`)).json();
    const stored = tree.nodes.find((n): n is StructureOrderNode => n.kind === "order" && n.manufacturingOrderId === l.id)!.plannedFinish!;
    expect(stored < finish).toBe(true);
    expect(note).toContain(`visar ${stored}`);
    // The halvfabrikat under it is planned and locked as usual.
    expect((await opsOf(s.id)).map((op) => [op.start, op.locked])).toEqual([[ready, true]]);
  });

  it("404 for a TO that does not exist and 409 for a top that is not open", async () => {
    const w = await world();
    const body = { dueDate: null, moveComponentDueDates: false };
    const unknown = crypto.randomUUID();
    for (const url of [`/manufacturing-orders/${unknown}/replan-structure/preview`, `/manufacturing-orders/${unknown}/replan-structure`]) {
      const res = await post(w.cookie, url, { ...body, includeOrderIds: [], expected: [{ manufacturingOrderId: unknown, dueDate: null, plannedStartDate: null, plannedEndDate: null }] });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ code: "manufacturing-order-not-found" });
    }
    const shown = await previewOf(w.cookie, w.q.id);
    await db.update(manufacturingOrders).set({ status: "closed" }).where(eq(manufacturingOrders.id, w.q.id));
    const before = await snapshot();
    const preview = await post(w.cookie, `/manufacturing-orders/${w.q.id}/replan-structure/preview`, body);
    expect(preview.statusCode).toBe(409);
    expect(preview.json()).toMatchObject({ code: "invalid-status-transition", orderNumber: w.q.orderNumber });
    const res = await writeOf(w.cookie, w.q.id, shown);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "invalid-status-transition" });
    expect(await snapshot()).toEqual(before);
  });

  it("waits for the production_plan lock", async () => {
    const w = await world();
    const shown = await previewOf(w.cookie, w.p.id);
    const before = await snapshot();
    let open!: () => void;
    const holding = new Promise<void>((resolve) => (open = resolve));
    let locked!: () => void;
    const inside = new Promise<void>((resolve) => (locked = resolve));
    const holder = db.transaction(async (tx) => {
      await lockProductionPlan(tx);
      locked();
      await holding;
    });
    await inside;
    let run: Promise<Awaited<ReturnType<typeof writeOf>>> | undefined;
    // Released even when something fails, so the open transaction never hangs the file.
    try {
      // inject() starts when it is awaited — `then` starts it now.
      run = writeOf(w.cookie, w.p.id, shown).then((res) => res);
      run.catch(() => {});
      await waitForLockWaiter();
      expect(await snapshot()).toEqual(before);
    } finally {
      open();
    }
    await holder;
    const res = await run!;
    expect(res.statusCode, res.body).toBe(200);
    expect((await opsOf(w.p.id)).every((op) => op.locked)).toBe(true);
  });

  it("two at the same time: the second sees the first one's days and gets 409", async () => {
    const w = await world();
    const shown = await previewOf(w.cookie, w.p.id);
    const [a, b] = await Promise.all([writeOf(w.cookie, w.p.id, shown), writeOf(w.cookie, w.p.id, shown)]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    const refused = a.statusCode === 409 ? a : b;
    expect(refused.json()).toMatchObject({ code: "replan-structure-changed" });
    // One run's rows in the log, and the refused one's preview is the plan as it is now.
    expect((await events("structure_replanned")).filter((r) => r.entityType === "production_plan")).toHaveLength(1);
    const fresh: ReplanStructureResult = refused.json().result;
    expect(orderOf(fresh, w.p.id).planned.before).toEqual({ start: w.ready, end: nextWeekday(w.ready) });
  });

  it("a report that holds an operation of the tree and then takes its order does not deadlock (operation before order)", async () => {
    const w = await world();
    const body = { dueDate: weekdayOnOrAfter(addDays(today, 60)), moveComponentDueDates: true };
    const shown = await previewOf(w.cookie, w.p.id, body);
    const [h10] = await opsOf(w.h.id);
    let open!: () => void;
    const holding = new Promise<void>((resolve) => (open = resolve));
    let locked!: () => void;
    const inside = new Promise<void>((resolve) => (locked = resolve));
    // The reports' lock order: the operation, then the order row.
    const holder = db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM mo_operations WHERE id = ${h10!.id} FOR UPDATE`);
      locked();
      await holding;
      await tx.execute(sql`SELECT id FROM manufacturing_orders WHERE id = ${w.h.id} FOR UPDATE`);
    });
    await inside;
    let run: Promise<Awaited<ReturnType<typeof writeOf>>> | undefined;
    try {
      run = writeOf(w.cookie, w.p.id, shown, body).then((res) => res);
      run.catch(() => {});
      // The replan waits for the operation — it holds no order row yet.
      await waitForLockWaiter();
    } finally {
      open();
    }
    await holder;
    const res = await run!;
    expect(res.statusCode, res.body).toBe(200);
    expect((await dueDatesOf([w.p.id])).get(w.p.id)).toBe(body.dueDate);
  });
});

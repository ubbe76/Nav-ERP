import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@navet/db";
import { testArticleService, testDocumentPdfService } from "./helpers/services.js";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import { createManufacturingService } from "../src/modules/manufacturing/service/manufacturing.service.js";
import { createSalesRepository } from "../src/modules/sales/repository/sales.repository.js";
import { markSalesOrderInProduction } from "../src/modules/sales/service/production-transition.js";
import { createScheduleRepository } from "../src/modules/timereport/repository/schedule.repository.js";
import { createScheduleService } from "../src/modules/timereport/service/schedule.service.js";
import { createTimeReportRepository } from "../src/modules/timereport/repository/timereport.repository.js";
import { createPlanningRepository } from "../src/modules/planning/repository/planning.repository.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { createStockService } from "../src/modules/stock/service/stock.service.js";
import {
  createPlanningService,
  ManufacturingOrderNotFoundError,
  type ManufacturingPlanReader,
} from "../src/modules/planning/service/planning.service.js";

// Pegging (#9) against Postgres: a chain product → halvfabrikat → raw
// material, the halvfabrikat's TO covering the product TO's material need,
// Halvfabrikat sent on the TO card, the list row, the list's status filter
// (with total), Beläggning's chips and GET …/coverage. "Today" is pinned to
// Monday 2030-03-04 like production-plan.integration.test.ts.
const W1 = "2030-03-04";
const W4 = "2030-03-25";
const TODAY = W1;

const articleService = createArticleService(createArticleRepository(db));
const authRepo = createAuthRepository(db);
const salesRepository = createSalesRepository(db);
const stockService = createStockService(createStockRepository(db));

// The same late binding as app.ts.
const planReaderRef: { current: ManufacturingPlanReader | null } = { current: null };
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
  undefined,
  undefined,
  undefined,
  {
    planNewOrderInTx: (tx, moId, given, opts) => planReaderRef.current!.planNewOrderInTx(tx, moId, given, opts),
    replanOrderInTx: (tx, moId) => planReaderRef.current!.replanOrderInTx(tx, moId),
    orderPlanSummaries: (ids) => planReaderRef.current!.orderPlanSummaries(ids),
    componentLateOrders: (ids) => planReaderRef.current!.componentLateOrders!(ids),
  }
);
// Without a plan reader: its TOs are unplanned (ready on their due date) and
// its list/card never say Halvfabrikat sent.
const unplannedMfgService = createManufacturingService(createManufacturingRepository(db), testDocumentPdfService, testArticleService);
const scheduleService = createScheduleService(createScheduleRepository(db), createTimeReportRepository(db), {
  isDateLocked: async () => false,
});
const planningService = createPlanningService(createPlanningRepository(db), {
  purchase: {
    createPurchaseOrder: async () => {
      throw new Error("not used");
    },
    addRow: async () => {},
    cancel: async () => {},
  },
  manufacturing: mfgService,
  requirementsCacheMs: 0,
  today: () => TODAY,
});
planReaderRef.current = planningService;

const TRUNCATE = sql`TRUNCATE mo_operation_plan_weeks, mo_reports, mo_report_materials, mo_operation_scrap, mo_material_consumptions, mo_operations, manufacturing_orders, routing_operations, work_centers, production_groups, holidays, week_schedule_days, week_schedules, day_schedule_breaks, day_schedules, stock_transactions, stock_locations, warehouses, bom_components, article_suppliers, articles, users CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
});
afterAll(async () => {
  await db.execute(TRUNCATE);
});

// Two resources on a 40 h week; the product P (Ledtid 5 working days, Op 10
// on R2) is made of one halvfabrikat H (Op 10 on R1, 60 min/st) which is
// made of one raw material R (purchased).
async function seedWorld() {
  const user = await authRepo.create({
    email: `peg-${crypto.randomUUID()}@example.com`,
    passwordHash: "not-a-real-hash",
    name: "Planerare",
    role: "admin",
  });
  const day = await scheduleService.createDaySchedule({ code: "D8", name: "Dagtid 8h", startTime: "07:00", endTime: "15:00", breaks: [], active: true });
  const week = await scheduleService.createWeekSchedule({
    code: "VS40",
    name: "Veckoschema 40h",
    days: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, dayScheduleId: day.id })),
    active: true,
  });
  const r1 = await mfgService.createWorkCenter({ code: "101", name: "Kap", weekScheduleId: week.id, capacityFactor: 1, active: true });
  const r2 = await mfgService.createWorkCenter({ code: "201", name: "Montering", weekScheduleId: week.id, capacityFactor: 1, active: true });
  const suffix = crypto.randomUUID().slice(0, 8);
  const raw = await articleService.createArticle({ articleNumber: `R-${suffix}`, name: "Råvara", type: "purchased", active: true });
  const semi = await articleService.createArticle({ articleNumber: `H-${suffix}`, name: "Halvfabrikat", type: "manufactured", active: true });
  const product = await articleService.createArticle({
    articleNumber: `P-${suffix}`,
    name: "Produkt",
    type: "manufactured",
    active: true,
    manufacturingLeadTimeDays: 5,
  });
  await mfgService.createRoutingOperation(semi.id, { sequenceNo: 10, workCenterId: r1.id, setupTime: 0, runTimePerUnit: 60 });
  await mfgService.createRoutingOperation(product.id, { sequenceNo: 10, workCenterId: r2.id, setupTime: 0, runTimePerUnit: 60 });
  await articleService.addBomComponent(semi.id, { componentArticleId: raw.id, quantity: 1 });
  await articleService.addBomComponent(product.id, { componentArticleId: semi.id, quantity: 1 });
  return { user, r1, r2, raw, semi, product };
}
type World = Awaited<ReturnType<typeof seedWorld>>;

const list = (status?: string) => mfgService.listManufacturingOrders({ limit: 50, offset: 0, ...(status ? { status: status.split(",") as never } : {}) });

describe("the chain product → halvfabrikat → raw material", () => {
  it("an unplanned halvfabrikat TO due after the product TO's start is late for it: coverage, card, list row and filter", async () => {
    const world = await seedWorld();
    // Due Fri W4 with Ledtid 5 working days ⇒ the material is needed on
    // Fri 2030-03-22 (the TO's start); the plan puts its operation in W1,
    // which never wins over due − lead (planning.md).
    const parent = await mfgService.createManufacturingOrder({ articleId: world.product.id, quantity: 2, dueDate: "2030-03-29" }, world.user.id);
    // Unplanned ⇒ ready on its due date, Wed 2030-03-27: three working days
    // after the need.
    const semi = await unplannedMfgService.createManufacturingOrder({ articleId: world.semi.id, quantity: 2, dueDate: "2030-03-27" }, world.user.id);

    const coverage = await planningService.getManufacturingOrderCoverage(parent.id);
    expect(coverage).toMatchObject({ manufacturingOrderId: parent.id, orderNumber: parent.orderNumber, status: "released", componentLate: true, moves: [] });
    expect(coverage.materials).toEqual([
      expect.objectContaining({
        kind: "mo_material",
        articleId: world.semi.id,
        articleNumber: world.semi.articleNumber,
        articleType: "manufactured",
        needDate: "2030-03-22",
        quantity: 2,
        uncovered: 0,
        allocations: [
          { kind: "manufacturing_order", documentId: semi.id, documentNumber: semi.orderNumber, quantity: 2, readyDate: "2030-03-27", late: true, undated: false, daysLate: 3, isDraft: false },
        ],
      }),
    ]);
    // The product TO is supply for nothing: no demand, all surplus.
    expect(coverage.goesTo).toEqual([]);
    expect(coverage.surplus).toBe(2);

    // The halvfabrikat's own card: its raw material has no supply (uncovered),
    // it goes to the product TO (late for it), and nothing of its own is a late TO.
    const semiCoverage = await planningService.getManufacturingOrderCoverage(semi.id);
    expect(semiCoverage.componentLate).toBe(false);
    expect(semiCoverage.materials).toEqual([
      expect.objectContaining({ articleId: world.raw.id, articleType: "purchased", quantity: 2, uncovered: 2, allocations: [] }),
    ]);
    expect(semiCoverage.goesTo).toEqual([
      { kind: "mo_material", documentId: parent.id, documentNumber: parent.orderNumber, partner: `${world.product.articleNumber} — Produkt`, needDate: "2030-03-22", quantity: 2, late: true, daysLate: 3 },
    ]);
    expect(semiCoverage.surplus).toBe(0);

    // The card and the list row.
    expect((await mfgService.getManufacturingOrder(parent.id))?.componentLate).toBe(true);
    expect((await mfgService.getManufacturingOrder(semi.id))?.componentLate).toBe(false);
    const all = await list();
    expect(all.rows.find((r) => r.id === parent.id)?.componentLate).toBe(true);
    expect(all.rows.find((r) => r.id === semi.id)?.componentLate).toBe(false);
    // The filter: only the product TO, and total follows it.
    const filtered = await list("component_late");
    expect(filtered.rows.map((r) => r.id)).toEqual([parent.id]);
    expect(filtered.total).toBe(1);
    // Combined with Sen: the product TO is planned in W1 and due W4 — not
    // Sen — so both together list nothing; with a real status both apply.
    expect((await list("late,component_late")).total).toBe(0);
    expect((await list("released,component_late")).rows.map((r) => r.id)).toEqual([parent.id]);
    expect((await list("in_progress,component_late")).total).toBe(0);

    // The reader-less service never says Halvfabrikat sent.
    expect((await unplannedMfgService.getManufacturingOrder(parent.id))?.componentLate).toBe(false);
    expect((await unplannedMfgService.listManufacturingOrders({ limit: 50, offset: 0, status: ["component_late"] })).total).toBe(0);
  });

  it("a halvfabrikat TO ready in time is not late; a planned week after the need makes it late — the same finish as Sen", async () => {
    const world = await seedWorld();
    const parent = await mfgService.createManufacturingOrder({ articleId: world.product.id, quantity: 2, dueDate: "2030-03-29" }, world.user.id);
    // Planned in W1 (free capacity) ⇒ plannedFinish Fri 2030-03-08, well
    // before the need on 2030-03-22, although due only on Wed 2030-03-20.
    const semi = await mfgService.createManufacturingOrder({ articleId: world.semi.id, quantity: 2, dueDate: "2030-03-20" }, world.user.id);
    const [op10] = await mfgService.listOperations(semi.id);
    expect(op10).toMatchObject({ plannedStartWeek: W1, plannedEndWeek: W1 });

    let coverage = await planningService.getManufacturingOrderCoverage(parent.id);
    expect(coverage.componentLate).toBe(false);
    expect(coverage.materials[0]!.allocations[0]).toMatchObject({ documentId: semi.id, readyDate: "2030-03-08", late: false, daysLate: 0 });
    expect((await list("component_late")).total).toBe(0);

    // Flytta the operation to W4: the plan finishes it Fri 2030-03-29 —
    // after the need (5 working days) and after its own due date (Sen).
    await planningService.moveOperation(op10!.id, { weekMonday: W4, moveFollowing: false }, world.user.id);
    coverage = await planningService.getManufacturingOrderCoverage(parent.id);
    expect(coverage.componentLate).toBe(true);
    expect(coverage.materials[0]!.allocations[0]).toMatchObject({ documentId: semi.id, readyDate: "2030-03-29", late: true, daysLate: 5 });
    const summaries = await planningService.orderPlanSummaries([semi.id]);
    expect(summaries.get(semi.id)).toMatchObject({ late: true, plannedFinish: "2030-03-29", plannedEndWeek: W4 });
    expect((await list("component_late")).rows.map((r) => r.id)).toEqual([parent.id]);
    // Sen is the halvfabrikat's, Halvfabrikat sent the product's.
    const rows = (await list()).rows;
    expect(rows.find((r) => r.id === semi.id)).toMatchObject({ late: true, componentLate: false });
    expect(rows.find((r) => r.id === parent.id)).toMatchObject({ late: false, componentLate: true });

    // Beläggning: the product TO's chip carries the mark, the halvfabrikat's does not.
    const capacity = await planningService.getCapacity({ weeks: 4 });
    const chips = capacity.groups.flatMap((g) => g.resources.flatMap((r) => r.weeks.flatMap((w) => w.orders)));
    expect(chips.find((c) => c.manufacturingOrderId === parent.id)).toMatchObject({ componentLate: true, late: false });
    expect(chips.find((c) => c.manufacturingOrderId === semi.id)).toMatchObject({ componentLate: false, late: true });
  });

  it("one halvfabrikat TO feeding two product TOs goes to the earlier need first; only the parent it is late for is marked", async () => {
    const world = await seedWorld();
    // A needs 6 on Fri 2030-03-15 (due Fri 22 − 5), B needs 6 on Fri 2030-03-22.
    const a = await mfgService.createManufacturingOrder({ articleId: world.product.id, quantity: 6, dueDate: "2030-03-22" }, world.user.id);
    const b = await mfgService.createManufacturingOrder({ articleId: world.product.id, quantity: 6, dueDate: "2030-03-29" }, world.user.id);
    // 10 ready Mon 2030-03-18 (unplanned): A gets 6 one working day late, B
    // gets the remaining 4 in time and lacks 2.
    const semi = await unplannedMfgService.createManufacturingOrder({ articleId: world.semi.id, quantity: 10, dueDate: "2030-03-18" }, world.user.id);

    const forA = await planningService.getManufacturingOrderCoverage(a.id);
    expect(forA.componentLate).toBe(true);
    expect(forA.materials[0]).toMatchObject({ needDate: "2030-03-15", quantity: 6, uncovered: 0 });
    expect(forA.materials[0]!.allocations).toEqual([expect.objectContaining({ documentId: semi.id, quantity: 6, late: true, daysLate: 1 })]);
    const forB = await planningService.getManufacturingOrderCoverage(b.id);
    expect(forB.componentLate).toBe(false);
    expect(forB.materials[0]).toMatchObject({ needDate: "2030-03-22", quantity: 6, uncovered: 2 });
    expect(forB.materials[0]!.allocations).toEqual([expect.objectContaining({ documentId: semi.id, quantity: 4, late: false, daysLate: 0 })]);

    const forSemi = await planningService.getManufacturingOrderCoverage(semi.id);
    expect(forSemi.goesTo).toEqual([
      expect.objectContaining({ kind: "mo_material", documentId: a.id, documentNumber: a.orderNumber, needDate: "2030-03-15", quantity: 6, late: true, daysLate: 1 }),
      expect.objectContaining({ kind: "mo_material", documentId: b.id, documentNumber: b.orderNumber, needDate: "2030-03-22", quantity: 4, late: false, daysLate: 0 }),
    ]);
    expect(forSemi.surplus).toBe(0);

    const filtered = await list("component_late");
    expect(filtered.rows.map((r) => r.id)).toEqual([a.id]);
    expect(filtered.total).toBe(1);
    const set = await planningService.componentLateOrders([a.id, b.id, semi.id]);
    expect([...set]).toEqual([a.id]);
  });

  it("stock covers first and is never late; the halvfabrikat TO covers the rest", async () => {
    const world = await seedWorld();
    await stockService.recordTransaction({ articleId: world.semi.id, quantityDelta: 1, transactionType: "inventory_adjustment" });
    const parent = await mfgService.createManufacturingOrder({ articleId: world.product.id, quantity: 3, dueDate: "2030-03-29" }, world.user.id);
    const semi = await unplannedMfgService.createManufacturingOrder({ articleId: world.semi.id, quantity: 5, dueDate: "2030-03-27" }, world.user.id);

    const coverage = await planningService.getManufacturingOrderCoverage(parent.id);
    expect(coverage.materials[0]!.allocations).toEqual([
      { kind: "stock", documentId: null, documentNumber: null, quantity: 1, readyDate: TODAY, late: false, undated: false, daysLate: 0, isDraft: false },
      expect.objectContaining({ kind: "manufacturing_order", documentId: semi.id, quantity: 2, late: true, daysLate: 3 }),
    ]);
    expect(coverage.componentLate).toBe(true);
    expect((await planningService.getManufacturingOrderCoverage(semi.id)).surplus).toBe(3);
  });

  it("a closed TO has no coverage, an unknown id is 404", async () => {
    const world = await seedWorld();
    const parent = await mfgService.createManufacturingOrder({ articleId: world.product.id, quantity: 2, dueDate: "2030-03-29" }, world.user.id);
    await unplannedMfgService.createManufacturingOrder({ articleId: world.semi.id, quantity: 2, dueDate: "2030-03-27" }, world.user.id);
    await db.execute(sql`UPDATE manufacturing_orders SET status = 'done' WHERE id = ${parent.id}`);
    expect(await planningService.getManufacturingOrderCoverage(parent.id)).toEqual({
      manufacturingOrderId: parent.id,
      orderNumber: parent.orderNumber,
      status: "done",
      materials: [],
      goesTo: [],
      surplus: 0,
      componentLate: false,
      moves: [],
    });
    expect((await mfgService.getManufacturingOrder(parent.id))?.componentLate).toBe(false);
    expect((await list("component_late")).total).toBe(0);
    await expect(planningService.getManufacturingOrderCoverage(crypto.randomUUID())).rejects.toBeInstanceOf(ManufacturingOrderNotFoundError);
  });
});

import { createArticleSchema, createWeekScheduleSchema, createWorkCenterSchema } from "@navet/shared";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { auditLog, db, manufacturingOrders } from "@navet/db";
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
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import {
  COMPONENT_MOVE_NOTICE,
  ComponentMoveChangedError,
  createPlanningService,
  InvalidStatusTransitionError,
  ManufacturingOrderNotFoundError,
  type ManufacturingPlanReader,
} from "../src/modules/planning/service/planning.service.js";
import { parsed } from "./helpers/parsed.js";

// Flytta halvfabrikaten (pegging #9, etapp 2) against Postgres: the chain
// product P → halvfabrikat H → sub-halvfabrikat S → raw material R, the
// move rows in GET …/coverage (exclusive vs shared, earlier and later, the
// level-2 chain, the floor) and POST …/component-moves (the write, the
// händelselogg, and the refusals that write nothing). "Today" is pinned to
// Monday 2030-03-04 like pegging.integration.test.ts.
const TODAY = "2030-03-04";

const articleService = createArticleService(createArticleRepository(db));
const authRepo = createAuthRepository(db);
const salesRepository = createSalesRepository(db);

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
// Without a plan reader: its TOs are unplanned, so they are ready on their
// due date — the dates in the tests below are then exact.
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
  audit: createAuditRepository(db),
});
planReaderRef.current = planningService;

const TRUNCATE = sql`TRUNCATE audit_log, mo_operation_plan_weeks, mo_reports, mo_report_materials, mo_operation_scrap, mo_material_consumptions, mo_operations, manufacturing_orders, routing_operations, work_centers, production_groups, holidays, week_schedule_days, week_schedules, day_schedule_breaks, day_schedules, stock_transactions, stock_locations, warehouses, bom_components, article_suppliers, articles, users CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
});
afterAll(async () => {
  await db.execute(TRUNCATE);
});

// Two resources on a 40 h week. P (Ledtid 5 working days, Op 10 on R2) is
// made of one H (Op 10 on R1, 60 min/st ⇒ 1 working day for a few pieces),
// H of one S (the same), S of one purchased R. `semiLeadDays` sets H's
// Ledtid (dagar) field instead; `productNeedsSub` puts S directly on P too.
async function seedWorld(opts: { semiLeadDays?: number; productNeedsSub?: boolean } = {}) {
  const user = await authRepo.create({
    email: `peg-${crypto.randomUUID()}@example.com`,
    passwordHash: "not-a-real-hash",
    name: "Planerare",
    role: "admin",
  });
  const day = await scheduleService.createDaySchedule({ code: "D8", name: "Dagtid 8h", startTime: "07:00", endTime: "15:00", breaks: [], active: true });
  const week = await scheduleService.createWeekSchedule(parsed(createWeekScheduleSchema, {
    code: "VS40",
    name: "Veckoschema 40h",
    days: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, dayScheduleId: day.id })),
    active: true,
  }));
  const r1 = await mfgService.createWorkCenter(parsed(createWorkCenterSchema, { code: "101", name: "Kap", weekScheduleId: week.id, capacityFactor: 1, active: true }));
  const r2 = await mfgService.createWorkCenter(parsed(createWorkCenterSchema, { code: "201", name: "Montering", weekScheduleId: week.id, capacityFactor: 1, active: true }));
  const suffix = crypto.randomUUID().slice(0, 8);
  const raw = await articleService.createArticle(parsed(createArticleSchema, { articleNumber: `R-${suffix}`, name: "Råvara", type: "purchased", active: true }));
  const sub = await articleService.createArticle(parsed(createArticleSchema, { articleNumber: `S-${suffix}`, name: "Delhalvfabrikat", type: "manufactured", active: true }));
  const semi = await articleService.createArticle(parsed(createArticleSchema, {
    articleNumber: `H-${suffix}`,
    name: "Halvfabrikat",
    type: "manufactured",
    active: true,
    ...(opts.semiLeadDays !== undefined ? { manufacturingLeadTimeDays: opts.semiLeadDays } : {}),
  }));
  const product = await articleService.createArticle(parsed(createArticleSchema, {
    articleNumber: `P-${suffix}`,
    name: "Produkt",
    type: "manufactured",
    active: true,
    manufacturingLeadTimeDays: 5,
  }));
  await mfgService.createRoutingOperation(sub.id, { sequenceNo: 10, workCenterId: r1.id, setupTime: 0, runTimePerUnit: 60 });
  await mfgService.createRoutingOperation(semi.id, { sequenceNo: 10, workCenterId: r1.id, setupTime: 0, runTimePerUnit: 60 });
  await mfgService.createRoutingOperation(product.id, { sequenceNo: 10, workCenterId: r2.id, setupTime: 0, runTimePerUnit: 60 });
  await articleService.addBomComponent(sub.id, { componentArticleId: raw.id, quantity: 1 });
  await articleService.addBomComponent(semi.id, { componentArticleId: sub.id, quantity: 1 });
  await articleService.addBomComponent(product.id, { componentArticleId: semi.id, quantity: 1 });
  if (opts.productNeedsSub) await articleService.addBomComponent(product.id, { componentArticleId: sub.id, quantity: 1 });
  return { user, r1, r2, raw, sub, semi, product };
}

const dueDateOf = async (id: string) => (await db.select({ dueDate: manufacturingOrders.dueDate }).from(manufacturingOrders).where(eq(manufacturingOrders.id, id)))[0]!.dueDate;
const movesOf = async (id: string) => (await planningService.getManufacturingOrderCoverage(id)).moves;
const auditRows = () =>
  db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.entityType, "manufacturing_order"), eq(auditLog.action, "updated")))
    .orderBy(auditLog.createdAt);

describe("moves in GET /manufacturing-orders/:id/coverage", () => {
  it("a late exclusive halvfabrikat TO is offered the working day before the need, preselected; its own halvfabrikat follows at level 2", async () => {
    const world = await seedWorld();
    // P due Fri 03-29, Ledtid 5 ⇒ needs H on Fri 03-22. H due Wed 03-27
    // (unplanned ⇒ ready then): 3 working days late. H's own start today is
    // 03-26 (one working day of work), so S due 03-26 is on time for it.
    const parent = await mfgService.createManufacturingOrder({ articleId: world.product.id, quantity: 2, dueDate: "2030-03-29" }, world.user.id);
    const semi = await unplannedMfgService.createManufacturingOrder({ articleId: world.semi.id, quantity: 2, dueDate: "2030-03-27" }, world.user.id);
    const sub = await unplannedMfgService.createManufacturingOrder({ articleId: world.sub.id, quantity: 2, dueDate: "2030-03-26" }, world.user.id);
    // From H's own card S is in time (the same day) but due ON the need, so
    // the working day before is offered without being late.
    expect(await movesOf(semi.id)).toEqual([
      expect.objectContaining({ manufacturingOrderId: sub.id, level: 1, currentDueDate: "2030-03-26", suggestedDueDate: "2030-03-25", late: false, reason: "needed_earlier" }),
    ]);

    const moves = await movesOf(parent.id);
    expect(moves).toEqual([
      {
        id: `mv:${semi.id}`,
        parentMoveId: null,
        manufacturingOrderId: semi.id,
        orderNumber: semi.orderNumber,
        articleId: world.semi.id,
        articleNumber: world.semi.articleNumber,
        level: 1,
        currentDueDate: "2030-03-27",
        suggestedDueDate: "2030-03-21",
        late: false,
        exclusive: true,
        preselected: true,
        reason: "late",
      },
      // H due 03-21 starts Wed 03-20 (one working day of work) ⇒ S, ready
      // 03-26, is late for it and is offered the working day before.
      {
        id: `mv:${sub.id}`,
        parentMoveId: `mv:${semi.id}`,
        manufacturingOrderId: sub.id,
        orderNumber: sub.orderNumber,
        articleId: world.sub.id,
        articleNumber: world.sub.articleNumber,
        level: 2,
        currentDueDate: "2030-03-26",
        suggestedDueDate: "2030-03-19",
        late: false,
        exclusive: true,
        preselected: true,
        reason: "late",
      },
    ]);
  });

  it("a TO shared between two levels follows the moved parent's NEW start: P needs H and S, H needs S, one S TO covers both", async () => {
    const world = await seedWorld({ productNeedsSub: true });
    // P due Fri 03-29, Ledtid 5 ⇒ needs H and S on Fri 03-22. H due Wed
    // 03-27 starts 03-26 ⇒ needs S then. One S TO (4) due Tue 03-26 covers
    // P's 2 (late) and H's 2 (in time).
    const parent = await mfgService.createManufacturingOrder({ articleId: world.product.id, quantity: 2, dueDate: "2030-03-29" }, world.user.id);
    const semi = await unplannedMfgService.createManufacturingOrder({ articleId: world.semi.id, quantity: 2, dueDate: "2030-03-27" }, world.user.id);
    const sub = await unplannedMfgService.createManufacturingOrder({ articleId: world.sub.id, quantity: 4, dueDate: "2030-03-26" }, world.user.id);

    // Seen from P alone S would be offered 03-21 (the day before P's need).
    // But H moved to 03-21 starts Wed 03-20 and needs S then — the chain
    // finds that at level 2 and recomputes: S is offered Tue 03-19, the
    // working day before H's NEW start, so ticking both never makes S late
    // for H. S stays at level 1 (where P first met it), shared ⇒ not
    // preselected; nothing is listed under H since S is already listed.
    expect(await movesOf(parent.id)).toEqual([
      expect.objectContaining({ manufacturingOrderId: semi.id, level: 1, parentMoveId: null, currentDueDate: "2030-03-27", suggestedDueDate: "2030-03-21", exclusive: true, preselected: true, reason: "late" }),
      expect.objectContaining({
        manufacturingOrderId: sub.id,
        level: 1,
        parentMoveId: null,
        currentDueDate: "2030-03-26",
        suggestedDueDate: "2030-03-19",
        late: false,
        exclusive: false,
        preselected: false,
        reason: "late",
      }),
    ]);

    // Ticking both: S is in time for H's new start as well.
    await planningService.moveComponentOrders(
      parent.id,
      {
        moves: [
          { manufacturingOrderId: semi.id, dueDate: "2030-03-21", expectedDueDate: "2030-03-27" },
          { manufacturingOrderId: sub.id, dueDate: "2030-03-19", expectedDueDate: "2030-03-26" },
        ],
      },
      world.user.id
    );
    expect((await planningService.getManufacturingOrderCoverage(parent.id)).componentLate).toBe(false);
    expect((await planningService.getManufacturingOrderCoverage(semi.id)).componentLate).toBe(false);
    expect(await movesOf(parent.id)).toEqual([]);
  });

  it("a TO that also goes to other needs is shown but not preselected, and its suggestion follows the earliest of ALL its needs", async () => {
    const world = await seedWorld();
    // A needs 6 on Fri 03-15, B needs 6 on Fri 03-22; H (10, due Mon
    // 03-18) covers A one working day late and 4 of B in time.
    const a = await mfgService.createManufacturingOrder({ articleId: world.product.id, quantity: 6, dueDate: "2030-03-22" }, world.user.id);
    const b = await mfgService.createManufacturingOrder({ articleId: world.product.id, quantity: 6, dueDate: "2030-03-29" }, world.user.id);
    const semi = await unplannedMfgService.createManufacturingOrder({ articleId: world.semi.id, quantity: 10, dueDate: "2030-03-18" }, world.user.id);

    expect(await movesOf(a.id)).toEqual([
      expect.objectContaining({ manufacturingOrderId: semi.id, suggestedDueDate: "2030-03-14", late: false, exclusive: false, preselected: false, reason: "late" }),
    ]);
    // From B's card the same TO is not late for B, but A's earlier need
    // decides the date — moving it for B must not make it later for A.
    expect(await movesOf(b.id)).toEqual([
      expect.objectContaining({ manufacturingOrderId: semi.id, currentDueDate: "2030-03-18", suggestedDueDate: "2030-03-14", exclusive: false, preselected: false, reason: "needed_earlier" }),
    ]);
  });

  it("a need that moved out offers a later date; an undated TO gets a date; a TO already on the suggested date is not listed", async () => {
    const world = await seedWorld();
    const parent = await mfgService.createManufacturingOrder({ articleId: world.product.id, quantity: 2, dueDate: "2030-03-29" }, world.user.id);
    const early = await unplannedMfgService.createManufacturingOrder({ articleId: world.semi.id, quantity: 1, dueDate: "2030-03-12" }, world.user.id);
    const undated = await unplannedMfgService.createManufacturingOrder({ articleId: world.semi.id, quantity: 1 }, world.user.id);
    expect(await movesOf(parent.id)).toEqual([
      expect.objectContaining({ manufacturingOrderId: early.id, currentDueDate: "2030-03-12", suggestedDueDate: "2030-03-21", late: false, reason: "later_possible", preselected: true }),
      expect.objectContaining({ manufacturingOrderId: undated.id, currentDueDate: null, suggestedDueDate: "2030-03-21", late: false, reason: "undated", preselected: true }),
    ]);

    await mfgService.updateManufacturingOrder(early.id, { dueDate: "2030-03-21" }, world.user.id);
    await mfgService.updateManufacturingOrder(undated.id, { dueDate: "2030-03-21" }, world.user.id);
    expect(await movesOf(parent.id)).toEqual([]);
  });

  it("the floor today + lead time wins when the need is too close: late (hinner inte)", async () => {
    // H's Ledtid (dagar) 20 ⇒ the floor is Monday 04-01, after the need 03-22
    // but before H's due date 04-10: earlier, though not in time.
    const world = await seedWorld({ semiLeadDays: 20 });
    const parent = await mfgService.createManufacturingOrder({ articleId: world.product.id, quantity: 2, dueDate: "2030-03-29" }, world.user.id);
    const semi = await unplannedMfgService.createManufacturingOrder({ articleId: world.semi.id, quantity: 2, dueDate: "2030-04-10" }, world.user.id);
    expect(await movesOf(parent.id)).toEqual([
      expect.objectContaining({ manufacturingOrderId: semi.id, currentDueDate: "2030-04-10", suggestedDueDate: "2030-04-01", late: true, reason: "late" }),
    ]);
    // Due 03-27 (already before the floor): a late TO never gets a later date.
    await db.execute(sql`UPDATE manufacturing_orders SET due_date = '2030-03-27' WHERE id = ${semi.id}`);
    expect(await movesOf(parent.id)).toEqual([]);
  });

  it("a closed parent has no moves", async () => {
    const world = await seedWorld();
    const parent = await mfgService.createManufacturingOrder({ articleId: world.product.id, quantity: 2, dueDate: "2030-03-29" }, world.user.id);
    await unplannedMfgService.createManufacturingOrder({ articleId: world.semi.id, quantity: 2, dueDate: "2030-03-27" }, world.user.id);
    await db.execute(sql`UPDATE manufacturing_orders SET status = 'done' WHERE id = ${parent.id}`);
    expect(await movesOf(parent.id)).toEqual([]);
  });
});

describe("POST /manufacturing-orders/:id/component-moves (moveComponentOrders)", () => {
  it("sets the chosen TOs' due dates in one go, logs `updated` per TO with the reason, and the card then has nothing to move", async () => {
    const world = await seedWorld();
    const parent = await mfgService.createManufacturingOrder({ articleId: world.product.id, quantity: 2, dueDate: "2030-03-29" }, world.user.id);
    const semi = await unplannedMfgService.createManufacturingOrder({ articleId: world.semi.id, quantity: 2, dueDate: "2030-03-27" }, world.user.id);
    const sub = await unplannedMfgService.createManufacturingOrder({ articleId: world.sub.id, quantity: 2, dueDate: "2030-03-26" }, world.user.id);
    expect((await planningService.getManufacturingOrderCoverage(parent.id)).componentLate).toBe(true);

    const result = await planningService.moveComponentOrders(
      parent.id,
      {
        moves: [
          { manufacturingOrderId: sub.id, dueDate: "2030-03-19", expectedDueDate: "2030-03-26" },
          { manufacturingOrderId: semi.id, dueDate: "2030-03-21", expectedDueDate: "2030-03-27" },
        ],
      },
      world.user.id
    );
    expect(result).toEqual({
      moved: [
        { id: sub.id, orderNumber: sub.orderNumber, dueDate: "2030-03-19" },
        { id: semi.id, orderNumber: semi.orderNumber, dueDate: "2030-03-21" },
      ],
      notice: COMPONENT_MOVE_NOTICE,
    });
    expect(await dueDateOf(semi.id)).toBe("2030-03-21");
    expect(await dueDateOf(sub.id)).toBe("2030-03-19");
    expect((await auditRows()).map((r) => [r.entityId, r.detail, r.userId])).toEqual([
      [sub.orderNumber, { before: { dueDate: "2030-03-26" }, after: { dueDate: "2030-03-19" }, reason: "component_move", forOrder: parent.orderNumber }, world.user.id],
      [semi.orderNumber, { before: { dueDate: "2030-03-27" }, after: { dueDate: "2030-03-21" }, reason: "component_move", forOrder: parent.orderNumber }, world.user.id],
    ]);

    const coverage = await planningService.getManufacturingOrderCoverage(parent.id);
    expect(coverage.componentLate).toBe(false);
    expect(coverage.moves).toEqual([]);
    expect((await planningService.getManufacturingOrderCoverage(semi.id)).componentLate).toBe(false);

    // A move to the date a TO already has writes nothing and logs nothing.
    await planningService.moveComponentOrders(parent.id, { moves: [{ manufacturingOrderId: semi.id, dueDate: "2030-03-21", expectedDueDate: "2030-03-21" }] }, world.user.id);
    expect((await auditRows()).length).toBe(2);
  });

  it("409 component-move-changed when a TO's due date is no longer the one shown — nothing written, not even the other TOs", async () => {
    const world = await seedWorld();
    const parent = await mfgService.createManufacturingOrder({ articleId: world.product.id, quantity: 2, dueDate: "2030-03-29" }, world.user.id);
    const semi = await unplannedMfgService.createManufacturingOrder({ articleId: world.semi.id, quantity: 2, dueDate: "2030-03-27" }, world.user.id);
    const sub = await unplannedMfgService.createManufacturingOrder({ articleId: world.sub.id, quantity: 2, dueDate: "2030-03-26" }, world.user.id);
    // Someone moved S meanwhile.
    await mfgService.updateManufacturingOrder(sub.id, { dueDate: "2030-03-25" }, world.user.id);
    await db.execute(sql`DELETE FROM audit_log`);

    const err = await planningService
      .moveComponentOrders(
        parent.id,
        {
          moves: [
            { manufacturingOrderId: semi.id, dueDate: "2030-03-21", expectedDueDate: "2030-03-27" },
            { manufacturingOrderId: sub.id, dueDate: "2030-03-19", expectedDueDate: "2030-03-26" },
          ],
        },
        world.user.id
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ComponentMoveChangedError);
    expect(err).toMatchObject({ orderNumber: sub.orderNumber, expectedDueDate: "2030-03-26", currentDueDate: "2030-03-25" });
    expect(await dueDateOf(semi.id)).toBe("2030-03-27");
    expect(await dueDateOf(sub.id)).toBe("2030-03-25");
    expect(await auditRows()).toEqual([]);
  });

  it("409 invalid-status-transition for a TO that is no longer open; 404 for an unknown parent or an unknown TO in the list", async () => {
    const world = await seedWorld();
    const parent = await mfgService.createManufacturingOrder({ articleId: world.product.id, quantity: 2, dueDate: "2030-03-29" }, world.user.id);
    const semi = await unplannedMfgService.createManufacturingOrder({ articleId: world.semi.id, quantity: 2, dueDate: "2030-03-27" }, world.user.id);
    const other = await unplannedMfgService.createManufacturingOrder({ articleId: world.semi.id, quantity: 1, dueDate: "2030-03-27" }, world.user.id);
    await db.execute(sql`UPDATE manufacturing_orders SET status = 'closed' WHERE id = ${semi.id}`);

    const moves = [
      { manufacturingOrderId: other.id, dueDate: "2030-03-21", expectedDueDate: "2030-03-27" },
      { manufacturingOrderId: semi.id, dueDate: "2030-03-21", expectedDueDate: "2030-03-27" },
    ];
    const err = await planningService.moveComponentOrders(parent.id, { moves }, world.user.id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidStatusTransitionError);
    expect(err).toMatchObject({ orderNumber: semi.orderNumber, status: "closed" });
    expect(await dueDateOf(other.id)).toBe("2030-03-27");
    expect(await dueDateOf(semi.id)).toBe("2030-03-27");

    await expect(planningService.moveComponentOrders(crypto.randomUUID(), { moves }, world.user.id)).rejects.toBeInstanceOf(ManufacturingOrderNotFoundError);
    await expect(
      planningService.moveComponentOrders(
        parent.id,
        { moves: [moves[0]!, { manufacturingOrderId: crypto.randomUUID(), dueDate: "2030-03-21", expectedDueDate: null }] },
        world.user.id
      )
    ).rejects.toBeInstanceOf(ManufacturingOrderNotFoundError);
    expect(await dueDateOf(other.id)).toBe("2030-03-27");
    expect(await auditRows()).toEqual([]);
  });
});

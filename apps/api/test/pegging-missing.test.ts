import { createArticleSchema, createWeekScheduleSchema, createWorkCenterSchema } from "@navet/shared";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
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
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { createStockService } from "../src/modules/stock/service/stock.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import {
  createPlanningService,
  InvalidStatusTransitionError,
  ManufacturingOrderNotFoundError,
  MissingComponentsChangedError,
  NothingToCreateError,
  type ManufacturingOrderCreator,
  type ManufacturingPlanReader,
} from "../src/modules/planning/service/planning.service.js";
import { parsed } from "./helpers/parsed.js";
import { unwiredSalesOrderLinks } from "./helpers/unwired";

// Skapa saknade halvfabrikat (pegging #9, etapp 3) against Postgres: the
// chain product P → halvfabrikat H → sub-halvfabrikat S → raw material R.
// The preview (GET …/missing-components), the create (POST — deepest level
// first in one transaction, the parent then covered), and the refusals that
// write nothing. "Today" is pinned to Monday 2030-03-04 like the other
// pegging suites.
const TODAY = "2030-03-04";

const articleService = createArticleService(createArticleRepository(db));
const authRepo = createAuthRepository(db);
const salesRepository = createSalesRepository(db);
const stockService = createStockService(createStockRepository(db));

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
// due date — the competing TOs below.
const unplannedMfgService = createManufacturingService(createManufacturingRepository(db), testDocumentPdfService, testArticleService, unwiredSalesOrderLinks);
const scheduleService = createScheduleService(createScheduleRepository(db), createTimeReportRepository(db), {
  isDateLocked: async () => false,
});
const purchaseStub = {
  createPurchaseOrder: async () => {
    throw new Error("not used");
  },
  addRow: async () => {},
  cancel: async () => {},
};
const planningService = createPlanningService(createPlanningRepository(db), {
  purchase: purchaseStub,
  manufacturing: mfgService,
  requirementsCacheMs: 0,
  today: () => TODAY,
  audit: createAuditRepository(db),
});
planReaderRef.current = planningService;

const TRUNCATE = sql`TRUNCATE audit_log, mo_operation_plan_weeks, mo_reports, mo_report_materials, mo_operation_scrap, mo_material_consumptions, mo_operations, manufacturing_orders, routing_operations, work_centers, production_groups, holidays, week_schedule_days, week_schedules, day_schedule_breaks, day_schedules, stock_transactions, stock_locations, warehouses, bom_components, article_suppliers, configurator_templates, articles, users CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
});
afterAll(async () => {
  await db.execute(TRUNCATE);
});

// Two resources on a 40 h week. P (Ledtid 5 working days, Op 10 on R2) is
// made of one H (Op 10 on R1, 60 min/st ⇒ 1 working day for a few pieces),
// H of one S (the same), S of one purchased R. `productNeedsRaw` puts two
// R directly on P too.
async function seedWorld(opts: { semiOrderQuantity?: number; productNeedsRaw?: boolean } = {}) {
  const user = await authRepo.create({
    email: `missing-${crypto.randomUUID()}@example.com`,
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
    ...(opts.semiOrderQuantity !== undefined ? { orderQuantity: opts.semiOrderQuantity } : {}),
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
  if (opts.productNeedsRaw) await articleService.addBomComponent(product.id, { componentArticleId: raw.id, quantity: 2 });
  return { user, r1, r2, raw, sub, semi, product };
}

const expectedOf = (preview: { orders: { articleId: string; quantity: number; level: number }[] }) =>
  preview.orders.map((o) => ({ articleId: o.articleId, quantity: o.quantity, level: o.level }));
const moRows = (ids: string[]) =>
  db
    .select({ id: manufacturingOrders.id, articleId: manufacturingOrders.articleId, quantity: manufacturingOrders.quantity, dueDate: manufacturingOrders.dueDate, note: manufacturingOrders.note, status: manufacturingOrders.status })
    .from(manufacturingOrders)
    .where(inArray(manufacturingOrders.id, ids));
const auditRows = () =>
  db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.entityType, "manufacturing_order"), inArray(auditLog.action, ["released", "component_orders_created"])))
    .orderBy(auditLog.createdAt);
const slim = (o: { articleId: string; level: number; quantity: number; dueDate: string | null; late: boolean; needDate: string | null; parentKey: string | null }) => ({
  articleId: o.articleId,
  level: o.level,
  quantity: o.quantity,
  dueDate: o.dueDate,
  late: o.late,
  needDate: o.needDate,
  parentKey: o.parentKey,
});

describe("GET /manufacturing-orders/:id/missing-components (getMissingComponents)", () => {
  it("previews the whole structure: H the working day before P's start, S before H's start, R as a note", async () => {
    const world = await seedWorld();
    // P due Fri 03-29, Ledtid 5 ⇒ starts Fri 03-22 = H's need. H (one
    // working day of work) due Thu 03-21 starts Wed 03-20 = S's need.
    const parent = await mfgService.createManufacturingOrder({ articleId: world.product.id, quantity: 2, dueDate: "2030-03-29" }, world.user.id);
    const preview = await planningService.getMissingComponents(parent.id);
    expect(preview.orders.map(slim)).toEqual([
      { articleId: world.semi.id, level: 1, quantity: 2, dueDate: "2030-03-21", late: false, needDate: "2030-03-22", parentKey: null },
      { articleId: world.sub.id, level: 2, quantity: 2, dueDate: "2030-03-19", late: false, needDate: "2030-03-20", parentKey: preview.orders[0]!.key },
    ]);
    expect(preview.orders.map((o) => [o.articleNumber, o.articleName])).toEqual([
      [world.semi.articleNumber, "Halvfabrikat"],
      [world.sub.articleNumber, "Delhalvfabrikat"],
    ]);
    expect(preview.notes).toEqual([`${world.raw.articleNumber} köps (2 st saknas) — syns i Behovsberäkningen`]);
  });

  it("nets against existing supply: a covering H TO leaves nothing; the order-quantity multiple and stock on S shape the tree", async () => {
    const world = await seedWorld({ semiOrderQuantity: 5 });
    const parent = await mfgService.createManufacturingOrder({ articleId: world.product.id, quantity: 2, dueDate: "2030-03-29" }, world.user.id);
    await stockService.recordTransaction({ articleId: world.sub.id, quantityDelta: 3, transactionType: "inventory_adjustment" });
    // H comes in fives ⇒ 5; S needs 5, 3 on the shelf ⇒ 2.
    const preview = await planningService.getMissingComponents(parent.id);
    expect(preview.orders.map((o) => [o.articleId, o.level, o.quantity])).toEqual([
      [world.semi.id, 1, 5],
      [world.sub.id, 2, 2],
    ]);
    expect(preview.notes).toEqual([`${world.raw.articleNumber} köps (2 st saknas) — syns i Behovsberäkningen`]);

    // An existing H TO covers P ⇒ nothing to create.
    await unplannedMfgService.createManufacturingOrder({ articleId: world.semi.id, quantity: 2, dueDate: "2030-03-27" }, world.user.id);
    expect(await planningService.getMissingComponents(parent.id)).toEqual({ orders: [], notes: [] });
  });

  it("an undated parent gives undated TOs with a note; a variants template is a note", async () => {
    const world = await seedWorld();
    // Unplanned: a planned TO without a due date starts in its planned week
    // (moStartDate), which would date the need.
    const parent = await unplannedMfgService.createManufacturingOrder({ articleId: world.product.id, quantity: 1 }, world.user.id);
    const preview = await planningService.getMissingComponents(parent.id);
    expect(preview.orders.map((o) => [o.articleId, o.level, o.dueDate, o.needDate])).toEqual([
      [world.semi.id, 1, null, null],
      [world.sub.id, 2, null, null],
    ]);
    expect(preview.notes).toEqual([
      "Behovet saknar datum — de nya tillverkningsordrarna får inget färdigdatum",
      `${world.raw.articleNumber} köps (1 st saknas) — syns i Behovsberäkningen`,
    ]);

    await db.execute(sql`INSERT INTO configurator_templates (article_id, mode) VALUES (${world.sub.id}, 'variants')`);
    const templated = await planningService.getMissingComponents(parent.id);
    expect(templated.orders.map((o) => o.articleId)).toEqual([world.semi.id]);
    expect(templated.notes).toEqual([
      "Behovet saknar datum — de nya tillverkningsordrarna får inget färdigdatum",
      `${world.sub.articleNumber} är en variantmall — välj en variant`,
    ]);
  });

  it("a purchased article the parent lacks directly is a note at level 1 — also when nothing is to be manufactured", async () => {
    const world = await seedWorld({ productNeedsRaw: true });
    const parent = await mfgService.createManufacturingOrder({ articleId: world.product.id, quantity: 2, dueDate: "2030-03-29" }, world.user.id);
    // P lacks 4 R directly (level 1), the new S TO lacks 2 R (level 3).
    let preview = await planningService.getMissingComponents(parent.id);
    expect(preview.orders.map((o) => [o.articleId, o.level])).toEqual([
      [world.semi.id, 1],
      [world.sub.id, 2],
    ]);
    expect(preview.notes).toEqual([
      `${world.raw.articleNumber} köps (4 st saknas) — syns i Behovsberäkningen`,
      `${world.raw.articleNumber} köps (2 st saknas) — syns i Behovsberäkningen`,
    ]);

    // H covered ⇒ no TO, but the purchased shortage is still told.
    await unplannedMfgService.createManufacturingOrder({ articleId: world.semi.id, quantity: 2, dueDate: "2030-03-27" }, world.user.id);
    preview = await planningService.getMissingComponents(parent.id);
    expect(preview).toEqual({ orders: [], notes: [`${world.raw.articleNumber} köps (4 st saknas) — syns i Behovsberäkningen`] });
    await expect(planningService.createMissingComponents(parent.id, { expected: [{ articleId: world.semi.id, quantity: 2, level: 1 }] }, world.user.id)).rejects.toBeInstanceOf(
      NothingToCreateError
    );
  });

  it("the cycle note names the parent's ARTICLE: P → H → S", async () => {
    const world = await seedWorld();
    // The article service refuses a BOM cycle, so the edge S → H is planted
    // directly (the structure of an imported register can hold one).
    await db.execute(sql`INSERT INTO bom_components (parent_article_id, component_article_id, quantity) VALUES (${world.sub.id}, ${world.semi.id}, 1)`);
    const parent = await mfgService.createManufacturingOrder({ articleId: world.product.id, quantity: 2, dueDate: "2030-03-29" }, world.user.id);
    const preview = await planningService.getMissingComponents(parent.id);
    expect(preview.orders.map((o) => [o.articleId, o.level])).toEqual([
      [world.semi.id, 1],
      [world.sub.id, 2],
    ]);
    expect(preview.notes).toEqual([
      `${world.semi.articleNumber} ingår i sin egen struktur (${world.product.articleNumber} → ${world.semi.articleNumber} → ${world.sub.articleNumber}) — hoppas över`,
      `${world.raw.articleNumber} köps (2 st saknas) — syns i Behovsberäkningen`,
    ]);
  });

  it("a closed parent has an empty preview; an unknown TO is 404", async () => {
    const world = await seedWorld();
    const parent = await mfgService.createManufacturingOrder({ articleId: world.product.id, quantity: 2, dueDate: "2030-03-29" }, world.user.id);
    await db.execute(sql`UPDATE manufacturing_orders SET status = 'done' WHERE id = ${parent.id}`);
    expect(await planningService.getMissingComponents(parent.id)).toEqual({ orders: [], notes: [] });
    await expect(planningService.getMissingComponents(crypto.randomUUID())).rejects.toBeInstanceOf(ManufacturingOrderNotFoundError);
  });
});

describe("POST /manufacturing-orders/:id/missing-components (createMissingComponents)", () => {
  it("creates the TOs deepest level first with the preview's quantities, dates and note; the parent is then covered; released + component_orders_created are logged", async () => {
    const world = await seedWorld();
    const parent = await mfgService.createManufacturingOrder({ articleId: world.product.id, quantity: 2, dueDate: "2030-03-29" }, world.user.id);
    await db.execute(sql`DELETE FROM audit_log`);
    const preview = await planningService.getMissingComponents(parent.id);

    const result = await planningService.createMissingComponents(parent.id, { expected: expectedOf(preview) }, world.user.id);
    expect(result.manufacturingOrders.map((mo) => [mo.articleNumber, mo.quantity, mo.level])).toEqual([
      [world.sub.articleNumber, 2, 2],
      [world.semi.articleNumber, 2, 1],
    ]);
    const [subOrder, semiOrder] = result.manufacturingOrders;
    // Planned on free capacity: nothing late — only the releases' own
    // material-shortage warnings (no stock of R or S yet), prefixed with
    // the TO number.
    const releaseWarnings = [
      `${subOrder!.orderNumber}: Råvara: behöver 2, tillgängligt 0`,
      `${semiOrder!.orderNumber}: Delhalvfabrikat: behöver 2, tillgängligt 0`,
    ];
    expect(result.warnings).toEqual(releaseWarnings);
    expect(subOrder!.orderNumber < semiOrder!.orderNumber).toBe(true);
    const rows = await moRows(result.manufacturingOrders.map((mo) => mo.id));
    expect(rows.map((r) => ({ ...r, quantity: Number(r.quantity) }))).toEqual(
      expect.arrayContaining([
        { id: subOrder!.id, articleId: world.sub.id, quantity: 2, dueDate: "2030-03-19", note: `Skapad för ${parent.orderNumber} (halvfabrikat)`, status: "released" },
        { id: semiOrder!.id, articleId: world.semi.id, quantity: 2, dueDate: "2030-03-21", note: `Skapad för ${parent.orderNumber} (halvfabrikat)`, status: "released" },
      ])
    );

    const coverage = await planningService.getManufacturingOrderCoverage(parent.id);
    expect(coverage.materials.map((m) => [m.articleId, m.uncovered, m.allocations.map((a) => [a.kind, a.documentId, a.quantity, a.late])])).toEqual([
      [world.semi.id, 0, [["manufacturing_order", semiOrder!.id, 2, false]]],
    ]);
    const semiCoverage = await planningService.getManufacturingOrderCoverage(semiOrder!.id);
    expect(semiCoverage.materials.map((m) => [m.articleId, m.uncovered, m.allocations.map((a) => [a.kind, a.documentId, a.quantity])])).toEqual([
      [world.sub.id, 0, [["manufacturing_order", subOrder!.id, 2]]],
    ]);
    expect(await planningService.getMissingComponents(parent.id)).toEqual({ orders: [], notes: [] });

    expect((await auditRows()).map((r) => [r.action, r.entityId, r.detail, r.userId])).toEqual([
      ["released", subOrder!.orderNumber, null, world.user.id],
      ["released", semiOrder!.orderNumber, null, world.user.id],
      [
        "component_orders_created",
        parent.orderNumber,
        { orderNumbers: `${subOrder!.orderNumber}, ${semiOrder!.orderNumber}` },
        world.user.id,
      ],
    ]);
  });

  it("409 missing-components-changed with the fresh preview when a competing TO changed the tree — nothing written", async () => {
    const world = await seedWorld();
    const parent = await mfgService.createManufacturingOrder({ articleId: world.product.id, quantity: 2, dueDate: "2030-03-29" }, world.user.id);
    const preview = await planningService.getMissingComponents(parent.id);
    // Someone made one H meanwhile: only one more is missing.
    const competing = await unplannedMfgService.createManufacturingOrder({ articleId: world.semi.id, quantity: 1, dueDate: "2030-03-27" }, world.user.id);
    await db.execute(sql`DELETE FROM audit_log`);

    const err = await planningService.createMissingComponents(parent.id, { expected: expectedOf(preview) }, world.user.id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MissingComponentsChangedError);
    expect((err as MissingComponentsChangedError).result.orders.map((o) => [o.articleId, o.level, o.quantity])).toEqual([
      [world.semi.id, 1, 1],
      [world.sub.id, 2, 1],
    ]);
    expect((await db.select({ id: manufacturingOrders.id }).from(manufacturingOrders)).map((r) => r.id).sort()).toEqual([parent.id, competing.id].sort());
    expect(await auditRows()).toEqual([]);
  });

  it("409 nothing-to-create when the parent is covered meanwhile; 409 invalid-status-transition for a closed parent; 404 unknown", async () => {
    const world = await seedWorld();
    const parent = await mfgService.createManufacturingOrder({ articleId: world.product.id, quantity: 2, dueDate: "2030-03-29" }, world.user.id);
    const preview = await planningService.getMissingComponents(parent.id);
    await unplannedMfgService.createManufacturingOrder({ articleId: world.semi.id, quantity: 2, dueDate: "2030-03-27" }, world.user.id);
    await expect(planningService.createMissingComponents(parent.id, { expected: expectedOf(preview) }, world.user.id)).rejects.toBeInstanceOf(NothingToCreateError);

    await db.execute(sql`UPDATE manufacturing_orders SET status = 'done' WHERE id = ${parent.id}`);
    const closed = await planningService.createMissingComponents(parent.id, { expected: expectedOf(preview) }, world.user.id).catch((e: unknown) => e);
    expect(closed).toBeInstanceOf(InvalidStatusTransitionError);
    expect(closed).toMatchObject({ orderNumber: parent.orderNumber, status: "done" });

    await expect(
      planningService.createMissingComponents(crypto.randomUUID(), { expected: expectedOf(preview) }, world.user.id)
    ).rejects.toBeInstanceOf(ManufacturingOrderNotFoundError);
    expect(await db.select({ id: manufacturingOrders.id }).from(manufacturingOrders)).toHaveLength(2);
  });

  it("a failing create midway rolls everything back — no TO persisted, nothing logged", async () => {
    const world = await seedWorld();
    const parent = await mfgService.createManufacturingOrder({ articleId: world.product.id, quantity: 2, dueDate: "2030-03-29" }, world.user.id);
    await db.execute(sql`DELETE FROM audit_log`);
    const preview = await planningService.getMissingComponents(parent.id);

    let calls = 0;
    const failing: ManufacturingOrderCreator = {
      ...mfgService,
      createManufacturingOrderInTx: async (tx, input, createdBy, opts) => {
        calls += 1;
        if (calls === 2) throw new Error("boom after the first TO");
        return mfgService.createManufacturingOrderInTx(tx, input, createdBy, opts);
      },
    };
    const failingService = createPlanningService(createPlanningRepository(db), {
      purchase: purchaseStub,
      manufacturing: failing,
      requirementsCacheMs: 0,
      today: () => TODAY,
      audit: createAuditRepository(db),
    });
    await expect(failingService.createMissingComponents(parent.id, { expected: expectedOf(preview) }, world.user.id)).rejects.toThrow("boom after the first TO");
    expect(calls).toBe(2);
    expect((await db.select({ id: manufacturingOrders.id }).from(manufacturingOrders)).map((r) => r.id)).toEqual([parent.id]);
    expect(await auditRows()).toEqual([]);
    // The preview is unchanged and the real create still works.
    expect(await planningService.getMissingComponents(parent.id)).toEqual(preview);
    const result = await planningService.createMissingComponents(parent.id, { expected: expectedOf(preview) }, world.user.id);
    expect(result.manufacturingOrders).toHaveLength(2);
  });

  it("a late preview row becomes a warning with Skapa ordrar's text", async () => {
    const world = await seedWorld();
    // P due tomorrow: H is needed today at the latest; its floor is today +
    // one working day.
    const parent = await mfgService.createManufacturingOrder({ articleId: world.product.id, quantity: 2, dueDate: "2030-03-05" }, world.user.id);
    const preview = await planningService.getMissingComponents(parent.id);
    expect(preview.orders.map((o) => [o.articleId, o.dueDate, o.late])).toEqual([
      [world.semi.id, "2030-03-05", true],
      [world.sub.id, "2030-03-05", true],
    ]);
    const result = await planningService.createMissingComponents(parent.id, { expected: expectedOf(preview) }, world.user.id);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        `${world.semi.articleNumber}: Färdigdatumet (2030-03-05) hinner inte före behovet (${preview.orders[0]!.needDate})`,
        `${world.sub.articleNumber}: Färdigdatumet (2030-03-05) hinner inte före behovet (${preview.orders[1]!.needDate})`,
      ])
    );
  });
});

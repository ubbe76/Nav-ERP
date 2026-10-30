import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  auditLog,
  db,
  inquiries,
  inquiryRows,
  moMaterialConsumptions,
  moOperationPlanWeeks,
  moOperations,
  purchaseOrderRows,
  purchaseOrders,
  stockTransactions,
  systemSettings,
  units,
} from "@navet/db";
import { testArticleService, testDocumentPdfService } from "./helpers/services.js";
import { insertPlannedManufacturingOrder } from "./helpers/planned-manufacturing-order.js";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { ArticleIsTemplateError, createArticleService, InvalidUnitError } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import {
  createManufacturingService,
  LastOperationLockedError,
  ManufacturingOrderNotEditableError,
  MoMaterialConsumedError,
  MoMaterialDuplicateError,
  MoMaterialOwnArticleError,
  MoMaterialPhantomError,
  MOMaterialConsumptionNotFoundError,
  MoOperationDoneError,
  MoOperationLinkedPurchaseError,
  MoOperationNotOnOrderError,
  MOOperationNotFoundError,
  MoOperationReportedError,
  MoOperationSequenceTakenError,
  MoOperationStampedError,
  NotSubcontractOperationError,
} from "../src/modules/manufacturing/service/manufacturing.service.js";
import { createPlanningRepository } from "../src/modules/planning/repository/planning.repository.js";
import { createPlanningService, type ManufacturingPlanReader } from "../src/modules/planning/service/planning.service.js";
import { createPurchaseRepository } from "../src/modules/purchase/repository/purchase.repository.js";
import { createSalesRepository } from "../src/modules/sales/repository/sales.repository.js";
import { markSalesOrderInProduction } from "../src/modules/sales/service/production-transition.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { createStockService } from "../src/modules/stock/service/stock.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { createScheduleRepository } from "../src/modules/timereport/repository/schedule.repository.js";
import { createScheduleService } from "../src/modules/timereport/service/schedule.service.js";
import { createTimeReportRepository } from "../src/modules/timereport/repository/timereport.repository.js";
import { createTimeReportService } from "../src/modules/timereport/service/timereport.service.js";

// Ändra material och operationer på en skapad TO against Postgres: every
// guard, the top-up rule after a changed quantity, the unlinking of
// material when its operation goes, the last-operation lock, the replan
// (including orimligt mycket tid and the lock released by a resource
// change), the händelselogg and a report racing an edit. "Today" is
// pinned to Monday 2030-03-04 like production-plan.integration.test.ts.
const W1 = "2030-03-04";
const W2 = "2030-03-11";
const TODAY = W1;

const articleService = createArticleService(createArticleRepository(db));
const stockService = createStockService(createStockRepository(db));
const authRepo = createAuthRepository(db);
const salesRepository = createSalesRepository(db);
const purchaseRepository = createPurchaseRepository(db);
const auditRepository = createAuditRepository(db);
const periodLocks = { isDateLocked: async () => false };

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
  auditRepository,
  undefined,
  periodLocks,
  undefined,
  {
    planNewOrderInTx: (tx, moId, given) => planReaderRef.current!.planNewOrderInTx(tx, moId, given),
    replanOrderInTx: (tx, moId) => planReaderRef.current!.replanOrderInTx(tx, moId),
    orderPlanSummaries: (ids) => planReaderRef.current!.orderPlanSummaries(ids),
  }
);
const timeReportRepository = createTimeReportRepository(db);
const scheduleService = createScheduleService(createScheduleRepository(db), timeReportRepository, periodLocks);
const timeReportService = createTimeReportService(timeReportRepository, mfgService, periodLocks, { log: async () => {} });
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
  audit: { log: async () => {} },
});
planReaderRef.current = planningService;

const TRUNCATE = sql`TRUNCATE configurator_templates, mo_operation_plan_weeks, mo_reports, mo_report_materials, mo_operation_scrap, mo_material_consumptions, mo_operations, manufacturing_orders, routing_operations, inquiry_rows, inquiries, purchase_order_rows, purchase_orders, work_centers, production_groups, holidays, week_schedule_days, week_schedules, day_schedule_breaks, day_schedules, attendance_sessions, stamp_sessions, time_reports, employees, stock_transactions, stock_locations, warehouses, bom_components, article_units, articles, suppliers, audit_log, users CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
  await db.delete(systemSettings).where(eq(systemSettings.key, "planning_long_operation_weeks"));
});
afterAll(async () => {
  await db.execute(TRUNCATE);
  await db.delete(systemSettings).where(eq(systemSettings.key, "planning_long_operation_weeks"));
});

async function planRows(opId: string) {
  const rows = await db
    .select({ monday: moOperationPlanWeeks.weekMonday, minutes: moOperationPlanWeeks.minutes })
    .from(moOperationPlanWeeks)
    .where(eq(moOperationPlanWeeks.moOperationId, opId))
    .orderBy(moOperationPlanWeeks.weekMonday);
  return rows.map((r) => ({ monday: r.monday, minutes: Number(r.minutes) }));
}

async function opRow(opId: string) {
  const [row] = await db.select().from(moOperations).where(eq(moOperations.id, opId));
  return row ?? null;
}

async function materialRows(moId: string) {
  return db.select().from(moMaterialConsumptions).where(eq(moMaterialConsumptions.manufacturingOrderId, moId));
}

// In the order they were written — never the table's physical order, which
// a reused (DELETE-cleaned) table does not keep.
async function auditRows(action: string) {
  return db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.entityType, "manufacturing_order"), eq(auditLog.action, action)))
    .orderBy(auditLog.createdAt);
}

async function stockOf(articleId: string) {
  const [row] = await db
    .select({ q: sql<string>`coalesce(sum(${stockTransactions.quantityDelta}), 0)` })
    .from(stockTransactions)
    .where(eq(stockTransactions.articleId, articleId));
  return Number(row!.q);
}

// Two own resources on a 40 h week and a legoresurs; a parent whose route
// is Op 10 on R1 (60 min/st) and Op 20 on R2 (60 min/st), with component
// C1 (2 per unit, linked to Op 10) and 100 st of C1 in stock. The TO is
// 10 st — released and planned at creation.
async function seedWorld() {
  const user = await authRepo.create({ email: `edit-${crypto.randomUUID()}@example.com`, passwordHash: "x", name: "Beredare", role: "admin" });
  const day = await scheduleService.createDaySchedule({ code: "D8", name: "Dagtid 8h", startTime: "07:00", endTime: "15:00", breaks: [], active: true });
  const week = await scheduleService.createWeekSchedule({
    code: "VS40",
    name: "Veckoschema 40h",
    days: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, dayScheduleId: day.id })),
    active: true,
  });
  const r1 = await mfgService.createWorkCenter({ code: "101", name: "Kap", weekScheduleId: week.id, capacityFactor: 1, active: true });
  const r2 = await mfgService.createWorkCenter({ code: "201", name: "Svets", weekScheduleId: week.id, capacityFactor: 1, active: true });
  const supplier = await purchaseRepository.createSupplier({ name: "Lego AB", active: true });
  const lego = await mfgService.createWorkCenter({ code: "301", name: "Ytbehandling", type: "subcontract", supplierId: supplier.id, active: true });
  const warehouse = await stockService.createWarehouse({ name: "Huvudlager", active: true });
  const location = await stockService.createLocation({ warehouseId: warehouse.id, name: "A1", active: true });
  const c1 = await articleService.createArticle({ articleNumber: "C1", name: "Komponent 1", type: "purchased", unit: "st", defaultLocationId: location.id, active: true });
  const c2 = await articleService.createArticle({ articleNumber: "C2", name: "Komponent 2", type: "purchased", unit: "st", defaultLocationId: location.id, active: true });
  const phantom = await articleService.createArticle({ articleNumber: "F1", name: "Fantom", type: "manufactured", isPhantom: true, unit: "st", active: true });
  const parent = await articleService.createArticle({ articleNumber: "P1", name: "Produkt", type: "manufactured", unit: "st", defaultLocationId: location.id, active: true });
  const op10 = await mfgService.createRoutingOperation(parent.id, { sequenceNo: 10, workCenterId: r1.id, setupTime: 0, runTimePerUnit: 60 });
  await mfgService.createRoutingOperation(parent.id, { sequenceNo: 20, workCenterId: r2.id, setupTime: 0, runTimePerUnit: 60 });
  await articleService.addBomComponent(parent.id, { componentArticleId: c1.id, quantity: 2, routingOperationId: op10.id });
  await stockService.recordTransaction({ articleId: c1.id, locationId: location.id, quantityDelta: 100, transactionType: "inventory_adjustment" });
  const order = await mfgService.createManufacturingOrder({ articleId: parent.id, quantity: 10 }, user.id);
  const ops = await mfgService.listOperations(order.id);
  const [material] = await mfgService.listMaterialConsumptions(order.id);
  return {
    user,
    r1,
    r2,
    lego,
    supplier,
    location,
    c1,
    c2,
    phantom,
    parent,
    order,
    op10: ops.find((o) => o.sequenceNo === 10)!,
    op20: ops.find((o) => o.sequenceNo === 20)!,
    material: material!,
  };
}
type World = Awaited<ReturnType<typeof seedWorld>>;

async function employee() {
  return timeReportService.createEmployee({ employeeNumber: "107", name: "Urban", active: true });
}

// A live IO row buying the operation (lego) — inserted directly, the
// purchase service is not what is under test.
async function linkPurchaseRow(w: World, opId: string, status: "confirmed" | "cancelled" = "confirmed") {
  const [po] = await db
    .insert(purchaseOrders)
    .values({ orderNumber: `IO-${crypto.randomUUID().slice(0, 8)}`, supplierId: w.supplier.id, status })
    .returning();
  await db.insert(purchaseOrderRows).values({ purchaseOrderId: po!.id, articleId: w.parent.id, quantityOrdered: "10", unitPrice: "5", moOperationId: opId });
}
async function linkInquiryRow(w: World, opId: string) {
  const [rfq] = await db
    .insert(inquiries)
    .values({ inquiryNumber: `FO-${crypto.randomUUID().slice(0, 8)}`, supplierId: w.supplier.id, status: "sent" })
    .returning();
  await db.insert(inquiryRows).values({ inquiryId: rfq!.id, articleId: w.parent.id, quantity: "10", moOperationId: opId });
}

describe("status guard", () => {
  it("refuses every edit on an order that is not released/in progress (planned, done)", async () => {
    const w = await seedWorld();
    const planned = await insertPlannedManufacturingOrder({ articleId: w.parent.id, quantity: 1, createdBy: w.user.id });
    await expect(mfgService.addMaterial(planned.id, { componentArticleId: w.c2.id, quantity: 1 }, w.user.id)).rejects.toBeInstanceOf(ManufacturingOrderNotEditableError);
    await expect(
      mfgService.addOperation(planned.id, { sequenceNo: 30, workCenterId: w.r1.id, setupTime: 0, runTimePerUnit: 1 }, w.user.id)
    ).rejects.toBeInstanceOf(ManufacturingOrderNotEditableError);

    await mfgService.complete(w.order.id, {}, w.user.id);
    expect((await mfgService.getManufacturingOrder(w.order.id))!.status).toBe("done");
    await expect(mfgService.addMaterial(w.order.id, { componentArticleId: w.c2.id, quantity: 1 }, w.user.id)).rejects.toBeInstanceOf(ManufacturingOrderNotEditableError);
    await expect(mfgService.updateMaterial(w.order.id, w.material.id, { quantity: 1 }, w.user.id)).rejects.toBeInstanceOf(ManufacturingOrderNotEditableError);
    await expect(mfgService.removeMaterial(w.order.id, w.material.id, w.user.id)).rejects.toBeInstanceOf(ManufacturingOrderNotEditableError);
    await expect(
      mfgService.addOperation(w.order.id, { sequenceNo: 30, workCenterId: w.r1.id, setupTime: 0, runTimePerUnit: 1 }, w.user.id)
    ).rejects.toBeInstanceOf(ManufacturingOrderNotEditableError);
    await expect(mfgService.updateOperation(w.order.id, w.op10.id, { setupTime: 5 }, w.user.id)).rejects.toBeInstanceOf(ManufacturingOrderNotEditableError);
    await expect(mfgService.removeOperation(w.order.id, w.op10.id, w.user.id)).rejects.toBeInstanceOf(ManufacturingOrderNotEditableError);
  });

  it("answers 404-style errors for an unknown row/operation on the order", async () => {
    const w = await seedWorld();
    const other = await mfgService.createManufacturingOrder({ articleId: w.parent.id, quantity: 1 }, w.user.id);
    // Rows of another order are not found on this one.
    await expect(mfgService.updateMaterial(other.id, w.material.id, { quantity: 1 }, w.user.id)).rejects.toBeInstanceOf(MOMaterialConsumptionNotFoundError);
    await expect(mfgService.removeMaterial(other.id, w.material.id, w.user.id)).rejects.toBeInstanceOf(MOMaterialConsumptionNotFoundError);
    await expect(mfgService.updateOperation(other.id, w.op10.id, { setupTime: 1 }, w.user.id)).rejects.toBeInstanceOf(MOOperationNotFoundError);
    await expect(mfgService.removeOperation(other.id, w.op10.id, w.user.id)).rejects.toBeInstanceOf(MOOperationNotFoundError);
  });
});

describe("material", () => {
  it("adds a row in the component's base unit, linked to an operation, with a shortage warning", async () => {
    const w = await seedWorld();
    const { material, warnings } = await mfgService.addMaterial(w.order.id, { componentArticleId: w.c2.id, quantity: 3, moOperationId: w.op20.id }, w.user.id);
    expect(material).toMatchObject({
      componentArticleId: w.c2.id,
      componentArticleNumber: "C2",
      componentName: "Komponent 2",
      quantityPlanned: "3.0000",
      quantityConsumed: "0.0000",
      moOperationId: w.op20.id,
      unitId: null,
      unitFactor: null,
      unitCode: "st",
    });
    // Nothing of C2 in stock: the same text as the release's warning.
    expect(warnings).toEqual(["Komponent 2: behöver 3, tillgängligt 0"]);
    expect(await mfgService.listMaterialConsumptions(w.order.id)).toHaveLength(2);
    // The article's BOM is untouched.
    expect(await articleService.getBom(w.parent.id)).toHaveLength(1);
    expect(await auditRows("material_added")).toMatchObject([
      { entityId: w.order.orderNumber, detail: { articleNumber: "C2", quantityPlanned: 3, unitCode: "st", operationSequenceNo: 20, warnings } },
    ]);
  });

  it("converts an alternative unit like a BOM row and refuses a unit that is not the component's", async () => {
    const w = await seedWorld();
    // The units register is not truncated here — kg may exist from another suite.
    await db.insert(units).values({ code: "kg", name: "Kilogram" }).onConflictDoNothing();
    const [kg] = await db.select().from(units).where(eq(units.code, "kg"));
    // 1 st of C2 weighs 0.5 kg ⇒ quantity_per_base (kg per st) = 0.5; 4 kg = 8 st.
    await articleService.addArticleUnit(w.c2.id, { unitId: kg!.id, quantityPerBase: 0.5 });
    const { material } = await mfgService.addMaterial(w.order.id, { componentArticleId: w.c2.id, quantity: 4, unitId: kg!.id }, w.user.id);
    expect(material).toMatchObject({ quantityPlanned: "8.0000", unitId: kg!.id, unitFactor: "0.500000", unitCode: "kg" });

    // Quantity in the row's unit on PATCH: 2 kg = 4 st.
    const changed = await mfgService.updateMaterial(w.order.id, material.id, { quantity: 2 }, w.user.id);
    expect(changed.material.quantityPlanned).toBe("4.0000");
    // Back to the base unit: the quantity is then read in st.
    const base = await mfgService.updateMaterial(w.order.id, material.id, { quantity: 2, unitId: null }, w.user.id);
    expect(base.material).toMatchObject({ quantityPlanned: "2.0000", unitId: null, unitFactor: null, unitCode: "st" });

    // kg is not one of C1's units.
    await expect(mfgService.addMaterial(w.order.id, { componentArticleId: w.c1.id, quantity: 1, unitId: kg!.id, moOperationId: w.op20.id }, w.user.id)).rejects.toBeInstanceOf(
      InvalidUnitError
    );
  });

  it("refuses the order's own article, a phantom, a template and an operation of another order", async () => {
    const w = await seedWorld();
    await expect(mfgService.addMaterial(w.order.id, { componentArticleId: w.parent.id, quantity: 1 }, w.user.id)).rejects.toBeInstanceOf(MoMaterialOwnArticleError);
    await expect(mfgService.addMaterial(w.order.id, { componentArticleId: w.phantom.id, quantity: 1 }, w.user.id)).rejects.toBeInstanceOf(MoMaterialPhantomError);
    const other = await mfgService.createManufacturingOrder({ articleId: w.parent.id, quantity: 1 }, w.user.id);
    const [otherOp] = await mfgService.listOperations(other.id);
    await expect(mfgService.addMaterial(w.order.id, { componentArticleId: w.c2.id, quantity: 1, moOperationId: otherOp!.id }, w.user.id)).rejects.toBeInstanceOf(
      MoOperationNotOnOrderError
    );
    await expect(mfgService.updateMaterial(w.order.id, w.material.id, { moOperationId: otherOp!.id }, w.user.id)).rejects.toBeInstanceOf(MoOperationNotOnOrderError);
    // A template in mode variants.
    await db.execute(sql`insert into configurator_templates (article_id, mode) values (${w.c2.id}, 'variants')`);
    await expect(mfgService.addMaterial(w.order.id, { componentArticleId: w.c2.id, quantity: 1 }, w.user.id)).rejects.toBeInstanceOf(ArticleIsTemplateError);
    expect(await materialRows(w.order.id)).toHaveLength(1);
  });

  it("refuses a duplicate on the same operation (the unique constraint) — but allows the component on another operation", async () => {
    const w = await seedWorld();
    await expect(mfgService.addMaterial(w.order.id, { componentArticleId: w.c1.id, quantity: 1, moOperationId: w.op10.id }, w.user.id)).rejects.toBeInstanceOf(
      MoMaterialDuplicateError
    );
    const added = await mfgService.addMaterial(w.order.id, { componentArticleId: w.c1.id, quantity: 1, moOperationId: w.op20.id }, w.user.id);
    expect(added.material.moOperationId).toBe(w.op20.id);
    // Moving it onto op 10 collides too.
    await expect(mfgService.updateMaterial(w.order.id, added.material.id, { moOperationId: w.op10.id }, w.user.id)).rejects.toBeInstanceOf(MoMaterialDuplicateError);
    expect(await materialRows(w.order.id)).toHaveLength(2);
  });

  it("swaps the component only while nothing is consumed; the quantity may go below the consumed amount", async () => {
    const w = await seedWorld();
    const swapped = await mfgService.updateMaterial(w.order.id, w.material.id, { componentArticleId: w.c2.id }, w.user.id);
    expect(swapped.material).toMatchObject({ componentArticleId: w.c2.id, quantityPlanned: "20.0000", unitCode: "st" });
    expect(swapped.warnings).toEqual(["Komponent 2: behöver 20, tillgängligt 0"]);
    await mfgService.updateMaterial(w.order.id, w.material.id, { componentArticleId: w.c1.id }, w.user.id);

    // Report 5 OK on op 10 ⇒ 10 st of C1 drawn.
    await mfgService.reportOperationQuantities(w.op10.id, { quantityOk: 5, quantityScrapped: 0, markDone: false, createdBy: w.user.id });
    expect((await mfgService.listMaterialConsumptions(w.order.id))[0]!.quantityConsumed).toBe("10.0000");
    await expect(mfgService.updateMaterial(w.order.id, w.material.id, { componentArticleId: w.c2.id }, w.user.id)).rejects.toBeInstanceOf(MoMaterialConsumedError);
    await expect(mfgService.removeMaterial(w.order.id, w.material.id, w.user.id)).rejects.toBeInstanceOf(MoMaterialConsumedError);
    // Lower than consumed is allowed, and nothing is returned to stock.
    const lowered = await mfgService.updateMaterial(w.order.id, w.material.id, { quantity: 5 }, w.user.id);
    expect(lowered.material).toMatchObject({ quantityPlanned: "5.0000", quantityConsumed: "10.0000" });
    expect(lowered.warnings).toEqual([]);
    expect(await stockOf(w.c1.id)).toBe(90);
    expect(await auditRows("material_changed")).toMatchObject([
      { detail: { articleNumber: "C2", before: { articleNumber: "C1" }, after: { articleNumber: "C2" } } },
      { detail: { before: { articleNumber: "C2" }, after: { articleNumber: "C1" } } },
      { detail: { articleNumber: "C1", before: { quantityPlanned: 20 }, after: { quantityPlanned: 5 } } },
    ]);
  });

  it("applies the top-up rule to the changed quantity on the next report, without specialcasing", async () => {
    const w = await seedWorld();
    // 2/st × 10 = 20 planned. 5 OK ⇒ 10 consumed.
    await mfgService.reportOperationQuantities(w.op10.id, { quantityOk: 5, quantityScrapped: 0, markDone: false, createdBy: w.user.id });
    // Raised to 4/st (40 for the order). Warning: 90 in stock covers it.
    const raised = await mfgService.updateMaterial(w.order.id, w.material.id, { quantity: 40 }, w.user.id);
    expect(raised.warnings).toEqual([]);
    // Another 5 OK ⇒ target 4 × 10 = 40, already 10 ⇒ 30 more drawn.
    await mfgService.reportOperationQuantities(w.op10.id, { quantityOk: 5, quantityScrapped: 0, markDone: true, createdBy: w.user.id });
    expect((await mfgService.listMaterialConsumptions(w.order.id))[0]!.quantityConsumed).toBe("40.0000");
    expect(await stockOf(w.c1.id)).toBe(60);
    // Lowered below what is consumed: the next report draws nothing more.
    await mfgService.updateMaterial(w.order.id, w.material.id, { quantity: 10 }, w.user.id);
    await mfgService.reportOperationQuantities(w.op10.id, { quantityOk: 2, quantityScrapped: 0, markDone: false, createdBy: w.user.id });
    expect((await mfgService.listMaterialConsumptions(w.order.id))[0]!.quantityConsumed).toBe("40.0000");
    expect(await stockOf(w.c1.id)).toBe(60);
  });

  it("moves a row to another operation (or unlinks it) — only future draws follow", async () => {
    const w = await seedWorld();
    const moved = await mfgService.updateMaterial(w.order.id, w.material.id, { moOperationId: null }, w.user.id);
    expect(moved.material.moOperationId).toBeNull();
    // Op 10 reported: nothing drawn, the row is drawn at receipt.
    await mfgService.reportOperationQuantities(w.op10.id, { quantityOk: 10, quantityScrapped: 0, markDone: true, createdBy: w.user.id });
    expect(await stockOf(w.c1.id)).toBe(100);
    await mfgService.reportOperationQuantities(w.op20.id, { quantityOk: 10, quantityScrapped: 0, markDone: true, createdBy: w.user.id });
    expect(await stockOf(w.c1.id)).toBe(80);
  });

  it("removes an untouched row and logs it", async () => {
    const w = await seedWorld();
    await mfgService.removeMaterial(w.order.id, w.material.id, w.user.id);
    expect(await materialRows(w.order.id)).toEqual([]);
    expect(await auditRows("material_removed")).toMatchObject([{ detail: { articleNumber: "C1", quantityPlanned: 20, operationSequenceNo: 10 } }]);
  });
});

describe("operations", () => {
  it("adds a pending operation, plans the order again and answers the list row shape", async () => {
    const w = await seedWorld();
    const { operation, warnings } = await mfgService.addOperation(
      w.order.id,
      { sequenceNo: 30, workCenterId: w.r1.id, setupTime: 30, runTimePerUnit: 60, description: "Efterkontroll", printOnWorkCard: true, comment: "Kolla" },
      w.user.id
    );
    expect(operation).toMatchObject({
      sequenceNo: 30,
      status: "pending",
      routingOperationId: null,
      workCenterId: w.r1.id,
      workCenterCode: "101",
      workCenterName: "Kap",
      workCenterType: "machine",
      setupTime: "30.00",
      runTimePerUnit: "60.0000",
      description: "Efterkontroll",
      printOnWorkCard: true,
      comment: "Kolla",
      subcontractSupplierName: null,
      planLocked: false,
    });
    expect(warnings).toEqual([]);
    // 10 h on R1 (op 10) in W1, op 20 10 h on R2 in W1, the new op 10.5 h on R1 after op 20 — still W1.
    expect(operation.plannedStartWeek).toBe(W1);
    expect(await planRows(operation.id)).toEqual([{ monday: W1, minutes: 630 }]);
    expect(await mfgService.listOperations(w.order.id)).toHaveLength(3);
    // The article's routing is untouched.
    expect(await mfgService.listRoutingOperations(w.parent.id)).toHaveLength(2);
    expect(await auditRows("operation_added")).toMatchObject([{ detail: { sequenceNo: 30, workCenterCode: "101", setupTime: 30, runTimePerUnit: 60 } }]);
  });

  it("refuses a taken sequence number and the beredning's lego rule, and defaults the lego supplier", async () => {
    const w = await seedWorld();
    await expect(mfgService.addOperation(w.order.id, { sequenceNo: 10, workCenterId: w.r1.id, setupTime: 0, runTimePerUnit: 1 }, w.user.id)).rejects.toBeInstanceOf(
      MoOperationSequenceTakenError
    );
    await expect(
      mfgService.addOperation(w.order.id, { sequenceNo: 30, workCenterId: w.r1.id, setupTime: 0, runTimePerUnit: 1, unitPrice: 5 }, w.user.id)
    ).rejects.toBeInstanceOf(NotSubcontractOperationError);
    await expect(mfgService.updateOperation(w.order.id, w.op10.id, { setupPrice: 100 }, w.user.id)).rejects.toBeInstanceOf(NotSubcontractOperationError);
    const { operation } = await mfgService.addOperation(w.order.id, { sequenceNo: 30, workCenterId: w.lego.id, setupTime: 0, runTimePerUnit: 0, unitPrice: 12.5 }, w.user.id);
    expect(operation).toMatchObject({ workCenterType: "subcontract", subcontractSupplierId: w.supplier.id, subcontractSupplierName: "Lego AB", unitPrice: "12.5000" });
    // Lego: no plan.
    expect(operation.plannedStartWeek).toBeNull();
    await expect(mfgService.updateOperation(w.order.id, w.op20.id, { sequenceNo: 30 }, w.user.id)).rejects.toBeInstanceOf(MoOperationSequenceTakenError);
  });

  it("changes times and texts on a pending operation (also after reports), replans only on time/resource/sequence", async () => {
    const w = await seedWorld();
    await mfgService.reportOperationQuantities(w.op10.id, { quantityOk: 2, quantityScrapped: 0, markDone: false, createdBy: w.user.id });
    const before = await opRow(w.op10.id);
    // Texts only: no replan — planned_at is untouched.
    const texts = await mfgService.updateOperation(w.order.id, w.op10.id, { description: "Kapning", comment: null }, w.user.id);
    expect(texts.operation).toMatchObject({ description: "Kapning", comment: null, quantityCompleted: "2.0000" });
    expect(texts.warnings).toEqual([]);
    expect((await opRow(w.op10.id))!.plannedAt?.getTime()).toBe(before!.plannedAt?.getTime());
    // 60 → 300 min/st: 8 st remain ⇒ 40 h, started ⇒ from this week; R1 has 40 h in W1 minus nothing else.
    const times = await mfgService.updateOperation(w.order.id, w.op10.id, { runTimePerUnit: 300 }, w.user.id);
    expect(times.operation.runTimePerUnit).toBe("300.0000");
    expect(await planRows(w.op10.id)).toEqual([{ monday: W1, minutes: 2400 }]);
    // Op 20 follows into W2 (R1 full in W1 ⇒ op 10 ends W1; op 20 needs 10 h on R2, W1 has room — it ends the same week).
    expect((await opRow(w.op20.id))!.plannedStartWeek).toBe(W1);
    expect((await opRow(w.op10.id))!.plannedAt!.getTime()).toBeGreaterThan(before!.plannedAt!.getTime());
    expect(await auditRows("operation_changed")).toMatchObject([
      { detail: { sequenceNo: 10, workCenterCode: "101", before: { description: null }, after: { description: "Kapning" } } },
      { detail: { before: { runTimePerUnit: 60 }, after: { runTimePerUnit: 300 } } },
    ]);
  });

  it("warns for orimligt mycket tid when a changed time crosses the limit", async () => {
    const w = await seedWorld();
    await db.insert(systemSettings).values({ key: "planning_long_operation_weeks", value: "1" });
    const { warnings } = await mfgService.updateOperation(w.order.id, w.op20.id, { runTimePerUnit: 600 }, w.user.id);
    expect(warnings).toEqual([expect.stringContaining("Op 20 på 201 (P1 Produkt) har orimligt mycket tid: 100 h kvar")]);
    // Planned anyway, over W1–W3.
    expect((await opRow(w.op20.id))!.plannedStartWeek).toBe(W1);
    expect((await planRows(w.op20.id)).reduce((s, r) => s + r.minutes, 0)).toBe(6000);
  });

  it("refuses to change a done operation", async () => {
    const w = await seedWorld();
    await mfgService.reportOperationQuantities(w.op10.id, { quantityOk: 10, quantityScrapped: 0, markDone: true, createdBy: w.user.id });
    await expect(mfgService.updateOperation(w.order.id, w.op10.id, { description: "x" }, w.user.id)).rejects.toBeInstanceOf(MoOperationDoneError);
    await expect(mfgService.removeOperation(w.order.id, w.op10.id, w.user.id)).rejects.toBeInstanceOf(MoOperationDoneError);
  });

  it("refuses a resource change while someone is stamped in (open or paused), and after a purchase row points at it", async () => {
    const w = await seedWorld();
    const worker = await employee();
    // Stamping in on work opens the attendance too (regel 5).
    const session = await timeReportService.stampIn({ employeeId: worker.id, moOperationId: w.op10.id }, w.user.id);
    await expect(mfgService.updateOperation(w.order.id, w.op10.id, { workCenterId: w.r2.id }, w.user.id)).rejects.toBeInstanceOf(MoOperationStampedError);
    // Paused (Gå hem) is still stamped.
    const attendance = await timeReportRepository.findOpenAttendanceSession(worker.id);
    await timeReportService.attendanceOut(attendance!.id, w.user.id);
    await expect(mfgService.updateOperation(w.order.id, w.op10.id, { workCenterId: w.r2.id }, w.user.id)).rejects.toBeInstanceOf(MoOperationStampedError);
    // The times may still change.
    await mfgService.updateOperation(w.order.id, w.op10.id, { setupTime: 15 }, w.user.id);
    await timeReportService.attendanceIn({ employeeId: worker.id }, w.user.id);
    await timeReportService.stampOut(session.id, {}, w.user.id);
    // Stamped out: a resource change among own resources is fine.
    const moved = await mfgService.updateOperation(w.order.id, w.op10.id, { workCenterId: w.r2.id }, w.user.id);
    expect(moved.operation.workCenterCode).toBe("201");

    await linkPurchaseRow(w, w.op20.id, "cancelled");
    await mfgService.updateOperation(w.order.id, w.op20.id, { workCenterId: w.r1.id }, w.user.id);
    await linkPurchaseRow(w, w.op20.id);
    await expect(mfgService.updateOperation(w.order.id, w.op20.id, { workCenterId: w.r2.id }, w.user.id)).rejects.toBeInstanceOf(MoOperationLinkedPurchaseError);
    await expect(mfgService.removeOperation(w.order.id, w.op20.id, w.user.id)).rejects.toBeInstanceOf(MoOperationLinkedPurchaseError);
    const { operation } = await mfgService.addOperation(w.order.id, { sequenceNo: 30, workCenterId: w.r1.id, setupTime: 0, runTimePerUnit: 1 }, w.user.id);
    await linkInquiryRow(w, operation.id);
    await expect(mfgService.updateOperation(w.order.id, operation.id, { workCenterId: w.r2.id }, w.user.id)).rejects.toBeInstanceOf(MoOperationLinkedPurchaseError);
  });

  it("refuses lego ↔ own once something is reported, allows it before, and clears lego fields on the way back", async () => {
    const w = await seedWorld();
    // Untouched: own → lego, supplier from the body, prices allowed.
    const toLego = await mfgService.updateOperation(w.order.id, w.op20.id, { workCenterId: w.lego.id, subcontractSupplierId: w.supplier.id, unitPrice: 9 }, w.user.id);
    expect(toLego.operation).toMatchObject({ workCenterType: "subcontract", unitPrice: "9.0000", plannedStartWeek: null });
    // Back to own: lego fields cleared.
    const back = await mfgService.updateOperation(w.order.id, w.op20.id, { workCenterId: w.r2.id }, w.user.id);
    expect(back.operation).toMatchObject({ workCenterType: "machine", subcontractSupplierId: null, unitPrice: null, setupPrice: null, showNetWeight: false });
    expect(back.operation.plannedStartWeek).toBe(W1);
    // A time-only stamp counts as reported.
    const worker = await employee();
    const session = await timeReportService.stampIn({ employeeId: worker.id, moOperationId: w.op20.id }, w.user.id);
    await timeReportService.stampOut(session.id, {}, w.user.id);
    await expect(mfgService.updateOperation(w.order.id, w.op20.id, { workCenterId: w.lego.id }, w.user.id)).rejects.toBeInstanceOf(MoOperationReportedError);
    // Own → own is still fine.
    await mfgService.updateOperation(w.order.id, w.op20.id, { workCenterId: w.r1.id }, w.user.id);
  });

  it("releases the lock when a locked operation changes resource, keeps it on a time change", async () => {
    const w = await seedWorld();
    await planningService.moveOperation(w.op20.id, { weekMonday: W2, moveFollowing: true }, w.user.id);
    expect(await opRow(w.op20.id)).toMatchObject({ planLocked: true, plannedStartWeek: W2 });
    // Time change: the lock and the weeks stay as booked — the remaining
    // time is spread backwards over them at read time (operationLoadWeeks).
    await mfgService.updateOperation(w.order.id, w.op20.id, { runTimePerUnit: 120 }, w.user.id);
    expect(await opRow(w.op20.id)).toMatchObject({ planLocked: true, plannedStartWeek: W2, plannedEndWeek: W2 });
    expect((await planRows(w.op20.id)).map((r) => r.monday)).toEqual([W2]);
    // Resource change: unlocked and replanned on free capacity — this week.
    const moved = await mfgService.updateOperation(w.order.id, w.op20.id, { workCenterId: w.r1.id }, w.user.id);
    expect(moved.operation).toMatchObject({ planLocked: false, plannedStartWeek: W1, workCenterCode: "101" });
  });

  it("removes an untouched operation, unlinks its material (drawn at receipt) and replans", async () => {
    const w = await seedWorld();
    const removed = await mfgService.removeOperation(w.order.id, w.op10.id, w.user.id);
    expect(removed).toEqual({ warnings: [], unlinkedMaterials: 1 });
    expect((await materialRows(w.order.id))[0]!.moOperationId).toBeNull();
    expect(await mfgService.listOperations(w.order.id)).toHaveLength(1);
    expect(await planRows(w.op10.id)).toEqual([]);
    // Op 20 is now the only — and last — operation: its OK is finished goods
    // and the unlinked material follows the receipt.
    await mfgService.reportOperationQuantities(w.op20.id, { quantityOk: 10, quantityScrapped: 0, markDone: true, createdBy: w.user.id });
    expect(await stockOf(w.c1.id)).toBe(80);
    expect(await stockOf(w.parent.id)).toBe(10);
    expect((await mfgService.getManufacturingOrder(w.order.id))!.status).toBe("done");
    expect(await auditRows("operation_removed")).toMatchObject([{ detail: { sequenceNo: 10, workCenterCode: "101", unlinkedMaterials: 1 } }]);
  });

  it("refuses to remove an operation that has ever had anything — even an undone report", async () => {
    const w = await seedWorld();
    await mfgService.reportOperationQuantities(w.op10.id, { quantityOk: 1, quantityScrapped: 0, markDone: false, createdBy: w.user.id });
    const [report] = await mfgService.listReports(w.order.id);
    await mfgService.undoReport(w.order.id, report!.id, w.user.id);
    expect((await opRow(w.op10.id))!.quantityCompleted).toBe("0.0000");
    await expect(mfgService.removeOperation(w.order.id, w.op10.id, w.user.id)).rejects.toBeInstanceOf(MoOperationReportedError);
  });

  it("locks which operation is last once finished goods were received", async () => {
    const w = await seedWorld();
    // Not received yet: a new last operation is fine, and it becomes the one whose OK is goods.
    await mfgService.addOperation(w.order.id, { sequenceNo: 30, workCenterId: w.r1.id, setupTime: 0, runTimePerUnit: 1 }, w.user.id);
    await mfgService.reportOperationQuantities(w.op20.id, { quantityOk: 10, quantityScrapped: 0, markDone: true, createdBy: w.user.id });
    expect(await stockOf(w.parent.id)).toBe(0);
    const [op30] = (await mfgService.listOperations(w.order.id)).filter((o) => o.sequenceNo === 30);
    // Partial receipt from op 30.
    await mfgService.reportOperationQuantities(op30!.id, { quantityOk: 4, quantityScrapped: 0, markDone: false, createdBy: w.user.id });
    expect(await stockOf(w.parent.id)).toBe(4);
    await expect(mfgService.addOperation(w.order.id, { sequenceNo: 40, workCenterId: w.r1.id, setupTime: 0, runTimePerUnit: 1 }, w.user.id)).rejects.toBeInstanceOf(
      LastOperationLockedError
    );
    await expect(mfgService.updateOperation(w.order.id, w.op10.id, { sequenceNo: 35 }, w.user.id)).rejects.toBeInstanceOf(LastOperationLockedError);
    await expect(mfgService.updateOperation(w.order.id, op30!.id, { sequenceNo: 15 }, w.user.id)).rejects.toBeInstanceOf(LastOperationLockedError);
    // The last operation always has the receipt's report, so its removal is
    // refused as reported before the lock is even looked at.
    await expect(mfgService.removeOperation(w.order.id, op30!.id, w.user.id)).rejects.toBeInstanceOf(MoOperationReportedError);
    // Renumbering that keeps op 30 last, and an operation before it, are fine.
    await mfgService.updateOperation(w.order.id, w.op10.id, { sequenceNo: 5 }, w.user.id);
    await mfgService.updateOperation(w.order.id, op30!.id, { sequenceNo: 25 }, w.user.id);
    await mfgService.addOperation(w.order.id, { sequenceNo: 22, workCenterId: w.r1.id, setupTime: 0, runTimePerUnit: 1 }, w.user.id);
  });

  it("logs every change on the order's händelselogg", async () => {
    const w = await seedWorld();
    await mfgService.addMaterial(w.order.id, { componentArticleId: w.c2.id, quantity: 1 }, w.user.id);
    await mfgService.updateMaterial(w.order.id, w.material.id, { quantity: 30 }, w.user.id);
    await mfgService.removeMaterial(w.order.id, w.material.id, w.user.id);
    const { operation } = await mfgService.addOperation(w.order.id, { sequenceNo: 30, workCenterId: w.r1.id, setupTime: 0, runTimePerUnit: 1 }, w.user.id);
    await mfgService.updateOperation(w.order.id, operation.id, { setupTime: 5, workCenterId: w.r2.id }, w.user.id);
    await mfgService.removeOperation(w.order.id, operation.id, w.user.id);
    const rows = await db.select().from(auditLog).where(eq(auditLog.entityType, "manufacturing_order")).orderBy(auditLog.createdAt);
    expect(rows.map((r) => r.action)).toEqual([
      "released",
      "material_added",
      "material_changed",
      "material_removed",
      "operation_added",
      "operation_changed",
      "operation_removed",
    ]);
    expect(rows.every((r) => r.entityId === w.order.orderNumber && r.userId === w.user.id)).toBe(true);
    expect(rows[5]!.detail).toMatchObject({
      sequenceNo: 30,
      workCenterCode: "201",
      before: { setupTime: 0, workCenterCode: "101" },
      after: { setupTime: 5, workCenterCode: "201" },
    });
  });
});

describe("concurrency", () => {
  it("a report and an operation edit on the same order never deadlock", { timeout: 60_000 }, async () => {
    const w = await seedWorld();
    for (let i = 0; i < 6; i++) {
      await Promise.all([
        mfgService.reportOperationQuantities(w.op10.id, { quantityOk: 1, quantityScrapped: 0, markDone: false, createdBy: w.user.id }),
        mfgService.updateOperation(w.order.id, w.op20.id, { runTimePerUnit: 60 + i }, w.user.id),
        mfgService.addMaterial(w.order.id, { componentArticleId: w.c2.id, quantity: 1 + i, moOperationId: w.op20.id }, w.user.id).then(
          (r) => mfgService.removeMaterial(w.order.id, r.material.id, w.user.id)
        ),
      ]);
    }
    expect((await opRow(w.op10.id))!.quantityCompleted).toBe("6.0000");
    expect((await opRow(w.op20.id))!.runTimePerUnit).toBe("65.0000");
    expect((await mfgService.listMaterialConsumptions(w.order.id))[0]!.quantityConsumed).toBe("12.0000");
  });
});

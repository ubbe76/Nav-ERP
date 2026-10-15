import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { auditLog, db, stockTransactions, weekSchedules } from "@navet/db";
import { completeManufacturingOrderSchema } from "@navet/shared";
import { testArticleService, testDocumentPdfService } from "./helpers/services.js";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService, CostingOnlyOperationLinkError } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import {
  createManufacturingService,
  DuplicateProductionGroupCodeError,
  DuplicateSequenceNoError,
  DuplicateWorkCenterCodeError,
  InvalidStatusTransitionError,
  ManufacturingOrderHasReportsError,
  ManufacturingOrderNotFoundError,
  OperationHasLinkedMaterialError,
  OverConsumptionError,
  ProductionGroupNotFoundError,
  RoutingOperationNotFoundError,
  WeekScheduleNotFoundError,
  WorkCenterNotFoundError,
} from "../src/modules/manufacturing/service/manufacturing.service.js";
import { PDFDocument } from "pdf-lib";
import { pdfText, pdfTextRuns } from "./helpers/pdf.js";
import { insertPlannedManufacturingOrder } from "./helpers/planned-manufacturing-order.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { createStockCountRepository } from "../src/modules/stock/repository/stock-count.repository.js";
import { createStockService, LocationUnderStockCountError } from "../src/modules/stock/service/stock.service.js";
import { createSalesRepository } from "../src/modules/sales/repository/sales.repository.js";
import { markSalesOrderInProduction } from "../src/modules/sales/service/production-transition.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";

const articleService = createArticleService(createArticleRepository(db));
const stockService = createStockService(createStockRepository(db));
const stockCountRepo = createStockCountRepository(db);
const authRepo = createAuthRepository(db);
const auditRepository = createAuditRepository(db);
// E3: the real cross-module reader, wired exactly like app.ts — these tests
// never set salesOrderRowId, so it's never exercised, but the factory now
// requires it.
const salesRepository = createSalesRepository(db);
const mfgService = createManufacturingService(
  createManufacturingRepository(db),
  testDocumentPdfService,
  testArticleService,
  {
    findRowForManufacturing: salesRepository.findRowForManufacturing,
    lockRowForManufacturing: salesRepository.lockRowForManufacturing,
    markInProduction: markSalesOrderInProduction,
  },
  auditRepository
);

const TRUNCATE = sql`TRUNCATE mo_material_consumptions, mo_operations, manufacturing_orders, routing_operations, work_centers, production_groups, stock_transactions, stock_locations, warehouses, bom_components, articles, audit_log, users CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
});

afterAll(async () => {
  await db.execute(TRUNCATE);
});

async function auditRows(entityType: string, action: string) {
  return db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.entityType, entityType), eq(auditLog.action, action)));
}

// Bypasses authService.register (bootstrap-only, one admin) since these
// tests only need a valid user id for createdBy — not auth policy itself.
async function makeUser() {
  return authRepo.create({
    email: `mfg-${crypto.randomUUID()}@example.com`,
    passwordHash: "not-a-real-hash",
    name: "Producer",
    role: "admin",
  });
}

async function makeLocation() {
  const warehouse = await stockService.createWarehouse({ name: "Huvudlager", active: true });
  return stockService.createLocation({ warehouseId: warehouse.id, name: "A1", active: true });
}

async function seedStock(articleId: string, locationId: string, quantity: number) {
  await stockService.recordTransaction({
    articleId,
    locationId,
    quantityDelta: quantity,
    transactionType: "inventory_adjustment",
  });
}

async function makeComponentArticle() {
  return articleService.createArticle({
    articleNumber: `COMP-${crypto.randomUUID()}`,
    name: "Component",
    type: "purchased",
    unit: "st",
    active: true,
  });
}

async function makeParentWithBom(componentQtyPerParent = 2) {
  const parent = await articleService.createArticle({
    articleNumber: `PARENT-${crypto.randomUUID()}`,
    name: "Parent",
    type: "manufactured",
    unit: "st",
    active: true,
  });
  const component = await articleService.createArticle({
    articleNumber: `COMP-${crypto.randomUUID()}`,
    name: "Component",
    type: "purchased",
    unit: "st",
    active: true,
  });
  await articleService.addBomComponent(parent.id, { componentArticleId: component.id, quantity: componentQtyPerParent });
  return { parent, component };
}

// A TO still in planned (an older order — new ones are released at
// creation), so the tests can edit the routing before Släpp.
async function makeMO(moQuantity = 5) {
  const user = await makeUser();
  const { parent, component } = await makeParentWithBom(2);
  const location = await makeLocation();
  const order = await insertPlannedManufacturingOrder({ articleId: parent.id, quantity: moQuantity, createdBy: user.id });
  return { user, parent, component, location, order };
}

// A new TO is released in the same transaction that creates it, so it can be
// stamped in the terminal straight away — no separate Släpp step.
describe("manufacturing service — release at creation", () => {
  it("creates the order released, with BOM and routing snapshotted, shortage warnings and a released audit row", async () => {
    const user = await makeUser();
    const { parent, component } = await makeParentWithBom(2);
    const workCenter = await mfgService.createWorkCenter({ code: "100", name: "Svets", active: true });
    await mfgService.createRoutingOperation(parent.id, { sequenceNo: 10, workCenterId: workCenter.id, setupTime: 10, runTimePerUnit: 2 });

    const order = await mfgService.createManufacturingOrder({ articleId: parent.id, quantity: 5 }, user.id);

    expect(order.status).toBe("released");
    expect(order.releaseWarnings).toHaveLength(1); // no stock for 2 × 5 components
    const materials = await mfgService.listMaterialConsumptions(order.id);
    expect(materials.map((m) => [m.componentArticleId, m.quantityPlanned])).toEqual([[component.id, "10.0000"]]);
    const operations = await mfgService.listOperations(order.id);
    expect(operations.map((op) => [op.sequenceNo, op.status])).toEqual([[10, "pending"]]);
    const released = await auditRows("manufacturing_order", "released");
    expect(released.map((r) => [r.entityId, r.userId])).toEqual([[order.orderNumber, user.id]]);
  });

  it("has no release warnings when stock covers the need", async () => {
    const user = await makeUser();
    const { parent, component } = await makeParentWithBom(2);
    const location = await makeLocation();
    await seedStock(component.id, location.id, 100);

    const order = await mfgService.createManufacturingOrder({ articleId: parent.id, quantity: 5 }, user.id);
    expect(order.releaseWarnings).toEqual([]);
  });

  it("refuses a second release of a new order", async () => {
    const user = await makeUser();
    const { parent } = await makeParentWithBom(2);
    const order = await mfgService.createManufacturingOrder({ articleId: parent.id, quantity: 5 }, user.id);
    await expect(mfgService.release(order.id)).rejects.toThrow(InvalidStatusTransitionError);
  });
});

describe("manufacturing service — release", () => {
  it("snapshots BOM x MO quantity into material consumption and Routing into operations", async () => {
    const { order, component, parent, user } = await makeMO(5);
    const workCenter = await mfgService.createWorkCenter({ code: "100", name: "Svets", active: true });
    await mfgService.createRoutingOperation(parent.id, { sequenceNo: 1, workCenterId: workCenter.id, setupTime: 10, runTimePerUnit: 2 });
    void user;

    const { order: released } = await mfgService.release(order.id);
    expect(released.status).toBe("released");

    const materials = await mfgService.listMaterialConsumptions(order.id);
    expect(materials).toHaveLength(1);
    expect(materials[0]?.componentArticleId).toBe(component.id);
    expect(materials[0]?.quantityPlanned).toBe("10.0000"); // 2 per unit x 5 units

    const operations = await mfgService.listOperations(order.id);
    expect(operations).toHaveLength(1);
    expect(operations[0]?.workCenterId).toBe(workCenter.id);
    expect(operations[0]?.status).toBe("pending");
  });

  it("snapshots the operation's Beskrivning so later routing edits do not reach a released order", async () => {
    const { order, parent } = await makeMO(5);
    const workCenter = await mfgService.createWorkCenter({ code: "100", name: "Svets", active: true });
    const op = await mfgService.createRoutingOperation(parent.id, {
      sequenceNo: 1,
      workCenterId: workCenter.id,
      setupTime: 10,
      runTimePerUnit: 2,
      description: "Kapning",
    });

    await mfgService.release(order.id);
    const operations = await mfgService.listOperations(order.id);
    expect(operations[0]?.description).toBe("Kapning");
    // The resource code rides along — the work card prints it beside the
    // description now that the resource NAME has given up the column.
    expect(operations[0]?.workCenterCode).toBe("100");

    await mfgService.updateRoutingOperation(parent.id, op.id, { description: "Ny beskrivning" });
    const after = await mfgService.listOperations(order.id);
    expect(after[0]?.description).toBe("Kapning");
  });

  it("snapshots the operation's Kommentar so later routing edits do not reach a released order", async () => {
    const { order, parent } = await makeMO(5);
    const workCenter = await mfgService.createWorkCenter({ code: "100", name: "Svets", active: true });
    const op = await mfgService.createRoutingOperation(parent.id, {
      sequenceNo: 1,
      workCenterId: workCenter.id,
      setupTime: 10,
      runTimePerUnit: 2,
      comment: "Kör med skyddsglasögon",
      printOnWorkCard: true,
    });

    await mfgService.release(order.id);
    const operations = await mfgService.listOperations(order.id);
    expect(operations[0]?.comment).toBe("Kör med skyddsglasögon");
    expect(operations[0]?.printOnWorkCard).toBe(true);

    // Same rule as the times: the work card shows what applied at release.
    await mfgService.updateRoutingOperation(parent.id, op.id, { comment: "Ny text", printOnWorkCard: false });
    const after = await mfgService.listOperations(order.id);
    expect(after[0]?.comment).toBe("Kör med skyddsglasögon");
    expect(after[0]?.printOnWorkCard).toBe(true);
  });

  it("snapshots the operation's Packinstruktion so later routing edits do not reach a released order", async () => {
    const { order, parent } = await makeMO(5);
    const workCenter = await mfgService.createWorkCenter({ code: "100", name: "Svets", active: true });
    const op = await mfgService.createRoutingOperation(parent.id, {
      sequenceNo: 1,
      workCenterId: workCenter.id,
      setupTime: 10,
      runTimePerUnit: 2,
      packingInstructions: "Packa i EU-pall med hörnskydd",
    });

    await mfgService.release(order.id);
    const operations = await mfgService.listOperations(order.id);
    expect(operations[0]?.packingInstructions).toBe("Packa i EU-pall med hörnskydd");

    // Same rule as the comment/times: the work card shows what applied at
    // release. Always printed, independent of printOnWorkCard.
    await mfgService.updateRoutingOperation(parent.id, op.id, { packingInstructions: "Ny text" });
    const after = await mfgService.listOperations(order.id);
    expect(after[0]?.packingInstructions).toBe("Packa i EU-pall med hörnskydd");
  });

  it("stores and returns a st/h operation as minutes, snapshots the unit at release, and lets it be flipped by PATCH", async () => {
    const { order, parent } = await makeMO(5);
    const workCenter = await mfgService.createWorkCenter({ code: "100", name: "Svets", active: true });
    // Canonical storage is always minutes — the API accepts/returns
    // runTimePerUnit in minutes regardless of timeUnit (decision 1).
    const created = await mfgService.createRoutingOperation(parent.id, {
      sequenceNo: 1,
      workCenterId: workCenter.id,
      setupTime: 10,
      runTimePerUnit: 8.5714,
      timeUnit: "units_per_hour",
    });
    expect(created.timeUnit).toBe("units_per_hour");
    expect(Number(created.runTimePerUnit)).toBeCloseTo(8.5714, 4);

    const routing = await mfgService.listRoutingOperations(parent.id);
    expect(routing[0]?.timeUnit).toBe("units_per_hour");

    await mfgService.release(order.id);
    const operations = await mfgService.listOperations(order.id);
    expect(operations[0]?.timeUnit).toBe("units_per_hour");
    expect(Number(operations[0]?.runTimePerUnit)).toBeCloseTo(8.5714, 4);

    // PATCH can flip it back to the default minutes display.
    const updated = await mfgService.updateRoutingOperation(parent.id, created.id, {
      timeUnit: "minutes_per_unit",
    });
    expect(updated.timeUnit).toBe("minutes_per_unit");
    // The stored minutes value itself is untouched by the flag flip — the
    // conversion is a client-side concern (decision 1: pure presentation).
    expect(Number(updated.runTimePerUnit)).toBeCloseTo(8.5714, 4);
  });

  it("defaults a plain operation's time unit to minutes_per_unit", async () => {
    const { parent } = await makeMO(5);
    const workCenter = await mfgService.createWorkCenter({ code: "100", name: "Svets", active: true });
    const created = await mfgService.createRoutingOperation(parent.id, {
      sequenceNo: 1,
      workCenterId: workCenter.id,
      setupTime: 10,
      runTimePerUnit: 2,
    });
    expect(created.timeUnit).toBe("minutes_per_unit");
  });

  it("leaves a Kalkyl operation out of the snapshot so it never reaches the MO", async () => {
    const { order, parent } = await makeMO(5);
    const workCenter = await mfgService.createWorkCenter({ code: "100", name: "Svets", active: true });
    await mfgService.createRoutingOperation(parent.id, { sequenceNo: 1, workCenterId: workCenter.id, setupTime: 10, runTimePerUnit: 2 });
    await mfgService.createRoutingOperation(parent.id, {
      sequenceNo: 2,
      workCenterId: workCenter.id,
      setupTime: 5,
      runTimePerUnit: 1,
      costingOnly: true,
    });

    await mfgService.release(order.id);

    // Excluding it here is what keeps it off the terminal, the capacity view,
    // the post-calculation and the MO printout — they all read mo_operations.
    const operations = await mfgService.listOperations(order.id);
    expect(operations.map((op) => op.sequenceNo)).toEqual([1]);
  });

  it("returns released operations ordered by sequence number regardless of insertion order", async () => {
    // P5: the routing is created out of order (30, 10, 20) — listOperations
    // must sort by sequence_no, not by insertion/creation order.
    const { order, parent } = await makeMO(5);
    const workCenter = await mfgService.createWorkCenter({ code: "100", name: "Svets", active: true });
    await mfgService.createRoutingOperation(parent.id, { sequenceNo: 30, workCenterId: workCenter.id, setupTime: 10, runTimePerUnit: 2 });
    await mfgService.createRoutingOperation(parent.id, { sequenceNo: 10, workCenterId: workCenter.id, setupTime: 5, runTimePerUnit: 1 });
    await mfgService.createRoutingOperation(parent.id, { sequenceNo: 20, workCenterId: workCenter.id, setupTime: 3, runTimePerUnit: 1 });

    await mfgService.release(order.id);

    const operations = await mfgService.listOperations(order.id);
    expect(operations.map((op) => op.sequenceNo)).toEqual([10, 20, 30]);
  });

  it("releases with no operations at all when the whole routing is Kalkyl", async () => {
    const { order, parent } = await makeMO(5);
    const workCenter = await mfgService.createWorkCenter({ code: "100", name: "Svets", active: true });
    await mfgService.createRoutingOperation(parent.id, {
      sequenceNo: 1,
      workCenterId: workCenter.id,
      setupTime: 10,
      runTimePerUnit: 2,
      costingOnly: true,
    });

    const { order: released } = await mfgService.release(order.id);
    expect(released.status).toBe("released");
    expect(await mfgService.listOperations(order.id)).toHaveLength(0);
  });

  it("warns on stock shortage but still releases", async () => {
    const { order } = await makeMO(5);
    const { warnings, order: released } = await mfgService.release(order.id);

    expect(released.status).toBe("released");
    expect(warnings).toHaveLength(1);
  });

  it("has no warnings once stock covers the planned need", async () => {
    const { order, component, location } = await makeMO(5);
    await seedStock(component.id, location.id, 100); // 2 x 5 = 10 needed, 100 available

    const { warnings } = await mfgService.release(order.id);
    expect(warnings).toHaveLength(0);
  });
});

describe("manufacturing service — release with phantom BOM components", () => {
  it("resolves a phantom component past into its own components, multiplying quantities down the chain", async () => {
    const user = await makeUser();
    const parent = await articleService.createArticle({
      articleNumber: `PARENT-${crypto.randomUUID()}`,
      name: "Parent",
      type: "manufactured",
      unit: "st",
      active: true,
    });
    const phantom = await articleService.createArticle({
      articleNumber: `PHANTOM-${crypto.randomUUID()}`,
      name: "Phantom",
      type: "manufactured",
      isPhantom: true,
      unit: "st",
      active: true,
    });
    const leaf = await articleService.createArticle({
      articleNumber: `LEAF-${crypto.randomUUID()}`,
      name: "Leaf",
      type: "purchased",
      unit: "st",
      active: true,
    });
    await articleService.addBomComponent(parent.id, { componentArticleId: phantom.id, quantity: 2 });
    await articleService.addBomComponent(phantom.id, { componentArticleId: leaf.id, quantity: 3 });

    const order = await mfgService.createManufacturingOrder({ articleId: parent.id, quantity: 5 }, user.id);
    expect(order.status).toBe("released");

    const materials = await mfgService.listMaterialConsumptions(order.id);
    expect(materials).toHaveLength(1); // only the leaf — the phantom itself never appears
    expect(materials[0]?.componentArticleId).toBe(leaf.id);
    expect(materials[0]?.quantityPlanned).toBe("30.0000"); // 2 (parent->phantom) x 3 (phantom->leaf) x 5 (MO qty)
  });

  it("merges the same leaf reached via two sibling phantom branches (diamond BOM), not a false cycle", async () => {
    const user = await makeUser();
    const parent = await articleService.createArticle({
      articleNumber: `PARENT-${crypto.randomUUID()}`,
      name: "Parent",
      type: "manufactured",
      unit: "st",
      active: true,
    });
    const phantomA = await articleService.createArticle({
      articleNumber: `PHA-${crypto.randomUUID()}`,
      name: "Phantom A",
      type: "manufactured",
      isPhantom: true,
      unit: "st",
      active: true,
    });
    const phantomB = await articleService.createArticle({
      articleNumber: `PHB-${crypto.randomUUID()}`,
      name: "Phantom B",
      type: "manufactured",
      isPhantom: true,
      unit: "st",
      active: true,
    });
    const leaf = await articleService.createArticle({
      articleNumber: `LEAF-${crypto.randomUUID()}`,
      name: "Leaf",
      type: "purchased",
      unit: "st",
      active: true,
    });
    await articleService.addBomComponent(parent.id, { componentArticleId: phantomA.id, quantity: 1 });
    await articleService.addBomComponent(parent.id, { componentArticleId: phantomB.id, quantity: 1 });
    await articleService.addBomComponent(phantomA.id, { componentArticleId: leaf.id, quantity: 2 });
    await articleService.addBomComponent(phantomB.id, { componentArticleId: leaf.id, quantity: 4 });

    const order = await mfgService.createManufacturingOrder({ articleId: parent.id, quantity: 1 }, user.id);
    expect(order.status).toBe("released");

    const materials = await mfgService.listMaterialConsumptions(order.id);
    expect(materials).toHaveLength(1); // merged into a single row for the shared leaf
    expect(materials[0]?.componentArticleId).toBe(leaf.id);
    expect(materials[0]?.quantityPlanned).toBe("6.0000"); // (1x2) + (1x4) = 6
  });
});

describe("manufacturing service — order lifecycle", () => {
  // articles.rounding (Avrundning): the TO quantity is rounded up to the
  // article's step at creation (KO→TO delegates to the same path).
  it("rounds the order quantity up to the article's Avrundning", async () => {
    const user = await makeUser();
    const article = await articleService.createArticle({
      articleNumber: `RND-${crypto.randomUUID()}`,
      name: "Rundad",
      type: "manufactured",
      unit: "st",
      rounding: 10,
      active: true,
    });
    const order = await mfgService.createManufacturingOrder({ articleId: article.id, quantity: 12 }, user.id);
    expect(order.quantity).toBe("20.0000");

    const exact = await mfgService.createManufacturingOrder({ articleId: article.id, quantity: 30 }, user.id);
    expect(exact.quantity).toBe("30.0000");
  });

  it("allows cancel from planned and from released", async () => {
    const { order: plannedOrder } = await makeMO(5);
    const cancelledPlanned = await mfgService.cancel(plannedOrder.id);
    expect(cancelledPlanned?.status).toBe("cancelled");

    const { order: releasedOrder } = await makeMO(5);
    await mfgService.release(releasedOrder.id);
    const cancelledReleased = await mfgService.cancel(releasedOrder.id);
    expect(cancelledReleased?.status).toBe("cancelled");
  });

  // Makulera order: an order under way can be cancelled as long as nothing
  // is booked against it — a material draw has to be undone first.
  it("cancels an in-progress order with nothing booked, but not one with drawn material", async () => {
    const { order: started } = await makeMO(5);
    await mfgService.release(started.id);
    await mfgService.start(started.id);
    expect((await mfgService.cancel(started.id)).status).toBe("cancelled");

    const { order, component, location, user } = await makeMO(5);
    await seedStock(component.id, location.id, 100);
    await mfgService.release(order.id);
    const [materialRow] = await mfgService.listMaterialConsumptions(order.id);
    await mfgService.consumeMaterial(order.id, materialRow!.id, { locationId: location.id, quantity: 1 }, user.id);
    await expect(mfgService.cancel(order.id)).rejects.toThrow(ManufacturingOrderHasReportsError);
  });
});

describe("manufacturing service — material consumption", () => {
  it("consumes material, records a negative stock_transactions row, and rejects over-consumption", async () => {
    const { order, component, location, user } = await makeMO(5);
    await seedStock(component.id, location.id, 100);
    await mfgService.release(order.id);
    const [materialRow] = await mfgService.listMaterialConsumptions(order.id);

    const consumed = await mfgService.consumeMaterial(order.id, materialRow!.id, { locationId: location.id, quantity: 6 }, user.id);
    expect(consumed.quantityConsumed).toBe("6.0000");

    await expect(
      mfgService.consumeMaterial(order.id, materialRow!.id, { locationId: location.id, quantity: 5 }, user.id)
    ).rejects.toThrow(OverConsumptionError); // 6 + 5 = 11 > 10 planned

    const balances = await stockService.getBalances({ articleId: component.id, limit: 50, offset: 0 });
    expect(balances.rows[0]?.quantityOnHand).toBe("94.0000"); // 100 - 6
  });

  it("refuses to consume material against a location under a blocking count", async () => {
    const { order, component, location, user } = await makeMO(5);
    await seedStock(component.id, location.id, 100);
    await mfgService.release(order.id);
    const [materialRow] = await mfgService.listMaterialConsumptions(order.id);
    await stockCountRepo.createSession({ locationId: location.id, blocksTransactions: true }, null);

    await expect(
      mfgService.consumeMaterial(order.id, materialRow!.id, { locationId: location.id, quantity: 6 }, user.id)
    ).rejects.toBeInstanceOf(LocationUnderStockCountError);
  });

  it("rejects consuming material against a planned (not yet released) order", async () => {
    const { order, location, user } = await makeMO(5);
    // material consumption rows don't exist yet since the order was never released
    await expect(
      mfgService.consumeMaterial(order.id, "00000000-0000-0000-0000-000000000000", { locationId: location.id, quantity: 1 }, user.id)
    ).rejects.toThrow(InvalidStatusTransitionError);
  });
});

describe("manufacturing service — operations and completion", () => {
  it("marks an operation done", async () => {
    const { order, parent } = await makeMO(5);
    const workCenter = await mfgService.createWorkCenter({ code: "100", name: "Svets", active: true });
    await mfgService.createRoutingOperation(parent.id, { sequenceNo: 1, workCenterId: workCenter.id, setupTime: 10, runTimePerUnit: 2 });
    await mfgService.release(order.id);
    const [operation] = await mfgService.listOperations(order.id);

    const { operation: completed } = await mfgService.completeOperation(
      operation!.id,
      { actualTime: 42 },
      order.createdBy!
    );
    expect(completed.status).toBe("done");
    expect(completed.actualTime).toBe("42.00");
    // No quantity given → the order's quantity is reported.
    expect(Number(completed.quantityCompleted)).toBe(5);
  });

  // The card's Slutför marks the operation done only once its accumulated OK
  // covers the order quantity — a partial report leaves it pending, so it
  // stays stampable in the terminal.
  it("leaves the operation pending on a partial report and marks it done once the order quantity is covered", async () => {
    const { order, parent } = await makeMO(5);
    const workCenter = await mfgService.createWorkCenter({ code: "100", name: "Svets", active: true });
    await mfgService.createRoutingOperation(parent.id, { sequenceNo: 1, workCenterId: workCenter.id, setupTime: 10, runTimePerUnit: 2 });
    await mfgService.createRoutingOperation(parent.id, { sequenceNo: 2, workCenterId: workCenter.id, setupTime: 10, runTimePerUnit: 2 });
    await mfgService.release(order.id);
    const [operation] = await mfgService.listOperations(order.id);

    const partial = await mfgService.completeOperation(operation!.id, { quantityCompleted: 2, quantityScrapped: 3, scrapReason: "Repa" }, order.createdBy!);
    expect([partial.operation.status, partial.operation.quantityCompleted]).toEqual(["pending", "2.0000"]);

    const rest = await mfgService.completeOperation(operation!.id, {}, order.createdBy!);
    // Defaults to what remains (5 − 2 OK) and covers the order quantity.
    expect([rest.operation.status, rest.operation.quantityCompleted]).toEqual(["done", "5.0000"]);
  });

  // No Starta step: Slutför order works straight on a released order, never on a planned one.
  it("completes a released order, refuses a planned one, and records a positive mo_receipt transaction", async () => {
    const { order, parent, component, location, user } = await makeMO(5);
    await seedStock(component.id, location.id, 100);

    await expect(mfgService.complete(order.id, { locationId: location.id }, user.id)).rejects.toThrow(InvalidStatusTransitionError);

    await mfgService.release(order.id);
    const completed = await mfgService.complete(order.id, { locationId: location.id }, user.id);
    expect(completed?.status).toBe("done");

    const balances = await stockService.getBalances({ articleId: parent.id, limit: 50, offset: 0 });
    expect(balances.rows[0]?.quantityOnHand).toBe("5.0000");
  });

  it("refuses to complete against a receipt location under a blocking count", async () => {
    const { order, component, location, user } = await makeMO(5);
    await seedStock(component.id, location.id, 100);
    await mfgService.release(order.id);
    await mfgService.start(order.id);
    await stockCountRepo.createSession({ locationId: location.id, blocksTransactions: true }, null);

    await expect(
      mfgService.complete(order.id, { locationId: location.id }, user.id)
    ).rejects.toBeInstanceOf(LocationUnderStockCountError);
  });

  it("closes an order only once done", async () => {
    const { order, location, user } = await makeMO(5);
    await mfgService.release(order.id);
    await mfgService.start(order.id);

    await expect(mfgService.close(order.id)).rejects.toThrow(InvalidStatusTransitionError);

    await mfgService.complete(order.id, { locationId: location.id }, user.id);
    const closed = await mfgService.close(order.id);
    expect(closed?.status).toBe("closed");
  });
});

describe("manufacturing service — full lifecycle", () => {
  it("runs create (released) -> start -> consume -> completeOperation (last op: received, done) -> close end to end", async () => {
    const user = await makeUser();
    const { parent, component } = await makeParentWithBom(2);
    const location = await makeLocation();
    await seedStock(component.id, location.id, 100);
    const workCenter = await mfgService.createWorkCenter({ code: "100", name: "Svets", active: true });
    await mfgService.createRoutingOperation(parent.id, { sequenceNo: 1, workCenterId: workCenter.id, setupTime: 10, runTimePerUnit: 2 });

    const order = await mfgService.createManufacturingOrder({ articleId: parent.id, quantity: 5 }, user.id);
    await mfgService.start(order.id);

    const [materialRow] = await mfgService.listMaterialConsumptions(order.id);
    await mfgService.consumeMaterial(order.id, materialRow!.id, { locationId: location.id, quantity: 10 }, user.id);

    const [operation] = await mfgService.listOperations(order.id);
    const reported = await mfgService.completeOperation(operation!.id, { actualTime: 20 }, order.createdBy!);
    // The only operation is the last one: its 5 OK are received and the order is done.
    expect([reported.received, reported.orderCompleted]).toEqual([5, true]);

    const closed = await mfgService.close(order.id);
    expect(closed?.status).toBe("closed");

    const componentBalance = await stockService.getBalances({ articleId: component.id, limit: 50, offset: 0 });
    expect(componentBalance.rows[0]?.quantityOnHand).toBe("90.0000"); // 100 - 10 consumed

    const parentBalance = await stockService.getBalances({ articleId: parent.id, limit: 50, offset: 0 });
    expect(parentBalance.rows[0]?.quantityOnHand).toBe("5.0000"); // 5 produced
  });
});

describe("manufacturing — editable work centers and routing", () => {
  it("updates a work center and 404s on unknown ids", async () => {
    const wc = await mfgService.createWorkCenter({ code: "200", name: "Press", hourlyRate: 500, overheadPercent: 10, active: true });
    const updated = await mfgService.updateWorkCenter(wc.id, { name: "Kantpress", hourlyRate: 620 });
    expect(updated.name).toBe("Kantpress");
    expect(updated.hourlyRate).toBe("620.00");

    await expect(mfgService.updateWorkCenter(crypto.randomUUID(), { name: "X" })).rejects.toBeInstanceOf(
      WorkCenterNotFoundError
    );
  });

  it("refuses the Kalkyl flag while a BOM row still points at the operation", async () => {
    const { parent } = await makeParentWithBom(2);
    const extra = await makeComponentArticle();
    const wc = await mfgService.createWorkCenter({ code: "100", name: "Svets", active: true });
    const op = await mfgService.createRoutingOperation(parent.id, {
      sequenceNo: 10,
      workCenterId: wc.id,
      setupTime: 1,
      runTimePerUnit: 1,
    });
    const linked = await articleService.addBomComponent(parent.id, {
      componentArticleId: extra.id,
      quantity: 1,
      routingOperationId: op.id,
    });

    // A Kalkyl operation never reaches the MO, so material hung off it would
    // silently fall through to final completion — refuse the combination.
    await expect(mfgService.updateRoutingOperation(parent.id, op.id, { costingOnly: true })).rejects.toBeInstanceOf(
      OperationHasLinkedMaterialError
    );

    await articleService.removeBomComponent(parent.id, linked.id);
    const flagged = await mfgService.updateRoutingOperation(parent.id, op.id, { costingOnly: true });
    expect(flagged.costingOnly).toBe(true);
  });

  it("creates a Kalkyl operation and lets the flag be cleared again", async () => {
    const { parent } = await makeParentWithBom(2);
    const wc = await mfgService.createWorkCenter({ code: "100", name: "Svets", active: true });
    const op = await mfgService.createRoutingOperation(parent.id, {
      sequenceNo: 10,
      workCenterId: wc.id,
      setupTime: 1,
      runTimePerUnit: 1,
      costingOnly: true,
    });
    expect(op.costingOnly).toBe(true);

    const cleared = await mfgService.updateRoutingOperation(parent.id, op.id, { costingOnly: false });
    expect(cleared.costingOnly).toBe(false);
  });

  it("refuses to hang a BOM row on a Kalkyl operation, on both add and update", async () => {
    // bom_components is unique per (parent, component) and makeParentWithBom
    // already consumed `component`, so these rows need their own article.
    const { parent } = await makeParentWithBom(2);
    const extra = await makeComponentArticle();
    const wc = await mfgService.createWorkCenter({ code: "100", name: "Svets", active: true });
    const calcOp = await mfgService.createRoutingOperation(parent.id, {
      sequenceNo: 10,
      workCenterId: wc.id,
      setupTime: 1,
      runTimePerUnit: 1,
      costingOnly: true,
    });

    await expect(
      articleService.addBomComponent(parent.id, { componentArticleId: extra.id, quantity: 1, routingOperationId: calcOp.id })
    ).rejects.toBeInstanceOf(CostingOnlyOperationLinkError);

    const row = await articleService.addBomComponent(parent.id, { componentArticleId: extra.id, quantity: 1 });
    await expect(
      articleService.updateBomComponent(parent.id, row.id, { routingOperationId: calcOp.id })
    ).rejects.toBeInstanceOf(CostingOnlyOperationLinkError);
  });

  it("edits and removes routing operations, rejecting duplicate sequence numbers", async () => {
    const user = await makeUser();
    const article = await articleService.createArticle({
      articleNumber: `RUT-${crypto.randomUUID()}`,
      name: "Ruttartikel",
      type: "manufactured",
      unit: "st",
      active: true,
    });
    const wc = await mfgService.createWorkCenter({ code: "100", name: "Svets", hourlyRate: 600, overheadPercent: 20, active: true });
    const op1 = await mfgService.createRoutingOperation(article.id, {
      sequenceNo: 1,
      workCenterId: wc.id,
      setupTime: 10,
      runTimePerUnit: 2,
    });
    const op2 = await mfgService.createRoutingOperation(article.id, {
      sequenceNo: 2,
      workCenterId: wc.id,
      setupTime: 5,
      runTimePerUnit: 1,
    });

    const updated = await mfgService.updateRoutingOperation(article.id, op2.id, { setupTime: 8 });
    expect(updated.setupTime).toBe("8.00");

    await expect(
      mfgService.updateRoutingOperation(article.id, op2.id, { sequenceNo: 1 })
    ).rejects.toBeInstanceOf(DuplicateSequenceNoError);

    await mfgService.removeRoutingOperation(article.id, op1.id);
    const remaining = await mfgService.listRoutingOperations(article.id);
    expect(remaining).toHaveLength(1);
    await expect(mfgService.removeRoutingOperation(article.id, op1.id)).rejects.toBeInstanceOf(
      RoutingOperationNotFoundError
    );
    void user;
  });

  it("stores, edits and clears the operation's Beskrivning", async () => {
    const article = await articleService.createArticle({
      articleNumber: `RUT-${crypto.randomUUID()}`,
      name: "Ruttartikel",
      type: "manufactured",
      unit: "st",
      active: true,
    });
    const wc = await mfgService.createWorkCenter({ code: "100", name: "Svets", active: true });

    const created = await mfgService.createRoutingOperation(article.id, {
      sequenceNo: 10,
      workCenterId: wc.id,
      setupTime: 1,
      runTimePerUnit: 1,
      description: "  Kapning  ",
    });
    expect(created.description).toBe("Kapning");

    // Optional — a routing written without it reads exactly as before.
    const bare = await mfgService.createRoutingOperation(article.id, {
      sequenceNo: 20,
      workCenterId: wc.id,
      setupTime: 1,
      runTimePerUnit: 1,
    });
    expect(bare.description).toBeNull();

    const edited = await mfgService.updateRoutingOperation(article.id, created.id, { description: "Avgradning" });
    expect(edited.description).toBe("Avgradning");

    const cleared = await mfgService.updateRoutingOperation(article.id, created.id, { description: "" });
    expect(cleared.description).toBeNull();
  });

  it("stores, edits and clears the operation's Kommentar and its print flag", async () => {
    const article = await articleService.createArticle({
      articleNumber: `RUT-${crypto.randomUUID()}`,
      name: "Ruttartikel",
      type: "manufactured",
      unit: "st",
      active: true,
    });
    const wc = await mfgService.createWorkCenter({ code: "100", name: "Svets", active: true });

    const created = await mfgService.createRoutingOperation(article.id, {
      sequenceNo: 10,
      workCenterId: wc.id,
      setupTime: 1,
      runTimePerUnit: 1,
      comment: "  Kör med skyddsglasögon  ",
      printOnWorkCard: true,
    });
    // zod trims the text; the flag rides along untouched.
    expect(created.comment).toBe("Kör med skyddsglasögon");
    expect(created.printOnWorkCard).toBe(true);

    // Defaults: no comment, not printed.
    const bare = await mfgService.createRoutingOperation(article.id, {
      sequenceNo: 20,
      workCenterId: wc.id,
      setupTime: 1,
      runTimePerUnit: 1,
    });
    expect(bare.comment).toBeNull();
    expect(bare.printOnWorkCard).toBe(false);

    const edited = await mfgService.updateRoutingOperation(article.id, created.id, { comment: "Avsyna först" });
    expect(edited.comment).toBe("Avsyna först");
    expect(edited.printOnWorkCard).toBe(true);

    // A blanked textarea arrives as "" and must really erase the comment —
    // "no comment" has one representation, not two.
    const cleared = await mfgService.updateRoutingOperation(article.id, created.id, { comment: "" });
    expect(cleared.comment).toBeNull();
  });

  it("stores, edits and clears the operation's Packinstruktion", async () => {
    const article = await articleService.createArticle({
      articleNumber: `RUT-${crypto.randomUUID()}`,
      name: "Ruttartikel",
      type: "manufactured",
      unit: "st",
      active: true,
    });
    const wc = await mfgService.createWorkCenter({ code: "100", name: "Svets", active: true });

    const created = await mfgService.createRoutingOperation(article.id, {
      sequenceNo: 10,
      workCenterId: wc.id,
      setupTime: 1,
      runTimePerUnit: 1,
      packingInstructions: "  Packa i EU-pall med hörnskydd  ",
    });
    // zod trims the text.
    expect(created.packingInstructions).toBe("Packa i EU-pall med hörnskydd");

    // Optional — a routing written without it reads exactly as before.
    const bare = await mfgService.createRoutingOperation(article.id, {
      sequenceNo: 20,
      workCenterId: wc.id,
      setupTime: 1,
      runTimePerUnit: 1,
    });
    expect(bare.packingInstructions).toBeNull();

    const edited = await mfgService.updateRoutingOperation(article.id, created.id, {
      packingInstructions: "Bubbelplast runt kanterna",
    });
    expect(edited.packingInstructions).toBe("Bubbelplast runt kanterna");

    // A blanked textarea arrives as "" and must really erase the field —
    // "not filled in" has one representation, not two.
    const cleared = await mfgService.updateRoutingOperation(article.id, created.id, { packingInstructions: "" });
    expect(cleared.packingInstructions).toBeNull();
  });
});

describe("manufacturing — work center resource numbers", () => {
  it("creates a work center with a 3-digit number", async () => {
    const wc = await mfgService.createWorkCenter({ code: "310", name: "Svets", active: true });
    expect(wc.code).toBe("310");
  });

  it("rejects a duplicate number on create", async () => {
    await mfgService.createWorkCenter({ code: "310", name: "Svets", active: true });
    await expect(mfgService.createWorkCenter({ code: "310", name: "Press", active: true })).rejects.toBeInstanceOf(
      DuplicateWorkCenterCodeError
    );
  });

  it("updates the number", async () => {
    const wc = await mfgService.createWorkCenter({ code: "310", name: "Svets", active: true });
    const updated = await mfgService.updateWorkCenter(wc.id, { code: "320" });
    expect(updated.code).toBe("320");
  });

  it("allows saving a work center with its own unchanged number", async () => {
    const wc = await mfgService.createWorkCenter({ code: "310", name: "Svets", active: true });
    const updated = await mfgService.updateWorkCenter(wc.id, { code: "310", name: "Svetsstation" });
    expect(updated.id).toBe(wc.id);
    expect(updated.name).toBe("Svetsstation");
  });

  it("rejects a number change that collides with another work center", async () => {
    await mfgService.createWorkCenter({ code: "310", name: "Svets", active: true });
    const other = await mfgService.createWorkCenter({ code: "320", name: "Press", active: true });
    await expect(mfgService.updateWorkCenter(other.id, { code: "310" })).rejects.toBeInstanceOf(
      DuplicateWorkCenterCodeError
    );
  });

  it("lists work centers sorted by number", async () => {
    await mfgService.createWorkCenter({ code: "320", name: "B", active: true });
    await mfgService.createWorkCenter({ code: "100", name: "C", active: true });
    await mfgService.createWorkCenter({ code: "310", name: "A", active: true });

    const list = await mfgService.listWorkCenters();
    expect(list.map((wc) => wc.code)).toEqual(["100", "310", "320"]);
  });
});

describe("manufacturing — work center type and production groups", () => {
  it("defaults a work center to machine, accepts personnel explicitly", async () => {
    const machine = await mfgService.createWorkCenter({ code: "100", name: "Svets", active: true });
    expect(machine.type).toBe("machine");

    const person = await mfgService.createWorkCenter({ code: "200", name: "Montör", type: "personnel", active: true });
    expect(person.type).toBe("personnel");

    const updated = await mfgService.updateWorkCenter(machine.id, { type: "personnel" });
    expect(updated.type).toBe("personnel");
  });

  it("creates a work center directly into a production group", async () => {
    const group = await mfgService.createProductionGroup({ code: "500", name: "Svetsning", active: true });
    const wc = await mfgService.createWorkCenter({ code: "510", name: "MIG", productionGroupId: group.id, active: true });
    expect(wc.productionGroupId).toBe(group.id);

    const list = await mfgService.listWorkCenters();
    const listed = list.find((w) => w.id === wc.id)!;
    expect(listed.productionGroupCode).toBe("500");
    expect(listed.productionGroupName).toBe("Svetsning");
  });

  it("rejects an unknown production group on create and update", async () => {
    await expect(
      mfgService.createWorkCenter({ code: "100", name: "Svets", productionGroupId: crypto.randomUUID(), active: true })
    ).rejects.toBeInstanceOf(ProductionGroupNotFoundError);

    const wc = await mfgService.createWorkCenter({ code: "100", name: "Svets", active: true });
    await expect(
      mfgService.updateWorkCenter(wc.id, { productionGroupId: crypto.randomUUID() })
    ).rejects.toBeInstanceOf(ProductionGroupNotFoundError);
  });

  it("clears the group with productionGroupId null on update", async () => {
    const group = await mfgService.createProductionGroup({ code: "500", name: "Svetsning", active: true });
    const wc = await mfgService.createWorkCenter({ code: "510", name: "MIG", productionGroupId: group.id, active: true });

    const updated = await mfgService.updateWorkCenter(wc.id, { productionGroupId: null });
    expect(updated.productionGroupId).toBeNull();
  });

  it("rejects a duplicate production group code", async () => {
    await mfgService.createProductionGroup({ code: "500", name: "Svetsning", active: true });
    await expect(
      mfgService.createProductionGroup({ code: "500", name: "Dubblett", active: true })
    ).rejects.toBeInstanceOf(DuplicateProductionGroupCodeError);
  });

  it("replace-the-set from the group side moves and clears resources", async () => {
    const groupA = await mfgService.createProductionGroup({ code: "500", name: "Svetsning", active: true });
    const groupB = await mfgService.createProductionGroup({ code: "600", name: "Svarv", active: true });
    const wc1 = await mfgService.createWorkCenter({ code: "510", name: "MIG", productionGroupId: groupA.id, active: true });
    const wc2 = await mfgService.createWorkCenter({ code: "520", name: "TIG", productionGroupId: groupA.id, active: true });

    // Checking wc1 in group B steals it from A; unchecking wc2 in A clears it.
    const inB = await mfgService.setProductionGroupWorkCenters(groupB.id, { workCenterIds: [wc1.id] });
    expect(inB.map((w) => w.code)).toEqual(["510"]);

    const inA = await mfgService.setProductionGroupWorkCenters(groupA.id, { workCenterIds: [] });
    expect(inA).toEqual([]);
    expect((await mfgService.getWorkCenter(wc2.id))!.productionGroupId).toBeNull();

    // The list view's count subquery and the detail view agree.
    const groups = await mfgService.listProductionGroups();
    expect(groups.find((g) => g.id === groupA.id)!.workCenterCount).toBe(0);
    expect(groups.find((g) => g.id === groupB.id)!.workCenterCount).toBe(1);

    const detail = await mfgService.getProductionGroup(groupB.id);
    expect(detail.workCenters.map((w) => w.code)).toEqual(["510"]);
  });

  it("throws ProductionGroupNotFoundError for a missing group", async () => {
    await expect(mfgService.getProductionGroup(crypto.randomUUID())).rejects.toBeInstanceOf(ProductionGroupNotFoundError);
    await expect(
      mfgService.setProductionGroupWorkCenters(crypto.randomUUID(), { workCenterIds: [] })
    ).rejects.toBeInstanceOf(ProductionGroupNotFoundError);
  });
});

describe("manufacturing service — listManufacturingOrders withOperations", () => {
  // The stamp terminal (stämpelterminalen) filters the order list by work
  // center and production group client-side, so the list can opt in to a
  // per-row operations summary. Without the flag the payload is unchanged.
  it("adds an operations summary with work center and production group only when asked", async () => {
    const { order, parent } = await makeMO(5);
    const group = await mfgService.createProductionGroup({ code: "500", name: "Svetsning", active: true });
    const mig = await mfgService.createWorkCenter({ code: "510", name: "MIG", productionGroupId: group.id, active: true });
    const saw = await mfgService.createWorkCenter({ code: "520", name: "Kapning", active: true });
    await mfgService.createRoutingOperation(parent.id, { sequenceNo: 20, workCenterId: mig.id, setupTime: 10, runTimePerUnit: 2 });
    await mfgService.createRoutingOperation(parent.id, { sequenceNo: 10, workCenterId: saw.id, setupTime: 5, runTimePerUnit: 1 });
    await mfgService.release(order.id);
    // A second order with no routing at all must still get an empty array.
    const { order: bare } = await makeMO(1);

    const plain = await mfgService.listManufacturingOrders({ limit: 50, offset: 0 });
    expect(plain.rows.find((r) => r.id === order.id)).not.toHaveProperty("operations");

    const withOps = await mfgService.listManufacturingOrders({ limit: 50, offset: 0, withOperations: true });
    const row = withOps.rows.find((r) => r.id === order.id)!;
    expect(row.operations).toHaveLength(2);
    expect(row.operations.map((op) => op.sequenceNo)).toEqual([10, 20]);
    expect(row.operations[0]).toMatchObject({
      status: "pending",
      workCenterCode: "520",
      workCenterName: "Kapning",
      workCenterType: "machine",
      productionGroupCode: null,
      productionGroupName: null,
    });
    expect(row.operations[1]).toMatchObject({
      workCenterCode: "510",
      workCenterName: "MIG",
      productionGroupCode: "500",
      productionGroupName: "Svetsning",
    });
    expect(withOps.rows.find((r) => r.id === bare.id)!.operations).toEqual([]);
    expect(withOps.total).toBe(2);
  });
});

describe("manufacturing service — batch TO printout (NOTES.md #9)", () => {
  it("merges several orders into one PDF in the given order, unknown id fails the batch", async () => {
    const { order: first, parent } = await makeMO(5);
    const workCenter = await mfgService.createWorkCenter({ code: "100", name: "Svets", active: true });
    await mfgService.createRoutingOperation(parent.id, { sequenceNo: 1, workCenterId: workCenter.id, setupTime: 10, runTimePerUnit: 2 });
    await mfgService.release(first.id);
    const { order: second } = await makeMO(2);
    const pagesOf = async (buffer: Buffer) => (await PDFDocument.load(buffer)).getPageCount();
    const [a, b] = await Promise.all([mfgService.getManufacturingOrderPdf(first.id), mfgService.getManufacturingOrderPdf(second.id)]);

    const merged = await mfgService.getManufacturingOrdersPdf([second.id, first.id]);
    expect(merged.filename).toBe("tillverkningsordrar-2-st.pdf");
    expect(await pagesOf(merged.content)).toBe((await pagesOf(a.content)) + (await pagesOf(b.content)));
    const text = pdfText(merged.content);
    expect(text.indexOf(second.orderNumber)).toBeGreaterThan(-1);
    expect(text.indexOf(second.orderNumber)).toBeLessThan(text.indexOf(first.orderNumber));

    await expect(mfgService.getManufacturingOrdersPdf([first.id, crypto.randomUUID()])).rejects.toBeInstanceOf(
      ManufacturingOrderNotFoundError
    );
  });
});

describe("manufacturing service — TO printout", () => {
  it("renders a released order with operations and material, drawings appended", async () => {
    const { order, parent } = await makeMO(5);
    await mfgService.release(order.id);

    const plain = await mfgService.getManufacturingOrderPdf(order.id);
    expect(plain.filename).toBe(`${order.orderNumber}.pdf`);
    expect(plain.content.subarray(0, 4).toString()).toBe("%PDF");

    // A drawing on the article is appended as an extra page.
    await testArticleService.addFile(parent.id, {
      filename: "ritning.png",
      contentType: "image/png",
      data: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        "base64"
      ),
    });
    const withDrawing = await mfgService.getManufacturingOrderPdf(order.id);
    expect(withDrawing.content.length).toBeGreaterThan(plain.content.length);
  });

  // A long "artikelnummer — benämning" wraps; everything below it must start
  // under its last line instead of being printed on top of it.
  it("wraps a long article heading and pushes the lines below it down", async () => {
    const user = await makeUser();
    const article = await articleService.createArticle({
      articleNumber: "63000-IN-SI-INKAST",
      name: "Papperskorg Stabil 48L, Inkast, Silver, RAL 9006, Inkastlock",
      type: "manufactured",
      unit: "st",
      active: true,
    });
    const order = await mfgService.createManufacturingOrder({ articleId: article.id, quantity: 1, note: "Skapad från behovsberäkning" }, user.id);

    const runs = pdfTextRuns((await mfgService.getManufacturingOrderPdf(order.id)).content);
    const heading = runs.filter((r) => /63000-IN-SI-INKAST|Inkastlock/.test(r.text));
    const quantity = runs.find((r) => r.text.startsWith("Antal att tillverka"))!;
    expect(heading.length).toBeGreaterThanOrEqual(2); // wrapped onto a second line
    const lowestHeading = Math.min(...heading.map((r) => r.y));
    // PDF y grows upwards: the quantity line sits at least a line below.
    expect(lowestHeading - quantity.y).toBeGreaterThanOrEqual(12);
  });

  it("prints a planned order too and 404s for an unknown id", async () => {
    const article = await articleService.createArticle({
      articleNumber: `ART-TO-PDF-${crypto.randomUUID()}`,
      name: "Oreleased",
      type: "manufactured",
      unit: "st",
      active: true,
    });
    const order = await insertPlannedManufacturingOrder({ articleId: article.id, quantity: 3 });

    const { content } = await mfgService.getManufacturingOrderPdf(order.id);
    expect(content.subarray(0, 4).toString()).toBe("%PDF");

    await expect(
      mfgService.getManufacturingOrderPdf("00000000-0000-0000-0000-000000000000")
    ).rejects.toThrow(ManufacturingOrderNotFoundError);
  });
});

describe("manufacturing service — operation-linked material", () => {
  // Parent with two operations; the component is tied to the first one.
  async function makeLinkedMo(moQuantity = 10, componentPerUnit = 2) {
    const user = await makeUser();
    const location = await makeLocation();
    const parent = await articleService.createArticle({
      articleNumber: `PARENT-${crypto.randomUUID()}`,
      name: "Parent",
      type: "manufactured",
      unit: "st",
      active: true,
    });
    const linked = await articleService.createArticle({
      articleNumber: `LINKED-${crypto.randomUUID()}`,
      name: "Linked component",
      type: "purchased",
      unit: "st",
      active: true,
    });
    const unlinked = await articleService.createArticle({
      articleNumber: `FREE-${crypto.randomUUID()}`,
      name: "Unlinked component",
      type: "purchased",
      unit: "st",
      active: true,
    });
    const workCenter = await mfgService.createWorkCenter({ code: String(Math.floor(Math.random() * 900) + 100), name: "Svets", active: true });
    const op10 = await mfgService.createRoutingOperation(parent.id, {
      sequenceNo: 10,
      workCenterId: workCenter.id,
      setupTime: 1,
      runTimePerUnit: 0.5,
    });
    // The last operation: reports on it receive finished goods (delinleverans),
    // which these tests of op 10's material draw stay clear of.
    await mfgService.createRoutingOperation(parent.id, {
      sequenceNo: 20,
      workCenterId: workCenter.id,
      setupTime: 1,
      runTimePerUnit: 0.5,
    });

    await articleService.addBomComponent(parent.id, {
      componentArticleId: linked.id,
      quantity: componentPerUnit,
      routingOperationId: op10.id,
    });
    await articleService.addBomComponent(parent.id, { componentArticleId: unlinked.id, quantity: 1 });

    await seedStock(linked.id, location.id, 1000);
    await seedStock(unlinked.id, location.id, 1000);

    const order = await mfgService.createManufacturingOrder({ articleId: parent.id, quantity: moQuantity }, user.id);
    const operations = await mfgService.listOperations(order.id);
    return { user, location, parent, linked, unlinked, order, operation: operations[0]! };
  }

  async function consumedFor(orderId: string, articleId: string) {
    const rows = await mfgService.listMaterialConsumptions(orderId);
    return Number(rows.find((r) => r.componentArticleId === articleId)!.quantityConsumed);
  }

  it("snapshots the BOM row's operation link onto the material row", async () => {
    const { order, linked, unlinked, operation } = await makeLinkedMo();
    const materials = await mfgService.listMaterialConsumptions(order.id);

    expect(materials.find((m) => m.componentArticleId === linked.id)?.moOperationId).toBe(operation.id);
    expect(materials.find((m) => m.componentArticleId === unlinked.id)?.moOperationId).toBeNull();
  });

  it("draws the linked material for the reported quantity, leaving unlinked material untouched", async () => {
    const { order, linked, unlinked, location, operation, user } = await makeLinkedMo(10, 2);

    const { consumed } = await mfgService.completeOperation(
      operation.id,
      { quantityCompleted: 10, locationId: location.id },
      user.id
    );
    expect(consumed).toHaveLength(1);
    expect(await consumedFor(order.id, linked.id)).toBe(20); // 2/st × 10
    expect(await consumedFor(order.id, unlinked.id)).toBe(0);
  });

  it("draws MORE material when more than the order quantity is reported", async () => {
    const { order, linked, location, operation, user } = await makeLinkedMo(10, 2);

    await mfgService.completeOperation(operation.id, { quantityCompleted: 12, locationId: location.id }, user.id);
    // 2 per unit × 12 reported = 24, above the planned 20.
    expect(await consumedFor(order.id, linked.id)).toBe(24);
  });

  it("draws proportionally when fewer than the order quantity are reported", async () => {
    const { order, linked, location, operation, user } = await makeLinkedMo(10, 2);

    await mfgService.completeOperation(operation.id, { quantityCompleted: 4, locationId: location.id }, user.id);
    expect(await consumedFor(order.id, linked.id)).toBe(8);
  });

  it("tops up instead of double-booking material consumed manually first", async () => {
    const { order, linked, location, operation, user } = await makeLinkedMo(10, 2);
    const materials = await mfgService.listMaterialConsumptions(order.id);
    const linkedRow = materials.find((m) => m.componentArticleId === linked.id)!;
    await mfgService.consumeMaterial(order.id, linkedRow.id, { locationId: location.id, quantity: 6 }, user.id);

    await mfgService.completeOperation(operation.id, { quantityCompleted: 10, locationId: location.id }, user.id);
    // Target is 20; 6 was already taken, so only 14 more is booked.
    expect(await consumedFor(order.id, linked.id)).toBe(20);
  });

  it("resolves the draw to the component's default location, falling back to ***", async () => {
    const { order, linked, operation, user, location } = await makeLinkedMo(10, 2);
    // Give the linked component a default location of its own.
    await articleService.updateArticle(linked.id, { defaultLocationId: location.id });

    await mfgService.completeOperation(operation.id, { quantityCompleted: 10 }, user.id);

    const transactions = await stockService.listTransactions({ search: "LINKED", limit: 50, offset: 0 });
    const draw = transactions.rows.find((t) => t.transactionType === "mo_consumption");
    expect(draw).toBeDefined();
    expect(Number(draw!.quantityDelta)).toBe(-20);
    expect(draw!.locationId).toBe(location.id);
  });

  it("creates and uses the *** fallback location when nothing else is set", async () => {
    const { operation, user, unlinked } = await makeLinkedMo(10, 2);
    // Strip the components' default locations to force the *** fallback.
    const materials = await mfgService.listMaterialConsumptions(operation.manufacturingOrderId);
    for (const m of materials) {
      await articleService.updateArticle(m.componentArticleId, { defaultLocationId: null });
    }

    await mfgService.completeOperation(operation.id, { quantityCompleted: 10 }, user.id);

    const locations = await stockService.listLocations();
    const fallback = locations.find((l) => l.name === "***");
    expect(fallback).toBeDefined();

    const transactions = await stockService.listTransactions({ search: "LINKED", limit: 50, offset: 0 });
    const draw = transactions.rows.find((t) => t.transactionType === "mo_consumption");
    expect(draw!.locationId).toBe(fallback!.id);
    void unlinked;
  });

  it("draws unlinked material at final reporting", async () => {
    const { order, unlinked, location, operation, user } = await makeLinkedMo(10, 2);
    await mfgService.completeOperation(operation.id, { quantityCompleted: 10, locationId: location.id }, user.id);
    await mfgService.start(order.id);

    expect(await consumedFor(order.id, unlinked.id)).toBe(0);
    await mfgService.complete(order.id, { locationId: location.id, quantity: 10 }, user.id);
    expect(await consumedFor(order.id, unlinked.id)).toBe(10); // 1/st × 10
  });
});

describe("manufacturing service — scrap reporting", () => {
  // Same setup as the operation-linked describe: order of `moQuantity`,
  // linked component `componentPerUnit`/unit at op 10, plus one unlinked.
  async function makeLinkedMo(moQuantity = 10, componentPerUnit = 2) {
    const user = await makeUser();
    const location = await makeLocation();
    const parent = await articleService.createArticle({
      articleNumber: `PARENT-${crypto.randomUUID()}`,
      name: "Parent",
      type: "manufactured",
      unit: "st",
      active: true,
    });
    const linked = await articleService.createArticle({
      articleNumber: `LINKED-${crypto.randomUUID()}`,
      name: "Linked component",
      type: "purchased",
      unit: "st",
      active: true,
    });
    const workCenter = await mfgService.createWorkCenter({ code: String(Math.floor(Math.random() * 900) + 100), name: "Svets", active: true });
    const op10 = await mfgService.createRoutingOperation(parent.id, {
      sequenceNo: 10,
      workCenterId: workCenter.id,
      setupTime: 1,
      runTimePerUnit: 0.5,
    });
    await articleService.addBomComponent(parent.id, {
      componentArticleId: linked.id,
      quantity: componentPerUnit,
      routingOperationId: op10.id,
    });
    await seedStock(linked.id, location.id, 1000);
    const order = await mfgService.createManufacturingOrder({ articleId: parent.id, quantity: moQuantity }, user.id);
    const operations = await mfgService.listOperations(order.id);
    return { user, location, parent, linked, order, operation: operations[0]! };
  }

  async function consumedForOrder(orderId: string, articleId: string) {
    const rows = await mfgService.listMaterialConsumptions(orderId);
    return Number(rows.find((r) => r.componentArticleId === articleId)!.quantityConsumed);
  }

  it("draws material for OK + scrapped (order 10, OK 10 + 4 scrapped → components for 14)", async () => {
    const { order, linked, location, operation, user } = await makeLinkedMo(10, 2);

    const { operation: updated } = await mfgService.reportOperationQuantities(operation.id, {
      quantityOk: 10,
      quantityScrapped: 4,
      scrapReason: "Repor",
      locationId: location.id,
      markDone: true,
      createdBy: user.id,
    });

    expect(Number(updated.quantityCompleted)).toBe(10);
    expect(Number(updated.quantityScrapped)).toBe(4);
    expect(updated.status).toBe("done");
    // 2 per unit × (10 OK + 4 kasserade) = 28.
    expect(await consumedForOrder(order.id, linked.id)).toBe(28);

    const scrapLog = await mfgService.listScrapForOrder(order.id);
    expect(scrapLog).toHaveLength(1);
    expect(scrapLog[0]?.reason).toBe("Repor");
    expect(Number(scrapLog[0]?.quantity)).toBe(4);
  });

  it("accumulates partial reports and tops up material without double-booking", async () => {
    const { order, linked, location, operation, user } = await makeLinkedMo(10, 2);

    await mfgService.reportOperationQuantities(operation.id, {
      quantityOk: 4,
      quantityScrapped: 1,
      scrapReason: "Måttfel",
      locationId: location.id,
      markDone: false,
      createdBy: user.id,
    });
    expect(await consumedForOrder(order.id, linked.id)).toBe(10); // (4+1) × 2

    await mfgService.reportOperationQuantities(operation.id, {
      quantityOk: 6,
      quantityScrapped: 0,
      locationId: location.id,
      markDone: true,
      createdBy: user.id,
    });
    const operations = await mfgService.listOperations(order.id);
    expect(Number(operations[0]?.quantityCompleted)).toBe(10);
    expect(Number(operations[0]?.quantityScrapped)).toBe(1);
    expect(operations[0]?.status).toBe("done");
    expect(await consumedForOrder(order.id, linked.id)).toBe(22); // (10+1) × 2
  });

  it("completeOperation on the card defaults Antal klart to what remains", async () => {
    const { order, linked, location, operation, user } = await makeLinkedMo(10, 2);
    // 6 already reported from the terminal.
    await mfgService.reportOperationQuantities(operation.id, {
      quantityOk: 6,
      quantityScrapped: 0,
      locationId: location.id,
      markDone: false,
      createdBy: user.id,
    });

    // Card completion without an explicit quantity → the remaining 4.
    await mfgService.completeOperation(operation.id, { quantityScrapped: 0, locationId: location.id }, user.id);
    const operations = await mfgService.listOperations(order.id);
    expect(Number(operations[0]?.quantityCompleted)).toBe(10);
    expect(await consumedForOrder(order.id, linked.id)).toBe(20);
  });

  it("a 0/0 report (pause) draws nothing and leaves the operation pending", async () => {
    const { order, linked, operation, user } = await makeLinkedMo(10, 2);

    await mfgService.reportOperationQuantities(operation.id, {
      quantityOk: 0,
      quantityScrapped: 0,
      markDone: false,
      createdBy: user.id,
    });
    const operations = await mfgService.listOperations(order.id);
    expect(operations[0]?.status).toBe("pending");
    expect(await consumedForOrder(order.id, linked.id)).toBe(0);
  });
});

// E2 Beläggning: capacity fields on the work center and the MO's planned
// finish date. Week schedules are seeded with raw inserts — the register has
// no logic of its own worth exercising here, and unique random codes keep
// tests isolated without touching the shared TRUNCATE list.
async function makeWeekSchedule() {
  const [row] = await db
    .insert(weekSchedules)
    .values({ code: `VS-${crypto.randomUUID().slice(0, 8)}`, name: "40 h" })
    .returning();
  return row!;
}

// Delinleverans: OK reported on the order's LAST operation (highest sequence
// number) is received into stock straight away; the order completes itself
// once the received quantity reaches the order quantity.
describe("manufacturing service — receipt from the last operation", () => {
  // Parent (standard cost 250) with op 10 (linked component, 2/unit) and the
  // last op 20; one unlinked component (1/unit). Order of 10, released.
  async function makeTwoOpMo(moQuantity = 10) {
    const user = await makeUser();
    const location = await makeLocation();
    const parent = await articleService.createArticle({
      articleNumber: `PARENT-${crypto.randomUUID()}`,
      name: "Parent",
      type: "manufactured",
      unit: "st",
      standardCost: 250,
      active: true,
    });
    const linked = await makeComponentArticle();
    const unlinked = await makeComponentArticle();
    const workCenter = await mfgService.createWorkCenter({ code: "100", name: "Svets", active: true });
    const op10 = await mfgService.createRoutingOperation(parent.id, { sequenceNo: 10, workCenterId: workCenter.id, setupTime: 1, runTimePerUnit: 1 });
    await mfgService.createRoutingOperation(parent.id, { sequenceNo: 20, workCenterId: workCenter.id, setupTime: 1, runTimePerUnit: 1 });
    await articleService.addBomComponent(parent.id, { componentArticleId: linked.id, quantity: 2, routingOperationId: op10.id });
    await articleService.addBomComponent(parent.id, { componentArticleId: unlinked.id, quantity: 1 });
    await seedStock(linked.id, location.id, 1000);
    await seedStock(unlinked.id, location.id, 1000);

    const order = await mfgService.createManufacturingOrder({ articleId: parent.id, quantity: moQuantity }, user.id);
    const [first, last] = await mfgService.listOperations(order.id);
    return { user, location, parent, linked, unlinked, order, first: first!, last: last! };
  }

  const report = (operationId: string, quantityOk: number, quantityScrapped = 0, createdBy: string | null = null) =>
    mfgService.reportOperationQuantities(operationId, {
      quantityOk,
      quantityScrapped,
      scrapReason: quantityScrapped > 0 ? "Repa" : undefined,
      markDone: false,
      createdBy,
    });

  async function onHand(articleId: string) {
    const balances = await stockService.getBalances({ articleId, limit: 50, offset: 0 });
    return balances.rows.reduce((t, r) => t + Number(r.quantityOnHand), 0);
  }

  async function consumed(orderId: string, articleId: string) {
    const rows = await mfgService.listMaterialConsumptions(orderId);
    return Number(rows.find((r) => r.componentArticleId === articleId)!.quantityConsumed);
  }

  async function receipts(orderId: string) {
    return db
      .select({ quantityDelta: stockTransactions.quantityDelta, unitCost: stockTransactions.unitCost })
      .from(stockTransactions)
      .where(and(eq(stockTransactions.referenceId, orderId), eq(stockTransactions.transactionType, "mo_receipt")));
  }

  it("receives the OK quantity of a last-operation report, draws unlinked material pro rata and starts the order", async () => {
    const { order, parent, unlinked, last, user } = await makeTwoOpMo(10);

    await report(last.id, 4, 0, user.id);

    expect(await onHand(parent.id)).toBe(4);
    expect(await receipts(order.id)).toEqual([{ quantityDelta: "4.0000", unitCost: "250.0000" }]);
    expect(await consumed(order.id, unlinked.id)).toBe(4);
    const after = (await mfgService.getManufacturingOrder(order.id))!;
    expect([after.status, after.quantityReceived]).toEqual(["in_progress", "4.0000"]);
  });

  it("receives only the increment on later reports and completes the order when the order quantity is reached", async () => {
    const { order, parent, unlinked, last, user } = await makeTwoOpMo(10);

    await report(last.id, 4, 0, user.id);
    await report(last.id, 6, 0, user.id);

    expect(await onHand(parent.id)).toBe(10);
    expect((await receipts(order.id)).map((r) => r.quantityDelta)).toEqual(["4.0000", "6.0000"]);
    expect(await consumed(order.id, unlinked.id)).toBe(10);
    const after = (await mfgService.getManufacturingOrder(order.id))!;
    expect([after.status, after.quantityReceived]).toEqual(["done", "10.0000"]);
    const completed = await auditRows("manufacturing_order", "completed");
    expect(completed.map((r) => [r.entityId, r.userId])).toEqual([[order.orderNumber, user.id]]);
  });

  it("receives nothing for a report on an earlier operation", async () => {
    const { order, parent, first } = await makeTwoOpMo(10);

    await report(first.id, 10);

    expect(await onHand(parent.id)).toBe(0);
    const after = (await mfgService.getManufacturingOrder(order.id))!;
    expect([after.status, after.quantityReceived]).toEqual(["released", "0.0000"]);
  });

  it("gives scrapped units no stock and does not complete the order short of the order quantity", async () => {
    const { order, parent, last } = await makeTwoOpMo(10);

    await report(last.id, 9, 1);

    expect(await onHand(parent.id)).toBe(9);
    const after = (await mfgService.getManufacturingOrder(order.id))!;
    expect([after.status, after.quantityReceived]).toEqual(["in_progress", "9.0000"]);
  });

  it("receives an over-report too", async () => {
    const { order, parent, last } = await makeTwoOpMo(10);

    await report(last.id, 12);

    expect(await onHand(parent.id)).toBe(12);
    const after = (await mfgService.getManufacturingOrder(order.id))!;
    expect([after.status, after.quantityReceived]).toEqual(["done", "12.0000"]);
  });

  it("Slutför after a partial receipt receives what remains by default and draws the rest of the unlinked material", async () => {
    const { order, parent, unlinked, last, location, user } = await makeTwoOpMo(10);
    await report(last.id, 4);

    const done = await mfgService.complete(order.id, { locationId: location.id }, user.id);

    expect(done.status).toBe("done");
    expect(done.quantityReceived).toBe("10.0000");
    expect(await onHand(parent.id)).toBe(10);
    expect(await consumed(order.id, unlinked.id)).toBe(10);
  });

  it("Slutför with 0 closes a short order without receiving more", async () => {
    const { order, parent, last, user } = await makeTwoOpMo(10);
    await report(last.id, 9, 1);

    const done = await mfgService.complete(order.id, { quantity: 0 }, user.id);

    expect([done.status, done.quantityReceived]).toEqual(["done", "9.0000"]);
    expect(await onHand(parent.id)).toBe(9);
    expect((await receipts(order.id)).map((r) => r.quantityDelta)).toEqual(["9.0000"]);
    expect(completeManufacturingOrderSchema.parse({ quantity: 0 })).toEqual({ quantity: 0 });
  });

  it("refuses a further report once the order completed itself", async () => {
    const { last } = await makeTwoOpMo(10);
    await report(last.id, 10);

    await expect(report(last.id, 1)).rejects.toThrow(InvalidStatusTransitionError);
  });
});

describe("work center capacity fields (E2)", () => {
  it("stores week schedule + capacity factor and lists the joined schedule code", async () => {
    const schedule = await makeWeekSchedule();
    const workCenter = await mfgService.createWorkCenter({
      code: "150",
      name: "Svets",
      weekScheduleId: schedule.id,
      capacityFactor: 2,
      active: true,
    });
    expect(workCenter.weekScheduleId).toBe(schedule.id);
    expect(Number(workCenter.capacityFactor)).toBe(2);

    const listed = await mfgService.listWorkCenters();
    const row = listed.find((w) => w.id === workCenter.id)!;
    expect(row.weekScheduleCode).toBe(schedule.code);
    expect(row.weekScheduleName).toBe("40 h");
  });

  it("rejects an unknown week schedule id with a domain error", async () => {
    await expect(
      mfgService.createWorkCenter({
        code: "151",
        name: "Press",
        weekScheduleId: crypto.randomUUID(),
        capacityFactor: 1,
        active: true,
      })
    ).rejects.toBeInstanceOf(WeekScheduleNotFoundError);
  });

  it("clears the schedule with null on update", async () => {
    const schedule = await makeWeekSchedule();
    const workCenter = await mfgService.createWorkCenter({
      code: "152",
      name: "Kant",
      weekScheduleId: schedule.id,
      capacityFactor: 1,
      active: true,
    });
    const updated = await mfgService.updateWorkCenter(workCenter.id, { weekScheduleId: null });
    expect(updated.weekScheduleId).toBeNull();
  });
});

describe("manufacturing order due date (E2)", () => {
  it("stores the due date on create and defaults it to null", async () => {
    const { order } = await makeMO();
    expect(order.dueDate).toBeNull();

    const user = await makeUser();
    const { parent } = await makeParentWithBom();
    const dated = await mfgService.createManufacturingOrder(
      { articleId: parent.id, quantity: 3, dueDate: "2026-09-01" },
      user.id
    );
    expect(dated.dueDate).toBe("2026-09-01");
  });

  it("PATCH sets and clears the due date in planned/released and guards other statuses", async () => {
    const { order } = await makeMO();

    const set = await mfgService.updateManufacturingOrder(order.id, { dueDate: "2026-09-15" });
    expect(set.dueDate).toBe("2026-09-15");

    await mfgService.release(order.id);
    const changed = await mfgService.updateManufacturingOrder(order.id, { dueDate: "2026-09-22" });
    expect(changed.dueDate).toBe("2026-09-22");

    const cleared = await mfgService.updateManufacturingOrder(order.id, { dueDate: null });
    expect(cleared.dueDate).toBeNull();

    await mfgService.cancel(order.id);
    await expect(mfgService.updateManufacturingOrder(order.id, { dueDate: "2026-10-01" })).rejects.toBeInstanceOf(
      InvalidStatusTransitionError
    );
  });

  it("404s an unknown order", async () => {
    await expect(
      mfgService.updateManufacturingOrder(crypto.randomUUID(), { dueDate: "2026-09-01" })
    ).rejects.toBeInstanceOf(ManufacturingOrderNotFoundError);
  });
});

// G1: audit trail over the MO status transitions + header PATCH. entityId is
// the order NUMBER (readable, like a verifikat's displayNumber), not the
// uuid. completeOperation/reportOperationQuantities (the stamp-terminal
// path) are deliberately NOT covered here — see the "not logged" case below.
describe("manufacturing service — audit log", () => {
  it("logs release/start/close with the acting user and the order number as entityId", async () => {
    const { order, location, user } = await makeMO(5);
    await mfgService.release(order.id, user.id);
    await mfgService.start(order.id, user.id);
    await mfgService.complete(order.id, { locationId: location.id }, user.id);
    await mfgService.close(order.id, user.id);

    for (const action of ["released", "started", "closed"] as const) {
      const rows = await auditRows("manufacturing_order", action);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.entityId).toBe(order.orderNumber);
      expect(rows[0]!.userId).toBe(user.id);
    }
  });

  it("logs cancel with the acting user", async () => {
    const { order, user } = await makeMO(5);
    await mfgService.cancel(order.id, user.id);

    const rows = await auditRows("manufacturing_order", "cancelled");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.entityId).toBe(order.orderNumber);
    expect(rows[0]!.userId).toBe(user.id);
  });

  it("logs complete with quantity/locationId in detail", async () => {
    const { order, location, user } = await makeMO(5);
    await mfgService.release(order.id, user.id);
    await mfgService.start(order.id, user.id);
    await mfgService.complete(order.id, { locationId: location.id, quantity: 5 }, user.id);

    const rows = await auditRows("manufacturing_order", "completed");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.entityId).toBe(order.orderNumber);
    expect(rows[0]!.userId).toBe(user.id);
    expect(rows[0]!.detail).toEqual({ quantity: 5, locationId: location.id });
  });

  it("logs the header PATCH with before/after dueDate, only when it actually changes", async () => {
    const { order, user } = await makeMO(5);
    await mfgService.updateManufacturingOrder(order.id, { dueDate: "2026-09-15" }, user.id);

    const rows = await auditRows("manufacturing_order", "updated");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.entityId).toBe(order.orderNumber);
    expect(rows[0]!.userId).toBe(user.id);
    expect(rows[0]!.detail).toEqual({ before: { dueDate: null }, after: { dueDate: "2026-09-15" } });

    // Setting it to the same value again is a no-op — no second row.
    await mfgService.updateManufacturingOrder(order.id, { dueDate: "2026-09-15" }, user.id);
    expect(await auditRows("manufacturing_order", "updated")).toHaveLength(1);
  });

  it("does NOT log completeOperation / reportOperationQuantities (shop-floor noise)", async () => {
    const { order, parent, user } = await makeMO(5);
    const workCenter = await mfgService.createWorkCenter({ code: "100", name: "Svets", active: true });
    await mfgService.createRoutingOperation(parent.id, { sequenceNo: 1, workCenterId: workCenter.id, setupTime: 10, runTimePerUnit: 2 });
    await mfgService.release(order.id, user.id);
    await mfgService.start(order.id, user.id);
    const operations = await mfgService.listOperations(order.id);
    await mfgService.completeOperation(operations[0]!.id, { quantityCompleted: 5 }, user.id);

    expect(await auditRows("mo_operation", "completed")).toHaveLength(0);
    expect(await auditRows("mo_operation", "reported")).toHaveLength(0);
  });
});

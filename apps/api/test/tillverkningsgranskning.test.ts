import {
  completeOperationSchema,
  createArticleSchema,
  createEmployeeSchema,
  createMoMaterialSchema,
  createRoutingOperationSchema,
  createStockLocationSchema,
  createSupplierSchema,
  createWorkCenterSchema,
  stampInSchema,
  stampOutSchema,
  updateManufacturingOrderSchema,
  updateMoMaterialSchema,
  updateMoOperationSchema,
} from "@navet/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  auditLog,
  db,
  manufacturingOrders,
  moOperations,
  moReports,
  stampSessions,
  stockTransactions,
  systemSettings,
  timeReports,
  units,
  type Tx,
} from "@navet/db";
import { buildApp } from "../src/app.js";
import { testArticleService, testDocumentPdfService, testSystemService } from "./helpers/services.js";
import { waitForLockWaiter } from "./helpers/year-end.js";
import { insertPlannedManufacturingOrder } from "./helpers/planned-manufacturing-order.js";
import { parsed } from "./helpers/parsed.js";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createAuthService } from "../src/modules/auth/service/auth.service.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import {
  createManufacturingService,
  DuplicateWorkCenterCodeError,
  InvalidStatusTransitionError,
  MaterialShortageError,
} from "../src/modules/manufacturing/service/manufacturing.service.js";
import { createPurchaseRepository } from "../src/modules/purchase/repository/purchase.repository.js";
import { createSalesRepository } from "../src/modules/sales/repository/sales.repository.js";
import { markSalesOrderInProduction } from "../src/modules/sales/service/production-transition.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { createStockService } from "../src/modules/stock/service/stock.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { createTimeReportRepository } from "../src/modules/timereport/repository/timereport.repository.js";
import { createTimeReportService } from "../src/modules/timereport/service/timereport.service.js";

// Tillverkningsgranskningen 2026-11-10: the races, float edges and wrong
// answers the review of the manufacturing module found (A1–A6, B1–B12).
// One describe per finding; the real wiring as in app.ts.

const auditRepository = createAuditRepository(db);
const articleService = createArticleService(createArticleRepository(db));
const stockService = createStockService(createStockRepository(db), auditRepository);
const authRepo = createAuthRepository(db);
const salesRepository = createSalesRepository(db);
const purchaseRepository = createPurchaseRepository(db);
const mfgRepository = createManufacturingRepository(db);
const mfgService = createManufacturingService(
  mfgRepository,
  testDocumentPdfService,
  testArticleService,
  {
    findRowForManufacturing: salesRepository.findRowForManufacturing,
    lockRowForManufacturing: salesRepository.lockRowForManufacturing,
    markInProduction: markSalesOrderInProduction,
  },
  auditRepository,
  undefined,
  undefined,
  testSystemService
);
const trService = createTimeReportService(createTimeReportRepository(db), mfgService, { isDateLocked: async () => false }, { log: async () => {} });

const TABLES = sql`TRUNCATE attendance_sessions, stamp_sessions, time_reports, employees, audit_log, purchase_receipts, mo_report_materials, mo_reports,
  purchase_order_rows, purchase_orders, suppliers, mo_material_consumptions, mo_operation_scrap, mo_operations, manufacturing_orders,
  routing_operations, work_centers, production_groups, stock_transactions, stock_locations, warehouses, bom_components, article_units,
  articles, user_settings, users CASCADE`;

// system_settings survives the TRUNCATE and is shared with every other
// suite — the key is removed before and after so nobody inherits a mode.
const SHORTAGE_KEY = "manufacturing_material_shortage";

let user: { id: string };

beforeEach(async () => {
  await db.execute(TABLES);
  await db.delete(systemSettings).where(eq(systemSettings.key, SHORTAGE_KEY));
  user = await authRepo.create({ email: `to-${crypto.randomUUID()}@example.com`, passwordHash: "x", name: "Beredare", role: "admin" });
});
afterAll(async () => {
  await db.execute(TABLES);
  await db.delete(systemSettings).where(eq(systemSettings.key, SHORTAGE_KEY));
});

async function article(type: "purchased" | "manufactured" = "purchased", name = "Artikel") {
  return articleService.createArticle(
    parsed(createArticleSchema, { articleNumber: `${type === "manufactured" ? "P" : "C"}-${crypto.randomUUID().slice(0, 8)}`, name, type, active: true })
  );
}

// Resource numbers are three digits and unique per test (the table is truncated).
let nextCode = 100;
async function workCenter(name = "Svets") {
  return mfgService.createWorkCenter(parsed(createWorkCenterSchema, { code: String(nextCode++), name, active: true }));
}

async function routingOp(articleId: string, sequenceNo: number, workCenterId: string) {
  return mfgService.createRoutingOperation(articleId, parsed(createRoutingOperationSchema, { sequenceNo, workCenterId, setupTime: 0, runTimePerUnit: 1 }));
}

async function seedStock(articleId: string, quantity: number) {
  const warehouse = await stockService.createWarehouse({ name: `Lager ${crypto.randomUUID()}`, active: true });
  const location = await stockService.createLocation(parsed(createStockLocationSchema, { warehouseId: warehouse!.id, name: "A1", active: true }));
  await stockService.recordTransaction({ articleId, locationId: location.id, quantityDelta: quantity, transactionType: "inventory_adjustment" }, user.id);
  return location;
}

// A released TO of `quantity` on a parent with the given operations
// (default 10 and 20); `component` is linked to the first operation.
async function order(opts: { quantity?: number; sequences?: number[]; component?: { id: string }; perUnit?: number } = {}) {
  const { quantity = 4, sequences = [10, 20] } = opts;
  const parent = await article("manufactured");
  const wc = await workCenter();
  const routing = [];
  for (const sequenceNo of sequences) routing.push(await routingOp(parent.id, sequenceNo, wc.id));
  if (opts.component) {
    await articleService.addBomComponent(parent.id, { componentArticleId: opts.component.id, quantity: opts.perUnit ?? 1, routingOperationId: routing[0]!.id });
  }
  const mo = await mfgService.createManufacturingOrder({ articleId: parent.id, quantity }, user.id);
  const operations = await mfgService.listOperations(mo.id);
  return { parent, wc, order: mo, operations, first: operations[0]!, last: operations[operations.length - 1]! };
}

async function orderRow(id: string) {
  const [row] = await db.select().from(manufacturingOrders).where(eq(manufacturingOrders.id, id));
  return row!;
}

async function operationRow(id: string) {
  const [row] = await db.select().from(moOperations).where(eq(moOperations.id, id));
  return row!;
}

async function employee() {
  return trService.createEmployee(parsed(createEmployeeSchema, { employeeNumber: `E-${crypto.randomUUID().slice(0, 8)}`, name: "Stämplare", active: true }));
}

async function openStamps(operationId: string) {
  return db
    .select()
    .from(stampSessions)
    .where(and(eq(stampSessions.moOperationId, operationId), isNull(stampSessions.stoppedAt)));
}

async function auditRows(action: string) {
  return db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.entityType, "manufacturing_order"), eq(auditLog.action, action)))
    .orderBy(auditLog.createdAt);
}

// Another transaction in flight: `work` takes its locks and writes, and the
// transaction then stays open until release(). `locked` resolves once the
// locks are held, so the code under test always starts behind them.
function hold(work: (tx: Tx) => Promise<void>) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let ready!: () => void;
  const reached = new Promise<void>((resolve) => (ready = resolve));
  const done = db.transaction(async (tx) => {
    await work(tx);
    ready();
    await gate;
  });
  return { locked: Promise.race([reached, done]), release, done };
}

// Runs `action` behind `work`'s locks: it must end up waiting on them, and
// only then is the holder committed. Returns the action's error (or value).
async function behindLock<T>(work: (tx: Tx) => Promise<void>, action: () => Promise<T>): Promise<unknown> {
  const holder = hold(work);
  await holder.locked;
  const pending = action().catch((err: unknown) => err);
  try {
    await waitForLockWaiter();
  } finally {
    holder.release(); // never leave the holder's locks behind a failed wait
  }
  await holder.done;
  return pending;
}

const lockOrderAndSet = (orderId: string, status: "done" | "cancelled") => async (tx: Tx) => {
  await tx.select({ id: manufacturingOrders.id }).from(manufacturingOrders).where(eq(manufacturingOrders.id, orderId)).for("update");
  await tx.update(manufacturingOrders).set({ status }).where(eq(manufacturingOrders.id, orderId));
};

describe("A1 — start is conditional on released", () => {
  // start read "released" without a lock and then overwrote whatever a
  // Slutför order / Makulera had committed in between with in_progress.
  for (const status of ["done", "cancelled"] as const) {
    it(`does not overwrite an order that turned ${status} meanwhile`, async () => {
      const f = await order();
      const err = await behindLock(lockOrderAndSet(f.order.id, status), () => mfgService.start(f.order.id, user.id));
      expect(err).toBeInstanceOf(InvalidStatusTransitionError);
      expect((await orderRow(f.order.id)).status).toBe(status);
      expect(await auditRows("started")).toHaveLength(0);
    });
  }
});

describe("A2 — quantities are summed at four decimals", () => {
  // 0.7 + 0.1 is 0.7999999999999999 in floats: the order never reached its
  // quantity of 0.8 and stayed in progress with everything received.
  it("0.7 + 0.1 completes an order of 0.8 and its last operation", async () => {
    const f = await order({ quantity: 0.8, sequences: [10] });
    await mfgService.completeOperation(f.first.id, parsed(completeOperationSchema, { quantityCompleted: 0.7 }), user.id);
    expect((await orderRow(f.order.id)).status).toBe("in_progress");
    expect((await operationRow(f.first.id)).status).not.toBe("done");

    await mfgService.completeOperation(f.first.id, parsed(completeOperationSchema, { quantityCompleted: 0.1 }), user.id);
    const row = await orderRow(f.order.id);
    expect(row.status).toBe("done");
    expect(row.quantityReceived).toBe("0.8000");
    // Slutför operation marks done once covered (markDoneWhenCovered).
    const op = await operationRow(f.first.id);
    expect(op.status).toBe("done");
    expect(op.quantityCompleted).toBe("0.8000");
  });

  // The undo side: 0.3 − 0.1 is 0.19999999999999998, below an order
  // quantity of 0.2 — the order and operation reopened although covered.
  it("undoing an over-report of 0.1 leaves an order of 0.2 done (0.2, then 0.1)", async () => {
    const f = await order({ quantity: 0.2, sequences: [10] });
    await mfgService.completeOperation(f.first.id, parsed(completeOperationSchema, { quantityCompleted: 0.2 }), user.id);
    expect((await orderRow(f.order.id)).status).toBe("done");
    const over = await mfgService.completeOperation(f.first.id, parsed(completeOperationSchema, { quantityCompleted: 0.1 }), user.id);
    expect((await operationRow(f.first.id)).quantityCompleted).toBe("0.3000");

    await mfgService.undoReport(f.order.id, over.reportId, user.id);
    expect((await orderRow(f.order.id)).status).toBe("done");
    const op = await operationRow(f.first.id);
    expect(op.quantityCompleted).toBe("0.2000");
    expect(op.status).toBe("done");
  });

  it("undoing the first 0.1 of 0.1 + 0.2 leaves an order of 0.2 done", async () => {
    // Both reports are receipts here (the order turns done on the second),
    // so this is the one where quantity_received itself is 0.3 − 0.1.
    const f = await order({ quantity: 0.2, sequences: [10] });
    const first = await mfgService.completeOperation(f.first.id, parsed(completeOperationSchema, { quantityCompleted: 0.1 }), user.id);
    await mfgService.completeOperation(f.first.id, parsed(completeOperationSchema, { quantityCompleted: 0.2 }), user.id);
    expect((await orderRow(f.order.id)).quantityReceived).toBe("0.3000");

    await mfgService.undoReport(f.order.id, first.reportId, user.id);
    const row = await orderRow(f.order.id);
    expect(row.status).toBe("done");
    expect(row.quantityReceived).toBe("0.2000");
    expect((await operationRow(f.first.id)).status).toBe("done");
  });
});

describe("A3 — stamp-out 0/0 with operationen klar is dry-run too", () => {
  // Only a stint with quantities was dry-run. 0/0 + "operationen klar"
  // still tops the linked material up, so in block it was refused AFTER
  // the time report was written and the session closed.
  it("block: refused with nothing written", async () => {
    const component = await article("purchased", "Plåt 2 mm");
    await seedStock(component.id, 3);
    const f = await order({ quantity: 4, component, perUnit: 2 });
    // One unit reported while there is no check: draws 2, leaves 1.
    await mfgService.completeOperation(f.first.id, parsed(completeOperationSchema, { quantityCompleted: 1 }), user.id);
    await testSystemService.updateSettings({ manufacturingMaterialShortage: "block" });

    // Ändra material: 2/st → 10/st. The top-up for the one reported unit
    // now wants 10 − 2 = 8, and 1 is in stock.
    const [material] = await mfgService.listMaterialConsumptions(f.order.id);
    await mfgService.updateMaterial(f.order.id, material!.id, parsed(updateMoMaterialSchema, { quantity: 40 }), user.id);

    const worker = await employee();
    const session = await trService.stampIn(parsed(stampInSchema, { employeeId: worker.id, moOperationId: f.first.id }), user.id);
    const reportsBefore = (await db.select().from(moReports)).length;
    const movesBefore = (await db.select().from(stockTransactions)).length;

    const err = await trService
      .stampOut(session.id, parsed(stampOutSchema, { quantityOk: 0, quantityScrapped: 0, markOperationDone: true }), user.id)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MaterialShortageError);

    const [after] = await db.select().from(stampSessions).where(eq(stampSessions.id, session.id));
    expect(after!.stoppedAt).toBeNull();
    expect(await db.select().from(timeReports)).toHaveLength(0);
    expect(await db.select().from(moReports)).toHaveLength(reportsBefore);
    expect(await db.select().from(stockTransactions)).toHaveLength(movesBefore);
    expect((await operationRow(f.first.id)).status).not.toBe("done");
  });
});

describe("A4 — Släpp re-reads the status under the order's lock", () => {
  async function plannedOrder() {
    const parent = await article("manufactured");
    const wc = await workCenter();
    await routingOp(parent.id, 10, wc.id);
    await routingOp(parent.id, 20, wc.id);
    return insertPlannedManufacturingOrder({ articleId: parent.id, quantity: 2, createdBy: user.id });
  }

  it("the repository refuses an order that is already released", async () => {
    const f = await order();
    expect(await mfgRepository.release(f.order.id)).toEqual({ invalidStatus: "released" });
    expect(await mfgService.listOperations(f.order.id)).toHaveLength(2);
  });

  // The second Släpp fell on the snapshot's unique indexes (a 500).
  it("two Släpp at once: one succeeds, the other is an invalid transition", async () => {
    const planned = await plannedOrder();
    const results = await Promise.allSettled([mfgService.release(planned.id, user.id), mfgService.release(planned.id, user.id)]);
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0]!.reason).toBeInstanceOf(InvalidStatusTransitionError);
    expect((await orderRow(planned.id)).status).toBe("released");
    expect((await mfgService.listOperations(planned.id)).map((op) => op.sequenceNo)).toEqual([10, 20]);
  });

  it("a Släpp behind a Makulera is refused and snapshots nothing", async () => {
    const planned = await plannedOrder();
    const err = await behindLock(lockOrderAndSet(planned.id, "cancelled"), () => mfgService.release(planned.id, user.id));
    expect(err).toBeInstanceOf(InvalidStatusTransitionError);
    expect((await orderRow(planned.id)).status).toBe("cancelled");
    expect(await mfgService.listOperations(planned.id)).toHaveLength(0);
  });
});

describe("routes (A5, B5, B6)", () => {
  const authService = createAuthService(createAuthRepository(db), "unused", createAuditRepository(db));
  const PASSWORD = "ett-tillräckligt-långt-lösenord";
  let app: ReturnType<typeof buildApp>;
  let cookie: string;

  beforeAll(async () => {
    app = buildApp();
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    const email = `to-admin-${crypto.randomUUID()}@example.com`;
    await authService.createUser({ email, password: PASSWORD, name: "Admin", role: "admin" });
    const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PASSWORD } });
    expect(res.statusCode).toBe(200);
    cookie = res.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  });

  const post = (url: string, payload: object) => app.inject({ method: "POST", url: `/api/v1${url}`, headers: { cookie }, payload });

  describe("A5/B6 — an unknown article is a 404", () => {
    // Both fell on the insert's FK violation: a 500.
    it("POST /manufacturing-orders", async () => {
      const res = await post("/manufacturing-orders", { articleId: crypto.randomUUID(), quantity: 1 });
      expect(res.statusCode).toBe(404);
      expect(await db.select().from(manufacturingOrders)).toHaveLength(0);
    });

    it("POST /articles/:id/routing", async () => {
      const wc = await workCenter();
      const res = await post(`/articles/${crypto.randomUUID()}/routing`, { sequenceNo: 10, workCenterId: wc.id, setupTime: 0, runTimePerUnit: 1 });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("B5 — Slutför operation on another order's operation", () => {
    // The order in the URL was ignored: the report (with stock moves)
    // landed on the other order.
    it("is a 404 and reports nothing", async () => {
      const a = await order({ sequences: [10] });
      const b = await order({ sequences: [10] });
      const res = await post(`/manufacturing-orders/${a.order.id}/operations/${b.first.id}/complete`, { quantityCompleted: 1 });
      expect(res.statusCode).toBe(404);
      expect(await db.select().from(moReports)).toHaveLength(0);
      expect(await db.select().from(stockTransactions)).toHaveLength(0);
      expect((await orderRow(b.order.id)).status).toBe("released");
      expect(Number((await operationRow(b.first.id)).quantityCompleted ?? 0)).toBe(0);

      // The same call on its own order goes through.
      const own = await post(`/manufacturing-orders/${b.order.id}/operations/${b.first.id}/complete`, { quantityCompleted: 1 });
      expect(own.statusCode).toBe(200);
      expect(await db.select().from(moReports)).toHaveLength(1);
    });
  });
});

describe("A6 — the stamp-in asks again on the locked order and operation", () => {
  // The status was read before the insert without a lock: a Makulera or
  // a report closing the operation in between left an open stamp behind.
  async function underWay() {
    const f = await order();
    await mfgService.start(f.order.id, user.id);
    return { ...f, worker: await employee() };
  }

  it("refuses a stamp-in behind a Makulera", async () => {
    const f = await underWay();
    const err = await behindLock(lockOrderAndSet(f.order.id, "cancelled"), () =>
      trService.stampIn(parsed(stampInSchema, { employeeId: f.worker.id, moOperationId: f.first.id }), user.id)
    );
    expect(err).toBeInstanceOf(InvalidStatusTransitionError);
    expect(await openStamps(f.first.id)).toHaveLength(0);
  });

  it("refuses a stamp-in behind a report that made the operation done", async () => {
    const f = await underWay();
    const err = await behindLock(
      async (tx) => {
        await tx.select({ id: moOperations.id }).from(moOperations).where(eq(moOperations.id, f.first.id)).for("update");
        await tx.update(moOperations).set({ status: "done" }).where(eq(moOperations.id, f.first.id));
      },
      () => trService.stampIn(parsed(stampInSchema, { employeeId: f.worker.id, moOperationId: f.first.id }), user.id)
    );
    expect(err).toBeInstanceOf(InvalidStatusTransitionError);
    expect(await openStamps(f.first.id)).toHaveLength(0);
  });
});

// A manufactured article whose route is Op 10 (machine) and Op 20 on a
// legoresurs: ställpris 1000, transportkostnad 500, styckpris 100.
async function legoOrder() {
  const supplier = await purchaseRepository.createSupplier(parsed(createSupplierSchema, { name: "Lego AB", active: true }));
  const machine = await workCenter();
  const lego = await mfgService.createWorkCenter(
    parsed(createWorkCenterSchema, { code: String(nextCode++), name: "Ytbehandling AB", type: "subcontract", supplierId: supplier.id, active: true })
  );
  const parent = await article("manufactured", "Legodetalj");
  await routingOp(parent.id, 10, machine.id);
  const routingLegoOp = await mfgService.createRoutingOperation(
    parent.id,
    parsed(createRoutingOperationSchema, {
      sequenceNo: 20,
      description: "Ytbehandling",
      workCenterId: lego.id,
      setupTime: 0,
      runTimePerUnit: 0,
      setupPrice: 1000,
      transportPrice: 500,
      unitPrice: 100,
    })
  );
  const mo = await mfgService.createManufacturingOrder({ articleId: parent.id, quantity: 4 }, user.id);
  const moLegoOp = (await mfgService.listOperations(mo.id)).find((op) => op.sequenceNo === 20)!;
  return { parent, order: mo, routingLegoOp, moLegoOp };
}

describe("B1 — the lego options' Ställpris is the one-off charge", () => {
  // The inquiry row was prefilled with the raw setup_price: the
  // Transportkostnad every other reader adds (legoOneOffSql) was dropped.
  it("ställpris 1000 + transportkostnad 500 is 1500.00 on the routing and the TO row", async () => {
    const f = await legoOrder();
    const options = await mfgService.listLegoOperationOptions(f.parent.id);
    expect(options).toHaveLength(2);
    expect(options.find((o) => o.kind === "routing")).toMatchObject({ routingOperationId: f.routingLegoOp.id, setupPrice: "1500.00", unitPrice: "100.0000" });
    expect(options.find((o) => o.kind === "mo")).toMatchObject({ moOperationId: f.moLegoOp.id, setupPrice: "1500.00", unitPrice: "100.0000" });
  });
});

describe("B7 — the händelselogg for Ändra TO", () => {
  // quantityPlanned was logged in the base unit beside the row's unit
  // code: 4 kg at factor 0.5 read "8 kg".
  it("material_added logs the quantity in the row's unit", async () => {
    const f = await order();
    const component = await article("purchased", "Plåt");
    // The units register is not truncated — kg may exist from another suite.
    await db.insert(units).values({ code: "kg", name: "Kilogram" }).onConflictDoNothing();
    const [kg] = await db.select().from(units).where(eq(units.code, "kg"));
    await articleService.addArticleUnit(component.id, { unitId: kg!.id, quantityPerBase: 0.5 });

    const { material } = await mfgService.addMaterial(
      f.order.id,
      parsed(createMoMaterialSchema, { componentArticleId: component.id, quantity: 4, unitId: kg!.id }),
      user.id
    );
    expect(material).toMatchObject({ quantityPlanned: "8.0000", unitCode: "kg" });
    expect(await auditRows("material_added")).toMatchObject([{ entityId: f.order.orderNumber, detail: { quantityPlanned: 4, unitCode: "kg" } }]);
  });

  // transportPrice was missing from the operation's audit view, so a
  // change of only it logged an empty before/after.
  it("operation_changed carries transportPrice", async () => {
    const f = await legoOrder();
    await mfgService.updateOperation(f.order.id, f.moLegoOp.id, parsed(updateMoOperationSchema, { transportPrice: 750 }), user.id);
    expect((await operationRow(f.moLegoOp.id)).transportPrice).toBe("750.00");
    expect(await auditRows("operation_changed")).toMatchObject([
      { entityId: f.order.orderNumber, detail: { sequenceNo: 20, before: { transportPrice: 500 }, after: { transportPrice: 750 } } },
    ]);
  });
});

describe("B9 — the planned finish date is written under the order's lock", () => {
  // The status check was on an unlocked read: a done order got a new date.
  it("refuses an order that turned done meanwhile and keeps its date", async () => {
    const f = await order();
    await mfgService.updateManufacturingOrder(f.order.id, parsed(updateManufacturingOrderSchema, { dueDate: "2031-03-03" }), user.id);
    const err = await behindLock(lockOrderAndSet(f.order.id, "done"), () =>
      mfgService.updateManufacturingOrder(f.order.id, parsed(updateManufacturingOrderSchema, { dueDate: "2031-04-04" }), user.id)
    );
    expect(err).toBeInstanceOf(InvalidStatusTransitionError);
    const row = await orderRow(f.order.id);
    expect(row.status).toBe("done");
    expect(row.dueDate).toBe("2031-03-03");
    // Only the first change is logged.
    expect(await auditRows("updated")).toHaveLength(1);
  });
});

describe("B10 — two resources with the same number at once", () => {
  // The pre-check is unlocked: the loser fell on the unique constraint (500).
  it("one is created, the other is a duplicate", async () => {
    const input = () => parsed(createWorkCenterSchema, { code: "555", name: "Svets", active: true });
    const results = await Promise.allSettled([mfgService.createWorkCenter(input()), mfgService.createWorkCenter(input())]);
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0]!.reason).toBeInstanceOf(DuplicateWorkCenterCodeError);
  });

  it("the insert's unique violation is the duplicate error (the loser of the race)", async () => {
    // Deterministic: the first insert is uncommitted when the second passes
    // the pre-check, waits on the unique index and loses at the commit.
    const first = hold(async (tx) => {
      await tx.execute(sql`INSERT INTO work_centers (code, name) VALUES ('556', 'Svets')`);
    });
    await first.locked;
    const second = mfgService.createWorkCenter(parsed(createWorkCenterSchema, { code: "556", name: "Svets 2", active: true })).catch((e: unknown) => e);
    try {
      await waitForLockWaiter();
    } finally {
      first.release();
    }
    await first.done;
    expect(await second).toBeInstanceOf(DuplicateWorkCenterCodeError);
  });
});

describe("B12 — the routing is listed in sequence order", () => {
  // No ORDER BY: the operations came in the table's physical order.
  it("30, 20, 10 created in that order list as 10, 20, 30", async () => {
    const parent = await article("manufactured");
    const wc = await workCenter();
    for (const sequenceNo of [30, 20, 10]) await routingOp(parent.id, sequenceNo, wc.id);
    expect((await mfgService.listRoutingOperations(parent.id)).map((op) => op.sequenceNo)).toEqual([10, 20, 30]);
  });
});

describe("material on an operation that is already Klar", () => {
  // Linked material is drawn by its operation's reports, so on a Klar
  // operation nothing draws it any more: saved all the same, with a note
  // (doneOperationWarnings) — only when there is something left to draw.
  it("warns when a row is added or moved there, not for the open operation or a lowered quantity", async () => {
    const f = await order({ quantity: 4 });
    await mfgService.completeOperation(f.first.id, parsed(completeOperationSchema, { quantityCompleted: 4 }), user.id);
    expect((await operationRow(f.first.id)).status).toBe("done");
    expect((await operationRow(f.last.id)).status).not.toBe("done");
    // Plenty in stock: no shortage warnings beside the note.
    const c1 = await article("purchased", "Plåt");
    const c2 = await article("purchased", "Skruv");
    await seedStock(c1.id, 100);
    await seedStock(c2.id, 100);
    const note = [`Operation ${f.first.sequenceNo} är klar — materialet dras inte automatiskt, använd Förbruka.`];

    const onDone = await mfgService.addMaterial(f.order.id, parsed(createMoMaterialSchema, { componentArticleId: c1.id, quantity: 8, moOperationId: f.first.id }), user.id);
    expect(onDone.warnings).toEqual(note);

    const onOpen = await mfgService.addMaterial(f.order.id, parsed(createMoMaterialSchema, { componentArticleId: c1.id, quantity: 8, moOperationId: f.last.id }), user.id);
    expect(onOpen.warnings).toEqual([]);

    const other = await mfgService.addMaterial(f.order.id, parsed(createMoMaterialSchema, { componentArticleId: c2.id, quantity: 8, moOperationId: f.last.id }), user.id);
    expect(other.warnings).toEqual([]);
    const moved = await mfgService.updateMaterial(f.order.id, other.material.id, parsed(updateMoMaterialSchema, { moOperationId: f.first.id }), user.id);
    expect(moved.material.moOperationId).toBe(f.first.id);
    expect(moved.warnings).toEqual(note);

    // Less needed on a row already there: nothing new to tell.
    const lowered = await mfgService.updateMaterial(f.order.id, onDone.material.id, parsed(updateMoMaterialSchema, { quantity: 4 }), user.id);
    expect(lowered.material.quantityPlanned).toBe("4.0000");
    expect(lowered.warnings).toEqual([]);
  });
});
